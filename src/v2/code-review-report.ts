import { createHash } from 'node:crypto';

import { canonicalJson } from './containment.js';
import { agentReportEnvelopeSchema } from './report-envelope.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_TEXT = 16 * 1024;
export const COMPLETE_REVIEW_COVERAGE = [
  'candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability',
  'repository-standards', 'requirements', 'tests', 'zero-legacy',
] as const;

/** Exact Runner context persisted before launch and reused after restart. */
export function validateReviewContext(value: unknown): CodeReviewValidationContext {
  assertExactObject(value, ['operation', 'targetRevision', 'targetFingerprint', 'reviewerSessionId',
    'previousFindingIds', 'requiredCoverage', 'availableReviewers', 'requireAllReviewers', 'requireReviewerEvidence'], 'review validation context');
  assertOperation(value.operation);
  assertPositiveInteger(value.targetRevision, 'review context revision');
  assertSha256(value.targetFingerprint, 'review context fingerprint');
  assertText(value.reviewerSessionId, 'review context session');
  const previousFindingIds = sortedUniqueStrings(value.previousFindingIds, 'review context findings');
  const requiredCoverage = sortedUniqueStrings(value.requiredCoverage, 'review context coverage');
  if (requiredCoverage.some((category) => !(COMPLETE_REVIEW_COVERAGE as readonly string[]).includes(category))) {
    throw new Error('review validation context has unknown coverage category');
  }
  const availableReviewers = sortedUniqueStrings(value.availableReviewers, 'review context roles');
  if (availableReviewers.length === 0 || typeof value.requireAllReviewers !== 'boolean' || value.requireReviewerEvidence !== true) {
    throw new Error('review validation context lacks reviewer authority');
  }
  return { operation: value.operation as ReviewOperation, targetRevision: value.targetRevision as number,
    targetFingerprint: value.targetFingerprint as string, reviewerSessionId: value.reviewerSessionId as string,
    previousFindingIds, requiredCoverage, availableReviewers,
    requireAllReviewers: value.requireAllReviewers, requireReviewerEvidence: true };
}

export type ReviewOperation = 'code-review';
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

/** Current findings returned by reviewers; historical transitions belong to Runner. */
export type CodeReviewFindingV1 = Omit<CodeReviewDefectV1,
  'status' | 'introducedTargetRevision' | 'statusTargetRevision' | 'supersededBy'>;

export interface CodeReviewReportV1 {
  version: 1;
  operation: ReviewOperation;
  targetRevision: number;
  targetFingerprint: string;
  verdict: ReviewVerdict;
  coverage: string[];
  defects: CodeReviewFindingV1[];
  residualRisks: string[];
  reviewerSessionId: string;
  reviewers: Array<{ role: string; sessionId: string; verdict: 'approve' | 'block' }>;
}

export interface CodeReviewValidationContext {
  operation: ReviewOperation;
  targetRevision: number;
  targetFingerprint: string;
  reviewerSessionId: string;
  previousFindingIds?: string[];
  requiredCoverage?: string[];
  availableReviewers?: string[];
  requireAllReviewers?: boolean;
  requireReviewerEvidence?: boolean;
}

export function hashCodeReviewReport(report: CodeReviewReportV1): string {
  return domainHash('codex-orchestrator-code-review-report-v1', canonicalJson(report));
}

export function validateCodeReviewReport(value: unknown, context: CodeReviewValidationContext): CodeReviewReportV1 {
  assertExactObject(value, [
    'version', 'operation', 'targetRevision', 'targetFingerprint', 'verdict', 'coverage', 'defects',
    'residualRisks', 'reviewerSessionId', 'reviewers',
  ], 'code review report');
  if (value.version !== 1) throw new Error('code review report.version is invalid');
  assertOperation(value.operation);
  assertPositiveInteger(value.targetRevision, 'code review report.targetRevision');
  assertSha256(value.targetFingerprint, 'code review report.targetFingerprint');
  if (!['approved', 'needs-work', 'rejected'].includes(value.verdict as string)) throw new Error('code review report.verdict is invalid');
  const coverage = sortedUniqueStrings(value.coverage, 'code review report.coverage');
  if (coverage.some((category) => !(COMPLETE_REVIEW_COVERAGE as readonly string[]).includes(category))) {
    throw new Error('code review report has unknown coverage category');
  }
  const requiredCoverage = sortedUniqueStrings(context.requiredCoverage ?? [], 'required review coverage');
  const residualRisks = sortedUniqueStrings(value.residualRisks, 'code review report.residualRisks');
  assertText(value.reviewerSessionId, 'code review report.reviewerSessionId');
  const reviewers = validateReviewers(
    value.reviewers, context.availableReviewers ?? [], context.requireAllReviewers ?? true,
    context.requireReviewerEvidence ?? false,
    value.reviewerSessionId as string,
  );
  if (value.operation !== context.operation || value.targetRevision !== context.targetRevision
    || value.targetFingerprint !== context.targetFingerprint || value.reviewerSessionId !== context.reviewerSessionId) {
    throw new Error('code review report correlation mismatch');
  }
  const defects = validateCurrentFindings(value.defects);
  const unresolved = defects.some(defect => defect.class === 'blocker' || defect.class === 'execution-risk');
  if (value.verdict === 'approved' && unresolved) {
    throw new Error('approved review has unresolved defects');
  }
  if (value.verdict === 'approved' && reviewers.some((reviewer) => reviewer.verdict !== 'approve')) {
    throw new Error('approved review has a blocking reviewer');
  }
  if (value.verdict === 'approved' && requiredCoverage.some((item) => !coverage.includes(item))) {
    throw new Error('approved review is missing required coverage');
  }
  if (value.verdict === 'needs-work' && defects.length === 0) {
    throw new Error('needs-work review requires a current finding');
  }
  return {
    ...(structuredClone(value) as unknown as CodeReviewReportV1),
    coverage,
    defects,
    residualRisks,
    reviewers,
  };
}

export function validateCodeReviewDefects(value: unknown, targetRevision: number): CodeReviewDefectV1[] {
  assertPositiveInteger(targetRevision, 'code review defect ledger target revision');
  return validateDefects(value, targetRevision);
}

export function codeReviewReportOutputSchema(): Record<string, unknown> {
  const text = { type: 'string', minLength: 1, maxLength: MAX_TEXT };
  const stringList = { type: 'array', items: text };
  const defect = {
    type: 'object', additionalProperties: false,
    required: [
      'id', 'class', 'severity', 'confidence', 'invariant', 'failure', 'evidence', 'repair', 'affectedTargets',
    ],
    properties: {
      id: text,
      class: { type: 'string', enum: ['blocker', 'execution-risk', 'improvement'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      invariant: text, failure: text, evidence: stringList, repair: text, affectedTargets: stringList,
    },
  };
  const report = {
    type: 'object', additionalProperties: false,
    required: [
      'version', 'operation', 'targetRevision', 'targetFingerprint', 'verdict', 'coverage', 'defects',
      'residualRisks', 'reviewerSessionId', 'reviewers',
    ],
    properties: {
      version: { type: 'integer', const: 1 },
      operation: { type: 'string', const: 'code-review' },
      targetRevision: { type: 'integer', minimum: 1 },
      targetFingerprint: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      verdict: { type: 'string', enum: ['approved', 'needs-work', 'rejected'] },
      coverage: { type: 'array', items: { type: 'string', enum: [...COMPLETE_REVIEW_COVERAGE] } },
      defects: { type: 'array', items: defect },
      residualRisks: stringList,
      reviewerSessionId: text,
      reviewers: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['role', 'sessionId', 'verdict'],
          properties: { role: text, sessionId: text, verdict: { type: 'string', enum: ['approve', 'block'] } },
        },
      },
    },
  };
  return agentReportEnvelopeSchema(report);
}

function validateReviewers(
  value: unknown,
  availableReviewers: string[],
  requireAllReviewers: boolean,
  requireReviewerEvidence: boolean,
  coordinatorSessionId: string,
): CodeReviewReportV1['reviewers'] {
  if (!Array.isArray(value)) throw new Error('code review report.reviewers is invalid');
  const reviewers = value.map((reviewer, index) => {
    assertExactObject(reviewer, ['role', 'sessionId', 'verdict'], `code review reviewer[${index}]`);
    assertText(reviewer.role, 'code review reviewer.role');
    assertText(reviewer.sessionId, 'code review reviewer.sessionId');
    if (!['approve', 'block'].includes(reviewer.verdict as string)) throw new Error('code review reviewer.verdict is invalid');
    return structuredClone(reviewer) as CodeReviewReportV1['reviewers'][number];
  }).sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0);
  assertUnique(reviewers.map((reviewer) => reviewer.role), 'code review reviewer roles');
  assertUnique(reviewers.map((reviewer) => reviewer.sessionId), 'code review reviewer sessions');
  if (reviewers.some((reviewer) => reviewer.sessionId === coordinatorSessionId)) {
    throw new Error('code review reviewer session is not independent');
  }
  const available = [...availableReviewers].sort();
  assertUnique(available, 'available code review reviewers');
  const selected = reviewers.map((reviewer) => reviewer.role);
  if ((available.length === 0 ? (requireReviewerEvidence ? selected.length === 0 : selected.length !== 0) : selected.length === 0)
    || selected.some((role) => !available.includes(role))
    || (requireAllReviewers && !sameStrings(selected, available))) {
    throw new Error('code review report reviewers do not match available roles');
  }
  return reviewers;
}

function validateDefects(value: unknown, targetRevision: number): CodeReviewDefectV1[] {
  if (!Array.isArray(value)) throw new Error('code review report.defects is invalid');
  const defects = value.map((item, index) => {
    assertExactObject(item, [
      'id', 'class', 'severity', 'confidence', 'status', 'invariant', 'failure', 'evidence', 'repair',
      'affectedTargets', 'introducedTargetRevision', 'statusTargetRevision', 'supersededBy',
    ], `code review defect[${index}]`);
    const finding = validateFindingFields(item);
    if (!['open', 'fixed', 'verified', 'reopened', 'superseded'].includes(item.status as string)) throw new Error('code review defect.status is invalid');
    assertPositiveInteger(item.introducedTargetRevision, 'code review defect.introducedTargetRevision');
    assertPositiveInteger(item.statusTargetRevision, 'code review defect.statusTargetRevision');
    if ((item.introducedTargetRevision as number) > (item.statusTargetRevision as number)
      || (item.statusTargetRevision as number) > targetRevision) throw new Error('code review defect revisions are invalid');
    if (item.status === 'superseded') assertText(item.supersededBy, 'code review defect.supersededBy');
    else if (item.supersededBy !== null) throw new Error('non-superseded defect has replacement');
    return { ...(structuredClone(item) as unknown as CodeReviewDefectV1), ...finding };
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

function validateCurrentFindings(value: unknown): CodeReviewFindingV1[] {
  if (!Array.isArray(value)) throw new Error('code review report.defects is invalid');
  const findings = value.map(finding => {
    assertExactObject(finding, [
      'id', 'class', 'severity', 'confidence', 'invariant', 'failure', 'evidence', 'repair', 'affectedTargets',
    ], 'code review finding');
    return validateFindingFields(finding);
  });
  assertUnique(findings.map(finding => finding.id), 'code review finding IDs');
  return findings;
}

function validateFindingFields(item: Record<string, unknown>): CodeReviewFindingV1 {
  for (const field of ['id', 'invariant', 'failure', 'repair'] as const) assertText(item[field], `code review finding.${field}`);
  if (!['blocker', 'execution-risk', 'improvement'].includes(item.class as string)) throw new Error('code review finding.class is invalid');
  if (!['critical', 'high', 'medium', 'low'].includes(item.severity as string)) throw new Error('code review finding.severity is invalid');
  if (!['high', 'medium', 'low'].includes(item.confidence as string)) throw new Error('code review finding.confidence is invalid');
  const { id, class: findingClass, severity, confidence, invariant, failure, repair } = item;
  return { id, class: findingClass, severity, confidence, invariant, failure, repair,
    evidence: sortedUniqueStrings(item.evidence, 'code review finding.evidence'),
    affectedTargets: sortedUniqueStrings(item.affectedTargets, 'code review finding.affectedTargets'),
  } as CodeReviewFindingV1;
}

function sortedUniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
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
