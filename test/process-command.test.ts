import assert from 'node:assert/strict';
import { execPath } from 'node:process';
import { test } from 'node:test';
import { defaultProcessExecutor } from '../src/process/command.js';

test('process executor terminates commands after timeout', async () => {
  const result = await defaultProcessExecutor(
    execPath,
    ['-e', 'setTimeout(() => console.log("late"), 1000)'],
    { timeoutMs: 50 },
  );

  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /Command timed out after 50ms/);
});

test('process executor streams stdout and stderr chunks to callbacks', async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const result = await defaultProcessExecutor(
    execPath,
    ['-e', 'console.log("hello"); console.error("warn");'],
    {
      onStdoutChunk: (chunk) => {
        stdoutChunks.push(chunk);
      },
      onStderrChunk: (chunk) => {
        stderrChunks.push(chunk);
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello\n');
  assert.equal(result.stderr, 'warn\n');
  assert.deepEqual(stdoutChunks, ['hello\n']);
  assert.deepEqual(stderrChunks, ['warn\n']);
});

test('process executor terminates commands after idle timeout', async () => {
  const result = await defaultProcessExecutor(
    execPath,
    ['-e', 'setTimeout(() => console.log("late"), 1000)'],
    { idleTimeoutMs: 50 },
  );

  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /Command idle timed out after 50ms/);
});

test('process executor resets idle timeout on output activity', async () => {
  const result = await defaultProcessExecutor(
    execPath,
    [
      '-e',
      [
        'console.log("active");',
        'setTimeout(() => console.log("still-active"), 1200);',
        'setTimeout(() => console.log("done"), 2400);',
      ].join(' '),
    ],
    { idleTimeoutMs: 3000 },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /active/);
  assert.match(result.stdout, /still-active/);
  assert.match(result.stdout, /done/);
});
