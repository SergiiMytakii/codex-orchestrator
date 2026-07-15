import { readFile } from 'node:fs/promises';

import { validateConfig, type CheckExecutionPhase, type CodexOrchestratorConfig } from '../config/schema.js';
import { globMatches } from '../path-policy.js';
import type { ShellCommandExecutor } from '../process/command.js';
import {
  applyTargetPackageConfigDefaults,
  defaultAcceptanceProofConfig,
  defaultRiskRoutingConfig,
  projectConfigPath,
} from '../setup/project-config.js';
import type { ScopedCompletionReport } from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';

export interface RunConfiguredChecksOptions {
  phase?: CheckExecutionPhase;
  changedFiles?: string[];
}

export async function readRunnerConfig(targetRoot: string): Promise<CodexOrchestratorConfig> {
  const content = await readFile(projectConfigPath(targetRoot), 'utf8');
  const withDefaults = withRuntimeConfigDefaults(JSON.parse(content) as unknown);
  const preValidation = validateConfig(withDefaults);
  if (!preValidation.ok) {
    throw new Error(`Invalid config: ${preValidation.errors.join('; ')}`);
  }
  const parsed = await applyTargetPackageConfigDefaults(targetRoot, preValidation.value);
  const validation = validateConfig(parsed);
  if (!validation.ok) {
    throw new Error(`Invalid config: ${validation.errors.join('; ')}`);
  }
  return validation.value;
}

export async function rereadRunnerConfigUnderFence(
  targetRoot: string,
  fencedStateDir: string,
): Promise<CodexOrchestratorConfig> {
  const config = await readRunnerConfig(targetRoot);
  if (config.runner.stateDir !== fencedStateDir) {
    throw new Error(
      `target-activity-fence-config-changed: runner.stateDir changed from ${fencedStateDir} to ${config.runner.stateDir}.`,
    );
  }
  return config;
}

function withRuntimeConfigDefaults(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const root = value as Record<string, unknown>;
  if (typeof root.runner !== 'object' || root.runner === null || Array.isArray(root.runner)) {
    return value;
  }
  const runner = root.runner as Record<string, unknown>;
  const reviewGates = typeof root.reviewGates === 'object' && root.reviewGates !== null && !Array.isArray(root.reviewGates)
    ? root.reviewGates as Record<string, unknown>
    : undefined;
  const visualProof = typeof reviewGates?.visualProof === 'object' && reviewGates.visualProof !== null && !Array.isArray(reviewGates.visualProof)
    ? reviewGates.visualProof as Record<string, unknown>
    : undefined;
  const acceptanceProof = typeof reviewGates?.acceptanceProof === 'object' && reviewGates.acceptanceProof !== null && !Array.isArray(reviewGates.acceptanceProof)
    ? reviewGates.acceptanceProof as Record<string, unknown>
    : undefined;
  const riskRouting = typeof reviewGates?.riskRouting === 'object' && reviewGates.riskRouting !== null && !Array.isArray(reviewGates.riskRouting)
    ? reviewGates.riskRouting as Record<string, unknown>
    : undefined;
  const defaultAcceptanceProof = defaultAcceptanceProofConfig();
  const loopPolicy = typeof root.loopPolicy === 'object' && root.loopPolicy !== null && !Array.isArray(root.loopPolicy)
    ? root.loopPolicy as Record<string, unknown>
    : undefined;
  const rework = typeof loopPolicy?.rework === 'object' && loopPolicy.rework !== null && !Array.isArray(loopPolicy.rework)
    ? loopPolicy.rework as Record<string, unknown>
    : undefined;
  const retryableBlockers = Array.isArray(rework?.retryableBlockers)
    ? rework.retryableBlockers.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    ...root,
    runner: {
      ...runner,
      allowAgentLocalCommits: 'allowAgentLocalCommits' in runner ? runner.allowAgentLocalCommits : false,
    },
    ...(reviewGates
      ? {
          reviewGates: {
            ...reviewGates,
            acceptanceProof: acceptanceProof
              ? { ...defaultAcceptanceProof, ...acceptanceProof }
              : {
                  ...defaultAcceptanceProof,
                  enabled: visualProof?.enabled ?? defaultAcceptanceProof.enabled,
                  artifactDir: visualProof?.artifactDir ?? defaultAcceptanceProof.artifactDir,
                  issueTextPatterns: visualProof?.issueTextPatterns ?? defaultAcceptanceProof.issueTextPatterns,
                  changedPathGlobs: visualProof?.changedPathGlobs ?? defaultAcceptanceProof.changedPathGlobs,
                  runnerValidationCommand: visualProof?.runnerValidationCommand,
                  runnerTimeoutMs: visualProof?.runnerTimeoutMs,
                  envPassthrough: visualProof?.envPassthrough ?? defaultAcceptanceProof.envPassthrough,
                },
            riskRouting: {
              ...defaultRiskRoutingConfig(),
              ...riskRouting,
            },
          },
        }
      : {}),
    ...(loopPolicy && rework && retryableBlockers
      ? {
          loopPolicy: {
            ...loopPolicy,
            rework: {
              ...rework,
              retryableBlockers: Array.from(new Set([
                ...retryableBlockers,
                'idle-timeout-before-change',
                'failed-acceptance-proof',
                'optional-figma-mcp-failure',
              ])),
            },
          },
        }
      : {}),
  };
}

export function bulletList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- none'];
}

export function formatSessionTimestamp(now: Date): string {
  return now.toISOString().replace(/\D/g, '').slice(0, 14);
}

export function mergeArtifacts(
  existing: ScopedCompletionReport['artifacts'],
  additions: ScopedCompletionReport['artifacts'],
): ScopedCompletionReport['artifacts'] {
  const seen = new Set(existing.map((artifact) => artifact.url ?? artifact.path ?? artifact.description));
  const merged = [...existing];
  for (const artifact of additions) {
    const key = artifact.url ?? artifact.path ?? artifact.description;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(artifact);
  }
  return merged;
}

export async function runConfiguredChecks(
  config: CodexOrchestratorConfig,
  worktreePath: string,
  shellExecutor: ShellCommandExecutor,
  reportValidation: RunnerValidationLine[],
  options: RunConfiguredChecksOptions | string[] = {},
): Promise<RunnerValidationLine[]> {
  const lines = [...reportValidation];
  const runOptions = Array.isArray(options) ? { changedFiles: options } : options;
  const changedFiles = runOptions.changedFiles ?? [];
  const policy = config.checksPolicy ?? {};
  const missingNpmScript = policy.missingNpmScript ?? 'skip';
  const lintBaseline = policy.lintBaseline ?? { mode: 'strict' as const };
  const baseEnv = {
    ...currentProcessEnv(),
    CODEX_ORCHESTRATOR_CHANGED_FILES: changedFiles.join('\n'),
    CODEX_ORCHESTRATOR_WORKTREE_PATH: worktreePath,
  };

  for (const [name, command] of Object.entries(config.checks)) {
    const applicability = configuredCheckApplicability({
      name,
      policy,
      phase: runOptions.phase,
      changedFiles,
    });
    if (!applicability.run) {
      lines.push({
        command,
        status: 'skipped',
        summary: `${name}: skipped (${applicability.reason})`,
      });
      continue;
    }

    const result = await shellExecutor(command, { cwd: worktreePath, env: baseEnv });
    if (result.exitCode === 0) {
      lines.push({ command, status: 'passed', summary: `${name}: passed` });
      continue;
    }

    const output = `${result.stderr}\n${result.stdout}`.trim();
    const missingScript = detectMissingNpmScript(output);
    if (missingScript && missingNpmScript === 'skip') {
      lines.push({
        command,
        status: 'skipped',
        summary: `${name}: skipped (missing script: ${missingScript})`,
      });
      continue;
    }

    const looksLikeLint = isLintCheck(name, command);
    if (looksLikeLint && lintBaseline.mode === 'touched-only' && lintBaseline.touchedFilesCommand) {
      const touchedResult = await shellExecutor(lintBaseline.touchedFilesCommand, { cwd: worktreePath, env: baseEnv });
      lines.push({
        command: lintBaseline.touchedFilesCommand,
        status: touchedResult.exitCode === 0 ? 'passed' : 'failed',
        summary: `lint:touched: ${touchedResult.exitCode === 0 ? 'passed' : touchedResult.stderr || touchedResult.stdout || `exit ${touchedResult.exitCode}`}`,
      });
      if (touchedResult.exitCode === 0) {
        lines.push({
          command,
          status: 'skipped',
          summary: `${name}: lint baseline failed (repo-wide lint failed) but touched-files lint passed`,
        });
        continue;
      }
      lines.push({
        command,
        status: 'failed',
        summary: `${name}: ${output || `exit ${result.exitCode}`}`,
      });
      continue;
    }

    lines.push({
      command,
      status: 'failed',
      summary: `${name}: ${output || `exit ${result.exitCode}`}`,
    });
  }
  return lines;
}

function configuredCheckApplicability(input: {
  name: string;
  policy: NonNullable<CodexOrchestratorConfig['checksPolicy']>;
  phase?: CheckExecutionPhase;
  changedFiles: string[];
}): { run: true } | { run: false; reason: string } {
  const scope = input.policy.scope?.[input.name];
  if (!scope) {
    return { run: true };
  }

  if (input.phase && scope.phases && !scope.phases.includes(input.phase)) {
    return { run: false, reason: `not configured for ${input.phase}` };
  }

  if (input.phase === 'child' && scope.changedPathGlobs && scope.changedPathGlobs.length > 0) {
    const matchesChangedPath = input.changedFiles.some((path) =>
      scope.changedPathGlobs?.some((pattern) => globMatches(pattern, path)),
    );
    if (!matchesChangedPath) {
      return { run: false, reason: 'no changed files matched configured scope' };
    }
  }

  return { run: true };
}

function currentProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function detectMissingNpmScript(output: string): string | undefined {
  const match = output.match(/Missing script:\s*"?([^"\n]+)"?/iu);
  return match?.[1]?.trim() || undefined;
}

function isLintCheck(name: string, command: string): boolean {
  return name.toLowerCase().includes('lint') || /\blint\b/iu.test(command);
}
