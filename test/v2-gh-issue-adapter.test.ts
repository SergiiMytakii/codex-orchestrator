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
    if (args.includes('--slurp') && args.includes('--jq')) {
      throw new Error('the --slurp option is not supported with --jq or --template');
    }
    return { stdout: `${JSON.stringify(restComment)}\n`, stderr: '' };
  };
  const comments = await new GhCliIssueAdapter('owner', 'repo', executor).listAllComments(12);
  assert.equal(comments[0]!.id, restComment.id);
  assert.equal(comments[0]!.author.id, restComment.user.id);
  assert.equal(comments[0]!.updatedAt, restComment.updated_at);
  assert.equal(observedArgs.includes('--paginate'), true);
  assert.equal(observedArgs.includes('--slurp'), false);
  assert.deepEqual(observedArgs.slice(-2), [
    '--jq',
    '.[] | .id = (.id | tostring) | .user.id = (.user.id | tostring)',
  ]);
});

test('GhCliIssueAdapter canonicalizes GitHub comment timestamps before persistence', async () => {
  const executor: CommandExecutor = async () => ({
    stdout: JSON.stringify({
      number: 12,
      title: 'Issue',
      body: 'Body',
      url: 'https://github.com/owner/repo/issues/12',
      state: 'OPEN',
      labels: [],
      closedByPullRequestsReferences: [],
      comments: [{
        id: 'IC_12',
        url: 'https://github.com/owner/repo/issues/12#issuecomment-12',
        body: 'comment',
        createdAt: '2026-07-17T10:00:00Z',
        author: { login: 'maintainer' },
        authorAssociation: 'MEMBER',
      }],
    }),
    stderr: '',
  });

  const issue = await new GhCliIssueAdapter('owner', 'repo', executor).getIssue(12);

  assert.equal(issue!.comments[0]!.createdAt, '2026-07-17T10:00:00.000Z');
  assert.equal(issue!.comments[0]!.updatedAt, '2026-07-17T10:00:00.000Z');
});

test('GhCliIssueAdapter bounds historical comments to the persisted run-state contract', async () => {
  const oversizedBody = 'x'.repeat(60_000);
  const executor: CommandExecutor = async () => ({
    stdout: `${JSON.stringify({ ...restComment, body: oversizedBody })}\n`, stderr: '',
  });

  const [comment] = await new GhCliIssueAdapter('owner', 'repo', executor).listAllComments(12);

  assert.equal(comment!.body.length, 16_384);
  assert.match(comment!.body, /\[truncated by codex-orchestrator: original comment was 60000 UTF-16 code units\]$/u);
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
      : { stdout: `${JSON.stringify(restComment)}\n`, stderr: '' };
  };
  const observed = await new GhCliIssueAdapter('owner', 'repo', executor).postComment(12, 'answer');
  assert.equal(observed.id, restComment.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]![0], 'api');
});

test('GhCliIssueAdapter preserves oversized Unicode comments across the GitHub argv round trip', async () => {
  const suffix = '\n\n[truncated by codex-orchestrator: original comment was 60000 UTF-16 code units]';
  const cutoff = 16_384 - suffix.length;
  const body = `${'x'.repeat(cutoff - 1)}😀${'x'.repeat(60_000 - cutoff - 1)}`;
  let outboundBody = '';
  let postedBody = '';
  const executor: CommandExecutor = async (_file, args) => {
    if (args[0] === 'issue') {
      outboundBody = args.at(-1)!;
      postedBody = Buffer.from(outboundBody).toString('utf8');
      return { stdout: '', stderr: '' };
    }
    return { stdout: `${JSON.stringify({ ...restComment, body: postedBody })}\n`, stderr: '' };
  };

  const observed = await new GhCliIssueAdapter('owner', 'repo', executor).postComment(12, body);

  assert.equal(observed.body, postedBody);
  assert.equal(outboundBody.length, 16_383);
  assert.notEqual(outboundBody, body);
  assert.equal(outboundBody.endsWith(suffix), true);
  assert.doesNotMatch(outboundBody, /😀/u);
  assert.equal(observed.body.length, outboundBody.length);
  assert.doesNotMatch(observed.body, /\uFFFD/u);
});
