import { homedir } from 'node:os';
import { join } from 'node:path';

import { forbiddenCodexProfileEnvKeys, type CodexOrchestratorConfig, type CodexPhase, type CodexProfileConfig } from '../config/schema.js';
import type { ProcessExecutor } from '../process/command.js';
import { defaultProcessExecutor } from '../process/command.js';
import { RunLogWriter } from '../runner/run-log.js';
import { ensureMobileDeviceGuardBin, prependPath } from './mobile-device-guard.js';

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
  phase?: CodexPhase;
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
    const phase = input.phase ?? 'scoped-issue';
    const effectiveProfile = resolveCodexProfile(this.config, phase);
    const profileTimeoutMs = this.config.codex.profiles?.[phase]?.timeoutMs;
    const args = effectiveProfile.args.map((arg) => renderCodexArg(arg, input));
    const logWriter = input.logPath ? new RunLogWriter(input.logPath) : undefined;
    const mobileDeviceGuardBin = await ensureMobileDeviceGuardBin({ targetRoot: input.targetRoot, config: input.config });
    await logWriter?.appendLifecycle(`starting ${effectiveProfile.command} ${args.join(' ')}`);
    try {
      const result = await this.executor(effectiveProfile.command, args, {
        cwd: input.worktreePath,
        stdin: input.promptText,
        env: buildCodexProcessEnv(input, process.env, effectiveProfile.env, mobileDeviceGuardBin),
        timeoutMs: profileTimeoutMs ?? input.timeoutMs ?? this.config.codex.timeoutMs,
        idleTimeoutMs: effectiveProfile.idleTimeoutMs,
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
  profileEnv: Record<string, string> = {},
  mobileDeviceGuardBin?: string,
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
  for (const [key, value] of Object.entries(profileEnv)) {
    if (!forbiddenCodexProfileEnvKeys.has(key)) {
      env[key] = renderCodexArg(value, input);
    }
  }
  if (mobileDeviceGuardBin) {
    env.PATH = prependPath(env.PATH, mobileDeviceGuardBin);
    env.CODEX_ORCHESTRATOR_MOBILE_DEVICE_GUARD = '1';
  }
  env.HOME = input.isolatedHomePath;
  env[input.config.codex.promptFileEnv] = input.promptPath;
  env[input.config.codex.reportFileEnv] = input.reportPath;
  return env;
}

export interface EffectiveCodexProfile {
  phase: CodexPhase;
  command: string;
  args: string[];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  env: Record<string, string>;
}

export function resolveCodexProfile(config: CodexOrchestratorConfig, phase: CodexPhase): EffectiveCodexProfile {
  const profile: CodexProfileConfig = config.codex.profiles?.[phase] ?? {};
  return {
    phase,
    command: profile.command ?? config.codex.command,
    args: profile.args ?? config.codex.args,
    timeoutMs: profile.timeoutMs ?? config.codex.timeoutMs,
    idleTimeoutMs: profile.idleTimeoutMs ?? config.codex.idleTimeoutMs,
    env: profile.env ?? {},
  };
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
