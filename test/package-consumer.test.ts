import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('packed consumer doctor uses package skills despite conflicting skills and no Python', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-packed-consumer-'));
  const packDir = join(root, 'pack');
  const consumer = join(root, 'consumer');
  const installed = join(consumer, 'node_modules', 'codex-orchestrator');
  const fakeBin = join(root, 'bin');
  const home = join(root, 'home');
  const remote = join(root, 'origin.git');
  const pythonMarker = join(root, 'python-invoked');
  await Promise.all([
    mkdir(packDir, { recursive: true }),
    mkdir(installed, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(join(home, '.codex', 'skills', 'to-spec'), { recursive: true }),
    mkdir(join(consumer, '.codex', 'skills', 'to-spec'), { recursive: true }),
  ]);

  await writeFile(join(home, '.codex', 'skills', 'to-spec', 'SKILL.md'), 'CONFLICTING USER SKILL\n', 'utf8');
  await writeFile(join(consumer, '.codex', 'skills', 'to-spec', 'SKILL.md'), 'CONFLICTING REPO SKILL\n', 'utf8');
  const pythonTrap = '#!/bin/sh\nprintf invoked > "' + pythonMarker + '"\nexit 99\n';
  const labels = [
    'agent:auto', 'agent:plan-auto', 'agent:running', 'agent:blocked',
    'agent:manual', 'agent:review', 'agent:child',
  ].map((name) => ({ name, color: '000000', description: 'fixture' }));
  await writeFile(join(fakeBin, 'python'), pythonTrap, 'utf8');
  await writeFile(join(fakeBin, 'python3'), pythonTrap, 'utf8');
  await writeFile(join(fakeBin, 'codex'), '#!/bin/sh\nexit 0\n', 'utf8');
  await writeFile(
    join(fakeBin, 'gh'),
    "#!/bin/sh\nprintf '%s' '" + JSON.stringify(labels) + "'\n",
    'utf8',
  );
  await Promise.all(['python', 'python3', 'codex', 'gh'].map((name) => chmod(join(fakeBin, name), 0o755)));

  const { stdout: packOutput } = await execFileAsync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
    { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 },
  );
  const tarballName = (JSON.parse(packOutput) as Array<{ filename: string }>)[0]?.filename;
  assert.ok(tarballName);
  await execFileAsync('tar', ['-xzf', join(packDir, tarballName), '--strip-components=1', '-C', installed]);
  await symlink(join(process.cwd(), 'node_modules', 'playwright-core'), join(consumer, 'node_modules', 'playwright-core'));

  await execFileAsync('git', ['init', '--bare', remote]);
  await execFileAsync('git', ['init', '-b', 'main', consumer]);
  await execFileAsync('git', ['-C', consumer, 'config', 'user.name', 'Tarball Test']);
  await execFileAsync('git', ['-C', consumer, 'config', 'user.email', 'tarball@example.com']);
  await writeFile(join(consumer, 'README.md'), '# consumer\n', 'utf8');
  await execFileAsync('git', ['-C', consumer, 'add', 'README.md']);
  await execFileAsync('git', ['-C', consumer, 'commit', '-m', 'Initial']);
  await execFileAsync('git', ['-C', consumer, 'remote', 'add', 'origin', remote]);
  await execFileAsync('git', ['-C', consumer, 'push', '-u', 'origin', 'main']);

  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    CODEX_ORCHESTRATOR_HOME: join(home, '.codex-orchestrator'),
    PATH: fakeBin + ':/usr/bin:/bin:/usr/sbin:/sbin',
  };
  const cli = join(installed, 'dist', 'src', 'cli.js');
  await execFileAsync(process.execPath, [
    cli,
    'setup',
    '--target',
    consumer,
    '--github-owner',
    'fixture',
    '--github-repo',
    'consumer',
  ], { cwd: consumer, env, maxBuffer: 20 * 1024 * 1024 });
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    'doctor',
    '--target',
    consumer,
    '--json',
  ], { cwd: consumer, env, maxBuffer: 20 * 1024 * 1024 });
  const doctor = JSON.parse(stdout) as {
    pass: Array<{ id: string; summary: string }>;
    fail: Array<{ id: string; summary: string }>;
  };
  const installedManifest = JSON.parse(
    await readFile(join(installed, 'runtime-skills', 'bundle.json'), 'utf8'),
  ) as { bundleHash: string };

  assert.equal(doctor.fail.some((check) => check.id === 'config' || check.id === 'skill-runtime-v2'), false);
  assert.match(
    doctor.pass.find((check) => check.id === 'skill-runtime-v2')?.summary ?? '',
    new RegExp(installedManifest.bundleHash, 'u'),
  );
  await assert.rejects(readFile(pythonMarker, 'utf8'), /ENOENT/);
});
