import { readFile } from 'node:fs/promises';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import { globMatches, normalizePath } from '../path-policy.js';
import { scopedArtifactTypes, type ScopedArtifactType } from './completion-report.js';

export type AcceptanceProofStatus = 'passed' | 'needs-rework' | 'blocked';
export type AcceptanceCriterionStatus = 'passed' | 'failed' | 'unknown';
export type AcceptanceProofConfidence = 'high' | 'medium' | 'low';
export type AcceptanceProofArtifactType = ScopedArtifactType;

export interface AcceptanceProofArtifact {
  type: AcceptanceProofArtifactType;
  path?: string;
  url?: string;
  description: string;
}

export interface AcceptanceProofCriterion {
  id: string;
  description: string;
  status: AcceptanceCriterionStatus;
  confidence: AcceptanceProofConfidence;
  reasoningSummary: string;
  artifactRefs: string[];
}

export interface AcceptanceProofReport {
  status: AcceptanceProofStatus;
  criteria: AcceptanceProofCriterion[];
  artifacts: AcceptanceProofArtifact[];
  proofScriptRepair?: {
    changedPaths: string[];
    summary: string;
  };
  proofPhaseDiff: {
    allowedProofPaths: string[];
    forbiddenProductPaths: string[];
  };
  reworkRequest?: {
    summary: string;
    requiredChanges: string[];
    evidenceRefs: string[];
  };
  residualRisks: string[];
}

export interface AcceptanceProofEvaluationInput {
  config: CodexOrchestratorConfig;
  report: AcceptanceProofReport;
  proofPhaseChangedFiles: string[];
  artifactExists?: (path: string) => boolean;
}

export interface AcceptanceProofEvaluationResult {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

export type AcceptanceProofReportReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'valid'; report: AcceptanceProofReport };

export async function readAcceptanceProofReport(path: string): Promise<AcceptanceProofReportReadResult> {
  let content = '';
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    assertAcceptanceProofReport(parsed);
    return { kind: 'valid', report: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid acceptance proof report';
    return { kind: 'invalid', message };
  }
}

export function evaluateAcceptanceProofReport(input: AcceptanceProofEvaluationInput): AcceptanceProofEvaluationResult {
  const reasons: string[] = [];
  const warnings: string[] = [...input.report.residualRisks];

  if (input.report.status !== 'passed') {
    reasons.push(`Acceptance proof ${input.report.status}: ${input.report.reworkRequest?.summary ?? 'proof did not pass'}`);
  }
  if (input.report.criteria.length === 0) {
    reasons.push('Acceptance proof report has no criteria.');
  }

  const artifactRefs = new Set(input.report.artifacts.flatMap((artifact) => [
    artifact.path,
    artifact.url,
    artifact.description,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)));
  if (input.artifactExists) {
    const missingArtifactPaths = input.report.artifacts
      .map((artifact) => artifact.path)
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
      .filter((path) => !input.artifactExists?.(path));
    if (missingArtifactPaths.length > 0) {
      reasons.push(`Acceptance proof references missing artifact path(s): ${missingArtifactPaths.join(', ')}.`);
    }
  }

  for (const criterion of input.report.criteria) {
    if (criterion.status !== 'passed') {
      reasons.push(`Acceptance proof criterion ${criterion.id} has status ${criterion.status}.`);
    }
    if (criterion.confidence !== 'high') {
      reasons.push(`Acceptance proof criterion ${criterion.id} has confidence ${criterion.confidence}.`);
    }
    if (criterion.artifactRefs.length === 0) {
      reasons.push(`Acceptance proof criterion ${criterion.id} has no artifact evidence.`);
      continue;
    }
    const missingRefs = criterion.artifactRefs.filter((ref) => !artifactRefs.has(ref));
    if (missingRefs.length > 0) {
      reasons.push(`Acceptance proof criterion ${criterion.id} references missing artifact(s): ${missingRefs.join(', ')}.`);
    }
  }

  const forbiddenProductPaths = [
    ...input.report.proofPhaseDiff.forbiddenProductPaths,
    ...classifyAcceptanceProofDiff(input.config, input.proofPhaseChangedFiles).forbiddenProductPaths,
  ];
  const uniqueForbiddenProductPaths = Array.from(new Set(forbiddenProductPaths.map(normalizePath))).sort();
  if (uniqueForbiddenProductPaths.length > 0) {
    reasons.push(`Acceptance proof produced product-code changes during acceptance proof: ${uniqueForbiddenProductPaths.join(', ')}.`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
  };
}

export function classifyAcceptanceProofDiff(
  config: CodexOrchestratorConfig,
  proofPhaseChangedFiles: string[],
): { allowedProofPaths: string[]; forbiddenProductPaths: string[] } {
  const proofOwnedPathGlobs = config.reviewGates.acceptanceProof.proofOwnedPathGlobs;
  const allowedProofPaths: string[] = [];
  const forbiddenProductPaths: string[] = [];

  for (const path of proofPhaseChangedFiles.map(normalizePath)) {
    if (proofOwnedPathGlobs.some((pattern) => globMatches(pattern, path))) {
      allowedProofPaths.push(path);
    } else {
      forbiddenProductPaths.push(path);
    }
  }

  return {
    allowedProofPaths: allowedProofPaths.sort(),
    forbiddenProductPaths: forbiddenProductPaths.sort(),
  };
}

export function assertAcceptanceProofReport(value: unknown): asserts value is AcceptanceProofReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid acceptance proof report: report must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!['passed', 'needs-rework', 'blocked'].includes(String(record.status))) {
    throw new Error('Invalid acceptance proof report: status must be passed, needs-rework, or blocked');
  }
  assertCriteria(record.criteria);
  assertArtifacts(record.artifacts);
  assertProofPhaseDiff(record.proofPhaseDiff);
  assertStringArray(record.residualRisks, 'residualRisks');
}

function assertCriteria(value: unknown): asserts value is AcceptanceProofCriterion[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid acceptance proof report: criteria must be an array');
  }
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Invalid acceptance proof report: criterion must be an object');
    }
    const record = item as Record<string, unknown>;
    for (const key of ['id', 'description', 'reasoningSummary']) {
      if (typeof record[key] !== 'string' || record[key].trim().length === 0) {
        throw new Error(`Invalid acceptance proof report: criterion.${key} must be a non-empty string`);
      }
    }
    if (!['passed', 'failed', 'unknown'].includes(String(record.status))) {
      throw new Error('Invalid acceptance proof report: criterion.status is invalid');
    }
    if (!['high', 'medium', 'low'].includes(String(record.confidence))) {
      throw new Error('Invalid acceptance proof report: criterion.confidence is invalid');
    }
    assertStringArray(record.artifactRefs, 'criterion.artifactRefs');
  }
}

function assertArtifacts(value: unknown): asserts value is AcceptanceProofArtifact[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid acceptance proof report: artifacts must be an array');
  }
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Invalid acceptance proof report: artifact must be an object');
    }
    const record = item as Record<string, unknown>;
    if (!scopedArtifactTypes.includes(record.type as ScopedArtifactType)) {
      throw new Error('Invalid acceptance proof report: artifact.type is invalid');
    }
    if (typeof record.description !== 'string' || record.description.trim().length === 0) {
      throw new Error('Invalid acceptance proof report: artifact.description must be a non-empty string');
    }
    if ('path' in record && typeof record.path !== 'string') {
      throw new Error('Invalid acceptance proof report: artifact.path must be a string');
    }
    if ('url' in record && typeof record.url !== 'string') {
      throw new Error('Invalid acceptance proof report: artifact.url must be a string');
    }
    if (!record.path && !record.url) {
      throw new Error('Invalid acceptance proof report: artifact must include path or url');
    }
  }
}

function assertProofPhaseDiff(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid acceptance proof report: proofPhaseDiff must be an object');
  }
  const record = value as Record<string, unknown>;
  assertStringArray(record.allowedProofPaths, 'proofPhaseDiff.allowedProofPaths');
  assertStringArray(record.forbiddenProductPaths, 'proofPhaseDiff.forbiddenProductPaths');
}

function assertStringArray(value: unknown, key: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid acceptance proof report: ${key} must be a string array`);
  }
}
