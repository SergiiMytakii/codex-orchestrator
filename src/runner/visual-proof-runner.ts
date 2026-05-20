import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import { normalizePath } from '../path-policy.js';
import type { ShellCommandExecutor } from '../process/command.js';
import type { ScopedCompletionReport } from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import {
  assertAcceptanceProofReport,
  evaluateAcceptanceProofReport,
  type AcceptanceProofReport,
} from './acceptance-proof.js';
import { runnerVisualProofPolicy, shouldApplyVisualProofGate } from './review-gate-policy.js';

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
  targetRoot?: string;
  worktreePath: string;
  changedFiles: string[];
  report: ScopedCompletionReport;
  shellExecutor: ShellCommandExecutor;
}

export interface RunnerVisualProofResult {
  validation: RunnerValidationLine[];
  artifacts: ScopedCompletionReport['artifacts'];
}

export async function runRunnerVisualProof(input: RunnerVisualProofInput): Promise<RunnerVisualProofResult> {
  const policy = runnerVisualProofPolicy(input.config);
  const commandTemplate = policy.commandTemplate;
  if (!commandTemplate || !shouldApplyVisualProofGate(input)) {
    return { validation: [], artifacts: [] };
  }

  const proofDir = join(
    input.worktreePath,
    policy.artifactDir,
    `issue-${input.issueNumber}`,
  );
  const runtimeDir = runnerVisualProofRuntimeDir(input.worktreePath, input.issueNumber);
  const playwrightProfileDir = join(runtimeDir, 'playwright-profile');
  const playwrightBrowsersDir = join(runtimeDir, 'ms-playwright');
  const proofReportPath = join(proofDir, 'acceptance-proof-report.json');
  await mkdir(proofDir, { recursive: true });
  await mkdir(playwrightProfileDir, { recursive: true });
  await mkdir(playwrightBrowsersDir, { recursive: true });

  const command = renderVisualProofCommand(commandTemplate, input, proofDir, policy.artifactDir);
  const before = new Map((await listScreenshotArtifacts(input.worktreePath, proofDir)).map((artifact) => [artifact.path, artifact]));
  const result = await input.shellExecutor(command, {
    cwd: input.worktreePath,
    env: {
      ...runnerCommandBaseEnv(),
      ...runnerPassthroughEnv(policy.envPassthrough),
      ...runnerSharedStateEnv(input),
      CODEX_ORCHESTRATOR_ISSUE_NUMBER: String(input.issueNumber),
      CODEX_ORCHESTRATOR_ARTIFACT_DIR: policy.artifactDir,
      CODEX_ORCHESTRATOR_PROOF_DIR: proofDir,
      CODEX_ORCHESTRATOR_PROOF_REPORT_PATH: proofReportPath,
      CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR: playwrightProfileDir,
      CODEX_ORCHESTRATOR_WORKTREE_PATH: input.worktreePath,
      CODEX_ORCHESTRATOR_CHANGED_FILES: input.changedFiles.join('\n'),
      PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersDir,
    },
    timeoutMs: policy.timeoutMs,
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
  const proofReport = await readAcceptanceProofReport(proofReportPath);
  if (proofReport.kind === 'invalid') {
    return {
      validation: [{
        command,
        status: 'failed',
        summary: proofReport.message,
      }],
      artifacts,
    };
  }
  if (proofReport.kind === 'valid') {
    const evaluation = evaluateAcceptanceProofReport({
      config: input.config,
      report: proofReport.report,
      proofPhaseChangedFiles: [],
      artifactExists: (path) => existsSync(join(input.worktreePath, path)),
    });
    if (result.exitCode !== 0) {
      return {
        validation: [{
          command,
          status: 'failed',
          summary: `runner acceptance proof failed: command exited ${result.exitCode}; ${result.stderr || result.stdout || 'no output'}`,
        }],
        artifacts: mergeProofArtifacts(artifacts, proofReport.report.artifacts),
      };
    }
    return {
      validation: [{
        command,
        status: evaluation.ok ? 'passed' : 'failed',
        summary: evaluation.ok
          ? `runner acceptance proof passed: ${proofReport.report.criteria.length} criterion/criteria mapped to artifacts.`
          : `runner acceptance proof failed: ${evaluation.reasons.join('; ')}`,
      }],
      artifacts: mergeProofArtifacts(artifacts, proofReport.report.artifacts),
    };
  }

  if (result.exitCode !== 0) {
    return {
      validation: [{
        command,
        status: policy.blockOnMissingProof ? 'failed' : 'skipped',
        summary: `${policy.blockOnMissingProof ? 'runner acceptance proof failed' : 'runner visual proof warning'}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
      }],
      artifacts,
    };
  }

  const requiredArtifactCount = policy.minScreenshotArtifacts;
  if (artifacts.length < requiredArtifactCount) {
    return {
      validation: [{
        command,
        status: policy.blockOnMissingProof ? 'failed' : 'skipped',
        summary: `${policy.blockOnMissingProof ? 'runner acceptance proof failed' : 'runner visual proof warning'}: command completed but did not produce a screenshot artifact under ${policy.artifactDir}/issue-${input.issueNumber}; ${requiredArtifactCount} required.`,
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

type AcceptanceProofReportReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'valid'; report: AcceptanceProofReport };

async function readAcceptanceProofReport(path: string): Promise<AcceptanceProofReportReadResult> {
  let content = '';
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    assertAcceptanceProofReport(parsed);
    return { kind: 'valid', report: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid acceptance proof report';
    return { kind: 'invalid', message };
  }
}

function mergeProofArtifacts(
  screenshots: ScopedCompletionReport['artifacts'],
  proofArtifacts: ScopedCompletionReport['artifacts'],
): ScopedCompletionReport['artifacts'] {
  const seen = new Set(screenshots.map((artifact) => artifact.url ?? artifact.path ?? artifact.description));
  const merged = [...screenshots];
  for (const artifact of proofArtifacts) {
    const key = artifact.url ?? artifact.path ?? artifact.description;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(artifact);
  }
  return merged;
}

function runnerSharedStateEnv(input: RunnerVisualProofInput): Record<string, string> {
  if (!input.targetRoot) {
    return {};
  }
  const stateDir = join(input.targetRoot, input.config.runner.stateDir);
  return {
    CODEX_ORCHESTRATOR_TARGET_ROOT: input.targetRoot,
    CODEX_ORCHESTRATOR_STATE_DIR: stateDir,
    CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_DIR: join(stateDir, 'mobile-device-locks'),
  };
}

function runnerCommandBaseEnv(): Record<string, string> {
  const keys = [
    'PATH',
    'HOME',
    'USER',
    'TMPDIR',
    'SHELL',
    'ANDROID_HOME',
    'ANDROID_SDK_ROOT',
    'ANDROID_SERIAL',
    'LOCALAPPDATA',
    'USERPROFILE',
    'APPDATA',
    'FLUTTER_ROOT',
    'PUB_CACHE',
    'GRADLE_USER_HOME',
    'CODEX_ORCHESTRATOR_ADB',
    'CODEX_ORCHESTRATOR_EMULATOR',
    'CODEX_ORCHESTRATOR_TARGET_ROOT',
    'CODEX_ORCHESTRATOR_STATE_DIR',
    'CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_DIR',
    'CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_TIMEOUT_MS',
    'CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_STALE_MS',
    'CODEX_ORCHESTRATOR_FLUTTER_BIN',
    'CODEX_ORCHESTRATOR_FLUTTER_ROOT',
    'CODEX_ORCHESTRATOR_FLUTTER_LAUNCH_CONFIG',
    'CODEX_ORCHESTRATOR_FLUTTER_TARGET',
    'CODEX_ORCHESTRATOR_MOBILE_PROJECT_TYPE',
    'CODEX_ORCHESTRATOR_ANDROID_PROJECT_TYPE',
    'CODEX_ORCHESTRATOR_ANDROID_FLAVOR',
    'CODEX_ORCHESTRATOR_ANDROID_PACKAGE',
    'CODEX_ORCHESTRATOR_ANDROID_GRADLE_INSTALL_TASK',
    'CODEX_ORCHESTRATOR_ANDROID_LAUNCH_SETTLE_MS',
    'CODEX_ORCHESTRATOR_IOS_PROJECT_TYPE',
    'CODEX_ORCHESTRATOR_IOS_FLAVOR',
    'CODEX_ORCHESTRATOR_IOS_BUNDLE_ID',
    'CODEX_ORCHESTRATOR_IOS_SCHEME',
    'CODEX_ORCHESTRATOR_IOS_LAUNCH_SETTLE_MS',
  ];
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

function renderVisualProofCommand(
  command: string,
  input: RunnerVisualProofInput,
  proofDir: string,
  artifactDir: string,
): string {
  return command
    .replaceAll('${issueNumber}', String(input.issueNumber))
    .replaceAll('${artifactDir}', artifactDir)
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

function isPathInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length === 0 || (!path.startsWith('..') && !isAbsolute(path));
}
