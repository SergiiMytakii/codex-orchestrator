import { readFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { resolveBaseBranch } from '../git/base-branch.js';
import { GitWorktreeManager } from '../git/worktree.js';
import { defaultShellCommandExecutor, type ShellCommandExecutor } from '../process/command.js';
import { readRunnerConfig } from './command-utils.js';
import { readScopedCompletionReport } from './completion-report.js';
import { writeDurableRunSummary } from './durable-run-summary.js';
import { runFreshContextReviewIfEnabled } from './fresh-context-review.js';
import { runImplementationPublishabilityCheck, type LocalExecutionPhaseExecutor } from './local-execution-session.js';
import { RunnerStateStore, type RunnerProcessMetadata } from './local-state.js';
import { RunnerLifecycleEventStore } from './lifecycle-events.js';
import type { AcceptanceProofAttemptEvidence } from './acceptance-proof-runner.js';
import {
  buildBlockedHandoffEvidence,
  buildPromotionAsBlockedHandoffEvidence,
  buildReviewReadyHandoffEvidence,
} from './runner-handoff-decision.js';
import {
  finishScopedBlockedHandoff,
  finishScopedReviewReadyHandoff,
  type ScopedAutoCommandResult,
} from './scoped-auto-command.js';

export const SCOPED_RECOVERY_LEASE_STALE_MS = 30 * 60 * 1000;
export const SCOPED_RECOVERY_BLOCKED_MARKER_PREFIX = '<!-- codex-orchestrator:recovery-blocked';

export type ScopedRecoveryInvocation = 'status' | 'daemon' | 'targeted';
export type ProcessProbeResult = 'alive' | 'missing' | 'unknown';
export type ScopedRecoveryStatus =
  | 'active'
  | 'unknown-or-foreign'
  | 'completed-pending-handoff'
  | 'failed-pending-block';

export interface ScopedRecoveryClassification {
  issueNumber: number;
  status: ScopedRecoveryStatus;
  reason: string;
  canMutate: boolean;
  beforeHead?: string;
  reportState: 'completed' | 'needs-promotion' | 'missing' | 'invalid';
}

export interface ClassifyScopedRecoveryRunInput {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  run: RunnerProcessMetadata;
  issue?: GitHubIssue;
  invocation: ScopedRecoveryInvocation;
  now: Date;
  hostname?: () => string;
  processProbe?: (pid: number) => Promise<ProcessProbeResult> | ProcessProbeResult;
}

export interface RecoverScopedRunInput {
  targetRoot: string;
  issueNumber: number;
  invocation: 'daemon' | 'targeted';
  issueAdapter?: GitHubIssueAdapter;
  pullRequestAdapter?: GitHubPullRequestAdapter;
  git?: GitWorktreeManager;
  codexAdapter?: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  shellExecutor?: ShellCommandExecutor;
  localPhases?: string[];
  localPhaseExecutor?: LocalExecutionPhaseExecutor;
  now?: Date;
  hostname?: () => string;
  processProbe?: (pid: number) => Promise<ProcessProbeResult> | ProcessProbeResult;
}

export type ScopedRecoveryRunResult =
  | { status: 'not-recoverable'; classification: ScopedRecoveryClassification }
  | (ScopedAutoCommandResult & { recovered: true; classification: ScopedRecoveryClassification });

interface OwnershipState {
  kind: 'same-host' | 'cross-host' | 'legacy' | 'unknown';
  stale: boolean;
  process: ProcessProbeResult;
}

export async function classifyScopedRecoveryRun(
  input: ClassifyScopedRecoveryRunInput,
): Promise<ScopedRecoveryClassification> {
  const beforeHead = await resolveBeforeHead(input.targetRoot, input.config, input.run);
  const reportState = await readReportState(input.run);
  const invalidReason = basicInvalidReason(input.run, input.issue, input.config);

  if (invalidReason) {
    return classification(input.run, 'unknown-or-foreign', invalidReason, false, beforeHead, reportState);
  }
  if (!beforeHead) {
    return classification(input.run, 'unknown-or-foreign', 'deterministic base evidence is missing', false, undefined, reportState);
  }

  const ownership = await classifyOwnership(input);
  if (ownership.kind === 'unknown') {
    return classification(input.run, 'unknown-or-foreign', 'lease ownership evidence is invalid or from the future', false, beforeHead, reportState);
  }

  if (ownership.kind === 'same-host' && (ownership.process === 'alive' || ownership.process === 'unknown')) {
    return classification(input.run, 'active', `same-host process is ${ownership.process}`, false, beforeHead, reportState);
  }
  if (ownership.kind === 'same-host' && ownership.process === 'missing' && reportState === 'completed') {
    const canMutate = input.invocation !== 'status';
    return classification(
      input.run,
      'completed-pending-handoff',
      'same-host missing PID with completed report',
      canMutate,
      beforeHead,
      reportState,
    );
  }
  if (ownership.kind === 'same-host' && !ownership.stale) {
    return classification(input.run, 'active', 'same-host lease is still fresh', false, beforeHead, reportState);
  }

  if (input.invocation === 'status') {
    return readOnlyStatusClassification(input.run, beforeHead, reportState, ownership);
  }
  if (input.invocation === 'daemon') {
    if (ownership.kind !== 'same-host' || ownership.process !== 'missing' || !ownership.stale) {
      return classification(input.run, 'unknown-or-foreign', 'daemon recovery requires same-host missing-PID stale lease proof', false, beforeHead, reportState);
    }
    return staleMutatingClassification(input.run, beforeHead, reportState);
  }

  if (reportState === 'completed' && (ownership.kind === 'legacy' || ownership.stale)) {
    return classification(input.run, 'completed-pending-handoff', 'completed report can be recovered by targeted run', true, beforeHead, reportState);
  }
  if (reportState !== 'completed' && ownership.stale) {
    return classification(input.run, 'failed-pending-block', 'stale runner-owned run lacks a completed report', true, beforeHead, reportState);
  }
  return classification(input.run, 'unknown-or-foreign', 'targeted recovery requires stale lease or legacy completed report', false, beforeHead, reportState);
}

export async function recoverScopedRun(input: RecoverScopedRunInput): Promise<ScopedRecoveryRunResult> {
  const targetRoot = input.targetRoot;
  const now = input.now ?? new Date();
  const config = await readRunnerConfig(targetRoot);
  const issueAdapter = input.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const pullRequestAdapter = input.pullRequestAdapter ?? new GhCliPullRequestAdapter(config.github.owner, config.github.repo);
  const git = input.git ?? new GitWorktreeManager();
  const codexAdapter = input.codexAdapter ?? new CodexCommandAdapter(config);
  const shellExecutor = input.shellExecutor ?? defaultShellCommandExecutor;
  const store = new RunnerStateStore(targetRoot, config);
  const state = await store.load();
  const run = state.runs.find((candidate) => candidate.issueNumber === input.issueNumber);
  const issue = await issueAdapter.getIssue(input.issueNumber);

  if (!run || !issue) {
    return {
      status: 'not-recoverable',
      classification: classification(
        run ?? minimalMissingRun(input.issueNumber),
        'unknown-or-foreign',
        run ? 'matching GitHub issue is missing' : 'local runner metadata is missing',
        false,
        undefined,
        'missing',
      ),
    };
  }

  const scoped = await classifyScopedRecoveryRun({
    targetRoot,
    config,
    run,
    issue,
    invocation: input.invocation,
    now,
    hostname: input.hostname,
    processProbe: input.processProbe,
  });
  if (!scoped.canMutate || !scoped.beforeHead) {
    if (hasRecoveryBlockedMarker(issue, run) && scoped.reportState !== 'completed') {
      await store.upsertRun({ ...run, lastRecoveredAt: now.toISOString() });
    }
    return { status: 'not-recoverable', classification: scoped };
  }

  if (scoped.status === 'completed-pending-handoff') {
    return recoverCompletedHandoff({
      targetRoot,
      config,
      run,
      issue,
      classification: { ...scoped, beforeHead: scoped.beforeHead },
      issueAdapter,
      pullRequestAdapter,
      git,
      codexAdapter,
      shellExecutor,
      localPhases: input.localPhases,
      localPhaseExecutor: input.localPhaseExecutor,
      now,
    });
  }
  if (scoped.status === 'failed-pending-block') {
    return blockRecoveredRun({
      targetRoot,
      config,
      run,
      classification: scoped,
      issueAdapter,
      reasons: [blockedReason(scoped.reportState)],
      changedFiles: [],
      validation: [],
      skippedChecks: [],
      residualRisks: [],
      now,
      logPath: run.logPath ?? '',
    });
  }

  return { status: 'not-recoverable', classification: scoped };
}

export function defaultProcessProbe(pid: number): ProcessProbeResult {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EPERM') {
        return 'alive';
      }
      if (error.code === 'ESRCH') {
        return 'missing';
      }
    }
    return 'unknown';
  }
}

export function buildRecoveredCodexResult(reportPath: string): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `codex-orchestrator recovery reused completed report ${reportPath}`,
    stderr: '',
    exitCode: 0,
  };
}

async function recoverCompletedHandoff(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  run: RunnerProcessMetadata;
  issue: GitHubIssue;
  classification: ScopedRecoveryClassification & { beforeHead: string };
  issueAdapter: GitHubIssueAdapter;
  pullRequestAdapter: GitHubPullRequestAdapter;
  git: GitWorktreeManager;
  codexAdapter: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  shellExecutor: ShellCommandExecutor;
  localPhases?: string[];
  localPhaseExecutor?: LocalExecutionPhaseExecutor;
  now: Date;
}): Promise<ScopedRecoveryRunResult> {
  const reportPath = input.run.reportPath ?? '';
  const logPath = input.run.logPath ?? '';
  const afterHead = await input.git.getHead(input.run.workspacePath);
  const publishability = await runImplementationPublishabilityCheck({
    config: input.config,
    issue: input.issue,
    targetRoot: input.targetRoot,
    worktreePath: input.run.workspacePath,
    reportPath,
    beforeHead: input.classification.beforeHead,
    afterHead,
    codexResult: buildRecoveredCodexResult(reportPath),
    git: input.git,
    shellExecutor: input.shellExecutor,
    commitMessage: `Codex: implement issue #${input.run.issueNumber}`,
    localPhases: input.localPhases,
    localPhaseExecutor: input.localPhaseExecutor,
  });
  const baseResult = {
    issueNumber: input.run.issueNumber,
    branchName: input.run.branchName ?? '',
    worktreePath: input.run.workspacePath,
    promptPath: input.run.promptPath ?? '',
    reportPath,
    logPath,
  };

  if (publishability.status !== 'publish-ready') {
    const evidence = publishability.status === 'blocked'
      ? buildBlockedHandoffEvidence({
        publishability,
        nextAction: 'Maintainer input or a corrected agent run is required before draft PR handoff.',
      })
      : buildPromotionAsBlockedHandoffEvidence({
        publishability,
        fallbackReason: 'Recovered report requested promotion',
        nextAction: 'Maintainer input or a corrected agent run is required before draft PR handoff.',
      });
    return blockRecoveredRun({
      targetRoot: input.targetRoot,
      config: input.config,
      run: input.run,
      classification: input.classification,
      issueAdapter: input.issueAdapter,
      reasons: evidence.blockers,
      changedFiles: evidence.changedFiles,
      validation: evidence.validation,
      skippedChecks: evidence.skippedChecks,
      residualRisks: evidence.residualRisks,
      now: input.now,
      logPath,
      nextAction: evidence.nextAction,
      suggestionEvidence: evidence.suggestionEvidence,
      acceptanceProof: evidence.acceptanceProof,
    });
  }

  const freshContextReview = await runFreshContextReviewIfEnabled({
    targetRoot: input.targetRoot,
    config: input.config,
    issue: input.issue,
    codexAdapter: input.codexAdapter,
    worktreePath: input.run.workspacePath,
    isolatedSessionId: `${input.run.sessionId}-fresh-review`,
    branchName: input.run.branchName ?? '',
    publishability,
  });
  if (freshContextReview?.status === 'blocked') {
    const evidence = buildBlockedHandoffEvidence({
      publishability,
      freshContextReview,
      nextAction: 'Review the Fresh-Context Review blocker before draft PR handoff.',
    });
    return blockRecoveredRun({
      targetRoot: input.targetRoot,
      config: input.config,
      run: input.run,
      classification: input.classification,
      issueAdapter: input.issueAdapter,
      reasons: evidence.blockers,
      changedFiles: evidence.changedFiles,
      validation: evidence.validation,
      skippedChecks: evidence.skippedChecks,
      residualRisks: evidence.residualRisks,
      now: input.now,
      logPath,
      freshContextReview,
      nextAction: evidence.nextAction,
      suggestionEvidence: evidence.suggestionEvidence,
      acceptanceProof: evidence.acceptanceProof,
    });
  }

  const evidence = buildReviewReadyHandoffEvidence({
    publishability,
    freshContextReview,
    nextAction: 'Review the draft pull request before merge.',
  });
  const durableRunSummary = await writeDurableRunSummary({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: input.run.issueNumber,
    sessionId: input.run.sessionId,
    outcome: evidence.outcome,
    changedFiles: evidence.changedFiles,
    validation: evidence.validation,
    blockers: evidence.blockers,
    skippedChecks: evidence.skippedChecks,
    residualRisks: evidence.residualRisks,
    suggestionEvidence: evidence.suggestionEvidence,
    nextAction: evidence.nextAction,
    logPath,
    reportPath,
    acceptanceProof: evidence.acceptanceProof,
  });
  const resolvedBase = await resolveBaseBranch({ targetRoot: input.targetRoot, base: input.config.branches.base });
  const handoff = await finishScopedReviewReadyHandoff({
    issueNumber: input.run.issueNumber,
    branchName: input.run.branchName ?? '',
    baseBranch: resolvedBase.prBaseBranch,
    worktreePath: input.run.workspacePath,
    logPath,
    config: input.config,
    git: input.git,
    pullRequestAdapter: input.pullRequestAdapter,
    issueAdapter: input.issueAdapter,
    publishability,
    freshContextReview,
    durableRunSummary,
    acceptanceProof: evidence.acceptanceProof,
  });
  await new RunnerStateStore(input.targetRoot, input.config).removeRun(input.run.issueNumber);
  await safeAppendRecoveryEvent(input.targetRoot, input.config, {
    issueNumber: input.run.issueNumber,
    sessionId: input.run.sessionId,
    status: 'completed',
    summary: 'Recovered interrupted scoped run and completed draft PR handoff.',
    pullRequest: handoff.pullRequest,
  });
  return {
    ...baseResult,
    status: 'review-ready',
    pullRequest: handoff.pullRequest,
    reportComment: handoff.reportComment,
    recovered: true,
    classification: input.classification,
  };
}

async function blockRecoveredRun(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  run: RunnerProcessMetadata;
  classification: ScopedRecoveryClassification;
  issueAdapter: GitHubIssueAdapter;
  reasons: string[];
  changedFiles: string[];
  validation: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; summary: string }>;
  skippedChecks: string[];
  residualRisks: string[];
  now: Date;
  logPath: string;
  nextAction?: string;
  suggestionEvidence?: string[];
  freshContextReview?: Parameters<typeof finishScopedBlockedHandoff>[0]['freshContextReview'];
  acceptanceProof?: AcceptanceProofAttemptEvidence;
}): Promise<ScopedRecoveryRunResult> {
  const marker = recoveryBlockedMarker(input.run);
  const durableRunSummary = await writeDurableRunSummary({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: input.run.issueNumber,
    sessionId: input.run.sessionId,
    outcome: 'blocked',
    changedFiles: input.changedFiles,
    validation: input.validation,
    blockers: input.reasons,
    skippedChecks: input.skippedChecks,
    residualRisks: input.residualRisks,
    suggestionEvidence: input.suggestionEvidence,
    nextAction: input.nextAction ?? 'Maintainer input or a corrected agent run is required before draft PR handoff.',
    logPath: input.logPath,
    reportPath: input.run.reportPath ?? '',
    acceptanceProof: input.acceptanceProof,
  });
  const handoff = await finishScopedBlockedHandoff({
    issueNumber: input.run.issueNumber,
    logPath: input.logPath,
    issueAdapter: input.issueAdapter,
    config: input.config,
    reasons: input.reasons,
    changedFiles: input.changedFiles,
    skippedChecks: input.skippedChecks,
    residualRisks: input.residualRisks,
    freshContextReview: input.freshContextReview,
    durableRunSummary,
    acceptanceProof: input.acceptanceProof,
    commentPrefix: marker,
    skipCommentIfIncludes: marker,
  });
  await new RunnerStateStore(input.targetRoot, input.config).upsertRun({
    ...input.run,
    lastRecoveredAt: input.now.toISOString(),
  });
  await safeAppendRecoveryEvent(input.targetRoot, input.config, {
    issueNumber: input.run.issueNumber,
    sessionId: input.run.sessionId,
    status: 'blocked',
    summary: 'Recovered interrupted scoped run and posted blocked handoff evidence.',
  });
  return {
    issueNumber: input.run.issueNumber,
    branchName: input.run.branchName ?? '',
    worktreePath: input.run.workspacePath,
    promptPath: input.run.promptPath ?? '',
    reportPath: input.run.reportPath ?? '',
    logPath: input.logPath,
    status: 'blocked',
    reportComment: handoff.reportComment,
    recovered: true,
    classification: input.classification,
  };
}

async function readOnlyStatusClassification(
  run: RunnerProcessMetadata,
  beforeHead: string,
  reportState: ScopedRecoveryClassification['reportState'],
  ownership: OwnershipState,
): Promise<ScopedRecoveryClassification> {
  if (reportState === 'completed' && (ownership.kind === 'legacy' || ownership.stale)) {
    return classification(run, 'completed-pending-handoff', 'completed scoped run is pending runner-owned handoff', false, beforeHead, reportState);
  }
  if (reportState !== 'completed' && ownership.stale) {
    return classification(run, 'failed-pending-block', 'stale scoped run is pending blocked recovery', false, beforeHead, reportState);
  }
  return classification(run, 'active', 'scoped run is not stale enough for recovery', false, beforeHead, reportState);
}

function staleMutatingClassification(
  run: RunnerProcessMetadata,
  beforeHead: string,
  reportState: ScopedRecoveryClassification['reportState'],
): ScopedRecoveryClassification {
  if (reportState === 'completed') {
    return classification(run, 'completed-pending-handoff', 'same-host missing-PID stale lease with completed report', true, beforeHead, reportState);
  }
  return classification(run, 'failed-pending-block', 'same-host missing-PID stale lease without completed report', true, beforeHead, reportState);
}

function basicInvalidReason(
  run: RunnerProcessMetadata,
  issue: GitHubIssue | undefined,
  config: CodexOrchestratorConfig,
): string | undefined {
  if (run.mode !== 'scoped-issue') {
    return 'local metadata is not scoped-issue mode';
  }
  if (!run.branchName || !run.workspacePath || !run.reportPath) {
    return 'local metadata is missing branch, worktree, or report path';
  }
  if (!issue) {
    return 'matching GitHub issue is missing';
  }
  if (issue.number !== run.issueNumber) {
    return 'local metadata issue number does not match GitHub issue';
  }
  const labels = new Set(issue.labels.map((label) => label.name));
  if (issue.state !== 'OPEN' || !labels.has(config.github.labels.running.name)) {
    return 'GitHub issue is not open with the running label';
  }
  return undefined;
}

async function classifyOwnership(input: ClassifyScopedRecoveryRunInput): Promise<OwnershipState> {
  const localHost = (input.hostname ?? osHostname)();
  const timestamp = input.run.leaseUpdatedAt ? Date.parse(input.run.leaseUpdatedAt) : Number.NaN;
  const hasLease = Number.isFinite(timestamp);
  const stale = hasLease
    ? input.now.getTime() - timestamp >= SCOPED_RECOVERY_LEASE_STALE_MS
    : false;

  if (hasLease && timestamp > input.now.getTime()) {
    return { kind: 'unknown', stale: false, process: 'unknown' };
  }
  if (!input.run.host && !input.run.ownerPid && !input.run.leaseUpdatedAt) {
    return { kind: 'legacy', stale: false, process: 'unknown' };
  }
  const ownerPid = input.run.ownerPid;
  if (!input.run.host || typeof ownerPid !== 'number' || !Number.isInteger(ownerPid) || !hasLease) {
    return { kind: 'unknown', stale: false, process: 'unknown' };
  }
  if (input.run.host !== localHost) {
    return { kind: 'cross-host', stale, process: 'unknown' };
  }

  const probe = input.processProbe ?? defaultProcessProbe;
  return { kind: 'same-host', stale, process: await probe(ownerPid) };
}

async function readReportState(run: RunnerProcessMetadata): Promise<ScopedRecoveryClassification['reportState']> {
  if (!run.reportPath) {
    return 'missing';
  }
  try {
    const result = await readScopedCompletionReport(run.reportPath);
    if (result.kind === 'missing') {
      return 'missing';
    }
    return result.report.status === 'completed' ? 'completed' : 'needs-promotion';
  } catch {
    return 'invalid';
  }
}

async function resolveBeforeHead(
  targetRoot: string,
  config: CodexOrchestratorConfig,
  run: RunnerProcessMetadata,
): Promise<string | undefined> {
  if (isNonEmpty(run.baseSha)) {
    return run.baseSha;
  }
  const snapshotBase = run.snapshotPath ? await readSnapshotBaseSha(run.snapshotPath) : undefined;
  if (snapshotBase) {
    return snapshotBase;
  }
  return readSnapshotBaseSha(join(
    targetRoot,
    config.runner.stateDir,
    'snapshots',
    `issue-${run.issueNumber}-${run.sessionId}.json`,
  ));
}

async function readSnapshotBaseSha(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const repository = (parsed as Record<string, unknown>).repository;
    if (typeof repository !== 'object' || repository === null || Array.isArray(repository)) {
      return undefined;
    }
    const base = (repository as Record<string, unknown>).base;
    if (typeof base !== 'object' || base === null || Array.isArray(base)) {
      return undefined;
    }
    const sha = (base as Record<string, unknown>).sha;
    return isNonEmpty(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function classification(
  run: RunnerProcessMetadata,
  status: ScopedRecoveryStatus,
  reason: string,
  canMutate: boolean,
  beforeHead: string | undefined,
  reportState: ScopedRecoveryClassification['reportState'],
): ScopedRecoveryClassification {
  return { issueNumber: run.issueNumber, status, reason, canMutate, beforeHead, reportState };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function recoveryBlockedMarker(run: RunnerProcessMetadata): string {
  return `${SCOPED_RECOVERY_BLOCKED_MARKER_PREFIX} issue=${run.issueNumber} session=${run.sessionId} -->`;
}

function hasRecoveryBlockedMarker(issue: GitHubIssue, run: RunnerProcessMetadata): boolean {
  const marker = recoveryBlockedMarker(run);
  return issue.comments.some((comment) => comment.body.includes(marker));
}

function blockedReason(reportState: ScopedRecoveryClassification['reportState']): string {
  if (reportState === 'missing') {
    return 'Recovered scoped run is stale, but the completion report is missing.';
  }
  if (reportState === 'needs-promotion') {
    return 'Recovered scoped run is stale, but the completion report requested promotion.';
  }
  if (reportState === 'invalid') {
    return 'Recovered scoped run is stale, but the completion report is invalid.';
  }
  return 'Recovered scoped run could not be safely published.';
}

function minimalMissingRun(issueNumber: number): RunnerProcessMetadata {
  return {
    issueNumber,
    mode: 'scoped-issue',
    workspacePath: '',
    sessionId: '',
    retryCount: 0,
    createdAt: '',
    updatedAt: '',
  };
}

async function safeAppendRecoveryEvent(
  targetRoot: string,
  config: CodexOrchestratorConfig,
  input: {
    issueNumber: number;
    sessionId: string;
    status: 'completed' | 'blocked';
    summary: string;
    pullRequest?: GitHubPullRequest;
  },
): Promise<void> {
  try {
    await new RunnerLifecycleEventStore(targetRoot, config).append({
      timestamp: new Date(),
      issueNumber: input.issueNumber,
      mode: 'scoped-issue',
      sessionId: input.sessionId,
      phase: 'scoped-issue',
      status: input.status,
      summary: input.summary,
      artifacts: input.pullRequest
        ? [{ kind: 'pr', url: input.pullRequest.url, description: 'Draft pull request' }]
        : [],
    });
  } catch {
    // Recovery lifecycle evidence should not turn a proven handoff into a blocker.
  }
}
