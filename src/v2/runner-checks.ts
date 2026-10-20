import { mkdir } from 'node:fs/promises';
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { canonicalJson, sha256 } from './containment.js';
import { CommandProcessQuiescenceError, defaultProcessExecutor, type ProcessExecutor } from './adapters/command.js';

export interface RunnerCheckResult {
  id: string;
  command: string;
  exitCode: number;
  outputSha256: string;
  logPath: string;
}

export interface RunnerChecks {
  status: 'pending' | 'complete';
  sourceSha256: string;
  policySha256: string;
  results: RunnerCheckResult[];
}

/** Preserve ordinary local SDK/cache locations without publication credentials. */
export function buildHostCheckEnvironment(parent: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CI',
    'PUB_CACHE', 'FLUTTER_ROOT', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME',
    'DEVELOPER_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'SystemRoot', 'ComSpec', 'PATHEXT'];
  return Object.fromEntries(allowed.flatMap(key => parent[key] === undefined ? [] : [[key, parent[key]!]]));
}

/** Execution order is part of the configured host-check policy. */
export function runnerCheckPolicySha256(checks: Record<string, string>): string {
  return sha256(canonicalJson(Object.entries(checks)));
}

/** Execute only trusted configured commands, stopping at the first failure. */
export async function runConfiguredChecks(input: {
  checks: Record<string, string>;
  worktreePath: string;
  logRoot: string;
  timeoutMs: number;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  executor?: ProcessExecutor;
}): Promise<RunnerCheckResult[]> {
  await mkdir(input.logRoot, { recursive: true, mode: 0o700 });
  const results: RunnerCheckResult[] = [];
  for (const [id, command] of Object.entries(input.checks)) {
    if (input.signal.aborted) throw new Error('Configured checks cancelled before launch.');
    const logPath = join(input.logRoot, `${results.length}.log`);
    const fd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256');
    const capture = (bytes: Buffer) => {
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset);
        if (!written) throw new Error('Check log write made no progress.');
        offset += written;
      }
      hash.update(bytes);
    };
    let exitCode: number;
    try {
      const result = await (input.executor ?? defaultProcessExecutor)('/bin/sh', ['-c', command], {
        cwd: input.worktreePath, env: buildHostCheckEnvironment(input.env),
        timeoutMs: input.timeoutMs, signal: input.signal, processGroup: true, maxOutputBytes: 64 * 1024 * 1024,
        onStdoutBytes: capture, onStderrBytes: capture,
      });
      exitCode = result.exitCode;
      if (result.exitCode === 124 || result.exitCode === 130) capture(Buffer.from(`\nRunner: ${result.exitCode === 124 ? 'command timed out' : 'command cancelled'}.\n`));
    } catch (error) {
      // An unresolved owned group remains fenced; a model cannot admit its output.
      if (error instanceof CommandProcessQuiescenceError) throw error;
      capture(Buffer.from(`\nRunner: check did not complete; retained output may be incomplete. ${error instanceof Error ? error.message : 'Command execution failed.'}\n`));
      exitCode = 1;
    } finally { try { fsyncSync(fd); } finally { closeSync(fd); } }
    results.push({ id, command, exitCode, outputSha256: hash.digest('hex'), logPath });
    if (exitCode !== 0) break;
  }
  return results;
}

/** Reject incomplete or malformed durable host evidence before recovery. */
export function validateRunnerChecks(value: unknown): asserts value is RunnerChecks {
  if (!value || typeof value !== 'object') throw new Error('runnerChecks is invalid');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'policySha256,results,sourceSha256,status'
    || !['pending', 'complete'].includes(r.status as string)
    || !/^[0-9a-f]{64}$/.test(r.sourceSha256 as string)
    || !/^[0-9a-f]{64}$/.test(r.policySha256 as string)
    || !Array.isArray(r.results) || r.results.length > 256) throw new Error('runnerChecks is invalid');
  const ids = new Set();
  for (const result of r.results) {
    if (!result || typeof result !== 'object'
      || Object.keys(result).sort().join(',') !== 'command,exitCode,id,logPath,outputSha256'
      || typeof result.id !== 'string' || !result.id || ids.has(result.id)
      || typeof result.command !== 'string' || !result.command
      || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255
      || typeof result.logPath !== 'string' || !result.logPath.startsWith('/')
      || !/^[0-9a-f]{64}$/.test(result.outputSha256)) throw new Error('runnerChecks result is invalid');
    ids.add(result.id);
  }
  if (r.status === 'pending' && r.results.length) throw new Error('pending runnerChecks cannot contain results');
}
