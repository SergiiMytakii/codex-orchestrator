import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { canonicalJson } from '../src/v2/containment.js';
import { FileIosLeaseVerifier } from '../src/v2/mobile-lease.js';

const leaseTool = resolve('internal-skills/acceptance-proof/tools/ios-lease.mjs');

test('iOS lease helper creates a new Simulator after ownership intent, binds exact app PID, verifies, and releases it', async () => {
  await withFixture(async ({ root, xcrun }) => {
    const acquired = await invoke(['acquire', ...common(root), '--proof-id', 'proof-ios', '--bundle-id', 'dev.codex.proof', '--owner-pid', String(process.pid),
      '--runtime', 'com.apple.CoreSimulator.SimRuntime.iOS-26-3', '--device-type', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'], {
      xcrun, booted: '{}', allState: 'Booted', appPid: '4242',
    });
    assert.equal(acquired.exitCode, 0, `${acquired.stderr}\n${acquired.stdout}`);
    assert.equal(acquired.json.status, 'acquired');
    assert.equal(acquired.json.udid, '11111111-2222-4333-8444-555555555555');

    const token = String(acquired.json.token);
    const bound = await invoke(['bind', ...common(root), '--proof-id', 'proof-ios', '--token', token, '--app-pid', '4242'], {
      xcrun, allState: 'Booted', appPid: '4242',
    });
    assert.equal(bound.exitCode, 0, bound.stderr);
    assert.equal(bound.json.appPid, 4242);
    const verified = await invoke(['verify', ...common(root), '--proof-id', 'proof-ios', '--token', token], {
      xcrun, allState: 'Booted', appPid: '4242',
    });
    assert.equal(verified.exitCode, 0, verified.stderr);
    const released = await invoke(['release', ...common(root), '--proof-id', 'proof-ios', '--token', token], {
      xcrun, allState: 'Booted', appPid: '4242',
    });
    assert.equal(released.exitCode, 0, released.stderr);
    assert.equal(released.json.status, 'released');
  });
});

test('iOS lease helper refuses acquisition when any Simulator is already booted', async () => {
  await withFixture(async ({ root, xcrun }) => {
    const result = await invoke(['acquire', ...common(root), '--proof-id', 'proof-blocked', '--bundle-id', 'dev.codex.proof', '--owner-pid', String(process.pid),
      '--runtime', 'com.apple.CoreSimulator.SimRuntime.iOS-26-3', '--device-type', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'], {
      xcrun,
      booted: JSON.stringify({ devices: { runtime: [{ udid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', name: 'User phone', state: 'Booted', isAvailable: true }] } }),
    });
    assert.equal(result.exitCode, 20);
    assert.equal(result.json.status, 'blocked');
  });
});

test('iOS lease helper refuses a live foreign lease without creating or deleting a Simulator', async () => {
  await withFixture(async ({ root, xcrun }) => {
    await mkdir(join(root, 'leases'), { recursive: true });
    await writeFile(join(root, 'leases', 'ios.json'), `${canonicalJson(leaseRecord({ proofId: 'foreign-proof' }))}\n`);
    const result = await invoke(['acquire', ...common(root), '--proof-id', 'new-proof', '--bundle-id', 'dev.codex.proof', '--owner-pid', String(process.pid),
      '--runtime', 'com.apple.CoreSimulator.SimRuntime.iOS-26-3', '--device-type', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'], { xcrun });
    assert.equal(result.exitCode, 20);
    assert.match(String(result.json.reason), /foreign iOS lease/u);
    const commands = await readFile(`${xcrun}.commands`, 'utf8');
    assert.doesNotMatch(commands, /simctl (create|delete|shutdown)/u);
  });
});

test('iOS lease helper reclaims only an expired dead-owner target before creating a fresh target', async () => {
  await withFixture(async ({ root, xcrun }) => {
    await mkdir(join(root, 'leases'), { recursive: true });
    await writeFile(join(root, 'leases', 'ios.json'), `${canonicalJson(leaseRecord({
      proofId: 'proof-ios', ownerPid: 999_999, expiresAt: '2026-07-16T23:59:00.000Z', appPid: null,
    }))}\n`);
    const result = await invoke(['acquire', ...common(root), '--proof-id', 'fresh-proof', '--bundle-id', 'dev.codex.proof', '--owner-pid', String(process.pid),
      '--runtime', 'com.apple.CoreSimulator.SimRuntime.iOS-26-3', '--device-type', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'], {
      xcrun, allState: 'Shutdown', deviceName: 'Codex proof-ios',
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const commands = await readFile(`${xcrun}.commands`, 'utf8');
    assert.match(commands, /simctl delete 11111111-2222-4333-8444-555555555555/u);
    assert.match(commands, /simctl create Codex fresh-proof com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-17-Pro com\.apple\.CoreSimulator\.SimRuntime\.iOS-26-3/u);
  });
});

test('iOS lease helper rejects app PID drift after exact bundle observation', async () => {
  await withFixture(async ({ root, xcrun }) => {
    const acquired = await invoke(['acquire', ...common(root), '--proof-id', 'proof-ios', '--bundle-id', 'dev.codex.proof', '--owner-pid', String(process.pid),
      '--runtime', 'com.apple.CoreSimulator.SimRuntime.iOS-26-3', '--device-type', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'], {
      xcrun, allState: 'Booted', appPid: '4242',
    });
    const result = await invoke(['bind', ...common(root), '--proof-id', 'proof-ios', '--token', String(acquired.json.token), '--app-pid', '4343'], {
      xcrun, allState: 'Booted', appPid: '4242',
    });
    assert.equal(result.exitCode, 20);
    assert.match(String(result.json.reason), /PID changed/u);
  });
});

test('runner iOS verifier matches exact ownership, invokes exact target release, and settles the local record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-ios-verifier-'));
  try {
    const leaseRoot = join(root, 'leases');
    const worktreeRoot = join(root, 'worktree');
    const relativePath = 'proofs/proof-ios/lease.json';
    await mkdir(leaseRoot, { recursive: true });
    await mkdir(join(worktreeRoot, 'proofs', 'proof-ios'), { recursive: true });
    const record = {
      schema: 'codex-orchestrator.ios-lease', version: 1, status: 'active', proofId: 'proof-ios', token: 'token-1',
      udid: '11111111-2222-4333-8444-555555555555', deviceName: 'Codex proof-ios', bundleId: 'dev.codex.proof',
      ownerPid: process.pid, appPid: 4242, runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
      deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', runnerCreated: true,
      acquiredAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:20:00.000Z', updatedAt: '2026-07-17T00:01:00.000Z',
    } as const;
    const bytes = Buffer.from(`${canonicalJson(record)}\n`);
    await writeFile(join(leaseRoot, 'ios.json'), bytes);
    await writeFile(join(worktreeRoot, relativePath), bytes);
    const released: string[] = [];
    const verifier = new FileIosLeaseVerifier({
      leaseRoot, worktreeRoot, artifactRelativePathForProof: () => relativePath,
      targetController: { release: async (target) => { released.push(target.udid); } },
      now: () => new Date('2026-07-17T00:02:00.000Z'),
    });
    await verifier.verify({ proofId: 'proof-ios', artifactRelativePath: relativePath, artifactBytes: bytes });
    await verifier.release('proof-ios');
    assert.deepEqual(released, ['11111111-2222-4333-8444-555555555555']);
    await assert.rejects(readFile(join(leaseRoot, 'ios.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(worktreeRoot, relativePath), 'utf8')).status, 'released');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner iOS verifier rejects target identity drift and an expired or unbound lease', async () => {
  for (const mutation of [
    (record: ReturnType<typeof leaseRecord>) => ({ ...record, token: 'changed-token' }),
    (record: ReturnType<typeof leaseRecord>) => ({ ...record, bundleId: 'dev.codex.other' }),
    (record: ReturnType<typeof leaseRecord>) => ({ ...record, appPid: 4343 }),
    (record: ReturnType<typeof leaseRecord>) => ({ ...record, expiresAt: '2026-07-16T23:59:00.000Z' }),
    (record: ReturnType<typeof leaseRecord>) => ({ ...record, appPid: null }),
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'codex-v2-ios-drift-'));
    try {
      const leaseRoot = join(root, 'leases');
      const worktreeRoot = join(root, 'worktree');
      const relativePath = 'proofs/proof-ios/lease.json';
      await mkdir(leaseRoot, { recursive: true });
      await mkdir(join(worktreeRoot, 'proofs', 'proof-ios'), { recursive: true });
      const external = leaseRecord();
      const artifact = mutation(external);
      const bytes = Buffer.from(`${canonicalJson(artifact)}\n`);
      await writeFile(join(leaseRoot, 'ios.json'), `${canonicalJson(external)}\n`);
      await writeFile(join(worktreeRoot, relativePath), bytes);
      const verifier = new FileIosLeaseVerifier({
        leaseRoot, worktreeRoot, artifactRelativePathForProof: () => relativePath,
        targetController: { release: async () => undefined },
        now: () => new Date('2026-07-17T00:02:00.000Z'),
      });
      await assert.rejects(verifier.verify({ proofId: 'proof-ios', artifactRelativePath: relativePath, artifactBytes: bytes }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('runner iOS release replays after target deletion and a locally released artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-ios-release-replay-'));
  try {
    const leaseRoot = join(root, 'leases');
    const worktreeRoot = join(root, 'worktree');
    const relativePath = 'proofs/proof-ios/lease.json';
    await mkdir(leaseRoot, { recursive: true });
    await mkdir(join(worktreeRoot, 'proofs', 'proof-ios'), { recursive: true });
    const external = leaseRecord();
    await writeFile(join(leaseRoot, 'ios.json'), `${canonicalJson(external)}\n`);
    await writeFile(join(worktreeRoot, relativePath), `${canonicalJson({ ...external, status: 'released' })}\n`);
    let releases = 0;
    const verifier = new FileIosLeaseVerifier({
      leaseRoot, worktreeRoot, artifactRelativePathForProof: () => relativePath,
      targetController: { release: async () => { releases += 1; } },
      now: () => new Date('2026-07-17T00:03:00.000Z'),
    });
    await verifier.release('proof-ios');
    assert.equal(releases, 1);
    await assert.rejects(readFile(join(leaseRoot, 'ios.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(worktreeRoot, relativePath), 'utf8')).status, 'released');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function leaseRecord(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'codex-orchestrator.ios-lease', version: 1, status: 'active', proofId: 'proof-ios', token: 'token-1',
    udid: '11111111-2222-4333-8444-555555555555', deviceName: 'Codex proof-ios', bundleId: 'dev.codex.proof',
    ownerPid: process.pid, appPid: 4242, runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
    deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', runnerCreated: true,
    acquiredAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:20:00.000Z', updatedAt: '2026-07-17T00:01:00.000Z',
    ...overrides,
  };
}

function common(root: string): string[] {
  return ['--lease-root', join(root, 'leases'), '--artifact', join(root, 'proofs', 'lease.json'), '--xcrun', join(root, 'fake-xcrun.sh')];
}

async function withFixture(run: (fixture: { root: string; xcrun: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-ios-lease-'));
  try {
    const xcrun = join(root, 'fake-xcrun.sh');
    await mkdir(join(root, 'proofs'), { recursive: true });
    await writeFile(xcrun, `#!/bin/sh
printf '%s\\n' "$*" >> "$0.commands"
if [ "$1 $2 $3 $4" = "simctl list devices booted" ]; then printf '%s' "$FAKE_BOOTED"; exit 0; fi
if [ "$1 $2 $3" = "simctl list devices" ]; then
  if [ -e "$0.deleted" ]; then printf '{"devices":{}}'; else printf '{"devices":{"runtime":[{"udid":"11111111-2222-4333-8444-555555555555","name":"%s","state":"%s","isAvailable":true}]}}' "$FAKE_DEVICE_NAME" "$FAKE_ALL_STATE"; fi
  exit 0
fi
if [ "$1 $2" = "simctl create" ]; then rm -f "$0.deleted"; printf '11111111-2222-4333-8444-555555555555\\n'; exit 0; fi
if [ "$1 $2" = "simctl get_app_container" ]; then printf '/tmp/Runner.app\\n'; exit 0; fi
if [ "$1 $2" = "simctl spawn" ]; then printf '%s 0 UIKitApplication:dev.codex.proof[fixture]\\n' "$FAKE_APP_PID"; exit 0; fi
if [ "$1 $2" = "simctl shutdown" ]; then exit 0; fi
if [ "$1 $2" = "simctl delete" ]; then touch "$0.deleted"; exit 0; fi
exit 1
`);
    await chmod(xcrun, 0o700);
    await run({ root, xcrun });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function invoke(args: string[], options: { xcrun: string; booted?: string; allState?: string; appPid?: string; deviceName?: string }) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string; json: Record<string, unknown> }>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [leaseTool, ...args], {
      env: {
        PATH: process.env.PATH,
        FAKE_BOOTED: options.booted ?? '{}',
        FAKE_ALL_STATE: options.allState ?? 'Booted',
        FAKE_APP_PID: options.appPid ?? '4242',
        FAKE_DEVICE_NAME: options.deviceName ?? 'Codex proof-ios',
        CODEX_ORCHESTRATOR_NOW: '2026-07-17T00:00:00.000Z',
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
