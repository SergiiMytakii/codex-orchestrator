import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GhCliIssueAdapter } from '../src/v2/adapters/gh-issue-adapter.js';
import type { CommandExecutionError, CommandExecutor } from '../src/v2/adapters/gh-cli.js';

const restComment = {
  id: '90071992547409931234',
  html_url: 'https://github.com/owner/repo/issues/12#issuecomment-90071992547409931234',
  body: 'answer',
  created_at: '2026-07-17T10:00:00.000Z',
  updated_at: '2026-07-17T10:01:00.000Z',
  user: { login: 'maintainer', id: '90071992547409939876' },
  author_association: 'MEMBER',
};

test('GhCliIssueAdapter preserves decimal REST comment and author IDs above MAX_SAFE_INTEGER', async () => {
  let observedArgs: string[] = [];
  const executor: CommandExecutor = async (_file, args) => {
    observedArgs = args;
    return { stdout: JSON.stringify([[restComment]]), stderr: '' };
  };
  const comments = await new GhCliIssueAdapter('owner', 'repo', executor).listAllComments(12);
  assert.equal(comments[0]!.id, restComment.id);
  assert.equal(comments[0]!.author.id, restComment.user.id);
  assert.equal(comments[0]!.updatedAt, restComment.updated_at);
  assert.deepEqual(observedArgs.slice(-2), ['--jq', 'map(map(.id |= tostring | .user.id |= tostring))']);
});

test('GhCliIssueAdapter checks permission against the immutable author ID and types 404 as none', async () => {
  const success: CommandExecutor = async () => ({
    stdout: JSON.stringify({ permission: 'write', user: { id: restComment.user.id } }), stderr: '',
  });
  const adapter = new GhCliIssueAdapter('owner', 'repo', success, () => '2026-07-17T11:00:00.000Z');
  assert.deepEqual(await adapter.getRepositoryPermission('maintainer', restComment.user.id), {
    permission: 'write', checkedAt: '2026-07-17T11:00:00.000Z', userId: restComment.user.id,
  });
  await assert.rejects(adapter.getRepositoryPermission('maintainer', '42'), /identity did not match/u);

  const missing: CommandExecutor = async () => {
    const error = new Error('not found') as CommandExecutionError;
    error.code = 1;
    error.stderr = 'gh: Not Found (HTTP 404)';
    throw error;
  };
  assert.deepEqual(await new GhCliIssueAdapter('owner', 'repo', missing, () => 'now').getRepositoryPermission('outsider', '77'), {
    permission: 'none', checkedAt: 'now', userId: '77',
  });
});

test('GhCliIssueAdapter returns the posted comment only after REST reread observes it', async () => {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (_file, args) => {
    calls.push(args);
    return args[0] === 'issue'
      ? { stdout: '', stderr: '' }
      : { stdout: JSON.stringify([[restComment]]), stderr: '' };
  };
  const observed = await new GhCliIssueAdapter('owner', 'repo', executor).postComment(12, 'answer');
  assert.equal(observed.id, restComment.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]![0], 'api');
});
