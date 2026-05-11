import { existsSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GitWorktreeManager, type GitWorktreeInfo } from '../git/worktree.js';
import type { GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import { RunnerStateStore } from './local-state.js';

export interface WorktreeCleanupEntry {
  worktreePath: string;
  branchName: string;
  pullRequest: GitHubPullRequest;
}

export interface WorktreeCleanupSkip {
  worktreePath: string;
  branchName?: string;
  reason: 'active-run' | 'outside-workspace-root' | 'missing-branch' | 'dirty' | 'no-merged-pr';
}

export interface WorktreeCleanupResult {
  removed: WorktreeCleanupEntry[];
  skipped: WorktreeCleanupSkip[];
}

export interface CleanupMergedWorktreesInput {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  git?: GitWorktreeManager;
  pullRequestAdapter?: GitHubPullRequestAdapter;
  store?: RunnerStateStore;
}

export async function cleanupMergedWorktrees(input: CleanupMergedWorktreesInput): Promise<WorktreeCleanupResult> {
  if (input.config.runner.worktreeCleanup?.enabled === false) {
    return { removed: [], skipped: [] };
  }

  const targetRoot = realPath(resolve(input.targetRoot));
  const workspaceRoot = realPath(resolve(targetRoot, input.config.runner.workspaceRoot));
  if (!existsSync(workspaceRoot)) {
    return { removed: [], skipped: [] };
  }

  const git = input.git ?? new GitWorktreeManager();
  const pullRequestAdapter =
    input.pullRequestAdapter ?? new GhCliPullRequestAdapter(input.config.github.owner, input.config.github.repo);
  const state = await (input.store ?? new RunnerStateStore(targetRoot, input.config)).load();
  const activeWorktreePaths = new Set(state.runs.map((run) => realPath(resolve(targetRoot, run.workspacePath))));
  const removed: WorktreeCleanupEntry[] = [];
  const skipped: WorktreeCleanupSkip[] = [];

  for (const worktree of await git.listWorktrees(targetRoot)) {
    const worktreePath = realPath(resolve(worktree.path));
    const branchName = shortBranchName(worktree);
    if (!isInsideDirectory(workspaceRoot, worktreePath)) {
      skipped.push({ worktreePath, branchName, reason: 'outside-workspace-root' });
      continue;
    }
    if (!branchName) {
      skipped.push({ worktreePath, reason: 'missing-branch' });
      continue;
    }
    if (activeWorktreePaths.has(worktreePath)) {
      skipped.push({ worktreePath, branchName, reason: 'active-run' });
      continue;
    }

    const pullRequest = await pullRequestAdapter.findMergedPullRequestByHeadBranch(branchName);
    if (!pullRequest) {
      skipped.push({ worktreePath, branchName, reason: 'no-merged-pr' });
      continue;
    }

    if (!(await git.isWorktreeClean(worktreePath))) {
      skipped.push({ worktreePath, branchName, reason: 'dirty' });
      continue;
    }

    await git.removeWorktree({ targetRoot, worktreePath });
    removed.push({ worktreePath, branchName, pullRequest });
  }

  if (removed.length > 0) {
    await git.pruneWorktrees(targetRoot);
  }

  return { removed, skipped };
}

function shortBranchName(worktree: GitWorktreeInfo): string | undefined {
  return worktree.branch?.replace(/^refs\/heads\//u, '');
}

function isInsideDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith('..') && path !== '..';
}

function realPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}
