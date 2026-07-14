import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyMissionOwnership,
  formatMissionMarker,
  parseMissionMarker,
  type MissionMarker,
} from '../src/runner/mission-ownership.js';

const marker: MissionMarker = {
  missionId: 'mission-227-a1',
  issueNumber: 227,
  repository: 'SergiiMytakii/codex-orchestrator',
  deploymentId: 'local-main',
};

test('mission marker uses one canonical versioned first line', () => {
  const rendered = formatMissionMarker(marker);

  assert.equal(rendered,
    '<!-- codex-orchestrator:mission:v1 {"missionId":"mission-227-a1","issueNumber":227,"repository":"SergiiMytakii/codex-orchestrator","deploymentId":"local-main"} -->');
  assert.deepEqual(parseMissionMarker(`${rendered}\nHuman-readable status follows.`), marker);
  assert.equal(parseMissionMarker(`prefix\n${rendered}`), undefined);
});

test('mission ownership rejects conflicting legacy or duplicate markers', () => {
  const rendered = formatMissionMarker(marker);
  const base = {
    mode: 'enabled' as const,
    markerLabelPresent: true,
    markerComments: [rendered],
    localMissionId: marker.missionId,
    legacyRunPresent: false,
    expectedIssueNumber: marker.issueNumber,
    expectedRepository: marker.repository,
    expectedDeploymentId: marker.deploymentId,
    claimResponseLost: false,
  };

  assert.deepEqual(classifyMissionOwnership(base), { kind: 'mission' });
  assert.equal(classifyMissionOwnership({ ...base, legacyRunPresent: true }).kind, 'safety-stop');
  assert.equal(classifyMissionOwnership({ ...base, markerComments: [rendered, rendered] }).kind, 'safety-stop');
  assert.deepEqual(classifyMissionOwnership({
    ...base,
    markerComments: [],
    claimResponseLost: true,
  }), { kind: 'resumable', reason: 'mission-marker-claim-unconfirmed' });
});
