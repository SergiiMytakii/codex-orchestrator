import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  InjectedContainedReportOperation,
  type ContainedReportOperation,
  type PreparedContainedReportAttempt,
} from '../src/v2/contained-report-operation.js';
import { ContainedImplementationReviewer, type ImplementationReviewerInput } from '../src/v2/implementation-reviewer.js';

const fingerprint = 'a'.repeat(64);
const workflowGeneration = {
  generationHash: 'b'.repeat(64), manifestSha256: 'c'.repeat(64), packageVersion: '2.0.1',
  generationRoot: '/sealed/workflow', contentSha256: 'd'.repeat(64),
};
const report = {
  version: 1 as const, operation: 'code-review' as const, targetRevision: 1, targetFingerprint: fingerprint,
  verdict: 'approved' as const, coverage: ['correctness'], defects: [], residualRisks: [],
  reviewerSessionId: 'review-session-1', reviewers: [], repairFindingOutcomes: [],
};

test('thin reviewer facade binds an independent attempt and delegates durable launch hooks', async () => {
  const calls: Parameters<ContainedReportOperation['run']>[0][] = [];
  const operation: ContainedReportOperation = {
    run: async (call) => {
      calls.push(call);
      await call.onPrepared?.();
      await call.onLaunched?.({ pid: 42, processGroupId: 42 });
      return { status: 'completed', attemptId: call.attemptId, validatedPayload: report, artifactSha256: 'e'.repeat(64) };
    },
  };
  const persisted: string[] = [];
  const reviewer = new ContainedImplementationReviewer({ operation });
  const result = await reviewer.run(input({
    onPrepared: async (invocation) => { persisted.push(`prepared:${invocation.attemptId}`); },
    onLaunched: async (invocation) => { persisted.push(`launched:${invocation.pid}:${invocation.processGroupId}`); },
  }));

  assert.deepEqual(result, { kind: 'completed', attemptId: 'review-attempt-1', report, artifactSha256: 'e'.repeat(64) });
  assert.deepEqual(persisted, ['prepared:review-attempt-1', 'launched:42:42']);
  assert.equal(calls[0]?.reviewContext?.reviewerSessionId, 'review-session-1');
  assert.deepEqual(calls[0]?.reviewContext?.requiredCoverage, [
    'candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability',
    'repository-standards', 'requirements', 'tests', 'zero-legacy',
  ]);
  assert.equal(calls[0]?.promptFacts.length, 1);
  const capsule = JSON.parse(calls[0]!.promptFacts[0]!) as Record<string, any>;
  assert.deepEqual(capsule.target.changedFiles, ['feature.txt']);
  assert.match(capsule.target.patch, /\+implemented/u);
});

test('targeted reviewer capsule carries only ephemeral exact trees, patch, blocker IDs, and current proof', async () => {
  let prompt = '';
  const reviewer = new ContainedImplementationReviewer({
    operation: { run: async (call) => { prompt = call.promptFacts[0] ?? ''; return { status: 'cancelled' }; } },
  });
  await reviewer.run(input({
    targetRevision: 2, currentTreeSha: '3'.repeat(40),
    previousTarget: { targetRevision: 1, targetFingerprint: '4'.repeat(64), candidateTreeSha: '5'.repeat(40) },
    repairPatch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    repairFindings: [{
      id: 'finding-1', sourceId: 'source-1', summary: 'Trusted feedback body',
      affectedContracts: ['contract:correctness', 'path:src/a.ts'],
    }],
  }));
  const capsule = JSON.parse(prompt) as Record<string, any>;
  assert.equal(capsule.target.previous.candidateTreeSha, '5'.repeat(40));
  assert.match(capsule.target.repairPatch, /\+new/u);
  assert.deepEqual(capsule.repairFindings, [{
    id: 'finding-1', sourceId: 'source-1', summary: 'Trusted feedback body',
    affectedContracts: ['contract:correctness', 'path:src/a.ts'],
  }]);
  assert.equal(capsule.proof.checkedChangeSha256, '2'.repeat(64));
  for (const removed of ['approvedCoverage', 'reviewMode', 'repairDelta', 'directImpactCone', 'preservedApproval', 'affectedProof']) {
    assert.equal(prompt.includes(removed), false, removed);
  }
});

test('report-only repair requires exact bounded secret-free original bytes and a new attempt', async () => {
  const calls: Parameters<ContainedReportOperation['run']>[0][] = [];
  const operation: ContainedReportOperation = {
    run: async (call) => {
      calls.push(call);
      return {
        status: 'invalid', attemptId: call.attemptId, findings: ['still malformed'],
        repairInput: { originalReportSha256: hash, originalReportBytes: Buffer.from(original) },
      };
    },
  };
  const reviewer = new ContainedImplementationReviewer({ operation });
  const original = Buffer.from('{"report":{"version":1}}');
  const hash = createHash('sha256').update(original).digest('hex');
  const result = await reviewer.run(input({
    attemptId: 'repair-attempt-2',
    repairOnly: true, originalReportSha256: hash, validationDiagnostic: 'missing operation', originalReportBytes: original,
  }));
  assert.equal(result.kind, 'report-invalid');
  if (result.kind !== 'report-invalid') return;
  assert.equal(result.originalReportSha256, hash);
  assert.equal(calls[0]?.attemptId, 'repair-attempt-2');
  assert.equal(calls[0]?.promptFacts[0]?.includes(hash), true);

  const secret = Buffer.from('{"access_token":"credential-material-12345"}');
  const rejected = await reviewer.run(input({
    attemptId: 'repair-attempt-3',
    repairOnly: true,
    originalReportSha256: createHash('sha256').update(secret).digest('hex'),
    validationDiagnostic: 'bad envelope', originalReportBytes: secret,
  }));
  assert.deepEqual(rejected, { kind: 'internal-error', code: 'review-report-repair-input-invalid' });
  assert.equal(calls.length, 1);
});

test('malformed Review admission has one exact encoded capsule boundary and every admitted result can be repaired', async () => {
  const resultForSize = async (size: number) => {
    const bytes = Buffer.from('x'.repeat(size));
    const reviewer = new ContainedImplementationReviewer({
      operation: { run: async (call) => ({
        status: 'invalid' as const,
        attemptId: call.attemptId,
        findings: ['malformed'],
        repairInput: { originalReportSha256: createHash('sha256').update(bytes).digest('hex'), originalReportBytes: bytes },
      }) },
    });
    return { bytes, result: await reviewer.run(input()) };
  };
  let low = 1;
  let high = 2 * 1024 * 1024;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((await resultForSize(middle)).result.kind === 'report-invalid') low = middle;
    else high = middle - 1;
  }
  assert.ok(low < 2 * 1024 * 1024, 'repair admission must reserve capsule metadata overhead');
  const admitted = await resultForSize(low);
  assert.equal(admitted.result.kind, 'report-invalid');
  assert.notEqual((await resultForSize(low + 1)).result.kind, 'report-invalid');
  if (admitted.result.kind !== 'report-invalid') return;

  let invoked = false;
  const correction = new ContainedImplementationReviewer({
    operation: { run: async () => { invoked = true; return { status: 'cancelled' }; } },
  });
  assert.deepEqual(await correction.run(input({
    attemptId: 'repair-boundary-attempt', repairOnly: true,
    originalReportSha256: admitted.result.originalReportSha256,
    validationDiagnostic: admitted.result.diagnostic,
    originalReportBytes: admitted.result.originalReportBytes,
  })), { kind: 'cancelled' });
  assert.equal(invoked, true);
});

test('production reviewer accepts targeted and complete fallback capsules with the same previous target provenance', async () => {
  const prompts: string[] = [];
  const reviewer = new ContainedImplementationReviewer({
    operation: { run: async (call) => { prompts.push(call.promptFacts[0] ?? ''); return { status: 'cancelled' }; } },
  });
  const previousTarget = { targetRevision: 1, targetFingerprint: '4'.repeat(64), candidateTreeSha: '5'.repeat(40) };
  const repairFindings = [{
    id: 'pr-thread:T_1', sourceId: 'pr-thread:T_1', summary: 'Trusted feedback body',
    affectedContracts: ['path:src/a.ts', 'pr-review'],
  }];
  assert.deepEqual(await reviewer.run(input({
    targetRevision: 2, currentTreeSha: '3'.repeat(40), previousTarget, repairFindings,
    repairPatch: 'diff --git a/src/a.ts b/src/a.ts\n-old\n+new\n',
  })), { kind: 'cancelled' });
  assert.deepEqual(await reviewer.run(input({
    attemptId: 'complete-fallback-attempt', targetRevision: 2, currentTreeSha: '3'.repeat(40),
    previousTarget, repairFindings, repairPatch: null,
  })), { kind: 'cancelled' });
  assert.equal(JSON.parse(prompts[0]!).target.repairPatch.includes('+new'), true);
  assert.equal(JSON.parse(prompts[1]!).target.repairPatch, null);
  assert.deepEqual(JSON.parse(prompts[1]!).target.previous, previousTarget);
  assert.deepEqual(JSON.parse(prompts[1]!).repairFindings, repairFindings);
});

test('reviewer capsule round-trips 257 unique input items under the encoded byte boundary', async () => {
  let capsule = '';
  const reviewer = new ContainedImplementationReviewer({
    operation: { run: async (call) => { capsule = call.promptFacts[0] ?? ''; return { status: 'cancelled' }; } },
  });
  const reviewFocus = Array.from({ length: 257 }, (_, index) => `focus-${index.toString().padStart(3, '0')}`);
  assert.deepEqual(await reviewer.run(input({ reviewFocus })), { kind: 'cancelled' });
  assert.deepEqual(JSON.parse(capsule).reviewFocus, reviewFocus);
  assert.ok(Buffer.byteLength(capsule, 'utf8') < 1024 * 1024);
});

test('reviewer facade rejects identity reuse before launching an operation', async () => {
  let called = false;
  const reviewer = new ContainedImplementationReviewer({
    operation: { run: async () => { called = true; return { status: 'cancelled' }; } },
  });
  const result = await reviewer.run(input({ attemptId: 'implementation-attempt-1', reviewerSessionId: 'implementation-attempt-1' }));
  assert.deepEqual(result, { kind: 'internal-error', code: 'reviewer-identity-not-independent' });
  assert.equal(called, false);
});

test('reviewer facade projects settled launch-gate failure as resumable infrastructure', async () => {
  const reviewer = new ContainedImplementationReviewer({
    operation: { run: async () => ({ status: 'retryable', code: 'review-operation-launch-gate-failed' }) },
  });
  assert.deepEqual(await reviewer.run(input()), { kind: 'transport-failed', resumable: true });
});

test('actual contained Review operation maps temporary prepare, launch, and report availability failures as resumable', async () => {
  const snapshot = {
    headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
    untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'review-worktree',
  };
  const prepared: PreparedContainedReportAttempt = {
    operation: 'code-review' as const,
    generationHash: workflowGeneration.generationHash,
    policy: {
      sandboxMode: 'read-only' as const, cwdClass: 'worktree' as const, worktreeAccess: 'read-only' as const,
      writableRootClasses: [], runnerPostcondition: 'report-only' as const, network: 'deny' as const,
      networkHosts: [], mcpTools: [], approvalCeiling: 'never' as const, externalWrite: false,
    },
  };
  const cases = [
    new InjectedContainedReportOperation({
      snapshot: async () => snapshot,
      prepare: async () => { throw new Error('service unavailable'); },
      launch: async () => { throw new Error('unreachable'); },
    }),
    new InjectedContainedReportOperation({
      snapshot: async () => snapshot, prepare: async () => prepared,
      launch: async () => { throw new Error('service unavailable'); },
    }),
    new InjectedContainedReportOperation({
      snapshot: async () => snapshot, prepare: async () => prepared,
      launch: async () => ({ status: 'blocked', kind: 'external', code: 'report-operation-report-unavailable' }),
    }),
  ];

  for (const operation of cases) {
    const reviewer = new ContainedImplementationReviewer({ operation });
    assert.deepEqual(await reviewer.run(input()), { kind: 'transport-failed', resumable: true });
  }
});

function input(overrides: Partial<ImplementationReviewerInput> = {}): ImplementationReviewerInput {
  return {
    attemptId: 'review-attempt-1', runId: 'run-1', worktreePath: '/worktree', operation: 'code-review',
    reviewerSessionId: 'review-session-1', implementationAttemptId: 'implementation-attempt-1', targetRevision: 1,
    targetFingerprint: fingerprint, issue: { number: 1, title: 'Issue' },
    currentTreeSha: '1'.repeat(40), previousTarget: null, repairPatch: null,
    targetPatch: 'diff --git a/feature.txt b/feature.txt\nnew file mode 100644\n+implemented\n', changedFiles: ['feature.txt'],
    repairFindings: [], checkedChangeSha256: '2'.repeat(64), checks: [], proofReceipt: { proofId: 'proof-1' },
    frozenCriteria: ['works'],
    deliveryAuthority: {
      version: 2, kind: 'issue', issueNumber: 1, issueUrl: 'https://example.invalid/issues/1',
      issueSnapshotSha256: 'a'.repeat(64), authorizationLabel: 'agent:auto',
      sourceSha256: 'a'.repeat(64), authoritySha256: 'b'.repeat(64),
    },
    defects: [],
    reviewFocus: [
      'candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability',
      'repository-standards', 'requirements', 'tests', 'zero-legacy',
    ], workflowGeneration, repairOnly: false, originalReportSha256: null,
    validationDiagnostic: null, originalReportBytes: null, signal: new AbortController().signal,
    onPrepared: async () => {}, onLaunched: async () => {}, ...overrides,
  };
}
