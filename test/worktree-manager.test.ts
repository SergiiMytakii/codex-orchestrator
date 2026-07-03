import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { GitMergeConflictError, GitWorktreeManager } from '../src/git/worktree.js';
import type { ProcessExecutor } from '../src/process/command.js';

const execFileAsync = promisify(execFile);

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

test('createIssueWorktree disables branch tracking setup to avoid git config lock races', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-worktree-args-'));
  const repo = join(root, 'repo');
  const worktreePath = join(root, 'worktrees', 'issue-18');
  const calls: string[][] = [];
  const executor: ProcessExecutor = async (_file, args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const git = new GitWorktreeManager(executor);

  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-18',
    baseBranch: 'main',
  });

  assert.deepEqual(calls[0], [
    '-C',
    repo,
    'worktree',
    'add',
    '--no-track',
    '-b',
    'codex/issue-18',
    worktreePath,
    'main',
  ]);
});

test('listChangedFiles normalizes porcelain rename paths through shared path policy', async () => {
  const executor: ProcessExecutor = async () => ({
    stdout: 'R  .\\src\\old.ts\0.\\src\\new.ts\0C  .\\docs\\old.md\0.\\docs\\new.md\0',
    stderr: '',
    exitCode: 0,
  });
  const git = new GitWorktreeManager(executor);

  assert.deepEqual(await git.listChangedFiles('/repo/worktree'), [
    'src/old.ts',
    'src/new.ts',
    'docs/old.md',
    'docs/new.md',
  ]);
});

test('collectSessionChangeSet normalizes and sorts committed plus working paths through shared path policy', async () => {
  const executor: ProcessExecutor = async (_file, args) => {
    if (args.includes('diff')) {
      return { stdout: '.\\src\\z.ts\0.\\src\\a.ts\0', stderr: '', exitCode: 0 };
    }
    if (args.includes('status')) {
      return { stdout: ' M .\\src\\z.ts\0?? .\\test\\z.test.ts\0', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const git = new GitWorktreeManager(executor);

  const changeSet = await git.collectSessionChangeSet({ worktreePath: '/repo/worktree', baseHead: 'base' });

  assert.deepEqual(changeSet.changedPaths, [
    'src/a.ts',
    'src/z.ts',
    'test/z.test.ts',
  ]);
  assert.equal(changeSet.hasChanges, true);
});

test('collectSessionChangeSet reports committed-only session changes', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const worktreePath = join(root, 'issue-12');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-12',
    baseBranch: 'main',
  });
  const baseHead = await git.getHead(worktreePath);
  await writeFile(join(worktreePath, 'committed.txt'), 'committed\n', 'utf8');
  await git.commitAll({ worktreePath, message: 'Agent checkpoint' });

  const changeSet = await git.collectSessionChangeSet({ worktreePath, baseHead });

  assert.equal(changeSet.hasChanges, true);
  assert.deepEqual(changeSet.changedPaths, ['committed.txt']);
  assert.equal(changeSet.commits.length, 1);
  assert.equal(changeSet.commits[0]?.subject, 'Agent checkpoint');
});

test('collectSessionChangeSet reports committed, staged, unstaged, and untracked paths together', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const worktreePath = join(root, 'issue-12');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-12',
    baseBranch: 'main',
  });
  await writeFile(join(worktreePath, 'tracked.txt'), 'before\n', 'utf8');
  await git.commitAll({ worktreePath, message: 'Add tracked file' });
  const baseHead = await git.getHead(worktreePath);
  await writeFile(join(worktreePath, 'committed.txt'), 'committed\n', 'utf8');
  await git.commitAll({ worktreePath, message: 'Agent checkpoint' });
  await writeFile(join(worktreePath, 'staged.txt'), 'staged\n', 'utf8');
  await execFileAsync('git', ['-C', worktreePath, 'add', 'staged.txt']);
  await writeFile(join(worktreePath, 'tracked.txt'), 'after\n', 'utf8');
  await writeFile(join(worktreePath, 'untracked.txt'), 'untracked\n', 'utf8');

  const changeSet = await git.collectSessionChangeSet({ worktreePath, baseHead });

  assert.equal(changeSet.hasChanges, true);
  assert.deepEqual(changeSet.changedPaths, ['committed.txt', 'staged.txt', 'tracked.txt', 'untracked.txt']);
  assert.equal(changeSet.commits.length, 1);
});

async function tempGitProject(): Promise<{ root: string; repo: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-worktree-'));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  await execFileAsync('git', ['init', '--bare', remote]);
  await execFileAsync('git', ['init', '-b', 'main', repo]);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(repo, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'Initial']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  await execFileAsync('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
  return { root, repo, remote };
}

function canonicalTestPath(path: string): string {
  return path.startsWith('/private/') ? path.slice('/private'.length) : path;
}

test('mergeBranch creates a no-ff merge commit that can be pushed from parent worktree', async () => {
  const { root, repo, remote } = await tempGitProject();
  const git = new GitWorktreeManager();
  const parent = join(root, 'parent');
  const child = join(root, 'child');
  await git.createIssueWorktree({ targetRoot: repo, workspacePath: parent, branchName: 'codex/tree-1', baseBranch: 'main' });
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: child,
    branchName: 'codex/tree-1-issue-2',
    baseBranch: 'codex/tree-1',
  });
  await writeFile(join(child, 'child.txt'), 'done\n', 'utf8');
  await git.commitAll({ worktreePath: child, message: 'Codex: implement issue #2 for parent #1' });

  await git.mergeBranch({
    worktreePath: parent,
    branchName: 'codex/tree-1-issue-2',
    message: 'Codex: merge issue #2 into parent #1',
  });
  await git.pushBranch({ worktreePath: parent, branchName: 'codex/tree-1' });

  const log = await execFileAsync('git', ['--git-dir', remote, 'log', '--oneline', 'codex/tree-1', '-1']);
  assert.match(log.stdout, /Codex: merge issue #2 into parent #1/);
});

test('createIssueWorktree removes clean merged stale branch worktree before retrying', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const stale = join(root, 'issue-1');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: stale,
    branchName: 'codex/issue-1',
    baseBranch: 'main',
  });
  await writeFile(join(stale, 'feature.txt'), 'done\n', 'utf8');
  await git.commitAll({ worktreePath: stale, message: 'Codex: implement issue #1' });
  await execFileAsync('git', ['-C', repo, 'merge', '--no-ff', 'codex/issue-1', '-m', 'Merge issue #1']);

  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: stale,
    branchName: 'codex/issue-1',
    baseBranch: 'main',
  });

  const branch = await execFileAsync('git', ['-C', stale, 'branch', '--show-current']);
  const status = await execFileAsync('git', ['-C', stale, 'status', '--porcelain']);
  assert.equal(branch.stdout.trim(), 'codex/issue-1');
  assert.equal(status.stdout, '');
});

test('createIssueWorktree refuses to remove dirty stale branch worktree', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const stale = join(root, 'issue-1');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: stale,
    branchName: 'codex/issue-1',
    baseBranch: 'main',
  });
  await writeFile(join(stale, 'feature.txt'), 'done\n', 'utf8');
  await git.commitAll({ worktreePath: stale, message: 'Codex: implement issue #1' });
  await execFileAsync('git', ['-C', repo, 'merge', '--no-ff', 'codex/issue-1', '-m', 'Merge issue #1']);
  await writeFile(join(stale, 'dirty.txt'), 'dirty\n', 'utf8');

  await assert.rejects(
    git.createIssueWorktree({
      targetRoot: repo,
      workspacePath: stale,
      branchName: 'codex/issue-1',
      baseBranch: 'main',
    }),
    /has uncommitted changes/,
  );
});

test('ensureIssueWorktree reuses existing clean same-issue worktree', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const worktreePath = join(root, 'issue-1');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-1',
    baseBranch: 'main',
  });

  await git.ensureIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-1',
    baseBranch: 'main',
    allowResume: true,
  });

  const branch = await execFileAsync('git', ['-C', worktreePath, 'branch', '--show-current']);
  const status = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain']);
  assert.equal(branch.stdout.trim(), 'codex/issue-1');
  assert.equal(status.stdout, '');
});

test('ensureIssueWorktree reuses existing dirty same-issue worktree', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const worktreePath = join(root, 'issue-1');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-1',
    baseBranch: 'main',
  });
  await writeFile(join(worktreePath, 'dirty.txt'), 'continue me\n', 'utf8');

  await git.ensureIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-1',
    baseBranch: 'main',
    allowResume: true,
  });

  const branch = await execFileAsync('git', ['-C', worktreePath, 'branch', '--show-current']);
  const status = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain']);
  assert.equal(branch.stdout.trim(), 'codex/issue-1');
  assert.match(status.stdout, /\?\? dirty\.txt/);
});

test('ensureIssueWorktree attaches existing unmerged branch without deleting it', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const temporaryWorktree = join(root, 'temporary-issue-1');
  const resumedWorktree = join(root, 'issue-1');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: temporaryWorktree,
    branchName: 'codex/issue-1',
    baseBranch: 'main',
  });
  await writeFile(join(temporaryWorktree, 'feature.txt'), 'done\n', 'utf8');
  await git.commitAll({ worktreePath: temporaryWorktree, message: 'Codex: implement issue #1' });
  await git.removeWorktree({ targetRoot: repo, worktreePath: temporaryWorktree });

  await git.ensureIssueWorktree({
    targetRoot: repo,
    workspacePath: resumedWorktree,
    branchName: 'codex/issue-1',
    baseBranch: 'main',
    allowResume: true,
  });

  const branch = await execFileAsync('git', ['-C', resumedWorktree, 'branch', '--show-current']);
  assert.equal(branch.stdout.trim(), 'codex/issue-1');
  assert.equal(await readFile(join(resumedWorktree, 'feature.txt'), 'utf8'), 'done\n');
});

test('ensureIssueWorktree refuses unrelated dirty worktree at expected workspace path', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const worktreePath = join(root, 'issue-1');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-2',
    baseBranch: 'main',
  });
  await writeFile(join(worktreePath, 'dirty.txt'), 'do not remove\n', 'utf8');

  await assert.rejects(
    git.ensureIssueWorktree({
      targetRoot: repo,
      workspacePath: worktreePath,
      branchName: 'codex/issue-1',
      baseBranch: 'main',
      allowResume: true,
    }),
    /belongs to refs\/heads\/codex\/issue-2/,
  );
});

test('ensureIssueWorktree resumes the existing same-issue worktree even when configured base moved forward', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const wrongBase = await git.getHead(repo);
  await writeFile(join(repo, 'new-base.txt'), 'new base\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'new-base.txt']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'New configured base']);
  const configuredBase = await git.getHead(repo);
  const worktreePath = join(root, 'issue-1');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-1',
    baseBranch: wrongBase,
  });

  await writeFile(join(worktreePath, 'dirty.txt'), 'continue in place\n', 'utf8');

  await git.ensureIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-1',
    baseBranch: configuredBase,
    requiredBaseSha: configuredBase,
    allowResume: true,
  });

  const branch = await execFileAsync('git', ['-C', worktreePath, 'branch', '--show-current']);
  const status = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain']);
  assert.equal(branch.stdout.trim(), 'codex/issue-1');
  assert.match(status.stdout, /\?\? dirty\.txt/);
});

test('ensureIssueWorktree refuses to attach an existing branch that does not contain the configured base sha', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const wrongBase = await git.getHead(repo);
  await writeFile(join(repo, 'new-base.txt'), 'new base\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'new-base.txt']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'New configured base']);
  const configuredBase = await git.getHead(repo);
  const temporaryWorktree = join(root, 'temporary-issue-1');
  const resumedWorktree = join(root, 'issue-1');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: temporaryWorktree,
    branchName: 'codex/issue-1',
    baseBranch: wrongBase,
  });
  await git.removeWorktree({ targetRoot: repo, worktreePath: temporaryWorktree });

  await assert.rejects(
    git.ensureIssueWorktree({
      targetRoot: repo,
      workspacePath: resumedWorktree,
      branchName: 'codex/issue-1',
      baseBranch: configuredBase,
      requiredBaseSha: configuredBase,
      allowResume: true,
    }),
    /was created from a different base/,
  );
});

test('branch query helpers report branch existence, base containment, and merge ancestry without mutation', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const baseSha = await git.getHead(repo);
  const parent = join(root, 'parent');
  const child = join(root, 'child');
  await git.createIssueWorktree({ targetRoot: repo, workspacePath: parent, branchName: 'codex/tree-1', baseBranch: 'main' });
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: child,
    branchName: 'codex/tree-1-issue-2',
    baseBranch: 'codex/tree-1',
  });
  await writeFile(join(child, 'child.txt'), 'done\n', 'utf8');
  await git.commitAll({ worktreePath: child, message: 'Codex: implement issue #2 for parent #1' });

  assert.equal(await git.branchExists(repo, 'codex/tree-1'), true);
  assert.equal(await git.branchExists(repo, 'codex/missing'), false);
  assert.equal(await git.branchContainsCommit(repo, 'codex/tree-1', baseSha), true);
  assert.equal(await git.isBranchAncestorOf(repo, 'codex/tree-1', 'codex/tree-1-issue-2'), true);
  assert.equal(await git.isBranchAncestorOf(repo, 'codex/tree-1-issue-2', 'codex/tree-1'), false);
  assert.deepEqual(
    (await git.listWorktrees(repo)).map((worktree) => canonicalTestPath(worktree.path)).sort(),
    [child, parent, repo].map(canonicalTestPath).sort(),
  );
});

test('mergeBranch throws GitMergeConflictError and abortMerge cleans the merge state', async () => {
  const { root, repo } = await tempGitProject();
  const git = new GitWorktreeManager();
  const parent = join(root, 'parent');
  const child = join(root, 'child');
  await git.createIssueWorktree({ targetRoot: repo, workspacePath: parent, branchName: 'codex/tree-1', baseBranch: 'main' });
  await writeFile(join(parent, 'conflict.txt'), 'parent\n', 'utf8');
  await git.commitAll({ worktreePath: parent, message: 'parent change' });
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: child,
    branchName: 'codex/tree-1-issue-2',
    baseBranch: 'main',
  });
  await writeFile(join(child, 'conflict.txt'), 'child\n', 'utf8');
  await git.commitAll({ worktreePath: child, message: 'child change' });

  await assert.rejects(
    git.mergeBranch({
      worktreePath: parent,
      branchName: 'codex/tree-1-issue-2',
      message: 'Codex: merge issue #2 into parent #1',
    }),
    (error) => error instanceof GitMergeConflictError && error.branchName === 'codex/tree-1-issue-2',
  );

  await git.abortMerge(parent);
  const status = await execFileAsync('git', ['-C', parent, 'status', '--porcelain']);
  assert.equal(status.stdout, '');
});

test('removeWorktree uses git worktree remove from target root', async () => {
  const calls: string[][] = [];
  const executor: ProcessExecutor = async (_file, args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const git = new GitWorktreeManager(executor);

  await git.removeWorktree({ targetRoot: '/repo', worktreePath: '/repo/.codex-orchestrator/workspaces/child' });

  assert.deepEqual(calls[0], [
    '-C',
    '/repo',
    'worktree',
    'remove',
    '/repo/.codex-orchestrator/workspaces/child',
  ]);
});
