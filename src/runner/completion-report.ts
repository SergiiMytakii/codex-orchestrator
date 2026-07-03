import { readFile } from 'node:fs/promises';

import { reviewHandoffFlows, type ReviewHandoffFlow } from '../review-handoff.js';
import type { PlanGraph } from './issue-tree.js';
import { validatePlanGraph } from './issue-tree.js';

export type { ReviewHandoffFlow } from '../review-handoff.js';

export type CompletionStatus = 'completed' | 'needs-promotion';
export type ValidationStatus = 'passed' | 'failed' | 'skipped';
export interface TddRedGreenValidationEvidence {
  kind: 'tdd-red-green';
  red: { command: string; status: 'failed'; summary: string };
  green: { command: string; status: 'passed'; summary: string };
}

export type ValidationEvidence = TddRedGreenValidationEvidence;
export interface ValidationItem {
  command: string;
  status: ValidationStatus;
  summary: string;
  evidence?: ValidationEvidence;
}
export type ReviewHandoffRisk = 'low' | 'medium' | 'high';
export const scopedArtifactTypes = ['screenshot', 'ui-dump', 'log', 'smoke-output', 'other'] as const;
export type ScopedArtifactType = (typeof scopedArtifactTypes)[number];
export type ProhibitedActionType =
  | 'secret-file-read'
  | 'secret-file-change'
  | 'destructive-db-or-cache'
  | 'production-deploy-or-release';

export interface ScopedCompletionReport {
  status: CompletionStatus;
  changes: string[];
  validation: ValidationItem[];
  artifacts: Array<{ type: ScopedArtifactType; path?: string; url?: string; description: string }>;
  skippedChecks: string[];
  residualRisks: string[];
  prohibitedActions: Array<{ type: ProhibitedActionType; description: string }>;
  reviewHandoff?: {
    flowUsed: ReviewHandoffFlow;
    riskLevel: ReviewHandoffRisk;
    implementedContract: string[];
    proofByAcceptanceCriteria: string[];
    reviewFocus: string[];
    humanReviewChecklist: string[];
  };
  promotion?: {
    reason: string;
    criteria: string[];
    evidence: string[];
  };
}

export interface PlanAutoCompletionReport {
  status: 'completed';
  parent: {
    title?: string;
    body: string;
  };
  graph: PlanGraph;
  sizeRisk?: {
    small: string[];
    medium: string[];
    high: string[];
  };
  parentReviewHandoff?: {
    risks: string[];
    proofStrategy: string[];
    humanReviewFocus: string[];
  };
  residualRisks: string[];
}

export type ScopedCompletionReportReadResult =
  | { kind: 'missing' }
  | { kind: 'valid'; report: ScopedCompletionReport };

export type PlanAutoCompletionReportReadResult =
  | { kind: 'missing' }
  | { kind: 'valid'; report: PlanAutoCompletionReport };

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
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && !('artifacts' in parsed)) {
    (parsed as Record<string, unknown>).artifacts = [];
  }
  assertScopedCompletionReport(parsed);
  return { kind: 'valid', report: parsed };
}

export async function readPlanAutoCompletionReport(reportPath: string): Promise<PlanAutoCompletionReportReadResult> {
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
    throw new Error('Invalid plan-auto completion report: report must be valid JSON');
  }
  assertPlanAutoCompletionReport(parsed);
  return { kind: 'valid', report: parsed };
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
  assertArtifacts(record.artifacts);
  assertStringArray(record.skippedChecks, 'skippedChecks');
  assertStringArray(record.residualRisks, 'residualRisks');
  assertProhibitedActions(record.prohibitedActions);
  if ('reviewHandoff' in record) {
    assertReviewHandoff(record.reviewHandoff);
  }
  if (record.status === 'needs-promotion') {
    assertPromotion(record.promotion);
  }
}

function assertReviewHandoff(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid scoped completion report: reviewHandoff must be an object');
  }
  const record = value as Record<string, unknown>;
  const flows = new Set<string>(reviewHandoffFlows);
  const risks = new Set(['low', 'medium', 'high']);
  if (typeof record.flowUsed !== 'string' || !flows.has(record.flowUsed)) {
    throw new Error('Invalid scoped completion report: reviewHandoff.flowUsed is malformed');
  }
  if (typeof record.riskLevel !== 'string' || !risks.has(record.riskLevel)) {
    throw new Error('Invalid scoped completion report: reviewHandoff.riskLevel is malformed');
  }
  assertStringArray(record.implementedContract, 'reviewHandoff.implementedContract');
  assertStringArray(record.proofByAcceptanceCriteria, 'reviewHandoff.proofByAcceptanceCriteria');
  assertStringArray(record.reviewFocus, 'reviewHandoff.reviewFocus');
  assertStringArray(record.humanReviewChecklist, 'reviewHandoff.humanReviewChecklist');
}

function assertPlanAutoCompletionReport(value: unknown): asserts value is PlanAutoCompletionReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid plan-auto completion report: report must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.status !== 'completed') {
    throw new Error('Invalid plan-auto completion report: status must be completed');
  }
  assertPlanParent(record.parent);
  assertPlanGraph(record.graph);
  if ('sizeRisk' in record) {
    assertPlanSizeRisk(record.sizeRisk);
  }
  if ('parentReviewHandoff' in record) {
    assertParentReviewHandoff(record.parentReviewHandoff);
  }
  assertStringArray(record.residualRisks, 'residualRisks', 'Invalid plan-auto completion report');
  const graphValidation = validatePlanGraph(record.graph);
  if (!graphValidation.ok) {
    throw new Error(`Invalid plan-auto completion report: ${graphValidation.errors.join('; ')}`);
  }
}

function assertPlanSizeRisk(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid plan-auto completion report: sizeRisk must be an object');
  }
  const record = value as Record<string, unknown>;
  assertStringArray(record.small, 'sizeRisk.small', 'Invalid plan-auto completion report');
  assertStringArray(record.medium, 'sizeRisk.medium', 'Invalid plan-auto completion report');
  assertStringArray(record.high, 'sizeRisk.high', 'Invalid plan-auto completion report');
}

function assertParentReviewHandoff(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid plan-auto completion report: parentReviewHandoff must be an object');
  }
  const record = value as Record<string, unknown>;
  assertStringArray(record.risks, 'parentReviewHandoff.risks', 'Invalid plan-auto completion report');
  assertStringArray(record.proofStrategy, 'parentReviewHandoff.proofStrategy', 'Invalid plan-auto completion report');
  assertStringArray(record.humanReviewFocus, 'parentReviewHandoff.humanReviewFocus', 'Invalid plan-auto completion report');
}

function assertPlanParent(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid plan-auto completion report: parent must be an object');
  }
  const record = value as Record<string, unknown>;
  if ('title' in record && typeof record.title !== 'string') {
    throw new Error('Invalid plan-auto completion report: parent.title must be a string');
  }
  if (typeof record.body !== 'string' || record.body.trim().length === 0) {
    throw new Error('Invalid plan-auto completion report: parent.body must be a non-empty string');
  }
}

function assertPlanGraph(value: unknown): asserts value is PlanGraph {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid plan-auto completion report: graph must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.nodes)) {
    throw new Error('Invalid plan-auto completion report: graph.nodes must be an array');
  }
  if (!Array.isArray(record.edges)) {
    throw new Error('Invalid plan-auto completion report: graph.edges must be an array');
  }
  if (record.specGate !== 'wave-level') {
    throw new Error('Invalid plan-auto completion report: graph.specGate must be wave-level');
  }
  for (const item of record.nodes) {
    assertPlanChildNode(item);
  }
  for (const item of record.edges) {
    assertPlanDependencyEdge(item);
  }
}

function assertPlanChildNode(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid plan-auto completion report: graph node must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of ['stableId', 'title', 'body']) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      throw new Error(`Invalid plan-auto completion report: graph node ${key} must be a non-empty string`);
    }
  }
  if ('issueNumber' in record && !Number.isInteger(record.issueNumber)) {
    throw new Error('Invalid plan-auto completion report: graph node issueNumber must be an integer');
  }
  if (record.afkHitl !== 'afk' && record.afkHitl !== 'hitl') {
    throw new Error('Invalid plan-auto completion report: graph node afkHitl must be afk or hitl');
  }
  assertStringArray(record.ownershipScope, 'ownershipScope', 'Invalid plan-auto completion report');
  assertStringArray(record.dependsOn, 'dependsOn', 'Invalid plan-auto completion report');
  assertStringArray(record.verification, 'verification', 'Invalid plan-auto completion report');
}

function assertPlanDependencyEdge(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid plan-auto completion report: graph edge must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of ['from', 'to', 'reason']) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      throw new Error(`Invalid plan-auto completion report: graph edge ${key} must be a non-empty string`);
    }
  }
}

function assertStringArray(value: unknown, key: string, prefix = 'Invalid scoped completion report'): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${prefix}: ${key} must be a string array`);
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
    if ('evidence' in record) {
      assertValidationEvidence(record.evidence);
    }
  }
}

function assertValidationEvidence(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid scoped completion report: validation evidence must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== 'tdd-red-green') {
    throw new Error('Invalid scoped completion report: validation evidence kind is unsupported');
  }
  assertTddEvidenceEndpoint(record.red, 'red', 'failed');
  assertTddEvidenceEndpoint(record.green, 'green', 'passed');
}

function assertTddEvidenceEndpoint(value: unknown, key: 'red' | 'green', expectedStatus: 'failed' | 'passed'): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid scoped completion report: validation evidence ${key} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.command !== 'string' || record.command.trim().length === 0) {
    throw new Error(`Invalid scoped completion report: validation evidence ${key} command must be non-empty`);
  }
  if (record.status !== expectedStatus) {
    throw new Error(`Invalid scoped completion report: validation evidence ${key} status must be ${expectedStatus}`);
  }
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) {
    throw new Error(`Invalid scoped completion report: validation evidence ${key} summary must be non-empty`);
  }
}

function assertArtifacts(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('Invalid scoped completion report: artifacts must be an array');
  }
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Invalid scoped completion report: artifacts item must be an object');
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.type !== 'string'
      || !scopedArtifactTypes.includes(record.type as ScopedArtifactType)
      || typeof record.description !== 'string'
      || record.description.trim().length === 0
    ) {
      throw new Error('Invalid scoped completion report: artifacts item is malformed');
    }
    if ('path' in record && typeof record.path !== 'string') {
      throw new Error('Invalid scoped completion report: artifacts path must be a string');
    }
    if ('url' in record && typeof record.url !== 'string') {
      throw new Error('Invalid scoped completion report: artifacts url must be a string');
    }
    if (!record.path && !record.url) {
      throw new Error('Invalid scoped completion report: artifacts item must include path or url');
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
