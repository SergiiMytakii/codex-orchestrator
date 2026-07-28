import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveCodexExecutable } from '../src/v2/runtime.js';
import { mkdtemp } from './mission-test-temp.js';

test('runtime resolves the installed Codex executable only from its safe path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-runtime-path-'));
  const parentBin = join(root, 'parent-bin');
  const safeBin = join(root, 'safe-bin');
  await Promise.all([mkdir(parentBin), mkdir(safeBin)]);
  const parentCodex = join(parentBin, 'codex');
  const safeCodex = join(safeBin, 'codex');
  await Promise.all([
    writeFile(parentCodex, '#!/bin/sh\necho codex-cli parent\n'),
    writeFile(safeCodex, '#!/bin/sh\necho codex-cli safe\n'),
  ]);
  await Promise.all([chmod(parentCodex, 0o700), chmod(safeCodex, 0o700)]);

  const previousPath = process.env.PATH;
  process.env.PATH = parentBin;
  try {
    assert.equal(await resolveCodexExecutable('codex', safeBin), await realpath(safeCodex));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
