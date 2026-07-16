import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertCodexVersion, preparePackageRuntimeHome } from '../src/codex/package-runtime-home.js';
import { AppServerProcessOwner } from '../src/codex/app-server-process.js';

test('package runtime home is private, isolated, and strips ambient credentials', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orchestrator-home-'));
  const runtime = await preparePackageRuntimeHome({ runId: 'run-1', orchestratorHome: base, sourceEnv: { PATH: process.env.PATH, LANG: 'C' } });
  assert.equal((await lstat(runtime.root)).mode & 0o777, 0o700);
  assert.equal((await lstat(runtime.sqliteHome)).mode & 0o777, 0o700);
  assert.equal(runtime.env.HOME, runtime.root);
  assert.equal('GH_TOKEN' in runtime.env, false);
});

test('package runtime home rejects symlinks and unsupported ambient auth', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orchestrator-home-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'orchestrator-home-outside-'));
  await symlink(outside, join(base, 'codex-home'));
  await assert.rejects(preparePackageRuntimeHome({ runId: 'run-1', orchestratorHome: base, sourceEnv: {} }), /unsafe/);
  await assert.rejects(preparePackageRuntimeHome({ runId: 'run-2', orchestratorHome: outside, sourceEnv: { OPENAI_API_KEY: 'secret' } }), /auth-env-unsupported/);
});

test('Codex version gate accepts only the pinned CLI', async () => {
  await assertCodexVersion('codex', '0.144.4', { PATH: process.env.PATH ?? '' });
  await assert.rejects(assertCodexVersion('codex', '0.0.0', { PATH: process.env.PATH ?? '' }), /version-mismatch/);
});

test('persisted auth lease rejects a second owner and releases only after process-group shutdown', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orchestrator-auth-lease-'));
  const runtime = await preparePackageRuntimeHome({ runId: 'run-1', orchestratorHome: base, sourceEnv: { PATH: process.env.PATH } });
  const fakeServer = fileURLToPath(new URL('fixtures/fake-app-server.js', import.meta.url));
  const supervisorPath = fileURLToPath(new URL('../src/codex/app-server-supervisor.js', import.meta.url));
  const owner = await AppServerProcessOwner.start({
    runId: 'run-1', runtimeHome: runtime, command: process.execPath, args: [fakeServer], cwd: runtime.root, supervisorPath,
  });
  const leasePath = join(runtime.root, 'app-server-persisted-auth.lock');
  await access(leasePath);
  await assert.rejects(AppServerProcessOwner.start({
    runId: 'run-2', runtimeHome: runtime, command: process.execPath, args: [fakeServer], cwd: runtime.root, supervisorPath,
  }), /orchestrator-auth-runtime-busy/);
  await owner.close();
  await assert.rejects(access(leasePath));
});

test('account preflight failure terminates the supervised group and releases its lease', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orchestrator-auth-missing-'));
  const runtime = await preparePackageRuntimeHome({ runId: 'run-1', orchestratorHome: base, sourceEnv: { PATH: process.env.PATH } });
  const fakeServer = fileURLToPath(new URL('fixtures/fake-app-server.js', import.meta.url));
  const supervisorPath = fileURLToPath(new URL('../src/codex/app-server-supervisor.js', import.meta.url));
  await assert.rejects(AppServerProcessOwner.start({
    runId: 'run-1', runtimeHome: runtime, command: process.execPath, args: [fakeServer, '--no-account'], cwd: runtime.root, supervisorPath,
  }), /orchestrator-auth-required/);
  await assert.rejects(access(join(runtime.root, 'app-server-persisted-auth.lock')));
});

test('app-server owner close remains retryable after an initial cleanup failure', async () => {
  let closeAttempts = 0;
  const owner = new (AppServerProcessOwner as any)(
    { stdio: [null, null, null, { destroy() {} }] },
    { close() {} },
    {
      async close() {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error('cleanup failed once');
      },
    },
    undefined,
    undefined,
    99_999_999,
  ) as AppServerProcessOwner;

  await assert.rejects(owner.close(), /cleanup failed once/);
  await owner.close();
  await owner.close();

  assert.equal(closeAttempts, 1);
});

test('access-token mode isolates SQLite homes and permits two supervised owners without the persisted-auth lease', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orchestrator-token-auth-'));
  const sourceEnv = { PATH: process.env.PATH, CODEX_ACCESS_TOKEN: 'test-token' };
  const firstRuntime = await preparePackageRuntimeHome({ runId: 'token-run-1', orchestratorHome: base, sourceEnv, allowAccessToken: true });
  const secondRuntime = await preparePackageRuntimeHome({ runId: 'token-run-2', orchestratorHome: base, sourceEnv, allowAccessToken: true });
  const fakeServer = fileURLToPath(new URL('fixtures/fake-app-server.js', import.meta.url));
  const supervisorPath = fileURLToPath(new URL('../src/codex/app-server-supervisor.js', import.meta.url));

  assert.equal(firstRuntime.authMode, 'access-token');
  assert.notEqual(firstRuntime.sqliteHome, secondRuntime.sqliteHome);
  const [firstOwner, secondOwner] = await Promise.all([
    AppServerProcessOwner.start({ runId: 'token-run-1', runtimeHome: firstRuntime, command: process.execPath, args: [fakeServer], cwd: firstRuntime.root, supervisorPath }),
    AppServerProcessOwner.start({ runId: 'token-run-2', runtimeHome: secondRuntime, command: process.execPath, args: [fakeServer], cwd: secondRuntime.root, supervisorPath }),
  ]);
  try {
    await assert.rejects(access(join(firstRuntime.root, 'app-server-persisted-auth.lock')));
  } finally {
    await Promise.all([firstOwner.close(), secondOwner.close()]);
  }
});

test('persisted owner retries only unfinished cleanup stages after its lease was already released', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orchestrator-persisted-close-retry-'));
  const runtime = await preparePackageRuntimeHome({ runId: 'run-close-retry', orchestratorHome: base, sourceEnv: { PATH: process.env.PATH } });
  const fakeServer = fileURLToPath(new URL('fixtures/fake-app-server.js', import.meta.url));
  const supervisorPath = fileURLToPath(new URL('../src/codex/app-server-supervisor.js', import.meta.url));
  const owner = await AppServerProcessOwner.start({
    runId: 'run-close-retry', runtimeHome: runtime, command: process.execPath, args: [fakeServer], cwd: runtime.root, supervisorPath,
  });
  const leasePath = join(runtime.root, 'app-server-persisted-auth.lock');
  let sessionCloseAttempts = 0;
  const originalClose = owner.session.close.bind(owner.session);
  (owner.session as any).close = async () => {
    sessionCloseAttempts += 1;
    if (sessionCloseAttempts === 1) throw new Error('session-cleanup-failed-once');
    await originalClose();
  };

  await assert.rejects(owner.close(), /session-cleanup-failed-once/);
  await assert.rejects(access(leasePath));
  await owner.close();

  assert.equal(sessionCloseAttempts, 1);
});
