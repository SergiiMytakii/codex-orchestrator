import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptApprovedReviewData, acceptNeedsWorkReviewData, canRecoverTerminalReviewDataReport,
  createInitialReviewData, prepareReviewData, recoverTerminalReviewDataReport, validateReviewData,
} from '../src/v2/review-data.js';
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
  const initial = createInitialReviewData({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  const needsWork = acceptNeedsWorkReviewData(initial, report({ verdict: 'needs-work', defects: [defect] }), 'b'.repeat(64));
  assert.throws(() => prepareReviewData(needsWork, 'c'.repeat(64), 'review-1'), /independent reviewer/u);
  const next = prepareReviewData(needsWork, 'c'.repeat(64), 'review-2');
  assert.equal(flat(next).receipt, null);
  assert.equal(next.targetRevision, 2);
  assert.equal(flat(next).reviewerSessionId, 'review-2');
  assert.equal(JSON.stringify(next).includes('closure'), false);
  assert.equal(JSON.stringify(next).includes('disposition'), false);
  assert.equal(JSON.stringify(next).includes('profile'), false);
  const verified = { ...defect, status: 'verified' as const, statusTargetRevision: 2 };
  const clear = acceptApprovedReviewData(next, report({
    targetRevision: 2, targetFingerprint: 'c'.repeat(64), reviewerSessionId: 'review-2', defects: [verified],
  }), 'd'.repeat(64));
  assert.deepEqual(flat(clear).receipt, { verdict: 'approved', reportSha256: 'd'.repeat(64) });
});

test('report-format recovery is bounded data and does not create a nested terminal lifecycle', () => {
  const initial = createInitialReviewData({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  const repairable = {
    ...initial,
    reportRepairs: 1 as const,
  };
  assert.equal(canRecoverTerminalReviewDataReport(repairable), true);
  assert.equal(flat(recoverTerminalReviewDataReport(repairable)).receipt, null);
  assert.equal('terminalOutcome' in repairable, false);
  assert.equal('stage' in repairable, false);
});

test('exact persisted schema contains passive review data and rejects nested lifecycle authority', () => {
  const initial = createInitialReviewData({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  assert.deepEqual(Object.keys(initial).sort(), [
    'coverage', 'defects', 'receipt', 'repairFindings', 'reportRepairs', 'reviewerSessionId',
    'targetFingerprint', 'targetRevision', 'transportRetries', 'version',
  ]);
  const validate = validateReviewData as (value: unknown) => unknown;
  assert.deepEqual(validate(initial), initial);
  assert.throws(() => validate({
    ...initial,
    review: {
      version: 1,
      disposition: 'active',
      profile: 'high',
    },
  }), /unknown or missing keys/u);
});

function flat(value: unknown): {
  reviewerSessionId: string;
  reportRepairs: 0 | 1 | 2 | 3 | 4;
  receipt: { verdict: 'approved' | 'needs-work'; reportSha256: string } | null;
} {
  return value as ReturnType<typeof flat>;
}
