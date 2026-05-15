import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
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
}

export interface DurableRunSummaryEvidence {
  path: string;
  excerpt: string[];
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
      `policy suggestions: ${summary.policySuggestions.length === 0 ? 'none' : summary.policySuggestions.join('; ')}`,
    ],
  };
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
