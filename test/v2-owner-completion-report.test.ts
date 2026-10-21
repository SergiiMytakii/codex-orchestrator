import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { COMPLETE_REVIEW_COVERAGE } from '../src/v2/code-review-report.js';
import { implementationReportOutputSchema, validateImplementationReport } from '../src/v2/implementation-report.js';

const ownerSessionId = '019a0000-0000-7000-8000-000000000001';
function completedReport() {
  return {
    version: 1, status: 'completed', summary: 'Completed and independently reviewed.',
    changedFiles: ['src/feature.ts'], residualRisks: [],
    checks: [{ id: 'test', command: 'npm test', status: 'passed', outputSha256: 'a'.repeat(64) }],
    proof: {
      version: 1, status: 'passed', decision: { mode: 'non-visual', targets: [] },
      criteria: [{ id: 'ac-1', status: 'passed', confidence: 'high', surfaces: ['non-visual'], evidenceRefs: ['test'], analysis: 'The configured test proves the requested behavior.' }],
      checks: [], artifacts: [], findings: [], residualRisks: [],
    },
    review: {
      summary: 'Both reviewers approved the final source and proof.', trackedContentSha256: 'b'.repeat(64), untrackedContentSha256: 'c'.repeat(64),
      coverage: [...COMPLETE_REVIEW_COVERAGE],
      reviewers: [
        { role: 'spec_reviewer', sessionId: '019a0000-0000-7000-8000-000000000002', verdict: 'approve' },
        { role: 'standards_reviewer', sessionId: '019a0000-0000-7000-8000-000000000003', verdict: 'approve' },
      ],
    },
  };
}

test('completed implementation fails closed when owner proof or independent review is missing', () => {
  const { proof, review, ...legacy } = completedReport();
  assert.throws(() => validateImplementationReport(legacy), /missing keys/u);
  assert.throws(() => validateImplementationReport({ ...legacy, proof }), /missing keys/u);
  assert.throws(() => validateImplementationReport({ ...legacy, review }), /missing keys/u);
});

test('owner completion validates passing evidence and returns an isolated normalized clone', () => {
  const report = completedReport();
  const nativeReport = { ...report, proof: { ...report.proof, visualEvidence: null, blocker: null } };
  const validated = validateImplementationReport(nativeReport, { ownerSessionId });
  assert.deepEqual(validated, report);
  assert.notEqual(validated.proof, nativeReport.proof);
  assert.notEqual(validated.review?.reviewers, nativeReport.review.reviewers);
  nativeReport.review.reviewers[0]!.sessionId = ownerSessionId;
  assert.equal(validated.review?.reviewers[0]?.sessionId, '019a0000-0000-7000-8000-000000000002');
  assert.equal(nativeReport.proof.visualEvidence, null, 'normalization must not mutate input');
});

test('owner completion rejects incomplete or dependent review and unbound source hashes', () => {
  const report = completedReport();
  const reviews = [
    { ...report.review, reviewers: [report.review.reviewers[0]] },
    { ...report.review, reviewers: [report.review.reviewers[0], { ...report.review.reviewers[1], role: 'spec_reviewer' }] },
    { ...report.review, reviewers: [report.review.reviewers[0], { ...report.review.reviewers[1], sessionId: report.review.reviewers[0]!.sessionId }] },
    { ...report.review, reviewers: [{ ...report.review.reviewers[0], sessionId: ownerSessionId }, report.review.reviewers[1]] },
    { ...report.review, reviewers: [{ ...report.review.reviewers[0], sessionId: 'not-a-uuid' }, report.review.reviewers[1]] },
    { ...report.review, reviewers: [{ ...report.review.reviewers[0], role: 'other' }, report.review.reviewers[1]] },
    { ...report.review, reviewers: [{ ...report.review.reviewers[0], verdict: 'block' }, report.review.reviewers[1]] },
    { ...report.review, coverage: report.review.coverage.slice(1) },
    { ...report.review, coverage: [...report.review.coverage.slice(1), report.review.coverage[1]] },
    { ...report.review, coverage: [...report.review.coverage.slice(1), 'unknown'] },
    { ...report.review, trackedContentSha256: 'bad' },
    { ...report.review, untrackedContentSha256: 'A'.repeat(64) },
    { ...report.review, summary: '' },
    { ...report.review, summary: 'x'.repeat(4097) },
    { ...report.review, extra: true },
  ];
  for (const review of reviews) assert.throws(() => validateImplementationReport({ ...report, review }, { ownerSessionId }));
});

test('owner completion delegates every criterion and evidence reference to strict proof validation', () => {
  const report = completedReport();
  const proofs = [
    { ...report.proof, status: 'needs-rework', findings: ['Still broken'] },
    { ...report.proof, criteria: [{ ...report.proof.criteria[0], status: 'failed' }] },
    { ...report.proof, criteria: [{ ...report.proof.criteria[0], confidence: 'medium' }] },
    { ...report.proof, criteria: [{ ...report.proof.criteria[0], evidenceRefs: [] }] },
    { ...report.proof, criteria: [{ ...report.proof.criteria[0], evidenceRefs: ['unknown'] }] },
    { ...report.proof, extra: null },
  ];
  for (const proof of proofs) assert.throws(() => validateImplementationReport({ ...report, proof }));
});

test('native completion schema requires full passed proof and independent review fields', () => {
  const envelope = implementationReportOutputSchema() as any;
  const schema = envelope.properties.report.anyOf.find((branch: any) => branch.properties.status.const === 'completed');
  assert.deepEqual(schema.required, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'checks', 'proof', 'review']);
  assert.equal(schema.properties.proof.properties.status.const, 'passed');
  assert.equal(schema.properties.proof.properties.criteria.items.properties.status.const, 'passed');
  assert.equal(schema.properties.proof.properties.criteria.items.properties.evidenceRefs.minItems, 1);
  assert.equal(schema.properties.review.additionalProperties, false);
  assert.deepEqual(schema.properties.review.properties.reviewers.items.properties.role.enum, ['spec_reviewer', 'standards_reviewer']);
  assert.equal(schema.properties.review.properties.reviewers.minItems, 2);
  assert.equal(schema.properties.review.properties.reviewers.maxItems, 2);
  assert.deepEqual(schema.properties.review.properties.coverage.items.enum, [...COMPLETE_REVIEW_COVERAGE]);
});

test('owner completion accepts actual canonical collaboration identities without weakening independent review', () => {
  const report = completedReport();
  report.review.reviewers[0]!.sessionId = '/root/spec_467_final';
  report.review.reviewers[1]!.sessionId = '/root/standards_467_final';
  assert.equal(validateImplementationReport(report, { ownerSessionId }).status, 'completed');
  const envelope = implementationReportOutputSchema() as any;
  const schema = envelope.properties.report.anyOf.find((branch: any) => branch.properties.status.const === 'completed');
  const identity = schema.properties.review.properties.reviewers.items.properties.sessionId;
  assert.match(report.review.reviewers[0]!.sessionId, new RegExp(identity.pattern, 'u'));
  const packaged = JSON.parse(readFileSync(new URL('../../internal-workflow/schemas/implementation-report-v1.json', import.meta.url), 'utf8'));
  const packagedIdentity = packaged.properties.report.anyOf.find((branch: any) => branch.properties.status.const === 'completed').properties.review.properties.reviewers.items.properties.sessionId;
  assert.deepEqual(packagedIdentity, identity);
  const mixed = structuredClone(report); mixed.review.reviewers[1]!.sessionId = '019a0000-0000-7000-8000-000000000003';
  assert.equal(validateImplementationReport(mixed, { ownerSessionId }).status, 'completed');
  assert.throws(() => validateImplementationReport(report, { ownerSessionId: '/root/spec_467_final' }), /self-review/u);
  for (const invalid of ['/root', '/root/../owner', '/root//spec', 'spec_467_final', '/root/spec;echo', '/root/' + 'x'.repeat(16 * 1024 + 1)]) {
    const bad = structuredClone(report); bad.review.reviewers[0]!.sessionId = invalid;
    assert.throws(() => validateImplementationReport(bad, { ownerSessionId }), invalid);
  }
  const duplicate = structuredClone(report);
  duplicate.review.reviewers[1]!.sessionId = duplicate.review.reviewers[0]!.sessionId;
  assert.throws(() => validateImplementationReport(duplicate, { ownerSessionId }), /unique/u);
});
