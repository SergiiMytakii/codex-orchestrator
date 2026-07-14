import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';

import { authorizeMissionCapability } from '../src/runner/mission-capability-kernel.js';
import { MissionStatePermitAuthority } from '../src/runner/mission-permit-authority.js';
import { MissionStateStore } from '../src/runner/mission-state-store.js';

test('permit authority atomically rejects replay, stale epoch, stale snapshot, and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-permit-authority-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const permit = authorizeMissionCapability({
    missionId: 'mission-a',
    actionKey: 'read-1',
    capability: 'read-file',
    argv: [],
    requestedPaths: ['src/value.ts'],
    grantedPaths: ['src/**'],
    readPath: 'src/value.ts',
    maxReadBytes: 4096,
    inputSnapshot: 'tree:abc',
    fencingEpoch: 4,
    expiresAt: '2026-07-14T14:00:00.000Z',
  });
  await store.mutate(0, (draft) => {
    draft.missions['mission-a'] = {
      id: 'mission-a',
      revision: 1,
      state: 'executing',
      inputSnapshot: 'tree:abc',
      fencingEpoch: 4,
      actionKey: 'read-1',
      authorizedPermit: permit,
    };
  });

  let now = new Date('2026-07-14T13:00:00.000Z');
  const authority = new MissionStatePermitAuthority(store, () => now);
  assert.deepEqual(await authority.begin(permit), { kind: 'execute' });
  assert.deepEqual(await authority.begin(permit), { kind: 'resume-in-flight' });
  await assert.rejects(authority.begin({
    ...permit,
    requestedPaths: ['src/other.ts'],
    readPath: 'src/other.ts',
  }), /durable authorization/);
  await assert.rejects(authority.begin({ ...permit, maxReadBytes: 8192 }), /durable authorization/);
  await assert.rejects(authority.begin({ ...permit, actionKey: 'read-2' }), /durable authorization/);
  await assert.rejects(authority.begin({ ...permit, fencingEpoch: 3 }), /epoch is stale/);
  await assert.rejects(authority.begin({
    ...permit,
    inputSnapshot: 'tree:moved',
  }), /snapshot is stale/);
  now = new Date('2026-07-14T14:00:01.000Z');
  await assert.rejects(authority.begin(permit), /expired/);
  const receiptPayload = Buffer.from('durable action result', 'utf8');
  now = new Date('2026-07-14T14:00:00.000Z');
  await assert.rejects(authority.complete(permit, receiptPayload), /expired/);
  now = new Date('2026-07-14T13:00:00.000Z');
  const refreshedPermit = { ...permit, expiresAt: '2026-07-14T15:00:00.000Z' };
  let current = await store.load();
  await store.mutate(current.generation, (draft) => {
    draft.missions['mission-a']!.authorizedPermit = refreshedPermit;
  });
  assert.deepEqual(await authority.begin(refreshedPermit), { kind: 'execute' });
  const artifactPayload = Buffer.from('durable patch artifact', 'utf8');
  const receiptSha256 = await authority.complete(refreshedPermit, receiptPayload, [artifactPayload]);
  assert.equal((await authority.readReceipt(receiptSha256)).toString('utf8'), 'durable action result');
  assert.equal((await authority.readReceipt(
    createHash('sha256').update(artifactPayload).digest('hex'),
  )).toString('utf8'), 'durable patch artifact');
  assert.deepEqual(await authority.begin(refreshedPermit), { kind: 'completed', receiptSha256 });
  now = new Date('2026-07-14T15:00:01.000Z');
  assert.deepEqual(await authority.begin(refreshedPermit), { kind: 'completed', receiptSha256 });
  assert.equal(await authority.complete(refreshedPermit, receiptPayload), receiptSha256);
  const secondRefresh = { ...permit, expiresAt: '2026-07-14T16:00:00.000Z' };
  current = await store.load();
  await store.mutate(current.generation, (draft) => {
    draft.missions['mission-a']!.authorizedPermit = secondRefresh;
  });
  await assert.rejects(authority.begin(secondRefresh), /completed action is bound/);

  current = await store.load();
  await store.mutate(current.generation, (draft) => {
    draft.missions['mission-a']!.state = 'cancelling';
  });
  await assert.rejects(authority.begin(permit), /revoked by current state/);
});
