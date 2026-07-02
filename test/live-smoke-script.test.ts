import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runLiveSmoke(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url));
    const child = spawn(process.execPath, [scriptPath, ...args], {
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

function runLiveSmokeHelp(): Promise<CommandResult> {
  return runLiveSmoke(['--help']);
}

function listedValues(output: string, label: string): string[] {
  const match = output.match(new RegExp(`^${label}: (.+)$`, 'm'));
  assert.ok(match, `expected ${label} line in output:\n${output}`);
  return match[1].split(',').map((value) => value.trim());
}

test('live smoke help lists publish-gate coverage scenarios', async () => {
  const result = await runLiveSmokeHelp();

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const scenarios = listedValues(result.stdout, 'Scenarios');
  assert.deepEqual(scenarios, [
    'baseline',
    'package-install',
    'discovery-matrix',
    'real-codex',
    'remote-base-branch',
    'scoped-runner-commit',
    'commit-policy',
    'run-scoped',
    'loop-policy',
    'diagnostics',
    'browser-proof',
    'acceptance-proof-positive',
    'proof-strategy-non-visual-smoke',
    'acceptance-proof-rework',
    'acceptance-proof-negative',
    'quality-gates',
    'risk-routing',
    'safety-negative',
    'plan-auto',
    'run-plan-auto',
    'plan-auto-blocking',
  ]);
  assert.equal(scenarios.includes('visual-proof'), false);
  assert.equal(scenarios.includes('scoped-local-commit'), false);
  assert.equal(scenarios.includes('local-commit-blocked'), false);
  assert.equal(scenarios.includes('denied-secret'), false);
  assert.equal(scenarios.includes('invalid-report'), false);
});

test('live smoke help documents run profiles and default core release profile', async () => {
  const result = await runLiveSmokeHelp();

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--profile <name>\s+Run a scenario profile\. Default core-release/);
  assert.deepEqual(listedValues(result.stdout, 'Profiles'), [
    'core-release',
    'extended-policy',
    'proof-matrix',
    'full',
  ]);
});

test('live smoke rejects unknown profiles before running smoke setup', async () => {
  const result = await runLiveSmoke(['--profile', 'missing-profile']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown profile "missing-profile"/);
  assert.match(result.stderr, /Known profiles: core-release, extended-policy, proof-matrix, full/);
});

test('live smoke help documents scratch repo and strict cleanup defaults', async () => {
  const result = await runLiveSmokeHelp();

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Defaults to SergiiMytakii\/codex-orchestrator-live-smoke/);
  assert.match(result.stdout, /Clean up created issues, PRs, and branches after the run by default/);
  assert.match(result.stdout, /--cleanup-mode <mode>\s+Cleanup mode: delete or close\. Default delete/);
  assert.match(result.stdout, /--keep-artifacts\s+Keep created GitHub artifacts for inspection/);
});
