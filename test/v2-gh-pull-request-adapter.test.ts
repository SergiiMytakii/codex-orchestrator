import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GhCliPullRequestAdapter } from '../src/v2/adapters/gh-pull-request-adapter.js';
import type { CommandExecutor } from '../src/v2/adapters/gh-cli.js';

test('reads an exact repository-bound pull request review target', async () => {
  const executor: CommandExecutor = async (_file, args) => {
    assert.equal(args[0], 'api');
    assert.equal(args[1], 'graphql');
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            id: 'R_repo',
            name: 'repo',
            owner: { id: 'O_owner', login: 'owner' },
            pullRequest: {
              id: 'PR_node',
              databaseId: 17,
              number: 17,
              url: 'https://github.com/owner/repo/pull/17',
              state: 'OPEN',
              isDraft: true,
              isCrossRepository: false,
              headRefName: 'codex/issue-42',
              headRefOid: 'a'.repeat(40),
              baseRefName: 'main',
              title: 'Change',
              body: '<!-- codex-orchestrator:run:run-42 -->',
              authorAssociation: 'MEMBER',
            },
          },
        },
      }),
      stderr: '',
    };
  };

  const target = await new GhCliPullRequestAdapter('owner', 'repo', executor)
    .getReviewTarget(17);

  assert.deepEqual(target, {
    repository: {
      nodeId: 'R_repo',
      name: 'repo',
      owner: { nodeId: 'O_owner', login: 'owner' },
    },
    number: 17,
    nodeId: 'PR_node',
    url: 'https://github.com/owner/repo/pull/17',
    state: 'OPEN',
    isDraft: true,
    isCrossRepository: false,
    headRefName: 'codex/issue-42',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    title: 'Change',
    body: '<!-- codex-orchestrator:run:run-42 -->',
    authorAssociation: 'MEMBER',
  });
});

test('paginates review threads and nested comments without exposing a mutation', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    const query = args.find((argument) => argument.startsWith('query=')) ?? '';
    const cursor = args.find((argument) => argument.startsWith('cursor='));
    if (query.includes('ReviewThreadComments')) {
      return jsonResult({ data: { node: { comments: {
        nodes: [graphComment('C_reply', 'reply', null)],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } });
    }
    if (cursor === 'cursor=threads-2') {
      return jsonResult({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: [graphThread('T_2', false, false, 'src/b.ts', 20, [graphComment('C_2', 'second', 'a'.repeat(40))], false)],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } });
    }
    return jsonResult({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [graphThread('T_1', false, false, 'src/a.ts', 10, [{
        ...graphComment('C_1', 'root', 'a'.repeat(40)),
        commit: { oid: 'b'.repeat(40) },
      }], true)],
      pageInfo: { hasNextPage: true, endCursor: 'threads-2' },
    } } } } });
  };

  const adapter = new GhCliPullRequestAdapter('owner', 'repo', executor);
  const threads = await adapter.listReviewThreads(17);

  assert.equal(threads.length, 2);
  assert.deepEqual(threads[0], {
    nodeId: 'T_1',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 10,
    comments: [
      {
        nodeId: 'C_1', databaseId: '90071992547409930001',
        url: 'https://github.com/owner/repo/pull/17#discussion_r1', body: 'root',
        createdAt: '2026-07-27T10:00:00.000Z', updatedAt: '2026-07-27T10:00:00.000Z',
        commitId: 'a'.repeat(40), author: { nodeId: 'U_1', id: '90071992547409930002', login: 'writer', isBot: false },
      },
      {
        nodeId: 'C_reply', databaseId: '90071992547409930001',
        url: 'https://github.com/owner/repo/pull/17#discussion_r1', body: 'reply',
        createdAt: '2026-07-27T10:00:00.000Z', updatedAt: '2026-07-27T10:00:00.000Z',
        commitId: null, author: { nodeId: 'U_1', id: '90071992547409930002', login: 'writer', isBot: false },
      },
    ],
  });
  assert.equal('resolveReviewThread' in adapter, false);
  assert.equal(calls.length, 3);
});

test('reads paginated submitted reviews and pull request conversation comments with exact identities', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    const endpoint = args.find((argument) => argument.startsWith('repos/')) ?? '';
    if (endpoint.endsWith('/reviews')) {
      return {
        stdout: `${JSON.stringify(restReview())}\n${JSON.stringify({ ...restReview(), id: '2', node_id: 'R_2', state: 'APPROVED' })}\n`,
        stderr: '',
      };
    }
    return {
      stdout: `${JSON.stringify(restConversationComment())}\n`,
      stderr: '',
    };
  };
  const adapter = new GhCliPullRequestAdapter('owner', 'repo', executor);

  assert.deepEqual(await adapter.listSubmittedReviews(17), [{
    nodeId: 'R_1', databaseId: '90071992547409930003',
    url: 'https://github.com/owner/repo/pull/17#pullrequestreview-1',
    body: 'Please fix', state: 'CHANGES_REQUESTED', commitId: 'a'.repeat(40),
    submittedAt: '2026-07-27T10:00:00.000Z',
    author: { id: '90071992547409930004', login: 'writer', isBot: false },
  }, {
    nodeId: 'R_2', databaseId: '2',
    url: 'https://github.com/owner/repo/pull/17#pullrequestreview-1',
    body: 'Please fix', state: 'APPROVED', commitId: 'a'.repeat(40),
    submittedAt: '2026-07-27T10:00:00.000Z',
    author: { id: '90071992547409930004', login: 'writer', isBot: false },
  }]);
  assert.deepEqual((await adapter.listConversationComments(17))[0], {
    id: '90071992547409930005',
    url: 'https://github.com/owner/repo/pull/17#issuecomment-1',
    body: '<!-- marker -->', createdAt: '2026-07-27T10:00:00.000Z', updatedAt: '2026-07-27T10:00:00.000Z',
    author: { id: '90071992547409930004', login: 'writer', isBot: false },
  });
  assert.equal(calls.some((args) => args.includes('--paginate')), false);
  assert.equal(calls.every((args) => args.includes('page=1')), true);
});

test('rejects malformed review payloads and preserves nullable GraphQL actors', async () => {
  const nullable: CommandExecutor = async () => jsonResult({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [graphThread('T_1', false, false, 'src/a.ts', null, [{ ...graphComment('C_1', 'root', 'a'.repeat(40)), author: null }], false)],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } } } });
  const threads = await new GhCliPullRequestAdapter('owner', 'repo', nullable).listReviewThreads(17);
  assert.equal(threads[0]!.comments[0]!.author, null);

  const malformed: CommandExecutor = async () => ({ stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":true,"endCursor":null}}}}}}', stderr: '' });
  await assert.rejects(
    new GhCliPullRequestAdapter('owner', 'repo', malformed).listReviewThreads(17),
    /endCursor/u,
  );

  const malformedRest: CommandExecutor = async (_file, args) => ({
    stdout: JSON.stringify(args.some((argument) => argument.endsWith('/reviews'))
      ? { ...restReview(), user: { id: '42', login: 'writer', type: 123 } }
      : restConversationComment()),
    stderr: '',
  });
  await assert.rejects(
    new GhCliPullRequestAdapter('owner', 'repo', malformedRest).listSubmittedReviews(17),
    /type/u,
  );
});

function jsonResult(value: unknown): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(value), stderr: '' };
}

function graphComment(nodeId: string, body: string, commitId: string | null): Record<string, unknown> {
  return {
    id: nodeId,
    databaseId: '90071992547409930001',
    url: 'https://github.com/owner/repo/pull/17#discussion_r1',
    body,
    createdAt: '2026-07-27T10:00:00Z',
    updatedAt: '2026-07-27T10:00:00Z',
    author: { __typename: 'User', id: 'U_1', databaseId: '90071992547409930002', login: 'writer' },
    commit: commitId ? { oid: commitId } : null,
    originalCommit: commitId ? { oid: commitId } : null,
  };
}

function graphThread(
  id: string, isResolved: boolean, isOutdated: boolean, path: string, line: number | null,
  comments: unknown[], hasNextPage: boolean,
): Record<string, unknown> {
  return {
    id, isResolved, isOutdated, path, line,
    comments: { nodes: comments, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'comments-2' : null } },
  };
}

function restReview(): Record<string, unknown> {
  return {
    id: '90071992547409930003', node_id: 'R_1',
    html_url: 'https://github.com/owner/repo/pull/17#pullrequestreview-1',
    body: 'Please fix', state: 'CHANGES_REQUESTED', commit_id: 'a'.repeat(40),
    submitted_at: '2026-07-27T10:00:00Z',
    user: { id: '90071992547409930004', login: 'writer', type: 'User' },
  };
}

function restConversationComment(): Record<string, unknown> {
  return {
    id: '90071992547409930005',
    html_url: 'https://github.com/owner/repo/pull/17#issuecomment-1',
    body: '<!-- marker -->', created_at: '2026-07-27T10:00:00Z', updated_at: '2026-07-27T10:00:00Z',
    user: { id: '90071992547409930004', login: 'writer', type: 'User' },
  };
}
