import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  codeReviewReportOutputSchema,
  hashClosureRequest,
  validateCodeReviewReport,
  type CodeReviewReportV1,
} from '../src/v2/code-review-report.js';

const fingerprint = 'a'.repeat(64);

test('code review report accepts one exact Full report bound to operation and target', () => {
  const report = fullReport();
  assert.deepEqual(validateCodeReviewReport(report, {
    operation: 'code-review', mode: 'full', targetRevision: 1, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', closureRequestSha256: null,
  }), report);
});

test('Closure hash and repair outcomes bind the exact sorted defect/finding coverage', () => {
  const closureRequestSha256 = hashClosureRequest({
    operation: 'code-review', targetRevision: 2, targetFingerprint: fingerprint,
    affectedDefectIds: ['DEF-2', 'DEF-1'],
    fixedRepairFindings: [
      { id: 'proof:p1:bbb', affectedContracts: ['acceptance:b', 'acceptance:a'] },
      { id: 'check:typecheck:aaa', affectedContracts: ['checks'] },
    ],
    mandatoryCoverage: ['spec', 'correctness'],
  });
  const report: CodeReviewReportV1 = {
    ...fullReport(), verdict: 'needs-work', mode: 'closure', targetRevision: 2, closureRequestSha256,
    coverage: ['correctness', 'spec'],
    repairFindingOutcomes: [
      { id: 'check:typecheck:aaa', status: 'verified' },
      { id: 'proof:p1:bbb', status: 'reopened' },
    ],
  };
  assert.deepEqual(validateCodeReviewReport(report, {
    operation: 'code-review', mode: 'closure', targetRevision: 2, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', closureRequestSha256,
    fixedRepairFindingIds: ['check:typecheck:aaa', 'proof:p1:bbb'],
  }), report);
  assert.throws(() => validateCodeReviewReport({
    ...report,
    repairFindingOutcomes: [...report.repairFindingOutcomes].reverse(),
  }, {
    operation: 'code-review', mode: 'closure', targetRevision: 2, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', closureRequestSha256,
    fixedRepairFindingIds: ['check:typecheck:aaa', 'proof:p1:bbb'],
  }), /sorted/u);
});

test('review reports reject stale correlation, unknown keys, invalid supersession, and false approval', () => {
  const report = fullReport();
  for (const changed of [
    { ...report, targetRevision: 2 },
    { ...report, targetFingerprint: 'b'.repeat(64) },
    { ...report, reviewerSessionId: 'other' },
    { ...report, closureRequestSha256: 'c'.repeat(64) },
    { ...report, extra: true },
  ]) {
    assert.throws(() => validateCodeReviewReport(changed, {
      operation: 'code-review', mode: 'full', targetRevision: 1, targetFingerprint: fingerprint,
      reviewerSessionId: 'review-session-1', closureRequestSha256: null,
    }));
  }

  const unresolved = fullReport();
  unresolved.defects = [defect({ status: 'open' })];
  assert.throws(() => validateCodeReviewReport(unresolved, {
    operation: 'code-review', mode: 'full', targetRevision: 1, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', closureRequestSha256: null,
  }), /approved.*unresolved/u);

  const cyclic = fullReport();
  cyclic.verdict = 'needs-work';
  cyclic.defects = [
    defect({ id: 'DEF-1', status: 'superseded', supersededBy: 'DEF-2' }),
    defect({ id: 'DEF-2', status: 'superseded', supersededBy: 'DEF-1' }),
  ];
  assert.throws(() => validateCodeReviewReport(cyclic, {
    operation: 'code-review', mode: 'full', targetRevision: 1, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', closureRequestSha256: null,
  }), /supersession/u);
});

test('generated review output schema is exact at the defect and correlation boundaries', () => {
  const schema = codeReviewReportOutputSchema() as any;
  const report = schema.properties.report;
  assert.equal(report.additionalProperties, false);
  assert.deepEqual(report.required, [
    'version', 'operation', 'targetRevision', 'targetFingerprint', 'verdict', 'mode', 'coverage', 'defects',
    'residualRisks', 'reviewerSessionId', 'closureRequestSha256', 'repairFindingOutcomes',
  ]);
  assert.equal(report.properties.defects.items.additionalProperties, false);
  assert.equal(report.properties.repairFindingOutcomes.items.additionalProperties, false);
});

test('maintained workflow overlay is byte-semantically equal to the runtime schema', async () => {
  const overlay = JSON.parse(await readFile('scripts/runtime-workflow-overlays/schemas/code-review-v1.json', 'utf8'));
  assert.deepEqual(overlay, codeReviewReportOutputSchema());
});

function fullReport(): CodeReviewReportV1 {
  return {
    version: 1,
    operation: 'code-review',
    targetRevision: 1,
    targetFingerprint: fingerprint,
    verdict: 'approved',
    mode: 'full',
    coverage: ['correctness', 'spec'],
    defects: [],
    residualRisks: [],
    reviewerSessionId: 'review-session-1',
    closureRequestSha256: null,
    repairFindingOutcomes: [],
  };
}

function defect(overrides: Partial<CodeReviewReportV1['defects'][number]> = {}): CodeReviewReportV1['defects'][number] {
  return {
    id: 'DEF-1', class: 'blocker', severity: 'high', confidence: 'high', status: 'open',
    invariant: 'Review gates delivery.', failure: 'Delivery can skip review.', evidence: ['src/v2/run-issue.ts'],
    repair: 'Run the review.', affectedTargets: ['src/v2/run-issue.ts'], introducedTargetRevision: 1,
    statusTargetRevision: 1, supersededBy: null, ...overrides,
  };
}
