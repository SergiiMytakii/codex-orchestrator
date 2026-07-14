import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MissionDeploymentRecord } from '../src/runner/mission-deployment.js';
import {
  MissionRuntimeOwnership,
  RuntimeOwnerConflictError,
  type RuntimeOwnerRefAdapter,
  type RuntimeOwnerRecord,
} from '../src/runner/mission-runtime-owner.js';

const deployment = (overrides: Partial<MissionDeploymentRecord> = {}): MissionDeploymentRecord => ({
  version: 1,
  repository: 'SergiiMytakii/codex-orchestrator',
  deploymentId: 'deployment-a',
  hostId: 'host-a',
  serviceId: 'daemon-main',
  githubAppInstallationId: '12345',
  credentialGeneration: 'generation-1',
  compatibilityEpoch: 1,
  priorCredentialRevokedAt: '2026-07-14T10:00:00.000Z',
  priorTokenExpiresAt: '2026-07-14T10:05:00.000Z',
  takeoverGraceUntil: '2026-07-14T10:10:00.000Z',
  takeoverNotBefore: '2026-07-14T10:10:00.000Z',
  approvedByCommit: 'a'.repeat(40),
  ...overrides,
});

class MemoryOwnerRef implements RuntimeOwnerRefAdapter {
  public sha: string | undefined;
  public record: RuntimeOwnerRecord | undefined;

  async read(): Promise<{ sha: string; record: RuntimeOwnerRecord } | undefined> {
    return this.sha && this.record ? { sha: this.sha, record: this.record } : undefined;
  }

  async compareAndSwap(expectedSha: string | undefined, record: RuntimeOwnerRecord): Promise<{ sha: string; record: RuntimeOwnerRecord }> {
    if (this.sha !== expectedSha) {
      throw new RuntimeOwnerConflictError('lease changed');
    }
    this.sha = `${Number(this.sha ?? '0') + 1}`;
    this.record = record;
    return { sha: this.sha, record };
  }
}

test('two deployments racing for initial ownership produce one owner', async () => {
  const adapter = new MemoryOwnerRef();
  const left = new MissionRuntimeOwnership(adapter);
  const right = new MissionRuntimeOwnership(adapter);

  const results = await Promise.allSettled([
    left.acquireInitial(deployment()),
    right.acquireInitial(deployment({ deploymentId: 'deployment-b', hostId: 'host-b' })),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('ownership transfer is forbidden before revocation, expiry, grace, and credential change', async () => {
  const adapter = new MemoryOwnerRef();
  const ownership = new MissionRuntimeOwnership(adapter);
  await ownership.acquireInitial(deployment());

  await assert.rejects(ownership.transfer(deployment({
    deploymentId: 'deployment-b',
    hostId: 'host-b',
  }), '2026-07-14T10:09:59.999Z'), /takeoverNotBefore/);
  await assert.rejects(ownership.transfer(deployment({
    deploymentId: 'deployment-b',
    hostId: 'host-b',
  }), '2026-07-14T10:10:00.000Z'), /credential generation/);

  const transferred = await ownership.transfer(deployment({
    deploymentId: 'deployment-b',
    hostId: 'host-b',
    credentialGeneration: 'generation-2',
  }), '2026-07-14T10:10:00.000Z');
  assert.equal(transferred.record.deploymentId, 'deployment-b');
  assert.equal(transferred.record.fencingEpoch, 2);
});

test('fresh mutation fence rejects stale deployment or epoch', async () => {
  const adapter = new MemoryOwnerRef();
  const ownership = new MissionRuntimeOwnership(adapter);
  const acquired = await ownership.acquireInitial(deployment());

  await ownership.assertMutationFence(deployment(), acquired.record.fencingEpoch);
  await assert.rejects(ownership.assertMutationFence(
    deployment({ credentialGeneration: 'generation-2' }),
    acquired.record.fencingEpoch,
  ), /credential generation/);
  await assert.rejects(ownership.assertMutationFence(deployment(), 0), /fencing epoch/);
});

test('fenced remote mutation never runs after owner movement', async () => {
  const adapter = new MemoryOwnerRef();
  const ownership = new MissionRuntimeOwnership(adapter);
  const acquired = await ownership.acquireInitial(deployment());
  adapter.record = { ...acquired.record, fencingEpoch: acquired.record.fencingEpoch + 1 };
  let called = false;

  await assert.rejects(ownership.runFencedMutation(
    deployment(),
    acquired.record.fencingEpoch,
    async () => {
      called = true;
      return 'mutated';
    },
  ), /fencing epoch/);
  assert.equal(called, false);
});
