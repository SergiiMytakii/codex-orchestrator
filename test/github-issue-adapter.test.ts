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

test('in-memory issue adapter creates and updates issues deterministically', async () => {
  const adapter = new InMemoryGitHubIssueAdapter([issueFixture({ number: 3, labels: ['existing'] })]);

  const created = await adapter.createIssue({
    title: 'Child',
    body: 'Body',
    labels: ['agent:child', 'agent:child', 'agent:auto'],
  });
  await adapter.postComment(created.number, 'comment');
  const updated = await adapter.updateIssue(created.number, {
    title: 'Updated child',
    body: 'Updated body',
    addLabels: ['agent:auto', 'agent:review'],
    removeLabels: ['agent:child'],
  });

  assert.equal(created.number, 4);
  assert.equal(updated.title, 'Updated child');
  assert.equal(updated.body, 'Updated body');
  assert.deepEqual(updated.labels.map((label) => label.name), ['agent:auto', 'agent:review']);
  assert.equal(updated.comments[0]?.body, 'comment');
});

test('gh issue adapter lists open issues once and filters matching labels locally', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const executor: CommandExecutor = async (file, args) => {
    calls.push({ file, args });
    return {
      stdout: JSON.stringify([
        {
          number: 1,
          title: 'One',
          body: 'Body',
          url: 'https://github.com/example/repo/issues/1',
          state: 'OPEN',
          labels: [{ name: 'agent:auto' }],
        },
        {
          number: 2,
          title: 'Two',
          body: 'Body',
          url: 'https://github.com/example/repo/issues/2',
          state: 'OPEN',
          labels: [{ name: 'agent:review' }],
        },
      ]),
      stderr: '',
    };
  };

  const adapter = new GhCliIssueAdapter('example', 'repo', executor);
  const issues = await adapter.listOpenIssuesWithAnyLabel(['agent:auto', 'agent:manual']);

  assert.deepEqual(issues.map((issue) => issue.number), [1]);
  assert.deepEqual(issues[0]?.labels.map((label) => label.name), ['agent:auto']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, [
    'issue',
    'list',
    '--repo',
    'example/repo',
    '--state',
    'open',
    '--limit',
    '1000',
    '--json',
    'number,title,body,url,state,labels,comments,closedByPullRequestsReferences',
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

test('gh issue adapter truncates oversized comments before posting', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    return { stdout: '{}', stderr: '' };
  };
  const adapter = new GhCliIssueAdapter('example', 'repo', executor);

  await adapter.postComment(1, 'x'.repeat(70_000));

  const body = calls[0]?.at(-1) ?? '';
  assert.equal(body.length, 60_000);
  assert.match(body, /truncated by codex-orchestrator/);
});

test('gh issue adapter creates issues and reads them back', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'create') {
      return { stdout: 'https://github.com/example/repo/issues/42\n', stderr: '' };
    }
    return {
      stdout: JSON.stringify({
        number: 42,
        title: 'Child',
        body: 'Body',
        url: 'https://github.com/example/repo/issues/42',
        state: 'OPEN',
        labels: [{ name: 'agent:child' }],
        comments: [],
        closedByPullRequestsReferences: [],
      }),
      stderr: '',
    };
  };
  const adapter = new GhCliIssueAdapter('example', 'repo', executor);

  const issue = await adapter.createIssue({ title: 'Child', body: 'Body', labels: ['agent:child', 'agent:auto'] });

  assert.equal(issue.number, 42);
  assert.deepEqual(calls[0], [
    'issue',
    'create',
    '--repo',
    'example/repo',
    '--title',
    'Child',
    '--body',
    'Body',
    '--label',
    'agent:child',
    '--label',
    'agent:auto',
  ]);
  assert.deepEqual(calls[1], [
    'issue',
    'view',
    '42',
    '--repo',
    'example/repo',
    '--json',
    'number,title,body,url,state,labels,comments,closedByPullRequestsReferences',
  ]);
});

test('gh issue adapter updates issues and reads them back', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify({
        number: 42,
        title: 'Updated',
        body: 'Updated body',
        url: 'https://github.com/example/repo/issues/42',
        state: 'OPEN',
        labels: [{ name: 'agent:child' }],
        comments: [],
        closedByPullRequestsReferences: [],
      }),
      stderr: '',
    };
  };
  const adapter = new GhCliIssueAdapter('example', 'repo', executor);

  const issue = await adapter.updateIssue(42, {
    title: 'Updated',
    body: 'Updated body',
    addLabels: ['agent:child'],
    removeLabels: ['agent:auto'],
  });

  assert.equal(issue.title, 'Updated');
  assert.deepEqual(calls[0], [
    'issue',
    'edit',
    '42',
    '--repo',
    'example/repo',
    '--title',
    'Updated',
    '--body',
    'Updated body',
    '--add-label',
    'agent:child',
    '--remove-label',
    'agent:auto',
  ]);
  assert.deepEqual(calls[1]?.slice(0, 3), ['issue', 'view', '42']);
});

test('gh issue adapter rejects create output without issue URL', async () => {
  const adapter = new GhCliIssueAdapter('example', 'repo', async () => ({ stdout: 'created', stderr: '' }));

  await assert.rejects(
    adapter.createIssue({ title: 'Child', body: 'Body', labels: [] }),
    /gh issue create did not return an issue URL/,
  );
});
