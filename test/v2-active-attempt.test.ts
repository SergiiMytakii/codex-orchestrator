import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  adoptActiveAttempt,
  clearActiveAttempt,
  confirmActiveAttemptCleanup,
  createActiveAttempt,
  launchActiveAttempt,
  observeActiveAttempt,
  validateActiveAttempt,
} from '../src/v2/active-attempt.js';
import {
  captureProcessStartIdentity,
  classifyProcessIdentity,
  observeProcessGroup,
  observeProcessIdentity,
} from '../src/v2/process-identity.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const INCARNATION_ID = '22222222-2222-4222-8222-222222222222';

test('one active attempt moves through launch observation adoption cleanup and clear', () => {
  const prepared = createActiveAttempt({
    runId: RUN_ID,
    operationId: 'implementation',
    operationSourceId: 'cycle:1',
    resultPath: '/tmp/orchestrator/runs/111/attempts/222/report.json',
    preparedAt: '2026-07-30T12:00:00.000Z',
  }, () => INCARNATION_ID);
  assert.equal(prepared.stage, 'prepared');
  assert.equal(prepared.incarnationId, INCARNATION_ID);
  assert.equal(prepared.attemptId, '35aec35f4f0dbcb9900a55c4a73b42882dd71cd055822cf5bc6b8b05c499a6f3');

  const launched = launchActiveAttempt(prepared, {
    host: 'host-a', bootId: 'boot-a', pid: 42, processGroupId: 42,
    processStartIdentity: { kind: 'linux-start-ticks', value: '12345' },
    launchedAt: '2026-07-30T12:00:01.000Z',
  });
  assert.equal(launched.stage, 'launched');

  assert.throws(() => observeActiveAttempt(launched, {
    leader: 'absent', group: 'live', result: null, observedAt: '2026-07-30T12:00:02.000Z',
  }));
  assert.throws(() => observeActiveAttempt(launched, {
    leader: 'same', group: 'absent', result: null, observedAt: '2026-07-30T12:00:02.000Z',
  }));
  assert.throws(() => observeActiveAttempt(launched, {
    leader: 'unknown', group: 'absent', result: null, observedAt: '2026-07-30T12:00:02.000Z',
  }));
  const observed = observeActiveAttempt(launched, {
    leader: 'absent', group: 'absent',
    result: { path: prepared.resultPath, sha256: 'a'.repeat(64) },
    observedAt: '2026-07-30T12:00:02.000Z',
  });
  const adopted = adoptActiveAttempt(observed, '2026-07-30T12:00:03.000Z');
  assert.deepEqual(validateActiveAttempt(structuredClone(adopted)), adopted);
  assert.throws(() => validateActiveAttempt({ ...adopted, unknown: true }), /exact keys/iu);
  assert.throws(() => validateActiveAttempt({ ...adopted, attemptId: 'b'.repeat(64) }), /attemptId/iu);
  assert.throws(() => clearActiveAttempt(adopted));
  assert.equal(clearActiveAttempt(confirmActiveAttemptCleanup(adopted, '2026-07-30T12:00:04.000Z')), undefined);
});

test('missing result cannot be adopted or replaced until cleanup is confirmed', () => {
  const prepared = createActiveAttempt({
    runId: RUN_ID, operationId: 'opaque-operation', operationSourceId: 'opaque-source',
    resultPath: '/tmp/a/report.json', preparedAt: '2026-07-30T12:00:00.000Z',
  }, () => INCARNATION_ID);
  const launched = launchActiveAttempt(prepared, {
    host: 'host-a', bootId: 'boot-a', pid: 42, processGroupId: 42,
    processStartIdentity: { kind: 'linux-start-ticks', value: '12345' },
    launchedAt: '2026-07-30T12:00:01.000Z',
  });
  const missing = observeActiveAttempt(launched, {
    leader: 'reused', group: 'absent', result: null, observedAt: '2026-07-30T12:00:02.000Z',
  });
  assert.throws(() => adoptActiveAttempt(missing, '2026-07-30T12:00:03.000Z'), /no result/iu);
  assert.throws(() => clearActiveAttempt(missing), /cleanup/iu);
  assert.equal(clearActiveAttempt(confirmActiveAttemptCleanup(missing, '2026-07-30T12:00:04.000Z')), undefined);
});

test('a replacement incarnation receives a distinct attempt and result identity', () => {
  const first = createActiveAttempt({
    runId: RUN_ID, operationId: 'implementation', operationSourceId: 'cycle:1',
    resultPath: '/tmp/a/report.json', preparedAt: '2026-07-30T12:00:00.000Z',
  }, () => INCARNATION_ID);
  const replacement = createActiveAttempt({
    runId: RUN_ID, operationId: 'implementation', operationSourceId: 'cycle:1',
    resultPath: '/tmp/b/report.json', preparedAt: '2026-07-30T12:00:01.000Z',
  }, () => '33333333-3333-4333-8333-333333333333');
  assert.notEqual(first.attemptId, replacement.attemptId);
  assert.notEqual(first.resultPath, replacement.resultPath);
});

test('default preparation creates a fresh incarnation for the same semantic operation', () => {
  const input = {
    runId: RUN_ID, operationId: 'opaque-operation', operationSourceId: 'opaque-source',
    resultPath: '/tmp/a/report.json', preparedAt: '2026-07-30T12:00:00.000Z',
  };
  const first = createActiveAttempt(input);
  const replacement = createActiveAttempt(input);
  assert.notEqual(first.incarnationId, replacement.incarnationId);
  assert.notEqual(first.attemptId, replacement.attemptId);
});

test('Darwin process identity never proves same and requires old group absence', () => {
  const adversarialProcesses = [
    { argv: ['runner', 'a b'], flattenedCommand: 'runner a b' },
    { argv: ['runner a', 'b'], flattenedCommand: 'runner a b' },
  ];
  assert.notDeepEqual(adversarialProcesses[0]?.argv, adversarialProcesses[1]?.argv);
  assert.equal(adversarialProcesses[0]?.flattenedCommand, adversarialProcesses[1]?.flattenedCommand);
  assert.equal(classifyProcessIdentity({
    platform: 'darwin', expectedPid: 42, expectedProcessGroupId: 42,
    expectedStartIdentity: { kind: 'unavailable', platform: 'darwin' },
    observed: { status: 'present', pid: 42, processGroupId: 42, startIdentity: null },
  }), 'unknown');
  assert.equal(classifyProcessIdentity({
    platform: 'darwin', expectedPid: 42, expectedProcessGroupId: 42,
    expectedStartIdentity: { kind: 'unavailable', platform: 'darwin' },
    observed: { status: 'present', pid: 42, processGroupId: 99, startIdentity: null },
  }), 'reused');
});

test('Linux start ticks distinguish same process from PID reuse', () => {
  const base = {
    platform: 'linux' as const, expectedPid: 42, expectedProcessGroupId: 42,
    expectedStartIdentity: { kind: 'linux-start-ticks' as const, value: '12345' },
  };
  assert.equal(classifyProcessIdentity({
    ...base, observed: { status: 'present', pid: 42, processGroupId: 42, startIdentity: '12345' },
  }), 'same');
  assert.equal(classifyProcessIdentity({
    ...base, observed: { status: 'present', pid: 42, processGroupId: 42, startIdentity: '67890' },
  }), 'reused');
});

test('Linux launch capture and recovery read exact /proc start ticks and process group', async () => {
  const fields = Array.from({ length: 30 }, () => '0');
  fields[0] = 'S';
  fields[1] = '1';
  fields[2] = '42';
  fields[19] = '12345';
  const stat = `42 (worker with ) delimiter) ${fields.join(' ')}`;
  const system = {
    readFile: async (path: string) => {
      assert.equal(path, '/proc/42/stat');
      return stat;
    },
    readDarwinProcessGroupId: async () => ({ status: 'unknown' as const }),
  };

  assert.deepEqual(await captureProcessStartIdentity({
    platform: 'linux', pid: 42, processGroupId: 42,
  }, system), { status: 'available', identity: { kind: 'linux-start-ticks', value: '12345' } });
  assert.equal(await observeProcessIdentity({
    platform: 'linux', pid: 42, processGroupId: 42,
    processStartIdentity: { kind: 'linux-start-ticks', value: '12345' },
  }, system), 'same');
  assert.equal(await observeProcessIdentity({
    platform: 'linux', pid: 42, processGroupId: 42,
    processStartIdentity: { kind: 'linux-start-ticks', value: '67890' },
  }, system), 'reused');
});

test('portable observation distinguishes absence, PID reuse, and unreadable identity', async () => {
  const linuxInput = { platform: 'linux' as const, pid: 42, processGroupId: 42 };
  const absent = {
    readFile: async () => { throw nodeError('ENOENT'); },
    readDarwinProcessGroupId: async () => ({ status: 'unknown' as const }),
  };
  assert.deepEqual(await captureProcessStartIdentity(linuxInput, absent), { status: 'absent' });
  assert.equal(await observeProcessIdentity({
    ...linuxInput, processStartIdentity: { kind: 'linux-start-ticks', value: '12345' },
  }, absent), 'absent');

  const malformed = { ...absent, readFile: async () => 'malformed' };
  assert.deepEqual(await captureProcessStartIdentity(linuxInput, malformed), { status: 'unknown' });

  const fields = Array.from({ length: 30 }, () => '0');
  fields[0] = 'S';
  fields[1] = '1';
  fields[2] = '99';
  fields[19] = '12345';
  const reused = { ...absent, readFile: async () => `42 (worker) ${fields.join(' ')}` };
  assert.deepEqual(await captureProcessStartIdentity(linuxInput, reused), { status: 'reused' });
});

test('Darwin launch stores unavailable sentinel while recovery stays fail-closed', async () => {
  const system = {
    readFile: async () => { throw new Error('Linux reader must not run'); },
    readDarwinProcessGroupId: async (pid: number) => {
      assert.equal(pid, 42);
      return { status: 'present' as const, processGroupId: 42 };
    },
  };
  assert.deepEqual(await captureProcessStartIdentity({
    platform: 'darwin', pid: 42, processGroupId: 42,
  }, system), { status: 'available', identity: { kind: 'unavailable', platform: 'darwin' } });
  assert.equal(await observeProcessIdentity({
    platform: 'darwin', pid: 42, processGroupId: 42,
    processStartIdentity: { kind: 'unavailable', platform: 'darwin' },
  }, system), 'unknown');

  const reused = {
    ...system,
    readDarwinProcessGroupId: async () => ({ status: 'present' as const, processGroupId: 99 }),
  };
  assert.equal(await observeProcessIdentity({
    platform: 'darwin', pid: 42, processGroupId: 42,
    processStartIdentity: { kind: 'unavailable', platform: 'darwin' },
  }, reused), 'reused');
});

test('process-group observation is independent and fail-closed', () => {
  assert.equal(observeProcessGroup(42, () => undefined), 'live');
  assert.equal(observeProcessGroup(42, () => { throw nodeError('ESRCH'); }), 'absent');
  assert.equal(observeProcessGroup(42, () => { throw nodeError('EPERM'); }), 'live');
  assert.equal(observeProcessGroup(42, () => { throw nodeError('EIO'); }), 'unknown');
});

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
