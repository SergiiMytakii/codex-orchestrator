import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  isDirectCliExecution,
  executeDaemonLoop,
  executeDaemonCandidates,
  parseDaemonArgs,
  parseRunArgs,
  parseTargetConfigForExecution,
  runCli,
} from '../src/v2/cli.js';


test('CLI direct-execution guard canonicalizes macOS temporary path aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v2-cli-entry-'));
  try {
    const path = join(root, 'cli.js');
    await writeFile(path, 'fixture\n');
    assert.equal(isDirectCliExecution(path, await realpath(path)), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI accepts only one exact direct run intent', () => {
  assert.deepEqual(parseRunArgs(['run', '--target', '/tmp/target', '--issue', '17']), {
    targetRoot: '/tmp/target', issueNumber: 17,
  });
  for (const argv of [
    [], ['run'], ['run', '--target', 'relative', '--issue', '1'], ['run', '--target', '/tmp/x'],
    ['run', '--target', '/tmp/x', '--issue', '0'], ['run', '--target', '/tmp/x', '--issue', '1', '--json'],
    ['daemon', '--target', '/tmp/x'],
  ]) assert.throws(() => parseRunArgs(argv));
});

test('CLI renders only the typed runIssue outcome and matching exit', async () => {
  const output: string[] = [];
  const exit = await runCli(['run', '--target', '/tmp/target', '--issue', '17'], {
    executeRun: async (input) => {
      assert.deepEqual(input, { targetRoot: '/tmp/target', issueNumber: 17 });
      return { status: 'blocked', kind: 'safety', resumable: false, evidencePath: 'evidence.json' };
    },
    write: (text) => { output.push(text); },
  });
  assert.equal(exit, 20);
  assert.deepEqual(JSON.parse(output.join('')), {
    schema: 'codex-orchestrator.agent-auto-run-result', version: 1,
    result: { status: 'blocked', kind: 'safety', resumable: false, evidencePath: 'evidence.json' },
  });
});

test('CLI reports bounded semantic repair continuation as success rather than transport failure', async () => {
  const output: string[] = [];
  const result = { status: 'repair-ready' as const, source: 'review' as const, blockerIds: ['REV-1'], evidencePath: 'repair.json' };
  const exit = await runCli(['run', '--target', '/tmp/target', '--issue', '17'], {
    executeRun: async () => result,
    write: (text) => { output.push(text); },
  });
  assert.equal(exit, 0);
  assert.deepEqual(JSON.parse(output.join('')).result, result);
});

test('CLI renders effect-free unsupported state as the exact public result with blocked exit', async () => {
  const output: string[] = [];
  const exit = await runCli(['run', '--target', '/tmp/target', '--issue', '17'], {
    executeRun: async () => ({ status: 'state-schema-unsupported' }),
    write: (text) => { output.push(text); },
  });
  assert.equal(exit, 20);
  assert.equal(output.join(''), '{"result":{"status":"state-schema-unsupported"},"schema":"codex-orchestrator.agent-auto-run-result","version":1}\n');
});

test('CLI daemon accepts one absolute target and delegates the serial loop', async () => {
  assert.deepEqual(parseDaemonArgs(['daemon', '--target', '/tmp/target']), {
    targetRoot: '/tmp/target', once: false,
  });
  assert.deepEqual(parseDaemonArgs(['daemon', '--target', '/tmp/target', '--once']), {
    targetRoot: '/tmp/target', once: true,
  });
  assert.deepEqual(parseDaemonArgs(['daemon', '--target', '/tmp/target', '--once', '--issue', '42']), {
    targetRoot: '/tmp/target', once: true, issueNumber: 42,
  });
  for (const argv of [
    ['daemon'], ['daemon', '--target', 'relative'], ['daemon', '--target', '/tmp/target', '--once', '--again'],
    ['daemon', '--target', '/tmp/target', '--issue', '42'],
    ['daemon', '--target', '/tmp/target', '--once', '--issue', '0'],
  ]) assert.throws(() => parseDaemonArgs(argv));

  const seen: unknown[] = [];
  const exit = await runCli(['daemon', '--target', '/tmp/target', '--once'], {
    executeDaemon: async (intent) => { seen.push(intent); return 0; },
  });
  assert.equal(exit, 0);
  assert.deepEqual(seen, [{ targetRoot: '/tmp/target', once: true }]);

  await runCli(['daemon', '--target', '/tmp/target', '--once', '--issue', '42'], {
    executeDaemon: async (intent) => { seen.push(intent); return 0; },
  });
  assert.deepEqual(seen.at(-1), { targetRoot: '/tmp/target', once: true, issueNumber: 42 });
});

test('daemon deduplicates auto and review candidates and suppresses unchanged review-ready output in one process', async () => {
  const issue = {
    number: 17, title: 'Issue', body: '', url: 'https://example.invalid/17', state: 'OPEN' as const,
    labels: [{ name: 'agent:auto' }, { name: 'agent:review' }], comments: [], closedByPullRequestsReferences: [],
  };
  const output: string[] = [];
  const calls: number[] = [];
  const lastResults = new Map<number, string>();
  let epoch = 'a'.repeat(40);
  const executeRun = async ({ issueNumber }: { targetRoot: string; issueNumber: number }) => {
    calls.push(issueNumber);
    return { status: 'review-ready' as const, pullRequestUrl: 'https://example.invalid/pr/1', evidencePath: 'evidence.json', continuationEpoch: epoch };
  };
  await executeDaemonCandidates({ targetRoot: '/tmp/target', candidates: [issue, structuredClone(issue)], executeRun, write: (text) => output.push(text), lastResults });
  await executeDaemonCandidates({ targetRoot: '/tmp/target', candidates: [issue], executeRun, write: (text) => output.push(text), lastResults });
  assert.deepEqual(calls, [17, 17]);
  assert.equal(output.length, 1);

  epoch = 'b'.repeat(40);
  await executeDaemonCandidates({ targetRoot: '/tmp/target', candidates: [issue], executeRun, write: (text) => output.push(text), lastResults });
  assert.equal(output.length, 2);

  const changed = async () => ({ status: 'blocked' as const, kind: 'safety' as const, resumable: false, evidencePath: 'blocked.json' });
  await executeDaemonCandidates({ targetRoot: '/tmp/target', candidates: [issue], executeRun: changed, write: (text) => output.push(text), lastResults });
  assert.equal(output.length, 3);
});

test('daemon releases a temporarily unavailable issue and resumes it after other candidates progress', async () => {
  const issue = (number: number) => ({
    number, title: `Issue ${number}`, body: '', url: `https://example.invalid/${number}`, state: 'OPEN' as const,
    labels: [{ name: 'agent:auto' }], comments: [], closedByPullRequestsReferences: [],
  });
  const calls: number[] = [];
  let firstIssueCalls = 0;
  const executeRun = async ({ issueNumber }: { targetRoot: string; issueNumber: number }) => {
    calls.push(issueNumber);
    if (issueNumber === 1 && firstIssueCalls++ === 0) {
      return { status: 'transport-failed' as const, resumable: true, evidencePath: 'service-down.json' };
    }
    return { status: 'review-ready' as const, pullRequestUrl: `https://example.invalid/pr/${issueNumber}`, evidencePath: 'ready.json' };
  };
  const lastResults = new Map<number, string>();
  await executeDaemonCandidates({ targetRoot: '/tmp/target', candidates: [issue(1), issue(2)], executeRun, write: () => {}, lastResults });
  await executeDaemonCandidates({ targetRoot: '/tmp/target', candidates: [issue(1)], executeRun, write: () => {}, lastResults });
  assert.deepEqual(calls, [1, 2, 1]);
});

test('continuous daemon retries fresh discovery after a failed tick without replaying stale candidates', async () => {
  const issue = {
    number: 17, title: 'Issue', body: '', url: 'https://example.invalid/17', state: 'OPEN' as const,
    labels: [{ name: 'agent:auto' }], comments: [], closedByPullRequestsReferences: [],
  };
  const discoveries: number[] = [];
  const runs: number[] = [];
  const delayArguments: number[] = [];
  let delays = 0;

  await assert.rejects(executeDaemonLoop({ targetRoot: '/tmp/target', once: false }, () => {}, {
    discover: async () => {
      discoveries.push(discoveries.length + 1);
      if (discoveries.length === 1) throw new Error('temporary discovery failure');
      return [issue];
    },
    executeRun: async ({ issueNumber }) => {
      runs.push(issueNumber);
      return { status: 'not-eligible' as const, reason: 'fixture', evidencePath: 'not-eligible.json' };
    },
    delay: async (milliseconds) => {
      delayArguments.push(milliseconds);
      delays += 1;
      if (delays === 2) throw new Error('stop fixture');
    },
    pollIntervalMilliseconds: 123,
  }), /stop fixture/u);

  assert.deepEqual(discoveries, [1, 2]);
  assert.deepEqual(runs, [17]);
  assert.equal(delays, 2);
  assert.deepEqual(delayArguments, [123, 123]);
});

test('daemon isolates thrown candidate failures and returns the greatest observed severity', async () => {
  const issue = (number: number) => ({
    number, title: `Issue ${number}`, body: '', url: `https://example.invalid/${number}`, state: 'OPEN' as const,
    labels: [{ name: 'agent:auto' }], comments: [], closedByPullRequestsReferences: [],
  });
  const calls: number[] = [];
  const exit = await executeDaemonCandidates({
    targetRoot: '/tmp/target',
    candidates: [issue(1), issue(2), issue(3)],
    executeRun: async ({ issueNumber }) => {
      calls.push(issueNumber);
      if (issueNumber === 1) throw new Error('candidate failed');
      if (issueNumber === 2) return { status: 'blocked', kind: 'safety', resumable: false, evidencePath: 'blocked.json' };
      return { status: 'cancelled', evidencePath: 'cancelled.json' };
    },
    write: () => {},
    lastResults: new Map(),
  });

  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(exit, 130);
});

test('daemon keeps completed severity and later candidates when output fails', async () => {
  const issue = (number: number) => ({
    number, title: `Issue ${number}`, body: '', url: `https://example.invalid/${number}`, state: 'OPEN' as const,
    labels: [{ name: 'agent:auto' }], comments: [], closedByPullRequestsReferences: [],
  });
  const calls: number[] = [];
  const exit = await executeDaemonCandidates({
    targetRoot: '/tmp/target', candidates: [issue(1), issue(2), issue(3)], lastResults: new Map(),
    executeRun: async ({ issueNumber }) => {
      calls.push(issueNumber);
      if (issueNumber === 2) throw new Error('candidate failed');
      return { status: 'blocked' as const, kind: 'safety' as const, resumable: false, evidencePath: 'blocked.json' };
    },
    write: () => { throw new Error('stdout unavailable'); },
  });

  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(exit, 70);
});

test('daemon loop never relabels candidate or output failures as discovery failure', async () => {
  const issue = (number: number) => ({
    number, title: `Issue ${number}`, body: '', url: `https://example.invalid/${number}`, state: 'OPEN' as const,
    labels: [{ name: 'agent:auto' }], comments: [], closedByPullRequestsReferences: [],
  });
  const calls: number[] = [];
  const writes: string[] = [];
  const exit = await executeDaemonLoop({ targetRoot: '/tmp/target', once: true }, (text) => {
    writes.push(text);
    throw new Error('stdout unavailable');
  }, {
    discover: async () => [issue(1), issue(2), issue(3)],
    executeRun: async ({ issueNumber }) => {
      calls.push(issueNumber);
      if (issueNumber === 1) return { status: 'cancelled' as const, evidencePath: 'cancelled.json' };
      if (issueNumber === 2) throw new Error('candidate failed');
      return { status: 'blocked' as const, kind: 'safety' as const, resumable: false, evidencePath: 'blocked.json' };
    },
    delay: async () => { throw new Error('once must not delay'); },
    pollIntervalMilliseconds: 123,
  });

  assert.equal(exit, 130);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(writes.some((text) => text.startsWith('daemon discovery failed:')), false);
});

test('--once performs one fresh discovery and one serial pass without delaying', async () => {
  const issue = (number: number) => ({
    number, title: `Issue ${number}`, body: '', url: `https://example.invalid/${number}`, state: 'OPEN' as const,
    labels: [{ name: 'agent:auto' }], comments: [], closedByPullRequestsReferences: [],
  });
  let discoveries = 0;
  let delays = 0;
  const calls: number[] = [];
  const exit = await executeDaemonLoop({ targetRoot: '/tmp/target', once: true }, () => {}, {
    discover: async () => { discoveries += 1; return [issue(2), issue(1)]; },
    executeRun: async ({ issueNumber }) => {
      calls.push(issueNumber);
      return { status: 'not-eligible' as const, reason: 'fixture', evidencePath: 'not-eligible.json' };
    },
    delay: async () => { delays += 1; },
    pollIntervalMilliseconds: 123,
  });

  assert.equal(exit, 21);
  assert.equal(discoveries, 1);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(delays, 0);
});

test('CLI delegates setup, doctor, and status policy to Setup and renders its typed result', async () => {
  for (const command of ['setup', 'doctor', 'status'] as const) {
    const output: string[] = [];
    const argv = command === 'setup'
      ? ['setup', '--target', '/tmp/target', '--prepare-labels']
      : [command, '--target', '/tmp/target'];
    const exit = await runCli(argv, {
      executeSetup: async (intent) => {
        assert.equal(intent.targetRoot, '/tmp/target');
        assert.equal(intent.operation, command === 'setup' ? 'prepare-labels' : command);
        return { status: 'inspected', disposition: 'blocked', diagnostics: [] };
      },
      write: (text) => { output.push(text); },
    });
    assert.equal(exit, 20);
    assert.deepEqual(JSON.parse(output.join('')), {
      schema: 'codex-orchestrator.agent-auto-setup-result', version: 1,
      result: { status: 'inspected', disposition: 'blocked', diagnostics: [] },
    });
  }
});

test('CLI help and version are side-effect free', async () => {
  const output: string[] = [];
  assert.equal(await runCli(['--help'], { write: (text) => { output.push(text); } }), 0);
  assert.match(output.pop() ?? '', /^codex-orchestrator\n/m);
  assert.equal(await runCli(['--version'], { packageVersion: '9.8.7', write: (text) => { output.push(text); } }), 0);
  assert.equal(output.pop(), '9.8.7\n');
});
