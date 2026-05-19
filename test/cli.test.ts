import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validConfig } from './fixtures/config.js';

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

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env, cwd: string | URL = new URL('../..', import.meta.url)): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const cliPath = fileURLToPath(new URL('../../dist/src/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
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
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /daemon/);
  assert.match(result.stdout, /agent:auto/);
  assert.match(result.stdout, /agent:plan-auto/);
  assert.match(result.stdout, /--prepare-labels/);
  assert.match(result.stdout, /--sync-prompts/);
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
  assert.match(result.stdout, /prd: package-bundled-prompt/);
  assert.match(result.stdout, /Codex will not be launched/);
  assert.match(result.stdout, /setup will not commit or open a pull request/);
});

test('runs setup with repository inferred from git origin', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cli-target-'));
  const fakeBin = await mkdtemp(join(tmpdir(), 'codex-orchestrator-fake-bin-'));
  const fakeGh = join(fakeBin, 'gh');
  await writeFile(fakeGh, '#!/bin/sh\nprintf \'[{"name":"agent:auto"}]\'\n', 'utf8');
  await chmod(fakeGh, 0o755);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', targetRoot, 'init'], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (status) => {
      status === 0 ? resolve() : reject(new Error(`git init exited with ${status}`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', targetRoot, 'remote', 'add', 'origin', 'https://github.com/SergiiMytakii/IntelleReach.git'], {
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (status) => {
      status === 0 ? resolve() : reject(new Error(`git remote add exited with ${status}`));
    });
  });

  const result = await runCli(
    [
      'setup',
      '--prepare-labels',
    ],
    {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
    targetRoot,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /mode: write/);
  assert.match(result.stdout, /labels: create-missing/);

  const config = JSON.parse(await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8')) as Record<
    string,
    Record<string, string>
  >;
  assert.equal(config.github.owner, 'SergiiMytakii');
  assert.equal(config.github.repo, 'IntelleReach');
});

test('status missing target exits with usage error', async () => {
  const result = await runCli(['status', '--dry-run']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /status requires --target <path>/);
});

test('doctor missing target exits with usage error', async () => {
  const result = await runCli(['doctor', '--json']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /doctor requires --target <path>/);
});

test('run command validates required arguments', async () => {
  const missingTarget = await runCli(['run', '--issue', '155']);
  assert.equal(missingTarget.status, 2);
  assert.match(missingTarget.stderr, /run requires --target <path>/);

  const missingIssue = await runCli(['run', '--target', '/tmp/repo']);
  assert.equal(missingIssue.status, 2);
  assert.match(missingIssue.stderr, /run requires --issue <number>/);

  const invalidIssue = await runCli(['run', '--target', '/tmp/repo', '--issue', '0']);
  assert.equal(invalidIssue.status, 2);
  assert.match(invalidIssue.stderr, /run requires --issue <number>/);
});

test('daemon command validates required arguments', async () => {
  const missingTarget = await runCli(['daemon', '--once']);
  assert.equal(missingTarget.status, 2);
  assert.match(missingTarget.stderr, /daemon requires --target <path>/);

  const invalidInterval = await runCli(['daemon', '--target', '/tmp/repo', '--interval-seconds', '0']);
  assert.equal(invalidInterval.status, 2);
  assert.match(invalidInterval.stderr, /daemon requires --interval-seconds <positive integer>/);

  const invalidMaxRuns = await runCli(['daemon', '--target', '/tmp/repo', '--max-runs', '0']);
  assert.equal(invalidMaxRuns.status, 2);
  assert.match(invalidMaxRuns.stderr, /daemon requires --max-runs <positive integer>/);

  const invalidConcurrency = await runCli(['daemon', '--target', '/tmp/repo', '--concurrency', '4']);
  assert.equal(invalidConcurrency.status, 2);
  assert.match(invalidConcurrency.stderr, /daemon requires --concurrency <integer between 1 and 3>/);
});

test('runs status dry-run without launching Codex', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cli-status-target-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    `${JSON.stringify(validConfig, null, 2)}\n`,
    'utf8',
  );
  const fakeBin = await mkdtemp(join(tmpdir(), 'codex-orchestrator-fake-bin-'));
  const fakeGh = join(fakeBin, 'gh');
  await writeFile(fakeGh, '#!/bin/sh\nprintf \'[]\'\n', 'utf8');
  await chmod(fakeGh, 0o755);

  const result = await runCli(['status', '--target', targetRoot, '--dry-run'], {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /codex-orchestrator status/);
  assert.match(result.stdout, /mode: dry-run/);
  assert.match(result.stdout, /eligible:\n  - none/);
});

test('runs daemon once without eligible work', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cli-daemon-target-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    `${JSON.stringify(validConfig, null, 2)}\n`,
    'utf8',
  );
  const fakeBin = await mkdtemp(join(tmpdir(), 'codex-orchestrator-fake-bin-'));
  const fakeGh = join(fakeBin, 'gh');
  await writeFile(fakeGh, '#!/bin/sh\nprintf \'[]\'\n', 'utf8');
  await chmod(fakeGh, 0o755);

  const result = await runCli(['daemon', '--target', targetRoot, '--once'], {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /codex-orchestrator daemon/);
  assert.match(result.stdout, /intervalMs: 300000/);
  assert.match(result.stdout, /no eligible issues/);
});
