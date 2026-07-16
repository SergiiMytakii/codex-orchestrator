import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';
import { GitWorktreeManager } from '../git/worktree.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import type { GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { defaultProcessExecutor, type ProcessExecutor } from '../process/command.js';
import { AcceptanceProof, ProofQuiescenceError, type FrozenCriterion, type IssueSnapshot, type ProofAgent } from './acceptance-proof.js';
import { acquireExclusiveJsonFileLock } from './atomic-store.js';
import { createCheckedChangeCapabilities, type CheckedChangeFreshness } from './checked-change.js';
import { parseAgentAutoConfig, type AgentAutoConfigV1 } from './config.js';
import {
  canonicalJson,
  containmentArgvPolicySha256,
  containmentCertificatePath,
  parseJsonWithoutDuplicateKeys,
  readContainmentCertificate,
  sha256,
} from './containment.js';
import { FileProofRecordWriter } from './proof-store.js';
import { CodexProcess, ProcessQuiescenceError } from './codex-process.js';
import { publishRuntimeAssetSnapshot } from './runtime-assets.js';
import { OwnerLockSafetyError, RunIssue, type ImplementationAgentResult, type RunIssueGit } from './run-issue.js';
import { FileRunRecordWriter, type RunRecordWriter } from './run-store.js';

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
    await this.worktrees.commitAll(input);
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
    packageRoot: string;
    orchestratorHome: string;
    parentCodexHome: string;
    safePath: string;
    packageVersion: string;
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
    signal: AbortSignal;
  }): Promise<ImplementationAgentResult> {
    const config = this.dependencies.config();
    const canonicalRepository = `${config.github.owner.toLowerCase()}/${config.github.repo.toLowerCase()}`;
    const attemptId = (this.dependencies.createAttemptId ?? randomUUID)();
    const attempt = await prepareContainedAttempt({
      packageRoot: this.dependencies.packageRoot,
      orchestratorHome: this.dependencies.orchestratorHome,
      canonicalRepository,
      runId: input.runId,
      attemptId,
      skill: 'agent-auto',
      expectedPackageVersion: this.dependencies.packageVersion,
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
          `Follow the exact skill at ${attempt.skillPath}.`,
          `Implement issue #${input.issue.number}: ${input.issue.title}`,
          `Implementation cycle: ${input.cycle}.`,
          `Frozen acceptance criteria: ${canonicalJson(input.frozenCriteria)}`,
          ...(input.reworkFindings.length > 0 ? [`Repair these verified findings: ${canonicalJson(input.reworkFindings)}`] : []),
          ...(input.repairOnly ? ['Report repair only: do not modify any worktree file; emit a schema-valid implementation report for the existing change.'] : []),
          'Do not commit, push, publish, or print credentials or local auth paths.',
        ].join('\n'),
        timeoutMs: config.codex.timeoutMs,
        idleTimeoutMs: config.codex.idleTimeoutMs,
      }, input.signal);
      if (result.kind === 'cancelled') return { kind: 'cancelled' };
      if (['spawn-failed', 'transport-failed', 'timeout', 'idle-timeout'].includes(result.kind)) {
        return { kind: 'transport-failed', resumable: true };
      }
      if (result.kind !== 'completed' || result.report.kind !== 'available') return { kind: 'internal-error' };
      return { kind: 'completed', report: parseJsonWithoutDuplicateKeys(result.report.bytes.toString('utf8')) };
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
    packageRoot: string;
    orchestratorHome: string;
    parentCodexHome: string;
    safePath: string;
    targetRoot: string;
    packageVersion: string;
    process?: CodexProcess;
    createAttemptId?: () => string;
  }) {}

  async run(input: Parameters<ProofAgent['run']>[0]): ReturnType<ProofAgent['run']> {
    const config = this.dependencies.config();
    const canonicalRepository = `${config.github.owner.toLowerCase()}/${config.github.repo.toLowerCase()}`;
    const worktreePath = resolve(this.dependencies.targetRoot, config.runner.workspaceRoot, `issue-${input.issue.number}`);
    const attempt = await prepareContainedAttempt({
      packageRoot: this.dependencies.packageRoot,
      orchestratorHome: this.dependencies.orchestratorHome,
      canonicalRepository,
      runId: input.runId,
      attemptId: (this.dependencies.createAttemptId ?? randomUUID)(),
      skill: 'acceptance-proof',
      expectedPackageVersion: this.dependencies.packageVersion,
    });
    const artifactRoot = resolve(worktreePath, config.proof.artifactDir);
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
          `Follow the exact skill at ${attempt.skillPath}.`,
          `Independently prove issue #${input.issue.number}.`,
          `Frozen acceptance criteria: ${canonicalJson(input.frozenCriteria)}`,
          `Checked change digest: ${input.checkedChangeSha256}.`,
          `Checked changed files: ${canonicalJson(input.changedFiles)}.`,
          `Configured check receipts: ${canonicalJson(input.checks)}.`,
          `Write evidence only below ${config.proof.artifactDir}.`,
          'When a frozen criterion has a browser surface, follow references/browser.md from the exact acceptance-proof skill snapshot.',
          ...(input.repairOnly ? [`Proof Report repair only: ${canonicalJson(input.repairFindings)} Do not modify product or evidence files.`] : []),
          'Do not modify product files, commit, push, publish, or print credentials or local auth paths.',
        ].join('\n'),
        timeoutMs: config.codex.timeoutMs,
        idleTimeoutMs: config.codex.idleTimeoutMs,
      }, input.signal);
      if (result.kind === 'cancelled') return { kind: 'cancelled' };
      if (['spawn-failed', 'transport-failed', 'timeout', 'idle-timeout'].includes(result.kind)) {
        return { kind: 'transport-failed', resumable: true };
      }
      if (result.kind !== 'completed' || result.report.kind !== 'available') return { kind: 'internal-error' };
      const after = await artifactInventory(artifactRoot, config.proof.artifactDir);
      return {
        kind: 'report',
        report: parseJsonWithoutDuplicateKeys(result.report.bytes.toString('utf8')),
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
  skillHashes: Record<string, string>;
  issues: GitHubIssueAdapter;
  pullRequests: GitHubPullRequestAdapter;
  implementationAgent?: {
    run(input: Parameters<NonNullable<ConstructorParameters<typeof RunIssue>[0]>['implementationAgent']['run']>[0]): Promise<ImplementationAgentResult>;
  };
  proofAgent?: ProofAgent;
  packageRoot?: string;
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
}): V2Runtime {
  const targetRoot = resolve(input.targetRoot);
  const orchestratorHome = resolve(input.orchestratorHome);
  const now = input.now ?? (() => new Date().toISOString());
  const commandExecutor = input.processExecutor ?? defaultProcessExecutor;
  const git = input.git ?? new LocalGitRunIssueAdapter(commandExecutor);
  const controller = new AbortController();
  let currentConfig: AgentAutoConfigV1 | undefined;
  let runRecords: RunRecordWriter | undefined;
  const containedProcess = input.codexProcess ?? new CodexProcess();
  const containedDependencies = () => ({
    config: () => requireConfig(currentConfig),
    packageRoot: requireRuntimeString(input.packageRoot, 'packageRoot'),
    orchestratorHome,
    parentCodexHome: requireRuntimeString(input.parentCodexHome, 'parentCodexHome'),
    safePath: requireRuntimeString(input.safePath, 'safePath'),
    packageVersion: input.packageVersion,
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
  });

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
      const acceptanceProof = new AcceptanceProof({
        checkedChangeReader: capabilities,
        proofRecords,
        proofAgent,
        inspectFreshness: async (payload) => ({
          ...await git.snapshot(worktreePath),
          checkPolicySha256: sha256(canonicalJson(config.checks)),
        }),
        readArtifact: async (relativePath) => readRegularFile(resolve(worktreePath, relativePath)),
        inspectArtifact: async (relativePath) => inspectRegularFile(resolve(worktreePath, relativePath)),
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
      if (certificate.packageVersion !== input.packageVersion) throw new Error('containment package version mismatch');
      if (certificate.argvPolicySha256 !== containmentArgvPolicySha256()) throw new Error('containment argv policy mismatch');
      const version = await commandExecutor(config.codex.command, ['--version']);
      if (version.exitCode !== 0 || version.stdout.trim() !== `codex-cli ${config.codex.requiredVersion}`) {
        throw new Error('current Codex version does not match the containment certificate');
      }
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
      postComment: (issueNumber, body) => input.issues.postComment(issueNumber, body),
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
    implementationAgent,
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
    skillHashes: structuredClone(input.skillHashes),
    createRunId: input.createRunId ?? randomUUID,
    createProofId: input.createProofId ?? randomUUID,
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

interface OwnerLockRecordV1 {
  version: 1;
  token: string;
  canonicalRepository: string;
  host: string;
  bootId: string;
  pid: number;
  acquiredAt: string;
}

async function acquireOwnerLock(input: {
  orchestratorHome: string;
  canonicalRepository: string;
  bootId: string;
  now: () => string;
  processAlive: (pid: number) => boolean;
}): Promise<{ release(): Promise<void> }> {
  const token = randomUUID();
  const host = hostname();
  const record: OwnerLockRecordV1 = {
    version: 1,
    token,
    canonicalRepository: input.canonicalRepository,
    host,
    bootId: input.bootId,
    pid: process.pid,
    acquiredAt: input.now(),
  };
  const repoKey = sha256(input.canonicalRepository);
  try {
    return await acquireExclusiveJsonFileLock({
      path: join(input.orchestratorHome, 'v2', 'owners', `${repoKey}.lock`),
      record,
      token,
      parse: parseOwnerLock,
      tokenOf: (value) => value.token,
      classifyExisting: (value) => value.host === host && value.bootId === input.bootId && input.processAlive(value.pid) ? 'wait' : 'block',
    });
  } catch (error) {
    if (error instanceof Error && /lock (?:owner|record|wait)/u.test(error.message)) throw new OwnerLockSafetyError(error.message);
    throw error;
  }
}

function parseOwnerLock(value: unknown): OwnerLockRecordV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('owner lock is invalid');
  const keys = Object.keys(value).sort();
  const expected = ['version', 'token', 'canonicalRepository', 'host', 'bootId', 'pid', 'acquiredAt'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('owner lock keys are invalid');
  const record = value as unknown as OwnerLockRecordV1;
  if (record.version !== 1 || !record.token || !record.canonicalRepository || !record.host || !record.bootId
    || !Number.isSafeInteger(record.pid) || record.pid <= 0 || Number.isNaN(Date.parse(record.acquiredAt))) {
    throw new Error('owner lock fields are invalid');
  }
  return record;
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

async function prepareContainedAttempt(input: {
  packageRoot: string;
  orchestratorHome: string;
  canonicalRepository: string;
  runId: string;
  attemptId: string;
  skill: 'agent-auto' | 'acceptance-proof';
  expectedPackageVersion: string;
}): Promise<{ skillPath: string; schemaPath: string; reportPath: string; toolHome: string; tmpDir: string }> {
  const runtimeRoot = join(resolve(input.orchestratorHome), 'v2', sha256(input.canonicalRepository));
  const attemptRelativePath = `runs/${input.runId}/attempts/${input.attemptId}`;
  const snapshot = await publishRuntimeAssetSnapshot({
    packageRoot: resolve(input.packageRoot),
    runtimeRoot,
    snapshotRelativePath: `${attemptRelativePath}/snapshot`,
    skill: input.skill,
  });
  if (snapshot.packageVersion !== input.expectedPackageVersion) throw new Error('runtime asset package version mismatch');
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
    skillPath: snapshot.skillPath,
    schemaPath: snapshot.schemaPath,
    reportPath: join(attemptRoot, 'report.json'),
    toolHome,
    tmpDir,
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

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
