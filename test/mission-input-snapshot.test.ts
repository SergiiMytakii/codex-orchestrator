import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { mkdtemp } from './mission-test-temp.js';

import { MissionGitInputSnapshotVerifier } from '../src/runner/mission-input-snapshot.js';
import type { MissionProcessInput } from '../src/runner/mission-process-executor.js';

const execFileAsync = promisify(execFile);

test('Git input snapshot verifier rejects malformed, dirty, and moved workspaces', async (context) => {
  if (process.platform !== 'darwin') {
    context.skip('Active Linux Mission snapshot verification remains fail-closed until bwrap probe support.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'mission-input-snapshot-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-input-snapshot-q-'));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.email', 'mission@example.invalid']);
  await git(root, ['config', 'user.name', 'Mission Test']);
  await writeFile(join(root, 'value.txt'), 'one', 'utf8');
  await git(root, ['add', 'value.txt']);
  await git(root, ['commit', '-qm', 'initial']);
  const tree = (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
  const gitExecutable = (await execFileAsync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' })).stdout.trim();
  const verifier = new MissionGitInputSnapshotVerifier({
    workspaceRoot: root, quarantineRoot: quarantine, backend: 'macos-sandbox', gitExecutable,
  });

  await verifier.verify(`tree:${tree}`);
  await assert.rejects(verifier.verify('tree:abc'), /full Git tree object id/);
  await writeFile(join(root, 'value.txt'), 'two', 'utf8');
  await assert.rejects(verifier.verify(`tree:${tree}`), /no longer matches/);
});

test('Git input snapshot verifier uses bounded credential-free no-lock commands', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Mission executor capability probe rejects Windows in v1.');
    return;
  }
  const tree = 'a'.repeat(40);
  const calls: MissionProcessInput[] = [];
  const root = await mkdtemp(join(tmpdir(), 'mission-input-snapshot-bounded-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-input-snapshot-bounded-q-'));
  const backend = process.platform === 'darwin' ? 'macos-sandbox' : 'linux-bwrap';
  const gitExecutable = process.platform === 'darwin'
    ? (await execFileAsync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' })).stdout.trim()
    : '/usr/bin/git';
  const verifier = new MissionGitInputSnapshotVerifier({
    workspaceRoot: root,
    quarantineRoot: quarantine,
    backend,
    gitExecutable,
  }, async (input) => {
    calls.push(input);
    return {
      stdout: input.args.includes('rev-parse') ? `${tree}\n` : '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      termination: 'exited',
    };
  }, 1_234);

  await verifier.verify(`tree:${tree}`);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.timeoutMs, 1_234);
    assert.equal(call.maxOutputBytes, 1024 * 1024);
    assert.deepEqual(call.allowedEnvKeys, ['PATH']);
    assert.deepEqual(Object.keys(call.sourceEnv), ['PATH']);
    assert.equal(call.args.includes('--no-optional-locks'), true);
    if (backend === 'macos-sandbox') {
      assert.equal(call.file, '/usr/bin/sandbox-exec');
      assert.match(call.args[1] ?? '', /deny network/);
    } else {
      assert.equal(call.file, '/usr/bin/bwrap');
      assert.equal(call.args.includes('--unshare-net'), true);
    }
  }
});

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' })).stdout;
}
