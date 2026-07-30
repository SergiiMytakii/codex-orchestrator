import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codeReviewReportOutputSchema, validateCodeReviewReport, type CodeReviewReportV1 } from '../src/v2/code-review-report.js';

const fingerprint = 'a'.repeat(64);

function report(overrides: Partial<CodeReviewReportV1> = {}): CodeReviewReportV1 {
  return {
    version: 1, operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    verdict: 'approved', coverage: ['acceptance'], defects: [], residualRisks: [],
    reviewerSessionId: 'review-session-1', repairFindingOutcomes: [], ...overrides,
  };
}

test('accepts an independent complete review bound to one target revision', () => {
  assert.deepEqual(validateCodeReviewReport(report(), {
    operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', previousFindingIds: [],
  }), report());
});

test('every repair review accounts for every previous finding ID', () => {
  const repaired = report({
    targetRevision: 2,
    repairFindingOutcomes: [{ id: 'finding-1', status: 'verified' }],
  });
  assert.deepEqual(validateCodeReviewReport(repaired, {
    operation: 'code-review', targetRevision: 2, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', previousFindingIds: ['finding-1'],
  }), repaired);
  assert.throws(() => validateCodeReviewReport({ ...repaired, repairFindingOutcomes: [] }, {
    operation: 'code-review', targetRevision: 2, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', previousFindingIds: ['finding-1'],
  }), /previous finding IDs/u);
});

test('generated schema has no Full Closure or closure hash contract', () => {
  const text = JSON.stringify(codeReviewReportOutputSchema());
  assert.equal(text.includes('closure'), false);
  assert.equal(text.includes('mode'), false);
});
