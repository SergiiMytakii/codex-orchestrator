import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { withRemoteBaseWorktree } from '../src/index.js';

const execute = promisify(execFile);
const git = async (...args: string[]) => (await execute('git', args)).stdout.trim();

for (const scenario of ['success', 'analysis-failed', 'remote-moved', 'fetch-failed', 'hook-failed']) {
  test(`remote-base analysis excludes local edits and releases its temporary worktree: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'v2-remote-base-test-'));
    const remote = join(root, 'remote.git');
    const target = join(root, 'target');
    let analysisPath: string | undefined;
    try {
      await git('init', '--bare', remote);
      await git('init', '-b', 'integration', target);
      await git('-C', target, 'config', 'user.email', 'test@example.invalid');
      await git('-C', target, 'config', 'user.name', 'Test');
      await writeFile(join(target, 'fixture.txt'), 'remote contract');
      await git('-C', target, 'add', 'fixture.txt');
      await git('-C', target, 'commit', '-m', 'Remote baseline');
      await git('-C', target, 'remote', 'add', 'origin', remote);
      await git('-C', target, 'push', 'origin', 'integration');
      const remoteSha = await git('-C', target, 'rev-parse', 'HEAD');
      await writeFile(join(target, 'fixture.txt'), 'local contract');
      await git('-C', target, 'commit', '-am', 'Local prerequisite');
      const localSha = await git('-C', target, 'rev-parse', 'HEAD');
      await git('-C', target, 'push', 'origin', 'HEAD:refs/heads/advance');
      await writeFile(join(target, 'fixture.txt'), 'dirty contract');
      await mkdir(join(target, '.codex-orchestrator'));
      const label = (name: string) => ({ name, color: 'ededed', description: name });
      await writeFile(join(target, '.codex-orchestrator/config.json'), JSON.stringify({
        schema: 'codex-orchestrator.agent-auto', version: 2,
        github: { owner: 'owner', repo: 'repo', baseBranch: 'integration', labels: {
          auto: label('agent:auto'), running: label('agent:running'), blocked: label('agent:blocked'), review: label('agent:review'),
        } },
        runner: { workspaceRoot: '.worktrees', stateDir: '.codex-orchestrator/state', branchTemplate: 'codex/issue-${issueNumber}', pollIntervalSeconds: 60 },
        codex: { command: 'codex', timeoutMs: 1000, idleTimeoutMs: 500, toolNetwork: 'deny' },
        checks: {}, proof: { artifactDir: '.codex-orchestrator/proofs' }, deny: { readPaths: [], commands: [] },
      }));
      if (scenario === 'fetch-failed') await rm(remote, { recursive: true, force: true });
      if (scenario === 'hook-failed') {
        const hook = join(target, '.git/hooks/post-checkout');
        await writeFile(hook, '#!/bin/sh\nexit 1\n');
        await chmod(hook, 0o755);
      }
      const analysis = withRemoteBaseWorktree(target, async ({ worktreePath, baseSha }) => {
        analysisPath = worktreePath;
        assert.equal(baseSha, remoteSha);
        assert.equal(await git('-C', worktreePath, 'rev-parse', 'HEAD'), remoteSha);
        assert.equal(await git('-C', worktreePath, 'branch', '--show-current'), '');
        assert.equal(await readFile(join(worktreePath, 'fixture.txt'), 'utf8'), 'remote contract');
        if (scenario === 'analysis-failed') throw new Error('analysis failed');
        if (scenario === 'remote-moved') await git('--git-dir', remote, 'update-ref', 'refs/heads/integration', localSha);
        return 'candidate';
      });
      if (scenario === 'success') assert.deepEqual(await analysis, { baseSha: remoteSha, result: 'candidate' });
      else await assert.rejects(analysis, scenario === 'analysis-failed' ? /analysis failed/ : scenario === 'remote-moved' ? /Remote base changed/ : scenario === 'hook-failed' ? /Discovery worktree creation failed/ : /git failed/);
      assert.equal(await git('-C', target, 'rev-parse', 'HEAD'), localSha);
      assert.equal(await readFile(join(target, 'fixture.txt'), 'utf8'), 'dirty contract');
      if (analysisPath) assert.equal(existsSync(analysisPath), false);
      else assert.ok(scenario === 'fetch-failed' || scenario === 'hook-failed');
      assert.doesNotMatch(await git('-C', target, 'worktree', 'list', '--porcelain'), /codex-orchestrator-discovery-/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
