import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCandidateRunArgs, runCandidateCli } from '../src/v2/candidate-cli.js';

test('candidate CLI accepts only one exact direct run intent', () => {
  assert.deepEqual(parseCandidateRunArgs(['run', '--target', '/tmp/target', '--issue', '17']), {
    targetRoot: '/tmp/target', issueNumber: 17,
  });
  for (const argv of [
    [], ['run'], ['run', '--target', 'relative', '--issue', '1'], ['run', '--target', '/tmp/x'],
    ['run', '--target', '/tmp/x', '--issue', '0'], ['run', '--target', '/tmp/x', '--issue', '1', '--json'],
    ['daemon', '--target', '/tmp/x'],
  ]) assert.throws(() => parseCandidateRunArgs(argv));
});

test('candidate CLI renders only the typed runIssue outcome and matching exit', async () => {
  const output: string[] = [];
  const exit = await runCandidateCli(['run', '--target', '/tmp/target', '--issue', '17'], {
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

test('candidate CLI delegates setup, doctor, and status policy to Setup and renders its typed result', async () => {
  for (const command of ['setup', 'doctor', 'status'] as const) {
    const output: string[] = [];
    const argv = command === 'setup'
      ? ['setup', '--target', '/tmp/target', '--prepare-labels']
      : [command, '--target', '/tmp/target'];
    const exit = await runCandidateCli(argv, {
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

test('candidate CLI help and version are side-effect free', async () => {
  const output: string[] = [];
  assert.equal(await runCandidateCli(['--help'], { write: (text) => { output.push(text); } }), 0);
  assert.match(output.pop() ?? '', /V2 candidate/);
  assert.equal(await runCandidateCli(['--version'], { packageVersion: '9.8.7', write: (text) => { output.push(text); } }), 0);
  assert.equal(output.pop(), '9.8.7\n');
});
