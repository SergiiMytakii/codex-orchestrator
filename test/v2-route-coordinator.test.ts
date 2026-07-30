import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RouteCoordinator, initialRouteExecution, type RouteCoordinatorState } from '../src/v2/route-coordinator.js';
import { hashRouteDecision, type RouteExecutionV1, type RouteReceiptV1 } from '../src/v2/route-decision.js';
import { InjectedContainedReportOperation, type ContainedReportOperation, type DurableReportInvocationV1 } from '../src/v2/contained-report-operation.js';

const generationHash = 'a'.repeat(64);
const direct = { version: 1, status: 'direct', inspectedEvidence: [{ kind: 'issue', location: '#1', summary: 'Read.' }], assumptions: [],
  direct: { summary: 'Small direct change.', behaviors: ['Change behavior.'], verification: ['Run focused test.'] }, specRequired: null, awaitingUser: null, blocker: null };

test('triage maps canonical report bytes into the existing route receipt with one green launch', async () => {
  const fixture = coordinatorFixture([{ status: 'completed', attemptId: 'attempt-1', reportBytes: envelope(direct), reportSha256: '1'.repeat(64) }]);
  const result = await fixture.coordinator.run(input());
  assert.equal(result.status, 'succeeded');
  assert.equal(fixture.calls, 1);
  assert.equal(fixture.state.current.phase, 'route-complete');
});

test('infrastructure deferral preserves semantic budgets and does not relaunch inside the coordinator', async () => {
  const fixture = coordinatorFixture([{ status: 'retryable', code: 'transport' }]);
  const result = await fixture.coordinator.run(input());
  assert.deepEqual(result, { status: 'retryable', code: 'transport' });
  assert.deepEqual(fixture.state.current, { version: 1, phase: 'triage-in-flight', triageRepairs: 0, candidateReviews: 0 });
  assert.equal(fixture.calls, 1);
});

test('triage restart refuses a report prepared from stale issue comments without relaunching', async () => {
  const state = new MemoryState();
  let launches = 0;
  let report: Buffer | undefined;
  const operation = new InjectedContainedReportOperation({
    host: 'host-a', bootId: 'boot-a', now: () => '2026-07-17T00:00:00.000Z', createAttemptId: () => 'triage-attempt-1',
    prepare: async () => ({
      operation: 'triage', generationHash,
      reportPath: '/attempts/triage-attempt-1/report.json',
      policy: { sandboxMode: 'read-only', cwdClass: 'worktree', worktreeAccess: 'read-only', writableRootClasses: [],
        runnerPostcondition: 'report-only', network: 'deny', networkHosts: [], mcpTools: [], approvalCeiling: 'never', externalWrite: false },
    }),
    snapshot: async () => ({ headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64), untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'worktree-1' }),
    readReport: async () => report ? { status: 'available', bytes: report } : { status: 'absent' },
    settleAttempt: async () => undefined,
    processStartIdentity: async () => 'process-start-1',
    inspectProcess: async () => ({ status: 'absent', processGroupAlive: false }),
    launch: async ({ onSpawned }) => {
      launches += 1;
      await onSpawned({ pid: 41, processGroupId: 41 });
      return { status: 'safe-halt' };
    },
  });
  const coordinator = new RouteCoordinator({ state, operation, now: () => '2026-07-17T00:00:00.000Z',
    createReceipt: () => { throw new Error('stale report must not create a receipt'); } });
  const original = { ...input(), promptFacts: ['issue comment=old'] };
  assert.equal((await coordinator.run(original)).status, 'safe-halt');
  report = envelope(direct);
  const changed = { ...input(), promptFacts: ['issue comment=old', 'issue comment=new'] };
  assert.deepEqual(await coordinator.run(changed), { status: 'safe-halt', code: 'report-operation-prompt-facts-drift' });
  assert.equal(launches, 1);
  assert.equal(state.invocationValue?.attemptId, 'triage-attempt-1');
});

test('recovered malformed triage output consumes the existing repair budget exactly once', async () => {
  const fixture = coordinatorFixture([{ status: 'completed', attemptId: 'attempt-1', reportBytes: envelope({ wrong: true }), reportSha256: '1'.repeat(64) }]);
  const first = await fixture.coordinator.run(input());
  assert.equal(first.status, 'repairable');
  assert.equal(fixture.state.current.triageRepairs, 1);
  const replay = structuredClone(fixture.state.current);
  assert.equal(replay.triageRepairs, 1);
});

test('ambiguity review keeps independent attempt and candidate correlation', async () => {
  const waiting = { ...direct, status: 'awaiting-user', direct: null,
    awaitingUser: { outcomes: [
      { id: 'a', title: 'Choose A', behaviorDelta: 'Implement observable behavior A.', evidence: ['Issue does not choose A.'] },
      { id: 'b', title: 'Choose B', behaviorDelta: 'Implement observable behavior B.', evidence: ['Issue does not choose B.'] },
    ], absenceOfAuthorizedChoiceEvidence: ['No authorized source chooses an outcome.'], question: 'Choose A or B?', recommendation: 'Choose A.' } };
  const fixture = coordinatorFixture([
    { status: 'completed', attemptId: 'triage-1', reportBytes: envelope(waiting), reportSha256: '1'.repeat(64) },
    { status: 'completed', attemptId: 'review-1', reportBytes: Buffer.alloc(0), reportSha256: '2'.repeat(64) },
  ], (calls, state) => calls === 2 ? envelope({ version: 1, candidateSha256: (state.current as any).triage.artifactSha256,
    verdict: 'approved', evidenceReviewed: ['issue'], findings: [], recommendation: 'Proceed.' }) : undefined);
  const result = await fixture.coordinator.run(input());
  assert.equal(result.status, 'awaiting-user');
  assert.equal(fixture.calls, 2);
  assert.notEqual((result as any).receipt.triage.attemptId, (result as any).receipt.review.attemptId);
});

test('rejected ambiguity output consumes existing budgets once and replay cannot repeat review', async () => {
  const waiting = { ...direct, status: 'awaiting-user', direct: null,
    awaitingUser: { outcomes: [
      { id: 'a', title: 'Choose A', behaviorDelta: 'Implement A.', evidence: ['No choice.'] },
      { id: 'b', title: 'Choose B', behaviorDelta: 'Implement B.', evidence: ['No choice.'] },
    ], absenceOfAuthorizedChoiceEvidence: ['No authorized source chooses.'], question: 'Choose?', recommendation: 'A.' } };
  const fixture = coordinatorFixture([
    { status: 'completed', attemptId: 'triage-1', reportBytes: envelope(waiting), reportSha256: '1'.repeat(64) },
    { status: 'completed', attemptId: 'review-1', reportBytes: Buffer.alloc(0), reportSha256: '2'.repeat(64) },
    { status: 'completed', attemptId: 'triage-repair-1', reportBytes: envelope(direct), reportSha256: '3'.repeat(64) },
  ], (calls, state) => calls === 2 ? envelope({
    version: 1, candidateSha256: (state.current as any).triage.artifactSha256,
    verdict: 'rejected', evidenceReviewed: ['issue'], findings: ['Not authorized.'], recommendation: 'Use direct route.',
  }) : undefined);

  assert.equal((await fixture.coordinator.run(input())).status, 'repairable');
  assert.equal(fixture.state.current.triageRepairs, 1);
  assert.equal(fixture.state.current.candidateReviews, 1);
  assert.equal((await fixture.coordinator.run(input())).status, 'succeeded');
  assert.equal(fixture.calls, 3);
  assert.equal((await fixture.coordinator.run(input())).status, 'blocked');
  assert.equal(fixture.calls, 3);
});

test('blocked ambiguity output settles phase state and canonical invocation atomically', async () => {
  const waiting = { ...direct, status: 'awaiting-user', direct: null,
    awaitingUser: { outcomes: [
      { id: 'a', title: 'Choose A', behaviorDelta: 'Implement A.', evidence: ['No choice.'] },
      { id: 'b', title: 'Choose B', behaviorDelta: 'Implement B.', evidence: ['No choice.'] },
    ], absenceOfAuthorizedChoiceEvidence: ['No authorized source chooses.'], question: 'Choose?', recommendation: 'A.' } };
  const fixture = coordinatorFixture([
    { status: 'completed', attemptId: 'triage-1', reportBytes: envelope(waiting), reportSha256: '1'.repeat(64) },
    { status: 'completed', attemptId: 'review-1', reportBytes: Buffer.alloc(0), reportSha256: '2'.repeat(64) },
  ], (calls, state) => calls === 2 ? envelope({
    version: 1, candidateSha256: (state.current as any).triage.artifactSha256,
    verdict: 'blocked', evidenceReviewed: ['issue'], findings: ['Unsafe ambiguity.'], recommendation: 'Stop.',
  }) : undefined);

  assert.deepEqual(await fixture.coordinator.run(input()), {
    status: 'blocked', kind: 'safety', code: 'ambiguity-review-blocked', evidence: ['Unsafe ambiguity.'],
  });
  assert.equal(fixture.state.current.phase, 'candidate-ready');
  assert.equal(fixture.state.invocationValue, undefined);
  assert.equal(fixture.state.settleCalls, 2);
});

function coordinatorFixture(results: any[], dynamic?: (calls: number, state: MemoryState) => Buffer | undefined) {
  const state = new MemoryState();
  let calls = 0;
  const operation: ContainedReportOperation = { run: async () => {
    calls += 1;
    const source = results[calls - 1];
    const result = source.status === 'completed' ? { ...source, reportBytes: Buffer.from(source.reportBytes) } : { ...source };
    const bytes = dynamic?.(calls, state);
    if (bytes && result.status === 'completed') result.reportBytes = bytes;
    if (result.status === 'completed') state.invocationValue = { attemptId: result.attemptId } as DurableReportInvocationV1;
    return result;
  } };
  const coordinator = new RouteCoordinator({ state, operation, now: () => '2026-07-17T00:00:00.000Z',
    createReceipt: ({ artifact, triage, review, decidedAt }) => {
      const receipt: RouteReceiptV1 = { version: 1, route: artifact.status as any, triage, review, artifact: artifact as any,
        decisionSha256: '', decidedAt, assumptions: artifact.assumptions };
      receipt.decisionSha256 = hashRouteDecision(receipt);
      return receipt;
    } });
  return { coordinator, state, get calls() { return calls; } };
}

class MemoryState implements RouteCoordinatorState {
  current: RouteExecutionV1 = initialRouteExecution();
  invocationValue: DurableReportInvocationV1 | undefined;
  settleCalls = 0;
  invocation = {
    read: async () => structuredClone(this.invocationValue),
    compareAndSwap: async (_expected: DurableReportInvocationV1 | undefined, next: DurableReportInvocationV1 | undefined) => { this.invocationValue = next; return true; },
  };
  async read() { return structuredClone(this.current); }
  async compareAndSwap(expected: RouteExecutionV1, next: RouteExecutionV1) { assert.deepEqual(this.current, expected); this.current = structuredClone(next); return true; }
  async settle(expected: RouteExecutionV1, next: RouteExecutionV1, attemptId: string) {
    if (this.invocationValue?.attemptId !== attemptId) return false;
    this.settleCalls += 1;
    this.invocationValue = undefined;
    return this.compareAndSwap(expected, next);
  }
  async complete(expected: RouteExecutionV1, next: RouteExecutionV1, _receipt: RouteReceiptV1, attemptId: string) {
    if (this.invocationValue?.attemptId !== attemptId) return false;
    this.invocationValue = undefined;
    return this.compareAndSwap(expected, next);
  }
  async cancel(_expected: RouteExecutionV1) { return true; }
}

function input() { return { runId: 'run-1', worktreePath: '/worktree', workflowGeneration: { generationHash,
  manifestSha256: 'b'.repeat(64), packageVersion: '2.0.10', generationRoot: '/sealed/workflow', contentSha256: 'c'.repeat(64) },
  promptFacts: ['issue'], signal: new AbortController().signal }; }
function envelope(report: unknown) { return Buffer.from(JSON.stringify({ report })); }
