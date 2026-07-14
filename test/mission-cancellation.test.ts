import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';
import {
  MissionCancellationCoordinator,
  MissionProcessGroupTerminator,
} from '../src/runner/mission-cancellation.js';
import {
  createMissionApplyPermit,
  missionApplyPermitFingerprint,
} from '../src/runner/mission-git-contracts.js';
import { MissionStateStore } from '../src/runner/mission-state-store.js';

test('cancellation durably revokes work, terminates process groups, and completes without blocked state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-cancel-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const initial = await store.mutate(0, (draft) => {
    draft.missions.mission = claimedMission();
    draft.nextEligibleAt.mission = claimedMission().claim.leaseUntil;
  });
  const terminated: number[] = [];
  const coordinator = new MissionCancellationCoordinator(store, {
    terminate: async (process) => {
      terminated.push(process.pid);
      return { kind: 'terminated' };
    },
    reconcileApply: async () => { throw new Error('apply reconciliation is unexpected'); },
    nextEligibleAt: () => '2026-07-14T18:06:00.000Z',
  });

  const result = await coordinator.cancel({
    expectedGeneration: initial.generation,
    missionId: 'mission',
    expectedRevision: 3,
    requestedAt: '2026-07-14T18:02:00.000Z',
    requestedBy: 'user',
  });

  assert.deepEqual(result, { kind: 'cancelled', missionId: 'mission', state: 'cancelled' });
  assert.deepEqual(terminated, [4242]);
  const stored = await store.load();
  assert.equal(stored.missions.mission?.state, 'cancelled');
  assert.equal(stored.missions.mission?.claim, undefined);
  assert.equal(stored.nextEligibleAt.mission, undefined);
  assert.equal(JSON.stringify(result).includes('blocked'), false);
});

test('failed process termination remains resumable in cancelling and replays on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-cancel-resume-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const initial = await store.mutate(0, (draft) => {
    draft.missions.mission = claimedMission();
    draft.nextEligibleAt.mission = claimedMission().claim.leaseUntil;
  });
  let attempts = 0;
  const coordinator = new MissionCancellationCoordinator(store, {
    terminate: async () => {
      attempts += 1;
      return attempts === 1
        ? { kind: 'transient-failure', reason: 'process supervisor unavailable' }
        : { kind: 'already-exited' };
    },
    reconcileApply: async () => { throw new Error('apply reconciliation is unexpected'); },
    nextEligibleAt: () => '2026-07-14T18:06:00.000Z',
  });

  const first = await coordinator.cancel({
    expectedGeneration: initial.generation,
    missionId: 'mission',
    expectedRevision: 3,
    requestedAt: '2026-07-14T18:02:00.000Z',
    requestedBy: 'user',
  });
  assert.deepEqual(first, {
    kind: 'resumable',
    missionId: 'mission',
    state: 'cancelling',
    reason: 'process supervisor unavailable',
    nextEligibleAt: '2026-07-14T18:06:00.000Z',
  });
  const pending = await store.load();
  assert.equal(pending.missions.mission?.state, 'cancelling');
  assert.equal(pending.nextEligibleAt.mission, '2026-07-14T18:06:00.000Z');

  const second = await coordinator.cancel({
    expectedGeneration: pending.generation,
    missionId: 'mission',
    expectedRevision: pending.missions.mission!.revision,
    requestedAt: '2026-07-14T18:06:00.000Z',
    requestedBy: 'user',
  });
  assert.equal(second.kind, 'cancelled');
  assert.equal(attempts, 2);
});

test('cancellation with a durable apply intent remains resumable for ref reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-cancel-apply-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const permit = applyPermit();
  const fingerprint = missionApplyPermitFingerprint(permit);
  const initial = await store.mutate(0, (draft) => {
    draft.missions.mission = {
      ...claimedMission(),
      state: 'applying',
      actionKey: permit.actionKey,
      fencingEpoch: permit.fencingEpoch,
      applyPermit: permit,
      applyIntent: {
        version: 1,
        permitFingerprint: fingerprint,
        permit,
        preparedAt: '2026-07-14T18:01:00.000Z',
      },
    };
    draft.nextEligibleAt.mission = claimedMission().claim.leaseUntil;
  });
  const coordinator = new MissionCancellationCoordinator(store, {
    terminate: async () => ({ kind: 'already-exited' }),
    reconcileApply: async () => ({
      kind: 'transient-failure',
      reason: 'apply-reconciliation-required',
    }),
    nextEligibleAt: () => '2026-07-14T18:06:00.000Z',
  });

  const result = await coordinator.cancel({
    expectedGeneration: initial.generation,
    missionId: 'mission',
    expectedRevision: 3,
    requestedAt: '2026-07-14T18:02:00.000Z',
    requestedBy: 'user',
  });

  assert.deepEqual(result, {
    kind: 'resumable',
    missionId: 'mission',
    state: 'cancelling',
    reason: 'apply-reconciliation-required',
    nextEligibleAt: '2026-07-14T18:06:00.000Z',
  });
  const stored = await store.load();
  assert.equal(stored.missions.mission?.state, 'cancelling');
  assert.equal(stored.missions.mission?.applyIntent?.permitFingerprint, fingerprint);
  assert.equal(stored.nextEligibleAt.mission, '2026-07-14T18:06:00.000Z');
});

test('cancellation reconciles a completed apply, preserves its receipt, and reaches cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-cancel-applied-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const permit = applyPermit();
  const fingerprint = missionApplyPermitFingerprint(permit);
  const receipt = {
    version: 1 as const,
    permitFingerprint: fingerprint,
    targetRef: permit.targetRef,
    oldCommitSha: permit.expectedOldCommit,
    commitSha: permit.expectedNewCommit,
    treeSha: permit.expectedNewTree,
    recovered: true,
    appliedAt: '2026-07-14T18:02:30.000Z',
  };
  const initial = await store.mutate(0, (draft) => {
    draft.missions.mission = {
      ...claimedMission(),
      state: 'applying',
      actionKey: permit.actionKey,
      fencingEpoch: permit.fencingEpoch,
      applyPermit: permit,
      applyIntent: {
        version: 1,
        permitFingerprint: fingerprint,
        permit,
        preparedAt: '2026-07-14T18:01:00.000Z',
      },
    };
    draft.nextEligibleAt.mission = claimedMission().claim.leaseUntil;
  });
  const coordinator = new MissionCancellationCoordinator(store, {
    terminate: async () => ({ kind: 'already-exited' }),
    reconcileApply: async () => ({ kind: 'new-identity', receipt }),
    nextEligibleAt: () => '2026-07-14T18:06:00.000Z',
  });

  assert.deepEqual(await coordinator.cancel({
    expectedGeneration: initial.generation,
    missionId: 'mission',
    expectedRevision: 3,
    requestedAt: '2026-07-14T18:02:00.000Z',
    requestedBy: 'user',
  }), { kind: 'cancelled', missionId: 'mission', state: 'cancelled' });
  const stored = await store.load();
  assert.equal(stored.missions.mission?.applyIntent, undefined);
  assert.deepEqual(stored.missions.mission?.applyHistory, [receipt]);
});

test('cancellation classifies a third apply identity as safety-stop, never blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-cancel-third-identity-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const permit = applyPermit();
  const fingerprint = missionApplyPermitFingerprint(permit);
  const initial = await store.mutate(0, (draft) => {
    draft.missions.mission = {
      ...claimedMission(),
      state: 'applying',
      actionKey: permit.actionKey,
      fencingEpoch: permit.fencingEpoch,
      applyPermit: permit,
      applyIntent: {
        version: 1,
        permitFingerprint: fingerprint,
        permit,
        preparedAt: '2026-07-14T18:01:00.000Z',
      },
    };
    draft.nextEligibleAt.mission = claimedMission().claim.leaseUntil;
  });
  const coordinator = new MissionCancellationCoordinator(store, {
    terminate: async () => ({ kind: 'already-exited' }),
    reconcileApply: async () => ({
      kind: 'safety-stop',
      reason: 'target-ref-third-identity',
    }),
    nextEligibleAt: () => '2026-07-14T18:06:00.000Z',
  });

  const result = await coordinator.cancel({
    expectedGeneration: initial.generation,
    missionId: 'mission',
    expectedRevision: 3,
    requestedAt: '2026-07-14T18:02:00.000Z',
    requestedBy: 'user',
  });
  assert.deepEqual(result, {
    kind: 'safety-stop',
    missionId: 'mission',
    state: 'safety-stop',
    reason: 'target-ref-third-identity',
  });
  assert.equal(JSON.stringify(result).includes('blocked'), false);
  assert.equal((await store.load()).missions.mission?.state, 'safety-stop');
});

test('process group terminator verifies host, boot, and process identity before TERM and KILL', async () => {
  const signals: NodeJS.Signals[] = [];
  let observations = 0;
  const terminator = new MissionProcessGroupTerminator({
    hostId: 'host-a',
    bootNonce: 'boot-a',
    graceMs: 1,
  }, {
    observe: async () => {
      observations += 1;
      return observations <= 2 ? 'matching' : 'missing';
    },
    signalProcessGroup: (_pid, signal) => { signals.push(signal); },
    wait: async () => undefined,
  });
  assert.deepEqual(await terminator.terminate(claimedMission().claim.processes[0]!), {
    kind: 'terminated',
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

  let reusedSignals = 0;
  const reused = new MissionProcessGroupTerminator({
    hostId: 'host-a', bootNonce: 'boot-a', graceMs: 1,
  }, {
    observe: async () => 'different',
    signalProcessGroup: () => { reusedSignals += 1; },
    wait: async () => undefined,
  });
  assert.deepEqual(await reused.terminate(claimedMission().claim.processes[0]!), {
    kind: 'already-exited',
  });
  assert.equal(reusedSignals, 0);

  const rebooted = new MissionProcessGroupTerminator({
    hostId: 'host-a', bootNonce: 'boot-new', graceMs: 1,
  }, {
    observe: async () => { throw new Error('must not inspect a prior boot pid'); },
    signalProcessGroup: () => { reusedSignals += 1; },
    wait: async () => undefined,
  });
  assert.deepEqual(await rebooted.terminate(claimedMission().claim.processes[0]!), {
    kind: 'already-exited',
  });
});

function claimedMission() {
  return {
    id: 'mission',
    revision: 3,
    state: 'diagnosing' as const,
    actionKey: 'diagnosis:mission',
    claim: {
      version: 1 as const,
      token: 'claim-current',
      daemonId: 'daemon-main',
      hostId: 'host-a',
      bootNonce: 'boot-a',
      fencingEpoch: 9,
      claimedAt: '2026-07-14T18:00:00.000Z',
      leaseUntil: '2026-07-14T18:05:00.000Z',
      processes: [{
        actionKey: 'diagnosis:mission',
        pid: 4242,
        hostId: 'host-a',
        bootNonce: 'boot-a',
        startedAt: '2026-07-14T18:00:01.000Z',
      }],
    },
  };
}

function applyPermit() {
  return createMissionApplyPermit({
    missionId: 'mission',
    actionKey: 'apply:mission',
    fencingEpoch: 9,
    expiresAt: '2099-07-14T19:00:00.000Z',
    targetRef: 'refs/heads/mission-test',
    auditReceiptSha256: `sha256:${'a'.repeat(64)}`,
    candidate: {
      baseCommit: '1'.repeat(40),
      baseTree: '2'.repeat(40),
      patchSha256: `sha256:${'b'.repeat(64)}`,
      treeSha: '3'.repeat(40),
      commitSha: '4'.repeat(40),
      manifest: [{
        path: 'src/value.ts',
        operation: 'modify',
        oldMode: '100644',
        newMode: '100644',
        beforeBlob: '5'.repeat(40),
        afterBlob: '6'.repeat(40),
        beforeSha256: `sha256:${'c'.repeat(64)}`,
        afterSha256: `sha256:${'d'.repeat(64)}`,
      }],
    },
    commit: {
      message: 'mission apply',
      authorName: 'codex-orchestrator',
      authorEmail: 'codex-orchestrator@localhost',
      authoredAt: '2026-07-14T18:00:00.000Z',
      committerName: 'codex-orchestrator',
      committerEmail: 'codex-orchestrator@localhost',
      committedAt: '2026-07-14T18:00:00.000Z',
    },
  });
}
