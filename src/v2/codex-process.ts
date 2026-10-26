import { spawn } from 'node:child_process';
import { lstat, readFile, rm } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

import { buildContainmentCodexArgs, buildContainmentCodexEnvironment } from './containment.js';
import { captureProcessStartIdentity } from './process-identity.js';
import type { ProcessStartIdentity } from './active-attempt.js';
import type { WorkflowExecutionProfile, WorkflowOperationPolicy } from './workflow-assets.js';

const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const TERMINATE_GRACE_MS = 5_000;
const QUIESCENCE_TIMEOUT_MS = 10_000;
const MONITOR_POLL_MS = 50;
const MODEL_CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.';

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  deadline?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
}

export interface SupervisedChild {
  pid: number;
  processGroupId: number;
  processStartIdentity: ProcessStartIdentity | null;
  lastActivityAt(): number;
  releaseStartGate(): Promise<void>;
  writeStdinAndClose(value: string): Promise<void>;
  waitForExit(): Promise<{ exitCode: number | null; signal: string | null }>;
  terminateGroup(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  waitForGroupAbsent(timeoutMs: number): Promise<void>;
  waitForStreamsClosed(): Promise<{ stdout: Buffer; stderr: Buffer; truncated: boolean }>;
}

export type SpawnSupervisedProcess = (spec: SpawnSpec) => Promise<SupervisedChild>;

export interface CodexProcessInput {
  sessionId?: string;
  onSessionStarted?: (sessionId: string) => Promise<void>;
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
  agentProfilePaths?: Record<string, string>;
  onSpawned: (identity: {
    pid: number;
    processGroupId: number;
    processStartIdentity: ProcessStartIdentity;
  }) => Promise<void>;
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
  sessionId?: string;
  sessionIdentityFailed?: boolean;
  pid?: number;
  processGroupId?: number;
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  report: CodexReportRead;
  error?: string;
  outputTruncated?: boolean;
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
    const deadline = Date.now() + input.timeoutMs;
    await clearPriorReport(input.reportPath);
    const liveSmokeModel = input.parentEnv.CODEX_ORCHESTRATOR_LIVE_SMOKE_MODEL;
    if (liveSmokeModel !== undefined && !/^[a-z0-9._-]+$/u.test(liveSmokeModel)) {
      throw new Error('live smoke model must be one canonical model slug');
    }
    let sessionId = input.sessionId;
    let observedSessionId: string | undefined;
    let sessionError: unknown;
    let sessionWrites = Promise.resolve();
    let failSession!: (error: unknown) => void;
    const sessionFailed = new Promise<{ kind: 'session-failed'; error: unknown }>((resolveFailure) => {
      failSession = (error) => {
        sessionError ??= error instanceof Error ? error : new Error(String(error));
        resolveFailure({ kind: 'session-failed', error: sessionError });
      };
    });
    let pendingLine = '';
    let discardingLine = false;
    let modelCapacityFailure = false;
    const consumeLine = (line: string) => {
      if (sessionError) return;
      let event: unknown;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if ((event as { type?: unknown }).type === 'turn.failed') {
        const error = (event as { error?: { message?: unknown; codex_error_info?: unknown } | null }).error;
        if (error?.message === MODEL_CAPACITY_MESSAGE || error?.codex_error_info === 'server_overloaded') {
          modelCapacityFailure = true;
        }
        return;
      }
      if ((event as { type?: unknown }).type !== 'thread.started') return;
      const id = (event as { thread_id?: unknown }).thread_id;
      if (typeof id !== 'string' || !isSessionId(id)) {
        failSession(new Error('thread.started session identity must be a canonical UUID'));
        return;
      }
      if ((input.sessionId !== undefined && id !== input.sessionId)
        || (observedSessionId !== undefined && id !== observedSessionId)) {
        failSession(new Error('thread.started session identity conflicts with the issue session'));
        return;
      }
      if (observedSessionId === id) return;
      observedSessionId = id;
      sessionWrites = sessionWrites.then(async () => {
        await input.onSessionStarted?.(id);
        sessionId = id;
      }).catch((error: unknown) => { failSession(error); });
    };
    const onStdout = (chunk: Buffer) => {
      // Identity events are ASCII. Keep parser memory bounded independently of
      // the diagnostic capture, and continue observing after capture truncation.
      for (const part of chunk.toString('utf8').split(/(?<=\n)/u)) {
        if (!discardingLine) {
          pendingLine += part;
          if (Buffer.byteLength(pendingLine) > MAX_STREAM_BYTES) { pendingLine = ''; discardingLine = true; }
        }
        if (part.endsWith('\n')) {
          if (!discardingLine) consumeLine(pendingLine);
          pendingLine = '';
          discardingLine = false;
        }
      }
    };
    const finalizeResult = (...args: Parameters<typeof finalizeProcessResult>): CodexProcessResult => ({
      ...finalizeProcessResult(...args), ...(sessionId ? { sessionId } : {}), ...(sessionError ? { sessionIdentityFailed: true } : {}),
    });
    const spec: SpawnSpec = {
      file: input.codexPath,
      args: buildContainmentCodexArgs({
        sessionId: input.sessionId,
        schemaPath: input.schemaPath,
        reportPath: input.reportPath,
        toolHome: input.toolHome,
        tmpDir: input.tmpDir,
        safePath: input.safePath,
        operationPolicy: input.operationPolicy,
        agentProfilePaths: input.agentProfilePaths,
        executionProfile: liveSmokeModel
          ? { ...input.executionProfile, model: liveSmokeModel }
          : input.parentEnv.CODEX_ORCHESTRATOR_LIVE_SMOKE_CODEX_DEFAULT_MODEL === '1'
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
      deadline, signal, onStdout,
    };

    let child: SupervisedChild;
    try {
      child = await this.spawnProcess(spec);
    } catch (error) {
      return emptyResult(error instanceof DeadlineError ? error.kind : 'spawn-failed', errorMessage(error));
    }

    if (!child.processStartIdentity) {
      const settled = await terminateAndSettle(child, child.waitForExit());
      return finalizeResult('launch-gate-failed', child, settled, { kind: 'missing' }, 'process start identity is unknown');
    }
    try {
      await withinDeadline(input.onSpawned({
        pid: child.pid,
        processGroupId: child.processGroupId,
        processStartIdentity: structuredClone(child.processStartIdentity),
      }), deadline, signal);
    } catch (error) {
      const settled = await terminateAndSettle(child, child.waitForExit());
      return finalizeResult(error instanceof DeadlineError ? error.kind : 'launch-gate-failed', child, settled, { kind: 'missing' }, errorMessage(error));
    }
    try {
      await withinDeadline(child.releaseStartGate(), deadline, signal);
    } catch (error) {
      const settled = await terminateAndSettle(child, child.waitForExit());
      return finalizeResult(error instanceof DeadlineError ? error.kind : 'launch-gate-failed', child, settled, { kind: 'missing' }, errorMessage(error));
    }

    let stdinError: unknown;
    try {
      await withinDeadline(Promise.race([
        child.writeStdinAndClose(spec.stdin),
        sessionFailed.then(({ error }) => { throw error; }),
      ]), deadline, signal);
    } catch (error) {
      stdinError = error;
    }
    const exitPromise = child.waitForExit();
    const terminal = stdinError ? { kind: 'stdin-failed' as const, error: stdinError } : await Promise.race([
      monitorTerminal(child, exitPromise, signal, Math.max(1, deadline - Date.now()), input.idleTimeoutMs),
      sessionFailed,
    ]);
    let settled: SettledChild;
    if (terminal.kind === 'exit') {
      settled = await settleNormalExit(child, terminal.exit);
    } else {
      settled = await terminateAndSettle(child, exitPromise);
    }
    if (pendingLine && !discardingLine) consumeLine(pendingLine);
    try { await withinDeadline(sessionWrites, deadline, signal); }
    catch (error) { failSession(error); }
    const report = await readReportAtomic(input.reportPath);
    if (sessionError) return finalizeResult(sessionError instanceof DeadlineError ? sessionError.kind : 'transport-failed', child, settled, report, errorMessage(sessionError));

    if (terminal.kind === 'stdin-failed') {
      return finalizeResult(terminal.error instanceof DeadlineError ? terminal.error.kind : 'transport-failed', child, settled, report, errorMessage(terminal.error));
    }
    if (terminal.kind === 'session-failed') return finalizeResult('transport-failed', child, settled, report, errorMessage(terminal.error));
    if (terminal.kind === 'wait-failed') {
      return finalizeResult('transport-failed', child, settled, report, errorMessage(terminal.error));
    }
    if (terminal.kind === 'cancelled') return finalizeResult('cancelled', child, settled, report);
    if (terminal.kind === 'timeout') return finalizeResult('timeout', child, settled, report);
    if (terminal.kind === 'idle-timeout') return finalizeResult('idle-timeout', child, settled, report);
    if (modelCapacityFailure || (settled.exit.exitCode !== 0 && settled.streams.stderr.toString('utf8').includes(MODEL_CAPACITY_MESSAGE))) {
      return finalizeResult('transport-failed', child, settled, report, 'codex-model-capacity');
    }
    if (
      report.kind !== 'available'
      && settled.exit.exitCode !== 0
      && isConfirmedTransportFailure(settled.streams.stderr)
    ) {
      return finalizeResult('transport-failed', child, settled, report);
    }
    if (report.kind === 'missing' && settled.exit.exitCode === 0 && settled.exit.signal === null) {
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
  const diagnostic = stderr.toString('utf8');
  return diagnostic.includes('stream disconnected before completion');
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
    await withTimeout(child.waitForGroupAbsent(0), MONITOR_POLL_MS, 'group observation did not settle');
  } catch {
    await requireGroupTermination(child, 'SIGTERM');
    try {
      await withTimeout(child.waitForGroupAbsent(TERMINATE_GRACE_MS), TERMINATE_GRACE_MS, 'group observation did not settle');
    } catch {
      await requireGroupTermination(child, 'SIGKILL');
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
  await requireGroupTermination(child, 'SIGTERM');
  try {
    await withTimeout(child.waitForGroupAbsent(TERMINATE_GRACE_MS), TERMINATE_GRACE_MS, 'group observation did not settle');
  } catch {
    await requireGroupTermination(child, 'SIGKILL');
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

async function requireGroupTermination(child: SupervisedChild, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  try { await withTimeout(child.terminateGroup(signal), QUIESCENCE_TIMEOUT_MS, 'group termination did not settle'); }
  catch (error) {
    // A group may disappear between observation and signalling. EPERM alone is
    // never absence evidence; require a fresh bounded group observation.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      try {
        await withTimeout(child.waitForGroupAbsent(MONITOR_POLL_MS), MONITOR_POLL_MS, 'group reobservation did not settle');
        return;
      } catch { /* Retain the original permission diagnostic and owned identity. */ }
    }
    throw new ProcessQuiescenceError('process group termination could not be confirmed', child, { cause: error });
  }
}

async function requireGroupAbsent(child: SupervisedChild, timeoutMs: number): Promise<void> {
  try {
    await withTimeout(child.waitForGroupAbsent(timeoutMs), Math.max(1, timeoutMs), 'group observation did not settle');
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

function finalizeProcessResult(
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
    ...(settled.streams.truncated ? { outputTruncated: true } : {}),
    ...(error ? { error } : {}),
  };
}

function emptyResult(kind: 'spawn-failed' | 'timeout' | 'cancelled', error: string): CodexProcessResult {
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
  const child = spawn('/bin/sh', ['-c', 'IFS= read -r _ || exit 125; exec "$@"', 'codex-launch-gate', spec.file, ...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('spawned Codex process lacks required stdio');

  let lastActivity = Date.now();
  const stdout = collectBoundedStream(child.stdout, () => { lastActivity = Date.now(); }, spec.onStdout);
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
  const capturedStartIdentity = await withinDeadline(captureProcessStartIdentity({
    platform: process.platform,
    pid,
    processGroupId: pid,
  }), spec.deadline ?? Date.now() + 5_000, spec.signal).catch(() => ({ status: 'unknown' as const }));

  return {
    pid,
    processGroupId: pid,
    processStartIdentity: capturedStartIdentity.status === 'available' ? capturedStartIdentity.identity : null,
    lastActivityAt: () => lastActivity,
    releaseStartGate: async () => {
      if (!child.stdin.write('\n')) await new Promise<void>((resolveDrain) => child.stdin.once('drain', resolveDrain));
    },
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
  onChunk?: (chunk: Buffer) => void,
): { done: Promise<{ bytes: Buffer; truncated: boolean }> } {
  const chunks: Buffer[] = [];
  let captured = 0;
  let truncated = false;
  const done = new Promise<{ bytes: Buffer; truncated: boolean }>((resolveDone, rejectDone) => {
    stream.on('data', (value: Buffer | string) => {
      onActivity();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      onChunk?.(chunk);
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
  if (input.sessionId !== undefined && !isSessionId(input.sessionId)) throw new Error('sessionId must be a canonical UUID');
  if (input.onSessionStarted !== undefined && typeof input.onSessionStarted !== 'function') throw new Error('onSessionStarted must be a function');
  if (typeof input.onSpawned !== 'function') throw new Error('onSpawned launch persistence callback is required');
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class DeadlineError extends Error {
  constructor(readonly kind: 'timeout' | 'cancelled') { super(`Codex process ${kind}`); }
}
async function withinDeadline<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    if (signal?.aborted) throw new DeadlineError('cancelled');
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError('timeout')), Math.max(0, deadline - Date.now()));
      abort = () => reject(new DeadlineError('cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
