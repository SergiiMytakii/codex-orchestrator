import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../src/v2/containment.js';

import {
  acceptSpecReview,
  acceptSpecRevision,
  consumeSpecReportRepair,
  consumeSpecTransportRetry,
  createInitialSpecDelivery,
  createSpecRevision,
  freezeSpecQuestion,
  acceptTrustedSpecAnswer,
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
  assert.equal(reviewReady.stage, 'review');
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

test('product decision remains inside spec state and resumes at the next immutable revision', () => {
  const initial = createInitialSpecDelivery({ issueNumber: 1, runId: 'run-1', workflowGenerationSha256: workflowHash });
  const revision = createSpecRevision({
    revision: 1, path: 'docs/spec.md', content: '# Partial spec\n', previousRevision: null,
    evidence: [{ path: 'issue:1', sha256: 'c'.repeat(64), description: 'intent' }],
    author: { attemptId: 'author-attempt', sessionId: 'author-session' },
  });
  const waiting = freezeSpecQuestion(initial, revision, [{ id: 'pricing', summary: 'Choose pricing behavior.', evidence: ['issue:1'] }], 'Which pricing behavior?');
  assert.equal(waiting.stage, 'question');
  assert.equal(waiting.question?.revisionSha256, revision.revisionSha256);
  assert.match(waiting.question?.answerPrefix ?? '', /^Answer q-/u);
  const published = validateSpecDelivery({
    ...waiting,
    questionResult: { questionSha256: waiting.question!.questionSha256, evidenceId: 'evidence-1', evidencePath: '/evidence/1.json' },
  });
  const answering = acceptTrustedSpecAnswer(published, {
    accepted: true, question: waiting.question!, frozenResult: { evidenceId: 'evidence-1', evidencePath: '/evidence/1.json' },
    canonicalSource: {
      commentId: '1', authorId: '2', author: 'owner', normalizedAnswer: 'Use fixed pricing',
      normalizedSha256: sha256('Use fixed pricing'), permission: { permission: 'write', userId: '2', checkedAt: '2026-07-30T00:00:00.000Z' },
      commentCreatedAt: '2026-07-30T00:00:00.000Z', commentUpdatedAt: '2026-07-30T00:00:00.000Z',
    },
    duplicateCommentIds: [], additionalSources: [],
  });
  assert.equal(answering.stage, 'answer-authoring');
  const nonCanonical = structuredClone(answering);
  nonCanonical.trustedAnswer!.additionalSources = [{
    ...structuredClone(nonCanonical.trustedAnswer!.canonicalSource), commentId: '0', authorId: '3', author: 'other',
    permission: { permission: 'write', userId: '3', checkedAt: '2026-07-30T00:00:00.000Z' },
  }];
  nonCanonical.trustedAnswer!.duplicateCommentIds = ['0'];
  assert.throws(() => validateSpecDelivery(nonCanonical), /canonical/u);
  const nextRevision = createSpecRevision({
    revision: 2, path: 'docs/spec-2.md', content: '# Complete spec\n', previousRevision: revision,
    evidence: revision.evidence, author: { attemptId: 'author-attempt-2', sessionId: 'author-session' },
  });
  const resumed = acceptSpecRevision(answering, nextRevision);
  assert.equal(resumed.stage, 'review');
  const foreignInitial = createInitialSpecDelivery({ issueNumber: 2, runId: 'run-2', workflowGenerationSha256: workflowHash });
  const foreignRevision = createSpecRevision({
    revision: 1, path: 'docs/foreign.md', content: '# Foreign\n', previousRevision: null,
    evidence: [{ path: 'issue:2', sha256: 'f'.repeat(64), description: 'foreign' }],
    author: { attemptId: 'foreign-attempt', sessionId: 'foreign-session' },
  });
  const foreignQuestion = freezeSpecQuestion(foreignInitial, foreignRevision, [{ id: 'foreign', summary: 'Foreign.', evidence: ['issue:2'] }], 'Foreign?').question!;
  const forged = structuredClone(resumed);
  forged.acceptedAnswers[0]!.question = foreignQuestion;
  assert.throws(() => validateSpecDelivery(forged), /not persisted/u);
  const outOfOrder = structuredClone(resumed);
  const repeatedRevision = structuredClone(outOfOrder.acceptedAnswers[0]!);
  repeatedRevision.canonicalSource.commentId = '9';
  repeatedRevision.canonicalSource.authorId = '9';
  repeatedRevision.canonicalSource.author = 'later';
  repeatedRevision.canonicalSource.permission.userId = '9';
  outOfOrder.acceptedAnswers.push(repeatedRevision);
  assert.throws(() => validateSpecDelivery(outOfOrder), /revision order/u);
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
  async revalidateBeforeAttempt() { return { status: 'valid' as const }; }
}

function reviewReport(revision: ReturnType<typeof createSpecRevision>, sessionId: string, attemptId = 'review-attempt'): SpecReviewReportV1 {
  return {
    version: 1, targetRevision: revision.revision, targetSha256: revision.revisionSha256, verdict: 'approved',
    reviewer: { attemptId, sessionId }, coverage: ['approved-product-intent', 'deterministic-executability', 'safety', 'scope', 'validation'],
    defects: [], acceptedRisks: [],
  };
}
