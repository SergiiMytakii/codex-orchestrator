import { agentReportEnvelopeSchema } from './report-envelope.js';

const MAX_STRING_LENGTH = 16 * 1024;
const MAX_ARRAY_LENGTH = 256;

const evidenceKinds = [
  'issue', 'comment', 'code', 'caller', 'test', 'instruction', 'context', 'domain', 'adr', 'behavior',
] as const;

interface Evidence {
  kind: typeof evidenceKinds[number];
  location: string;
  summary: string;
}

interface DirectRoute {
  summary: string;
  behaviors: string[];
  verification: string[];
}

interface SpecRequiredRoute {
  summary: string;
  complexityReasons: string[];
  specMode: 'compact' | 'standard';
  reviewFocus: string[];
}

interface BlockerRoute {
  kind: 'external' | 'safety' | 'exhausted';
  code: string;
  summary: string;
  evidence: string[];
}

interface TriageRouteBase {
  version: 1;
  inspectedEvidence: Evidence[];
  assumptions: string[];
}

export type TriageRouteV1 = TriageRouteBase & (
  | { status: 'direct'; direct: DirectRoute; specRequired: null; blocker: null }
  | { status: 'spec-required'; direct: null; specRequired: SpecRequiredRoute; blocker: null }
  | { status: 'blocked'; direct: null; specRequired: null; blocker: BlockerRoute }
);

export function validateTriageRoute(value: unknown): TriageRouteV1 {
  assertExactObject(value, [
    'version', 'status', 'inspectedEvidence', 'assumptions',
    'direct', 'specRequired', 'blocker',
  ], 'triage route');
  if (value.version !== 1) throw new Error('triage route.version must be 1');
  validateEvidence(value.inspectedEvidence);
  assertStringArray(value.assumptions, 'triage route.assumptions', 0);
  assertUnique(value.assumptions, 'triage route.assumptions');

  if (value.status === 'direct') {
    validateDirect(value.direct);
    assertInactive(value.specRequired, 'specRequired');
    assertInactive(value.blocker, 'blocker');
  } else if (value.status === 'spec-required') {
    assertInactive(value.direct, 'direct');
    validateSpecRequired(value.specRequired);
    assertInactive(value.blocker, 'blocker');
  } else if (value.status === 'blocked') {
    assertInactive(value.direct, 'direct');
    assertInactive(value.specRequired, 'specRequired');
    validateBlocker(value.blocker);
  } else {
    throw new Error('triage route.status is invalid');
  }
  return value as unknown as TriageRouteV1;
}

export function triageRouteOutputSchema(): Record<string, unknown> {
  return agentReportEnvelopeSchema([
    routeSchema('direct', directSchema(), nullSchema(), nullSchema()),
    routeSchema('spec-required', nullSchema(), specRequiredSchema(), nullSchema()),
    routeSchema('blocked', nullSchema(), nullSchema(), blockerSchema()),
  ]);
}

function routeSchema(
  status: TriageRouteV1['status'],
  direct: Record<string, unknown>,
  specRequired: Record<string, unknown>,
  blocker: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'version', 'status', 'inspectedEvidence', 'assumptions',
      'direct', 'specRequired', 'blocker',
    ],
    properties: {
      version: { type: 'integer', const: 1 },
      status: { type: 'string', const: status },
      inspectedEvidence: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, items: evidenceSchema() },
      assumptions: stringArraySchema(0),
      direct,
      specRequired,
      blocker,
    },
  };
}

function evidenceSchema(): Record<string, unknown> {
  return objectSchema(['kind', 'location', 'summary'], {
    kind: { type: 'string', enum: evidenceKinds },
    location: stringSchema(),
    summary: stringSchema(),
  });
}

function directSchema(): Record<string, unknown> {
  return objectSchema(['summary', 'behaviors', 'verification'], {
    summary: stringSchema(),
    behaviors: stringArraySchema(1),
    verification: stringArraySchema(1),
  });
}

function specRequiredSchema(): Record<string, unknown> {
  return objectSchema(['summary', 'complexityReasons', 'specMode', 'reviewFocus'], {
    summary: stringSchema(),
    complexityReasons: stringArraySchema(1),
    specMode: { type: 'string', enum: ['compact', 'standard'] },
    reviewFocus: stringArraySchema(1),
  });
}

function blockerSchema(): Record<string, unknown> {
  return objectSchema(['kind', 'code', 'summary', 'evidence'], {
    kind: { type: 'string', enum: ['external', 'safety', 'exhausted'] },
    code: stringSchema(),
    summary: stringSchema(),
    evidence: stringArraySchema(1),
  });
}

function objectSchema(required: string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required, properties };
}

function stringArraySchema(minItems: number): Record<string, unknown> {
  return { type: 'array', minItems, maxItems: MAX_ARRAY_LENGTH, items: stringSchema() };
}

function stringSchema(): Record<string, unknown> {
  return { type: 'string', minLength: 1, maxLength: MAX_STRING_LENGTH };
}

function nullSchema(): Record<string, unknown> {
  return { type: 'null' };
}

function validateEvidence(value: unknown): asserts value is Evidence[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARRAY_LENGTH) {
    throw new Error('triage route.inspectedEvidence must contain 1..256 entries');
  }
  for (const [index, item] of value.entries()) {
    assertExactObject(item, ['kind', 'location', 'summary'], `triage route.inspectedEvidence[${index}]`);
    if (!evidenceKinds.includes(item.kind as Evidence['kind'])) throw new Error('triage route.inspectedEvidence kind is invalid');
    assertString(item.location, 'triage route.inspectedEvidence location');
    assertString(item.summary, 'triage route.inspectedEvidence summary');
  }
}

function validateDirect(value: unknown): asserts value is DirectRoute {
  assertExactObject(value, ['summary', 'behaviors', 'verification'], 'triage route.direct');
  assertString(value.summary, 'triage route.direct.summary');
  assertStringArray(value.behaviors, 'triage route.direct.behaviors', 1);
  assertStringArray(value.verification, 'triage route.direct.verification', 1);
  assertUnique(value.behaviors, 'triage route.direct.behaviors');
  assertUnique(value.verification, 'triage route.direct.verification');
}

function validateSpecRequired(value: unknown): asserts value is SpecRequiredRoute {
  assertExactObject(value, ['summary', 'complexityReasons', 'specMode', 'reviewFocus'], 'triage route.specRequired');
  assertString(value.summary, 'triage route.specRequired.summary');
  assertStringArray(value.complexityReasons, 'triage route.specRequired.complexityReasons', 1);
  if (!['compact', 'standard'].includes(value.specMode as string)) throw new Error('triage route.specRequired.specMode is invalid');
  assertStringArray(value.reviewFocus, 'triage route.specRequired.reviewFocus', 1);
  assertUnique(value.complexityReasons, 'triage route.specRequired.complexityReasons');
  assertUnique(value.reviewFocus, 'triage route.specRequired.reviewFocus');
}

function validateBlocker(value: unknown): asserts value is BlockerRoute {
  assertExactObject(value, ['kind', 'code', 'summary', 'evidence'], 'triage route.blocker');
  if (!['external', 'safety', 'exhausted'].includes(value.kind as string)) throw new Error('triage route.blocker.kind is invalid');
  assertString(value.code, 'triage route.blocker.code');
  assertString(value.summary, 'triage route.blocker.summary');
  assertStringArray(value.evidence, 'triage route.blocker.evidence', 1);
  assertUnique(value.evidence, 'triage route.blocker.evidence');
}

function assertInactive(value: unknown, field: string): asserts value is null {
  if (value !== null) throw new Error(`triage route.${field} must be inactive null`);
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

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}
