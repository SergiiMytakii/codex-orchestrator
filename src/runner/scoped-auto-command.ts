import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { GitWorktreeManager, renderBranchTemplate } from '../git/worktree.js';
import { defaultShellCommandExecutor, type ShellCommandExecutor } from '../process/command.js';
import { bulletList, formatSessionTimestamp, readRunnerConfig } from './command-utils.js';
import { claimIssue, discoverIssueWork } from './issue-state-machine.js';
import { RunnerStateStore } from './local-state.js';
import {
  buildScopedImplementationPrompt,
  readScopedCompletionReport,
  sessionPromptPath,
  sessionReportPath,
  type ScopedCompletionReport,
  writeDurablePrompt,
} from './prompt.js';
import {
  validateChangedPaths,
  validateCompletionReportSafety,
  validateNoAgentOwnedGitPublication,
} from './safety.js';

export interface ScopedAutoCommandOptions {
  targetRoot: string;
  issueNumber: number;
  issueAdapter?: GitHubIssueAdapter;
  pullRequestAdapter?: GitHubPullRequestAdapter;
  git?: GitWorktreeManager;
  codexAdapter?: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  shellExecutor?: ShellCommandExecutor;
  now?: Date;
}

export interface ScopedAutoCommandResult {
  issueNumber: number;
  branchName: string;
  worktreePath: string;
  promptPath: string;
  reportPath: string;
  pullRequest?: GitHubPullRequest;
  status: 'review-ready' | 'blocked' | 'promotion-requested';
  reportComment: string;
}

interface ValidationLine {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
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
  let promptPath = '';
  let reportPath = '';
  let pullRequest: GitHubPullRequest | undefined;

  await claimIssue(issueAdapter, config, options.issueNumber, 'scoped-issue', now);

  try {
    await git.createIssueWorktree({
      targetRoot,
      workspacePath: worktreePath,
      branchName,
      baseBranch: config.branches.base,
    });
    const sessionId = `issue-${options.issueNumber}-${formatSessionTimestamp(now)}`;
    promptPath = sessionPromptPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
    reportPath = sessionReportPath({ targetRoot, config, issueNumber: options.issueNumber, sessionId });
    const isolatedHomePath = join(targetRoot, config.runner.stateDir, 'codex-home', sessionId);
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
      mode: 'scoped-issue',
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
    const publicationViolations = validateNoAgentOwnedGitPublication(beforeHead, afterHead);
    if (publicationViolations.length > 0) {
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath), issueAdapter, config, publicationViolations.map((violation) => violation.message), [], [], []);
    }
    if (codexResult.exitCode !== 0) {
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath), issueAdapter, config, [`Codex exited with code ${codexResult.exitCode}: ${codexResult.stderr || codexResult.stdout}`], [], [], []);
    }

    let report: ScopedCompletionReport;
    try {
      const reportResult = await readScopedCompletionReport(reportPath);
      if (reportResult.kind === 'missing') {
        return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath), issueAdapter, config, ['Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove safety contract.'], [], [], []);
      }
      report = reportResult.report;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid scoped completion report';
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath), issueAdapter, config, [message], [], [], []);
    }

    if (report.status === 'needs-promotion') {
      return finishPromotionRequested(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath), issueAdapter, config, report);
    }

    const changedFiles = await git.listChangedFiles(worktreePath);
    if (changedFiles.length === 0) {
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath), issueAdapter, config, ['Codex completed without file changes'], [], report.skippedChecks, report.residualRisks);
    }

    const violations = [
      ...validateChangedPaths(changedFiles, config),
      ...validateCompletionReportSafety(report),
    ];
    if (violations.length > 0) {
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath), issueAdapter, config, violations.map((violation) => violation.message), changedFiles, report.skippedChecks, report.residualRisks);
    }

    const validation = await runConfiguredChecks(config, worktreePath, shellExecutor, report.validation);
    const residualRisks = [...report.residualRisks];
    if (validation.some((line) => line.status === 'failed')) {
      residualRisks.push('One or more configured checks failed.');
    }
    await git.commitAll({ worktreePath, message: `Codex: implement issue #${options.issueNumber}` });
    await git.pushBranch({ worktreePath, branchName });
    pullRequest = await pullRequestAdapter.createDraftPullRequest({
      title: renderTemplate(config.pullRequests.scopedIssueTitle, options.issueNumber),
      body: buildPullRequestBody(options.issueNumber, changedFiles, validation, report.skippedChecks, residualRisks),
      headBranch: branchName,
      baseBranch: config.branches.base,
    });
    const reportComment = buildReviewReport(options.issueNumber, pullRequest, changedFiles, validation, report.skippedChecks, residualRisks);
    await issueAdapter.removeLabels(options.issueNumber, [config.github.labels.running.name]);
    await issueAdapter.addLabels(options.issueNumber, [config.github.labels.review.name]);
    await issueAdapter.postComment(options.issueNumber, reportComment);
    await store.removeRun(options.issueNumber);

    return {
      ...baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath),
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
      baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath),
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

async function finishBlocked(
  result: Omit<ScopedAutoCommandResult, 'status' | 'reportComment'>,
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  reasons: string[],
  changedFiles: string[],
  skippedChecks: string[],
  residualRisks: string[],
): Promise<ScopedAutoCommandResult> {
  const reportComment = [
    `codex-orchestrator blocked scoped execution for #${result.issueNumber}`,
    'Reasons',
    ...bulletList(reasons),
    'Changed Files',
    ...bulletList(changedFiles),
    'Skipped Checks',
    ...bulletList(skippedChecks),
    'Residual Risks',
    ...bulletList(residualRisks),
  ].join('\n');
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
  const promotion = report.promotion;
  if (!promotion) {
    throw new Error('promotion is required for needs-promotion');
  }
  const reportComment = [
    `codex-orchestrator promotion requested for #${result.issueNumber}`,
    `Reason: ${promotion.reason}`,
    'Criteria',
    ...bulletList(promotion.criteria),
    'Evidence',
    ...bulletList(promotion.evidence),
    'Review this evidence and replace agent:auto with agent:plan-auto when parent issue-tree orchestration is desired.',
  ].join('\n');
  await issueAdapter.removeLabels(result.issueNumber, [config.github.labels.running.name]);
  await issueAdapter.addLabels(result.issueNumber, [config.github.labels.blocked.name]);
  await issueAdapter.postComment(result.issueNumber, reportComment);
  return { ...result, status: 'promotion-requested', reportComment };
}

function buildReviewReport(
  issueNumber: number,
  pullRequest: GitHubPullRequest,
  changedFiles: string[],
  validation: ValidationLine[],
  skippedChecks: string[],
  residualRisks: string[],
): string {
  return [
    `codex-orchestrator review report for #${issueNumber}`,
    'Pull Request',
    `- ${pullRequest.url}`,
    'Changes',
    ...bulletList(changedFiles),
    'Validation',
    ...validation.map((line) => `- ${line.command}: ${line.status} - ${line.summary}`),
    'Skipped Checks',
    ...bulletList(skippedChecks),
    'Residual Risks',
    ...bulletList(residualRisks),
  ].join('\n');
}

function buildPullRequestBody(
  issueNumber: number,
  changedFiles: string[],
  validation: ValidationLine[],
  skippedChecks: string[],
  residualRisks: string[],
): string {
  return [
    `Closes #${issueNumber}`,
    '',
    'Changed files:',
    ...bulletList(changedFiles),
    '',
    'Validation:',
    ...validation.map((line) => `- ${line.command}: ${line.status} - ${line.summary}`),
    '',
    'Skipped checks:',
    ...bulletList(skippedChecks),
    '',
    'Residual risks:',
    ...bulletList(residualRisks),
  ].join('\n');
}

function baseResult(
  issueNumber: number,
  branchName: string,
  worktreePath: string,
  promptPath: string,
  reportPath: string,
): Omit<ScopedAutoCommandResult, 'status' | 'reportComment'> {
  return { issueNumber, branchName, worktreePath, promptPath, reportPath };
}

function renderTemplate(template: string, issueNumber: number): string {
  return template.replaceAll('${issueNumber}', String(issueNumber));
}
