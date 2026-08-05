import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultProcessExecutor, ProcessOutputLimitError } from '../src/v2/adapters/command.js';

test('production command executor aborts before buffering output beyond the configured bound', async () => {
  await assert.rejects(
    defaultProcessExecutor(process.execPath, ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], {
      maxOutputBytes: 1024 * 1024,
    }),
    (error: unknown) => error instanceof ProcessOutputLimitError
      && error.code === 'command-output-limit-exceeded'
      && error.maxOutputBytes === 1024 * 1024,
  );
});
