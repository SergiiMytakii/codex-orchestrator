import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  isDirectCliExecution,
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
