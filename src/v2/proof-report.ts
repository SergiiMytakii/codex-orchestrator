import { posix } from 'node:path';

const MAX_STRING_LENGTH = 16 * 1024;
const MAX_SUMMARY_LENGTH = 4 * 1024;
const MAX_ARRAY_LENGTH = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SURFACES = ['non-visual', 'browser', 'android', 'ios'] as const;
const TARGETS = ['browser', 'android', 'ios'] as const;
const ARTIFACT_KINDS = [
  'command-output', 'static-inspection', 'generated-file', 'screenshot',
  'dom-snapshot', 'console-log', 'network-log', 'ui-hierarchy', 'device-log', 'lease-record',
] as const;

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
    kind: typeof ARTIFACT_KINDS[number];
    relativePath: string;
    sha256: string;
    publishable: boolean;
    description: string;
  }>;
  visualEvidence?: BrowserVisualEvidenceV1 | AndroidVisualEvidenceV1 | IosVisualEvidenceV1;
  findings: string[];
  residualRisks: string[];
  blocker?: ExternalBlocker;
}

interface VisualCaptureV1<Target extends 'browser' | 'android' | 'ios'> {
  target: Target;
  name: string;
  width: number;
  height: number;
  criteriaRefs: string[];
  screenshotRef: string;
  stateRef: string;
}

interface VisualEvidenceCommonV1 {
  workflow: { entrypoint: string; steps: string[]; finalState: string };
  freshness: { capturedAfterFinalInteraction: true };
  layoutReview: Array<{ summary: string; evidenceRefs: string[] }>;
  copyReview: Array<{ summary: string; evidenceRefs: string[] }>;
}

export interface BrowserVisualEvidenceV1 extends VisualEvidenceCommonV1 {
  captures: Array<VisualCaptureV1<'browser'>>;
  diagnostics: { consoleRef: string; networkRef: string };
}

export interface AndroidVisualEvidenceV1 extends VisualEvidenceCommonV1 {
  captures: Array<VisualCaptureV1<'android'>>;
  diagnostics: { deviceLogRef: string };
  lease: { leaseRef: string };
}

export interface IosVisualEvidenceV1 extends VisualEvidenceCommonV1 {
  captures: Array<VisualCaptureV1<'ios'>>;
  diagnostics: { deviceLogRef: string };
  lease: { leaseRef: string };
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
  const visualReport = value.status !== 'external-block' && isRecord(value.decision) && value.decision.mode === 'visual';
  if (value.status === 'passed' || value.status === 'needs-rework') {
    assertExactObject(value, visualReport ? [...commonKeys, 'visualEvidence'] : commonKeys, 'proof report');
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

  if (visualReport) {
    validateVisualEvidence(
      value.visualEvidence,
      criteria,
      value.artifacts as ProofReportV1['artifacts'],
      decision,
    );
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
    artifacts: { type: 'array', maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: artifactSchema() },
    findings: stringArraySchema(),
    residualRisks: stringArraySchema(),
  };
  const passedCriteria = { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: criterionSchema(true) };
  const openCriteria = { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: criterionSchema(false) };
  const passedChecks = { type: 'array', maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: checkSchema(true) };
  const openChecks = { type: 'array', maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: checkSchema(false) };
  return {
    oneOf: [
      reportBranch({
        status: 'passed',
        common,
        decision: nonVisualDecisionSchema(),
        criteria: passedCriteria,
        checks: passedChecks,
        findings: { type: 'array', maxItems: 0, items: boundedStringSchema(MAX_STRING_LENGTH) },
      }),
      reportBranch({
        status: 'passed',
        common,
        decision: browserDecisionSchema(),
        criteria: passedCriteria,
        checks: passedChecks,
        findings: { type: 'array', maxItems: 0, items: boundedStringSchema(MAX_STRING_LENGTH) },
        visualEvidence: browserVisualEvidenceSchema(),
      }),
      reportBranch({
        status: 'passed',
        common,
        decision: androidDecisionSchema(),
        criteria: passedCriteria,
        checks: passedChecks,
        findings: { type: 'array', maxItems: 0, items: boundedStringSchema(MAX_STRING_LENGTH) },
        visualEvidence: androidVisualEvidenceSchema(),
      }),
      reportBranch({
        status: 'passed',
        common,
        decision: iosDecisionSchema(),
        criteria: passedCriteria,
        checks: passedChecks,
        findings: { type: 'array', maxItems: 0, items: boundedStringSchema(MAX_STRING_LENGTH) },
        visualEvidence: iosVisualEvidenceSchema(),
      }),
      reportBranch({
        status: 'needs-rework',
        common,
        decision: nonVisualDecisionSchema(),
        criteria: openCriteria,
        checks: openChecks,
        findings: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, items: boundedStringSchema(MAX_STRING_LENGTH) },
      }),
      reportBranch({
        status: 'needs-rework',
        common,
        decision: browserDecisionSchema(),
        criteria: openCriteria,
        checks: openChecks,
        findings: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, items: boundedStringSchema(MAX_STRING_LENGTH) },
        visualEvidence: browserVisualEvidenceSchema(),
      }),
      reportBranch({
        status: 'needs-rework',
        common,
        decision: androidDecisionSchema(),
        criteria: openCriteria,
        checks: openChecks,
        findings: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, items: boundedStringSchema(MAX_STRING_LENGTH) },
        visualEvidence: androidVisualEvidenceSchema(),
      }),
      reportBranch({
        status: 'needs-rework',
        common,
        decision: iosDecisionSchema(),
        criteria: openCriteria,
        checks: openChecks,
        findings: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, items: boundedStringSchema(MAX_STRING_LENGTH) },
        visualEvidence: iosVisualEvidenceSchema(),
      }),
      reportBranch({
        status: 'external-block',
        common,
        decision: decisionSchema(),
        criteria: openCriteria,
        checks: openChecks,
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
  decision: Record<string, unknown>;
  criteria: Record<string, unknown>;
  checks: Record<string, unknown>;
  findings: unknown;
  blocker?: Record<string, unknown>;
  visualEvidence?: Record<string, unknown>;
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    ...input.common,
    status: { type: 'string', const: input.status },
    decision: input.decision,
    criteria: input.criteria,
    checks: input.checks,
    findings: input.findings,
  };
  const required = ['version', 'status', 'decision', 'criteria', 'checks', 'artifacts', 'findings', 'residualRisks'];
  if (input.visualEvidence) {
    properties.visualEvidence = input.visualEvidence;
    required.push('visualEvidence');
  }
  if (input.blocker) {
    properties.blocker = input.blocker;
    required.push('blocker');
  }
  return { type: 'object', additionalProperties: false, required, properties };
}

function decisionSchema(): Record<string, unknown> {
  return {
    oneOf: [
      nonVisualDecisionSchema(),
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

function nonVisualDecisionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'targets'],
    properties: {
      mode: { type: 'string', const: 'non-visual' },
      targets: { type: 'array', maxItems: 0, uniqueItems: true, items: { type: 'string', enum: TARGETS } },
    },
  };
}

function browserDecisionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'targets'],
    properties: {
      mode: { type: 'string', const: 'visual' },
      targets: { type: 'array', minItems: 1, maxItems: 1, uniqueItems: true, items: { type: 'string', const: 'browser' } },
    },
  };
}

function androidDecisionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'targets'],
    properties: {
      mode: { type: 'string', const: 'visual' },
      targets: { type: 'array', minItems: 1, maxItems: 1, uniqueItems: true, items: { type: 'string', const: 'android' } },
    },
  };
}

function iosDecisionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'targets'],
    properties: {
      mode: { type: 'string', const: 'visual' },
      targets: { type: 'array', minItems: 1, maxItems: 1, uniqueItems: true, items: { type: 'string', const: 'ios' } },
    },
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
      kind: { type: 'string', enum: ARTIFACT_KINDS },
      relativePath: relativePathSchema(),
      sha256: sha256Schema(),
      publishable: { type: 'boolean' },
      description: boundedStringSchema(MAX_SUMMARY_LENGTH),
    },
  };
}

function browserVisualEvidenceSchema(): Record<string, unknown> {
  const reviewSchema = {
    type: 'array',
    minItems: 1,
    maxItems: MAX_ARRAY_LENGTH,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'evidenceRefs'],
      properties: {
        summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
        evidenceRefs: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: boundedStringSchema(MAX_STRING_LENGTH) },
      },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['workflow', 'captures', 'diagnostics', 'freshness', 'layoutReview', 'copyReview'],
    properties: {
      workflow: {
        type: 'object', additionalProperties: false, required: ['entrypoint', 'steps', 'finalState'],
        properties: {
          entrypoint: boundedStringSchema(MAX_STRING_LENGTH),
          steps: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, items: boundedStringSchema(MAX_STRING_LENGTH) },
          finalState: boundedStringSchema(MAX_SUMMARY_LENGTH),
        },
      },
      captures: {
        type: 'array', minItems: 2, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true,
        items: {
          type: 'object', additionalProperties: false,
          required: ['target', 'name', 'width', 'height', 'criteriaRefs', 'screenshotRef', 'stateRef'],
          properties: {
            target: { type: 'string', const: 'browser' },
            name: boundedStringSchema(MAX_STRING_LENGTH),
            width: { type: 'integer' },
            height: { type: 'integer' },
            criteriaRefs: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: boundedStringSchema(MAX_STRING_LENGTH) },
            screenshotRef: boundedStringSchema(MAX_STRING_LENGTH),
            stateRef: boundedStringSchema(MAX_STRING_LENGTH),
          },
        },
      },
      diagnostics: {
        type: 'object', additionalProperties: false, required: ['consoleRef', 'networkRef'],
        properties: { consoleRef: boundedStringSchema(MAX_STRING_LENGTH), networkRef: boundedStringSchema(MAX_STRING_LENGTH) },
      },
      freshness: {
        type: 'object', additionalProperties: false, required: ['capturedAfterFinalInteraction'],
        properties: { capturedAfterFinalInteraction: { type: 'boolean', const: true } },
      },
      layoutReview: reviewSchema,
      copyReview: reviewSchema,
    },
  };
}

function androidVisualEvidenceSchema(): Record<string, unknown> {
  return mobileVisualEvidenceSchema('android');
}

function iosVisualEvidenceSchema(): Record<string, unknown> {
  return mobileVisualEvidenceSchema('ios');
}

function mobileVisualEvidenceSchema(target: 'android' | 'ios'): Record<string, unknown> {
  const reviewSchema = {
    type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH,
    items: {
      type: 'object', additionalProperties: false, required: ['summary', 'evidenceRefs'],
      properties: {
        summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
        evidenceRefs: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: boundedStringSchema(MAX_STRING_LENGTH) },
      },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['workflow', 'captures', 'diagnostics', 'lease', 'freshness', 'layoutReview', 'copyReview'],
    properties: {
      workflow: {
        type: 'object', additionalProperties: false, required: ['entrypoint', 'steps', 'finalState'],
        properties: {
          entrypoint: boundedStringSchema(MAX_STRING_LENGTH),
          steps: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, items: boundedStringSchema(MAX_STRING_LENGTH) },
          finalState: boundedStringSchema(MAX_SUMMARY_LENGTH),
        },
      },
      captures: {
        type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true,
        items: {
          type: 'object', additionalProperties: false,
          required: ['target', 'name', 'width', 'height', 'criteriaRefs', 'screenshotRef', 'stateRef'],
          properties: {
            target: { type: 'string', const: target },
            name: boundedStringSchema(MAX_STRING_LENGTH),
            width: { type: 'integer' },
            height: { type: 'integer' },
            criteriaRefs: { type: 'array', minItems: 1, maxItems: MAX_ARRAY_LENGTH, uniqueItems: true, items: boundedStringSchema(MAX_STRING_LENGTH) },
            screenshotRef: boundedStringSchema(MAX_STRING_LENGTH),
            stateRef: boundedStringSchema(MAX_STRING_LENGTH),
          },
        },
      },
      diagnostics: {
        type: 'object', additionalProperties: false, required: ['deviceLogRef'],
        properties: { deviceLogRef: boundedStringSchema(MAX_STRING_LENGTH) },
      },
      lease: {
        type: 'object', additionalProperties: false, required: ['leaseRef'],
        properties: { leaseRef: boundedStringSchema(MAX_STRING_LENGTH) },
      },
      freshness: {
        type: 'object', additionalProperties: false, required: ['capturedAfterFinalInteraction'],
        properties: { capturedAfterFinalInteraction: { type: 'boolean', const: true } },
      },
      layoutReview: reviewSchema,
      copyReview: reviewSchema,
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
    if (!ARTIFACT_KINDS.includes(artifact.kind as typeof ARTIFACT_KINDS[number])) {
      throw new Error(`${field}.kind is invalid`);
    }
    assertRelativePath(artifact.relativePath, `${field}.relativePath`);
    assertSha256(artifact.sha256, `${field}.sha256`);
    if (typeof artifact.publishable !== 'boolean') throw new Error(`${field}.publishable must be boolean`);
    if (['dom-snapshot', 'console-log', 'network-log', 'ui-hierarchy', 'device-log', 'lease-record'].includes(artifact.kind as string)
      && artifact.publishable !== false) {
      throw new Error(`${field}.kind must remain local-only`);
    }
    assertBoundedString(artifact.description, `${field}.description`, MAX_SUMMARY_LENGTH, true);
    ids.push(artifact.id);
  }
  assertUnique(ids, 'proof report.artifact ids');
}

function validateVisualEvidence(
  value: unknown,
  criteria: ProofReportV1['criteria'],
  artifacts: ProofReportV1['artifacts'],
  decision: ProofReportV1['decision'],
): asserts value is NonNullable<ProofReportV1['visualEvidence']> {
  if (decision.targets.length !== 1) throw new Error('visual proof requires one settled platform target');
  if (decision.targets[0] === 'browser') return validateBrowserVisualEvidence(value, criteria, artifacts, decision);
  if (decision.targets[0] === 'android') return validateAndroidVisualEvidence(value, criteria, artifacts, decision);
  if (decision.targets[0] === 'ios') return validateIosVisualEvidence(value, criteria, artifacts, decision);
  throw new Error('visual proof target is not implemented');
}

function validateBrowserVisualEvidence(
  value: unknown,
  criteria: ProofReportV1['criteria'],
  artifacts: ProofReportV1['artifacts'],
  decision: ProofReportV1['decision'],
): asserts value is NonNullable<ProofReportV1['visualEvidence']> {
  if (decision.targets.length !== 1 || decision.targets[0] !== 'browser') {
    throw new Error('Spec 3 visual proof supports the browser target only');
  }
  assertExactObject(value, ['workflow', 'captures', 'diagnostics', 'freshness', 'layoutReview', 'copyReview'], 'proof report.visualEvidence');
  assertExactObject(value.workflow, ['entrypoint', 'steps', 'finalState'], 'proof report.visualEvidence.workflow');
  assertBoundedString(value.workflow.entrypoint, 'proof report.visualEvidence.workflow.entrypoint', MAX_STRING_LENGTH, true);
  if (!/^https?:\/\//u.test(value.workflow.entrypoint as string)) throw new Error('visual workflow entrypoint must be HTTP(S)');
  assertStringArray(value.workflow.steps, 'proof report.visualEvidence.workflow.steps');
  if (value.workflow.steps.length === 0) throw new Error('visual workflow requires steps');
  assertBoundedString(value.workflow.finalState, 'proof report.visualEvidence.workflow.finalState', MAX_SUMMARY_LENGTH, true);

  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const browserCriteria = criteria.filter((criterion) => criterion.surfaces.includes('browser'));
  const browserCriterionIds = new Set(browserCriteria.map((criterion) => criterion.id));
  if (browserCriteria.length === 0) throw new Error('browser decision requires a browser criterion surface');
  if (!Array.isArray(value.captures) || value.captures.length < 2 || value.captures.length > MAX_ARRAY_LENGTH) {
    throw new Error('browser visual evidence requires at least two captures');
  }
  const captureNames: string[] = [];
  for (const [index, capture] of value.captures.entries()) {
    const field = `proof report.visualEvidence.captures[${index}]`;
    assertExactObject(capture, ['target', 'name', 'width', 'height', 'criteriaRefs', 'screenshotRef', 'stateRef'], field);
    if (capture.target !== 'browser') throw new Error(`${field}.target must be browser`);
    assertBoundedString(capture.name, `${field}.name`, MAX_STRING_LENGTH, true);
    if (!Number.isSafeInteger(capture.width) || !Number.isSafeInteger(capture.height)
      || (capture.width as number) < 1 || (capture.height as number) < 1
      || (capture.width as number) > 10_000 || (capture.height as number) > 10_000) {
      throw new Error(`${field} dimensions are invalid`);
    }
    assertStringArray(capture.criteriaRefs, `${field}.criteriaRefs`);
    assertUnique(capture.criteriaRefs, `${field}.criteriaRefs`);
    if (capture.criteriaRefs.length === 0 || capture.criteriaRefs.some((id) => !browserCriterionIds.has(id))) {
      throw new Error(`${field} has irrelevant criterion mapping`);
    }
    for (const criterionId of browserCriterionIds) {
      if (!capture.criteriaRefs.includes(criterionId)) throw new Error(`${field} omits browser criterion ${criterionId}`);
    }
    assertBoundedString(capture.screenshotRef, `${field}.screenshotRef`, MAX_STRING_LENGTH, true);
    assertBoundedString(capture.stateRef, `${field}.stateRef`, MAX_STRING_LENGTH, true);
    const screenshot = artifactById.get(capture.screenshotRef as string);
    const state = artifactById.get(capture.stateRef as string);
    if (screenshot?.kind !== 'screenshot') throw new Error(`${field} lacks screenshot evidence`);
    if (state?.kind !== 'dom-snapshot') throw new Error(`${field} lacks DOM state evidence`);
    for (const criterionId of capture.criteriaRefs as string[]) {
      const criterion = browserCriteria.find((candidate) => candidate.id === criterionId)!;
      if (!criterion.evidenceRefs.includes(screenshot.id) || !criterion.evidenceRefs.includes(state.id)) {
        throw new Error(`${field} evidence is not linked to criterion ${criterionId}`);
      }
    }
    captureNames.push(capture.name as string);
  }
  assertUnique(captureNames, 'proof report.visualEvidence capture names');
  if (!(value.captures as Array<{ width: number }>).some((capture) => capture.width >= 1024)) {
    throw new Error('browser visual evidence lacks desktop coverage');
  }
  if (!(value.captures as Array<{ width: number }>).some((capture) => capture.width <= 480)) {
    throw new Error('browser visual evidence lacks narrow responsive coverage');
  }

  assertExactObject(value.diagnostics, ['consoleRef', 'networkRef'], 'proof report.visualEvidence.diagnostics');
  if (artifactById.get(value.diagnostics.consoleRef as string)?.kind !== 'console-log') {
    throw new Error('browser visual evidence lacks console diagnostics');
  }
  if (artifactById.get(value.diagnostics.networkRef as string)?.kind !== 'network-log') {
    throw new Error('browser visual evidence lacks network diagnostics');
  }
  assertExactObject(value.freshness, ['capturedAfterFinalInteraction'], 'proof report.visualEvidence.freshness');
  if (value.freshness.capturedAfterFinalInteraction !== true) throw new Error('browser evidence is not post-interaction');
  validateVisualReview(value.layoutReview, 'layoutReview', artifactById);
  validateVisualReview(value.copyReview, 'copyReview', artifactById);
}

function validateAndroidVisualEvidence(
  value: unknown,
  criteria: ProofReportV1['criteria'],
  artifacts: ProofReportV1['artifacts'],
  decision: ProofReportV1['decision'],
): asserts value is AndroidVisualEvidenceV1 {
  validateMobileVisualEvidence(value, criteria, artifacts, decision, 'android');
}

function validateIosVisualEvidence(
  value: unknown,
  criteria: ProofReportV1['criteria'],
  artifacts: ProofReportV1['artifacts'],
  decision: ProofReportV1['decision'],
): asserts value is IosVisualEvidenceV1 {
  validateMobileVisualEvidence(value, criteria, artifacts, decision, 'ios');
}

function validateMobileVisualEvidence(
  value: unknown,
  criteria: ProofReportV1['criteria'],
  artifacts: ProofReportV1['artifacts'],
  decision: ProofReportV1['decision'],
  target: 'android' | 'ios',
): asserts value is AndroidVisualEvidenceV1 | IosVisualEvidenceV1 {
  if (decision.targets.length !== 1 || decision.targets[0] !== target) throw new Error(`${target} visual target mismatch`);
  assertExactObject(value, ['workflow', 'captures', 'diagnostics', 'lease', 'freshness', 'layoutReview', 'copyReview'], 'proof report.visualEvidence');
  assertExactObject(value.workflow, ['entrypoint', 'steps', 'finalState'], 'proof report.visualEvidence.workflow');
  assertBoundedString(value.workflow.entrypoint, 'proof report.visualEvidence.workflow.entrypoint', MAX_STRING_LENGTH, true);
  assertStringArray(value.workflow.steps, 'proof report.visualEvidence.workflow.steps');
  if (value.workflow.steps.length === 0) throw new Error(`${target} visual workflow requires steps`);
  assertBoundedString(value.workflow.finalState, 'proof report.visualEvidence.workflow.finalState', MAX_SUMMARY_LENGTH, true);

  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const androidCriteria = criteria.filter((criterion) => criterion.surfaces.includes(target));
  const androidCriterionIds = new Set(androidCriteria.map((criterion) => criterion.id));
  if (androidCriteria.length === 0) throw new Error(`${target} decision requires a ${target} criterion surface`);
  if (!Array.isArray(value.captures) || value.captures.length === 0 || value.captures.length > MAX_ARRAY_LENGTH) {
    throw new Error(`${target} visual evidence requires a capture`);
  }
  const captureNames: string[] = [];
  for (const [index, capture] of value.captures.entries()) {
    const field = `proof report.visualEvidence.captures[${index}]`;
    assertExactObject(capture, ['target', 'name', 'width', 'height', 'criteriaRefs', 'screenshotRef', 'stateRef'], field);
    if (capture.target !== target) throw new Error(`${field}.target must be ${target}`);
    assertBoundedString(capture.name, `${field}.name`, MAX_STRING_LENGTH, true);
    if (!Number.isSafeInteger(capture.width) || !Number.isSafeInteger(capture.height)
      || (capture.width as number) < 1 || (capture.height as number) < 1
      || (capture.width as number) > 10_000 || (capture.height as number) > 10_000) {
      throw new Error(`${field} dimensions are invalid`);
    }
    assertStringArray(capture.criteriaRefs, `${field}.criteriaRefs`);
    assertUnique(capture.criteriaRefs, `${field}.criteriaRefs`);
    if (capture.criteriaRefs.length === 0 || capture.criteriaRefs.some((id) => !androidCriterionIds.has(id))) {
      throw new Error(`${field} has irrelevant criterion mapping`);
    }
    for (const criterionId of androidCriterionIds) {
      if (!capture.criteriaRefs.includes(criterionId)) throw new Error(`${field} omits ${target} criterion ${criterionId}`);
    }
    assertBoundedString(capture.screenshotRef, `${field}.screenshotRef`, MAX_STRING_LENGTH, true);
    assertBoundedString(capture.stateRef, `${field}.stateRef`, MAX_STRING_LENGTH, true);
    const screenshot = artifactById.get(capture.screenshotRef as string);
    const hierarchy = artifactById.get(capture.stateRef as string);
    if (screenshot?.kind !== 'screenshot') throw new Error(`${field} lacks screenshot evidence`);
    if (hierarchy?.kind !== 'ui-hierarchy') throw new Error(`${field} lacks UI hierarchy evidence`);
    for (const criterionId of capture.criteriaRefs as string[]) {
      const criterion = androidCriteria.find((candidate) => candidate.id === criterionId)!;
      if (!criterion.evidenceRefs.includes(screenshot.id) || !criterion.evidenceRefs.includes(hierarchy.id)) {
        throw new Error(`${field} evidence is not linked to criterion ${criterionId}`);
      }
    }
    captureNames.push(capture.name as string);
  }
  assertUnique(captureNames, 'proof report.visualEvidence capture names');
  assertExactObject(value.diagnostics, ['deviceLogRef'], 'proof report.visualEvidence.diagnostics');
  if (artifactById.get(value.diagnostics.deviceLogRef as string)?.kind !== 'device-log') {
    throw new Error(`${target} visual evidence lacks device log diagnostics`);
  }
  assertExactObject(value.lease, ['leaseRef'], 'proof report.visualEvidence.lease');
  if (artifactById.get(value.lease.leaseRef as string)?.kind !== 'lease-record') {
    throw new Error(`${target} visual evidence lacks lease record`);
  }
  assertExactObject(value.freshness, ['capturedAfterFinalInteraction'], 'proof report.visualEvidence.freshness');
  if (value.freshness.capturedAfterFinalInteraction !== true) throw new Error(`${target} evidence is not post-interaction`);
  validateVisualReview(value.layoutReview, 'layoutReview', artifactById);
  validateVisualReview(value.copyReview, 'copyReview', artifactById);
}

function validateVisualReview(
  value: unknown,
  fieldName: 'layoutReview' | 'copyReview',
  artifactById: Map<string, ProofReportV1['artifacts'][number]>,
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARRAY_LENGTH) {
    throw new Error(`proof report.visualEvidence.${fieldName} must be non-empty`);
  }
  for (const [index, finding] of value.entries()) {
    const field = `proof report.visualEvidence.${fieldName}[${index}]`;
    assertExactObject(finding, ['summary', 'evidenceRefs'], field);
    assertBoundedString(finding.summary, `${field}.summary`, MAX_SUMMARY_LENGTH, true);
    assertStringArray(finding.evidenceRefs, `${field}.evidenceRefs`);
    assertUnique(finding.evidenceRefs, `${field}.evidenceRefs`);
    if (finding.evidenceRefs.length === 0 || finding.evidenceRefs.some((ref) => !artifactById.has(ref))) {
      throw new Error(`${field} has invalid evidence references`);
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  assertRecord(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}
