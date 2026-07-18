import assert from 'node:assert/strict';
import test from 'node:test';

import {
  downstreamLifecycleForRoute,
  hashAmbiguityReviewArtifact,
  hashRouteDecision,
  hashTriageArtifact,
  validateRouteExecution,
  validateRouteReceipt,
  validateRouteStateInvariant,
  validateRouteTransition,
  type AmbiguityReviewArtifactV1,
  type RouteReceiptV1,
} from '../src/v2/route-decision.js';
import type { TriageRouteV1 } from '../src/v2/triage-route.js';

const generationHash = 'a'.repeat(64);

const directArtifact: TriageRouteV1 = {
  version: 1,
  status: 'direct',
  inspectedEvidence: [{ kind: 'issue', location: '#1', summary: 'Read the issue.' }],
  assumptions: [],
  direct: { summary: 'Small change.', behaviors: ['Change behavior.'], verification: ['Run test.'] },
  specRequired: null,
  awaitingUser: null,
  blocker: null,
};

const waitingArtifact: TriageRouteV1 = {
  ...directArtifact,
  status: 'awaiting-user',
  direct: null,
  awaitingUser: {
    outcomes: [
      { id: 'a', title: 'A', behaviorDelta: 'Use behavior A.', evidence: ['Issue permits A.'] },
      { id: 'b', title: 'B', behaviorDelta: 'Use behavior B.', evidence: ['Issue permits B.'] },
    ],
    absenceOfAuthorizedChoiceEvidence: ['No source chooses A or B.'],
    recommendation: 'Choose A.',
    question: 'Should the product use A or B?',
  },
};

const directArtifactSha256 = 'b9616d55da5ad1ef72b632cda35c61663294f682bcb4787fedc32d82e0519c31';

function directReceipt(): RouteReceiptV1 {
  return {
    version: 1,
    route: 'direct',
    triage: {
      operation: 'triage',
      attemptId: 'attempt-1',
      artifactSha256: directArtifactSha256,
      generationHash,
    },
    review: null,
    artifact: structuredClone(directArtifact),
    decisionSha256: '975ea4ad8c87cbc3ccbe3aeed0637e1463f52c0295f6f2191c4a5f034c09c837',
    decidedAt: '2026-07-17T00:00:00.000Z',
    assumptions: [],
  };
}

test('route hash known-answer vectors use NUL domain separation', () => {
  const review: AmbiguityReviewArtifactV1 = {
    version: 1,
    candidateSha256: directArtifactSha256,
    verdict: 'approved',
    evidenceReviewed: ['issue'],
    findings: [],
    recommendation: 'Proceed.',
  };
  assert.equal(hashTriageArtifact(directArtifact), directArtifactSha256);
  assert.equal(hashAmbiguityReviewArtifact(review), 'a15f377edd58ccb08d215dbf85b214a73d83c684bf3a98b626d14cf7fb4ff356');
  assert.equal(hashRouteDecision(directReceipt()), '975ea4ad8c87cbc3ccbe3aeed0637e1463f52c0295f6f2191c4a5f034c09c837');
  assert.throws(() => hashRouteDecision({ ...directReceipt(), extra: true } as RouteReceiptV1), /unknown|missing keys/u);
});

test('route receipt validator accepts an exact direct receipt', () => {
  assert.deepEqual(validateRouteReceipt(directReceipt(), generationHash), directReceipt());
});

test('route receipt validator fails closed on unknown keys, hash drift, and generation mismatch', () => {
  assert.throws(() => validateRouteReceipt({ ...directReceipt(), extra: true }, generationHash), /unknown|missing keys/u);
  assert.throws(() => validateRouteReceipt({ ...directReceipt(), decisionSha256: '0'.repeat(64) }, generationHash), /decision.*hash/u);
  assert.throws(() => validateRouteReceipt(directReceipt(), 'b'.repeat(64)), /generation/u);
  assert.throws(() => validateRouteReceipt({
    ...directReceipt(),
    triage: { ...directReceipt().triage, artifactSha256: '0'.repeat(64) },
  }, generationHash), /artifact.*hash/u);
});

test('route receipt validator enforces route payload, review, and assumption invariants', () => {
  assert.throws(() => validateRouteReceipt({ ...directReceipt(), route: 'spec-required' }, generationHash), /route|status/u);
  assert.throws(() => validateRouteReceipt({ ...directReceipt(), assumptions: ['duplicate', 'duplicate'] }, generationHash), /assumptions.*unique/u);
  assert.throws(() => validateRouteReceipt({
    ...directReceipt(),
    assumptions: ['receipt-only'],
  }, generationHash), /assumptions.*artifact/u);
  assert.throws(() => validateRouteReceipt({
    ...directReceipt(),
    review: {
      operation: 'ambiguity-review',
      attemptId: 'review-1',
      candidateSha256: directArtifactSha256,
      artifactSha256: 'c'.repeat(64),
      verdict: 'approved',
      generationHash,
    },
  }, generationHash), /review.*null/u);
});

test('awaiting-user receipt requires a fresh approved review bound to the candidate', () => {
  const candidateSha256 = hashTriageArtifact(waitingArtifact);
  const receipt: RouteReceiptV1 = {
    version: 1,
    route: 'awaiting-user',
    triage: {
      operation: 'triage', attemptId: 'triage-1', artifactSha256: candidateSha256, generationHash,
    },
    review: {
      operation: 'ambiguity-review', attemptId: 'review-1', candidateSha256,
      artifactSha256: 'c'.repeat(64), verdict: 'approved', generationHash,
    },
    artifact: waitingArtifact,
    decisionSha256: '',
    decidedAt: '2026-07-17T00:00:00.000Z',
    assumptions: [],
  };
  receipt.decisionSha256 = hashRouteDecision(receipt);
  assert.equal(validateRouteReceipt(receipt, generationHash).route, 'awaiting-user');
  assert.throws(() => validateRouteReceipt({
    ...receipt,
    review: { ...receipt.review!, verdict: 'rejected' },
  }, generationHash), /approved/u);
  assert.throws(() => validateRouteReceipt({
    ...receipt,
    review: { ...receipt.review!, attemptId: 'triage-1' },
  }, generationHash), /distinct|attempt/u);
});

test('route execution validator accepts every exact phase', () => {
  const budgets = {
    version: 1 as const,
    triageRepairs: 0 as const,
    triageTransportRetries: 0 as const,
    ambiguityTransportRetries: 0 as const,
    candidateReviews: 0 as const,
  };
  const triage = {
    operation: 'triage' as const,
    attemptId: 'triage-1',
    artifactSha256: hashTriageArtifact(waitingArtifact),
    generationHash,
  };
  const review = {
    operation: 'ambiguity-review' as const,
    attemptId: 'review-1',
    candidateSha256: triage.artifactSha256,
    artifactSha256: 'c'.repeat(64),
    verdict: 'rejected' as const,
    generationHash,
  };
  const phases = [
    { ...budgets, phase: 'triage-ready', previousAttemptId: null },
    { ...budgets, phase: 'triage-in-flight', attemptId: 'triage-1', startedAt: '2026-07-17T00:00:00.000Z' },
    { ...budgets, phase: 'candidate-ready', candidate: waitingArtifact, triage },
    { ...budgets, phase: 'review-in-flight', attemptId: 'review-1', startedAt: '2026-07-17T00:00:00.000Z', candidate: waitingArtifact, triage },
    { ...budgets, triageRepairs: 1, phase: 'malformed-repair-ready', findings: ['Invalid status.'] },
    { ...budgets, triageRepairs: 1, candidateReviews: 1, phase: 'candidate-repair-ready', candidate: waitingArtifact, triage, review, findings: ['Not a real ambiguity.'] },
    { ...budgets, triageRepairs: 1, phase: 'repair-in-flight', attemptId: 'repair-1', startedAt: '2026-07-17T00:00:00.000Z', repairInput: { kind: 'malformed', findings: ['Invalid status.'] } },
    { ...budgets, triageRepairs: 1, candidateReviews: 1, phase: 'repair-in-flight', attemptId: 'repair-1', startedAt: '2026-07-17T00:00:00.000Z', repairInput: { kind: 'rejected-candidate', candidate: waitingArtifact, triage, review, findings: ['Not a real ambiguity.'] } },
    { ...budgets, phase: 'route-complete', triage: { ...triage, artifactSha256: directArtifactSha256 }, review: null },
    { ...budgets, triageRepairs: 1, candidateReviews: 1, phase: 'route-complete', triage: { ...triage, artifactSha256: directArtifactSha256 }, review: null },
  ];
  for (const phase of phases) assert.equal(validateRouteExecution(phase, generationHash).phase, phase.phase);
});

test('route execution validator rejects impossible counters and embedded evidence', () => {
  const ready = {
    version: 1,
    triageRepairs: 0,
    triageTransportRetries: 0,
    ambiguityTransportRetries: 0,
    candidateReviews: 0,
    phase: 'triage-ready',
    previousAttemptId: null,
  };
  assert.throws(() => validateRouteExecution({ ...ready, triageRepairs: 2 }, generationHash), /triageRepairs/u);
  assert.throws(() => validateRouteExecution({ ...ready, extra: true }, generationHash), /unknown|missing keys/u);
  assert.throws(() => validateRouteExecution({
    version: 1,
    triageRepairs: 0,
    triageTransportRetries: 0,
    ambiguityTransportRetries: 0,
    candidateReviews: 0,
    phase: 'candidate-ready',
    candidate: directArtifact,
    triage: { operation: 'triage', attemptId: 'triage-1', artifactSha256: directArtifactSha256, generationHash },
  }, generationHash), /awaiting-user|candidate/u);
});

test('route state guard enforces claimed, triaging, routed, downstream, and terminal invariants', () => {
  const execution = {
    version: 1 as const,
    triageRepairs: 0 as const,
    triageTransportRetries: 0 as const,
    ambiguityTransportRetries: 0 as const,
    candidateReviews: 0 as const,
    phase: 'route-complete' as const,
    triage: directReceipt().triage,
    review: null,
  };
  const triageReady = {
    version: 1 as const,
    triageRepairs: 0 as const,
    triageTransportRetries: 0 as const,
    ambiguityTransportRetries: 0 as const,
    candidateReviews: 0 as const,
    phase: 'triage-ready' as const,
    previousAttemptId: null,
  };
  assert.doesNotThrow(() => validateRouteStateInvariant({ lifecycle: 'claimed', routeExecution: undefined, routeReceipt: undefined, generationHash }));
  assert.doesNotThrow(() => validateRouteStateInvariant({ lifecycle: 'triaging', routeExecution: triageReady, routeReceipt: undefined, generationHash }));
  assert.doesNotThrow(() => validateRouteStateInvariant({ lifecycle: 'routed', routeExecution: execution, routeReceipt: directReceipt(), generationHash }));
  assert.doesNotThrow(() => validateRouteStateInvariant({ lifecycle: 'implementing', routeExecution: execution, routeReceipt: directReceipt(), generationHash }));
  assert.throws(() => validateRouteStateInvariant({ lifecycle: 'spec-authoring', routeExecution: execution, routeReceipt: directReceipt(), generationHash }), /dispatch|implementing/u);
  assert.doesNotThrow(() => validateRouteStateInvariant({ lifecycle: 'review-ready', routeExecution: undefined, routeReceipt: undefined, generationHash }));

  assert.throws(() => validateRouteStateInvariant({ lifecycle: 'claimed', routeExecution: execution, routeReceipt: directReceipt(), generationHash }), /claimed.*absent/u);
  assert.throws(() => validateRouteStateInvariant({ lifecycle: 'triaging', routeExecution: execution, routeReceipt: directReceipt(), generationHash }), /triaging.*absent/u);
  assert.throws(() => validateRouteStateInvariant({ lifecycle: 'routed', routeExecution: triageReady, routeReceipt: directReceipt(), generationHash }), /route-complete/u);
  assert.throws(() => validateRouteStateInvariant({ lifecycle: 'implementing', routeExecution: undefined, routeReceipt: undefined, generationHash }), /route.*required/u);
  assert.throws(() => validateRouteStateInvariant({ lifecycle: 'routed', routeExecution: { ...execution, triage: { ...execution.triage, attemptId: 'other' } }, routeReceipt: directReceipt(), generationHash }), /refs|triage/u);
});

test('route transition guard keeps the receipt immutable and owns downstream dispatch mapping', () => {
  const receipt = directReceipt();
  const execution = {
    version: 1 as const,
    triageRepairs: 0 as const,
    triageTransportRetries: 0 as const,
    ambiguityTransportRetries: 0 as const,
    candidateReviews: 0 as const,
    phase: 'route-complete' as const,
    triage: receipt.triage,
    review: null,
  };
  const routed = { lifecycle: 'routed' as const, routeExecution: execution, routeReceipt: receipt, generationHash };
  const implementing = { ...routed, lifecycle: 'implementing' as const };
  assert.equal(downstreamLifecycleForRoute(receipt, generationHash), 'implementing');
  assert.doesNotThrow(() => validateRouteTransition(routed, implementing));
  assert.throws(() => validateRouteTransition(routed, { ...implementing, lifecycle: 'spec-authoring' }), /dispatch|implementing/u);
  assert.throws(() => validateRouteTransition(implementing, {
    ...implementing,
    routeReceipt: { ...receipt, decidedAt: '2026-07-17T00:00:01.000Z' },
  }), /decision hash|immutable/u);
});
