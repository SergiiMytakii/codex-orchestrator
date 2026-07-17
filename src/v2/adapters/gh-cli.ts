import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (file: string, args: string[]) => Promise<CommandResult>;

export interface CommandExecutionError extends Error {
  code?: number;
  stderr?: string;
}

export async function defaultGhExecutor(file: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(file, args);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    const commandError = new Error(`Failed to run ${file} ${args.join(' ')}: ${message}`) as CommandExecutionError;
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code;
      const stderr = (error as { stderr?: unknown }).stderr;
      if (typeof code === 'number') {
        commandError.code = code;
      }
      if (typeof stderr === 'string') {
        commandError.stderr = stderr;
      }
    }
    throw commandError;
  }
}
