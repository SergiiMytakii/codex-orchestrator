import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runShellCheck } from '../src/v2/runtime.js';

test('Jest checks select the immutable change and exclude unrelated failing suites', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-affected-jest-'));
  try {
    await mkdir(join(cwd, 'node_modules/.bin'), { recursive: true });
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src/feature.ts'), 'export const feature = true;');
    await writeFile(join(cwd, 'jest.config.js'), 'module.exports = {};');
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'jest --config jest.config.js' } }));
    // Process-boundary fixture: an unscoped suite fails; the native related-test invocation succeeds.
    await writeFile(join(cwd, 'node_modules/.bin/jest'), `#!/bin/sh
printf "%s\\n" "$@"
case "$*" in
  *--showConfig*) echo observed > config-probe.marker; if [ -f resolved-config.json ]; then cat resolved-config.json; else printf '{"configs":[{}],"globalConfig":{}}'; fi; exit 0;;
  *./src/broken.ts*) exit 1;;
  *./src/uncovered.ts*) case "$*" in *--passWithNoTests=false*) exit 1;; *) exit 0;; esac;;
  *"--findRelatedTests ./src/feature.ts"*) exit 0;;
  *) exit 1;;
esac
`);
    await chmod(join(cwd, 'node_modules/.bin/jest'), 0o700);
    const run = (changedFiles?: string[]) => runShellCheck('npm test', cwd, new AbortController().signal, 5000, undefined, changedFiles);
    assert.equal((await run()).status, 'failed');
    await assert.rejects(runShellCheck('npm test', cwd, new AbortController().signal, 5000,
      async () => { throw new Error('ownership rejected'); }, ['src/feature.ts']), /ownership rejected/u);
    await assert.rejects(readFile(join(cwd, 'config-probe.marker')), 'config probing must wait for persisted launch ownership');
    const affected = await run(['src/feature.ts']);
    assert.equal(affected.status, 'passed');
    assert.match(affected.output.toString(), /--findRelatedTests/u);
    assert.match(affected.output.toString(), /\.\/src\/feature\.ts/u);
    assert.equal(affected.outputSha256, createHash('sha256').update(affected.output).digest('hex'));
    await writeFile(join(cwd, 'src/broken.ts'), 'throw new Error("regression");');
    assert.equal((await run(['src/feature.ts', 'src/broken.ts'])).status, 'failed', 'a related failure remains blocking');
    await writeFile(join(cwd, 'README.md'), 'documentation');
    await writeFile(join(cwd, 'jest.config.js'), 'module.exports = {};');
    assert.equal((await run(['src/feature.ts', 'README.md'])).status, 'passed', 'incidental docs must not restore unrelated blocking');
    await writeFile(join(cwd, 'src/uncovered.ts'), 'export const uncovered = true;');
    assert.equal((await run(['src/uncovered.ts'])).status, 'failed', 'config-based no-tests success cannot waive the check');
    await mkdir(join(cwd, 'test'));
    await writeFile(join(cwd, 'test/bootstrap.js'), 'beforeEach(() => {});');
    await writeFile(join(cwd, 'resolved-config.json'), JSON.stringify({ configs: [{ setupFilesAfterEnv: [join(cwd, 'test/bootstrap.js')] }], globalConfig: {} }));
    const setup = await run(['src/feature.ts', 'test/bootstrap.js']);
    assert.equal(setup.status, 'failed', 'global setup changes can affect suites outside ordinary imports');
    assert.doesNotMatch(setup.output.toString(), /--findRelatedTests/u);
    assert.equal((await run(['src/feature.ts'])).status, 'failed', 'local hook dependencies also require conservative full execution');
    await writeFile(join(cwd, 'resolved-config.json'), JSON.stringify({ configs: [{ snapshotSerializers: [join(cwd, 'test/bootstrap.js')] }], globalConfig: {} }));
    assert.equal((await run(['src/feature.ts'])).status, 'failed', 'local serializers affect suites without import edges');
    await rm(join(cwd, 'resolved-config.json'));
    for (const config of [
      "module.exports = process.env.npm_lifecycle_event === 'test' ? { setupFilesAfterEnv: ['./test/bootstrap.js'] } : {};",
      "module.exports = { globals: require('./src/feature.ts') };",
    ]) {
      await writeFile(join(cwd, 'jest.config.js'), config);
      assert.equal((await run(['src/feature.ts'])).status, 'failed', 'executable config dependencies cannot authorize narrower checks');
    }
    await writeFile(join(cwd, 'jest.config.js'), 'module.exports = {};');
    for (const files of [['jest.config.js'], ['src/deleted.ts'], [], ['../outside.ts']]) {
      const result = await run(files);
      assert.equal(result.status, 'failed', JSON.stringify(files));
      assert.doesNotMatch(result.output.toString(), /--findRelatedTests/u);
    }
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'jest --config jest.config.js', pretest: 'echo prepared' } }));
    const hooked = await run(['src/feature.ts']);
    assert.equal(hooked.status, 'failed', 'npm lifecycle hooks can change effective configuration after the probe');
    assert.doesNotMatch(hooked.output.toString(), /--findRelatedTests/u);
    // Existing filters, custom wrappers and no-tests success flags cannot become a weaker gate.
    for (const script of ['jest --passWithNoTests', 'jest --testPathPattern feature', 'node wrapper.js', 'jest && echo ok']) {
      await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: script } }));
      const result = await run(['src/feature.ts']);
      assert.doesNotMatch(result.output.toString(), /--findRelatedTests/u, script);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('timed-out check proves a TERM-ignoring descendant is absent before returning', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-check-timeout-'));
  const controller = new AbortController();
  await assert.rejects(
    runShellCheck(
      "(trap '' TERM; exec sleep 300) </dev/null >/dev/null 2>&1 & echo $! > child.pid; wait",
      cwd,
      controller.signal,
      5000,
    ),
    /exceeded 5000ms/u,
  );

  const pid = Number((await readFile(join(cwd, 'child.pid'), 'utf8')).trim());
  assert.equal(Number.isSafeInteger(pid) && pid > 0, true);
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ESRCH'
  ));
});

test('cancelled check proves a TERM-ignoring descendant is absent before returning', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-check-cancel-'));
  const controller = new AbortController();
  const check = runShellCheck(
    "(trap '' TERM; exec sleep 300) </dev/null >/dev/null 2>&1 & echo $! > child.pid; wait",
    cwd,
    controller.signal,
    10_000,
  );
  while (true) {
    try { await readFile(join(cwd, 'child.pid'), 'utf8'); break; }
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 10)); }
  }
  controller.abort();
  await check;

  const pid = Number((await readFile(join(cwd, 'child.pid'), 'utf8')).trim());
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ESRCH'
  ));
});

test('normal leader exit reports a live descendant process group instead of quiescence', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-check-live-descendant-'));
  let processGroupId: number | undefined;
  try {
    const result = await runShellCheck(
      "(trap '' HUP TERM; exec sleep 300) </dev/null >/dev/null 2>&1 & echo $! > child.pid",
      cwd,
      new AbortController().signal,
      10_000,
      async (launched) => { processGroupId = launched.processGroupId; },
    );

    assert.deepEqual(
      (result as { observation?: unknown }).observation,
      { leader: 'absent', group: 'live' },
    );
  } finally {
    if (processGroupId !== undefined) {
      try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* already absent */ }
    }
  }
});

test('check command cannot execute before launched ownership persistence resolves', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-check-launch-gate-'));
  let release!: () => void;
  const launched = new Promise<void>((resolve) => { release = resolve; });
  const check = runShellCheck('printf executed > marker.txt', cwd, new AbortController().signal, 10_000, async () => launched);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(readFile(join(cwd, 'marker.txt')));
  release();
  assert.equal((await check).status, 'passed');
  assert.equal(await readFile(join(cwd, 'marker.txt'), 'utf8'), 'executed');
});

test('rejected launched ownership persistence terminates the gated check without executing it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-check-launch-reject-'));
  await assert.rejects(runShellCheck(
    'printf executed > marker.txt', cwd, new AbortController().signal, 10_000,
    async () => { throw new Error('state CAS rejected'); },
  ), /state CAS rejected/u);
  await assert.rejects(readFile(join(cwd, 'marker.txt')));
});

/** A new materialization receives package resolution before its --no-pub check. */
test('Flutter checks initialize dependencies in the exact checked working directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-flutter-check-'));
  const flutter = join(cwd, 'flutter');
  try {
    await writeFile(flutter, '#!/bin/sh\nif [ "$1" = pub ]; then mkdir -p .dart_tool; echo prepared > .dart_tool/package_config.json; exit 0; fi\n[ -f .dart_tool/package_config.json ] || exit 23\nprintf "checked:%s:%s" "$PWD" "$*"\n');
    await chmod(flutter, 0o700);
    const result = await runShellCheck(flutter + ' analyze --no-pub', cwd, new AbortController().signal, 5000);
    assert.equal(result.status, 'passed');
    assert.match(result.output.toString(), /checked:.*:analyze/);
    assert.equal(await readFile(join(cwd, '.dart_tool/package_config.json'), 'utf8'), 'prepared\n');
    const focused = await runShellCheck(flutter + ' test --no-pub test/a_test.dart', cwd, new AbortController().signal, 5000);
    assert.equal(focused.status, 'passed');
    assert.match(focused.output.toString(), /test --no-pub test\/a_test\.dart/u);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

/** Missing executable is an environment failure, never a product test failure. */
test('Flutter verification rejects an unavailable SDK environment before executing checks', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-flutter-unavailable-'));
  try {
    const flutter = join(cwd, 'flutter');
    await writeFile(flutter, '#!/bin/sh\necho should-not-run > marker\n');
    for (const command of ['analyze --no-pub', 'test --no-pub test/a_test.dart']) {
      await assert.rejects(runShellCheck(flutter + ' ' + command, cwd, new AbortController().signal, 5000), /Flutter verification environment/u);
    }
    await assert.rejects(readFile(join(cwd, 'marker')));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('host checks distinguish unavailable executables from ordinary check failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'configured-check-env-'));
  try {
    const tool = join(root, 'not-executable');
    await writeFile(tool, '#!/bin/sh\nexit 0\n');
    await chmod(tool, 0o600);
    for (const [command, expected] of [
      [join(root, 'missing-tool'), 'unavailable'],
      [tool, 'unavailable'],
      ['exit 1', 'failed'],
      ['exit 0', 'passed'],
    ] as const) {
      const result = await runShellCheck(command, root, new AbortController().signal, 5_000);
      assert.equal(result.status, expected, command);
      assert.equal(result.observation.group, 'absent');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('large passed and failed check logs hash the exact retained bytes with explicit truncation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-check-large-output-'));
  try {
    for (const size of [1_048_575, 1_048_576, 1_048_577]) {
      for (const exitCode of [0, 1]) {
        const result = await runShellCheck(
          `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.alloc(${size}, 120)); process.exitCode=${exitCode}'`,
          cwd, new AbortController().signal, 5000,
        );
        assert.equal(result.status, exitCode === 0 ? 'passed' : 'failed');
        assert.equal(result.outputSha256, createHash('sha256').update(result.output).digest('hex'));
        assert.equal(result.output.toString().includes('[diagnostic output truncated]'), size > 1_048_576);
      }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('check launch persistence that never settles returns within its command deadline', { timeout: 3000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-check-hung-launch-'));
  const started = Date.now();
  try {
    await assert.rejects(runShellCheck('echo unsafe > marker', cwd, new AbortController().signal, 100,
      async () => new Promise<void>(() => {})), /exceeded 100ms/u);
    assert.ok(Date.now() - started < 3000);
    await assert.rejects(readFile(join(cwd, 'marker')));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
