import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireOwnerControlLock, OwnerControlLockBlockedError } from '../src/v2/owner-control-lock.js';

test('host-global owner ref serializes distinct target clones and release is token-safe', async () => {
  const orchestratorHome = await mkdtemp(join(tmpdir(), 'owner-control-'));
  const alive = new Set([101]);
  const first = await acquireOwnerControlLock(input(orchestratorHome, 101, alive));
  await assert.rejects(acquireOwnerControlLock(input(orchestratorHome, 202, alive, { waitMs: 5 })), OwnerControlLockBlockedError);

  alive.delete(101);
  alive.add(202);
  const second = await acquireOwnerControlLock(input(orchestratorHome, 202, alive));
  await first.release();
  await assert.rejects(acquireOwnerControlLock(input(orchestratorHome, 303, alive, { waitMs: 5 })), OwnerControlLockBlockedError);
  await second.release();
  alive.delete(202);
  const third = await acquireOwnerControlLock(input(orchestratorHome, 303, alive));
  await third.release();
});

test('stale reclaimer cannot replace the winner after observed-old barrier', async () => {
  const orchestratorHome = await mkdtemp(join(tmpdir(), 'owner-control-race-'));
  const alive = new Set<number>();
  const dead = await acquireOwnerControlLock(input(orchestratorHome, 101, alive));
  void dead;

  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  let observed!: () => void;
  const observedPromise = new Promise<void>((resolve) => { observed = resolve; });
  const stale = acquireOwnerControlLock(input(orchestratorHome, 202, alive, {
    waitMs: 20,
    afterObservedOwner: async () => { observed(); await barrier; },
  }));
  await observedPromise;
  alive.add(303);
  const winner = await acquireOwnerControlLock(input(orchestratorHome, 303, alive));
  releaseBarrier();
  await assert.rejects(stale, OwnerControlLockBlockedError);
  await winner.release();
});

function input(
  orchestratorHome: string,
  pid: number,
  alive: Set<number>,
  overrides: { waitMs?: number; afterObservedOwner?: () => Promise<void> } = {},
) {
  return {
    orchestratorHome,
    canonicalRepository: 'owner/repo',
    bootId: 'boot-a',
    host: 'host-a',
    pid,
    now: () => '2026-07-17T00:00:00.000Z',
    createToken: () => `token-${pid}`,
    processAlive: (candidate: number) => alive.has(candidate),
    waitMs: overrides.waitMs ?? 100,
    pollMs: 1,
    afterObservedOwner: overrides.afterObservedOwner,
  };
}
