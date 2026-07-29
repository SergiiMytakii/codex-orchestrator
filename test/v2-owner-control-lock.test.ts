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
    processStartIdentity: `start-${pid}`,
    inspectProcessIdentity: async (candidate: number) => alive.has(candidate)
      ? { status: 'present' as const, processStartIdentity: `start-${candidate}` }
      : { status: 'absent' as const },
    waitMs: overrides.waitMs ?? 100,
    pollMs: 1,
    afterObservedOwner: overrides.afterObservedOwner,
  };
}

test('dead-owner reclaim is PID-reuse resistant and live or unknown identity stays fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-identity-'));
  const alive = new Set([101]);
  const first = await acquireOwnerControlLock(input(root, 101, alive));
  void first;

  await assert.rejects(acquireOwnerControlLock({ ...input(root, 202, new Set([101, 202]), { waitMs: 5 }),
    inspectProcessIdentity: async (pid) => pid === 101
      ? { status: 'present' as const, processStartIdentity: 'start-101' }
      : { status: 'present' as const, processStartIdentity: 'start-202' },
  }), /timed out/u);

  const reused = await acquireOwnerControlLock({ ...input(root, 202, new Set([202])),
    inspectProcessIdentity: async (pid) => pid === 101
      ? { status: 'present' as const, processStartIdentity: 'different-start' }
      : { status: 'present' as const, processStartIdentity: 'start-202' },
  });
  await reused.release();

  const unknownRoot = await mkdtemp(join(tmpdir(), 'owner-control-unknown-'));
  await acquireOwnerControlLock(input(unknownRoot, 301, new Set([301])));
  await assert.rejects(acquireOwnerControlLock({ ...input(unknownRoot, 302, new Set([302]), { waitMs: 5 }),
    inspectProcessIdentity: async () => ({ status: 'unknown' as const }),
  }), OwnerControlLockBlockedError);
  await assert.rejects(acquireOwnerControlLock({ ...input(unknownRoot, 303, new Set([303]), { waitMs: 5 }),
    inspectProcessIdentity: async () => { throw new Error('inspection failed'); },
  }), OwnerControlLockBlockedError);
});

test('foreign host or boot ownership stays fail closed even when the recorded PID is absent', async () => {
  for (const identity of [{ host: 'host-b' }, { bootId: 'boot-b' }]) {
    const root = await mkdtemp(join(tmpdir(), 'owner-control-foreign-'));
    await acquireOwnerControlLock(input(root, 401, new Set([401])));
    await assert.rejects(acquireOwnerControlLock({
      ...input(root, 402, new Set([402]), { waitMs: 5 }),
      ...identity,
      inspectProcessIdentity: async () => ({ status: 'absent' as const }),
    }), OwnerControlLockBlockedError);
  }
});
