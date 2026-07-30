import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executeDaemonTick } from '../src/v2/cli.js';
import type { GitHubIssue } from '../src/v2/adapters/issues.js';
import type { RunIssueResult } from '../src/v2/run-issue.js';

function issue(number: number): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    url: `https://example.invalid/${number}`,
    state: 'OPEN',
    labels: [{ name: 'agent:auto' }],
    comments: [],
    closedByPullRequestsReferences: [],
  };
}

test('daemon tick discards a prior frozen list when discovery fails and rediscovers next tick', async () => {
  let discovery = 0;
  const executed: number[] = [];
  const input = {
    targetRoot: '/tmp/target',
    discoverCandidates: async () => {
      discovery += 1;
      if (discovery === 1) return [issue(11)];
      if (discovery === 2) throw new Error('discovery unavailable');
      return [issue(22)];
    },
    executeRun: async ({ issueNumber }: { targetRoot: string; issueNumber: number }): Promise<RunIssueResult> => {
      executed.push(issueNumber);
      return { status: 'requeued', reason: 'owner-contention', evidencePath: 'owner-contention.json' };
    },
    write: () => undefined,
    lastResults: new Map<number, string>(),
  };

  assert.equal(await executeDaemonTick(input), 0);
  await assert.rejects(executeDaemonTick(input), /discovery unavailable/);
  assert.deepEqual(executed, [11]);

  assert.equal(await executeDaemonTick(input), 0);
  assert.equal(discovery, 3);
  assert.deepEqual(executed, [11, 22]);
});

test('daemon tick observes each frozen issue once and continues after retry and safety outcomes', async () => {
  const executed: number[] = [];
  const output: string[] = [];
  const results = new Map<number, RunIssueResult>([
    [1, { status: 'requeued', reason: 'owner-contention', evidencePath: 'owner-contention.json' }],
    [2, { status: 'state-schema-unsupported' }],
    [3, {
      status: 'review-ready',
      pullRequestUrl: 'https://example.invalid/pr/3',
      evidencePath: 'evidence.json',
      continuationEpoch: 'a'.repeat(40),
    }],
  ]);

  const exitCode = await executeDaemonTick({
    targetRoot: '/tmp/target',
    discoverCandidates: async () => [issue(3), issue(1), issue(2), issue(1)],
    executeRun: async ({ issueNumber }) => {
      executed.push(issueNumber);
      return results.get(issueNumber)!;
    },
    write: (text) => output.push(text),
    lastResults: new Map<number, string>(),
  });

  assert.equal(exitCode, 20);
  assert.deepEqual(executed, [1, 2, 3]);
  assert.deepEqual(output.map((text) => JSON.parse(text).result.status), [
    'requeued',
    'state-schema-unsupported',
    'review-ready',
  ]);
});
