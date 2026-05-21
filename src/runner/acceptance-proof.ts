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

export type UiEvidenceFailureDimension =
  | 'workflow'
  | 'viewport'
  | 'freshness'
  | 'layout'
  | 'copy'
  | 'source-input';

export const uiEvidenceFailureDimensions: UiEvidenceFailureDimension[] = [
  'workflow',
  'viewport',
  'freshness',
  'layout',
  'copy',
  'source-input',
];

export interface AcceptanceProofUiEvidence {
  workflowScope: {
    entrypoint: string;
    path: string[];
    screenState: string;
    authPath?: 'real-login' | 'seeded-session' | 'not-required' | 'blocked';
    authShortcutReason?: string;
  };
  viewportCoverage: Array<{
    name: string;
    width: number;
    height: number;
    artifactRefs: string[];
    requiredBy: 'desktop-web-layout' | 'mobile-or-responsive' | 'issue-specific' | 'other';
  }>;
  artifactFreshness: {
    currentArtifactRefs: string[];
    checkedAfterFinalRun: boolean;
  };
  layoutReview: {
    checked: boolean;
    findings: Array<{ summary: string; artifactRefs: string[] }>;
  };
  copyReview: {
    checked: boolean;
    acceptedTerms?: string[];
    rejectedTermsAbsent?: string[];
    findings: Array<{ summary: string; artifactRefs: string[] }>;
  };
  sourceInputs: {
    acceptanceCriteriaRefs: string[];
    implementationEvidenceRefs: string[];
    reproductionSignalRefs?: string[];
    manualQaPlanRefs?: string[];
    runtimeValidationRefs?: string[];
  };
}

export interface AcceptanceProofReport {
  status: AcceptanceProofStatus;
  criteria: AcceptanceProofCriterion[];
  artifacts: AcceptanceProofArtifact[];
  uiEvidence?: AcceptanceProofUiEvidence;
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

  validateUiEvidence({
    report: input.report,
    artifactRefs,
    reasons,
  });

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

function validateUiEvidence(input: {
  report: AcceptanceProofReport;
  artifactRefs: Set<string>;
  reasons: string[];
}): void {
  const uiProofRequired = input.report.artifacts.some((artifact) => artifact.type === 'screenshot' || artifact.type === 'ui-dump');
  if (!uiProofRequired && input.report.uiEvidence === undefined) {
    return;
  }

  const uiEvidence = input.report.uiEvidence;
  if (!uiEvidence) {
    for (const dimension of uiEvidenceFailureDimensions) {
      addUiEvidenceReason(input.reasons, dimension, 'UI artifacts require a complete UI Evidence Contract.');
    }
    return;
  }

  validateWorkflowScope(input.report, uiEvidence, input.reasons);
  validateViewportCoverage(uiEvidence, input.artifactRefs, input.reasons);
  validateArtifactFreshness(uiEvidence, input.artifactRefs, input.reasons);
  validateLayoutReview(uiEvidence, input.artifactRefs, input.reasons);
  validateCopyReview(uiEvidence, input.artifactRefs, input.reasons);
  validateSourceInputs(uiEvidence, input.reasons);
}

function validateWorkflowScope(
  report: AcceptanceProofReport,
  uiEvidence: AcceptanceProofUiEvidence,
  reasons: string[],
): void {
  const workflowScope = valueRecord(uiEvidence.workflowScope);
  if (!workflowScope) {
    addUiEvidenceReason(reasons, 'workflow', 'workflowScope is required.');
    return;
  }
  if (!nonEmptyString(workflowScope.entrypoint)) {
    addUiEvidenceReason(reasons, 'workflow', 'workflowScope.entrypoint is required.');
  }
  if (!nonEmptyString(workflowScope.screenState)) {
    addUiEvidenceReason(reasons, 'workflow', 'workflowScope.screenState is required.');
  }
  if (!nonEmptyStringArray(workflowScope.path)) {
    addUiEvidenceReason(reasons, 'workflow', 'workflowScope.path must include the user path to the screen.');
  }
  const authPath = workflowScope.authPath;
  if (authPath !== undefined && !['real-login', 'seeded-session', 'not-required', 'blocked'].includes(String(authPath))) {
    addUiEvidenceReason(reasons, 'workflow', 'workflowScope.authPath is invalid.');
  }
  if (authPath === 'seeded-session' && !nonEmptyString(workflowScope.authShortcutReason)) {
    addUiEvidenceReason(reasons, 'workflow', 'seeded-session auth requires authShortcutReason.');
  }
  if (authPath === 'blocked' && report.status === 'passed') {
    addUiEvidenceReason(reasons, 'workflow', 'blocked auth cannot accompany a passed proof report.');
  }
}

function validateViewportCoverage(
  uiEvidence: AcceptanceProofUiEvidence,
  artifactRefs: Set<string>,
  reasons: string[],
): void {
  const viewportCoverage = uiEvidence.viewportCoverage as unknown;
  if (!Array.isArray(viewportCoverage) || viewportCoverage.length === 0) {
    addUiEvidenceReason(reasons, 'viewport', 'viewportCoverage must include at least one viewport.');
    return;
  }
  const requiredByValues = ['desktop-web-layout', 'mobile-or-responsive', 'issue-specific', 'other'];
  for (const [index, viewport] of viewportCoverage.entries()) {
    const record = valueRecord(viewport);
    if (!record) {
      addUiEvidenceReason(reasons, 'viewport', `viewportCoverage[${index}] must be an object.`);
      continue;
    }
    if (!nonEmptyString(record.name)) {
      addUiEvidenceReason(reasons, 'viewport', `viewportCoverage[${index}].name is required.`);
    }
    if (!positiveInteger(record.width) || !positiveInteger(record.height)) {
      addUiEvidenceReason(reasons, 'viewport', `viewportCoverage[${index}] must include positive integer width and height.`);
    }
    if (!requiredByValues.includes(String(record.requiredBy))) {
      addUiEvidenceReason(reasons, 'viewport', `viewportCoverage[${index}].requiredBy is invalid.`);
    }
    if (record.requiredBy === 'desktop-web-layout' && positiveInteger(record.width) && Number(record.width) < 1280) {
      addUiEvidenceReason(reasons, 'viewport', 'desktop-web-layout viewport width must be at least 1280.');
    }
    validateMappedRefs(record.artifactRefs, artifactRefs, reasons, 'viewport', `viewportCoverage[${index}].artifactRefs`);
  }
}

function validateArtifactFreshness(
  uiEvidence: AcceptanceProofUiEvidence,
  artifactRefs: Set<string>,
  reasons: string[],
): void {
  const freshness = valueRecord(uiEvidence.artifactFreshness);
  if (!freshness) {
    addUiEvidenceReason(reasons, 'freshness', 'artifactFreshness is required.');
    return;
  }
  if (freshness.checkedAfterFinalRun !== true) {
    addUiEvidenceReason(reasons, 'freshness', 'artifactFreshness.checkedAfterFinalRun must be true.');
  }
  validateMappedRefs(freshness.currentArtifactRefs, artifactRefs, reasons, 'freshness', 'artifactFreshness.currentArtifactRefs');
}

function validateLayoutReview(
  uiEvidence: AcceptanceProofUiEvidence,
  artifactRefs: Set<string>,
  reasons: string[],
): void {
  const layoutReview = valueRecord(uiEvidence.layoutReview);
  if (!layoutReview) {
    addUiEvidenceReason(reasons, 'layout', 'layoutReview is required.');
    return;
  }
  if (layoutReview.checked !== true) {
    addUiEvidenceReason(reasons, 'layout', 'layoutReview.checked must be true.');
  }
  validateMappedFindings(layoutReview.findings, artifactRefs, reasons, 'layout', 'layoutReview.findings');
}

function validateCopyReview(
  uiEvidence: AcceptanceProofUiEvidence,
  artifactRefs: Set<string>,
  reasons: string[],
): void {
  const copyReview = valueRecord(uiEvidence.copyReview);
  if (!copyReview) {
    addUiEvidenceReason(reasons, 'copy', 'copyReview is required.');
    return;
  }
  if (copyReview.checked !== true) {
    addUiEvidenceReason(reasons, 'copy', 'copyReview.checked must be true.');
  }
  validateOptionalStringArray(copyReview.acceptedTerms, reasons, 'copy', 'copyReview.acceptedTerms');
  validateOptionalStringArray(copyReview.rejectedTermsAbsent, reasons, 'copy', 'copyReview.rejectedTermsAbsent');
  validateMappedFindings(copyReview.findings, artifactRefs, reasons, 'copy', 'copyReview.findings');
}

function validateSourceInputs(uiEvidence: AcceptanceProofUiEvidence, reasons: string[]): void {
  const sourceInputs = valueRecord(uiEvidence.sourceInputs);
  if (!sourceInputs) {
    addUiEvidenceReason(reasons, 'source-input', 'sourceInputs is required.');
    return;
  }
  if (!nonEmptyStringArray(sourceInputs.acceptanceCriteriaRefs)) {
    addUiEvidenceReason(reasons, 'source-input', 'sourceInputs.acceptanceCriteriaRefs is required.');
  }
  if (!nonEmptyStringArray(sourceInputs.implementationEvidenceRefs)) {
    addUiEvidenceReason(reasons, 'source-input', 'sourceInputs.implementationEvidenceRefs is required.');
  }
  for (const key of ['reproductionSignalRefs', 'manualQaPlanRefs', 'runtimeValidationRefs']) {
    validateOptionalStringArray(sourceInputs[key], reasons, 'source-input', `sourceInputs.${key}`);
  }
}

function validateMappedFindings(
  value: unknown,
  artifactRefs: Set<string>,
  reasons: string[],
  dimension: UiEvidenceFailureDimension,
  label: string,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    addUiEvidenceReason(reasons, dimension, `${label} must include at least one mapped finding.`);
    return;
  }
  for (const [index, finding] of value.entries()) {
    const record = valueRecord(finding);
    if (!record) {
      addUiEvidenceReason(reasons, dimension, `${label}[${index}] must be an object.`);
      continue;
    }
    if (!nonEmptyString(record.summary)) {
      addUiEvidenceReason(reasons, dimension, `${label}[${index}].summary is required.`);
    }
    validateMappedRefs(record.artifactRefs, artifactRefs, reasons, dimension, `${label}[${index}].artifactRefs`);
  }
}

function validateMappedRefs(
  value: unknown,
  artifactRefs: Set<string>,
  reasons: string[],
  dimension: UiEvidenceFailureDimension,
  label: string,
): void {
  if (!nonEmptyStringArray(value)) {
    addUiEvidenceReason(reasons, dimension, `${label} must include at least one artifact reference.`);
    return;
  }
  const missingRefs = value.filter((ref) => !artifactRefs.has(ref));
  if (missingRefs.length > 0) {
    addUiEvidenceReason(reasons, dimension, `${label} references missing artifact(s): ${missingRefs.join(', ')}.`);
  }
}

function validateOptionalStringArray(
  value: unknown,
  reasons: string[],
  dimension: UiEvidenceFailureDimension,
  label: string,
): void {
  if (value === undefined) {
    return;
  }
  if (!nonEmptyStringArray(value)) {
    addUiEvidenceReason(reasons, dimension, `${label} must be a non-empty string array when present.`);
  }
}

function addUiEvidenceReason(reasons: string[], dimension: UiEvidenceFailureDimension, reason: string): void {
  reasons.push(`UI Evidence ${dimension}: ${reason}`);
}

function valueRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function positiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
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
  if ('uiEvidence' in record && valueRecord(record.uiEvidence) === undefined) {
    throw new Error('Invalid acceptance proof report: uiEvidence must be an object');
  }
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
