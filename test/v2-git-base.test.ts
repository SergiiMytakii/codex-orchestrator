import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { LocalGitRunIssueAdapter } from '../src/v2/runtime.js';
import { mkdtemp } from './mission-test-temp.js';

const execFileAsync = promisify(execFile);

test('new runs resolve the configured base from a fresh remote branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-git-base-'));
  const remoteRoot = join(root, 'remote.git');
  const publisherRoot = join(root, 'publisher');
  const targetRoot = join(root, 'target');
  await execFileAsync('git', ['init', '--bare', '-q', remoteRoot]);
  await execFileAsync('git', ['init', '-q', '-b', 'dev', publisherRoot]);
  await writeFile(join(publisherRoot, 'fixture.txt'), 'one\n');
  await execFileAsync('git', ['-C', publisherRoot, 'add', 'fixture.txt']);
  await execFileAsync('git', ['-C', publisherRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'one']);
  await execFileAsync('git', ['-C', publisherRoot, 'remote', 'add', 'origin', remoteRoot]);
  await execFileAsync('git', ['-C', publisherRoot, 'push', '-u', 'origin', 'dev']);
  await execFileAsync('git', ['clone', '-q', '--branch', 'dev', remoteRoot, targetRoot]);
  const staleLocalSha = (await execFileAsync('git', ['-C', targetRoot, 'rev-parse', 'dev'])).stdout.trim();

  await writeFile(join(publisherRoot, 'fixture.txt'), 'two\n');
  await execFileAsync('git', ['-C', publisherRoot, 'add', 'fixture.txt']);
  await execFileAsync('git', ['-C', publisherRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'two']);
  await execFileAsync('git', ['-C', publisherRoot, 'push', 'origin', 'dev']);
  const remoteSha = (await execFileAsync('git', ['-C', publisherRoot, 'rev-parse', 'dev'])).stdout.trim();

  const adapter = new LocalGitRunIssueAdapter();
  assert.notEqual(staleLocalSha, remoteSha);
  assert.equal(await adapter.getBaseSha({ targetRoot, baseBranch: 'dev' }), remoteSha);
});

test('issue worktrees are created from the pinned base SHA instead of a moving branch ref', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-pinned-base-'));
  const targetRoot = join(root, 'target');
  const worktreePath = join(root, 'worktree');
  await mkdir(targetRoot);
  await execFileAsync('git', ['init', '-q', '-b', 'dev', targetRoot]);
  await writeFile(join(targetRoot, 'fixture.txt'), 'one\n');
  await execFileAsync('git', ['-C', targetRoot, 'add', 'fixture.txt']);
  await execFileAsync('git', ['-C', targetRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'one']);
  const pinnedSha = (await execFileAsync('git', ['-C', targetRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(targetRoot, 'fixture.txt'), 'two\n');
  await execFileAsync('git', ['-C', targetRoot, 'add', 'fixture.txt']);
  await execFileAsync('git', ['-C', targetRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'two']);

  const adapter = new LocalGitRunIssueAdapter();
  await adapter.createWorktree({
    targetRoot,
    worktreePath,
    branchName: 'codex/issue-1',
    baseBranch: 'dev',
    baseSha: pinnedSha,
  });
  assert.equal((await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])).stdout.trim(), pinnedSha);
});
