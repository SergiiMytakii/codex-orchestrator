import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { AcceptanceProofAttemptEvidence } from './acceptance-proof-runner.js';
import type { RunnerValidationLine } from './handoff-evidence.js';

export interface DurableRunSummary {
  issueNumber: number;
  sessionId: string;
  outcome: 'review-ready' | 'blocked' | 'promotion-requested';
  changedFiles: string[];
  confirmedFacts: string[];
  validation: RunnerValidationLine[];
  blockers: string[];
  skippedChecks: string[];
  residualRisks: string[];
  policySuggestions: string[];
  nextAction: string;
  evidence: {
    logPath: string;
    reportPath: string;
  };
  reworkAttempts?: ReworkAttemptEvidence[];
  acceptanceProof?: AcceptanceProofAttemptEvidence;
}

export interface DurableRunSummaryEvidence {
  path: string;
  excerpt: string[];
}

export interface ReworkAttemptEvidence {
  attempt: number;
  maxAttempts?: number;
  decisionKind: 'retry' | 'exhausted' | 'hard-block';
  reasons: string[];
  promptPath: string;
  reportPath: string;
  logPath: string;
  snapshotPath?: string;
}

export type DurableRunSummaryReadResult =
  | { kind: 'valid'; path: string; summary: DurableRunSummary }
  | { kind: 'missing'; path: string }
  | { kind: 'invalid'; path: string; reason: string };

export async function readDurableRunSummary(path: string): Promise<DurableRunSummaryReadResult> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing', path };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    assertDurableRunSummary(parsed);
    return { kind: 'valid', path, summary: parsed };
  } catch (error) {
    return { kind: 'invalid', path, reason: error instanceof Error ? error.message : 'summary is invalid' };
  }
}

export async function findDurableRunSummariesForIssue(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issueNumber: number;
  sessionId?: string;
}): Promise<DurableRunSummaryReadResult[]> {
  const summariesDir = join(input.targetRoot, input.config.runner.stateDir, 'summaries');
  if (input.sessionId) {
    return [await readDurableRunSummary(join(summariesDir, `issue-${input.issueNumber}-${input.sessionId}.json`))];
  }
  let entries: string[];
  try {
    entries = await readdir(summariesDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const prefix = `issue-${input.issueNumber}-`;
  const paths = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))
    .sort()
    .map((entry) => join(summariesDir, entry));
  return Promise.all(paths.map((path) => readDurableRunSummary(path)));
}

export async function writeDurableRunSummary(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issueNumber: number;
  sessionId: string;
  outcome: DurableRunSummary['outcome'];
  changedFiles: string[];
  validation: RunnerValidationLine[];
  blockers: string[];
  skippedChecks: string[];
  residualRisks: string[];
  policySuggestions?: string[];
  suggestionEvidence?: string[];
  nextAction: string;
  logPath: string;
  reportPath: string;
  reworkAttempts?: ReworkAttemptEvidence[];
  acceptanceProof?: AcceptanceProofAttemptEvidence;
}): Promise<DurableRunSummaryEvidence | undefined> {
  if (!input.config.loopPolicy.durableRunSummaries.enabled) {
    return undefined;
  }

  const summary: DurableRunSummary = {
    issueNumber: input.issueNumber,
    sessionId: input.sessionId,
    outcome: input.outcome,
    changedFiles: input.changedFiles,
    confirmedFacts: buildConfirmedFacts(input),
    validation: input.validation,
    blockers: input.blockers,
    skippedChecks: input.skippedChecks,
    residualRisks: input.residualRisks,
    policySuggestions: input.policySuggestions ?? buildPolicySuggestions(input),
    nextAction: input.nextAction,
    evidence: {
      logPath: input.logPath,
      reportPath: input.reportPath,
    },
    reworkAttempts: input.reworkAttempts && input.reworkAttempts.length > 0 ? input.reworkAttempts : undefined,
    acceptanceProof: input.acceptanceProof,
  };
  const path = join(
    input.targetRoot,
    input.config.runner.stateDir,
    'summaries',
    `issue-${input.issueNumber}-${input.sessionId}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  return {
    path,
    excerpt: [
      `outcome: ${summary.outcome}`,
      `next action: ${summary.nextAction}`,
      `confirmed facts: ${summary.confirmedFacts.length === 0 ? 'none' : summary.confirmedFacts.join('; ')}`,
      `residual risks: ${summary.residualRisks.length === 0 ? 'none' : summary.residualRisks.join('; ')}`,
      `rework attempts: ${summary.reworkAttempts?.length ?? 0}`,
      `acceptance proof: ${formatAcceptanceProofStatus(summary)}`,
      `policy suggestions: ${summary.policySuggestions.length === 0 ? 'none' : summary.policySuggestions.join('; ')}`,
    ],
  };
}

function formatAcceptanceProofStatus(summary: DurableRunSummary): string {
  if (summary.acceptanceProof) {
    return summary.acceptanceProof.status;
  }
  if (summary.outcome === 'review-ready') {
    return 'satisfied-by-validation';
  }
  return 'not-run';
}

function buildPolicySuggestions(input: {
  config: CodexOrchestratorConfig;
  blockers: string[];
  skippedChecks: string[];
  residualRisks: string[];
  suggestionEvidence?: string[];
}): string[] {
  if (!input.config.loopPolicy.policySuggestions.enabled) {
    return [];
  }

  const suggestions = [
    ...input.blockers.map((blocker) =>
      `Non-mutating recommendation: review Loop Policy or prompt guidance for repeated blocker: ${blocker}`),
    ...input.skippedChecks.map((check) =>
      `Non-mutating recommendation: decide whether skipped evidence should become a configured check: ${check}`),
    ...(input.suggestionEvidence ?? []).map((evidence) =>
      `Non-mutating recommendation: review Fresh-Context Review evidence for policy follow-up: ${evidence}`),
    ...input.residualRisks
      .filter((risk) => /policy|prompt|config|check|review/iu.test(risk))
      .map((risk) => `Non-mutating recommendation: consider policy follow-up for residual risk: ${risk}`),
  ];
  return [...new Set(suggestions)].slice(0, input.config.loopPolicy.policySuggestions.maxSuggestions);
}

function buildConfirmedFacts(input: {
  changedFiles: string[];
  validation: RunnerValidationLine[];
  blockers: string[];
}): string[] {
  const facts: string[] = [];
  if (input.changedFiles.length > 0) {
    facts.push(`${input.changedFiles.length} changed file(s) detected`);
  }
  const passedValidation = input.validation.filter((line) => line.status === 'passed');
  if (passedValidation.length > 0) {
    facts.push(`${passedValidation.length} validation check(s) passed`);
  }
  if (input.blockers.length > 0) {
    facts.push(`${input.blockers.length} blocker(s) recorded`);
  }
  return facts;
}

function assertDurableRunSummary(value: unknown): asserts value is DurableRunSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('durable run summary must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.issueNumber)) {
    throw new Error('durable run summary issueNumber must be an integer');
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
    throw new Error('durable run summary sessionId must be a non-empty string');
  }
  if (record.outcome !== 'review-ready' && record.outcome !== 'blocked' && record.outcome !== 'promotion-requested') {
    throw new Error('durable run summary outcome is invalid');
  }
  assertStringArray(record.changedFiles, 'changedFiles');
  assertStringArray(record.confirmedFacts, 'confirmedFacts');
  assertValidation(record.validation);
  assertStringArray(record.blockers, 'blockers');
  assertStringArray(record.skippedChecks, 'skippedChecks');
  assertStringArray(record.residualRisks, 'residualRisks');
  assertStringArray(record.policySuggestions, 'policySuggestions');
  if (typeof record.nextAction !== 'string') {
    throw new Error('durable run summary nextAction must be a string');
  }
  if (typeof record.evidence !== 'object' || record.evidence === null || Array.isArray(record.evidence)) {
    throw new Error('durable run summary evidence must be an object');
  }
  const evidence = record.evidence as Record<string, unknown>;
  if (typeof evidence.logPath !== 'string' || evidence.logPath.length === 0) {
    throw new Error('durable run summary evidence.logPath must be a non-empty string');
  }
  if (typeof evidence.reportPath !== 'string' || evidence.reportPath.length === 0) {
    throw new Error('durable run summary evidence.reportPath must be a non-empty string');
  }
}

function assertStringArray(value: unknown, key: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`durable run summary ${key} must be a string array`);
  }
}

function assertValidation(value: unknown): asserts value is RunnerValidationLine[] {
  if (!Array.isArray(value)) {
    throw new Error('durable run summary validation must be an array');
  }
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('durable run summary validation item must be an object');
    }
    const record = item as Record<string, unknown>;
    if (typeof record.command !== 'string' || !['passed', 'failed', 'skipped'].includes(String(record.status)) || typeof record.summary !== 'string') {
      throw new Error('durable run summary validation item is malformed');
    }
  }
}
