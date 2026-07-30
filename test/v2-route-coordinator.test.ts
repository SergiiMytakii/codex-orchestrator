import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  generationHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), packageVersion: '2.0.1',
  generationRoot: '/workflow', contentSha256: 'c'.repeat(64),
};
const directRoute: TriageRouteV1 = {
  version: 1, status: 'direct', inspectedEvidence: [{ kind: 'issue', location: '#1', summary: 'approved' }], assumptions: [],
  direct: { summary: 'small', behaviors: ['works'], verification: ['test'] }, specRequired: null, awaitingUser: null, blocker: null,
};
const waitingRoute: TriageRouteV1 = {
  ...directRoute, status: 'awaiting-user', direct: null,
  awaitingUser: {
    outcomes: [
      { id: 'a', title: 'A', behaviorDelta: 'Keep A', evidence: ['absent'] },
      { id: 'b', title: 'B', behaviorDelta: 'Keep B', evidence: ['absent'] },
    ],
    absenceOfAuthorizedChoiceEvidence: ['issue and code do not choose'], recommendation: 'A', question: 'A or B?',
  },
};

test('route workers use one external attempt owner while route state keeps semantic budgets and refs only', async () => {
  const fixture = makeFixture([{ status: 'completed', validatedPayload: directRoute, artifactSha256: hash('direct') }]);
  const result = await fixture.run();
  assert.equal(result.status, 'succeeded');
  assert.equal(fixture.state.execution.phase, 'route-complete');
  assert.equal(fixture.state.prepared.length, 1);
  assert.equal(fixture.state.launched.length, 1);
  assert.equal(fixture.state.adopted.length, 1);
  assert.equal(JSON.stringify(fixture.state.execution).includes('startedAt'), false);
  assert.equal(JSON.stringify(fixture.state.execution).includes('in-flight'), false);
});

test('awaiting-user candidate and independent review retain semantic result refs', async () => {
  const candidateSha = hash('candidate');
  const fixture = makeFixture([
    { status: 'completed', validatedPayload: waitingRoute, artifactSha256: candidateSha },
    { status: 'completed', validatedPayload: {
      version: 1, candidateSha256: candidateSha, verdict: 'approved', evidenceReviewed: ['issue'], findings: [], recommendation: 'ask',
    }, artifactSha256: hash('review') },
  ]);
  const result = await fixture.run();
  assert.equal(result.status, 'awaiting-user');
  assert.equal(fixture.state.execution.phase, 'route-complete');
  if (fixture.state.execution.phase !== 'route-complete') return;
  assert.notEqual(fixture.state.execution.triage.attemptId, fixture.state.execution.review?.attemptId);
  assert.equal(fixture.state.execution.candidateReviews, 1);
});

test('malformed triage consumes one semantic repair budget without persisting invocation identity', async () => {
  const fixture = makeFixture([
    { status: 'invalid', findings: ['missing direct payload'], repairInput: { originalReportSha256: hash('bad'), originalReportBytes: Buffer.from('bad') } },
    { status: 'completed', validatedPayload: directRoute, artifactSha256: hash('fixed') },
  ]);
  const first = await fixture.run();
  assert.equal(first.status, 'repairable');
  assert.deepEqual(fixture.state.execution, {
    version: 1, phase: 'malformed-repair-ready', findings: ['missing direct payload'],
    triageRepairs: 1, triageTransportRetries: 0, ambiguityTransportRetries: 0, candidateReviews: 0,
  });
  const second = await fixture.run();
  assert.equal(second.status, 'succeeded');
});

function makeFixture(queue: Array<any>) {
  const state = new MemoryRouteState(initialRouteExecution());
  const operation: ContainedReportOperation = {
    run: async (input) => {
      await input.onLaunched?.({ pid: 42, processGroupId: 42 });
      const next = queue.shift();
      if (!next) throw new Error('unexpected operation');
      return next.status === 'completed' || next.status === 'invalid'
        ? { ...next, attemptId: input.attemptId }
        : next;
    },
  };
  const coordinator = new RouteCoordinator({
    state, operation, now: () => '2026-07-30T00:00:00.000Z',
    createReceipt: ({ artifact, triage, review, decidedAt }) => ({
      version: 1, route: artifact.status as RouteReceiptV1['route'], triage, review, artifact,
      decisionSha256: hash(`receipt:${artifact.status}`), decidedAt, assumptions: artifact.assumptions,
    }),
  });
  return { state, run: () => coordinator.run({
    runId: 'run-1', worktreePath: '/worktree', workflowGeneration, promptFacts: [], signal: new AbortController().signal,
  }) };
}

class MemoryRouteState implements RouteCoordinatorState {
  prepared: string[] = [];
  launched: string[] = [];
  adopted: string[] = [];
  receipt: RouteReceiptV1 | null = null;
  private attempt = 0;
  constructor(public execution: RouteExecutionV1) {}
  async read() { return structuredClone(this.execution); }
  async compareAndSwap(expected: RouteExecutionV1, next: RouteExecutionV1) {
    if (!same(this.execution, expected)) return false;
    this.execution = structuredClone(next); return true;
  }
  async prepareAttempt(operationId: 'triage' | 'ambiguity-review', sourceId: string) {
    const id = `${operationId}:${sourceId}:attempt-${++this.attempt}`; this.prepared.push(id); return id;
  }
  async launchAttempt(attemptId: string) { this.launched.push(attemptId); }
  async adopt(expected: RouteExecutionV1, next: RouteExecutionV1, resultSha256: string) {
    if (!same(this.execution, expected)) return false;
    this.execution = structuredClone(next); this.adopted.push(resultSha256); return true;
  }
  async clearAttempt() {}
  async complete(expected: RouteExecutionV1, next: RouteExecutionV1, receipt: RouteReceiptV1, resultSha256: string) {
    if (!await this.adopt(expected, next, resultSha256)) return false;
    this.receipt = structuredClone(receipt); return true;
  }
  async cancel(expected: RouteExecutionV1) { return same(this.execution, expected); }
}

function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
