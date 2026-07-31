import { canonicalJson, sha256 } from './containment.js';
import { validateTriageRoute, type TriageRouteV1 } from './triage-route.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_STRING_LENGTH = 16 * 1024;
const MAX_ARRAY_LENGTH = 256;

const TRIAGE_ARTIFACT_DOMAIN = 'codex-orchestrator-triage-artifact-v1';
const ROUTE_DECISION_DOMAIN = 'codex-orchestrator-route-decision-v1';

export type DeliveryRoute = 'direct' | 'spec-required';

export interface RouteArtifactRefV1 {
  operation: 'triage';
  attemptId: string;
  artifactSha256: string;
  generationHash: string;
}

export interface RouteReceiptV1 {
  version: 1;
  route: DeliveryRoute;
  triage: RouteArtifactRefV1;
  review: null;
  artifact: TriageRouteV1;
  decisionSha256: string;
  decidedAt: string;
  assumptions: string[];
}

export interface RouteBudgetsV1 {
  version: 1;
  triageRepairs: 0 | 1;
  triageTransportRetries: 0 | 1;
}

export type MalformedRepairInputV1 = { kind: 'malformed'; findings: string[] };

export type RouteExecutionV1 = RouteBudgetsV1 & (
  | { phase: 'triage-ready' }
  | { phase: 'malformed-repair-ready'; findings: string[] }
  | { phase: 'route-complete'; triage: RouteArtifactRefV1 }
);

export type RouteLifecycle =
  | 'claimed'
  | 'triaging'
  | 'routed'
  | 'implementing'
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

export type RoutedLifecycle = 'implementing' | 'spec-authoring';

export function hashTriageArtifact(value: unknown): string {
  return hashDomain(TRIAGE_ARTIFACT_DOMAIN, validateTriageRoute(value));
}

export function hashRouteDecision(value: RouteReceiptV1): string {
  const receipt = validateRouteReceiptCore(value, undefined, false);
  return hashDomain(ROUTE_DECISION_DOMAIN, { ...receipt, decisionSha256: '' });
}

export function validateRouteArtifactRef(value: unknown, expectedGenerationHash?: string): RouteArtifactRefV1 {
  assertExactObject(value, ['operation', 'attemptId', 'artifactSha256', 'generationHash'], 'route triage ref');
  if (value.operation !== 'triage') throw new Error('route triage ref.operation must be triage');
  assertString(value.attemptId, 'route triage ref.attemptId');
  assertSha256(value.artifactSha256, 'route triage ref.artifactSha256');
  assertGeneration(value.generationHash, expectedGenerationHash, 'route triage ref.generationHash');
  return value as unknown as RouteArtifactRefV1;
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
  if (!['direct', 'spec-required'].includes(value.route as string)) {
    throw new Error('route receipt.route is invalid');
  }
  const triage = validateRouteArtifactRef(value.triage, expectedGenerationHash);
  const artifact = validateTriageRoute(value.artifact);
  if (artifact.status === 'blocked' || artifact.status !== value.route) {
    throw new Error('route receipt.route does not match artifact status');
  }
  const artifactSha256 = hashTriageArtifact(artifact);
  if (triage.artifactSha256 !== artifactSha256) throw new Error('route receipt artifact hash mismatch');

  if (value.review !== null) {
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
  const budgetKeys = ['version', 'triageRepairs', 'triageTransportRetries'];
  if (value.phase === 'triage-ready') {
    assertExactObject(value, [...budgetKeys, 'phase'], 'route execution');
  } else if (value.phase === 'malformed-repair-ready') {
    assertExactObject(value, [...budgetKeys, 'phase', 'findings'], 'route execution');
    validateFindings(value.findings, 'route execution.findings');
    assertRepairConsumed(value);
  } else if (value.phase === 'route-complete') {
    assertExactObject(value, [...budgetKeys, 'phase', 'triage'], 'route execution');
    validateRouteArtifactRef(value.triage, expectedGenerationHash);
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
  if (input.lifecycle === 'safe-halt' && hasExecution && !hasReceipt) return void validateRouteExecution(input.routeExecution, input.generationHash);
  if (TERMINAL_LIFECYCLES.includes(input.lifecycle) && !hasExecution && !hasReceipt) return;
  if (!hasExecution || !hasReceipt) throw new Error(`${input.lifecycle} route execution and receipt are required as an exact pair`);
  const execution = validateRouteExecution(input.routeExecution, input.generationHash);
  if (execution.phase !== 'route-complete') throw new Error(`${input.lifecycle} route execution must be route-complete`);
  const receipt = validateRouteReceipt(input.routeReceipt, input.generationHash);
  if (canonicalJson(execution.triage) !== canonicalJson(receipt.triage)
    || receipt.review !== null) {
    throw new Error('route-complete refs must equal route receipt refs');
  }
  if (input.lifecycle === 'implementing' && !['direct', 'spec-required'].includes(receipt.route)) {
    throw new Error('implementing lifecycle requires delivery authority route');
  }
  if (input.lifecycle === 'spec-authoring' && receipt.route !== 'spec-required') {
    throw new Error('direct route dispatch requires implementing lifecycle');
  }
}

export function downstreamLifecycleForRoute(
  receiptValue: unknown,
  expectedGenerationHash?: string,
): RoutedLifecycle {
  const receipt = validateRouteReceipt(receiptValue, expectedGenerationHash);
  if (receipt.route === 'direct') return 'implementing';
  if (receipt.route === 'spec-required') return 'spec-authoring';
  throw new Error('route receipt is not dispatchable');
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

const ROUTE_LIFECYCLES: RouteLifecycle[] = [
  'claimed', 'triaging', 'routed', 'implementing', 'spec-authoring', 'reworking', 'checking',
  'proving', 'publishing', 'safe-halt', 'review-ready', 'blocked', 'transport-failed', 'cancelled', 'internal-error',
];

const TERMINAL_LIFECYCLES: RouteLifecycle[] = [
  'review-ready', 'blocked', 'transport-failed', 'cancelled', 'internal-error',
];

function validateBudgets(value: Record<string, unknown>): void {
  if (value.version !== 1) throw new Error('route execution.version must be 1');
  for (const key of ['triageRepairs', 'triageTransportRetries'] as const) {
    if (value[key] !== 0 && value[key] !== 1) throw new Error(`route execution.${key} must be 0 or 1`);
  }
}

function assertRepairConsumed(value: Record<string, unknown>): void {
  if (value.triageRepairs !== 1) throw new Error('repair phase requires triageRepairs 1');
}

function validateFindings(value: unknown, field: string): void {
  assertStringArray(value, field, 1);
  assertUnique(value, field);
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
