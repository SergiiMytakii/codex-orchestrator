import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryGitHubIssueAdapter } from '../src/v2/adapters/issues.js';
import { GhCliPullRequestAdapter } from '../src/v2/adapters/gh-pull-request-adapter.js';
import type { CommandExecutor } from '../src/v2/adapters/gh-cli.js';
import { InMemoryGitHubPullRequestAdapter, type GitHubPullRequestReviewTarget } from '../src/v2/adapters/pull-requests.js';
import { ReviewFeedbackObserver } from '../src/v2/review-feedback-coordinator.js';

test('freezes the first trusted issue comment after the terminal cutoff and revalidates immutable source trust', async () => {
  const pullRequests = pullRequestFixture();
  const comments = [
    issueComment('100', 'writer', '42', 'before cutoff', '2026-07-27T09:59:00.000Z'),
    issueComment('101', 'writer', '42', '   ', '2026-07-27T10:01:00.000Z'),
    issueComment('102', 'reader', '43', 'untrusted', '2026-07-27T10:02:00.000Z'),
    issueComment('103', 'dependabot[bot]', '44', 'bot request', '2026-07-27T10:03:00.000Z'),
    issueComment('104', 'codex-orchestrator', '45', 'orchestrator output', '2026-07-27T10:04:00.000Z'),
    issueComment('105', 'writer', '42', 'Please explain the current behavior.', '2026-07-27T10:05:00.000Z'),
    issueComment('106', 'admin', '46', 'Later request', '2026-07-27T10:06:00.000Z'),
  ];
  const issues = new PermissionFixture({ '42': 'write', '43': 'read', '44': 'write', '45': 'admin', '46': 'admin' }, comments);
  const service = coordinator(pullRequests, issues);
  const result = await service.observeAndFreeze({
    ...observationInput(),
    issueCommentCutoff: { issueNumber: 42, commentId: '100', observedAt: '2026-07-27T10:00:00.000Z' },
  });

  assert.equal(result.status, 'frozen');
  if (result.status !== 'frozen') return;
  assert.deepEqual(result.batch.sources.map((source) => source.sourceId), ['issue-comment:105']);
  assert.equal(result.batch.sources[0]!.kind, 'issue-comment');
  assert.equal(result.batch.sources[0]!.body, 'Please explain the current behavior.');
  assert.deepEqual(issues.checked, ['43', '42']);
  assert.equal((await service.revalidate({ batch: result.batch, issueNumber: 42, epoch: 'pre-update', expectedHeadSha: 'a'.repeat(40) })).status, 'valid');

  issues.comments = comments.map((comment) => comment.id === '105' ? { ...comment, body: 'edited' } : comment);
  assert.equal((await service.revalidate({ batch: result.batch, issueNumber: 42, epoch: 'pre-update', expectedHeadSha: 'a'.repeat(40) })).status, 'blocked');
});

test('excludes package-owned marker comments from observation and revalidation even for a trusted human login', async () => {
  const pullRequests = pullRequestFixture();
  const marker = '<!-- codex-orchestrator:run:00000000-0000-4000-8000-000000000001:cycle:1:handoff -->';
  const comments = [
    issueComment('101', 'writer', '42', `${marker}\npackage response`, '2026-07-27T10:01:00.000Z'),
    issueComment('102', 'writer', '42', 'Human follow-up', '2026-07-27T10:02:00.000Z'),
  ];
  const issues = new PermissionFixture({ '42': 'write' }, comments);
  const service = coordinator(pullRequests, issues);
  const result = await service.observeAndFreeze({
    ...observationInput(),
    issueCommentCutoff: { issueNumber: 42, commentId: '100', observedAt: '2026-07-27T10:00:00.000Z' },
  });

  assert.equal(result.status, 'frozen');
  if (result.status !== 'frozen') return;
  assert.deepEqual(result.batch.sources.map((source) => source.sourceId), ['issue-comment:102']);

  issues.comments = comments.map((comment) => comment.id === '102'
    ? { ...comment, body: `${marker}\npackage response under a human identity` }
    : comment);
  assert.equal((await service.revalidate({
    batch: result.batch, issueNumber: 42, epoch: 'pre-update', expectedHeadSha: 'a'.repeat(40),
  })).status, 'blocked');
});

test('rejects a comment known to predate observedAt even when its numeric ID exceeds a stale cutoff', async () => {
  const comments = [
    issueComment('900', 'writer', '42', 'Predates frozen boundary', '2026-07-27T09:59:59.000Z'),
  ];
  const result = await coordinator(pullRequestFixture(), new PermissionFixture({ '42': 'write' }, comments))
    .observeAndFreeze({
      ...observationInput(),
      issueCommentCutoff: { issueNumber: 42, commentId: '100', observedAt: '2026-07-27T10:00:00.000Z' },
    });

  assert.equal(result.status, 'none');
});

test('falls back to trusted PR feedback when after-cutoff issue comments fail trust validation', async () => {
  const pullRequests = pullRequestFixture();
  pullRequests.reviewThreads.set(17, [
    thread('T_good', 'writer', '42', 'Trusted PR request', false, false, 'a'.repeat(40)),
  ]);
  const comments = [issueComment('101', 'reader', '43', 'Untrusted issue request', '2026-07-27T10:01:00.000Z')];
  const result = await coordinator(pullRequests, new PermissionFixture({ '42': 'write', '43': 'read' }, comments))
    .observeAndFreeze({
      ...observationInput(),
      issueCommentCutoff: { issueNumber: 42, commentId: '100', observedAt: '2026-07-27T10:00:00.000Z' },
    });

  assert.equal(result.status, 'frozen');
  if (result.status !== 'frozen') return;
  assert.deepEqual(result.batch.sources.map((source) => source.sourceId), ['pr-thread:T_good']);
});

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

test('defers torn observations to a later tick and ignores ineligible old feedback', async () => {
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
  assert.equal(torn.status, 'retryable');
  if (torn.status === 'retryable') assert.match(torn.reason, /torn/u);
  assert.equal(reads, 2);
});

test('one incomplete GraphQL page defers without an internal retry and succeeds on the next tick', async () => {
  const pullRequests = pullRequestFixture();
  let reads = 0;
  const original = pullRequests.listReviewThreads.bind(pullRequests);
  pullRequests.listReviewThreads = async (number) => {
    reads += 1;
    if (reads === 1) throw new Error('temporary GraphQL pagination failure');
    return original(number);
  };
  const service = coordinator(pullRequests, new PermissionFixture({ '42': 'write' }));

  assert.equal((await service.observeAndFreeze(observationInput())).status, 'retryable');
  assert.equal(reads, 1);
  assert.equal((await service.observeAndFreeze(observationInput())).status, 'none');
  assert.equal(reads, 2);
});

for (const paginationFailure of ['omitted-end-cursor', 'page-bound'] as const) {
  test(`real GraphQL ${paginationFailure} pagination uncertainty remains retryable`, async () => {
    let threadPages = 0;
    const executor: CommandExecutor = async (_file, args) => {
      const query = args.find((argument) => argument.startsWith('query=')) ?? '';
      if (query.includes('ReviewThreads')) {
        threadPages += 1;
        return jsonResult({ data: { repository: { pullRequest: { reviewThreads: {
          nodes: [], pageInfo: {
            hasNextPage: true,
            endCursor: paginationFailure === 'omitted-end-cursor' ? null : `cursor-${threadPages}`,
          },
        } } } } });
      }
      if (args.some((argument) => argument.endsWith('/reviews'))) return { stdout: '', stderr: '' };
      return jsonResult(reviewTargetGraphQl());
    };
    const service = new ReviewFeedbackObserver({
      pullRequests: new GhCliPullRequestAdapter('owner', 'repo', executor),
      issues: new PermissionFixture({}),
    });

    const result = await service.observeAndFreeze(observationInput());

    assert.equal(result.status, 'retryable');
    if (result.status === 'retryable') assert.match(result.reason, /pagination/u);
    assert.equal(threadPages, paginationFailure === 'omitted-end-cursor' ? 1 : 20);
  });
}

test('non-authoritative target metadata drift does not tear an otherwise stable authority observation', async () => {
  const pullRequests = pullRequestFixture();
  let reads = 0;
  let threadReads = 0;
  let reviewReads = 0;
  const original = pullRequests.getReviewTarget.bind(pullRequests);
  const originalThreads = pullRequests.listReviewThreads.bind(pullRequests);
  const originalReviews = pullRequests.listSubmittedReviews.bind(pullRequests);
  pullRequests.getReviewTarget = async (number) => {
    const value = await original(number);
    reads += 1;
    return value ? { ...value, title: reads === 1 ? 'old title' : 'new title' } : undefined;
  };
  pullRequests.listReviewThreads = async (number) => { threadReads += 1; return originalThreads(number); };
  pullRequests.listSubmittedReviews = async (number) => { reviewReads += 1; return originalReviews(number); };

  assert.equal((await coordinator(pullRequests, new PermissionFixture({ '42': 'write' }))
    .observeAndFreeze(observationInput())).status, 'none');
  assert.deepEqual({ targetReads: reads, threadReads, reviewReads }, { targetReads: 2, threadReads: 1, reviewReads: 1 });
});

for (const heads of [
  { rest: 'a'.repeat(40), graphQl: 'b'.repeat(40) },
  { rest: 'b'.repeat(40), graphQl: 'a'.repeat(40) },
]) {
  test(`independent REST ${heads.rest[0]} and GraphQL ${heads.graphQl[0]} heads are retryable disagreement`, async () => {
    const executor = productionObservationExecutor(heads.rest, heads.graphQl);
    const pullRequests = new GhCliPullRequestAdapter('owner', 'repo', executor);
    const [rest] = await pullRequests.listAllByHeadBranch('codex/issue-42');
    assert.ok(rest?.headSha);
    const input = { ...observationInput(), expectedHeadSha: rest.headSha, restPullRequest: {
      number: rest.number, nodeId: rest.nodeId, headSha: rest.headSha, body: rest.body,
    } } as Parameters<ReviewFeedbackObserver['observeAndFreeze']>[0];

    const result = await new ReviewFeedbackObserver({ pullRequests, issues: new PermissionFixture({}) })
      .observeAndFreeze(input);

    assert.equal(result.status, 'retryable');
    if (result.status === 'retryable') assert.match(result.reason, /REST.*GraphQL|disagree/iu);
  });
}

test('authority drift during permission observation defers the whole trusted batch', async () => {
  const pullRequests = pullRequestFixture();
  pullRequests.reviewThreads.set(17, [thread('T_good', 'writer', '42', 'Root body', false, false, 'a'.repeat(40))]);
  const issues = new PermissionFixture({ '42': 'write' });
  const readPermission = issues.getRepositoryPermission.bind(issues);
  issues.getRepositoryPermission = async (login, userId) => {
    const permission = await readPermission(login, userId);
    pullRequests.reviewTargets.set(17, target('b'.repeat(40)));
    return permission;
  };

  const result = await coordinator(pullRequests, issues).observeAndFreeze(observationInput());

  assert.equal(result.status, 'retryable');
  if (result.status === 'retryable') assert.match(result.reason, /torn/u);
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
  assert.equal((await service.revalidate({ batch: observed.batch, issueNumber: 42, epoch: 'post-push', expectedHeadSha: 'c'.repeat(40) })).status, 'valid');

  pullRequests.reviewThreads.set(17, [thread('T_good', 'writer', '42', 'edited', true, true, 'a'.repeat(40))]);
  assert.equal((await service.revalidate({ batch: observed.batch, issueNumber: 42, epoch: 'post-push', expectedHeadSha: 'c'.repeat(40) })).status, 'blocked');

  pullRequests.reviewThreads.set(17, [thread('T_good', 'writer', '42', 'Root body', true, true, 'a'.repeat(40))]);
  permissions.permissions['42'] = 'read';
  assert.equal((await service.revalidate({ batch: observed.batch, issueNumber: 42, epoch: 'post-push', expectedHeadSha: 'c'.repeat(40) })).status, 'blocked');
});

function coordinator(pullRequests: InMemoryGitHubPullRequestAdapter, issues: PermissionFixture): ReviewFeedbackObserver {
  return new ReviewFeedbackObserver({
    pullRequests, issues, now: () => '2026-07-27T10:05:00.000Z',
  });
}

function observationInput() {
  const marker = '<!-- codex-orchestrator:run:00000000-0000-4000-8000-000000000001 -->';
  return {
    runId: '00000000-0000-4000-8000-000000000001', canonicalRepository: 'owner/repo', pullRequestNumber: 17,
    expectedHeadSha: 'a'.repeat(40), expectedHeadRefName: 'codex/issue-42', expectedBaseRefName: 'main',
    marker, consumedSourceIds: [],
    restPullRequest: { number: 17, nodeId: 'PR_1', headSha: 'a'.repeat(40), body: marker },
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
  public constructor(
    public permissions: Record<string, 'none' | 'read' | 'write' | 'admin'>,
    public comments: Awaited<ReturnType<InMemoryGitHubIssueAdapter['listAllComments']>> = [],
  ) { super(); }
  public override async listAllComments() { return structuredClone(this.comments); }
  public override async getIssue(number: number) {
    return {
      number, title: 'Issue', body: 'Body', url: `https://github.com/owner/repo/issues/${number}`,
      state: 'OPEN' as const, labels: [], comments: structuredClone(this.comments), closedByPullRequestsReferences: [],
    };
  }
  public override async getRepositoryPermission(_login: string, userId: string) {
    this.checked.push(userId);
    return { permission: this.permissions[userId] ?? 'none', userId, checkedAt: '2026-07-27T10:04:00.000Z' } as const;
  }
}

function issueComment(id: string, login: string, userId: string, body: string, createdAt: string) {
  return {
    id, url: `https://github.com/owner/repo/issues/42#issuecomment-${id}`, body, createdAt, updatedAt: createdAt,
    author: { login, id: userId }, authorAssociation: 'MEMBER',
  };
}

function jsonResult(value: unknown): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(value), stderr: '' };
}

function reviewTargetGraphQl(headSha = 'a'.repeat(40)) {
  return { data: { repository: {
    id: 'REPO_1', name: 'repo', owner: { id: 'OWNER_1', login: 'owner' },
    pullRequest: {
      id: 'PR_1', databaseId: 17, number: 17, url: 'https://github.com/owner/repo/pull/17',
      state: 'OPEN', isDraft: true, isCrossRepository: false, headRefName: 'codex/issue-42',
      headRefOid: headSha, baseRefName: 'main', title: 'Change', body: observationInput().marker,
      authorAssociation: 'MEMBER',
    },
  } } };
}

function productionObservationExecutor(restHead: string, graphQlHead: string): CommandExecutor {
  return async (_file, args) => {
    const query = args.find((argument) => argument.startsWith('query=')) ?? '';
    if (args.includes('--paginate')) return jsonResult([[restPullRequestPayload(restHead)]]);
    if (query.includes('ReviewThreads')) return jsonResult({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
    } } } } });
    if (args.some((argument) => argument.endsWith('/reviews'))) return { stdout: '', stderr: '' };
    return jsonResult(reviewTargetGraphQl(graphQlHead));
  };
}

function restPullRequestPayload(headSha: string) {
  return {
    number: 17, node_id: 'PR_1', html_url: 'https://github.com/owner/repo/pull/17',
    state: 'open', merged_at: null, draft: true, title: 'Change', body: observationInput().marker,
    author_association: 'MEMBER', head: { ref: 'codex/issue-42', sha: headSha }, base: { ref: 'main' },
  };
}
