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
