import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  childMissionId,
  integrationRecoveryMissionId,
  missionId,
  publicationAttemptId,
  validationRecoveryMissionId,
} from '../src/runner/mission-identifiers.js';

test('mission aggregate identifiers are deterministic and domain-separated', () => {
  const mission = missionId({
    repository: 'SergiiMytakii/codex-orchestrator',
    issueNumber: 227,
    attempt: 1,
  });

  assert.equal(mission, missionId({
    repository: 'SergiiMytakii/codex-orchestrator',
    issueNumber: 227,
    attempt: 1,
  }));
  assert.match(mission, /^mission:v1:[a-f0-9]{64}$/u);
  assert.notEqual(mission, missionId({
    repository: 'SergiiMytakii/codex-orchestrator',
    issueNumber: 227,
    attempt: 2,
  }));

  const child = childMissionId({ parentId: mission, nodeId: 'implementation' });
  const publication = publicationAttemptId({
    ownerId: mission,
    candidateCommit: 'candidate-sha',
    baseSha: 'base-sha',
    configHash: 'config-sha256',
  });
  assert.match(child, /^mission-child:v1:[a-f0-9]{64}$/u);
  assert.match(publication, /^publication:v1:[a-f0-9]{64}$/u);
  assert.notEqual(child.split(':').at(-1), publication.split(':').at(-1));

  const recovery = integrationRecoveryMissionId({
    parentId: mission,
    wave: 1,
    checkpointCommit: '1'.repeat(40),
    integratedTree: '2'.repeat(40),
    cursor: 2,
    childCommit: '3'.repeat(40),
    configHash: `sha256:${'a'.repeat(64)}`,
  });
  assert.match(recovery, /^mission-integration-recovery:v1:[a-f0-9]{64}$/u);
  assert.equal(recovery, integrationRecoveryMissionId({
    parentId: mission,
    wave: 1,
    checkpointCommit: '1'.repeat(40),
    integratedTree: '2'.repeat(40),
    cursor: 2,
    childCommit: '3'.repeat(40),
    configHash: `sha256:${'a'.repeat(64)}`,
  }));
  assert.match(validationRecoveryMissionId({
    parentId: mission,
    phase: 'wave-1',
    candidateTree: '2'.repeat(40),
    configHash: `sha256:${'a'.repeat(64)}`,
  }), /^mission-validation-recovery:v1:[a-f0-9]{64}$/u);
});
