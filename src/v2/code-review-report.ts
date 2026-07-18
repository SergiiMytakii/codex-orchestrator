import { createHash } from 'node:crypto';

import { canonicalJson } from './containment.js';
import { agentReportEnvelopeSchema } from './report-envelope.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_ITEMS = 256;
const MAX_TEXT = 16 * 1024;

export type ReviewOperation = 'code-review';
export type ReviewMode = 'full' | 'closure';
export type ReviewVerdict = 'approved' | 'needs-work' | 'rejected';
export type ReviewClass = 'blocker' | 'execution-risk' | 'improvement';
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewStatus = 'open' | 'fixed' | 'verified' | 'reopened' | 'superseded';

export interface CodeReviewDefectV1 {
  id: string;
  class: ReviewClass;
  severity: ReviewSeverity;
  confidence: 'high' | 'medium' | 'low';
  status: ReviewStatus;
  invariant: string;
  failure: string;
  evidence: string[];
  repair: string;
  affectedTargets: string[];
  introducedTargetRevision: number;
  statusTargetRevision: number;
  supersededBy: string | null;
}

export interface RepairFindingOutcomeV1 {
  id: string;
  status: 'verified' | 'reopened';
}

export interface CodeReviewReportV1 {
  version: 1;
  operation: ReviewOperation;
  targetRevision: number;
  targetFingerprint: string;
  verdict: ReviewVerdict;
  mode: ReviewMode;
  coverage: string[];
  defects: CodeReviewDefectV1[];
  residualRisks: string[];
  reviewerSessionId: string;
  closureRequestSha256: string | null;
  repairFindingOutcomes: RepairFindingOutcomeV1[];
}

export interface CodeReviewValidationContext {
  operation: ReviewOperation;
  mode: ReviewMode;
  targetRevision: number;
  targetFingerprint: string;
  reviewerSessionId: string;
  closureRequestSha256: string | null;
  fixedRepairFindingIds?: string[];
  mandatoryCoverage?: string[];
}

export interface ClosureRequestInput {
  operation: ReviewOperation;
  targetRevision: number;
  targetFingerprint: string;
  affectedDefectIds: string[];
  fixedRepairFindings: Array<{ id: string; affectedContracts: string[] }>;
  mandatoryCoverage: string[];
}

export function hashClosureRequest(input: ClosureRequestInput): string {
  assertOperation(input.operation);
  assertPositiveInteger(input.targetRevision, 'closure request.targetRevision');
  assertSha256(input.targetFingerprint, 'closure request.targetFingerprint');
  const affectedDefectIds = sortedUniqueStrings(input.affectedDefectIds, 'closure request.affectedDefectIds');
  const mandatoryCoverage = sortedUniqueStrings(input.mandatoryCoverage, 'closure request.mandatoryCoverage');
  if (!Array.isArray(input.fixedRepairFindings) || input.fixedRepairFindings.length > MAX_ITEMS) {
    throw new Error('closure request.fixedRepairFindings is invalid');
  }
  const fixedRepairFindings = input.fixedRepairFindings.map((finding) => {
    assertExactObject(finding, ['id', 'affectedContracts'], 'closure request fixed finding');
    assertText(finding.id, 'closure request fixed finding.id');
    return {
      id: finding.id,
      affectedContracts: sortedUniqueStrings(finding.affectedContracts, 'closure request fixed finding.affectedContracts'),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(fixedRepairFindings.map((finding) => finding.id), 'closure request fixed finding IDs');
  return domainHash('codex-orchestrator-review-closure-v1', canonicalJson({
    operation: input.operation,
    targetRevision: input.targetRevision,
    targetFingerprint: input.targetFingerprint,
    affectedDefectIds,
    fixedRepairFindings,
    mandatoryCoverage,
  }));
}

export function hashCodeReviewReport(report: CodeReviewReportV1): string {
  return domainHash('codex-orchestrator-code-review-report-v1', canonicalJson(report));
}

export function validateCodeReviewReport(value: unknown, context: CodeReviewValidationContext): CodeReviewReportV1 {
  assertExactObject(value, [
    'version', 'operation', 'targetRevision', 'targetFingerprint', 'verdict', 'mode', 'coverage', 'defects',
    'residualRisks', 'reviewerSessionId', 'closureRequestSha256', 'repairFindingOutcomes',
  ], 'code review report');
  if (value.version !== 1) throw new Error('code review report.version is invalid');
  assertOperation(value.operation);
  assertPositiveInteger(value.targetRevision, 'code review report.targetRevision');
  assertSha256(value.targetFingerprint, 'code review report.targetFingerprint');
  if (!['approved', 'needs-work', 'rejected'].includes(value.verdict as string)) throw new Error('code review report.verdict is invalid');
  if (value.mode !== 'full' && value.mode !== 'closure') throw new Error('code review report.mode is invalid');
  const coverage = sortedUniqueStrings(value.coverage, 'code review report.coverage');
  const mandatoryCoverage = sortedUniqueStrings(context.mandatoryCoverage ?? [], 'code review mandatory coverage');
  if (!mandatoryCoverage.every((item) => coverage.includes(item))) throw new Error('code review report is missing mandatory coverage');
  const residualRisks = sortedUniqueStrings(value.residualRisks, 'code review report.residualRisks');
  assertText(value.reviewerSessionId, 'code review report.reviewerSessionId');
  if (value.closureRequestSha256 !== null) assertSha256(value.closureRequestSha256, 'code review report.closureRequestSha256');
  if (value.operation !== context.operation || value.mode !== context.mode || value.targetRevision !== context.targetRevision
    || value.targetFingerprint !== context.targetFingerprint || value.reviewerSessionId !== context.reviewerSessionId
    || value.closureRequestSha256 !== context.closureRequestSha256) {
    throw new Error('code review report correlation mismatch');
  }
  const defects = validateDefects(value.defects, value.targetRevision as number);
  const repairFindingOutcomes = validateRepairFindingOutcomes(value.repairFindingOutcomes);
  const expectedFindingIds = [...(context.fixedRepairFindingIds ?? [])].sort();
  if (context.mode === 'full') {
    if (value.closureRequestSha256 !== null || repairFindingOutcomes.length !== 0 || expectedFindingIds.length !== 0) {
      throw new Error('Full review cannot contain Closure correlation');
    }
  } else {
    if (value.closureRequestSha256 === null) throw new Error('Closure review requires correlation hash');
    const actual = repairFindingOutcomes.map((outcome) => outcome.id);
    if (!sameStrings(actual, expectedFindingIds)) throw new Error('Closure repair finding outcomes must match sorted request IDs');
  }
  const unresolved = defects.some((defect) => (defect.class === 'blocker' || defect.class === 'execution-risk')
    && defect.status !== 'verified' && defect.status !== 'superseded');
  if (value.verdict === 'approved' && (unresolved || repairFindingOutcomes.some((outcome) => outcome.status === 'reopened'))) {
    throw new Error('approved review has unresolved defects or repair findings');
  }
  return {
    ...(structuredClone(value) as unknown as CodeReviewReportV1),
    coverage,
    defects,
    residualRisks,
    repairFindingOutcomes,
  };
}

export function validateCodeReviewDefects(value: unknown, targetRevision: number): CodeReviewDefectV1[] {
  assertPositiveInteger(targetRevision, 'code review defect ledger target revision');
  return validateDefects(value, targetRevision);
}

export function codeReviewReportOutputSchema(): Record<string, unknown> {
  const text = { type: 'string', minLength: 1, maxLength: MAX_TEXT };
  const stringList = { type: 'array', maxItems: MAX_ITEMS, items: text };
  const defect = {
    type: 'object', additionalProperties: false,
    required: [
      'id', 'class', 'severity', 'confidence', 'status', 'invariant', 'failure', 'evidence', 'repair',
      'affectedTargets', 'introducedTargetRevision', 'statusTargetRevision', 'supersededBy',
    ],
    properties: {
      id: text,
      class: { type: 'string', enum: ['blocker', 'execution-risk', 'improvement'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      status: { type: 'string', enum: ['open', 'fixed', 'verified', 'reopened', 'superseded'] },
      invariant: text, failure: text, evidence: stringList, repair: text, affectedTargets: stringList,
      introducedTargetRevision: { type: 'integer', minimum: 1 },
      statusTargetRevision: { type: 'integer', minimum: 1 },
      supersededBy: { anyOf: [text, { type: 'null' }] },
    },
  };
  const report = {
    type: 'object', additionalProperties: false,
    required: [
      'version', 'operation', 'targetRevision', 'targetFingerprint', 'verdict', 'mode', 'coverage', 'defects',
      'residualRisks', 'reviewerSessionId', 'closureRequestSha256', 'repairFindingOutcomes',
    ],
    properties: {
      version: { type: 'integer', const: 1 },
      operation: { type: 'string', const: 'code-review' },
      targetRevision: { type: 'integer', minimum: 1 },
      targetFingerprint: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      verdict: { type: 'string', enum: ['approved', 'needs-work', 'rejected'] },
      mode: { type: 'string', enum: ['full', 'closure'] },
      coverage: stringList,
      defects: { type: 'array', maxItems: MAX_ITEMS, items: defect },
      residualRisks: stringList,
      reviewerSessionId: text,
      closureRequestSha256: { anyOf: [{ type: 'string', pattern: '^[0-9a-f]{64}$' }, { type: 'null' }] },
      repairFindingOutcomes: {
        type: 'array', maxItems: MAX_ITEMS,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'status'],
          properties: { id: text, status: { type: 'string', enum: ['verified', 'reopened'] } },
        },
      },
    },
  };
  return agentReportEnvelopeSchema(report);
}

function validateDefects(value: unknown, targetRevision: number): CodeReviewDefectV1[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('code review report.defects is invalid');
  const defects = value.map((item, index) => {
    assertExactObject(item, [
      'id', 'class', 'severity', 'confidence', 'status', 'invariant', 'failure', 'evidence', 'repair',
      'affectedTargets', 'introducedTargetRevision', 'statusTargetRevision', 'supersededBy',
    ], `code review defect[${index}]`);
    for (const field of ['id', 'invariant', 'failure', 'repair'] as const) assertText(item[field], `code review defect.${field}`);
    if (!['blocker', 'execution-risk', 'improvement'].includes(item.class as string)) throw new Error('code review defect.class is invalid');
    if (!['critical', 'high', 'medium', 'low'].includes(item.severity as string)) throw new Error('code review defect.severity is invalid');
    if (!['high', 'medium', 'low'].includes(item.confidence as string)) throw new Error('code review defect.confidence is invalid');
    if (!['open', 'fixed', 'verified', 'reopened', 'superseded'].includes(item.status as string)) throw new Error('code review defect.status is invalid');
    const evidence = sortedUniqueStrings(item.evidence, 'code review defect.evidence');
    const affectedTargets = sortedUniqueStrings(item.affectedTargets, 'code review defect.affectedTargets');
    assertPositiveInteger(item.introducedTargetRevision, 'code review defect.introducedTargetRevision');
    assertPositiveInteger(item.statusTargetRevision, 'code review defect.statusTargetRevision');
    if ((item.introducedTargetRevision as number) > (item.statusTargetRevision as number)
      || (item.statusTargetRevision as number) > targetRevision) throw new Error('code review defect revisions are invalid');
    if (item.status === 'superseded') assertText(item.supersededBy, 'code review defect.supersededBy');
    else if (item.supersededBy !== null) throw new Error('non-superseded defect has replacement');
    return { ...(structuredClone(item) as unknown as CodeReviewDefectV1), evidence, affectedTargets };
  });
  assertUnique(defects.map((defect) => defect.id), 'code review defect IDs');
  validateSupersession(defects);
  return defects;
}

function validateSupersession(defects: CodeReviewDefectV1[]): void {
  const byId = new Map(defects.map((defect) => [defect.id, defect]));
  for (const defect of defects) {
    if (defect.status !== 'superseded') continue;
    const seen = new Set([defect.id]);
    let current = defect;
    while (current.status === 'superseded') {
      const nextId = current.supersededBy!;
      if (seen.has(nextId)) throw new Error('defect supersession cycle is invalid');
      seen.add(nextId);
      const next = byId.get(nextId);
      if (!next) throw new Error('defect supersession replacement is missing');
      current = next;
    }
  }
}

function validateRepairFindingOutcomes(value: unknown): RepairFindingOutcomeV1[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('repair finding outcomes are invalid');
  const output = value.map((item, index) => {
    assertExactObject(item, ['id', 'status'], `repair finding outcome[${index}]`);
    assertText(item.id, 'repair finding outcome.id');
    if (item.status !== 'verified' && item.status !== 'reopened') throw new Error('repair finding outcome.status is invalid');
    return structuredClone(item) as unknown as RepairFindingOutcomeV1;
  });
  const ids = output.map((item) => item.id);
  assertUnique(ids, 'repair finding outcome IDs');
  if (!sameStrings(ids, [...ids].sort())) throw new Error('repair finding outcomes must be sorted');
  return output;
}

function sortedUniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`${field} is invalid`);
  for (const item of value) assertText(item, `${field} entry`);
  const output = [...value as string[]].sort();
  assertUnique(output, field);
  return output;
}

function assertOperation(value: unknown): asserts value is ReviewOperation {
  if (value !== 'code-review') throw new Error('review operation is invalid');
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} is invalid`);
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${field} is invalid`);
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) throw new Error(`${field} is invalid`);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameStrings(actual, expected)) throw new Error(`${field} has unknown or missing keys`);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function domainHash(domain: string, payload: string): string {
  return createHash('sha256').update(`${domain}\0${payload}`, 'utf8').digest('hex');
}
