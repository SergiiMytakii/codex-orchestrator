import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GitWorktreeManager, renderBranchTemplate } from '../git/worktree.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import { bulletList, formatSessionTimestamp, readRunnerConfig } from './command-utils.js';
import { claimIssue, discoverIssueWork } from './issue-state-machine.js';
import {
  ensureAutonomousChildBody,
  isAutonomousChildOfParent,
  topologicalPlanNodes,
  type PlanChildNode,
} from './issue-tree.js';
import { RunnerStateStore } from './local-state.js';
import {
  buildPlanAutoPrompt,
  readPlanAutoCompletionReport,
  sessionPromptPath,
  sessionReportPath,
  type PlanAutoCompletionReport,
  writeDurablePrompt,
} from './prompt.js';

export interface PlanAutoCommandOptions {
  targetRoot: string;
  issueNumber: number;
  issueAdapter?: GitHubIssueAdapter;
  git?: GitWorktreeManager;
  codexAdapter?: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  now?: Date;
}

export interface PlanAutoCommandResult {
  parentIssueNumber: number;
  branchName: string;
  worktreePath: string;
  promptPath: string;
  reportPath: string;
  childIssues: GitHubIssue[];
  status: 'planning-ready' | 'blocked';
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

export async function runPlanAutoCommand(options: PlanAutoCommandOptions): Promise<PlanAutoCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const now = options.now ?? new Date();
  const config = await readRunnerConfig(targetRoot);
  const issueAdapter = options.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const git = options.git ?? new GitWorktreeManager();
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
  const branchName = renderBranchTemplate(config.branches.issueTree, { parentIssueNumber: options.issueNumber });
  const worktreePath = join(targetRoot, config.runner.workspaceRoot, `tree-${options.issueNumber}`);
  let promptPath = '';
  let reportPath = '';
  const childIssues: GitHubIssue[] = [];

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

    const reportComment = buildPlanningReport(options.issueNumber, report, childIssues);
    await issueAdapter.removeLabels(options.issueNumber, [config.github.labels.running.name]);
    await issueAdapter.addLabels(options.issueNumber, [config.github.labels.review.name]);
    await issueAdapter.postComment(options.issueNumber, reportComment);
    await store.removeRun(options.issueNumber);

    return {
      ...baseResult(options.issueNumber, branchName, worktreePath, promptPath, reportPath, childIssues),
      status: 'planning-ready',
      reportComment,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'plan-auto planning failed';
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
  const absolutePath = promptPath ? join(targetRoot, promptPath) : 'undefined';
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Plan-auto workflow prompt not found at ${absolutePath}`);
    }
    throw error;
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
    `codex-orchestrator blocked parent planning for #${result.parentIssueNumber}`,
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
    `AFK/HITL: ${node.afkHitl}`,
    `Depends on: ${node.dependsOn.length > 0 ? node.dependsOn.join(', ') : 'none'}`,
    'Ownership:',
    ...bulletList(node.ownershipScope),
    'Spec gate: wave-level',
    'Verification:',
    ...bulletList(node.verification),
  ].join('\n');
}

function buildPlanningReport(
  parentIssueNumber: number,
  report: PlanAutoCompletionReport,
  childIssues: GitHubIssue[],
): string {
  const persistedNodes = topologicalPlanNodes(report.graph);
  const issueByStableId = new Map(persistedNodes.map((node, index) => [node.stableId, childIssues[index]]));
  return [
    `codex-orchestrator planning report for #${parentIssueNumber}`,
    'Child Issues',
    ...report.graph.nodes.map((node) => {
      const issue = issueByStableId.get(node.stableId);
      return `- ${issue ? `#${issue.number}` : node.stableId} ${node.title}: ${node.afkHitl}`;
    }),
    'Dependency Edges',
    ...bulletList(report.graph.edges.map((edge) => `${edge.from} -> ${edge.to}: ${edge.reason}`)),
    'Ownership Scopes',
    ...report.graph.nodes.map((node) => `- ${node.stableId}: ${node.ownershipScope.join(', ')}`),
    'Spec gate: wave-level',
    'Verification Expectations',
    ...report.graph.nodes.map((node) => `- ${node.stableId}: ${node.verification.join(', ')}`),
    'Execution',
    `- Child wave execution is out of scope for #${parentIssueNumber}.`,
    'Residual Risks',
    ...bulletList(report.residualRisks),
  ].join('\n');
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
