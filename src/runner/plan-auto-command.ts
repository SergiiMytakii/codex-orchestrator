import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GitMergeConflictError, GitWorktreeManager, renderBranchTemplate } from '../git/worktree.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { defaultShellCommandExecutor, type ShellCommandExecutor } from '../process/command.js';
import { bulletList, formatSessionTimestamp, readRunnerConfig } from './command-utils.js';
import { claimIssue, discoverIssueWork } from './issue-state-machine.js';
import {
  collectExecutableChildBatches,
  ensureAutonomousChildBody,
  isAutonomousChildOfParent,
  parseAutonomousChildMetadata,
  topologicalPlanNodes,
  type AutonomousChildNode,
  type PlanChildNode,
} from './issue-tree.js';
import { RunnerStateStore } from './local-state.js';
import {
  buildIssueTreeChildPrompt,
  buildPlanAutoPrompt,
  readScopedCompletionReport,
  readPlanAutoCompletionReport,
  sessionPromptPath,
  sessionReportPath,
  type PlanAutoCompletionReport,
  type ScopedCompletionReport,
  writeDurablePrompt,
} from './prompt.js';
import { evaluateReviewGates } from './review-gates.js';
import {
  validateChangedPaths,
  validateCompletionReportSafety,
  validateNoAgentOwnedGitPublication,
} from './safety.js';
import { runRunnerVisualProof } from './visual-proof-runner.js';

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
  childIssues: GitHubIssue[];
}

interface ValidationLine {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
}

interface ChildExecutionResult {
  child: AutonomousChildNode;
  branchName: string;
  worktreePath: string;
  promptPath: string;
  reportPath: string;
  changedFiles: string[];
  validation: ValidationLine[];
  artifacts: ScopedCompletionReport['artifacts'];
  skippedChecks: string[];
  residualRisks: string[];
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
  const childIssues: GitHubIssue[] = [];
  let pullRequest: GitHubPullRequest | undefined;

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
    const isolatedHomePath = join(targetRoot, config.runner.stateDir, 'codex-home', sessionId);
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
    const store = new RunnerStateStore(targetRoot, config);
    await store.upsertRun({
      issueNumber: options.issueNumber,
      mode: 'plan-parent',
      workspacePath: worktreePath,
      sessionId,
      branchName,
      promptPath,
      reportPath,
      retryCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const beforeHead = await git.getHead(worktreePath);
    const codexResult = await codexAdapter.run({
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
    });
    const afterHead = await git.getHead(worktreePath);
    const base = baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, childIssues);

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
      const persisted = await persistChildNode(issueAdapter, config, options.issueNumber, node);
      childIssues.push(persisted);
    }

    const childNodes = await readExecutableChildren(issueAdapter, config, options.issueNumber, childIssues);
    const batches = collectExecutableChildBatches(childNodes, config);
    if (!batches.ok) {
      return finishPlanBlocked(issueAdapter, config, base, batches.errors, childIssues);
    }

    const executionResults: ChildExecutionResult[] = [];
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
      const failures: Array<{ child?: AutonomousChildNode; message: string }> = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          continue;
        }
        failures.push({
          child: batch[index],
          message: result.reason instanceof Error ? result.reason.message : 'child execution failed',
        });
      }
      if (failures.length > 0) {
        const successful = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
        await blockFailedBatch(issueAdapter, config, options.issueNumber, failures, successful);
        return finishPlanBlocked(
          issueAdapter,
          config,
          baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, childIssues),
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
            return finishPlanBlocked(
              issueAdapter,
              config,
              baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, childIssues),
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
        await issueAdapter.removeLabels(childResult.child.issue.number, [config.github.labels.running.name]);
        await issueAdapter.addLabels(childResult.child.issue.number, [config.github.labels.review.name]);
        await issueAdapter.postComment(
          childResult.child.issue.number,
          buildChildReviewReport(options.issueNumber, childResult),
        );
        await store.removeRun(childResult.child.issue.number);
        executionResults.push(childResult);
      }
    }

    const finalValidation = await runConfiguredChecks(config, worktreePath, shellExecutor, []);
    await git.pushBranch({ worktreePath, branchName });
    pullRequest = await pullRequestAdapter.createDraftPullRequest({
      title: renderParentTemplate(config.pullRequests.issueTreeTitle, options.issueNumber),
      body: buildIssueTreePullRequestBody(options.issueNumber, childIssues, executionResults, finalValidation),
      headBranch: branchName,
      baseBranch: config.branches.base,
    });

    const reportComment = buildIssueTreeReviewReport(
      options.issueNumber,
      pullRequest,
      batches.batches,
      executionResults,
      finalValidation,
    );
    await issueAdapter.removeLabels(options.issueNumber, [config.github.labels.running.name]);
    await issueAdapter.addLabels(options.issueNumber, [config.github.labels.review.name]);
    await issueAdapter.postComment(options.issueNumber, reportComment);
    await store.removeRun(options.issueNumber);

    return {
      ...baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, childIssues),
      status: 'review-ready',
      pullRequest,
      reportComment,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'plan-auto planning failed';
    if (pullRequest) {
      throw new Error(`Issue-tree execution failed after draft PR creation (${pullRequest.url}); not marking parent blocked: ${message}`);
    }
    return finishPlanBlocked(
      issueAdapter,
      config,
      baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, childIssues),
      [message],
      childIssues,
    );
  }
}

async function persistChildNode(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  parentIssueNumber: number,
  node: PlanChildNode,
): Promise<GitHubIssue> {
  const body = buildChildBody(node, parentIssueNumber);
  const childLabel = config.github.labels.child.name;
  const autoLabel = config.github.labels.auto.name;

  let issue: GitHubIssue;
  if (node.issueNumber !== undefined) {
    const existing = await issueAdapter.getIssue(node.issueNumber);
    if (!existing) {
      throw new Error(`Existing issue #${node.issueNumber} was not found`);
    }
    if (!isAutonomousChildOfParent(existing, config, parentIssueNumber)) {
      throw new Error(
        `Existing issue #${node.issueNumber} is not an autonomous child of #${parentIssueNumber}; refusing to update arbitrary issue.`,
      );
    }
    issue = await issueAdapter.updateIssue(node.issueNumber, {
      title: node.title,
      body,
      addLabels: [childLabel],
      removeLabels: node.afkHitl === 'hitl' ? [autoLabel] : undefined,
    });
  } else {
    issue = await issueAdapter.createIssue({
      title: node.title,
      body,
      labels: [childLabel],
    });
  }

  if (!isAutonomousChildOfParent(issue, config, parentIssueNumber)) {
    throw new Error(`Child issue #${issue.number} was not persisted with the autonomous marker for #${parentIssueNumber}.`);
  }
  if (node.afkHitl === 'afk') {
    issue = await issueAdapter.updateIssue(issue.number, { addLabels: [autoLabel] });
    if (!isAutonomousChildOfParent(issue, config, parentIssueNumber)) {
      throw new Error(
        `Child issue #${issue.number} lost the autonomous marker for #${parentIssueNumber} while enabling agent:auto.`,
      );
    }
  }
  return issue;
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

async function readExecutableChildren(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  parentIssueNumber: number,
  childIssues: GitHubIssue[],
): Promise<AutonomousChildNode[]> {
  const nodes: AutonomousChildNode[] = [];
  const errors: string[] = [];
  for (const child of childIssues) {
    const current = await issueAdapter.getIssue(child.number);
    if (!current) {
      errors.push(`Child issue #${child.number} was not found during execution readback`);
      continue;
    }
    const parsed = parseAutonomousChildMetadata(current, config, parentIssueNumber);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      continue;
    }
    nodes.push(parsed.node);
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  return nodes;
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
  const isolatedHomePath = join(input.targetRoot, input.config.runner.stateDir, 'codex-home', sessionId);
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
    retryCount: 0,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
  });

  const beforeHead = await input.git.getHead(worktreePath);
  const codexResult = await input.codexAdapter.run({
    targetRoot: input.targetRoot,
    config: input.config,
    worktreePath,
    promptPath,
    promptText,
    reportPath,
    isolatedHomePath,
    issueNumber: childIssueNumber,
    sessionId,
    branchName,
  });
  const afterHead = await input.git.getHead(worktreePath);
  const publicationViolations = validateNoAgentOwnedGitPublication(beforeHead, afterHead);
  if (publicationViolations.length > 0) {
    throw new Error(publicationViolations.map((violation) => violation.message).join('; '));
  }
  if (codexResult.exitCode !== 0) {
    throw new Error(`Codex exited with code ${codexResult.exitCode}: ${codexResult.stderr || codexResult.stdout}`);
  }

  const report = await readRequiredScopedReport(reportPath);
  if (report.status === 'needs-promotion') {
    const promotion = report.promotion;
    throw new Error(
      [
        'Child requested promotion instead of completing issue-tree work.',
        promotion ? `Reason: ${promotion.reason}` : undefined,
        promotion ? `Evidence: ${promotion.evidence.join(', ')}` : undefined,
      ].filter(Boolean).join(' '),
    );
  }
  let changedFiles = await input.git.listChangedFiles(worktreePath);
  if (changedFiles.length === 0) {
    throw new Error('Codex completed without file changes');
  }
  const violations = [
    ...validateChangedPaths(changedFiles, input.config),
    ...validateCompletionReportSafety(report),
  ];
  if (violations.length > 0) {
    throw new Error(violations.map((violation) => violation.message).join('; '));
  }

  let validation = await runConfiguredChecks(input.config, worktreePath, input.shellExecutor, report.validation);
  const runnerVisualProof = await runRunnerVisualProof({
    config: input.config,
    issue: input.child.issue,
    issueNumber: childIssueNumber,
    worktreePath,
    changedFiles,
    report,
    shellExecutor: input.shellExecutor,
  });
  validation = [...validation, ...runnerVisualProof.validation];
  const artifacts = mergeArtifacts(report.artifacts, runnerVisualProof.artifacts);
  if (runnerVisualProof.artifacts.length > 0) {
    changedFiles = await input.git.listChangedFiles(worktreePath);
  }
  const residualRisks = [...report.residualRisks];
  if (validation.some((line) => line.status === 'failed')) {
    residualRisks.push('One or more configured checks failed.');
  }
  const reviewGate = evaluateReviewGates({
    config: input.config,
    issue: input.child.issue,
    changedFiles,
    validation,
    skippedChecks: report.skippedChecks,
    report: { ...report, artifacts },
  });
  if (!reviewGate.ok) {
    throw new Error(reviewGate.reasons.join('; '));
  }
  await input.git.commitAll({
    worktreePath,
    message: `Codex: implement issue #${childIssueNumber} for parent #${input.parentIssue.number}`,
  });

  return {
    child: input.child,
    branchName,
    worktreePath,
    promptPath,
    reportPath,
    changedFiles,
    validation,
    artifacts,
    skippedChecks: report.skippedChecks,
    residualRisks,
  };
}

async function readRequiredScopedReport(reportPath: string): Promise<ScopedCompletionReport> {
  const reportRead = await readScopedCompletionReport(reportPath);
  if (reportRead.kind === 'missing') {
    throw new Error('Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove child safety contract.');
  }
  return reportRead.report;
}

async function runConfiguredChecks(
  config: CodexOrchestratorConfig,
  worktreePath: string,
  shellExecutor: ShellCommandExecutor,
  reportValidation: ValidationLine[],
): Promise<ValidationLine[]> {
  const lines = [...reportValidation];
  for (const [name, command] of Object.entries(config.checks)) {
    const result = await shellExecutor(command, { cwd: worktreePath });
    lines.push({
      command,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      summary: `${name}: ${result.exitCode === 0 ? 'passed' : result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    });
  }
  return lines;
}

function mergeArtifacts(
  existing: ScopedCompletionReport['artifacts'],
  additions: ScopedCompletionReport['artifacts'],
): ScopedCompletionReport['artifacts'] {
  const seen = new Set(existing.map((artifact) => artifact.url ?? artifact.path ?? artifact.description));
  const merged = [...existing];
  for (const artifact of additions) {
    const key = artifact.url ?? artifact.path ?? artifact.description;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(artifact);
  }
  return merged;
}

async function blockFailedBatch(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  parentIssueNumber: number,
  failures: Array<{ child?: AutonomousChildNode; message: string }>,
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
      [
        `codex-orchestrator blocked child #${failure.child.issue.number} for parent #${parentIssueNumber}`,
        'Reasons',
        `- ${failure.message}`,
        'Worktree preserved for maintainer inspection.',
      ].join('\n'),
    );
  }
  for (const result of successfulUnmerged) {
    await issueAdapter.removeLabels(result.child.issue.number, [config.github.labels.running.name]);
    await issueAdapter.addLabels(result.child.issue.number, [config.github.labels.blocked.name]);
    await issueAdapter.postComment(
      result.child.issue.number,
      [
        `codex-orchestrator blocked child #${result.child.issue.number} for parent #${parentIssueNumber}`,
        'Reasons',
        '- A sibling child failed before the batch merge; this child branch was not merged.',
        `- Branch preserved: ${result.branchName}`,
        `- Worktree preserved: ${result.worktreePath}`,
      ].join('\n'),
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
      [
        `codex-orchestrator blocked child #${result.child.issue.number} for parent #${parentIssueNumber}`,
        'Reasons',
        result.child.issue.number === childResult.child.issue.number
          ? `- Merge conflict from branch ${childResult.branchName}`
          : `- A sibling merge conflict stopped the batch before publication: ${childResult.branchName}`,
        `- Parent worktree: ${error.worktreePath}`,
        `- Child worktree: ${result.worktreePath}`,
        `- Child branch preserved: ${result.branchName}`,
        abortMessage ? `- Merge abort also failed: ${abortMessage}` : '- Merge abort completed.',
        'Batch Children',
        ...bulletList(batchResults.map((batchResult) => `#${batchResult.child.issue.number} ${batchResult.branchName}`)),
        'Git Output',
        ...bulletList([error.stderr || error.stdout || 'no git output']),
      ].join('\n'),
    );
  }
}

async function finishPlanBlocked(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  result: PlanBlockedContext,
  reasons: string[],
  mutatedChildren: GitHubIssue[],
): Promise<PlanAutoCommandResult> {
  const reportComment = [
    `codex-orchestrator blocked parent issue-tree execution for #${result.parentIssueNumber}`,
    'Reasons',
    ...bulletList(reasons),
    'Mutated Child Issues',
    ...bulletList(mutatedChildren.map((issue) => `#${issue.number} ${issue.title}`)),
  ].join('\n');
  await issueAdapter.removeLabels(result.parentIssueNumber, [config.github.labels.running.name]);
  await issueAdapter.addLabels(result.parentIssueNumber, [config.github.labels.blocked.name]);
  await issueAdapter.postComment(result.parentIssueNumber, reportComment);
  return { ...result, status: 'blocked', reportComment };
}

function buildChildBody(node: PlanChildNode, parentIssueNumber: number): string {
  return [
    ensureAutonomousChildBody(node.body, parentIssueNumber),
    '',
    '## codex-orchestrator metadata',
    `Stable ID: ${node.stableId}`,
    `AFK/HITL: ${node.afkHitl}`,
    `Depends on: ${node.dependsOn.length > 0 ? node.dependsOn.join(', ') : 'none'}`,
    'Ownership:',
    ...bulletList(node.ownershipScope),
    'Spec gate: wave-level',
    'Verification:',
    ...bulletList(node.verification),
  ].join('\n');
}

function dependencyIssuesFor(child: AutonomousChildNode, allChildren: AutonomousChildNode[]): GitHubIssue[] {
  const issuesByStableId = new Map(allChildren.map((node) => [node.metadata.stableId, node.issue]));
  return child.metadata.dependsOn.flatMap((stableId) => {
    const issue = issuesByStableId.get(stableId);
    return issue ? [issue] : [];
  });
}

function buildChildReviewReport(parentIssueNumber: number, result: ChildExecutionResult): string {
  return [
    `codex-orchestrator child review report for #${result.child.issue.number}`,
    `Parent issue: #${parentIssueNumber}`,
    `Integration branch: ${result.branchName}`,
    'Changes',
    ...bulletList(result.changedFiles),
    'Validation',
    ...result.validation.map((line) => `- ${line.command}: ${line.status} - ${line.summary}`),
    'Proof Artifacts',
    ...renderProofArtifacts(result.artifacts),
    'Skipped Checks',
    ...bulletList(result.skippedChecks),
    'Residual Risks',
    ...bulletList(result.residualRisks),
  ].join('\n');
}

function buildIssueTreeReviewReport(
  parentIssueNumber: number,
  pullRequest: GitHubPullRequest,
  batches: AutonomousChildNode[][],
  childResults: ChildExecutionResult[],
  finalValidation: ValidationLine[],
): string {
  return [
    `codex-orchestrator issue-tree review report for #${parentIssueNumber}`,
    'Pull Request',
    `- ${pullRequest.url}`,
    'Execution Batches',
    ...batches.map((batch, index) => `- Batch ${index + 1}: ${batch.map((child) => `#${child.issue.number}`).join(', ')}`),
    'Child Issues',
    ...childResults.map((result) => `- #${result.child.issue.number} ${result.child.issue.title}: ${result.branchName}`),
    'Validation',
    ...childResults.flatMap((result) => result.validation.map((line) => `- #${result.child.issue.number} ${line.command}: ${line.status} - ${line.summary}`)),
    ...finalValidation.map((line) => `- final ${line.command}: ${line.status} - ${line.summary}`),
    'Skipped Checks',
    ...bulletList(childResults.flatMap((result) => result.skippedChecks)),
    'Proof Artifacts',
    ...childResults.flatMap((result) => renderProofArtifacts(result.artifacts).map((line) => `- #${result.child.issue.number} ${line.replace(/^- /, '')}`)),
    'Residual Risks',
    ...bulletList(childResults.flatMap((result) => result.residualRisks)),
  ].join('\n');
}

function buildIssueTreePullRequestBody(
  parentIssueNumber: number,
  childIssues: GitHubIssue[],
  childResults: ChildExecutionResult[],
  finalValidation: ValidationLine[],
): string {
  return [
    `Parent issue: #${parentIssueNumber}`,
    '',
    'Child issues:',
    ...childIssues.map((issue) => `- #${issue.number} ${issue.title}`),
    '',
    'Changed files:',
    ...childResults.flatMap((result) => [
      `- #${result.child.issue.number}:`,
      ...result.changedFiles.map((file) => `  - ${file}`),
    ]),
    '',
    'Validation:',
    ...childResults.flatMap((result) => result.validation.map((line) => `- #${result.child.issue.number} ${line.command}: ${line.status} - ${line.summary}`)),
    ...finalValidation.map((line) => `- final ${line.command}: ${line.status} - ${line.summary}`),
    '',
    'Skipped checks:',
    ...bulletList(childResults.flatMap((result) => result.skippedChecks)),
    '',
    'Proof artifacts:',
    ...childResults.flatMap((result) => renderProofArtifacts(result.artifacts).map((line) => `- #${result.child.issue.number} ${line.replace(/^- /, '')}`)),
    '',
    'Residual risks:',
    ...bulletList(childResults.flatMap((result) => result.residualRisks)),
    '',
    'Merge summary:',
    ...childResults.map((result) => `- ${result.branchName} merged for #${result.child.issue.number}`),
    '',
    'Auto-merge is disabled.',
  ].join('\n');
}

function renderParentTemplate(template: string, parentIssueNumber: number): string {
  return template.replaceAll('${parentIssueNumber}', String(parentIssueNumber));
}

function renderProofArtifacts(artifacts: ScopedCompletionReport['artifacts']): string[] {
  if (artifacts.length === 0) {
    return ['- none'];
  }
  return artifacts.map((artifact) => {
    const target = artifact.url ?? artifact.path ?? 'missing-target';
    const label = `${artifact.type}: ${artifact.description}`;
    return artifact.type === 'screenshot' ? `- ![${label.replace(/[\[\]]/g, '')}](${target})` : `- ${label}: ${target}`;
  });
}

function baseResult(
  parentIssueNumber: number,
  branchName: string,
  worktreePath: string,
  promptPath: string,
  reportPath: string,
  childIssues: GitHubIssue[],
): PlanBlockedContext {
  return { parentIssueNumber, branchName, worktreePath, promptPath, reportPath, childIssues };
}
