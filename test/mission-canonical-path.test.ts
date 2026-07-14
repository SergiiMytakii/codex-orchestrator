import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';

import { inspectCanonicalFile } from '../src/runner/mission-canonical-path.js';

test('canonical inspection rejects same-inode same-length concurrent rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-canonical-rewrite-'));
  const path = join(root, 'value.txt');
  await writeFile(path, 'before', 'utf8');

  await assert.rejects(inspectCanonicalFile({
    root,
    path: 'value.txt',
    deniedPaths: [],
  }, {
    beforeRead: async () => writeFile(path, 'after!', 'utf8'),
  }), /changed during read/);
});
