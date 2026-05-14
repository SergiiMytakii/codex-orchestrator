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
} from './handoff-evidence.js';
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
    const maxReworkAttempts = 1;
    let rework: { attempt: number; blockedReasons: string[] } | undefined;
    let publishability: Awaited<ReturnType<typeof runImplementationPublishabilityCheck>> | undefined;

    for (let attempt = 0; attempt <= maxReworkAttempts; attempt++) {
      const attemptNow = attempt === 0 ? now : new Date(now.getTime() + attempt);
      const sessionId = `issue-${options.issueNumber}-${formatSessionTimestamp(attemptNow)}`;
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

      if (publishability.status === 'blocked' && attempt < maxReworkAttempts && shouldRequestRework(publishability.reasons)) {
        rework = { attempt: attempt + 1, blockedReasons: publishability.reasons };
        continue;
      }

      break;
    }

    if (!publishability) {
      throw new Error('Runner internal error: missing publishability result');
    }

    if (publishability.status === 'promotion-requested') {
      return finishPromotionRequested(
        baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
        issueAdapter,
        config,
        publishability.report,
      );
    }

    if (publishability.status === 'blocked') {
      return finishBlocked(
        baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
        issueAdapter,
        config,
        publishability.reasons,
        publishability.changedFiles,
        publishability.skippedChecks,
        publishability.residualRisks,
      );
    }

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

function shouldRequestRework(reasons: string[]): boolean {
  if (reasons.some((reason) => /matches denied pattern/iu.test(reason))) {
    return false;
  }
  if (reasons.some((reason) => /runner-owned publication was violated/iu.test(reason))) {
    return false;
  }
  if (reasons.some((reason) => /destructive-db-or-cache|production-deploy-or-release/iu.test(reason))) {
    return false;
  }

  const retryablePatterns = [
    /Quality gate requires/iu,
    /One or more configured checks failed/iu,
    /Invalid scoped completion report/iu,
    /Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE/iu,
    /Codex completed without file changes/iu,
  ];
  return reasons.some((reason) => retryablePatterns.some((pattern) => pattern.test(reason)));
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
): Promise<ScopedAutoCommandResult> {
  const reportComment = buildScopedBlockedReport({
    issueNumber: result.issueNumber,
    reasons,
    changedFiles,
    logPath: result.logPath,
    skippedChecks,
    residualRisks,
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
): Promise<ScopedAutoCommandResult> {
  const reportComment = buildPromotionRequestReport({ issueNumber: result.issueNumber, report });
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
