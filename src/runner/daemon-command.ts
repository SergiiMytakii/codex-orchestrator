import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import { hasIssueClosureEvidence, type GitHubIssue, type GitHubIssueAdapter } from '../github/issues.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { GitWorktreeManager } from '../git/worktree.js';
import { readRunnerConfig, rereadRunnerConfigUnderFence } from './command-utils.js';
import { discoverIssueWork, type IssueDiscoveryDecision } from './issue-state-machine.js';
import { runPlanAutoCommand } from './plan-auto-command.js';
import { RunnerStateStore } from './local-state.js';
import { runHygieneCleanup, type HygieneCleanupResult } from './hygiene-cleanup.js';
import { recoverScopedRun } from './scoped-recovery.js';
import { runScopedAutoCommand } from './scoped-auto-command.js';
import { issueOwnershipScopes, scopesOverlap } from './scope-isolation-policy.js';
import { cleanupMergedWorktrees, type WorktreeCleanupResult } from './worktree-cleanup.js';
import { acquireTargetActivityFence } from './target-activity-fence.js';
import { runSkillRuntimePreflight } from './skill-runtime-preflight.js';

export interface DaemonCommandOptions {
  targetRoot: string;
  issueAdapter?: GitHubIssueAdapter;
  pullRequestAdapter?: GitHubPullRequestAdapter;
  git?: GitWorktreeManager;
  intervalMs?: number;
  once?: boolean;
  maxRuns?: number;
  concurrency?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  executeIssue?: (issueNumber: number) => Promise<{ reportComment: string }>;
  cleanupHygiene?: () => Promise<HygieneCleanupResult>;
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

function resolveDaemonConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error('daemon concurrency must be an integer between 1 and 3');
  }
  return value;
}

export async function runDaemonCommand(options: DaemonCommandOptions): Promise<DaemonCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const config = await readRunnerConfig(targetRoot);
  const activityLease = await acquireTargetActivityFence({
    targetRoot,
    stateDir: config.runner.stateDir,
    mode: 'shared',
    purpose: 'daemon',
  });
  try {
    const fencedConfig = await rereadRunnerConfigUnderFence(targetRoot, config.runner.stateDir);
    return await runDaemonCommandFenced(options, targetRoot, fencedConfig);
  } finally {
    await activityLease.release();
  }
}

async function runDaemonCommandFenced(
  options: DaemonCommandOptions,
  targetRoot: string,
  config: Awaited<ReturnType<typeof readRunnerConfig>>,
): Promise<DaemonCommandResult> {
  const concurrency = resolveDaemonConcurrency(options.concurrency ?? config.runner.maxParallelScopedIssues ?? 1);
  if (!options.executeIssue) {
    if ((config as { version: number }).version !== 2) throw new Error('orchestrator-skill-runtime-v2-required');
    await runSkillRuntimePreflight({ targetRoot, config: config as any, runId: 'daemon-preflight' });
  }
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
  emit(`concurrency: ${concurrency}`);

  while (true) {
    scanned += 1;
    const recoveryStore = new RunnerStateStore(targetRoot, config);
    const recoveryRuns = (await recoveryStore.load()).runs
      .filter((run) => run.mode === 'scoped-issue')
      .sort((left, right) => left.issueNumber - right.issueNumber);
    for (const run of recoveryRuns) {
      const recovered = await recoverScopedRun({
        targetRoot,
        issueNumber: run.issueNumber,
        invocation: 'daemon',
        issueAdapter: adapter,
        pullRequestAdapter,
        git,
        now: now(),
      });
      if (recovered.status !== 'not-recoverable') {
        emit(`[${now().toISOString()}] recovered #${run.issueNumber} ${recovered.status}`);
      }
    }
    const remainingRuns = maxRuns === undefined ? Number.POSITIVE_INFINITY : maxRuns - executed.length;
    const decisions = remainingRuns > 0
      ? await findNextEligibleIssues(adapter, config, Math.min(concurrency, remainingRuns))
      : [];

    if (decisions.length === 0) {
      emit(`[${now().toISOString()}] no eligible issues`);
    } else {
      for (const decision of decisions) {
        emit(`[${now().toISOString()}] running #${decision.issueNumber} ${decision.mode}`);
        emit(`[${now().toISOString()}] selection: ${decision.selectionSummary}`);
      }

      const results = await Promise.allSettled(
        decisions.map(async (decision) => {
          const executeIssue = options.executeIssue ?? ((issueNumber) => runIssue(targetRoot, issueNumber, decision.mode));
          await executeIssue(decision.issueNumber);
          return decision.issueNumber;
        }),
      );

      for (const [index, result] of results.entries()) {
        const decision = decisions[index];
        if (!decision) {
          continue;
        }
        if (result.status === 'fulfilled') {
          executed.push(result.value);
          emit(`[${now().toISOString()}] completed #${decision.issueNumber}`);
        } else {
          const message = result.reason instanceof Error ? result.reason.message : 'issue execution failed';
          emit(`[${now().toISOString()}] failed #${decision.issueNumber}: ${message}`);
        }
      }
    }

    try {
      const hygiene =
        options.cleanupHygiene ??
        (() => runHygieneCleanup({ targetRoot, config, git }));
      const hygieneResult = await hygiene();
      if (hygieneResult.staleRunsRemoved.length > 0) {
        emit(
          `[${now().toISOString()}] hygiene pruned ${hygieneResult.staleRunsRemoved.length} stale runner-state run(s)`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'hygiene cleanup failed';
      emit(`[${now().toISOString()}] hygiene cleanup failed: ${message}`);
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

    try {
      const staleReviewIssues = await cleanupClosedReviewLabels({ adapter, config });
      for (const issue of staleReviewIssues) {
        emit(`[${now().toISOString()}] removed stale review label from closed #${issue.number}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'closed review-label cleanup failed';
      emit(`[${now().toISOString()}] closed review-label cleanup failed: ${message}`);
    }

    if (once || (maxRuns !== undefined && executed.length >= maxRuns)) {
      break;
    }

    await wait(intervalMs);
  }

  return { output: lines.join('\n'), scanned, executed };
}

async function cleanupClosedReviewLabels(input: {
  adapter: GitHubIssueAdapter;
  config: Awaited<ReturnType<typeof readRunnerConfig>>;
}): Promise<GitHubIssue[]> {
  const reviewLabel = input.config.github.labels.review.name;
  const issues = await input.adapter.listClosedIssuesWithAnyLabel([reviewLabel]);
  const cleaned: GitHubIssue[] = [];
  for (const issue of issues) {
    if (!hasIssueClosureEvidence(issue)) {
      continue;
    }
    await input.adapter.removeLabels(issue.number, [reviewLabel]);
    cleaned.push(issue);
  }
  return cleaned;
}

async function findNextEligibleIssues(
  adapter: GitHubIssueAdapter,
  config: Awaited<ReturnType<typeof readRunnerConfig>>,
  limit: number,
): Promise<Array<Extract<IssueDiscoveryDecision, { kind: 'eligible' }> & { selectionSummary: string }>> {
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
  return selectEligibleIssueBatch(eligible, issues, config, limit).map((selected) => ({
    ...selected,
    selectionSummary: selectionSummary(selected, issues, config),
  }));
}

function selectEligibleIssueBatch(
  eligible: Array<Extract<IssueDiscoveryDecision, { kind: 'eligible' }>>,
  issues: GitHubIssue[],
  config: Awaited<ReturnType<typeof readRunnerConfig>>,
  limit: number,
): Array<Extract<IssueDiscoveryDecision, { kind: 'eligible' }>> {
  if (limit < 1) {
    return [];
  }

  const sorted = [...eligible].sort((left, right) => compareEligibleIssueSelection(left, right, issues, config));
  const batch: Array<Extract<IssueDiscoveryDecision, { kind: 'eligible' }>> = [];

  for (const decision of sorted) {
    if (batch.length >= limit) {
      break;
    }
    if (decision.mode === 'plan-parent') {
      if (batch.length === 0) {
        batch.push(decision);
        break;
      }
      continue;
    }
    if (canAddScopedIssueToBatch(decision, batch, issues)) {
      batch.push(decision);
    }
  }

  return batch;
}

function canAddScopedIssueToBatch(
  decision: Extract<IssueDiscoveryDecision, { kind: 'eligible' }>,
  batch: Array<Extract<IssueDiscoveryDecision, { kind: 'eligible' }>>,
  issues: GitHubIssue[],
): boolean {
  if (batch.some((selected) => selected.mode === 'plan-parent')) {
    return false;
  }

  const scopes = ownershipScopesForIssue(decision.issueNumber, issues);
  if (!scopes) {
    return batch.length === 0;
  }

  for (const selected of batch) {
    const selectedScopes = ownershipScopesForIssue(selected.issueNumber, issues);
    if (!selectedScopes || scopesOverlap(scopes, selectedScopes)) {
      return false;
    }
  }

  return true;
}

function ownershipScopesForIssue(issueNumber: number, issues: GitHubIssue[]): string[] | undefined {
  const issue = issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) {
    return undefined;
  }

  const scopes = issueOwnershipScopes(issue);
  return scopes.length > 0 ? Array.from(new Set(scopes)).sort((left, right) => left.localeCompare(right)) : undefined;
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
