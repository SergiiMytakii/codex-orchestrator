import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandExecutor } from '../src/github/gh-cli.js';
import { GhCliPullRequestAdapter } from '../src/github/gh-pull-request-adapter.js';
import { InMemoryGitHubPullRequestAdapter } from '../src/github/pull-requests.js';

test('in-memory pull request adapter records draft PR requests', async () => {
  const adapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');

  const pullRequest = await adapter.createDraftPullRequest({
    title: 'Codex: issue #155',
    body: 'Closes #155',
    headBranch: 'codex/issue-155',
    baseBranch: 'main',
  });

  assert.deepEqual(adapter.createdPullRequests, [
    {
      title: 'Codex: issue #155',
      body: 'Closes #155',
      headBranch: 'codex/issue-155',
      baseBranch: 'main',
    },
  ]);
  assert.deepEqual(pullRequest, {
    number: 1,
    url: 'https://github.com/example/repo/pull/1',
    isDraft: true,
    headRefName: 'codex/issue-155',
    baseRefName: 'main',
  });
});

test('finds open pull request by head and base', async () => {
  const adapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');

  await adapter.createDraftPullRequest({
    title: 'Codex: issue #155',
    body: 'Closes #155',
    headBranch: 'codex/issue-155',
    baseBranch: 'main',
  });
  await adapter.createDraftPullRequest({
    title: 'Codex: issue #155 for dev',
    body: 'Closes #155',
    headBranch: 'codex/issue-155',
    baseBranch: 'dev',
  });

  assert.equal((await adapter.findOpenPullRequestByHeadAndBase('codex/issue-155', 'main'))?.number, 1);
  assert.equal((await adapter.findOpenPullRequestByHeadAndBase('codex/issue-155', 'dev'))?.number, 2);
  assert.equal(await adapter.findOpenPullRequestByHeadAndBase('codex/issue-155', 'release'), undefined);
});

test('gh pull request adapter uses draft create command and parses URL', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    return { stdout: 'https://github.com/example/repo/pull/42\n', stderr: '' };
  };
  const adapter = new GhCliPullRequestAdapter('example', 'repo', executor);

  const pullRequest = await adapter.createDraftPullRequest({
    title: 'Title',
    body: 'Body',
    headBranch: 'codex/issue-155',
    baseBranch: 'main',
  });

  assert.deepEqual(calls[0], [
    'pr',
    'create',
    '--repo',
    'example/repo',
    '--base',
    'main',
    '--head',
    'codex/issue-155',
    '--title',
    'Title',
    '--body',
    'Body',
    '--draft',
  ]);
  assert.equal(pullRequest.number, 42);
});

test('gh pull request adapter finds open pull requests by head and base', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify([
        {
          number: 42,
          url: 'https://github.com/example/repo/pull/42',
          isDraft: true,
          headRefName: 'codex/issue-155',
          baseRefName: 'main',
        },
      ]),
      stderr: '',
    };
  };
  const adapter = new GhCliPullRequestAdapter('example', 'repo', executor);

  const pullRequest = await adapter.findOpenPullRequestByHeadAndBase('codex/issue-155', 'main');

  assert.deepEqual(calls[0], [
    'pr',
    'list',
    '--repo',
    'example/repo',
    '--state',
    'open',
    '--head',
    'codex/issue-155',
    '--base',
    'main',
    '--json',
    'number,url,isDraft,headRefName,baseRefName',
    '--limit',
    '1',
  ]);
  assert.equal(pullRequest?.number, 42);
});

test('gh pull request adapter finds merged PRs by head branch', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify([
        {
          number: 42,
          url: 'https://github.com/example/repo/pull/42',
          isDraft: false,
          headRefName: 'codex/issue-155',
          baseRefName: 'main',
        },
      ]),
      stderr: '',
    };
  };
  const adapter = new GhCliPullRequestAdapter('example', 'repo', executor);

  const pullRequest = await adapter.findMergedPullRequestByHeadBranch('codex/issue-155');

  assert.deepEqual(calls[0], [
    'pr',
    'list',
    '--repo',
    'example/repo',
    '--head',
    'codex/issue-155',
    '--state',
    'merged',
    '--json',
    'number,url,isDraft,headRefName,baseRefName',
    '--limit',
    '1',
  ]);
  assert.equal(pullRequest?.number, 42);
});

test('gh pull request adapter enumerates every PR page and preserves immutable identity', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify([[
        {
          number: 41,
          node_id: 'PR_first',
          html_url: 'https://github.com/example/repo/pull/41',
          state: 'closed',
          draft: false,
          merged_at: null,
          head: { ref: 'codex/mission-227' },
          base: { ref: 'main' },
          title: 'Old attempt',
          body: null,
          author_association: 'MEMBER',
        },
      ], [
        {
          number: 42,
          node_id: 'PR_expected',
          html_url: 'https://github.com/example/repo/pull/42',
          state: 'closed',
          draft: false,
          merged_at: '2026-07-14T20:00:00Z',
          head: { ref: 'codex/mission-227' },
          base: { ref: 'main' },
          title: 'Expected',
          body: '<!-- codex-orchestrator:publication mission-227 -->',
          author_association: 'OWNER',
        },
      ]]),
      stderr: '',
    };
  };
  const adapter = new GhCliPullRequestAdapter('example', 'repo', executor);

  const pullRequests = await adapter.listAllByHeadBranch('codex/mission-227');

  assert.deepEqual(calls[0], [
    'api', '--paginate', '--slurp', '--method', 'GET',
    'repos/example/repo/pulls',
    '-f', 'state=all',
    '-f', 'head=example:codex/mission-227',
    '-f', 'per_page=100',
  ]);
  assert.deepEqual(pullRequests.map((pullRequest) => ({
    number: pullRequest.number,
    nodeId: pullRequest.nodeId,
    state: pullRequest.state,
    body: pullRequest.body,
  })), [
    { number: 41, nodeId: 'PR_first', state: 'CLOSED', body: '' },
    {
      number: 42,
      nodeId: 'PR_expected',
      state: 'MERGED',
      body: '<!-- codex-orchestrator:publication mission-227 -->',
    },
  ]);
});
