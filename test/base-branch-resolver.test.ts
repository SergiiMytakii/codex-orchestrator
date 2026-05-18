import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveBaseBranch } from '../src/git/base-branch.js';
import type { ProcessExecutor } from '../src/process/command.js';

test('resolves explicit base branch through a fetched remote ref', async () => {
  const calls: string[][] = [];
  const executor: ProcessExecutor = async (_file, args) => {
    calls.push(args);
    if (args.includes('fetch')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args.includes('show-ref')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args.includes('rev-parse')) {
      return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 1 };
  };

  const result = await resolveBaseBranch({
    targetRoot: '/repo',
    base: { mode: 'explicit', remote: 'origin', branch: 'sirbro-dev' },
    executor,
  });

  assert.deepEqual(calls[0], ['-C', '/repo', 'fetch', 'origin', '--prune']);
  assert.deepEqual(result, {
    mode: 'explicit',
    remote: 'origin',
    branch: 'sirbro-dev',
    remoteRef: 'refs/remotes/origin/sirbro-dev',
    sha: 'abc123',
    prBaseBranch: 'sirbro-dev',
    legacy: false,
  });
});

test('resolves legacy string base branch as origin branch', async () => {
  const executor: ProcessExecutor = async (_file, args) => {
    if (args.includes('rev-parse')) {
      return { stdout: 'def456\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  const result = await resolveBaseBranch({
    targetRoot: '/repo',
    base: 'main',
    executor,
  });

  assert.equal(result.remoteRef, 'refs/remotes/origin/main');
  assert.equal(result.sha, 'def456');
  assert.equal(result.legacy, true);
});

test('fails with a clear error when the configured remote base is missing', async () => {
  const executor: ProcessExecutor = async (_file, args) => {
    if (args.includes('fetch')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 1 };
  };

  await assert.rejects(
    resolveBaseBranch({
      targetRoot: '/repo',
      base: { mode: 'explicit', remote: 'origin', branch: 'sirbro-dev' },
      executor,
    }),
    /Configured base branch origin\/sirbro-dev was not found/,
  );
});
