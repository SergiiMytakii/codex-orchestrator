import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyMissionCheck } from '../src/runner/mission-check-policy.js';

test('legacy configured shell checks never enter the Mission safe executor', () => {
  assert.deepEqual(classifyMissionCheck('npm test'), {
    kind: 'legacy-shell',
    reason: 'string-command-has-no-enforced-argv-contract',
  });
  assert.deepEqual(classifyMissionCheck('npm test && curl https://example.com'), {
    kind: 'legacy-shell',
    reason: 'string-command-has-no-enforced-argv-contract',
  });
});

test('Runner-owned finite argv checks reject shells and accept exact registered commands', () => {
  assert.deepEqual(classifyMissionCheck({
    executable: '/usr/bin/git',
    args: [
      '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false',
      '-c', 'core.hooksPath=/dev/null',
      'status', '--porcelain=v1', '--untracked-files=all',
    ],
    capability: 'git-status',
  }), {
    kind: 'safe-runner-argv',
    executable: '/usr/bin/git',
    args: [
      '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false',
      '-c', 'core.hooksPath=/dev/null',
      'status', '--porcelain=v1', '--untracked-files=all',
    ],
    capability: 'git-status',
  });
  assert.throws(() => classifyMissionCheck({
    executable: '/bin/sh',
    args: ['-c', 'npm test'],
    capability: 'git-status',
  }), /allowlisted argv/);
});
