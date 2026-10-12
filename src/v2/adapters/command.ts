import { spawn } from 'node:child_process';

export interface ProcessCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  envOverlay?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  processGroup?: boolean;
  maxOutputBytes?: number;
  onStdoutBytes?: (chunk: Buffer) => void;
  onStderrBytes?: (chunk: Buffer) => void;
  onStdoutChunk?: (chunk: string) => void | Promise<void>;
  onStderrChunk?: (chunk: string) => void | Promise<void>;
}

export interface ProcessCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ProcessOutputLimitError extends Error {
  readonly code = 'command-output-limit-exceeded';

  constructor(readonly maxOutputBytes: number) {
    super(`Command output exceeded ${maxOutputBytes} bytes.`);
    this.name = 'ProcessOutputLimitError';
  }
}

export interface UnresolvedCommandIdentity {
  pid: number;
  processGroupId: number;
  processStartIdentity?: string;
  streamsUnconfirmed: boolean;
}

export class CommandProcessQuiescenceError extends Error implements UnresolvedCommandIdentity {
  readonly code = 'command-process-quiescence-unconfirmed';
  readonly processStartIdentity?: string;
  constructor(message: string, readonly pid: number, readonly processGroupId: number,
    readonly streamsUnconfirmed: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CommandProcessQuiescenceError';
  }
}

export type ProcessExecutor = (
  file: string,
  args: string[],
  options?: ProcessCommandOptions,
) => Promise<ProcessCommandResult>;

export type ShellCommandExecutor = (command: string, options?: ProcessCommandOptions) => Promise<ProcessCommandResult>;

export const defaultProcessExecutor: ProcessExecutor = (file, args, options) =>
  runSpawn(file, args, { ...options, shell: false });

export const defaultShellCommandExecutor: ShellCommandExecutor = (command, options) =>
  runSpawn(command, [], { ...options, shell: true });

function runSpawn(
  file: string,
  args: string[],
  options: ProcessCommandOptions & { shell: boolean },
): Promise<ProcessCommandResult> {
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1)) {
    return Promise.reject(new Error('maxOutputBytes must be a positive safe integer'));
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('timeoutMs must be finite and positive'));
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const ownsGroup = options.processGroup !== false && process.platform !== 'win32';
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ? { ...options.env } : options.envOverlay ? { ...process.env, ...options.envOverlay } : process.env,
      shell: options.shell, stdio: ['pipe', 'pipe', 'pipe'], detached: ownsGroup,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const callbacks: Promise<void>[] = [];
    let bytes = 0;
    let settled = false;
    let stopping = false;
    let captureError: unknown;
    let streamsClosed = false;
    let reason: 'timeout' | 'idle' | 'cancelled' | 'output' | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let barrierTimer: NodeJS.Timeout | undefined;
    const finish = (error?: unknown, exitCode = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (idleTimer) clearTimeout(idleTimer);
      if (killTimer) clearTimeout(killTimer); if (barrierTimer) clearTimeout(barrierTimer);
      options.signal?.removeEventListener('abort', abort);
      if (error || captureError) {
        const failure = error && captureError ? new Error(`${String(captureError)}; command cleanup failed: ${String(error)}`) : error ?? captureError;
        let absent = !child.pid;
        try { absent = !child.pid || (ownsGroup ? !groupPresent(child.pid) : false); } catch { absent = false; }
        reject(child.pid && (!absent || !streamsClosed)
          ? new CommandProcessQuiescenceError(String(failure), child.pid, ownsGroup ? child.pid : 0, !streamsClosed, { cause: failure })
          : failure);
        return;
      }
      if (reason === 'output') { reject(new ProcessOutputLimitError(options.maxOutputBytes!)); return; }
      const diagnostic = reason === 'cancelled' ? 'Command cancelled.' : reason === 'idle'
        ? `Command idle timed out after ${options.idleTimeoutMs}ms.` : reason === 'timeout'
          ? `Command timed out after ${timeoutMs}ms.` : '';
      const capturedStderr = Buffer.concat(stderr).toString('utf8');
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: diagnostic
        ? `${capturedStderr}${capturedStderr ? '\n' : ''}${diagnostic}` : capturedStderr,
        exitCode: reason === 'cancelled' ? 130 : reason ? 124 : exitCode });
    };
    const stop = (nextReason?: typeof reason) => {
      if (nextReason && !reason) reason = nextReason;
      if (stopping || settled) return;
      stopping = true;
      try { signalOwnedProcess(child.pid, ownsGroup, 'SIGTERM'); } catch (error) { finish(error); return; }
      killTimer = setTimeout(() => {
        try { signalOwnedProcess(child.pid, ownsGroup, 'SIGKILL'); } catch (error) { finish(error); }
      }, 2_000);
      barrierTimer = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        finish(new Error('Command process group or streams could not be confirmed absent after SIGKILL.'));
      }, 7_000);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const activity = () => {
      if (!options.idleTimeoutMs || stopping) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('idle'), options.idleTimeoutMs);
    };
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (options.maxOutputBytes !== undefined && bytes + chunk.length > options.maxOutputBytes) { stop('output'); return; }
      bytes += chunk.length;
      (stream === 'stdout' ? stdout : stderr).push(chunk);
      try {
        (stream === 'stdout' ? options.onStdoutBytes : options.onStderrBytes)?.(chunk);
        const callback = stream === 'stdout' ? options.onStdoutChunk : options.onStderrChunk;
        if (callback) {
          const task = Promise.resolve(callback(chunk.toString('utf8')));
          void task.catch(() => undefined); callbacks.push(task);
        }
      } catch (error) { captureError = error; stop(); }
      activity();
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => finish(error));
    child.once('exit', () => {
      // Parent exit is insufficient: descendants may still own the inherited pipes.
      try { if (ownsGroup && child.pid && groupPresent(child.pid)) stop(); }
      catch (error) { finish(error); }
    });
    child.once('close', (code) => {
      streamsClosed = true;
      void (async () => {
        if (ownsGroup && child.pid) {
          if (groupPresent(child.pid)) stop();
          while (groupPresent(child.pid) && !settled) await new Promise((r) => setTimeout(r, 25));
        }
        // Keep the wall deadline alive for asynchronous output consumers too.
        let callbackTimer: NodeJS.Timeout | undefined;
        try {
          if (!reason) await Promise.race([Promise.all(callbacks), new Promise<void>((r) => {
            callbackTimer = setTimeout(() => { if (!reason) reason = 'timeout'; r(); }, Math.max(0, deadline - Date.now()));
          })]);
        } finally { if (callbackTimer) clearTimeout(callbackTimer); }
        if (!settled) finish(undefined, code ?? 1);
      })().catch((error) => finish(error));
    });
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    activity();
    child.stdin.end(options.stdin);
  });
}

function signalOwnedProcess(pid: number | undefined, processGroup: boolean, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(processGroup ? -pid : pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
function groupPresent(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error; }
}
