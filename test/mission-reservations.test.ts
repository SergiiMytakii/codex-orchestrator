import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';

import { MissionReservationCoordinator } from '../src/runner/mission-reservations.js';
import { MissionStateStore } from '../src/runner/mission-state-store.js';

test('scope reservations reject overlap atomically and allow disjoint missions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-reservations-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const coordinator = new MissionReservationCoordinator(
    store,
    () => new Date('2026-07-14T10:00:00.000Z'),
  );
  const first = await coordinator.reserve(0, {
    missionId: 'mission-a',
    paths: ['src/runner/**'],
    fencingEpoch: 1,
    leaseUntil: '2026-07-14T11:00:00.000Z',
  });

  await assert.rejects(coordinator.reserve(first.generation, {
    missionId: 'mission-b',
    paths: ['src/runner/mission.ts'],
    fencingEpoch: 1,
    leaseUntil: '2026-07-14T11:00:00.000Z',
  }), /overlaps mission-a/);
  assert.equal((await store.load()).generation, first.generation);

  const disjoint = await coordinator.reserve(first.generation, {
    missionId: 'mission-b',
    paths: ['docs/**'],
    fencingEpoch: 1,
    leaseUntil: '2026-07-14T11:00:00.000Z',
  });
  assert.equal(disjoint.generation, first.generation + 1);
});

test('reservation release is owner and fencing-epoch guarded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-reservation-release-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const coordinator = new MissionReservationCoordinator(
    store,
    () => new Date('2026-07-14T10:00:00.000Z'),
  );
  const claimed = await coordinator.reserve(0, {
    missionId: 'mission-a',
    paths: ['src/**'],
    fencingEpoch: 2,
    leaseUntil: '2026-07-14T11:00:00.000Z',
  });

  await assert.rejects(
    coordinator.release(claimed.generation, 'mission-a', 1),
    /fencing epoch/,
  );
  const released = await coordinator.release(claimed.generation, 'mission-a', 2);
  assert.deepEqual(released.reservations, {});
});

test('expired reservations are reclaimed inside the same atomic generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-reservation-expiry-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const beforeExpiry = new MissionReservationCoordinator(
    store,
    () => new Date('2026-07-14T10:00:00.000Z'),
  );
  const claimed = await beforeExpiry.reserve(0, {
    missionId: 'mission-a',
    paths: ['src/**'],
    fencingEpoch: 1,
    leaseUntil: '2026-07-14T10:01:00.000Z',
  });
  const afterExpiry = new MissionReservationCoordinator(
    store,
    () => new Date('2026-07-14T10:01:00.001Z'),
  );
  const reclaimed = await afterExpiry.reserve(claimed.generation, {
    missionId: 'mission-b',
    paths: ['src/runner/**'],
    fencingEpoch: 1,
    leaseUntil: '2026-07-14T10:02:00.000Z',
  });
  assert.deepEqual(Object.keys(reclaimed.reservations), ['mission-b']);
});

test('reservation intersection detects crossing wildcard languages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-reservation-glob-intersection-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const coordinator = new MissionReservationCoordinator(
    store,
    () => new Date('2026-07-14T10:00:00.000Z'),
  );
  const claimed = await coordinator.reserve(0, {
    missionId: 'mission-a',
    paths: ['src/*/foo'],
    fencingEpoch: 2,
    leaseUntil: '2026-07-14T11:00:00.000Z',
  });
  await assert.rejects(coordinator.reserve(claimed.generation, {
    missionId: 'mission-b',
    paths: ['src/bar/*'],
    fencingEpoch: 2,
    leaseUntil: '2026-07-14T11:00:00.000Z',
  }), /overlaps mission-a/);
});

test('stale fencing epoch cannot renew a newer reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-reservation-stale-renewal-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const coordinator = new MissionReservationCoordinator(
    store,
    () => new Date('2026-07-14T10:00:00.000Z'),
  );
  const claimed = await coordinator.reserve(0, {
    missionId: 'mission-a',
    paths: ['src/**'],
    fencingEpoch: 3,
    leaseUntil: '2026-07-14T11:00:00.000Z',
  });
  await assert.rejects(coordinator.reserve(claimed.generation, {
    missionId: 'mission-a',
    paths: ['src/**'],
    fencingEpoch: 2,
    leaseUntil: '2026-07-14T11:30:00.000Z',
  }), /stale fencing epoch/);
});

test('reservation rejects empty segments and mutation-shaped renewal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-reservation-renewal-contract-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const coordinator = new MissionReservationCoordinator(
    store,
    () => new Date('2026-07-14T10:00:00.000Z'),
  );
  assert.throws(() => coordinator.reserve(0, {
    missionId: 'mission-empty',
    paths: ['foo/'],
    fencingEpoch: 1,
    leaseUntil: '2026-07-14T11:00:00.000Z',
  }), /empty segments/);
  const claimed = await coordinator.reserve(0, {
    missionId: 'mission-a',
    paths: ['src/**'],
    fencingEpoch: 2,
    leaseUntil: '2026-07-14T11:00:00.000Z',
  });
  await assert.rejects(coordinator.reserve(claimed.generation, {
    missionId: 'mission-a',
    paths: ['docs/**'],
    fencingEpoch: 2,
    leaseUntil: '2026-07-14T11:30:00.000Z',
  }), /cannot change scope/);
  await assert.rejects(coordinator.reserve(claimed.generation, {
    missionId: 'mission-a',
    paths: ['src/**'],
    fencingEpoch: 2,
    leaseUntil: '2026-07-14T10:30:00.000Z',
  }), /cannot shorten lease/);
  await assert.rejects(coordinator.reserve(claimed.generation, {
    missionId: 'mission-a',
    paths: ['src/**'],
    fencingEpoch: 3,
    leaseUntil: '2026-07-14T11:30:00.000Z',
  }), /cannot change fencing epoch/);
});
