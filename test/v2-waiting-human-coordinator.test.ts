import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GitHubPermissionSafetyError,
  GitHubPermissionRetryableError,
  InMemoryGitHubIssueAdapter,
  type GitHubIssue,
  type GitHubIssueComment,
} from '../src/v2/adapters/issues.js';
import type { RoutedRunContext } from '../src/v2/route-continuations.js';
import type { WaitingHumanExecutionV1 } from '../src/v2/waiting-human.js';
import { createWaitingQuestion, hashNormalizedAnswer, renderWaitingQuestionBody } from '../src/v2/waiting-human.js';
import { WaitingHumanCoordinator, type WaitingHumanState } from '../src/v2/waiting-human-coordinator.js';

test('WaitingHumanCoordinator publishes one bound question then reconciles exact waiting labels', async () => {
  const issues = new InMemoryGitHubIssueAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const result = await coordinator.run(contextFixture(), state, new AbortController().signal);
  assert.equal(result.status, 'awaiting-answer');
  assert.equal(issues.postedComments.length, 1);
  assert.deepEqual(await issues.getLabels(12), ['agent:auto', 'agent:waiting-human']);
  assert.equal((await state.read())?.phase, 'awaiting-answer');

  assert.deepEqual(await coordinator.run(contextFixture(), state, new AbortController().signal), result);
  assert.equal(issues.postedComments.length, 1);
  assert.equal(issues.updatedIssues.length, 1);
});

test('WaitingHumanCoordinator recovers comment and label intents without duplicate effects', async () => {
  const issues = new InMemoryGitHubIssueAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const context = contextFixture();

  state.stopAfterCas = 'question-comment-intent';
  await assert.rejects(coordinator.run(context, state, new AbortController().signal), /injected crash/u);
  state.stopAfterCas = undefined;
  assert.equal((await coordinator.run(context, state, new AbortController().signal)).status, 'awaiting-answer');
  assert.equal(issues.postedComments.length, 1);

  const issuesAfterComment = new InMemoryGitHubIssueAdapter([issueFixture()]);
  const stateAfterComment = memoryState();
  const coordinatorAfterComment = coordinatorFixture(issuesAfterComment);
  stateAfterComment.stopAfterCas = 'wait-labels-intent';
  await assert.rejects(coordinatorAfterComment.run(context, stateAfterComment, new AbortController().signal), /injected crash/u);
  stateAfterComment.stopAfterCas = undefined;
  assert.equal((await coordinatorAfterComment.run(context, stateAfterComment, new AbortController().signal)).status, 'awaiting-answer');
  assert.equal(issuesAfterComment.postedComments.length, 1);
  assert.equal(issuesAfterComment.updatedIssues.length, 1);
});

test('WaitingHumanCoordinator safety-blocks duplicate marker observations', async () => {
  const context = contextFixture();
  const question = createWaitingQuestion({
    runId: context.runId, generation: 1, routeDecisionSha256: context.receipt.decisionSha256,
    workflowGenerationHash: context.workflowGeneration.generationHash, priorQuestionSha256: null, conflictHashes: [],
    recommendation: 'Choose A.', question: 'A or B?',
  });
  const issue = issueFixture();
  issue.comments = ['101', '102'].map((id) => ({
    id, url: `${issue.url}#issuecomment-${id}`, body: renderWaitingQuestionBody(question),
    createdAt: '2026-07-17T11:30:00.000Z', updatedAt: '2026-07-17T11:30:00.000Z',
    author: { login: 'runner', id: '1' }, authorAssociation: 'MEMBER',
  }));
  const result = await coordinatorFixture(new InMemoryGitHubIssueAdapter([issue])).run(
    context, memoryState(), new AbortController().signal,
  );
  assert.deepEqual(result, {
    status: 'blocked', kind: 'safety', resumable: false, code: 'question-comment-conflict', evidence: ['101', '102'],
  });
});

test('WaitingHumanCoordinator freezes one current WRITE+ answer and reaches resume-ready once', async () => {
  const issues = new InMemoryGitHubIssueAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const context = contextFixture();
  const waiting = await coordinator.run(context, state, new AbortController().signal);
  assert.equal(waiting.status, 'awaiting-answer');
  assert.equal((await state.read())?.phase, 'awaiting-answer');
  await issues.postComment(12, `Answer ${(waiting as Extract<typeof waiting, { status: 'awaiting-answer' }>).questionId}: Choose A`);

  const resumed = await coordinator.run(context, state, new AbortController().signal);
  assert.equal(resumed.status, 'resume-ready');
  assert.equal((resumed as Extract<typeof resumed, { status: 'resume-ready' }>).answer.normalizedAnswer, 'Choose A');
  assert.deepEqual(await issues.getLabels(12), ['agent:auto', 'agent:running']);
  const effects = issues.updatedIssues.length;
  assert.deepEqual(await coordinator.run(context, state, new AbortController().signal), resumed);
  assert.equal(issues.updatedIssues.length, effects);
});

test('WaitingHumanCoordinator rejects old, edited, missing-prefix, empty, and association-only answers', async () => {
  class AdversarialAnswerAdapter extends InMemoryGitHubIssueAdapter {
    public extraComments: GitHubIssueComment[] = [];

    override async listAllComments(issueNumber: number): Promise<GitHubIssueComment[]> {
      return [...await super.listAllComments(issueNumber), ...this.extraComments];
    }

    override async getRepositoryPermission(login: string, userId: string) {
      return {
        permission: login === 'association-only' ? 'read' as const : 'write' as const,
        checkedAt: '2026-07-17T12:00:02.000Z',
        userId,
      };
    }
  }

  const issues = new AdversarialAnswerAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const context = contextFixture();
  const waiting = await coordinator.run(context, state, new AbortController().signal) as Extract<
    Awaited<ReturnType<WaitingHumanCoordinator['run']>>,
    { status: 'awaiting-answer' }
  >;
  const receipt = (await state.read()) as Extract<WaitingHumanExecutionV1, { phase: 'awaiting-answer' }>;
  const beforeQuestion = new Date(Date.parse(receipt.questionReceipt.createdAt) - 1).toISOString();
  const afterQuestion = new Date(Date.parse(receipt.questionReceipt.createdAt) + 1).toISOString();
  const prefix = waiting.answerPrefix;
  issues.extraComments = [
    answerComment('200', `${prefix} Too old`, beforeQuestion),
    answerComment('201', `${prefix} Edited`, afterQuestion, { updatedAt: new Date(Date.parse(afterQuestion) + 1).toISOString() }),
    answerComment('202', 'Choose A', afterQuestion),
    answerComment('203', `${prefix}   `, afterQuestion),
    answerComment('204', `${prefix} Association is not authority`, afterQuestion, { login: 'association-only', association: 'OWNER' }),
    answerComment('205', `${prefix} Choose A`, afterQuestion, { login: 'maintainer' }),
  ];

  const resumed = await coordinator.run(context, state, new AbortController().signal);
  assert.equal(resumed.status, 'resume-ready');
  assert.equal((resumed as Extract<typeof resumed, { status: 'resume-ready' }>).answer.commentId, '205');
});

test('WaitingHumanCoordinator re-observes after post and safety-blocks a concurrent duplicate', async () => {
  class DuplicatePostAdapter extends InMemoryGitHubIssueAdapter {
    override async postComment(issueNumber: number, body: string): Promise<GitHubIssueComment> {
      await super.postComment(issueNumber, body);
      return super.postComment(issueNumber, body);
    }
  }
  const issues = new DuplicatePostAdapter([issueFixture()]);
  const result = await coordinatorFixture(issues).run(contextFixture(), memoryState(), new AbortController().signal);
  assert.equal(result.status, 'blocked');
  assert.equal((result as Extract<typeof result, { status: 'blocked' }>).code, 'question-comment-conflict');
  assert.equal(issues.updatedIssues.length, 0);
});

test('WaitingHumanCoordinator types observation failure as retryable and cancels manual ownership without label mutation', async () => {
  class FailingReadAdapter extends InMemoryGitHubIssueAdapter {
    override async listAllComments(): Promise<GitHubIssueComment[]> { throw new Error('transport'); }
  }
  const failed = await coordinatorFixture(new FailingReadAdapter([issueFixture()]))
    .run(contextFixture(), memoryState(), new AbortController().signal);
  assert.deepEqual(failed, { status: 'retryable', owner: 'github-effect', code: 'question-comment-observation-failed' });

  const manualIssue = issueFixture();
  manualIssue.labels.push({ name: 'agent:manual' });
  const manual = new InMemoryGitHubIssueAdapter([manualIssue]);
  assert.equal((await coordinatorFixture(manual).run(contextFixture(), memoryState(), new AbortController().signal)).status, 'cancelled');
  assert.equal(manual.updatedIssues.length, 0);
});

test('WaitingHumanCoordinator safety-blocks malformed permission responses', async () => {
  class InvalidPermissionAdapter extends InMemoryGitHubIssueAdapter {
    override async getRepositoryPermission(): Promise<never> { throw new GitHubPermissionSafetyError('malformed'); }
  }
  const issues = new InvalidPermissionAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const waiting = await coordinator.run(contextFixture(), state, new AbortController().signal) as Extract<Awaited<ReturnType<WaitingHumanCoordinator['run']>>, { status: 'awaiting-answer' }>;
  await issues.postComment(12, `Answer ${waiting.questionId}: Choose A`);
  assert.deepEqual(await coordinator.run(contextFixture(), state, new AbortController().signal), {
    status: 'blocked', kind: 'safety', resumable: false, code: 'permission-response-invalid', evidence: [],
  });
});

test('WaitingHumanCoordinator publishes exactly one generation-two conflict question', async () => {
  const issues = new InMemoryGitHubIssueAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const context = contextFixture();
  const waiting = await coordinator.run(context, state, new AbortController().signal) as Extract<Awaited<ReturnType<WaitingHumanCoordinator['run']>>, { status: 'awaiting-answer' }>;
  await issues.postComment(12, `Answer ${waiting.questionId}: Choose A`);
  await issues.postComment(12, `Answer ${waiting.questionId}: Choose B`);
  const clarified = await coordinator.run(context, state, new AbortController().signal);
  assert.equal(clarified.status, 'awaiting-answer');
  assert.notEqual((clarified as Extract<typeof clarified, { status: 'awaiting-answer' }>).questionId, waiting.questionId);
  assert.equal(issues.postedComments.filter((comment) => comment.body.includes('codex-orchestrator:waiting-question')).length, 2);
  assert.equal((await state.read())?.clarificationAttempts, 1);
});

test('a second approved awaiting-user route publishes the only generation-two product question', async () => {
  const issues = new InMemoryGitHubIssueAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const context = contextFixture();
  const waiting = await coordinator.run(context, state, new AbortController().signal) as Extract<
    Awaited<ReturnType<WaitingHumanCoordinator['run']>>,
    { status: 'awaiting-answer' }
  >;
  await issues.postComment(12, `Answer ${waiting.questionId}: Choose A`);
  await coordinator.run(context, state, new AbortController().signal);
  const ready = await state.read() as Extract<WaitingHumanExecutionV1, { phase: 'resume-ready' }>;
  const resumed: WaitingHumanExecutionV1 = {
    version: 1,
    clarificationAttempts: ready.clarificationAttempts,
    permissionRetries: ready.permissionRetries,
    effectRetries: structuredClone(ready.effectRetries),
    history: [{
      routeReceipt: structuredClone(context.receipt),
      question: structuredClone(ready.questionReceipt.question),
      questionReceipt: structuredClone(ready.questionReceipt),
      answerReceipt: structuredClone(ready.answerReceipt),
      conflictHashes: [],
    }],
    phase: 'resumed',
    trustedAnswer: structuredClone(ready.answerReceipt),
  };
  assert.equal(await state.compareAndSwap(ready, resumed), true);

  const second = await coordinator.run(context, state, new AbortController().signal);
  assert.equal(second.status, 'awaiting-answer');
  const generationTwo = await state.read() as Extract<WaitingHumanExecutionV1, { phase: 'awaiting-answer' }>;
  assert.equal(generationTwo.questionReceipt.question.generation, 2);
  assert.equal(generationTwo.questionReceipt.question.priorQuestionSha256, ready.questionReceipt.question.questionSha256);
  assert.equal(generationTwo.clarificationAttempts, 1);
});

test('final permission revalidation consumes the same durable one-retry budget', async () => {
  class FinalRetryAdapter extends InMemoryGitHubIssueAdapter {
    calls = 0;
    override async getRepositoryPermission(_login: string, userId: string) {
      this.calls += 1;
      if (this.calls >= 3) throw new GitHubPermissionRetryableError('temporary');
      return { permission: 'write' as const, checkedAt: '2026-07-17T12:00:02.000Z', userId };
    }
  }
  const issues = new FinalRetryAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const context = contextFixture();
  const waiting = await coordinator.run(context, state, new AbortController().signal) as Extract<
    Awaited<ReturnType<WaitingHumanCoordinator['run']>>,
    { status: 'awaiting-answer' }
  >;
  await issues.postComment(12, `Answer ${waiting.questionId}: Choose A`);
  assert.equal((await coordinator.run(context, state, new AbortController().signal)).status, 'retryable');
  assert.equal((await state.read())?.permissionRetries, 1);
  assert.deepEqual(await coordinator.run(context, state, new AbortController().signal), {
    status: 'blocked', kind: 'external', resumable: true, code: 'permission-retries-exhausted', evidence: [],
  });
});

test('revocation label reconciliation cancels conflicting ownership and bounds unknown delivery', async () => {
  class RevocationAdapter extends InMemoryGitHubIssueAdapter {
    override async getRepositoryPermission(_login: string, userId: string) {
      return { permission: 'none' as const, checkedAt: '2026-07-17T12:00:02.000Z', userId };
    }
  }
  const issue = issueFixture();
  issue.labels.push({ name: 'agent:review' });
  const conflicting = new RevocationAdapter([issue]);
  const state = memoryState(revocationState(contextFixture()));
  assert.equal((await coordinatorFixture(conflicting).run(contextFixture(), state, new AbortController().signal)).status, 'cancelled');
  assert.equal(conflicting.updatedIssues.length, 0);

  class UnknownRevocationAdapter extends RevocationAdapter {
    override async updateIssue(): Promise<never> { throw new Error('unknown delivery'); }
  }
  const unknown = new UnknownRevocationAdapter([issueFixture()]);
  const retryState = memoryState(revocationState(contextFixture()));
  assert.equal((await coordinatorFixture(unknown).run(contextFixture(), retryState, new AbortController().signal)).status, 'retryable');
  assert.equal((await retryState.read())?.effectRetries.revokeLabels, 1);
  assert.deepEqual(await coordinatorFixture(unknown).run(contextFixture(), retryState, new AbortController().signal), {
    status: 'blocked', kind: 'external', resumable: true, code: 'revoke-labels-exhausted', evidence: [],
  });
});

test('permission retry exhaustion is independent and performs no label or model work', async () => {
  class RetryPermissionAdapter extends InMemoryGitHubIssueAdapter {
    override async getRepositoryPermission(): Promise<never> { throw new GitHubPermissionRetryableError('temporary'); }
  }
  const issues = new RetryPermissionAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const context = contextFixture();
  const waiting = await coordinator.run(context, state, new AbortController().signal) as Extract<Awaited<ReturnType<WaitingHumanCoordinator['run']>>, { status: 'awaiting-answer' }>;
  await issues.postComment(12, `Answer ${waiting.questionId}: Choose A`);
  assert.equal((await coordinator.run(context, state, new AbortController().signal)).status, 'retryable');
  const afterRetry = await state.read();
  assert.equal(afterRetry?.permissionRetries, 1);
  assert.deepEqual(afterRetry?.effectRetries, { questionComment: 0, waitLabels: 0, resumeLabels: 0, revokeLabels: 0 });
  assert.equal(afterRetry?.clarificationAttempts, 0);
  const exhausted = await coordinator.run(context, state, new AbortController().signal);
  assert.deepEqual(exhausted, {
    status: 'blocked', kind: 'external', resumable: true, code: 'permission-retries-exhausted', evidence: [],
  });
  assert.equal(issues.updatedIssues.length, 1);
});

test('permission revocation after resume labels reconciles to auto plus blocked without resurrection', async () => {
  class RevokedPermissionAdapter extends InMemoryGitHubIssueAdapter {
    calls = 0;
    override async getRepositoryPermission(_login: string, userId: string) {
      this.calls += 1;
      return {
        permission: this.calls < 3 ? 'admin' as const : 'none' as const,
        checkedAt: new Date().toISOString(), userId,
      };
    }
  }
  const issues = new RevokedPermissionAdapter([issueFixture()]);
  const state = memoryState();
  const coordinator = coordinatorFixture(issues);
  const context = contextFixture();
  const waiting = await coordinator.run(context, state, new AbortController().signal) as Extract<Awaited<ReturnType<WaitingHumanCoordinator['run']>>, { status: 'awaiting-answer' }>;
  await issues.postComment(12, `Answer ${waiting.questionId}: Choose A`);
  const blocked = await coordinator.run(context, state, new AbortController().signal);
  assert.equal(blocked.status, 'blocked');
  assert.equal((blocked as Extract<typeof blocked, { status: 'blocked' }>).code, 'answer-permission-revoked');
  assert.deepEqual(await issues.getLabels(12), ['agent:auto', 'agent:blocked']);
  assert.equal((await state.read())?.phase, 'revoke-labels-intent');
});

function coordinatorFixture(issues: InMemoryGitHubIssueAdapter): WaitingHumanCoordinator {
  return new WaitingHumanCoordinator({
    issues,
    labels: {
      auto: 'agent:auto', running: 'agent:running', blocked: 'agent:blocked', review: 'agent:review', waitingHuman: 'agent:waiting-human',
    },
    now: () => '2026-07-17T12:00:00.000Z',
  });
}

function memoryState(initial?: WaitingHumanExecutionV1): WaitingHumanState & { stopAfterCas?: WaitingHumanExecutionV1['phase'] } {
  let current: WaitingHumanExecutionV1 | undefined = structuredClone(initial);
  const state: WaitingHumanState & { stopAfterCas?: WaitingHumanExecutionV1['phase'] } = {
    read: async () => structuredClone(current),
    compareAndSwap: async (expected, next) => {
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      current = structuredClone(next);
      if (state.stopAfterCas === next.phase) throw new Error('injected crash');
      return true;
    },
  };
  return state;
}

function revocationState(context: RoutedRunContext): Extract<WaitingHumanExecutionV1, { phase: 'revoke-labels-intent' }> {
  const question = createWaitingQuestion({
    runId: context.runId, generation: 1, routeDecisionSha256: context.receipt.decisionSha256,
    workflowGenerationHash: context.workflowGeneration.generationHash, priorQuestionSha256: null, conflictHashes: [],
    recommendation: 'Choose A.', question: 'A or B?',
  });
  const answer = {
    version: 1 as const, questionId: question.questionId, questionSha256: question.questionSha256,
    commentId: '102', commentUrl: 'https://example.invalid/comments/102', authorId: '2', author: 'maintainer',
    permission: 'write' as const, permissionCheckedAt: '2026-07-17T12:00:02.000Z',
    commentCreatedAt: '2026-07-17T12:00:01.000Z', commentUpdatedAt: '2026-07-17T12:00:01.000Z',
    observedAt: '2026-07-17T12:00:01.000Z', normalizedAnswer: 'Choose A',
    normalizedSha256: hashNormalizedAnswer('Choose A'), duplicateCommentIds: [],
  };
  return {
    version: 1, clarificationAttempts: 0, permissionRetries: 0,
    effectRetries: { questionComment: 0, waitLabels: 0, resumeLabels: 0, revokeLabels: 0 }, history: [],
    phase: 'revoke-labels-intent',
    questionReceipt: { question, commentId: '101', commentUrl: 'https://example.invalid/comments/101', authorId: '1', author: 'runner', createdAt: '2026-07-17T12:00:00.000Z', observedAt: '2026-07-17T12:00:00.000Z' },
    answerReceipt: answer,
    reason: 'permission-revoked',
  };
}

function issueFixture(): GitHubIssue {
  return {
    number: 12, title: 'Need product choice', body: 'Choose behavior.', url: 'https://github.com/owner/repo/issues/12', state: 'OPEN',
    labels: [{ name: 'agent:auto' }, { name: 'agent:running' }], comments: [], closedByPullRequestsReferences: [],
  };
}

function answerComment(
  id: string,
  body: string,
  createdAt: string,
  overrides: { updatedAt?: string; login?: string; association?: string } = {},
): GitHubIssueComment {
  return {
    id,
    url: `https://github.com/owner/repo/issues/12#issuecomment-${id}`,
    body,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    author: { login: overrides.login ?? 'maintainer', id },
    authorAssociation: overrides.association ?? 'NONE',
  };
}

function contextFixture(): RoutedRunContext {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    issue: { number: 12, title: 'Need product choice', body: 'Choose behavior.', url: 'https://github.com/owner/repo/issues/12', state: 'OPEN', labels: ['agent:auto', 'agent:running'] },
    frozenCriteria: [{ id: 'criterion-1', order: 1, text: 'Honor the product choice.', source: 'explicit' }],
    worktreePath: '/tmp/worktree',
    workflowGeneration: { generationHash: 'b'.repeat(64), manifestSha256: 'c'.repeat(64), packageVersion: '2.0.1', generationRoot: '/tmp/generation', contentSha256: 'd'.repeat(64) },
    receipt: {
      version: 1, route: 'awaiting-user',
      triage: { operation: 'triage', attemptId: 'triage-1', artifactSha256: 'e'.repeat(64), generationHash: 'b'.repeat(64) },
      review: { operation: 'ambiguity-review', attemptId: 'review-1', candidateSha256: 'e'.repeat(64), artifactSha256: 'f'.repeat(64), verdict: 'approved', generationHash: 'b'.repeat(64) },
      artifact: {
        version: 1, status: 'awaiting-user',
        inspectedEvidence: [{ kind: 'issue', location: '#12', summary: 'Read issue.' }], assumptions: [],
        direct: null, specRequired: null, blocker: null,
        awaitingUser: {
          outcomes: [
            { id: 'a', title: 'A', behaviorDelta: 'Use A', evidence: ['issue'] },
            { id: 'b', title: 'B', behaviorDelta: 'Use B', evidence: ['issue'] },
          ],
          absenceOfAuthorizedChoiceEvidence: ['No answer in issue.'], recommendation: 'Choose A.', question: 'A or B?',
        },
      },
      decisionSha256: 'a'.repeat(64), decidedAt: '2026-07-17T11:00:00.000Z', assumptions: [],
    },
  };
}
