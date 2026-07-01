import { mkdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { verifyPullRequestRefs } from '../github/pull-requests.js';
import { resolveBaseBranch } from '../git/base-branch.js';
import { GitWorktreeManager, renderBranchTemplate } from '../git/worktree.js';
import { defaultShellCommandExecutor, type ShellCommandExecutor } from '../process/command.js';
import {
  formatSessionTimestamp,
  readRunnerConfig,
} from './command-utils.js';
import {
  buildPromotionRequestReport,
  buildScopedBlockedReport,
  buildScopedPullRequestBody,
  buildScopedReviewReport,
  type FreshContextReviewEvidence,
} from './handoff-evidence.js';
import { writeDurableRunSummary } from './durable-run-summary.js';
import { runFreshContextReviewIfEnabled } from './fresh-context-review.js';
import { claimIssue, discoverIssueWork } from './issue-state-machine.js';
import { writeContextSnapshot } from './context-snapshot.js';
import type { ScopedCompletionReport } from './completion-report.js';
import {
  runImplementationPublishabilityCheck,
  type ImplementationPublishabilityResult,
  type LocalExecutionPhaseExecutor,
} from './local-execution-session.js';
import { RunnerStateStore } from './local-state.js';
import { RunnerLifecycleEventStore, type LifecycleArtifact } from './lifecycle-events.js';
import type { AcceptanceProofAttemptEvidence } from './acceptance-proof-runner.js';
import {
  buildScopedImplementationPrompt,
  sessionPromptPath,
  sessionReportPath,
  writeDurablePrompt,
} from './prompt.js';
import { maxReworkAttemptsForReasons, shouldRequestImplementationRework } from './rework-policy.js';
import { sessionLogPath } from './run-log.js';
import { cleanupSessionCodexHome, sessionCodexHomePath } from './session-home.js';

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
  const targetRoot = resolve(options.targetRoot);
  const now = options.now ?? new Date();
  const config = await readRunnerConfig(targetRoot);
  const issueAdapter = options.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const pullRequestAdapter = options.pullRequestAdapter ?? new GhCliPullRequestAdapter(config.github.owner, config.github.repo);
  const git = options.git ?? new GitWorktreeManager();
  const shellExecutor = options.shellExecutor ?? defaultShellCommandExecutor;
  const codexAdapter = options.codexAdapter ?? new CodexCommandAdapter(config);
  const resolvedBase = await resolveBaseBranch({ targetRoot, base: config.branches.base });
  const issue = await issueAdapter.getIssue(options.issueNumber);

  if (!issue) {
    throw new Error(`Issue #${options.issueNumber} was not found`);
  }

  const decision = discoverIssueWork([issue], config)[0];
  if (!decision || decision.kind !== 'eligible' || decision.mode !== 'scoped-issue') {
    const reason = decision?.kind === 'skipped' ? decision.reason : 'not scoped agent:auto';
    throw new Error(`Issue #${options.issueNumber} is not eligible for scoped agent:auto execution: ${reason}`);
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

  await claimIssue(issueAdapter, config, options.issueNumber, 'scoped-issue', now);
  await safeAppendEvent(events, {
    timestamp: now,
    issueNumber: options.issueNumber,
    mode: 'scoped-issue',
    phase: 'scoped-issue',
    status: 'started',
    summary: 'Issue claimed for scoped autonomous work.',
  });

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
    let rework: { attempt: number; blockedReasons: string[] } | undefined;
    let publishability: Awaited<ReturnType<typeof runImplementationPublishabilityCheck>> | undefined;

    for (let attempt = 0; attempt <= maxReworkAttempts; attempt++) {
      const attemptNow = attempt === 0 ? now : new Date(now.getTime() + attempt);
      sessionId = `issue-${options.issueNumber}-${formatSessionTimestamp(attemptNow)}`;
      promptPath = sessionPromptPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
      reportPath = sessionReportPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
      logPath = sessionLogPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
      const isolatedHomePath = sessionCodexHomePath({ targetRoot, sessionId });
      await mkdir(dirname(reportPath), { recursive: true });
      await mkdir(isolatedHomePath, { recursive: true });
      const promptText = buildScopedImplementationPrompt({
        issue,
        config,
        workflowPromptText,
        promptPath,
        reportPath,
        branchName,
        worktreePath,
        rework,
      });
      await writeDurablePrompt({
        targetRoot,
        config,
        issueNumber: options.issueNumber,
        sessionId,
        promptText,
      });
      const snapshot = await writeContextSnapshot({
        targetRoot,
        config,
        issue,
        mode: 'scoped-issue',
        phase: 'scoped-issue',
        decision: 'has configured auto label and no blocking state labels',
        sessionId,
        worktreePath,
        promptPath,
        reportPath,
        logPath,
        branchName,
        baseBranch: resolvedBase.prBaseBranch,
        base: resolvedBase,
        createdAt: attemptNow,
      });
      snapshotPath = snapshot.path;
      await store.upsertRun({
        issueNumber: options.issueNumber,
        mode: 'scoped-issue',
        workspacePath: worktreePath,
        sessionId,
        branchName,
        promptPath,
        reportPath,
        logPath,
        retryCount: attempt,
        createdAt: now.toISOString(),
        updatedAt: attemptNow.toISOString(),
        ownerPid: process.pid,
        host: hostname(),
        leaseUpdatedAt: attemptNow.toISOString(),
        attemptStartedAt: attemptNow.toISOString(),
        baseSha: resolvedBase.sha,
        snapshotPath,
      });
      await safeAppendEvent(events, {
        timestamp: attemptNow,
        issueNumber: options.issueNumber,
        mode: 'scoped-issue',
        sessionId,
        phase: 'scoped-issue',
        status: 'started',
        summary: 'Starting scoped Codex implementation session.',
        artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshotPath),
      });

      const beforeHead = await git.getHead(worktreePath);
      let codexResult: CodexCommandRunResult;
      try {
        codexResult = await codexAdapter.run({
          targetRoot,
          config,
          worktreePath,
          promptPath,
          promptText,
          reportPath,
          isolatedHomePath,
          issueNumber: options.issueNumber,
          sessionId,
          branchName,
          phase: 'scoped-issue',
          timeoutMs: codexTimeoutMs,
          logPath,
        });
      } finally {
        await cleanupSessionCodexHome(isolatedHomePath);
      }
      const afterHead = await git.getHead(worktreePath);
      publishability = await runImplementationPublishabilityCheck({
        config,
        issue,
        targetRoot,
        worktreePath,
        reportPath,
        beforeHead,
        afterHead,
        codexResult,
        git,
        shellExecutor,
        commitMessage: `Codex: implement issue #${options.issueNumber}`,
        localPhases: options.localPhases,
        localPhaseExecutor: options.localPhaseExecutor,
        acceptanceProof: {
          targetRoot,
          sessionId,
          branchName,
          workflowPromptText: acceptanceProofWorkflowText,
          codexAdapter,
          onAttemptEvent: (event) => appendAcceptanceProofEvent({
            events,
            issueNumber: options.issueNumber,
            mode: 'scoped-issue',
            sessionId,
            event,
          }),
        },
      });
      await safeAppendEvent(events, {
        issueNumber: options.issueNumber,
        mode: 'scoped-issue',
        sessionId,
        phase: 'quality-review',
        status: publishability.status === 'blocked' ? 'blocked' : 'completed',
        summary: `Runner publishability gate returned ${publishability.status}.`,
        artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshotPath),
      });

      if (
        publishability.status === 'blocked'
        && attempt < maxReworkAttemptsForReasons(publishability.reasons, config)
        && shouldRequestImplementationRework(publishability.reasons, config)
      ) {
        rework = { attempt: attempt + 1, blockedReasons: publishability.reasons };
        continue;
      }

      break;
    }

    if (!publishability) {
      throw new Error('Runner internal error: missing publishability result');
    }

    if (publishability.status === 'promotion-requested') {
      const durableRunSummary = await writeDurableRunSummary({
        targetRoot,
        config,
        issueNumber: options.issueNumber,
        sessionId,
        outcome: 'promotion-requested',
        changedFiles: [],
        validation: publishability.report.validation,
        blockers: [publishability.report.promotion?.reason ?? 'Promotion requested'],
        skippedChecks: publishability.report.skippedChecks,
        residualRisks: publishability.report.residualRisks,
        nextAction: 'Maintainer should review promotion evidence and decide whether to use parent issue-tree orchestration.',
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
      const durableRunSummary = await writeDurableRunSummary({
        targetRoot,
        config,
        issueNumber: options.issueNumber,
        sessionId,
        outcome: 'blocked',
        changedFiles: publishability.changedFiles,
        validation: publishability.validation ?? [],
        blockers: publishability.reasons,
        skippedChecks: publishability.skippedChecks,
        residualRisks: publishability.residualRisks,
        suggestionEvidence: [],
        nextAction: 'Maintainer input or a corrected agent run is required before draft PR handoff.',
        logPath,
        reportPath,
        acceptanceProof: publishability.acceptanceProofAttempt,
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
        publishability.reasons,
        publishability.changedFiles,
        publishability.skippedChecks,
        publishability.residualRisks,
        undefined,
        durableRunSummary,
        publishability.acceptanceProofAttempt,
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
      const durableRunSummary = await writeDurableRunSummary({
        targetRoot,
        config,
        issueNumber: options.issueNumber,
        sessionId,
        outcome: 'blocked',
        changedFiles: publishability.changedFiles,
        validation: publishability.validation,
        blockers: ['Fresh-Context Review blocked publication', ...freshContextReview.findings],
        skippedChecks: publishability.skippedChecks,
        residualRisks: [...publishability.residualRisks, ...freshContextReview.residualRisks],
        suggestionEvidence: freshContextReview.findings,
        nextAction: 'Review the Fresh-Context Review blocker before draft PR handoff.',
        logPath,
        reportPath,
        acceptanceProof: publishability.acceptanceProofAttempt,
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
        ['Fresh-Context Review blocked publication', ...freshContextReview.findings],
        publishability.changedFiles,
        publishability.skippedChecks,
        [...publishability.residualRisks, ...freshContextReview.residualRisks],
        freshContextReview,
        durableRunSummary,
        publishability.acceptanceProofAttempt,
      );
    }

    const durableRunSummary = await writeDurableRunSummary({
      targetRoot,
      config,
      issueNumber: options.issueNumber,
      sessionId,
      outcome: 'review-ready',
      changedFiles: publishability.changedFiles,
      validation: publishability.validation,
      blockers: [],
      skippedChecks: publishability.skippedChecks,
      residualRisks: [
        ...publishability.residualRisks,
        ...(freshContextReview?.residualRisks ?? []),
      ],
      suggestionEvidence: freshContextReview?.findings,
      nextAction: 'Review the draft pull request before merge.',
      logPath,
      reportPath,
      acceptanceProof: publishability.acceptanceProofAttempt,
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
  acceptanceProof?: AcceptanceProofAttemptEvidence,
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
    acceptanceProof,
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
  await input.git.pushBranch({ worktreePath: input.worktreePath, branchName: input.branchName });
  let pullRequest = await input.pullRequestAdapter.findOpenPullRequestByHeadAndBase(input.branchName, input.baseBranch);
  if (!pullRequest) {
    pullRequest = await input.pullRequestAdapter.createDraftPullRequest({
      title: renderTemplate(input.config.pullRequests.scopedIssueTitle, input.issueNumber),
      body: buildScopedPullRequestBody({
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
      }),
      headBranch: input.branchName,
      baseBranch: input.baseBranch,
    });
  }
  pullRequest = await verifyPullRequestRefs(input.pullRequestAdapter, pullRequest, input.branchName, input.baseBranch);
  input.onPullRequestReady?.(pullRequest);
  const reportComment = buildScopedReviewReport({
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
  });
  await input.issueAdapter.removeLabels(input.issueNumber, [input.config.github.labels.running.name]);
  await input.issueAdapter.addLabels(input.issueNumber, [input.config.github.labels.review.name]);
  await input.issueAdapter.postComment(input.issueNumber, reportComment);
  return { pullRequest, reportComment };
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
      acceptanceProof: input.acceptanceProof,
    }),
  ].filter(Boolean).join('\n');
  await input.issueAdapter.removeLabels(input.issueNumber, [input.config.github.labels.running.name]);
  await input.issueAdapter.addLabels(input.issueNumber, [input.config.github.labels.blocked.name]);
  const issue = input.skipCommentIfIncludes ? await input.issueAdapter.getIssue(input.issueNumber) : undefined;
  const alreadyPosted = Boolean(input.skipCommentIfIncludes && issue?.comments.some((comment) => comment.body.includes(input.skipCommentIfIncludes ?? '')));
  if (!alreadyPosted) {
    await input.issueAdapter.postComment(input.issueNumber, reportComment);
  }
  return { reportComment, postedComment: !alreadyPosted };
}

async function finishPromotionRequested(
  result: Omit<ScopedAutoCommandResult, 'status' | 'reportComment'>,
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  report: ScopedCompletionReport,
  durableRunSummary?: Awaited<ReturnType<typeof writeDurableRunSummary>>,
): Promise<ScopedAutoCommandResult> {
  const reportComment = buildPromotionRequestReport({ issueNumber: result.issueNumber, report, durableRunSummary });
  await issueAdapter.removeLabels(result.issueNumber, [config.github.labels.running.name]);
  await issueAdapter.addLabels(result.issueNumber, [config.github.labels.blocked.name]);
  await issueAdapter.postComment(result.issueNumber, reportComment);
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
