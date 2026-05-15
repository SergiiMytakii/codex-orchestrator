import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { GitWorktreeManager } from '../git/worktree.js';
import { readRunnerConfig } from './command-utils.js';
import { discoverIssueWork, type IssueDiscoveryDecision } from './issue-state-machine.js';
import { runPlanAutoCommand } from './plan-auto-command.js';
import { runScopedAutoCommand } from './scoped-auto-command.js';
import { cleanupMergedWorktrees, type WorktreeCleanupResult } from './worktree-cleanup.js';

export interface DaemonCommandOptions {
  targetRoot: string;
  issueAdapter?: GitHubIssueAdapter;
  pullRequestAdapter?: GitHubPullRequestAdapter;
  git?: GitWorktreeManager;
  intervalMs?: number;
  once?: boolean;
  maxRuns?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  executeIssue?: (issueNumber: number) => Promise<{ reportComment: string }>;
  cleanupWorktrees?: () => Promise<WorktreeCleanupResult>;
  onEvent?: (line: string) => void;
  now?: () => Date;
}

export interface DaemonCommandResult {
  output: string;
  scanned: number;
  executed: number[];
}

const defaultIntervalMs = 300_000;

export async function runDaemonCommand(options: DaemonCommandOptions): Promise<DaemonCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const config = await readRunnerConfig(targetRoot);
  const adapter = options.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const pullRequestAdapter =
    options.pullRequestAdapter ?? new GhCliPullRequestAdapter(config.github.owner, config.github.repo);
  const git = options.git ?? new GitWorktreeManager();
  const intervalMs = options.intervalMs ?? defaultIntervalMs;
  const once = options.once ?? false;
  const maxRuns = options.maxRuns;
  const wait = options.sleep ?? sleep;
  const now = options.now ?? (() => new Date());
  const lines: string[] = [];
  const executed: number[] = [];
  let scanned = 0;

  const emit = (line: string): void => {
    lines.push(line);
    options.onEvent?.(line);
  };

  emit('codex-orchestrator daemon');
  emit(`repo: ${config.github.owner}/${config.github.repo}`);
  emit(`target: ${targetRoot}`);
  emit(`intervalMs: ${intervalMs}`);

  while (true) {
    scanned += 1;
    const decision = await findNextEligibleIssue(adapter, config);

    if (!decision) {
      emit(`[${now().toISOString()}] no eligible issues`);
    } else {
      emit(`[${now().toISOString()}] running #${decision.issueNumber} ${decision.mode}`);
      emit(`[${now().toISOString()}] selection: ${decision.selectionSummary}`);
      try {
        const executeIssue = options.executeIssue ?? ((issueNumber) => runIssue(targetRoot, issueNumber, decision.mode));
        await executeIssue(decision.issueNumber);
        executed.push(decision.issueNumber);
        emit(`[${now().toISOString()}] completed #${decision.issueNumber}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'issue execution failed';
        emit(`[${now().toISOString()}] failed #${decision.issueNumber}: ${message}`);
      }
    }

    try {
      const cleanup =
        options.cleanupWorktrees ??
        (() => cleanupMergedWorktrees({ targetRoot, config, git, pullRequestAdapter }));
      const cleanupResult = await cleanup();
      for (const removed of cleanupResult.removed) {
        emit(
          `[${now().toISOString()}] cleaned worktree ${removed.worktreePath} for PR #${removed.pullRequest.number}`,
        );
      }
      for (const skipped of cleanupResult.skipped.filter((entry) => entry.reason === 'dirty')) {
        emit(`[${now().toISOString()}] skipped dirty worktree ${skipped.worktreePath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'worktree cleanup failed';
      emit(`[${now().toISOString()}] worktree cleanup failed: ${message}`);
    }

    if (once || (maxRuns !== undefined && executed.length >= maxRuns)) {
      break;
    }

    await wait(intervalMs);
  }

  return { output: lines.join('\n'), scanned, executed };
}

async function findNextEligibleIssue(
  adapter: GitHubIssueAdapter,
  config: Awaited<ReturnType<typeof readRunnerConfig>>,
): Promise<(Extract<IssueDiscoveryDecision, { kind: 'eligible' }> & { selectionSummary: string }) | undefined> {
  const discoveryLabels = [
    config.github.labels.auto.name,
    config.github.labels.planAuto.name,
    config.github.labels.manual.name,
    config.github.labels.blocked.name,
    config.github.labels.running.name,
    config.github.labels.review.name,
  ];
  const issues = await adapter.listOpenIssuesWithAnyLabel(discoveryLabels);
  const eligible = discoverIssueWork(issues, config).filter(
    (decision): decision is Extract<IssueDiscoveryDecision, { kind: 'eligible' }> => decision.kind === 'eligible',
  );
  const [selected] = eligible.sort((left, right) => compareEligibleIssueSelection(left, right, issues, config));
  return selected ? { ...selected, selectionSummary: selectionSummary(selected, issues, config) } : undefined;
}

function compareEligibleIssueSelection(
  left: Extract<IssueDiscoveryDecision, { kind: 'eligible' }>,
  right: Extract<IssueDiscoveryDecision, { kind: 'eligible' }>,
  issues: Parameters<typeof discoverIssueWork>[0],
  config: Awaited<ReturnType<typeof readRunnerConfig>>,
): number {
  const leftPriority = priorityRank(left.issueNumber, issues, config);
  const rightPriority = priorityRank(right.issueNumber, issues, config);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.issueNumber - right.issueNumber;
}

function priorityRank(
  issueNumber: number,
  issues: Parameters<typeof discoverIssueWork>[0],
  config: Awaited<ReturnType<typeof readRunnerConfig>>,
): number {
  const issue = issues.find((candidate) => candidate.number === issueNumber);
  const labels = new Set(issue?.labels.map((label) => label.name) ?? []);
  const rank = config.loopPolicy.issueSelection.priorityLabels.findIndex((label) => labels.has(label));
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

function selectionSummary(
  decision: Extract<IssueDiscoveryDecision, { kind: 'eligible' }>,
  issues: Parameters<typeof discoverIssueWork>[0],
  config: Awaited<ReturnType<typeof readRunnerConfig>>,
): string {
  const rank = priorityRank(decision.issueNumber, issues, config);
  const priority = Number.isFinite(rank)
    ? config.loopPolicy.issueSelection.priorityLabels[rank]
    : 'unprioritized';
  return `priority ${priority}, tie-breaker ${config.loopPolicy.issueSelection.tieBreaker}`;
}

function runIssue(
  targetRoot: string,
  issueNumber: number,
  mode: Extract<IssueDiscoveryDecision, { kind: 'eligible' }>['mode'],
): Promise<{ reportComment: string }> {
  if (mode === 'plan-parent') {
    return runPlanAutoCommand({ targetRoot, issueNumber });
  }
  return runScopedAutoCommand({ targetRoot, issueNumber });
}
