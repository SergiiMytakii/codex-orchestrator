import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { loadPackageSkillBundle } from '../src/skills/package-skill-bundle.js';

const packageRoot = resolve('.');

test('runtime skill import records the exact allowlist, source fingerprint, and approved adaptation', async () => {
  const bundle = JSON.parse(await readFile('runtime-skills/bundle.json', 'utf8')) as Record<string, any>;
  const snapshot = JSON.parse(await readFile('runtime-skills/source-snapshot.json', 'utf8')) as Record<string, any>;
  const report = JSON.parse(await readFile('runtime-skills/adaptation-report.json', 'utf8')) as Record<string, any>;

  assert.equal(Object.keys(bundle.skills).length, 16);
  assert.equal(snapshot.sourceFingerprint, bundle.sourceFingerprint);
  assert.equal(report.sourceFingerprint, bundle.sourceFingerprint);
  assert.ok(report.approvedPlanAdaptations.some((item: Record<string, unknown>) => item.id === 'high-artifact-review-topology'));
  assert.deepEqual(snapshot.records, [...snapshot.records].sort((left, right) => Buffer.compare(Buffer.from(left.logicalPath), Buffer.from(right.logicalPath))));
  assert.equal(snapshot.records.filter((record: Record<string, unknown>) => record.origin === 'git-blob').length, 4);
});

test('runtime skill payload has no personal paths, automatic invocation markers, or native delegation tools', async () => {
  const loaded = await loadPackageSkillBundle(packageRoot);
  for (const file of loaded.manifest.files.filter((entry) => /(?:SKILL\.md|\.mjs)$/u.test(entry.path))) {
    const text = await readFile(join(loaded.bundleRoot, ...file.path.split('/')), 'utf8');
    assert.doesNotMatch(text, /\/Users\/serhiimytakii\/\.codex/u, file.path);
    assert.doesNotMatch(text, /\$(?!schema\b)[a-z][a-z0-9-]*/u, file.path);
    assert.doesNotMatch(text, /spawn_agent|send_input|close_agent|subagent/iu, file.path);
  }
});

test('runtime skill manifest rejects a declared path escape before reading payload bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-skill-invalid-'));
  await cp('runtime-skills', join(root, 'runtime-skills'), { recursive: true });
  const path = join(root, 'runtime-skills/bundle.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
  manifest.files[0].path = '../escape';
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(loadPackageSkillBundle(root), /invalid path|invalid bundle file record/);
});
