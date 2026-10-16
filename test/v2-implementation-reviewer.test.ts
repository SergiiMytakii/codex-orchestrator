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
  reviewerSessionId: 'review-session-1', reviewers: [],
};

test('complete and targeted Review launch with the exact 19207-character candidate patch', async () => {
  const patch = 'diff --git a/feature.txt b/feature.txt\n+' + 'я'.repeat(19167);
  assert.equal(patch.length, 19207);
  const capsules: string[] = [];
  const reviewer = new ContainedImplementationReviewer({
    operation: { run: async (call) => { capsules.push(call.promptFacts[0]!); return { status: 'cancelled' }; } },
  });
  assert.deepEqual(await reviewer.run(input({ targetPatch: patch })), { kind: 'cancelled' });
  assert.deepEqual(await reviewer.run(input({
    targetRevision: 2, targetPatch: patch, repairPatch: patch,
    previousTarget: { targetRevision: 1, targetFingerprint: '4'.repeat(64), candidateTreeSha: '5'.repeat(40) },
    repairFindings: [{ id: 'finding-1', sourceId: 'check-1', summary: 'Repair behavior', affectedContracts: ['feature.txt'] }],
  })), { kind: 'cancelled' });
  assert.equal(JSON.parse(capsules[0]!).target.patch, patch);
  assert.equal(JSON.parse(capsules[1]!).target.repairPatch, patch);
});

test('review capsule retains additional implementation verification beside configured proof', async () => {
  let prompt = '';
  const reviewer = new ContainedImplementationReviewer({
    operation: { run: async call => { prompt = call.promptFacts[0]!; return { status: 'cancelled' }; } },
  });
  const lint = { id: 'lint', command: 'npm run lint', status: 'passed', outputSha256: 'e'.repeat(64) };
  await reviewer.run(input({ implementationChecks: [lint] }));
  const capsule = JSON.parse(prompt);
  assert.deepEqual(capsule.proof.implementationChecks, [lint]);
  assert.deepEqual(capsule.proof.checks, []);
});

test('Review passes large exact capsules through Runner-owned files without truncating patches', async () => {
  const calls: Parameters<ContainedReportOperation['run']>[0][] = [];
  const reviewer = new ContainedImplementationReviewer({ operation: { run: async (call) => { calls.push(call); return { status: 'cancelled' }; } } });
  const patch = 'я'.repeat(600_000);
  assert.deepEqual(await reviewer.run(input({ targetPatch: patch })), { kind: 'cancelled' });
  const fact = calls[0]!.runnerFacts?.[0];
  assert.ok(fact);
  assert.equal(JSON.parse(fact.bytes.toString('utf8')).target.patch, patch);
  assert.equal(createHash('sha256').update(fact.bytes).digest('hex'), fact.sha256);
  assert.equal(JSON.parse(calls[0]!.promptFacts[0]!).exactReviewCapsule.path, fact.path);
  for (const overrides of [
    { targetPatch: ' ' }, { reviewerSessionId: 'x'.repeat(16_385) },
    { targetPatch: 'API_KEY=unsafecredential123456789abcdef' },
  ]) assert.equal((await reviewer.run(input(overrides))).kind, 'internal-error');
  assert.equal(calls.length, 1);
});

test('thin reviewer facade binds an independent attempt and delegates durable launch hooks', async () => {
  const calls: Parameters<ContainedReportOperation['run']>[0][] = [];
  const operation: ContainedReportOperation = {
    run: async (call) => {
      calls.push(call);
      await call.onPrepared?.(call.reviewContext!);
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
  const original = Buffer.from(JSON.stringify({ report: { ...report, reviewers: [
    { role: 'spec_reviewer', sessionId: 'spec-original', verdict: 'approve' },
    { role: 'standards_reviewer', sessionId: 'standards-original', verdict: 'approve' },
  ] } }));
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

test('coverage-only correction retains independent verdicts and cannot erase findings or replace reviewers', async () => {
  const original = { ...report, reviewers: [
    { role: 'spec_reviewer', sessionId: 'original-spec', verdict: 'approve' as const },
    { role: 'standards_reviewer', sessionId: 'original-standards', verdict: 'approve' as const },
  ] };
  const originalReportBytes = Buffer.from(JSON.stringify({ report: original }));
  const correction = input({ repairOnly: true, originalReportBytes,
    originalReportSha256: createHash('sha256').update(originalReportBytes).digest('hex'),
    validationDiagnostic: 'approved review is missing required coverage' });
  let capsule: any;
  const reviewer = new ContainedImplementationReviewer({ operation: { run: async (call) => {
    capsule = JSON.parse(call.promptFacts[0]!);
    return { status: 'completed', attemptId: call.attemptId, artifactSha256: 'e'.repeat(64),
      validatedPayload: { ...original, coverage: [...correction.reviewFocus] } };
  } } });
  assert.equal((await reviewer.run(correction)).kind, 'completed');
  assert.equal(capsule.repairOnly, true);
  assert.equal(capsule.repair.originalReportSha256, correction.originalReportSha256);
  const replacement = new ContainedImplementationReviewer({ operation: { run: async (call) => ({
    status: 'completed', attemptId: call.attemptId, artifactSha256: 'e'.repeat(64),
    validatedPayload: { ...original, coverage: [...correction.reviewFocus], reviewers: original.reviewers.map((r) => ({ ...r, sessionId: r.sessionId + '-new' })) },
  }) } });
  assert.deepEqual(await replacement.run(correction), { kind: 'internal-error', code: 'review-report-correction-changed-semantics' });
});

test('format correction without an independent semantic review stops before a new Review can launch', async () => {
  const bytes = Buffer.from('{"report":{"version":1}}');
  let invoked = false;
  const reviewer = new ContainedImplementationReviewer({ operation: { run: async () => {
    invoked = true; return { status: 'cancelled' };
  } } });
  assert.deepEqual(await reviewer.run(input({ repairOnly: true, originalReportBytes: bytes,
    originalReportSha256: createHash('sha256').update(bytes).digest('hex'),
    validationDiagnostic: 'code review report has unknown or missing keys' })),
    { kind: 'internal-error', code: 'review-report-repair-input-invalid' });
  assert.equal(invoked, false);
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

test('actual contained Review operation maps temporary snapshots, preparation, launch, and report availability as resumable', async () => {
  const snapshot = {
    headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
    untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'review-worktree',
  };
  const prepared: PreparedContainedReportAttempt = {
    operation: 'code-review' as const,
    generationHash: workflowGeneration.generationHash,
    reviewers: ['spec_reviewer', 'standards_reviewer'],
    policy: {
      sandboxMode: 'read-only' as const, cwdClass: 'worktree' as const, worktreeAccess: 'read-only' as const,
      writableRootClasses: [], runnerPostcondition: 'report-only' as const, network: 'deny' as const,
      networkHosts: [], mcpTools: [], approvalCeiling: 'never' as const, externalWrite: false,
    },
  };
  const cases = [
    new InjectedContainedReportOperation({
      snapshot: async () => { throw Object.assign(new Error('temporary snapshot I/O'), { code: 'EIO' }); },
      prepare: async () => prepared, launch: async () => ({ status: 'cancelled' }),
    }),
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

test('reviewer facade retains unsafe snapshot failures as integrity errors', async () => {
  const reviewer = new ContainedImplementationReviewer({ operation: new InjectedContainedReportOperation({
    snapshot: async () => ({ headSha: 'only one fingerprint' }),
    prepare: async () => { throw new Error('must not prepare'); },
    launch: async () => { throw new Error('must not launch'); },
  }) });
  assert.deepEqual(await reviewer.run(input()), { kind: 'internal-error', code: 'report-operation-snapshot-failed' });
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

test('format correction preserves a blocking review with two prior repairs without rerunning reviewers', async () => {
  const finding = { id: 'standards:build', class: 'blocker' as const, severity: 'medium' as const,
    confidence: 'high' as const, invariant: 'Build candidate', failure: 'Build proof missing',
    evidence: ['Only test and typecheck receipts'], repair: 'Run build', affectedTargets: ['src/feature.ts'] };
  const semantic = { ...report, targetRevision: 2, verdict: 'needs-work' as const, defects: [finding], reviewers: [
    { role: 'spec_reviewer', sessionId: 'retained-spec', verdict: 'approve' as const },
    { role: 'standards_reviewer', sessionId: 'retained-standards', verdict: 'block' as const },
  ] };
  const { coverage: _coverage, ...withoutCoverage } = semantic;
  const originalReportBytes = Buffer.from(JSON.stringify({ report: withoutCoverage }));
  const correction = input({ targetRevision: 2, repairOnly: true, originalReportBytes,
    previousTarget: { targetRevision: 1, targetFingerprint: '4'.repeat(64), candidateTreeSha: '5'.repeat(40) },
    originalReportSha256: createHash('sha256').update(originalReportBytes).digest('hex'),
    validationDiagnostic: 'code review report has unknown or missing keys',
    repairFindings: [{ id: 'proof:acceptance', sourceId: 'proof:acceptance', summary: 'Acceptance repaired', affectedContracts: ['src/feature.ts'] }],
    defects: [{ ...finding, status: 'fixed', introducedTargetRevision: 1, statusTargetRevision: 1, supersededBy: null }],
  });
  const run = async (payload: unknown) => {
    const reviewer = new ContainedImplementationReviewer({ operation: { run: async call => {
      const capsule = JSON.parse(call.promptFacts[0]!);
      assert.equal(capsule.repairOnly, true);
      assert.equal(capsule.repair.originalReport, originalReportBytes.toString());
      return { status: 'completed', attemptId: call.attemptId, artifactSha256: 'e'.repeat(64), validatedPayload: payload };
    } } });
    return reviewer.run(correction);
  };
  assert.equal((await run(semantic)).kind, 'completed');
  assert.deepEqual(await run({ ...semantic, verdict: 'approved', defects: [],
    reviewers: semantic.reviewers.map(reviewer => ({ ...reviewer, verdict: 'approve' })) }),
    { kind: 'internal-error', code: 'review-report-correction-changed-semantics' });
});
