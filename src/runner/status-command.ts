import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { validateConfig, type CodexOrchestratorConfig } from '../config/schema.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import { projectConfigPath } from '../setup/project-config.js';
import { discoverIssueWork, type IssueDiscoveryDecision } from './issue-state-machine.js';
import { RunnerStateStore } from './local-state.js';
import { reconcileRunnerState, type RecoveryEntry } from './recovery.js';

export interface StatusCommandOptions {
  targetRoot: string;
  issueAdapter?: GitHubIssueAdapter;
  dryRun?: boolean;
}

export interface StatusCommandResult {
  output: string;
  dryRun: boolean;
  eligible: IssueDiscoveryDecision[];
  skipped: IssueDiscoveryDecision[];
  recovery: RecoveryEntry[];
}

export async function runStatusCommand(options: StatusCommandOptions): Promise<StatusCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const config = await readProjectConfig(targetRoot);
  const adapter = options.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const discoveryLabels = [
    config.github.labels.auto.name,
    config.github.labels.planAuto.name,
    config.github.labels.manual.name,
    config.github.labels.blocked.name,
    config.github.labels.running.name,
    config.github.labels.review.name,
  ];
  const issues = await adapter.listOpenIssuesWithAnyLabel(discoveryLabels);
  const decisions = discoverIssueWork(issues, config);
  const eligible = decisions.filter((decision): decision is Extract<IssueDiscoveryDecision, { kind: 'eligible' }> => (
    decision.kind === 'eligible'
  ));
  const skipped = decisions.filter((decision): decision is Extract<IssueDiscoveryDecision, { kind: 'skipped' }> => (
    decision.kind === 'skipped'
  ));
  const recovery = await reconcileRunnerState({
    store: new RunnerStateStore(targetRoot, config),
    issueAdapter: adapter,
    config,
    now: new Date(),
    allowClarificationResume: false,
    updateLocalState: false,
  });
  const dryRun = options.dryRun ?? false;

  return {
    output: formatStatusOutput(config, targetRoot, dryRun, eligible, skipped, recovery),
    dryRun,
    eligible,
    skipped,
    recovery,
  };
}

async function readProjectConfig(targetRoot: string): Promise<CodexOrchestratorConfig> {
  const content = await readFile(projectConfigPath(targetRoot), 'utf8');
  const parsed = JSON.parse(content) as unknown;
  const validation = validateConfig(parsed);
  if (!validation.ok) {
    throw new Error(`Invalid config: ${validation.errors.join('; ')}`);
  }
  return validation.value;
}

function formatStatusOutput(
  config: CodexOrchestratorConfig,
  targetRoot: string,
  dryRun: boolean,
  eligible: Extract<IssueDiscoveryDecision, { kind: 'eligible' }>[],
  skipped: Extract<IssueDiscoveryDecision, { kind: 'skipped' }>[],
  recovery: RecoveryEntry[],
): string {
  return [
    'codex-orchestrator status',
    `repo: ${config.github.owner}/${config.github.repo}`,
    `target: ${targetRoot}`,
    `mode: ${dryRun ? 'dry-run' : 'status'}`,
    'eligible:',
    ...formatEligible(eligible),
    'skipped:',
    ...formatSkipped(skipped),
    'recovery:',
    ...formatRecovery(recovery),
  ].join('\n');
}

function formatEligible(eligible: Extract<IssueDiscoveryDecision, { kind: 'eligible' }>[]): string[] {
  if (eligible.length === 0) {
    return ['  - none'];
  }
  return eligible.map((decision) => `  - #${decision.issueNumber} ${decision.mode}: ${decision.reason}`);
}

function formatSkipped(skipped: Extract<IssueDiscoveryDecision, { kind: 'skipped' }>[]): string[] {
  if (skipped.length === 0) {
    return ['  - none'];
  }
  return skipped.map((decision) => `  - #${decision.issueNumber} ${decision.reasonCode}: ${decision.reason}`);
}

function formatRecovery(recovery: RecoveryEntry[]): string[] {
  if (recovery.length === 0) {
    return ['  - none'];
  }
  return recovery.map((entry) => `  - #${entry.issueNumber} ${entry.status}: ${entry.reason}`);
}
