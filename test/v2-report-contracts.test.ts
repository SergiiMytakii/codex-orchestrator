import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  implementationReportOutputSchema,
  validateImplementationReport,
  type ImplementationReportV1,
} from '../src/v2/implementation-report.js';
import {
  createProofReceipt,
  proofReportOutputSchema,
  validateProofReport,
  type ProofReportV1,
} from '../src/v2/proof-report.js';
import { decodeAgentReportForValidation, unwrapAgentReportEnvelope } from '../src/v2/report-envelope.js';

const completedImplementation: ImplementationReportV1 = {
  version: 1,
  status: 'completed',
  summary: 'Implemented the requested behavior.',
  changedFiles: ['src/feature.ts'],
  residualRisks: [],
};

const passedProof: ProofReportV1 = {
  version: 1,
  status: 'passed',
  decision: { mode: 'non-visual', targets: [] },
  criteria: [{
    id: 'ac-001',
    status: 'passed',
    confidence: 'high',
    surfaces: ['non-visual'],
    evidenceRefs: ['check:typecheck', 'artifact:inspection'],
    analysis: 'The focused check and source inspection prove the behavior.',
  }],
  checks: [{
    id: 'check:typecheck',
    command: 'npm run typecheck',
    status: 'passed',
    summary: 'TypeScript accepted the change.',
    outputSha256: 'a'.repeat(64),
  }],
  artifacts: [
    {
      id: 'artifact:inspection',
      kind: 'static-inspection',
      relativePath: '.codex-orchestrator/v2/proofs/inspection.txt',
      sha256: 'b'.repeat(64),
      publishable: false,
      description: 'Local source inspection.',
    },
    {
      id: 'artifact:screenshot',
      kind: 'screenshot',
      relativePath: '.codex-orchestrator/v2/proofs/result.png',
      sha256: 'c'.repeat(64),
      publishable: true,
      description: 'Publishable result.',
    },
  ],
  findings: [],
  residualRisks: [],
};

const visualProof: ProofReportV1 = {
  ...passedProof,
  decision: { mode: 'visual', targets: ['browser'] },
  criteria: [{
    id: 'ac-web', status: 'passed', confidence: 'high', surfaces: ['browser'],
    evidenceRefs: ['shot-wide', 'dom-wide', 'shot-narrow', 'dom-narrow'],
    analysis: 'The final workflow state is visible at both required widths.',
  }],
  checks: [],
  artifacts: [
    visualArtifact('shot-wide', 'screenshot', 'proofs/visual/wide.png', true),
    visualArtifact('dom-wide', 'dom-snapshot', 'proofs/visual/wide.json', false),
    visualArtifact('shot-narrow', 'screenshot', 'proofs/visual/narrow.png', true),
    visualArtifact('dom-narrow', 'dom-snapshot', 'proofs/visual/narrow.json', false),
    visualArtifact('console', 'console-log', 'proofs/visual/console.json', false),
    visualArtifact('network', 'network-log', 'proofs/visual/network.json', false),
  ],
  visualEvidence: {
    workflow: { entrypoint: 'http://127.0.0.1:4173/', steps: ['Open', 'Activate'], finalState: 'Dashboard ready' },
    captures: [
      { target: 'browser', name: 'wide', width: 1280, height: 720, criteriaRefs: ['ac-web'], screenshotRef: 'shot-wide', stateRef: 'dom-wide' },
      { target: 'browser', name: 'narrow', width: 390, height: 844, criteriaRefs: ['ac-web'], screenshotRef: 'shot-narrow', stateRef: 'dom-narrow' },
    ],
    diagnostics: { consoleRef: 'console', networkRef: 'network' },
    freshness: { capturedAfterFinalInteraction: true },
    layoutReview: [{ summary: 'Responsive layout is aligned and unclipped.', evidenceRefs: ['shot-wide', 'shot-narrow'] }],
    copyReview: [{ summary: 'Visible copy matches the criterion.', evidenceRefs: ['dom-wide', 'dom-narrow'] }],
  },
};

const androidVisualProof: ProofReportV1 = {
  ...passedProof,
  decision: { mode: 'visual', targets: ['android'] },
  criteria: [{
    id: 'ac-android', status: 'passed', confidence: 'high', surfaces: ['android'],
    evidenceRefs: ['android-shot', 'android-tree'],
    analysis: 'The leased Android workflow reached its final visible state.',
  }],
  checks: [],
  artifacts: [
    visualArtifact('android-shot', 'screenshot', 'proofs/android/final.png', true),
    visualArtifact('android-tree', 'ui-hierarchy', 'proofs/android/final.xml', false),
    visualArtifact('android-log', 'device-log', 'proofs/android/logcat.txt', false),
    visualArtifact('android-lease', 'lease-record', 'proofs/android/lease.json', false),
  ],
  visualEvidence: {
    workflow: { entrypoint: 'dev.codex.proof/.MainActivity', steps: ['Open', 'Activate'], finalState: 'Android proof ready' },
    captures: [{
      target: 'android', name: 'final', width: 1080, height: 2424, criteriaRefs: ['ac-android'],
      screenshotRef: 'android-shot', stateRef: 'android-tree',
    }],
    diagnostics: { deviceLogRef: 'android-log' },
    lease: { leaseRef: 'android-lease' },
    freshness: { capturedAfterFinalInteraction: true },
    layoutReview: [{ summary: 'The Android layout is aligned and unclipped.', evidenceRefs: ['android-shot'] }],
    copyReview: [{ summary: 'Visible Android copy matches the criterion.', evidenceRefs: ['android-shot', 'android-tree'] }],
  },
};

const iosVisualProof: ProofReportV1 = {
  ...passedProof,
  decision: { mode: 'visual', targets: ['ios'] },
  criteria: [{
    id: 'ac-ios', status: 'passed', confidence: 'high', surfaces: ['ios'],
    evidenceRefs: ['ios-shot', 'ios-tree'],
    analysis: 'The runner-created iOS workflow reached its final visible state.',
  }],
  checks: [],
  artifacts: [
    visualArtifact('ios-shot', 'screenshot', 'proofs/ios/final.png', true),
    visualArtifact('ios-tree', 'ui-hierarchy', 'proofs/ios/final.txt', false),
    visualArtifact('ios-log', 'device-log', 'proofs/ios/simulator.log', false),
    visualArtifact('ios-lease', 'lease-record', 'proofs/ios/lease.json', false),
  ],
  visualEvidence: {
    workflow: { entrypoint: 'dev.codex.proof', steps: ['Open', 'Activate'], finalState: 'iOS proof ready' },
    captures: [{
      target: 'ios', name: 'final', width: 1206, height: 2622, criteriaRefs: ['ac-ios'],
      screenshotRef: 'ios-shot', stateRef: 'ios-tree',
    }],
    diagnostics: { deviceLogRef: 'ios-log' },
    lease: { leaseRef: 'ios-lease' },
    freshness: { capturedAfterFinalInteraction: true },
    layoutReview: [{ summary: 'The iOS layout is aligned and unclipped.', evidenceRefs: ['ios-shot'] }],
    copyReview: [{ summary: 'Visible iOS copy matches the criterion.', evidenceRefs: ['ios-shot', 'ios-tree'] }],
  },
};

test('implementation output schema and runtime validator have parity across status branches', () => {
  const fixtures: Array<{ value: unknown; accepted: boolean }> = [
    { value: completedImplementation, accepted: true },
    {
      value: {
        ...completedImplementation,
        status: 'external-block',
        changedFiles: [],
        blocker: { kind: 'credential', summary: 'Login required.', attempted: ['codex login status'] },
      },
      accepted: true,
    },
    { value: { ...completedImplementation, changedFiles: [] }, accepted: false },
    {
      value: {
        ...completedImplementation,
        blocker: { kind: 'tool', summary: 'Unexpected blocker.', attempted: ['tool'] },
      },
      accepted: false,
    },
    { value: { ...completedImplementation, status: 'external-block' }, accepted: false },
    { value: { ...completedImplementation, residualRisks: [''] }, accepted: false },
    { value: { ...completedImplementation, summary: 'x'.repeat(4097) }, accepted: false },
    { value: { ...completedImplementation, extra: true }, accepted: false },
  ];

  assertParity(fixtures, implementationReportOutputSchema(), validateImplementationReport);
});

test('agent output schemas use a Structured Outputs compatible root envelope', () => {
  for (const schema of [implementationReportOutputSchema(), proofReportOutputSchema()]) {
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['report']);
    assert.equal(schema.additionalProperties, false);
    assertNoKeyword(schema, 'oneOf');
    assertNoKeyword(schema, 'uniqueItems');
    assertNoRegexLookaround(schema);
  }
  assert.equal(Array.isArray((implementationReportOutputSchema().properties as Record<string, any>).report.anyOf), true);
  assert.equal((proofReportOutputSchema().properties as Record<string, any>).report.type, 'object');
  assert.deepEqual(unwrapAgentReportEnvelope({ report: completedImplementation }), completedImplementation);
  assert.deepEqual(
    unwrapAgentReportEnvelope({ report: { ...passedProof, visualEvidence: null, blocker: null } }, ['visualEvidence', 'blocker']),
    passedProof,
  );
  assert.throws(() => unwrapAgentReportEnvelope(completedImplementation), /report envelope/u);
  assert.throws(() => unwrapAgentReportEnvelope({ report: completedImplementation, extra: true }), /report envelope/u);
});

test('contained adapters preserve malformed report bytes for owner-level validation and repair', () => {
  assert.deepEqual(
    decodeAgentReportForValidation(Buffer.from(JSON.stringify({ report: completedImplementation }))),
    completedImplementation,
  );
  assert.equal(decodeAgentReportForValidation(Buffer.from('{bad json')), '{bad json');
  assert.deepEqual(
    decodeAgentReportForValidation(Buffer.from(JSON.stringify({ unexpected: completedImplementation }))),
    { unexpected: completedImplementation },
  );
});

test('runtime validators enforce uniqueness omitted from the supported generation schema', () => {
  const duplicateImplementation = { ...completedImplementation, changedFiles: ['src/feature.ts', 'src/feature.ts'] };
  assert.equal(schemaAccepts(implementationReportOutputSchema(), { report: duplicateImplementation }), true);
  assert.throws(() => validateImplementationReport(duplicateImplementation), /unique/u);

  const duplicateProof = {
    ...passedProof,
    criteria: [{ ...passedProof.criteria[0], surfaces: ['non-visual', 'non-visual'] }],
  };
  assert.equal(schemaAccepts(proofReportOutputSchema(), { report: generatedProofReport(duplicateProof) }), true);
  assert.throws(() => validateProofReport(duplicateProof), /unique/u);
});

test('runtime validators enforce repository paths omitted from the supported generation regex subset', () => {
  const unsafeImplementation = { ...completedImplementation, changedFiles: ['../escape.ts'] };
  assert.equal(schemaAccepts(implementationReportOutputSchema(), { report: unsafeImplementation }), true);
  assert.throws(() => validateImplementationReport(unsafeImplementation), /relative POSIX paths|dot-dot segments/u);

  const unsafeProof = {
    ...passedProof,
    artifacts: [{ ...passedProof.artifacts[0], relativePath: '../outside.txt' }],
  };
  assert.equal(schemaAccepts(proofReportOutputSchema(), { report: generatedProofReport(unsafeProof) }), true);
  assert.throws(() => validateProofReport(unsafeProof), /relative POSIX paths|dot-dot segments/u);
});

test('generation schemas reject absolute, backslash, and trailing-slash paths without lookaround', () => {
  for (const changedFile of ['/tmp/feature.ts', 'src\\feature.ts', 'src/feature/']) {
    assert.equal(schemaAccepts(implementationReportOutputSchema(), {
      report: { ...completedImplementation, changedFiles: [changedFile] },
    }), false);
  }
});

test('proof output schema covers valid terminal reports and runtime validator rejects invalid combinations', () => {
  const fixtures: Array<{ value: unknown; accepted: boolean }> = [
    { value: passedProof, accepted: true },
    { value: visualProof, accepted: true },
    { value: androidVisualProof, accepted: true },
    { value: iosVisualProof, accepted: true },
    { value: { ...visualProof, visualEvidence: undefined }, accepted: false },
    { value: { ...androidVisualProof, visualEvidence: { ...androidVisualProof.visualEvidence, lease: undefined } }, accepted: false },
    { value: { ...iosVisualProof, visualEvidence: { ...iosVisualProof.visualEvidence, diagnostics: {} } }, accepted: false },
    {
      value: {
        ...passedProof,
        status: 'needs-rework',
        criteria: [{ ...passedProof.criteria[0], status: 'failed', confidence: 'medium' }],
        findings: ['The behavior is incomplete.'],
      },
      accepted: true,
    },
    {
      value: {
        ...passedProof,
        status: 'external-block',
        criteria: [{ ...passedProof.criteria[0], status: 'unknown', confidence: 'low' }],
        blocker: { kind: 'service', summary: 'Fixture unavailable.', attempted: ['retry fixture'] },
      },
      accepted: true,
    },
    { value: { ...passedProof, criteria: [{ ...passedProof.criteria[0], confidence: 'medium' }] }, accepted: false },
    { value: { ...passedProof, findings: ['Unexpected finding.'] }, accepted: false },
    { value: { ...passedProof, status: 'needs-rework', findings: [] }, accepted: false },
    { value: { ...passedProof, status: 'external-block' }, accepted: false },
    { value: { ...passedProof, residualRisks: [''] }, accepted: false },
    {
      value: {
        ...passedProof,
        artifacts: [{ ...passedProof.artifacts[0], kind: 'command-output', publishable: true }],
      },
      accepted: false,
    },
    { value: { ...passedProof, extra: true }, accepted: false },
  ];

  assertRuntimeContract(fixtures, proofReportOutputSchema(), validateProofReport, generatedProofReport);
});

test('proof runtime validation rejects dangling evidence, duplicate IDs, and non-canonical artifact paths', () => {
  assert.throws(() => validateProofReport({
    ...passedProof,
    criteria: [{ ...passedProof.criteria[0], evidenceRefs: ['artifact:missing'] }],
  }));
  assert.throws(() => validateProofReport({
    ...passedProof,
    checks: [passedProof.checks[0], passedProof.checks[0]],
  }));
  assert.throws(() => validateProofReport({
    ...passedProof,
    artifacts: [{ ...passedProof.artifacts[0], relativePath: '../outside.txt' }],
  }));
});

test('ProofReceipt contains only sanitized references and never raw local artifact paths', () => {
  const receipt = createProofReceipt({
    proofId: 'proof-123',
    bindingSha256: 'd'.repeat(64),
    summary: 'Acceptance proof passed.',
    localEvidenceId: 'local-proof-123',
    report: validateProofReport(passedProof),
  });

  assert.deepEqual(receipt, {
    proofId: 'proof-123',
    bindingSha256: 'd'.repeat(64),
    summary: 'Acceptance proof passed.',
    publishableEvidence: [{
      ref: 'artifact:screenshot',
      kind: 'screenshot',
      sha256: 'c'.repeat(64),
      description: 'Publishable result.',
    }],
    localEvidenceId: 'local-proof-123',
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes('relativePath'), false);
  assert.equal(serialized.includes('.codex-orchestrator'), false);
  assert.equal(serialized.includes('platform'), false);
  assert.equal(serialized.includes('lease'), false);
  assert.equal(serialized.includes('repair'), false);
});

function assertParity(
  fixtures: Array<{ value: unknown; accepted: boolean }>,
  schema: Record<string, unknown>,
  validate: (value: unknown) => unknown,
): void {
  for (const fixture of fixtures) {
    assert.equal(schemaAccepts(schema, { report: fixture.value }), fixture.accepted, `schema parity failed for ${JSON.stringify(fixture.value)}`);
    assert.equal(runtimeAccepts(validate, fixture.value), fixture.accepted, `runtime parity failed for ${JSON.stringify(fixture.value)}`);
  }
}

function assertRuntimeContract(
  fixtures: Array<{ value: unknown; accepted: boolean }>,
  schema: Record<string, unknown>,
  validate: (value: unknown) => unknown,
  generatedValue: (value: unknown) => unknown,
): void {
  for (const fixture of fixtures) {
    if (fixture.accepted) {
      assert.equal(schemaAccepts(schema, { report: generatedValue(fixture.value) }), true, `schema rejected valid ${JSON.stringify(fixture.value)}`);
    }
    assert.equal(runtimeAccepts(validate, fixture.value), fixture.accepted, `runtime contract failed for ${JSON.stringify(fixture.value)}`);
  }
}

function generatedProofReport(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const report = value as Record<string, unknown>;
  return {
    ...report,
    visualEvidence: report.visualEvidence ?? null,
    blocker: report.blocker ?? null,
  };
}

function assertNoKeyword(value: unknown, keyword: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoKeyword(item, keyword);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  assert.equal(Object.hasOwn(value, keyword), false, `schema contains unsupported ${keyword}`);
  for (const child of Object.values(value)) assertNoKeyword(child, keyword);
}

function assertNoRegexLookaround(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoRegexLookaround(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const pattern = (value as Record<string, unknown>).pattern;
  if (typeof pattern === 'string') assert.doesNotMatch(pattern, /\(\?/u);
  for (const child of Object.values(value)) assertNoRegexLookaround(child);
}

function visualArtifact(
  id: string,
  kind: ProofReportV1['artifacts'][number]['kind'],
  relativePath: string,
  publishable: boolean,
): ProofReportV1['artifacts'][number] {
  return { id, kind, relativePath, publishable, sha256: 'e'.repeat(64), description: `${id} evidence` };
}

function runtimeAccepts(validate: (value: unknown) => unknown, value: unknown): boolean {
  try {
    validate(value);
    return true;
  } catch {
    return false;
  }
}

function schemaAccepts(schema: Record<string, unknown>, value: unknown): boolean {
  const anyOf = schema.anyOf as Array<Record<string, unknown>> | undefined;
  if (anyOf) return anyOf.some((branch) => schemaAccepts(branch, value));
  const oneOf = schema.oneOf as Array<Record<string, unknown>> | undefined;
  if (oneOf) return oneOf.filter((branch) => schemaAccepts(branch, value)).length === 1;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return false;
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    if (required.some((key) => !(key in record))) return false;
    const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    if (schema.additionalProperties === false && Object.keys(record).some((key) => !(key in properties))) return false;
    return Object.entries(record).every(([key, item]) => !properties[key] || schemaAccepts(properties[key], item));
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    return value.every((item) => schemaAccepts(schema.items as Record<string, unknown>, item));
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return false;
    return true;
  }
  if (schema.type === 'integer') return Number.isSafeInteger(value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return true;
}
