import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { defaultProcessExecutor } from './adapters/command.js';
import { parseAgentAutoConfig } from './config.js';
import { LocalGitRunIssueAdapter } from './runtime.js';

/** Analyze the same remote baseline used by a new run without reading local product edits. */
export async function withRemoteBaseWorktree<T>(
  targetRoot: string,
  analyze: (snapshot: { worktreePath: string; baseSha: string }) => Promise<T>,
): Promise<{ baseSha: string; result: T }> {
  if (!isAbsolute(targetRoot)) throw new Error('Remote-base target must be absolute.');
  const config = parseAgentAutoConfig(JSON.parse(await readFile(join(targetRoot, '.codex-orchestrator/config.json'), 'utf8')));
  const git = new LocalGitRunIssueAdapter();
  const base = { targetRoot, baseBranch: config.github.baseBranch };
  const baseSha = await git.getBaseSha(base);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-discovery-'));
  const worktreePath = join(temporaryRoot, 'worktree');
  let created = false;
  try {
    const added = await defaultProcessExecutor('git', ['-C', targetRoot, 'worktree', 'add', '--detach', worktreePath, baseSha]);
    created = added.exitCode === 0 || existsSync(join(worktreePath, '.git'));
    if (added.exitCode !== 0) throw new Error(`Discovery worktree creation failed: ${added.stderr}`);
    const result = await analyze({ worktreePath, baseSha });
    if (await git.getBaseSha(base) !== baseSha) throw new Error('Remote base changed during discovery; analyze the new base before publishing an issue.');
    return { baseSha, result };
  } finally {
    if (created) {
      const removed = await defaultProcessExecutor('git', ['-C', targetRoot, 'worktree', 'remove', '--force', worktreePath]);
      if (removed.exitCode !== 0) throw new Error(`Discovery worktree cleanup failed at ${worktreePath}: ${removed.stderr}`);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
