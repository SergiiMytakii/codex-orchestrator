import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireOwnerControlLock, inspectOwnerControlLock, OwnerControlLockBlockedError } from '../src/v2/owner-control-lock.js';

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

test('foreign hosts and unknown boot changes stay blocked even when the recorded PID is absent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-foreign-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await acquireOwnerControlLock(input(root, 401, new Set([401])));
  const next = input(root, 402, new Set([402]));
  for (const identity of [{ host: 'host-b' }, { bootId: 'boot-b' }]) {
    assert.equal((await inspectOwnerControlLock({ ...next, ...identity })).status, 'ambiguous');
    await assert.rejects(acquireOwnerControlLock({ ...next, ...identity }), OwnerControlLockBlockedError);
  }
});

test('a new boot on the same host supersedes even an interrupted command from the previous boot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-reboot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = await acquireOwnerControlLock({
    ...input(root, 401, new Set([401])), bootId: '11111111-1111-4111-8111-111111111111',
  });
  await old.beginCommand();
  const next = {
    ...input(root, 402, new Set([401, 402])), bootId: '22222222-2222-4222-8222-222222222222',
  };
  assert.deepEqual(await inspectOwnerControlLock(next), { status: 'inactive' });
  const owner = await acquireOwnerControlLock(next);
  assert.deepEqual(await inspectOwnerControlLock(next), { status: 'active' });
  await owner.release();
});

test('a legacy boot record can be reclaimed after the recorded process is confirmed absent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-legacy-boot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await acquireOwnerControlLock({
    ...input(root, 401, new Set([401])), bootId: '{ sec = 1793946093, usec = 572479 } Fri Nov 6 08:21:33 2026',
  });
  const next = { ...input(root, 402, new Set([402])), bootId: '22222222-2222-4222-8222-222222222222' };
  const live = {
    ...input(root, 402, new Set([401, 402]), { waitMs: 5 }), bootId: next.bootId,
  };
  assert.deepEqual(await inspectOwnerControlLock(live), { status: 'active' });
  await assert.rejects(acquireOwnerControlLock(live), { kind: 'live-contention' });
  await assert.rejects(acquireOwnerControlLock({
    ...next,
    inspectProcessIdentity: async () => ({ status: 'unknown' }),
  }), OwnerControlLockBlockedError);
  await assert.rejects(acquireOwnerControlLock({
    ...next,
    inspectProcessIdentity: async () => ({ status: 'present', processStartIdentity: 'unmatched-start' }),
  }), OwnerControlLockBlockedError);
  const owner = await acquireOwnerControlLock(next);
  await owner.release();
});

test('malformed boot IDs cannot authorize replacement of an owner record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-malformed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = input(root, 401, new Set([401]));
  await acquireOwnerControlLock(owner);
  const store = join(root, 'v2', 'owner-control.git');
  const ref = 'refs/codex-orchestrator/owners/' + createHash('sha256').update(owner.canonicalRepository).digest('hex');
  const git = (args: string[], stdin?: string) =>
    execFileSync('git', ['--git-dir', store, ...args], { input: stdin, encoding: 'utf8' }).trim();
  const record = JSON.parse(git(['cat-file', 'blob', ref]));
  const next = { ...input(root, 402, new Set([402])), bootId: '22222222-2222-4222-8222-222222222222' };
  for (const bootId of [123, ['11111111-1111-4111-8111-111111111111']]) {
    const oid = git(['hash-object', '-w', '--stdin'], JSON.stringify({ ...record, bootId }));
    git(['update-ref', ref, oid]);
    assert.equal((await inspectOwnerControlLock(next)).status, 'ambiguous');
    await assert.rejects(acquireOwnerControlLock(next), /owner control record is malformed/u);
    assert.equal(git(['rev-parse', ref]), oid);
  }
});

test('durable unresolved command fence survives a dead owner and preserves repository ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-command-fence-'));
  const first = await acquireOwnerControlLock(input(root, 501, new Set([501])));
  await first.fenceCommand({ pid: 2_147_483_647, processGroupId: 2_147_483_647, streamsUnconfirmed: true });
  await assert.rejects(first.release(), /owner lock retained/u);
  await assert.rejects(acquireOwnerControlLock({ ...input(root, 502, new Set([502])),
    inspectProcessIdentity: async () => ({ status: 'absent' as const }),
  }), /owned command group cleanup is unconfirmed/u);
});

test('command fence permits reclaim only after positive leader and group absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-command-absence-'));
  const first = await acquireOwnerControlLock(input(root, 601, new Set([601])));
  await first.fenceCommand({ pid: 2_147_483_647, processGroupId: 2_147_483_647, streamsUnconfirmed: false });
  await assert.rejects(acquireOwnerControlLock({ ...input(root, 602, new Set([602])),
    inspectProcessIdentity: async (pid) => pid === 2_147_483_647
      ? { status: 'unknown' as const } : { status: 'absent' as const },
  }), /owned command group cleanup is unconfirmed/u);
  const second = await acquireOwnerControlLock({ ...input(root, 603, new Set([603])),
    inspectProcessIdentity: async () => ({ status: 'absent' as const }),
  });
  await second.release();
});

test('failed fence persistence does not authorize release of the existing owner lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-command-invalid-'));
  const first = await acquireOwnerControlLock(input(root, 701, new Set([701])));
  await assert.rejects(first.fenceCommand({ pid: -1, processGroupId: 0, streamsUnconfirmed: true }), /identity is invalid/u);
  await assert.rejects(first.release(), /owner lock retained/u);
  await assert.rejects(acquireOwnerControlLock(input(root, 702, new Set([701]), { waitMs: 5 })), /timed out/u);
});


test('concurrent command receipts cannot release ownership before every command settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-concurrent-command-'));
  const first = await acquireOwnerControlLock(input(root, 801, new Set([801])));
  await Promise.all([first.beginCommand(), first.beginCommand()]);
  await first.completeCommand();
  await assert.rejects(first.release(), /owner lock retained/u);
  await first.completeCommand();
  await first.release();
});

test('real runner crash with a durable prelaunch receipt fences a fresh runner', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-control-prelaunch-restart-'));
  const moduleUrl = new URL('../src/v2/owner-control-lock.js', import.meta.url).href;
  const base = `import { acquireOwnerControlLock } from ${JSON.stringify(moduleUrl)};
    import { hostname } from 'node:os';
    const input = { orchestratorHome: ${JSON.stringify(root)}, canonicalRepository: 'owner/repo',
      bootId: 'same-boot', host: hostname(), pid: process.pid,
      now: () => new Date().toISOString(), createToken: () => String(process.pid),
      processAlive: () => false, waitMs: 0 };
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', `${base}
    const lock = await acquireOwnerControlLock(input);
    await lock.beginCommand(); process.stdout.write('checkpoint'); setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ownerExit = once(owner, 'exit');
  try {
    let timer: NodeJS.Timeout | undefined;
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('owner did not checkpoint')), 5_000);
      owner.stdout.on('data', (bytes) => { if (bytes.toString().includes('checkpoint')) { clearTimeout(timer); resolve(); } });
      owner.once('error', reject);
    });
    owner.kill('SIGKILL');
    await ownerExit;
    const fresh = spawn(process.execPath, ['--input-type=module', '-e', `${base}
      try { await acquireOwnerControlLock(input); process.stdout.write('unexpected-acquisition'); }
      catch (error) { process.stdout.write(error.message); }
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    fresh.stdout.on('data', (bytes) => { output += bytes.toString(); });
    const [code] = await once(fresh, 'exit');
    assert.equal(code, 0);
    assert.match(output, /owned command group cleanup is unconfirmed/u);
    assert.doesNotMatch(output, /unexpected-acquisition/u);
  } finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); }
});
