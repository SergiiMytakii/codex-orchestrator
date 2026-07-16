import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  loadPackageSkillBundle,
  materializePackageSkillBundle,
  verifyMaterializedSkillBundle,
} from '../src/skills/package-skill-bundle.js';

test('package skill bundle validates the checked-in closure and accepted bridge generation', async () => {
  const bundle = await loadPackageSkillBundle();

  assert.equal(bundle.manifest.version, 1);
  assert.equal(bundle.manifest.package.name, 'codex-orchestrator');
  assert.ok(bundle.manifest.acceptedBridgePackageHashes.includes(
    '4556aaafaf8a9657f0239b49572f3842426dcd50f070b5ef87f2c69153d2153a',
  ));
  assert.equal(Object.keys(bundle.manifest.skills).length, 16);
  assert.deepEqual(Object.keys(bundle.manifest.operations), [...Object.keys(bundle.manifest.operations)].sort());
});

test('package skill materialization rejects symlinked target-state ancestors', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'package-skill-symlink-target-'));
  const outside = await mkdtemp(join(tmpdir(), 'package-skill-outside-'));
  await mkdir(join(targetRoot, '.state'));
  await symlink(outside, join(targetRoot, '.state/runtime-bundles'));
  await assert.rejects(materializePackageSkillBundle({ targetRoot, stateDir: '.state' }), /unsafe materialization ancestor/);
});

test('package skill bundle materializes one immutable content-addressed snapshot', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'package-skill-target-'));
  const first = await materializePackageSkillBundle({ targetRoot, stateDir: '.state' });
  const second = await materializePackageSkillBundle({ targetRoot, stateDir: '.state' });

  assert.equal(first.bundleRoot, second.bundleRoot);
  assert.equal(first.bundleHash, second.bundleHash);
  await verifyMaterializedSkillBundle(first.bundleRoot, first.bundleHash);

  const manifestPath = join(first.bundleRoot, 'bundle.json');
  await assert.rejects(writeFile(manifestPath, await readFile(manifestPath)), /EACCES|EPERM/);
});

test('concurrent materializers converge on one verified destination', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'package-skill-concurrent-'));

  const results = await Promise.all(Array.from({ length: 4 }, () => materializePackageSkillBundle({ targetRoot, stateDir: '.state' })));

  assert.equal(new Set(results.map((result) => result.bundleRoot)).size, 1);
  assert.equal(new Set(results.map((result) => result.bundleHash)).size, 1);
  await verifyMaterializedSkillBundle(results[0]!.bundleRoot, results[0]!.bundleHash);
});

test('materialized bundle verification rejects sealed-mode drift', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'package-skill-mode-drift-'));
  const materialized = await materializePackageSkillBundle({ targetRoot, stateDir: '.state' });
  const manifest = JSON.parse(await readFile(join(materialized.bundleRoot, 'bundle.json'), 'utf8')) as { files: Array<{ path: string }> };
  const changedPath = join(materialized.bundleRoot, manifest.files[0]!.path);
  await chmod(changedPath, 0o600);

  await assert.rejects(verifyMaterializedSkillBundle(materialized.bundleRoot, materialized.bundleHash), /file drift/);
});

test('materialization cleans an owned sealed temp tree when publication crashes', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'package-skill-before-publish-crash-'));

  await assert.rejects(materializePackageSkillBundle({
    targetRoot,
    stateDir: '.state',
    dependencies: { beforePublish: async () => { throw new Error('injected-before-publish'); } },
  }), /injected-before-publish/);

  assert.deepEqual(await readdir(join(targetRoot, '.state', 'runtime-bundles')), []);
});

test('a crash after atomic publication leaves a reusable verified destination', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'package-skill-after-publish-crash-'));
  let publishedRoot = '';

  await assert.rejects(materializePackageSkillBundle({
    targetRoot,
    stateDir: '.state',
    dependencies: { afterPublish: async (destination) => { publishedRoot = destination; throw new Error('injected-after-publish'); } },
  }), /injected-after-publish/);
  const recovered = await materializePackageSkillBundle({ targetRoot, stateDir: '.state' });

  assert.equal(recovered.bundleRoot, publishedRoot);
  await verifyMaterializedSkillBundle(recovered.bundleRoot, recovered.bundleHash);
});
