import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { GitWorktreeManager, renderBranchTemplate, type SessionCommitInfo } from '../git/worktree.js';
import { defaultShellCommandExecutor, type ShellCommandExecutor } from '../process/command.js';
import { bulletList, formatSessionTimestamp, mergeArtifacts, readRunnerConfig, renderCommitEvidence } from './command-utils.js';
import { claimIssue, discoverIssueWork } from './issue-state-machine.js';
import { readScopedCompletionReport, type ScopedCompletionReport } from './completion-report.js';
import { runLocalExecutionSession, type LocalExecutionPhaseExecutor } from './local-execution-session.js';
import { RunnerStateStore } from './local-state.js';
import {
  buildScopedImplementationPrompt,
  sessionPromptPath,
  sessionReportPath,
  writeDurablePrompt,
} from './prompt.js';
import { evaluateReviewGates } from './review-gates.js';
import { sessionLogPath } from './run-log.js';
import {
  validateChangedPaths,
  validateCompletionReportSafety,
  validateNoAgentOwnedGitPublication,
} from './safety.js';
import { cleanupSessionCodexHome, sessionCodexHomePath } from './session-home.js';
import { runRunnerVisualProof } from './visual-proof-runner.js';

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
  let logPath = '';
  let pullRequest: GitHubPullRequest | undefined;

  await claimIssue(issueAdapter, config, options.issueNumber, 'scoped-issue', now);

  try {
    await git.ensureIssueWorktree({
      targetRoot,
      workspacePath: worktreePath,
      branchName,
      baseBranch: config.branches.base,
      allowResume: true,
    });
    const sessionId = `issue-${options.issueNumber}-${formatSessionTimestamp(now)}`;
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
    const publicationViolations = config.runner.allowAgentLocalCommits
      ? []
      : validateNoAgentOwnedGitPublication(beforeHead, afterHead);
    if (publicationViolations.length > 0) {
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath), issueAdapter, config, publicationViolations.map((violation) => violation.message), [], [], []);
    }
    if (codexResult.exitCode !== 0) {
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath), issueAdapter, config, [`Codex exited with code ${codexResult.exitCode}: ${codexResult.stderr || codexResult.stdout}`], [], [], []);
    }

    let report: ScopedCompletionReport;
    try {
      const reportResult = await readScopedCompletionReport(reportPath);
      if (reportResult.kind === 'missing') {
        return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath), issueAdapter, config, ['Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove safety contract.'], [], [], []);
      }
      report = reportResult.report;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid scoped completion report';
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath), issueAdapter, config, [message], [], [], []);
    }

    if (report.status === 'needs-promotion') {
      return finishPromotionRequested(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath), issueAdapter, config, report);
    }

    const localSession = await runLocalExecutionSession({
      worktreePath,
      phases: options.localPhases ?? [],
      executePhase: options.localPhaseExecutor ?? defaultPassingLocalPhaseExecutor,
    });
    if (!localSession.publishReady) {
      const blockedChangeSet = await git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead });
      return finishBlocked(
        baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
        issueAdapter,
        config,
        localSessionBlockReasons(localSession.phaseResults),
        blockedChangeSet.changedPaths,
        report.skippedChecks,
        [...report.residualRisks, ...localSession.phaseResults.flatMap((phase) => phase.residualRisks)],
      );
    }
    report = {
      ...report,
      validation: [...report.validation, ...localSession.phaseResults.flatMap((phase) => phase.validation)],
      artifacts: mergeArtifacts(report.artifacts, localSession.phaseResults.flatMap((phase) => phase.artifacts)),
      residualRisks: [...report.residualRisks, ...localSession.phaseResults.flatMap((phase) => phase.residualRisks)],
    };

    let changeSet = await git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead });
    let changedFiles = changeSet.changedPaths;
    if (changedFiles.length === 0) {
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath), issueAdapter, config, ['Codex completed without file changes'], [], report.skippedChecks, report.residualRisks);
    }

    const violations = [
      ...validateChangedPaths(changedFiles, config),
      ...validateCompletionReportSafety(report),
    ];
    if (violations.length > 0) {
      return finishBlocked(baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath), issueAdapter, config, violations.map((violation) => violation.message), changedFiles, report.skippedChecks, report.residualRisks);
    }

    let validation = await runConfiguredChecks(config, worktreePath, shellExecutor, report.validation);
    const runnerVisualProof = await runRunnerVisualProof({
      config,
      issue,
      issueNumber: options.issueNumber,
      worktreePath,
      changedFiles,
      report,
      shellExecutor,
    });
    validation = [...validation, ...runnerVisualProof.validation];
    report = {
      ...report,
      artifacts: mergeArtifacts(report.artifacts, runnerVisualProof.artifacts),
    };
    if (runnerVisualProof.artifacts.length > 0) {
      changeSet = await git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead });
      changedFiles = changeSet.changedPaths;
    }
    const residualRisks = [...report.residualRisks];
    if (validation.some((line) => line.status === 'failed')) {
      residualRisks.push('One or more configured checks failed.');
    }
    const reviewGate = evaluateReviewGates({
      config,
      issue,
      changedFiles,
      validation,
      skippedChecks: report.skippedChecks,
      report,
      worktreePath,
    });
    if (!reviewGate.ok) {
      return finishBlocked(
        baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, logPath),
        issueAdapter,
        config,
        reviewGate.reasons,
        changedFiles,
        report.skippedChecks,
        residualRisks,
      );
    }
    if (!(await git.isWorktreeClean(worktreePath))) {
      await git.commitAll({ worktreePath, message: `Codex: implement issue #${options.issueNumber}` });
      changeSet = await git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead });
    }
    await git.pushBranch({ worktreePath, branchName });
    pullRequest = await pullRequestAdapter.createDraftPullRequest({
      title: renderTemplate(config.pullRequests.scopedIssueTitle, options.issueNumber),
      body: buildPullRequestBody(config, branchName, options.issueNumber, changedFiles, validation, report.artifacts, report.skippedChecks, residualRisks, logPath, changeSet.commits),
      headBranch: branchName,
      baseBranch: config.branches.base,
    });
    const reportComment = buildReviewReport(config, branchName, options.issueNumber, pullRequest, changedFiles, validation, report.artifacts, report.skippedChecks, residualRisks, logPath, changeSet.commits);
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

async function defaultPassingLocalPhaseExecutor(input: { phaseId: string; worktreePath: string }) {
  return {
    phaseId: input.phaseId,
    status: 'passed' as const,
    validation: [],
    artifacts: [],
    residualRisks: [],
  };
}

function localSessionBlockReasons(phaseResults: Array<Awaited<ReturnType<LocalExecutionPhaseExecutor>>>): string[] {
  return phaseResults.flatMap((phase) => {
    if (phase.status !== 'failed') {
      return [];
    }
    return [
      `Local phase ${phase.phaseId} failed`,
      ...phase.validation.map((line) => `${line.command}: ${line.status} - ${line.summary}`),
      ...phase.artifacts.map((artifact) => `${artifact.description}: ${artifact.url ?? artifact.path ?? 'missing-target'}`),
    ];
  });
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
    'Log',
    ...bulletList([result.logPath]),
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
  config: CodexOrchestratorConfig,
  branchName: string,
  issueNumber: number,
  pullRequest: GitHubPullRequest,
  changedFiles: string[],
  validation: ValidationLine[],
  artifacts: ScopedCompletionReport['artifacts'],
  skippedChecks: string[],
  residualRisks: string[],
  logPath: string,
  commits: SessionCommitInfo[],
): string {
  return [
    `codex-orchestrator review report for #${issueNumber}`,
    'Pull Request',
    `- ${pullRequest.url}`,
    'Changes',
    ...bulletList(changedFiles),
    'Validation',
    ...validation.map((line) => `- ${line.command}: ${line.status} - ${line.summary}`),
    'Proof Artifacts',
    ...renderProofArtifacts(config, branchName, artifacts),
    'Log',
    ...bulletList([logPath]),
    'Local Commits',
    ...renderCommitEvidence(commits),
    'Skipped Checks',
    ...bulletList(skippedChecks),
    'Residual Risks',
    ...bulletList(residualRisks),
  ].join('\n');
}

function buildPullRequestBody(
  config: CodexOrchestratorConfig,
  branchName: string,
  issueNumber: number,
  changedFiles: string[],
  validation: ValidationLine[],
  artifacts: ScopedCompletionReport['artifacts'],
  skippedChecks: string[],
  residualRisks: string[],
  logPath: string,
  commits: SessionCommitInfo[],
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
    'Proof artifacts:',
    ...renderProofArtifacts(config, branchName, artifacts),
    '',
    'Log:',
    ...bulletList([logPath]),
    '',
    'Local commits:',
    ...renderCommitEvidence(commits),
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
  logPath: string,
): Omit<ScopedAutoCommandResult, 'status' | 'reportComment'> {
  return { issueNumber, branchName, worktreePath, promptPath, reportPath, logPath };
}

function renderTemplate(template: string, issueNumber: number): string {
  return template.replaceAll('${issueNumber}', String(issueNumber));
}

function renderProofArtifacts(
  config: CodexOrchestratorConfig,
  branchName: string,
  artifacts: ScopedCompletionReport['artifacts'],
): string[] {
  if (artifacts.length === 0) {
    return ['- none'];
  }
  return artifacts.map((artifact) => {
    const target = artifact.url ?? rawGitHubUrl(config, branchName, artifact.path ?? '');
    const label = `${artifact.type}: ${artifact.description}`;
    return artifact.type === 'screenshot' ? `- ![${escapeMarkdownAlt(label)}](${target})` : `- ${label}: ${target}`;
  });
}

function rawGitHubUrl(config: CodexOrchestratorConfig, branchName: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${encodeURIComponent(config.github.owner)}/${encodeURIComponent(config.github.repo)}/${encodeURIComponent(branchName)}/${encodedPath}`;
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/[\[\]]/g, '');
}
