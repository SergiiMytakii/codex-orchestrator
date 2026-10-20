import { posix } from 'node:path';

import { agentReportEnvelopeSchema } from './report-envelope.js';
import { COMPLETE_REVIEW_COVERAGE } from './code-review-report.js';
import { passedProofReportOutputSchema, validateProofReport, type ProofReportV1 } from './proof-report.js';

const MAX_STRING_LENGTH = 16 * 1024;
const MAX_SUMMARY_LENGTH = 4 * 1024;
const MAX_ARRAY_LENGTH = 256;

export interface ExternalBlocker {
  kind: 'credential' | 'tool' | 'service' | 'decision-delta' | 'out-of-scope' | 'authority-boundary';
  summary: string;
  attempted: string[];
  resumable: boolean;
  reviewerRejectionDetail?: string;
}

const SESSION_ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const REVIEWER_ROLES = ['spec_reviewer', 'standards_reviewer'] as const;

export interface ImplementationReviewV1 {
  summary: string;
  trackedContentSha256: string;
  untrackedContentSha256: string;
  coverage: string[];
  reviewers: Array<{ role: typeof REVIEWER_ROLES[number]; sessionId: string; verdict: 'approve' }>;
}

export interface ImplementationCheck {
  id: string;
  command: string;
  status: 'passed';
  outputSha256: string;
}

/** One source owner coordinates verification; explicit host checks belong to Runner. */
export interface ImplementationReportV1 {
  version: 1;
  status: 'completed' | 'checks-request' | 'android-proof-request' | 'external-block' | 'answer-only' | 'boundary';
  summary: string;
  changedFiles: string[];
  residualRisks: string[];
  checks?: ImplementationCheck[];
  proof?: ProofReportV1;
  review?: ImplementationReviewV1;
  blocker?: ExternalBlocker;
  response?: string;
  boundary?: { kind: 'decision-delta' | 'out-of-scope' | 'authority-boundary' };
}

export function validateImplementationReport(
  value: unknown,
  context: { issueFeedbackActive?: boolean; ownerSessionId?: string } = {},
): ImplementationReportV1 {
  assertRecord(value, 'implementation report');
  let normalizedProof: ProofReportV1 | undefined;
  if (value.status === 'completed') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'checks', 'proof', 'review'], 'implementation report');
  } else if (value.status === 'checks-request') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks'], 'implementation report');
  } else if (value.status === 'android-proof-request') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'checks'], 'implementation report');
  } else if (value.status === 'external-block') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'blocker'], 'implementation report');
  } else if (value.status === 'answer-only') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'response'], 'implementation report');
  } else if (value.status === 'boundary') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'response', 'boundary'], 'implementation report');
  } else {
    throw new Error('implementation report.status is invalid');
  }
  if (value.version !== 1) throw new Error('implementation report.version must be 1');
  assertBoundedString(value.summary, 'implementation report.summary', MAX_SUMMARY_LENGTH, true);
  assertStringArray(value.changedFiles, 'implementation report.changedFiles');
  for (const file of value.changedFiles) assertRelativePath(file, 'implementation report.changedFiles');
  assertUnique(value.changedFiles, 'implementation report.changedFiles');
  assertStringArray(value.residualRisks, 'implementation report.residualRisks');
  if (value.status === 'android-proof-request') validateImplementationChecks(value.checks);
  if (value.status === 'completed') {
    validateImplementationChecks(value.checks);
    assertRecord(value.proof, 'implementation report.proof');
    const proof = { ...value.proof };
    // Native Structured Outputs requires these optional proof fields as nullable keys.
    for (const key of ['visualEvidence', 'blocker']) if (proof[key] === null) delete proof[key];
    if (proof.status !== 'passed') throw new Error('completed implementation requires passed proof');
    normalizedProof = validateProofReport(proof, value.checks.map((check) => check.id));
    validateImplementationReview(value.review, context.ownerSessionId);
  }
  if (value.status === 'completed' && value.changedFiles.length === 0) {
    throw new Error('completed implementation report requires changedFiles');
  }
  if ((value.status === 'answer-only' || value.status === 'boundary') && value.changedFiles.length !== 0) {
    throw new Error(`${value.status} implementation report cannot include changedFiles`);
  }
  if (value.status === 'external-block') validateExternalBlocker(value.blocker, 'implementation report.blocker');
  if (value.status === 'answer-only' || value.status === 'boundary') {
    assertBoundedString(value.response, 'implementation report.response', MAX_SUMMARY_LENGTH, true);
  }
  if (value.status === 'boundary') {
    assertRecord(value.boundary, 'implementation report.boundary');
    assertExactObject(value.boundary, ['kind'], 'implementation report.boundary');
    if (!['decision-delta', 'out-of-scope', 'authority-boundary'].includes(value.boundary.kind as string)) {
      throw new Error('implementation report.boundary.kind is invalid');
    }
  }
  if ((value.status === 'answer-only' || value.status === 'boundary') && context.issueFeedbackActive !== true) {
    throw new Error(`${value.status} implementation report requires active issue feedback`);
  }
  return structuredClone({ ...value, ...(normalizedProof ? { proof: normalizedProof } : {}) }) as unknown as ImplementationReportV1;
}

export function implementationReportOutputSchema(): Record<string, unknown> {
  const commonProperties = {
    version: { type: 'integer', const: 1 },
    summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
    changedFiles: {
      type: 'array',
      maxItems: MAX_ARRAY_LENGTH,
      items: relativePathSchema(),
    },
    residualRisks: stringArraySchema(),
  };
  return agentReportEnvelopeSchema([
      {
        type: 'object', additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks'],
        properties: { ...commonProperties, status: { type: 'string', const: 'checks-request' } },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'checks', 'proof', 'review'],
        properties: {
          ...commonProperties,
          status: { type: 'string', const: 'completed' },
          proof: passedProofReportOutputSchema(),
          review: implementationReviewSchema(),
          checks: { type: 'array', maxItems: MAX_ARRAY_LENGTH, items: {
            type: 'object', additionalProperties: false, required: ['id', 'command', 'status', 'outputSha256'],
            properties: { id: boundedStringSchema(MAX_STRING_LENGTH), command: boundedStringSchema(MAX_STRING_LENGTH),
              status: { type: 'string', const: 'passed' }, outputSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
          } },
          changedFiles: { ...commonProperties.changedFiles, minItems: 1 },
        },
      },
      {
        type: 'object', additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'checks'],
        properties: { ...commonProperties, status: { type: 'string', const: 'android-proof-request' },
          checks: { type: 'array', maxItems: MAX_ARRAY_LENGTH, items: {
            type: 'object', additionalProperties: false, required: ['id', 'command', 'status', 'outputSha256'],
            properties: { id: boundedStringSchema(MAX_STRING_LENGTH), command: boundedStringSchema(MAX_STRING_LENGTH),
              status: { type: 'string', const: 'passed' }, outputSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
          } },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'blocker'],
        properties: {
          ...commonProperties,
          status: { type: 'string', const: 'external-block' },
          blocker: externalBlockerSchema(),
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'response'],
        properties: {
          ...commonProperties,
          status: { type: 'string', const: 'answer-only' },
          changedFiles: { ...commonProperties.changedFiles, maxItems: 0 },
          response: boundedStringSchema(MAX_SUMMARY_LENGTH),
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'response', 'boundary'],
        properties: {
          ...commonProperties,
          status: { type: 'string', const: 'boundary' },
          changedFiles: { ...commonProperties.changedFiles, maxItems: 0 },
          response: boundedStringSchema(MAX_SUMMARY_LENGTH),
          boundary: {
            type: 'object', additionalProperties: false, required: ['kind'],
            properties: { kind: { type: 'string', enum: ['decision-delta', 'out-of-scope', 'authority-boundary'] } },
          },
        },
      },
  ]);
}

export function implementationReportRepairDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown validation failure';
  return `Return one complete JSON object matching the supplied implementation output schema. Validation failed: ${detail}`;
}

export function implementationReportSkillExcerpt(): string {
  return 'Use the packaged Implement skill through the operation contract. Return the supplied report schema with exact configured check evidence for completed work; Git publication and tracker writes are reserved to Runner.';
}

function validateExternalBlocker(value: unknown, field: string): asserts value is ExternalBlocker {
  assertRecord(value, field);
  assertExactObject(value, ['kind', 'summary', 'attempted', 'resumable', ...(hasOwn(value, 'reviewerRejectionDetail') ? ['reviewerRejectionDetail'] : [])], field);
  if (!['credential', 'tool', 'service', 'decision-delta', 'out-of-scope', 'authority-boundary'].includes(value.kind as string)) {
    throw new Error(`${field}.kind is invalid`);
  }
  assertBoundedString(value.summary, `${field}.summary`, MAX_SUMMARY_LENGTH, true);
  assertStringArray(value.attempted, `${field}.attempted`);
  if (typeof value.resumable !== 'boolean') throw new Error(`${field}.resumable is invalid`);
  if (['decision-delta', 'out-of-scope', 'authority-boundary'].includes(value.kind as string) && value.resumable) {
    throw new Error(`${field}.resumable must be false for an authority boundary`);
  }
  if (hasOwn(value, 'reviewerRejectionDetail')) assertBoundedString(value.reviewerRejectionDetail, `${field}.reviewerRejectionDetail`, MAX_SUMMARY_LENGTH, true);
}

function externalBlockerSchema(): Record<string, unknown> {
  const commonProperties = {
    summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
    attempted: stringArraySchema(),
  };
  const variants = [
    {
      ...commonProperties,
      kind: { type: 'string', enum: ['credential', 'tool', 'service'] },
      resumable: { type: 'boolean' },
    },
    {
      ...commonProperties,
      kind: { type: 'string', enum: ['decision-delta', 'out-of-scope', 'authority-boundary'] },
      resumable: { type: 'boolean', const: false },
    },
  ];
  return {
    anyOf: variants.flatMap((properties) => [
      { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
      {
        type: 'object',
        additionalProperties: false,
        required: [...Object.keys(properties), 'reviewerRejectionDetail'],
        properties: { ...properties, reviewerRejectionDetail: boundedStringSchema(MAX_SUMMARY_LENGTH) },
      },
    ]),
  };
}

function stringArraySchema(): Record<string, unknown> {
  return {
    type: 'array',
    maxItems: MAX_ARRAY_LENGTH,
    items: boundedStringSchema(MAX_STRING_LENGTH),
  };
}

function boundedStringSchema(maxLength: number): Record<string, unknown> {
  return { type: 'string', minLength: 1, maxLength };
}

function relativePathSchema(): Record<string, unknown> {
  return {
    type: 'string',
    minLength: 1,
    maxLength: MAX_STRING_LENGTH,
    pattern: '^[^/\\\\]$|^[^/\\\\][^\\\\]*[^/\\\\]$',
  };
}

function assertRelativePath(value: string, field: string): void {
  if (value.startsWith('/') || value.includes('\\') || posix.normalize(value) !== value) {
    throw new Error(`${field} entries must be normalized repository-relative POSIX paths`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${field} entries must not contain empty, dot, or dot-dot segments`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) throw new Error(`${field} must contain at most 256 strings`);
  for (const item of value) assertBoundedString(item, `${field} entry`, MAX_STRING_LENGTH, true);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function assertBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  requireNonEmpty: boolean,
): asserts value is string {
  if (typeof value !== 'string' || value.length > maxLength || (requireNonEmpty && value.length === 0)) {
    throw new Error(`${field} must be a bounded string`);
  }
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  assertRecord(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}

/** Reject missing, duplicate or unsuccessful worker verification instead of publishing unchecked code. */
export function validateImplementationChecks(value: unknown): asserts value is ImplementationCheck[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) throw new Error('implementation checks must be an array');
  const ids = new Set<string>();
  for (const check of value) {
    assertRecord(check, 'implementation check');
    assertExactObject(check, ['id', 'command', 'status', 'outputSha256'], 'implementation check');
    assertBoundedString(check.id, 'implementation check.id', MAX_STRING_LENGTH, true);
    assertBoundedString(check.command, 'implementation check.command', MAX_STRING_LENGTH, true);
    if (check.status !== 'passed' || typeof check.outputSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(check.outputSha256)) {
      throw new Error('implementation check must have passed with an output hash');
    }
    if (ids.has(check.id)) throw new Error('implementation check ids must be unique');
    ids.add(check.id);
  }
}

export function validateImplementationReview(value: unknown, ownerSessionId?: string): asserts value is ImplementationReviewV1 {
  const field = 'implementation report.review';
  assertExactObject(value, ['summary', 'trackedContentSha256', 'untrackedContentSha256', 'coverage', 'reviewers'], field);
  assertBoundedString(value.summary, `${field}.summary`, MAX_SUMMARY_LENGTH, true);
  for (const key of ['trackedContentSha256', 'untrackedContentSha256']) {
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(value[key])) throw new Error(`${field}.${key} must be lowercase SHA-256`);
  }
  assertStringArray(value.coverage, `${field}.coverage`);
  assertUnique(value.coverage, `${field}.coverage`);
  if (value.coverage.length !== COMPLETE_REVIEW_COVERAGE.length
    || value.coverage.some((category) => !(COMPLETE_REVIEW_COVERAGE as readonly string[]).includes(category))) {
    throw new Error(`${field}.coverage requires every complete review category`);
  }
  if (!Array.isArray(value.reviewers) || value.reviewers.length !== 2) throw new Error(`${field} requires both independent reviewers`);
  const roles: string[] = [];
  const sessions: string[] = [];
  for (const reviewer of value.reviewers) {
    assertExactObject(reviewer, ['role', 'sessionId', 'verdict'], `${field}.reviewer`);
    if (!REVIEWER_ROLES.includes(reviewer.role as typeof REVIEWER_ROLES[number]) || reviewer.verdict !== 'approve') {
      throw new Error(`${field} requires approving Spec and Standards reviewers`);
    }
    if (typeof reviewer.sessionId !== 'string' || !new RegExp(SESSION_ID_PATTERN, 'u').test(reviewer.sessionId)) {
      throw new Error(`${field}.reviewer.sessionId must be a canonical UUID`);
    }
    if (reviewer.sessionId === ownerSessionId) throw new Error(`${field} forbids owner self-review`);
    roles.push(reviewer.role as string);
    sessions.push(reviewer.sessionId);
  }
  assertUnique(roles, `${field} reviewer roles`);
  assertUnique(sessions, `${field} reviewer sessions`);
}

function implementationReviewSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false,
    required: ['summary', 'trackedContentSha256', 'untrackedContentSha256', 'coverage', 'reviewers'],
    properties: {
      summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
      trackedContentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      untrackedContentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      coverage: { type: 'array', minItems: COMPLETE_REVIEW_COVERAGE.length, maxItems: COMPLETE_REVIEW_COVERAGE.length,
        items: { type: 'string', enum: [...COMPLETE_REVIEW_COVERAGE] } },
      reviewers: { type: 'array', minItems: 2, maxItems: 2, items: {
        type: 'object', additionalProperties: false, required: ['role', 'sessionId', 'verdict'],
        properties: { role: { type: 'string', enum: [...REVIEWER_ROLES] },
          sessionId: { type: 'string', pattern: SESSION_ID_PATTERN }, verdict: { type: 'string', const: 'approve' } },
      } },
    },
  };
}
