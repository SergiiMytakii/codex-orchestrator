import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { verifyBridgeRuntimeManifest } from '../src/bridge-runtime.js';

const execFileAsync = promisify(execFile);

test('checked-in bridge manifest matches the current publication closure', async () => {
  const manifest = await verifyBridgeRuntimeManifest(process.cwd());

  assert.equal(manifest.packageVersion, '0.1.51');
  assert.match(manifest.packageHash, /^[a-f0-9]{64}$/u);
});

test('npm dry-run tarball includes every runtime skill manifest entry', async () => {
  const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 });
  const packed = JSON.parse(stdout)[0] as { files: Array<{ path: string }> };
  const paths = new Set(packed.files.map((file) => file.path));
  const manifest = JSON.parse(await readFile('runtime-skills/bundle.json', 'utf8')) as { files: Array<{ path: string }> };

  assert.ok(paths.has('runtime-skills/bundle.json'));
  for (const file of manifest.files) assert.ok(paths.has(`runtime-skills/${file.path}`), file.path);
});
