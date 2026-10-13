import { CommandProcessQuiescenceError, defaultProcessExecutor, type ProcessCommandOptions, type ProcessExecutor } from './command.js';
import { setTimeout as delay } from 'node:timers/promises';

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
    const timeoutMs = commandOptions.timeoutMs ?? options.timeoutMs ?? githubCollectionDeadlineMs;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await executor(file, args, { ...commandOptions, signal, timeoutMs: Math.max(1, deadline - Date.now()) });
      } catch (error) {
        const pauseMs = 250 * (attempt + 1);
        if (attempt >= 2 || signal?.aborted || !isGitHubRead(file, args)
          || !isTemporaryGitHubError(error) || deadline - Date.now() <= pauseMs) throw error;
        try { await delay(pauseMs, undefined, { signal }); }
        catch { throw error; }
        if (signal?.aborted || Date.now() >= deadline) throw error;
      }
    }
  };
  if (ownedExecutors.has(executor)) ownedExecutors.add(execute);
  return execute;
}

function isGitHubRead(file: string, args: string[]): boolean {
  if (file !== 'gh') return false;
  if (['issue', 'pr', 'repo'].includes(args[0] ?? '') && ['view', 'list'].includes(args[1] ?? '')) return true;
  const methodIndex = args.findIndex((arg) => arg === '--method' || arg === '-X');
  if (args[0] !== 'api') return false;
  if (methodIndex >= 0) return args[methodIndex + 1] === 'GET';
  if (args[1] !== 'graphql') return false;
  const query = args.find((arg) => arg.startsWith('query='))?.slice('query='.length).trimStart();
  return query !== undefined && /^query(?:\s|\()/u.test(query);
}

function isTemporaryGitHubError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof CommandProcessQuiescenceError) return false;
  const detail = `${error.message} ${(error as CommandExecutionError).stderr ?? ''}`;
  return /\bHTTP (?:429|5\d\d)\b|\b(?:API rate limit exceeded|secondary rate limit|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|TLS handshake timeout|i\/o timeout|connection reset by peer|temporary failure in name resolution)\b/iu.test(detail);
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
