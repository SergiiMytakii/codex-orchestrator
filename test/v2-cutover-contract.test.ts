import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('public package points at one V2 runtime and ships no Legacy assets', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.bin, { 'codex-orchestrator': 'dist/src/v2/candidate-cli.js' });
  assert.deepEqual(packageJson.files, [
    'dist/src', 'internal-workflow', 'docs/deep-dive.md', 'CHANGELOG.md', 'README.md', 'LICENSE',
  ]);
  assert.equal(packageJson.scripts?.prepack, 'npm run verify:workflow --silent && npm run build --silent');
  assert.match(packageJson.scripts?.build ?? '', /npm run clean/u);
  assert.equal('bridge:manifest' in (packageJson.scripts ?? {}), false);
});

test('root export barrel and public CLI contain no Legacy authority', async () => {
  const indexSource = await readFile('src/index.ts', 'utf8');
  const cliSource = await readFile('src/v2/candidate-cli.ts', 'utf8');
  for (const forbidden of ['plan-auto', 'issue-tree', 'mission-', 'runScopedAutoCommand', 'bridge-runtime']) {
    assert.doesNotMatch(indexSource, new RegExp(forbidden, 'u'));
    assert.doesNotMatch(cliSource, new RegExp(forbidden, 'u'));
  }
  assert.match(cliSource, /'codex-orchestrator'/u);
  assert.doesNotMatch(cliSource, /V2 candidate/u);
});
