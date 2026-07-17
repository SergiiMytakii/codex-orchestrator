import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RouteCoordinator,
  initialRouteExecution,
  type ContainedReportOperation,
  type RouteCoordinatorState,
  type RouteExecutionV1,
  type RouteReceiptV1,
} from '../src/v2/route-coordinator.js';
import type { TriageRouteV1 } from '../src/v2/triage-route.js';

const workflowGeneration = {
  generationHash: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  packageVersion: '2.0.1',
  generationRoot: '/workflow',
  contentSha256: 'c'.repeat(64),
};

const directRoute: TriageRouteV1 = {
  version: 1,
  status: 'direct',
  inspectedEvidence: [{ kind: 'issue', location: '#1225', summary: 'Read the approved issue.' }],
  assumptions: [],
  direct: { summary: 'Small change.', behaviors: ['Change behavior.'], verification: ['Run test.'] },
  specRequired: null,
  awaitingUser: null,
  blocker: null,
};

const specRoute: TriageRouteV1 = {
  ...directRoute,
  status: 'spec-required',
  direct: null,
  specRequired: {
    summary: 'Durable state change.',
    complexityReasons: ['Crash recovery contract.'],
    specMode: 'standard',
    reviewFocus: ['Recovery.'],
  },
};

const waitingRoute: TriageRouteV1 = {
  ...directRoute,
  status: 'awaiting-user',
  direct: null,
  awaitingUser: {
    outcomes: [
      { id: 'a', title: 'Keep history', behaviorDelta: 'Retain completed entries.', evidence: ['No source choice.'] },
      { id: 'b', title: 'Clear history', behaviorDelta: 'Remove completed entries.', evidence: ['No source choice.'] },
    ],
    absenceOfAuthorizedChoiceEvidence: ['Issue, code, and domain docs do not choose.'],
    recommendation: 'Keep history.',
    question: 'Should completed entries be retained or removed?',
  },
};

test('adversarial false-wait corpus routes autonomously while only genuine product ambiguity is reviewed', async () => {
  const autonomousCorpus = [
    { name: 'clear simple request', route: directRoute },
    { name: 'clear complex request', route: specRoute },
    { name: 'source-inferable missing detail', route: { ...directRoute, assumptions: ['Existing behavior chooses UTC.'] } },
    { name: 'technical implementation choice', route: { ...directRoute, assumptions: ['Use the existing state adapter.'] } },
  ] as const;

  for (const entry of autonomousCorpus) {
    const fixture = coordinatorFixture([{ status: 'completed', validatedPayload: entry.route, artifactSha256: hash(entry.name) }]);
    const result = await fixture.run();
    assert.equal(result.status, 'succeeded', entry.name);
    assert.deepEqual(fixture.operations.map((call) => call.operation), ['triage'], entry.name);
    assert.deepEqual(fixture.operationPhases, ['triage-in-flight'], entry.name);
  }

  const candidateHash = hash('genuine ambiguity');
  const fixture = coordinatorFixture([
    { status: 'completed', validatedPayload: waitingRoute, artifactSha256: candidateHash },
    {
      status: 'completed',
      validatedPayload: {
        version: 1,
        candidateSha256: candidateHash,
        verdict: 'approved',
        findings: [],
        evidenceReviewed: ['issue', 'code', 'domain'],
        recommendation: 'Ask the focused product question.',
      },
      artifactSha256: hash('approved review'),
    },
  ]);
  const result = await fixture.run();
  assert.equal(result.status, 'awaiting-user');
  assert.deepEqual(fixture.operations.map((call) => call.operation), ['triage', 'ambiguity-review']);
  assert.deepEqual(fixture.operationPhases, ['triage-in-flight', 'review-in-flight']);
  assert.notEqual(fixture.operations[0]?.attemptId, fixture.operations[1]?.attemptId);
  assert.ok(fixture.operations[1]?.promptFacts.includes(`candidateSha256=${candidateHash}`));
  assert.equal(fixture.state.execution.phase, 'route-complete');
  assert.equal(fixture.state.execution.candidateReviews, 1);
});

test('malformed triage persists findings only, repairs once, and cannot borrow another budget', async () => {
  const fixture = coordinatorFixture([
    { status: 'invalid', findings: ['missing direct payload'] },
    { status: 'completed', validatedPayload: directRoute, artifactSha256: hash('repaired') },
  ]);

  const repairable = await fixture.run();
  assert.deepEqual(repairable, {
    status: 'repairable',
    code: 'triage-artifact-invalid',
    findings: ['missing direct payload'],
  });
  assert.deepEqual(fixture.state.execution, {
    version: 1,
    phase: 'malformed-repair-ready',
    findings: ['missing direct payload'],
    triageRepairs: 1,
    triageTransportRetries: 0,
    ambiguityTransportRetries: 0,
    candidateReviews: 0,
  });
  assert.equal(JSON.stringify(fixture.state.execution).includes('validatedPayload'), false);

  assert.equal((await fixture.run()).status, 'succeeded');
  assert.deepEqual(fixture.operations.map((call) => call.operation), ['triage', 'triage']);
  assert.ok(fixture.operations[1]?.promptFacts.includes('repairKind=malformed'));

  const exhausted = coordinatorFixture([
    { status: 'invalid', findings: ['first'] },
    { status: 'invalid', findings: ['second'] },
  ]);
  assert.equal((await exhausted.run()).status, 'repairable');
  assert.deepEqual(await exhausted.run(), {
    status: 'blocked',
    kind: 'exhausted',
    code: 'triage-repair-exhausted',
    evidence: ['second'],
  });
  assert.equal(exhausted.state.execution.triageTransportRetries, 0);
  assert.equal(exhausted.state.execution.ambiguityTransportRetries, 0);
  assert.equal(exhausted.state.execution.candidateReviews, 0);
});

test('rejected waiting candidate preserves complete repair input and a second waiting result exhausts', async () => {
  const candidateHash = hash('rejected candidate');
  const fixture = coordinatorFixture([
    { status: 'completed', validatedPayload: waitingRoute, artifactSha256: candidateHash },
    {
      status: 'completed',
      validatedPayload: {
        version: 1,
        candidateSha256: candidateHash,
        verdict: 'rejected',
        findings: ['The alternatives differ only in wording.'],
        evidenceReviewed: ['issue', 'code'],
        recommendation: 'Resolve autonomously.',
      },
      artifactSha256: hash('rejected review'),
    },
    { status: 'completed', validatedPayload: waitingRoute, artifactSha256: hash('second waiting') },
  ]);

  assert.deepEqual(await fixture.run(), {
    status: 'repairable',
    code: 'waiting-candidate-rejected',
    findings: ['The alternatives differ only in wording.'],
  });
  assert.equal(fixture.state.execution.phase, 'candidate-repair-ready');
  if (fixture.state.execution.phase !== 'candidate-repair-ready') assert.fail('candidate repair was not persisted');
  assert.deepEqual(fixture.state.execution.candidate, waitingRoute);
  assert.equal(fixture.state.execution.triage.artifactSha256, candidateHash);
  assert.equal(fixture.state.execution.review.verdict, 'rejected');
  assert.equal(fixture.state.execution.triageRepairs, 1);
  assert.equal(fixture.state.execution.candidateReviews, 1);

  const result = await fixture.run();
  assert.deepEqual(result, {
    status: 'blocked',
    kind: 'exhausted',
    code: 'waiting-candidate-repair-exhausted',
    evidence: ['A repaired candidate may not ask another question.'],
  });
  assert.ok(fixture.operations[2]?.promptFacts.includes('repairKind=rejected-candidate'));
  assert.ok(fixture.operations[2]?.promptFacts.includes(`candidateSha256=${candidateHash}`));
});

test('triage and review transport retries consume only their independent owner budgets', async () => {
  const triage = coordinatorFixture([
    { status: 'retryable', code: 'triage-timeout' },
    { status: 'completed', validatedPayload: directRoute, artifactSha256: hash('triage retry') },
  ]);
  assert.deepEqual(await triage.run(), {
    status: 'retryable', owner: 'triage', code: 'triage-timeout',
  });
  assert.equal(triage.state.execution.triageTransportRetries, 1);
  assert.equal(triage.state.execution.ambiguityTransportRetries, 0);
  assert.equal((await triage.run()).status, 'succeeded');

  const candidateHash = hash('review retry');
  const review = coordinatorFixture([
    { status: 'completed', validatedPayload: waitingRoute, artifactSha256: candidateHash },
    { status: 'retryable', code: 'review-timeout' },
    {
      status: 'completed',
      validatedPayload: approvedReview(candidateHash),
      artifactSha256: hash('review retry success'),
    },
  ]);
  assert.deepEqual(await review.run(), {
    status: 'retryable', owner: 'ambiguity-review', code: 'review-timeout',
  });
  assert.equal(review.state.execution.triageTransportRetries, 0);
  assert.equal(review.state.execution.ambiguityTransportRetries, 1);
  assert.equal(review.state.execution.candidateReviews, 0);
  assert.equal((await review.run()).status, 'awaiting-user');
  assert.equal(review.state.execution.candidateReviews, 1);

  const exhausted = coordinatorFixture([
    { status: 'retryable', code: 'first-timeout' },
    { status: 'retryable', code: 'second-timeout' },
  ]);
  assert.equal((await exhausted.run()).status, 'retryable');
  assert.deepEqual(await exhausted.run(), {
    status: 'blocked',
    kind: 'exhausted',
    code: 'triage-transport-retries-exhausted',
    evidence: ['second-timeout'],
  });
  assert.equal(exhausted.state.execution.triageTransportRetries, 1);
});

test('crash recovery abandons in-flight attempts, preserves repair input, and rejects stale adoption', async () => {
  const abandoned = {
    ...initialRouteExecution(),
    phase: 'triage-in-flight',
    attemptId: 'abandoned-attempt',
    startedAt: '2026-07-17T00:00:00.000Z',
  } satisfies RouteExecutionV1;
  const recovered = coordinatorFixture([
    { status: 'completed', validatedPayload: directRoute, artifactSha256: hash('after crash') },
  ], abandoned);
  assert.deepEqual(await recovered.run(), {
    status: 'retryable', owner: 'triage', code: 'abandoned-triage-attempt',
  });
  assert.equal(recovered.operations.length, 0);
  assert.equal(recovered.state.execution.phase, 'triage-ready');
  assert.equal(recovered.state.execution.triageTransportRetries, 1);
  assert.equal((await recovered.run()).status, 'succeeded');

  const candidateHash = hash('review crash');
  const reviewCrash = coordinatorFixture([], {
    ...initialRouteExecution(),
    phase: 'review-in-flight',
    attemptId: 'abandoned-review',
    startedAt: '2026-07-17T00:00:00.000Z',
    candidate: waitingRoute,
    triage: {
      operation: 'triage', attemptId: 'triage-before-crash', artifactSha256: candidateHash,
      generationHash: workflowGeneration.generationHash,
    },
  });
  assert.deepEqual(await reviewCrash.run(), {
    status: 'retryable', owner: 'ambiguity-review', code: 'abandoned-ambiguity-review-attempt',
  });
  assert.equal(reviewCrash.state.execution.phase, 'candidate-ready');
  assert.equal(reviewCrash.state.execution.ambiguityTransportRetries, 1);

  const repairInput = { kind: 'malformed' as const, findings: ['invalid JSON'] };
  const repairCrash = coordinatorFixture([], {
    ...initialRouteExecution(),
    phase: 'repair-in-flight',
    attemptId: 'abandoned-repair',
    startedAt: '2026-07-17T00:00:00.000Z',
    repairInput,
    triageRepairs: 1,
  });
  assert.equal((await repairCrash.run()).status, 'retryable');
  assert.deepEqual(repairCrash.state.execution, {
    version: 1,
    phase: 'malformed-repair-ready',
    findings: ['invalid JSON'],
    triageRepairs: 1,
    triageTransportRetries: 1,
    ambiguityTransportRetries: 0,
    candidateReviews: 0,
  });

  const stale = coordinatorFixture([
    { status: 'completed', attemptId: 'stale-attempt', validatedPayload: directRoute, artifactSha256: hash('stale') },
  ]);
  assert.deepEqual(await stale.run(), {
    status: 'blocked',
    kind: 'safety',
    code: 'route-attempt-mismatch',
    evidence: ['Expected attempt-1 but operation returned stale-attempt.'],
  });
  assert.equal(stale.state.execution.phase, 'triage-in-flight');
});

test('cancellation is terminal and budget-neutral, and an approved review must echo the candidate hash', async () => {
  const cancelled = coordinatorFixture([{ status: 'cancelled' }]);
  assert.deepEqual(await cancelled.run(), { status: 'cancelled' });
  assert.equal(cancelled.state.cancelled, true);
  assert.deepEqual(budgets(cancelled.state.execution), budgets(initialRouteExecution()));

  const candidateHash = hash('candidate');
  const mismatch = coordinatorFixture([
    { status: 'completed', validatedPayload: waitingRoute, artifactSha256: candidateHash },
    {
      status: 'completed',
      validatedPayload: approvedReview(hash('different candidate')),
      artifactSha256: hash('mismatched review'),
    },
  ]);
  assert.deepEqual(await mismatch.run(), {
    status: 'blocked',
    kind: 'safety',
    code: 'ambiguity-review-candidate-mismatch',
    evidence: [`Expected ${candidateHash} but review echoed ${hash('different candidate')}.`],
  });
  assert.equal(mismatch.state.execution.phase, 'review-in-flight');

  const conflicted = coordinatorFixture([
    { status: 'completed', validatedPayload: directRoute, artifactSha256: hash('conflict') },
  ]);
  conflicted.state.failNextComplete = true;
  assert.deepEqual(await conflicted.run(), {
    status: 'blocked',
    kind: 'safety',
    code: 'route-state-conflict',
    evidence: ['Durable route state changed before compare-and-swap.'],
  });
  assert.equal(conflicted.state.execution.phase, 'triage-in-flight');
});

type OperationResult =
  | { status: 'completed'; attemptId?: string; validatedPayload: unknown; artifactSha256: string }
  | { status: 'invalid'; attemptId?: string; findings: string[] }
  | { status: 'retryable'; code: string }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety'; code: string };

function coordinatorFixture(results: OperationResult[], execution: RouteExecutionV1 = initialRouteExecution()) {
  const state = new MemoryRouteState(execution);
  const operations: Parameters<ContainedReportOperation['run']>[0][] = [];
  const operationPhases: RouteExecutionV1['phase'][] = [];
  const queue = [...results];
  let attempt = 0;
  const operation: ContainedReportOperation = {
    run: async (input) => {
      operationPhases.push(state.execution.phase);
      operations.push(structuredClone({ ...input, signal: undefined }) as unknown as typeof input);
      const next = queue.shift();
      if (!next) throw new Error('unexpected operation launch');
      if (next.status === 'completed' || next.status === 'invalid') {
        return { ...next, attemptId: next.attemptId ?? input.attemptId };
      }
      return next;
    },
  };
  const coordinator = new RouteCoordinator({
    state,
    operation,
    createAttemptId: () => `attempt-${++attempt}`,
    now: () => '2026-07-17T00:00:00.000Z',
    createReceipt: (input) => receipt(input.artifact, input.triage, input.review),
  });
  return {
    state,
    operations,
    operationPhases,
    run: () => coordinator.run({
      runId: 'run-1',
      worktreePath: '/worktree',
      workflowGeneration,
      promptFacts: ['issue=#1225', 'authority=approved-spec'],
      signal: new AbortController().signal,
    }),
  };
}

class MemoryRouteState implements RouteCoordinatorState {
  readonly transitions: RouteExecutionV1[] = [];
  receipt: RouteReceiptV1 | null = null;
  cancelled = false;
  failNextComplete = false;

  constructor(public execution: RouteExecutionV1) {}

  async read(): Promise<RouteExecutionV1> {
    return structuredClone(this.execution);
  }

  async compareAndSwap(expected: RouteExecutionV1, next: RouteExecutionV1): Promise<boolean> {
    if (!deepEqual(this.execution, expected)) return false;
    this.execution = structuredClone(next);
    this.transitions.push(structuredClone(next));
    return true;
  }

  async complete(expected: RouteExecutionV1, next: RouteExecutionV1, nextReceipt: RouteReceiptV1): Promise<boolean> {
    if (this.failNextComplete) {
      this.failNextComplete = false;
      return false;
    }
    if (!deepEqual(this.execution, expected)) return false;
    this.execution = structuredClone(next);
    this.receipt = structuredClone(nextReceipt);
    this.transitions.push(structuredClone(next));
    return true;
  }

  async cancel(expected: RouteExecutionV1): Promise<boolean> {
    if (!deepEqual(this.execution, expected)) return false;
    this.cancelled = true;
    return true;
  }
}

function receipt(
  artifact: TriageRouteV1,
  triage: RouteReceiptV1['triage'],
  review: RouteReceiptV1['review'],
): RouteReceiptV1 {
  return {
    version: 1,
    route: artifact.status as RouteReceiptV1['route'],
    triage,
    review,
    artifact,
    decisionSha256: hash(`receipt-${artifact.status}`),
    decidedAt: '2026-07-17T00:00:00.000Z',
    assumptions: artifact.assumptions,
  };
}

function approvedReview(candidateSha256: string) {
  return {
    version: 1,
    candidateSha256,
    verdict: 'approved',
    findings: [],
    evidenceReviewed: ['issue', 'code'],
    recommendation: 'Ask the focused product question.',
  };
}

function hash(seed: string): string {
  return Buffer.from(seed).toString('hex').padEnd(64, '0').slice(0, 64);
}

function budgets(execution: RouteExecutionV1) {
  return {
    triageRepairs: execution.triageRepairs,
    triageTransportRetries: execution.triageTransportRetries,
    ambiguityTransportRetries: execution.ambiguityTransportRetries,
    candidateReviews: execution.candidateReviews,
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
