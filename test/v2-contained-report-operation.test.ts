import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InjectedContainedReportOperation,
  type ContainedReportOperationId,
  type DurableReportInvocationV1,
} from '../src/v2/contained-report-operation.js';
import type { WorkflowGenerationReceipt, WorkflowOperationPolicy } from '../src/v2/workflow-assets.js';

const generationHash = 'a'.repeat(64);
const workflowGeneration: WorkflowGenerationReceipt = {
  generationHash, manifestSha256: 'b'.repeat(64), packageVersion: '2.0.10',
  generationRoot: '/sealed/workflow', contentSha256: 'c'.repeat(64),
};
const policy: WorkflowOperationPolicy = {
  sandboxMode: 'read-only', cwdClass: 'worktree', worktreeAccess: 'read-only', writableRootClasses: [],
  runnerPostcondition: 'report-only', network: 'deny', networkHosts: [], mcpTools: [], approvalCeiling: 'never', externalWrite: false,
};
const operations: ContainedReportOperationId[] = ['triage', 'ambiguity-review', 'code-review', 'spec-review'];

for (const operationId of operations) {
  test(`${operationId} persists prepare and fenced launch before adopting its attempt-owned report`, async () => {
    const fixture = invocationFixture(operationId, { launch: 'completed' });
    const result = await fixture.operation.run(fixture.input);
    assert.equal(result.status, 'completed');
    assert.equal(result.status === 'completed' && result.attemptId, `attempt-${operationId}`);
    assert.deepEqual(fixture.phases, ['prepared', 'launched']);
    assert.equal(fixture.launches, 1);
  });
}

test('restart adopts the exact exited attempt report before any relaunch', async () => {
  const fixture = invocationFixture('triage', { launch: 'safe-halt' });
  assert.equal((await fixture.operation.run(fixture.input)).status, 'safe-halt');
  fixture.report = Buffer.from('{"report":{"status":"direct"}}');
  fixture.observation = { status: 'absent', processGroupAlive: false };
  const recovered = await fixture.operation.run(fixture.input);
  assert.equal(recovered.status, 'completed');
  assert.equal(fixture.launches, 1);
  assert.equal(fixture.observations, 1);
});

test('unknown report read retains the launched fence and never permits a second launch', async () => {
  const fixture = invocationFixture('triage', { launch: 'safe-halt' });
  assert.equal((await fixture.operation.run(fixture.input)).status, 'safe-halt');
  fixture.reportReadError = Object.assign(new Error('report I/O failed'), { code: 'EIO' });
  fixture.observation = { status: 'absent', processGroupAlive: false };

  assert.deepEqual(await fixture.operation.run(fixture.input), {
    status: 'safe-halt', code: 'report-operation-report-observation-unknown',
  });
  assert.equal(fixture.currentInvocation()?.phase, 'launched');
  assert.equal(fixture.launches, 1);
});

test('prompt-fact drift rejects stale adoption without clearing or relaunching the attempt', async () => {
  const fixture = invocationFixture('triage', { launch: 'safe-halt' });
  assert.equal((await fixture.operation.run(fixture.input)).status, 'safe-halt');
  fixture.report = Buffer.from('{"report":{"status":"direct"}}');
  fixture.observation = { status: 'absent', processGroupAlive: false };
  fixture.input.promptFacts = ['fact', 'new authoritative comment'];

  assert.deepEqual(await fixture.operation.run(fixture.input), {
    status: 'safe-halt', code: 'report-operation-prompt-facts-drift',
  });
  assert.equal(fixture.currentInvocation()?.phase, 'launched');
  assert.equal(fixture.launches, 1);
  assert.equal(fixture.observations, 0);
});

test('read-view cleanup failure defers recovered report adoption and preserves its fence', async () => {
  const fixture = invocationFixture('code-review', { launch: 'safe-halt' });
  assert.equal((await fixture.operation.run(fixture.input)).status, 'safe-halt');
  fixture.report = Buffer.from('{"report":{"verdict":"approved"}}');
  fixture.observation = { status: 'absent', processGroupAlive: false };
  fixture.cleanupError = new Error('cleanup failed');

  assert.deepEqual(await fixture.operation.run(fixture.input), {
    status: 'safe-halt', code: 'report-operation-attempt-cleanup-failed',
  });
  assert.equal(fixture.cleanups, 1);
  assert.equal(fixture.currentInvocation()?.phase, 'launched');
  assert.equal(fixture.launches, 1);

  fixture.cleanupError = undefined;
  assert.equal((await fixture.operation.run(fixture.input)).status, 'completed');
  assert.equal(fixture.cleanups, 2);
  assert.equal(fixture.launches, 1);
});

test('live, unknown, host/boot drift, and PID reuse with a live group stay fail closed without duplicate launch', async () => {
  for (const observation of [
    { status: 'present', processStartIdentity: 'start-1', processGroupAlive: true },
    { status: 'unknown' },
    { status: 'present', processStartIdentity: 'reused', processGroupAlive: true },
  ] as const) {
    const fixture = invocationFixture('code-review', { launch: 'safe-halt' });
    await fixture.operation.run(fixture.input);
    fixture.observation = observation;
    assert.equal((await fixture.operation.run(fixture.input)).status, 'safe-halt');
    assert.equal(fixture.launches, 1);
    assert.equal(fixture.observations, 1);
  }
  const drift = invocationFixture('spec-review', { launch: 'safe-halt' });
  await drift.operation.run(drift.input);
  drift.dependencies.bootId = 'boot-b';
  assert.equal((await drift.operation.run(drift.input)).status, 'safe-halt');
  assert.equal(drift.observations, 0);
});

test('PID reuse permits abandonment only after the old process group is positively absent', async () => {
  const fixture = invocationFixture('ambiguity-review', { launch: 'safe-halt' });
  await fixture.operation.run(fixture.input);
  fixture.observation = { status: 'present', processStartIdentity: 'reused', processGroupAlive: false };
  assert.deepEqual(await fixture.operation.run(fixture.input), { status: 'retryable', code: 'report-operation-output-unavailable' });
  assert.equal(fixture.invocation, undefined);
  assert.equal(fixture.launches, 1);
});

test('state-CAS failure prevents launch and worktree mutation prevents report adoption', async () => {
  const conflict = invocationFixture('triage', { launch: 'completed', rejectCas: true });
  assert.deepEqual(await conflict.operation.run(conflict.input), { status: 'blocked', kind: 'safety', code: 'report-operation-state-conflict' });
  assert.equal(conflict.launches, 0);

  const changed = invocationFixture('triage', { launch: 'completed', mutateSnapshot: true });
  assert.deepEqual(await changed.operation.run(changed.input), { status: 'blocked', kind: 'safety', code: 'report-operation-worktree-mutated' });
});

function invocationFixture(operationId: ContainedReportOperationId, options: {
  launch: 'completed' | 'safe-halt'; rejectCas?: boolean; mutateSnapshot?: boolean;
}) {
  let invocation: DurableReportInvocationV1 | undefined;
  let snapshots = 0;
  const phases: string[] = [];
  const fixture = {
    launches: 0,
    observations: 0,
    cleanups: 0,
    report: undefined as Buffer | undefined,
    reportReadError: undefined as Error | undefined,
    cleanupError: undefined as Error | undefined,
    observation: { status: 'present', processStartIdentity: 'start-1', processGroupAlive: true } as any,
    dependencies: {
      host: 'host-a', bootId: 'boot-a', now: () => '2026-07-17T00:00:00.000Z',
      createAttemptId: () => `attempt-${operationId}`,
      snapshot: async () => ({ ...snapshot(), ...(options.mutateSnapshot && snapshots++ > 0 ? { trackedContentSha256: '9'.repeat(64) } : {}) }),
      prepare: async () => ({ operation: operationId, generationHash, policy, reportPath: `/attempts/attempt-${operationId}/report.json` }),
      readReport: async () => {
        if (fixture.reportReadError) throw fixture.reportReadError;
        return fixture.report
          ? { status: 'available' as const, bytes: fixture.report }
          : { status: 'absent' as const };
      },
      settleAttempt: async () => {
        fixture.cleanups += 1;
        if (fixture.cleanupError) throw fixture.cleanupError;
      },
      processStartIdentity: async () => 'start-1',
      inspectProcess: async () => { fixture.observations += 1; return fixture.observation; },
      launch: async (input: any) => {
        fixture.launches += 1;
        await input.onSpawned({ pid: 4242, processGroupId: 4242 });
        return options.launch === 'completed'
          ? { status: 'completed' as const, reportBytes: Buffer.from(`report:${operationId}`) }
          : { status: 'safe-halt' as const };
      },
    },
  };
  const state = {
    read: async () => structuredClone(invocation),
    compareAndSwap: async (expected: DurableReportInvocationV1 | undefined, next: DurableReportInvocationV1 | undefined) => {
      if (options.rejectCas) return false;
      assert.deepEqual(invocation, expected);
      invocation = next ? structuredClone(next) : undefined;
      if (next) phases.push(next.phase);
      return true;
    },
  };
  return Object.assign(fixture, {
    currentInvocation: () => structuredClone(invocation),
    get invocation() { return invocation; },
    phases,
    operation: new InjectedContainedReportOperation(fixture.dependencies),
    input: { operation: operationId, runId: 'run-1', worktreePath: '/worktree', workflowGeneration,
      promptFacts: ['fact'], signal: new AbortController().signal, invocationState: state },
  });
}

function snapshot() {
  return { headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
    untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'worktree-1' };
}
