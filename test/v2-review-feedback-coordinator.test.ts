import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryGitHubIssueAdapter } from '../src/v2/adapters/issues.js';
import { InMemoryGitHubPullRequestAdapter, type GitHubPullRequestReviewTarget } from '../src/v2/adapters/pull-requests.js';
import { ReviewFeedbackObserver } from '../src/v2/review-feedback-coordinator.js';

test('freezes only authorized eligible review sources', async () => {
  const pullRequests = pullRequestFixture();
  pullRequests.reviewThreads.set(17, [
    thread('T_good', 'writer', '42', 'Root body', false, false, 'a'.repeat(40), [comment('C_reply', 'reader', '43', 'untrusted reply', null)]),
    thread('T_resolved', 'writer', '42', 'resolved', true, false, 'a'.repeat(40)),
    thread('T_other_head', 'writer', '42', 'old', false, false, 'b'.repeat(40)),
    thread('T_reader', 'reader', '43', 'weak', false, false, 'a'.repeat(40)),
  ]);
  pullRequests.submittedReviews.set(17, [
    review('R_good', 'writer', '42', 'Review body', 'CHANGES_REQUESTED', 'a'.repeat(40)),
    review('R_approved', 'writer', '42', 'looks good', 'APPROVED', 'a'.repeat(40)),
    review('R_blank', 'writer', '42', '   ', 'CHANGES_REQUESTED', 'a'.repeat(40)),
  ]);
  const issues = new PermissionFixture({ '42': 'write', '43': 'read' });
  const result = await coordinator(pullRequests, issues).observeAndFreeze(observationInput());

  assert.equal(result.status, 'frozen');
  if (result.status !== 'frozen') return;
  assert.deepEqual(result.batch.sources.map((source) => source.sourceId), ['pr-review:R_good', 'pr-thread:T_good']);
  assert.deepEqual(result.batch.sources.map((source) => source.body), ['Review body', 'Root body']);
  assert.equal(JSON.stringify(result.batch).includes('untrusted reply'), false);
  assert.deepEqual(issues.checked, ['42', '42', '43']);
});

test('rejects torn observations outdated threads and other-head reviews', async () => {
  const pullRequests = pullRequestFixture();
  pullRequests.reviewThreads.set(17, [thread('T_old', 'writer', '42', 'old', false, true, 'a'.repeat(40))]);
  pullRequests.submittedReviews.set(17, [review('R_old', 'writer', '42', 'old review', 'CHANGES_REQUESTED', 'b'.repeat(40))]);
  const stable = await coordinator(pullRequests, new PermissionFixture({ '42': 'write' }))
    .observeAndFreeze(observationInput());
  assert.equal(stable.status, 'none');

  let reads = 0;
  const original = pullRequests.getReviewTarget.bind(pullRequests);
  pullRequests.getReviewTarget = async (number) => {
    const value = await original(number);
    reads += 1;
    return value ? { ...value, headRefOid: reads % 2 === 0 ? 'b'.repeat(40) : 'a'.repeat(40) } : undefined;
  };
  const torn = await coordinator(pullRequests, new PermissionFixture({ '42': 'write' }))
    .observeAndFreeze(observationInput());
  assert.equal(torn.status, 'blocked');
  if (torn.status === 'blocked') assert.match(torn.reason, /torn/u);
  assert.equal(reads, 4);
});

test('revalidation rejects edited or revoked sources and post-push permits only derived thread state drift', async () => {
  const pullRequests = pullRequestFixture();
  pullRequests.reviewThreads.set(17, [thread('T_good', 'writer', '42', 'Root body', false, false, 'a'.repeat(40))]);
  const permissions = new PermissionFixture({ '42': 'write' });
  const service = coordinator(pullRequests, permissions);
  const observed = await service.observeAndFreeze(observationInput());
  assert.equal(observed.status, 'frozen');
  if (observed.status !== 'frozen') return;

  pullRequests.reviewThreads.set(17, [thread('T_good', 'writer', '42', 'Root body', true, true, 'a'.repeat(40))]);
  pullRequests.reviewTargets.set(17, target('c'.repeat(40)));
  assert.equal((await service.revalidate({ batch: observed.batch, epoch: 'post-push', expectedHeadSha: 'c'.repeat(40) })).status, 'valid');

  pullRequests.reviewThreads.set(17, [thread('T_good', 'writer', '42', 'edited', true, true, 'a'.repeat(40))]);
  assert.equal((await service.revalidate({ batch: observed.batch, epoch: 'post-push', expectedHeadSha: 'c'.repeat(40) })).status, 'blocked');

  pullRequests.reviewThreads.set(17, [thread('T_good', 'writer', '42', 'Root body', true, true, 'a'.repeat(40))]);
  permissions.permissions['42'] = 'read';
  assert.equal((await service.revalidate({ batch: observed.batch, epoch: 'post-push', expectedHeadSha: 'c'.repeat(40) })).status, 'blocked');
});

function coordinator(pullRequests: InMemoryGitHubPullRequestAdapter, issues: PermissionFixture): ReviewFeedbackObserver {
  return new ReviewFeedbackObserver({
    pullRequests, issues, now: () => '2026-07-27T10:05:00.000Z',
  });
}

function observationInput() {
  return {
    runId: '00000000-0000-4000-8000-000000000001', canonicalRepository: 'owner/repo', pullRequestNumber: 17,
    expectedHeadSha: 'a'.repeat(40), expectedHeadRefName: 'codex/issue-42', expectedBaseRefName: 'main',
    marker: '<!-- codex-orchestrator:run:00000000-0000-4000-8000-000000000001 -->', consumedSourceIds: [],
  };
}

function pullRequestFixture(): InMemoryGitHubPullRequestAdapter {
  const adapter = new InMemoryGitHubPullRequestAdapter('owner', 'repo');
  adapter.reviewTargets.set(17, target('a'.repeat(40)));
  return adapter;
}

function target(headSha: string): GitHubPullRequestReviewTarget {
  return {
    repository: { nodeId: 'REPO_1', name: 'repo', owner: { nodeId: 'OWNER_1', login: 'owner' } },
    number: 17, nodeId: 'PR_1', url: 'https://github.com/owner/repo/pull/17', state: 'OPEN', isDraft: true,
    isCrossRepository: false, headRefName: 'codex/issue-42', headRefOid: headSha, baseRefName: 'main',
    title: 'Change', body: '<!-- codex-orchestrator:run:00000000-0000-4000-8000-000000000001 -->', authorAssociation: 'MEMBER',
  };
}

function thread(id: string, login: string, userId: string, body: string, resolved: boolean, outdated: boolean, commitId: string, replies: ReturnType<typeof comment>[] = []) {
  return {
    nodeId: id, isResolved: resolved, isOutdated: outdated, path: 'src/a.ts', line: 10,
    comments: [comment(`C_${id}`, login, userId, body, commitId), ...replies],
  };
}

function comment(id: string, login: string, userId: string, body: string, commitId: string | null) {
  return {
    nodeId: id, databaseId: id, url: `https://example.invalid/${id}`, body,
    createdAt: '2026-07-27T10:00:00.000Z', updatedAt: '2026-07-27T10:00:00.000Z', commitId,
    author: { nodeId: `U_${userId}`, id: userId, login, isBot: false },
  };
}

function review(id: string, login: string, userId: string, body: string, state: 'CHANGES_REQUESTED' | 'APPROVED', commitId: string) {
  return {
    nodeId: id, databaseId: id, url: `https://example.invalid/${id}`, body, state, commitId,
    submittedAt: '2026-07-27T10:00:00.000Z', author: { id: userId, login, isBot: false },
  };
}

class PermissionFixture extends InMemoryGitHubIssueAdapter {
  public checked: string[] = [];
  public constructor(public permissions: Record<string, 'none' | 'read' | 'write' | 'admin'>) { super(); }
  public override async getRepositoryPermission(_login: string, userId: string) {
    this.checked.push(userId);
    return { permission: this.permissions[userId] ?? 'none', userId, checkedAt: '2026-07-27T10:04:00.000Z' } as const;
  }
}
