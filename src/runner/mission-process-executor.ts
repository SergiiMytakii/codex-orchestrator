import { spawn } from 'node:child_process';

import { scrubMissionExecutorEnv } from './mission-capability-kernel.js';

export interface MissionProcessInput {
  file: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  sourceEnv: NodeJS.ProcessEnv;
  allowedEnvKeys: string[];
  stdin?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number | undefined) => void;
}

export interface MissionProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  termination: 'exited' | 'timeout' | 'output-limit' | 'stdin-error' | 'cancelled';
}

export interface MissionProcessDependencies {
  terminateProcessGroup?: (pid: number | undefined, signal: NodeJS.Signals) => void;
  terminateChild?: (signal: NodeJS.Signals) => void;
}

export function runMissionProcess(
  input: MissionProcessInput,
  dependencies: MissionProcessDependencies = {},
): Promise<MissionProcessResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('Mission process timeoutMs must be a positive integer.');
  }
  if (input.file.trim().length === 0 || input.args.some((arg) => arg.includes('\0'))) {
    throw new Error('Mission process requires a valid argv command.');
  }
  const maxOutputBytes = input.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error('Mission process maxOutputBytes must be a positive integer.');
  }
  if (input.signal?.aborted) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      exitCode: 130,
      timedOut: false,
      termination: 'cancelled',
    });
  }
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let termination: 'timeout' | 'output-limit' | 'stdin-error' | 'cancelled' | undefined;
    let outputBytes = 0;
    let settled = false;
    let terminationError: Error | undefined;
    let inputError: Error | undefined;
    let closeExitCode: number | null | undefined;
    let escalationComplete = false;
    let settlementTimeout: NodeJS.Timeout | undefined;
    const child = spawn(input.file, input.args, {
      cwd: input.cwd,
      env: scrubMissionExecutorEnv(input.sourceEnv, input.allowedEnvKeys),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const onAbort = () => beginTermination('cancelled');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { collectOutput('stdout', chunk); });
    child.stderr.on('data', (chunk: Buffer) => { collectOutput('stderr', chunk); });
    const timeout = setTimeout(() => {
      beginTermination('timeout');
    }, input.timeoutMs);
    timeout.unref();

    try {
      input.onSpawn?.(child.pid);
    } catch (error) {
      inputError = error instanceof Error ? error : new Error(String(error));
      beginTermination('stdin-error');
    }
    if (input.signal?.aborted) beginTermination('cancelled');

    function beginTermination(reason: 'timeout' | 'output-limit' | 'stdin-error' | 'cancelled'): void {
      if (termination || settled) return;
      termination = reason;
      clearTimeout(timeout);
      requestTermination(child.pid, 'SIGTERM');
      setTimeout(() => {
        if (settled) return;
        requestTermination(child.pid, 'SIGKILL');
        escalationComplete = true;
        if (closeExitCode !== undefined) {
          finishClose(closeExitCode);
        } else {
          settlementTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            input.signal?.removeEventListener('abort', onAbort);
            reject(terminationError ?? inputError
              ?? new Error('Mission process did not terminate after SIGKILL reconciliation.'));
          }, 500);
        }
      }, 250);
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      if (settlementTimeout) clearTimeout(settlementTimeout);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      clearTimeout(timeout);
      closeExitCode = exitCode;
      if (termination && !escalationComplete) return;
      finishClose(exitCode);
    });
    child.stdin.on('error', (error) => {
      if (settled) return;
      inputError ??= new Error(`Mission process stdin failed: ${error.message}`, { cause: error });
      beginTermination('stdin-error');
    });
    child.stdin.end(input.stdin);

    function finishClose(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener('abort', onAbort);
      if (settlementTimeout) clearTimeout(settlementTimeout);
      if (terminationError) {
        reject(terminationError);
        return;
      }
      if (inputError) {
        reject(inputError);
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode: termination === 'timeout' ? 124
          : termination === 'output-limit' ? 125
            : termination === 'cancelled' ? 130 : (exitCode ?? 1),
        timedOut: termination === 'timeout',
        termination: termination ?? 'exited',
      });
    }

    function collectOutput(target: 'stdout' | 'stderr', chunk: Buffer): void {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      const accepted = chunk.subarray(0, remaining);
      if (accepted.byteLength > 0) {
        if (target === 'stdout') stdout += accepted.toString('utf8');
        else stderr += accepted.toString('utf8');
        outputBytes += accepted.byteLength;
      }
      if (chunk.byteLength > remaining) beginTermination('output-limit');
    }

    function requestTermination(pid: number | undefined, signal: NodeJS.Signals): void {
      try {
        (dependencies.terminateProcessGroup ?? terminateProcessGroup)(pid, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminationError ??= new Error(`Mission process failed to terminate process group: ${message}`);
        try {
          (dependencies.terminateChild ?? ((childSignal) => { child.kill(childSignal); }))(signal);
        } catch {
          // The stored termination error is reported when the child closes.
        }
      }
    }
  });
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
}
