import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  childMissionId,
  missionId,
  publicationAttemptId,
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
});
