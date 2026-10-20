import { runConfiguredChecks } from './runner-checks.js';
import { readIssueProofRequirements } from './issue-proof-policy.js';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, unlink } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeDurableAtomicFile } from './adapters/durable-atomic-file.js';
import { GitWorktreeManager } from './adapters/worktree.js';
import type { GitHubIssueAdapter } from './adapters/issues.js';
import type { GitHubPullRequestAdapter } from './adapters/pull-requests.js';
import { ReviewFeedbackObserver } from './review-feedback-coordinator.js';
import { CommandProcessQuiescenceError, defaultProcessExecutor, type ProcessExecutor } from './adapters/command.js';
import { RunnerAndroidProofController } from './android-proof-runner.js';
import { AcceptanceProof, CandidateProofInspectionError, proofFailureSummary, type FrozenCriterion, type IssueSnapshot, type ProofProcessFailure } from './acceptance-proof.js';
import { createCheckedChangeCapabilities, type CheckedChangeFreshness } from './checked-change.js';
import type { DeliveryAuthority } from './delivery-authority.js';
import { parseAgentAutoConfig, type AgentAutoConfig } from './config.js';
import {
  canonicalJson,
  parseJsonWithoutDuplicateKeys,
  sha256,
  validateContainmentOperationPolicy,
} from './containment.js';
import { acquireOwnerControlLock, OwnerControlLockBlockedError, inspectProcessIdentity, readProcessStartIdentity, type OwnerControlLockHandle } from './owner-control-lock.js';
import { decodeAgentReportForValidation } from './report-envelope.js';
import { CodexProcess, ProcessQuiescenceError } from './codex-process.js';
import { FileAndroidLeaseVerifier, FileIosLeaseVerifier, type IosLeaseRecordV1 } from './mobile-lease.js';
import { publishRuntimeAssetSnapshot } from './runtime-assets.js';
import {
  OwnerLockContentionError, OwnerLockSafetyError, RunIssue, RunConfigurationError,
  type AttemptCleanupIdentity, type ImplementationAgentResult, type RunIssueGit, type RunIssueSnapshot,
} from './run-issue.js';
import { FileRunRecordWriter, type RunRecordWriter, type RunRecord } from './run-store.js';
import { captureProcessStartIdentity, observeProcessGroup, observeProcessIdentity } from './process-identity.js';
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
  type CandidateBoundaryV2,
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
      inspectSource: (input) => this.inspectCandidateSource(input),
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
          // Absence from this stateDir cannot prove that another journal does not own the ref.
          throw new Error('candidate ref ownership is unknown; preserve it for inspection');
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
            throw new Error('candidate materialization ownership is unknown; preserve it for inspection');
          }
        }
      }
    });
  }

  private async inspectCandidateSource(input: Parameters<CandidateGitV2['inspectSource']>[0]): Promise<CandidateResult<'matching' | 'changed'>> {
    return this.candidateOperation('candidate-io-failed', async () => {
      const first = await this.captureCandidateTree(input.worktreePath, input.binding.expectedHeadSha, input.artifactDir);
      const second = await this.captureCandidateTree(input.worktreePath, input.binding.expectedHeadSha, input.artifactDir);
      if (canonicalJson(first) !== canonicalJson(second)) throw new Error('candidate source is unstable');
      const bindingId = candidateBindingId({
        bindingSeed: candidateBindingSeed(input.runId, input.boundary), expectedHeadSha: input.binding.expectedHeadSha,
        candidateTreeSha: first.treeSha, canonicalChangedFiles: first.changedFiles, sourceWorktreeIdentity: first.worktreeIdentity,
      });
      return bindingId === input.binding.bindingId && first.treeSha === input.binding.candidateTreeSha
        && canonicalJson(first.changedFiles) === canonicalJson(input.binding.canonicalChangedFiles) ? 'matching' : 'changed';
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
      const [head, tree, unchanged] = await Promise.all([
        this.getHead(input.materialization.path),
        this.git(['-C', input.materialization.path, 'rev-parse', 'HEAD^{tree}']).then((value) => value.trim()),
        this.worktrees.listChangedFilesIgnoringUntrackedRoot(input.materialization.path, input.artifactDir)
          .then(files => files.length === 0),
      ]);
      return head === input.binding.candidateCommitSha && tree === input.binding.candidateTreeSha && unchanged ? 'matching' : 'mutated';
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
    const [headSha, canonicalPath, gitDirectoryRaw] = await Promise.all([
      this.getHead(worktreePath),
      realpath(worktreePath),
      this.git(['-C', worktreePath, 'rev-parse', '--absolute-git-dir']),
    ]);
    const gitDirectory = gitDirectoryRaw.trim();
    const temporaryRoot = await mkdtemp(join(gitDirectory, 'snapshot-index-'));
    const indexPath = join(temporaryRoot, 'index');
    const options = { envOverlay: { GIT_INDEX_FILE: indexPath } };
    try {
      await copyFile(join(gitDirectory, 'index'), indexPath);
      const indexTreeSha = await this.git(['-C', worktreePath, 'write-tree'], options);
      const trackedDiff = await this.git(['-C', worktreePath, 'diff', '--binary', 'HEAD'], options);
      const untrackedPaths = await this.git(['-C', worktreePath, 'ls-files', '--others', '--exclude-standard', '-z'], options);
      const untracked: Array<{ path: string; sha256: string }> = [];
      for (const path of untrackedPaths.split('\0').filter(Boolean).sort()) {
        if (ignoredRoot && (path === ignoredRoot || path.startsWith(`${ignoredRoot}/`))) continue;
        untracked.push({ path, sha256: sha256(await readFile(join(canonicalPath, path))) });
      }
      return {
        headSha,
        indexTreeSha: indexTreeSha.trim(),
        trackedContentSha256: sha256(trackedDiff),
        untrackedContentSha256: sha256(canonicalJson(untracked)),
        worktreeIdentity: sha256(canonicalJson({ canonicalPath, gitDirectory })),
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  listChangedFiles(worktreePath: string): Promise<string[]> {
    return this.worktrees.listChangedFiles(worktreePath);
  }

  async diffTrees(worktreePath: string, previousTreeSha: string, candidateTreeSha: string): Promise<{ changedFiles: string[]; patch: string }> {
    const [names, patch] = await Promise.all([
      this.git(['-C', worktreePath, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', previousTreeSha, candidateTreeSha], { maxOutputBytes: 1024 * 1024 }),
      this.git(['-C', worktreePath, 'diff', '--binary', '--full-index', '--no-ext-diff', previousTreeSha, candidateTreeSha, '--']),
    ]);
    return { changedFiles: names.split('\0').filter(Boolean).sort(), patch };
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

async function readRegularFileWithoutSymlinkAncestors(rootInput: string | SafeArtifactRoot, path: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
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
    if (!stat.isFile() || stat.size > maxBytes) throw new CandidateArtifactConflictError('candidate artifact is not a bounded regular file');
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
    processExecutor?: ProcessExecutor;
    iosXcrunPath?: string;
    process?: CodexProcess;
    createAttemptId?: () => string;
    now?: () => string;
  }) {}

  async run(input: {
    operation: 'implementation';
    proofId: string;
    sessionId?: string;
    androidProofPreparation?: RunRecord['androidProofPreparation'];
    runnerChecks?: RunRecord['runnerChecks'];
    onSessionStarted?: (sessionId: string) => Promise<void>;
    attemptId: string;
    runId: string;
    worktreePath: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    deliveryAuthority: DeliveryAuthority;
    cycle: number;
    reworkFindings: string[];
    reportCorrection?: { bytes: Buffer; sha256: string; diagnostic: string };
    workflowGeneration: WorkflowGenerationReceipt;
    reviewFeedbackRound?: number;
    reviewFeedback?: Array<{ id: string; sourceUrl: string; path: string | null; line: number | null; body: string }>;
    reviewFeedbackPullRequest?: { number: number; headSha: string; headRefName: string; url: string };
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
    let correctionView: string | undefined;
    let unresolvedProcess = false;
    try {
      try {
        const recovered = await readRegularFile(attempt.reportPath);
        return { kind: 'completed', attemptId, report: decodeAgentReportForValidation(recovered), reportBytes: recovered };
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) {
          if (isTechnicalRuntimeError(error)) throw error;
          return { kind: 'internal-error' };
        }
      }
      if (input.reportCorrection) correctionView = await prepareReportCorrectionView({
        worktreePath: input.worktreePath, destination: join(dirname(attempt.tmpDir), 'read-view'),
        deniedPaths: config.deny.readPaths, correction: input.reportCorrection, schemaPath: attempt.schemaPath, signal: input.signal,
      });
      const iosXcrunPath = this.dependencies.iosXcrunPath ?? '/usr/bin/xcrun';
      const iosTooling = input.reportCorrection ? undefined : await discoverIosTooling(this.dependencies.processExecutor ?? defaultProcessExecutor, iosXcrunPath);
      const result = await (this.dependencies.process ?? new CodexProcess()).run({
        codexPath: config.codex.command,
        sessionId: input.sessionId,
        onSessionStarted: input.onSessionStarted,
        agentProfilePaths: { ...attempt.reviewerProfiles, implementer: join(attempt.workflowRoot, 'profiles/implementer.toml') },
        cwd: correctionView ?? input.worktreePath,
        schemaPath: attempt.schemaPath,
        reportPath: attempt.reportPath,
        toolHome: attempt.toolHome,
        tmpDir: attempt.tmpDir,
        safePath: this.dependencies.safePath,
        parentCodexHome: this.dependencies.parentCodexHome,
        parentEnv: process.env,
        prompt: input.reportCorrection ? [
          reportCorrectionPrompt(input.reportCorrection),
          `Required configured checks: ${canonicalJson(config.checks)}. Correct evidence only; do not execute commands in report-only mode.`,
          `Use the exact structured output schema at ${attempt.schemaPath}.`,
          `Retain the existing operation ${attempt.operationPath}; correct its report only.`,
        ].join('\n') : [
          `Package profile instructions: ${attempt.profile.developerInstructions}`,
          `Process authority: ${attempt.sourceSkillPath}`,
          `Invocation contract: ${attempt.operationPath}`,
          `The operation's immutable workflow root is ${attempt.workflowRoot}.`,
          ...(input.reportCorrection ? [reportCorrectionPrompt(input.reportCorrection)] : [`Implement issue #${input.issue.number}: ${input.issue.title}`]),
          `Authorized issue body (task data): ${input.issue.body}`,
          `Implementation cycle: ${input.cycle}.`,
          ...(input.reviewFeedbackRound ? [`Trusted feedback follow-up round: ${input.reviewFeedbackRound}.`] : []),
          ...(input.reviewFeedbackPullRequest ? [`Current same-branch draft pull request: ${canonicalJson(input.reviewFeedbackPullRequest)}`] : []),
          ...(input.reviewFeedback?.length ? [`Frozen trusted feedback: ${canonicalJson(input.reviewFeedback)}`] : []),
          ...(input.reviewFeedback?.some((feedback) => feedback.id.startsWith('issue-comment:')) ? [
            'For this issue-comment cycle, either make an in-scope repair, return answer-only without modifying files, or return boundary without modifying files when authority is ambiguous or exceeded.',
          ] : []),
          `iOS lease helper: ${join(attempt.workflowRoot, 'skills/acceptance-proof/tools/ios-lease.mjs')}. Use the packaged iOS proof procedure for iOS criteria only.`,
          `iOS lease root: ${join(resolve(this.dependencies.orchestratorHome), 'v2', sha256(canonicalRepository), 'leases')}.`,
          `iOS lease artifact: ${resolve(input.worktreePath, config.proof.artifactDir, input.proofId, 'ios-lease.json')}.`,
          `iOS lease proof ID: ${input.proofId}; owner PID: ${process.pid}; xcrun: ${iosXcrunPath}.`,
          ...(iosTooling ? [`iOS runtime ID: ${iosTooling.runtimeId}; device type ID: ${iosTooling.deviceTypeId}.`] : ['iOS tooling is unavailable; return a tool blocker if iOS proof is required.']),
          `Proof artifacts belong under ${config.proof.artifactDir}/${input.proofId}/. Use proof criterion IDs and configured check IDs exactly as supplied.`,
          ...(input.androidProofPreparation ? [`Runner Android preparation (trusted resource result): ${canonicalJson(input.androidProofPreparation)}. Use the prepared artifacts and leased target through the synchronized Android skills. Do not change source or configured checks after preparation; report a blocker if further edits are required.`] : []),
          `Acceptance criteria: ${canonicalJson(input.frozenCriteria.map(criterion => criterion.source === 'fallback' ? { id: criterion.id, source: criterion.source, text: 'Prove the authorized issue above.' } : criterion))}`,
          ...(input.reworkFindings.length > 0 ? [`Repair these verified findings: ${canonicalJson(input.reworkFindings)}`] : []),
          'In a completed report, changedFiles is the complete current candidate diff relative to the original HEAD, including files retained from earlier cycles. A verification-only repair with no new edits still returns completed with that complete current diff.',
          ...(config.runner.checkExecution === 'host' ? [
            `Required host commands: ${canonicalJson(config.checks)}. Runner executes these ordinary local processes; do not run them inside the sandbox. After final source edits return checks-request before proof and Review.`,
            ...(input.runnerChecks ? [`Trusted Runner check results: ${canonicalJson(input.runnerChecks)}. Results match current source: ${input.runnerChecks.sourceSha256 === sha256(canonicalJson(baseline))}. If false, request fresh checks before proof or Review. Read complete logs at logPath. Use only passing exact Runner receipts for the unchanged source. After an in-scope source repair request checks again; otherwise report the concrete blocker. Complete proof and independent Review only after all required host checks passed.`] : []),
          ] : [`Required commands: ${canonicalJson(config.checks)}. Include the exact policy in any child assignment. Run heavy checks sequentially. Retain passing evidence only while source and command policy remain unchanged. Diagnose and correct failures before rechecking; otherwise return the blocker. Complete proof and independent Review through the packaged global skills before returning completed.`]),
          'Do not commit, push, publish, or print credentials or local auth paths.',
        ].join('\n'),
        timeoutMs: config.codex.timeoutMs,
        idleTimeoutMs: config.codex.idleTimeoutMs,
        operationPolicy: input.reportCorrection ? reportOnlyPolicy(attempt.policy) : attempt.policy,
        executionProfile: attempt.profile,
        onSpawned: async ({ pid, processGroupId }) => input.onLaunched?.({
          attemptId, pid, processGroupId, launchedAt: (this.dependencies.now ?? (() => new Date().toISOString()))(),
        }),
      }, input.signal);
      if (input.reportCorrection && canonicalJson(await this.dependencies.git.snapshot(input.worktreePath)) !== canonicalJson(baseline)) return { kind: 'internal-error' };
      if (result.sessionIdentityFailed) return { kind: 'internal-error' };
      if (result.kind === 'cancelled') return { kind: 'cancelled' };
      if (result.kind === 'transport-failed' && !result.error && result.report.kind === 'missing' && result.exitCode === 0 && result.signal === null) {
        return { kind: 'completed', attemptId, report: '', reportBytes: Buffer.alloc(0) };
      }
      if (['spawn-failed', 'transport-failed', 'timeout', 'idle-timeout', 'launch-gate-failed'].includes(result.kind)) {
        return { kind: 'transport-failed', resumable: true };
      }
      if (result.kind !== 'completed' || result.report.kind !== 'available') return { kind: 'internal-error' };
      return {
        kind: 'completed',
        attemptId,
        report: decodeAgentReportForValidation(result.report.bytes), reportBytes: result.report.bytes,
      };
    } catch (error) {
      if (!(error instanceof ProcessQuiescenceError)) {
        if (isTechnicalRuntimeError(error)) throw error;
        return { kind: 'internal-error' };
      }
      unresolvedProcess = true;
      return { kind: 'safe-halt' };
    } finally {
      if (correctionView && !unresolvedProcess) await rm(correctionView, { recursive: true, force: true });
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

export function configuredCheckPolicySha256(
  passedChecks: Array<{ id: string; command: string }>,
  configuredAuthority: Record<string, string>,
): string {
  const passed = new Set<string>();
  for (const check of passedChecks) {
    if (passed.has(check.id) || !Object.prototype.hasOwnProperty.call(configuredAuthority, check.id)
      || configuredAuthority[check.id] !== check.command) {
      throw new CandidateProofInspectionError('check no longer matches current configured authority');
    }
    passed.add(check.id);
  }
  if (passed.size !== Object.keys(configuredAuthority).length) {
    throw new CandidateProofInspectionError('not every mandatory configured check has a receipt');
  }
  return sha256(canonicalJson(configuredAuthority));
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
  issues?: GitHubIssueAdapter;
  pullRequests?: GitHubPullRequestAdapter;
  createGitHubAdapters?: (signal: AbortSignal, executor: ProcessExecutor) => {
    issues: GitHubIssueAdapter;
    pullRequests: GitHubPullRequestAdapter;
  };
  implementationAgent?: {
    run(input: Parameters<NonNullable<ConstructorParameters<typeof RunIssue>[0]>['implementationAgent']['run']>[0]): Promise<ImplementationAgentResult>;
  };
  parentCodexHome?: string;
  safePath?: string;
  codexProcess?: CodexProcess;
  git?: RunIssueGit;
  processExecutor?: ProcessExecutor;
  expectedConfigBytes?: Buffer;
  abortController?: AbortController;
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
  const controller = input.abortController ?? new AbortController();
  const underlyingExecutor = input.processExecutor ?? defaultProcessExecutor;
  let ownerCommandHandle: OwnerControlLockHandle | undefined;
  const commandExecutor: ProcessExecutor = (file, args, options) => executeOwnedCommand({
    executor: underlyingExecutor, owner: ownerCommandHandle, file, args,
    options: { timeoutMs: 30_000, processGroup: true, ...options, signal: options?.signal ?? controller.signal },
  });
  const githubAdapters = input.createGitHubAdapters?.(controller.signal, commandExecutor);
  const issues = githubAdapters?.issues ?? input.issues;
  const pullRequests = githubAdapters?.pullRequests ?? input.pullRequests;
  if (!issues || !pullRequests) throw new Error('GitHub adapters are required');
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
  let currentConfig: AgentAutoConfig | undefined;
  let runRecords: RunRecordWriter | undefined;
  let repositoryRecords: FileRunRecordWriter | undefined;
  let selectedIssueNumber: number | undefined;
  let ownsRepository = false;
  let selectedStoreKey: string | undefined;
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
    processExecutor: commandExecutor, iosXcrunPath,
  });
  const androidProofController = new RunnerAndroidProofController({
    adbPath: androidAdbPath,
    emulatorPath: androidEmulatorPath,
    execute: commandExecutor,
    now: () => new Date(now()),
  });
  const readConfig = async (requestedRoot: string) => {
    if (resolve(requestedRoot) !== targetRoot) throw new Error('runtime target root mismatch');
    const bytes = await readRegularFile(join(targetRoot, '.codex-orchestrator', 'config.json'));
    if (input.expectedConfigBytes && !bytes.equals(input.expectedConfigBytes)) throw new Error('config-snapshot-changed');
    let parsed: AgentAutoConfig;
    try { parsed = parseAgentAutoConfig(parseJsonWithoutDuplicateKeys(bytes.toString('utf8'))); }
    catch (error) { throw new RunConfigurationError(error instanceof Error ? error.message : 'Malformed config'); }
    const config: AgentAutoConfig = {
      ...parsed,
      codex: { ...parsed.codex, command: await resolveRuntimeCodex(parsed.codex.command) },
    };
    const path = join(targetRoot, config.runner.stateDir, 'v2', 'run-state.json');
    const canonicalRepository = `${config.github.owner.toLowerCase()}/${config.github.repo.toLowerCase()}`;
    const storeKey = `${path}:${canonicalRepository}:${ownsRepository}`;
    if (selectedStoreKey !== storeKey) {
      const processStartIdentity = await readProcessStartIdentity(process.pid);
      if (!processStartIdentity) throw new Error('writer process start identity is unavailable');
      repositoryRecords = FileRunRecordWriter.forRepository(path, canonicalRepository, {
        host: hostname(), bootId: input.bootId, pid: process.pid, processStartIdentity,
        exclusiveRepositoryOwnership: ownsRepository,
        inspectProcessIdentity: async (pid) => {
          const observed = await inspectProcessIdentity(pid);
          return observed.status === 'present' ? { processStartIdentity: observed.processStartIdentity } : observed.status;
        },
      });
      if (ownsRepository) await repositoryRecords.migrateLegacy();
      runRecords = ownsRepository && selectedIssueNumber !== undefined
        ? repositoryRecords.forIssue(selectedIssueNumber) : repositoryRecords;
      selectedStoreKey = storeKey;
    }
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
  const proofMobileLeases = (canonicalRepository: string, worktreePath: string) => {
    const config = requireConfig(currentConfig);
    const leaseRoot = join(orchestratorHome, 'v2', sha256(canonicalRepository), 'leases');
    return {
      androidLease: new FileAndroidLeaseVerifier({
        leaseRoot, worktreeRoot: worktreePath, now: () => new Date(now()),
        artifactRelativePathForProof: (proofId) => `${config.proof.artifactDir}/${proofId}/android-lease.json`,
        targetController: androidProofController,
      }),
      iosLease: new FileIosLeaseVerifier({
        leaseRoot, worktreeRoot: worktreePath, now: () => new Date(now()),
        artifactRelativePathForProof: (proofId) => `${config.proof.artifactDir}/${proofId}/ios-lease.json`,
        targetController: { release: (record) => releaseIosSimulator(commandExecutor, iosXcrunPath, record) },
      }),
    };
  };
  const inspectProofFreshness = async (
    payload: import('./checked-change.js').CheckedChangePayload,
    worktreePath: string,
    config: AgentAutoConfig,
  ): Promise<import('./checked-change.js').CheckedChangeFreshnessAny> => {
    const checkPolicySha256 = configuredCheckPolicySha256(payload.checks, config.checks);
    if (payload.version === 1) return { ...await git.snapshot(worktreePath), checkPolicySha256 };
    if (!git.candidateV2) throw new CandidateProofInspectionError('candidate-git-v2-required');
    const record = (await records.read()).runs.find(run => run.runId === payload.runId);
    if (!record) throw new CandidateProofInspectionError('candidate-run-missing');
    const boundary: CandidateBoundaryV2 = record.reviewFeedback?.activeBatch
      ? { kind: 'review-feedback', batchId: record.reviewFeedback.activeBatch.batchId,
        repairRound: record.reviewFeedback.repairRound, authoritySha256: payload.deliveryAuthoritySha256 }
      : { kind: 'implementation-cycle', cycle: payload.cycle, authoritySha256: payload.deliveryAuthoritySha256 };
    const source = await git.candidateV2.inspectSource({ binding: payload.binding, worktreePath,
      runId: payload.runId, boundary, artifactDir: config.proof.artifactDir });
    const pin = await git.candidateV2.inspectPin(payload.binding);
    if (source.kind !== 'ok' || source.value !== 'matching' || pin.kind !== 'ok' || pin.value !== 'matching')
      throw new CandidateProofInspectionError('candidate-source-or-pin-drift');
    return { bindingId: payload.binding.bindingId, candidateTreeSha: payload.binding.candidateTreeSha, checkPolicySha256 };
  };
  const proof = {
    cleanupMobileLeases: async (input: { canonicalRepository: string; worktreePath: string; proofId: string }) => {
      const leases = proofMobileLeases(input.canonicalRepository, input.worktreePath);
      await leases.androidLease.release(input.proofId);
      await leases.iosLease.release(input.proofId);
    },
    prepareAndroid: async (preparationInput: {
      proofId: string;
      issue: IssueSnapshot;
      observeOnly?: boolean;
      checkedChange: import('./checked-change.js').CheckedChange<import('./checked-change.js').CheckedChangePayloadV2>;
    }) => {
      const config = requireConfig(currentConfig);
      const checked = capabilities.verifyAndRead(preparationInput.checkedChange);
      const payload = checked.payload;
      const worktreePath = resolve(targetRoot, config.runner.workspaceRoot, `issue-${payload.issueNumber}`);
      const record = (await records.read()).runs.find(run => run.runId === payload.runId);
      if (!record || record.proofId !== preparationInput.proofId
        || record.issueNumber !== payload.issueNumber || record.canonicalRepository !== payload.canonicalRepository
        || record.candidateBinding?.bindingId !== payload.binding.bindingId
        || (record.checkedChangeSha256 && record.checkedChangeSha256 !== checked.checkedChangeSha256)
        || preparationInput.issue.number !== payload.issueNumber || preparationInput.issue.body !== record.issueSnapshot.body) {
        throw new CandidateProofInspectionError('android-preparation-run-binding-mismatch');
      }
      const assertFresh = async () => {
        const freshness = await inspectProofFreshness(payload, worktreePath, config);
        if (freshness.checkPolicySha256 !== payload.checkPolicySha256) {
          throw new CandidateProofInspectionError('android-preparation-check-policy-drift');
        }
      };
      await assertFresh();
      if (!config.proof.android) return {
        status: 'blocked' as const, runnerPreparedArtifactPaths: [], runnerPreparedArtifactSha256: {},
        runnerPreparationWarnings: ['Required Runner-owned Android proof is not configured.'],
      };
      const result = await androidProofController.prepare({
        proofId: preparationInput.proofId, worktreePath, artifactDir: config.proof.artifactDir,
        leaseRoot: join(orchestratorHome, 'v2', sha256(payload.canonicalRepository), 'leases'),
        config: config.proof.android, requirements: readIssueProofRequirements(preparationInput.issue.body),
        checks: payload.checks, checkedChangeSha256: checked.checkedChangeSha256,
        proofAgentBudgetMs: config.codex.timeoutMs, observeOnly: preparationInput.observeOnly, signal: controller.signal,
      });
      await assertFresh();
      return {
        status: result.status,
        runnerPreparedArtifactPaths: [...result.runnerPreparedArtifactPaths],
        runnerPreparedArtifactSha256: { ...result.runnerPreparedArtifactSha256 },
        runnerPreparationWarnings: result.status === 'blocked'
          ? [proofFailureSummary('Android proof preparation blocked', new Error(result.summary))] : [],
      };
    },
    admitReport: async (proofInput: Parameters<AcceptanceProof<import('./checked-change.js').CheckedChangePayload>['admitReport']>[0]) => {
      const config = requireConfig(currentConfig);
      const checked = capabilities.verifyAndRead(proofInput.checkedChange);
      const worktreePath = resolve(targetRoot, config.runner.workspaceRoot, `issue-${checked.payload.issueNumber}`);
      const leases = proofMobileLeases(checked.payload.canonicalRepository, worktreePath);
      const acceptanceProof = new AcceptanceProof<import('./checked-change.js').CheckedChangePayload>({
        checkedChangeReader: capabilities,
        inspectFreshness: payload => inspectProofFreshness(payload, worktreePath, config),
        readArtifact: relativePath => readRegularFileWithoutSymlinkAncestors(worktreePath, resolve(worktreePath, relativePath), 5 * 1024 * 1024),
        inspectArtifact: async relativePath => {
          const path = resolve(worktreePath, relativePath);
          await readRegularFileWithoutSymlinkAncestors(worktreePath, path, 5 * 1024 * 1024);
          const metadata = await inspectRegularFile(path);
          await readRegularFileWithoutSymlinkAncestors(worktreePath, path, 5 * 1024 * 1024);
          return metadata;
        },
        ...leases, proofArtifactDir: config.proof.artifactDir, signal: controller.signal,
      });
      const record = (await records.read()).runs.find(run => run.runId === checked.payload.runId);
      const preparation = record?.androidProofPreparation;
      if (preparation?.status === 'pending') throw new CandidateProofInspectionError('android-preparation-is-pending');
      if (preparation && (preparation.status !== 'prepared' || record?.proofId !== proofInput.proofId
        || preparation.checkedChangeSha256 !== checked.checkedChangeSha256)) {
        throw new CandidateProofInspectionError('android-preparation-admission-binding-mismatch');
      }
      return acceptanceProof.admitReport({
        ...proofInput,
        runnerPreparedArtifactPaths: preparation?.runnerPreparedArtifactPaths ?? [],
        runnerPreparedArtifactSha256: preparation?.runnerPreparedArtifactSha256 ?? {},
        runnerPreparationWarnings: preparation?.runnerPreparationWarnings ?? [],
      });
    },
  };

  const runner = new RunIssue({
    readConfig,
    configuredChecks: { run: async checkInput => {
      const config = requireConfig(currentConfig);
      return runConfiguredChecks({ ...checkInput, logRoot: join(orchestratorHome, 'v2', 'runner-checks',
        sha256(canonicalJson({ repository: `${config.github.owner}/${config.github.repo}`,
          proofId: checkInput.proofId, nonce: randomUUID() }))),
        timeoutMs: config.codex.timeoutMs, env: process.env, executor: commandExecutor });
    } },
    ownerLock: {
      acquire: async ({ canonicalRepository }) => {
        const lock = await acquireOwnerLock({
          orchestratorHome, canonicalRepository, bootId: input.bootId, now,
          processAlive: input.processAlive ?? processIsAlive,
        });
        ownsRepository = true;
        ownerCommandHandle = lock;
        return { release: async () => {
          try { await lock.release(); } finally { ownsRepository = false; ownerCommandHandle = undefined; selectedStoreKey = undefined; }
        } };
      },
    },
    issues: {
      read: (issueNumber) => readRuntimeIssue(issues, issueNumber),
      isReauthorized: (record, issue) => hasGitHubReauthorization({ targetRoot, config: requireConfig(currentConfig), record, issue, issues }),
      getAuthorizationGrantId: async (number, label) => (await issues.getLatestAuthorizationGrant?.(number, label))?.id,
      setLabels: async (issueNumber, labels) => {
        const current = await issues.getLabels(issueNumber);
        const policy = requireConfig(currentConfig).github.labels;
        await issues.updateIssue(issueNumber, managedLabelUpdate(current, labels, policy));
      },
      getRepositoryPermission: (login, expectedUserId) => issues.getRepositoryPermission(login, expectedUserId),
      reconcileTerminalLabels: async (issueNumber, labels) => {
        const current = await issues.getLabels(issueNumber);
        const policy = requireConfig(currentConfig).github.labels;
        await issues.updateIssue(issueNumber, managedLabelUpdate(
          current,
          current.filter((label) => !labels.remove.includes(label)).concat(labels.add),
          policy,
          true,
        ));
      },
      postComment: async (issueNumber, body) => { await issues.postComment(issueNumber, body); },
    },
    pullRequests: {
      findOpen: async ({ headBranch, baseBranch }) => {
        const matches = (await pullRequests.listAllByHeadBranch(headBranch))
          .filter((pullRequest) => pullRequest.state === 'OPEN' && pullRequest.baseRefName === baseBranch);
        if (matches.length > 1) throw new Error('multiple open pull requests match publication pendingEffect');
        const match = matches[0];
        if (!match) return undefined;
        const reviewTarget = await pullRequests.getReviewTarget(match.number);
        return {
          url: match.url,
          body: match.body,
          number: match.number,
          nodeId: match.nodeId,
          headRefName: match.headRefName,
          baseRefName: match.baseRefName,
          ...(reviewTarget ? { headSha: reviewTarget.headRefOid } : {}),
        };
      },
      createDraft: async ({ title, body, headBranch, baseBranch }) => pullRequests.createDraftPullRequest({ title, body, headBranch, baseBranch }),
      listConversationComments: async (number) => (await pullRequests.listConversationComments(number))
        .map((comment) => ({ id: comment.id, body: comment.body })),
      postConversationComment: async (number, body) => {
        const comment = await pullRequests.postConversationComment(number, body);
        return { id: comment.id, body: comment.body };
      },
    },
    reviewFeedback: new ReviewFeedbackObserver({ pullRequests: pullRequests, issues: issues, now }),
    git,
    implementationAgent,
    proof,
    checkedChangeMint: capabilities,
    runRecords: records,
    inventoryRuns: async () => {
      if (!repositoryRecords) throw new Error('inventory used before config');
      return (await repositoryRecords.inventory()).runs;
    },
    writeEvidence: async ({ runId, code, summary, failure }) => {
      const config = requireConfig(currentConfig);
      const relativePath = `${config.runner.stateDir}/v2/evidence/${runId}.json`;
      await writeDurableAtomicFile(resolve(targetRoot, relativePath), `${canonicalJson({ version: 1, runId, code, summary, ...(failure ? { failure } : {}), recordedAt: now() })}\n`);
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
    runIssue: (runInput) => {
      selectedIssueNumber = runInput.issueNumber;
      selectedStoreKey = undefined;
      return runner.runIssue(runInput);
    },
    abort: () => controller.abort(),
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

export async function executeOwnedCommand(input: {
  executor: ProcessExecutor;
  owner?: OwnerControlLockHandle;
  file: string;
  args: string[];
  options?: Parameters<ProcessExecutor>[2];
}): ReturnType<ProcessExecutor> {
  await input.owner?.beginCommand();
  let unresolved = false;
  try {
    return await input.executor(input.file, input.args, input.options);
  } catch (error) {
    if (error instanceof CommandProcessQuiescenceError) {
      unresolved = true;
      await input.owner?.fenceCommand({ pid: error.pid, processGroupId: error.processGroupId,
        streamsUnconfirmed: error.streamsUnconfirmed });
    }
    throw error;
  } finally {
    if (!unresolved) await input.owner?.completeCommand();
  }
}

export async function readRuntimeIssue(
  issues: Pick<GitHubIssueAdapter, 'getIssue' | 'listAllComments'>,
  issueNumber: number,
): Promise<RunIssueSnapshot | undefined> {
  const issue = await issues.getIssue(issueNumber);
  if (!issue) return undefined;
  const comments = await issues.listAllComments(issueNumber);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state,
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
}

export function managedLabelUpdate(
  current: string[],
  expected: string[],
  policy: AgentAutoConfig['github']['labels'],
  requireManagedStatus = false,
): { addLabels: string[]; removeLabels: string[] } {
  const managed = new Set([policy.auto.name, policy.running.name, policy.blocked.name, policy.review.name]);
  const hasManagedStatus = current.some((label) => managed.has(label));
  return {
    addLabels: requireManagedStatus && !hasManagedStatus
      ? []
      : expected.filter((label) => managed.has(label) && !current.includes(label)),
    removeLabels: current.filter((label) => managed.has(label) && !expected.includes(label)),
  };
}

async function acquireOwnerLock(input: {
  orchestratorHome: string;
  canonicalRepository: string;
  bootId: string;
  now: () => string;
  processAlive: (pid: number) => boolean;
}): Promise<OwnerControlLockHandle> {
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
  operationId: 'implementation' | 'acceptance-proof' | 'code-review';
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
  reviewers: string[];
  reviewerProfiles: Record<string, string>;
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
  const reportOnly = input.operationId === 'code-review';
  validateContainmentOperationPolicy(snapshot.policy);
  if ((reportOnly
    ? snapshot.policy.sandboxMode !== 'read-only'
      || snapshot.policy.worktreeAccess !== 'read-only'
      || snapshot.policy.runnerPostcondition !== 'report-only'
      || snapshot.policy.writableRootClasses.length !== 0
    : snapshot.policy.sandboxMode !== 'workspace-write')
    || snapshot.policy.approvalCeiling !== 'never'
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
    reviewers: Object.keys(snapshot.reviewerProfiles).sort(),
    reviewerProfiles: structuredClone(snapshot.reviewerProfiles),
  };
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
  signal?: AbortSignal;
}): Promise<string> {
  await assertDisjointReadViewPaths(input.worktreePath, input.destination);
  const deniedPaths = normalizeReadViewDeniedPaths(input.deniedPaths);
  await rm(input.destination, { recursive: true, force: true });
  await mkdir(input.destination, { recursive: true, mode: 0o700 });
  await materializeCurrentReadView(input.worktreePath, input.destination, deniedPaths, input.signal);
  await scrubReportReadView(input.destination);
  return input.destination;
}


function isTechnicalRuntimeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && ['EIO', 'ENOENT', 'EAGAIN', 'EINTR', 'ENOSPC', 'EMFILE', 'ENFILE', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  return error instanceof Error && /^(?:git failed:|report read-view inventory failed:)/u.test(error.message);
}

function reportOnlyPolicy(policy: WorkflowOperationPolicy): WorkflowOperationPolicy {
  return { ...policy, sandboxMode: 'read-only', worktreeAccess: 'read-only', writableRootClasses: [], runnerPostcondition: 'report-only', network: 'deny', networkHosts: [] };
}

function reportCorrectionPrompt(correction: { sha256: string; diagnostic: string }): string {
  return `Correct only the structured report using review-facts/correction-${correction.sha256}.json and the exact output schema. Do not implement, rerun checks, launch an app scenario, modify product/evidence files, or make semantic repairs. Preserve all existing facts; if evidence cannot establish a result, report that accurately. Diagnostic: ${correction.diagnostic}`;
}

async function prepareReportCorrectionView(input: {
  worktreePath: string; destination: string; deniedPaths: string[]; schemaPath: string; signal: AbortSignal;
  correction: { bytes: Buffer; sha256: string; diagnostic: string };
}): Promise<string> {
  if (sha256(input.correction.bytes) !== input.correction.sha256
    || !Buffer.from(input.correction.bytes.toString('utf8')).equals(input.correction.bytes)) throw new Error('report correction binding is invalid');
  const view = await materializeReportReadView(input);
  const bytes = Buffer.from(canonicalJson({
    originalReport: input.correction.bytes.toString('utf8'), originalReportSha256: input.correction.sha256,
    diagnostic: input.correction.diagnostic, schema: JSON.parse((await readRegularFile(input.schemaPath)).toString('utf8')),
  }));
  await materializeRunnerFacts(view, [{ path: `review-facts/correction-${input.correction.sha256}.json`, bytes, sha256: sha256(bytes) }]);
  return view;
}

/** Create-only facts live beside the scrubbed view, never in the product tree. */
export async function materializeRunnerFacts(readView: string, facts: Array<{ path: string; bytes: Buffer; sha256: string }>): Promise<void> {
  const canonicalView = await realpath(readView);
  const seen = new Set<string>();
  for (const fact of facts) {
    if (!/^review-facts\/[a-zA-Z0-9._-]+\.json$/u.test(fact.path) || seen.has(fact.path)
      || sha256(fact.bytes) !== fact.sha256) throw new Error('review facts binding is invalid');
    seen.add(fact.path);
    const destination = resolve(canonicalView, fact.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const directory = await realpath(dirname(destination));
    if (directory !== resolve(canonicalView, 'review-facts')) throw new Error('review facts directory is unsafe');
    const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    try { await handle.writeFile(fact.bytes); await handle.sync(); } finally { await handle.close(); }
    if (sha256(await readFile(destination)) !== fact.sha256) throw new Error('review facts materialization diverged');
  }
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

async function materializeCurrentReadView(worktreePath: string, destination: string, deniedPaths: string[], signal?: AbortSignal): Promise<void> {
  const paths = new Set(await readGitPathList(worktreePath, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal));
  for (const path of [...paths].sort()) {
    signal?.throwIfAborted();
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

async function readGitPathList(worktreePath: string, args: string[], signal?: AbortSignal): Promise<string[]> {
  const result = await defaultProcessExecutor('git', ['-C', worktreePath, ...args], {
    timeoutMs: 30_000, signal, processGroup: true,
  });
  if (result.exitCode !== 0) throw new Error(`report read-view inventory failed: ${result.stderr.slice(0, 8 * 1024)}`);
  return result.stdout.split('\0').filter(Boolean);
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
  const requirements = readIssueProofRequirements(issue.body);
  if (requirements) return requirements.level === 'android-live';
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

/** GitHub grants execution; the journal supplies only the stopped operation's boundary. */
export async function hasGitHubReauthorization(input: {
  targetRoot: string; config: AgentAutoConfig; record: RunRecord;
  issue: { state: string; labels: string[] }; issues: Pick<GitHubIssueAdapter, 'getLatestAuthorizationGrant'>;
}): Promise<boolean> {
  const { record, issue, config } = input;
  const outcome = record.terminalOutcome;
  if (!outcome || outcome.status === 'review-ready' || issue.state !== 'OPEN'
    || !issue.labels.includes(config.github.labels.auto.name)
    || [config.github.labels.running.name, config.github.labels.blocked.name, config.github.labels.review.name]
      .some(label => issue.labels.includes(label))) return false;
  const evidenceRoot = resolve(input.targetRoot, config.runner.stateDir, 'v2/evidence');
  const path = resolve(input.targetRoot, outcome.evidencePath);
  if (!isPathWithin(evidenceRoot, path)) return false;
  let evidence;
  try { evidence = JSON.parse((await readRegularFile(path)).toString('utf8')); }
  catch (error) { if (isErrorCode(error, 'ENOENT')) return false; throw error; }
  const { evidencePath: _path, ...seed } = outcome;
  if (evidence.runId !== record.runId || evidence.summary !== canonicalJson(seed)
    || typeof evidence.recordedAt !== 'string' || !Number.isFinite(Date.parse(evidence.recordedAt))) return false;
  const grant = await input.issues.getLatestAuthorizationGrant?.(record.issueNumber, config.github.labels.auto.name);
  return !!grant && (record.terminalAuthorizationGrantId
    ? BigInt(grant.id) > BigInt(record.terminalAuthorizationGrantId)
    : Date.parse(grant.createdAt) > Date.parse(evidence.recordedAt));
}
