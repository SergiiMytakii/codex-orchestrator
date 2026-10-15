import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultProcessExecutor } from '../src/v2/adapters/command.js';

test('owned command parent exit drains and terminates inherited descendant pipes', { timeout: 10_000 }, async () => {
  const result = await defaultProcessExecutor(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] }).unref();
    process.stdout.write('parent-completed');
  `], { timeoutMs: 2_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'parent-completed');
});

test('owned command deadline includes output callbacks after successful parent exit', { timeout: 2_000 }, async () => {
  // Exercise callback settlement within the deadline without a Node VM startup.
  const result = await defaultProcessExecutor('/bin/sh', ['-c', 'printf done'], {
    timeoutMs: 150, onStdoutChunk: () => new Promise<void>(() => undefined),
  });
  assert.equal(result.exitCode, 124);
  assert.equal(result.stdout, 'done');
});

test('owned command deadline interrupts blocked stdin and preserves binary bytes', { timeout: 10_000 }, async () => {
  const bytes: Buffer[] = [];
  const binary = await defaultProcessExecutor(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,128,13,10]))'], {
    onStdoutBytes: (chunk) => { bytes.push(chunk); },
  });
  assert.equal(binary.exitCode, 0);
  assert.deepEqual(Buffer.concat(bytes), Buffer.from([0,255,128,13,10]));
  const blocked = await defaultProcessExecutor(process.execPath, ['-e', 'process.stdin.pause(); setInterval(() => {},1000)'], {
    timeoutMs: 100, stdin: 'x'.repeat(4 * 1024 * 1024),
  });
  assert.equal(blocked.exitCode, 124);
});

test('owned command confirms group absence after exit races a denied cleanup signal', async (t) => {
  const kill = process.kill.bind(process);
  let observedExitingGroup = false;
  let deniedCleanup = false;
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && signal === 0 && !observedExitingGroup) {
      observedExitingGroup = true;
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    }
    if (pid < 0 && signal === 'SIGTERM' && !deniedCleanup) {
      deniedCleanup = true;
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    }
    return kill(pid, signal);
  });

  const result = await defaultProcessExecutor(process.execPath, ['-e', "process.stdout.write('done')"]);

  assert.equal(observedExitingGroup, true);
  assert.equal(deniedCleanup, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'done');
});

test('owned command keeps denied group cleanup blocked until the existing barrier expires', { timeout: 12_000 }, async (t) => {
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return kill(pid, signal);
  });

  await assert.rejects(
    defaultProcessExecutor(process.execPath, ['-e', "process.stdout.write('done')"]),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'command-process-quiescence-unconfirmed',
  );
});
