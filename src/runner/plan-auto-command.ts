import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GitMergeConflictError, GitWorktreeManager, renderBranchTemplate, type SessionCommitInfo } from '../git/worktree.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { defaultShellCommandExecutor, type ShellCommandExecutor } from '../process/command.js';
import {
  formatSessionTimestamp,
  readRunnerConfig,
  runConfiguredChecks,
} from './command-utils.js';
import {
  buildChildBlockedReport,
  buildChildReviewReport,
  buildIssueTreePullRequestBody,
  buildIssueTreeReviewReport,
  buildParentBlockedReport,
  type FreshContextReviewEvidence,
  type RunnerValidationLine,
} from './handoff-evidence.js';
import { writeDurableRunSummary, type DurableRunSummaryEvidence } from './durable-run-summary.js';
import { runFreshContextReviewIfEnabled } from './fresh-context-review.js';
import {
  readPlanAutoCompletionReport,
  type PlanAutoCompletionReport,
  type ScopedCompletionReport,
} from './completion-report.js';
import { claimIssue, discoverIssueWork } from './issue-state-machine.js';
import {
  collectExecutableChildBatches,
  persistAutonomousChildNode,
  readAutonomousChildNodes,
  topologicalPlanNodes,
  type AutonomousChildNode,
} from './issue-tree.js';
import { runImplementationPublishabilityCheck } from './local-execution-session.js';
import { RunnerStateStore } from './local-state.js';
import {
  buildIssueTreeChildPrompt,
  buildPlanAutoPrompt,
  sessionPromptPath,
  sessionReportPath,
  writeDurablePrompt,
} from './prompt.js';
import { shouldRequestImplementationRework } from './rework-policy.js';
import { sessionLogPath } from './run-log.js';
import { cleanupSessionCodexHome, sessionCodexHomePath } from './session-home.js';

export interface PlanAutoCommandOptions {
  targetRoot: string;
  issueNumber: number;
  issueAdapter?: GitHubIssueAdapter;
  pullRequestAdapter?: GitHubPullRequestAdapter;
  git?: GitWorktreeManager;
  codexAdapter?: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  shellExecutor?: ShellCommandExecutor;
  now?: Date;
}

export interface PlanAutoCommandResult {
  parentIssueNumber: number;
  branchName: string;
  worktreePath: string;
  promptPath: string;
  reportPath: string;
  logPath: string;
  childIssues: GitHubIssue[];
  pullRequest?: GitHubPullRequest;
  status: 'review-ready' | 'blocked';
  reportComment: string;
}

interface PlanWorkflowPrompts {
  prd: string;
  issueBreakdown: string;
  breakdownReview: string;
  triage: string;
}

interface PlanBlockedContext {
  parentIssueNumber: number;
  branchName: string;
  worktreePath: string;
  promptPath: string;
  reportPath: string;
  logPath: string;
  childIssues: GitHubIssue[];
}

interface ChildExecutionResult {
  child: AutonomousChildNode;
  branchName: string;
  worktreePath: string;
  promptPath: string;
  reportPath: string;
  logPath: string;
  changedFiles: string[];
  validation: RunnerValidationLine[];
  artifacts: ScopedCompletionReport['artifacts'];
  commits: SessionCommitInfo[];
  skippedChecks: string[];
  residualRisks: string[];
  freshContextReview?: FreshContextReviewEvidence;
  durableRunSummary?: DurableRunSummaryEvidence;
}

class ChildExecutionBlockedError extends Error {
  public constructor(
    message: string,
    public readonly durableRunSummary?: DurableRunSummaryEvidence,
    public readonly freshContextReview?: FreshContextReviewEvidence,
  ) {
    super(message);
  }
}

export async function runPlanAutoCommand(options: PlanAutoCommandOptions): Promise<PlanAutoCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const now = options.now ?? new Date();
  const config = await readRunnerConfig(targetRoot);
  const issueAdapter = options.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const pullRequestAdapter = options.pullRequestAdapter ?? new GhCliPullRequestAdapter(config.github.owner, config.github.repo);
  const git = options.git ?? new GitWorktreeManager();
  const shellExecutor = options.shellExecutor ?? defaultShellCommandExecutor;
  const codexAdapter = options.codexAdapter ?? new CodexCommandAdapter(config);
  const parentIssue = await issueAdapter.getIssue(options.issueNumber);

  if (!parentIssue) {
    throw new Error(`Issue #${options.issueNumber} was not found`);
  }

  const decision = discoverIssueWork([parentIssue], config)[0];
  if (!decision || decision.kind !== 'eligible' || decision.mode !== 'plan-parent') {
    const reason = decision?.kind === 'skipped' ? decision.reason : 'not agent:plan-auto';
    throw new Error(`Issue #${options.issueNumber} is not eligible for agent:plan-auto planning: ${reason}`);
  }

  const workflowPrompts = await readPlanWorkflowPrompts(targetRoot, config);
  const issueTreeWorkflowPrompt = await readIssueTreeWorkflowPrompt(targetRoot, config);
  const branchName = renderBranchTemplate(config.branches.issueTree, { parentIssueNumber: options.issueNumber });
  const worktreePath = join(targetRoot, config.runner.workspaceRoot, `tree-${options.issueNumber}`);
  let promptPath = '';
  let reportPath = '';
  let logPath = '';
  const childIssues: GitHubIssue[] = [];
  let pullRequest: GitHubPullRequest | undefined;
  let store: RunnerStateStore | undefined;
  const executionResults: ChildExecutionResult[] = [];

  await claimIssue(issueAdapter, config, options.issueNumber, 'plan-parent', now);

  try {
    await git.createIssueWorktree({
      targetRoot,
      workspacePath: worktreePath,
      branchName,
      baseBranch: config.branches.base,
    });
    const sessionId = `plan-${options.issueNumber}-${formatSessionTimestamp(now)}`;
    promptPath = sessionPromptPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
    reportPath = sessionReportPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
    logPath = sessionLogPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
    const isolatedHomePath = sessionCodexHomePath({ targetRoot, sessionId });
    await mkdir(dirname(reportPath), { recursive: true });
    await mkdir(isolatedHomePath, { recursive: true });
    const promptText = buildPlanAutoPrompt({
      parentIssue,
      config,
      prompts: workflowPrompts,
      promptPath,
      reportPath,
      branchName,
      worktreePath,
    });
    await writeDurablePrompt({
      targetRoot,
      config,
      issueNumber: options.issueNumber,
      sessionId,
      promptText,
    });
    store = new RunnerStateStore(targetRoot, config);
    await store.upsertRun({
      issueNumber: options.issueNumber,
      mode: 'plan-parent',
      workspacePath: worktreePath,
      sessionId,
      branchName,
      promptPath,
      reportPath,
      logPath,
      retryCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
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
        logPath,
      });
    } finally {
      await cleanupSessionCodexHome(isolatedHomePath);
    }
    const afterHead = await git.getHead(worktreePath);
    const base = baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues);

    if (beforeHead !== afterHead) {
      return finishPlanBlocked(issueAdapter, config, base, ['Planning session changed git HEAD; planning must not commit.'], []);
    }

    const changedFiles = await git.listChangedFiles(worktreePath);
    if (changedFiles.length > 0) {
      return finishPlanBlocked(
        issueAdapter,
        config,
        base,
        ['Planning session changed repository files; planning must return structured output only.'],
        [],
      );
    }

    if (codexResult.exitCode !== 0) {
      return finishPlanBlocked(
        issueAdapter,
        config,
        base,
        [`Codex exited with code ${codexResult.exitCode}: ${codexResult.stderr || codexResult.stdout}`],
        [],
      );
    }

    const reportRead = await readPlanReport(reportPath);
    if (reportRead.kind === 'missing') {
      return finishPlanBlocked(
        issueAdapter,
        config,
        base,
        ['Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove planning graph.'],
        [],
      );
    }
    const report = reportRead.report;

    await issueAdapter.updateIssue(options.issueNumber, {
      title: report.parent.title,
      body: report.parent.body,
    });

    for (const node of topologicalPlanNodes(report.graph)) {
      const persisted = await persistAutonomousChildNode(issueAdapter, config, options.issueNumber, node);
      childIssues.push(persisted);
    }

    const childNodes = await readAutonomousChildNodes(issueAdapter, config, options.issueNumber, childIssues);
    const batches = collectExecutableChildBatches(childNodes, config);
    if (!batches.ok) {
      return finishPlanBlocked(issueAdapter, config, base, batches.errors, childIssues);
    }

    for (const batch of batches.batches) {
      const settled = await Promise.allSettled(batch.map((child) => executeChild({
        targetRoot,
        config,
        parentIssue,
        child,
        dependencyIssues: dependencyIssuesFor(child, childNodes),
        parentBranchName: branchName,
        issueAdapter,
        git,
        codexAdapter,
        shellExecutor,
        issueTreeWorkflowPrompt,
        now,
      })));
      const failures: Array<{
        child?: AutonomousChildNode;
        message: string;
        durableRunSummary?: DurableRunSummaryEvidence;
        freshContextReview?: FreshContextReviewEvidence;
      }> = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          continue;
        }
        failures.push({
          child: batch[index],
          message: result.reason instanceof Error ? result.reason.message : 'child execution failed',
          durableRunSummary: result.reason instanceof ChildExecutionBlockedError ? result.reason.durableRunSummary : undefined,
          freshContextReview: result.reason instanceof ChildExecutionBlockedError ? result.reason.freshContextReview : undefined,
        });
      }
      if (failures.length > 0) {
        const successful = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
        await blockFailedBatch(issueAdapter, config, options.issueNumber, failures, successful);
        await blockCompletedChildren(
          issueAdapter,
          config,
          store,
          options.issueNumber,
          executionResults,
          'A later child batch failed before parent publication.',
          worktreePath,
        );
        return finishPlanBlocked(
          issueAdapter,
          config,
          baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues),
          [
            'Child batch failed before merge; no child from the failed batch was merged, pushed, or published.',
            ...failures.map((failure) => failure.child ? `#${failure.child.issue.number}: ${failure.message}` : failure.message),
          ],
          childIssues,
        );
      }

      const batchResults = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const orderedBatchResults = batchResults.sort((left, right) => left.child.issue.number - right.child.issue.number);
      for (const childResult of orderedBatchResults) {
        try {
          await git.mergeBranch({
            worktreePath,
            branchName: childResult.branchName,
            message: `Codex: merge issue #${childResult.child.issue.number} into parent #${options.issueNumber}`,
          });
        } catch (error) {
          if (error instanceof GitMergeConflictError) {
            await handleMergeConflict(git, issueAdapter, config, options.issueNumber, error, childResult, orderedBatchResults);
            await blockCompletedChildren(
              issueAdapter,
              config,
              store,
              options.issueNumber,
              executionResults,
              `A later merge conflict stopped parent publication before ${branchName} was pushed.`,
              worktreePath,
            );
            return finishPlanBlocked(
              issueAdapter,
              config,
              baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues),
              [
                `Merge conflict while merging #${childResult.child.issue.number} from ${childResult.branchName}.`,
                error.stderr || error.stdout,
              ],
              childIssues,
            );
          }
          throw error;
        }
      }
      for (const childResult of orderedBatchResults) {
        await git.removeWorktree({ targetRoot, worktreePath: childResult.worktreePath });
        executionResults.push(childResult);
      }
    }

    const finalValidation = await runConfiguredChecks(config, worktreePath, shellExecutor, []);
    const failedFinalValidation = finalValidation.filter((line) => line.status === 'failed');
    if (failedFinalValidation.length > 0) {
      await blockCompletedChildren(
        issueAdapter,
        config,
        store,
        options.issueNumber,
        executionResults,
        'Parent integration configured checks failed before publication.',
        worktreePath,
      );
      return finishPlanBlocked(
        issueAdapter,
        config,
        baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues),
        [
          'One or more configured checks failed.',
          ...failedFinalValidation.map((line) => `${line.command}: ${line.status} - ${line.summary}`),
        ],
        childIssues,
      );
    }
    await git.pushBranch({ worktreePath, branchName });
    pullRequest = await pullRequestAdapter.createDraftPullRequest({
      title: renderParentTemplate(config.pullRequests.issueTreeTitle, options.issueNumber),
      body: buildIssueTreePullRequestBody({
        parentIssueNumber: options.issueNumber,
        childIssues,
        childResults: executionResults,
        finalValidation,
      }),
      headBranch: branchName,
      baseBranch: config.branches.base,
    });

    const reportComment = buildIssueTreeReviewReport({
      parentIssueNumber: options.issueNumber,
      pullRequest,
      batches: batches.batches,
      childResults: executionResults,
      finalValidation,
    });
    await markCompletedChildrenReviewReady(issueAdapter, config, store, options.issueNumber, executionResults);
    await issueAdapter.removeLabels(options.issueNumber, [config.github.labels.running.name]);
    await issueAdapter.addLabels(options.issueNumber, [config.github.labels.review.name]);
    await issueAdapter.postComment(options.issueNumber, reportComment);
    await store.removeRun(options.issueNumber);

    return {
      ...baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues),
      status: 'review-ready',
      pullRequest,
      reportComment,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'plan-auto planning failed';
    if (pullRequest) {
      throw new Error(`Issue-tree execution failed after draft PR creation (${pullRequest.url}); not marking parent blocked: ${message}`);
    }
    if (store && executionResults.length > 0) {
      await blockCompletedChildren(
        issueAdapter,
        config,
        store,
        options.issueNumber,
        executionResults,
        `Parent publication failed before review handoff: ${message}`,
        worktreePath,
      );
    }
    return finishPlanBlocked(
      issueAdapter,
      config,
      baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues),
      [message],
      childIssues,
    );
  }
}

async function readPlanReport(
  reportPath: string,
): Promise<{ kind: 'missing' } | { kind: 'valid'; report: PlanAutoCompletionReport }> {
  try {
    return await readPlanAutoCompletionReport(reportPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid plan-auto completion report';
    throw new Error(message);
  }
}

async function readPlanWorkflowPrompts(targetRoot: string, config: CodexOrchestratorConfig): Promise<PlanWorkflowPrompts> {
  return {
    prd: await readPlanWorkflowPrompt(targetRoot, config.workflows.prd.promptPath),
    issueBreakdown: await readPlanWorkflowPrompt(targetRoot, config.workflows.issueBreakdown.promptPath),
    breakdownReview: await readPlanWorkflowPrompt(targetRoot, config.workflows.breakdownReview.promptPath),
    triage: await readPlanWorkflowPrompt(targetRoot, config.workflows.triage.promptPath),
  };
}

async function readPlanWorkflowPrompt(targetRoot: string, promptPath: string | undefined): Promise<string> {
  return readWorkflowPrompt(targetRoot, promptPath, 'Plan-auto workflow prompt');
}

async function readIssueTreeWorkflowPrompt(targetRoot: string, config: CodexOrchestratorConfig): Promise<string> {
  return readWorkflowPrompt(
    targetRoot,
    config.workflows.issueTreeOrchestration.promptPath,
    'Issue-tree orchestration workflow prompt',
  );
}

async function readWorkflowPrompt(targetRoot: string, promptPath: string | undefined, promptName: string): Promise<string> {
  const absolutePath = promptPath ? join(targetRoot, promptPath) : 'undefined';
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`${promptName} not found at ${absolutePath}`);
    }
    throw error;
  }
}

async function executeChild(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  parentIssue: GitHubIssue;
  child: AutonomousChildNode;
  dependencyIssues: GitHubIssue[];
  parentBranchName: string;
  issueAdapter: GitHubIssueAdapter;
  git: GitWorktreeManager;
  codexAdapter: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  shellExecutor: ShellCommandExecutor;
  issueTreeWorkflowPrompt: string;
  now: Date;
}): Promise<ChildExecutionResult> {
  const childIssueNumber = input.child.issue.number;
  const branchName = `codex/tree-${input.parentIssue.number}-issue-${childIssueNumber}`;
  const worktreePath = join(input.targetRoot, input.config.runner.workspaceRoot, `tree-${input.parentIssue.number}-issue-${childIssueNumber}`);
  const sessionId = `tree-${input.parentIssue.number}-issue-${childIssueNumber}-${formatSessionTimestamp(input.now)}`;
  const promptPath = sessionPromptPath({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: childIssueNumber,
    sessionId,
  });
  const reportPath = sessionReportPath({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: childIssueNumber,
    sessionId,
  });
  const logPath = sessionLogPath({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: childIssueNumber,
    sessionId,
  });
  const isolatedHomePath = sessionCodexHomePath({ targetRoot: input.targetRoot, sessionId });
  const store = new RunnerStateStore(input.targetRoot, input.config);

  await input.git.createIssueWorktree({
    targetRoot: input.targetRoot,
    workspacePath: worktreePath,
    branchName,
    baseBranch: input.parentBranchName,
  });
  await input.issueAdapter.addLabels(childIssueNumber, [input.config.github.labels.running.name]);
  await input.issueAdapter.postComment(
    childIssueNumber,
    `codex-orchestrator: claimed #${childIssueNumber} for tree-child autonomous work under #${input.parentIssue.number} at ${input.now.toISOString()}.`,
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(isolatedHomePath, { recursive: true });
  const promptText = buildIssueTreeChildPrompt({
    parentIssue: input.parentIssue,
    childIssue: input.child.issue,
    config: input.config,
    workflowPromptText: input.issueTreeWorkflowPrompt,
    childMetadata: input.child.metadata,
    dependencyIssues: input.dependencyIssues,
    promptPath,
    reportPath,
    branchName,
    worktreePath,
  });
  await writeDurablePrompt({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: childIssueNumber,
    sessionId,
    promptText,
  });
  await store.upsertRun({
    issueNumber: childIssueNumber,
    parentIssueNumber: input.parentIssue.number,
    mode: 'tree-child',
    workspacePath: worktreePath,
    sessionId,
    branchName,
    promptPath,
    reportPath,
    logPath,
    retryCount: 0,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
  });

  let publishability: Awaited<ReturnType<typeof runImplementationPublishabilityCheck>> | undefined;
  let rework: { attempt: number; blockedReasons: string[] } | undefined;
  for (let attempt = 0; attempt <= input.config.loopPolicy.rework.maxAttempts; attempt++) {
    const attemptPromptText = rework
      ? `${promptText}\n\n## Rework Request\nThis is an automatic rework attempt (#${rework.attempt}). Continue from the current worktree state; do not start over.\nThe previous attempt was blocked for these reasons:\n${rework.blockedReasons.map((reason) => `- ${reason}`).join('\n')}\nAddress the blockers, then produce a fresh completion report JSON for the runner.`
      : promptText;
    await writeDurablePrompt({
      targetRoot: input.targetRoot,
      config: input.config,
      issueNumber: childIssueNumber,
      sessionId,
      promptText: attemptPromptText,
    });
    const beforeHead = await input.git.getHead(worktreePath);
    let codexResult: CodexCommandRunResult;
    try {
      codexResult = await input.codexAdapter.run({
        targetRoot: input.targetRoot,
        config: input.config,
        worktreePath,
        promptPath,
        promptText: attemptPromptText,
        reportPath,
        isolatedHomePath,
        issueNumber: childIssueNumber,
        sessionId,
        branchName,
        logPath,
      });
    } finally {
      await cleanupSessionCodexHome(isolatedHomePath);
    }
    const afterHead = await input.git.getHead(worktreePath);
    publishability = await runImplementationPublishabilityCheck({
      config: input.config,
      issue: input.child.issue,
      worktreePath,
      reportPath,
      beforeHead,
      afterHead,
      codexResult,
      git: input.git,
      shellExecutor: input.shellExecutor,
      commitMessage: `Codex: implement issue #${childIssueNumber} for parent #${input.parentIssue.number}`,
    });

    if (
      publishability.status === 'blocked'
      && attempt < input.config.loopPolicy.rework.maxAttempts
      && shouldRequestImplementationRework(publishability.reasons, input.config)
    ) {
      rework = { attempt: attempt + 1, blockedReasons: publishability.reasons };
      await mkdir(isolatedHomePath, { recursive: true });
      continue;
    }
    break;
  }

  if (!publishability) {
    throw new Error('Runner internal error: missing child publishability result');
  }

  if (publishability.status === 'promotion-requested') {
    const promotion = publishability.report.promotion;
    throw new Error(
      [
        'Child requested promotion instead of completing issue-tree work.',
        promotion ? `Reason: ${promotion.reason}` : undefined,
        promotion ? `Evidence: ${promotion.evidence.join(', ')}` : undefined,
      ].filter(Boolean).join(' '),
    );
  }

  if (publishability.status === 'blocked') {
    const durableRunSummary = await writeDurableRunSummary({
      targetRoot: input.targetRoot,
      config: input.config,
      issueNumber: childIssueNumber,
      sessionId,
      outcome: 'blocked',
      changedFiles: publishability.changedFiles,
      validation: [],
      blockers: publishability.reasons,
      skippedChecks: publishability.skippedChecks,
      residualRisks: publishability.residualRisks,
      nextAction: 'Parent issue-tree execution is blocked until this child is resolved.',
      logPath,
      reportPath,
    });
    throw new ChildExecutionBlockedError(publishability.reasons.join('; '), durableRunSummary);
  }

  const freshContextReview = await runFreshContextReviewIfEnabled({
    targetRoot: input.targetRoot,
    config: input.config,
    issue: input.child.issue,
    codexAdapter: input.codexAdapter,
    worktreePath,
    isolatedSessionId: `${sessionId}-fresh-review`,
    branchName,
    publishability,
  });
  if (freshContextReview?.status === 'blocked') {
    const durableRunSummary = await writeDurableRunSummary({
      targetRoot: input.targetRoot,
      config: input.config,
      issueNumber: childIssueNumber,
      sessionId,
      outcome: 'blocked',
      changedFiles: publishability.changedFiles,
      validation: publishability.validation,
      blockers: ['Fresh-Context Review blocked publication', ...freshContextReview.findings],
      skippedChecks: publishability.skippedChecks,
      residualRisks: [...publishability.residualRisks, ...freshContextReview.residualRisks],
      suggestionEvidence: freshContextReview.findings,
      nextAction: 'Parent issue-tree execution is blocked until this child review finding is resolved.',
      logPath,
      reportPath,
    });
    throw new ChildExecutionBlockedError(
      ['Fresh-Context Review blocked publication', ...freshContextReview.findings].join('; '),
      durableRunSummary,
      freshContextReview,
    );
  }

  const durableRunSummary = await writeDurableRunSummary({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: childIssueNumber,
    sessionId,
    outcome: 'review-ready',
    changedFiles: publishability.changedFiles,
    validation: publishability.validation,
    blockers: [],
    skippedChecks: publishability.skippedChecks,
    residualRisks: [...publishability.residualRisks, ...(freshContextReview?.residualRisks ?? [])],
    suggestionEvidence: freshContextReview?.findings,
    nextAction: 'Parent issue-tree integration should merge this child branch.',
    logPath,
    reportPath,
  });

  return {
    child: input.child,
    branchName,
    worktreePath,
    promptPath,
    reportPath,
    logPath,
    changedFiles: publishability.changedFiles,
    validation: publishability.validation,
    artifacts: publishability.artifacts,
    commits: publishability.commits,
    skippedChecks: publishability.skippedChecks,
    residualRisks: [...publishability.residualRisks, ...(freshContextReview?.residualRisks ?? [])],
    freshContextReview,
    durableRunSummary,
  };
}

async function blockFailedBatch(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  parentIssueNumber: number,
  failures: Array<{
    child?: AutonomousChildNode;
    message: string;
    durableRunSummary?: DurableRunSummaryEvidence;
    freshContextReview?: FreshContextReviewEvidence;
  }>,
  successfulUnmerged: ChildExecutionResult[],
): Promise<void> {
  for (const failure of failures) {
    if (!failure.child) {
      continue;
    }
    await issueAdapter.removeLabels(failure.child.issue.number, [config.github.labels.running.name]);
    await issueAdapter.addLabels(failure.child.issue.number, [config.github.labels.blocked.name]);
    await issueAdapter.postComment(
      failure.child.issue.number,
      buildChildBlockedReport({
        parentIssueNumber,
        childIssueNumber: failure.child.issue.number,
        reasons: [failure.message],
        details: ['Worktree preserved for maintainer inspection.'],
        freshContextReview: failure.freshContextReview,
        durableRunSummary: failure.durableRunSummary,
      }),
    );
  }
  for (const result of successfulUnmerged) {
    await issueAdapter.removeLabels(result.child.issue.number, [config.github.labels.running.name]);
    await issueAdapter.addLabels(result.child.issue.number, [config.github.labels.blocked.name]);
    await issueAdapter.postComment(
      result.child.issue.number,
      buildChildBlockedReport({
        parentIssueNumber,
        childIssueNumber: result.child.issue.number,
        reasons: ['A sibling child failed before the batch merge; this child branch was not merged.'],
        branchName: result.branchName,
        worktreePath: result.worktreePath,
        durableRunSummary: result.durableRunSummary,
      }),
    );
  }
}

async function handleMergeConflict(
  git: GitWorktreeManager,
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  parentIssueNumber: number,
  error: GitMergeConflictError,
  childResult: ChildExecutionResult,
  batchResults: ChildExecutionResult[],
): Promise<void> {
  let abortMessage = '';
  try {
    await git.abortMerge(error.worktreePath);
  } catch (abortError) {
    abortMessage = abortError instanceof Error ? abortError.message : 'merge abort failed';
  }
  for (const result of batchResults) {
    await issueAdapter.removeLabels(result.child.issue.number, [config.github.labels.running.name]);
    await issueAdapter.addLabels(result.child.issue.number, [config.github.labels.blocked.name]);
    await issueAdapter.postComment(
      result.child.issue.number,
      buildChildBlockedReport({
        parentIssueNumber,
        childIssueNumber: result.child.issue.number,
        reasons: [
          result.child.issue.number === childResult.child.issue.number
            ? `Merge conflict from branch ${childResult.branchName}`
            : `A sibling merge conflict stopped the batch before publication: ${childResult.branchName}`,
        ],
        details: [
          `- Parent worktree: ${error.worktreePath}`,
          `- Child worktree: ${result.worktreePath}`,
          `- Child branch preserved: ${result.branchName}`,
          abortMessage ? `- Merge abort also failed: ${abortMessage}` : '- Merge abort completed.',
        ],
        batchChildren: batchResults.map((batchResult) => ({
          issueNumber: batchResult.child.issue.number,
          branchName: batchResult.branchName,
        })),
        gitOutput: error.stderr || error.stdout || 'no git output',
        durableRunSummary: result.durableRunSummary,
      }),
    );
  }
}

async function markCompletedChildrenReviewReady(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  store: RunnerStateStore,
  parentIssueNumber: number,
  childResults: ChildExecutionResult[],
): Promise<void> {
  for (const childResult of childResults) {
    await issueAdapter.removeLabels(childResult.child.issue.number, [config.github.labels.running.name]);
    await issueAdapter.addLabels(childResult.child.issue.number, [config.github.labels.review.name]);
    await issueAdapter.postComment(
      childResult.child.issue.number,
      buildChildReviewReport({ parentIssueNumber, result: childResult }),
    );
    await store.removeRun(childResult.child.issue.number);
  }
}

async function blockCompletedChildren(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  store: RunnerStateStore,
  parentIssueNumber: number,
  childResults: ChildExecutionResult[],
  reason: string,
  parentWorktreePath: string,
): Promise<void> {
  for (const result of childResults) {
    await issueAdapter.removeLabels(result.child.issue.number, [config.github.labels.running.name]);
    await issueAdapter.addLabels(result.child.issue.number, [config.github.labels.blocked.name]);
    await issueAdapter.postComment(
      result.child.issue.number,
      buildChildBlockedReport({
        parentIssueNumber,
        childIssueNumber: result.child.issue.number,
        reasons: [reason],
        details: [
          `- Merged child branch was not published: ${result.branchName}`,
          `- Parent worktree preserved: ${parentWorktreePath}`,
        ],
        durableRunSummary: result.durableRunSummary,
      }),
    );
    await store.removeRun(result.child.issue.number);
  }
}

async function finishPlanBlocked(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  result: PlanBlockedContext,
  reasons: string[],
  mutatedChildren: GitHubIssue[],
): Promise<PlanAutoCommandResult> {
  const reportComment = buildParentBlockedReport({
    parentIssueNumber: result.parentIssueNumber,
    reasons,
    logPath: result.logPath,
    mutatedChildren,
  });
  await issueAdapter.removeLabels(result.parentIssueNumber, [config.github.labels.running.name]);
  await issueAdapter.addLabels(result.parentIssueNumber, [config.github.labels.blocked.name]);
  await issueAdapter.postComment(result.parentIssueNumber, reportComment);
  return { ...result, status: 'blocked', reportComment };
}

function dependencyIssuesFor(child: AutonomousChildNode, allChildren: AutonomousChildNode[]): GitHubIssue[] {
  const issuesByStableId = new Map(allChildren.map((node) => [node.metadata.stableId, node.issue]));
  return child.metadata.dependsOn.flatMap((stableId) => {
    const issue = issuesByStableId.get(stableId);
    return issue ? [issue] : [];
  });
}

function renderParentTemplate(template: string, parentIssueNumber: number): string {
  return template.replaceAll('${parentIssueNumber}', String(parentIssueNumber));
}

function baseResult(
  parentIssueNumber: number,
  branchName: string,
  worktreePath: string,
  promptPath: string,
  reportPath: string,
  logPath: string,
  childIssues: GitHubIssue[],
): PlanBlockedContext {
  return { parentIssueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues };
}
