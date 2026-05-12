import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

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

interface ScreenshotArtifactSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
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
  const runtimeDir = runnerVisualProofRuntimeDir(input.worktreePath, input.issueNumber);
  const playwrightProfileDir = join(runtimeDir, 'playwright-profile');
  const playwrightBrowsersDir = join(runtimeDir, 'ms-playwright');
  await mkdir(proofDir, { recursive: true });
  await mkdir(playwrightProfileDir, { recursive: true });
  await mkdir(playwrightBrowsersDir, { recursive: true });

  const command = renderVisualProofCommand(commandTemplate, input, proofDir);
  const before = new Map((await listScreenshotArtifacts(input.worktreePath, proofDir)).map((artifact) => [artifact.path, artifact]));
  const result = await input.shellExecutor(command, {
    cwd: input.worktreePath,
    env: {
      ...runnerCommandBaseEnv(),
      ...runnerPassthroughEnv(input.config.reviewGates.visualProof.envPassthrough ?? []),
      CODEX_ORCHESTRATOR_ISSUE_NUMBER: String(input.issueNumber),
      CODEX_ORCHESTRATOR_ARTIFACT_DIR: input.config.reviewGates.visualProof.artifactDir,
      CODEX_ORCHESTRATOR_PROOF_DIR: proofDir,
      CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR: playwrightProfileDir,
      CODEX_ORCHESTRATOR_WORKTREE_PATH: input.worktreePath,
      CODEX_ORCHESTRATOR_CHANGED_FILES: input.changedFiles.join('\n'),
      PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersDir,
    },
    timeoutMs: input.config.reviewGates.visualProof.runnerTimeoutMs,
  });
  const after = await listScreenshotArtifacts(input.worktreePath, proofDir);
  const produced = after.filter((artifact) => {
    const previous = before.get(artifact.path);
    return !previous
      || previous.size !== artifact.size
      || previous.mtimeMs !== artifact.mtimeMs
      || previous.hash !== artifact.hash;
  });
  const artifacts = produced.map(({ path }) => ({
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

  const requiredArtifactCount = input.config.reviewGates.visualProof.minScreenshotArtifacts;
  if (artifacts.length < requiredArtifactCount) {
    return {
      validation: [{
        command,
        status: 'failed',
        summary: `runner visual proof failed: command completed but did not produce a screenshot artifact under ${input.config.reviewGates.visualProof.artifactDir}/issue-${input.issueNumber}; ${requiredArtifactCount} required.`,
      }],
      artifacts,
    };
  }

  return {
    validation: [{
      command,
      status: 'passed',
      summary: `runner visual proof passed: Playwright/screenshot command completed with ${artifacts.length} screenshot artifact(s).`,
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

function runnerPassthroughEnv(names: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
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

function runnerVisualProofRuntimeDir(worktreePath: string, issueNumber: number): string {
  const key = createHash('sha256')
    .update(`${worktreePath}\0${issueNumber}`)
    .digest('hex')
    .slice(0, 16);
  const tempRoot = join(tmpdir(), 'codex-orchestrator-visual-proof-runtime');
  const runtimeRoot = isPathInside(worktreePath, tempRoot)
    ? join(dirname(worktreePath), '.codex-orchestrator-visual-proof-runtime')
    : tempRoot;
  return join(runtimeRoot, `issue-${issueNumber}-${key}`);
}

async function listScreenshotArtifacts(worktreePath: string, proofDir: string): Promise<ScreenshotArtifactSnapshot[]> {
  const paths = await listFiles(proofDir);
  const artifacts = await Promise.all(paths
    .filter((path) => isCollectableScreenshotPath(path, proofDir))
    .map(async (path) => {
      const [info, contents] = await Promise.all([stat(path), readFile(path)]);
      return {
        path: normalizePath(relative(worktreePath, path)),
        size: info.size,
        mtimeMs: info.mtimeMs,
        hash: createHash('sha256').update(contents).digest('hex'),
      };
    }));
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function isCollectableScreenshotPath(path: string, proofDir: string): boolean {
  if (!/\.(png|jpe?g|webp)$/iu.test(path)) {
    return false;
  }

  const pathWithinProofDir = normalizePath(relative(proofDir, path));
  const topLevelDirectory = pathWithinProofDir.split('/')[0];
  return topLevelDirectory !== 'playwright-profile' && topLevelDirectory !== 'ms-playwright';
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

function isPathInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length === 0 || (!path.startsWith('..') && !isAbsolute(path));
}
