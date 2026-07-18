import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptApprovedDirectReview,
  acceptNeedsWorkDirectReview,
  beginDirectReviewRepair,
  createInitialDirectReview,
  directReviewTargetFingerprint,
  launchDirectReviewInvocation,
  prepareDirectReviewInvocation,
  prepareDirectReviewClosure,
  validateDirectReview,
  type DirectReviewV1,
} from '../src/v2/direct-delivery.js';

const fingerprint = 'a'.repeat(64);

test('initial direct review state has one canonical Full owner', () => {
  const state = createInitialDirectReview({
    targetFingerprint: fingerprint,
    codeReviewerSessionId: 'review-session-1',
  });
  assert.equal(state.status, 'active');
  assert.equal(state.stage, 'review-full');
  assert.equal(state.review.disposition, 'active');
  assert.equal(state.review.mode, 'full');
  assert.deepEqual(validateDirectReview(state, { lifecycle: 'implementing' }), state);
});

test('clear review has an exact legal composite', () => {
  const initial = createInitialDirectReview({
    targetFingerprint: fingerprint,
    codeReviewerSessionId: 'review-session-1',
  });
  const clear: DirectReviewV1 = {
    ...initial,
    status: 'clear',
    review: {
      ...initial.review,
      disposition: 'clear', reviewerSessionId: 'review-session-1', mode: 'full',
      coverage: ['correctness', 'spec'], acceptedReportSha256: 'b'.repeat(64),
    },
  };
  assert.deepEqual(validateDirectReview(clear, { lifecycle: 'checking' }), clear);

});

test('direct review validator rejects impossible stage, budget, Closure, and safe-halt states', () => {
  const initial = createInitialDirectReview({
    targetFingerprint: fingerprint,
    codeReviewerSessionId: 'review-session-1',
  });
  const invalid = [
    { ...initial, review: { ...initial.review, reportRepairs: 2 } },
    { ...initial, review: { ...initial.review, mode: 'closure' } },
  ];
  for (const value of invalid) assert.throws(() => validateDirectReview(value, { lifecycle: 'implementing' }));

  assert.deepEqual(validateDirectReview(initial, {
    lifecycle: 'safe-halt',
    process: { purpose: 'code-review', resumeLifecycle: 'implementing', resumeReviewStage: 'review-full' },
  }), initial);
});

test('terminal projection preserves review evidence without retaining an invocation', () => {
  const active = createInitialDirectReview({
    targetFingerprint: fingerprint, codeReviewerSessionId: 'review-session-1',
  });
  const terminal: DirectReviewV1 = {
    ...active, status: 'terminal', terminalOutcome: { status: 'blocked', kind: 'exhausted' },
  };
  assert.deepEqual(validateDirectReview(terminal, { lifecycle: 'blocked' }), terminal);
  assert.throws(() => validateDirectReview({ ...terminal, invocation: {
    attemptId: 'a', operation: 'code-review', mode: 'full', reviewerSessionId: 'review-session-1',
    targetRevision: 1, targetFingerprint: fingerprint, closureRequestSha256: null,
    status: 'prepared', pid: null, processGroupId: null,
  } }, { lifecycle: 'blocked' }), /terminal/u);
});

test('target fingerprint and prepared-launched-accepted review transition are exact', () => {
  const targetFingerprint = directReviewTargetFingerprint({
    snapshot: { headSha: '1', indexTreeSha: '2', trackedContentSha256: '3', untrackedContentSha256: '4', worktreeIdentity: '5' },
    changedFiles: ['src/a.ts'], routeDecisionSha256: 'b'.repeat(64), workflowGenerationHash: 'c'.repeat(64),
    cycle: 1, frozenCriteria: [{ id: 'criterion-1' }],
  });
  const initial = createInitialDirectReview({
    targetFingerprint, codeReviewerSessionId: 'review-session-1',
  });
  const prepared = prepareDirectReviewInvocation(initial, {
    attemptId: 'review-attempt-1', operation: 'code-review', mode: 'full', reviewerSessionId: 'review-session-1',
    targetRevision: 1, targetFingerprint, closureRequestSha256: null,
  });
  const launched = launchDirectReviewInvocation(prepared, { attemptId: 'review-attempt-1', pid: 42, processGroupId: 42 });
  const clear = acceptApprovedDirectReview(launched, {
    version: 1, operation: 'code-review', targetRevision: 1, targetFingerprint, verdict: 'approved', mode: 'full',
    coverage: ['correctness'], defects: [], residualRisks: [], reviewerSessionId: 'review-session-1',
    closureRequestSha256: null, repairFindingOutcomes: [],
  }, 'd'.repeat(64));
  assert.equal(clear.status, 'clear');
  assert.equal('invocation' in clear, false);
  assert.deepEqual(validateDirectReview(clear, { lifecycle: 'checking' }), clear);

  const repair = beginDirectReviewRepair(clear, [{
    id: 'finding-1', provenance: 'check', sourceId: 'typecheck', targetRevision: 1,
    summary: 'Typecheck failed.', affectedContracts: ['configured-checks'], status: 'open',
  }]);
  const closure = prepareDirectReviewClosure(repair, 'e'.repeat(64));
  assert.equal(closure.state.stage, 'review-closure');
  assert.deepEqual(validateDirectReview(closure.state, { lifecycle: 'implementing' }), closure.state);
  const closureLaunched = launchDirectReviewInvocation(prepareDirectReviewInvocation(closure.state, {
    attemptId: 'closure-attempt-1', operation: 'code-review', mode: 'closure', reviewerSessionId: 'review-session-1',
    targetRevision: 2, targetFingerprint: 'e'.repeat(64), closureRequestSha256: closure.closureRequestSha256,
  }), { attemptId: 'closure-attempt-1', pid: 43, processGroupId: 43 });
  const reopened = acceptNeedsWorkDirectReview(closureLaunched, {
    version: 1, operation: 'code-review', targetRevision: 2, targetFingerprint: 'e'.repeat(64),
    verdict: 'needs-work', mode: 'closure', coverage: ['correctness'], defects: [], residualRisks: [],
    reviewerSessionId: 'review-session-1', closureRequestSha256: closure.closureRequestSha256,
    repairFindingOutcomes: [{ id: 'finding-1', status: 'reopened' }],
  }, 'f'.repeat(64));
  assert.equal(reopened.stage, 'review-repair');
  assert.equal(reopened.repairFindings[0]?.status, 'reopened');
});

test('needs-work defects become fixed only after implementation and enter correlated Closure', () => {
  const initial = createInitialDirectReview({
    targetFingerprint: fingerprint, codeReviewerSessionId: 'review-session-1',
  });
  const launched = launchDirectReviewInvocation(prepareDirectReviewInvocation(initial, {
    attemptId: 'review-attempt-1', operation: 'code-review', mode: 'full', reviewerSessionId: 'review-session-1',
    targetRevision: 1, targetFingerprint: fingerprint, closureRequestSha256: null,
  }), { attemptId: 'review-attempt-1', pid: 42, processGroupId: 42 });
  const defect = {
    id: 'defect-1', class: 'blocker' as const, severity: 'high' as const, confidence: 'high' as const,
    status: 'open' as const, invariant: 'Checks pass.', failure: 'Typecheck fails.', evidence: ['src/a.ts'],
    repair: 'Fix the type.', affectedTargets: ['src/a.ts'], introducedTargetRevision: 1, statusTargetRevision: 1,
    supersededBy: null,
  };
  const repair = acceptNeedsWorkDirectReview(launched, {
    version: 1, operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    verdict: 'needs-work', mode: 'full', coverage: ['correctness'], defects: [defect], residualRisks: [],
    reviewerSessionId: 'review-session-1', closureRequestSha256: null, repairFindingOutcomes: [],
  }, 'b'.repeat(64));
  assert.equal(repair.stage, 'review-repair');
  const closure = prepareDirectReviewClosure(repair, 'c'.repeat(64));
  assert.equal(closure.state.review.defects[0]?.status, 'fixed');
  assert.equal(closure.state.review.defects[0]?.statusTargetRevision, 2);
  assert.equal(closure.state.review.affectedDefectIds.includes('defect-1'), true);

  const closurePrepared = prepareDirectReviewInvocation(closure.state, {
    attemptId: 'closure-attempt-1', operation: 'code-review', mode: 'closure', reviewerSessionId: 'review-session-1',
    targetRevision: 2, targetFingerprint: 'c'.repeat(64), closureRequestSha256: closure.closureRequestSha256,
  });
  const closureLaunched = launchDirectReviewInvocation(closurePrepared, {
    attemptId: 'closure-attempt-1', pid: 43, processGroupId: 43,
  });
  assert.throws(() => acceptApprovedDirectReview(closureLaunched, {
    version: 1, operation: 'code-review', targetRevision: 2, targetFingerprint: 'c'.repeat(64),
    verdict: 'approved', mode: 'closure', coverage: ['correctness'], defects: [], residualRisks: [],
    reviewerSessionId: 'review-session-1', closureRequestSha256: closure.closureRequestSha256,
    repairFindingOutcomes: [],
  }, 'd'.repeat(64)), /unresolved defects/u);
});
