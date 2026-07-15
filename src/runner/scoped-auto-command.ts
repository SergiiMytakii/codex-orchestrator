import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { resolveBaseBranch } from '../git/base-branch.js';
import { GitWorktreeManager, renderBranchTemplate } from '../git/worktree.js';
import { defaultShellCommandExecutor, type ShellCommandExecutor } from '../process/command.js';
import {
  formatSessionTimestamp,
  readRunnerConfig,
  rereadRunnerConfigUnderFence,
} from './command-utils.js';
import {
  buildPromotionRequestReport,
  buildScopedBlockedReport,
  buildScopedPullRequestBody,
  buildScopedReviewReport,
  type FreshContextReviewEvidence,
} from './handoff-evidence.js';
import { writeDurableRunSummary, type ReworkAttemptEvidence } from './durable-run-summary.js';
import { runFreshContextReviewIfEnabled } from './fresh-context-review.js';
import { claimIssue, discoverIssueWork } from './issue-state-machine.js';
import type { ScopedCompletionReport } from './completion-report.js';
import {
  type ImplementationPublishabilityResult,
  type LocalExecutionPhaseExecutor,
  type PublishabilityRepairAttempt,
} from './local-execution-session.js';
import { RunnerStateStore } from './local-state.js';
import { RunnerLifecycleEventStore, type LifecycleArtifact } from './lifecycle-events.js';
import type { AcceptanceProofAttemptEvidence } from './acceptance-proof-runner.js';
import {
  buildScopedImplementationPrompt,
} from './prompt.js';
import { runAgentAttemptLoop } from './agent-attempt.js';
import {
  buildBlockedHandoffEvidence,
  buildPromotionRequestedHandoffEvidence,
  buildReviewReadyHandoffEvidence,
} from './runner-handoff-decision.js';
import { sessionLogPath } from './run-log.js';
import {
  finishBlockedTerminalOutcome,
  finishPromotionRequestedTerminalOutcome,
  finishReviewReadyTerminalOutcome,
} from './terminal-outcome.js';
import { acquireTargetActivityFence } from './target-activity-fence.js';

export interface ScopedAutoCommandOptions {
  targetRoot: string;
  issueNumber: number;
  issueAdapter?: GitHubIssueAdapter;
  pullRequestAdapter?: GitHubPullRequestAdapter;
  git?: GitWorktreeManager;
  codexAdapter?: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  localPhases?: string[];
  localPhaseExecutor?: LocalExecutionPhaseExecutor;
  shellExecutor?: ShellCommandExecutor;
  now?: Date;
}

export interface ScopedRecoveryRetryOptions extends ScopedAutoCommandOptions {
  issue: GitHubIssue;
  startAttempt: number;
  initialRework: {
    attempt: number;
    blockedReasons: string[];
    disableOptionalFigmaMcp?: boolean;
  };
}

export interface ScopedAutoCommandResult {
  issueNumber: number;
  branchName: string;
  worktreePath: string;
  promptPath: string;
  reportPath: string;
  logPath: string;
  pullRequest?: GitHubPullRequest;
  status: 'review-ready' | 'blocked' | 'promotion-requested';
  reportComment: string;
}

export async function runScopedAutoCommand(options: ScopedAutoCommandOptions): Promise<ScopedAutoCommandResult> {
  return withScopedActivityFence(options, () => runScopedAutoCommandInternal(options));
}

export async function runScopedRecoveryRetry(options: ScopedRecoveryRetryOptions): Promise<ScopedAutoCommandResult> {
  return withScopedActivityFence(options, () => runScopedAutoCommandInternal(options, {
    issue: options.issue,
    startAttempt: options.startAttempt,
    initialRework: options.initialRework,
  }));
}

async function withScopedActivityFence<T>(options: ScopedAutoCommandOptions, action: () => Promise<T>): Promise<T> {
  const targetRoot = resolve(options.targetRoot);
  const config = await readRunnerConfig(targetRoot);
  const lease = await acquireTargetActivityFence({
    targetRoot,
    stateDir: config.runner.stateDir,
    mode: 'shared',
    purpose: 'claim',
  });
  try {
    await rereadRunnerConfigUnderFence(targetRoot, config.runner.stateDir);
    return await action();
  } finally {
    await lease.release();
  }
}

async function runScopedAutoCommandInternal(
  options: ScopedAutoCommandOptions,
  recovery?: {
    issue: GitHubIssue;
    startAttempt: number;
    initialRework: {
      attempt: number;
      blockedReasons: string[];
      disableOptionalFigmaMcp?: boolean;
    };
  },
): Promise<ScopedAutoCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const now = options.now ?? new Date();
  const config = await readRunnerConfig(targetRoot);
  const issueAdapter = options.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const pullRequestAdapter = options.pullRequestAdapter ?? new GhCliPullRequestAdapter(config.github.owner, config.github.repo);
  const git = options.git ?? new GitWorktreeManager();
  const shellExecutor = options.shellExecutor ?? defaultShellCommandExecutor;
  const codexAdapter = options.codexAdapter ?? new CodexCommandAdapter(config);
  const resolvedBase = await resolveBaseBranch({ targetRoot, base: config.branches.base });
  const issue = recovery?.issue ?? await issueAdapter.getIssue(options.issueNumber);

  if (!issue) {
    throw new Error(`Issue #${options.issueNumber} was not found`);
  }

  if (issue.number !== options.issueNumber) {
    throw new Error(`Recovery issue #${issue.number} does not match scoped issue #${options.issueNumber}`);
  }

  if (!recovery) {
    const decision = discoverIssueWork([issue], config)[0];
    if (!decision || decision.kind !== 'eligible' || decision.mode !== 'scoped-issue') {
      const reason = decision?.kind === 'skipped' ? decision.reason : 'not scoped agent:auto';
      throw new Error(`Issue #${options.issueNumber} is not eligible for scoped agent:auto execution: ${reason}`);
    }
  }

  const workflowPath = config.workflows.scopedImplementation.promptPath;
  if (!workflowPath) {
    throw new Error('Scoped implementation workflow prompt not found at undefined');
  }
  const workflowPromptPath = join(targetRoot, workflowPath);
  const workflowPromptText = await readWorkflowPrompt(workflowPromptPath);
  const acceptanceProofWorkflowPath = config.workflows.acceptanceProof.promptPath;
  if (!acceptanceProofWorkflowPath) {
    throw new Error('Acceptance proof workflow prompt not found at undefined');
  }
  const acceptanceProofWorkflowText = await readWorkflowPrompt(join(targetRoot, acceptanceProofWorkflowPath));
  const branchName = renderBranchTemplate(config.branches.scopedIssue, { issueNumber: options.issueNumber });
  const worktreePath = join(targetRoot, config.runner.workspaceRoot, `issue-${options.issueNumber}`);
  const codexTimeoutMs = selectCodexTimeoutMs(config, issue);
  let promptPath = '';
  let reportPath = '';
  let logPath = '';
  let sessionId = '';
  let snapshotPath = '';
  let pullRequest: GitHubPullRequest | undefined;
  const store = new RunnerStateStore(targetRoot, config);
  const events = new RunnerLifecycleEventStore(targetRoot, config);

  if (!recovery) {
    await claimIssue(issueAdapter, config, options.issueNumber, 'scoped-issue', now);
    await safeAppendEvent(events, {
      timestamp: now,
      issueNumber: options.issueNumber,
      mode: 'scoped-issue',
      phase: 'scoped-issue',
      status: 'started',
      summary: 'Issue claimed for scoped autonomous work.',
    });
  }

  try {
    await git.ensureIssueWorktree({
      targetRoot,
      workspacePath: worktreePath,
      branchName,
      baseBranch: resolvedBase.sha,
      requiredBaseSha: resolvedBase.sha,
      allowResume: true,
    });
    const maxReworkAttempts = Math.max(
      config.loopPolicy.rework.maxAttempts,
      config.reviewGates.acceptanceProof.maxIterations - 1,
    );
    const attemptLoop = await runAgentAttemptLoop({
      targetRoot,
      config,
      issue,
      issueNumber: options.issueNumber,
      mode: 'scoped-issue',
      phase: 'scoped-issue',
      branchName,
      worktreePath,
      baseBranch: resolvedBase.prBaseBranch,
      base: resolvedBase,
      createdAt: now,
      firstAttempt: recovery?.startAttempt,
      initialRework: recovery?.initialRework,
      buildSessionId: ({ attempt, attemptNow }) =>
        `issue-${options.issueNumber}-${formatSessionTimestamp(attemptNow)}${attempt === 0 ? '' : `-attempt-${attempt}`}`,
      buildPrompt: ({ promptPath: attemptPromptPath, reportPath: attemptReportPath, rework }) => buildScopedImplementationPrompt({
        issue,
        config,
        workflowPromptText,
        promptPath: attemptPromptPath,
        reportPath: attemptReportPath,
        branchName,
        worktreePath,
        rework,
      }),
      buildSnapshotDecision: () => 'has configured auto label and no blocking state labels',
      startedSummary: () => 'Starting scoped Codex implementation session.',
      reworkScheduledSummary: ({ nextAttempt }) => `Runner scheduled scoped rework attempt #${nextAttempt}.`,
      reworkEventPhase: 'quality-review',
      missingPublishabilityMessage: 'Runner internal error: missing publishability result',
      codexAdapter,
      codexTimeoutMs,
      git,
      shellExecutor,
      commitMessage: `Codex: implement issue #${options.issueNumber}`,
      events,
      localPhases: options.localPhases,
      localPhaseExecutor: options.localPhaseExecutor,
      acceptanceProof: {
        targetRoot,
        workflowPromptText: acceptanceProofWorkflowText,
        codexAdapter,
      },
      onAcceptanceProofAttemptEvent: ({ sessionId: attemptSessionId, event }) => appendAcceptanceProofEvent({
        events,
        issueNumber: options.issueNumber,
        mode: 'scoped-issue',
        sessionId: attemptSessionId,
        event,
      }),
      runMetadata: ({ attemptNow }) => ({
        ownerPid: process.pid,
        host: hostname(),
        leaseUpdatedAt: attemptNow.toISOString(),
        baseSha: resolvedBase.sha,
      }),
      publishabilityEvent: ({ publishability }) => ({
        phase: 'quality-review',
        status: publishability.status === 'blocked' ? 'blocked' : 'completed',
        summary: `Runner publishability gate returned ${publishability.status}.`,
      }),
    });
    const publishability = attemptLoop.publishability;
    sessionId = attemptLoop.sessionId;
    promptPath = attemptLoop.promptPath;
    reportPath = attemptLoop.reportPath;
    logPath = attemptLoop.logPath;
    snapshotPath = attemptLoop.snapshotPath;
    const reworkAttempts = attemptLoop.reworkAttempts;

    if (publishability.status === 'promotion-requested') {
      const evidence = buildPromotionRequestedHandoffEvidence({
        publishability,
        nextAction: 'Maintainer should review promotion evidence and decide whether to use parent issue-tree orchestration.',
      });
      const durableRunSummary = await writeDurableRunSummary({
        targetRoot,
        config,
        issueNumber: options.issueNumber,
        sessionId,
        outcome: evidence.outcome,
        changedFiles: evidence.changedFiles,
        validation: evidence.validation,
        blockers: evidence.blockers,
        skippedChecks: evidence.skippedChecks,
        residualRisks: evidence.residualRisks,
        nextAction: evidence.nextAction,
        logPath,
        reportPath,
      });
      await safeAppendEvent(events, {
        issueNumber: options.issueNumber,
        mode: 'scoped-issue',
        sessionId,
        phase: 'scoped-issue',
        status: 'blocked',
        summary: 'Scoped implementation requested promotion instead of direct publication.',
        artifacts: sessionArtifacts(
          promptPath,
          reportPath,
          logPath,
          snapshotPath,
          durableRunSummary?.path,
        ),
      });
      return finishPromotionRequested(
        baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
        issueAdapter,
        config,
        publishability.report,
        durableRunSummary,
      );
    }

    if (publishability.status === 'blocked') {
      const evidence = buildBlockedHandoffEvidence({
        publishability,
        nextAction: 'Maintainer input or a corrected agent run is required before draft PR handoff.',
      });
      const durableRunSummary = await writeDurableRunSummary({
        targetRoot,
        config,
        issueNumber: options.issueNumber,
        sessionId,
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
        reworkAttempts,
        repairAttempts: evidence.repairAttempts,
      });
      await safeAppendEvent(events, {
        issueNumber: options.issueNumber,
        mode: 'scoped-issue',
        sessionId,
        phase: 'scoped-issue',
        status: 'blocked',
        summary: 'Scoped implementation blocked before draft PR handoff.',
        artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshotPath, durableRunSummary?.path),
      });
      return finishBlocked(
        baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
        issueAdapter,
        config,
        evidence.blockers,
        evidence.changedFiles,
        evidence.skippedChecks,
        evidence.residualRisks,
        undefined,
        durableRunSummary,
        reworkAttempts,
        evidence.acceptanceProof,
        evidence.repairAttempts,
      );
    }

    const freshContextReview = await runFreshContextReviewIfEnabled({
      targetRoot,
      config,
      issue,
      codexAdapter,
      worktreePath,
      isolatedSessionId: `issue-${options.issueNumber}-${formatSessionTimestamp(new Date(now.getTime() + maxReworkAttempts + 1))}-fresh-review`,
      branchName,
      publishability,
    });
    if (freshContextReview?.status === 'blocked') {
      const evidence = buildBlockedHandoffEvidence({
        publishability,
        freshContextReview,
        nextAction: 'Review the Fresh-Context Review blocker before draft PR handoff.',
      });
      const durableRunSummary = await writeDurableRunSummary({
        targetRoot,
        config,
        issueNumber: options.issueNumber,
        sessionId,
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
        reworkAttempts,
        repairAttempts: evidence.repairAttempts,
      });
      await safeAppendEvent(events, {
        issueNumber: options.issueNumber,
        mode: 'scoped-issue',
        sessionId,
        phase: 'fresh-context-review',
        status: 'blocked',
        summary: 'Fresh-Context Review blocked scoped publication.',
        artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshotPath, durableRunSummary?.path),
      });
      return finishBlocked(
        baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
        issueAdapter,
        config,
        evidence.blockers,
        evidence.changedFiles,
        evidence.skippedChecks,
        evidence.residualRisks,
        freshContextReview,
        durableRunSummary,
        reworkAttempts,
        evidence.acceptanceProof,
        evidence.repairAttempts,
      );
    }

    const evidence = buildReviewReadyHandoffEvidence({
      publishability,
      freshContextReview,
      nextAction: 'Review the draft pull request before merge.',
    });
    const durableRunSummary = await writeDurableRunSummary({
      targetRoot,
      config,
      issueNumber: options.issueNumber,
      sessionId,
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
      reworkAttempts,
      repairAttempts: evidence.repairAttempts,
    });
    const handoff = await finishScopedReviewReadyHandoff({
      issueNumber: options.issueNumber,
      branchName,
      baseBranch: resolvedBase.prBaseBranch,
      worktreePath,
      logPath,
      config,
      git,
      pullRequestAdapter,
      issueAdapter,
      publishability,
      freshContextReview,
      durableRunSummary,
      acceptanceProof: publishability.acceptanceProofAttempt,
      onPullRequestReady: (createdPullRequest) => {
        pullRequest = createdPullRequest;
      },
    });
    pullRequest = handoff.pullRequest;
    await store.removeRun(options.issueNumber);
    await safeAppendEvent(events, {
      issueNumber: options.issueNumber,
      mode: 'scoped-issue',
      sessionId,
      phase: 'scoped-issue',
      status: 'completed',
      summary: 'Scoped implementation passed runner gates and completed draft PR handoff.',
      artifacts: [
        ...sessionArtifacts(promptPath, reportPath, logPath, freshContextReview?.snapshotPath ?? snapshotPath, durableRunSummary?.path),
        { kind: 'pr', url: pullRequest.url, description: 'Draft pull request' },
      ],
    });

    return {
      ...baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
      status: 'review-ready',
      pullRequest,
      reportComment: handoff.reportComment,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'scoped execution failed';
    if (pullRequest) {
      await safeAppendEvent(events, {
        issueNumber: options.issueNumber,
        mode: 'scoped-issue',
        sessionId: sessionId || undefined,
        phase: 'scoped-issue',
        status: 'failed',
        summary: `Scoped execution failed after draft PR creation: ${message}`,
        artifacts: [
          ...sessionArtifacts(promptPath, reportPath, logPath, snapshotPath),
          { kind: 'pr', url: pullRequest.url, description: 'Draft pull request' },
        ],
      });
      throw new Error(`Scoped execution failed after draft PR creation (${pullRequest.url}); not marking issue blocked: ${message}`);
    }
    await safeAppendEvent(events, {
      issueNumber: options.issueNumber,
      mode: 'scoped-issue',
      sessionId: sessionId || undefined,
      phase: 'scoped-issue',
      status: 'blocked',
      summary: `Scoped execution failed before draft PR handoff: ${message}`,
      artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshotPath),
    });
    return finishBlocked(
      baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
      issueAdapter,
      config,
      [message],
      [],
      [],
      [],
    );
  }
}

function sessionArtifacts(
  promptPath: string,
  reportPath: string,
  logPath: string,
  snapshotPath?: string,
  durableSummaryPath?: string,
): LifecycleArtifact[] {
  const artifacts: Array<LifecycleArtifact | undefined> = [
    snapshotPath ? { kind: 'snapshot', path: snapshotPath, description: 'Context snapshot' } : undefined,
    promptPath ? { kind: 'prompt', path: promptPath, description: 'Session prompt path' } : undefined,
    reportPath ? { kind: 'report', path: reportPath, description: 'Session report path' } : undefined,
    logPath ? { kind: 'log', path: logPath, description: 'Session log path' } : undefined,
    durableSummaryPath ? { kind: 'durable-summary', path: durableSummaryPath, description: 'Durable run summary' } : undefined,
  ];
  return artifacts.filter((artifact): artifact is LifecycleArtifact => Boolean(artifact));
}

async function safeAppendEvent(
  store: RunnerLifecycleEventStore,
  input: Parameters<RunnerLifecycleEventStore['append']>[0],
): Promise<void> {
  try {
    await store.append(input);
  } catch {
    // Lifecycle evidence must not create a new publication blocker after runner gates pass.
  }
}

async function appendAcceptanceProofEvent(input: {
  events: RunnerLifecycleEventStore;
  issueNumber: number;
  mode: 'scoped-issue';
  sessionId: string;
  event: {
    status: 'started' | 'passed' | 'needs-rework' | 'blocked';
    evidence?: AcceptanceProofAttemptEvidence;
  };
}): Promise<void> {
  const evidence = input.event.evidence;
  await safeAppendEvent(input.events, {
    issueNumber: input.issueNumber,
    mode: input.mode,
    sessionId: input.sessionId,
    phase: 'acceptance-proof',
    status: input.event.status === 'passed' ? 'completed' : input.event.status,
    summary: input.event.status === 'started'
      ? 'Starting Adaptive Proof Agent session.'
      : `Adaptive Proof Agent finished with ${input.event.status}.`,
    artifacts: evidence ? [
      { kind: 'prompt', path: evidence.promptPath, description: 'Acceptance proof prompt path' },
      { kind: 'report', path: evidence.reportPath, description: 'Acceptance proof report path' },
      ...evidence.artifactPaths.map((path) => ({ kind: 'other' as const, path, description: 'Acceptance proof artifact' })),
    ] : undefined,
  });
}

async function readWorkflowPrompt(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Scoped implementation workflow prompt not found at ${path}`);
    }
    throw error;
  }
}

async function finishBlocked(
  result: Omit<ScopedAutoCommandResult, 'status' | 'reportComment'>,
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  reasons: string[],
  changedFiles: string[],
  skippedChecks: string[],
  residualRisks: string[],
  freshContextReview?: FreshContextReviewEvidence,
  durableRunSummary?: Awaited<ReturnType<typeof writeDurableRunSummary>>,
  reworkAttempts?: ReworkAttemptEvidence[],
  acceptanceProof?: AcceptanceProofAttemptEvidence,
  repairAttempts?: PublishabilityRepairAttempt[],
): Promise<ScopedAutoCommandResult> {
  const handoff = await finishScopedBlockedHandoff({
    issueNumber: result.issueNumber,
    logPath: result.logPath,
    issueAdapter,
    config,
    reasons,
    changedFiles,
    skippedChecks,
    residualRisks,
    freshContextReview,
    durableRunSummary,
    reworkAttempts,
    acceptanceProof,
    repairAttempts,
  });
  return { ...result, status: 'blocked', reportComment: handoff.reportComment };
}

export interface FinishScopedReviewReadyHandoffInput {
  issueNumber: number;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  logPath: string;
  config: CodexOrchestratorConfig;
  git: Pick<GitWorktreeManager, 'pushBranch'>;
  pullRequestAdapter: GitHubPullRequestAdapter;
  issueAdapter: GitHubIssueAdapter;
  publishability: Extract<ImplementationPublishabilityResult, { status: 'publish-ready' }>;
  freshContextReview?: FreshContextReviewEvidence;
  durableRunSummary?: Awaited<ReturnType<typeof writeDurableRunSummary>>;
  acceptanceProof?: AcceptanceProofAttemptEvidence;
  onPullRequestReady?: (pullRequest: GitHubPullRequest) => void;
}

export async function finishScopedReviewReadyHandoff(
  input: FinishScopedReviewReadyHandoffInput,
): Promise<{ pullRequest: GitHubPullRequest; reportComment: string }> {
  const pullRequestBody = buildScopedPullRequestBody({
    config: input.config,
    branchName: input.branchName,
    issueNumber: input.issueNumber,
    changedFiles: input.publishability.changedFiles,
    validation: input.publishability.validation,
    artifacts: input.publishability.artifacts,
    skippedChecks: input.publishability.skippedChecks,
    residualRisks: input.publishability.residualRisks,
    reviewHandoff: input.publishability.report.reviewHandoff,
    logPath: input.logPath,
    commits: input.publishability.commits,
    freshContextReview: input.freshContextReview,
    durableRunSummary: input.durableRunSummary,
    acceptanceProof: input.acceptanceProof,
    repairAttempts: input.publishability.repairAttempts,
  });
  return finishReviewReadyTerminalOutcome({
    issueNumber: input.issueNumber,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    worktreePath: input.worktreePath,
    config: input.config,
    git: input.git,
    pullRequestAdapter: input.pullRequestAdapter,
    issueAdapter: input.issueAdapter,
    pullRequest: {
      title: renderTemplate(input.config.pullRequests.scopedIssueTitle, input.issueNumber),
      body: pullRequestBody,
    },
    reportComment: (pullRequest) => buildScopedReviewReport({
      config: input.config,
      branchName: input.branchName,
      issueNumber: input.issueNumber,
      pullRequest,
      changedFiles: input.publishability.changedFiles,
      validation: input.publishability.validation,
      artifacts: input.publishability.artifacts,
      skippedChecks: input.publishability.skippedChecks,
      residualRisks: input.publishability.residualRisks,
      reviewHandoff: input.publishability.report.reviewHandoff,
      logPath: input.logPath,
      commits: input.publishability.commits,
      freshContextReview: input.freshContextReview,
      durableRunSummary: input.durableRunSummary,
      acceptanceProof: input.acceptanceProof,
      repairAttempts: input.publishability.repairAttempts,
    }),
    onPullRequestReady: input.onPullRequestReady,
  });
}

export interface FinishScopedBlockedHandoffInput {
  issueNumber: number;
  logPath: string;
  issueAdapter: GitHubIssueAdapter;
  config: CodexOrchestratorConfig;
  reasons: string[];
  changedFiles: string[];
  skippedChecks: string[];
  residualRisks: string[];
  freshContextReview?: FreshContextReviewEvidence;
  durableRunSummary?: Awaited<ReturnType<typeof writeDurableRunSummary>>;
  reworkAttempts?: ReworkAttemptEvidence[];
  repairAttempts?: PublishabilityRepairAttempt[];
  acceptanceProof?: AcceptanceProofAttemptEvidence;
  commentPrefix?: string;
  skipCommentIfIncludes?: string;
}

export async function finishScopedBlockedHandoff(
  input: FinishScopedBlockedHandoffInput,
): Promise<{ reportComment: string; postedComment: boolean }> {
  const reportComment = [
    input.commentPrefix,
    buildScopedBlockedReport({
      issueNumber: input.issueNumber,
      reasons: input.reasons,
      changedFiles: input.changedFiles,
      logPath: input.logPath,
      skippedChecks: input.skippedChecks,
      residualRisks: input.residualRisks,
      freshContextReview: input.freshContextReview,
      durableRunSummary: input.durableRunSummary,
      reworkAttempts: input.reworkAttempts,
      repairAttempts: input.repairAttempts,
      acceptanceProof: input.acceptanceProof,
    }),
  ].filter(Boolean).join('\n');
  return finishBlockedTerminalOutcome({
    issueNumber: input.issueNumber,
    config: input.config,
    issueAdapter: input.issueAdapter,
    reportComment,
    skipCommentIfIncludes: input.skipCommentIfIncludes,
  });
}

async function finishPromotionRequested(
  result: Omit<ScopedAutoCommandResult, 'status' | 'reportComment'>,
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  report: ScopedCompletionReport,
  durableRunSummary?: Awaited<ReturnType<typeof writeDurableRunSummary>>,
): Promise<ScopedAutoCommandResult> {
  const reportComment = buildPromotionRequestReport({ issueNumber: result.issueNumber, report, durableRunSummary });
  await finishPromotionRequestedTerminalOutcome({
    issueNumber: result.issueNumber,
    config,
    issueAdapter,
    reportComment,
  });
  return { ...result, status: 'promotion-requested', reportComment };
}

function baseResult(
  issueNumber: number,
  branchName: string,
  worktreePath: string,
  promptPath: string,
  reportPath: string,
  logPath: string,
): Omit<ScopedAutoCommandResult, 'status' | 'reportComment'> {
  return { issueNumber, branchName, worktreePath, promptPath, reportPath, logPath };
}

function renderTemplate(template: string, issueNumber: number): string {
  return template.replaceAll('${issueNumber}', String(issueNumber));
}

function selectCodexTimeoutMs(config: CodexOrchestratorConfig, issue: GitHubIssue): number | undefined {
  if (config.codex.profiles?.['scoped-issue']?.timeoutMs) {
    return undefined;
  }
  if (!config.codex.mobileTimeoutMs || !isMobileIssue(issue)) {
    return undefined;
  }
  return config.codex.mobileTimeoutMs;
}

function isMobileIssue(issue: GitHubIssue): boolean {
  const labels = issue.labels.map((label) => label.name).join('\n');
  const text = `${issue.title}\n${issue.body}\n${labels}`;
  return /\b(?:android|flutter|ios|iphone|ipad|mobile|emulator|apk|aab|dart)\b/iu.test(text);
}
