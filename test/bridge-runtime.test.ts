import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildBridgeRuntimeManifest,
  verifyBridgeRuntimeManifest,
  writeBridgeRuntimeManifest,
} from '../src/bridge-runtime.js';

async function bridgePackageFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-runtime-'));
  await mkdir(join(root, 'dist/src'), { recursive: true });
  await mkdir(join(root, 'prompts'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"codex-orchestrator","version":"1.2.3"}\n', 'utf8');
  await writeFile(join(root, 'dist/src/cli.js'), '#!/usr/bin/env node\n', 'utf8');
  await chmod(join(root, 'dist/src/cli.js'), 0o755);
  await writeFile(join(root, 'prompts/setup-skill.md'), 'prompt\n', 'utf8');
  await writeFile(join(root, 'README.md'), 'readme\n', 'utf8');
  await writeFile(join(root, 'docs/deep-dive.md'), 'deep\n', 'utf8');
  await writeFile(join(root, 'CHANGELOG.md'), 'change\n', 'utf8');
  return root;
}

test('bridge runtime manifest deterministically covers the exact publication closure', async () => {
  const root = await bridgePackageFixture();
  const first = await buildBridgeRuntimeManifest(root);
  const second = await buildBridgeRuntimeManifest(root);

  assert.deepEqual(first, second);
  assert.equal(first.packageVersion, '1.2.3');
  assert.deepEqual(first.files.map((file) => file.path), [
    'CHANGELOG.md',
    'README.md',
    'dist/src/cli.js',
    'docs/deep-dive.md',
    'package.json',
    'prompts/setup-skill.md',
  ]);
  assert.match(first.packageHash, /^[a-f0-9]{64}$/u);
});

test('bridge runtime verification detects byte and mode drift', async () => {
  const root = await bridgePackageFixture();
  await writeBridgeRuntimeManifest(root);
  const manifestPath = join(root, 'bridge-runtime.json');
  assert.equal((await verifyBridgeRuntimeManifest(root, manifestPath)).packageVersion, '1.2.3');

  await writeFile(join(root, 'README.md'), 'changed\n', 'utf8');
  await assert.rejects(verifyBridgeRuntimeManifest(root, manifestPath), /bridge-runtime.json does not match package bytes/);

  await writeFile(join(root, 'README.md'), 'readme\n', 'utf8');
  await chmod(join(root, 'dist/src/cli.js'), 0o644);
  await assert.rejects(verifyBridgeRuntimeManifest(root, manifestPath), /bridge-runtime.json does not match package bytes/);
  assert.match(await readFile(manifestPath, 'utf8'), /"version": 1/);
});

test('bridge manifest writer normalizes the installed package bin mode before hashing', async () => {
  const root = await bridgePackageFixture();
  const cliPath = join(root, 'dist/src/cli.js');
  await chmod(cliPath, 0o644);

  const manifest = await writeBridgeRuntimeManifest(root);

  assert.equal((await lstat(cliPath)).mode & 0o777, 0o755);
  assert.equal(manifest.files.find((file) => file.path === 'dist/src/cli.js')?.mode, 0o755);
  await verifyBridgeRuntimeManifest(root);
});

test('bridge manifest atomic publication removes its temporary file when rename fails', async () => {
  const root = await bridgePackageFixture();
  const manifestPath = join(root, 'bridge-runtime.json');
  await mkdir(manifestPath);

  await assert.rejects(writeBridgeRuntimeManifest(root), /EISDIR|ENOTDIR|EEXIST/);
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.startsWith('bridge-runtime.json.') && entry.endsWith('.tmp')),
    [],
  );
});
