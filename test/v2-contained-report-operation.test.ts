import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InjectedContainedReportOperation,
  type ContainedReportOperationDependencies,
  type PreparedContainedReportAttempt,
} from '../src/v2/contained-report-operation.js';
import type { WorkflowGenerationReceipt, WorkflowOperationPolicy } from '../src/v2/workflow-assets.js';

const generationHash = 'a'.repeat(64);
const workflowGeneration: WorkflowGenerationReceipt = {
  generationHash,
  manifestSha256: 'b'.repeat(64),
  packageVersion: '2.0.1',
  generationRoot: '/sealed/workflow',
  contentSha256: 'c'.repeat(64),
};
const readOnlyPolicy: WorkflowOperationPolicy = {
  sandboxMode: 'read-only',
  cwdClass: 'worktree',
  worktreeAccess: 'read-only',
  writableRootClasses: [],
  runnerPostcondition: 'report-only',
  network: 'deny',
  networkHosts: [],
  mcpTools: [],
  approvalCeiling: 'never',
  externalWrite: false,
};
const codeReviewArtifact = {
  version: 1,
  operation: 'code-review',
  targetRevision: 1,
  targetFingerprint: 'd'.repeat(64),
  verdict: 'approved',
  coverage: ['correctness'],
  defects: [],
  residualRisks: [],
  reviewerSessionId: 'reviewer-session-1',
  reviewers: [
    { role: 'spec_reviewer', sessionId: 'spec-session-1', verdict: 'approve' },
    { role: 'standards_reviewer', sessionId: 'standards-session-1', verdict: 'approve' },
  ],
  repairFindingOutcomes: [],
};

test('implementation reviewer persists prepared and launched identity before accepting a correlated report', async () => {
  const fixture = operationFixture('code-review', Buffer.from(JSON.stringify({ report: codeReviewArtifact })));
  const input = runInput('code-review');
  const result = await fixture.operation.run({
    ...input,
    reviewContext: {
      operation: 'code-review', targetRevision: 1,
      targetFingerprint: 'd'.repeat(64), reviewerSessionId: 'reviewer-session-1',
      previousFindingIds: [],
    },
    onPrepared: async () => { fixture.events.push('persist:prepared'); },
    onLaunched: async ({ pid, processGroupId }) => { fixture.events.push(`persist:launched:${pid}:${processGroupId}`); },
  });

  assert.equal(result.status, 'completed');
  if (result.status !== 'completed') return;
  assert.deepEqual(result.validatedPayload, codeReviewArtifact);
  assert.deepEqual(fixture.events, [
    'snapshot', 'prepare:code-review', 'persist:prepared', 'launch:code-review',
    'persist:launched:4242:4242', 'snapshot',
  ]);
});

test('implementation reviewer rejects missing launch persistence and stale correlation', async () => {
  const fixture = operationFixture('code-review', Buffer.from(JSON.stringify({ report: codeReviewArtifact })));
  const missingGate = await fixture.operation.run(runInput('code-review'));
  assert.deepEqual(missingGate, {
    status: 'blocked', kind: 'safety', code: 'review-operation-launch-gate-missing',
  });

  const staleFixture = operationFixture('code-review', Buffer.from(JSON.stringify({ report: codeReviewArtifact })));
  const stale = await staleFixture.operation.run({
    ...runInput('code-review'),
    reviewContext: {
      operation: 'code-review', targetRevision: 2,
      targetFingerprint: 'd'.repeat(64), reviewerSessionId: 'reviewer-session-1',
      previousFindingIds: [],
    },
    onPrepared: async () => {},
    onLaunched: async () => {},
  });
  assert.equal(stale.status, 'invalid');
});

test('invalid payload returns validation findings without retaining raw payload bytes', async () => {
  const secret = 'raw-secret-that-must-not-survive';
  const fixture = operationFixture('code-review', Buffer.from(JSON.stringify({
    report: { ...codeReviewArtifact, status: secret },
  })));

  const result = await fixture.operation.run(reviewInput());

  assert.equal(result.status, 'invalid');
  if (result.status !== 'invalid') return;
  assert.equal(result.attemptId, 'attempt-1');
  assert.equal(result.findings.length > 0, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal('validatedPayload' in result, false);
});

test('credential-bearing report bytes are rejected before payload adoption', async () => {
  const fixture = operationFixture('code-review', Buffer.from(JSON.stringify({
    report: codeReviewArtifact,
    access_token: 'credential-material-12345',
  })));
  const result = await fixture.operation.run(reviewInput());
  assert.equal(result.status, 'invalid');
  assert.equal(JSON.stringify(result).includes('credential-material-12345'), false);
});

test('quiescence uncertainty returns durable process evidence without an unsafe final snapshot', async () => {
  const baseline = stableSnapshot();
  const dependencies: ContainedReportOperationDependencies = {
    snapshot: async () => structuredClone(baseline),
    prepare: async () => ({ operation: 'code-review', generationHash, policy: readOnlyPolicy }),
    launch: async () => ({
      status: 'safe-halt',
      pid: 123,
      processGroupId: 123,
      startedAt: '2026-07-17T00:00:00.000Z',
    }),
  };
  const result = await new InjectedContainedReportOperation(dependencies).run(reviewInput());
  assert.equal(result.status, 'safe-halt');
  if (result.status !== 'safe-halt') return;
  assert.deepEqual(result.process.baseline, baseline);
});

test('launcher blocks authority or generation drift before starting the process', async () => {
  const fixture = operationFixture('code-review', Buffer.from(JSON.stringify({ report: codeReviewArtifact })), {
    prepared: {
      operation: 'code-review',
      generationHash: 'd'.repeat(64),
      policy: { ...readOnlyPolicy, mcpTools: ['github'] },
    },
  });

  const result = await fixture.operation.run(reviewInput());

  assert.deepEqual(result, {
    status: 'blocked', kind: 'safety', code: 'report-operation-authority-drift',
  });
  assert.deepEqual(fixture.events, ['snapshot', 'prepare:code-review', 'snapshot']);
});

test('launcher blocks a completed report when any before/after worktree fingerprint differs', async () => {
  const fixture = operationFixture('code-review', Buffer.from(JSON.stringify({ report: codeReviewArtifact })), {
    snapshots: [
      { ...stableSnapshot() },
      { ...stableSnapshot(), trackedContentSha256: 'changed' },
    ],
  });

  const result = await fixture.operation.run(reviewInput());

  assert.deepEqual(result, {
    status: 'blocked', kind: 'safety', code: 'report-operation-worktree-mutated',
  });
});

function runInput(operation: 'code-review') {
  return {
    operation,
    attemptId: 'attempt-1',
    runId: 'run-1',
    worktreePath: '/worktree',
    workflowGeneration,
    promptFacts: ['fact'],
    signal: new AbortController().signal,
  };
}

function reviewInput() {
  return {
    ...runInput('code-review'),
    reviewContext: {
      operation: 'code-review' as const,
      targetRevision: 1,
      targetFingerprint: 'd'.repeat(64),
      reviewerSessionId: 'reviewer-session-1',
      previousFindingIds: [],
    },
    onPrepared: async () => {},
    onLaunched: async () => {},
  };
}

function operationFixture(
  operation: 'code-review',
  reportBytes: Buffer,
  options: {
    prepared?: PreparedContainedReportAttempt;
    snapshots?: unknown[];
  } = {},
) {
  const events: string[] = [];
  const snapshots = options.snapshots ?? [stableSnapshot(), stableSnapshot()];
  let snapshotIndex = 0;
  const dependencies: ContainedReportOperationDependencies = {
    snapshot: async () => {
      events.push('snapshot');
      return structuredClone(snapshots[snapshotIndex++]);
    },
    prepare: async (input) => {
      events.push(`prepare:${input.operation}`);
      return options.prepared ?? {
        operation, generationHash, policy: readOnlyPolicy,
        reviewers: ['spec_reviewer', 'standards_reviewer'],
      };
    },
    launch: async (input) => {
      events.push(`launch:${input.attempt.operation}`);
      await input.onLaunched?.({ pid: 4242, processGroupId: 4242 });
      return { status: 'completed', reportBytes };
    },
  };
  return { operation: new InjectedContainedReportOperation(dependencies), events };
}

function stableSnapshot() {
  return {
    headSha: '1',
    indexTreeSha: '2',
    trackedContentSha256: '3',
    untrackedContentSha256: '4',
    worktreeIdentity: '5',
  };
}
