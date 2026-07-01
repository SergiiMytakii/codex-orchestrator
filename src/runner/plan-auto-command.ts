import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { resolveBaseBranch } from '../git/base-branch.js';
import { GitMergeConflictError, GitWorktreeManager, renderBranchTemplate, type SessionCommitInfo } from '../git/worktree.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { verifyPullRequestRefs } from '../github/pull-requests.js';
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
import { writeContextSnapshot } from './context-snapshot.js';
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
import { RunnerLifecycleEventStore, type LifecycleArtifact } from './lifecycle-events.js';
import type { AcceptanceProofAttemptEvidence } from './acceptance-proof-runner.js';
import { RunnerStateStore } from './local-state.js';
import {
  buildIssueTreeChildPrompt,
  buildPlanAutoPrompt,
  sessionPromptPath,
  sessionReportPath,
  writeDurablePrompt,
} from './prompt.js';
import { maxReworkAttemptsForReasons, shouldRequestImplementationRework } from './rework-policy.js';
import { evaluateParentRiskRoutingGate } from './review-gates.js';
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
  riskRoutingWarnings: string[];
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
  sessionId?: string;
  snapshotPath?: string;
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
  reviewHandoff?: ScopedCompletionReport['reviewHandoff'];
  freshContextReview?: FreshContextReviewEvidence;
  durableRunSummary?: DurableRunSummaryEvidence;
  acceptanceProof?: AcceptanceProofAttemptEvidence;
}

class ChildExecutionBlockedError extends Error {
  public constructor(
    message: string,
    public readonly durableRunSummary?: DurableRunSummaryEvidence,
    public readonly freshContextReview?: FreshContextReviewEvidence,
    public readonly acceptanceProof?: AcceptanceProofAttemptEvidence,
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
  const resolvedBase = await resolveBaseBranch({ targetRoot, base: config.branches.base });
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
  const acceptanceProofWorkflowPrompt = await readAcceptanceProofWorkflowPrompt(targetRoot, config);
  const branchName = renderBranchTemplate(config.branches.issueTree, { parentIssueNumber: options.issueNumber });
  const worktreePath = join(targetRoot, config.runner.workspaceRoot, `tree-${options.issueNumber}`);
  let promptPath = '';
  let reportPath = '';
  let logPath = '';
  let sessionId = '';
  let parentSnapshotPath = '';
  const childIssues: GitHubIssue[] = [];
  let pullRequest: GitHubPullRequest | undefined;
  let store: RunnerStateStore | undefined;
  const executionResults: ChildExecutionResult[] = [];
  const events = new RunnerLifecycleEventStore(targetRoot, config);
  const buildBase = () =>
    baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues, sessionId, parentSnapshotPath);

  await claimIssue(issueAdapter, config, options.issueNumber, 'plan-parent', now);

  try {
    await git.createIssueWorktree({
      targetRoot,
      workspacePath: worktreePath,
      branchName,
      baseBranch: resolvedBase.sha,
      requiredBaseSha: resolvedBase.sha,
    });
    sessionId = `plan-${options.issueNumber}-${formatSessionTimestamp(now)}`;
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
    const snapshot = await writeContextSnapshot({
      targetRoot,
      config,
      issue: parentIssue,
      mode: 'plan-parent',
      phase: 'plan-parent',
      decision: 'parent planning session',
      sessionId,
      worktreePath,
      promptPath,
      reportPath,
      logPath,
      branchName,
      baseBranch: resolvedBase.prBaseBranch,
      base: resolvedBase,
      createdAt: now,
    });
    parentSnapshotPath = snapshot.path;
    await safeAppendEvent(events, {
      timestamp: now,
      issueNumber: options.issueNumber,
      mode: 'plan-parent',
      sessionId,
      phase: 'plan-parent',
      status: 'started',
      summary: 'Starting parent planning Codex session.',
      artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshot.path),
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
        phase: 'plan-parent',
        logPath,
      });
    } finally {
      await cleanupSessionCodexHome(isolatedHomePath);
    }
    const afterHead = await git.getHead(worktreePath);
    const base = buildBase();

    if (beforeHead !== afterHead) {
      return finishPlanBlocked(issueAdapter, config, events, base, ['Planning session changed git HEAD; planning must not commit.'], []);
    }

    const changedFiles = await git.listChangedFiles(worktreePath);
    if (changedFiles.length > 0) {
      return finishPlanBlocked(
        issueAdapter,
        config,
        events,
        base,
        ['Planning session changed repository files; planning must return structured output only.'],
        [],
      );
    }

    if (codexResult.exitCode !== 0) {
      return finishPlanBlocked(
        issueAdapter,
        config,
        events,
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
        events,
        base,
        ['Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove planning graph.'],
        [],
      );
    }
    const report = reportRead.report;
    const parentRiskRouting = evaluateParentRiskRoutingGate({ config, report });
    const riskRoutingWarnings = parentRiskRouting.warnings;
    if (!parentRiskRouting.ok) {
      return finishPlanBlocked(
        issueAdapter,
        config,
        events,
        base,
        parentRiskRouting.reasons,
        [],
      );
    }

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
      return finishPlanBlocked(issueAdapter, config, events, base, batches.errors, childIssues);
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
        acceptanceProofWorkflowPrompt,
        now,
        events,
      })));
      const failures: Array<{
        child?: AutonomousChildNode;
        message: string;
        durableRunSummary?: DurableRunSummaryEvidence;
        freshContextReview?: FreshContextReviewEvidence;
        acceptanceProof?: AcceptanceProofAttemptEvidence;
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
          acceptanceProof: result.reason instanceof ChildExecutionBlockedError ? result.reason.acceptanceProof : undefined,
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
          events,
          buildBase(),
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
              events,
              buildBase(),
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
        events,
        buildBase(),
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
        sizeRisk: report.sizeRisk,
        parentReviewHandoff: report.parentReviewHandoff,
        riskRoutingWarnings,
      }),
      headBranch: branchName,
      baseBranch: resolvedBase.prBaseBranch,
    });
    pullRequest = await verifyPullRequestRefs(pullRequestAdapter, pullRequest, branchName, resolvedBase.prBaseBranch);

    const reportComment = buildIssueTreeReviewReport({
      parentIssueNumber: options.issueNumber,
      pullRequest,
      batches: batches.batches,
      childResults: executionResults,
      finalValidation,
      sizeRisk: report.sizeRisk,
      parentReviewHandoff: report.parentReviewHandoff,
      riskRoutingWarnings,
    });
    await markCompletedChildrenReviewReady(issueAdapter, config, store, options.issueNumber, executionResults);
    await issueAdapter.removeLabels(options.issueNumber, [config.github.labels.running.name]);
    await issueAdapter.addLabels(options.issueNumber, [config.github.labels.review.name]);
    await issueAdapter.postComment(options.issueNumber, reportComment);
    await store.removeRun(options.issueNumber);
    await safeAppendEvent(events, {
      issueNumber: options.issueNumber,
      mode: 'plan-parent',
      sessionId,
      phase: 'plan-parent',
      status: 'completed',
      summary: 'Issue-tree execution completed draft PR handoff.',
      artifacts: [
        ...sessionArtifacts(promptPath, reportPath, logPath, parentSnapshotPath),
        { kind: 'pr', url: pullRequest.url, description: 'Draft pull request' },
      ],
    });

    return {
      ...buildBase(),
      status: 'review-ready',
      pullRequest,
      reportComment,
      riskRoutingWarnings,
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
      events,
      buildBase(),
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

async function readAcceptanceProofWorkflowPrompt(targetRoot: string, config: CodexOrchestratorConfig): Promise<string> {
  return readWorkflowPrompt(
    targetRoot,
    config.workflows.acceptanceProof.promptPath,
    'Acceptance proof workflow prompt',
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
  acceptanceProofWorkflowPrompt: string;
  now: Date;
  events: RunnerLifecycleEventStore;
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
  const maxReworkAttempts = Math.max(
    input.config.loopPolicy.rework.maxAttempts,
    input.config.reviewGates.acceptanceProof.maxIterations - 1,
  );
  for (let attempt = 0; attempt <= maxReworkAttempts; attempt++) {
    const attemptNow = new Date(input.now.getTime() + attempt);
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
    const snapshot = await writeContextSnapshot({
      targetRoot: input.targetRoot,
      config: input.config,
      issue: input.child.issue,
      mode: 'tree-child',
      phase: 'tree-child',
      decision: rework
        ? `tree-child rework attempt #${rework.attempt} under parent #${input.parentIssue.number}`
        : `child issue execution under parent #${input.parentIssue.number}`,
      sessionId,
      worktreePath,
      promptPath,
      reportPath,
      logPath,
      branchName,
      baseBranch: input.parentBranchName,
      parentIssueNumber: input.parentIssue.number,
      blockedBy: [],
      createdAt: attemptNow,
    });
    await safeAppendEvent(input.events, {
      timestamp: attemptNow,
      issueNumber: childIssueNumber,
      parentIssueNumber: input.parentIssue.number,
      mode: 'tree-child',
      sessionId,
      phase: 'tree-child',
      status: 'started',
      summary: rework ? `Starting tree-child rework attempt #${rework.attempt}.` : 'Starting tree-child Codex session.',
      artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshot.path),
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
        phase: 'tree-child',
        logPath,
      });
    } finally {
      await cleanupSessionCodexHome(isolatedHomePath);
    }
    const afterHead = await input.git.getHead(worktreePath);
    publishability = await runImplementationPublishabilityCheck({
      config: input.config,
      issue: input.child.issue,
      targetRoot: input.targetRoot,
      worktreePath,
      reportPath,
      beforeHead,
      afterHead,
      codexResult,
      git: input.git,
      shellExecutor: input.shellExecutor,
      commitMessage: `Codex: implement issue #${childIssueNumber} for parent #${input.parentIssue.number}`,
      acceptanceProof: {
        targetRoot: input.targetRoot,
        sessionId,
        branchName,
        workflowPromptText: input.acceptanceProofWorkflowPrompt,
        codexAdapter: input.codexAdapter,
        onAttemptEvent: (event) => appendAcceptanceProofEvent({
          events: input.events,
          issueNumber: childIssueNumber,
          parentIssueNumber: input.parentIssue.number,
          sessionId,
          event,
        }),
      },
    });

    if (
      publishability.status === 'blocked'
      && attempt < maxReworkAttemptsForReasons(publishability.reasons, input.config)
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
      validation: publishability.validation ?? [],
      blockers: publishability.reasons,
      skippedChecks: publishability.skippedChecks,
      residualRisks: publishability.residualRisks,
      nextAction: 'Parent issue-tree execution is blocked until this child is resolved.',
      logPath,
      reportPath,
      acceptanceProof: publishability.acceptanceProofAttempt,
    });
    throw new ChildExecutionBlockedError(publishability.reasons.join('; '), durableRunSummary, undefined, publishability.acceptanceProofAttempt);
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
      acceptanceProof: publishability.acceptanceProofAttempt,
    });
    throw new ChildExecutionBlockedError(
      ['Fresh-Context Review blocked publication', ...freshContextReview.findings].join('; '),
      durableRunSummary,
      freshContextReview,
      publishability.acceptanceProofAttempt,
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
    acceptanceProof: publishability.acceptanceProofAttempt,
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
    reviewHandoff: publishability.report.reviewHandoff,
    freshContextReview,
    durableRunSummary,
    acceptanceProof: publishability.acceptanceProofAttempt,
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
    acceptanceProof?: AcceptanceProofAttemptEvidence;
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
        acceptanceProof: failure.acceptanceProof,
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
        acceptanceProof: result.acceptanceProof,
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
        acceptanceProof: result.acceptanceProof,
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
        acceptanceProof: result.acceptanceProof,
      }),
    );
    await store.removeRun(result.child.issue.number);
  }
}

async function finishPlanBlocked(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  events: RunnerLifecycleEventStore,
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
  await safeAppendEvent(events, {
    issueNumber: result.parentIssueNumber,
    mode: 'plan-parent',
    sessionId: result.sessionId,
    phase: 'plan-parent',
    status: 'blocked',
    summary: `Issue-tree execution blocked: ${reasons[0] ?? 'blocked'}`,
    artifacts: sessionArtifacts(result.promptPath, result.reportPath, result.logPath, result.snapshotPath),
  });
  return { ...result, status: 'blocked', reportComment, riskRoutingWarnings: [] };
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

function sessionArtifacts(
  promptPath: string,
  reportPath: string,
  logPath: string,
  snapshotPath?: string,
): LifecycleArtifact[] {
  const artifacts: Array<LifecycleArtifact | undefined> = [
    snapshotPath ? { kind: 'snapshot', path: snapshotPath, description: 'Context snapshot' } : undefined,
    promptPath ? { kind: 'prompt', path: promptPath, description: 'Session prompt path' } : undefined,
    reportPath ? { kind: 'report', path: reportPath, description: 'Session report path' } : undefined,
    logPath ? { kind: 'log', path: logPath, description: 'Session log path' } : undefined,
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
    // Diagnostics evidence must not alter the runner publication outcome.
  }
}

async function appendAcceptanceProofEvent(input: {
  events: RunnerLifecycleEventStore;
  issueNumber: number;
  parentIssueNumber: number;
  sessionId: string;
  event: {
    status: 'started' | 'passed' | 'needs-rework' | 'blocked';
    evidence?: AcceptanceProofAttemptEvidence;
  };
}): Promise<void> {
  const evidence = input.event.evidence;
  await safeAppendEvent(input.events, {
    issueNumber: input.issueNumber,
    parentIssueNumber: input.parentIssueNumber,
    mode: 'tree-child',
    sessionId: input.sessionId,
    phase: 'acceptance-proof',
    status: input.event.status === 'passed' ? 'completed' : input.event.status,
    summary: input.event.status === 'started'
      ? 'Starting tree-child Adaptive Proof Agent session.'
      : `Tree-child Adaptive Proof Agent finished with ${input.event.status}.`,
    artifacts: evidence ? [
      { kind: 'prompt', path: evidence.promptPath, description: 'Acceptance proof prompt path' },
      { kind: 'report', path: evidence.reportPath, description: 'Acceptance proof report path' },
      ...evidence.artifactPaths.map((path) => ({ kind: 'other' as const, path, description: 'Acceptance proof artifact' })),
    ] : undefined,
  });
}

function baseResult(
  parentIssueNumber: number,
  branchName: string,
  worktreePath: string,
  promptPath: string,
  reportPath: string,
  logPath: string,
  childIssues: GitHubIssue[],
  sessionId?: string,
  snapshotPath?: string,
): PlanBlockedContext {
  return { parentIssueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues, sessionId, snapshotPath };
}
