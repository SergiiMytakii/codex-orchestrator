import { spawn } from 'node:child_process';
import { lstat, readFile, rm } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

import { buildContainmentCodexArgs, buildContainmentCodexEnvironment } from './containment.js';
import type { WorkflowExecutionProfile, WorkflowOperationPolicy } from './workflow-assets.js';

const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const TERMINATE_GRACE_MS = 5_000;
const QUIESCENCE_TIMEOUT_MS = 10_000;
const MONITOR_POLL_MS = 50;

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
}

export interface SupervisedChild {
  pid: number;
  processGroupId: number;
  lastActivityAt(): number;
  writeStdinAndClose(value: string): Promise<void>;
  waitForExit(): Promise<{ exitCode: number | null; signal: string | null }>;
  terminateGroup(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  waitForGroupAbsent(timeoutMs: number): Promise<void>;
  waitForStreamsClosed(): Promise<{ stdout: Buffer; stderr: Buffer; truncated: boolean }>;
}

export type SpawnSupervisedProcess = (spec: SpawnSpec) => Promise<SupervisedChild>;

export interface CodexProcessInput {
  codexPath: string;
  cwd: string;
  schemaPath: string;
  reportPath: string;
  toolHome: string;
  tmpDir: string;
  safePath: string;
  parentCodexHome: string;
  parentEnv: NodeJS.ProcessEnv;
  prompt: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  operationPolicy: WorkflowOperationPolicy;
  executionProfile: Pick<WorkflowExecutionProfile, 'model' | 'reasoningEffort'>;
  onSpawned?: (identity: { pid: number; processGroupId: number }) => Promise<void>;
}

export type CodexReportRead =
  | { kind: 'available'; bytes: Buffer }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string };

export interface CodexProcessResult {
  kind:
    | 'completed'
    | 'exit-failed'
    | 'spawn-failed'
    | 'launch-gate-failed'
    | 'transport-failed'
    | 'timeout'
    | 'idle-timeout'
    | 'cancelled'
    | 'output-truncated'
    | 'report-failed';
  pid?: number;
  processGroupId?: number;
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  report: CodexReportRead;
  error?: string;
}

export class ProcessQuiescenceError extends Error {
  readonly pid: number;
  readonly processGroupId: number;

  constructor(message: string, child: SupervisedChild, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProcessQuiescenceError';
    this.pid = child.pid;
    this.processGroupId = child.processGroupId;
  }
}

export class CodexProcess {
  constructor(private readonly spawnProcess: SpawnSupervisedProcess = spawnNodeSupervisedProcess) {}

  async run(input: CodexProcessInput, signal: AbortSignal): Promise<CodexProcessResult> {
    validateInput(input);
    await clearPriorReport(input.reportPath);
    const spec: SpawnSpec = {
      file: input.codexPath,
      args: buildContainmentCodexArgs({
        schemaPath: input.schemaPath,
        reportPath: input.reportPath,
        toolHome: input.toolHome,
        tmpDir: input.tmpDir,
        safePath: input.safePath,
        operationPolicy: input.operationPolicy,
        executionProfile: input.parentEnv.CODEX_ORCHESTRATOR_LIVE_SMOKE_CODEX_DEFAULT_MODEL === '1'
          ? undefined
          : input.executionProfile,
      }),
      cwd: input.cwd,
      env: buildContainmentCodexEnvironment({
        parentEnv: input.parentEnv,
        parentCodexHome: input.parentCodexHome,
        safePath: input.safePath,
      }),
      stdin: input.prompt,
    };

    let child: SupervisedChild;
    try {
      child = await this.spawnProcess(spec);
    } catch (error) {
      return emptyResult('spawn-failed', errorMessage(error));
    }

    if (input.onSpawned) {
      try {
        await input.onSpawned({ pid: child.pid, processGroupId: child.processGroupId });
      } catch (error) {
        const settled = await terminateAndSettle(child, child.waitForExit());
        return finalizeResult('launch-gate-failed', child, settled, { kind: 'missing' }, errorMessage(error));
      }
    }

    let stdinError: unknown;
    try {
      await child.writeStdinAndClose(spec.stdin);
    } catch (error) {
      stdinError = error;
    }
    const exitPromise = child.waitForExit();
    if (stdinError) {
      const settled = await terminateAndSettle(child, exitPromise);
      return finalizeResult('transport-failed', child, settled, await readReportAtomic(input.reportPath), errorMessage(stdinError));
    }

    const terminal = await monitorTerminal(child, exitPromise, signal, input.timeoutMs, input.idleTimeoutMs);
    let settled: SettledChild;
    if (terminal.kind === 'exit') {
      settled = await settleNormalExit(child, terminal.exit);
    } else {
      settled = await terminateAndSettle(child, exitPromise);
    }
    const report = await readReportAtomic(input.reportPath);

    if (terminal.kind === 'wait-failed') {
      return finalizeResult('transport-failed', child, settled, report, errorMessage(terminal.error));
    }
    if (terminal.kind === 'cancelled') return finalizeResult('cancelled', child, settled, report);
    if (terminal.kind === 'timeout') return finalizeResult('timeout', child, settled, report);
    if (terminal.kind === 'idle-timeout') return finalizeResult('idle-timeout', child, settled, report);
    if (settled.streams.truncated) return finalizeResult('output-truncated', child, settled, report);
    if (
      report.kind !== 'available'
      && settled.exit.exitCode !== 0
      && isConfirmedTransportFailure(settled.streams.stderr)
    ) {
      return finalizeResult('transport-failed', child, settled, report);
    }
    if (report.kind !== 'available') return finalizeResult('report-failed', child, settled, report);
    if (settled.exit.exitCode === 0 && settled.exit.signal === null) {
      return finalizeResult('completed', child, settled, report);
    }
    return finalizeResult('exit-failed', child, settled, report);
  }
}

function isConfirmedTransportFailure(stderr: Buffer): boolean {
  return stderr.toString('utf8').includes('stream disconnected before completion');
}

type TerminalObservation =
  | { kind: 'exit'; exit: { exitCode: number | null; signal: string | null } }
  | { kind: 'wait-failed'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'idle-timeout' }
  | { kind: 'cancelled' };

interface SettledChild {
  exit: { exitCode: number | null; signal: string | null };
  streams: { stdout: Buffer; stderr: Buffer; truncated: boolean };
}

async function monitorTerminal(
  child: SupervisedChild,
  exitPromise: Promise<{ exitCode: number | null; signal: string | null }>,
  signal: AbortSignal,
  timeoutMs: number,
  idleTimeoutMs: number,
): Promise<TerminalObservation> {
  const startedAt = Date.now();
  const observedExit: Promise<TerminalObservation> = exitPromise.then(
    (exit): TerminalObservation => ({ kind: 'exit', exit }),
    (error: unknown): TerminalObservation => ({ kind: 'wait-failed', error }),
  );
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<TerminalObservation>((resolveAbort) => {
    abortListener = () => resolveAbort({ kind: 'cancelled' });
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    while (true) {
      if (signal.aborted) return { kind: 'cancelled' };
      const now = Date.now();
      const wallRemaining = timeoutMs - (now - startedAt);
      if (wallRemaining <= 0) return { kind: 'timeout' };
      const idleRemaining = idleTimeoutMs - Math.max(0, now - child.lastActivityAt());
      if (idleRemaining <= 0) return { kind: 'idle-timeout' };
      const waitMs = Math.max(1, Math.min(wallRemaining, idleRemaining, MONITOR_POLL_MS));
      const winner = await Promise.race([
        observedExit,
        aborted,
        delay(waitMs).then(() => ({ kind: 'tick' as const })),
      ]);
      if (winner.kind !== 'tick') return winner;
    }
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

async function settleNormalExit(
  child: SupervisedChild,
  exit: { exitCode: number | null; signal: string | null },
): Promise<SettledChild> {
  try {
    await child.waitForGroupAbsent(0);
  } catch {
    await child.terminateGroup('SIGTERM');
    try {
      await child.waitForGroupAbsent(TERMINATE_GRACE_MS);
    } catch {
      await child.terminateGroup('SIGKILL');
      await requireGroupAbsent(child, QUIESCENCE_TIMEOUT_MS);
    }
  }
  const streams = await requireStreamsClosed(child);
  return { exit, streams };
}

async function terminateAndSettle(
  child: SupervisedChild,
  exitPromise: Promise<{ exitCode: number | null; signal: string | null }>,
): Promise<SettledChild> {
  await child.terminateGroup('SIGTERM');
  try {
    await child.waitForGroupAbsent(TERMINATE_GRACE_MS);
  } catch {
    await child.terminateGroup('SIGKILL');
    await requireGroupAbsent(child, QUIESCENCE_TIMEOUT_MS);
  }
  let exit: { exitCode: number | null; signal: string | null };
  try {
    exit = await withTimeout(exitPromise, QUIESCENCE_TIMEOUT_MS, 'process exit did not settle');
  } catch (error) {
    throw new ProcessQuiescenceError('process exit could not be confirmed', child, { cause: error });
  }
  const streams = await requireStreamsClosed(child);
  return { exit, streams };
}

async function requireGroupAbsent(child: SupervisedChild, timeoutMs: number): Promise<void> {
  try {
    await child.waitForGroupAbsent(timeoutMs);
  } catch (error) {
    throw new ProcessQuiescenceError('process group absence could not be confirmed', child, { cause: error });
  }
}

async function requireStreamsClosed(child: SupervisedChild): Promise<SettledChild['streams']> {
  try {
    const streams = await withTimeout(child.waitForStreamsClosed(), QUIESCENCE_TIMEOUT_MS, 'process streams did not close');
    return {
      stdout: streams.stdout.subarray(0, MAX_STREAM_BYTES),
      stderr: streams.stderr.subarray(0, MAX_STREAM_BYTES),
      truncated: streams.truncated || streams.stdout.length > MAX_STREAM_BYTES || streams.stderr.length > MAX_STREAM_BYTES,
    };
  } catch (error) {
    throw new ProcessQuiescenceError('process stream closure could not be confirmed', child, { cause: error });
  }
}

function finalizeResult(
  kind: CodexProcessResult['kind'],
  child: SupervisedChild,
  settled: SettledChild,
  report: CodexReportRead,
  error?: string,
): CodexProcessResult {
  return {
    kind,
    pid: child.pid,
    processGroupId: child.processGroupId,
    exitCode: settled.exit.exitCode,
    signal: settled.exit.signal,
    stdout: settled.streams.stdout,
    stderr: settled.streams.stderr,
    report,
    ...(error ? { error } : {}),
  };
}

function emptyResult(kind: 'spawn-failed', error: string): CodexProcessResult {
  return {
    kind,
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    report: { kind: 'missing' },
    error,
  };
}

async function readReportAtomic(path: string): Promise<CodexReportRead> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', reason: errorMessage(error) };
  }
  if (before.isSymbolicLink() || !before.isFile()) return { kind: 'invalid', reason: 'report is not a regular file' };
  if (before.size > MAX_REPORT_BYTES) return { kind: 'invalid', reason: 'report exceeds 1 MiB' };
  try {
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size
    ) {
      return { kind: 'invalid', reason: 'report changed during atomic read' };
    }
    return { kind: 'available', bytes };
  } catch (error) {
    return { kind: 'invalid', reason: errorMessage(error) };
  }
}

async function clearPriorReport(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('refusing unsafe pre-existing report path');
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function spawnNodeSupervisedProcess(spec: SpawnSpec): Promise<SupervisedChild> {
  const child = spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('spawned Codex process lacks required stdio');

  let lastActivity = Date.now();
  const stdout = collectBoundedStream(child.stdout, () => { lastActivity = Date.now(); });
  const stderr = collectBoundedStream(child.stderr, () => { lastActivity = Date.now(); });
  const exit = new Promise<{ exitCode: number | null; signal: string | null }>((resolveExit, rejectExit) => {
    child.once('exit', (exitCode, exitSignal) => resolveExit({ exitCode, signal: exitSignal }));
    child.once('error', rejectExit);
  });
  void exit.catch(() => undefined);
  void stdout.done.catch(() => undefined);
  void stderr.done.catch(() => undefined);

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  if (!child.pid) throw new Error('spawned Codex process has no pid');
  const pid = child.pid;

  return {
    pid,
    processGroupId: pid,
    lastActivityAt: () => lastActivity,
    writeStdinAndClose: async (value) => {
      const completion = finished(child.stdin, { cleanup: true });
      if (value.length === 0) child.stdin.end();
      else child.stdin.end(value);
      try {
        await completion;
      } catch (error) {
        if (value.length === 0 && (error as NodeJS.ErrnoException).code === 'EPIPE') return;
        throw error;
      }
    },
    waitForExit: () => exit,
    terminateGroup: async (terminationSignal) => {
      try {
        process.kill(-pid, terminationSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
    waitForGroupAbsent: (timeoutMs) => waitForProcessGroupAbsent(pid, timeoutMs),
    waitForStreamsClosed: async () => {
      const [stdoutResult, stderrResult] = await Promise.all([stdout.done, stderr.done]);
      return {
        stdout: stdoutResult.bytes,
        stderr: stderrResult.bytes,
        truncated: stdoutResult.truncated || stderrResult.truncated,
      };
    },
  };
}

function collectBoundedStream(
  stream: NodeJS.ReadableStream,
  onActivity: () => void,
): { done: Promise<{ bytes: Buffer; truncated: boolean }> } {
  const chunks: Buffer[] = [];
  let captured = 0;
  let truncated = false;
  const done = new Promise<{ bytes: Buffer; truncated: boolean }>((resolveDone, rejectDone) => {
    stream.on('data', (value: Buffer | string) => {
      onActivity();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = MAX_STREAM_BYTES - captured;
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        chunks.push(accepted);
        captured += accepted.length;
      }
      if (chunk.length > remaining) truncated = true;
    });
    stream.once('end', () => resolveDone({ bytes: Buffer.concat(chunks), truncated }));
    stream.once('error', rejectDone);
  });
  return { done };
}

async function waitForProcessGroupAbsent(processGroupId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error('process group is still present');
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateInput(input: CodexProcessInput): void {
  for (const [field, value] of Object.entries({
    codexPath: input.codexPath,
    cwd: input.cwd,
    schemaPath: input.schemaPath,
    reportPath: input.reportPath,
    toolHome: input.toolHome,
    tmpDir: input.tmpDir,
    safePath: input.safePath,
    parentCodexHome: input.parentCodexHome,
    prompt: input.prompt,
  })) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('timeoutMs must be a positive safe integer');
  if (!Number.isSafeInteger(input.idleTimeoutMs) || input.idleTimeoutMs <= 0) throw new Error('idleTimeoutMs must be a positive safe integer');
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
