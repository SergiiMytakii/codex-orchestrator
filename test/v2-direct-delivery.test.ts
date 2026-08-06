import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptApprovedDirectReview, acceptNeedsWorkDirectReview, beginDirectReviewRepair,
  createInitialDirectReview, prepareDirectReview, validateDirectReview,
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
    reviewers: [], repairFindingOutcomes: [], ...overrides,
  };
}

test('repair creates a targeted revision that retains the previous reviewed target', () => {
  const initial = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  const needsWork = acceptNeedsWorkDirectReview(
    initial,
    report({ verdict: 'needs-work', defects: [defect] }),
    'b'.repeat(64),
    '1'.repeat(40),
  );
  const next = prepareDirectReview(needsWork, 'c'.repeat(64), 'review-2');
  assert.equal(next.stage, 'review');
  assert.equal(next.targetRevision, 2);
  assert.equal(next.review.reviewerSessionId, 'review-2');
  assert.deepEqual(next.previousTarget, {
    targetRevision: 1,
    targetFingerprint: fingerprint,
    candidateTreeSha: '1'.repeat(40),
  });
  assert.equal(JSON.stringify(next).includes('closure'), false);
  const verified = { ...defect, status: 'verified' as const, statusTargetRevision: 2 };
  const clear = acceptApprovedDirectReview(next, report({
    targetRevision: 2, targetFingerprint: 'c'.repeat(64), reviewerSessionId: 'review-2', defects: [verified],
    repairFindingOutcomes: [{ id: 'finding-1', status: 'verified' }],
  }), 'd'.repeat(64), '2'.repeat(40), 'targeted');
  assert.equal(clear.status, 'clear');
});

test('every later repair anchors to the immediately previous approved target without a round limit', () => {
  let state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  state = acceptApprovedDirectReview(state, report({}), '1'.repeat(64), '1'.repeat(40), 'complete');
  for (let revision = 2; revision <= 6; revision += 1) {
    const id = `repair-${revision}`;
    state = beginDirectReviewRepair(state, [{
      id, provenance: 'pr-review', sourceId: id, targetRevision: revision - 1,
      summary: `repair revision ${revision}`, affectedContracts: ['path:feature.txt'], status: 'open',
    }], String(revision - 1).repeat(40).slice(0, 40));
    state = prepareDirectReview(state, String(revision).repeat(64).slice(0, 64), `review-${revision}`);
    assert.equal(state.previousTarget?.targetRevision, revision - 1);
    state = acceptApprovedDirectReview(state, report({
      targetRevision: revision,
      targetFingerprint: state.targetFingerprint,
      reviewerSessionId: `review-${revision}`,
      repairFindingOutcomes: [{ id, status: 'verified' }],
    }), String(revision + 1).repeat(64).slice(0, 64), String(revision).repeat(40).slice(0, 40), 'targeted');
  }
  assert.equal(state.targetRevision, 6);
  assert.equal(state.previousTarget?.targetRevision, 5);
});

test('targeted approval merges repaired coverage with untouched historical approval', () => {
  let state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  state = acceptApprovedDirectReview(state, report({ coverage: ['correctness', 'requirements'] }), '1'.repeat(64), '1'.repeat(40), 'complete');
  state = beginDirectReviewRepair(state, [{
    id: 'repair-correctness', provenance: 'pr-review', sourceId: 'repair-correctness', targetRevision: 1,
    summary: 'repair correctness', affectedContracts: ['contract:correctness', 'path:feature.txt'], status: 'open',
  }]);
  state = prepareDirectReview(state, 'c'.repeat(64), 'review-2');
  state = acceptApprovedDirectReview(state, report({
    targetRevision: 2, targetFingerprint: 'c'.repeat(64), reviewerSessionId: 'review-2',
    coverage: ['correctness'], repairFindingOutcomes: [{ id: 'repair-correctness', status: 'verified' }],
  }), 'd'.repeat(64), '2'.repeat(40), 'targeted');
  assert.deepEqual(state.review.coverage, ['correctness', 'requirements']);
  assert.deepEqual(state.repairFindings, []);
  assert.deepEqual(state.review.defects, []);
});

test('persisted direct review coverage accepts 257 unique byte-bounded entries', () => {
  const coverage = Array.from({ length: 257 }, (_, index) => `coverage-${index.toString().padStart(3, '0')}`);
  const initial = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  const approved = acceptApprovedDirectReview(
    initial,
    report({ coverage }),
    '1'.repeat(64),
    '1'.repeat(40),
    'complete',
  );
  const restarted = JSON.parse(JSON.stringify(approved));
  const validated = validateDirectReview(restarted, { lifecycle: 'publishing' });
  assert.deepEqual(validated.review.coverage, coverage);
});

test('more than 256 sequential repairs compact verified findings into coverage truth', () => {
  let state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  state = acceptApprovedDirectReview(state, report({ coverage: ['correctness', 'requirements'] }), '1'.repeat(64), '1'.repeat(40), 'complete');
  for (let revision = 2; revision <= 302; revision += 1) {
    const id = `repair-${revision}`;
    state = beginDirectReviewRepair(state, [{
      id, provenance: 'pr-review', sourceId: id, targetRevision: revision - 1,
      summary: `repair ${revision}`, affectedContracts: ['contract:correctness', 'path:feature.txt'], status: 'open',
    }], String((revision % 9) + 1).repeat(40));
    const targetFingerprint = String((revision % 9) + 1).repeat(64);
    state = prepareDirectReview(state, targetFingerprint, `review-${revision}`);
    state = acceptApprovedDirectReview(state, report({
      targetRevision: revision, targetFingerprint, reviewerSessionId: `review-${revision}`,
      coverage: ['correctness'], repairFindingOutcomes: [{ id, status: 'verified' }],
    }), String(((revision + 1) % 9) + 1).repeat(64), String(((revision + 2) % 9) + 1).repeat(40), 'targeted');
    assert.equal(state.repairFindings.length, 0);
    assert.equal(state.review.defects.length, 0);
  }
  assert.deepEqual(state.review.coverage, ['correctness', 'requirements']);
  assert.equal(state.targetRevision, 302);
});

test('targeted needs-work preserves untouched approval but removes blocked coverage', () => {
  let state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-1' });
  state = acceptApprovedDirectReview(state, report({ coverage: ['correctness', 'requirements'] }), '1'.repeat(64), '1'.repeat(40), 'complete');
  state = beginDirectReviewRepair(state, [{
    id: 'repair-correctness', provenance: 'pr-review', sourceId: 'repair-correctness', targetRevision: 1,
    summary: 'repair correctness', affectedContracts: ['contract:correctness', 'path:feature.txt'], status: 'open',
  }]);
  state = prepareDirectReview(state, 'c'.repeat(64), 'review-2');
  state = acceptNeedsWorkDirectReview(state, report({
    targetRevision: 2, targetFingerprint: 'c'.repeat(64), reviewerSessionId: 'review-2', verdict: 'needs-work',
    coverage: ['correctness'], defects: [{
      ...defect, id: 'repair-blocked', affectedTargets: ['contract:correctness'], introducedTargetRevision: 2, statusTargetRevision: 2,
    }], repairFindingOutcomes: [{ id: 'repair-correctness', status: 'reopened' }],
  }), 'd'.repeat(64), '2'.repeat(40));
  assert.deepEqual(state.review.coverage, ['requirements']);
});
