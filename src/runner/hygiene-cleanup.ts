import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import { GitWorktreeManager } from '../git/worktree.js';
import { RunnerStateStore, type RunnerProcessMetadata } from './local-state.js';

export interface HygieneCleanupResult {
  staleRunsRemoved: RunnerProcessMetadata[];
  prunedGitWorktrees: boolean;
}

export interface RunHygieneCleanupInput {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  git?: GitWorktreeManager;
  store?: RunnerStateStore;
}

export async function runHygieneCleanup(input: RunHygieneCleanupInput): Promise<HygieneCleanupResult> {
  const targetRoot = resolve(input.targetRoot);
  const git = input.git ?? new GitWorktreeManager();
  const store = input.store ?? new RunnerStateStore(targetRoot, input.config);
  let prunedGitWorktrees = false;

  if (existsSync(resolve(targetRoot, '.git'))) {
    await git.pruneWorktrees(targetRoot);
    prunedGitWorktrees = true;
  }

  const state = await store.load();
  const runs = state.runs.filter((run) => workspaceExists(targetRoot, run));
  const staleRunsRemoved = state.runs.filter((run) => !workspaceExists(targetRoot, run));

  if (staleRunsRemoved.length > 0) {
    await store.save({ version: state.version, runs });
  }

  return { staleRunsRemoved, prunedGitWorktrees };
}

function workspaceExists(targetRoot: string, run: RunnerProcessMetadata): boolean {
  return existsSync(resolve(targetRoot, run.workspacePath));
}
