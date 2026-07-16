import { mkdir } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { resolveBaseBranch } from '../git/base-branch.js';
import { GitMergeConflictError, GitWorktreeManager, renderBranchTemplate, type SessionCommitInfo } from '../git/worktree.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { defaultShellCommandExecutor, type ShellCommandExecutor } from '../process/command.js';
import {
  formatSessionTimestamp,
  readRunnerConfig,
  rereadRunnerConfigUnderFence,
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
import { writeDurableRunSummary, type DurableRunSummaryEvidence, type ReworkAttemptEvidence } from './durable-run-summary.js';
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
import { RunnerLifecycleEventStore, type LifecycleArtifact } from './lifecycle-events.js';
import type { AcceptanceProofAttemptEvidence } from './acceptance-proof-runner.js';
import { RunnerStateStore } from './local-state.js';
import {
  classifyPlanAutoBlockedChildRecovery,
  classifyPlanAutoCompletedChildRecovery,
  classifyPlanAutoParentRecovery,
  type PlanAutoChildRecoveryDecision,
} from './plan-auto-recovery.js';
import { sessionPromptPath, sessionReportPath, writeDurablePrompt } from './prompt.js';
import { runAgentAttemptLoop } from './agent-attempt.js';
import type { ProcessProbeResult } from './scoped-recovery.js';
import { evaluateParentRiskRoutingGate } from './review-gates.js';
import {
  buildBlockedHandoffEvidence,
  buildPromotionAsBlockedHandoffEvidence,
  buildReviewReadyHandoffEvidence,
} from './runner-handoff-decision.js';
import { sessionLogPath } from './run-log.js';
import {
  finishBlockedTerminalOutcome,
  finishReviewReadyCommentTerminalOutcome,
  finishReviewReadyTerminalOutcome,
} from './terminal-outcome.js';
import { acquireTargetActivityFence } from './target-activity-fence.js';
import { prepareSkillRuntimeExecution, skillExecutionPolicyHash } from './skill-runtime-execution.js';
import { requireConfigV2 } from '../setup/skill-runtime-v2-migration.js';
import { runSkillRuntimePreflight } from './skill-runtime-preflight.js';

export interface PlanAutoCommandOptions {
  targetRoot: string;
  issueNumber: number;
  issueAdapter?: GitHubIssueAdapter;
  pullRequestAdapter?: GitHubPullRequestAdapter;
  git?: GitWorktreeManager;
  codexAdapter?: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  shellExecutor?: ShellCommandExecutor;
  now?: Date;
  hostname?: () => string;
  processProbe?: (pid: number) => Promise<ProcessProbeResult> | ProcessProbeResult;
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
  recovered?: boolean;
}

class ChildExecutionBlockedError extends Error {
  public constructor(
    message: string,
    public readonly durableRunSummary?: DurableRunSummaryEvidence,
    public readonly freshContextReview?: FreshContextReviewEvidence,
    public readonly acceptanceProof?: AcceptanceProofAttemptEvidence,
    public readonly reworkAttempts?: ReworkAttemptEvidence[],
  ) {
    super(message);
  }
}

export async function runPlanAutoCommand(options: PlanAutoCommandOptions): Promise<PlanAutoCommandResult> {
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
    return await runPlanAutoCommandFenced(options);
  } finally {
    await lease.release();
  }
}

async function runPlanAutoCommandFenced(options: PlanAutoCommandOptions): Promise<PlanAutoCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const now = options.now ?? new Date();
  const config = await readRunnerConfig(targetRoot);
  let retainedOwner: import('../codex/app-server-process.js').AppServerProcessOwner | undefined;
  if (!options.codexAdapter) {
    if ((config as { version: number }).version !== 2) throw new Error('orchestrator-skill-runtime-v2-required');
    retainedOwner = (await runSkillRuntimePreflight({
      targetRoot, config: config as any, runId: `plan-${options.issueNumber}-preflight`, retainAppServer: true,
    })).retainedOwner;
  }
  const issueAdapter = options.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const pullRequestAdapter = options.pullRequestAdapter ?? new GhCliPullRequestAdapter(config.github.owner, config.github.repo);
  const git = options.git ?? new GitWorktreeManager();
  const shellExecutor = options.shellExecutor ?? defaultShellCommandExecutor;
  let resolvedBase;
  let parentIssue;
  try {
    resolvedBase = await resolveBaseBranch({ targetRoot, base: config.branches.base });
    parentIssue = await issueAdapter.getIssue(options.issueNumber);
  } catch (error) {
    await retainedOwner?.close('preclaim-failed');
    throw error;
  }

  if (!parentIssue) {
    await retainedOwner?.close('preclaim-failed');
    throw new Error(`Issue #${options.issueNumber} was not found`);
  }
  const codexAdapter = options.codexAdapter ?? new CodexCommandAdapter(requireConfigV2(config), { retainedOwner });

  const branchName = renderBranchTemplate(config.branches.issueTree, { parentIssueNumber: options.issueNumber });
  const worktreePath = join(targetRoot, config.runner.workspaceRoot, `tree-${options.issueNumber}`);
  const store = new RunnerStateStore(targetRoot, config);
  let parentRecovery: Awaited<ReturnType<typeof classifyPlanAutoParentRecovery>>;
  try {
    parentRecovery = await classifyPlanAutoParentRecovery({
      targetRoot,
      config,
      parentIssue,
      branchName,
      worktreePath,
      baseSha: resolvedBase.sha,
      state: await store.load(),
      git,
      now,
      hostname: options.hostname,
      processProbe: options.processProbe,
    });
  } catch (error) {
    await retainedOwner?.close('preclaim-failed');
    throw error;
  }
  const decision = discoverIssueWork([parentIssue], config)[0];
  const parentLabels = new Set(parentIssue.labels.map((label) => label.name));
  const alreadyRunningPlanParent = decision?.kind === 'skipped'
    && decision.reasonCode === 'already-running'
    && parentIssue.state === 'OPEN'
    && parentLabels.has(config.github.labels.planAuto.name)
    && !parentLabels.has(config.github.labels.child.name);
  if (!decision || !((decision.kind === 'eligible' && decision.mode === 'plan-parent') || alreadyRunningPlanParent)) {
    await retainedOwner?.close('preclaim-failed');
    const reason = decision?.kind === 'skipped' ? decision.reason : 'not agent:plan-auto';
    throw new Error(`Issue #${options.issueNumber} is not eligible for agent:plan-auto planning: ${reason}`);
  }

  let promptPath = '';
  let reportPath = '';
  let logPath = '';
  let sessionId = '';
  let parentSnapshotPath = '';
  const childIssues: GitHubIssue[] = [];
  let pullRequest: GitHubPullRequest | undefined;
  const executionResults: ChildExecutionResult[] = [];
  const events = new RunnerLifecycleEventStore(targetRoot, config);
  const buildBase = () =>
    baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath, childIssues, sessionId, parentSnapshotPath);

  if (parentRecovery.kind === 'hard-block') {
    await retainedOwner?.close('preclaim-failed');
    return finishPlanBlocked(issueAdapter, config, events, buildBase(), [parentRecovery.reason], childIssues, parentRecovery.marker);
  }
  if (alreadyRunningPlanParent && parentRecovery.kind !== 'resume-parent') {
    await retainedOwner?.close('preclaim-failed');
    return finishPlanBlocked(
      issueAdapter,
      config,
      events,
      buildBase(),
      ['parent recovery requires runner-owned metadata for running parent'],
      childIssues,
      `plan-auto-recovery-blocked parent=${options.issueNumber} reason=missing-runner-owned-metadata`,
    );
  }
  if (!alreadyRunningPlanParent) {
    try {
      await claimIssue(issueAdapter, config, options.issueNumber, 'plan-parent', now);
    } catch (error) {
      await retainedOwner?.close('preclaim-failed');
      throw error;
    }
  }

  try {
    if (parentRecovery.kind === 'resume-parent') {
      await git.ensureIssueWorktree({
        targetRoot,
        workspacePath: worktreePath,
        branchName,
        baseBranch: resolvedBase.sha,
        requiredBaseSha: resolvedBase.sha,
        allowResume: true,
      });
    } else {
      await git.createIssueWorktree({
        targetRoot,
        workspacePath: worktreePath,
        branchName,
        baseBranch: resolvedBase.sha,
        requiredBaseSha: resolvedBase.sha,
      });
    }
    sessionId = `plan-${options.issueNumber}-${formatSessionTimestamp(now)}`;
    promptPath = sessionPromptPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
    reportPath = sessionReportPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
    logPath = sessionLogPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
    await mkdir(dirname(reportPath), { recursive: true });
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
    const execution = await prepareSkillRuntimeExecution({
      targetRoot,
      config,
      worktreePath,
      runId: `issue-${options.issueNumber}-${sessionId}`,
      issueNumber: options.issueNumber,
      sessionId,
      branchName,
      phase: 'plan-parent',
      operationId: 'plan-parent',
      attemptId: `${sessionId}-plan-parent`,
      reportPath,
      logPath,
      context: { parentIssue, branchName, worktreePath, promptPath, reportPath, logPath },
    });
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
      ownerPid: process.pid,
      host: (options.hostname ?? osHostname)(),
      leaseUpdatedAt: now.toISOString(),
      baseSha: resolvedBase.sha,
      ...((config as { version: number }).version === 2 ? {
        stateVersion: 2 as const,
        runId: execution.input.runId,
        skillRuntime: execution.input.skillRuntime,
        executionPolicyHash: skillExecutionPolicyHash(execution.input.manifestNode),
        effectivePolicySummary: execution.input.targetPolicy,
        graph: execution.graph,
      } : {}),
    });

    const beforeHead = await git.getHead(worktreePath);
    let codexResult: CodexCommandRunResult;
    await writeDurablePrompt({
      targetRoot,
      config,
      issueNumber: options.issueNumber,
      sessionId,
      contextArtifactPath: execution.contextArtifactPath,
    });
    codexResult = await codexAdapter.run(execution.input);
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
    const childRecoveryState = await store.load();
    const childRecoveryDecisions = await Promise.all(childNodes.map(async (child) => {
      const completed = await classifyPlanAutoCompletedChildRecovery({
        targetRoot,
        config,
        parentIssueNumber: options.issueNumber,
        parentBranchName: branchName,
        child,
        state: childRecoveryState,
        git,
      });
      return completed.kind === 'execute-child'
        ? classifyPlanAutoBlockedChildRecovery({
          targetRoot,
          config,
          parentIssueNumber: options.issueNumber,
          child,
          state: childRecoveryState,
          git,
        })
        : completed;
    }));
    const recoveredStableIds: string[] = [];
    const resumableBlockedStableIds: string[] = [];
    const childRecoveryByStableId = new Map<string, Extract<PlanAutoChildRecoveryDecision, { kind: 'resume-child-rework' }>>();
    for (const decision of childRecoveryDecisions) {
      if (decision.kind === 'hard-block') {
        return finishPlanBlocked(issueAdapter, config, events, buildBase(), [decision.reason], childIssues, decision.marker);
      }
      if (decision.kind === 'recovered-completed-child') {
        recoveredStableIds.push(decision.child.metadata.stableId);
        executionResults.push({
          child: decision.child,
          branchName: decision.branchName,
          worktreePath: decision.worktreePath,
          promptPath: decision.promptPath,
          reportPath: decision.reportPath,
          logPath: decision.logPath,
          changedFiles: decision.changedFiles,
          validation: decision.validation,
          artifacts: [],
          commits: [],
          skippedChecks: decision.skippedChecks,
          residualRisks: decision.residualRisks,
          durableRunSummary: decision.durableRunSummary,
          recovered: true,
        });
      } else if (decision.kind === 'resume-child-rework') {
        resumableBlockedStableIds.push(decision.child.metadata.stableId);
        childRecoveryByStableId.set(decision.child.metadata.stableId, decision);
      }
    }
    const batches = collectExecutableChildBatches(childNodes, config, recoveredStableIds, resumableBlockedStableIds);
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
        now,
        events,
        recovery: childRecoveryByStableId.get(child.metadata.stableId),
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

    const finalValidation = await runConfiguredChecks(config, worktreePath, shellExecutor, [], { phase: 'parent-integration' });
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
    const handoff = await finishReviewReadyTerminalOutcome({
      issueNumber: options.issueNumber,
      config,
      branchName,
      baseBranch: resolvedBase.prBaseBranch,
      worktreePath,
      git,
      pullRequestAdapter,
      issueAdapter,
      pullRequest: {
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
      },
      findExistingPullRequest: false,
      reportComment: (verifiedPullRequest) => buildIssueTreeReviewReport({
        parentIssueNumber: options.issueNumber,
        pullRequest: verifiedPullRequest,
        batches: batches.batches,
        childResults: executionResults,
        finalValidation,
        sizeRisk: report.sizeRisk,
        parentReviewHandoff: report.parentReviewHandoff,
        riskRoutingWarnings,
      }),
      onPullRequestReady: (verifiedPullRequest) => {
        pullRequest = verifiedPullRequest;
      },
      beforeIssueMutation: () => markCompletedChildrenReviewReady(issueAdapter, config, store, options.issueNumber, executionResults),
      afterComment: () => store.removeRun(options.issueNumber),
    });
    await safeAppendEvent(events, {
      issueNumber: options.issueNumber,
      mode: 'plan-parent',
      sessionId,
      phase: 'plan-parent',
      status: 'completed',
      summary: 'Issue-tree execution completed draft PR handoff.',
      artifacts: [
        ...sessionArtifacts(promptPath, reportPath, logPath, parentSnapshotPath),
        { kind: 'pr', url: handoff.pullRequest.url, description: 'Draft pull request' },
      ],
    });

    return {
      ...buildBase(),
      status: 'review-ready',
      pullRequest: handoff.pullRequest,
      reportComment: handoff.reportComment,
      riskRoutingWarnings,
    };
  } catch (error) {
    await retainedOwner?.close('runner-shutdown');
    const message = error instanceof Error ? error.message : 'plan-auto planning failed';
    if (pullRequest) {
      throw new Error(`Issue-tree execution failed after draft PR creation (${pullRequest.url}); not marking parent blocked: ${message}`);
    }
    if (executionResults.length > 0) {
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
  now: Date;
  events: RunnerLifecycleEventStore;
  recovery?: Extract<PlanAutoChildRecoveryDecision, { kind: 'resume-child-rework' }>;
}): Promise<ChildExecutionResult> {
  const childIssueNumber = input.child.issue.number;
  const branchName = `codex/tree-${input.parentIssue.number}-issue-${childIssueNumber}`;
  const worktreePath = join(input.targetRoot, input.config.runner.workspaceRoot, `tree-${input.parentIssue.number}-issue-${childIssueNumber}`);
  let sessionId = '';
  let promptPath = '';
  let reportPath = '';
  let logPath = '';
  let snapshotPath = '';

  if (input.recovery) {
    await input.git.ensureIssueWorktree({
      targetRoot: input.targetRoot,
      workspacePath: worktreePath,
      branchName,
      baseBranch: input.parentBranchName,
      allowResume: true,
    });
    await input.issueAdapter.removeLabels(childIssueNumber, [input.config.github.labels.blocked.name]);
    await input.issueAdapter.addLabels(childIssueNumber, [input.config.github.labels.running.name]);
  } else {
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
  }

  const attemptLoop = await runAgentAttemptLoop({
    targetRoot: input.targetRoot,
    config: input.config,
    issue: input.child.issue,
    issueNumber: childIssueNumber,
    parentIssueNumber: input.parentIssue.number,
    mode: 'tree-child',
    phase: 'tree-child',
    branchName,
    worktreePath,
    baseBranch: input.parentBranchName,
    createdAt: input.now,
    firstAttempt: input.recovery ? input.recovery.rework.attempt : 0,
    initialRework: input.recovery?.rework,
    runtimeContext: {
      parentIssue: input.parentIssue,
      childMetadata: input.child.metadata,
      dependencyIssues: input.dependencyIssues,
    },
    buildSessionId: ({ attempt, attemptNow }) =>
      `tree-${input.parentIssue.number}-issue-${childIssueNumber}-${formatSessionTimestamp(attemptNow)}${attempt === 0 ? '' : `-attempt-${attempt}`}`,
    buildSnapshotDecision: ({ rework }) => rework
      ? `tree-child rework attempt #${rework.attempt} under parent #${input.parentIssue.number}`
      : `child issue execution under parent #${input.parentIssue.number}`,
    startedSummary: ({ rework }) => rework ? `Starting tree-child rework attempt #${rework.attempt}.` : 'Starting tree-child Codex session.',
    reworkScheduledSummary: ({ nextAttempt }) => `Runner scheduled tree-child rework attempt #${nextAttempt}.`,
    missingPublishabilityMessage: 'Runner internal error: missing child publishability result',
    codexAdapter: input.codexAdapter,
    git: input.git,
    shellExecutor: input.shellExecutor,
    commitMessage: `Codex: implement issue #${childIssueNumber} for parent #${input.parentIssue.number}`,
    events: input.events,
    acceptanceProof: {
      targetRoot: input.targetRoot,
      codexAdapter: input.codexAdapter,
    },
    onAcceptanceProofAttemptEvent: ({ sessionId: attemptSessionId, event }) => appendAcceptanceProofEvent({
      events: input.events,
      issueNumber: childIssueNumber,
      parentIssueNumber: input.parentIssue.number,
      sessionId: attemptSessionId,
      event,
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
    const promotion = publishability.report.promotion;
    const evidence = buildPromotionAsBlockedHandoffEvidence({
      publishability,
      fallbackReason: 'Child requested promotion instead of completing issue-tree work.',
      nextAction: 'Parent issue-tree execution is blocked until this child is resolved.',
    });
    const durableRunSummary = await writeDurableRunSummary({
      targetRoot: input.targetRoot,
      config: input.config,
      issueNumber: childIssueNumber,
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
      acceptanceProof: evidence.acceptanceProof,
      reworkAttempts,
    });
    const message = [
      'Child requested promotion instead of completing issue-tree work.',
      promotion ? `Reason: ${promotion.reason}` : undefined,
      promotion ? `Evidence: ${promotion.evidence.join(', ')}` : undefined,
    ].filter(Boolean).join(' ');
    throw new ChildExecutionBlockedError(message, durableRunSummary, undefined, evidence.acceptanceProof, reworkAttempts);
  }

  if (publishability.status === 'blocked') {
    const evidence = buildBlockedHandoffEvidence({
      publishability,
      nextAction: 'Parent issue-tree execution is blocked until this child is resolved.',
    });
    const durableRunSummary = await writeDurableRunSummary({
      targetRoot: input.targetRoot,
      config: input.config,
      issueNumber: childIssueNumber,
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
      acceptanceProof: evidence.acceptanceProof,
      reworkAttempts,
    });
    throw new ChildExecutionBlockedError(evidence.blockers.join('; '), durableRunSummary, undefined, evidence.acceptanceProof, reworkAttempts);
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
    const evidence = buildBlockedHandoffEvidence({
      publishability,
      freshContextReview,
      nextAction: 'Parent issue-tree execution is blocked until this child review finding is resolved.',
    });
    const durableRunSummary = await writeDurableRunSummary({
      targetRoot: input.targetRoot,
      config: input.config,
      issueNumber: childIssueNumber,
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
    });
    throw new ChildExecutionBlockedError(
      evidence.blockers.join('; '),
      durableRunSummary,
      freshContextReview,
      evidence.acceptanceProof,
      reworkAttempts,
    );
  }

  const evidence = buildReviewReadyHandoffEvidence({
    publishability,
    freshContextReview,
    nextAction: 'Parent issue-tree integration should merge this child branch.',
  });
  const durableRunSummary = await writeDurableRunSummary({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: childIssueNumber,
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
    residualRisks: evidence.residualRisks,
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
    reworkAttempts?: ReworkAttemptEvidence[];
  }>,
  successfulUnmerged: ChildExecutionResult[],
): Promise<void> {
  for (const failure of failures) {
    if (!failure.child) {
      continue;
    }
    await finishBlockedTerminalOutcome({
      issueNumber: failure.child.issue.number,
      config,
      issueAdapter,
      reportComment: buildChildBlockedReport({
        parentIssueNumber,
        childIssueNumber: failure.child.issue.number,
        reasons: [failure.message],
        details: ['Worktree preserved for maintainer inspection.'],
        freshContextReview: failure.freshContextReview,
        durableRunSummary: failure.durableRunSummary,
        reworkAttempts: failure.reworkAttempts,
        acceptanceProof: failure.acceptanceProof,
      }),
    });
  }
  for (const result of successfulUnmerged) {
    await finishBlockedTerminalOutcome({
      issueNumber: result.child.issue.number,
      config,
      issueAdapter,
      reportComment: buildChildBlockedReport({
        parentIssueNumber,
        childIssueNumber: result.child.issue.number,
        reasons: ['A sibling child failed before the batch merge; this child branch was not merged.'],
        branchName: result.branchName,
        worktreePath: result.worktreePath,
        durableRunSummary: result.durableRunSummary,
        acceptanceProof: result.acceptanceProof,
      }),
    });
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
    await finishBlockedTerminalOutcome({
      issueNumber: result.child.issue.number,
      config,
      issueAdapter,
      reportComment: buildChildBlockedReport({
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
    });
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
    if (childResult.recovered) {
      await store.removeRun(childResult.child.issue.number);
      continue;
    }
    await finishReviewReadyCommentTerminalOutcome({
      issueNumber: childResult.child.issue.number,
      config,
      issueAdapter,
      reportComment: buildChildReviewReport({ parentIssueNumber, result: childResult }),
      afterTerminalMutation: () => store.removeRun(childResult.child.issue.number),
    });
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
    if (result.recovered) {
      continue;
    }
    await finishBlockedTerminalOutcome({
      issueNumber: result.child.issue.number,
      config,
      issueAdapter,
      reportComment: buildChildBlockedReport({
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
      afterTerminalMutation: () => store.removeRun(result.child.issue.number),
    });
  }
}

async function finishPlanBlocked(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  events: RunnerLifecycleEventStore,
  result: PlanBlockedContext,
  reasons: string[],
  mutatedChildren: GitHubIssue[],
  commentMarker?: string,
): Promise<PlanAutoCommandResult> {
  const reportBody = buildParentBlockedReport({
    parentIssueNumber: result.parentIssueNumber,
    reasons,
    logPath: result.logPath,
    mutatedChildren,
  });
  const reportComment = commentMarker ? `<!-- codex-orchestrator:${commentMarker} -->\n${reportBody}` : reportBody;
  await finishBlockedTerminalOutcome({
    issueNumber: result.parentIssueNumber,
    config,
    issueAdapter,
    reportComment,
    skipCommentIfIncludes: commentMarker,
  });
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
