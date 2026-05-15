import { resolve } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import { readRunnerConfig } from './command-utils.js';
import { discoverIssueWork, type IssueDiscoveryDecision } from './issue-state-machine.js';
import { RunnerStateStore } from './local-state.js';
import type { RunnerProcessMetadata } from './local-state.js';
import { RunnerLifecycleEventStore, type RunnerLifecycleEvent } from './lifecycle-events.js';
import { reconcileRunnerState, type RecoveryEntry } from './recovery.js';

export interface StatusCommandOptions {
  targetRoot: string;
  issueAdapter?: GitHubIssueAdapter;
  dryRun?: boolean;
  json?: boolean;
}

export interface StatusCommandResult {
  output: string;
  dryRun: boolean;
  eligible: IssueDiscoveryDecision[];
  skipped: IssueDiscoveryDecision[];
  recovery: RecoveryEntry[];
  activeRuns: RunnerProcessMetadata[];
  recentEvents: RunnerLifecycleEvent[];
  json?: StatusJson;
}

export interface StatusJson {
  version: 1;
  generatedAt: string;
  repo: { owner: string; name: string };
  target: string;
  dryRun: boolean;
  eligible: IssueDiscoveryDecision[];
  skipped: IssueDiscoveryDecision[];
  recovery: RecoveryEntry[];
  activeRuns: RunnerProcessMetadata[];
  recentEvents: RunnerLifecycleEvent[];
}

export async function runStatusCommand(options: StatusCommandOptions): Promise<StatusCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const config = await readRunnerConfig(targetRoot);
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
  const store = new RunnerStateStore(targetRoot, config);
  const recovery = await reconcileRunnerState({
    store,
    issueAdapter: adapter,
    config,
    now: new Date(),
    allowClarificationResume: false,
    updateLocalState: false,
  });
  const dryRun = options.dryRun ?? false;
  const activeRuns = (await store.load()).runs;
  const recentEvents = await new RunnerLifecycleEventStore(targetRoot, config).readRecent(20);
  const json = buildStatusJson(config, targetRoot, dryRun, eligible, skipped, recovery, activeRuns, recentEvents);

  return {
    output: options.json
      ? JSON.stringify(json, null, 2)
      : formatStatusOutput(config, targetRoot, dryRun, eligible, skipped, recovery),
    dryRun,
    eligible,
    skipped,
    recovery,
    activeRuns,
    recentEvents,
    json,
  };
}

function buildStatusJson(
  config: CodexOrchestratorConfig,
  targetRoot: string,
  dryRun: boolean,
  eligible: Extract<IssueDiscoveryDecision, { kind: 'eligible' }>[],
  skipped: Extract<IssueDiscoveryDecision, { kind: 'skipped' }>[],
  recovery: RecoveryEntry[],
  activeRuns: RunnerProcessMetadata[],
  recentEvents: RunnerLifecycleEvent[],
): StatusJson {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repo: { owner: config.github.owner, name: config.github.repo },
    target: targetRoot,
    dryRun,
    eligible,
    skipped,
    recovery,
    activeRuns,
    recentEvents,
  };
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
