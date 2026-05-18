import type { BaseBranchConfig } from '../config/schema.js';
import { defaultProcessExecutor, type ProcessExecutor } from '../process/command.js';

export interface ResolvedBaseBranch {
  mode: 'explicit';
  remote: string;
  branch: string;
  remoteRef: string;
  sha: string;
  prBaseBranch: string;
  legacy: boolean;
}

export interface ResolveBaseBranchInput {
  targetRoot: string;
  base: BaseBranchConfig;
  executor?: ProcessExecutor;
}

export async function resolveBaseBranch(input: ResolveBaseBranchInput): Promise<ResolvedBaseBranch> {
  const executor = input.executor ?? defaultProcessExecutor;
  const normalized = baseBranchParts(input.base);
  const fetch = await executor('git', ['-C', input.targetRoot, 'fetch', normalized.remote, '--prune']);
  if (fetch.exitCode !== 0) {
    throw new Error(`Could not fetch ${normalized.remote} before resolving base branch: ${fetch.stderr || fetch.stdout}`);
  }

  const exists = await executor('git', ['-C', input.targetRoot, 'show-ref', '--verify', '--quiet', normalized.remoteRef]);
  if (exists.exitCode !== 0) {
    throw new Error(`Configured base branch ${normalized.remote}/${normalized.branch} was not found. Run setup and choose an existing remote branch.`);
  }

  const shaResult = await executor('git', ['-C', input.targetRoot, 'rev-parse', normalized.remoteRef]);
  if (shaResult.exitCode !== 0) {
    throw new Error(`Could not resolve configured base branch ${normalized.remote}/${normalized.branch}: ${shaResult.stderr || shaResult.stdout}`);
  }

  return {
    mode: 'explicit',
    remote: normalized.remote,
    branch: normalized.branch,
    remoteRef: normalized.remoteRef,
    sha: shaResult.stdout.trim(),
    prBaseBranch: normalized.branch,
    legacy: normalized.legacy,
  };
}

export function formatBaseBranch(base: BaseBranchConfig): string {
  const normalized = baseBranchParts(base);
  return `${normalized.remote}/${normalized.branch}`;
}

export function isLegacyBaseBranch(base: BaseBranchConfig): boolean {
  return typeof base === 'string';
}

export function baseBranchParts(base: BaseBranchConfig): { remote: string; branch: string; remoteRef: string; legacy: boolean } {
  if (typeof base === 'string') {
    return { remote: 'origin', branch: base, remoteRef: `refs/remotes/origin/${base}`, legacy: true };
  }

  return {
    remote: base.remote,
    branch: base.branch,
    remoteRef: `refs/remotes/${base.remote}/${base.branch}`,
    legacy: false,
  };
}
