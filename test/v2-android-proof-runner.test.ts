import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RunnerAndroidProofController } from '../src/v2/android-proof-runner.js';
import type { AndroidProofConfig } from '../src/v2/config.js';
import { parseAndroidLease } from '../src/v2/mobile-lease.js';

const config: AndroidProofConfig = {
  applicationId: 'ai.levantem.sirbro',
  avdName: 'Pixel_9_API_Baklava',
  flutterCommand: '/opt/flutter/bin/flutter',
  buildArgs: ['build', 'apk', '--debug', '--flavor', 'sirbro', '-t', 'lib/main_dev.dart'],
  apkPath: 'build/app/outputs/flutter-apk/app-sirbro-debug.apk',
  tapText: ['Live'],
  bootTimeoutMs: 120_000,
  navigationTimeoutMs: 60_000,
  settleMs: 1_000,
};

test('runner starts an isolated emulator and captures bound proof evidence without touching observed devices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-proof-runner-'));
  const calls: Array<{ file: string; args: string[] }> = [];
  let emulatorStarted = false;
  let hierarchyReads = 0;
  let emulatorIdentityReads = 0;
  try {
    const adbPath = join(root, 'adb');
    const emulatorPath = join(root, 'emulator');
    await writeFile(adbPath, '#!/bin/sh\n');
    await writeFile(emulatorPath, '#!/bin/sh\n');
    await chmod(adbPath, 0o700);
    await chmod(emulatorPath, 0o700);
    const worktreePath = join(root, 'worktree');
    const apkPath = join(worktreePath, config.apkPath);
    const leaseRoot = join(root, 'leases');
    const controller = new RunnerAndroidProofController({
      adbPath,
      emulatorPath,
      execute: async (file, args) => {
        calls.push({ file, args });
        if (file === emulatorPath && args[0] === '-list-avds') return ok('Pixel_8_API_35\nPixel_9_API_Baklava\n');
        if (file === adbPath && args[0] === 'devices') {
          return ok(`List of devices attached\nPHYSICAL device model:phone\n${emulatorStarted ? 'emulator-5554 device model:sdk\n' : ''}`);
        }
        if (file === adbPath && args.includes('getprop')) return ok('1\n');
        if (file === config.flutterCommand) {
          await mkdir(join(worktreePath, 'build/app/outputs/flutter-apk'), { recursive: true });
          await writeFile(apkPath, 'fresh apk');
          return ok('Built app-sirbro-debug.apk\n');
        }
        if (file === adbPath && args.includes('install')) {
          const installedPath = args.at(-1)!;
          assert.notEqual(installedPath, apkPath);
          assert.equal(await readFile(installedPath, 'utf8'), 'fresh apk');
          return ok('Success\n');
        }
        if (file === adbPath && args.includes('pidof')) return ok('4242\n');
        if (file === adbPath && args.includes('uiautomator')) return ok('UI hierarchy dumped\n');
        if (file === adbPath && args.includes('rm')) return ok('');
        if (file === adbPath && args.includes('monkey')) return ok('Events injected: 1\n');
        if (file === adbPath && args.includes('input')) return ok('');
        if (file === adbPath && args.includes('emu')) return ok('OK\n');
        throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
      },
      executeBinary: async (_file, args) => {
        if (args.includes('screencap')) return Buffer.from('89504e470d0a1a0a', 'hex');
        if (args.includes('uiautomator')) {
          hierarchyReads += 1;
          if (hierarchyReads === 1 || hierarchyReads === 3) {
            return Buffer.from('UI hierarchy dump is temporarily incomplete\n');
          }
          return Buffer.from('<hierarchy><node text="" content-desc="Live" bounds="[10,20][110,80]" /></hierarchy>\n');
        }
        if (args.includes('logcat')) return Buffer.from('I/flutter: Live screen rendered\n');
        throw new Error(`unexpected binary command: ${args.join(' ')}`);
      },
      startEmulator: async (_file, args) => {
        const preparation = JSON.parse(await readFile(join(leaseRoot, 'android.preparation.json'), 'utf8')) as Record<string, unknown>;
        assert.equal(preparation.proofId, 'proof-177');
        assert.equal(preparation.emulatorPid, null);
        assert.deepEqual(args.slice(0, 2), ['-avd', 'Pixel_9_API_Baklava']);
        assert.deepEqual(args.slice(args.indexOf('-datadir'), args.indexOf('-datadir') + 2), ['-datadir', '/tmp/codex-proof-data']);
        assert.ok(args.includes('-wipe-data'));
        assert.ok(args.includes('-no-snapshot-save'));
        emulatorStarted = true;
        return { pid: 31337 };
      },
      createDataDir: async () => '/tmp/codex-proof-data',
      removeDataDir: async () => {},
      wait: async () => {},
      now: () => new Date('2026-07-28T09:00:00.000Z'),
      createToken: () => 'runner-token',
      readProcessIdentity: async (pid) => {
        if (pid === 31337) emulatorIdentityReads += 1;
        return pid === 31337 ? 'darwin:process-start' : undefined;
      },
    });

    await mkdir(join(worktreePath, 'build/app/outputs/flutter-apk'), { recursive: true });
    await writeFile(apkPath, 'stale apk');
    const result = await controller.prepare({
      proofId: 'proof-177',
      worktreePath,
      artifactDir: '.codex-orchestrator/v2/proofs',
      leaseRoot,
      config,
      checks: [{ id: 'flutter-test', command: 'flutter test --no-pub', status: 'passed', outputSha256: 'a'.repeat(64) }],
      checkedChangeSha256: 'b'.repeat(64),
      proofAgentBudgetMs: 900_000,
      signal: new AbortController().signal,
    });

    assert.equal(result.status, 'prepared');
    assert.equal(result.serial, 'emulator-5554');
    assert.equal(result.appPid, 4242);
    assert.deepEqual(result.runnerPreparedArtifactPaths.sort(), [
      '.codex-orchestrator/v2/proofs/proof-177/android-device-log.txt',
      '.codex-orchestrator/v2/proofs/proof-177/android-final.png',
      '.codex-orchestrator/v2/proofs/proof-177/android-lease.json',
      '.codex-orchestrator/v2/proofs/proof-177/android-runner-receipt.json',
      '.codex-orchestrator/v2/proofs/proof-177/android-ui.xml',
    ]);
    const lease = parseAndroidLease(await readFile(join(leaseRoot, 'android.json')));
    assert.equal(lease.runnerCreated, true);
    assert.equal(lease.emulatorPid, 31337);
    assert.equal(lease.emulatorProcessIdentity, 'darwin:process-start');
    assert.equal(lease.dataDir, '/tmp/codex-proof-data');
    assert.equal(lease.serial, 'emulator-5554');
    assert.equal(lease.appPid, 4242);
    await stat(join(worktreePath, '.codex-orchestrator/v2/proofs/proof-177/android-final.png'));
    const receipt = JSON.parse(await readFile(
      join(worktreePath, '.codex-orchestrator/v2/proofs/proof-177/android-runner-receipt.json'),
      'utf8',
    )) as Record<string, unknown>;
    assert.equal(receipt.proofId, 'proof-177');
    assert.equal(receipt.apkSha256, 'be5e3b63462b8491c1466bdebf4cc0202d11dc1b2ef14e15d0af7d2b01658237');
    assert.equal(receipt.checkedChangeSha256, 'b'.repeat(64));
    assert.deepEqual(receipt.configuredCheckIds, ['flutter-test']);
    assert.deepEqual(receipt.navigation, { launchUriConfigured: false, tapText: ['Live'] });
    assert.equal(calls.some((call) => call.args.join(' ').includes('shell input tap 60 50')), true);
    assert.equal(calls.some((call) => call.args.includes('PHYSICAL')), false);
    assert.ok(emulatorIdentityReads >= 5, `expected repeated emulator ownership checks, got ${emulatorIdentityReads}`);
    await assert.rejects(readFile(join(leaseRoot, 'android.preparation.json')), { code: 'ENOENT' });
    const resumed = await controller.prepare({
      proofId: 'proof-177', worktreePath, artifactDir: '.codex-orchestrator/v2/proofs', leaseRoot, config,
      checks: [{ id: 'flutter-test', command: 'flutter test --no-pub', status: 'passed', outputSha256: 'a'.repeat(64) }],
      checkedChangeSha256: 'b'.repeat(64), proofAgentBudgetMs: 900_000, signal: new AbortController().signal,
    });
    assert.equal(resumed.status, 'prepared');
    if (resumed.status === 'prepared') assert.equal(resumed.appPid, 4242);
    await writeFile(join(worktreePath, '.codex-orchestrator/v2/proofs/proof-177/android-ui.xml'), '<hierarchy tampered="true" />\n');
    const tamperedResume = await controller.prepare({
      proofId: 'proof-177', worktreePath, artifactDir: '.codex-orchestrator/v2/proofs', leaseRoot, config,
      checks: [{ id: 'flutter-test', command: 'flutter test --no-pub', status: 'passed', outputSha256: 'a'.repeat(64) }],
      checkedChangeSha256: 'b'.repeat(64), proofAgentBudgetMs: 900_000, signal: new AbortController().signal,
    });
    assert.equal(tamperedResume.status, 'blocked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner owns lease creation and terminal release stops only its emulator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-proof-release-'));
  const calls: string[][] = [];
  const removed: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  try {
    const controller = new RunnerAndroidProofController({
      adbPath: '/sdk/platform-tools/adb',
      emulatorPath: '/sdk/emulator/emulator',
      execute: async (_file, args) => {
        calls.push(args);
        return ok('OK\n');
      },
      executeBinary: async () => Buffer.alloc(0),
      startEmulator: async () => ({ pid: 1 }),
      wait: async () => {},
      removeDataDir: async (path) => { removed.push(path); },
      readProcessIdentity: async (pid) => {
        assert.equal(pid, 99);
        return signals.length === 0 ? 'darwin:original-start' : undefined;
      },
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    });
    await controller.release({
      schema: 'codex-orchestrator.android-lease', version: 1, status: 'active', proofId: 'proof-release',
      token: 'token', serial: 'emulator-5580', appId: 'ai.levantem.sirbro', ownerPid: 7, appPid: 42,
      runnerCreated: true, emulatorPid: 99, emulatorProcessIdentity: 'darwin:original-start',
      dataDir: '/tmp/codex-orchestrator-android-proof-release',
      acquiredAt: '2026-07-28T09:00:00.000Z', expiresAt: '2026-07-28T09:15:00.000Z', updatedAt: '2026-07-28T09:01:00.000Z',
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(signals, [{ pid: 99, signal: 'SIGTERM' }]);
    assert.deepEqual(removed, ['/tmp/codex-orchestrator-android-proof-release']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner release is idempotent and never kills a foreign emulator after serial reuse', async () => {
  const calls: string[][] = [];
  const removed: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const controller = new RunnerAndroidProofController({
    adbPath: '/sdk/platform-tools/adb', emulatorPath: '/sdk/emulator/emulator',
    execute: async (_file, args) => { calls.push(args); return ok('OK\n'); },
    executeBinary: async () => Buffer.alloc(0), startEmulator: async () => ({ pid: 1 }), wait: async () => {},
    removeDataDir: async (path) => { removed.push(path); },
    readProcessIdentity: async () => 'darwin:foreign-start',
    signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
  });
  const record = {
    schema: 'codex-orchestrator.android-lease' as const, version: 1 as const, status: 'active' as const,
    proofId: 'proof-release', token: 'token', serial: 'emulator-5580', appId: 'ai.levantem.sirbro',
    ownerPid: 7, appPid: 42, runnerCreated: true as const, emulatorPid: 99,
    emulatorProcessIdentity: 'darwin:original-start', dataDir: '/tmp/codex-orchestrator-android-proof-release',
    acquiredAt: '2026-07-28T09:00:00.000Z', expiresAt: '2026-07-28T09:15:00.000Z', updatedAt: '2026-07-28T09:01:00.000Z',
  };
  await controller.release(record);
  await controller.release(record);
  assert.deepEqual(calls, []);
  assert.deepEqual(signals, []);
  assert.deepEqual(removed, [record.dataDir, record.dataDir]);
});

test('runner retains lease ownership when process identity inspection fails', async () => {
  const signals: string[] = [];
  const removed: string[] = [];
  const controller = new RunnerAndroidProofController({
    adbPath: '/sdk/platform-tools/adb', emulatorPath: '/sdk/emulator/emulator',
    inspectProcessIdentity: async () => ({ status: 'error' }),
    signalProcess: (_pid, signal) => { signals.push(signal); },
    removeDataDir: async (path) => { removed.push(path); },
  });
  await assert.rejects(controller.release({
    schema: 'codex-orchestrator.android-lease', version: 1, status: 'active', proofId: 'proof-release',
    token: 'token', serial: 'emulator-5580', appId: 'ai.levantem.sirbro', ownerPid: 7, appPid: 42,
    runnerCreated: true, emulatorPid: 99, emulatorProcessIdentity: 'darwin:original-start',
    dataDir: '/tmp/codex-orchestrator-android-proof-release', acquiredAt: '2026-07-28T09:00:00.000Z',
    expiresAt: '2026-07-28T09:15:00.000Z', updatedAt: '2026-07-28T09:01:00.000Z',
  }), /could not be inspected/iu);
  assert.deepEqual(signals, []);
  assert.deepEqual(removed, []);
});

test('runner refuses a stale APK when the configured build produces no fresh output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-proof-stale-apk-'));
  let emulatorStarted = false;
  try {
    const worktreePath = join(root, 'worktree');
    const leaseRoot = join(root, 'leases');
    const adbPath = join(root, 'adb');
    const emulatorPath = join(root, 'emulator');
    await mkdir(join(worktreePath, 'build/app/outputs/flutter-apk'), { recursive: true });
    await writeFile(join(worktreePath, config.apkPath), 'stale apk');
    await writeFile(adbPath, '#!/bin/sh\n'); await chmod(adbPath, 0o700);
    await writeFile(emulatorPath, '#!/bin/sh\n'); await chmod(emulatorPath, 0o700);
    const controller = new RunnerAndroidProofController({
      adbPath, emulatorPath,
      execute: async (file, args) => {
        if (file === emulatorPath) return ok(`${config.avdName}\n`);
        if (file === config.flutterCommand) return ok('build returned zero without output\n');
        if (args[0] === 'devices') return ok(`List of devices attached\n${emulatorStarted ? 'emulator-5554 device\n' : ''}`);
        if (args.includes('getprop')) return ok('1\n');
        if (args.includes('emu')) { emulatorStarted = false; return ok('OK\n'); }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
      startEmulator: async () => { emulatorStarted = true; return { pid: 31337 }; },
      createDataDir: async () => join(root, 'ephemeral-data'), removeDataDir: async () => {}, wait: async () => {},
      readProcessIdentity: async (pid) => pid === 31337 && emulatorStarted ? 'darwin:start' : undefined,
      signalProcess: () => { emulatorStarted = false; },
    });
    const result = await controller.prepare({
      proofId: 'proof-stale', worktreePath, artifactDir: 'proofs', leaseRoot,
      config: { ...config, buildArgs: ['build', 'apk', '--debug'] }, checks: [], checkedChangeSha256: 'c'.repeat(64),
      proofAgentBudgetMs: 900_000,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') assert.match(result.summary, /was not produced/iu);
    await assert.rejects(stat(join(worktreePath, config.apkPath)), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner never removes an APK through a symlinked worktree parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-proof-symlink-apk-'));
  let emulatorStarted = false;
  try {
    const worktreePath = join(root, 'worktree');
    const foreign = join(root, 'foreign');
    const adbPath = join(root, 'adb');
    const emulatorPath = join(root, 'emulator');
    await mkdir(join(worktreePath), { recursive: true });
    await mkdir(join(foreign, 'app/outputs/flutter-apk'), { recursive: true });
    await writeFile(join(foreign, 'app/outputs/flutter-apk/app-sirbro-debug.apk'), 'foreign apk');
    await symlink(foreign, join(worktreePath, 'build'));
    await writeFile(adbPath, '#!/bin/sh\n'); await chmod(adbPath, 0o700);
    await writeFile(emulatorPath, '#!/bin/sh\n'); await chmod(emulatorPath, 0o700);
    const controller = new RunnerAndroidProofController({
      adbPath, emulatorPath,
      execute: async (file, args) => {
        if (file === emulatorPath) return ok(`${config.avdName}\n`);
        if (file === config.flutterCommand) throw new Error('build must not run');
        if (args[0] === 'devices') return ok(`List of devices attached\n${emulatorStarted ? 'emulator-5554 device\n' : ''}`);
        if (args.includes('getprop')) return ok('1\n');
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
      startEmulator: async () => { emulatorStarted = true; return { pid: 31337 }; },
      createDataDir: async () => join(root, 'ephemeral-data'), removeDataDir: async () => {}, wait: async () => {},
      readProcessIdentity: async () => emulatorStarted ? 'darwin:start' : undefined,
      signalProcess: () => { emulatorStarted = false; },
    });
    const result = await controller.prepare({
      proofId: 'proof-symlink', worktreePath, artifactDir: 'proofs', leaseRoot: join(root, 'leases'),
      config, checks: [], checkedChangeSha256: '9'.repeat(64), proofAgentBudgetMs: 900_000,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') assert.match(result.summary, /parent path is unsafe/iu);
    assert.equal(await readFile(join(foreign, 'app/outputs/flutter-apk/app-sirbro-debug.apk'), 'utf8'), 'foreign apk');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner blocks a symlinked proof root without mutating the external target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-proof-symlink-root-'));
  try {
    const worktreePath = join(root, 'worktree');
    const foreign = join(root, 'foreign');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(foreign, { recursive: true });
    await symlink(foreign, join(worktreePath, 'proofs'));
    const controller = new RunnerAndroidProofController({
      adbPath: '/must-not-run/adb', emulatorPath: '/must-not-run/emulator',
      execute: async () => { throw new Error('must not execute'); },
      startEmulator: async () => { throw new Error('must not start'); },
    });
    const result = await controller.prepare({
      proofId: 'proof-symlink-root', worktreePath, artifactDir: 'proofs', leaseRoot: join(root, 'leases'),
      config, checks: [], checkedChangeSha256: '6'.repeat(64), proofAgentBudgetMs: 900_000,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') assert.match(result.summary, /artifact directory is unsafe/iu);
    assert.deepEqual(result.runnerPreparedArtifactPaths, []);
    await assert.rejects(stat(join(foreign, 'proof-symlink-root')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner terminates oversized adb binary capture before buffering unbounded output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-proof-capture-cap-'));
  let emulatorStarted = false;
  try {
    const worktreePath = join(root, 'worktree');
    const adbPath = join(root, 'adb');
    const emulatorPath = join(root, 'emulator');
    await mkdir(worktreePath, { recursive: true });
    await writeFile(adbPath, '#!/bin/sh\nhead -c 6000000 /dev/zero\n'); await chmod(adbPath, 0o700);
    await writeFile(emulatorPath, '#!/bin/sh\n'); await chmod(emulatorPath, 0o700);
    const controller = new RunnerAndroidProofController({
      adbPath, emulatorPath,
      execute: async (file, args) => {
        if (file === emulatorPath) return ok(`${config.avdName}\n`);
        if (file === config.flutterCommand) {
          await mkdir(join(worktreePath, 'build/app/outputs/flutter-apk'), { recursive: true });
          await writeFile(join(worktreePath, config.apkPath), 'fresh apk');
          return ok('Built APK\n');
        }
        if (args[0] === 'devices') return ok(`List of devices attached\n${emulatorStarted ? 'emulator-5554 device\n' : ''}`);
        if (args.includes('getprop')) return ok('1\n');
        if (args.includes('install')) return ok('Success\n');
        if (args.includes('monkey')) return ok('Events injected: 1\n');
        if (args.includes('pidof')) return ok('4242\n');
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
      startEmulator: async () => { emulatorStarted = true; return { pid: 31337 }; },
      createDataDir: async () => join(root, 'ephemeral-data'), removeDataDir: async () => {}, wait: async () => {},
      readProcessIdentity: async () => emulatorStarted ? 'darwin:start' : undefined,
      signalProcess: () => { emulatorStarted = false; },
    });
    const result = await controller.prepare({
      proofId: 'proof-capture-cap', worktreePath, artifactDir: 'proofs', leaseRoot: join(root, 'leases'),
      config: { ...config, tapText: undefined }, checks: [], checkedChangeSha256: '5'.repeat(64),
      proofAgentBudgetMs: 900_000, signal: new AbortController().signal,
    });
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') assert.match(result.summary, /stdout exceeded its byte limit/iu);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner returns a useful redacted build blocker and cleans its lease and emulator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-proof-build-blocker-'));
  const calls: string[][] = [];
  let emulatorStarted = false;
  try {
    const adbPath = join(root, 'adb');
    const emulatorPath = join(root, 'emulator');
    await writeFile(adbPath, '#!/bin/sh\n');
    await writeFile(emulatorPath, '#!/bin/sh\n');
    await chmod(adbPath, 0o700);
    await chmod(emulatorPath, 0o700);
    const controller = new RunnerAndroidProofController({
      adbPath,
      emulatorPath,
      execute: async (file, args) => {
        calls.push(args);
        if (file === emulatorPath) return ok(`${config.avdName}\n`);
        if (file === config.flutterCommand) {
          return { stdout: '', stderr: 'Android resource linking failed TOKEN=do-not-leak-value', exitCode: 1 };
        }
        if (args[0] === 'devices') return ok(`List of devices attached\n${emulatorStarted ? 'emulator-5554 device\n' : ''}`);
        if (args.includes('getprop')) return ok('1\n');
        if (args.includes('emu')) { emulatorStarted = false; return ok('OK\n'); }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
      startEmulator: async () => { emulatorStarted = true; return { pid: 31337 }; },
      createDataDir: async () => join(root, 'ephemeral-data'),
      removeDataDir: async () => {},
      wait: async () => {},
      createToken: () => 'build-blocker-token',
      readProcessIdentity: async (pid) => pid === 31337 && emulatorStarted ? 'darwin:start' : undefined,
      signalProcess: () => { emulatorStarted = false; },
    });
    const worktreePath = join(root, 'worktree');
    const leaseRoot = join(root, 'leases');
    await mkdir(worktreePath, { recursive: true });
    const result = await controller.prepare({
      proofId: 'proof-build-blocker', worktreePath, artifactDir: 'proofs', leaseRoot, config, checks: [],
      checkedChangeSha256: 'd'.repeat(64),
      proofAgentBudgetMs: 900_000,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'blocked');
    if (result.status !== 'blocked') return;
    assert.match(result.summary, /Android resource linking failed/u);
    assert.doesNotMatch(result.summary, /do-not-leak-value/u);
    await assert.rejects(readFile(join(leaseRoot, 'android.json')), { code: 'ENOENT' });
    assert.equal(emulatorStarted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner preserves an existing durable lease instead of starting a competing emulator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-android-proof-existing-lease-'));
  try {
    const worktreePath = join(root, 'worktree');
    const leaseRoot = join(root, 'leases');
    const lease = {
      schema: 'codex-orchestrator.android-lease' as const, version: 1 as const, status: 'active' as const,
      proofId: 'proof-existing', token: 'existing-token', serial: 'emulator-5560', appId: config.applicationId,
      ownerPid: 7, appPid: 42, runnerCreated: true as const, emulatorPid: 99,
      emulatorProcessIdentity: 'darwin:existing-start',
      dataDir: '/tmp/codex-orchestrator-android-existing',
      acquiredAt: '2026-07-28T09:00:00.000Z', expiresAt: '2026-07-28T09:30:00.000Z', updatedAt: '2026-07-28T09:01:00.000Z',
    };
    await mkdir(leaseRoot, { recursive: true });
    await writeFile(join(leaseRoot, 'android.json'), `${JSON.stringify(lease)}\n`);
    const controller = new RunnerAndroidProofController({
      adbPath: '/must-not-run/adb', emulatorPath: '/must-not-run/emulator',
      execute: async () => { throw new Error('must not execute'); },
      startEmulator: async () => { throw new Error('must not start'); },
    });
    const result = await controller.prepare({
      proofId: 'proof-existing', worktreePath, artifactDir: 'proofs', leaseRoot, config, checks: [],
      checkedChangeSha256: 'e'.repeat(64),
      proofAgentBudgetMs: 900_000,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'blocked');
    if (result.status !== 'blocked') return;
    assert.match(result.summary, /existing durable Android lease/iu);
    assert.deepEqual(parseAndroidLease(await readFile(join(leaseRoot, 'android.json'))), lease);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 };
}
