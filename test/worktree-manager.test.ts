import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitWorktreeManager } from '../src/git/worktree.js';
import type { ProcessExecutor } from '../src/process/command.js';

test('runner-owned commit and push disable git hooks', async () => {
  const calls: string[][] = [];
  const executor: ProcessExecutor = async (_file, args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const git = new GitWorktreeManager(executor);

  await git.commitAll({ worktreePath: '/repo/worktree', message: 'Codex: implement issue #155' });
  await git.pushBranch({ worktreePath: '/repo/worktree', branchName: 'codex/issue-155' });

  assert.deepEqual(calls[1], [
    '-C',
    '/repo/worktree',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=codex-orchestrator',
    '-c',
    'user.email=codex-orchestrator@users.noreply.github.com',
    'commit',
    '--no-verify',
    '-m',
    'Codex: implement issue #155',
  ]);
  assert.deepEqual(calls[2], [
    '-C',
    '/repo/worktree',
    '-c',
    'core.hooksPath=/dev/null',
    'push',
    '--no-verify',
    '-u',
    'origin',
    'codex/issue-155',
  ]);
});
