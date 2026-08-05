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

test('review arrays are byte-bounded by the contained operation rather than semantic item counts', () => {
  const coverage = Array.from({ length: 300 }, (_, index) => `coverage-${index}`);
  assert.deepEqual(validateCodeReviewReport(report({ coverage }), {
    operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', previousFindingIds: [],
  }).coverage, [...coverage].sort());
  assert.equal(JSON.stringify(codeReviewReportOutputSchema()).includes('maxItems'), false);
});

test('approved complete review must cover every Runner-required focus area', () => {
  const context = {
    operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', previousFindingIds: [],
    requiredCoverage: [
      'candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability',
      'repository-standards', 'requirements', 'tests', 'zero-legacy',
    ],
  } as Parameters<typeof validateCodeReviewReport>[1];
  assert.throws(() => validateCodeReviewReport(report({ coverage: ['correctness', 'requirements'] }), context), /required coverage/u);
  const complete = report({ coverage: context.requiredCoverage });
  assert.deepEqual(validateCodeReviewReport(complete, context), complete);
});

test('needs-work requires an open or reopened defect or repair finding', () => {
  assert.throws(() => validateCodeReviewReport(report({ verdict: 'needs-work' }), {
    operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', previousFindingIds: [],
  }), /needs-work.*open or reopened/u);
  assert.throws(() => validateCodeReviewReport(report({
    verdict: 'needs-work', targetRevision: 2,
    repairFindingOutcomes: [{ id: 'finding-1', status: 'verified' }],
  }), {
    operation: 'code-review', targetRevision: 2, targetFingerprint: fingerprint,
    reviewerSessionId: 'review-session-1', previousFindingIds: ['finding-1'],
  }), /needs-work.*open or reopened/u);
});
