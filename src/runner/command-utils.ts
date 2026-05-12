import { readFile } from 'node:fs/promises';

import { validateConfig, type CodexOrchestratorConfig } from '../config/schema.js';
import type { SessionCommitInfo } from '../git/worktree.js';
import type { ShellCommandExecutor } from '../process/command.js';
import { projectConfigPath } from '../setup/project-config.js';
import type { ScopedCompletionReport } from './completion-report.js';

export async function readRunnerConfig(targetRoot: string): Promise<CodexOrchestratorConfig> {
  const content = await readFile(projectConfigPath(targetRoot), 'utf8');
  const parsed = withRuntimeConfigDefaults(JSON.parse(content) as unknown);
  const validation = validateConfig(parsed);
  if (!validation.ok) {
    throw new Error(`Invalid config: ${validation.errors.join('; ')}`);
  }
  return validation.value;
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
  if ('allowAgentLocalCommits' in runner) {
    return value;
  }
  return {
    ...root,
    runner: {
      ...runner,
      allowAgentLocalCommits: false,
    },
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

export function renderCommitEvidence(commits: SessionCommitInfo[]): string[] {
  if (commits.length === 0) {
    return ['- none'];
  }
  return commits.map((commit) => `- ${commit.sha.slice(0, 12)} ${commit.subject}`);
}

export interface RunnerValidationLine {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
}

export async function runConfiguredChecks(
  config: CodexOrchestratorConfig,
  worktreePath: string,
  shellExecutor: ShellCommandExecutor,
  reportValidation: RunnerValidationLine[],
): Promise<RunnerValidationLine[]> {
  const lines = [...reportValidation];
  for (const [name, command] of Object.entries(config.checks)) {
    const result = await shellExecutor(command, { cwd: worktreePath });
    lines.push({
      command,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      summary: `${name}: ${result.exitCode === 0 ? 'passed' : result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    });
  }
  return lines;
}
