import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProcessExecutor } from '../src/v2/adapters/command.js';
import type { IosLeaseRecordV1 } from '../src/v2/mobile-lease.js';
import { discoverIosTooling, releaseIosSimulator } from '../src/v2/runtime.js';

const udid = '11111111-2222-4333-8444-555555555555';

test('iOS tooling discovery is read-only and selects the newest available runtime and Pro iPhone', async () => {
  const calls: string[][] = [];
  const executor: ProcessExecutor = async (_command, args) => {
    calls.push(args);
    if (args[2] === 'runtimes') return result(JSON.stringify({ runtimes: [
      { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2', version: '18.2', isAvailable: true },
      { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3', version: '26.3', isAvailable: true },
      { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', version: '27.0', isAvailable: false },
    ] }));
    return result(JSON.stringify({ devicetypes: [
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro', name: 'iPhone 16 Pro' },
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', name: 'iPhone 17' },
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' },
    ] }));
  };
  assert.deepEqual(await discoverIosTooling(executor, '/usr/bin/xcrun'), {
    runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
    deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
  });
  assert.deepEqual(calls, [
    ['simctl', 'list', 'runtimes', '-j'],
    ['simctl', 'list', 'devicetypes', '-j'],
  ]);
});

test('iOS release controller mutates only the exact recorded UDID and confirms deletion', async () => {
  const calls: string[][] = [];
  let state: 'Booted' | 'Shutdown' | 'absent' = 'Booted';
  const executor: ProcessExecutor = async (_command, args) => {
    calls.push(args);
    if (args[1] === 'list') return result(JSON.stringify({ devices: state === 'absent' ? {} : {
      runtime: [{ udid, name: 'Codex proof-ios', state, isAvailable: true }],
    } }));
    if (args[1] === 'shutdown' && args[2] === udid) { state = 'Shutdown'; return result(''); }
    if (args[1] === 'delete' && args[2] === udid) { state = 'absent'; return result(''); }
    return result('', 1);
  };
  await releaseIosSimulator(executor, '/usr/bin/xcrun', lease());
  assert.deepEqual(calls, [
    ['simctl', 'list', 'devices', '-j'],
    ['simctl', 'shutdown', udid],
    ['simctl', 'delete', udid],
    ['simctl', 'list', 'devices', '-j'],
  ]);
  calls.length = 0;
  await releaseIosSimulator(executor, '/usr/bin/xcrun', lease());
  assert.deepEqual(calls, [['simctl', 'list', 'devices', '-j']]);
});

function lease(): IosLeaseRecordV1 {
  return {
    schema: 'codex-orchestrator.ios-lease', version: 1, status: 'active', proofId: 'proof-ios', token: 'token-1',
    udid, deviceName: 'Codex proof-ios', bundleId: 'dev.codex.proof', ownerPid: 1, appPid: 2,
    runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
    deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', runnerCreated: true,
    acquiredAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:20:00.000Z', updatedAt: '2026-07-17T00:01:00.000Z',
  };
}

function result(stdout: string, exitCode = 0): Awaited<ReturnType<ProcessExecutor>> {
  return { stdout, stderr: '', exitCode };
}
