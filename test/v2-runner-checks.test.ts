import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runConfiguredChecks, buildHostCheckEnvironment } from '../src/v2/runner-checks.js';
import { sha256 } from '../src/v2/containment.js';

test('trusted checks inherit the full runtime environment including database and credential variables', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-checks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'worktree');
  const home = join(root, 'ordinary-user-home');
  await mkdir(workspace); await mkdir(home);
  const command = `printf cache > "$HOME/engine.stamp"; test "$GITHUB_TOKEN" = fixture-token && test "$SSH_AUTH_SOCK" = /fixture/socket && test "$MONGODB_URI" = mongodb://fixture.invalid/test && test "$DB_NAME" = test_fixture && test "$CUSTOM_FLAG" = enabled && pwd`;
  const results = await runConfiguredChecks({ checks: { sdk: command }, worktreePath: workspace,
    logRoot: join(root, 'logs'), timeoutMs: 5000, signal: new AbortController().signal,
    env: { ...process.env, HOME: home, GITHUB_TOKEN: 'fixture-token', SSH_AUTH_SOCK: '/fixture/socket',
      MONGODB_URI: 'mongodb://fixture.invalid/test', DB_NAME: 'test_fixture', CUSTOM_FLAG: 'enabled' } });
  assert.equal(results[0]!.exitCode, 0);
  assert.equal(await readFile(join(home, 'engine.stamp'), 'utf8'), 'cache');
  const log = await readFile(results[0]!.logPath, 'utf8');
  assert.equal(log.trim(), workspace.replace('/var/', '/private/var/'));
  assert.equal(results[0]!.outputSha256, sha256(log));
  assert.deepEqual(buildHostCheckEnvironment({ HOME: home, GH_TOKEN: 'fixture-token', UNSET: undefined }),
    { HOME: home, GH_TOKEN: 'fixture-token' });
});

test('failed configured check retains stdout and stderr and prevents dependent commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-checks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = await runConfiguredChecks({ checks: {
    prepare: 'printf ready', test: 'printf failure >&2; exit 9', later: 'exit 0',
  }, worktreePath: root, logRoot: join(root, 'logs'), timeoutMs: 5000,
    signal: new AbortController().signal, env: process.env });
  assert.deepEqual(results.map(r => [r.id, r.exitCode]), [['prepare', 0], ['test', 9]]);
  assert.equal(await readFile(results[1]!.logPath, 'utf8'), 'failure');
});

test('host check timeout cleans its process group before returning', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-checks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = await runConfiguredChecks({ checks: { hanging: 'sleep 30 & wait' }, worktreePath: root,
    logRoot: join(root, 'logs'), timeoutMs: 100, signal: new AbortController().signal, env: process.env });
  assert.equal(results[0]!.exitCode, 124);
  assert.match(await readFile(results[0]!.logPath, 'utf8'), /timed out/);
});


test('output-limit failure retains diagnostic output and produces no passing receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-checks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = await runConfiguredChecks({ checks: { verbose:
    `'${process.execPath}' -e 'process.stdout.write("prefix\\n");process.stdout.write(Buffer.alloc(65*1024*1024,120))'` },
    worktreePath: root, logRoot: join(root, 'logs'), timeoutMs: 10000,
    signal: new AbortController().signal, env: process.env });
  assert.equal(results[0]!.exitCode, 1);
  const log = await readFile(results[0]!.logPath, 'utf8');
  assert.match(log.slice(0, 20), /^prefix/);
  assert.match(log.slice(-400), /check did not complete; retained output may be incomplete/);
  assert.equal(results[0]!.outputSha256, sha256(log));
});

test('durable baseline evidence rejects malformed or affected failure exceptions', async () => {
  const { validateRunnerChecks } = await import('../src/v2/runner-checks.js');
  const baseline = { baseSha: 'a'.repeat(40), logPath: '/private/base.log', outputSha256: sha256('base'),
    affectedTests: ['test/feature_test.dart'], failures: [{ test: 'test/other_test.dart :: old failure', errorSha256: sha256('failure') }] };
  const result = { id: 'test', command: 'flutter test --no-pub', exitCode: 1, outputSha256: sha256('candidate'), logPath: '/private/candidate.log', baseline };
  const state = { status: 'complete', sourceSha256: sha256('source'), policySha256: sha256('policy'), results: [result] };
  assert.doesNotThrow(() => validateRunnerChecks(state));
  for (const change of [
    { affectedTests: [] }, { baseSha: 'not-a-commit' }, { outputSha256: 'bad' },
    { affectedTests: ['test/../feature_test.dart'] }, { logPath: result.logPath },
    { failures: [{ test: 'test/feature_test.dart :: related failure', errorSha256: sha256('failure') }] },
    { unknown: true },
  ]) {
    assert.throws(() => validateRunnerChecks({ ...state, results: [{ ...result, baseline: { ...baseline, ...change } }] }), /baseline/);
  }
  assert.throws(() => validateRunnerChecks({ ...state, results: [{ ...result, command: 'npm test' }] }), /baseline/);
});
