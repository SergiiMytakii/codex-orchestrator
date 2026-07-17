import { canonicalJson, sha256 } from './containment.js';
import { validateTriageRoute, type TriageRouteV1 } from './triage-route.js';
import type { WaitingHumanExecutionV1 } from './waiting-human.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_STRING_LENGTH = 16 * 1024;
const MAX_ARRAY_LENGTH = 256;

const TRIAGE_ARTIFACT_DOMAIN = 'codex-orchestrator-triage-artifact-v1';
const AMBIGUITY_REVIEW_DOMAIN = 'codex-orchestrator-ambiguity-review-v1';
const ROUTE_DECISION_DOMAIN = 'codex-orchestrator-route-decision-v1';

export type DeliveryRoute = 'direct' | 'spec-required' | 'awaiting-user';

export interface RouteArtifactRefV1 {
  operation: 'triage';
  attemptId: string;
  artifactSha256: string;
  generationHash: string;
}

export interface AmbiguityReviewRefV1 {
  operation: 'ambiguity-review';
  attemptId: string;
  candidateSha256: string;
  artifactSha256: string;
  verdict: 'approved' | 'rejected';
  generationHash: string;
}

export interface AmbiguityReviewArtifactV1 {
  version: 1;
  candidateSha256: string;
  verdict: 'approved' | 'rejected' | 'blocked';
  evidenceReviewed: string[];
  findings: string[];
  recommendation: string;
}

export interface RouteReceiptV1 {
  version: 1;
  route: DeliveryRoute;
  triage: RouteArtifactRefV1;
  review: AmbiguityReviewRefV1 | null;
  artifact: TriageRouteV1;
  decisionSha256: string;
  decidedAt: string;
  assumptions: string[];
}

export interface RouteBudgetsV1 {
  version: 1;
  triageRepairs: 0 | 1;
  triageTransportRetries: 0 | 1;
  ambiguityTransportRetries: 0 | 1;
  candidateReviews: 0 | 1;
}

export type MalformedRepairInputV1 = { kind: 'malformed'; findings: string[] };

export type CandidateRepairInputV1 = {
  kind: 'rejected-candidate';
  candidate: TriageRouteV1;
  triage: RouteArtifactRefV1;
  review: AmbiguityReviewRefV1;
  findings: string[];
};

export type RouteExecutionV1 = RouteBudgetsV1 & (
  | { phase: 'triage-ready'; previousAttemptId: string | null }
  | { phase: 'triage-in-flight'; attemptId: string; startedAt: string }
  | { phase: 'candidate-ready'; candidate: TriageRouteV1; triage: RouteArtifactRefV1 }
  | { phase: 'review-in-flight'; attemptId: string; startedAt: string; candidate: TriageRouteV1; triage: RouteArtifactRefV1 }
  | { phase: 'malformed-repair-ready'; findings: string[] }
  | { phase: 'candidate-repair-ready'; candidate: TriageRouteV1; triage: RouteArtifactRefV1; review: AmbiguityReviewRefV1; findings: string[] }
  | { phase: 'repair-in-flight'; attemptId: string; startedAt: string; repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 }
  | { phase: 'route-complete'; triage: RouteArtifactRefV1; review: AmbiguityReviewRefV1 | null }
);

export type RouteLifecycle =
  | 'claimed'
  | 'triaging'
  | 'routed'
  | 'implementing'
  | 'waiting-human'
  | 'spec-authoring'
  | 'reworking'
  | 'checking'
  | 'proving'
  | 'publishing'
  | 'safe-halt'
  | 'review-ready'
  | 'blocked'
  | 'transport-failed'
  | 'cancelled'
  | 'internal-error';

export type RoutedLifecycle = 'implementing' | 'spec-authoring' | 'waiting-human';

export function hashTriageArtifact(value: unknown): string {
  return hashDomain(TRIAGE_ARTIFACT_DOMAIN, validateTriageRoute(value));
}

export function hashAmbiguityReviewArtifact(value: unknown): string {
  return hashDomain(AMBIGUITY_REVIEW_DOMAIN, validateAmbiguityReviewArtifact(value));
}

export function hashRouteDecision(value: RouteReceiptV1): string {
  const receipt = validateRouteReceiptCore(value, undefined, false);
  return hashDomain(ROUTE_DECISION_DOMAIN, { ...receipt, decisionSha256: '' });
}

export function validateAmbiguityReviewArtifact(value: unknown): AmbiguityReviewArtifactV1 {
  assertExactObject(value, [
    'version', 'candidateSha256', 'verdict', 'evidenceReviewed', 'findings', 'recommendation',
  ], 'ambiguity review artifact');
  if (value.version !== 1) throw new Error('ambiguity review artifact.version must be 1');
  assertSha256(value.candidateSha256, 'ambiguity review artifact.candidateSha256');
  if (!['approved', 'rejected', 'blocked'].includes(value.verdict as string)) {
    throw new Error('ambiguity review artifact.verdict is invalid');
  }
  assertStringArray(value.evidenceReviewed, 'ambiguity review artifact.evidenceReviewed', 0);
  assertUnique(value.evidenceReviewed, 'ambiguity review artifact.evidenceReviewed');
  assertStringArray(value.findings, 'ambiguity review artifact.findings', 0);
  assertUnique(value.findings, 'ambiguity review artifact.findings');
  assertString(value.recommendation, 'ambiguity review artifact.recommendation');
  return value as unknown as AmbiguityReviewArtifactV1;
}

export function validateRouteArtifactRef(value: unknown, expectedGenerationHash?: string): RouteArtifactRefV1 {
  assertExactObject(value, ['operation', 'attemptId', 'artifactSha256', 'generationHash'], 'route triage ref');
  if (value.operation !== 'triage') throw new Error('route triage ref.operation must be triage');
  assertString(value.attemptId, 'route triage ref.attemptId');
  assertSha256(value.artifactSha256, 'route triage ref.artifactSha256');
  assertGeneration(value.generationHash, expectedGenerationHash, 'route triage ref.generationHash');
  return value as unknown as RouteArtifactRefV1;
}

export function validateAmbiguityReviewRef(value: unknown, expectedGenerationHash?: string): AmbiguityReviewRefV1 {
  assertExactObject(value, [
    'operation', 'attemptId', 'candidateSha256', 'artifactSha256', 'verdict', 'generationHash',
  ], 'ambiguity review ref');
  if (value.operation !== 'ambiguity-review') throw new Error('ambiguity review ref.operation must be ambiguity-review');
  assertString(value.attemptId, 'ambiguity review ref.attemptId');
  assertSha256(value.candidateSha256, 'ambiguity review ref.candidateSha256');
  assertSha256(value.artifactSha256, 'ambiguity review ref.artifactSha256');
  if (value.verdict !== 'approved' && value.verdict !== 'rejected') throw new Error('ambiguity review ref.verdict is invalid');
  assertGeneration(value.generationHash, expectedGenerationHash, 'ambiguity review ref.generationHash');
  return value as unknown as AmbiguityReviewRefV1;
}

export function validateRouteReceipt(value: unknown, expectedGenerationHash?: string): RouteReceiptV1 {
  return validateRouteReceiptCore(value, expectedGenerationHash, true);
}

function validateRouteReceiptCore(
  value: unknown,
  expectedGenerationHash: string | undefined,
  verifyDecisionHash: boolean,
): RouteReceiptV1 {
  assertExactObject(value, [
    'version', 'route', 'triage', 'review', 'artifact', 'decisionSha256', 'decidedAt', 'assumptions',
  ], 'route receipt');
  if (value.version !== 1) throw new Error('route receipt.version must be 1');
  if (!['direct', 'spec-required', 'awaiting-user'].includes(value.route as string)) {
    throw new Error('route receipt.route is invalid');
  }
  const triage = validateRouteArtifactRef(value.triage, expectedGenerationHash);
  const artifact = validateTriageRoute(value.artifact);
  if (artifact.status === 'blocked' || artifact.status !== value.route) {
    throw new Error('route receipt.route does not match artifact status');
  }
  const artifactSha256 = hashTriageArtifact(artifact);
  if (triage.artifactSha256 !== artifactSha256) throw new Error('route receipt artifact hash mismatch');

  let review: AmbiguityReviewRefV1 | null;
  if (value.review === null) {
    review = null;
  } else {
    review = validateAmbiguityReviewRef(value.review, expectedGenerationHash ?? triage.generationHash);
    if (review.generationHash !== triage.generationHash) throw new Error('route receipt review generation mismatch');
  }
  if (value.route === 'awaiting-user') {
    if (review === null || review.verdict !== 'approved') throw new Error('awaiting-user route requires an approved review');
    if (review.candidateSha256 !== triage.artifactSha256) throw new Error('awaiting-user review candidate hash mismatch');
    if (review.attemptId === triage.attemptId) throw new Error('triage and ambiguity review attempt IDs must be distinct');
  } else if (review !== null) {
    throw new Error(`${String(value.route)} route requires review null`);
  }

  if (verifyDecisionHash || value.decisionSha256 !== '') {
    assertSha256(value.decisionSha256, 'route receipt.decisionSha256');
  }
  assertTimestamp(value.decidedAt, 'route receipt.decidedAt');
  assertStringArray(value.assumptions, 'route receipt.assumptions', 0);
  assertUnique(value.assumptions, 'route receipt.assumptions');
  if (canonicalJson(value.assumptions) !== canonicalJson(artifact.assumptions)) {
    throw new Error('route receipt assumptions must equal artifact assumptions');
  }
  const receipt = value as unknown as RouteReceiptV1;
  const expectedDecisionSha256 = hashDomain(ROUTE_DECISION_DOMAIN, { ...receipt, decisionSha256: '' });
  if (verifyDecisionHash && value.decisionSha256 !== expectedDecisionSha256) {
    throw new Error('route receipt decision hash mismatch');
  }
  return receipt;
}

export function validateRouteExecution(value: unknown, expectedGenerationHash?: string): RouteExecutionV1 {
  assertRecord(value, 'route execution');
  validateBudgets(value);
  const budgetKeys = [
    'version', 'triageRepairs', 'triageTransportRetries', 'ambiguityTransportRetries', 'candidateReviews',
  ];
  if (value.phase === 'triage-ready') {
    assertExactObject(value, [...budgetKeys, 'phase', 'previousAttemptId'], 'route execution');
    if (value.previousAttemptId !== null) assertString(value.previousAttemptId, 'route execution.previousAttemptId');
  } else if (value.phase === 'triage-in-flight') {
    assertExactObject(value, [...budgetKeys, 'phase', 'attemptId', 'startedAt'], 'route execution');
    assertAttemptAndTimestamp(value);
  } else if (value.phase === 'candidate-ready') {
    assertExactObject(value, [...budgetKeys, 'phase', 'candidate', 'triage'], 'route execution');
    validateWaitingCandidate(value.candidate, value.triage, expectedGenerationHash);
    if (value.candidateReviews !== 0) throw new Error('candidate-ready candidateReviews must be 0');
  } else if (value.phase === 'review-in-flight') {
    assertExactObject(value, [...budgetKeys, 'phase', 'attemptId', 'startedAt', 'candidate', 'triage'], 'route execution');
    assertAttemptAndTimestamp(value);
    const triage = validateWaitingCandidate(value.candidate, value.triage, expectedGenerationHash);
    if (value.attemptId === triage.attemptId) throw new Error('review attempt ID must be distinct from triage attempt ID');
    if (value.candidateReviews !== 0) throw new Error('review-in-flight candidateReviews must be 0');
  } else if (value.phase === 'malformed-repair-ready') {
    assertExactObject(value, [...budgetKeys, 'phase', 'findings'], 'route execution');
    validateFindings(value.findings, 'route execution.findings');
    assertRepairConsumed(value);
  } else if (value.phase === 'candidate-repair-ready') {
    assertExactObject(value, [...budgetKeys, 'phase', 'candidate', 'triage', 'review', 'findings'], 'route execution');
    validateRejectedCandidate(value.candidate, value.triage, value.review, value.findings, expectedGenerationHash);
    assertRejectedRepairBudgets(value);
  } else if (value.phase === 'repair-in-flight') {
    assertExactObject(value, [...budgetKeys, 'phase', 'attemptId', 'startedAt', 'repairInput'], 'route execution');
    assertAttemptAndTimestamp(value);
    validateRepairInput(value.repairInput, expectedGenerationHash);
    assertRepairConsumed(value);
    if ((value.repairInput as Record<string, unknown>).kind === 'rejected-candidate') {
      if (value.candidateReviews !== 1) throw new Error('rejected-candidate repair requires candidateReviews 1');
    } else if (value.candidateReviews !== 0) {
      throw new Error('malformed repair requires candidateReviews 0');
    }
  } else if (value.phase === 'route-complete') {
    assertExactObject(value, [...budgetKeys, 'phase', 'triage', 'review'], 'route execution');
    const triage = validateRouteArtifactRef(value.triage, expectedGenerationHash);
    if (value.review !== null) {
      const review = validateAmbiguityReviewRef(value.review, expectedGenerationHash ?? triage.generationHash);
      validateReviewBinding(triage, review);
      if (review.verdict !== 'approved') throw new Error('route-complete review must be approved');
      if (value.candidateReviews !== 1) throw new Error('reviewed route-complete requires candidateReviews 1');
    }
  } else {
    throw new Error('route execution.phase is invalid');
  }
  return value as unknown as RouteExecutionV1;
}

export function validateRouteStateInvariant(input: {
  lifecycle: RouteLifecycle;
  routeExecution: unknown;
  routeReceipt: unknown;
  generationHash: string;
}): void {
  assertSha256(input.generationHash, 'route state.generationHash');
  if (!ROUTE_LIFECYCLES.includes(input.lifecycle)) throw new Error('route state lifecycle is invalid');
  const hasExecution = input.routeExecution !== undefined;
  const hasReceipt = input.routeReceipt !== undefined;
  if (input.lifecycle === 'claimed') {
    if (hasExecution || hasReceipt) throw new Error('claimed route state requires routeExecution and routeReceipt absent');
    return;
  }
  if (input.lifecycle === 'triaging') {
    if (!hasExecution || hasReceipt) throw new Error('triaging route state requires routeExecution and routeReceipt absent');
    const execution = validateRouteExecution(input.routeExecution, input.generationHash);
    if (execution.phase === 'route-complete') throw new Error('triaging route execution cannot be route-complete');
    return;
  }
  if (input.lifecycle === 'safe-halt' && hasExecution && !hasReceipt) {
    const execution = validateRouteExecution(input.routeExecution, input.generationHash);
    if (!['triage-in-flight', 'repair-in-flight', 'review-in-flight'].includes(execution.phase)) {
      throw new Error('pre-route safe-halt requires an in-flight route execution');
    }
    return;
  }
  if (TERMINAL_LIFECYCLES.includes(input.lifecycle) && !hasExecution && !hasReceipt) return;
  if (!hasExecution || !hasReceipt) throw new Error(`${input.lifecycle} route execution and receipt are required as an exact pair`);
  const execution = validateRouteExecution(input.routeExecution, input.generationHash);
  if (execution.phase !== 'route-complete') throw new Error(`${input.lifecycle} route execution must be route-complete`);
  const receipt = validateRouteReceipt(input.routeReceipt, input.generationHash);
  if (canonicalJson(execution.triage) !== canonicalJson(receipt.triage)
    || canonicalJson(execution.review) !== canonicalJson(receipt.review)) {
    throw new Error('route-complete refs must equal route receipt refs');
  }
  if (input.lifecycle === 'implementing' && receipt.route !== 'direct') {
    throw new Error('implementing lifecycle requires direct route');
  }
  if (input.lifecycle === 'spec-authoring' && receipt.route !== 'spec-required') {
    throw new Error('direct route dispatch requires implementing lifecycle');
  }
  if (input.lifecycle === 'waiting-human' && receipt.route !== 'awaiting-user') {
    throw new Error('waiting-human lifecycle requires awaiting-user route');
  }
}

export function downstreamLifecycleForRoute(
  receiptValue: unknown,
  expectedGenerationHash?: string,
): RoutedLifecycle {
  const receipt = validateRouteReceipt(receiptValue, expectedGenerationHash);
  if (receipt.route === 'direct') return 'implementing';
  if (receipt.route === 'spec-required') return 'spec-authoring';
  return 'waiting-human';
}

export function validateRouteTransition(
  previous: {
    lifecycle: RouteLifecycle;
    routeExecution: unknown;
    routeReceipt: unknown;
    generationHash: string;
  },
  next: {
    lifecycle: RouteLifecycle;
    routeExecution: unknown;
    routeReceipt: unknown;
    generationHash: string;
  },
): void {
  validateRouteStateInvariant(previous);
  validateRouteStateInvariant(next);
  if (previous.generationHash !== next.generationHash) throw new Error('route transition generation is immutable');
  if (previous.routeReceipt !== undefined) {
    if (next.routeReceipt === undefined
      || canonicalJson(previous.routeReceipt) !== canonicalJson(next.routeReceipt)) {
      throw new Error('route receipt is immutable after routing');
    }
  }
  if (previous.lifecycle === 'routed' && next.lifecycle !== 'routed') {
    const expected = downstreamLifecycleForRoute(previous.routeReceipt, previous.generationHash);
    if (next.lifecycle !== expected) throw new Error(`routed ${String((previous.routeReceipt as RouteReceiptV1).route)} must dispatch to ${expected}`);
  }
}

export function validateTrustedAnswerResumeTransition(
  previous: { lifecycle: RouteLifecycle; routeExecution: unknown; routeReceipt: unknown; generationHash: string },
  next: { lifecycle: RouteLifecycle; routeExecution: unknown; routeReceipt: unknown; generationHash: string },
  waitingHuman: WaitingHumanExecutionV1,
): void {
  validateRouteStateInvariant(previous);
  validateRouteStateInvariant(next);
  if (previous.lifecycle !== 'waiting-human' || (previous.routeReceipt as RouteReceiptV1).route !== 'awaiting-user') {
    throw new Error('trusted answer resume requires waiting-human awaiting-user authority');
  }
  if (waitingHuman.phase !== 'resume-ready') throw new Error('trusted answer resume requires resume-ready evidence');
  if (next.lifecycle !== 'triaging' || next.routeReceipt !== undefined) throw new Error('trusted answer resume must restart triage without a receipt');
  const execution = validateRouteExecution(next.routeExecution, next.generationHash);
  if (execution.phase !== 'triage-ready' || execution.previousAttemptId !== null
    || execution.triageRepairs !== 0 || execution.triageTransportRetries !== 0
    || execution.ambiguityTransportRetries !== 0 || execution.candidateReviews !== 0) {
    throw new Error('trusted answer resume requires initial route execution');
  }
}

const ROUTE_LIFECYCLES: RouteLifecycle[] = [
  'claimed', 'triaging', 'routed', 'implementing', 'waiting-human', 'spec-authoring', 'reworking', 'checking',
  'proving', 'publishing', 'safe-halt', 'review-ready', 'blocked', 'transport-failed', 'cancelled', 'internal-error',
];

const TERMINAL_LIFECYCLES: RouteLifecycle[] = [
  'review-ready', 'blocked', 'transport-failed', 'cancelled', 'internal-error',
];

function validateBudgets(value: Record<string, unknown>): void {
  if (value.version !== 1) throw new Error('route execution.version must be 1');
  for (const key of [
    'triageRepairs', 'triageTransportRetries', 'ambiguityTransportRetries', 'candidateReviews',
  ] as const) {
    if (value[key] !== 0 && value[key] !== 1) throw new Error(`route execution.${key} must be 0 or 1`);
  }
}

function validateWaitingCandidate(
  candidateValue: unknown,
  triageValue: unknown,
  expectedGenerationHash?: string,
): RouteArtifactRefV1 {
  const candidate = validateTriageRoute(candidateValue);
  if (candidate.status !== 'awaiting-user') throw new Error('route execution candidate must be awaiting-user');
  const triage = validateRouteArtifactRef(triageValue, expectedGenerationHash);
  if (triage.artifactSha256 !== hashTriageArtifact(candidate)) throw new Error('route execution candidate artifact hash mismatch');
  return triage;
}

function validateRejectedCandidate(
  candidate: unknown,
  triageValue: unknown,
  reviewValue: unknown,
  findings: unknown,
  expectedGenerationHash?: string,
): void {
  const triage = validateWaitingCandidate(candidate, triageValue, expectedGenerationHash);
  const review = validateAmbiguityReviewRef(reviewValue, expectedGenerationHash ?? triage.generationHash);
  validateReviewBinding(triage, review);
  if (review.verdict !== 'rejected') throw new Error('candidate repair review must be rejected');
  validateFindings(findings, 'route execution findings');
}

function validateRepairInput(value: unknown, expectedGenerationHash?: string): void {
  assertRecord(value, 'route execution.repairInput');
  if (value.kind === 'malformed') {
    assertExactObject(value, ['kind', 'findings'], 'route execution.repairInput');
    validateFindings(value.findings, 'route execution.repairInput.findings');
    return;
  }
  if (value.kind === 'rejected-candidate') {
    assertExactObject(value, ['kind', 'candidate', 'triage', 'review', 'findings'], 'route execution.repairInput');
    validateRejectedCandidate(value.candidate, value.triage, value.review, value.findings, expectedGenerationHash);
    return;
  }
  throw new Error('route execution.repairInput.kind is invalid');
}

function validateReviewBinding(triage: RouteArtifactRefV1, review: AmbiguityReviewRefV1): void {
  if (review.generationHash !== triage.generationHash) throw new Error('ambiguity review generation mismatch');
  if (review.candidateSha256 !== triage.artifactSha256) throw new Error('ambiguity review candidate hash mismatch');
  if (review.attemptId === triage.attemptId) throw new Error('ambiguity review attempt must be distinct from triage attempt');
}

function assertRepairConsumed(value: Record<string, unknown>): void {
  if (value.triageRepairs !== 1) throw new Error('repair phase requires triageRepairs 1');
}

function assertRejectedRepairBudgets(value: Record<string, unknown>): void {
  assertRepairConsumed(value);
  if (value.candidateReviews !== 1) throw new Error('rejected candidate requires candidateReviews 1');
}

function validateFindings(value: unknown, field: string): void {
  assertStringArray(value, field, 1);
  assertUnique(value, field);
}

function assertAttemptAndTimestamp(value: Record<string, unknown>): void {
  assertString(value.attemptId, 'route execution.attemptId');
  assertTimestamp(value.startedAt, 'route execution.startedAt');
}

function hashDomain(domain: string, value: unknown): string {
  return sha256(Buffer.concat([
    Buffer.from(domain, 'ascii'),
    Buffer.from([0]),
    Buffer.from(canonicalJson(value), 'utf8'),
  ]));
}

function assertGeneration(value: unknown, expected: string | undefined, field: string): asserts value is string {
  assertSha256(value, field);
  if (expected !== undefined) {
    assertSha256(expected, 'expected generation hash');
    if (value !== expected) throw new Error(`${field} generation mismatch`);
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
}

function assertStringArray(value: unknown, field: string, minItems: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > MAX_ARRAY_LENGTH) {
    throw new Error(`${field} has invalid cardinality`);
  }
  for (const item of value) assertString(item, `${field} entry`);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH) {
    throw new Error(`${field} must be a bounded non-empty string`);
  }
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  assertRecord(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}
