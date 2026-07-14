import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';

import { acquireMissionCoordinatorLock } from '../src/runner/mission-coordinator-lock.js';

test('coordinator lock is exclusive and release is token-fenced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-coordinator-'));
  const first = await acquireMissionCoordinatorLock({
    targetRoot: root,
    stateDir: '.codex-orchestrator/state',
    hostId: 'host-a',
    bootNonce: 'boot-a',
    pid: 101,
    isProcessAlive: () => true,
  });

  await assert.rejects(acquireMissionCoordinatorLock({
    targetRoot: root,
    stateDir: '.codex-orchestrator/state',
    hostId: 'host-a',
    bootNonce: 'boot-b',
    pid: 102,
    isProcessAlive: () => true,
  }), /already owned/);

  const metadata = JSON.parse(await readFile(first.metadataPath, 'utf8')) as Record<string, unknown>;
  await writeFile(first.metadataPath, `${JSON.stringify({ ...metadata, token: 'replacement' })}\n`, 'utf8');
  await first.release();
  assert.equal((JSON.parse(await readFile(first.metadataPath, 'utf8')) as Record<string, unknown>).token, 'replacement');
});

test('coordinator lock reclaims only proven dead same-host owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-coordinator-stale-'));
  const lockDirectory = join(root, '.codex-orchestrator/state/mission-coordinator.lock');
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, 'owner.json'), `${JSON.stringify({
    version: 1,
    token: 'old',
    hostId: 'host-a',
    bootNonce: 'old-boot',
    pid: 90,
    acquiredAt: '2026-07-14T09:00:00.000Z',
  })}\n`, 'utf8');

  const lock = await acquireMissionCoordinatorLock({
    targetRoot: root,
    stateDir: '.codex-orchestrator/state',
    hostId: 'host-a',
    bootNonce: 'new-boot',
    pid: 101,
    isProcessAlive: (pid) => pid !== 90,
  });
  await lock.release();

  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, 'owner.json'), `${JSON.stringify({
    version: 1,
    token: 'foreign',
    hostId: 'host-b',
    bootNonce: 'boot-b',
    pid: 90,
    acquiredAt: '2026-07-14T09:00:00.000Z',
  })}\n`, 'utf8');
  await assert.rejects(acquireMissionCoordinatorLock({
    targetRoot: root,
    stateDir: '.codex-orchestrator/state',
    hostId: 'host-a',
    bootNonce: 'new-boot',
    pid: 101,
    isProcessAlive: () => false,
  }), /different host/);
});

test('two stale reclaimers cannot remove the newly acquired live lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-coordinator-dual-reclaim-'));
  const lockDirectory = join(root, '.codex-orchestrator/state/mission-coordinator.lock');
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, 'owner.json'), `${JSON.stringify({
    version: 1,
    token: 'dead-owner',
    hostId: 'host-a',
    bootNonce: 'dead-boot',
    pid: 90,
    acquiredAt: '2026-07-14T09:00:00.000Z',
  })}\n`, 'utf8');

  const contenders = [101, 102].map((pid) => acquireMissionCoordinatorLock({
    targetRoot: root,
    stateDir: '.codex-orchestrator/state',
    hostId: 'host-a',
    bootNonce: `boot-${pid}`,
    pid,
    isProcessAlive: (candidate) => candidate !== 90,
  }));
  const results = await Promise.allSettled(contenders);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const live = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8')) as { pid: number };
  assert.equal(live.pid === 101 || live.pid === 102, true);
  const winner = results.find((result): result is PromiseFulfilledResult<Awaited<typeof contenders[number]>> =>
    result.status === 'fulfilled');
  await winner?.value.release();
});

test('coordinator uses boot nonce for PID reuse and fails closed on orphan reclaim guard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-coordinator-boot-nonce-'));
  const lockDirectory = join(root, '.codex-orchestrator/state/mission-coordinator.lock');
  const owner = {
    version: 1,
    token: 'old-token',
    hostId: 'host-a',
    bootNonce: 'old-boot',
    pid: 101,
    acquiredAt: '2026-07-14T09:00:00.000Z',
  };
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, 'owner.json'), `${JSON.stringify(owner)}\n`, 'utf8');
  const reclaimed = await acquireMissionCoordinatorLock({
    targetRoot: root,
    stateDir: '.codex-orchestrator/state',
    hostId: 'host-a',
    bootNonce: 'new-boot',
    pid: 101,
    isProcessAlive: () => true,
  });
  await reclaimed.release();

  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, 'owner.json'), `${JSON.stringify(owner)}\n`, 'utf8');
  const guard = `${lockDirectory}.stale.${owner.token}`;
  await mkdir(guard, { recursive: true });
  await writeFile(join(guard, 'owner.json'), `${JSON.stringify(owner)}\n`, 'utf8');
  await assert.rejects(acquireMissionCoordinatorLock({
    targetRoot: root,
    stateDir: '.codex-orchestrator/state',
    hostId: 'host-a',
    bootNonce: 'newer-boot',
    pid: 101,
    isProcessAlive: () => true,
  }), /stale reclaim guard already exists/);
});
