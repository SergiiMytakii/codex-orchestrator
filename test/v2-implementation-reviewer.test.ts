import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ContainedImplementationReviewer } from '../src/v2/implementation-reviewer.js';
import type { ContainedReportOperation, DurableReportInvocationV1 } from '../src/v2/contained-report-operation.js';

const report = {
  version: 1, operation: 'code-review', targetRevision: 1, targetFingerprint: 'd'.repeat(64),
  verdict: 'approved', mode: 'full', coverage: ['correctness'], defects: [], residualRisks: [],
  reviewerSessionId: 'reviewer-1', closureRequestSha256: null, repairFindingOutcomes: [],
};

test('phase reviewer retains correlation, provenance, and reviewer independence while mechanics remain external', async () => {
  let observed: any;
  const operation: ContainedReportOperation = { run: async (input) => {
    observed = input;
    return { status: 'completed', attemptId: 'review-attempt', reportBytes: Buffer.from(JSON.stringify({ report })), reportSha256: 'a'.repeat(64) };
  } };
  const result = await new ContainedImplementationReviewer({ operation }).run(input());
  assert.equal(result.kind, 'completed');
  assert.deepEqual(observed.forbiddenAttemptIds, ['implementation-1', 'reviewer-1']);
  assert.equal(observed.promptFacts.length, 1);
});

test('malformed output is mapped to the existing report-repair budget input without leaking credentials', async () => {
  const bytes = Buffer.from('{"report":{"wrong":true}}');
  const operation: ContainedReportOperation = { run: async () => ({
    status: 'completed', attemptId: 'review-attempt', reportBytes: bytes, reportSha256: 'b'.repeat(64),
  }) };
  const result = await new ContainedImplementationReviewer({ operation }).run(input());
  assert.equal(result.kind, 'report-invalid');
  assert.equal(result.kind === 'report-invalid' && result.originalReportBytes.equals(bytes), true);
});

test('same implementation/reviewer identity is rejected before canonical mechanics launch', async () => {
  let calls = 0;
  const operation: ContainedReportOperation = { run: async () => { calls += 1; return { status: 'cancelled' }; } };
  const result = await new ContainedImplementationReviewer({ operation }).run(input({ reviewerSessionId: 'implementation-1' }));
  assert.deepEqual(result, { kind: 'internal-error', code: 'reviewer-identity-not-independent' });
  assert.equal(calls, 0);
});

function input(overrides: Record<string, unknown> = {}) {
  let invocation: DurableReportInvocationV1 | undefined;
  return {
    runId: 'run-1', worktreePath: '/candidate', operation: 'code-review' as const, mode: 'full' as const,
    reviewerSessionId: 'reviewer-1', implementationAttemptId: 'implementation-1', targetRevision: 1,
    targetFingerprint: 'd'.repeat(64), closureRequestSha256: null, issue: { number: 1 }, frozenCriteria: [],
    routeReceipt: { route: 'direct' }, defects: [], affectedDefectIds: [], fixedRepairFindings: [],
    reviewFocus: ['correctness'], workflowGeneration: { generationHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
      packageVersion: '2.0.10', generationRoot: '/sealed/workflow', contentSha256: 'c'.repeat(64) },
    repairOnly: false, originalReportSha256: null, validationDiagnostic: null, originalReportBytes: null,
    signal: new AbortController().signal,
    invocationState: {
      read: async () => structuredClone(invocation),
      compareAndSwap: async (_expected: DurableReportInvocationV1 | undefined, next: DurableReportInvocationV1 | undefined) => { invocation = next; return true; },
    },
    ...overrides,
  };
}
