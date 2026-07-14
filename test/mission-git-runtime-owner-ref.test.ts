import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitRuntimeOwnerRefAdapter } from '../src/runner/mission-git-runtime-owner-ref.js';
import type { ProcessExecutor } from '../src/process/command.js';
import type { RuntimeOwnerRecord } from '../src/runner/mission-runtime-owner.js';

const record: RuntimeOwnerRecord = {
  version: 1,
  repository: 'SergiiMytakii/codex-orchestrator',
  deploymentId: 'deployment-a',
  githubAppInstallationId: '12345',
  credentialGeneration: 'generation-1',
  compatibilityEpoch: 1,
  deploymentRecordHash: `sha256:${'a'.repeat(64)}`,
  approvedByCommit: 'b'.repeat(40),
  fencingEpoch: 1,
};

test('git runtime-owner adapter publishes with exact force-with-lease and re-reads', async () => {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  let published = false;
  const commitSha = '4'.repeat(40);
  const executor: ProcessExecutor = async (_file, args, options) => {
    calls.push({ args, stdin: options?.stdin });
    if (args[0] === 'ls-remote') {
      return published
        ? { stdout: `${commitSha}\trefs/codex-orchestrator/runtime-owner-v1\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'fetch' || args[0] === 'update-ref') return { stdout: '', stderr: '', exitCode: 0 };
    if (args[0] === 'rev-parse') return { stdout: `${commitSha}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'hash-object') return { stdout: `${'1'.repeat(40)}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'mktree') return { stdout: `${'2'.repeat(40)}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'commit-tree') return { stdout: `${commitSha}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'push') {
      published = true;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'show') return { stdout: JSON.stringify(record), stderr: '', exitCode: 0 };
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  };
  const adapter = new GitRuntimeOwnerRefAdapter('/repo', executor);

  const result = await adapter.compareAndSwap(undefined, record);
  assert.equal(result.sha, commitSha);
  assert.equal(calls.some(({ args }) => args[0] === 'push'
    && args.includes('--force-with-lease=refs/codex-orchestrator/runtime-owner-v1:')), true);
  assert.equal(calls.find(({ args }) => args[0] === 'hash-object')?.stdin, JSON.stringify(record));
});

test('git runtime-owner adapter rejects ambiguous refs and failed CAS', async () => {
  const ambiguous: ProcessExecutor = async () => ({
    stdout: `${'1'.repeat(40)}\trefs/codex-orchestrator/runtime-owner-v1\n${'2'.repeat(40)}\trefs/codex-orchestrator/runtime-owner-v1\n`,
    stderr: '',
    exitCode: 0,
  });
  await assert.rejects(new GitRuntimeOwnerRefAdapter('/repo', ambiguous).read(), /ambiguous/);

  const failed: ProcessExecutor = async (_file, args) => {
    if (args[0] === 'hash-object') return { stdout: `${'1'.repeat(40)}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'mktree') return { stdout: `${'2'.repeat(40)}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'commit-tree') return { stdout: `${'3'.repeat(40)}\n`, stderr: '', exitCode: 0 };
    return { stdout: '', stderr: 'stale info', exitCode: 1 };
  };
  await assert.rejects(
    new GitRuntimeOwnerRefAdapter('/repo', failed).compareAndSwap('9'.repeat(40), record),
    /compare-and-swap failed/,
  );
});

test('git runtime-owner adapter reconciles a lost successful push response', async () => {
  const commitSha = '4'.repeat(40);
  let published = false;
  const executor: ProcessExecutor = async (_file, args) => {
    if (args[0] === 'hash-object') return { stdout: `${'1'.repeat(40)}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'mktree') return { stdout: `${'2'.repeat(40)}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'commit-tree') return { stdout: `${commitSha}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'push') {
      published = true;
      return { stdout: '', stderr: 'connection closed after receive', exitCode: 1 };
    }
    if (args[0] === 'ls-remote') return {
      stdout: published ? `${commitSha}\trefs/codex-orchestrator/runtime-owner-v1\n` : '',
      stderr: '',
      exitCode: 0,
    };
    if (args[0] === 'fetch' || args[0] === 'update-ref') return { stdout: '', stderr: '', exitCode: 0 };
    if (args[0] === 'rev-parse') return { stdout: `${commitSha}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'show') return { stdout: JSON.stringify(record), stderr: '', exitCode: 0 };
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  };

  assert.equal((await new GitRuntimeOwnerRefAdapter('/repo', executor)
    .compareAndSwap(undefined, record)).sha, commitSha);
});

test('git runtime-owner adapter fetches an unseen owner object before parsing', async () => {
  const sha = '4'.repeat(40);
  let fetched = false;
  const calls: string[][] = [];
  const executor: ProcessExecutor = async (_file, args) => {
    calls.push(args);
    if (args[0] === 'ls-remote') return {
      stdout: `${sha}\trefs/codex-orchestrator/runtime-owner-v1\n`,
      stderr: '',
      exitCode: 0,
    };
    if (args[0] === 'fetch') {
      fetched = true;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'rev-parse') return { stdout: `${sha}\n`, stderr: '', exitCode: 0 };
    if (args[0] === 'show' && fetched) return { stdout: JSON.stringify(record), stderr: '', exitCode: 0 };
    if (args[0] === 'update-ref') return { stdout: '', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: 'object is not present locally', exitCode: 128 };
  };

  assert.equal((await new GitRuntimeOwnerRefAdapter('/fresh-clone', executor).read())?.sha, sha);
  assert.equal(calls.some((args) => args[0] === 'fetch'
    && args.some((arg) => arg.startsWith('+refs/codex-orchestrator/runtime-owner-v1:refs/codex-orchestrator/observed/'))), true);
});
