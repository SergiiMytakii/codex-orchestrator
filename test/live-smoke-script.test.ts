import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runLiveSmokeHelp(): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url));
    const child = spawn(process.execPath, [scriptPath, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test('live smoke help lists publish-gate coverage scenarios', async () => {
  const result = await runLiveSmokeHelp();

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /run-scoped/);
  assert.match(result.stdout, /run-plan-auto/);
  assert.match(result.stdout, /discovery-matrix/);
  assert.match(result.stdout, /quality-gates/);
  assert.match(result.stdout, /loop-policy/);
  assert.match(result.stdout, /diagnostics/);
  assert.match(result.stdout, /plan-auto-blocking/);
  assert.match(result.stdout, /package-install/);
});
