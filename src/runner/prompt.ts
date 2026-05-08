import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';

export interface ScopedPromptInput {
  issue: GitHubIssue;
  config: CodexOrchestratorConfig;
  workflowPromptText: string;
  promptPath: string;
  reportPath: string;
  branchName: string;
  worktreePath: string;
}

export type CompletionStatus = 'completed' | 'needs-promotion';
export type ValidationStatus = 'passed' | 'failed' | 'skipped';
export type ProhibitedActionType =
  | 'secret-file-read'
  | 'secret-file-change'
  | 'destructive-db-or-cache'
  | 'production-deploy-or-release';

export interface ScopedCompletionReport {
  status: CompletionStatus;
  changes: string[];
  validation: Array<{ command: string; status: ValidationStatus; summary: string }>;
  skippedChecks: string[];
  residualRisks: string[];
  prohibitedActions: Array<{ type: ProhibitedActionType; description: string }>;
  promotion?: {
    reason: string;
    criteria: string[];
    evidence: string[];
  };
}

export type ScopedCompletionReportReadResult =
  | { kind: 'missing' }
  | { kind: 'valid'; report: ScopedCompletionReport };

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
    'Change files only. Do not commit, push, open pull requests, merge, publish, deploy, or edit GitHub labels/comments. The runner owns publication.',
    '## Safety Contract',
    `Do not read or modify configured secret file patterns: ${input.config.deny.secretFiles.join(', ')}.`,
    'Do not run destructive database/cache actions.',
    'Do not run production deploy/release actions.',
    '## Completion Report Contract',
    `Write JSON to ${input.reportPath} with: status, changes, validation, skippedChecks, residualRisks, prohibitedActions, and optional promotion.`,
    `Prompt file: ${input.promptPath}`,
    `Branch: ${input.branchName}`,
    `Worktree: ${input.worktreePath}`,
  ].join('\n\n');
}

export async function readScopedCompletionReport(reportPath: string): Promise<ScopedCompletionReportReadResult> {
  let content: string;
  try {
    content = await readFile(reportPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error('Invalid scoped completion report: report must be valid JSON');
  }
  assertScopedCompletionReport(parsed);
  return { kind: 'valid', report: parsed };
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

function assertScopedCompletionReport(value: unknown): asserts value is ScopedCompletionReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid scoped completion report: report must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.status !== 'completed' && record.status !== 'needs-promotion') {
    throw new Error('Invalid scoped completion report: status must be completed or needs-promotion');
  }
  assertStringArray(record.changes, 'changes');
  assertValidation(record.validation);
  assertStringArray(record.skippedChecks, 'skippedChecks');
  assertStringArray(record.residualRisks, 'residualRisks');
  assertProhibitedActions(record.prohibitedActions);
  if (record.status === 'needs-promotion') {
    assertPromotion(record.promotion);
  }
}

function assertStringArray(value: unknown, key: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid scoped completion report: ${key} must be a string array`);
  }
}

function assertValidation(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('Invalid scoped completion report: validation must be an array');
  }
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Invalid scoped completion report: validation item must be an object');
    }
    const record = item as Record<string, unknown>;
    if (typeof record.command !== 'string' || !['passed', 'failed', 'skipped'].includes(String(record.status)) || typeof record.summary !== 'string') {
      throw new Error('Invalid scoped completion report: validation item is malformed');
    }
  }
}

function assertProhibitedActions(value: unknown): void {
  const types = new Set(['secret-file-read', 'secret-file-change', 'destructive-db-or-cache', 'production-deploy-or-release']);
  if (!Array.isArray(value)) {
    throw new Error('Invalid scoped completion report: prohibitedActions must be an array');
  }
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Invalid scoped completion report: prohibitedActions item must be an object');
    }
    const record = item as Record<string, unknown>;
    if (typeof record.type !== 'string' || !types.has(record.type) || typeof record.description !== 'string') {
      throw new Error('Invalid scoped completion report: prohibitedActions item is malformed');
    }
  }
}

function assertPromotion(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid scoped completion report: promotion is required for needs-promotion');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.reason !== 'string' || record.reason.trim().length === 0) {
    throw new Error('Invalid scoped completion report: promotion.reason must be non-empty');
  }
  assertStringArray(record.criteria, 'promotion.criteria');
  assertStringArray(record.evidence, 'promotion.evidence');
  if ((record.criteria as string[]).length === 0 || (record.evidence as string[]).length === 0) {
    throw new Error('Invalid scoped completion report: promotion criteria and evidence must be non-empty');
  }
}
