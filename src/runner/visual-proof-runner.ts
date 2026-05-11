import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ShellCommandExecutor } from '../process/command.js';
import type { ScopedCompletionReport } from './prompt.js';
import { shouldApplyVisualProofGate } from './review-gates.js';

interface ValidationLine {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
}

export interface RunnerVisualProofInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  issueNumber: number;
  worktreePath: string;
  changedFiles: string[];
  report: ScopedCompletionReport;
  shellExecutor: ShellCommandExecutor;
}

export interface RunnerVisualProofResult {
  validation: ValidationLine[];
  artifacts: ScopedCompletionReport['artifacts'];
}

export async function runRunnerVisualProof(input: RunnerVisualProofInput): Promise<RunnerVisualProofResult> {
  const commandTemplate = input.config.reviewGates.visualProof.runnerValidationCommand?.trim();
  if (!commandTemplate || !shouldApplyVisualProofGate(input)) {
    return { validation: [], artifacts: [] };
  }

  const proofDir = join(
    input.worktreePath,
    input.config.reviewGates.visualProof.artifactDir,
    `issue-${input.issueNumber}`,
  );
  await mkdir(proofDir, { recursive: true });

  const before = new Set(await listScreenshotArtifacts(input.worktreePath, proofDir));
  const command = renderVisualProofCommand(commandTemplate, input, proofDir);
  const result = await input.shellExecutor(command, {
    cwd: input.worktreePath,
    env: {
      ...runnerCommandBaseEnv(),
      CODEX_ORCHESTRATOR_ISSUE_NUMBER: String(input.issueNumber),
      CODEX_ORCHESTRATOR_ARTIFACT_DIR: input.config.reviewGates.visualProof.artifactDir,
      CODEX_ORCHESTRATOR_PROOF_DIR: proofDir,
      CODEX_ORCHESTRATOR_WORKTREE_PATH: input.worktreePath,
      CODEX_ORCHESTRATOR_CHANGED_FILES: input.changedFiles.join('\n'),
    },
  });
  const after = await listScreenshotArtifacts(input.worktreePath, proofDir);
  const newArtifacts = after.filter((path) => !before.has(path));
  const artifacts = newArtifacts.map((path) => ({
    type: 'screenshot' as const,
    path,
    description: `runner visual proof ${path.split('/').at(-1) ?? path}`,
  }));

  if (result.exitCode !== 0) {
    return {
      validation: [{
        command,
        status: 'failed',
        summary: `runner visual proof failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
      }],
      artifacts,
    };
  }

  return {
    validation: [{
      command,
      status: 'passed',
      summary: `runner visual proof created ${artifacts.length} screenshot artifact(s).`,
    }],
    artifacts,
  };
}

function runnerCommandBaseEnv(): Record<string, string> {
  const keys = ['PATH', 'HOME', 'USER', 'TMPDIR', 'SHELL'];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function renderVisualProofCommand(command: string, input: RunnerVisualProofInput, proofDir: string): string {
  return command
    .replaceAll('${issueNumber}', String(input.issueNumber))
    .replaceAll('${artifactDir}', input.config.reviewGates.visualProof.artifactDir)
    .replaceAll('${proofDir}', proofDir)
    .replaceAll('${worktreePath}', input.worktreePath);
}

async function listScreenshotArtifacts(worktreePath: string, proofDir: string): Promise<string[]> {
  const paths = await listFiles(proofDir);
  return paths
    .filter((path) => /\.(png|jpe?g|webp)$/iu.test(path))
    .map((path) => normalizePath(relative(worktreePath, path)))
    .sort();
}

async function listFiles(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      files.push(...await listFiles(path));
      continue;
    }
    if (info.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}
