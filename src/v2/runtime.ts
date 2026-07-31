import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, unlink } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import { writeDurableAtomicFile } from './adapters/durable-atomic-file.js';
import { GitWorktreeManager } from './adapters/worktree.js';
import type { GitHubIssueAdapter } from './adapters/issues.js';
import type { GitHubPullRequestAdapter } from './adapters/pull-requests.js';
import { ReviewFeedbackObserver } from './review-feedback-coordinator.js';
import { defaultProcessExecutor, type ProcessExecutor } from './adapters/command.js';
import { RunnerAndroidProofController } from './android-proof-runner.js';
import { AcceptanceProof, CandidateProofInspectionError, type FrozenCriterion, type IssueSnapshot, type ProofAgent } from './acceptance-proof.js';
import { createCheckedChangeCapabilities, type CheckedChangeFreshness } from './checked-change.js';
import type { DeliveryAuthorityV1 } from './delivery-authority.js';
import { InjectedContainedReportOperation } from './contained-report-operation.js';
import { ContainedImplementationReviewer } from './implementation-reviewer.js';
import { parseAgentAutoConfig, type AgentAutoConfig } from './config.js';
import {
  canonicalJson,
  parseJsonWithoutDuplicateKeys,
  sha256,
} from './containment.js';
import { CheckProcessQuiescenceError, parseIssueCheckInvocation, resolveIssueCheckPolicy } from './issue-check-policy.js';
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
import {
  OwnerLockContentionError, OwnerLockSafetyError, RunIssue,
  type AttemptCleanupIdentity, type ImplementationAgentResult, type RunIssueGit,
} from './run-issue.js';
import { FileRunRecordWriter, type RunRecordWriter } from './run-store.js';
import { captureProcessStartIdentity, observeProcessGroup, observeProcessIdentity, type ProcessGroupObservation } from './process-identity.js';
import {
  parseWorkflowExecutionProfile,
  type WorkflowExecutionProfile,
  type WorkflowGenerationReceipt,
  verifyWorkflowGeneration,
  type WorkflowOperationPolicy,
} from './workflow-assets.js';
import {
  candidateBindingId,
  candidateBindingSeed,
  candidateRef,
  type CandidateBindingV2,
  type CandidateMaterializationV2,
  type CandidateGitV2,
  type CandidateResult,
} from './candidate.js';

export class LocalGitRunIssueAdapter implements RunIssueGit {
  private readonly worktrees: GitWorktreeManager;
  private readonly candidateRepositories = new Map<string, string>();
  readonly candidateV2: CandidateGitV2;

  constructor(
    private readonly executor: ProcessExecutor = defaultProcessExecutor,
    private readonly repositoryRoot?: string,
  ) {
    this.worktrees = new GitWorktreeManager(executor);
    this.candidateV2 = {
      reconcileOrphans: (input) => this.reconcileCandidateOrphans(input),
      captureAndPin: (input) => this.captureAndPinCandidate(input),
      inspectPin: (binding) => this.inspectCandidatePin(binding),
      normalizeSharedIndex: (input) => this.candidateOperation('candidate-io-failed', async () => {
        if (await this.getHead(input.worktreePath) !== input.expectedHeadSha) throw new Error('candidate expected HEAD diverged');
        await this.git(['-C', input.worktreePath, 'read-tree', input.expectedHeadSha]);
      }),
      prepareMaterialization: (input) => this.prepareCandidateMaterialization(input),
      inspectMaterialization: (input) => this.inspectCandidateMaterialization(input),
      removeMaterialization: (input) => this.removeCandidateMaterialization(input.materialization),
      copyProofArtifacts: (input) => this.copyCandidateProofArtifacts(input),
      createOrObserveCommit: (input) => this.createOrObserveCandidateCommit(input),
      releasePin: (input) => this.releaseCandidatePin(input.binding, input.expectedPinnedCommitSha),
    };
  }

  private async reconcileCandidateOrphans(input: Parameters<NonNullable<CandidateGitV2['reconcileOrphans']>>[0]): Promise<CandidateResult<void>> {
    return this.candidateOperation('candidate-io-failed', async () => {
      const root = (await this.git(['-C', input.repositoryRoot, 'rev-parse', '--show-toplevel'])).trim();
      const activeRefs = new Set(input.activeCandidateRefs);
      const adoptableRefs = new Set<string>();
      for (const pending of input.pendingCandidates) {
        const first = await this.captureCandidateTree(pending.worktreePath, pending.expectedHeadSha, pending.artifactDir);
        const second = await this.captureCandidateTree(pending.worktreePath, pending.expectedHeadSha, pending.artifactDir);
        if (canonicalJson(first) !== canonicalJson(second)) continue;
        const bindingId = candidateBindingId({
          bindingSeed: candidateBindingSeed(pending.runId, pending.boundary),
          expectedHeadSha: pending.expectedHeadSha,
          candidateTreeSha: first.treeSha,
          canonicalChangedFiles: first.changedFiles,
          sourceWorktreeIdentity: first.worktreeIdentity,
        });
        const ref = candidateRef(pending.runId, bindingId);
        const commit = await this.resolveOptionalRef(root, ref);
        if (commit && await this.commitMatches(root, commit, pending.expectedHeadSha, first.treeSha)) adoptableRefs.add(ref);
      }
      const refs = (await this.git(['-C', root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/codex-orchestrator/candidates/']))
        .split('\n').filter(Boolean);
      for (const row of refs) {
        const separator = row.indexOf(' ');
        if (separator < 1) throw new Error('orphan candidate ref row is malformed');
        const ref = row.slice(0, separator);
        const sha = row.slice(separator + 1);
        if (!activeRefs.has(ref) && !adoptableRefs.has(ref)) {
          const deleted = await this.executor('git', ['-C', root, 'update-ref', '-d', ref, sha]);
          if (deleted.exitCode !== 0) throw new Error('orphan candidate ref cleanup failed');
        }
      }
      const materializationRoot = canonicalFilesystemPath(resolve(input.workspaceRoot, '.candidate-materializations'));
      const activeMaterializations = new Map(input.activeMaterializations.map((materialization) => [
        canonicalFilesystemPath(materialization.path), materialization.candidateCommitSha,
      ]));
      for (const worktree of await this.worktrees.listWorktrees(root)) {
        const path = canonicalFilesystemPath(worktree.path);
        const relativePath = relative(materializationRoot, path);
        if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
          const expectedCommit = activeMaterializations.get(path);
          if (expectedCommit) {
            if (worktree.branch !== undefined || await this.getHead(path).catch(() => '') !== expectedCommit) {
              throw new Error('persisted candidate materialization diverged');
            }
          } else {
            if (worktree.branch !== undefined) throw new Error('orphan candidate materialization unexpectedly owns a branch');
            await this.git(['-C', root, 'worktree', 'remove', '--force', path]);
          }
        }
      }
    });
  }

  private async captureAndPinCandidate(input: Parameters<CandidateGitV2['captureAndPin']>[0]): Promise<CandidateResult<CandidateBindingV2>> {
    try {
      const first = await this.captureCandidateTree(input.worktreePath, input.expectedHeadSha, input.artifactDir);
      const second = await this.captureCandidateTree(input.worktreePath, input.expectedHeadSha, input.artifactDir);
      if (canonicalJson(first) !== canonicalJson(second)) {
        return { kind: 'failed', code: 'candidate-unstable', detailSha256: sha256(canonicalJson({ first, second })) };
      }
      const bindingSeed = candidateBindingSeed(input.runId, input.boundary);
      const bindingId = candidateBindingId({
        bindingSeed,
        expectedHeadSha: input.expectedHeadSha,
        candidateTreeSha: first.treeSha,
        canonicalChangedFiles: first.changedFiles,
        sourceWorktreeIdentity: first.worktreeIdentity,
      });
      const ref = candidateRef(input.runId, bindingId);
      const root = (await this.git(['-C', input.worktreePath, 'rev-parse', '--show-toplevel'])).trim();
      this.candidateRepositories.set(ref, root);
      let commitSha = await this.resolveOptionalRef(root, ref);
      if (commitSha) {
        if (!await this.commitMatches(root, commitSha, input.expectedHeadSha, first.treeSha)) throw new Error('existing candidate ref diverged');
      } else {
        commitSha = (await this.git([
          '-C', root, '-c', 'user.name=codex-orchestrator', '-c', 'user.email=codex-orchestrator@users.noreply.github.com',
          'commit-tree', first.treeSha, '-p', input.expectedHeadSha, '-m', `codex-orchestrator candidate ${bindingId}`,
        ])).trim();
        const update = await this.executor('git', ['-C', root, 'update-ref', ref, commitSha, '0'.repeat(commitSha.length)]);
        if (update.exitCode !== 0) {
          const observed = await this.resolveOptionalRef(root, ref);
          if (!observed || !await this.commitMatches(root, observed, input.expectedHeadSha, first.treeSha)) {
            return { kind: 'failed', code: 'candidate-ref-update-unknown', detailSha256: sha256(update.stderr) };
          }
          commitSha = observed;
        }
      }
      return { kind: 'ok', value: {
        version: 2, bindingId, expectedHeadSha: input.expectedHeadSha, candidateRef: ref,
        candidateCommitSha: commitSha, candidateTreeSha: first.treeSha,
        canonicalChangedFiles: first.changedFiles, sourceWorktreeIdentity: first.worktreeIdentity,
      } };
    } catch (error) {
      return candidateFailure('candidate-io-failed', error);
    }
  }

  private async captureCandidateTree(worktreePath: string, expectedHeadSha: string, artifactDir: string): Promise<{
    expectedHeadSha: string; treeSha: string; changedFiles: string[]; worktreeIdentity: string;
  }> {
    validateRelativeRoot(artifactDir);
    const [head, canonicalPath, gitDirectoryRaw] = await Promise.all([
      this.getHead(worktreePath), realpath(worktreePath), this.git(['-C', worktreePath, 'rev-parse', '--absolute-git-dir']),
    ]);
    if (head !== expectedHeadSha) throw new Error('candidate expected HEAD diverged');
    const gitDirectory = gitDirectoryRaw.trim();
    const temporaryRoot = await mkdtemp(join(gitDirectory, 'candidate-index-'));
    const indexPath = join(temporaryRoot, 'index');
    const options = { envOverlay: { GIT_INDEX_FILE: indexPath } };
    try {
      await this.git(['-C', worktreePath, 'read-tree', expectedHeadSha], options);
      await this.git(['-C', worktreePath, 'add', '-u', '--'], options);
      const untracked = (await this.git(['-C', worktreePath, 'ls-files', '--others', '--exclude-standard', '-z'], options)).split('\0')
        .filter((path) => path && path !== artifactDir && !path.startsWith(`${artifactDir}/`)).sort();
      if (untracked.length > 0) {
        await this.git(['-C', worktreePath, 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          ...options, stdin: `${untracked.join('\0')}\0`,
        });
      }
      const treeSha = (await this.git(['-C', worktreePath, 'write-tree'], options)).trim();
      const changedFiles = (await this.git(['-C', worktreePath, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', expectedHeadSha, treeSha]))
        .split('\0').filter(Boolean).sort();
      return {
        expectedHeadSha,
        treeSha,
        changedFiles,
        worktreeIdentity: sha256(canonicalJson({ canonicalPath, gitDirectory })),
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async inspectCandidatePin(binding: CandidateBindingV2): Promise<CandidateResult<'matching' | 'missing' | 'diverged'>> {
    return this.candidateOperation('candidate-io-failed', async () => {
      const root = await this.candidateRepository(binding.candidateRef);
      if (!root) return 'missing';
      const observed = await this.resolveOptionalRef(root, binding.candidateRef);
      if (!observed) return 'missing';
      return observed === binding.candidateCommitSha
        && await this.commitMatches(root, observed, binding.expectedHeadSha, binding.candidateTreeSha) ? 'matching' : 'diverged';
    });
  }

  private async prepareCandidateMaterialization(input: Parameters<CandidateGitV2['prepareMaterialization']>[0]): Promise<Awaited<ReturnType<CandidateGitV2['prepareMaterialization']>>> {
    return this.candidateOperation('candidate-materialization-io-failed', async () => {
      const root = await this.repositoryFromWorkspaceRoot(input.workspaceRoot);
      this.candidateRepositories.set(input.binding.candidateRef, root);
      const path = join(input.workspaceRoot, '.candidate-materializations', input.runId, input.binding.bindingId, input.materializationId);
      const existing = (await this.worktrees.listWorktrees(root)).find((worktree) => sameFilesystemPath(worktree.path, path));
      if (existing) {
        const clean = await this.worktrees.isWorktreeClean(path);
        const head = await this.getHead(path).catch(() => 'missing');
        if (existing.branch !== undefined || head !== input.binding.candidateCommitSha || !clean) return { kind: 'path-diverged', path };
      } else {
        await mkdir(dirname(path), { recursive: true });
        await this.git(['-C', root, 'worktree', 'add', '--detach', path, input.binding.candidateCommitSha]);
      }
      return { kind: 'prepared', materialization: {
        version: 2, bindingId: input.binding.bindingId, candidateCommitSha: input.binding.candidateCommitSha,
        path,
      } };
    });
  }

  private async inspectCandidateMaterialization(input: Parameters<CandidateGitV2['inspectMaterialization']>[0]): Promise<Awaited<ReturnType<CandidateGitV2['inspectMaterialization']>>> {
    return this.candidateOperation('candidate-materialization-io-failed', async () => {
      try {
        const stat = await lstat(input.materialization.path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return 'mutated';
      } catch (error) {
        if (isErrorCode(error, 'ENOENT')) return 'missing';
        throw error;
      }
      const [head, tree, changed] = await Promise.all([
        this.getHead(input.materialization.path),
        this.git(['-C', input.materialization.path, 'rev-parse', 'HEAD^{tree}']).then((value) => value.trim()),
        this.worktrees.listChangedFilesIgnoringUntrackedRoot(input.materialization.path, input.artifactDir),
      ]);
      return head === input.binding.candidateCommitSha && tree === input.binding.candidateTreeSha && changed.length === 0 ? 'matching' : 'mutated';
    });
  }

  private async removeCandidateMaterialization(materialization: CandidateMaterializationV2): Promise<CandidateResult<void>> {
    return this.candidateOperation('candidate-materialization-io-failed', async () => {
      const root = await this.repositoryFromWorkspaceRoot(materialization.path);
      const registered = (await this.worktrees.listWorktrees(root)).find((worktree) => sameFilesystemPath(worktree.path, materialization.path));
      if (!registered) return;
      if (registered.branch !== undefined || await this.getHead(materialization.path) !== materialization.candidateCommitSha) throw new Error('candidate materialization diverged');
      await this.git(['-C', root, 'worktree', 'remove', '--force', materialization.path]);
    });
  }

  private async copyCandidateProofArtifacts(input: Parameters<CandidateGitV2['copyProofArtifacts']>[0]): Promise<Awaited<ReturnType<CandidateGitV2['copyProofArtifacts']>>> {
    return this.candidateOperation('candidate-materialization-io-failed', async () => {
      const proofRoot = `${input.artifactDir}/${input.proofId}`;
      const repositoryRoot = await this.repositoryFromWorkspaceRoot(input.materialization.path);
      const registered = (await this.worktrees.listWorktrees(repositoryRoot))
        .find((worktree) => sameFilesystemPath(worktree.path, input.materialization.path));
      if (!registered || registered.branch !== undefined
        || await this.getHead(input.materialization.path).catch(() => '') !== input.materialization.candidateCommitSha) {
        return { kind: 'artifact-conflict' as const, relativePath: proofRoot };
      }
      const sourceRoot = await inspectSafeArtifactRoot(input.materialization.path);
      const destinationRoot = await inspectSafeArtifactRoot(input.issueWorktreePath);
      for (const artifact of input.artifacts) {
        if (artifact.relativePath !== proofRoot && !artifact.relativePath.startsWith(`${proofRoot}/`)) return { kind: 'artifact-conflict', relativePath: artifact.relativePath };
        try {
          const source = join(input.materialization.path, artifact.relativePath);
          const destination = join(input.issueWorktreePath, artifact.relativePath);
          const sourceBytes = await readRegularFileWithoutSymlinkAncestors(sourceRoot, source);
          if (sha256(sourceBytes) !== artifact.sha256) return { kind: 'artifact-conflict', relativePath: artifact.relativePath };
          await ensureSafeDirectoryPath(destinationRoot, dirname(destination));
          await publishArtifactCreateOnly(destinationRoot, destination, sourceBytes, artifact.sha256);
        } catch (error) {
          if (error instanceof CandidateArtifactConflictError) return { kind: 'artifact-conflict', relativePath: artifact.relativePath };
          throw error;
        }
      }
      return { kind: 'copied-or-observed' };
    });
  }

  private async createOrObserveCandidateCommit(input: Parameters<CandidateGitV2['createOrObserveCommit']>[0]): Promise<Awaited<ReturnType<CandidateGitV2['createOrObserveCommit']>>> {
    return this.candidateOperation('candidate-ref-update-unknown', async () => {
      const root = (await this.git(['-C', input.worktreePath, 'rev-parse', '--show-toplevel'])).trim();
      const ref = `refs/heads/${input.branchName}`;
      const observedHead = (await this.git(['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`])).trim();
      if (observedHead !== input.parentSha) {
        const observed = await this.inspectCommit(root, observedHead);
        if (observed.parentSha === input.parentSha && observed.treeSha === input.treeSha && observed.message === input.message) {
          return { kind: 'created-or-observed', sha: observedHead, ...observed };
        }
        return { kind: 'branch-diverged', observedHeadSha: observedHead };
      }
      if (input.observeOnly) return { kind: 'parent-unchanged' };
      const pin = await this.resolveOptionalRef(root, input.candidateRef);
      if (!pin || (await this.git(['-C', root, 'rev-parse', `${pin}^{tree}`])).trim() !== input.treeSha) throw new Error('candidate pin does not authorize publication tree');
      const sha = (await this.git([
        '-C', root, '-c', 'user.name=codex-orchestrator', '-c', 'user.email=codex-orchestrator@users.noreply.github.com',
        'commit-tree', input.treeSha, '-p', input.parentSha, '-m', input.message,
      ])).trim();
      const update = await this.executor('git', ['-C', root, 'update-ref', ref, sha, input.parentSha]);
      if (update.exitCode !== 0) {
        const after = (await this.git(['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`])).trim();
        if (after === input.parentSha) return { kind: 'parent-unchanged' };
        const observed = await this.inspectCommit(root, after);
        if (observed.parentSha === input.parentSha && observed.treeSha === input.treeSha && observed.message === input.message) {
          return { kind: 'created-or-observed', sha: after, ...observed };
        }
        return { kind: 'branch-diverged', observedHeadSha: after };
      }
      return { kind: 'created-or-observed', sha, parentSha: input.parentSha, treeSha: input.treeSha, message: input.message };
    });
  }

  private async releaseCandidatePin(binding: CandidateBindingV2, expected: string): Promise<CandidateResult<void>> {
    return this.candidateOperation('candidate-ref-update-unknown', async () => {
      const root = await this.candidateRepository(binding.candidateRef);
      if (!root) return;
      const observed = await this.resolveOptionalRef(root, binding.candidateRef);
      if (!observed) return;
      if (observed !== expected) throw new Error('candidate pin diverged');
      const result = await this.executor('git', ['-C', root, 'update-ref', '-d', binding.candidateRef, expected]);
      if (result.exitCode !== 0 && await this.resolveOptionalRef(root, binding.candidateRef)) throw new Error('candidate pin deletion outcome is unknown');
    });
  }

  private async candidateOperation<T>(code: 'candidate-io-failed' | 'candidate-materialization-io-failed' | 'candidate-ref-update-unknown', operation: () => Promise<T>): Promise<CandidateResult<T>> {
    try { return { kind: 'ok', value: await operation() }; }
    catch (error) { return candidateFailure(code, error); }
  }

  private async candidateRepository(ref: string): Promise<string | undefined> {
    const known = this.candidateRepositories.get(ref);
    if (known) return known;
    for (const candidateRoot of [this.repositoryRoot, process.cwd()]) {
      if (!candidateRoot) continue;
      try {
        const root = (await this.git(['-C', candidateRoot, 'rev-parse', '--show-toplevel'])).trim();
        if (await this.resolveOptionalRef(root, ref)) { this.candidateRepositories.set(ref, root); return root; }
      } catch { /* this location need not be in the target repository */ }
    }
    return undefined;
  }

  private async repositoryFromWorkspaceRoot(path: string): Promise<string> {
    let current = resolve(path);
    while (true) {
      try { return (await this.git(['-C', current, 'rev-parse', '--show-toplevel'])).trim(); }
      catch {
        const parent = dirname(current);
        if (parent === current) throw new Error('candidate workspace is not below a Git repository');
        current = parent;
      }
    }
  }

  private async resolveOptionalRef(root: string, ref: string): Promise<string | undefined> {
    const result = await this.executor('git', ['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`]);
    if (result.exitCode === 1 || result.exitCode === 128) return undefined;
    if (result.exitCode !== 0) throw new Error(`git ref inspection failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  private async commitMatches(root: string, commit: string, parent: string, tree: string): Promise<boolean> {
    const observed = await this.inspectCommit(root, commit);
    return observed.parentSha === parent && observed.treeSha === tree;
  }

  private async inspectCommit(root: string, commit: string): Promise<{ parentSha: string; treeSha: string; message: string }> {
    const output = await this.git(['-C', root, 'show', '-s', '--format=%P%n%T%n%B', commit]);
    const [parentSha, treeSha, ...message] = output.split('\n');
    if (!parentSha || parentSha.includes(' ') || !treeSha) throw new Error('candidate commit is not single-parent');
    return { parentSha, treeSha, message: message.join('\n').trimEnd() };
  }

  async getBaseSha(input: { targetRoot: string; baseBranch: string }): Promise<string> {
    await this.git([
      '-C', input.targetRoot, 'fetch', '--quiet', '--no-tags', 'origin', `refs/heads/${input.baseBranch}`,
    ]);
    return (await this.git(['-C', input.targetRoot, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
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
    if (await this.getHead(input.worktreePath) !== input.baseSha) {
      throw new Error('created issue worktree does not match the pinned base SHA');
    }
  }

  async ensureContinuationWorktree(input: {
    targetRoot: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    publishedHeadSha: string;
  }): Promise<void> {
    const localHead = (await this.git([
      '-C', input.targetRoot, 'rev-parse', '--verify', `refs/heads/${input.branchName}`,
    ])).trim();
    const remoteHead = await this.getRemoteBranchSha(input.targetRoot, input.branchName);
    if (localHead !== input.publishedHeadSha || remoteHead !== input.publishedHeadSha) {
      throw new Error('continuation branch refs do not exactly match the published head');
    }
    await this.worktrees.ensureIssueWorktree({
      targetRoot: input.targetRoot,
      workspacePath: input.worktreePath,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      requiredBaseSha: input.publishedHeadSha,
      allowResume: true,
    });
    const observed = await this.inspectWorktree({
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseSha: input.publishedHeadSha,
    });
    if (observed !== 'matching') throw new Error('continuation worktree does not match the published head');
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

  listChangedFilesIgnoringUntrackedRoot(worktreePath: string, ignoredRoot: string): Promise<string[]> {
    return this.worktrees.listChangedFilesIgnoringUntrackedRoot(worktreePath, ignoredRoot);
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

  private async git(args: string[], options?: Parameters<ProcessExecutor>[2]): Promise<string> {
    const result = await this.executor('git', args, options);
    if (result.exitCode !== 0) throw new Error(`git failed: ${result.stderr}`);
    return result.stdout;
  }
}

function candidateFailure<T>(
  code: 'candidate-unstable' | 'candidate-io-failed' | 'candidate-materialization-io-failed' | 'candidate-ref-update-unknown',
  error: unknown,
): CandidateResult<T> {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return { kind: 'failed', code, detailSha256: sha256(detail) };
}

function processGroupIsAlive(processGroupId: number): boolean {
  try { process.kill(-processGroupId, 0); return true; }
  catch (error) { return !isErrorCode(error, 'ESRCH'); }
}

function sameFilesystemPath(left: string, right: string): boolean {
  return canonicalFilesystemPath(left) === canonicalFilesystemPath(right);
}

function canonicalFilesystemPath(value: string): string {
  const resolved = resolve(value);
  return resolved.startsWith('/private/') ? resolved.slice('/private'.length) : resolved;
}

interface SafeArtifactRoot {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

async function inspectSafeArtifactRoot(root: string): Promise<SafeArtifactRoot> {
  const path = resolve(root);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CandidateArtifactConflictError('candidate artifact root is unsafe');
  const realPath = canonicalFilesystemPath(await realpath(path));
  if (realPath !== canonicalFilesystemPath(path)) throw new CandidateArtifactConflictError('candidate artifact root has a symlinked ancestor');
  const identity = { path, realPath, dev: stat.dev, ino: stat.ino };
  await assertSafeArtifactRoot(identity);
  return identity;
}

async function assertSafeArtifactRoot(root: SafeArtifactRoot): Promise<void> {
  const stat = await lstat(root.path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== root.dev || stat.ino !== root.ino
    || canonicalFilesystemPath(await realpath(root.path)) !== root.realPath) {
    throw new CandidateArtifactConflictError('candidate artifact root changed');
  }
}

async function readRegularFileWithoutSymlinkAncestors(rootInput: string | SafeArtifactRoot, path: string): Promise<Buffer> {
  const root = typeof rootInput === 'string' ? await inspectSafeArtifactRoot(rootInput) : rootInput;
  await assertSafeArtifactRoot(root);
  const relativePath = relative(root.path, resolve(path));
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) throw new CandidateArtifactConflictError('candidate artifact path escapes its root');
  let current = root.path;
  const rootStat = await lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new CandidateArtifactConflictError('candidate artifact root is unsafe');
  const ancestorIdentity = [{ path: current, dev: rootStat.dev, ino: rootStat.ino }];
  const segments = relativePath.split('/');
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CandidateArtifactConflictError('candidate artifact ancestor is unsafe');
    ancestorIdentity.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  const finalBeforeOpen = await lstat(path);
  if (finalBeforeOpen.isSymbolicLink() || !finalBeforeOpen.isFile()) {
    throw new CandidateArtifactConflictError('candidate artifact is not a regular file');
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrorCode(error, 'ELOOP')) throw new CandidateArtifactConflictError('candidate artifact is not a regular file');
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CandidateArtifactConflictError('candidate artifact is not a regular file');
    const openedPath = await realpath(path);
    const openedRelative = relative(root.realPath, canonicalFilesystemPath(openedPath));
    if (!openedRelative || openedRelative.startsWith('..') || isAbsolute(openedRelative)) {
      throw new CandidateArtifactConflictError('candidate artifact path escaped its root during read');
    }
    const finalStat = await lstat(path);
    if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino) {
      throw new CandidateArtifactConflictError('candidate artifact changed during read');
    }
    for (const identity of ancestorIdentity) {
      const observed = await lstat(identity.path);
      if (!observed.isDirectory() || observed.isSymbolicLink() || observed.dev !== identity.dev || observed.ino !== identity.ino) {
        throw new CandidateArtifactConflictError('candidate artifact ancestor changed during read');
      }
    }
    await assertSafeArtifactRoot(root);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function ensureSafeDirectoryPath(root: SafeArtifactRoot, directory: string): Promise<void> {
  await assertSafeArtifactRoot(root);
  const relativeDirectory = relative(root.path, resolve(directory));
  if (relativeDirectory.startsWith('..') || isAbsolute(relativeDirectory)) throw new CandidateArtifactConflictError('candidate artifact directory escapes its root');
  let current = root.path;
  for (const segment of relativeDirectory.split('/').filter(Boolean)) {
    current = join(current, segment);
    try { await mkdir(current); }
    catch (error) { if (!isErrorCode(error, 'EEXIST')) throw error; }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CandidateArtifactConflictError('candidate artifact directory is unsafe');
  }
  const parentRealPath = canonicalFilesystemPath(await realpath(directory));
  const parentRelative = relative(root.realPath, parentRealPath);
  if (parentRelative.startsWith('..') || isAbsolute(parentRelative)) throw new CandidateArtifactConflictError('candidate artifact directory escaped its root');
  await assertSafeArtifactRoot(root);
}

class CandidateArtifactConflictError extends Error {}

async function publishArtifactCreateOnly(root: SafeArtifactRoot, destination: string, bytes: Buffer, expectedSha256: string): Promise<void> {
  await assertSafeArtifactRoot(root);
  const temporary = join(dirname(destination), `.${basename(destination)}.${expectedSha256}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (!isErrorCode(error, 'EEXIST')) throw error;
    const stale = await readRegularFileWithoutSymlinkAncestors(root, temporary);
    if (sha256(stale) !== expectedSha256) {
      await unlink(temporary);
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    }
  }
  if (handle) {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      const stat = await handle.stat();
      const observed = await lstat(temporary);
      const temporaryRealPath = canonicalFilesystemPath(await realpath(temporary));
      const temporaryRelative = relative(root.realPath, temporaryRealPath);
      if (!observed.isFile() || observed.isSymbolicLink() || observed.dev !== stat.dev || observed.ino !== stat.ino
        || temporaryRelative.startsWith('..') || isAbsolute(temporaryRelative)) {
        throw new CandidateArtifactConflictError('candidate artifact temporary path changed');
      }
      await assertSafeArtifactRoot(root);
    } finally { await handle.close(); }
  }
  try { await link(temporary, destination); }
  catch (error) {
    if (!isErrorCode(error, 'EEXIST')) throw error;
    const existing = await readRegularFileWithoutSymlinkAncestors(root, destination);
    if (sha256(existing) !== expectedSha256) throw new CandidateArtifactConflictError('candidate artifact destination conflicts');
  }
  const published = await readRegularFileWithoutSymlinkAncestors(root, destination);
  if (sha256(published) !== expectedSha256) throw new CandidateArtifactConflictError('candidate artifact destination conflicts');
  const parent = await open(dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const parentStat = await parent.stat();
    const observedParent = await lstat(dirname(destination));
    const parentRealPath = canonicalFilesystemPath(await realpath(dirname(destination)));
    const parentRelative = relative(root.realPath, parentRealPath);
    if (!observedParent.isDirectory() || observedParent.isSymbolicLink()
      || observedParent.dev !== parentStat.dev || observedParent.ino !== parentStat.ino
      || parentRelative.startsWith('..') || isAbsolute(parentRelative)) {
      throw new CandidateArtifactConflictError('candidate artifact destination directory changed');
    }
    await parent.sync();
    await assertSafeArtifactRoot(root);
  } finally { await parent.close(); }
  await unlink(temporary).catch((error) => { if (!isErrorCode(error, 'ENOENT')) throw error; });
}

export class ContainedImplementationAgent {
  constructor(private readonly dependencies: {
    config: () => AgentAutoConfig;
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
    operation: 'implementation';
    attemptId: string;
    runId: string;
    worktreePath: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    deliveryAuthority: DeliveryAuthorityV1;
    cycle: number;
    reworkFindings: string[];
    repairOnly: boolean;
    workflowGeneration: WorkflowGenerationReceipt;
    reviewFeedbackRound?: number;
    reviewFeedback?: Array<{ id: string; sourceUrl: string; path: string | null; line: number | null; body: string }>;
    onPrepared?: (input: {
      attemptId: string; reportPath: string; preparedAt: string;
      baseline: Omit<CheckedChangeFreshness, 'checkPolicySha256'>;
    }) => Promise<void>;
    onLaunched?: (input: { attemptId: string; pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
    signal: AbortSignal;
  }): Promise<ImplementationAgentResult> {
    const config = this.dependencies.config();
    const canonicalRepository = `${config.github.owner.toLowerCase()}/${config.github.repo.toLowerCase()}`;
    const attemptId = input.attemptId;
    const attempt = await prepareContainedAttempt({
      orchestratorHome: this.dependencies.orchestratorHome,
      canonicalRepository,
      runId: input.runId,
      attemptId,
      operationId: input.operation,
      workflowGeneration: input.workflowGeneration,
      bootId: this.dependencies.bootId,
    });
    const baseline = await this.dependencies.git.snapshot(input.worktreePath);
    await input.onPrepared?.({
      attemptId,
      reportPath: attempt.reportPath,
      preparedAt: (this.dependencies.now ?? (() => new Date().toISOString()))(),
      baseline,
    });
    try {
      try {
        const recovered = await readRegularFile(attempt.reportPath);
        return { kind: 'completed', attemptId, report: decodeAgentReportForValidation(recovered) };
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) return { kind: 'internal-error' };
      }
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
          ...(input.reviewFeedbackRound ? [`Pull-request feedback repair round: ${input.reviewFeedbackRound}.`] : []),
          ...(input.reviewFeedback?.length ? [`Frozen trusted pull-request feedback: ${canonicalJson(input.reviewFeedback)}`] : []),
          `Exact delivery authority: ${canonicalJson(input.deliveryAuthority)}`,
          `Frozen acceptance criteria: ${canonicalJson(input.frozenCriteria)}`,
          ...(input.reworkFindings.length > 0 ? [`Repair these verified findings: ${canonicalJson(input.reworkFindings)}`] : []),
          ...(input.repairOnly ? ['Report repair only: do not modify any worktree file; emit a schema-valid implementation report for the existing change.'] : []),
          'Do not commit, push, publish, or print credentials or local auth paths.',
        ].join('\n'),
        timeoutMs: config.codex.timeoutMs,
        idleTimeoutMs: config.codex.idleTimeoutMs,
        operationPolicy: attempt.policy,
        executionProfile: attempt.profile,
        onSpawned: async ({ pid, processGroupId }) => input.onLaunched?.({
          attemptId, pid, processGroupId, launchedAt: (this.dependencies.now ?? (() => new Date().toISOString()))(),
        }),
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
      return { kind: 'safe-halt' };
    }
  }

}

export class ContainedProofAgent implements ProofAgent<import('./checked-change.js').CheckedChangePayload> {
  constructor(private readonly dependencies: {
    config: () => AgentAutoConfig;
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
    const issueWorktreePath = resolve(this.dependencies.targetRoot, config.runner.workspaceRoot, `issue-${input.issue.number}`);
    const worktreePath = input.worktreePath ? resolve(input.worktreePath) : issueWorktreePath;
    const attempt = await prepareContainedAttempt({
      orchestratorHome: this.dependencies.orchestratorHome,
      canonicalRepository,
      runId: input.runId,
      attemptId: input.attemptId ?? (this.dependencies.createAttemptId ?? randomUUID)(),
      operationId: 'acceptance-proof',
      workflowGeneration: input.workflowGeneration,
      bootId: this.dependencies.bootId,
    });
    const artifactRoot = resolve(worktreePath, config.proof.artifactDir);
    const snapshotRoot = dirname(attempt.sourceSkillPath ?? attempt.operationPath);
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
      try {
        const recoveredReport = await readRegularFile(attempt.reportPath);
        const recoveredInventory = await artifactInventory(artifactRoot, config.proof.artifactDir);
        const runnerPrepared = new Set(input.runnerPreparedArtifactPaths);
        return {
          kind: 'report',
          report: decodeAgentReportForValidation(recoveredReport, ['visualEvidence', 'blocker']),
          proofPhaseChangedFiles: [...recoveredInventory.keys()].filter((path) => !runnerPrepared.has(path)).sort(),
        };
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) throw error;
      }
      if (input.recoverOnly) return { kind: 'internal-error' };
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
          ...(config.proof.android ? [
            `Runner-owned Android artifact paths: ${canonicalJson(input.runnerPreparedArtifactPaths)}.`,
            `Runner-owned Android preparation warnings: ${canonicalJson(input.runnerPreparationWarnings)}.`,
            'The trusted Runner owns emulator, build, adb, lease, capture, and cleanup actions. Do not invoke adb, emulator, Flutter run, or an Android lease helper.',
            'Inspect Runner artifacts when present. If preparation warnings are present, continue with all available non-visual evidence and preserve the warning as a residual risk; Android infrastructure failure alone must not block delivery.',
          ] : [
            'Runner-owned Android proof is not configured for this repository. Do not invoke adb, emulator, Flutter run, or an Android lease helper; return a typed tool blocker for Android criteria.',
          ]),
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
        onSpawned: async ({ pid, processGroupId }) => input.onLaunched?.({
          pid, processGroupId, launchedAt: new Date().toISOString(),
        }),
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
      return error instanceof ProcessQuiescenceError ? { kind: 'safe-halt' } : { kind: 'internal-error' };
    }
  }
}

export async function observeAttemptReadViewCleanup(input: {
  orchestratorHome: string;
  canonicalRepository: string;
  identity: AttemptCleanupIdentity;
}): Promise<'confirmed' | 'pending'> {
  const runtimeRoot = join(resolve(input.orchestratorHome), 'v2', sha256(input.canonicalRepository));
  const attemptRoot = join(runtimeRoot, 'runs', input.identity.runId, 'attempts', input.identity.attemptId);
  const expectedResultPath = join(attemptRoot, 'report.json');
  if (input.identity.resultPath !== expectedResultPath) return 'pending';
  let canonicalRuntimeRoot;
  let canonicalAttemptRoot;
  try { canonicalRuntimeRoot = await realpath(runtimeRoot); }
  catch (error) { return isErrorCode(error, 'ENOENT') ? 'confirmed' : 'pending'; }
  try { canonicalAttemptRoot = await realpath(attemptRoot); }
  catch (error) { return isErrorCode(error, 'ENOENT') ? 'confirmed' : 'pending'; }
  const expectedRelative = relative(runtimeRoot, attemptRoot);
  if (!isPathWithin(canonicalRuntimeRoot, canonicalAttemptRoot)
    || relative(canonicalRuntimeRoot, canonicalAttemptRoot) !== expectedRelative) return 'pending';
  await rm(join(attemptRoot, 'read-view'), { recursive: true, force: true });
  return 'confirmed';
}

export interface V2Runtime {
  runIssue(input: { targetRoot: string; issueNumber: number }): ReturnType<RunIssue['runIssue']>;
  abort(): void;
  dispose(): void;
}

export async function resolveCodexExecutable(command: string, safePath: string): Promise<string> {
  if (command.length === 0 || safePath.length === 0) throw new Error('Codex command and safe path must be non-empty');
  if (!isAbsolute(command) && command.includes('/')) throw new Error('relative Codex command paths are not supported');
  const candidates = isAbsolute(command)
    ? [command]
    : safePath.split(':').filter((entry) => entry.length > 0).map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const stat = await lstat(canonical);
      if (!stat.isFile()) continue;
      await access(canonical, constants.X_OK);
      return canonical;
    } catch {
      // Try the next safe-path entry.
    }
  }
  throw new Error('Codex executable is unavailable in the configured safe path');
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
  proofAgent?: ProofAgent<import('./checked-change.js').CheckedChangePayload>;
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
  const runtimeSafePath = requireRuntimeString(input.safePath, 'safePath');
  let codexExecutable: { command: string; path: string } | undefined;
  const resolveRuntimeCodex = async (command: string) => {
    if (codexExecutable?.command === command) return codexExecutable.path;
    const path = await resolveCodexExecutable(command, runtimeSafePath);
    codexExecutable = { command, path };
    return path;
  };
  const git = input.git ?? new LocalGitRunIssueAdapter(commandExecutor, targetRoot);
  const proofFreshnessGit = git as RunIssueGit & {
    snapshotIgnoringUntrackedRoot?: (
      worktreePath: string,
      ignoredRoot: string,
    ) => Promise<Omit<CheckedChangeFreshness, 'checkPolicySha256'>>;
  };
  const controller = new AbortController();
  let currentConfig: AgentAutoConfig | undefined;
  let runRecords: RunRecordWriter | undefined;
  const containedProcess = input.codexProcess ?? new CodexProcess();
  const configuredAndroidAdbPath = input.androidAdbPath
    ?? process.env.ANDROID_ADB
    ?? (process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : undefined)
    ?? (process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb') : undefined)
    ?? join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
  const androidAdbPath = resolve(configuredAndroidAdbPath);
  const androidEmulatorPath = join(dirname(dirname(androidAdbPath)), 'emulator', 'emulator');
  const iosXcrunPath = resolve(input.iosXcrunPath ?? '/usr/bin/xcrun');
  const containedDependencies = () => ({
    config: () => requireConfig(currentConfig),
    orchestratorHome,
    parentCodexHome: requireRuntimeString(input.parentCodexHome, 'parentCodexHome'),
    safePath: runtimeSafePath,
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
  const androidProofController = new RunnerAndroidProofController({
    adbPath: androidAdbPath,
    emulatorPath: androidEmulatorPath,
    execute: commandExecutor,
    now: () => new Date(now()),
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
      try {
        return { status: 'completed' as const, reportBytes: await readRegularFile(attempt.reportPath) };
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) {
          return { status: 'blocked' as const, kind: 'safety' as const, code: 'report-operation-result-read-failed' };
        }
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
        onSpawned: async ({ pid, processGroupId }) => onLaunched?.({ pid, processGroupId }),
        }, signal);
      } catch (error) {
        if (error instanceof ProcessQuiescenceError) {
          cleanupAfterSafeHalt = true;
          return {
            status: 'safe-halt' as const,
            pid: error.pid,
            processGroupId: error.processGroupId,
            startedAt: now(),
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
  });
  const specOperation: SpecDeliveryOperation = {
    author: async ({ attemptId, context, state, mode, recoverOnly, signal, onPrepared, onLaunched }) => {
      const sessionId = state.authorSessionId ?? attemptId;
      let attempt;
      try {
        attempt = await prepareContainedAttempt({
          orchestratorHome, canonicalRepository: requireCanonicalRepository(currentConfig), runId: context.runId,
          attemptId, operationId: 'spec-author', workflowGeneration: context.workflowGeneration, bootId: input.bootId,
        });
        const revisionPath = join(dirname(attempt.reportPath), `revision-${state.revisions.length + 1}.md`);
        if (!recoverOnly) await onPrepared({ attemptId, sessionId, reportPath: attempt.reportPath, revisionPath });
        const config = requireConfig(currentConfig);
        const result = recoverOnly
          ? { kind: 'completed' as const, report: { kind: 'available' as const, bytes: await readRegularFile(attempt.reportPath) } }
          : await containedProcess.run({
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
            `Prior revisions, accepted answers, and review state: ${canonicalJson({
              revisions: state.revisions,
              acceptedAnswers: state.acceptedAnswers,
              trustedAnswer: state.trustedAnswer ?? null,
              review: state.review,
            })}.`,
            `Write the complete new immutable revision only to ${revisionPath}. Return that exact absolute path and its SHA-256 in the report.`,
            'Do not modify the product worktree, prior revisions, external state, or any .env file.',
          ].join('\n'),
          }, signal);
        if (result.kind === 'cancelled') return { status: 'cancelled' };
        if (['spawn-failed','transport-failed','timeout','idle-timeout'].includes(result.kind)) return { status: 'retryable', code: `spec-author-${result.kind}` };
        if (result.kind !== 'completed' || result.report.kind !== 'available') return { status: 'retryable', code: 'spec-author-report-invalid' };
        const report = decodeAgentReportForValidation(result.report.bytes) as Record<string, unknown>;
        if (!['ready', 'decision-required'].includes(report.status as string) || report.specPath !== revisionPath || report.specSha256 === null) return { status: 'retryable', code: 'spec-author-report-invalid' };
        const content = await readRegularFile(revisionPath);
        if (report.specSha256 !== sha256(content)) return { status: 'retryable', code: 'spec-author-report-invalid' };
        const previous = state.revisions.at(-1) ?? null;
        const revision = createSpecRevision({
          revision: state.revisions.length + 1, path: revisionPath, content: content.toString('utf8'),
          evidence: [{ path: context.issue.url, sha256: sha256(canonicalJson(context.issue)), description: 'Frozen issue authority' }],
          author: { attemptId, sessionId }, previousRevision: previous,
        });
        if (report.status === 'decision-required') {
          if (!Array.isArray(report.decisionGaps) || report.decisionGaps.length === 0 || typeof report.question !== 'string' || report.question.length === 0) {
            return { status: 'retryable', code: 'spec-author-report-invalid' };
          }
          return {
            status: 'decision-required', value: revision, decisionGaps: report.decisionGaps as Array<{ id: string; summary: string; evidence: string[] }>,
            question: report.question, attemptResultSha256: sha256(result.report.bytes),
          };
        }
        return { status: 'completed', attemptResultSha256: sha256(result.report.bytes), value: revision };
      } catch (error) {
        if (error instanceof ProcessQuiescenceError) {
          return { status: 'safe-halt' };
        }
        return { status: 'retryable', code: 'spec-author-report-invalid' };
      }
    },
    review: async ({ attemptId, context, state, recoverOnly, signal, onPrepared, onLaunched }) => {
      const sessionId = state.review.reviewer?.sessionId ?? attemptId;
      try {
        const attempt = await prepareContainedAttempt({
          orchestratorHome, canonicalRepository: requireCanonicalRepository(currentConfig), runId: context.runId,
          attemptId, operationId: 'spec-review', workflowGeneration: context.workflowGeneration, bootId: input.bootId,
        });
        if (!recoverOnly) await onPrepared({ attemptId, sessionId, reportPath: attempt.reportPath });
        const config = requireConfig(currentConfig);
        const result = recoverOnly
          ? { kind: 'completed' as const, report: { kind: 'available' as const, bytes: await readRegularFile(attempt.reportPath) } }
          : await containedProcess.run({
          codexPath: config.codex.command, cwd: context.worktreePath, schemaPath: attempt.schemaPath,
          reportPath: attempt.reportPath, toolHome: attempt.toolHome, tmpDir: attempt.tmpDir,
          safePath: requireRuntimeString(input.safePath, 'safePath'), parentCodexHome: requireRuntimeString(input.parentCodexHome, 'parentCodexHome'),
          parentEnv: process.env, timeoutMs: config.codex.timeoutMs, idleTimeoutMs: config.codex.idleTimeoutMs,
          operationPolicy: attempt.policy, executionProfile: attempt.profile,
          onSpawned: ({ pid, processGroupId }) => onLaunched({ attemptId, sessionId, pid, processGroupId }),
          prompt: [
            `Package profile instructions: ${attempt.profile.developerInstructions}`,
            `Follow the exact operation at ${attempt.operationPath}.`,
            `Reviewer session ID: ${sessionId}. Perform a complete independent review.`,
            `Issue authority and frozen criteria: ${canonicalJson({ issue: context.issue, frozenCriteria: context.frozenCriteria })}.`,
            `Immutable spec delivery state: ${canonicalJson(state)}.`,
            'Return only the package spec-review report. Do not edit files or external state.',
          ].join('\n'),
          }, signal);
        if (result.kind === 'cancelled') return { status: 'cancelled' };
        if (['spawn-failed','transport-failed','timeout','idle-timeout'].includes(result.kind)) return { status: 'retryable', code: `spec-review-${result.kind}` };
        if (result.kind !== 'completed' || result.report.kind !== 'available') return { status: 'retryable', code: 'spec-review-report-invalid' };
        const raw = decodeAgentReportForValidation(result.report.bytes) as Record<string, unknown>;
        if (raw.reviewerSessionId !== sessionId || !Array.isArray(raw.coverage) || !Array.isArray(raw.defects)
          || !Array.isArray(raw.acceptedRisks)
          || !['approved','needs-work','rejected'].includes(raw.verdict as string)) return { status: 'retryable', code: 'spec-review-report-invalid' };
        const target = state.revisions.at(-1)!;
        const defects = validateCodeReviewDefects(raw.defects, target.revision);
        const report: SpecReviewReportV1 = {
          version: 1, targetRevision: target.revision, targetSha256: target.revisionSha256,
          verdict: raw.verdict as SpecReviewReportV1['verdict'], reviewer: { attemptId, sessionId },
          coverage: raw.coverage as string[], defects,
          acceptedRisks: [],
        };
        return { status: 'completed', value: report, attemptResultSha256: sha256(result.report.bytes), reportSha256: sha256(result.report.bytes) };
      } catch (error) {
        if (error instanceof ProcessQuiescenceError) {
          return { status: 'safe-halt' };
        }
        return { status: 'retryable', code: 'spec-review-report-invalid' };
      }
    },
  };

  const readConfig = async (requestedRoot: string) => {
    if (resolve(requestedRoot) !== targetRoot) throw new Error('runtime target root mismatch');
    const bytes = await readRegularFile(join(targetRoot, '.codex-orchestrator', 'config.json'));
    const parsed = parseAgentAutoConfig(parseJsonWithoutDuplicateKeys(bytes.toString('utf8')));
    const config: AgentAutoConfig = {
      ...parsed,
      codex: { ...parsed.codex, command: await resolveRuntimeCodex(parsed.codex.command) },
    };
    const path = join(targetRoot, config.runner.stateDir, 'v2', 'run-state.json');
    if (!runRecords) runRecords = new FileRunRecordWriter(path);
    currentConfig = config;
    return { bytes, config };
  };
  const records: RunRecordWriter = {
    inspect: async () => {
      if (!runRecords) throw new Error('run store used before config');
      return runRecords.inspect();
    },
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
    proveChange: async (proofInput: Parameters<AcceptanceProof<import('./checked-change.js').CheckedChangePayload>['proveChange']>[0]) => {
      const config = requireConfig(currentConfig);
      const checked = capabilities.verifyAndRead(proofInput.checkedChange);
      const repoKey = sha256(checked.payload.canonicalRepository);
      const issueWorktreePath = resolve(targetRoot, config.runner.workspaceRoot, `issue-${checked.payload.issueNumber}`);
      const worktreePath = proofInput.materialization?.path ?? issueWorktreePath;
      const androidLease = new FileAndroidLeaseVerifier({
        leaseRoot: join(orchestratorHome, 'v2', repoKey, 'leases'),
        worktreeRoot: worktreePath,
        now: () => new Date(now()),
        artifactRelativePathForProof: (proofId) => `${config.proof.artifactDir}/${proofId}/android-lease.json`,
        targetController: androidProofController,
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
      const acceptanceProof = new AcceptanceProof<import('./checked-change.js').CheckedChangePayload>({
        checkedChangeReader: capabilities,
        proofAgent,
        inspectFreshness: async (payload, materialization) => {
          const checkPolicySha256 = sha256(canonicalJson(resolveIssueCheckPolicy(proofInput.issue.body, config.checks).checks));
          if (payload.version === 1) return {
            ...await (proofFreshnessGit.snapshotIgnoringUntrackedRoot
              ? proofFreshnessGit.snapshotIgnoringUntrackedRoot(worktreePath, config.proof.artifactDir)
              : git.snapshot(worktreePath)),
            checkPolicySha256,
          };
          if (!materialization || !git.candidateV2) throw new CandidateProofInspectionError('candidate-git-v2-required');
          const inspection = await git.candidateV2.inspectMaterialization({
            binding: payload.binding,
            materialization,
            artifactDir: config.proof.artifactDir,
          });
          if (inspection.kind === 'failed') throw new CandidateProofInspectionError(inspection.code);
          if (inspection.value !== 'matching') throw new CandidateProofInspectionError('candidate-materialization-mutated');
          return { bindingId: payload.binding.bindingId, candidateTreeSha: payload.binding.candidateTreeSha, checkPolicySha256 };
        },
        readArtifact: async (relativePath) => readRegularFile(resolve(worktreePath, relativePath)),
        inspectArtifact: async (relativePath) => inspectRegularFile(resolve(worktreePath, relativePath)),
        androidLease,
        iosLease,
        proofArtifactDir: config.proof.artifactDir,
        signal: controller.signal,
      });
      const androidRelevant = !!config.proof.android && isAndroidProofRelevant(
        proofInput.issue,
        proofInput.frozenCriteria,
        checked.payload.changedFiles,
      );
      const runnerPreparedArtifactPaths: string[] = [];
      const runnerPreparedArtifactSha256: Record<string, string> = {};
      const runnerPreparationWarnings: string[] = [];
      let preparationAttempted = false;
      const result = await acceptanceProof.proveChange({
        ...proofInput,
        runnerPreparedArtifactPaths,
        runnerPreparedArtifactSha256,
        runnerPreparationWarnings,
        beforeAgentLaunch: async () => {
          await proofInput.beforeAgentLaunch?.();
          if (!androidRelevant || preparationAttempted) return;
          preparationAttempted = true;
          const prepared = await androidProofController.prepare({
            proofId: proofInput.proofId,
            worktreePath,
            artifactDir: config.proof.artifactDir,
            leaseRoot: join(orchestratorHome, 'v2', repoKey, 'leases'),
            config: config.proof.android!,
            checks: checked.payload.checks,
            checkedChangeSha256: checked.checkedChangeSha256,
            proofAgentBudgetMs: config.codex.timeoutMs * 3,
            signal: controller.signal,
          });
          if (prepared.status === 'prepared') {
            runnerPreparedArtifactPaths.splice(0, runnerPreparedArtifactPaths.length, ...prepared.runnerPreparedArtifactPaths);
            Object.assign(runnerPreparedArtifactSha256, prepared.runnerPreparedArtifactSha256);
          } else {
            runnerPreparationWarnings.push(`Android UI proof unfinished: ${prepared.summary}`);
          }
        },
      });
      if (checked.payload.version === 2 && proofInput.materialization && git.candidateV2 && result.status === 'passed') {
        const artifacts = result.receipt.publishableEvidence.map((artifact) => ({ relativePath: artifact.ref, sha256: artifact.sha256 }));
        const copied = await git.candidateV2.copyProofArtifacts({
          materialization: proofInput.materialization,
          issueWorktreePath,
          artifactDir: config.proof.artifactDir,
          proofId: proofInput.proofId,
          artifacts,
        });
        if (copied.kind === 'failed') throw new CandidateProofInspectionError(copied.code);
        if (copied.value.kind === 'artifact-conflict') throw new CandidateProofInspectionError('candidate-artifact-conflict');
      }
      return result;
    },
  };
  const runner = new RunIssue({
    readConfig,
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
          comments: comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            authorAssociation: comment.authorAssociation,
            author: comment.author.login,
            authorId: comment.author.id,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
          })),
        };
      },
      setLabels: async (issueNumber, labels) => {
        const current = await input.issues.getLabels(issueNumber);
        await input.issues.updateIssue(issueNumber, {
          addLabels: labels.filter((label) => !current.includes(label)),
          removeLabels: current.filter((label) => !labels.includes(label)),
        });
      },
      getRepositoryPermission: (login, expectedUserId) => input.issues.getRepositoryPermission(login, expectedUserId),
      transitionToBlocked: async (issueNumber, labels) => {
        const current = await input.issues.getLabels(issueNumber);
        if (current.includes(labels.review)) return;
        const hasRunnerStatus = current.some((label) => (
          label === labels.auto || label === labels.running || label === labels.blocked
        ));
        if (!hasRunnerStatus) return;
        await input.issues.updateIssue(issueNumber, {
          addLabels: current.includes(labels.blocked) ? [] : [labels.blocked],
          removeLabels: current.includes(labels.running) ? [labels.running] : [],
        });
      },
      postComment: async (issueNumber, body) => { await input.issues.postComment(issueNumber, body); },
    },
    pullRequests: {
      findOpen: async ({ headBranch, baseBranch }) => {
        const matches = (await input.pullRequests.listAllByHeadBranch(headBranch))
          .filter((pullRequest) => pullRequest.state === 'OPEN' && pullRequest.baseRefName === baseBranch);
        if (matches.length > 1) throw new Error('multiple open pull requests match publication pendingEffect');
        const match = matches[0];
        if (!match) return undefined;
        const reviewTarget = await input.pullRequests.getReviewTarget(match.number);
        return {
          url: match.url,
          body: match.body,
          number: match.number,
          nodeId: match.nodeId,
          ...(reviewTarget ? { headSha: reviewTarget.headRefOid } : {}),
        };
      },
      createDraft: async ({ title, body, headBranch, baseBranch }) => input.pullRequests.createDraftPullRequest({ title, body, headBranch, baseBranch }),
      listConversationComments: async (number) => (await input.pullRequests.listConversationComments(number))
        .map((comment) => ({ id: comment.id, body: comment.body })),
      postConversationComment: async (number, body) => {
        const comment = await input.pullRequests.postConversationComment(number, body);
        return { id: comment.id, body: comment.body };
      },
    },
    reviewFeedback: new ReviewFeedbackObserver({ pullRequests: input.pullRequests, issues: input.issues, now }),
    git,
    routeCoordinator: {
      run: ({ state, ...routeInput }) => new RouteCoordinator({
        state,
        operation: reportOperation,
        now,
        createReceipt: ({ artifact, triage, decidedAt }) => {
          if (artifact.status === 'blocked') throw new Error('blocked triage cannot create a route receipt');
          const receipt: RouteReceiptV1 = {
            version: 1,
            route: artifact.status,
            triage,
            review: null,
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
    },
    implementationAgent,
    implementationReviewer,
    checks: {
      supportsLaunchOwnership: true,
      run: async ({ source, command, cwd, signal, onLaunched }) => {
        const timeoutMs = requireConfig(currentConfig).codex.timeoutMs;
        return source === 'issue'
          ? runProcessCheck(parseIssueCheckInvocation(command), cwd, signal, timeoutMs, onLaunched)
          : runShellCheck(command, cwd, signal, timeoutMs, onLaunched);
      },
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
    outcomeEvidencePath: (runId, code, summarySha256) => `${requireConfig(currentConfig).runner.stateDir}/v2/evidence/${runId}/${sha256(code)}-${summarySha256}.json`,
    inspectOutcomeEvidence: async (path) => {
      try { return { sha256: sha256(await readRegularFile(resolve(targetRoot, path))) }; }
      catch (error) {
        if (isErrorCode(error, 'ENOENT')) return undefined;
        throw error;
      }
    },
    writeOutcomeEvidence: ({ path, bytes, sha256: expectedSha256 }) => writeExactDurableBytes(
      resolve(targetRoot, path), bytes, expectedSha256,
    ),
    packageVersion: input.packageVersion,
    createWorkflowGeneration: input.createWorkflowGeneration,
    verifyWorkflowGeneration,
    createRunId: input.createRunId ?? randomUUID,
    createProofId: input.createProofId ?? randomUUID,
    createReviewSessionId: input.createAttemptId ?? randomUUID,
    processIdentity: {
      host: hostname(),
      bootId: input.bootId,
      capture: async (pid, processGroupId) => {
        const captured = await captureProcessStartIdentity({ platform: process.platform, pid, processGroupId });
        return captured.status === 'available' ? captured.identity : undefined;
      },
      observe: async (identity) => ({
        leader: await observeProcessIdentity({ platform: process.platform, ...identity }),
        group: observeProcessGroup(identity.processGroupId),
      }),
    },
    inspectAttemptResult: async (path) => {
      try {
        const bytes = await readRegularFile(path);
        return { bytes, sha256: sha256(bytes) };
      }
      catch (error) {
        if (isErrorCode(error, 'ENOENT')) return undefined;
        throw error;
      }
    },
    observeAttemptCleanup: async (attempt) => {
      return observeAttemptReadViewCleanup({
        orchestratorHome,
        canonicalRepository: requireCanonicalRepository(currentConfig),
        identity: attempt,
      });
    },
    writeAttemptResult: ({ path, bytes, sha256: expectedSha256 }) => writeExactDurableBytes(path, bytes, expectedSha256),
    attemptResultPath: ({ canonicalRepository, runId, attemptId }) => join(
      resolve(orchestratorHome),
      'v2',
      sha256(canonicalRepository),
      'runs',
      runId,
      'attempts',
      attemptId,
      'report.json',
    ),
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
  const beforeOpen = await lstat(path);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) throw new Error(`${path} is not a bounded regular file`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error(`${path} is not a bounded regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeExactDurableBytes(path: string, bytes: Buffer, expectedSha256: string): Promise<void> {
  if (sha256(bytes) !== expectedSha256) throw new Error('durable result bytes do not match expected SHA-256');
  try {
    const existing = await readRegularFile(path);
    if (sha256(existing) !== expectedSha256) throw new Error('durable result path already contains different bytes');
    return;
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error;
  }
  await writeDurableAtomicFile(path, bytes, 0o600);
  const observed = await readRegularFile(path);
  if (sha256(observed) !== expectedSha256) throw new Error('durable result write postcondition failed');
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

export interface CheckExecutionResult {
  status: 'passed' | 'failed';
  output: Buffer;
  outputSha256: string;
  observation: { leader: 'absent'; group: ProcessGroupObservation };
}

export async function runShellCheck(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  onLaunched?: (input: { pid: number; processGroupId: number }) => Promise<void>,
): Promise<CheckExecutionResult> {
  return runSpawnCheck('/bin/sh', ['-lc', command], cwd, signal, timeoutMs, onLaunched);
}

async function runProcessCheck(
  invocation: { file: string; args: string[] },
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  onLaunched?: (input: { pid: number; processGroupId: number }) => Promise<void>,
): Promise<CheckExecutionResult> {
  return runSpawnCheck(invocation.file, invocation.args, cwd, signal, timeoutMs, onLaunched);
}

async function runSpawnCheck(
  file: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  onLaunched?: (input: { pid: number; processGroupId: number }) => Promise<void>,
): Promise<CheckExecutionResult> {
  return new Promise((resolveCheck, rejectCheck) => {
    const child = spawn('/bin/sh', [
      '-c', 'IFS= read -r _ || exit 125; exec "$@"', 'codex-orchestrator-check-gate', file, ...args,
    ], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const launchOwnership = child.pid && onLaunched
      ? onLaunched({ pid: child.pid, processGroupId: child.pid })
      : Promise.resolve();
    const chunks: Buffer[] = [];
    let retained = 0;
    const outputHash = createHash('sha256');
    let settled = false;
    let timedOut = false;
    let terminationRequested = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();
    const collect = (chunk: Buffer) => {
      outputHash.update(chunk);
      if (retained >= 1024 * 1024) return;
      const kept = chunk.subarray(0, 1024 * 1024 - retained);
      chunks.push(kept);
      retained += kept.length;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const terminate = () => {
      terminationRequested = true;
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already absent */ }
      killTimer = setTimeout(() => {
        if (settled || !child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already absent */ }
      }, 5_000);
      killTimer.unref();
    };
    void launchOwnership.then(() => child.stdin.end('\n')).catch(() => terminate());
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    child.once('error', (error) => {
      settled = true;
      signal.removeEventListener('abort', terminate);
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      rejectCheck(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', terminate);
      clearTimeout(timeout);
      void (async () => {
        if (terminationRequested && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
            if (!isErrorCode(error, 'ESRCH')) {
              rejectCheck(new CheckProcessQuiescenceError(child.pid));
              return;
            }
          }
          if (!await waitForProcessGroupAbsentWithin(child.pid, 5_000)) {
            rejectCheck(new CheckProcessQuiescenceError(child.pid));
            return;
          }
        }
        if (killTimer) clearTimeout(killTimer);
        if (timedOut) {
          rejectCheck(new Error(`Check exceeded ${timeoutMs}ms and was terminated.`));
          return;
        }
        await launchOwnership;
        resolveCheck({
          status: code === 0 ? 'passed' : 'failed',
          output: Buffer.concat(chunks),
          outputSha256: outputHash.digest('hex'),
          observation: {
            leader: 'absent',
            group: child.pid ? observeProcessGroup(child.pid) : 'unknown',
          },
        });
      })().catch(rejectCheck);
    });
  });
}

async function waitForProcessGroupAbsentWithin(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(-processGroupId, 0); }
    catch (error) {
      if (isErrorCode(error, 'ESRCH')) return true;
      if (!isErrorCode(error, 'EPERM')) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return false;
}

function requireConfig(config: AgentAutoConfig | undefined): AgentAutoConfig {
  if (!config) throw new Error('runtime config is unavailable');
  return config;
}

function requireCanonicalRepository(config: AgentAutoConfig | undefined): string {
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
  operationId: 'implementation' | 'acceptance-proof' | 'triage' | 'code-review' | 'spec-author' | 'spec-review';
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
  const reportOnly = input.operationId === 'triage'
    || input.operationId === 'code-review' || input.operationId === 'spec-review';
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
  const rootIdentity = await inspectSafeArtifactRoot(root);
  const visit = async (directory: string, relative: string): Promise<void> => {
    await assertSafeArtifactRoot(rootIdentity);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('proof artifact tree contains a symlink');
      if (entry.isDirectory()) await visit(childPath, childRelative);
      else if (entry.isFile()) output.set(`${logicalRoot}/${childRelative}`, sha256(await readRegularFileWithoutSymlinkAncestors(rootIdentity, childPath)));
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

function isAndroidProofRelevant(issue: IssueSnapshot, criteria: FrozenCriterion[], changedFiles: string[]): boolean {
  return /\bandroid\b/iu.test([issue.title, issue.body, ...criteria.map((criterion) => criterion.text)].join('\n'))
    || changedFiles.some((path) => /^(?:android\/|lib\/|assets\/|fonts\/|pubspec\.(?:yaml|lock)$)/u.test(path));
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
