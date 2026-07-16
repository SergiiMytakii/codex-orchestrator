import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { canonicalJson } from '../src/v2/containment.js';
import { FileAndroidLeaseVerifier } from '../src/v2/mobile-lease.js';

const leaseTool = resolve('internal-skills/acceptance-proof/tools/android-lease.mjs');

test('Android lease helper acquires one emulator, binds exact app PID, verifies, and releases token-safely', async () => {
  await withFixture(async ({ root, adb }) => {
    const acquired = await invoke(['acquire', common(root), '--proof-id', 'proof-android', '--app-id', 'dev.codex.proof', '--owner-pid', String(process.pid)], {
      adb,
      devices: 'emulator-5580 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64\n',
    });
    assert.equal(acquired.exitCode, 0, `${acquired.stderr}\n${acquired.stdout}`);
    assert.equal(acquired.json.status, 'acquired');
    assert.equal(acquired.json.serial, 'emulator-5580');
    assert.equal(typeof acquired.json.token, 'string');

    const bound = await invoke(['bind', common(root), '--proof-id', 'proof-android', '--token', String(acquired.json.token)], {
      adb, devices: 'emulator-5580 device model:sdk\n', appPid: '4242\n',
    });
    assert.equal(bound.exitCode, 0, `${bound.stderr}\n${bound.stdout}`);
    assert.equal(bound.json.appPid, 4242);

    const verified = await invoke(['verify', common(root), '--proof-id', 'proof-android', '--token', String(acquired.json.token)], {
      adb, devices: 'emulator-5580 device model:sdk\n', appPid: '4242\n',
    });
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.equal(verified.json.status, 'verified');

    const wrongRelease = await invoke(['release', common(root), '--proof-id', 'proof-android', '--token', 'wrong-token'], { adb });
    assert.equal(wrongRelease.exitCode, 20);
    const released = await invoke(['release', common(root), '--proof-id', 'proof-android', '--token', String(acquired.json.token)], {
      adb, devices: 'emulator-5580 device model:sdk\n', appPid: '4242\n',
    });
    assert.equal(released.exitCode, 0, released.stderr);
    assert.equal(released.json.status, 'released');

    const artifact = JSON.parse(await readFile(join(root, 'proofs', 'lease.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(artifact.status, 'released');
    assert.equal(artifact.serial, 'emulator-5580');
    assert.equal(artifact.appPid, 4242);
  });
});

test('Android lease helper rejects physical, offline, ambiguous, and user-owned live app targets', async () => {
  const cases = [
    { name: 'physical', devices: 'R5CT device model:phone\n', appPid: '' },
    { name: 'offline', devices: 'emulator-5580 offline model:sdk\n', appPid: '' },
    { name: 'ambiguous', devices: 'emulator-5580 device model:sdk\nemulator-5582 device model:sdk\n', appPid: '' },
    { name: 'live app', devices: 'emulator-5580 device model:sdk\n', appPid: '3333\n' },
  ];
  for (const entry of cases) {
    await withFixture(async ({ root, adb }) => {
      const result = await invoke(['acquire', common(root), '--proof-id', `proof-${entry.name}`, '--app-id', 'dev.codex.proof', '--owner-pid', String(process.pid)], {
        adb, devices: entry.devices, appPid: entry.appPid,
      });
      assert.equal(result.exitCode, 20, entry.name);
      assert.equal(result.json.status, 'blocked', entry.name);
    });
  }
});

test('Android lease helper preserves active foreign ownership and reclaims only expired dead ownership', async () => {
  await withFixture(async ({ root, adb }) => {
    const active = await invoke(['acquire', common(root), '--proof-id', 'proof-active', '--app-id', 'dev.codex.proof', '--owner-pid', String(process.pid)], {
      adb, devices: 'emulator-5580 device model:sdk\n', now: '2026-07-16T12:00:00.000Z',
    });
    assert.equal(active.exitCode, 0);
    const foreign = await invoke(['acquire', common(root), '--proof-id', 'proof-foreign', '--app-id', 'dev.codex.proof', '--owner-pid', String(process.pid)], {
      adb, devices: 'emulator-5580 device model:sdk\n', now: '2026-07-16T12:01:00.000Z',
    });
    assert.equal(foreign.exitCode, 20);

    const leasePath = join(root, 'leases', 'android.json');
    const stale = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    stale.ownerPid = 999_999;
    stale.expiresAt = '2026-07-16T11:00:00.000Z';
    await writeFile(leasePath, `${JSON.stringify(stale)}\n`);
    const recovered = await invoke(['acquire', common(root), '--proof-id', 'proof-recovered', '--app-id', 'dev.codex.proof', '--owner-pid', String(process.pid)], {
      adb, devices: 'emulator-5580 device model:sdk\n', now: '2026-07-16T12:02:00.000Z',
    });
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    assert.equal(recovered.json.status, 'acquired');
    assert.equal(recovered.json.proofId, 'proof-recovered');
  });
});

test('runner lease verifier matches exact ownership and publishes a released local record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-runner-lease-'));
  try {
    const leaseRoot = join(root, 'leases');
    const worktreeRoot = join(root, 'worktree');
    const artifactRelativePath = 'proofs/proof-android/lease.json';
    const artifactPath = join(worktreeRoot, artifactRelativePath);
    await mkdir(leaseRoot, { recursive: true });
    await mkdir(join(worktreeRoot, 'proofs', 'proof-android'), { recursive: true });
    const record = {
      schema: 'codex-orchestrator.android-lease', version: 1, status: 'active', proofId: 'proof-android', token: 'token-1',
      serial: 'emulator-5580', appId: 'dev.codex.proof', ownerPid: process.pid, appPid: 4242,
      acquiredAt: '2026-07-16T12:00:00.000Z', expiresAt: '2026-07-16T12:30:00.000Z', updatedAt: '2026-07-16T12:01:00.000Z',
    } as const;
    const bytes = Buffer.from(`${canonicalJson(record)}\n`);
    await writeFile(join(leaseRoot, 'android.json'), bytes);
    await writeFile(artifactPath, bytes);
    const verifier = new FileAndroidLeaseVerifier({ leaseRoot, worktreeRoot, now: () => new Date('2026-07-16T12:02:00.000Z') });
    await verifier.verify({ proofId: 'proof-android', artifactRelativePath, artifactBytes: bytes });
    await verifier.release('proof-android');
    await assert.rejects(readFile(join(leaseRoot, 'android.json')), { code: 'ENOENT' });
    const released = JSON.parse(await readFile(artifactPath, 'utf8')) as Record<string, unknown>;
    assert.equal(released.status, 'released');
    assert.equal(released.token, 'token-1');
    assert.equal(released.updatedAt, '2026-07-16T12:02:00.000Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner terminal cleanup requires the deterministic matching lease artifact before verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-runner-cleanup-'));
  try {
    const leaseRoot = join(root, 'leases');
    const worktreeRoot = join(root, 'worktree');
    const artifactRelativePath = 'proofs/proof-cleanup/android-lease.json';
    await mkdir(leaseRoot, { recursive: true });
    await mkdir(join(worktreeRoot, 'proofs', 'proof-cleanup'), { recursive: true });
    const record = {
      schema: 'codex-orchestrator.android-lease', version: 1, status: 'active', proofId: 'proof-cleanup', token: 'token-cleanup',
      serial: 'emulator-5580', appId: 'dev.codex.proof', ownerPid: process.pid, appPid: null,
      acquiredAt: '2026-07-16T12:00:00.000Z', expiresAt: '2026-07-16T12:30:00.000Z', updatedAt: '2026-07-16T12:01:00.000Z',
    } as const;
    const bytes = Buffer.from(`${canonicalJson(record)}\n`);
    await writeFile(join(leaseRoot, 'android.json'), bytes);
    await writeFile(join(worktreeRoot, artifactRelativePath), bytes);
    const verifier = new FileAndroidLeaseVerifier({
      leaseRoot,
      worktreeRoot,
      now: () => new Date('2026-07-16T12:02:00.000Z'),
      artifactRelativePathForProof: () => artifactRelativePath,
    });
    await verifier.release('proof-cleanup');
    assert.equal(JSON.parse(await readFile(join(worktreeRoot, artifactRelativePath), 'utf8')).status, 'released');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner release replay completes after the local record was released before external removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-runner-release-replay-'));
  try {
    const leaseRoot = join(root, 'leases');
    const worktreeRoot = join(root, 'worktree');
    const artifactRelativePath = 'proofs/proof-replay/android-lease.json';
    await mkdir(leaseRoot, { recursive: true });
    await mkdir(join(worktreeRoot, 'proofs', 'proof-replay'), { recursive: true });
    const active = {
      schema: 'codex-orchestrator.android-lease', version: 1, status: 'active', proofId: 'proof-replay', token: 'token-replay',
      serial: 'emulator-5580', appId: 'dev.codex.proof', ownerPid: process.pid, appPid: 4242,
      acquiredAt: '2026-07-16T12:00:00.000Z', expiresAt: '2026-07-16T12:30:00.000Z', updatedAt: '2026-07-16T12:01:00.000Z',
    } as const;
    await writeFile(join(leaseRoot, 'android.json'), `${canonicalJson(active)}\n`);
    await writeFile(join(worktreeRoot, artifactRelativePath), `${canonicalJson({ ...active, status: 'released' })}\n`);
    const verifier = new FileAndroidLeaseVerifier({
      leaseRoot,
      worktreeRoot,
      now: () => new Date('2026-07-16T12:02:00.000Z'),
      artifactRelativePathForProof: () => artifactRelativePath,
    });
    await verifier.release('proof-replay');
    await assert.rejects(readFile(join(leaseRoot, 'android.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(worktreeRoot, artifactRelativePath), 'utf8')).status, 'released');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner lease verifier rejects wrong serial, app, PID, token, and expiry', async () => {
  for (const field of ['serial', 'appId', 'appPid', 'token', 'expired'] as const) {
    const root = await mkdtemp(join(tmpdir(), `codex-v2-runner-mismatch-${field}-`));
    try {
      const leaseRoot = join(root, 'leases');
      const worktreeRoot = join(root, 'worktree');
      await mkdir(leaseRoot, { recursive: true });
      await mkdir(join(worktreeRoot, 'proofs'), { recursive: true });
      const external: Record<string, unknown> = {
        schema: 'codex-orchestrator.android-lease', version: 1, status: 'active', proofId: 'proof-mismatch', token: 'token-1',
        serial: 'emulator-5580', appId: 'dev.codex.proof', ownerPid: process.pid, appPid: 4242,
        acquiredAt: '2026-07-16T12:00:00.000Z', expiresAt: '2026-07-16T12:30:00.000Z', updatedAt: '2026-07-16T12:01:00.000Z',
      };
      const artifact = structuredClone(external);
      if (field === 'serial') artifact.serial = 'emulator-5582';
      if (field === 'appId') artifact.appId = 'dev.codex.other';
      if (field === 'appPid') artifact.appPid = 5252;
      if (field === 'token') artifact.token = 'token-2';
      if (field === 'expired') {
        external.expiresAt = '2026-07-16T11:30:00.000Z';
        artifact.expiresAt = '2026-07-16T11:30:00.000Z';
      }
      await writeFile(join(leaseRoot, 'android.json'), `${canonicalJson(external)}\n`);
      const verifier = new FileAndroidLeaseVerifier({ leaseRoot, worktreeRoot, now: () => new Date('2026-07-16T12:02:00.000Z') });
      await assert.rejects(verifier.verify({
        proofId: 'proof-mismatch', artifactRelativePath: 'proofs/lease.json', artifactBytes: Buffer.from(`${canonicalJson(artifact)}\n`),
      }), { message: /.*/u }, field);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

function common(root: string): string {
  return `--lease-root=${join(root, 'leases')} --artifact=${join(root, 'proofs', 'lease.json')}`;
}

async function withFixture(run: (fixture: { root: string; adb: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-android-lease-'));
  try {
    const adb = join(root, 'fake-adb.sh');
    await mkdir(join(root, 'proofs'), { recursive: true });
    await writeFile(adb, `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf "List of devices attached\\n%s" "$FAKE_ADB_DEVICES"
  exit 0
fi
if [ "$3" = "shell" ] && [ "$4" = "getprop" ]; then
  printf "1\\n"
  exit 0
fi
if [ "$3" = "shell" ] && [ "$4" = "pidof" ]; then
  printf "%s" "$FAKE_ADB_APP_PID"
  exit 0
fi
exit 1
`);
    await chmod(adb, 0o700);
    await run({ root, adb });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function invoke(
  args: string[],
  options: { adb: string; devices?: string; appPid?: string; now?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string; json: Record<string, unknown> }> {
  const expanded = args.flatMap((arg) => arg.includes(' ') ? arg.split(' ') : [arg]);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [leaseTool, ...expanded], {
      env: {
        PATH: process.env.PATH,
        ANDROID_ADB: options.adb,
        FAKE_ADB_DEVICES: options.devices ?? '',
        FAKE_ADB_APP_PID: options.appPid ?? '',
        CODEX_ORCHESTRATOR_NOW: options.now ?? '2026-07-16T12:00:00.000Z',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('close', (code) => {
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(stdout) as Record<string, unknown>; } catch { /* RED may not produce JSON */ }
      resolveRun({ exitCode: code ?? 70, stdout, stderr, json });
    });
  });
}
