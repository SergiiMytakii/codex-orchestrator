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
