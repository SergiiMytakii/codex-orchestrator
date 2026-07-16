import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { CodexOrchestratorConfig, RunnerConfig } from '../config/schema.js';
import { validateConfig, validateConfigV2 } from '../config/schema.js';
import { formatBaseBranch } from '../git/base-branch.js';
import { GhCliLabelAdapter } from './github-label-adapter.js';
import type { GitHubLabelAdapter, LabelPlan } from './labels.js';
import { planLabels } from './labels.js';
import {
  assertNoRuntimeState,
  applyTargetPackageConfigDefaults,
  buildProjectConfig,
  projectConfigPath,
  readExistingConfig,
  writeProjectConfig,
} from './project-config.js';
import { legacyWorkflowConfigs } from './legacy-workflow-migration.js';
import { acquireTargetActivityFence } from '../runner/target-activity-fence.js';
import { readRunnerConfig } from '../runner/command-utils.js';
import {
  prepareSkillRuntimeV2,
  type PrepareSkillRuntimeV2Result,
} from './skill-runtime-v2-preparation.js';
import { activatePreparedSkillRuntimeV2, type ActivateSkillRuntimeV2Result } from './skill-runtime-v2-activation.js';
import { migrateConfigV1ToV2 } from './skill-runtime-v2-migration.js';
import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';
import { RunnerStateStore } from '../runner/local-state.js';

const execFileAsync = promisify(execFile);

export interface SetupCommandOptions {
  targetRoot: string;
  githubOwner?: string;
  githubRepo?: string;
  dryRun?: boolean;
  prepareLabels?: boolean;
  labelAdapter?: GitHubLabelAdapter;
  prepareSkillRuntimeV2?: boolean;
  activateSkillRuntimeV2?: boolean;
}

export interface SetupCommandResult {
  config: RunnerConfig;
  configPath: string;
  dryRun: boolean;
  labelPlan: LabelPlan;
  output: string;
  skillRuntimePreparation?: PrepareSkillRuntimeV2Result;
  skillRuntimeActivation?: ActivateSkillRuntimeV2Result;
}

export async function runSetupCommand(options: SetupCommandOptions): Promise<SetupCommandResult> {
  if (options.prepareSkillRuntimeV2 && options.activateSkillRuntimeV2) {
    throw new Error('setup skill runtime preparation and activation are separate commands');
  }
  if (options.activateSkillRuntimeV2) {
    if (options.dryRun) throw new Error('setup --activate-skill-runtime-v2 cannot be combined with --dry-run');
    const activation = await activatePreparedSkillRuntimeV2({ targetRoot: options.targetRoot });
    return {
      config: activation.config,
      configPath: activation.configPath,
      dryRun: false,
      labelPlan: { policy: 'report-only', existing: [], missing: [], created: [], wouldCreate: [] },
      output: [
        'skill runtime v2 activation: ready',
        `config: ${activation.configPath}`,
        `state: ${activation.statePath}`,
        `backup: ${activation.backupPath}`,
      ].join('\n'),
      skillRuntimeActivation: activation,
    };
  }
  if (options.prepareSkillRuntimeV2) {
    if (options.dryRun) throw new Error('setup --prepare-skill-runtime-v2 cannot be combined with --dry-run');
    const config = await readRunnerConfig(resolve(options.targetRoot));
    const preparation = await prepareSkillRuntimeV2({ targetRoot: options.targetRoot });
    return {
      config,
      configPath: projectConfigPath(options.targetRoot),
      dryRun: false,
      labelPlan: { policy: 'report-only', existing: [], missing: [], created: [], wouldCreate: [] },
      output: [
        'skill runtime v2 preparation: ready',
        `prepared generation: ${preparation.path}`,
        `bridge package hash: ${preparation.generation.bridgePackageHash}`,
        `activity fence generation: ${preparation.generation.activityFenceGeneration}`,
      ].join('\n'),
      skillRuntimePreparation: preparation,
    };
  }
  if (options.dryRun) return runSetupCommandFenced(options);
  const existingConfig = await readExistingConfig(projectConfigPath(options.targetRoot));
  const stateDir = readExistingString(existingConfig, 'runner', 'stateDir') ?? '.codex-orchestrator/state';
  const lease = await acquireTargetActivityFence({
    targetRoot: options.targetRoot,
    stateDir,
    mode: 'exclusive',
    purpose: 'setup',
  });
  try {
    const fencedExistingConfig = await readExistingConfig(projectConfigPath(options.targetRoot));
    const fencedStateDir = readExistingString(fencedExistingConfig, 'runner', 'stateDir') ?? '.codex-orchestrator/state';
    if (fencedStateDir !== stateDir) {
      throw new Error(
        `target-activity-fence-config-changed: runner.stateDir changed from ${stateDir} to ${fencedStateDir}.`,
      );
    }
    return await runSetupCommandFenced(options);
  } finally {
    await lease.release();
  }
}

async function runSetupCommandFenced(options: SetupCommandOptions): Promise<SetupCommandResult> {
  const dryRun = options.dryRun ?? false;
  const configPath = projectConfigPath(options.targetRoot);
  const existingConfig = await readExistingConfig(configPath);

  assertNoRuntimeState(existingConfig);

  const inferredGitHubRepo = await inferGitHubRepoFromOrigin(options.targetRoot);
  const owner = options.githubOwner ?? readExistingString(existingConfig, 'github', 'owner') ?? inferredGitHubRepo?.owner;
  const repo = options.githubRepo ?? readExistingString(existingConfig, 'github', 'repo') ?? inferredGitHubRepo?.repo;

  if (!owner || !repo) {
    throw new Error('setup requires --github-owner and --github-repo unless existing config or git origin remote provides them');
  }

  const prepareLabels = options.prepareLabels ? 'create-missing' : 'report-only';
  let config: RunnerConfig;
  if (existingConfig) {
    const existingV2 = validateConfigV2(existingConfig);
    if (existingV2.ok) config = existingV2.value;
    else {
      const existingV1 = validateConfig(existingConfig);
      if (existingV1.ok) throw new Error('orchestrator-skill-runtime-v2-activation-required');
      throw new Error(`Existing config is invalid: ${existingV2.errors.join('; ')}`);
    }
  } else {
    const inferredBaseBranch = await inferCurrentUpstreamBaseBranch(options.targetRoot);
    const bridgeDefaults = await applyTargetPackageConfigDefaults(options.targetRoot, buildProjectConfig({
      owner,
      repo,
      prepareLabels,
      workflows: legacyWorkflowConfigs(),
      baseBranch: inferredBaseBranch,
    }));
    config = migrateConfigV1ToV2(bridgeDefaults);
  }

  const adapter = options.labelAdapter ?? new GhCliLabelAdapter(owner, repo);
  const labelPlan = await planLabels(adapter, config.github.labels, prepareLabels, dryRun);
  if (!dryRun) {
    if (!existingConfig) {
      const store = new RunnerStateStore(options.targetRoot, config as unknown as CodexOrchestratorConfig);
      await writeDurableAtomicFile(store.statePath(), `${JSON.stringify({ version: 2, generation: 0, runs: [] }, null, 2)}\n`);
    }
    await writeProjectConfig(options.targetRoot, config);
    await ensureRuntimeGitignoreEntries(options.targetRoot, config);
    await ensurePackageScripts(options.targetRoot);
  }

  const output = formatSetupOutput(configPath, labelPlan, config, dryRun);

  return {
    config,
    configPath,
    dryRun,
    labelPlan,
    output,
  };
}

const packageScripts: Record<string, string> = {
  'orchestrator:doctor': 'codex-orchestrator doctor --target .',
  'orchestrator:status': 'codex-orchestrator status --target .',
  'orchestrator:status:json': 'codex-orchestrator status --target . --json',
  'orchestrator:daemon': 'codex-orchestrator doctor --target . && codex-orchestrator daemon --target .',
  'orchestrator:daemon:once': 'codex-orchestrator doctor --target . && codex-orchestrator daemon --target . --once',
  'orchestrator:daemon:fast': 'codex-orchestrator doctor --target . && codex-orchestrator daemon --target . --interval-seconds 60',
  'orchestrator:daemon:max3': 'codex-orchestrator doctor --target . && codex-orchestrator daemon --target . --max-runs 3',
};

async function ensurePackageScripts(targetRoot: string): Promise<void> {
  const packageJsonPath = join(targetRoot, 'package.json');
  let content = '';
  try {
    content = await readFile(packageJsonPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const packageJson = JSON.parse(content) as Record<string, unknown>;
  const existingScripts = typeof packageJson.scripts === 'object' && packageJson.scripts !== null && !Array.isArray(packageJson.scripts)
    ? packageJson.scripts as Record<string, unknown>
    : {};

  packageJson.scripts = {
    ...packageScripts,
    ...existingScripts,
  };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

async function ensureRuntimeGitignoreEntries(targetRoot: string, config: RunnerConfig): Promise<void> {
  const gitignorePath = join(targetRoot, '.gitignore');
  const entries = runtimeGitignoreEntries(config);
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const existingLines = new Set(existing.split(/\r?\n/u).map(normalizeExistingGitignoreLine));
  const missingEntries = entries.filter((entry) => !existingLines.has(entry));
  if (missingEntries.length === 0) {
    return;
  }

  const prefix = existing.length === 0
    ? ''
    : existing.endsWith('\n')
      ? '\n'
      : '\n\n';
  await writeFile(
    gitignorePath,
    `${existing}${prefix}# codex-orchestrator runtime files\n${missingEntries.join('\n')}\n`,
    'utf8',
  );
}

function gitignoreDirectory(path: string): string {
  return `${path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')}/`;
}

function runtimeGitignoreEntries(config: RunnerConfig): string[] {
  return Array.from(new Set([
    gitignoreDirectory(config.reviewGates.acceptanceProof.artifactDir),
    gitignoreDirectory(config.runner.workspaceRoot),
    gitignoreDirectory(config.runner.stateDir),
  ]));
}

function normalizeExistingGitignoreLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
    return trimmed;
  }
  return gitignoreDirectory(trimmed);
}

function formatSetupOutput(
  configPath: string,
  labelPlan: LabelPlan,
  config: RunnerConfig,
  dryRun: boolean,
): string {
  const missingLabels = labelPlan.missing.map((label) => label.name).join(', ') || 'none';

  return [
    `config: ${configPath}`,
    `mode: ${dryRun ? 'dry-run' : 'write'}`,
    `labels: ${labelPlan.policy}`,
    `missing labels: ${missingLabels}`,
    'skill runtime: package-owned v2',
    `checks: ${Object.keys(config.checks).join(', ')}`,
    `gitignore runtime entries: ${runtimeGitignoreEntries(config).join(', ')}`,
    `codex command: ${config.codex.command}`,
    `branches: base ${formatBaseBranch(config.branches.base)}, ${config.branches.scopedIssue}, ${config.branches.issueTree}`,
    `pull requests: ${config.pullRequests.scopedIssueTitle}, ${config.pullRequests.issueTreeTitle}`,
    'Codex will not be launched',
    'setup will not commit or open a pull request',
  ].join('\n');
}

function existingConfigBase(config: Record<string, unknown> | undefined): CodexOrchestratorConfig['branches']['base'] | undefined {
  const branches = config?.branches;
  if (typeof branches !== 'object' || branches === null || Array.isArray(branches)) {
    return undefined;
  }
  const base = (branches as Record<string, unknown>).base;
  if (typeof base === 'string' && base.length > 0) {
    return base;
  }
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return undefined;
  }
  const objectBase = base as Record<string, unknown>;
  if (objectBase.mode === 'explicit' && typeof objectBase.remote === 'string' && typeof objectBase.branch === 'string') {
    return { mode: 'explicit', remote: objectBase.remote, branch: objectBase.branch };
  }
  return undefined;
}

async function inferCurrentUpstreamBaseBranch(targetRoot: string): Promise<CodexOrchestratorConfig['branches']['base'] | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', targetRoot, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const upstream = result.stdout.trim();
    const separator = upstream.indexOf('/');
    if (separator <= 0 || separator === upstream.length - 1) {
      return undefined;
    }
    return {
      mode: 'explicit',
      remote: upstream.slice(0, separator),
      branch: upstream.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

function readExistingString(
  config: Record<string, unknown> | undefined,
  section: string,
  key: string,
): string | undefined {
  const sectionValue = config?.[section];
  if (typeof sectionValue !== 'object' || sectionValue === null || Array.isArray(sectionValue)) {
    return undefined;
  }

  const value = (sectionValue as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function inferGitHubRepoFromOrigin(targetRoot: string): Promise<{ owner: string; repo: string } | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', targetRoot, 'remote', 'get-url', 'origin']);
    return parseGitHubRemoteUrl(result.stdout.trim());
  } catch {
    return undefined;
  }
}

function parseGitHubRemoteUrl(remoteUrl: string): { owner: string; repo: string } | undefined {
  const patterns = [
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = remoteUrl.match(pattern);
    if (match?.[1] && match[2]) {
      return { owner: match[1], repo: match[2] };
    }
  }

  return undefined;
}
