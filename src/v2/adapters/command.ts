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
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let idleTimedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    const callbackTasks: Array<Promise<void>> = [];
    const ownsProcessGroup = options.processGroup === true && process.platform !== 'win32';
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ? { ...options.env } : options.envOverlay ? { ...process.env, ...options.envOverlay } : process.env,
      shell: options.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: ownsProcessGroup,
    });
    let stdout = '';
    let stderr = '';

    if (options.maxOutputBytes !== undefined
      && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1)) {
      child.kill();
      reject(new Error('maxOutputBytes must be a positive safe integer'));
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const scheduleCallback = (callback: ((chunk: string) => void | Promise<void>) | undefined, chunk: string) => {
      if (callback) {
        callbackTasks.push(Promise.resolve(callback(chunk)));
      }
    };
    let idleTimeout: NodeJS.Timeout | undefined;
    const resetIdleTimeout = () => {
      if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) {
        return;
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => {
        idleTimedOut = true;
        signalOwnedProcess(child.pid, ownsProcessGroup, 'SIGTERM');
        setTimeout(() => {
          if (ownsProcessGroup || !settled) signalOwnedProcess(child.pid, ownsProcessGroup, 'SIGKILL');
        }, 2_000).unref();
      }, options.idleTimeoutMs);
      idleTimeout.unref();
    };
    resetIdleTimeout();

    const capture = (chunk: string, stream: 'stdout' | 'stderr') => {
      const bytes = Buffer.byteLength(chunk, 'utf8');
      if (options.maxOutputBytes !== undefined && outputBytes + bytes > options.maxOutputBytes) {
        outputLimitExceeded = true;
        signalOwnedProcess(child.pid, ownsProcessGroup, 'SIGTERM');
        setTimeout(() => {
          if (ownsProcessGroup || !settled) signalOwnedProcess(child.pid, ownsProcessGroup, 'SIGKILL');
        }, 2_000).unref();
        return false;
      }
      outputBytes += bytes;
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      return true;
    };
    child.stdout.on('data', (chunk: string) => {
      if (!capture(chunk, 'stdout')) return;
      scheduleCallback(options.onStdoutChunk, chunk);
      resetIdleTimeout();
    });
    child.stderr.on('data', (chunk: string) => {
      if (!capture(chunk, 'stderr')) return;
      scheduleCallback(options.onStderrChunk, chunk);
      resetIdleTimeout();
    });
    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            signalOwnedProcess(child.pid, ownsProcessGroup, 'SIGTERM');
            setTimeout(() => {
              if (ownsProcessGroup || !settled) signalOwnedProcess(child.pid, ownsProcessGroup, 'SIGKILL');
            }, 2_000).unref();
          }, options.timeoutMs)
        : undefined;
    timeout?.unref();
    const abort = () => {
      aborted = true;
      signalOwnedProcess(child.pid, ownsProcessGroup, 'SIGTERM');
      setTimeout(() => {
        if (ownsProcessGroup || !settled) signalOwnedProcess(child.pid, ownsProcessGroup, 'SIGKILL');
      }, 2_000).unref();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      options.signal?.removeEventListener('abort', abort);
      const finish = async () => {
        await Promise.all(callbackTasks);
        if ((aborted || timedOut || idleTimedOut) && ownsProcessGroup && child.pid) {
          await waitForProcessGroupAbsence(child.pid);
        }
        if (outputLimitExceeded) {
          reject(new ProcessOutputLimitError(options.maxOutputBytes!));
          return;
        }
        if (aborted) {
          resolve({ stdout, stderr: stderr ? `${stderr}\nCommand cancelled.` : 'Command cancelled.', exitCode: 130 });
          return;
        }
        if (idleTimedOut) {
          const timeoutMessage = `Command idle timed out after ${options.idleTimeoutMs}ms.`;
          resolve({
            stdout,
            stderr: stderr ? `${stderr}\n${timeoutMessage}` : timeoutMessage,
            exitCode: 124,
          });
          return;
        }
        if (timedOut) {
          const timeoutMessage = `Command timed out after ${options.timeoutMs}ms.`;
          resolve({
            stdout,
            stderr: stderr ? `${stderr}\n${timeoutMessage}` : timeoutMessage,
            exitCode: 124,
          });
          return;
        }
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      };
      void finish().catch(reject);
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function signalOwnedProcess(pid: number | undefined, processGroup: boolean, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(processGroup ? -pid : pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

async function waitForProcessGroupAbsence(processGroupId: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(-processGroupId, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  signalOwnedProcess(processGroupId, true, 'SIGKILL');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(-processGroupId, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Command process group remained active after SIGKILL.');
}
