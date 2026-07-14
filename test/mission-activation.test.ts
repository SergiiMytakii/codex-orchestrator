import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateMissionActivation } from '../src/runner/mission-activation.js';

const ready = {
  mode: 'enabled' as const,
  requiredCompatibilityEpoch: 2,
  deploymentCompatibilityEpoch: 2,
  ownerCompatibilityEpoch: 2,
  ownerDeploymentMatches: true,
  preFenceDaemonIds: [] as string[],
  dedicatedCredential: true,
};

test('activation gate refuses enabled mode with old daemons or ownership mismatch', () => {
  assert.deepEqual(evaluateMissionActivation({ ...ready, preFenceDaemonIds: ['old-host'] }), {
    kind: 'external-input-required',
    reason: 'pre-fence-daemons-present',
    evidence: ['old-host'],
  });
  assert.equal(evaluateMissionActivation({ ...ready, ownerDeploymentMatches: false }).kind, 'safety-stop');
  assert.equal(evaluateMissionActivation({ ...ready, ownerCompatibilityEpoch: 1 }).kind, 'external-input-required');
  assert.equal(evaluateMissionActivation({ ...ready, dedicatedCredential: false }).kind, 'external-input-required');
});

test('activation gate keeps off and shadow non-authoritative and enables only a fenced deployment', () => {
  assert.deepEqual(evaluateMissionActivation({ ...ready, mode: 'off' }), { kind: 'legacy-only' });
  assert.deepEqual(evaluateMissionActivation({ ...ready, mode: 'shadow' }), { kind: 'shadow-only' });
  assert.deepEqual(evaluateMissionActivation({
    ...ready,
    configuredChecks: {
      tests: 'npm test',
      status: {
        executable: '/usr/bin/git',
        args: [
          '-c', 'core.fsmonitor=false',
          '-c', 'core.untrackedCache=false',
          '-c', 'core.hooksPath=/dev/null',
          'status', '--porcelain=v1', '--untracked-files=all',
        ],
        capability: 'git-status',
      },
    },
  }), { kind: 'mission-enabled', legacyCheckNames: ['tests'] });
});
