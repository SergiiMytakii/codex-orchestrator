import assert from 'node:assert/strict';
import test from 'node:test';

import {
  downstreamLifecycleForRoute,
  hashRouteDecision,
  hashTriageArtifact,
  validateRouteExecution,
  validateRouteReceipt,
  validateRouteStateInvariant,
  validateRouteTransition,
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
  blocker: null,
};

const directArtifactSha256 = '5b88bb5dffd931030fe91e2cbe95b0c07cb6fa789b002ad76ac8fd23dc2288fa';

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
    decisionSha256: 'ee2a5bf27fa46f3266e7b8a76d46acf1e9087247cb71ba2f9695ba407045aef1',
    decidedAt: '2026-07-17T00:00:00.000Z',
    assumptions: [],
  };
}

test('route hash known-answer vectors use NUL domain separation', () => {
  assert.equal(hashTriageArtifact(directArtifact), directArtifactSha256);
  assert.equal(hashRouteDecision(directReceipt()), 'ee2a5bf27fa46f3266e7b8a76d46acf1e9087247cb71ba2f9695ba407045aef1');
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
      operation: 'obsolete-review',
      attemptId: 'review-1',
      candidateSha256: directArtifactSha256,
      artifactSha256: 'c'.repeat(64),
      verdict: 'approved',
      generationHash,
    },
  }, generationHash), /review.*null/u);
});

test('route execution validator accepts every exact phase', () => {
  const budgets = {
    version: 1 as const,
    triageRepairs: 0 as const,
    triageTransportRetries: 0 as const,
  };
  const triage = {
    operation: 'triage' as const,
    attemptId: 'triage-1',
    artifactSha256: directArtifactSha256,
    generationHash,
  };
  const phases = [
    { ...budgets, phase: 'triage-ready' },
    { ...budgets, triageRepairs: 1, phase: 'malformed-repair-ready', findings: ['Invalid status.'] },
    { ...budgets, phase: 'route-complete', triage: { ...triage, artifactSha256: directArtifactSha256 } },
    { ...budgets, triageRepairs: 1, phase: 'route-complete', triage: { ...triage, artifactSha256: directArtifactSha256 } },
  ];
  for (const phase of phases) assert.equal(validateRouteExecution(phase, generationHash).phase, phase.phase);
});

test('route execution validator rejects impossible counters and embedded evidence', () => {
  const ready = {
    version: 1,
    triageRepairs: 0,
    triageTransportRetries: 0,
    phase: 'triage-ready',
  };
  assert.throws(() => validateRouteExecution({ ...ready, triageRepairs: 2 }, generationHash), /triageRepairs/u);
  assert.throws(() => validateRouteExecution({ ...ready, extra: true }, generationHash), /unknown|missing keys/u);
});

test('route state guard enforces claimed, triaging, routed, downstream, and terminal invariants', () => {
  const execution = {
    version: 1 as const,
    triageRepairs: 0 as const,
    triageTransportRetries: 0 as const,
    phase: 'route-complete' as const,
    triage: directReceipt().triage,
  };
  const triageReady = {
    version: 1 as const,
    triageRepairs: 0 as const,
    triageTransportRetries: 0 as const,
    phase: 'triage-ready' as const,
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
    phase: 'route-complete' as const,
    triage: receipt.triage,
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
