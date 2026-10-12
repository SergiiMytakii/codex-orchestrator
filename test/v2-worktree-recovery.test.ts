import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitWorktreeManager } from '../src/v2/adapters/worktree.js';
import { defaultProcessExecutor } from '../src/v2/adapters/command.js';

async function git(root: string, ...args: string[]) {
  const result = await defaultProcessExecutor('git', ['-C', root, ...args], { timeoutMs: 10_000, processGroup: true });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

test('a merged branch collision preserves a materialization whose run ownership is unknown', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'v2-worktree-preserve-')));
  try {
    await git(root, 'init', '-b', 'main');
    await git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'base');
    const existing = join(root, 'existing');
    await git(root, 'worktree', 'add', '-b', 'codex/issue-1', existing);
    const manager = new GitWorktreeManager();
    await assert.rejects(manager.createIssueWorktree({ targetRoot: root, workspacePath: join(root, 'replacement'), branchName: 'codex/issue-1', baseBranch: 'main' }), /confirmed ownership/);
    assert.equal(await manager.branchExists(root, 'codex/issue-1'), true);
    assert.ok((await manager.listWorktrees(root)).some((worktree) => worktree.path === existing));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worktree inspection returns after an owned Git command hangs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v2-worktree-deadline-'));
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const path = join(bin, 'git');
    await writeFile(path, '#!/bin/sh\n/bin/sleep 10\n');
    await chmod(path, 0o700);
    const manager = new GitWorktreeManager(defaultProcessExecutor, { timeoutMs: 40, env: { PATH: bin } });
    const started = Date.now();
    await assert.rejects(manager.getHead(root), /git command failed/);
    assert.ok(Date.now() - started < 4000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
