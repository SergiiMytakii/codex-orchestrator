import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import { writeDurableAtomicFile } from './adapters/durable-atomic-file.js';
import { GitWorktreeManager } from './adapters/worktree.js';
import type { GitHubIssueAdapter } from './adapters/issues.js';
import type { GitHubPullRequestAdapter } from './adapters/pull-requests.js';
import { defaultProcessExecutor, type ProcessExecutor } from './adapters/command.js';
import { AcceptanceProof, ProofQuiescenceError, type FrozenCriterion, type IssueSnapshot, type ProofAgent } from './acceptance-proof.js';
import { createCheckedChangeCapabilities, type CheckedChangeFreshness } from './checked-change.js';
import { InjectedContainedReportOperation } from './contained-report-operation.js';
import { ContainedImplementationReviewer } from './implementation-reviewer.js';
import { parseAgentAutoConfig, type AgentAutoConfigV1 } from './config.js';
import { WaitingHumanCoordinator } from './waiting-human-coordinator.js';
import {
  assertContainmentCertificateMatchesRuntime,
  canonicalJson,
  containmentArgvPolicySha256,
  containmentCertificatePath,
  parseJsonWithoutDuplicateKeys,
  readContainmentCertificate,
  sha256,
} from './containment.js';
import { FileProofRecordWriter } from './proof-store.js';
import { acquireOwnerControlLock, OwnerControlLockBlockedError } from './owner-control-lock.js';
import { decodeAgentReportForValidation } from './report-envelope.js';
import { CodexProcess, ProcessQuiescenceError } from './codex-process.js';
import { FileAndroidLeaseVerifier, FileIosLeaseVerifier, type IosLeaseRecordV1 } from './mobile-lease.js';
import { publishRuntimeAssetSnapshot } from './runtime-assets.js';
import { RouteCoordinator } from './route-coordinator.js';
import { SpecCoordinator, type SpecDeliveryOperation } from './spec-coordinator.js';
import { createSpecRevision, type SpecReviewReportV1 } from './spec-delivery.js';
import { validateCodeReviewDefects } from './code-review-report.js';
import { hashRouteDecision, validateRouteReceipt, type RouteReceiptV1 } from './route-decision.js';
import { OwnerLockContentionError, OwnerLockSafetyError, RunIssue, type ImplementationAgentResult, type RunIssueGit } from './run-issue.js';
import { FileRunRecordWriter, type RunRecordWriter } from './run-store.js';
import {
  parseWorkflowExecutionProfile,
  type WorkflowExecutionProfile,
  type WorkflowGenerationReceipt,
  verifyWorkflowGeneration,
  type WorkflowOperationPolicy,
} from './workflow-assets.js';

export class LocalGitRunIssueAdapter implements RunIssueGit {
  private readonly worktrees: GitWorktreeManager;

  constructor(private readonly executor: ProcessExecutor = defaultProcessExecutor) {
    this.worktrees = new GitWorktreeManager(executor);
  }

  async getBaseSha(input: { targetRoot: string; baseBranch: string }): Promise<string> {
    return (await this.git(['-C', input.targetRoot, 'rev-parse', input.baseBranch])).trim();
  }

  async createWorktree(input: {
    targetRoot: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    baseSha: string;
  }): Promise<void> {
    await this.worktrees.createIssueWorktree({
      targetRoot: input.targetRoot,
      workspacePath: input.worktreePath,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      requiredBaseSha: input.baseSha,
    });
  }

  async inspectWorktree(input: { worktreePath: string; branchName: string; baseSha: string }): Promise<'absent' | 'matching' | 'diverged'> {
    try {
      const stat = await lstat(input.worktreePath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return 'diverged';
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return 'absent';
      throw error;
    }
    const [head, branch] = await Promise.all([
      this.getHead(input.worktreePath),
      this.git(['-C', input.worktreePath, 'branch', '--show-current']),
    ]);
    return head === input.baseSha && branch.trim() === input.branchName ? 'matching' : 'diverged';
  }

  async snapshot(worktreePath: string): Promise<Omit<CheckedChangeFreshness, 'checkPolicySha256'>> {
    return this.snapshotWithIgnoredUntrackedRoot(worktreePath);
  }

  async snapshotIgnoringUntrackedRoot(
    worktreePath: string,
    ignoredRoot: string,
  ): Promise<Omit<CheckedChangeFreshness, 'checkPolicySha256'>> {
    validateRelativeRoot(ignoredRoot);
    return this.snapshotWithIgnoredUntrackedRoot(worktreePath, ignoredRoot);
  }

  async fingerprintDeniedPaths(worktreePath: string, deniedPaths: string[]): Promise<string> {
    const root = await realpath(worktreePath);
    const entries: Array<{ path: string; fingerprint: unknown }> = [];
    for (const path of [...deniedPaths].sort()) {
      entries.push({
        path,
        fingerprint: isAbsolute(path)
          ? { kind: 'external-path-not-monitored' }
          : await fingerprintRepositoryPath(root, path),
      });
    }
    return sha256(canonicalJson(entries));
  }

  private async snapshotWithIgnoredUntrackedRoot(
    worktreePath: string,
    ignoredRoot?: string,
  ): Promise<Omit<CheckedChangeFreshness, 'checkPolicySha256'>> {
    const [headSha, indexTreeSha, trackedDiff, untrackedPaths, canonicalPath, gitDirectory] = await Promise.all([
      this.getHead(worktreePath),
      this.getTreeSha(worktreePath),
      this.git(['-C', worktreePath, 'diff', '--binary', 'HEAD']),
      this.git(['-C', worktreePath, 'ls-files', '--others', '--exclude-standard', '-z']),
      realpath(worktreePath),
      this.git(['-C', worktreePath, 'rev-parse', '--git-dir']),
    ]);
    const untracked: Array<{ path: string; sha256: string }> = [];
    for (const path of untrackedPaths.split('\0').filter(Boolean).sort()) {
      if (ignoredRoot && (path === ignoredRoot || path.startsWith(`${ignoredRoot}/`))) continue;
      untracked.push({ path, sha256: sha256(await readFile(join(canonicalPath, path))) });
    }
    return {
      headSha,
      indexTreeSha,
      trackedContentSha256: sha256(trackedDiff),
      untrackedContentSha256: sha256(canonicalJson(untracked)),
      worktreeIdentity: sha256(canonicalJson({ canonicalPath, gitDirectory: gitDirectory.trim() })),
    };
  }

  listChangedFiles(worktreePath: string): Promise<string[]> {
    return this.worktrees.listChangedFiles(worktreePath);
  }

  async fingerprintChangedFiles(worktreePath: string, changedFiles: string[]): Promise<string> {
    const root = await realpath(worktreePath);
    const entries = [];
    for (const path of [...changedFiles].sort()) {
      entries.push({ path, fingerprint: await fingerprintRepositoryPath(root, path) });
    }
    return sha256(canonicalJson(entries));
  }

  async stageAll(worktreePath: string): Promise<void> {
    await this.git(['-C', worktreePath, 'add', '--all']);
  }

  async getTreeSha(worktreePath: string): Promise<string> {
    return (await this.git(['-C', worktreePath, 'write-tree'])).trim();
  }

  async getHead(worktreePath: string): Promise<string> {
    return this.worktrees.getHead(worktreePath);
  }

  async inspectHead(worktreePath: string): Promise<{ sha: string; parentSha: string; treeSha: string; message: string }> {
    const [sha, parentSha, treeSha, message] = (await this.git([
      '-C', worktreePath, 'show', '-s', '--format=%H%n%P%n%T%n%B', 'HEAD',
    ])).split('\n', 4);
    if (!sha || !parentSha || !treeSha || message === undefined || parentSha.includes(' ')) throw new Error('HEAD commit is not a single-parent commit');
    return { sha, parentSha, treeSha, message: message.trimEnd() };
  }

  async getRemoteBranchSha(worktreePath: string, branchName: string): Promise<string | undefined> {
    const output = (await this.git(['-C', worktreePath, 'ls-remote', '--heads', 'origin', `refs/heads/${branchName}`])).trim();
    if (!output) return undefined;
    const rows = output.split('\n');
    if (rows.length !== 1) throw new Error('remote branch observation is ambiguous');
    const [sha, ref] = rows[0]!.split(/\s+/u);
    if (!sha || ref !== `refs/heads/${branchName}`) throw new Error('remote branch observation is invalid');
    return sha;
  }

  async commit(input: { worktreePath: string; message: string }): Promise<string> {
    await this.git([
      '-C',
      input.worktreePath,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=codex-orchestrator',
      '-c',
      'user.email=codex-orchestrator@users.noreply.github.com',
      'commit',
      '--no-verify',
      '-m',
      input.message,
    ]);
    return this.getHead(input.worktreePath);
  }

  push(input: { worktreePath: string; branchName: string }): Promise<void> {
    return this.worktrees.pushBranch(input);
  }

  private async git(args: string[]): Promise<string> {
    const result = await this.executor('git', args);
    if (result.exitCode !== 0) throw new Error(`git failed: ${result.stderr}`);
    return result.stdout;
  }
}

export class ContainedImplementationAgent {
  constructor(private readonly dependencies: {
    config: () => AgentAutoConfigV1;
    orchestratorHome: string;
    parentCodexHome: string;
    safePath: string;
    bootId: string;
    git: RunIssueGit;
    process?: CodexProcess;
    createAttemptId?: () => string;
    now?: () => string;
  }) {}

  async run(input: {
    runId: string;
    worktreePath: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    cycle: number;
    reworkFindings: string[];
    repairOnly: boolean;
    workflowGeneration: WorkflowGenerationReceipt;
    signal: AbortSignal;
  }): Promise<ImplementationAgentResult> {
    const config = this.dependencies.config();
    const canonicalRepository = `${config.github.owner.toLowerCase()}/${config.github.repo.toLowerCase()}`;
    const attemptId = (this.dependencies.createAttemptId ?? randomUUID)();
    const attempt = await prepareContainedAttempt({
      orchestratorHome: this.dependencies.orchestratorHome,
      canonicalRepository,
      runId: input.runId,
      attemptId,
      operationId: 'implementation',
      workflowGeneration: input.workflowGeneration,
      bootId: this.dependencies.bootId,
    });
    const baseline = await this.dependencies.git.snapshot(input.worktreePath);
    try {
      const result = await (this.dependencies.process ?? new CodexProcess()).run({
        codexPath: config.codex.command,
        cwd: input.worktreePath,
        schemaPath: attempt.schemaPath,
        reportPath: attempt.reportPath,
        toolHome: attempt.toolHome,
        tmpDir: attempt.tmpDir,
        safePath: this.dependencies.safePath,
        parentCodexHome: this.dependencies.parentCodexHome,
        parentEnv: process.env,
        prompt: [
          `Package profile instructions: ${attempt.profile.developerInstructions}`,
          `Follow the exact operation at ${attempt.operationPath}.`,
          `The operation's immutable workflow root is ${attempt.workflowRoot}.`,
          `Implement issue #${input.issue.number}: ${input.issue.title}`,
          `Implementation cycle: ${input.cycle}.`,
          `Frozen acceptance criteria: ${canonicalJson(input.frozenCriteria)}`,
          ...(input.reworkFindings.length > 0 ? [`Repair these verified findings: ${canonicalJson(input.reworkFindings)}`] : []),
          ...(input.repairOnly ? ['Report repair only: do not modify any worktree file; emit a schema-valid implementation report for the existing change.'] : []),
          'Do not commit, push, publish, or print credentials or local auth paths.',
        ].join('\n'),
        timeoutMs: config.codex.timeoutMs,
        idleTimeoutMs: config.codex.idleTimeoutMs,
        operationPolicy: attempt.policy,
        executionProfile: attempt.profile,
      }, input.signal);
      if (result.kind === 'cancelled') return { kind: 'cancelled' };
      if (['spawn-failed', 'transport-failed', 'timeout', 'idle-timeout'].includes(result.kind)) {
        return { kind: 'transport-failed', resumable: true };
      }
      if (result.kind !== 'completed' || result.report.kind !== 'available') return { kind: 'internal-error' };
      return {
        kind: 'completed',
        attemptId,
        report: decodeAgentReportForValidation(result.report.bytes),
      };
    } catch (error) {
      if (!(error instanceof ProcessQuiescenceError)) return { kind: 'internal-error' };
      return {
        kind: 'safe-halt',
        process: {
          pid: error.pid,
          processGroupId: error.processGroupId,
          startedAt: (this.dependencies.now ?? (() => new Date().toISOString()))(),
          baseline: { ...baseline },
        },
        waitForAbsence: () => waitForProcessGroupAbsent(error.processGroupId),
      };
    }
  }
}

export class ContainedProofAgent implements ProofAgent {
  constructor(private readonly dependencies: {
    config: () => AgentAutoConfigV1;
    orchestratorHome: string;
    parentCodexHome: string;
    safePath: string;
    targetRoot: string;
    bootId: string;
    androidAdbPath: string;
    iosXcrunPath: string;
    processExecutor: ProcessExecutor;
    process?: CodexProcess;
    createAttemptId?: () => string;
  }) {}

  async run(input: Parameters<ProofAgent['run']>[0]): ReturnType<ProofAgent['run']> {
    if (!input.workflowGeneration) throw new Error('proof workflow generation is required');
    const config = this.dependencies.config();
    const canonicalRepository = `${config.github.owner.toLowerCase()}/${config.github.repo.toLowerCase()}`;
    const worktreePath = resolve(this.dependencies.targetRoot, config.runner.workspaceRoot, `issue-${input.issue.number}`);
    const attempt = await prepareContainedAttempt({
      orchestratorHome: this.dependencies.orchestratorHome,
      canonicalRepository,
      runId: input.runId,
      attemptId: (this.dependencies.createAttemptId ?? randomUUID)(),
      operationId: 'acceptance-proof',
      workflowGeneration: input.workflowGeneration,
      bootId: this.dependencies.bootId,
    });
    const artifactRoot = resolve(worktreePath, config.proof.artifactDir);
    const snapshotRoot = dirname(attempt.sourceSkillPath ?? attempt.operationPath);
    const androidLeaseRoot = join(
      resolve(this.dependencies.orchestratorHome),
      'v2',
      sha256(canonicalRepository),
      'leases',
    );
    const androidLeaseArtifact = join(artifactRoot, input.proofId, 'android-lease.json');
    const iosLeaseRoot = join(
      resolve(this.dependencies.orchestratorHome),
      'v2',
      sha256(canonicalRepository),
      'leases',
    );
    const iosLeaseArtifact = join(artifactRoot, input.proofId, 'ios-lease.json');
    const iosTooling = await discoverIosTooling(this.dependencies.processExecutor, this.dependencies.iosXcrunPath);
    const before = await artifactInventory(artifactRoot, config.proof.artifactDir);
    try {
      const result = await (this.dependencies.process ?? new CodexProcess()).run({
        codexPath: config.codex.command,
        cwd: worktreePath,
        schemaPath: attempt.schemaPath,
        reportPath: attempt.reportPath,
        toolHome: attempt.toolHome,
        tmpDir: attempt.tmpDir,
        safePath: this.dependencies.safePath,
        parentCodexHome: this.dependencies.parentCodexHome,
        parentEnv: process.env,
        prompt: [
          `Package profile instructions: ${attempt.profile.developerInstructions}`,
          `Follow the exact operation at ${attempt.operationPath}.`,
          `The operation's immutable workflow root is ${attempt.workflowRoot}.`,
          `Independently prove issue #${input.issue.number}.`,
          `Frozen acceptance criteria: ${canonicalJson(input.frozenCriteria)}`,
          `Checked change digest: ${input.checkedChangeSha256}.`,
          `Checked changed files: ${canonicalJson(input.changedFiles)}.`,
          `Configured check receipts: ${canonicalJson(input.checks)}.`,
          `Write evidence only below ${config.proof.artifactDir}.`,
          'When a frozen criterion has a browser surface, follow references/browser.md from the exact acceptance-proof skill snapshot.',
          'When a frozen criterion has an Android surface, follow references/android.md from the exact acceptance-proof skill snapshot.',
          `Android lease helper: ${join(snapshotRoot, 'tools', 'android-lease.mjs')}.`,
          `Android lease root: ${androidLeaseRoot}.`,
          `Android lease artifact: ${androidLeaseArtifact}.`,
          `Android lease proof ID: ${input.proofId}.`,
          `Android lease owner PID: ${process.pid}.`,
          `Android adb path: ${this.dependencies.androidAdbPath}.`,
          'When a frozen criterion has an iOS surface, follow references/ios.md from the exact acceptance-proof skill snapshot.',
          `iOS lease helper: ${join(snapshotRoot, 'tools', 'ios-lease.mjs')}.`,
          `iOS lease root: ${iosLeaseRoot}.`,
          `iOS lease artifact: ${iosLeaseArtifact}.`,
          `iOS lease proof ID: ${input.proofId}.`,
          `iOS lease owner PID: ${process.pid}.`,
          `iOS xcrun path: ${this.dependencies.iosXcrunPath}.`,
          ...(iosTooling ? [
            `iOS runtime ID: ${iosTooling.runtimeId}.`,
            `iOS device type ID: ${iosTooling.deviceTypeId}.`,
          ] : ['iOS Simulator tooling discovery is unavailable; return a typed tool blocker for an iOS surface.']),
          ...(input.repairOnly ? [`Proof Report repair only: ${canonicalJson(input.repairFindings)} Do not modify product or evidence files.`] : []),
          'Do not modify product files, commit, push, publish, or print credentials or local auth paths.',
        ].join('\n'),
        timeoutMs: config.codex.timeoutMs,
        idleTimeoutMs: config.codex.idleTimeoutMs,
        operationPolicy: attempt.policy,
        executionProfile: attempt.profile,
      }, input.signal);
      if (result.kind === 'cancelled') return { kind: 'cancelled' };
      if (['spawn-failed', 'transport-failed', 'timeout', 'idle-timeout'].includes(result.kind)) {
        return { kind: 'transport-failed', resumable: true };
      }
      if (result.kind !== 'completed' || result.report.kind !== 'available') return { kind: 'internal-error' };
      const after = await artifactInventory(artifactRoot, config.proof.artifactDir);
      return {
        kind: 'report',
        report: decodeAgentReportForValidation(result.report.bytes, ['visualEvidence', 'blocker']),
        proofPhaseChangedFiles: changedArtifactPaths(before, after),
      };
    } catch (error) {
      if (error instanceof ProcessQuiescenceError) {
        throw new ProofQuiescenceError(error.pid, error.processGroupId, () => waitForProcessGroupAbsent(error.processGroupId));
      }
      return { kind: 'internal-error' };
    }
  }
}

export interface V2Runtime {
  runIssue(input: { targetRoot: string; issueNumber: number }): ReturnType<RunIssue['runIssue']>;
  abort(): void;
  dispose(): void;
}

export function createV2Runtime(input: {
  targetRoot: string;
  orchestratorHome: string;
  bootId: string;
  packageVersion: string;
  createWorkflowGeneration: () => Promise<{ receipt: WorkflowGenerationReceipt; skillHashes: Record<string, string> }>;
  issues: GitHubIssueAdapter;
  pullRequests: GitHubPullRequestAdapter;
  implementationAgent?: {
    run(input: Parameters<NonNullable<ConstructorParameters<typeof RunIssue>[0]>['implementationAgent']['run']>[0]): Promise<ImplementationAgentResult>;
  };
  proofAgent?: ProofAgent;
  parentCodexHome?: string;
  safePath?: string;
  codexProcess?: CodexProcess;
  git?: RunIssueGit;
  processExecutor?: ProcessExecutor;
  createRunId?: () => string;
  createProofId?: () => string;
  createAttemptId?: () => string;
  now?: () => string;
  processAlive?: (pid: number) => boolean;
  androidAdbPath?: string;
  iosXcrunPath?: string;
}): V2Runtime {
  const targetRoot = resolve(input.targetRoot);
  const orchestratorHome = resolve(input.orchestratorHome);
  const now = input.now ?? (() => new Date().toISOString());
  const commandExecutor = input.processExecutor ?? defaultProcessExecutor;
  const git = input.git ?? new LocalGitRunIssueAdapter(commandExecutor);
  const proofFreshnessGit = git as RunIssueGit & {
    snapshotIgnoringUntrackedRoot?: (
      worktreePath: string,
      ignoredRoot: string,
    ) => Promise<Omit<CheckedChangeFreshness, 'checkPolicySha256'>>;
  };
  const controller = new AbortController();
  let currentConfig: AgentAutoConfigV1 | undefined;
  let runRecords: RunRecordWriter | undefined;
  const containedProcess = input.codexProcess ?? new CodexProcess();
  const configuredAndroidAdbPath = input.androidAdbPath
    ?? process.env.ANDROID_ADB
    ?? (process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : undefined)
    ?? (process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb') : undefined)
    ?? join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
  const androidAdbPath = resolve(configuredAndroidAdbPath);
  const iosXcrunPath = resolve(input.iosXcrunPath ?? '/usr/bin/xcrun');
  const containedDependencies = () => ({
    config: () => requireConfig(currentConfig),
    orchestratorHome,
    parentCodexHome: requireRuntimeString(input.parentCodexHome, 'parentCodexHome'),
    safePath: requireRuntimeString(input.safePath, 'safePath'),
    bootId: input.bootId,
    process: containedProcess,
    createAttemptId: input.createAttemptId,
  });
  const implementationAgent = input.implementationAgent ?? new ContainedImplementationAgent({
    ...containedDependencies(),
    git,
    now,
  });
  const proofAgent = input.proofAgent ?? new ContainedProofAgent({
    ...containedDependencies(),
    targetRoot,
    androidAdbPath,
    iosXcrunPath,
    processExecutor: commandExecutor,
  });
  const reportOperation = new InjectedContainedReportOperation({
    prepare: async ({ operation, attemptId, runId, workflowGeneration }) => ({
      operation,
      generationHash: workflowGeneration.generationHash,
      ...await prepareContainedAttempt({
        orchestratorHome,
        canonicalRepository: requireCanonicalRepository(currentConfig),
        runId,
        attemptId,
        operationId: operation,
        workflowGeneration,
        bootId: input.bootId,
      }),
    }),
    snapshot: (worktreePath) => git.snapshot(worktreePath),
    launch: async ({ attempt, worktreePath, promptFacts, signal, onLaunched }) => {
      const config = requireConfig(currentConfig);
      if (!attempt.schemaPath || !attempt.reportPath || !attempt.toolHome || !attempt.tmpDir
        || !attempt.profile || !attempt.operationPath || !attempt.workflowRoot) {
        return { status: 'blocked' as const, kind: 'safety' as const, code: 'report-operation-attempt-incomplete' };
      }
      let readView: string;
      try {
        readView = await materializeReportReadView({
          worktreePath,
          destination: join(dirname(attempt.tmpDir), 'read-view'),
          deniedPaths: config.deny.readPaths,
        });
      } catch {
        return { status: 'blocked' as const, kind: 'safety' as const, code: 'report-operation-read-view-failed' };
      }
      let result;
      let cleanupAfterSafeHalt = false;
      try {
        result = await containedProcess.run({
        codexPath: config.codex.command,
        cwd: readView,
        schemaPath: attempt.schemaPath,
        reportPath: attempt.reportPath,
        toolHome: attempt.toolHome,
        tmpDir: attempt.tmpDir,
        safePath: requireRuntimeString(input.safePath, 'safePath'),
        parentCodexHome: requireRuntimeString(input.parentCodexHome, 'parentCodexHome'),
        parentEnv: process.env,
        prompt: [
          `Package profile instructions: ${attempt.profile.developerInstructions}`,
          `Follow the exact operation at ${attempt.operationPath}.`,
          `The operation's immutable workflow root is ${attempt.workflowRoot}.`,
          `Runner-provided facts: ${canonicalJson(promptFacts)}`,
          'This is a read-only, report-only operation. Do not edit files or external state, use network or MCP tools, or request additional authority.',
          'Do not read .env or any .env* file. The runner has removed repository credential paths from this read view.',
        ].join('\n'),
        timeoutMs: config.codex.timeoutMs,
        idleTimeoutMs: config.codex.idleTimeoutMs,
        operationPolicy: attempt.policy,
        executionProfile: attempt.profile,
        ...(onLaunched ? { onSpawned: onLaunched } : {}),
        }, signal);
      } catch (error) {
        if (error instanceof ProcessQuiescenceError) {
          cleanupAfterSafeHalt = true;
          return {
            status: 'safe-halt' as const,
            pid: error.pid,
            processGroupId: error.processGroupId,
            startedAt: now(),
            waitForAbsence: async () => {
              await waitForProcessGroupAbsent(error.processGroupId);
              await rm(readView, { recursive: true, force: true });
            },
          };
        }
        throw error;
      } finally {
        if (!cleanupAfterSafeHalt) await rm(readView, { recursive: true, force: true });
      }
      if (result.kind === 'cancelled') return { status: 'cancelled' as const };
      if (result.kind === 'launch-gate-failed') {
        return { status: 'blocked' as const, kind: 'safety' as const, code: 'review-operation-launch-persistence-failed' };
      }
      if (['spawn-failed', 'transport-failed', 'timeout', 'idle-timeout'].includes(result.kind)) {
        return { status: 'retryable' as const, code: `report-operation-${result.kind}` };
      }
      if (result.kind !== 'completed' || result.report.kind !== 'available') {
        return { status: 'blocked' as const, kind: 'external' as const, code: 'report-operation-report-unavailable' };
      }
      return { status: 'completed' as const, reportBytes: result.report.bytes };
    },
  });
  const implementationReviewer = new ContainedImplementationReviewer({
    operation: reportOperation,
    createAttemptId: input.createAttemptId ?? randomUUID,
  });
  const createAttemptId = input.createAttemptId ?? randomUUID;
  const specOperation: SpecDeliveryOperation = {
    author: async ({ context, state, mode, signal, onPrepared, onLaunched }) => {
      const attemptId = createAttemptId();
      const sessionId = state.authorSessionId ?? randomUUID();
      let attempt;
      try {
        attempt = await prepareContainedAttempt({
          orchestratorHome, canonicalRepository: requireCanonicalRepository(currentConfig), runId: context.runId,
          attemptId, operationId: 'spec-author', workflowGeneration: context.workflowGeneration, bootId: input.bootId,
        });
        const revisionPath = join(dirname(attempt.reportPath), `revision-${state.revisions.length + 1}.md`);
        await onPrepared({ attemptId, sessionId, reportPath: attempt.reportPath, revisionPath });
        const config = requireConfig(currentConfig);
        const result = await containedProcess.run({
          codexPath: config.codex.command, cwd: dirname(attempt.reportPath), schemaPath: attempt.schemaPath,
          reportPath: attempt.reportPath, toolHome: attempt.toolHome, tmpDir: attempt.tmpDir,
          safePath: requireRuntimeString(input.safePath, 'safePath'), parentCodexHome: requireRuntimeString(input.parentCodexHome, 'parentCodexHome'),
          parentEnv: process.env, timeoutMs: config.codex.timeoutMs, idleTimeoutMs: config.codex.idleTimeoutMs,
          operationPolicy: attempt.policy, executionProfile: attempt.profile,
          onSpawned: ({ pid, processGroupId }) => onLaunched({ attemptId, sessionId, pid, processGroupId }),
          prompt: [
            `Package profile instructions: ${attempt.profile.developerInstructions}`,
            `Follow the exact operation at ${attempt.operationPath}.`,
            `The immutable workflow root is ${attempt.workflowRoot}.`,
            `Author mode: ${mode}. Issue authority: ${canonicalJson(context.issue)}.`,
            `Frozen criteria: ${canonicalJson(context.frozenCriteria)}.`,
            `Prior revisions and review state: ${canonicalJson({ revisions: state.revisions, review: state.review })}.`,
            `Write the complete new immutable revision only to ${revisionPath}. Return that exact absolute path and its SHA-256 in the report.`,
            'Do not modify the product worktree, prior revisions, external state, or any .env file.',
          ].join('\n'),
        }, signal);
        if (result.kind === 'cancelled') return { status: 'cancelled' };
        if (['spawn-failed','transport-failed','timeout','idle-timeout'].includes(result.kind)) return { status: 'retryable', code: `spec-author-${result.kind}` };
        if (result.kind !== 'completed' || result.report.kind !== 'available') return { status: 'retryable', code: 'spec-author-report-invalid' };
        const report = decodeAgentReportForValidation(result.report.bytes) as Record<string, unknown>;
        if (report.status !== 'ready' || report.specPath !== revisionPath || report.specSha256 === null) return { status: 'retryable', code: 'spec-author-report-invalid' };
        const content = await readRegularFile(revisionPath);
        if (report.specSha256 !== sha256(content)) return { status: 'retryable', code: 'spec-author-report-invalid' };
        const previous = state.revisions.at(-1) ?? null;
        return { status: 'completed', value: createSpecRevision({
          revision: state.revisions.length + 1, path: revisionPath, content: content.toString('utf8'),
          evidence: [{ path: context.issue.url, sha256: sha256(canonicalJson(context.issue)), description: 'Frozen issue authority' }],
          author: { attemptId, sessionId }, previousRevision: previous,
        }) };
      } catch (error) {
        if (error instanceof ProcessQuiescenceError) {
          try { await waitForProcessGroupAbsent(error.processGroupId); return { status: 'retryable', code: 'spec-author-process-quiescence' }; }
          catch { return { status: 'blocked', kind: 'safety', code: 'spec-author-process-absence-unconfirmed' }; }
        }
        return { status: 'retryable', code: 'spec-author-report-invalid' };
      }
    },
    review: async ({ context, state, mode, signal, onPrepared, onLaunched }) => {
      const attemptId = createAttemptId();
      const sessionId = state.review.reviewer?.sessionId ?? randomUUID();
      try {
        const attempt = await prepareContainedAttempt({
          orchestratorHome, canonicalRepository: requireCanonicalRepository(currentConfig), runId: context.runId,
          attemptId, operationId: 'spec-review', workflowGeneration: context.workflowGeneration, bootId: input.bootId,
        });
        await onPrepared({ attemptId, sessionId, reportPath: attempt.reportPath });
        const config = requireConfig(currentConfig);
        const result = await containedProcess.run({
          codexPath: config.codex.command, cwd: context.worktreePath, schemaPath: attempt.schemaPath,
          reportPath: attempt.reportPath, toolHome: attempt.toolHome, tmpDir: attempt.tmpDir,
          safePath: requireRuntimeString(input.safePath, 'safePath'), parentCodexHome: requireRuntimeString(input.parentCodexHome, 'parentCodexHome'),
          parentEnv: process.env, timeoutMs: config.codex.timeoutMs, idleTimeoutMs: config.codex.idleTimeoutMs,
          operationPolicy: attempt.policy, executionProfile: attempt.profile,
          onSpawned: ({ pid, processGroupId }) => onLaunched({ attemptId, sessionId, pid, processGroupId }),
          prompt: [
            `Package profile instructions: ${attempt.profile.developerInstructions}`,
            `Follow the exact operation at ${attempt.operationPath}.`,
            `Reviewer session ID: ${sessionId}. Review mode: ${mode}.`,
            `Issue authority and frozen criteria: ${canonicalJson({ issue: context.issue, frozenCriteria: context.frozenCriteria })}.`,
            `Immutable spec delivery state: ${canonicalJson(state)}.`,
            'Return only the package spec-review report. Do not edit files or external state.',
          ].join('\n'),
        }, signal);
        if (result.kind === 'cancelled') return { status: 'cancelled' };
        if (['spawn-failed','transport-failed','timeout','idle-timeout'].includes(result.kind)) return { status: 'retryable', code: `spec-review-${result.kind}` };
        if (result.kind !== 'completed' || result.report.kind !== 'available') return { status: 'retryable', code: 'spec-review-report-invalid' };
        const raw = decodeAgentReportForValidation(result.report.bytes) as Record<string, unknown>;
        if (raw.mode !== mode || raw.reviewerSessionId !== sessionId || !Array.isArray(raw.coverage) || !Array.isArray(raw.defects)
          || !Array.isArray(raw.affectedDefectIds) || !Array.isArray(raw.affectedContracts) || !Array.isArray(raw.acceptedRisks)
          || typeof raw.coverageInvalidated !== 'boolean'
          || !['approved','needs-work','rejected'].includes(raw.verdict as string)) return { status: 'retryable', code: 'spec-review-report-invalid' };
        const target = state.revisions.at(-1)!;
        const defects = validateCodeReviewDefects(raw.defects, target.revision);
        const report: SpecReviewReportV1 = {
          version: 1, targetRevision: target.revision, targetSha256: target.revisionSha256, mode,
          verdict: raw.verdict as SpecReviewReportV1['verdict'], reviewer: { attemptId, sessionId },
          coverage: raw.coverage as string[], defects,
          affectedDefectIds: raw.affectedDefectIds as string[],
          affectedContracts: raw.affectedContracts as string[],
          closureRequestSha256: mode === 'closure' ? state.review.closureRequestSha256 : null,
          acceptedRisks: [], coverageInvalidated: raw.coverageInvalidated,
        };
        return { status: 'completed', value: report, reportSha256: sha256(result.report.bytes) };
      } catch (error) {
        if (error instanceof ProcessQuiescenceError) {
          try { await waitForProcessGroupAbsent(error.processGroupId); return { status: 'retryable', code: 'spec-review-process-quiescence' }; }
          catch { return { status: 'blocked', kind: 'safety', code: 'spec-review-process-absence-unconfirmed' }; }
        }
        return { status: 'retryable', code: 'spec-review-report-invalid' };
      }
    },
    recover: async ({ context, state, signal }) => {
      const invocation = state.invocation;
      if (!invocation || signal.aborted) return signal.aborted ? { status: 'cancelled' } : { status: 'blocked', kind: 'safety', code: 'spec-recovery-invocation-missing' };
      if (invocation.status === 'launched') {
        try { await waitForProcessGroupAbsent(invocation.processGroupId!); }
        catch { return { status: 'blocked', kind: 'safety', code: 'spec-process-absence-unconfirmed' }; }
      }
      if (!invocation.reportPath) return { status: 'retryable', code: `spec-${invocation.purpose}-transport-recovery` };
      let reportBytes: Buffer;
      try { reportBytes = await readRegularFile(invocation.reportPath); }
      catch { return { status: 'retryable', code: `spec-${invocation.purpose}-transport-recovery` }; }
      if (invocation.purpose === 'author') {
        if (!invocation.revisionPath) return { status: 'retryable', code: 'spec-author-report-invalid' };
        try {
          const raw = decodeAgentReportForValidation(reportBytes) as Record<string, unknown>;
          const content = await readRegularFile(invocation.revisionPath);
          if (raw.status !== 'ready' || raw.specPath !== invocation.revisionPath || raw.specSha256 !== sha256(content)) return { status: 'retryable', code: 'spec-author-report-invalid' };
          return { status: 'completed', value: createSpecRevision({
            revision: state.revisions.length + 1, path: invocation.revisionPath, content: content.toString('utf8'),
            evidence: [{ path: context.issue.url, sha256: sha256(canonicalJson(context.issue)), description: 'Frozen issue authority' }],
            author: { attemptId: invocation.attemptId, sessionId: invocation.sessionId }, previousRevision: state.revisions.at(-1) ?? null,
          }) };
        } catch { return { status: 'retryable', code: 'spec-author-report-invalid' }; }
      }
      try {
        const raw = decodeAgentReportForValidation(reportBytes) as Record<string, unknown>;
        if (raw.mode !== invocation.mode || raw.reviewerSessionId !== invocation.sessionId || !Array.isArray(raw.coverage)
          || !Array.isArray(raw.defects) || !Array.isArray(raw.affectedDefectIds) || !Array.isArray(raw.affectedContracts)
          || typeof raw.coverageInvalidated !== 'boolean' || !['approved','needs-work','rejected'].includes(raw.verdict as string)) {
          return { status: 'retryable', code: 'spec-review-report-invalid' };
        }
        const defects = validateCodeReviewDefects(raw.defects, invocation.targetRevision);
        return { status: 'completed', reportSha256: sha256(reportBytes), value: {
          version: 1, targetRevision: invocation.targetRevision, targetSha256: invocation.targetSha256!,
          mode: invocation.mode as 'full'|'closure', verdict: raw.verdict as SpecReviewReportV1['verdict'],
          reviewer: { attemptId: invocation.attemptId, sessionId: invocation.sessionId }, coverage: raw.coverage as string[], defects,
          affectedDefectIds: raw.affectedDefectIds as string[], affectedContracts: raw.affectedContracts as string[],
          closureRequestSha256: invocation.closureRequestSha256, acceptedRisks: [], coverageInvalidated: raw.coverageInvalidated,
        } };
      } catch { return { status: 'retryable', code: 'spec-review-report-invalid' }; }
    },
  };

  const readConfig = async (requestedRoot: string) => {
    if (resolve(requestedRoot) !== targetRoot) throw new Error('runtime target root mismatch');
    const bytes = await readRegularFile(join(targetRoot, '.codex-orchestrator', 'config.json'));
    const config = parseAgentAutoConfig(parseJsonWithoutDuplicateKeys(bytes.toString('utf8')));
    const path = join(targetRoot, config.runner.stateDir, 'v2', 'run-state.json');
    if (!runRecords) runRecords = new FileRunRecordWriter(path);
    currentConfig = config;
    return { bytes, config };
  };
  const records: RunRecordWriter = {
    read: async () => {
      if (!runRecords) throw new Error('run store used before config');
      return runRecords.read();
    },
    compareAndSwap: async (generation, next) => {
      if (!runRecords) throw new Error('run store used before config');
      return runRecords.compareAndSwap(generation, next);
    },
  };
  const capabilities = createCheckedChangeCapabilities();
  const proof = {
    proveChange: async (proofInput: Parameters<AcceptanceProof['proveChange']>[0]) => {
      const config = requireConfig(currentConfig);
      const checked = capabilities.verifyAndRead(proofInput.checkedChange);
      const repoKey = sha256(checked.payload.canonicalRepository);
      const proofRecords = new FileProofRecordWriter(join(orchestratorHome, 'v2', repoKey, 'proofs'));
      const worktreePath = resolve(targetRoot, config.runner.workspaceRoot, `issue-${checked.payload.issueNumber}`);
      const androidLease = new FileAndroidLeaseVerifier({
        leaseRoot: join(orchestratorHome, 'v2', repoKey, 'leases'),
        worktreeRoot: worktreePath,
        now: () => new Date(now()),
        artifactRelativePathForProof: (proofId) => `${config.proof.artifactDir}/${proofId}/android-lease.json`,
      });
      const iosLease = new FileIosLeaseVerifier({
        leaseRoot: join(orchestratorHome, 'v2', repoKey, 'leases'),
        worktreeRoot: worktreePath,
        now: () => new Date(now()),
        artifactRelativePathForProof: (proofId) => `${config.proof.artifactDir}/${proofId}/ios-lease.json`,
        targetController: {
          release: (record) => releaseIosSimulator(commandExecutor, iosXcrunPath, record),
        },
      });
      const acceptanceProof = new AcceptanceProof({
        checkedChangeReader: capabilities,
        proofRecords,
        proofAgent,
        inspectFreshness: async (payload) => ({
          ...await (proofFreshnessGit.snapshotIgnoringUntrackedRoot
            ? proofFreshnessGit.snapshotIgnoringUntrackedRoot(worktreePath, config.proof.artifactDir)
            : git.snapshot(worktreePath)),
          checkPolicySha256: sha256(canonicalJson(config.checks)),
        }),
        readArtifact: async (relativePath) => readRegularFile(resolve(worktreePath, relativePath)),
        inspectArtifact: async (relativePath) => inspectRegularFile(resolve(worktreePath, relativePath)),
        androidLease,
        iosLease,
        proofArtifactDir: config.proof.artifactDir,
        createAttemptId: input.createAttemptId ?? randomUUID,
        now,
        signal: controller.signal,
      });
      return acceptanceProof.proveChange(proofInput);
    },
  };
  const runner = new RunIssue({
    readConfig,
    validateContainment: async (config) => {
      const certificate = await readContainmentCertificate(containmentCertificatePath(orchestratorHome));
      const version = await commandExecutor(config.codex.command, ['--version']);
      if (version.exitCode !== 0) throw new Error('Codex version is unavailable');
      assertContainmentCertificateMatchesRuntime(certificate, {
        codexVersion: version.stdout.trim(),
        argvPolicySha256: containmentArgvPolicySha256(),
      });
    },
    ownerLock: {
      acquire: async ({ canonicalRepository }) => acquireOwnerLock({
        orchestratorHome,
        canonicalRepository,
        bootId: input.bootId,
        now,
        processAlive: input.processAlive ?? processIsAlive,
      }),
    },
    issues: {
      read: async (issueNumber) => {
        const issue = await input.issues.getIssue(issueNumber);
        if (!issue || issue.state !== 'OPEN') return issue ? {
          number: issue.number, title: issue.title, body: issue.body, url: issue.url, state: 'CLOSED',
          labels: issue.labels.map((label) => label.name).sort(), comments: [],
        } : undefined;
        const comments = await input.issues.listAllComments(issueNumber);
        return {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          url: issue.url,
          state: 'OPEN',
          labels: issue.labels.map((label) => label.name).sort(),
          comments: comments.map((comment) => ({ body: comment.body, authorAssociation: comment.authorAssociation })),
        };
      },
      setLabels: async (issueNumber, labels) => {
        const current = await input.issues.getLabels(issueNumber);
        await input.issues.updateIssue(issueNumber, {
          addLabels: labels.filter((label) => !current.includes(label)),
          removeLabels: current.filter((label) => !labels.includes(label)),
        });
      },
      postComment: async (issueNumber, body) => { await input.issues.postComment(issueNumber, body); },
    },
    pullRequests: {
      findOpen: async ({ headBranch, baseBranch }) => {
        const matches = (await input.pullRequests.listAllByHeadBranch(headBranch))
          .filter((pullRequest) => pullRequest.state === 'OPEN' && pullRequest.baseRefName === baseBranch);
        if (matches.length > 1) throw new Error('multiple open pull requests match publication intent');
        const match = matches[0];
        return match ? { url: match.url, body: match.body } : undefined;
      },
      createDraft: async ({ title, body, headBranch, baseBranch }) => input.pullRequests.createDraftPullRequest({ title, body, headBranch, baseBranch }),
    },
    git,
    routeCoordinator: {
      run: ({ state, ...routeInput }) => new RouteCoordinator({
        state,
        operation: reportOperation,
        createAttemptId: input.createAttemptId ?? randomUUID,
        now,
        createReceipt: ({ artifact, triage, review, decidedAt }) => {
          if (artifact.status === 'blocked') throw new Error('blocked triage cannot create a route receipt');
          const receipt: RouteReceiptV1 = {
            version: 1,
            route: artifact.status,
            triage,
            review,
            artifact,
            decisionSha256: '',
            decidedAt,
            assumptions: [...artifact.assumptions],
          };
          receipt.decisionSha256 = hashRouteDecision(receipt);
          return validateRouteReceipt(receipt, triage.generationHash);
        },
      }).run(routeInput),
    },
    routeContinuations: {
      direct: async () => ({ status: 'completed' }),
      specRequired: (context, state, signal) => new SpecCoordinator({ state, operation: specOperation }).run(context, signal),
      awaitingUser: async (context, state, signal) => {
        const config = requireConfig(currentConfig);
        return new WaitingHumanCoordinator({
          issues: input.issues,
          labels: {
            auto: config.github.labels.auto.name,
            running: config.github.labels.running.name,
            blocked: config.github.labels.blocked.name,
            review: config.github.labels.review.name,
            waitingHuman: config.github.labels.waitingHuman.name,
          },
          now,
        }).run(context, state, signal);
      },
    },
    implementationAgent,
    implementationReviewer,
    waitForReviewProcessAbsence: waitForProcessGroupAbsent,
    checks: {
      run: async ({ command, cwd, signal }) => runShellCheck(command, cwd, signal),
    },
    proof,
    checkedChangeMint: capabilities,
    runRecords: records,
    writeEvidence: async ({ runId, code, summary }) => {
      const config = requireConfig(currentConfig);
      const relativePath = `${config.runner.stateDir}/v2/evidence/${runId}.json`;
      await writeDurableAtomicFile(resolve(targetRoot, relativePath), `${canonicalJson({ version: 1, runId, code, summary, recordedAt: now() })}\n`);
      return { id: `evidence:${runId}:${code}`, path: relativePath };
    },
    packageVersion: input.packageVersion,
    createWorkflowGeneration: input.createWorkflowGeneration,
    verifyWorkflowGeneration,
    createRunId: input.createRunId ?? randomUUID,
    createProofId: input.createProofId ?? randomUUID,
    createReviewSessionId: input.createAttemptId ?? randomUUID,
    now,
    signal: controller.signal,
  });
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    runIssue: (runInput) => runner.runIssue(runInput),
    abort: () => controller.abort(),
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

async function acquireOwnerLock(input: {
  orchestratorHome: string;
  canonicalRepository: string;
  bootId: string;
  now: () => string;
  processAlive: (pid: number) => boolean;
}): Promise<{ release(): Promise<void> }> {
  try {
    return await acquireOwnerControlLock({
      orchestratorHome: input.orchestratorHome,
      canonicalRepository: input.canonicalRepository,
      bootId: input.bootId,
      host: hostname(),
      pid: process.pid,
      now: input.now,
      createToken: randomUUID,
      processAlive: input.processAlive,
    });
  } catch (error) {
    if (error instanceof OwnerControlLockBlockedError) {
      if (error.kind === 'live-contention') throw new OwnerLockContentionError(error.message);
      throw new OwnerLockSafetyError(error.message);
    }
    throw error;
  }
}

async function readRegularFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error(`${path} is not a bounded regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function inspectRegularFile(path: string): Promise<{ modifiedAt: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) throw new Error(`${path} is not a bounded regular file`);
    return { modifiedAt: metadata.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

async function runShellCheck(command: string, cwd: string, signal: AbortSignal): Promise<{ status: 'passed' | 'failed'; output: Buffer }> {
  return new Promise((resolveCheck, rejectCheck) => {
    const child = spawn('/bin/sh', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let retained = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const collect = (chunk: Buffer) => {
      if (retained >= 1024 * 1024) return;
      const kept = chunk.subarray(0, 1024 * 1024 - retained);
      chunks.push(kept);
      retained += kept.length;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already absent */ }
      killTimer = setTimeout(() => {
        if (settled || !child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already absent */ }
      }, 5_000);
      killTimer.unref();
    };
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    child.once('error', (error) => {
      settled = true;
      signal.removeEventListener('abort', terminate);
      if (killTimer) clearTimeout(killTimer);
      rejectCheck(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', terminate);
      if (killTimer) clearTimeout(killTimer);
      resolveCheck({ status: code === 0 ? 'passed' : 'failed', output: Buffer.concat(chunks) });
    });
  });
}

function requireConfig(config: AgentAutoConfigV1 | undefined): AgentAutoConfigV1 {
  if (!config) throw new Error('runtime config is unavailable');
  return config;
}

function requireCanonicalRepository(config: AgentAutoConfigV1 | undefined): string {
  const value = requireConfig(config);
  return `${value.github.owner.toLowerCase()}/${value.github.repo.toLowerCase()}`;
}

function requireRuntimeString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required for contained Codex agents`);
  return value;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function discoverIosTooling(
  executor: ProcessExecutor,
  xcrunPath: string,
): Promise<{ runtimeId: string; deviceTypeId: string } | undefined> {
  const [runtimeResult, deviceTypeResult] = await Promise.all([
    executor(xcrunPath, ['simctl', 'list', 'runtimes', '-j']),
    executor(xcrunPath, ['simctl', 'list', 'devicetypes', '-j']),
  ]).catch(() => []);
  if (!runtimeResult || !deviceTypeResult || runtimeResult.exitCode !== 0 || deviceTypeResult.exitCode !== 0) return undefined;
  try {
    const runtimes = (JSON.parse(runtimeResult.stdout) as {
      runtimes?: Array<{ identifier?: unknown; version?: unknown; isAvailable?: unknown }>;
    }).runtimes ?? [];
    const deviceTypes = (JSON.parse(deviceTypeResult.stdout) as {
      devicetypes?: Array<{ identifier?: unknown; name?: unknown }>;
    }).devicetypes ?? [];
    const runtime = runtimes
      .filter((item) => item.isAvailable !== false && typeof item.identifier === 'string'
        && item.identifier.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-'))
      .sort((left, right) => String(right.version ?? '').localeCompare(String(left.version ?? ''), undefined, { numeric: true }))[0];
    const deviceType = deviceTypes
      .filter((item) => typeof item.identifier === 'string' && item.identifier.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-'))
      .sort((left, right) => {
        const leftPro = /Pro/u.test(String(left.name)) ? 0 : 1;
        const rightPro = /Pro/u.test(String(right.name)) ? 0 : 1;
        return leftPro - rightPro || String(right.name).localeCompare(String(left.name), undefined, { numeric: true });
      })[0];
    if (typeof runtime?.identifier !== 'string' || typeof deviceType?.identifier !== 'string') return undefined;
    return { runtimeId: runtime.identifier, deviceTypeId: deviceType.identifier };
  } catch {
    return undefined;
  }
}

export async function releaseIosSimulator(
  executor: ProcessExecutor,
  xcrunPath: string,
  record: IosLeaseRecordV1,
): Promise<void> {
  if (!record.runnerCreated) throw new Error('iOS release requires runner-created ownership');
  const readDevices = async () => {
    const result = await executor(xcrunPath, ['simctl', 'list', 'devices', '-j']);
    if (result.exitCode !== 0) throw new Error('iOS Simulator inventory failed during release');
    const parsed = JSON.parse(result.stdout) as {
      devices?: Record<string, Array<{ udid?: unknown; name?: unknown; state?: unknown; isAvailable?: unknown }>>;
    };
    return Object.values(parsed.devices ?? {}).flat().filter((device) => device.isAvailable !== false);
  };
  const matches = (await readDevices()).filter((device) => device.udid === record.udid);
  if (matches.length === 0) return;
  if (matches.length !== 1 || matches[0].name !== record.deviceName) throw new Error('iOS release target identity is ambiguous');
  if (matches[0].state === 'Booted') {
    const shutdown = await executor(xcrunPath, ['simctl', 'shutdown', record.udid]);
    if (shutdown.exitCode !== 0) throw new Error('iOS runner-created Simulator shutdown failed');
  }
  const deleted = await executor(xcrunPath, ['simctl', 'delete', record.udid]);
  if (deleted.exitCode !== 0) throw new Error('iOS runner-created Simulator deletion failed');
  if ((await readDevices()).some((device) => device.udid === record.udid)) {
    throw new Error('iOS runner-created Simulator deletion was not confirmed');
  }
}

async function prepareContainedAttempt(input: {
  orchestratorHome: string;
  canonicalRepository: string;
  runId: string;
  attemptId: string;
  operationId: 'implementation' | 'acceptance-proof' | 'triage' | 'ambiguity-review' | 'cleanup-review' | 'code-review' | 'spec-author' | 'spec-review';
  workflowGeneration: WorkflowGenerationReceipt;
  bootId: string;
}): Promise<{
  workflowRoot: string;
  operationPath: string;
  sourceSkillPath?: string;
  schemaPath: string;
  reportPath: string;
  toolHome: string;
  tmpDir: string;
  policy: WorkflowOperationPolicy;
  profile: WorkflowExecutionProfile;
}> {
  const runtimeRoot = join(resolve(input.orchestratorHome), 'v2', sha256(input.canonicalRepository));
  const attemptRelativePath = `runs/${input.runId}/attempts/${input.attemptId}`;
  const snapshot = await publishRuntimeAssetSnapshot({
    workflowGeneration: input.workflowGeneration,
    runtimeRoot,
    snapshotRelativePath: `${attemptRelativePath}/snapshot`,
    operation: input.operationId,
    bootId: input.bootId,
  });
  const reportOnly = input.operationId === 'triage' || input.operationId === 'ambiguity-review'
    || input.operationId === 'cleanup-review' || input.operationId === 'code-review' || input.operationId === 'spec-review';
  if ((reportOnly
    ? snapshot.policy.sandboxMode !== 'read-only'
      || snapshot.policy.worktreeAccess !== 'read-only'
      || snapshot.policy.runnerPostcondition !== 'report-only'
      || snapshot.policy.writableRootClasses.length !== 0
    : snapshot.policy.sandboxMode !== 'workspace-write')
    || snapshot.policy.approvalCeiling !== 'never'
    || snapshot.policy.network !== 'deny'
    || snapshot.policy.networkHosts.length !== 0
    || snapshot.policy.mcpTools.length !== 0
    || snapshot.policy.externalWrite !== false) {
    throw new Error(`workflow operation policy exceeds containment: ${input.operationId}`);
  }
  const profile = parseWorkflowExecutionProfile(await readFile(snapshot.profilePath, 'utf8'), snapshot.policy);
  const attemptRoot = join(runtimeRoot, attemptRelativePath);
  const toolHome = join(attemptRoot, 'tool-home');
  const tmpDir = join(attemptRoot, 'tmp');
  await mkdir(toolHome, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
    if (!isErrorCode(error, 'EEXIST')) throw error;
  });
  await mkdir(tmpDir, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
    if (!isErrorCode(error, 'EEXIST')) throw error;
  });
  return {
    workflowRoot: snapshot.snapshotRoot,
    operationPath: snapshot.operationPath,
    sourceSkillPath: snapshot.sourceSkillPath,
    schemaPath: snapshot.schemaPath,
    reportPath: join(attemptRoot, 'report.json'),
    toolHome,
    tmpDir,
    policy: structuredClone(snapshot.policy),
    profile,
  };
}

async function artifactInventory(root: string, logicalRoot: string): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return output;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('proof artifact root must be a direct directory');
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('proof artifact tree contains a symlink');
      if (entry.isDirectory()) await visit(childPath, childRelative);
      else if (entry.isFile()) output.set(`${logicalRoot}/${childRelative}`, sha256(await readFile(childPath)));
      else throw new Error('proof artifact tree contains a special file');
    }
  };
  await visit(root, '');
  return output;
}

function changedArtifactPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

async function fingerprintRepositoryPath(root: string, relativePath: string): Promise<unknown> {
  const segments = relativePath.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstat(current).catch((error: unknown) => {
      if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTDIR')) return undefined;
      throw error;
    });
    if (!info) return { kind: 'absent' };
    if (info.isSymbolicLink()) {
      return { kind: 'symlink', targetSha256: sha256(await readlink(current)), depth: index };
    }
    if (index < segments.length - 1 && !info.isDirectory()) return { kind: 'blocked-parent', depth: index };
    if (index === segments.length - 1) return fingerprintDeniedEntry(current, info);
  }
  return { kind: 'absent' };
}

async function fingerprintDeniedEntry(
  path: string,
  existingInfo?: Awaited<ReturnType<typeof lstat>>,
): Promise<unknown> {
  const info = existingInfo ?? await lstat(path);
  if (info.isSymbolicLink()) return { kind: 'symlink', targetSha256: sha256(await readlink(path)) };
  if (info.isFile()) return { kind: 'file', bytesSha256: sha256(await readFile(path)) };
  if (!info.isDirectory()) return { kind: 'special' };
  const entries: Array<{ nameSha256: string; fingerprint: unknown }> = [];
  for (const name of (await readdir(path)).sort()) {
    entries.push({ nameSha256: sha256(name), fingerprint: await fingerprintDeniedEntry(join(path, name)) });
  }
  return { kind: 'directory', entries };
}

async function waitForProcessGroupAbsent(processGroupId: number): Promise<void> {
  while (true) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (isErrorCode(error, 'ESRCH')) return;
      if (!isErrorCode(error, 'EPERM')) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
}

export async function materializeReportReadView(input: {
  worktreePath: string;
  destination: string;
  deniedPaths: string[];
}): Promise<string> {
  await assertDisjointReadViewPaths(input.worktreePath, input.destination);
  const deniedPaths = normalizeReadViewDeniedPaths(input.deniedPaths);
  await rm(input.destination, { recursive: true, force: true });
  await mkdir(input.destination, { recursive: true, mode: 0o700 });
  await materializeCurrentReadView(input.worktreePath, input.destination, deniedPaths);
  await scrubReportReadView(input.destination);
  return input.destination;
}

async function assertDisjointReadViewPaths(worktreePath: string, destination: string): Promise<void> {
  const worktree = await realpath(resolve(worktreePath));
  const readView = await canonicalProspectivePath(destination);
  if (isPathWithin(worktree, readView) || isPathWithin(readView, worktree)) {
    throw new Error('report read-view destination must not overlap its source worktree');
  }
}

async function canonicalProspectivePath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...suffix);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function isPathWithin(parent: string, child: string): boolean {
  const contained = relative(parent, child);
  return contained === '' || (contained !== '..' && !contained.startsWith('../') && !isAbsolute(contained));
}

function normalizeReadViewDeniedPaths(paths: string[]): string[] {
  return paths.flatMap((path) => {
    if (isAbsolute(path)) return [];
    if (path.length === 0 || posix.normalize(path) !== path
      || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error('report read-view denied path escapes destination');
    }
    return [path];
  });
}

async function materializeCurrentReadView(worktreePath: string, destination: string, deniedPaths: string[]): Promise<void> {
  const paths = new Set(await readGitPathList(worktreePath, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']));
  for (const path of [...paths].sort()) {
    if (isExcludedReadViewPath(path, deniedPaths)) continue;
    const target = resolve(destination, path);
    const contained = relative(destination, target);
    if (contained === '' || contained === '..' || contained.startsWith('../') || isAbsolute(contained)) {
      throw new Error('report read-view path escapes destination');
    }
    const source = resolve(worktreePath, path);
    let metadata;
    try {
      metadata = await lstat(source);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      await rm(target, { recursive: true, force: true });
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    await copyRegularFileNoFollow(source, target, metadata.mode);
  }
}

function isExcludedReadViewPath(path: string, deniedPaths: string[]): boolean {
  if (path.split('/').some((segment) => segment.startsWith('.env'))) return true;
  return deniedPaths.some((deniedPath) => path === deniedPath || path.startsWith(`${deniedPath}/`));
}

async function readGitPathList(worktreePath: string, args: string[]): Promise<string[]> {
  return new Promise((resolvePaths, reject) => {
    const child = spawn('git', ['-C', worktreePath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.once('error', reject);
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`report read-view inventory failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 8 * 1024)}`));
        return;
      }
      resolvePaths(Buffer.concat(stdout).toString('utf8').split('\0').filter((path) => path.length > 0));
    });
  });
}

async function copyRegularFileNoFollow(sourcePath: string, targetPath: string, mode: number): Promise<void> {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target;
  try {
    const metadata = await source.stat();
    if (!metadata.isFile()) throw new Error('report read-view source must be a regular file');
    await rm(targetPath, { recursive: true, force: true });
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    target = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode & 0o777);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, null);
        offset += bytesWritten;
      }
    }
  } finally {
    await target?.close();
    await source.close();
  }
}

async function scrubReportReadView(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.startsWith('.env') || entry.isSymbolicLink()) {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await scrubReportReadView(path);
    } else if (!entry.isFile()) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function validateRelativeRoot(value: string): void {
  if (
    value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || posix.normalize(value) !== value
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('ignored untracked root must be a normalized repository-relative path');
  }
}
