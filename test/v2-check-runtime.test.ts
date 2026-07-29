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
      50,
    ),
    /exceeded 50ms/u,
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
