import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandExecutor } from '../src/github/gh-cli.js';
import { GhCliIssueAdapter } from '../src/github/gh-issue-adapter.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { issueFixture } from './fixtures/issues.js';

test('in-memory issue adapter lists open issues by any matching label and mutates labels/comments', async () => {
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 2, labels: ['agent:manual'] }),
    issueFixture({ number: 1, labels: ['agent:auto'] }),
    issueFixture({ number: 3, labels: ['agent:auto'], state: 'CLOSED' }),
  ]);

  const listed = await adapter.listOpenIssuesWithAnyLabel(['agent:auto', 'agent:manual']);
  assert.deepEqual(listed.map((issue) => issue.number), [1, 2]);

  await adapter.addLabels(1, ['agent:running']);
  await adapter.removeLabels(1, ['agent:auto']);
  await adapter.postComment(1, 'claimed');

  const issue = await adapter.getIssue(1);
  assert.deepEqual(issue?.labels.map((label) => label.name), ['agent:running']);
  assert.equal(issue?.comments[0]?.body, 'claimed');
  assert.deepEqual(adapter.addedLabels, [{ issueNumber: 1, labels: ['agent:running'] }]);
  assert.deepEqual(adapter.removedLabels, [{ issueNumber: 1, labels: ['agent:auto'] }]);
  assert.deepEqual(adapter.postedComments, [{ issueNumber: 1, body: 'claimed' }]);
});

test('gh issue adapter lists once per label and normalizes missing arrays', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const executor: CommandExecutor = async (file, args) => {
    calls.push({ file, args });
    return {
      stdout: JSON.stringify([
        {
          number: 1,
          title: 'One',
          url: 'https://github.com/example/repo/issues/1',
          state: 'OPEN',
        },
      ]),
      stderr: '',
    };
  };

  const adapter = new GhCliIssueAdapter('example', 'repo', executor);
  const issues = await adapter.listOpenIssuesWithAnyLabel(['agent:auto', 'agent:manual']);

  assert.deepEqual(issues.map((issue) => issue.number), [1]);
  assert.deepEqual(issues[0]?.labels, []);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.args, [
    'issue',
    'list',
    '--repo',
    'example/repo',
    '--state',
    'open',
    '--label',
    'agent:auto',
    '--limit',
    '100',
    '--json',
    'number,title,url,state,labels,comments,closedByPullRequestsReferences',
  ]);
});

test('gh issue adapter handles issue view not-found stderr shapes', async () => {
  const stderrValues = ['issue not found', 'GraphQL: Could not resolve to an issue or pull request with the number of 999.'];

  for (const stderr of stderrValues) {
    const executor: CommandExecutor = async () => {
      throw Object.assign(new Error(stderr), { code: 1, stderr });
    };
    const adapter = new GhCliIssueAdapter('example', 'repo', executor);

    assert.equal(await adapter.getIssue(999), undefined);
  }
});

test('gh issue adapter uses exact mutation commands', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    return { stdout: '{}', stderr: '' };
  };
  const adapter = new GhCliIssueAdapter('example', 'repo', executor);

  await adapter.addLabels(1, ['agent:running']);
  await adapter.removeLabels(1, ['agent:blocked']);
  await adapter.postComment(1, 'hello');

  assert.deepEqual(calls, [
    ['issue', 'edit', '1', '--repo', 'example/repo', '--add-label', 'agent:running'],
    ['issue', 'edit', '1', '--repo', 'example/repo', '--remove-label', 'agent:blocked'],
    ['issue', 'comment', '1', '--repo', 'example/repo', '--body', 'hello'],
  ]);
});
