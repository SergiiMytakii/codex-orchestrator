import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  const packageApi = await import('../src/index.js');
  const { RunIssue } = await import('../src/v2/run-issue.js');
  assert.equal(packageApi.RunIssue, RunIssue);
  assert.equal(typeof packageApi.RunIssue.prototype.runIssue, 'function');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    new URL('../src/v2/cli.js', import.meta.url).pathname, '--help',
  ], { timeout: 10_000 });
  assert.equal(stderr, '');
  assert.match(stdout, /^codex-orchestrator\n/u);
  for (const command of ['setup', 'doctor', 'status', 'run', 'daemon']) assert.match(stdout, new RegExp(`\\b${command}\\b`, 'u'));
});
