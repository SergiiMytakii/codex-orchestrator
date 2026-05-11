import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import { validateConfig } from '../config/schema.js';
import { GhCliLabelAdapter } from './github-label-adapter.js';
import type { GitHubLabelAdapter, LabelPlan } from './labels.js';
import { planLabels } from './labels.js';
import {
  assertNoRuntimeState,
  buildProjectConfig,
  mergeExistingProjectConfig,
  projectConfigPath,
  readExistingConfig,
  writeProjectConfig,
} from './project-config.js';
import { defaultSkillsRoot, resolveWorkflowConfigs, workflowDefinitions } from './workflows.js';

const execFileAsync = promisify(execFile);

export interface SetupCommandOptions {
  targetRoot: string;
  githubOwner?: string;
  githubRepo?: string;
  dryRun?: boolean;
  prepareLabels?: boolean;
  skillsRoot?: string;
  replacePackageSkills?: boolean;
  labelAdapter?: GitHubLabelAdapter;
}

export interface SetupCommandResult {
  config: CodexOrchestratorConfig;
  configPath: string;
  dryRun: boolean;
  labelPlan: LabelPlan;
  promptFiles: string[];
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
  const workflows = await resolveWorkflowConfigs(options.skillsRoot ?? defaultSkillsRoot());
  const defaultConfig = buildProjectConfig({
    owner,
    repo,
    prepareLabels,
    workflows,
  });
  const config = mergeExistingProjectConfig(defaultConfig, existingConfig);
  const validation = validateConfig(config);

  if (!validation.ok) {
    throw new Error(`Generated config is invalid: ${validation.errors.join('; ')}`);
  }

  const adapter = options.labelAdapter ?? new GhCliLabelAdapter(owner, repo);
  const labelPlan = await planLabels(adapter, config.github.labels, prepareLabels, dryRun);
  const promptFiles = workflowDefinitions.map((definition) => join(options.targetRoot, definition.promptPath));

  if (!dryRun) {
    await writeProjectConfig(options.targetRoot, config);
    await copyPromptFiles(options.targetRoot, options.replacePackageSkills ?? false);
  }

  const output = formatSetupOutput(configPath, labelPlan, config, promptFiles, dryRun);

  return {
    config,
    configPath,
    dryRun,
    labelPlan,
    promptFiles,
    output,
  };
}

function formatSetupOutput(
  configPath: string,
  labelPlan: LabelPlan,
  config: CodexOrchestratorConfig,
  promptFiles: string[],
  dryRun: boolean,
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
    `checks: ${Object.keys(config.checks).join(', ')}`,
    `codex command: ${config.codex.command} ${config.codex.args.join(' ')}`,
    `branches: base ${config.branches.base}, ${config.branches.scopedIssue}, ${config.branches.issueTree}`,
    `pull requests: ${config.pullRequests.scopedIssueTitle}, ${config.pullRequests.issueTreeTitle}`,
    'Codex will not be launched',
    'setup will not commit or open a pull request',
  ].join('\n');
}

async function copyPromptFiles(targetRoot: string, replacePackageSkills: boolean): Promise<void> {
  await copyPrompt('setup-skill.md', join(targetRoot, '.codex-orchestrator', 'prompts', 'setup-skill.md'), replacePackageSkills);

  for (const definition of workflowDefinitions) {
    const sourceName = definition.promptPath.replace('.codex-orchestrator/prompts/workflows/', '');
    await copyPrompt(
      join('workflows', sourceName),
      join(targetRoot, definition.promptPath),
      replacePackageSkills,
    );
  }
}

async function copyPrompt(relativePromptPath: string, destination: string, replacePackageSkills: boolean): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const source = new URL(`../../../prompts/${relativePromptPath}`, import.meta.url);

  if (replacePackageSkills) {
    await cp(source, destination, { force: true });
    return;
  }

  try {
    await readFile(destination, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      const content = await readFile(source, 'utf8');
      await writeFile(destination, content, 'utf8');
      return;
    }

    throw error;
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
