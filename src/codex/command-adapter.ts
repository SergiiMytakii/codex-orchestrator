import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { ProcessExecutor } from '../process/command.js';
import { defaultProcessExecutor } from '../process/command.js';
import { RunLogWriter } from '../runner/run-log.js';

export interface CodexCommandRunInput {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  worktreePath: string;
  promptPath: string;
  promptText: string;
  reportPath: string;
  isolatedHomePath: string;
  issueNumber: number;
  sessionId: string;
  branchName: string;
  timeoutMs?: number;
  logPath?: string;
}

export interface CodexCommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  logPath?: string;
}

export class CodexCommandAdapter {
  public constructor(
    private readonly config: CodexOrchestratorConfig,
    private readonly executor: ProcessExecutor = defaultProcessExecutor,
  ) {}

  public async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
    const args = this.config.codex.args.map((arg) => renderCodexArg(arg, input));
    const logWriter = input.logPath ? new RunLogWriter(input.logPath) : undefined;
    await logWriter?.appendLifecycle(`starting ${this.config.codex.command} ${args.join(' ')}`);
    try {
      const result = await this.executor(this.config.codex.command, args, {
        cwd: input.worktreePath,
        stdin: input.promptText,
        env: buildCodexProcessEnv(input, process.env),
        timeoutMs: input.timeoutMs ?? this.config.codex.timeoutMs,
        idleTimeoutMs: this.config.codex.idleTimeoutMs,
        onStdoutChunk: logWriter ? (chunk) => logWriter.appendStdout(chunk) : undefined,
        onStderrChunk: logWriter ? (chunk) => logWriter.appendStderr(chunk) : undefined,
      });
      return { ...result, logPath: input.logPath };
    } finally {
      await logWriter?.close();
    }
  }
}

export function buildCodexProcessEnv(
  input: CodexCommandRunInput,
  sourceEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const allowed = ['PATH', 'CODEX_HOME', 'LANG', 'LC_ALL', 'TMPDIR'];
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = sourceEnv[key];
    if (value) {
      env[key] = value;
    }
  }
  env.CODEX_HOME = env.CODEX_HOME || join(homedir(), '.codex');
  env.HOME = input.isolatedHomePath;
  env[input.config.codex.promptFileEnv] = input.promptPath;
  env[input.config.codex.reportFileEnv] = input.reportPath;
  return env;
}

function renderCodexArg(arg: string, input: CodexCommandRunInput): string {
  return arg
    .replaceAll('${targetRoot}', input.targetRoot)
    .replaceAll('${stateDir}', join(input.targetRoot, input.config.runner.stateDir))
    .replaceAll('${worktreePath}', input.worktreePath)
    .replaceAll('${promptFile}', input.promptPath)
    .replaceAll('${promptPath}', input.promptPath)
    .replaceAll('${reportFile}', input.reportPath)
    .replaceAll('${reportPath}', input.reportPath)
    .replaceAll('${issueNumber}', String(input.issueNumber))
    .replaceAll('${sessionId}', input.sessionId)
    .replaceAll('${branchName}', input.branchName);
}
