import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';

import { runMissionProcess } from '../src/runner/mission-process-executor.js';

test('mission process receives no credential canary from its environment', async () => {
  const result = await runMissionProcess({
    file: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
    timeoutMs: 2_000,
    sourceEnv: {
      PATH: process.env.PATH,
      LANG: 'C',
      GH_TOKEN: 'credential-canary',
      OPENAI_API_KEY: 'credential-canary',
    },
    allowedEnvKeys: ['PATH', 'LANG', 'GH_TOKEN', 'OPENAI_API_KEY'],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.termination, 'exited');
  assert.doesNotMatch(result.stdout, /credential-canary/);
});

test('mission process timeout terminates its inherited process-group child', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Mission executor capability probe rejects Windows in v1.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'mission-process-group-'));
  const script = join(root, 'daemon.mjs');
  const descendantToken = `mission-process-descendant-${process.pid}-${Date.now()}`;
  await writeFile(script, [
    "import { spawn } from 'node:child_process';",
    `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(descendantToken)}], { stdio: 'ignore' });`,
    'console.log(child.pid);',
    'setInterval(() => {}, 1000);',
  ].join('\n'), 'utf8');

  const result = await runMissionProcess({
    file: process.execPath,
    args: [script],
    timeoutMs: 2_000,
    sourceEnv: { PATH: process.env.PATH },
    allowedEnvKeys: ['PATH'],
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.termination, 'timeout');
  const childPid = Number(result.stdout.trim());
  assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true);
  assert.equal(
    await waitForProcessExit(childPid, descendantToken, 2_000),
    true,
    describeProcess(childPid),
  );
});

test('mission process reports process-group termination errors through its promise', async () => {
  await assert.rejects(runMissionProcess({
    file: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 50,
    sourceEnv: { PATH: process.env.PATH },
    allowedEnvKeys: ['PATH'],
  }, {
    terminateProcessGroup: () => {
      throw new Error('kill denied');
    },
  }), /failed to terminate process group: kill denied/);
});

test('mission process settles even when both termination mechanisms fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-process-unreconciled-'));
  const pidPath = join(root, 'pid');
  const script = join(root, 'hang.mjs');
  await writeFile(script, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'), 'utf8');

  await assert.rejects(runMissionProcess({
    file: process.execPath,
    args: [script],
    timeoutMs: 50,
    sourceEnv: { PATH: process.env.PATH },
    allowedEnvKeys: ['PATH'],
  }, {
    terminateProcessGroup: () => { throw new Error('group kill denied'); },
    terminateChild: () => { throw new Error('child kill denied'); },
  }), /failed to terminate process group/);
  const pid = Number(await readFile(pidPath, 'utf8'));
  process.kill(pid, 'SIGKILL');
});

test('mission process bounds combined output and terminates the process group on overflow', async () => {
  const result = await runMissionProcess({
    file: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(10000)); setInterval(() => {}, 1000)'],
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
    sourceEnv: { PATH: process.env.PATH },
    allowedEnvKeys: ['PATH'],
  });
  assert.equal(result.termination, 'output-limit');
  assert.equal(result.exitCode, 125);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1_024, true);
});

test('mission process reports early stdin closure without an unhandled EPIPE', async () => {
  await assert.rejects(runMissionProcess({
    file: '/usr/bin/true',
    args: [],
    timeoutMs: 5_000,
    sourceEnv: { PATH: process.env.PATH },
    allowedEnvKeys: ['PATH'],
    stdin: 'x'.repeat(8 * 1024 * 1024),
  }), /Mission process (?:stdin failed|failed to terminate process group)/);
});

test('stdin failure still reports failed process-group reconciliation', async () => {
  await assert.rejects(runMissionProcess({
    file: '/usr/bin/true',
    args: [],
    timeoutMs: 5_000,
    sourceEnv: { PATH: process.env.PATH },
    allowedEnvKeys: ['PATH'],
    stdin: 'x'.repeat(8 * 1024 * 1024),
  }, {
    terminateProcessGroup: () => { throw new Error('group reconciliation denied'); },
  }), /failed to terminate process group: group reconciliation denied/);
});

async function waitForProcessExit(
  pid: number,
  expectedCommandToken: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid, expectedCommandToken)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function processExists(pid: number, expectedCommandToken: string): boolean {
  try {
    process.kill(pid, 0);
    try {
      const processRecord = execFileSync('/bin/ps', ['-o', 'stat=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return !processRecord.startsWith('Z') && processRecord.includes(expectedCommandToken);
    } catch {
      return true;
    }
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function describeProcess(pid: number): string {
  try {
    return execFileSync('/bin/ps', ['-o', 'pid=,ppid=,pgid=,stat=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return `process ${pid} absent`;
  }
}
