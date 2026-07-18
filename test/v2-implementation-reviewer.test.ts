import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { ContainedReportOperation } from '../src/v2/contained-report-operation.js';
import { ContainedImplementationReviewer, type ImplementationReviewerInput } from '../src/v2/implementation-reviewer.js';

const fingerprint = 'a'.repeat(64);
const workflowGeneration = {
  generationHash: 'b'.repeat(64), manifestSha256: 'c'.repeat(64), packageVersion: '2.0.1',
  generationRoot: '/sealed/workflow', contentSha256: 'd'.repeat(64),
};
const report = {
  version: 1 as const, operation: 'code-review' as const, targetRevision: 1, targetFingerprint: fingerprint,
  verdict: 'approved' as const, mode: 'full' as const, coverage: ['correctness'], defects: [], residualRisks: [],
  reviewerSessionId: 'review-session-1', closureRequestSha256: null, repairFindingOutcomes: [],
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
  const reviewer = new ContainedImplementationReviewer({ operation, createAttemptId: () => 'review-attempt-1' });
  const result = await reviewer.run(input({
    onPrepared: async (invocation) => { persisted.push(`prepared:${invocation.attemptId}`); },
    onLaunched: async (invocation) => { persisted.push(`launched:${invocation.pid}:${invocation.processGroupId}`); },
  }));

  assert.deepEqual(result, { kind: 'completed', attemptId: 'review-attempt-1', report, artifactSha256: 'e'.repeat(64) });
  assert.deepEqual(persisted, ['prepared:review-attempt-1', 'launched:42:42']);
  assert.equal(calls[0]?.reviewContext?.reviewerSessionId, 'review-session-1');
  assert.equal(calls[0]?.promptFacts.length, 1);
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
  const reviewer = new ContainedImplementationReviewer({ operation, createAttemptId: () => 'repair-attempt-2' });
  const original = Buffer.from('{"report":{"version":1}}');
  const hash = createHash('sha256').update(original).digest('hex');
  const result = await reviewer.run(input({
    repairOnly: true, originalReportSha256: hash, validationDiagnostic: 'missing operation', originalReportBytes: original,
  }));
  assert.equal(result.kind, 'report-invalid');
  if (result.kind !== 'report-invalid') return;
  assert.equal(result.originalReportSha256, hash);
  assert.equal(calls[0]?.attemptId, 'repair-attempt-2');
  assert.equal(calls[0]?.promptFacts[0]?.includes(hash), true);

  const secret = Buffer.from('{"access_token":"credential-material-12345"}');
  const rejected = await reviewer.run(input({
    repairOnly: true,
    originalReportSha256: createHash('sha256').update(secret).digest('hex'),
    validationDiagnostic: 'bad envelope', originalReportBytes: secret,
  }));
  assert.deepEqual(rejected, { kind: 'internal-error', code: 'review-report-repair-input-invalid' });
  assert.equal(calls.length, 1);
});

test('reviewer facade rejects identity reuse before launching an operation', async () => {
  let called = false;
  const reviewer = new ContainedImplementationReviewer({
    createAttemptId: () => 'implementation-attempt-1',
    operation: { run: async () => { called = true; return { status: 'cancelled' }; } },
  });
  const result = await reviewer.run(input({ reviewerSessionId: 'implementation-attempt-1' }));
  assert.deepEqual(result, { kind: 'internal-error', code: 'reviewer-identity-not-independent' });
  assert.equal(called, false);
});

function input(overrides: Partial<ImplementationReviewerInput> = {}): ImplementationReviewerInput {
  return {
    runId: 'run-1', worktreePath: '/worktree', operation: 'code-review', mode: 'full',
    reviewerSessionId: 'review-session-1', implementationAttemptId: 'implementation-attempt-1', targetRevision: 1,
    targetFingerprint: fingerprint, closureRequestSha256: null, issue: { number: 1, title: 'Issue' },
    frozenCriteria: ['works'], routeReceipt: { route: 'direct' }, defects: [], affectedDefectIds: [],
    fixedRepairFindings: [],
    mandatoryCoverage: ['correctness'], workflowGeneration, repairOnly: false, originalReportSha256: null,
    validationDiagnostic: null, originalReportBytes: null, signal: new AbortController().signal,
    onPrepared: async () => {}, onLaunched: async () => {}, ...overrides,
  };
}
