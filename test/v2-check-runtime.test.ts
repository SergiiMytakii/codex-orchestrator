import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runShellCheck } from '../src/v2/runtime.js';

test('timed-out check proves a TERM-ignoring descendant is absent before returning', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-check-timeout-'));
  const controller = new AbortController();
  await assert.rejects(
    runShellCheck(
      "(trap '' TERM; exec sleep 300) </dev/null >/dev/null 2>&1 & echo $! > child.pid; wait",
      cwd,
      controller.signal,
      250,
    ),
    /exceeded 250ms/u,
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
