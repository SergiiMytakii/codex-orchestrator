import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('public package points at one V2 runtime and ships no superseded assets', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.bin, { 'codex-orchestrator': 'dist/src/v2/cli.js' });
  assert.deepEqual(packageJson.files, [
    'dist/src', 'internal-workflow', 'docs/deep-dive.md', 'CHANGELOG.md', 'README.md', 'LICENSE',
  ]);
  assert.equal(packageJson.scripts?.prepack, 'npm run verify:workflow --silent && npm run build --silent');
  assert.match(packageJson.scripts?.build ?? '', /npm run clean/u);
  assert.equal('bridge:manifest' in (packageJson.scripts ?? {}), false);
});

test('root export barrel and public CLI expose the V2 authority', async () => {
  const indexSource = await readFile('src/index.ts', 'utf8');
  const cliSource = await readFile('src/v2/cli.ts', 'utf8');
  assert.match(indexSource, /\.\/v2\/run-issue\.js/u);
  assert.match(cliSource, /'codex-orchestrator'/u);
});
