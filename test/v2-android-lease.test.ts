import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { sha256 } from '../src/v2/containment.js';
import { FileAndroidLeaseVerifier, type AndroidLeaseRecordV1 } from '../src/v2/mobile-lease.js';
import { RunnerAndroidProofController } from '../src/v2/android-proof-runner.js';

test('durable Android release retries failed stop and removes host resources while retaining proof evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-lease-cleanup-'));
  try {
    const leaseRoot = join(root, 'leases');
    const proofRoot = join(root, 'proofs/proof-cleanup');
    await mkdir(leaseRoot); await mkdir(proofRoot, { recursive: true });
    const record: AndroidLeaseRecordV1 = {
      schema: 'codex-orchestrator.android-lease', version: 1, status: 'active', proofId: 'proof-cleanup',
      token: 'cleanup-token', serial: 'emulator-5554', appId: 'ai.levantem.sirbro', ownerPid: process.pid, appPid: 42,
      runnerCreated: true, emulatorPid: 99, emulatorProcessIdentity: 'darwin:owned-start', dataDir: join(root, 'data'),
      acquiredAt: '2026-07-28T09:00:00.000Z', expiresAt: '2026-07-28T09:30:00.000Z', updatedAt: '2026-07-28T09:00:00.000Z',
    };
    const preparedPath = join(leaseRoot, `android.prepared.${sha256(record.proofId)}.json`);
    await writeFile(join(leaseRoot, 'android.json'), JSON.stringify(record));
    await writeFile(join(proofRoot, 'android-lease.json'), JSON.stringify(record));
    await writeFile(join(proofRoot, 'android-final.png'), 'retained screenshot');
    await writeFile(preparedPath, JSON.stringify({ schema: 'codex-orchestrator.android-prepared', version: 1, proofId: record.proofId, leaseToken: record.token }));
    await writeFile(join(leaseRoot, 'android-install-cleanup-token.apk'), 'interrupted install snapshot');
    let stops = 0;
    const verifier = () => new FileAndroidLeaseVerifier({
      leaseRoot, worktreeRoot: root,
      artifactRelativePathForProof: proofId => `proofs/${proofId}/android-lease.json`,
      targetController: { release: async () => { if (++stops === 1) throw new Error('stop unconfirmed'); } },
    });
    await assert.rejects(verifier().release(record.proofId), /stop unconfirmed/u);
    assert.equal((await readdir(leaseRoot)).length, 3);
    await verifier().release(record.proofId);
    assert.deepEqual(await readdir(leaseRoot), []);
    await verifier().release(record.proofId);
    assert.equal(stops, 2);
    assert.equal(JSON.parse(await readFile(join(proofRoot, 'android-lease.json'), 'utf8')).status, 'released');
    assert.equal(await readFile(join(proofRoot, 'android-final.png'), 'utf8'), 'retained screenshot');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing Android lease cannot report cleanup complete while preparation resources remain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-preparation-cleanup-'));
  try {
    const path = join(root, 'android.preparation.json');
    await writeFile(path, JSON.stringify({ proofId: 'proof-preparation' }));
    const verifier = new FileAndroidLeaseVerifier({ leaseRoot: root, worktreeRoot: root });
    await assert.rejects(verifier.release('proof-preparation'), /preparation.*cleanup/iu);
    assert.ok(await readFile(path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('durable cleanup recovers a booting owned emulator before lease creation and preserves a foreign preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-prelease-recovery-'));
  try {
    const dataDir = join(root, 'data');
    const path = join(root, 'android.preparation.json');
    await mkdir(dataDir);
    await writeFile(path, JSON.stringify({
      schema: 'codex-orchestrator.android-preparation', version: 1, proofId: 'proof-preparation', token: 'preparation-token',
      ownerPid: process.pid, ownerProcessIdentity: 'darwin:runner-start', serial: 'emulator-5554', dataDir,
      emulatorPid: 99, emulatorProcessIdentity: 'darwin:owned-start',
    }));
    let running = true;
    const controller = new RunnerAndroidProofController({
      adbPath: '/unused/adb', emulatorPath: '/unused/emulator',
      readProcessIdentity: async () => running ? 'darwin:owned-start' : undefined,
      signalProcess: () => { running = false; }, removeDataDir: async path => { await rm(path, { recursive: true }); },
    });
    const verifier = new FileAndroidLeaseVerifier({ leaseRoot: root, worktreeRoot: root, targetController: controller });
    await assert.rejects(verifier.release('foreign-proof'), /another proof/u);
    assert.equal(running, true);
    await verifier.release('proof-preparation');
    assert.equal(running, false);
    assert.deepEqual(await readdir(root), []);
    await verifier.release('proof-preparation');
  } finally { await rm(root, { recursive: true, force: true }); }
});
