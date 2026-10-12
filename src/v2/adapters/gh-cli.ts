import { defaultProcessExecutor, type ProcessCommandOptions, type ProcessExecutor } from './command.js';

export interface CommandResult { stdout: string; stderr: string }
export type CommandExecutor = (file: string, args: string[], options?: ProcessCommandOptions) => Promise<CommandResult>;
export interface CommandExecutionError extends Error { code?: number; stderr?: string }

export const githubCollectionDeadlineMs = 60_000;
const githubPageBytes = 16 * 1024 * 1024;

const ownedExecutors = new WeakSet<CommandExecutor>();

/** Preserve the shared Runner executor's termination and ownership guarantees. */
export function ghExecutorFromProcessExecutor(executor: ProcessExecutor): CommandExecutor {
  const execute: CommandExecutor = async (file, args, options = {}) => {
    const result = await executor(file, args, {
      ...options, timeoutMs: options.timeoutMs ?? githubCollectionDeadlineMs,
      processGroup: true, maxOutputBytes: githubPageBytes,
    });
    if (result.exitCode !== 0) {
      const error = new Error(`Failed to run ${file}: exit ${result.exitCode}`) as CommandExecutionError;
      error.code = result.exitCode;
      error.stderr = result.stderr;
      throw error;
    }
    return { stdout: result.stdout, stderr: result.stderr };
  };
  ownedExecutors.add(execute);
  return execute;
}

export const defaultGhExecutor: CommandExecutor = ghExecutorFromProcessExecutor(defaultProcessExecutor);

export interface GitHubExecutionOptions { timeoutMs?: number; signal?: AbortSignal }

/** Apply the Runner's cancellation to each read and write as well as paged reads. */
export function githubExecutor(executor: CommandExecutor, options: GitHubExecutionOptions = {}): CommandExecutor {
  const execute: CommandExecutor = async (file, args, commandOptions = {}) => {
    const signal = commandOptions.signal ?? options.signal;
    if (signal?.aborted) throw new Error('GitHub collection deadline or cancellation');
    return executor(file, args, { ...commandOptions, signal, timeoutMs: commandOptions.timeoutMs ?? options.timeoutMs ?? githubCollectionDeadlineMs });
  };
  if (ownedExecutors.has(executor)) ownedExecutors.add(execute);
  return execute;
}

/** One deadline for the complete collection, with individually bounded pages. */
export function githubCollectionExecutor(executor: CommandExecutor, options: GitHubExecutionOptions = {}): CommandExecutor {
  const deadline = Date.now() + (options.timeoutMs ?? githubCollectionDeadlineMs);
  return async (file, args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || options.signal?.aborted) throw new Error('GitHub collection deadline or cancellation');
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    let abortReject: (() => void) | undefined;
    try {
      timer = setTimeout(abort, remaining);
      // Production commands return only after the owned process group is quiescent,
      // or after the shared executor has fenced its unresolved ownership.
      const cancelled = ownedExecutors.has(executor) ? undefined : new Promise<never>((_resolve, reject) => {
        abortReject = () => reject(new Error('GitHub collection deadline or cancellation'));
        controller.signal.addEventListener('abort', abortReject, { once: true });
      });
      const request = executor(file, args, { timeoutMs: remaining, signal: controller.signal, processGroup: true, maxOutputBytes: githubPageBytes });
      const result = cancelled ? await Promise.race([request, cancelled]) : await request;
      if (controller.signal.aborted) throw new Error('GitHub collection deadline or cancellation');
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > githubPageBytes) throw new Error('GitHub page response exceeds its byte bound');
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (abortReject) controller.signal.removeEventListener('abort', abortReject);
    }
  };
}

export async function githubRestCollection(executor: CommandExecutor, endpoint: string, fields: string[] = [], jq?: string): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const result = await executor('gh', ['api', '--method', 'GET', endpoint, '-f', 'per_page=100', '-f', `page=${page}`, ...fields, ...(jq ? ['--jq', jq] : [])]);
    const parsed = jq ? result.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown) : JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('GitHub page must contain at most 100 items');
    items.push(...parsed);
    if (parsed.length < 100) return items;
  }
}
