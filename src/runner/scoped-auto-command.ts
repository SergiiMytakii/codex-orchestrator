import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
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
import type { ScopedCompletionReport } from './completion-report.js';
import {
  runImplementationPublishabilityCheck,
  type LocalExecutionPhaseExecutor,
} from './local-execution-session.js';
import { RunnerStateStore } from './local-state.js';
import {
  buildScopedImplementationPrompt,
  sessionPromptPath,
  sessionReportPath,
  writeDurablePrompt,
} from './prompt.js';
import { shouldRequestImplementationRework } from './rework-policy.js';
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
  const branchName = renderBranchTemplate(config.branches.scopedIssue, { issueNumber: options.issueNumber });
  const worktreePath = join(targetRoot, config.runner.workspaceRoot, `issue-${options.issueNumber}`);
  const codexTimeoutMs = selectCodexTimeoutMs(config, issue);
  let promptPath = '';
  let reportPath = '';
  let logPath = '';
  let sessionId = '';
  let pullRequest: GitHubPullRequest | undefined;
  const store = new RunnerStateStore(targetRoot, config);

  await claimIssue(issueAdapter, config, options.issueNumber, 'scoped-issue', now);

  try {
    await git.ensureIssueWorktree({
      targetRoot,
      workspacePath: worktreePath,
      branchName,
      baseBranch: config.branches.base,
      allowResume: true,
    });
    const maxReworkAttempts = config.loopPolicy.rework.maxAttempts;
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
      });

      if (
        publishability.status === 'blocked'
        && attempt < maxReworkAttempts
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
        validation: [],
        blockers: publishability.reasons,
        skippedChecks: publishability.skippedChecks,
        residualRisks: publishability.residualRisks,
        suggestionEvidence: [],
        nextAction: 'Maintainer input or a corrected agent run is required before draft PR handoff.',
        logPath,
        reportPath,
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
    });

    await git.pushBranch({ worktreePath, branchName });
    pullRequest = await pullRequestAdapter.createDraftPullRequest({
      title: renderTemplate(config.pullRequests.scopedIssueTitle, options.issueNumber),
      body: buildScopedPullRequestBody({
        config,
        branchName,
        issueNumber: options.issueNumber,
        changedFiles: publishability.changedFiles,
        validation: publishability.validation,
        artifacts: publishability.artifacts,
        skippedChecks: publishability.skippedChecks,
        residualRisks: publishability.residualRisks,
        logPath,
        commits: publishability.commits,
        freshContextReview,
        durableRunSummary,
      }),
      headBranch: branchName,
      baseBranch: config.branches.base,
    });
    const reportComment = buildScopedReviewReport({
      config,
      branchName,
      issueNumber: options.issueNumber,
      pullRequest,
      changedFiles: publishability.changedFiles,
      validation: publishability.validation,
      artifacts: publishability.artifacts,
      skippedChecks: publishability.skippedChecks,
      residualRisks: publishability.residualRisks,
      logPath,
      commits: publishability.commits,
      freshContextReview,
      durableRunSummary,
    });
    await issueAdapter.removeLabels(options.issueNumber, [config.github.labels.running.name]);
    await issueAdapter.addLabels(options.issueNumber, [config.github.labels.review.name]);
    await issueAdapter.postComment(options.issueNumber, reportComment);
    await store.removeRun(options.issueNumber);

    return {
      ...baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
      status: 'review-ready',
      pullRequest,
      reportComment,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'scoped execution failed';
    if (pullRequest) {
      throw new Error(`Scoped execution failed after draft PR creation (${pullRequest.url}); not marking issue blocked: ${message}`);
    }
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
): Promise<ScopedAutoCommandResult> {
  const reportComment = buildScopedBlockedReport({
    issueNumber: result.issueNumber,
    reasons,
    changedFiles,
    logPath: result.logPath,
    skippedChecks,
    residualRisks,
    freshContextReview,
    durableRunSummary,
  });
  await issueAdapter.removeLabels(result.issueNumber, [config.github.labels.running.name]);
  await issueAdapter.addLabels(result.issueNumber, [config.github.labels.blocked.name]);
  await issueAdapter.postComment(result.issueNumber, reportComment);
  return { ...result, status: 'blocked', reportComment };
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
