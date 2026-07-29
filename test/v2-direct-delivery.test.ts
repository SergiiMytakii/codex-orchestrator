import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptApprovedDirectReview,
  acceptNeedsWorkDirectReview,
  beginDirectReviewRepair,
  createInitialDirectReview,
  directReviewCandidateTargetFingerprint,
  directReviewTargetFingerprint,
  prepareDirectReviewClosure,
  projectTerminalDirectReview,
  validateDirectReview,
  type DirectReviewV1,
} from '../src/v2/direct-delivery.js';

const fingerprint = 'a'.repeat(64);

test('V2 direct-review fingerprint binds the pinned candidate identity without changing V1 hashing', () => {
  const binding = {
    version: 2 as const,
    bindingId: '1'.repeat(64),
    expectedHeadSha: '2'.repeat(40),
    candidateRef: `refs/codex-orchestrator/candidates/00000000-0000-4000-8000-000000000001/${'1'.repeat(64)}`,
    candidateCommitSha: '3'.repeat(40),
    candidateTreeSha: '4'.repeat(40),
    canonicalChangedFiles: ['src/a.ts'],
    sourceWorktreeIdentity: '5'.repeat(64),
  };
  const common = {
    routeDecisionSha256: '6'.repeat(64), workflowGenerationHash: '7'.repeat(64),
    cycle: 1, frozenCriteria: [{ id: 'criterion-1' }],
  };
  const first = directReviewCandidateTargetFingerprint({ binding, ...common });
  const second = directReviewCandidateTargetFingerprint({
    binding: { ...binding, candidateCommitSha: '8'.repeat(40) }, ...common,
  });
  assert.notEqual(first, second);
  assert.equal(first, directReviewCandidateTargetFingerprint({ binding: structuredClone(binding), ...common }));
});

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

test('direct review validator rejects impossible stage, budget, Closure, and removed lifecycle state', () => {
  const initial = createInitialDirectReview({
    targetFingerprint: fingerprint,
    codeReviewerSessionId: 'review-session-1',
  });
  const invalid = [
    { ...initial, review: { ...initial.review, reportRepairs: 5 } },
    { ...initial, review: { ...initial.review, mode: 'closure' } },
  ];
  for (const value of invalid) assert.throws(() => validateDirectReview(value, { lifecycle: 'implementing' }));

  assert.throws(() => validateDirectReview(initial, {
    lifecycle: 'safe-halt',
    process: { purpose: 'code-review', resumeLifecycle: 'implementing', resumeReviewStage: 'review-full' } as never,
  }));
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
  } }, { lifecycle: 'blocked' }));
});

test('target fingerprint and canonical-result acceptance transition are exact', () => {
  const targetFingerprint = directReviewTargetFingerprint({
    snapshot: { headSha: '1', indexTreeSha: '2', trackedContentSha256: '3', untrackedContentSha256: '4', worktreeIdentity: '5' },
    changedFiles: ['src/a.ts'], routeDecisionSha256: 'b'.repeat(64), workflowGenerationHash: 'c'.repeat(64),
    cycle: 1, frozenCriteria: [{ id: 'criterion-1' }],
  });
  const initial = createInitialDirectReview({
    targetFingerprint, codeReviewerSessionId: 'review-session-1',
  });
  const clear = acceptApprovedDirectReview(initial, {
    version: 1, operation: 'code-review', targetRevision: 1, targetFingerprint, verdict: 'approved', mode: 'full',
    coverage: ['correctness'], defects: [], residualRisks: [], reviewerSessionId: 'review-session-1',
    closureRequestSha256: null, repairFindingOutcomes: [],
  }, 'd'.repeat(64));
  assert.equal(clear.status, 'clear');
  assert.equal('invocation' in clear, false);
  assert.deepEqual(validateDirectReview(clear, { lifecycle: 'checking' }), clear);

  assert.deepEqual(validateDirectReview({ ...clear, review: { ...clear.review, coverage: [] } }, { lifecycle: 'checking' }).review.coverage, []);

  const repair = beginDirectReviewRepair(clear, [{
    id: 'finding-1', provenance: 'check', sourceId: 'typecheck', targetRevision: 1,
    summary: 'Typecheck failed.', affectedContracts: ['configured-checks'], status: 'open',
  }]);
  repair.review.reportRepairs = 4;
  const closure = prepareDirectReviewClosure(repair, 'e'.repeat(64));
  assert.equal(closure.state.stage, 'review-closure');
  assert.equal(closure.state.review.reportRepairs, 0);
  assert.deepEqual(validateDirectReview(closure.state, { lifecycle: 'implementing' }), closure.state);
  const reopened = acceptNeedsWorkDirectReview(closure.state, {
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
  const defect = {
    id: 'defect-1', class: 'blocker' as const, severity: 'high' as const, confidence: 'high' as const,
    status: 'open' as const, invariant: 'Checks pass.', failure: 'Typecheck fails.', evidence: ['src/a.ts'],
    repair: 'Fix the type.', affectedTargets: ['src/a.ts'], introducedTargetRevision: 1, statusTargetRevision: 1,
    supersededBy: null,
  };
  const repair = acceptNeedsWorkDirectReview(initial, {
    version: 1, operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    verdict: 'needs-work', mode: 'full', coverage: ['correctness'], defects: [defect], residualRisks: [],
    reviewerSessionId: 'review-session-1', closureRequestSha256: null, repairFindingOutcomes: [],
  }, 'b'.repeat(64));
  assert.equal(repair.stage, 'review-repair');
  const closure = prepareDirectReviewClosure(repair, 'c'.repeat(64));
  assert.equal(closure.state.review.defects[0]?.status, 'fixed');
  assert.equal(closure.state.review.defects[0]?.statusTargetRevision, 2);
  assert.equal(closure.state.review.affectedDefectIds.includes('defect-1'), true);

  const accepted = acceptApprovedDirectReview(closure.state, {
    version: 1, operation: 'code-review', targetRevision: 2, targetFingerprint: 'c'.repeat(64),
    verdict: 'approved', mode: 'closure', coverage: ['correctness'], defects: [{
      ...defect,
      invariant: 'Equivalent wording from the Closure reviewer.',
      failure: 'Equivalent failure wording from the Closure reviewer.',
      status: 'verified', statusTargetRevision: 2,
    }], residualRisks: [],
    reviewerSessionId: 'review-session-1', closureRequestSha256: closure.closureRequestSha256,
    repairFindingOutcomes: [],
  }, 'd'.repeat(64));
  assert.equal(accepted.review.defects[0]?.status, 'verified');
  assert.equal(accepted.review.defects[0]?.invariant, defect.invariant);
  assert.equal(accepted.review.defects[0]?.failure, defect.failure);
});

test('maps PR findings through repair and affected Closure', () => {
  const initial = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-session-1' });
  const clear = acceptApprovedDirectReview(initial, {
    version: 1, operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    verdict: 'approved', mode: 'full', coverage: ['correctness'], defects: [], residualRisks: [],
    reviewerSessionId: 'review-session-1', closureRequestSha256: null, repairFindingOutcomes: [],
  }, 'a'.repeat(64));
  const repair = beginDirectReviewRepair(clear, [{
    id: 'pr-thread:T_1', provenance: 'pr-review', sourceId: 'pr-thread:T_1', targetRevision: 1,
    summary: 'Trusted review feedback.', affectedContracts: ['pr-review'], status: 'open',
  }]);
  assert.deepEqual(validateDirectReview(repair, {
    lifecycle: 'safe-halt',
    process: { purpose: 'implementation', resumeLifecycle: 'implementing', resumeReviewStage: null },
  }), repair);
  const closure = prepareDirectReviewClosure(repair, 'b'.repeat(64));
  assert.equal(closure.state.repairFindings[0]?.provenance, 'pr-review');
  assert.equal(closure.state.repairFindings[0]?.status, 'fixed');
  assert.deepEqual(closure.state.review.affectedDefectIds, ['pr-thread:T_1']);
  assert.deepEqual(validateDirectReview(closure.state, { lifecycle: 'implementing' }), closure.state);
});
