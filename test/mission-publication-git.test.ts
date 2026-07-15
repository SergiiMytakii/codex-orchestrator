import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitMissionPublicationBranchAdapter } from '../src/runner/mission-publication-git.js';

test('Publication branch adapter observes exact refs and pushes the pinned candidate with an absent-ref lease', async () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const candidateCommit = '3'.repeat(40);
  const adapter = new GitMissionPublicationBranchAdapter('/repo', async (_file, args, options) => {
    calls.push({ args, cwd: options?.cwd });
    if (args[0] === 'ls-remote' && args.at(-1) === 'refs/heads/codex/mission-227') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'ls-remote') {
      return { stdout: `${'1'.repeat(40)}\trefs/heads/main\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  assert.deepEqual(await adapter.observe('codex/mission-227'), { kind: 'absent' });
  assert.equal(await adapter.observeBase('main'), '1'.repeat(40));
  await adapter.push({ branch: 'codex/mission-227', candidateCommit });

  assert.deepEqual(calls[2], {
    cwd: '/repo',
    args: [
      'push', '--no-verify',
      '--force-with-lease=refs/heads/codex/mission-227:',
      'origin',
      `${candidateCommit}:refs/heads/codex/mission-227`,
    ],
  });
});
