import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';
import {
  MissionScheduler,
  listEligibleMissions,
} from '../src/runner/mission-scheduler.js';
import type { MissionRecord } from '../src/runner/mission-state-machine.js';
import {
  MissionStateStore,
  type MissionStateSnapshot,
} from '../src/runner/mission-state-store.js';

test('scheduler atomically indexes, claims, and reclaims resumable work by generation and revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-scheduler-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const scheduler = new MissionScheduler(store);
  const created = await store.mutate(0, (draft) => {
    draft.missions['mission-227'] = {
      id: 'mission-227',
      revision: 1,
      state: 'diagnosing',
      actionKey: 'diagnosis:227',
    };
    draft.reservations['mission-227'] = {
      revision: 1,
      value: {
        missionId: 'mission-227',
        paths: ['src/**'],
        fencingEpoch: 9,
        leaseUntil: '2026-07-14T18:04:00.000Z',
      },
    };
  });
  const deferred = await scheduler.defer({
    expectedGeneration: created.generation,
    missionId: 'mission-227',
    expectedRevision: 1,
    event: {
      type: 'diagnosis-transient-failure',
      actionKey: 'diagnosis:227',
      nextEligibleAt: '2026-07-14T18:05:00.000Z',
    },
    reason: 'model-transport-retry',
    requiredPredicate: 'model transport is reachable',
  });
  assert.equal(deferred.reservations['mission-227'], undefined);

  assert.deepEqual(listEligibleMissions(deferred, '2026-07-14T18:04:59.999Z'), []);
  assert.deepEqual(listEligibleMissions(deferred, '2026-07-14T18:05:00.000Z'), [{
    missionId: 'mission-227',
    revision: 2,
    state: 'resumable',
    nextEligibleAt: '2026-07-14T18:05:00.000Z',
    actionKey: 'diagnosis:227',
    recovery: false,
  }]);

  const claimInput = {
    expectedGeneration: deferred.generation,
    missionId: 'mission-227',
    expectedRevision: 2,
    now: '2026-07-14T18:05:00.000Z',
    claim: {
      version: 1 as const,
      token: 'claim-a',
      daemonId: 'daemon-main',
      hostId: 'host-a',
      bootNonce: 'boot-a',
      fencingEpoch: 9,
      claimedAt: '2026-07-14T18:05:00.000Z',
      leaseUntil: '2026-07-14T18:10:00.000Z',
      processes: [],
    },
  };
  const raced = await Promise.allSettled([
    scheduler.claim(claimInput),
    scheduler.claim({ ...claimInput, claim: { ...claimInput.claim, token: 'claim-b' } }),
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((result) => result.status === 'rejected').length, 1);
  const claimed = await store.load();
  assert.equal(claimed.missions['mission-227']?.state, 'diagnosing');
  assert.equal(claimed.missions['mission-227']?.actionKey, 'diagnosis:227');
  assert.equal(claimed.missions['mission-227']?.claim?.token === 'claim-a'
    || claimed.missions['mission-227']?.claim?.token === 'claim-b', true);
  assert.equal(claimed.nextEligibleAt['mission-227'], '2026-07-14T18:10:00.000Z');

  const active = claimed.missions['mission-227']!;
  const reclaimed = await scheduler.claim({
    ...claimInput,
    expectedGeneration: claimed.generation,
    expectedRevision: active.revision,
    now: '2026-07-14T18:10:00.000Z',
    claim: {
      ...claimInput.claim,
      token: 'claim-recovered',
      claimedAt: '2026-07-14T18:10:00.000Z',
      leaseUntil: '2026-07-14T18:15:00.000Z',
    },
  });
  assert.equal(reclaimed.missions['mission-227']?.state, 'diagnosing');
  assert.equal(reclaimed.missions['mission-227']?.actionKey, 'diagnosis:227');
  assert.equal(reclaimed.missions['mission-227']?.claim?.token, 'claim-recovered');
});

test('scheduler registers process identity only for the current claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-scheduler-process-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const scheduler = new MissionScheduler(store);
  const initial = await store.mutate(0, (draft) => {
    draft.missions.mission = activeMission();
    draft.nextEligibleAt.mission = activeMission().claim!.leaseUntil;
  });
  const saved = await scheduler.registerProcess({
    expectedGeneration: initial.generation,
    missionId: 'mission',
    expectedRevision: 3,
    claimToken: 'claim-current',
    process: {
      actionKey: 'action-1',
      pid: 1234,
      hostId: 'host-a',
      bootNonce: 'boot-a',
      startedAt: '2026-07-14T18:00:00.000Z',
    },
  });
  assert.deepEqual(saved.missions.mission?.claim?.processes, [{
    actionKey: 'action-1',
    pid: 1234,
    hostId: 'host-a',
    bootNonce: 'boot-a',
    startedAt: '2026-07-14T18:00:00.000Z',
  }]);
  const completed = await scheduler.completeProcess({
    expectedGeneration: saved.generation,
    missionId: 'mission',
    expectedRevision: saved.missions.mission!.revision,
    claimToken: 'claim-current',
    actionKey: 'action-1',
    pid: 1234,
  });
  assert.deepEqual(completed.missions.mission?.claim?.processes, []);
  await assert.rejects(scheduler.registerProcess({
    expectedGeneration: completed.generation,
    missionId: 'mission',
    expectedRevision: completed.missions.mission!.revision,
    claimToken: 'claim-stale',
    process: {
      actionKey: 'action-2',
      pid: 5678,
      hostId: 'host-a',
      bootNonce: 'boot-a',
      startedAt: '2026-07-14T18:01:00.000Z',
    },
  }), /claim token mismatch/);
});

test('scheduler indexes every transient resume target and refuses to drop a live process handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-scheduler-targets-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const scheduler = new MissionScheduler(store);
  const cases = [
    ['claiming', 'claim-transient-failure', 'claiming'],
    ['diagnosing', 'diagnosis-transient-failure', 'diagnosing'],
    ['authorizing', 'authorization-temporary', 'authorizing'],
    ['executing', 'execution-transient-failure', 'authorizing'],
    ['apply-authorizing', 'apply-authorization-temporary', 'apply-authorizing'],
    ['reconciling', 'reconciliation-transient-failure', 'reconciling'],
    ['publication-prepared', 'publication-transient-failure', 'publication-prepared'],
  ] as const;
  let snapshot = await store.mutate(0, (draft) => {
    for (const [state] of cases) {
      draft.missions[state] = { id: state, revision: 1, state, actionKey: `action:${state}` };
    }
  });
  for (const [state, type, resumeTarget] of cases) {
    snapshot = await scheduler.defer({
      expectedGeneration: snapshot.generation,
      missionId: state,
      expectedRevision: 1,
      event: {
        type,
        actionKey: `action:${state}`,
        nextEligibleAt: '2026-07-14T18:05:00.000Z',
      },
      reason: `${state}-retry`,
      requiredPredicate: `${state} retry is eligible`,
    });
    assert.equal(snapshot.missions[state]?.resumeTarget, resumeTarget);
    assert.equal(snapshot.nextEligibleAt[state], '2026-07-14T18:05:00.000Z');
  }

  const active = await store.mutate(snapshot.generation, (draft) => {
    draft.missions.live = activeMission('live');
    draft.missions.live!.claim!.processes = [{
      actionKey: 'action-1',
      pid: 1234,
      hostId: 'host-a',
      bootNonce: 'boot-a',
      startedAt: '2026-07-14T18:00:00.000Z',
    }];
    draft.nextEligibleAt.live = activeMission('live').claim!.leaseUntil;
  });
  await assert.rejects(scheduler.defer({
    expectedGeneration: active.generation,
    missionId: 'live',
    expectedRevision: 3,
    event: {
      type: 'diagnosis-transient-failure',
      actionKey: 'action-1',
      nextEligibleAt: '2026-07-14T18:10:00.000Z',
    },
    reason: 'retry',
    requiredPredicate: 'worker available',
  }), /live process handles/);
});

test('eligible index handles 100 due missions with 10000 retained tombstones without mission scans', () => {
  const missionMap: Record<string, ReturnType<typeof resumableMission>> = {};
  const nextEligibleAt: Record<string, string> = {};
  for (let index = 0; index < 100; index += 1) {
    const id = `mission-${String(index).padStart(3, '0')}`;
    missionMap[id] = resumableMission(id, '2026-07-14T18:00:00.000Z');
    nextEligibleAt[id] = '2026-07-14T18:00:00.000Z';
  }
  const missions = new Proxy(missionMap, {
    ownKeys: () => { throw new Error('scheduler scanned every mission'); },
  });
  const tombstones = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
    `old-${index}`,
    { kind: 'mission' as const, terminalState: 'completed', retainedAt: '2026-07-14T00:00:00.000Z' },
  ]));
  const snapshot = {
    version: 1,
    generation: 1,
    checksum: `sha256:${'0'.repeat(64)}`,
    missions,
    planParents: {},
    publications: {},
    reservations: {},
    nextEligibleAt,
    tombstones,
    blobs: {},
  } satisfies MissionStateSnapshot;

  const eligible = listEligibleMissions(snapshot, '2026-07-14T18:00:00.000Z', 100);
  assert.equal(eligible.length, 100);
  assert.equal(eligible[0]?.missionId, 'mission-000');
  assert.equal(eligible.at(-1)?.missionId, 'mission-099');
});

test('expired claims from every nonterminal state are restart-eligible without a blocked outcome', () => {
  const states = [
    'created', 'claiming', 'evaluating', 'diagnosing', 'authorizing', 'executing',
    'auditing', 'apply-authorizing', 'apply-prepared', 'applying', 'reconciling',
    'candidate-ready', 'publication-prepared', 'integration-ready', 'cancelling',
  ] as const;
  const missions = Object.fromEntries(states.map((state) => [state, {
    id: state,
    revision: 1,
    state,
    actionKey: `action:${state}`,
    claim: {
      ...activeMission().claim,
      token: `claim:${state}`,
      processes: [],
    },
  }])) as MissionStateSnapshot['missions'];
  const snapshot = {
    version: 1 as const,
    generation: 1,
    checksum: `sha256:${'0'.repeat(64)}`,
    missions,
    planParents: {}, publications: {}, reservations: {}, tombstones: {}, blobs: {},
    nextEligibleAt: Object.fromEntries(states.map((state) => [
      state, '2026-07-14T18:05:00.000Z',
    ])),
  };
  const eligible = listEligibleMissions(snapshot, '2026-07-14T18:05:00.000Z', 100);
  assert.deepEqual(eligible.map((entry) => entry.state), [...states].sort());
  assert.equal(eligible.every((entry) => entry.recovery), true);
  assert.equal(JSON.stringify(eligible).includes('blocked'), false);
});

test('restart reclaim drops prior-boot process handles and rejects a different host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-scheduler-restart-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const scheduler = new MissionScheduler(store);
  const initial = await store.mutate(0, (draft) => {
    const mission = activeMission();
    mission.claim.processes = [{
      actionKey: 'action-1',
      pid: 1234,
      hostId: 'host-a',
      bootNonce: 'boot-a',
      startedAt: '2026-07-14T18:00:00.000Z',
    }];
    draft.missions.mission = mission;
    draft.nextEligibleAt.mission = mission.claim.leaseUntil;
  });

  await assert.rejects(scheduler.claim({
    expectedGeneration: initial.generation,
    missionId: 'mission',
    expectedRevision: 3,
    now: '2026-07-14T18:05:00.000Z',
    claim: {
      ...activeMission().claim,
      token: 'other-host',
      hostId: 'host-b',
      claimedAt: '2026-07-14T18:05:00.000Z',
      leaseUntil: '2026-07-14T18:10:00.000Z',
      processes: [],
    },
  }), /another host/);

  const unchanged = await store.load();
  const reclaimed = await scheduler.claim({
    expectedGeneration: unchanged.generation,
    missionId: 'mission',
    expectedRevision: 3,
    now: '2026-07-14T18:05:00.000Z',
    claim: {
      ...activeMission().claim,
      token: 'after-reboot',
      bootNonce: 'boot-b',
      claimedAt: '2026-07-14T18:05:00.000Z',
      leaseUntil: '2026-07-14T18:10:00.000Z',
      processes: [],
    },
  });
  assert.deepEqual(reclaimed.missions.mission?.claim?.processes, []);
  assert.equal(reclaimed.missions.mission?.claim?.bootNonce, 'boot-b');
});

test('terminal retention compacts the aggregate and scheduler metadata to a tombstone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-scheduler-retention-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const scheduler = new MissionScheduler(store);
  const saved = await store.mutate(0, (draft) => {
    draft.missions.done = { id: 'done', revision: 4, state: 'completed' };
  });
  const compacted = await scheduler.compactTerminal({
    expectedGeneration: saved.generation,
    missionId: 'done',
    expectedRevision: 4,
    retainedAt: '2026-07-14T19:00:00.000Z',
  });

  assert.equal(compacted.missions.done, undefined);
  assert.equal(compacted.nextEligibleAt.done, undefined);
  assert.deepEqual(compacted.tombstones.done, {
    kind: 'mission',
    terminalState: 'completed',
    retainedAt: '2026-07-14T19:00:00.000Z',
  });
});

function activeMission(id = 'mission'): MissionRecord & { claim: NonNullable<MissionRecord['claim']> } {
  return {
    id,
    revision: 3,
    state: 'diagnosing' as const,
    actionKey: 'action-1',
    claim: {
      version: 1 as const,
      token: 'claim-current',
      daemonId: 'daemon-main',
      hostId: 'host-a',
      bootNonce: 'boot-a',
      fencingEpoch: 9,
      claimedAt: '2026-07-14T18:00:00.000Z',
      leaseUntil: '2026-07-14T18:05:00.000Z',
      processes: [],
    },
  };
}

function resumableMission(id: string, nextEligibleAt: string) {
  return {
    id,
    revision: 2,
    state: 'resumable' as const,
    resumeTarget: 'diagnosing' as const,
    nextEligibleAt,
    actionKey: `action:${id}`,
    resumableReason: 'backoff',
    requiredPredicate: 'retry time reached',
  };
}
