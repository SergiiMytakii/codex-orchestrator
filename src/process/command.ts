import { spawn } from 'node:child_process';

export interface ProcessCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onStdoutChunk?: (chunk: string) => void | Promise<void>;
  onStderrChunk?: (chunk: string) => void | Promise<void>;
}

export interface ProcessCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
    const callbackTasks: Array<Promise<void>> = [];
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ? { ...options.env } : process.env,
      shell: options.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

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
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        }, 2_000).unref();
      }, options.idleTimeoutMs);
      idleTimeout.unref();
    };
    resetIdleTimeout();

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      scheduleCallback(options.onStdoutChunk, chunk);
      resetIdleTimeout();
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      scheduleCallback(options.onStderrChunk, chunk);
      resetIdleTimeout();
    });
    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!settled) {
                child.kill('SIGKILL');
              }
            }, 2_000).unref();
          }, options.timeoutMs)
        : undefined;
    timeout?.unref();
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
      const finish = async () => {
        await Promise.all(callbackTasks);
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
