import { posix } from 'node:path';

const MAX_STRING_LENGTH = 16 * 1024;
const MAX_SUMMARY_LENGTH = 4 * 1024;
const MAX_ARRAY_LENGTH = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SURFACES = ['non-visual', 'browser', 'android', 'ios'] as const;
const TARGETS = ['browser', 'android', 'ios'] as const;

interface ExternalBlocker {
  kind: 'credential' | 'tool' | 'service' | 'product-decision';
  summary: string;
  attempted: string[];
}

export interface ProofReportV1 {
  version: 1;
  status: 'passed' | 'needs-rework' | 'external-block';
  decision: { mode: 'non-visual' | 'visual'; targets: Array<'browser' | 'android' | 'ios'> };
  criteria: Array<{
    id: string;
    status: 'passed' | 'failed' | 'unknown';
    confidence: 'high' | 'medium' | 'low';
    surfaces: Array<'non-visual' | 'browser' | 'android' | 'ios'>;
    evidenceRefs: string[];
    analysis: string;
  }>;
  checks: Array<{
    id: string;
    command: string;
    status: 'passed' | 'failed';
    summary: string;
    outputSha256: string;
  }>;
  artifacts: Array<{
    id: string;
    kind: 'command-output' | 'static-inspection' | 'generated-file' | 'screenshot';
    relativePath: string;
    sha256: string;
    publishable: boolean;
    description: string;
  }>;
  findings: string[];
  residualRisks: string[];
  blocker?: ExternalBlocker;
}

export interface ProofReceipt {
  proofId: string;
  bindingSha256: string;
  summary: string;
  publishableEvidence: Array<{
    ref: string;
    kind: 'screenshot' | 'summary';
    sha256: string;
    description: string;
  }>;
  localEvidenceId: string;
}

export function validateProofReport(value: unknown): ProofReportV1 {
  assertRecord(value, 'proof report');
  const commonKeys = ['version', 'status', 'decision', 'criteria', 'checks', 'artifacts', 'findings', 'residualRisks'];
  if (value.status === 'passed' || value.status === 'needs-rework') {
    assertExactObject(value, commonKeys, 'proof report');
  } else if (value.status === 'external-block') {
    assertExactObject(value, [...commonKeys, 'blocker'], 'proof report');
  } else {
    throw new Error('proof report.status is invalid');
  }
  if (value.version !== 1) throw new Error('proof report.version must be 1');
  validateDecision(value.decision);
  validateCriteria(value.criteria, value.status);
  validateChecks(value.checks, value.status);
  validateArtifacts(value.artifacts);
  assertStringArray(value.findings, 'proof report.findings');
  assertStringArray(value.residualRisks, 'proof report.residualRisks');

  if (value.status === 'passed' && value.findings.length !== 0) throw new Error('passed proof report forbids findings');
  if (value.status === 'needs-rework' && value.findings.length === 0) throw new Error('needs-rework proof report requires findings');
  if (value.status === 'external-block') validateExternalBlocker(value.blocker, 'proof report.blocker');

  const decision = value.decision as ProofReportV1['decision'];
  const criteria = value.criteria as ProofReportV1['criteria'];
  if (decision.mode === 'non-visual') {
    if (criteria.some((criterion) => criterion.surfaces.some((surface) => surface !== 'non-visual'))) {
      throw new Error('non-visual proof may use only non-visual criterion surfaces');
    }
  } else {
    const available = new Set<string>(['non-visual', ...decision.targets]);
    if (criteria.some((criterion) => criterion.surfaces.some((surface) => !available.has(surface)))) {
      throw new Error('visual proof criterion surface is absent from decision targets');
    }
  }

  const evidenceIds = new Set<string>([
    ...(value.checks as ProofReportV1['checks']).map((check) => check.id),
    ...(value.artifacts as ProofReportV1['artifacts']).map((artifact) => artifact.id),
  ]);
  for (const criterion of criteria) {
    for (const ref of criterion.evidenceRefs) {
      if (!evidenceIds.has(ref)) throw new Error(`criterion ${criterion.id} references unknown evidence ${ref}`);
    }
    if (value.status === 'passed' && criterion.evidenceRefs.length < criterion.surfaces.length) {
      throw new Error(`passed criterion ${criterion.id} lacks evidence for every surface`);
    }
  }
  return value as unknown as ProofReportV1;
}

export function createProofReceipt(input: {
  proofId: string;
  bindingSha256: string;
  summary: string;
  localEvidenceId: string;
  report: ProofReportV1;
}): ProofReceipt {
  assertBoundedString(input.proofId, 'proofId', MAX_STRING_LENGTH, true);
  assertSha256(input.bindingSha256, 'bindingSha256');
  assertBoundedString(input.summary, 'summary', MAX_SUMMARY_LENGTH, true);
  assertBoundedString(input.localEvidenceId, 'localEvidenceId', MAX_STRING_LENGTH, true);
  const report = validateProofReport(input.report);
  return {
    proofId: input.proofId,
    bindingSha256: input.bindingSha256,
    summary: input.summary,
    publishableEvidence: report.artifacts
      .filter((artifact) => artifact.publishable)
      .map((artifact) => ({
        ref: artifact.id,
        kind: artifact.kind === 'screenshot' ? 'screenshot' as const : 'summary' as const,
        sha256: artifact.sha256,
        description: artifact.description,
      })),
    localEvidenceId: input.localEvidenceId,
  };
}

export function proofReportOutputSchema(): Record<string, unknown> {
  const common = {
    version: { type: 'integer', const: 1 },
    decision: decisionSchema(),
    artifacts: { type: 'array', maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: artifactSchema() },
    findings: stringArraySchema(),
    residualRisks: stringArraySchema(),
  };
  return {
    oneOf: [
      reportBranch({
        status: 'passed',
        common,
        criteria: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: criterionSchema(true) },
        checks: { type: 'array', maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: checkSchema(true) },
        findings: { type: 'array', maxItems: 0, items: boundedStringSchema(MAX_STRING_LENGTH) },
      }),
      reportBranch({
        status: 'needs-rework',
        common,
        criteria: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: criterionSchema(false) },
        checks: { type: 'array', maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: checkSchema(false) },
        findings: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, items: boundedStringSchema(MAX_STRING_LENGTH) },
      }),
      reportBranch({
        status: 'external-block',
        common,
        criteria: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: criterionSchema(false) },
        checks: { type: 'array', maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: checkSchema(false) },
        findings: common.findings,
        blocker: externalBlockerSchema(),
      }),
    ],
  };
}

export function proofReportRepairDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown validation failure';
  return `Return one complete JSON object matching the supplied proof output schema. Validation failed: ${detail}`;
}

export function proofReportSkillExcerpt(): string {
  return 'Independently prove the frozen criteria and return only the JSON object required by the runner-supplied output schema. Do not edit product code, publish, or include credential/path material.';
}

function reportBranch(input: {
  status: ProofReportV1['status'];
  common: Record<string, unknown>;
  criteria: Record<string, unknown>;
  checks: Record<string, unknown>;
  findings: unknown;
  blocker?: Record<string, unknown>;
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    ...input.common,
    status: { type: 'string', const: input.status },
    criteria: input.criteria,
    checks: input.checks,
    findings: input.findings,
  };
  const required = ['version', 'status', 'decision', 'criteria', 'checks', 'artifacts', 'findings', 'residualRisks'];
  if (input.blocker) {
    properties.blocker = input.blocker;
    required.push('blocker');
  }
  return { type: 'object', additionalProperties: false, required, properties };
}

function decisionSchema(): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'targets'],
        properties: {
          mode: { type: 'string', const: 'non-visual' },
          targets: { type: 'array', maxItems: 0, uniqueItems: true, items: { type: 'string', enum: TARGETS } },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'targets'],
        properties: {
          mode: { type: 'string', const: 'visual' },
          targets: { type: 'array', minItems: 1, maxItems: TARGETS.length, uniqueItems: true, items: { type: 'string', enum: TARGETS } },
        },
      },
    ],
  };
}

function criterionSchema(passed: boolean): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status', 'confidence', 'surfaces', 'evidenceRefs', 'analysis'],
    properties: {
      id: boundedStringSchema(MAX_STRING_LENGTH),
      status: passed ? { type: 'string', const: 'passed' } : { type: 'string', enum: ['passed', 'failed', 'unknown'] },
      confidence: passed ? { type: 'string', const: 'high' } : { type: 'string', enum: ['high', 'medium', 'low'] },
      surfaces: { type: 'array', minItems: 1, maxItems: SURFACES.length, uniqueItems: true, items: { type: 'string', enum: SURFACES } },
      evidenceRefs: {
        type: 'array',
        minItems: passed ? 1 : 0,
        maxItems: MAX_ARRAY_LENGTH,
        uniqueItems: true,
        items: boundedStringSchema(MAX_STRING_LENGTH),
      },
      analysis: boundedStringSchema(MAX_SUMMARY_LENGTH),
    },
  };
}

function checkSchema(passed: boolean): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'command', 'status', 'summary', 'outputSha256'],
    properties: {
      id: boundedStringSchema(MAX_STRING_LENGTH),
      command: boundedStringSchema(MAX_STRING_LENGTH),
      status: passed ? { type: 'string', const: 'passed' } : { type: 'string', enum: ['passed', 'failed'] },
      summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
      outputSha256: sha256Schema(),
    },
  };
}

function artifactSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'kind', 'relativePath', 'sha256', 'publishable', 'description'],
    properties: {
      id: boundedStringSchema(MAX_STRING_LENGTH),
      kind: { type: 'string', enum: ['command-output', 'static-inspection', 'generated-file', 'screenshot'] },
      relativePath: relativePathSchema(),
      sha256: sha256Schema(),
      publishable: { type: 'boolean' },
      description: boundedStringSchema(MAX_SUMMARY_LENGTH),
    },
  };
}

function validateDecision(value: unknown): asserts value is ProofReportV1['decision'] {
  assertExactObject(value, ['mode', 'targets'], 'proof report.decision');
  if (value.mode !== 'non-visual' && value.mode !== 'visual') throw new Error('proof report.decision.mode is invalid');
  assertEnumArray(value.targets, TARGETS, 'proof report.decision.targets');
  if (value.mode === 'non-visual' && value.targets.length !== 0) throw new Error('non-visual decision forbids targets');
  if (value.mode === 'visual' && value.targets.length === 0) throw new Error('visual decision requires targets');
}

function validateCriteria(value: unknown, reportStatus: unknown): asserts value is ProofReportV1['criteria'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARRAY_LENGTH) {
    throw new Error('proof report.criteria must contain 1 to 256 entries');
  }
  const ids: string[] = [];
  for (const [index, criterion] of value.entries()) {
    const field = `proof report.criteria[${index}]`;
    assertExactObject(criterion, ['id', 'status', 'confidence', 'surfaces', 'evidenceRefs', 'analysis'], field);
    assertBoundedString(criterion.id, `${field}.id`, MAX_STRING_LENGTH, true);
    if (!['passed', 'failed', 'unknown'].includes(criterion.status as string)) throw new Error(`${field}.status is invalid`);
    if (!['high', 'medium', 'low'].includes(criterion.confidence as string)) throw new Error(`${field}.confidence is invalid`);
    assertEnumArray(criterion.surfaces, SURFACES, `${field}.surfaces`, true);
    assertStringArray(criterion.evidenceRefs, `${field}.evidenceRefs`);
    assertUnique(criterion.evidenceRefs, `${field}.evidenceRefs`);
    assertBoundedString(criterion.analysis, `${field}.analysis`, MAX_SUMMARY_LENGTH, true);
    if (reportStatus === 'passed' && (criterion.status !== 'passed' || criterion.confidence !== 'high')) {
      throw new Error('passed proof requires every criterion passed with high confidence');
    }
    if (reportStatus === 'passed' && criterion.evidenceRefs.length === 0) {
      throw new Error('passed proof requires criterion evidence');
    }
    ids.push(criterion.id);
  }
  assertUnique(ids, 'proof report.criteria ids');
}

function validateChecks(value: unknown, reportStatus: unknown): asserts value is ProofReportV1['checks'] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) throw new Error('proof report.checks must contain at most 256 entries');
  const ids: string[] = [];
  for (const [index, check] of value.entries()) {
    const field = `proof report.checks[${index}]`;
    assertExactObject(check, ['id', 'command', 'status', 'summary', 'outputSha256'], field);
    assertBoundedString(check.id, `${field}.id`, MAX_STRING_LENGTH, true);
    assertBoundedString(check.command, `${field}.command`, MAX_STRING_LENGTH, true);
    if (check.status !== 'passed' && check.status !== 'failed') throw new Error(`${field}.status is invalid`);
    if (reportStatus === 'passed' && check.status !== 'passed') throw new Error('passed proof forbids failed checks');
    assertBoundedString(check.summary, `${field}.summary`, MAX_SUMMARY_LENGTH, true);
    assertSha256(check.outputSha256, `${field}.outputSha256`);
    ids.push(check.id);
  }
  assertUnique(ids, 'proof report.check ids');
}

function validateArtifacts(value: unknown): asserts value is ProofReportV1['artifacts'] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) throw new Error('proof report.artifacts must contain at most 256 entries');
  const ids: string[] = [];
  for (const [index, artifact] of value.entries()) {
    const field = `proof report.artifacts[${index}]`;
    assertExactObject(artifact, ['id', 'kind', 'relativePath', 'sha256', 'publishable', 'description'], field);
    assertBoundedString(artifact.id, `${field}.id`, MAX_STRING_LENGTH, true);
    if (!['command-output', 'static-inspection', 'generated-file', 'screenshot'].includes(artifact.kind as string)) {
      throw new Error(`${field}.kind is invalid`);
    }
    assertRelativePath(artifact.relativePath, `${field}.relativePath`);
    assertSha256(artifact.sha256, `${field}.sha256`);
    if (typeof artifact.publishable !== 'boolean') throw new Error(`${field}.publishable must be boolean`);
    assertBoundedString(artifact.description, `${field}.description`, MAX_SUMMARY_LENGTH, true);
    ids.push(artifact.id);
  }
  assertUnique(ids, 'proof report.artifact ids');
}

function validateExternalBlocker(value: unknown, field: string): asserts value is ExternalBlocker {
  assertExactObject(value, ['kind', 'summary', 'attempted'], field);
  if (!['credential', 'tool', 'service', 'product-decision'].includes(value.kind as string)) throw new Error(`${field}.kind is invalid`);
  assertBoundedString(value.summary, `${field}.summary`, MAX_SUMMARY_LENGTH, true);
  assertStringArray(value.attempted, `${field}.attempted`);
}

function externalBlockerSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'summary', 'attempted'],
    properties: {
      kind: { type: 'string', enum: ['credential', 'tool', 'service', 'product-decision'] },
      summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
      attempted: stringArraySchema(),
    },
  };
}

function stringArraySchema(): Record<string, unknown> {
  return { type: 'array', maxItems: MAX_ARRAY_LENGTH, items: boundedStringSchema(MAX_STRING_LENGTH) };
}

function boundedStringSchema(maxLength: number): Record<string, unknown> {
  return { type: 'string', minLength: 1, maxLength };
}

function sha256Schema(): Record<string, unknown> {
  return { type: 'string', pattern: '^[0-9a-f]{64}$' };
}

function relativePathSchema(): Record<string, unknown> {
  return {
    type: 'string',
    minLength: 1,
    maxLength: MAX_STRING_LENGTH,
    pattern: '^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*//)(?!.*\\/$).+$',
  };
}

function assertRelativePath(value: unknown, field: string): asserts value is string {
  assertBoundedString(value, field, MAX_STRING_LENGTH, true);
  if (value.startsWith('/') || value.includes('\\') || posix.normalize(value) !== value) {
    throw new Error(`${field} must be a normalized repository-relative POSIX path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${field} must not contain empty, dot, or dot-dot segments`);
  }
}

function assertEnumArray<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  requireNonEmpty = false,
): asserts value is Array<T[number]> {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH || (requireNonEmpty && value.length === 0)) {
    throw new Error(`${field} has invalid length`);
  }
  if (value.some((item) => typeof item !== 'string' || !allowed.includes(item))) throw new Error(`${field} has invalid entries`);
  assertUnique(value as string[], field);
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) throw new Error(`${field} must contain at most 256 strings`);
  for (const item of value) assertBoundedString(item, `${field} entry`, MAX_STRING_LENGTH, true);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
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

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  assertRecord(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}
