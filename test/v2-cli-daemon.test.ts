import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { RunRecord } from '../src/v2/run-store.js';
import { test } from 'node:test';

import { executeDaemonTick, executeDaemonLoop, discoverConfiguredDaemonTick } from '../src/v2/cli.js';
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

test('an unresolved attempt releases the issue loop so later candidates run and the next tick rediscovers', async () => {
  let discoveries = 0;
  const executed: number[] = [];
  const lastResults = new Map<number, string>();
  const input = {
    targetRoot: '/tmp/target',
    discoverCandidates: async () => {
      discoveries += 1;
      return discoveries === 1 ? [issue(1), issue(2)] : [issue(2), issue(3)];
    },
    executeRun: async ({ issueNumber }: { targetRoot: string; issueNumber: number }): Promise<RunIssueResult> => {
      executed.push(issueNumber);
      return issueNumber === 1
        ? { status: 'transport-failed', resumable: true, evidencePath: 'active-attempt-observation.json' }
        : { status: 'requeued', reason: 'owner-contention', evidencePath: `owner-${issueNumber}.json` };
    },
    write: () => undefined,
    lastResults,
  };

  assert.equal(await executeDaemonTick(input), 70);
  assert.deepEqual(executed, [1, 2]);
  assert.equal(await executeDaemonTick(input), 0);
  assert.deepEqual(executed, [1, 2, 2, 3]);
  assert.equal(discoveries, 2);
});

test('daemon refreshes the complete execution snapshot each tick after temporary config I/O', async () => {
  const stop = new Error('stop test');
  const executions: string[] = [];
  let ticks = 0;
  let delays = 0;
  const result = { status: 'transport-failed', kind: 'transport', resumable: true, summary: 'retry' } as unknown as RunIssueResult;
  await assert.rejects(executeDaemonLoop({ targetRoot: '/tmp/repo', once: false }, () => {}, {
    discover: async () => { throw new Error('unbound discovery must never run'); },
    executeRun: async () => { throw new Error('unbound executor must never run'); },
    readTick: async () => {
      ticks += 1;
      if (ticks === 1) throw Object.assign(new Error('temporary config read failure'), { code: 'EIO' });
      const repository = ticks === 2 ? 'A' : 'B';
      return { candidates: [issue(42)], pollIntervalMilliseconds: 10,
        executeRun: async () => { executions.push(repository); return result; } };
    },
    pollIntervalMilliseconds: 1,
    delay: async () => { if (++delays === 3) throw stop; },
  }), (error: unknown) => error === stop);
  assert.deepEqual(executions, ['A', 'B']);
});


test('a repository config change after discovery cancels the frozen execution before effects', async () => {
  let bytes = await readFile('.codex-orchestrator/config.json');
  let executed = 0;
  const snapshot = await discoverConfiguredDaemonTick('/tmp/target', {
    readConfigBytes: async () => bytes,
    discover: async (config) => { assert.equal(config.github.repo, 'codex-orchestrator'); return [issue(12)]; },
    inventory: async () => [],
    executeRun: async () => { executed += 1; return { status: 'state-schema-unsupported' }; },
  });
  const changed = JSON.parse(bytes.toString());
  changed.github.repo = 'other';
  bytes = Buffer.from(JSON.stringify(changed));
  await assert.rejects(snapshot.executeRun({ targetRoot: '/tmp/target', issueNumber: 12 }), /config-snapshot-changed/);
  assert.equal(executed, 0);
});

test('discovery picks interrupted local runs without auto and omits final safety stops', async () => {
  const bytes = await readFile('.codex-orchestrator/config.json');
  const fixture = (number: number, extra: Partial<RunRecord>): RunRecord => ({ issueNumber: number, createdAt: '2026-10-12T00:00:00Z', issueSnapshot: { ...issue(number), labels: ['agent:running'] }, ...extra } as unknown as RunRecord);
  const snapshot = await discoverConfiguredDaemonTick('/tmp/target', {
    readConfigBytes: async () => bytes,
    discover: async () => [issue(2)],
    inventory: async () => [fixture(1, {}), fixture(2, { terminalOutcome: { status: 'blocked', kind: 'safety', resumable: false, evidencePath: 'evidence.json' } })],
    executeRun: async () => ({ status: 'state-schema-unsupported' }),
  });
  assert.deepEqual(snapshot.candidates.map((candidate) => candidate.number), [1]);
});


test('daemon leaves retired standalone proof terminals stopped without renewed authority', async () => {
  const bytes = await readFile('.codex-orchestrator/config.json');
  const stopped = (number: number): RunRecord => ({ issueNumber: number, createdAt: '2026-10-12T00:00:00Z',
    issueSnapshot: { ...issue(number), labels: ['agent:blocked'] },
    terminalOutcome: { status: 'internal-error', code: 'acceptance-proof-internal-failure', evidencePath: 'proof.json' } } as unknown as RunRecord);
  const snapshot = await discoverConfiguredDaemonTick('/tmp/target', {
    readConfigBytes: async () => bytes, discover: async () => [issue(1), issue(2)],
    inventory: async () => [stopped(1), stopped(2)],
    executeRun: async () => ({ status: 'state-schema-unsupported' }),
  });
  assert.deepEqual([...new Set(snapshot.candidates.map((candidate) => candidate.number))], []);
});


test('daemon cancellation ends the serial pass and skips later issue invocations', async () => {
  const controller = new AbortController();
  const executed: number[] = [];
  const result = await executeDaemonLoop({ targetRoot: '/tmp/target', once: true }, () => {}, {
    signal: controller.signal,
    discover: async () => [issue(1), issue(2)],
    executeRun: async ({ issueNumber }) => { executed.push(issueNumber); controller.abort(); return { status: 'cancelled', evidencePath: 'cancelled.json' }; },
    delay: async () => { throw new Error('cancelled daemon must not delay'); },
    pollIntervalMilliseconds: 1,
  });
  assert.equal(result, 130);
  assert.deepEqual(executed, [1]);
});

test('a fresh GitHub authorization returns a cancelled issue to the daemon queue', async () => {
  const bytes = await readFile('.codex-orchestrator/config.json');
  const cancelled = { issueNumber: 263, createdAt: '2026-10-05T00:00:00Z',
    terminalOutcome: { status: 'cancelled', evidencePath: 'cancelled.json' } } as RunRecord;
  const snapshot = await discoverConfiguredDaemonTick('/tmp/target', {
    readConfigBytes: async () => bytes,
    discover: async () => [issue(263)],
    inventory: async () => [cancelled],
    isReauthorized: async () => true,
    executeRun: async () => ({ status: 'state-schema-unsupported' }),
  } as Parameters<typeof discoverConfiguredDaemonTick>[1]);
  assert.deepEqual(snapshot.candidates.map(candidate => candidate.number), [263]);
});

test('a stopped issue timeline failure does not skip another eligible issue', async () => {
  const bytes = await readFile('.codex-orchestrator/config.json');
  const stopped = { issueNumber: 263, createdAt: '2026-10-05T00:00:00Z',
    terminalOutcome: { status: 'cancelled', evidencePath: 'cancelled.json' } } as RunRecord;
  const snapshot = await discoverConfiguredDaemonTick('/tmp/target', {
    readConfigBytes: async () => bytes,
    discover: async () => [issue(263), issue(264)],
    inventory: async () => [stopped],
    isReauthorized: async () => { throw new Error('HTTP 503 timeline'); },
    executeRun: async () => ({ status: 'state-schema-unsupported' }),
  });
  assert.deepEqual(snapshot.candidates.map(candidate => candidate.number), [264]);
});
