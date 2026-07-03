import { resolve } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { GitWorktreeManager } from '../git/worktree.js';
import {
  findDurableRunSummariesForIssue,
  type DurableRunSummary,
  type DurableRunSummaryEvidence,
} from './durable-run-summary.js';
import type { AutonomousChildNode } from './issue-tree.js';
import { isAutonomousChildOfParent } from './issue-tree.js';
import { decideImplementationRework, type ReworkDecision } from './rework-policy.js';
import { classifyRecoveryOwnership, type ProcessProbeResult } from './scoped-recovery.js';
import type { RunnerProcessMetadata, RunnerStateFile } from './local-state.js';

export type PlanAutoParentRecoveryDecision =
  | { kind: 'start-fresh' }
  | {
      kind: 'resume-parent';
      evidence: {
        issueNumber: number;
        branchName: string;
        worktreePath: string;
        sessionId: string;
        baseSha: string;
      };
    }
  | PlanAutoRecoveryHardBlock;

export interface PlanAutoRecoveryHardBlock {
  kind: 'hard-block';
  scope: 'parent' | 'child';
  reason: string;
  marker: string;
}

export type PlanAutoChildRecoveryDecision =
  | {
      kind: 'recovered-completed-child';
      child: AutonomousChildNode;
      branchName: string;
      worktreePath: string;
      promptPath: string;
      reportPath: string;
      logPath: string;
      changedFiles: string[];
      validation: DurableRunSummary['validation'];
      skippedChecks: string[];
      residualRisks: string[];
      durableRunSummary: DurableRunSummaryEvidence;
    }
  | { kind: 'execute-child' }
  | {
      kind: 'resume-child-rework';
      child: AutonomousChildNode;
      branchName: string;
      worktreePath: string;
      run: RunnerProcessMetadata;
      rework: Extract<ReworkDecision, { kind: 'retry' }>['rework'];
      blockedReasons: string[];
    }
  | PlanAutoRecoveryHardBlock;

export async function classifyPlanAutoParentRecovery(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  parentIssue: GitHubIssue;
  branchName: string;
  worktreePath: string;
  baseSha: string;
  state: RunnerStateFile;
  git: Pick<GitWorktreeManager, 'listWorktrees' | 'isWorktreeClean' | 'branchExists' | 'branchContainsCommit'>;
  now: Date;
  hostname?: () => string;
  processProbe?: (pid: number) => Promise<ProcessProbeResult> | ProcessProbeResult;
}): Promise<PlanAutoParentRecoveryDecision> {
  const run = input.state.runs.find((candidate) => (
    candidate.issueNumber === input.parentIssue.number || (
      candidate.mode === 'plan-parent'
      && candidate.branchName === input.branchName
      && samePath(candidate.workspacePath, input.worktreePath)
    )
  ));
  if (!run) {
    return { kind: 'start-fresh' };
  }

  const invalid = validateParentMetadata(run, input);
  if (invalid) {
    return parentBlock(input.parentIssue.number, invalid);
  }

  const ownership = await classifyRecoveryOwnership({
    run,
    now: input.now,
    hostname: input.hostname,
    processProbe: input.processProbe,
  });
  if (ownership.kind === 'unknown') {
    return parentBlock(
      input.parentIssue.number,
      ownership.remoteHost ? 'parent ownership evidence is incomplete' : 'parent ownership evidence is invalid or from the future',
    );
  }
  if (ownership.kind === 'legacy') {
    return parentBlock(input.parentIssue.number, 'legacy parent metadata cannot prove stale ownership');
  }
  if (ownership.kind === 'cross-host') {
    return parentBlock(input.parentIssue.number, `parent metadata belongs to host ${ownership.remoteHost ?? 'unknown'}`);
  }
  if (ownership.process === 'alive' || ownership.process === 'unknown') {
    return parentBlock(input.parentIssue.number, `parent runner process is ${ownership.process}`);
  }
  if (!ownership.stale) {
    return parentBlock(input.parentIssue.number, 'parent runner lease is still fresh');
  }

  const worktrees = await input.git.listWorktrees(input.targetRoot);
  const worktree = worktrees.find((candidate) => samePath(candidate.path, input.worktreePath));
  if (!worktree) {
    return parentBlock(input.parentIssue.number, 'parent worktree is missing');
  }
  const expectedBranchRef = `refs/heads/${input.branchName}`;
  if (worktree.branch !== expectedBranchRef) {
    return parentBlock(input.parentIssue.number, `parent worktree branch does not match ${input.branchName}`);
  }
  if (!await input.git.isWorktreeClean(input.worktreePath)) {
    return parentBlock(input.parentIssue.number, 'parent worktree is not clean');
  }
  if (!await input.git.branchExists(input.targetRoot, input.branchName)) {
    return parentBlock(input.parentIssue.number, `parent branch ${input.branchName} is missing`);
  }
  if (!await input.git.branchContainsCommit(input.targetRoot, input.branchName, input.baseSha)) {
    return parentBlock(input.parentIssue.number, 'parent branch does not contain configured base');
  }

  return {
    kind: 'resume-parent',
    evidence: {
      issueNumber: input.parentIssue.number,
      branchName: input.branchName,
      worktreePath: input.worktreePath,
      sessionId: run.sessionId,
      baseSha: input.baseSha,
    },
  };
}

export async function classifyPlanAutoCompletedChildRecovery(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  parentIssueNumber: number;
  parentBranchName: string;
  child: AutonomousChildNode;
  state: RunnerStateFile;
  git: Pick<GitWorktreeManager, 'listWorktrees' | 'isWorktreeClean' | 'branchExists' | 'isBranchAncestorOf'>;
}): Promise<PlanAutoChildRecoveryDecision> {
  const childIssue = input.child.issue;
  if (childIssue.state !== 'CLOSED') {
    return { kind: 'execute-child' };
  }
  if (!isAutonomousChildOfParent(childIssue, input.config, input.parentIssueNumber)) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child issue #${childIssue.number} is not marked for parent #${input.parentIssueNumber}`);
  }
  const run = input.state.runs.find((candidate) => candidate.issueNumber === childIssue.number);
  const expectedBranchName = `codex/tree-${input.parentIssueNumber}-issue-${childIssue.number}`;
  const expectedWorktreePath = `${input.targetRoot}/${input.config.runner.workspaceRoot}/tree-${input.parentIssueNumber}-issue-${childIssue.number}`;
  const invalid = validateCompletedChildMetadata(run, {
    childIssueNumber: childIssue.number,
    parentIssueNumber: input.parentIssueNumber,
    branchName: expectedBranchName,
    worktreePath: expectedWorktreePath,
  });
  if (invalid) {
    return childBlock(input.parentIssueNumber, childIssue.number, invalid);
  }
  const safeRun = run;
  if (!safeRun) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} runner metadata is missing`);
  }

  const summaries = await findDurableRunSummariesForIssue({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: childIssue.number,
    sessionId: safeRun.sessionId,
  });
  const summaryRead = summaries[0];
  if (!summaryRead || summaryRead.kind === 'missing') {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} durable run summary is missing`);
  }
  if (summaryRead.kind === 'invalid') {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} durable run summary is invalid: ${summaryRead.reason}`);
  }
  const summary = summaryRead.summary;
  if (summary.issueNumber !== childIssue.number || summary.sessionId !== safeRun.sessionId) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} durable run summary does not match runner metadata`);
  }
  if (summary.outcome !== 'review-ready') {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} durable run summary outcome is ${summary.outcome}`);
  }
  if (!await input.git.branchExists(input.targetRoot, expectedBranchName)) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child branch ${expectedBranchName} is missing`);
  }
  if (!await input.git.branchExists(input.targetRoot, input.parentBranchName)) {
    return childBlock(input.parentIssueNumber, childIssue.number, `parent branch ${input.parentBranchName} is missing`);
  }
  if (!await input.git.isBranchAncestorOf(input.targetRoot, expectedBranchName, input.parentBranchName)) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child branch ${expectedBranchName} is not merged into ${input.parentBranchName}`);
  }
  const worktrees = await input.git.listWorktrees(input.targetRoot);
  const childWorktree = worktrees.find((worktree) => samePath(worktree.path, expectedWorktreePath));
  if (childWorktree && childWorktree.branch !== `refs/heads/${expectedBranchName}`) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child worktree branch does not match ${expectedBranchName}`);
  }
  if (childWorktree && !await input.git.isWorktreeClean(expectedWorktreePath)) {
    return childBlock(input.parentIssueNumber, childIssue.number, 'child worktree is not clean');
  }

  return {
    kind: 'recovered-completed-child',
    child: input.child,
    branchName: expectedBranchName,
    worktreePath: expectedWorktreePath,
    promptPath: safeRun.promptPath ?? '',
    reportPath: summary.evidence.reportPath,
    logPath: summary.evidence.logPath,
    changedFiles: summary.changedFiles,
    validation: summary.validation,
    skippedChecks: summary.skippedChecks,
    residualRisks: summary.residualRisks,
    durableRunSummary: {
      path: summaryRead.path,
      excerpt: [
        `outcome: ${summary.outcome}`,
        `next action: ${summary.nextAction}`,
        'recovered from durable summary',
      ],
    },
  };
}

export async function classifyPlanAutoBlockedChildRecovery(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  parentIssueNumber: number;
  child: AutonomousChildNode;
  state: RunnerStateFile;
  git: Pick<GitWorktreeManager, 'listWorktrees' | 'branchExists'>;
}): Promise<PlanAutoChildRecoveryDecision> {
  const childIssue = input.child.issue;
  const labels = new Set(childIssue.labels.map((label) => label.name));
  if (!labels.has(input.config.github.labels.blocked.name)) {
    return { kind: 'execute-child' };
  }
  if (!isAutonomousChildOfParent(childIssue, input.config, input.parentIssueNumber)) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child issue #${childIssue.number} is not marked for parent #${input.parentIssueNumber}`);
  }
  const expectedBranchName = `codex/tree-${input.parentIssueNumber}-issue-${childIssue.number}`;
  const expectedWorktreePath = `${input.targetRoot}/${input.config.runner.workspaceRoot}/tree-${input.parentIssueNumber}-issue-${childIssue.number}`;
  const run = input.state.runs.find((candidate) => candidate.issueNumber === childIssue.number);
  const invalid = validateCompletedChildMetadata(run, {
    childIssueNumber: childIssue.number,
    parentIssueNumber: input.parentIssueNumber,
    branchName: expectedBranchName,
    worktreePath: expectedWorktreePath,
  });
  if (invalid) {
    return childBlock(input.parentIssueNumber, childIssue.number, invalid);
  }
  const safeRun = run;
  if (!safeRun) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} runner metadata is missing`);
  }
  const summaries = await findDurableRunSummariesForIssue({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: childIssue.number,
    sessionId: safeRun.sessionId,
  });
  const summaryRead = summaries[0];
  if (!summaryRead || summaryRead.kind === 'missing') {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} durable run summary is missing`);
  }
  if (summaryRead.kind === 'invalid') {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} durable run summary is invalid: ${summaryRead.reason}`);
  }
  if (summaryRead.summary.issueNumber !== childIssue.number || summaryRead.summary.sessionId !== safeRun.sessionId) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} durable run summary does not match runner metadata`);
  }
  if (summaryRead.summary.outcome !== 'blocked') {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} durable run summary outcome is ${summaryRead.summary.outcome}`);
  }
  if (summaryRead.summary.blockers.length === 0) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} durable run summary has no blockers`);
  }
  if (!await input.git.branchExists(input.targetRoot, expectedBranchName)) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child branch ${expectedBranchName} is missing`);
  }
  const worktree = (await input.git.listWorktrees(input.targetRoot)).find((candidate) => samePath(candidate.path, expectedWorktreePath));
  if (!worktree) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child worktree ${expectedWorktreePath} is missing`);
  }
  if (worktree.branch !== `refs/heads/${expectedBranchName}`) {
    return childBlock(input.parentIssueNumber, childIssue.number, `child worktree branch does not match ${expectedBranchName}`);
  }
  const reworkDecision = decideImplementationRework({
    reasons: summaryRead.summary.blockers,
    config: input.config,
    attempt: safeRun.retryCount,
  });
  if (reworkDecision.kind !== 'retry') {
    return childBlock(input.parentIssueNumber, childIssue.number, `child #${childIssue.number} rework decision is ${reworkDecision.kind}`);
  }
  return {
    kind: 'resume-child-rework',
    child: input.child,
    branchName: expectedBranchName,
    worktreePath: expectedWorktreePath,
    run: safeRun,
    rework: reworkDecision.rework,
    blockedReasons: summaryRead.summary.blockers,
  };
}

function validateParentMetadata(
  run: RunnerProcessMetadata,
  input: {
    parentIssue: GitHubIssue;
    branchName: string;
    worktreePath: string;
    baseSha: string;
  },
): string | undefined {
  if (run.mode !== 'plan-parent') {
    return 'parent metadata mode is not plan-parent';
  }
  if (run.issueNumber !== input.parentIssue.number) {
    return `parent metadata issue number does not match #${input.parentIssue.number}`;
  }
  if (run.branchName !== input.branchName) {
    return `parent metadata branch does not match ${input.branchName}`;
  }
  if (!samePath(run.workspacePath, input.worktreePath)) {
    return 'parent metadata worktree path does not match configured path';
  }
  if (!run.baseSha) {
    return 'parent metadata base evidence is missing';
  }
  if (run.baseSha !== input.baseSha) {
    return 'parent metadata base does not match configured base';
  }
  if (!run.sessionId) {
    return 'parent metadata session id is missing';
  }
  return undefined;
}

function validateCompletedChildMetadata(
  run: RunnerProcessMetadata | undefined,
  expected: {
    childIssueNumber: number;
    parentIssueNumber: number;
    branchName: string;
    worktreePath: string;
  },
): string | undefined {
  if (!run) {
    return `child #${expected.childIssueNumber} runner metadata is missing`;
  }
  if (run.mode !== 'tree-child') {
    return `child #${expected.childIssueNumber} metadata mode is not tree-child`;
  }
  if (run.issueNumber !== expected.childIssueNumber) {
    return `child #${expected.childIssueNumber} metadata issue number does not match`;
  }
  if (run.parentIssueNumber !== expected.parentIssueNumber) {
    return `child #${expected.childIssueNumber} metadata parent does not match #${expected.parentIssueNumber}`;
  }
  if (run.branchName !== expected.branchName) {
    return `child #${expected.childIssueNumber} metadata branch does not match ${expected.branchName}`;
  }
  if (!samePath(run.workspacePath, expected.worktreePath)) {
    return `child #${expected.childIssueNumber} metadata worktree path does not match`;
  }
  if (!run.sessionId) {
    return `child #${expected.childIssueNumber} metadata session id is missing`;
  }
  return undefined;
}

function parentBlock(parentIssueNumber: number, reason: string): PlanAutoRecoveryHardBlock {
  return {
    kind: 'hard-block',
    scope: 'parent',
    reason,
    marker: `plan-auto-recovery-blocked parent=${parentIssueNumber} reason=${reasonSlug(reason)}`,
  };
}

function childBlock(parentIssueNumber: number, childIssueNumber: number, reason: string): PlanAutoRecoveryHardBlock {
  return {
    kind: 'hard-block',
    scope: 'child',
    reason,
    marker: `plan-auto-recovery-blocked parent=${parentIssueNumber} child=${childIssueNumber} reason=${reasonSlug(reason)}`,
  };
}

function reasonSlug(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/#/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function canonicalPath(path: string): string {
  const resolvedPath = resolve(path);
  return resolvedPath.startsWith('/private/') ? resolvedPath.slice('/private'.length) : resolvedPath;
}
