import { spawn } from 'node:child_process';

export interface ProcessCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
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
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}
