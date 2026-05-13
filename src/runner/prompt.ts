import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { AutonomousChildMetadata } from './issue-tree.js';
import {
  buildQualityGatePromptLines,
  buildVisualProofPromptLines,
} from './review-gate-policy.js';
export {
  readPlanAutoCompletionReport,
  readScopedCompletionReport,
} from './completion-report.js';
export type {
  CompletionStatus,
  PlanAutoCompletionReport,
  PlanAutoCompletionReportReadResult,
  ProhibitedActionType,
  ScopedCompletionReport,
  ScopedCompletionReportReadResult,
  ValidationStatus,
} from './completion-report.js';

export interface ScopedPromptInput {
  issue: GitHubIssue;
  config: CodexOrchestratorConfig;
  workflowPromptText: string;
  promptPath: string;
  reportPath: string;
  branchName: string;
  worktreePath: string;
}

export interface PlanAutoPromptInput {
  parentIssue: GitHubIssue;
  config: CodexOrchestratorConfig;
  prompts: {
    prd: string;
    issueBreakdown: string;
    breakdownReview: string;
    triage: string;
  };
  promptPath: string;
  reportPath: string;
  branchName: string;
  worktreePath: string;
}

export interface IssueTreeChildPromptInput {
  parentIssue: GitHubIssue;
  childIssue: GitHubIssue;
  config: CodexOrchestratorConfig;
  workflowPromptText: string;
  childMetadata: AutonomousChildMetadata;
  dependencyIssues: GitHubIssue[];
  promptPath: string;
  reportPath: string;
  branchName: string;
  worktreePath: string;
}

export function buildScopedImplementationPrompt(input: ScopedPromptInput): string {
  const labels = input.issue.labels.map((label) => label.name).join(', ') || 'none';
  const comments = [...input.issue.comments]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((comment) => `- ${comment.createdAt} ${comment.author.login} (${comment.authorAssociation}): ${comment.body}`)
    .join('\n') || 'none';

  return [
    '# Codex Orchestrator Scoped Implementation',
    '## Issue Context',
    `Issue: #${input.issue.number}`,
    `Title: ${input.issue.title}`,
    `URL: ${input.issue.url}`,
    `Body:\n${input.issue.body}`,
    `Labels: ${labels}`,
    `Comments:\n${comments}`,
    '## Project Workflow',
    input.workflowPromptText,
    '## Runner-Owned Publication Contract',
    localCommitPublicationLine(input.config, false),
    '## Safety Contract',
    `Do not read or modify configured secret file patterns: ${input.config.deny.secretFiles.join(', ')}.`,
    'Do not run destructive database/cache actions.',
    'Do not run production deploy/release actions.',
    'Use explicit short timeouts for local HTTP probes, for example curl --max-time 10, and avoid blind probing of unrelated localhost ports.',
    ...buildQualityGatePromptLines(input.config),
    '## Completion Report Contract',
    `The Codex CLI will save your final response to ${input.reportPath}; do not try to write this file yourself.`,
    'Your final response must be only raw valid JSON, with no markdown fence or explanatory prose.',
    ...buildVisualProofPromptLines(input.config, input.issue.number),
    'Schema: { "status": "completed" | "needs-promotion", "changes": string[], "validation": { "command": string, "status": "passed" | "failed" | "skipped", "summary": string }[], "artifacts": { "type": "screenshot" | "log" | "other", "path"?: string, "url"?: string, "description": string }[], "skippedChecks": string[], "residualRisks": string[], "prohibitedActions": { "type": "secret-file-read" | "secret-file-change" | "destructive-db-or-cache" | "production-deploy-or-release", "description": string }[], "promotion"?: { "reason": string, "criteria": string[], "evidence": string[] } }.',
    `Prompt file: ${input.promptPath}`,
    `Branch: ${input.branchName}`,
    `Worktree: ${input.worktreePath}`,
  ].join('\n\n');
}

export function buildPlanAutoPrompt(input: PlanAutoPromptInput): string {
  const labels = input.parentIssue.labels.map((label) => label.name).join(', ') || 'none';
  const comments = [...input.parentIssue.comments]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((comment) => `- ${comment.createdAt} ${comment.author.login} (${comment.authorAssociation}): ${comment.body}`)
    .join('\n') || 'none';

  return [
    '# Codex Orchestrator Parent Planning',
    '## Parent Issue Context',
    `Issue: #${input.parentIssue.number}`,
    `Title: ${input.parentIssue.title}`,
    `URL: ${input.parentIssue.url}`,
    `Body:\n${input.parentIssue.body}`,
    `Labels: ${labels}`,
    `Comments:\n${comments}`,
    '## PRD Workflow',
    input.prompts.prd,
    '## Issue Breakdown Workflow',
    input.prompts.issueBreakdown,
    '## Breakdown Review Workflow',
    input.prompts.breakdownReview,
    '## Triage Workflow',
    input.prompts.triage,
    '## Runner-Owned GitHub Contract',
    'Return structured output only. Do not create/edit GitHub issues, labels, comments, milestones, projects, branches, commits, pushes, pull requests, merges, publishes, deploys, or execute child waves. The runner owns all GitHub mutations.',
    '## Autonomous Child Contract',
    'Every child must be represented in the JSON report. Autonomous membership requires the explicit runner marker plus parent reference. Arbitrary links, milestones, projects, and comments do not grant membership or inherited authorization.',
    '## Planning Report Contract',
    [
      `The Codex CLI will save your final response to ${input.reportPath}; do not try to write this file yourself.`,
      'Your final response must be only raw valid JSON, with no markdown fence or explanatory prose.',
      'Schema: { "status": "completed", "parent": { "title"?: string, "body": string }, "graph": { "nodes": PlanChildNode[], "edges": PlanDependencyEdge[], "specGate": "wave-level" }, "residualRisks": string[] }.',
      'PlanChildNode: { stableId, issueNumber?, title, body, afkHitl: "afk" | "hitl", ownershipScope: string[], dependsOn: string[], verification: string[] }.',
      'PlanDependencyEdge: { from, to, reason } where from is the dependency and to depends on it.',
      `Prompt file: ${input.promptPath}`,
      `Branch: ${input.branchName}`,
      `Worktree: ${input.worktreePath}`,
    ].join('\n'),
  ].join('\n\n');
}

export function buildIssueTreeChildPrompt(input: IssueTreeChildPromptInput): string {
  const labels = input.childIssue.labels.map((label) => label.name).join(', ') || 'none';
  const comments = [...input.childIssue.comments]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((comment) => `- ${comment.createdAt} ${comment.author.login} (${comment.authorAssociation}): ${comment.body}`)
    .join('\n') || 'none';
  const dependencies = input.dependencyIssues.length > 0
    ? input.dependencyIssues.map((issue) => `- #${issue.number} ${issue.title}`).join('\n')
    : 'none';

  return [
    '# Codex Orchestrator Issue-Tree Child Implementation',
    '## Parent Issue Context',
    `Issue: #${input.parentIssue.number}`,
    `Title: ${input.parentIssue.title}`,
    `URL: ${input.parentIssue.url}`,
    `Body:\n${input.parentIssue.body}`,
    '## Child Issue Context',
    `Issue: #${input.childIssue.number}`,
    `Title: ${input.childIssue.title}`,
    `URL: ${input.childIssue.url}`,
    `Body:\n${input.childIssue.body}`,
    `Labels: ${labels}`,
    `Comments:\n${comments}`,
    `Stable ID: ${input.childMetadata.stableId}`,
    `Ownership Scope: ${input.childMetadata.ownershipScope.join(', ')}`,
    `Dependencies: ${input.childMetadata.dependsOn.length > 0 ? input.childMetadata.dependsOn.join(', ') : 'none'}`,
    `Verification Expectations: ${input.childMetadata.verification.join(', ')}`,
    '## Dependency Context',
    dependencies,
    'Dependency child issues listed here were merged into the parent integration branch before this child starts.',
    '## Project Workflow',
    input.workflowPromptText,
    '## Runner-Owned Publication Contract',
    localCommitPublicationLine(input.config, true),
    '## Safety Contract',
    `Do not read or modify configured secret file patterns: ${input.config.deny.secretFiles.join(', ')}.`,
    'Do not run destructive database/cache actions.',
    'Do not run production deploy/release actions.',
    'Use explicit short timeouts for local HTTP probes, for example curl --max-time 10, and avoid blind probing of unrelated localhost ports.',
    ...buildQualityGatePromptLines(input.config),
    '## Completion Report Contract',
    `The Codex CLI will save your final response to ${input.reportPath}; do not try to write this file yourself.`,
    'Your final response must be only raw valid JSON, with no markdown fence or explanatory prose.',
    ...buildVisualProofPromptLines(input.config, input.childIssue.number),
    'Schema: { "status": "completed" | "needs-promotion", "changes": string[], "validation": { "command": string, "status": "passed" | "failed" | "skipped", "summary": string }[], "artifacts": { "type": "screenshot" | "log" | "other", "path"?: string, "url"?: string, "description": string }[], "skippedChecks": string[], "residualRisks": string[], "prohibitedActions": { "type": "secret-file-read" | "secret-file-change" | "destructive-db-or-cache" | "production-deploy-or-release", "description": string }[], "promotion"?: { "reason": string, "criteria": string[], "evidence": string[] } }.',
    `Prompt file: ${input.promptPath}`,
    `Branch: ${input.branchName}`,
    `Worktree: ${input.worktreePath}`,
  ].join('\n\n');
}

function localCommitPublicationLine(config: CodexOrchestratorConfig, child: boolean): string {
  const forbidden = child
    ? 'push, merge, open pull requests, merge pull requests, publish, deploy, or edit GitHub labels/comments'
    : 'push, open pull requests, merge, publish, deploy, or edit GitHub labels/comments';
  return config.runner.allowAgentLocalCommits
    ? `You may create local commits in this worktree. Do not ${forbidden}. The runner owns external publication.`
    : child
      ? `Change files only. You must not commit, ${forbidden}. The runner owns publication.`
      : `Change files only. Do not commit, ${forbidden}. The runner owns publication.`;
}

export async function writeDurablePrompt(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issueNumber: number;
  sessionId: string;
  promptText: string;
}): Promise<string> {
  const path = sessionPromptPath(input);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.promptText, 'utf8');
  return path;
}

export function sessionPromptPath(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issueNumber: number;
  sessionId: string;
}): string {
  return join(
    input.targetRoot,
    input.config.runner.stateDir,
    'prompts',
    `issue-${input.issueNumber}-${input.sessionId}.md`,
  );
}

export function sessionReportPath(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issueNumber: number;
  sessionId: string;
}): string {
  return join(
    input.targetRoot,
    input.config.runner.stateDir,
    'reports',
    `issue-${input.issueNumber}-${input.sessionId}.json`,
  );
}
