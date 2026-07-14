import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalMissionDeploymentRecord,
  missionDeploymentRecordHash,
  parseMissionDeploymentRecord,
  takeoverNotBefore,
} from '../src/runner/mission-deployment.js';

const deployment = {
  version: 1 as const,
  repository: 'SergiiMytakii/codex-orchestrator',
  deploymentId: 'mission-primary',
  hostId: 'host-a',
  serviceId: 'daemon-main',
  githubAppInstallationId: '12345',
  credentialGeneration: 'generation-2',
  compatibilityEpoch: 1,
  priorCredentialRevokedAt: '2026-07-14T10:00:00.000Z',
  priorTokenExpiresAt: '2026-07-14T10:05:00.000Z',
  takeoverGraceUntil: '2026-07-14T10:10:00.000Z',
  takeoverNotBefore: '2026-07-14T10:10:00.000Z',
  approvedByCommit: 'a'.repeat(40),
};

test('deployment record is exact canonical JSON with a stable hash', () => {
  const canonical = canonicalMissionDeploymentRecord(deployment);
  assert.deepEqual(parseMissionDeploymentRecord(canonical), deployment);
  assert.match(missionDeploymentRecordHash(deployment), /^sha256:[a-f0-9]{64}$/u);

  assert.throws(() => parseMissionDeploymentRecord(JSON.stringify({
    ...deployment,
    unexpected: true,
  })), /unexpected field unexpected/);
  assert.throws(() => parseMissionDeploymentRecord(`${JSON.stringify(deployment, null, 2)}\n`), /canonical JSON/);
});

test('takeoverNotBefore uses the later token expiry or grace boundary', () => {
  assert.equal(takeoverNotBefore(deployment), '2026-07-14T10:10:00.000Z');
  assert.throws(() => canonicalMissionDeploymentRecord({
    ...deployment,
    takeoverNotBefore: '2026-07-14T10:05:00.000Z',
  }), /takeoverNotBefore/);
});
