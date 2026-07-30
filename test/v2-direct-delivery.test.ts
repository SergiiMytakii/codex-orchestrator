import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptApprovedDirectReview, acceptNeedsWorkDirectReview, createInitialDirectReview, prepareDirectReview,
} from '../src/v2/direct-delivery.js';
import type { CodeReviewDefectV1, CodeReviewReportV1 } from '../src/v2/code-review-report.js';

const fingerprint = 'a'.repeat(64);
const defect: CodeReviewDefectV1 = {
  id: 'finding-1', class: 'blocker', severity: 'high', confidence: 'high', status: 'open',
  invariant: 'works', failure: 'broken', evidence: ['test'], repair: 'fix', affectedTargets: ['src/a.ts'],
  introducedTargetRevision: 1, statusTargetRevision: 1, supersededBy: null,
};

function report(overrides: Partial<CodeReviewReportV1>): CodeReviewReportV1 {
  return {
    version: 1, operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    verdict: 'approved', coverage: ['all'], defects: [], residualRisks: [], reviewerSessionId: 'review-1',
    repairFindingOutcomes: [], ...overrides,
  };
}

test('repair creates a new target revision and another complete independent review', () => {
  const initial = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  const needsWork = acceptNeedsWorkDirectReview(initial, report({ verdict: 'needs-work', defects: [defect] }), 'b'.repeat(64));
  const next = prepareDirectReview(needsWork, 'c'.repeat(64), 'review-2');
  assert.equal(next.stage, 'review');
  assert.equal(next.targetRevision, 2);
  assert.equal(next.review.reviewerSessionId, 'review-2');
  assert.equal(JSON.stringify(next).includes('closure'), false);
  const verified = { ...defect, status: 'verified' as const, statusTargetRevision: 2 };
  const clear = acceptApprovedDirectReview(next, report({
    targetRevision: 2, targetFingerprint: 'c'.repeat(64), reviewerSessionId: 'review-2', defects: [verified],
    repairFindingOutcomes: [{ id: 'finding-1', status: 'verified' }],
  }), 'd'.repeat(64));
  assert.equal(clear.status, 'clear');
});
