import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import { validateConfig } from '../config/schema.js';
import { formatBaseBranch } from '../git/base-branch.js';
import { resolveCodexCommand, type CodexCommandResolver } from './codex-command-resolver.js';
import { GhCliLabelAdapter } from './github-label-adapter.js';
import type { GitHubLabelAdapter, LabelPlan } from './labels.js';
import { planLabels } from './labels.js';
import {
  assertNoRuntimeState,
  applyTargetPackageConfigDefaults,
  buildProjectConfig,
  mergeExistingProjectConfig,
  projectConfigPath,
  readExistingConfig,
  writeProjectConfig,
} from './project-config.js';
import {
  checkPromptFiles,
  promptConflictGuidance,
  syncPromptFiles,
  type PromptSyncMode,
  type PromptSyncResult,
} from './prompt-sync.js';
import { resolveWorkflowConfigs, workflowDefinitions } from './workflows.js';

const execFileAsync = promisify(execFile);

export interface SetupCommandOptions {
  targetRoot: string;
  githubOwner?: string;
  githubRepo?: string;
  dryRun?: boolean;
  prepareLabels?: boolean;
  replacePackageSkills?: boolean;
  promptSyncMode?: PromptSyncMode;
  labelAdapter?: GitHubLabelAdapter;
  codexCommandResolver?: CodexCommandResolver;
}

export interface SetupCommandResult {
  config: CodexOrchestratorConfig;
  configPath: string;
  dryRun: boolean;
  labelPlan: LabelPlan;
  promptFiles: string[];
  promptSync?: PromptSyncResult;
  output: string;
}

export async function runSetupCommand(options: SetupCommandOptions): Promise<SetupCommandResult> {
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
  const workflows = await resolveWorkflowConfigs();
  const discoveredCodexCommand = await (options.codexCommandResolver ?? resolveCodexCommand)();
  const inferredBaseBranch = existingConfigBase(existingConfig) ?? await inferCurrentUpstreamBaseBranch(options.targetRoot);
  const defaultConfig = buildProjectConfig({
    owner,
    repo,
    prepareLabels,
    workflows,
    baseBranch: inferredBaseBranch,
  });
  const config = await applyTargetPackageConfigDefaults(
    options.targetRoot,
    mergeExistingProjectConfig(defaultConfig, existingConfig),
  );
  persistDiscoveredCodexCommand(config, discoveredCodexCommand);
  const validation = validateConfig(config);

  if (!validation.ok) {
    throw new Error(`Generated config is invalid: ${validation.errors.join('; ')}`);
  }

  const adapter = options.labelAdapter ?? new GhCliLabelAdapter(owner, repo);
  const labelPlan = await planLabels(adapter, config.github.labels, prepareLabels, dryRun);
  const promptFiles = workflowDefinitions.map((definition) => join(options.targetRoot, definition.promptPath));
  const promptSyncMode = options.promptSyncMode ?? (options.replacePackageSkills ? 'replace' : 'auto');
  let promptSync: PromptSyncResult | undefined;

  if (dryRun) {
    promptSync = await checkPromptFiles(options.targetRoot, promptSyncMode);
  } else {
    await writeProjectConfig(options.targetRoot, config);
    promptSync = await syncPromptFiles(options.targetRoot, promptSyncMode);
    await ensureRuntimeGitignoreEntries(options.targetRoot, config);
    await ensurePackageScripts(options.targetRoot);
  }

  const output = formatSetupOutput(configPath, labelPlan, config, promptFiles, dryRun, promptSync);

  return {
    config,
    configPath,
    dryRun,
    labelPlan,
    promptFiles,
    promptSync,
    output,
  };
}

function persistDiscoveredCodexCommand(
  config: CodexOrchestratorConfig,
  discoveredCodexCommand: string | undefined,
): void {
  if (!discoveredCodexCommand) {
    return;
  }

  if (config.codex.command === 'codex') {
    config.codex.command = discoveredCodexCommand;
  }

  for (const profile of Object.values(config.codex.profiles ?? {})) {
    if (profile?.command === 'codex') {
      profile.command = discoveredCodexCommand;
    }
  }
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

async function ensureRuntimeGitignoreEntries(targetRoot: string, config: CodexOrchestratorConfig): Promise<void> {
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

function runtimeGitignoreEntries(config: CodexOrchestratorConfig): string[] {
  return Array.from(new Set([
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
  config: CodexOrchestratorConfig,
  promptFiles: string[],
  dryRun: boolean,
  promptSync: PromptSyncResult | undefined,
): string {
  const workflowLines = Object.entries(config.workflows)
    .map(([id, workflow]) => `  - ${id}: ${workflow.source}`)
    .join('\n');
  const missingLabels = labelPlan.missing.map((label) => label.name).join(', ') || 'none';
  const promptSummary = promptFiles.map((file) => `  - ${file}`).join('\n');

  return [
    `config: ${configPath}`,
    `mode: ${dryRun ? 'dry-run' : 'write'}`,
    `labels: ${labelPlan.policy}`,
    `missing labels: ${missingLabels}`,
    'workflows:',
    workflowLines,
    'prompts:',
    promptSummary,
    formatPromptSync(promptSync),
    `checks: ${Object.keys(config.checks).join(', ')}`,
    `gitignore runtime entries: ${runtimeGitignoreEntries(config).join(', ')}`,
    `codex command: ${config.codex.command} ${config.codex.args.join(' ')}`,
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

function formatPromptSync(promptSync: PromptSyncResult | undefined): string {
  if (!promptSync) {
    return 'prompt sync: dry-run';
  }

  const line = `prompt sync: ${promptSync.installed.length} installed, ${promptSync.updated.length} updated, ${promptSync.preserved.length} preserved, ${promptSync.conflicts.length} conflict`;
  if (promptSync.conflicts.length === 0) {
    return line;
  }

  return [
    line,
    `prompt conflicts: ${promptSync.conflicts.join(', ')}`,
    ...promptConflictGuidance('codex-orchestrator setup'),
  ].join('\n');
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
