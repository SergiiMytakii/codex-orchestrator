import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('artifact review fingerprint Node tool matches the approved golden fixture', async () => {
  const tool = await import(pathToFileURL(resolve('runtime-skills/tools/artifact-review-fingerprint.mjs')).href) as {
    canonicalize(text: string): string;
    fingerprint(text: string): string;
  };
  const fixture = JSON.parse(await readFile('runtime-skills/fixtures/tools/artifact-review-fingerprint.json', 'utf8')) as Record<string, string>;

  assert.equal(tool.canonicalize(fixture.input), fixture.canonical);
  assert.equal(tool.fingerprint(fixture.input), fixture.sha256);
  assert.equal(tool.fingerprint(fixture.input.replace('status: "ready"', 'status: "approved"')), fixture.sha256);
  assert.notEqual(tool.fingerprint(fixture.input.replace('Deliver the behavior.', 'Deliver different behavior.')), fixture.sha256);
});

test('detect test command Node tool works without invoking Python', async () => {
  const tool = await import(pathToFileURL(resolve('runtime-skills/tools/detect-test-command.mjs')).href) as {
    detect(root: string): Record<string, any>;
  };
  const root = await mkdtemp(join(tmpdir(), 'detect-test-command-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(join(root, 'package-lock.json'), '{}');

  const result = tool.detect(root);
  assert.deepEqual(result.candidates, [{ command: 'npm run test', confidence: 'high', reason: 'package.json defines scripts.test; package manager from package-lock.json' }]);
  assert.deepEqual(result.safety, { read_only: true, tests_executed: false, files_modified: false, env_files_read: false });
});

test('review context Node tool reports deterministic read-only git evidence', async () => {
  const tool = await import(pathToFileURL(resolve('runtime-skills/tools/review-context.mjs')).href) as {
    collect(root: string, limit?: number): Record<string, any>;
  };
  const root = await mkdtemp(join(tmpdir(), 'review-context-'));
  await mkdir(join(root, 'test'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'runtime@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: root });
  await writeFile(join(root, 'feature.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'test/feature.test.ts'), 'test\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  await writeFile(join(root, 'feature.ts'), 'export const value = 2;\n');

  const result = tool.collect(root, 5);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed_files, ['feature.ts']);
  assert.equal(result.safety.env_files_read, false);
  assert.ok(result.nearby_tests_or_docs.includes('test/feature.test.ts'));
});

test('review context Node tool fails closed when required Git history is unavailable', async () => {
  const tool = await import(pathToFileURL(resolve('scripts/runtime-skill-tools/review-context.mjs')).href) as {
    collect(root: string, limit?: number): Record<string, any>;
  };
  const root = await mkdtemp(join(tmpdir(), 'review-context-unborn-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: root });
  assert.deepEqual(tool.collect(root).ok, false);
  assert.match(String(tool.collect(root).error), /git log .* failed/);
});
