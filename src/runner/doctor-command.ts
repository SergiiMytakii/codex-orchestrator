import { access, constants } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import { codexPhaseKeys } from '../config/schema.js';
import { baseBranchParts, formatBaseBranch, isLegacyBaseBranch } from '../git/base-branch.js';
import { resolveExecutableCommand, type ExecutableCommandResolver } from '../setup/codex-command-resolver.js';
import type { GitHubLabelAdapter } from '../setup/labels.js';
import { GhCliLabelAdapter } from '../setup/github-label-adapter.js';
import { checkPromptFiles, promptConflictGuidance } from '../setup/prompt-sync.js';
import { defaultShellCommandExecutor, type ShellCommandExecutor } from '../process/command.js';
import { readRunnerConfig } from './command-utils.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheckResult {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  summary: string;
  details?: string[];
}

export interface DoctorJson {
  version: 1;
  generatedAt: string;
  repo: { owner: string; name: string };
  target: string;
  summary: { pass: number; warn: number; fail: number };
  pass: DoctorCheckResult[];
  warn: DoctorCheckResult[];
  fail: DoctorCheckResult[];
}

export interface DoctorCommandOptions {
  targetRoot: string;
  json?: boolean;
  labelAdapter?: GitHubLabelAdapter;
  shellExecutor?: ShellCommandExecutor;
  commandResolver?: ExecutableCommandResolver;
}

export interface DoctorCommandResult {
  output: string;
  json: DoctorJson;
}

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<DoctorCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const checks: DoctorCheckResult[] = [];
  let config: CodexOrchestratorConfig | undefined;

  try {
    config = await readRunnerConfig(targetRoot);
    checks.push(check('config', 'Config', 'pass', 'config is valid'));
  } catch (error) {
    checks.push(check('config', 'Config', 'fail', error instanceof Error ? error.message : 'config is invalid'));
  }

  if (config) {
    const shellExecutor = options.shellExecutor ?? defaultShellCommandExecutor;
    const commandResolver = options.commandResolver ?? resolveExecutableCommand;
    const labelAdapter = options.labelAdapter ?? new GhCliLabelAdapter(config.github.owner, config.github.repo);
    checks.push(...await collectReadinessChecks(targetRoot, config, labelAdapter, shellExecutor, commandResolver));
  }

  const json = buildDoctorJson(targetRoot, config, checks);
  return {
    output: options.json ? JSON.stringify(json, null, 2) : formatDoctorText(json),
    json,
  };
}

async function collectReadinessChecks(
  targetRoot: string,
  config: CodexOrchestratorConfig,
  labelAdapter: GitHubLabelAdapter,
  shellExecutor: ShellCommandExecutor,
  commandResolver: ExecutableCommandResolver,
): Promise<DoctorCheckResult[]> {
  const checks: DoctorCheckResult[] = [];
  checks.push(await checkCommand(commandResolver, 'git', 'git', 'Git command'));
  checks.push(await checkShell(shellExecutor, 'git-repository', 'Git repository', 'git rev-parse --is-inside-work-tree', targetRoot));
  checks.push(await checkShell(
    shellExecutor,
    'base-branch',
    'Base branch',
    baseBranchReadinessCommand(config),
    targetRoot,
  ));
  if (isLegacyBaseBranch(config.branches.base)) {
    checks.push(check(
      'base-branch-config-format',
      'Base branch config format',
      'warn',
      `legacy base branch config detected: ${config.branches.base}; run setup to migrate to an explicit remote base`,
    ));
  }
  checks.push(await checkCodexBranchBases(targetRoot, config, shellExecutor));
  checks.push(await checkLabels(labelAdapter, Object.values(config.github.labels).map((label) => label.name)));
  checks.push(await checkPath(targetRoot, 'target', 'Target directory'));
  checks.push(await checkPath(resolve(targetRoot, config.runner.stateDir), 'state-dir', 'Runner state directory', 'warn'));
  checks.push(await checkPath(resolve(targetRoot, config.runner.workspaceRoot), 'workspace-root', 'Runner workspace root', 'warn'));
  checks.push(await checkPromptUpdates(targetRoot));
  checks.push(await checkCommand(commandResolver, config.codex.command, 'codex-command', 'Codex command'));
  checks.push(...await checkProfileCommands(config, commandResolver));
  checks.push(check(
    'configured-checks',
    'Configured checks',
    Object.keys(config.checks).length > 0 ? 'pass' : 'warn',
    Object.keys(config.checks).length > 0 ? `${Object.keys(config.checks).length} check(s) configured` : 'no configured checks',
  ));
  checks.push(check(
    'phase-profiles',
    'Phase profiles',
    'pass',
    'phase profile config is valid and missing profiles fall back to global Codex config',
  ));
  checks.push(check(
    'acceptance-proof',
    'Acceptance proof prerequisites',
    config.reviewGates.acceptanceProof.enabled && !config.reviewGates.acceptanceProof.runnerValidationCommand ? 'warn' : 'pass',
    config.reviewGates.acceptanceProof.enabled
      ? 'acceptance proof gate is enabled'
      : 'acceptance proof gate is disabled',
  ));
  return checks;
}

function baseBranchReadinessCommand(config: CodexOrchestratorConfig): string {
  const base = baseBranchParts(config.branches.base);
  return [
    `git fetch ${shellQuote(base.remote)} --prune`,
    `git rev-parse --verify ${shellQuote(base.remoteRef)}`,
  ].join(' && ');
}

async function checkCodexBranchBases(
  targetRoot: string,
  config: CodexOrchestratorConfig,
  shellExecutor: ShellCommandExecutor,
): Promise<DoctorCheckResult> {
  const base = baseBranchParts(config.branches.base);
  const result = await shellExecutor(
    `for branch in $(git for-each-ref --format='%(refname:short)' refs/heads/codex); do git merge-base --is-ancestor ${shellQuote(base.remoteRef)} "$branch" || echo "$branch"; done`,
    { cwd: targetRoot },
  );
  if (result.exitCode !== 0) {
    return check('codex-branch-bases', 'Codex branch bases', 'warn', result.stderr || result.stdout || 'could not inspect codex branches');
  }
  const mismatched = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return check(
    'codex-branch-bases',
    'Codex branch bases',
    mismatched.length === 0 ? 'pass' : 'warn',
    mismatched.length === 0
      ? `local codex branches contain configured base ${formatBaseBranch(config.branches.base)}`
      : `${mismatched.length} local codex branch(es) do not contain configured base ${formatBaseBranch(config.branches.base)}`,
    mismatched,
  );
}

async function checkPromptUpdates(targetRoot: string): Promise<DoctorCheckResult> {
  const result = await checkPromptFiles(targetRoot);
  const pending = result.installed.length + result.updated.length + result.conflicts.length;
  if (pending === 0) {
    return check('prompt-sync', 'Prompt sync', 'pass', 'project prompts match bundled package prompts');
  }

  return check(
    'prompt-sync',
    'Prompt sync',
    'warn',
    `prompt updates available: ${result.installed.length} missing, ${result.updated.length} safe update(s), ${result.conflicts.length} conflict(s)`,
    [
      'Run codex-orchestrator setup --sync-prompts=auto to apply safe prompt updates.',
      'If conflicts are reported, ask the user to choose keep, merge, or replace.',
      ...promptConflictGuidance('codex-orchestrator setup'),
    ],
  );
}

async function checkProfileCommands(
  config: CodexOrchestratorConfig,
  commandResolver: ExecutableCommandResolver,
): Promise<DoctorCheckResult[]> {
  const checks: DoctorCheckResult[] = [];
  for (const phase of codexPhaseKeys) {
    const command = config.codex.profiles?.[phase]?.command;
    if (!command || command === config.codex.command) {
      continue;
    }
    checks.push(await checkCommand(commandResolver, command, `codex-profile-${phase}`, `Codex profile ${phase}`));
  }
  return checks;
}

async function checkLabels(adapter: GitHubLabelAdapter, requiredLabels: string[]): Promise<DoctorCheckResult> {
  try {
    const labels = await adapter.listLabels();
    const existing = new Set(labels.map((label) => label.name));
    const missing = requiredLabels.filter((label) => !existing.has(label));
    return check(
      'github-labels',
      'GitHub labels',
      missing.length === 0 ? 'pass' : 'warn',
      missing.length === 0 ? 'all required labels exist' : `${missing.length} required label(s) missing`,
      missing,
    );
  } catch (error) {
    return check(
      'github-reachability',
      'GitHub reachability',
      'fail',
      error instanceof Error ? error.message : 'GitHub labels could not be listed',
    );
  }
}

async function checkPath(path: string, id: string, title: string, missingStatus: DoctorCheckStatus = 'fail'): Promise<DoctorCheckResult> {
  try {
    await access(path, constants.R_OK);
    return check(id, title, 'pass', `${path} is readable`);
  } catch {
    return check(id, title, missingStatus, `${path} is not readable`);
  }
}

async function checkCommand(
  commandResolver: ExecutableCommandResolver,
  command: string,
  id: string,
  title: string,
): Promise<DoctorCheckResult> {
  const resolvedCommand = await commandResolver(command);
  return check(
    id,
    title,
    resolvedCommand ? 'pass' : 'fail',
    resolvedCommand ? `${title} is ready` : unavailableCommandSummary(id, command),
  );
}

async function checkShell(
  shellExecutor: ShellCommandExecutor,
  id: string,
  title: string,
  command: string,
  cwd?: string,
): Promise<DoctorCheckResult> {
  const result = await shellExecutor(command, { cwd });
  return check(
    id,
    title,
    result.exitCode === 0 ? 'pass' : 'fail',
    result.exitCode === 0
      ? `${title} is ready`
      : (result.stderr || result.stdout || `${title} failed`),
  );
}

function unavailableCommandSummary(id: string, command: string): string {
  if (id === 'codex-command') {
    return `Codex command '${command}' is not available. Re-run setup so codex-orchestrator can persist a stable Codex CLI path.`;
  }

  if (id.startsWith('codex-profile-')) {
    return `Codex profile command '${command}' is not available. Re-run setup or update the configured profile command.`;
  }

  return `Command '${command}' is not available.`;
}

function buildDoctorJson(
  targetRoot: string,
  config: CodexOrchestratorConfig | undefined,
  checks: DoctorCheckResult[],
): DoctorJson {
  const pass = checks.filter((item) => item.status === 'pass');
  const warn = checks.filter((item) => item.status === 'warn');
  const fail = checks.filter((item) => item.status === 'fail');
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repo: { owner: config?.github.owner ?? '', name: config?.github.repo ?? '' },
    target: targetRoot,
    summary: { pass: pass.length, warn: warn.length, fail: fail.length },
    pass,
    warn,
    fail,
  };
}

function formatDoctorText(result: DoctorJson): string {
  return [
    'codex-orchestrator doctor',
    `repo: ${result.repo.owner}/${result.repo.name}`,
    `target: ${result.target}`,
    `summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail`,
    'pass:',
    ...formatChecks(result.pass),
    'warn:',
    ...formatChecks(result.warn),
    'fail:',
    ...formatChecks(result.fail),
  ].join('\n');
}

function formatChecks(checks: DoctorCheckResult[]): string[] {
  return checks.length === 0 ? ['  - none'] : checks.map((item) => `  - ${item.id}: ${item.summary}`);
}

function check(
  id: string,
  title: string,
  status: DoctorCheckStatus,
  summary: string,
  details?: string[],
): DoctorCheckResult {
  return { id, title, status, summary, details };
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
