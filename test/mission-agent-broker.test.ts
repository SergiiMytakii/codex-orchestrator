import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MissionAgentBroker,
  type MissionModelTransport,
} from '../src/runner/mission-agent-broker.js';

test('agent broker accepts only structured finite capability proposals', async () => {
  const transport: MissionModelTransport = {
    diagnose: async () => JSON.stringify({
      version: 1,
      kind: 'observe',
      capability: 'read-file',
      paths: ['src/value.ts'],
      rationale: 'inspect owning code',
    }),
  };
  const proposal = await new MissionAgentBroker(transport).diagnose({
    missionId: 'mission-a',
    snapshotId: 'tree:abc',
    findingIds: ['finding-a'],
    allowedCapabilities: ['read-file'],
  });
  assert.equal(proposal.kind, 'observe');
});

test('agent broker rejects command, network, unknown capability, and extra-field smuggling', async () => {
  for (const payload of [
    { version: 1, kind: 'observe', capability: 'shell', paths: ['src/**'], rationale: 'run it' },
    { version: 1, kind: 'observe', capability: 'read-file', paths: ['src/**'], rationale: 'read', network: true },
    { version: 1, kind: 'observe', capability: 'read-file', paths: ['.env'], rationale: 'secret' },
  ]) {
    const transport: MissionModelTransport = { diagnose: async () => JSON.stringify(payload) };
    await assert.rejects(new MissionAgentBroker(transport).diagnose({
      missionId: 'mission-a',
      snapshotId: 'tree:abc',
      findingIds: ['finding-a'],
      allowedCapabilities: ['read-file'],
    }), /Invalid Mission Agent proposal/);
  }
});

test('agent broker accepts only registered runner actions and structured scope expansion', async () => {
  const runnerAction = new MissionAgentBroker({
    diagnose: async () => JSON.stringify({
      version: 1,
      kind: 'runner-action',
      executorId: 'frontend-targeted-eslint',
      findingIds: ['finding:lint'],
      rationale: 'collect deterministic lint evidence',
    }),
  });
  assert.equal((await runnerAction.diagnose({
    missionId: 'mission-227',
    snapshotId: 'tree:abc',
    findingIds: ['finding:lint'],
    allowedCapabilities: ['read-file'],
    allowedRunnerActions: ['frontend-targeted-eslint'],
  })).kind, 'runner-action');

  const scopeExpansion = new MissionAgentBroker({
    diagnose: async () => JSON.stringify({
      version: 1,
      kind: 'scope-expansion',
      repository: 'SergiiMytakii/IntelleReach',
      paths: ['src/frontend/package.json'],
      evidenceIds: ['finding:lint'],
      relationship: {
        kind: 'config-consumer',
        from: 'src/frontend/context/AuthContext.tsx',
      },
      rationale: 'the failing check is owned by this package script',
    }),
  });
  assert.equal((await scopeExpansion.diagnose({
    missionId: 'mission-227',
    snapshotId: 'tree:abc',
    findingIds: ['finding:lint'],
    allowedCapabilities: ['read-file'],
    repository: 'SergiiMytakii/IntelleReach',
  })).kind, 'scope-expansion');

  const unregistered = new MissionAgentBroker({
    diagnose: async () => JSON.stringify({
      version: 1,
      kind: 'runner-action',
      executorId: 'arbitrary-shell',
      findingIds: ['finding:lint'],
      rationale: 'try shell',
    }),
  });
  await assert.rejects(unregistered.diagnose({
    missionId: 'mission-227',
    snapshotId: 'tree:abc',
    findingIds: ['finding:lint'],
    allowedCapabilities: ['read-file'],
    allowedRunnerActions: ['frontend-targeted-eslint'],
  }), /runner action is not allowed/);
});
