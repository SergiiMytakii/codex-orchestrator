import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptApprovedDirectReview,
  acceptNeedsWorkDirectReview,
  beginDirectReviewRepair,
  createInitialDirectReview,
  directReviewCandidateTargetFingerprint,
  prepareDirectReviewClosure,
  validateDirectReview,
} from '../src/v2/direct-delivery.js';

const fingerprint = 'a'.repeat(64);

test('direct review state contains semantic review data and no invocation owner', () => {
  const state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-session-1' });
  assert.deepEqual(validateDirectReview(state, { lifecycle: 'implementing' }), state);
  assert.equal('invocation' in state, false);
  assert.throws(() => validateDirectReview({ ...state, invocation: {} }, { lifecycle: 'implementing' }), /unknown|missing/u);
});

test('approved and needs-work reports correlate from durable semantic fields', () => {
  const state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-session-1' });
  const base = {
    version: 1 as const, operation: 'code-review' as const, targetRevision: 1, targetFingerprint: fingerprint,
    mode: 'full' as const, coverage: ['correctness'], residualRisks: [], reviewerSessionId: 'review-session-1',
    closureRequestSha256: null, repairFindingOutcomes: [],
  };
  const clear = acceptApprovedDirectReview(state, { ...base, verdict: 'approved', defects: [] }, 'b'.repeat(64));
  assert.equal(clear.status, 'clear');
  const needsWork = acceptNeedsWorkDirectReview(state, {
    ...base,
    verdict: 'needs-work',
    defects: [{
      id: 'd1', class: 'blocker', severity: 'high', confidence: 'high', affectedTargets: ['src/a.ts'],
      invariant: 'works', failure: 'broken', repair: 'fix', evidence: ['test'],
      status: 'open', introducedTargetRevision: 1, statusTargetRevision: 1, supersededBy: null,
    }],
  }, 'c'.repeat(64));
  assert.equal(needsWork.stage, 'review-repair');
});

test('Closure keeps reviewer independence without process ownership', () => {
  const state = createInitialDirectReview({ targetFingerprint: fingerprint, codeReviewerSessionId: 'review-session-1' });
  const clear = acceptApprovedDirectReview(state, {
    version: 1, operation: 'code-review', targetRevision: 1, targetFingerprint: fingerprint,
    verdict: 'approved', mode: 'full', coverage: ['correctness'], defects: [], residualRisks: [],
    reviewerSessionId: 'review-session-1', closureRequestSha256: null, repairFindingOutcomes: [],
  }, 'b'.repeat(64));
  const repair = beginDirectReviewRepair(clear, [{
    id: 'check:1', provenance: 'check', sourceId: 'check:1', targetRevision: 1,
    summary: 'failed', affectedContracts: ['checks'], status: 'open',
  }]);
  const closure = prepareDirectReviewClosure(repair, 'd'.repeat(64));
  assert.equal(closure.state.stage, 'review-closure');
  assert.equal('invocation' in closure.state, false);
});

test('candidate fingerprint binds finite materialization source identity', () => {
  const binding = {
    version: 2 as const, bindingId: '1'.repeat(64), expectedHeadSha: '2'.repeat(40),
    candidateRef: `refs/codex-orchestrator/candidates/00000000-0000-4000-8000-000000000001/${'1'.repeat(64)}`,
    candidateCommitSha: '3'.repeat(40), candidateTreeSha: '4'.repeat(40), canonicalChangedFiles: ['src/a.ts'],
    sourceWorktreeIdentity: '5'.repeat(64),
  };
  const common = { routeDecisionSha256: '6'.repeat(64), workflowGenerationHash: '7'.repeat(64), cycle: 1, frozenCriteria: [] };
  assert.notEqual(
    directReviewCandidateTargetFingerprint({ binding, ...common }),
    directReviewCandidateTargetFingerprint({ binding: { ...binding, candidateCommitSha: '8'.repeat(40) }, ...common }),
  );
});
