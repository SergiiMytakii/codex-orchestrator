import { mkdir } from 'node:fs/promises';
import { closeSync, constants, fsyncSync, openSync, writeSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { confirmFlutterBaseline, flutterTestCommand } from './flutter-host-checks.js';

import { jestCommand, npmTestScript } from './jest-command.js';
import { confirmJestBaseline, jestEvidencePath, validJestDiagnostic, type JestBaselineEvidence, type JestDiagnostic } from './jest-host-checks.js';

import { canonicalJson, sha256 } from './containment.js';
import { CommandProcessQuiescenceError, defaultProcessExecutor, type ProcessExecutor } from './adapters/command.js';

export interface TestBaselineEvidence {
  baseSha: string;
  logPath: string;
  outputSha256: string;
  affectedTests: string[];
  failures: Array<{ test: string; errorSha256: string }>;
}

export interface RunnerCheckResult {
  id: string;
  command: string;
  exitCode: number;
  outputSha256: string;
  logPath: string;
  baseline?: TestBaselineEvidence | JestBaselineEvidence;
  jestDiagnostic?: JestDiagnostic;
}

export interface RunnerChecks {
  status: 'pending' | 'complete';
  sourceSha256: string;
  policySha256: string;
  results: RunnerCheckResult[];
}

/** Trusted local checks inherit the Runner environment without filtering keys. */
export function buildHostCheckEnvironment(parent: NodeJS.ProcessEnv, environmentFile?: string): Record<string, string> {
  let configured: Record<string, string> = {};
  if (environmentFile) {
    let bytes: string | undefined;
    try { bytes = readFileSync(environmentFile, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read private Runner environment'); }
    if (bytes !== undefined) {
      try {
        const value: unknown = JSON.parse(bytes);
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.entries(value).some(([key, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string' || entry.includes('\0'))) throw new Error();
        configured = value as Record<string, string>;
      } catch { throw new Error('Invalid private Runner environment: expected an object of environment strings'); }
    }
  }
  return { ...configured, ...Object.fromEntries(Object.entries(parent).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
}

/** Execution order is part of the configured host-check policy. */
export function runnerCheckPolicySha256(checks: Record<string, string>): string {
  return sha256(canonicalJson(Object.entries(checks)));
}

/** A confirmed unchanged, unrelated test failure is admissible without hiding its exit status. */
export function runnerCheckAccepted(result: RunnerCheckResult, baseSha?: string): boolean {
  return result.exitCode === 0 || (result.exitCode === 1 && !!baseSha
    && result.baseline?.baseSha === baseSha
    && ('kind' in result.baseline ? result.baseline.kind === 'jest' && !!npmTestScript(result.command) : !!flutterTestCommand(result.command))
    && result.baseline.affectedTests.length > 0 && result.baseline.failures.length > 0);
}

/** Execute trusted commands sequentially; only baseline-confirmed unrelated test failures may continue. */
export async function runConfiguredChecks(input: {
  checks: Record<string, string>;
  worktreePath: string;
  baseSha?: string;
  logRoot: string;
  timeoutMs: number;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  executor?: ProcessExecutor;
}): Promise<RunnerCheckResult[]> {
  await mkdir(input.logRoot, { recursive: true, mode: 0o700 });
  const results: RunnerCheckResult[] = [];
  const incompleteLogs = new Set<string>();
  let sequence = 0;
  const execute = async (command: string, cwd: string, label: string, timeoutMs = input.timeoutMs): Promise<RunnerCheckResult> => {
    if (input.signal.aborted) throw new Error('Configured checks cancelled before launch.');
    const logPath = join(input.logRoot, `${sequence++}-${label.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 60)}.log`);
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
        cwd, env: buildHostCheckEnvironment(input.env),
        timeoutMs, signal: input.signal, processGroup: true, maxOutputBytes: 64 * 1024 * 1024,
        onStdoutBytes: capture, onStderrBytes: capture,
      });
      exitCode = result.exitCode;
      if (result.exitCode === 124 || result.exitCode === 130) capture(Buffer.from(`\nRunner: ${result.exitCode === 124 ? 'command timed out' : 'command cancelled'}.\n`));
    } catch (error) {
      // An unresolved owned group remains fenced; a model cannot admit its output.
      if (error instanceof CommandProcessQuiescenceError) throw error;
      capture(Buffer.from(`\nRunner: check did not complete; retained output may be incomplete. ${error instanceof Error ? error.message : 'Command execution failed.'}\n`));
      incompleteLogs.add(logPath);
      exitCode = 1;
    } finally { try { fsyncSync(fd); } finally { closeSync(fd); } }
    return { id: label, command, exitCode, outputSha256: hash.digest('hex'), logPath };
  };
  for (const [id, command] of Object.entries(input.checks)) {
    const flutter = input.baseSha ? flutterTestCommand(command) : undefined;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const baseSha = input.baseSha && /^[a-f0-9]{40}$/u.test(input.baseSha) ? input.baseSha : undefined;
    const checkDirectory = join(input.logRoot, `jest-${sequence}`);
    let reportPath: string | undefined;
    if (baseSha && npmTestScript(command)) {
      try {
        if (jestCommand(input.worktreePath, command)) reportPath = join(checkDirectory, 'candidate-jest.json');
      } catch { /* Invalid metadata retains the full command without instrumentation. */ }
      if (reportPath) await mkdir(checkDirectory, { mode: 0o700 });
    }
    const ownerCheck = baseSha && /^npm (?:test|run [A-Za-z0-9_:-]+)(?: |$)/u.test(command)
      ? `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./candidate-check.js', import.meta.url)))} ${baseSha} ${quote(command)}${reportPath ? ` ${quote(reportPath)}` : ''}` : command;
    const result = await execute(flutter?.machine ?? ownerCheck, input.worktreePath, id);
    result.command = command;
    if (flutter && result.exitCode === 1) {
      result.baseline = await confirmFlutterBaseline({ command, candidate: result, baseSha: input.baseSha!,
        worktreePath: input.worktreePath, logRoot: input.logRoot, run: execute });
      if (!result.baseline) delete result.baseline;
    } else if (reportPath && incompleteLogs.has(result.logPath)) {
      result.jestDiagnostic = { code: 'candidate-execution' };
    } else if (baseSha && reportPath && result.exitCode === 1) {
      const deadline = performance.now() + input.timeoutMs;
      let expired = false;
      const comparison = await confirmJestBaseline({ command, reportPath, baseSha, worktreePath: input.worktreePath,
        logRoot: checkDirectory, run: async (probe, cwd, label) => {
          const remaining = Math.ceil(deadline - performance.now());
          if (remaining <= 0) {
            expired = true;
            throw new Error('Jest baseline comparison timed out.');
          }
          const result = await execute(probe, cwd, label, remaining);
          expired ||= result.exitCode === 124;
          if (incompleteLogs.has(result.logPath)) throw new Error('Jest comparison command did not complete.');
          return result;
        } });
      Object.assign(result, expired ? { jestDiagnostic: { code: 'comparison-timeout' } } : comparison);
    }
    results.push(result);
    if (!runnerCheckAccepted(result, input.baseSha)) break;
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
      || Object.keys(result).filter(key => key !== 'baseline' && key !== 'jestDiagnostic').sort().join(',') !== 'command,exitCode,id,logPath,outputSha256'
      || typeof result.id !== 'string' || !result.id || ids.has(result.id)
      || typeof result.command !== 'string' || !result.command
      || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255
      || typeof result.logPath !== 'string' || !result.logPath.startsWith('/')
      || !/^[0-9a-f]{64}$/.test(result.outputSha256)) throw new Error('runnerChecks result is invalid');
    if ('jestDiagnostic' in result && (result.exitCode !== 1 || !npmTestScript(result.command)
      || 'baseline' in result || !validJestDiagnostic(result.jestDiagnostic))) throw new Error('runnerChecks Jest diagnostic is invalid');
    if ('baseline' in result) {
      const b = result.baseline;
      if (!b || typeof b !== 'object') throw new Error('runnerChecks baseline is invalid');
      const jest = b.kind === 'jest';
      const validFile = (file: unknown) => jest ? jestEvidencePath(file) : typeof file === 'string'
        && posix.normalize(file) === file && /^test\/.*_test\.dart$/u.test(file);
      if (Object.keys(b).sort().join(',') !== (jest ? 'affectedTests,baseSha,failures,kind,logPath,outputSha256' : 'affectedTests,baseSha,failures,logPath,outputSha256')
        || !/^[a-f0-9]{40}$/.test(b.baseSha) || typeof b.logPath !== 'string' || !b.logPath.startsWith('/')
        || !/^[a-f0-9]{64}$/.test(b.outputSha256) || !Array.isArray(b.affectedTests) || !b.affectedTests.length
        || b.affectedTests.some((file: unknown) => !validFile(file))
        || !Array.isArray(b.failures) || !b.failures.length || b.failures.some((failure: unknown) => {
          if (!failure || typeof failure !== 'object') return true;
          const f = failure as Record<string, unknown>;
          if (Object.keys(f).sort().join(',') !== 'errorSha256,test' || typeof f.test !== 'string'
            || typeof f.errorSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.errorSha256)) return true;
          const separator = f.test.indexOf(' :: ');
          const file = f.test.slice(0, separator);
          return separator < 0 || !f.test.slice(separator + 4).trim() || !validFile(file) || b.affectedTests.includes(file);
        })
        || b.logPath === result.logPath || new Set(b.affectedTests).size !== b.affectedTests.length
        || !runnerCheckAccepted(result, b.baseSha)) throw new Error('runnerChecks baseline is invalid');
    }
    ids.add(result.id);
  }
  if (r.status === 'pending' && r.results.length) throw new Error('pending runnerChecks cannot contain results');
}
