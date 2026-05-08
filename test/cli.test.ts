import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface PackageJsonShape {
  name?: unknown;
  version?: unknown;
}

async function readExpectedPackageVersion(): Promise<string> {
  const packageJsonUrl = new URL('../../package.json', import.meta.url);
  const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as PackageJsonShape;

  assert.equal(typeof packageJson.name, 'string');
  assert.equal(typeof packageJson.version, 'string');

  return `${packageJson.name} ${packageJson.version}\n`;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/src/cli.js', ...args], {
      cwd: new URL('../..', import.meta.url),
      env,
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

test('prints help', async () => {
  const result = await runCli(['--help']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /codex-orchestrator/);
  assert.match(result.stdout, /health/);
  assert.match(result.stdout, /--version/);
  assert.match(result.stdout, /--help/);
});

test('prints version', async () => {
  const result = await runCli(['--version']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, await readExpectedPackageVersion());
});

test('runs no-op health command', async () => {
  const result = await runCli(['health']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'codex-orchestrator health: ok\n');
});

test('runs setup dry-run without launching Codex', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cli-target-'));
  const fakeBin = await mkdtemp(join(tmpdir(), 'codex-orchestrator-fake-bin-'));
  const fakeGh = join(fakeBin, 'gh');
  await writeFile(fakeGh, '#!/bin/sh\nprintf \'[{"name":"agent:auto"}]\'\n', 'utf8');
  await chmod(fakeGh, 0o755);

  const result = await runCli(
    [
      'setup',
      '--target',
      targetRoot,
      '--github-owner',
      'SergiiMytakii',
      '--github-repo',
      'IntelleReach',
      '--dry-run',
    ],
    {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /.codex-orchestrator\/config.json/);
  assert.match(result.stdout, /labels: report-only/);
  assert.match(result.stdout, /prd: package-owned-prompt-fallback/);
  assert.match(result.stdout, /Codex will not be launched/);
  assert.match(result.stdout, /setup will not commit or open a pull request/);
});
