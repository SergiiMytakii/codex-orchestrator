import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { normalizePath, uniqueSortedPaths } from './path-policy.js';
import type { ProcessExecutor } from './command.js';
import { defaultProcessExecutor } from './command.js';

export interface BranchTemplateValues {
  issueNumber?: number;
  parentIssueNumber?: number;
}

export interface CreateIssueWorktreeInput {
  targetRoot: string;
  workspacePath: string;
  branchName: string;
  baseBranch: string;
  requiredBaseSha?: string;
}

export interface EnsureIssueWorktreeInput extends CreateIssueWorktreeInput {
  allowResume?: boolean;
}

export interface CommitAllInput {
  worktreePath: string;
  message: string;
}

export interface PushBranchInput {
  worktreePath: string;
  branchName: string;
}

export interface MergeBranchInput {
  worktreePath: string;
  branchName: string;
  message: string;
}

export interface RemoveWorktreeInput {
  targetRoot: string;
  worktreePath: string;
}

export interface GitWorktreeInfo {
  path: string;
  branch?: string;
}

export interface CollectSessionChangeSetInput {
  worktreePath: string;
  baseHead: string;
}

export interface SessionCommitInfo {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
}

export interface SessionChangeSet {
  changedPaths: string[];
  commits: SessionCommitInfo[];
  hasChanges: boolean;
}

export class GitMergeConflictError extends Error {
  public constructor(
    public readonly worktreePath: string,
    public readonly branchName: string,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`git merge failed for ${branchName} in ${worktreePath}`);
    this.name = 'GitMergeConflictError';
  }
}

export class GitWorktreeManager {
  public constructor(private readonly executor: ProcessExecutor = defaultProcessExecutor) {}

  public async getHead(worktreePath: string): Promise<string> {
    const result = await this.git(['-C', worktreePath, 'rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  public async createIssueWorktree(input: CreateIssueWorktreeInput): Promise<void> {
    await mkdir(dirname(input.workspacePath), { recursive: true });
    const args = this.newIssueWorktreeArgs(input);
    const result = await this.executor('git', args);
    if (result.exitCode === 0) {
      return;
    }
    if (!/a branch named .+ already exists/i.test(result.stderr)) {
      throw new Error(`git command failed: git ${args.join(' ')}\n${result.stderr}`);
    }

    await this.removeMergedStaleBranchWorktree(input);
    await this.git(args);
  }

  public async ensureIssueWorktree(input: EnsureIssueWorktreeInput): Promise<void> {
    if (!input.allowResume) {
      await this.createIssueWorktree(input);
      return;
    }

    await mkdir(dirname(input.workspacePath), { recursive: true });
    const expectedBranchRef = `refs/heads/${input.branchName}`;
    const worktrees = await this.listWorktrees(input.targetRoot);
    const workspaceWorktree = worktrees.find((worktree) => samePath(worktree.path, input.workspacePath));
    if (workspaceWorktree) {
      if (workspaceWorktree.branch === expectedBranchRef) {
        return;
      }
      throw new Error(
        `Existing worktree at ${input.workspacePath} belongs to ${workspaceWorktree.branch ?? 'detached HEAD'}; expected ${expectedBranchRef}.`,
      );
    }

    const branchWorktree = worktrees.find((worktree) => worktree.branch === expectedBranchRef);
    if (branchWorktree) {
      throw new Error(
        `Existing branch ${input.branchName} is already checked out at ${branchWorktree.path}; refusing to create a second issue worktree at ${input.workspacePath}.`,
      );
    }

    if (await this.branchExists(input.targetRoot, input.branchName)) {
      await this.assertBranchContainsRequiredBase(input);
      await this.git(['-C', input.targetRoot, 'worktree', 'add', input.workspacePath, input.branchName]);
      return;
    }

    await this.git(this.newIssueWorktreeArgs(input));
  }

  public async listChangedFiles(worktreePath: string): Promise<string[]> {
    const result = await this.git(['-C', worktreePath, 'status', '--porcelain=v1', '--untracked-files=all', '-z']);
    return parsePorcelainChangedFiles(result.stdout);
  }

  public async collectSessionChangeSet(input: CollectSessionChangeSetInput): Promise<SessionChangeSet> {
    const committedPaths = parseNulPaths(
      (await this.git(['-C', input.worktreePath, 'diff', '--name-only', '-z', `${input.baseHead}..HEAD`])).stdout,
    );
    const workingTreePaths = await this.listChangedFiles(input.worktreePath);
    const changedPaths = uniqueSortedPaths([...committedPaths, ...workingTreePaths]);
    const commits = parseSessionCommitLog(
      (await this.git([
        '-C',
        input.worktreePath,
        'log',
        '--format=%H%x1f%s%x1f%an%x1f%ae%x1f%ct%x1e',
        `${input.baseHead}..HEAD`,
      ])).stdout,
    );

    return {
      changedPaths,
      commits,
      hasChanges: changedPaths.length > 0 || commits.length > 0,
    };
  }

  public async commitAll(input: CommitAllInput): Promise<void> {
    await this.git(['-C', input.worktreePath, 'add', '--all']);
    await this.git([
      '-C',
      input.worktreePath,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=codex-orchestrator',
      '-c',
      'user.email=codex-orchestrator@users.noreply.github.com',
      'commit',
      '--no-verify',
      '-m',
      input.message,
    ]);
  }

  public async pushBranch(input: PushBranchInput): Promise<void> {
    await this.git([
      '-C',
      input.worktreePath,
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '--no-verify',
      '-u',
      'origin',
      input.branchName,
    ]);
  }

  public async mergeBranch(input: MergeBranchInput): Promise<void> {
    const result = await this.executor('git', [
      '-C',
      input.worktreePath,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=codex-orchestrator',
      '-c',
      'user.email=codex-orchestrator@users.noreply.github.com',
      'merge',
      '--no-ff',
      input.branchName,
      '-m',
      input.message,
    ]);
    if (result.exitCode !== 0) {
      throw new GitMergeConflictError(input.worktreePath, input.branchName, result.stdout, result.stderr);
    }
  }

  public async abortMerge(worktreePath: string): Promise<void> {
    await this.git(['-C', worktreePath, 'merge', '--abort']);
  }

  public async removeWorktree(input: RemoveWorktreeInput): Promise<void> {
    await this.git(['-C', input.targetRoot, 'worktree', 'remove', input.worktreePath]);
  }

  public async pruneWorktrees(targetRoot: string): Promise<void> {
    await this.git(['-C', targetRoot, 'worktree', 'prune']);
  }

  public async listWorktrees(targetRoot: string): Promise<GitWorktreeInfo[]> {
    return parseWorktreeList((await this.git(['-C', targetRoot, 'worktree', 'list', '--porcelain'])).stdout);
  }

  public async branchExists(targetRoot: string, branchName: string): Promise<boolean> {
    const result = await this.executor('git', [
      '-C',
      targetRoot,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branchName}`,
    ]);
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new Error(`git command failed: git -C ${targetRoot} show-ref --verify --quiet refs/heads/${branchName}\n${result.stderr}`);
  }

  public async branchContainsCommit(targetRoot: string, branchName: string, commitSha: string): Promise<boolean> {
    const result = await this.executor('git', [
      '-C',
      targetRoot,
      'merge-base',
      '--is-ancestor',
      commitSha,
      branchName,
    ]);
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new Error(`git command failed: git -C ${targetRoot} merge-base --is-ancestor ${commitSha} ${branchName}\n${result.stderr}`);
  }

  public async isBranchAncestorOf(targetRoot: string, ancestorBranch: string, descendantBranch: string): Promise<boolean> {
    const result = await this.executor('git', [
      '-C',
      targetRoot,
      'merge-base',
      '--is-ancestor',
      ancestorBranch,
      descendantBranch,
    ]);
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new Error(`git command failed: git -C ${targetRoot} merge-base --is-ancestor ${ancestorBranch} ${descendantBranch}\n${result.stderr}`);
  }

  public async isWorktreeClean(worktreePath: string): Promise<boolean> {
    const status = await this.git(['-C', worktreePath, 'status', '--porcelain=v1', '--untracked-files=all']);
    return status.stdout.trim().length === 0;
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await this.executor('git', args);
    if (result.exitCode !== 0) {
      throw new Error(`git command failed: git ${args.join(' ')}\n${result.stderr}`);
    }
    return result;
  }

  private newIssueWorktreeArgs(input: CreateIssueWorktreeInput): string[] {
    return [
      '-C',
      input.targetRoot,
      'worktree',
      'add',
      '--no-track',
      '-b',
      input.branchName,
      input.workspacePath,
      input.baseBranch,
    ];
  }

  private async removeMergedStaleBranchWorktree(input: CreateIssueWorktreeInput): Promise<void> {
    const ancestor = await this.executor('git', [
      '-C',
      input.targetRoot,
      'merge-base',
      '--is-ancestor',
      input.branchName,
      input.baseBranch,
    ]);
    if (ancestor.exitCode !== 0) {
      throw new Error(
        `Existing branch ${input.branchName} is not merged into ${input.baseBranch}; refusing to remove it automatically.`,
      );
    }

    const worktrees = parseWorktreeList((await this.git(['-C', input.targetRoot, 'worktree', 'list', '--porcelain'])).stdout);
    const staleWorktree = worktrees.find((worktree) => worktree.branch === `refs/heads/${input.branchName}`);
    if (staleWorktree) {
      const status = await this.git(['-C', staleWorktree.path, 'status', '--porcelain=v1']);
      if (status.stdout.trim().length > 0) {
        throw new Error(
          `Existing worktree for ${input.branchName} has uncommitted changes at ${staleWorktree.path}; refusing to remove it automatically.`,
        );
      }
      await this.removeWorktree({ targetRoot: input.targetRoot, worktreePath: staleWorktree.path });
    }

    await this.git(['-C', input.targetRoot, 'branch', '-d', input.branchName]);
  }

  private async assertBranchContainsRequiredBase(input: EnsureIssueWorktreeInput): Promise<void> {
    if (!input.requiredBaseSha) {
      return;
    }
    const ancestor = await this.executor('git', [
      '-C',
      input.targetRoot,
      'merge-base',
      '--is-ancestor',
      input.requiredBaseSha,
      input.branchName,
    ]);
    if (ancestor.exitCode !== 0) {
      throw new Error(
        `Existing branch ${input.branchName} was created from a different base; expected it to contain ${input.requiredBaseSha}. Create a clean branch or recover it manually.`,
      );
    }
  }
}

export function renderBranchTemplate(template: string, values: BranchTemplateValues): string {
  return template
    .replaceAll('${issueNumber}', values.issueNumber === undefined ? '' : String(values.issueNumber))
    .replaceAll('${parentIssueNumber}', values.parentIssueNumber === undefined ? '' : String(values.parentIssueNumber));
}

function parsePorcelainChangedFiles(output: string): string[] {
  const entries = output.split('\0').filter(Boolean);
  const files: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? '';
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.startsWith('R') || status.startsWith('C')) {
      const nextPath = entries[index + 1];
      if (path) {
        files.push(normalizePath(path));
      }
      if (nextPath) {
        files.push(normalizePath(nextPath));
        index += 1;
      }
    } else if (path) {
      files.push(normalizePath(path));
    }
  }

  return Array.from(new Set(files));
}

function parseNulPaths(output: string): string[] {
  return output.split('\0').filter(Boolean).map(normalizePath);
}

function parseSessionCommitLog(output: string): SessionCommitInfo[] {
  return output.split('\x1e').filter(Boolean).map((record) => {
    const [sha = '', subject = '', authorName = '', authorEmail = '', committedAtUnix = ''] = record
      .replace(/^\n/u, '')
      .split('\x1f');
    return {
      sha,
      subject,
      authorName,
      authorEmail,
      committedAt: new Date(Number(committedAtUnix) * 1000).toISOString(),
    };
  }).filter((commit) => commit.sha.length > 0);
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function canonicalPath(path: string): string {
  const resolvedPath = resolve(path);
  return resolvedPath.startsWith('/private/') ? resolvedPath.slice('/private'.length) : resolvedPath;
}

function parseWorktreeList(output: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = [];
  let current: { path: string; branch?: string } | undefined;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      worktrees.push(current);
      continue;
    }
    if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }

  return worktrees;
}
