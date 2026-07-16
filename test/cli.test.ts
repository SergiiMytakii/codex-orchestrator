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
  assert.match(result.stdout, /auth login/);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /daemon/);
  assert.match(result.stdout, /acceptance-proof/);
  assert.match(result.stdout, /agent:auto/);
  assert.match(result.stdout, /agent:plan-auto/);
  assert.match(result.stdout, /--prepare-labels/);
  assert.match(result.stdout, /--prepare-skill-runtime-v2/);
  assert.doesNotMatch(result.stdout, /--sync-prompts/);
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

test('acceptance-proof validate reports proof report shape errors', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cli-acceptance-proof-'));
  const invalidReportPath = join(tempDir, 'invalid-report.json');
  const validReportPath = join(tempDir, 'valid-report.json');
  await writeFile(invalidReportPath, JSON.stringify({
    status: 'passed',
    criteria: [{
      id: 'ac-1',
      status: 'passed',
      confidence: 'high',
    }],
  }), 'utf8');
  await writeFile(validReportPath, JSON.stringify({
    status: 'passed',
    criteria: [{
      id: 'ac-1',
      description: 'CLI behavior is observable.',
      status: 'passed',
      confidence: 'high',
      reasoningSummary: 'Smoke output proves the behavior.',
      artifactRefs: ['.codex-orchestrator/proofs/issue-1/smoke-output.txt'],
    }],
    artifacts: [{
      type: 'smoke-output',
      path: '.codex-orchestrator/proofs/issue-1/smoke-output.txt',
      description: 'smoke output',
    }],
    proofPhaseDiff: {
      allowedProofPaths: ['.codex-orchestrator/proofs/issue-1/smoke-output.txt'],
      forbiddenProductPaths: [],
    },
    residualRisks: [],
  }), 'utf8');

  const missingArg = await runCli(['acceptance-proof', 'validate']);
  assert.equal(missingArg.status, 2);
  assert.match(missingArg.stderr, /acceptance-proof validate requires --report <path>/);

  const invalid = await runCli(['acceptance-proof', 'validate', '--report', invalidReportPath]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /criteria\[0\]\.description must be a non-empty string/);
  assert.match(invalid.stderr, /criteria\[0\]\.reasoningSummary must be a non-empty string/);
  assert.match(invalid.stderr, /criteria\[0\]\.artifactRefs must be a string array/);
  assert.match(invalid.stderr, /artifacts must be an array/);

  const valid = await runCli(['acceptance-proof', 'validate', '--report', validReportPath]);
  assert.equal(valid.status, 0);
  assert.equal(valid.stderr, '');
  assert.equal(valid.stdout, 'acceptance proof report shape valid\n');
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
  assert.match(result.stdout, /skill runtime: package-owned v2/);
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

test('setup parses the skill-runtime-v2 preparation mode and rejects dry-run ambiguity', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cli-prepare-v2-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator/config.json'),
    `${JSON.stringify(validConfig, null, 2)}\n`,
    'utf8',
  );
  const result = await runCli(['setup', '--target', targetRoot, '--prepare-skill-runtime-v2', '--dry-run']);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /setup --prepare-skill-runtime-v2 cannot be combined with --dry-run/);
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

test('visual-proof auto reads config from --target instead of process cwd', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cli-proof-target-'));
  const unrelatedCwd = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cli-proof-cwd-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    `${JSON.stringify(validConfig, null, 2)}\n`,
    'utf8',
  );

  const result = await runCli(
    ['visual-proof', 'auto', '--issue', '887', '--target', targetRoot],
    {
      ...process.env,
      CODEX_ORCHESTRATOR_CHANGED_FILES: 'src/frontend/App.tsx',
      CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Frontend UI proof',
      CODEX_ORCHESTRATOR_ISSUE_BODY: 'Web layout proof',
    },
    unrelatedCwd,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /auto visual proof selected browser/);
  assert.match(
    await readFile(join(targetRoot, '.codex-orchestrator', 'proofs', 'issue-887', 'acceptance-proof-report.json'), 'utf8'),
    /Browser proof scenario file was not found/,
  );
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

test('daemon refuses bridge config v1 before issue discovery', async () => {
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

  assert.equal(result.status, 1);
  assert.match(result.stderr, /orchestrator-skill-runtime-v2-required/);
  assert.equal(result.stdout, '');
});
