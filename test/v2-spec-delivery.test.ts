import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptSpecReview,
  acceptSpecRevision,
  consumeSpecReportRepair,
  consumeSpecTransportRetry,
  createInitialSpecDelivery,
  createSpecRevision,
  freezeApprovedSpec,
  validateSpecDelivery,
  type SpecDeliveryV1,
  type SpecReviewReportV1,
} from '../src/v2/spec-delivery.js';
import { SpecCoordinator, type SpecDeliveryState } from '../src/v2/spec-coordinator.js';

const workflowHash = 'a'.repeat(64);
const reportHash = 'b'.repeat(64);

test('spec delivery persists semantics without invocation or PID ownership', () => {
  const initial = createInitialSpecDelivery({ issueNumber: 1, runId: 'run-1', workflowGenerationSha256: workflowHash });
  assert.deepEqual(validateSpecDelivery(initial), initial);
  assert.equal('invocation' in initial, false);
  assert.throws(() => validateSpecDelivery({ ...initial, invocation: {} }), /unknown or missing keys/u);
});

test('author and reviewer results correlate through immutable actors and reviewer independence', () => {
  const initial = createInitialSpecDelivery({ issueNumber: 1, runId: 'run-1', workflowGenerationSha256: workflowHash });
  const revision = createSpecRevision({
    revision: 1, path: 'docs/spec.md', content: '# Spec\n', previousRevision: null,
    evidence: [{ path: 'issue:1', sha256: 'c'.repeat(64), description: 'intent' }],
    author: { attemptId: 'author-attempt', sessionId: 'author-session' },
  });
  const reviewReady = acceptSpecRevision(initial, revision);
  assert.equal(reviewReady.stage, 'review-full');
  assert.throws(() => acceptSpecReview(reviewReady, reviewReport(revision, 'author-session'), reportHash), /correlation/u);
  const approved = acceptSpecReview(reviewReady, reviewReport(revision, 'review-session'), reportHash);
  assert.equal(approved.stage, 'approved');
  assert.equal(freezeApprovedSpec(approved).stage, 'frozen');
});

test('report and transport budgets remain separate semantic counters', () => {
  const initial = createInitialSpecDelivery({ issueNumber: 1, runId: 'run-1', workflowGenerationSha256: workflowHash });
  const report = consumeSpecReportRepair(initial, 'author');
  const transport = consumeSpecTransportRetry(report, 'author');
  assert.deepEqual(transport.budgets.author, { reportRepairs: 1, transportRetries: 1 });
  assert.throws(() => consumeSpecTransportRetry(transport, 'author'), /exhausted/u);
});

test('coordinator prepares, launches, adopts, and cleans one external active attempt', async () => {
  const state = new MemorySpecState();
  const coordinator = new SpecCoordinator({
    state,
    operation: {
      author: async ({ attemptId, onPrepared, onLaunched }) => {
        await onPrepared({ attemptId, sessionId: 'author-session', reportPath: '/tmp/report.json', revisionPath: '/tmp/spec.md' });
        await onLaunched({ attemptId, sessionId: 'author-session', pid: 42, processGroupId: 42 });
        return { status: 'completed', attemptResultSha256: 'a'.repeat(64), value: createSpecRevision({
          revision: 1, path: '/tmp/spec.md', content: '# Spec\n', previousRevision: null,
          evidence: [{ path: 'issue:1', sha256: 'c'.repeat(64), description: 'intent' }],
          author: { attemptId, sessionId: 'author-session' },
        }) };
      },
      review: async ({ attemptId, state: delivery, onPrepared, onLaunched }) => {
        await onPrepared({ attemptId, sessionId: 'review-session', reportPath: '/tmp/review.json' });
        await onLaunched({ attemptId, sessionId: 'review-session', pid: 43, processGroupId: 43 });
        return { status: 'completed', value: reviewReport(delivery.revisions[0]!, 'review-session', attemptId), attemptResultSha256: reportHash, reportSha256: reportHash };
      },
    },
  });
  const result = await coordinator.run({
    issue: { number: 1 }, runId: 'run-1', worktreePath: '/worktree', frozenCriteria: [],
    workflowGeneration: { generationHash: workflowHash }, receipt: {},
  } as never, new AbortController().signal);
  assert.equal(result.status, 'completed');
  assert.deepEqual(state.events, ['prepare:spec-author', 'launch', 'adopt', 'clear', 'prepare:spec-review', 'launch', 'adopt', 'clear']);
});

class MemorySpecState implements SpecDeliveryState {
  current: SpecDeliveryV1 | undefined;
  events: string[] = [];
  private attempt = 0;
  async read() { return structuredClone(this.current); }
  async compareAndSwap(expected: SpecDeliveryV1 | undefined, next: SpecDeliveryV1) {
    if (JSON.stringify(expected) !== JSON.stringify(this.current)) return false;
    this.current = structuredClone(next); return true;
  }
  async prepareAttempt(operationId: 'spec-author' | 'spec-review') {
    this.events.push(`prepare:${operationId}`); return { attemptId: `${operationId}-attempt-${++this.attempt}`, recoverOnly: false };
  }
  async launchAttempt() { this.events.push('launch'); }
  async adopt(expected: SpecDeliveryV1, next: SpecDeliveryV1) {
    if (JSON.stringify(expected) !== JSON.stringify(this.current)) return false;
    this.current = structuredClone(next); this.events.push('adopt'); return true;
  }
  async clearAttempt() { this.events.push('clear'); }
}

function reviewReport(revision: ReturnType<typeof createSpecRevision>, sessionId: string, attemptId = 'review-attempt'): SpecReviewReportV1 {
  return {
    version: 1, targetRevision: revision.revision, targetSha256: revision.revisionSha256, mode: 'full', verdict: 'approved',
    reviewer: { attemptId, sessionId }, coverage: ['approved-product-intent', 'deterministic-executability', 'safety', 'scope', 'validation'],
    defects: [], affectedDefectIds: [], affectedContracts: [], closureRequestSha256: null,
    acceptedRisks: [], coverageInvalidated: false,
  };
}
