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
const directArtifact = {
  version: 1,
  status: 'direct',
  inspectedEvidence: [{ kind: 'issue', location: '#1', summary: 'Read the issue.' }],
  assumptions: [],
  direct: { summary: 'Small change.', behaviors: ['Change behavior.'], verification: ['Run test.'] },
  specRequired: null,
  awaitingUser: null,
  blocker: null,
};
const reviewArtifact = {
  version: 1,
  candidateSha256: 'b9616d55da5ad1ef72b632cda35c61663294f682bcb4787fedc32d82e0519c31',
  verdict: 'approved',
  evidenceReviewed: ['issue'],
  findings: [],
  recommendation: 'Proceed.',
};
const codeReviewArtifact = {
  version: 1,
  operation: 'code-review',
  targetRevision: 1,
  targetFingerprint: 'd'.repeat(64),
  verdict: 'approved',
  mode: 'full',
  coverage: ['correctness'],
  defects: [],
  residualRisks: [],
  reviewerSessionId: 'reviewer-session-1',
  closureRequestSha256: null,
  repairFindingOutcomes: [],
};

test('report-only launcher returns validated triage payload with the exact domain-separated hash', async () => {
  const fixture = operationFixture('triage', Buffer.from(JSON.stringify({ report: directArtifact }, null, 2)));

  const result = await fixture.operation.run(runInput('triage'));

  assert.deepEqual(result, {
    status: 'completed',
    attemptId: 'attempt-1',
    validatedPayload: directArtifact,
    artifactSha256: 'b9616d55da5ad1ef72b632cda35c61663294f682bcb4787fedc32d82e0519c31',
  });
  assert.deepEqual(fixture.events, ['snapshot', 'prepare:triage', 'launch:triage', 'snapshot']);
});

test('report-only launcher validates and hashes ambiguity-review payload independently of envelope bytes', async () => {
  const report = Buffer.from(`{\n  "report": ${JSON.stringify(reviewArtifact)}\n}\n`);
  const fixture = operationFixture('ambiguity-review', report);

  const result = await fixture.operation.run(runInput('ambiguity-review'));

  assert.deepEqual(result, {
    status: 'completed',
    attemptId: 'attempt-1',
    validatedPayload: reviewArtifact,
    artifactSha256: 'a15f377edd58ccb08d215dbf85b214a73d83c684bf3a98b626d14cf7fb4ff356',
  });
});

test('implementation reviewer persists prepared and launched identity before accepting a correlated report', async () => {
  const fixture = operationFixture('code-review', Buffer.from(JSON.stringify({ report: codeReviewArtifact })));
  const input = runInput('code-review');
  const result = await fixture.operation.run({
    ...input,
    reviewContext: {
      operation: 'code-review', mode: 'full', targetRevision: 1,
      targetFingerprint: 'd'.repeat(64), reviewerSessionId: 'reviewer-session-1',
      closureRequestSha256: null,
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
      operation: 'code-review', mode: 'full', targetRevision: 2,
      targetFingerprint: 'd'.repeat(64), reviewerSessionId: 'reviewer-session-1',
      closureRequestSha256: null,
    },
    onPrepared: async () => {},
    onLaunched: async () => {},
  });
  assert.equal(stale.status, 'invalid');
});

test('invalid payload returns validation findings without retaining raw payload bytes', async () => {
  const secret = 'raw-secret-that-must-not-survive';
  const fixture = operationFixture('triage', Buffer.from(JSON.stringify({
    report: { ...directArtifact, status: secret },
  })));

  const result = await fixture.operation.run(runInput('triage'));

  assert.equal(result.status, 'invalid');
  if (result.status !== 'invalid') return;
  assert.equal(result.attemptId, 'attempt-1');
  assert.equal(result.findings.length > 0, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal('validatedPayload' in result, false);
});

test('credential-bearing report bytes are rejected before payload adoption', async () => {
  const fixture = operationFixture('triage', Buffer.from(JSON.stringify({
    report: directArtifact,
    access_token: 'credential-material-12345',
  })));
  const result = await fixture.operation.run(runInput('triage'));
  assert.equal(result.status, 'invalid');
  assert.equal(JSON.stringify(result).includes('credential-material-12345'), false);
});

test('quiescence uncertainty returns durable process evidence without an unsafe final snapshot', async () => {
  const baseline = stableSnapshot();
  const dependencies: ContainedReportOperationDependencies = {
    snapshot: async () => structuredClone(baseline),
    prepare: async () => ({ operation: 'triage', generationHash, policy: readOnlyPolicy }),
    launch: async () => ({
      status: 'safe-halt',
      pid: 123,
      processGroupId: 123,
      startedAt: '2026-07-17T00:00:00.000Z',
      waitForAbsence: async () => {},
    }),
  };
  const result = await new InjectedContainedReportOperation(dependencies).run(runInput('triage'));
  assert.equal(result.status, 'safe-halt');
  if (result.status !== 'safe-halt') return;
  assert.deepEqual(result.process.baseline, baseline);
});

test('ambiguity review uses the authoritative bounded unique-field validator', async () => {
  for (const invalid of [
    { ...reviewArtifact, evidenceReviewed: ['issue', 'issue'] },
    { ...reviewArtifact, findings: Array.from({ length: 257 }, (_, index) => `finding-${index}`) },
  ]) {
    const fixture = operationFixture('ambiguity-review', Buffer.from(JSON.stringify({ report: invalid })));
    const result = await fixture.operation.run(runInput('ambiguity-review'));
    assert.equal(result.status, 'invalid');
  }
});

test('launcher blocks authority or generation drift before starting the process', async () => {
  const fixture = operationFixture('triage', Buffer.from(JSON.stringify({ report: directArtifact })), {
    prepared: {
      operation: 'triage',
      generationHash: 'd'.repeat(64),
      policy: { ...readOnlyPolicy, mcpTools: ['github'] },
    },
  });

  const result = await fixture.operation.run(runInput('triage'));

  assert.deepEqual(result, {
    status: 'blocked', kind: 'safety', code: 'report-operation-authority-drift',
  });
  assert.deepEqual(fixture.events, ['snapshot', 'prepare:triage', 'snapshot']);
});

test('launcher blocks a completed report when any before/after worktree fingerprint differs', async () => {
  const fixture = operationFixture('triage', Buffer.from(JSON.stringify({ report: directArtifact })), {
    snapshots: [
      { ...stableSnapshot() },
      { ...stableSnapshot(), trackedContentSha256: 'changed' },
    ],
  });

  const result = await fixture.operation.run(runInput('triage'));

  assert.deepEqual(result, {
    status: 'blocked', kind: 'safety', code: 'report-operation-worktree-mutated',
  });
});

function runInput(operation: 'triage' | 'ambiguity-review' | 'code-review') {
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

function operationFixture(
  operation: 'triage' | 'ambiguity-review' | 'code-review',
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
      return options.prepared ?? { operation, generationHash, policy: readOnlyPolicy };
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
