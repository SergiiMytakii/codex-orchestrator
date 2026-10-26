import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { createProductionSetup } from '../src/v2/setup-runtime.js';
import { acquireOwnerControlLock } from '../src/v2/owner-control-lock.js';

const execFileAsync = promisify(execFile);

test('production Setup composition always derives the base branch from origin/HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-setup-runtime-'));
  const targetRoot = join(root, 'target');
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main', targetRoot]);
    await writeFile(join(targetRoot, 'package.json'), '{"private":true,"scripts":{"test":"node --test"}}\n');
    await execFileAsync('git', ['-C', targetRoot, 'add', 'package.json']);
    await execFileAsync('git', ['-C', targetRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', 'git@github.com:ExampleOwner/example-repo.git']);
    await execFileAsync('git', ['-C', targetRoot, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await execFileAsync('git', ['-C', targetRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    await execFileAsync('git', ['-C', targetRoot, 'update-ref', 'refs/remotes/origin/dev', 'HEAD']);
    await execFileAsync('git', ['-C', targetRoot, 'switch', '-c', 'dev']);
    await execFileAsync('git', ['-C', targetRoot, 'branch', '--set-upstream-to', 'origin/dev', 'dev']);

    const setup = createProductionSetup({ orchestratorHome: join(root, 'home'), bootId: 'boot-fixture' });
    assert.deepEqual(await setup.execute({ targetRoot, operation: 'configure', dryRun: false }), { status: 'created' });
    const config = JSON.parse(await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
    assert.deepEqual({ owner: config.github.owner, repo: config.github.repo, baseBranch: config.github.baseBranch }, {
      owner: 'ExampleOwner', repo: 'example-repo', baseBranch: 'main',
    });
    assert.deepEqual(config.checks, { test: 'npm test' });
    assert.deepEqual(await setup.execute({ targetRoot, operation: 'configure', dryRun: false }), { status: 'unchanged' });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('production setup validates the installed Flutter SDK and creates executable checks with quoted paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sdk-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetRoot = join(root, 'target');
  await execFileAsync('git', ['init', '-q', '-b', 'main', targetRoot]);
  await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', 'git@github.com:ExampleOwner/example-repo.git']);
  await execFileAsync('git', ['-C', targetRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  const flutterSdk = join(root, "Flutter SDK's stable $dir");
  const executable = join(flutterSdk, 'bin', 'flutter');
  await mkdir(join(flutterSdk, 'bin'), { recursive: true });
  await writeFile(executable, `#!/bin/sh\nif [ \"$1\" = --version ] && [ \"$GH_TOKEN\" != fixture-inherited-by-sdk ]; then exit 19; fi\nprintf '%s\\n' \"$*\" >> \"$0.calls\"\n`);
  await chmod(executable, 0o755);
  const setup = createProductionSetup({ orchestratorHome: join(root, 'home'), bootId: 'boot-fixture' });
  const credentialKeys = ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'npm_config_userconfig'];
  const saved = Object.fromEntries(credentialKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of credentialKeys) process.env[key] = 'fixture-inherited-by-sdk';
    assert.deepEqual(await setup.execute({ targetRoot, flutterSdk, operation: 'configure', dryRun: false }), { status: 'created' });
  } finally {
    for (const key of credentialKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  const configPath = join(targetRoot, '.codex-orchestrator', 'config.json');
  const bytes = await readFile(configPath, 'utf8');
  const config = JSON.parse(bytes);
  assert.equal(config.runner.checkExecution, 'host');
  assert.deepEqual(Object.keys(config.checks), ['flutter-pub-get', 'flutter-analyze', 'flutter-test']);
  for (const name of ['flutter-pub-get', 'flutter-analyze', 'flutter-test']) {
    await execFileAsync('/bin/sh', ['-c', config.checks[name]], { cwd: targetRoot });
  }
  assert.equal(await readFile(`${executable}.calls`, 'utf8'), '--version\npub get --enforce-lockfile\nanalyze --no-pub --no-fatal-infos\ntest --no-pub\n');
  assert.deepEqual(await setup.execute({ targetRoot, flutterSdk: '/missing/sdk', operation: 'configure', dryRun: false }), { status: 'unchanged' });
  assert.equal(await readFile(configPath, 'utf8'), bytes);
});

test('Flutter setup rejects missing, non-executable, and failing SDKs before local writes', async (t) => {
  for (const scenario of ['missing', 'not-executable', 'version-failed'] as const) {
    await t.test(scenario, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'codex-invalid-sdk-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const targetRoot = join(root, 'target');
      await execFileAsync('git', ['init', '-q', '-b', 'main', targetRoot]);
      await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', 'git@github.com:ExampleOwner/example-repo.git']);
      await execFileAsync('git', ['-C', targetRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
      const flutterSdk = join(root, 'sdk');
      if (scenario !== 'missing') {
        await mkdir(join(flutterSdk, 'bin'), { recursive: true });
        await writeFile(join(flutterSdk, 'bin', 'flutter'), '#!/bin/sh\nexit 1\n', { mode: scenario === 'version-failed' ? 0o755 : 0o644 });
      }
      const result = await createProductionSetup({ orchestratorHome: join(root, 'home'), bootId: 'fixture' }).execute({
        targetRoot, flutterSdk, operation: 'configure', dryRun: false,
      });
      assert.equal(result.status, 'io-failed');
      if (result.status === 'io-failed') {
        assert.equal(result.detail.code, 'flutter-sdk');
        assert.match(result.detail.summary, scenario === 'version-failed' ? /--version must succeed/u : /executable bin\/flutter/u);
      }
      await assert.rejects(stat(join(targetRoot, '.codex-orchestrator')), { code: 'ENOENT' });
      await assert.rejects(stat(join(targetRoot, '.gitignore')), { code: 'ENOENT' });
      await assert.rejects(stat(join(root, 'home')), { code: 'ENOENT' });
    });
  }
});

test('Flutter dry-run does not execute the SDK or create target or SDK cache files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sdk-dry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetRoot = join(root, 'target');
  await execFileAsync('git', ['init', '-q', '-b', 'main', targetRoot]);
  await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', 'git@github.com:ExampleOwner/example-repo.git']);
  await execFileAsync('git', ['-C', targetRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  const flutterSdk = join(root, 'sdk');
  const executable = join(flutterSdk, 'bin', 'flutter');
  await mkdir(join(flutterSdk, 'bin'), { recursive: true });
  await writeFile(executable, '#!/bin/sh\ntouch "$0.cache"\nexit 1\n', { mode: 0o755 });
  const setup = createProductionSetup({ orchestratorHome: join(root, 'home'), bootId: 'fixture' });
  const result = await setup.execute({ targetRoot, flutterSdk, operation: 'configure', dryRun: true });
  assert.equal(result.status, 'planned');
  await assert.rejects(stat(`${executable}.cache`), { code: 'ENOENT' });
  await assert.rejects(stat(join(targetRoot, '.codex-orchestrator')), { code: 'ENOENT' });
  await assert.rejects(stat(join(targetRoot, '.gitignore')), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, 'home')), { code: 'ENOENT' });
});
