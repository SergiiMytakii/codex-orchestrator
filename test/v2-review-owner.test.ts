import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCodeReviewReport, codeReviewReportOutputSchema } from '../src/v2/code-review-report.js';
import { createInitialDirectReview, acceptNeedsWorkDirectReview, prepareDirectReview, acceptApprovedDirectReview, beginDirectReviewRepair, reconcileReviewDefects, validateDirectReview } from '../src/v2/direct-delivery.js';

const fingerprint = 'a'.repeat(64);
const context = { operation: 'code-review' as const, targetRevision: 2, targetFingerprint: fingerprint,
  reviewerSessionId: 'coordinator', previousFindingIds: ['proof:acceptance', 'standards:build'],
  availableReviewers: ['spec_reviewer', 'standards_reviewer'], requireAllReviewers: true, requireReviewerEvidence: true };
const finding = { id: 'standards:build', class: 'blocker' as const, severity: 'medium' as const, confidence: 'high' as const,
  invariant: 'Build the candidate', failure: 'Build proof missing', evidence: ['Only tests and typecheck supplied'],
  repair: 'Run npm run build', affectedTargets: ['src/feature.ts'] };
const reviewers = [{ role: 'spec_reviewer', sessionId: 'spec-2', verdict: 'approve' },
  { role: 'standards_reviewer', sessionId: 'standards-2', verdict: 'block' }];
const review = (overrides = {}) => ({ version: 1, operation: 'code-review', targetRevision: 2,
  targetFingerprint: fingerprint, reviewerSessionId: 'coordinator', verdict: 'needs-work', coverage: ['correctness'],
  defects: [finding], residualRisks: [], reviewers, ...overrides });

test('review returns current findings while Runner reconciles two previous repairs across restart', () => {
  let state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'initial' });
  const initial = validateCodeReviewReport(review({ targetRevision: 1, reviewerSessionId: 'initial' }),
    { ...context, targetRevision: 1, reviewerSessionId: 'initial', previousFindingIds: [] });
  state = acceptNeedsWorkDirectReview(state, initial, 'b'.repeat(64), '1'.repeat(40));
  state = beginDirectReviewRepair(state, [{ id: 'proof:acceptance', sourceId: 'proof:acceptance', provenance: 'proof',
    targetRevision: 1, summary: 'Acceptance unknown', affectedContracts: ['src/feature.ts'], status: 'open' }]);
  state = prepareDirectReview(state, fingerprint, 'coordinator');
  const current = validateCodeReviewReport(review(), context);
  state = acceptNeedsWorkDirectReview(JSON.parse(JSON.stringify(state)), current, 'c'.repeat(64), '2'.repeat(40));
  assert.equal(state.review.defects.find(item => item.id === finding.id)?.status, 'reopened');
  assert.equal(state.repairFindings.find(item => item.id === 'proof:acceptance')?.status, 'verified');
  state = prepareDirectReview(JSON.parse(JSON.stringify(state)), 'd'.repeat(64), 'coordinator-3');
  const approved = validateCodeReviewReport(review({ verdict: 'approved', defects: [], targetRevision: 3,
    targetFingerprint: 'd'.repeat(64), reviewerSessionId: 'coordinator-3',
    reviewers: reviewers.map(item => ({ ...item, verdict: 'approve' })) }),
    { ...context, targetRevision: 3, targetFingerprint: 'd'.repeat(64), reviewerSessionId: 'coordinator-3' });
  state = acceptApprovedDirectReview(state, approved, 'e'.repeat(64), '3'.repeat(40), 'targeted');
  assert.equal(state.status, 'clear');
  assert.deepEqual(state.review.defects, []);
  assert.deepEqual(state.repairFindings, []);
});

test('agent Review schema contains findings and verdict without Runner ledger fields', () => {
  const schema = JSON.stringify(codeReviewReportOutputSchema());
  for (const field of ['repairFindingOutcomes', 'introducedTargetRevision', 'statusTargetRevision', 'supersededBy'])
    assert.equal(schema.includes(field), false, field);
});

test('complete fallback reconciles provisional findings while targeted approval preserves out-of-scope blockers', () => {
  let state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'coordinator' });
  const initial = validateCodeReviewReport(review({ targetRevision: 1 }), { ...context, targetRevision: 1 });
  state = acceptNeedsWorkDirectReview(state, initial, 'b'.repeat(64), '1'.repeat(40));
  state = prepareDirectReview(state, fingerprint, 'coordinator');
  const outside = validateCodeReviewReport(review({ defects: [{ ...finding, id: 'outside', affectedTargets: ['src/outside.ts'] }] }), context);
  state.review.defects = reconcileReviewDefects(state, outside);
  const approved = validateCodeReviewReport(review({ verdict: 'approved', defects: [],
    reviewers: reviewers.map(reviewer => ({ ...reviewer, verdict: 'approve' })) }), context);
  assert.throws(() => acceptApprovedDirectReview(state, approved, 'c'.repeat(64), '2'.repeat(40), 'targeted'), /unresolved defects/u);
  const clear = acceptApprovedDirectReview(state, approved, 'c'.repeat(64), '2'.repeat(40), 'complete');
  assert.equal(clear.status, 'clear');
  assert.deepEqual(clear.review.defects, []);
});

test('complete needs-work preserves valid superseded history across restart', () => {
  let state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'coordinator' });
  state.review.validationContext = { ...context, targetRevision: 1, requiredCoverage: [] };
  state.review.defects = [
    { ...finding, id: 'old', status: 'superseded', introducedTargetRevision: 1, statusTargetRevision: 1, supersededBy: 'replacement' },
    { ...finding, id: 'replacement', status: 'open', introducedTargetRevision: 1, statusTargetRevision: 1, supersededBy: null },
  ];
  state = validateDirectReview(JSON.parse(JSON.stringify(state)), { lifecycle: 'reviewing' });
  const current = validateCodeReviewReport(review({ targetRevision: 1 }), { ...context, targetRevision: 1 });
  const repaired = acceptNeedsWorkDirectReview(state, current, 'b'.repeat(64), '1'.repeat(40));
  const restarted = validateDirectReview(JSON.parse(JSON.stringify(repaired)), { lifecycle: 'implementing' });
  assert.equal(restarted.review.defects.find(defect => defect.id === 'old')?.status, 'superseded');
  assert.equal(restarted.review.defects.find(defect => defect.id === 'replacement')?.status, 'verified');
});
