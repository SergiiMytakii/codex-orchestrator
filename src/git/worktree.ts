import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ProcessExecutor } from '../process/command.js';
import { defaultProcessExecutor } from '../process/command.js';

export interface BranchTemplateValues {
  issueNumber?: number;
  parentIssueNumber?: number;
}

export interface CreateIssueWorktreeInput {
  targetRoot: string;
  workspacePath: string;
  branchName: string;
  baseBranch: string;
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
    await this.git([
      '-C',
      input.targetRoot,
      'worktree',
      'add',
      '-b',
      input.branchName,
      input.workspacePath,
      input.baseBranch,
    ]);
  }

  public async listChangedFiles(worktreePath: string): Promise<string[]> {
    const result = await this.git(['-C', worktreePath, 'status', '--porcelain=v1', '-z']);
    return parsePorcelainChangedFiles(result.stdout);
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

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await this.executor('git', args);
    if (result.exitCode !== 0) {
      throw new Error(`git command failed: git ${args.join(' ')}\n${result.stderr}`);
    }
    return result;
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

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
