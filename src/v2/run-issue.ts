import { dirname, resolve } from 'node:path';

import {
  checkedChangePayloadSha256,
  type CheckedChange,
  type CheckedChangeFreshness,
  type CheckedChangeMintCapability,
  type CheckedChangePayloadV1,
  type CheckedChangePayloadV2,
} from './checked-change.js';
import { parseAgentAutoConfig, type AgentAutoConfig } from './config.js';
import { canonicalJson, parseJsonWithoutDuplicateKeys, sha256 } from './containment.js';
import {
  adoptActiveAttempt,
  confirmActiveAttemptCleanup,
  createActiveAttempt,
  launchActiveAttempt,
  observeActiveAttempt,
  type AttemptProcessIdentity,
  type ProcessStartIdentity,
} from './active-attempt.js';
import { validateImplementationReport } from './implementation-report.js';
import {
  acceptApprovedDirectReview,
  acceptNeedsWorkDirectReview,
  beginDirectReviewRepair,
  canRecoverTerminalDirectReviewReport,
  createInitialDirectReview,
  directReviewCandidateTargetFingerprint,
  directReviewTargetFingerprint,
  MAX_DIRECT_REVIEW_REPORT_REPAIRS,
  prepareDirectReview,
  projectTerminalDirectReview,
  recoverTerminalDirectReviewReport,
} from './direct-delivery.js';
import type { ImplementationReviewerInput, ImplementationReviewerResult } from './implementation-reviewer.js';
import { CandidateProofInspectionError, ProofLaunchAuthorizationError, type FrozenCriterion, type IssueSnapshot, type ProveChangeResult } from './acceptance-proof.js';
import { CheckProcessQuiescenceError, resolveIssueCheckPolicy } from './issue-check-policy.js';
import type { ProofReceipt } from './proof-report.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import {
  RouteInitializationUnrecoverableError,
  WorkflowGenerationUnrecoverableError,
} from './run-store.js';
import {
  initialRouteExecution,
  type RouteCoordinatorInput,
  type RouteCoordinatorResult,
  type RouteCoordinatorState,
} from './route-coordinator.js';
import type { RoutedContinuationRegistry } from './route-continuations.js';
import type { SpecCoordinatorResult, SpecDeliveryState } from './spec-coordinator.js';
import { acceptTrustedSpecAnswer, type FrozenSpecQuestionReceiptV1, type FrozenSpecReceiptV1, type TrustedSpecAnswerV1 } from './spec-delivery.js';
import {
  downstreamLifecycleForRoute,
  validateRouteTransition,
  type RouteExecutionV1,
} from './route-decision.js';
import type {
  PendingEffect,
  PendingEffectInput,
  RunRecord,
  RunRecordWriter,
  RunStateInspection,
  RunStateFile,
  RunTerminalOutcome,
} from './run-store.js';
import { createPendingEffect } from './run-store.js';
import type { ReviewFeedbackObserver } from './review-feedback-coordinator.js';
import {
  activateReviewFeedback,
  blockReviewFeedback,
  initializeReviewFeedback,
  markReviewFeedbackVerified,
  projectReviewFeedbackBatch,
  publishReviewFeedback,
  reserveNextReviewFeedbackRound,
} from './review-feedback.js';
import type { CandidateGitV2 } from './candidate.js';
import type { CandidateBindingV2, CandidateBoundaryV2, CandidateMaterializationV2 } from './candidate.js';
import { createDirectDeliveryAuthority, createSpecDeliveryAuthority, type DeliveryAuthorityV1 } from './delivery-authority.js';
import {
  blockedLabelPolicy,
  blockedLabelProjection,
  claimComment,
  claimRunId,
  freezeCriteria,
  historicalClaimCounts,
  isClaimMarkerComment,
  isExactClaimMarkerLine,
  isAdoptableAttempt,
  observedHistoricalClaimKeys,
  outcomeEvidenceBytes,
  publicOutcome,
  publicIssueSnapshot,
  requireRouteExecution,
  refreshClaimedIssueSnapshot,
  snapshotIssue,
  sameInspectionIdentity,
  sameRouteExecution,
  sameStrings,
  semanticChangesMatch,
} from './run-state-projections.js';

export type RunIssueResult =
  | { status: 'state-schema-unsupported' }
  | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string; continuationEpoch?: string }
  | { status: 'route-ready'; route: 'spec-required'; evidencePath: string }
  | { status: 'spec-frozen'; receipt: FrozenSpecReceiptV1 | FrozenSpecQuestionReceiptV1; evidencePath: string }
  | { status: 'not-eligible'; reason: string; evidencePath: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; resumable: boolean; evidencePath: string }
  | { status: 'transport-failed'; resumable: boolean; evidencePath: string }
  | { status: 'cancelled'; evidencePath: string }
  | { status: 'internal-error'; evidencePath: string }
  | { status: 'requeued'; reason: 'owner-contention'; evidencePath: string }
  | { status: 'requeued'; reason: 'state-changed' };

export interface RunIssueSnapshot {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  comments: Array<{
    id?: string;
    body: string;
    authorAssociation: string;
    author?: string;
    authorId?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
}

export interface RunIssueGit {
  candidateV2?: CandidateGitV2;
  getBaseSha(input: { targetRoot: string; baseBranch: string }): Promise<string>;
  createWorktree(input: { targetRoot: string; worktreePath: string; branchName: string; baseBranch: string; baseSha: string }): Promise<void>;
  ensureContinuationWorktree?(input: { targetRoot: string; worktreePath: string; branchName: string; baseBranch: string; publishedHeadSha: string }): Promise<void>;
  inspectWorktree(input: { worktreePath: string; branchName: string; baseSha: string }): Promise<'absent' | 'matching' | 'diverged'>;
  snapshot(worktreePath: string): Promise<Omit<CheckedChangeFreshness, 'checkPolicySha256'>>;
  fingerprintDeniedPaths(worktreePath: string, deniedPaths: string[]): Promise<string>;
  listChangedFiles(worktreePath: string): Promise<string[]>;
  listChangedFilesIgnoringUntrackedRoot(worktreePath: string, ignoredRoot: string): Promise<string[]>;
  fingerprintChangedFiles(worktreePath: string, changedFiles: string[]): Promise<string>;
  stageAll(worktreePath: string): Promise<void>;
  getTreeSha(worktreePath: string): Promise<string>;
  getHead(worktreePath: string): Promise<string>;
  inspectHead(worktreePath: string): Promise<{ sha: string; parentSha: string; treeSha: string; message: string }>;
  getRemoteBranchSha(worktreePath: string, branchName: string): Promise<string | undefined>;
  commit(input: { worktreePath: string; message: string }): Promise<string>;
  push(input: { worktreePath: string; branchName: string }): Promise<void>;
}

export type ImplementationAgentResult =
  | { kind: 'completed'; report: unknown; attemptId?: string }
  | { kind: 'transport-failed'; resumable: boolean }
  | { kind: 'cancelled' }
  | { kind: 'internal-error' }
  | { kind: 'safe-halt'; waitForAbsence(): Promise<void> };

export interface RunIssueDependencies {
  readConfig(targetRoot: string): Promise<{ bytes: Buffer; config: AgentAutoConfig }>;
  ownerLock: {
    acquire(input: { canonicalRepository: string; targetRoot: string }): Promise<{ release(): Promise<void> }>;
  };
  issues: {
    read(issueNumber: number): Promise<RunIssueSnapshot | undefined>;
    setLabels(issueNumber: number, labels: string[]): Promise<void>;
    transitionToBlocked?(issueNumber: number, labels: {
      auto: string;
      running: string;
      blocked: string;
      review: string;
    }): Promise<void>;
    postComment(issueNumber: number, body: string): Promise<void>;
    getRepositoryPermission?(login: string, expectedUserId: string): Promise<{ permission: 'none' | 'read' | 'write' | 'admin'; checkedAt: string; userId: string }>;
  };
  pullRequests: {
    findOpen(input: { headBranch: string; baseBranch: string }): Promise<{ url: string; body: string; number?: number; nodeId?: string; headSha?: string } | undefined>;
    createDraft(input: { title: string; body: string; headBranch: string; baseBranch: string }): Promise<{ url: string }>;
    listConversationComments?(number: number): Promise<Array<{ id: string; body: string }>>;
    postConversationComment?(number: number, body: string): Promise<{ id: string; body: string }>;
  };
  reviewFeedback?: ReviewFeedbackObserver;
  git: RunIssueGit;
  implementationAgent: {
    run(input: {
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
      onPrepared?: (input: { attemptId: string; reportPath: string; preparedAt: string; baseline: Omit<CheckedChangeFreshness, 'checkPolicySha256'> }) => Promise<void>;
      onLaunched?: (input: { attemptId: string; pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
      signal: AbortSignal;
    }): Promise<ImplementationAgentResult>;
  };
  implementationReviewer: {
    run(input: ImplementationReviewerInput): Promise<ImplementationReviewerResult>;
  };
  waitForReviewProcessAbsence(processGroupId: number): Promise<void>;
  processIdentity: {
    host: string;
    bootId: string;
    capture(pid: number, processGroupId: number): Promise<ProcessStartIdentity | undefined>;
    observe(process: AttemptProcessIdentity): Promise<{
      leader: 'same' | 'reused' | 'absent' | 'unknown';
      group: 'live' | 'absent' | 'unknown';
    }>;
  };
  inspectAttemptResult(path: string): Promise<{ bytes: Buffer; sha256: string } | undefined>;
  writeAttemptResult(input: { path: string; bytes: Buffer; sha256: string }): Promise<void>;
  routeCoordinator: {
    run(input: RouteCoordinatorInput & { state: RouteCoordinatorState }): Promise<RouteCoordinatorResult>;
  };
  routeContinuations: RoutedContinuationRegistry;
  checks: {
    supportsLaunchOwnership?: true;
    run(input: {
      id: string; command: string; source: 'issue' | 'configured'; cwd: string; phase: 'changed'; signal: AbortSignal;
      onLaunched?: (input: { pid: number; processGroupId: number }) => Promise<void>;
    }): Promise<{
      status: 'passed' | 'failed'; output: Buffer; outputSha256: string;
      observation: { leader: 'absent'; group: 'live' | 'absent' | 'unknown' };
    }>;
  };
  proof: {
    proveChange(input: {
      proofId: string;
      attemptId: string;
      recoverOnly: boolean;
      proofStartedAt: string;
      transportRetryCount: number;
      reportRepairCount: number;
      reportRepairFindings: string[];
      passedReceipt?: ProofReceipt;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      checkedChange: CheckedChange<CheckedChangePayloadV1 | CheckedChangePayloadV2>;
      materialization?: CandidateMaterializationV2;
      workflowGeneration: WorkflowGenerationReceipt;
      beforeAgentLaunch?: () => Promise<void>;
      onLaunched?: (input: { pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
    }): Promise<ProveChangeResult>;
  };
  checkedChangeMint: CheckedChangeMintCapability;
  runRecords: RunRecordWriter;
  writeEvidence(input: { runId: string; code: string; summary: string }): Promise<{ id: string; path: string }>;
  outcomeEvidencePath(runId: string, code: string, summarySha256: string): string;
  inspectOutcomeEvidence(path: string): Promise<{ sha256: string } | undefined>;
  writeOutcomeEvidence(input: { path: string; bytes: Buffer; sha256: string }): Promise<void>;
  packageVersion: string;
  createWorkflowGeneration(): Promise<{ receipt: WorkflowGenerationReceipt; skillHashes: Record<string, string> }>;
  verifyWorkflowGeneration(receipt: WorkflowGenerationReceipt): Promise<void>;
  createRunId(): string;
  attemptResultPath(input: { canonicalRepository: string; runId: string; attemptId: string }): string;
  createProofId(): string;
  createReviewSessionId(): string;
  now(): string;
  signal?: AbortSignal;
}

type FeedbackWorkerObservation =
  | { status: 'valid' }
  | { status: 'retryable' | 'blocked'; code: string };

export class OwnerLockSafetyError extends Error {}
export class OwnerLockContentionError extends Error {}

interface ActiveRun {
  state: RunStateFile;
  record: RunRecord;
  config: AgentAutoConfig;
}

interface DurableConfiguredCheckResult {
  status: 'passed' | 'failed';
  output: Buffer;
  outputSha256: string;
  observation: { leader: 'absent'; group: 'live' | 'absent' | 'unknown' };
  attemptResultSha256: string;
}

type TerminalSeed =
  | { status: 'review-ready'; pullRequestUrl: string; continuationEpoch?: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; resumable: boolean }
  | { status: 'transport-failed'; resumable: boolean }
  | { status: 'cancelled' }
  | { status: 'internal-error'; code: string };

export class RunIssue {
  private readonly signal: AbortSignal;

  constructor(private readonly dependencies: RunIssueDependencies) {
    this.signal = dependencies.signal ?? new AbortController().signal;
  }

  private async reconcileClaim(
    starting: ActiveRun,
    config: AgentAutoConfig,
  ): Promise<{ active: ActiveRun } | { result: RunIssueResult }> {
    let active = starting;
    const { issueNumber, runId, branchName } = active.record;
    const expectedLabels = sortedUnique([config.github.labels.auto.name, config.github.labels.running.name]);
    if (active.record.pendingEffect && !['claim-labels', 'claim-comment'].includes(active.record.pendingEffect.kind)) {
      return { result: await this.publicationDiverged(active, 'claim-pendingEffect-diverged') };
    }
    let observation = await this.readIssue(issueNumber);
    if (!observation || observation.state !== 'OPEN') return { result: await this.publicationDiverged(active, 'claim-issue-missing') };
    const body = claimComment(runId, issueNumber, branchName);
    const marker = body.split('\n')[0]!;
    const commentEffect = { kind: 'claim-comment' as const, issueNumber, marker, bodySha256: sha256(body) };

    if (!active.record.pendingEffect) {
      observation = await this.readIssue(issueNumber);
      if (!observation || observation.state !== 'OPEN') return { result: await this.publicationDiverged(active, 'claim-issue-missing') };
      if (!this.hasTrustedClaim(observation, active.record)) {
        active = await this.persist(active, { pendingEffect: commentEffect });
      }
    }
    if (active.record.pendingEffect?.kind === 'claim-comment') {
      if (active.record.pendingEffect.marker !== marker || active.record.pendingEffect.bodySha256 !== sha256(body)) {
        return { result: await this.publicationDiverged(active, 'claim-comment-pendingEffect-diverged') };
      }
      observation = await this.readIssue(issueNumber);
      let comments = observation ? commentsWithMarker(observation, marker) : [];
      if (comments.some((comment) => comment.body !== body) || comments.length > 1) {
        return { result: await this.publicationDiverged(active, 'claim-comment-diverged') };
      }
      if (comments.length === 0) {
        try { await this.dependencies.issues.postComment(issueNumber, body); }
        catch { return { result: await this.invokedFailure(active, 'claim-comment-delivery-unknown') }; }
        observation = await this.readIssue(issueNumber);
        comments = observation ? commentsWithMarker(observation, marker) : [];
      }
      if (comments.length !== 1 || comments[0]!.body !== body
        || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comments[0]!.authorAssociation)) {
        return { result: await this.publicationDiverged(active, 'claim-comment-observation-diverged') };
      }
      active = await this.confirmEffect(active);
    }

    observation = await this.readIssue(issueNumber);
    if (!observation || observation.state !== 'OPEN' || !this.hasTrustedClaim(observation, active.record)) {
      return { result: await this.publicationDiverged(active, 'claim-comment-observation-diverged') };
    }
    if (sameStrings(observation.labels, expectedLabels)) return { active };
    const labels = new Set(observation.labels);
    if (!labels.has(config.github.labels.auto.name)
      || labels.has(config.github.labels.blocked.name)
      || labels.has(config.github.labels.review.name)) {
      return { result: await this.publicationDiverged(active, 'claim-labels-diverged') };
    }
    if (!active.record.pendingEffect) {
      active = await this.persist(active, { pendingEffect: { kind: 'claim-labels', issueNumber, expected: expectedLabels } });
    }
    if (active.record.pendingEffect?.kind !== 'claim-labels' || !sameStrings(active.record.pendingEffect.expected, expectedLabels)) {
      return { result: await this.publicationDiverged(active, 'claim-labels-pendingEffect-diverged') };
    }
    try { await this.dependencies.issues.setLabels(issueNumber, expectedLabels); }
    catch { return { result: await this.invokedFailure(active, 'claim-labels-delivery-unknown') }; }
    observation = await this.readIssue(issueNumber);
    if (!observation || !sameStrings(observation.labels, expectedLabels) || !this.hasTrustedClaim(observation, active.record)) {
      return { result: await this.publicationDiverged(active, 'claim-labels-observation-diverged') };
    }
    active = await this.confirmEffect(active);
    return { active };
  }

  private async publish(
    starting: ActiveRun,
    config: AgentAutoConfig,
    issue: IssueSnapshot,
    issueNumber: number,
  ): Promise<RunIssueResult> {
    let active = starting;
    const { runId, branchName, worktreePath, baseSha } = active.record;
    const message = `feat: implement #${issueNumber}`;

    let commitSha = await this.dependencies.git.getHead(worktreePath);
    const candidateBinding = active.record.candidateBinding;
    if (candidateBinding) {
      const candidate = this.dependencies.git.candidateV2;
      if (!candidate) return this.persistRetainedCommitIntentTerminal(active, 'candidate-git-v2-required');
      if (!active.record.pendingEffect) {
        if (commitSha !== candidateBinding.expectedHeadSha) return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-branch-diverged-without-pendingEffect');
        const recaptured = await candidate.captureAndPin({
          worktreePath,
          expectedHeadSha: candidateBinding.expectedHeadSha,
          runId,
          boundary: {
            kind: 'implementation-cycle', cycle: active.record.cycle,
            authoritySha256: active.record.deliveryAuthority!.authoritySha256,
          },
          artifactDir: config.proof.artifactDir,
        });
        if (recaptured.kind === 'failed') return this.mapCandidateFailure(active, recaptured.code);
        if (recaptured.value.bindingId !== candidateBinding.bindingId
          || recaptured.value.candidateTreeSha !== candidateBinding.candidateTreeSha
          || !sameStrings(recaptured.value.canonicalChangedFiles, candidateBinding.canonicalChangedFiles)) {
          if (recaptured.value.bindingId !== candidateBinding.bindingId) {
            await candidate.releasePin({ binding: recaptured.value, expectedPinnedCommitSha: recaptured.value.candidateCommitSha });
          }
          if (this.repairBudgetExhausted(active, config.runner.maxCycles)) {
            const released = await this.clearAndReleaseCandidate(active);
            return 'status' in released
              ? released
              : this.terminal(released.active, { status: 'blocked', kind: 'exhausted', resumable: true }, 'candidate-worktree-drift');
          }
          const reopened = await this.startNextCycleFromCandidate(active, ['The issue worktree changed after proof; review the new candidate.']);
          if ('status' in reopened) return reopened;
          return this.invokedFailure(reopened, 'candidate-worktree-drift', 'The mutable issue worktree changed after proof; the next bounded repair cycle is ready.');
        }
        active = await this.persist(active, { pendingEffect: {
          kind: 'initial-commit',
          parentSha: candidateBinding.expectedHeadSha,
          treeSha: candidateBinding.candidateTreeSha,
          message,
          candidateRef: candidateBinding.candidateRef,
        } });
      }
      const pendingEffect = active.record.pendingEffect;
      if (pendingEffect?.kind !== 'initial-commit' || pendingEffect.parentSha !== candidateBinding.expectedHeadSha
        || pendingEffect.treeSha !== candidateBinding.candidateTreeSha || pendingEffect.message !== message
        || pendingEffect.candidateRef !== candidateBinding.candidateRef) {
        return this.persistRetainedCommitIntentTerminal(active, 'candidate-commit-pendingEffect-diverged');
      }
      if (this.signal.aborted) return await this.persistRetainedCommitIntentTerminal(active, 'candidate-publication-cancelled');
      if (!await this.authorized(active, config)) return await this.persistRetainedCommitIntentTerminal(active, 'candidate-publication-authority-revoked');
      const publication = await candidate.createOrObserveCommit({
        worktreePath,
        branchName,
        parentSha: pendingEffect.parentSha,
        treeSha: pendingEffect.treeSha,
        message: pendingEffect.message,
        candidateRef: pendingEffect.candidateRef,
      });
      if (publication.kind === 'failed') {
        return publication.code === 'candidate-ref-update-unknown'
          ? this.invokedFailure(active, publication.code, 'Candidate commit outcome is unknown; retain and observe the exact commit effect.')
          : this.mapCandidateFailure(active, publication.code);
      }
      if (publication.value.kind === 'parent-unchanged') return this.invokedFailure(active, 'candidate-branch-update-not-observed');
      if (publication.value.kind === 'branch-diverged') return this.persistRetainedCommitIntentTerminal(active, 'candidate-branch-diverged');
      commitSha = publication.value.sha;
      const normalized = await candidate.normalizeSharedIndex({ worktreePath, expectedHeadSha: commitSha });
      if (normalized.kind === 'failed') return this.mapCandidateFailure(active, normalized.code);
      const residual = await this.dependencies.git.listChangedFilesIgnoringUntrackedRoot(worktreePath, config.proof.artifactDir);
      if (residual.length > 0) return this.persistRetainedCommitIntentTerminal(active, 'candidate-residual-worktree-drift');
      try {
        active = await this.persist(active, {
          pendingEffect: { kind: 'initial-push', branch: branchName, sha: commitSha },
          changeBindingVersion: undefined,
          candidateBinding: undefined,
        });
      } catch {
        throw new PostEffectStateError(active);
      }
      const released = await candidate.releasePin({ binding: candidateBinding, expectedPinnedCommitSha: candidateBinding.candidateCommitSha });
      if (released.kind === 'failed') {
        return this.invokedFailure(active, 'candidate-pin-release-unknown', 'The publication commit is confirmed; orphan reconciliation will retry exact pin cleanup.');
      }
    } else if (active.record.pendingEffect?.kind === 'initial-commit' || !active.record.pendingEffect) {
      if (!active.record.pendingEffect) {
        if (commitSha === baseSha) {
          active = await this.persist(active, {
            pendingEffect: { kind: 'initial-commit', parentSha: baseSha, treeSha: await this.dependencies.git.getTreeSha(worktreePath), message },
          });
        }
      }
      const pendingEffect = active.record.pendingEffect;
      if (pendingEffect?.kind === 'initial-commit') {
        if (commitSha === pendingEffect.parentSha) {
          if (await this.dependencies.git.getTreeSha(worktreePath) !== pendingEffect.treeSha) return await this.publicationDiverged(active, 'commit-tree-diverged');
          if (this.signal.aborted) return await this.terminal(await this.clearEffect(active), { status: 'cancelled' });
          if (!await this.authorized(active, config)) return await this.revoked(active);
          try { commitSha = await this.dependencies.git.commit({ worktreePath, message: pendingEffect.message }); }
          catch { return await this.invokedFailure(active, 'commit-delivery-unknown'); }
        }
        const observed = await this.dependencies.git.inspectHead(worktreePath);
        if (observed.sha !== commitSha || observed.parentSha !== pendingEffect.parentSha || observed.treeSha !== pendingEffect.treeSha || observed.message !== pendingEffect.message) {
          return await this.publicationDiverged(active, 'commit-observation-diverged');
        }
        active = await this.confirmEffect(active);
      }
    }
    const commit = await this.dependencies.git.inspectHead(worktreePath);
    if (commit.sha !== commitSha || commit.parentSha !== baseSha || commit.message !== message || commit.treeSha !== await this.dependencies.git.getTreeSha(worktreePath)) {
      return await this.publicationDiverged(active, 'commit-identity-diverged');
    }

    if (active.record.pendingEffect?.kind === 'initial-push' || !active.record.pendingEffect) {
      if (!active.record.pendingEffect) active = await this.persist(active, { pendingEffect: { kind: 'initial-push', branch: branchName, sha: commitSha } });
      const pendingEffect = active.record.pendingEffect;
      if (pendingEffect?.kind !== 'initial-push' || pendingEffect.branch !== branchName || pendingEffect.sha !== commitSha) return await this.publicationDiverged(active, 'push-pendingEffect-diverged');
      let remoteSha = await this.dependencies.git.getRemoteBranchSha(worktreePath, branchName);
      if (remoteSha && remoteSha !== commitSha) return await this.publicationDiverged(active, 'remote-branch-diverged');
      if (!remoteSha) {
        if (this.signal.aborted) return await this.terminal(await this.clearEffect(active), { status: 'cancelled' });
        if (!await this.authorized(active, config)) return await this.revoked(active);
        try { await this.dependencies.git.push({ worktreePath, branchName }); }
        catch { return await this.invokedFailure(active, 'push-delivery-unknown'); }
        remoteSha = await this.dependencies.git.getRemoteBranchSha(worktreePath, branchName);
      }
      if (remoteSha !== commitSha) return await this.publicationDiverged(active, 'push-observation-diverged');
      active = await this.confirmEffect(active);
    } else if (await this.dependencies.git.getRemoteBranchSha(worktreePath, branchName) !== commitSha) {
      return await this.publicationDiverged(active, 'push-missing-before-later-effect');
    }

    const prMarker = `<!-- codex-orchestrator:run:${runId}:pr -->`;
    const prBody = `${prMarker}\n\nCloses #${issueNumber}`;
    if (active.record.pendingEffect?.kind === 'draft-pr' || !active.record.pendingEffect) {
      if (!active.record.pendingEffect) {
        active = await this.persist(active, {
          pendingEffect: {
            kind: 'draft-pr', owner: config.github.owner, repo: config.github.repo, head: branchName,
            base: config.github.baseBranch, issueNumber, marker: prMarker,
          },
        });
      }
      let observed = await this.dependencies.pullRequests.findOpen({ headBranch: branchName, baseBranch: config.github.baseBranch });
      if (observed && observed.body !== prBody) return await this.publicationDiverged(active, 'pr-marker-diverged');
      if (!observed) {
        if (this.signal.aborted) return await this.terminal(await this.clearEffect(active), { status: 'cancelled' });
        if (!await this.authorized(active, config)) return await this.revoked(active);
        try {

          await this.dependencies.pullRequests.createDraft({
            title: `Implement #${issueNumber}: ${issue.title}`,
            body: prBody,
            headBranch: branchName,
            baseBranch: config.github.baseBranch,
          });
        } catch { return await this.invokedFailure(active, 'pr-delivery-unknown'); }
        observed = await this.dependencies.pullRequests.findOpen({ headBranch: branchName, baseBranch: config.github.baseBranch });
      }
      if (!observed || observed.body !== prBody) return await this.publicationDiverged(active, 'pr-observation-diverged');
      active = await this.confirmEffect(active);
    }
    const pullRequest = await this.dependencies.pullRequests.findOpen({ headBranch: branchName, baseBranch: config.github.baseBranch });
    if (!pullRequest || pullRequest.body !== prBody) return await this.publicationDiverged(active, 'pr-missing-before-handoff');

    const handoffMarker = `<!-- codex-orchestrator:run:${runId}:handoff -->`;
    const handoffBody = `${handoffMarker}\nReview-ready draft PR: ${pullRequest.url}`;
    if (active.record.pendingEffect?.kind === 'handoff-comment' || !active.record.pendingEffect) {
      if (!active.record.pendingEffect) {
        active = await this.persist(active, {
          pendingEffect: { kind: 'handoff-comment', issueNumber, marker: handoffMarker, bodySha256: sha256(handoffBody) },
        });
      }
      let observation = await this.readIssue(issueNumber);
      if (!observation) return await this.publicationDiverged(active, 'issue-missing-during-handoff');
      let matching = commentsWithMarker(observation, handoffMarker);
      if (matching.some((comment) => sha256(comment.body) !== sha256(handoffBody)) || matching.length > 1) {
        return await this.publicationDiverged(active, 'handoff-comment-diverged');
      }
      if (matching.length === 0) {
        if (this.signal.aborted) return await this.terminal(await this.clearEffect(active), { status: 'cancelled' });
        if (!await this.authorized(active, config)) return await this.revoked(active);
        try {
 await this.dependencies.issues.postComment(issueNumber, handoffBody); }
        catch { return await this.invokedFailure(active, 'handoff-comment-delivery-unknown'); }
        observation = await this.readIssue(issueNumber);
        matching = observation ? commentsWithMarker(observation, handoffMarker) : [];
      }
      if (matching.length !== 1 || sha256(matching[0]!.body) !== sha256(handoffBody)) {
        return await this.publicationDiverged(active, 'handoff-comment-observation-diverged');
      }
      active = await this.confirmEffect(active);
    }

    const terminalLabels = [config.github.labels.review.name];
    if (active.record.pendingEffect?.kind === 'final-labels' || !active.record.pendingEffect) {
      if (!active.record.pendingEffect) active = await this.persist(active, { pendingEffect: { kind: 'final-labels', issueNumber, expected: terminalLabels } });
      let observation = await this.readIssue(issueNumber);
      if (!observation) return await this.publicationDiverged(active, 'issue-missing-during-labels');
      if (!sameStrings(observation.labels, terminalLabels)) {
        if (this.signal.aborted) return await this.terminal(await this.clearEffect(active), { status: 'cancelled' });
        if (!await this.authorized(active, config)) return await this.revoked(active);
        try {
 await this.dependencies.issues.setLabels(issueNumber, terminalLabels); }
        catch { return await this.invokedFailure(active, 'terminal-labels-delivery-unknown'); }
        observation = await this.readIssue(issueNumber);
      }
      if (!observation || !sameStrings(observation.labels, terminalLabels)) return await this.publicationDiverged(active, 'terminal-labels-diverged');
      active = await this.confirmEffect(active);
    }
    return this.persistTerminal(active, {
      status: 'review-ready', pullRequestUrl: pullRequest.url, continuationEpoch: commitSha,
    }, 'review-ready', false, {
      reviewFeedback: initializeReviewFeedback(
        active.record.reviewFeedback ?? {
          version: 1, updateEpoch: 0, consumedSourceIds: [], previousPublishedHeadSha: null,
          repairRound: 0, activeBatch: null, history: [], verifiedReceipt: null,
        }, commitSha, [],
      ),
    });
  }

  private publicationDiverged(active: ActiveRun, code: string): Promise<RunIssueResult> {
    return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, code);
  }

  private async updateExistingPullRequest(
    starting: ActiveRun,
    config: AgentAutoConfig,
    issueNumber: number,
  ): Promise<RunIssueResult> {
    let active = starting;
    const feedback = active.record.reviewFeedback;
    const batch = feedback?.activeBatch;
    const coordinator = this.dependencies.reviewFeedback;
    if (!feedback || !feedback.verifiedReceipt || !batch || !coordinator
      || !this.dependencies.pullRequests.listConversationComments || !this.dependencies.pullRequests.postConversationComment) {
      return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-contract-missing');
    }
    const oldHead = batch.priorPublishedHeadSha;
    const message = `fix: address review feedback for #${issueNumber}`;
    let head = await this.dependencies.git.getHead(active.record.worktreePath);
    let remote = await this.dependencies.git.getRemoteBranchSha(active.record.worktreePath, active.record.branchName);
    if (!active.record.pendingEffect) {
      if (head !== oldHead || remote !== oldHead) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-update-baseline-diverged');
      }
    }

    const candidateBinding = active.record.candidateBinding;
    if (candidateBinding) {
      const candidate = this.dependencies.git.candidateV2;
      if (!candidate) return this.persistRetainedCommitIntentTerminal(active, 'candidate-git-v2-required');
      if (!active.record.pendingEffect) {
        const recaptured = await candidate.captureAndPin({
          worktreePath: active.record.worktreePath,
          expectedHeadSha: oldHead,
          runId: active.record.runId,
          boundary: {
            kind: 'review-feedback', batchId: batch.batchId,
            repairRound: feedback.repairRound as 1 | 2 | 3,
            authoritySha256: active.record.deliveryAuthority!.authoritySha256,
          },
          artifactDir: config.proof.artifactDir,
        });
        if (recaptured.kind === 'failed') return this.mapCandidateFailure(active, recaptured.code);
        if (recaptured.value.bindingId !== candidateBinding.bindingId
          || recaptured.value.candidateTreeSha !== candidateBinding.candidateTreeSha
          || !sameStrings(recaptured.value.canonicalChangedFiles, candidateBinding.canonicalChangedFiles)) {
          if (recaptured.value.bindingId !== candidateBinding.bindingId) {
            await candidate.releasePin({ binding: recaptured.value, expectedPinnedCommitSha: recaptured.value.candidateCommitSha });
          }
          const released = await this.clearAndReleaseCandidate(active);
          if ('status' in released) return released;
          if (feedback.repairRound >= 3) {
            return this.blockReviewFeedback(released.active, 'exhausted', 'review-feedback-candidate-worktree-drift');
          }
          const reopened = await this.persist(released.active, {
            lifecycle: 'implementing',
            reviewFeedback: reserveNextReviewFeedbackRound(feedback),
            reworkFindings: ['The issue worktree changed after proof; rebuild and revalidate the review-feedback candidate.'],
            checks: [], checkedChangeSha256: undefined, proofId: undefined, proofReceipt: undefined,
          });
          return this.invokedFailure(reopened, 'review-feedback-candidate-worktree-drift', 'The next review-feedback repair round is ready.');
        }
        active = await this.persist(active, { pendingEffect: {
          kind: 'review-update-commit', batchId: batch.batchId, parentSha: oldHead,
          treeSha: candidateBinding.candidateTreeSha, message, candidateRef: candidateBinding.candidateRef,
        } });
      }
      const pendingEffect = active.record.pendingEffect;
      if (pendingEffect?.kind !== 'review-update-commit' || pendingEffect.batchId !== batch.batchId
        || pendingEffect.parentSha !== oldHead || pendingEffect.treeSha !== candidateBinding.candidateTreeSha
        || pendingEffect.message !== message || pendingEffect.candidateRef !== candidateBinding.candidateRef) {
        return this.persistRetainedCommitIntentTerminal(active, 'review-feedback-candidate-pendingEffect-diverged');
      }
      if (!await this.authorized(active, config)) return this.persistRetainedCommitIntentTerminal(active, 'review-feedback-publication-authority-revoked');
      const validation = await coordinator.revalidate({ batch, epoch: 'pre-update', expectedHeadSha: oldHead });
      const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-precommit-revalidation-failed');
      if (validationFailure) return validationFailure;
      const publication = await candidate.createOrObserveCommit({
        worktreePath: active.record.worktreePath,
        branchName: active.record.branchName,
        parentSha: pendingEffect.parentSha,
        treeSha: pendingEffect.treeSha,
        message: pendingEffect.message,
        candidateRef: pendingEffect.candidateRef,
      });
      if (publication.kind === 'failed') {
        return publication.code === 'candidate-ref-update-unknown'
          ? this.invokedFailure(active, publication.code, 'Candidate update outcome is unknown; retain and observe the exact commit effect.')
          : this.mapCandidateFailure(active, publication.code);
      }
      if (publication.value.kind === 'parent-unchanged') return this.invokedFailure(active, 'review-feedback-candidate-branch-update-not-observed');
      if (publication.value.kind === 'branch-diverged') return this.persistRetainedCommitIntentTerminal(active, 'candidate-branch-diverged');
      head = publication.value.sha;
      const normalized = await candidate.normalizeSharedIndex({ worktreePath: active.record.worktreePath, expectedHeadSha: head });
      if (normalized.kind === 'failed') return this.mapCandidateFailure(active, normalized.code);
      if ((await this.dependencies.git.listChangedFilesIgnoringUntrackedRoot(active.record.worktreePath, config.proof.artifactDir)).length > 0) {
        return this.persistRetainedCommitIntentTerminal(active, 'candidate-residual-worktree-drift');
      }
      try {
        active = await this.persist(active, {
          pendingEffect: {
            kind: 'review-update-push', batchId: batch.batchId, branch: active.record.branchName,
            priorRemoteSha: oldHead, sha: head, treeSha: candidateBinding.candidateTreeSha,
          },
          changeBindingVersion: undefined,
          candidateBinding: undefined,
        });
      } catch {
        throw new PostEffectStateError(active);
      }
      const released = await candidate.releasePin({ binding: candidateBinding, expectedPinnedCommitSha: candidateBinding.candidateCommitSha });
      if (released.kind === 'failed') {
        return this.invokedFailure(active, 'candidate-pin-release-unknown', 'The review update commit is confirmed; orphan reconciliation will retry exact pin cleanup.');
      }
    } else if (!active.record.pendingEffect || active.record.pendingEffect.kind === 'review-update-commit') {
      if (!active.record.pendingEffect) {
        active = await this.persist(active, { pendingEffect: {
          kind: 'review-update-commit', batchId: batch.batchId, parentSha: oldHead,
          treeSha: await this.dependencies.git.getTreeSha(active.record.worktreePath), message,
        } });
      }
      const pendingEffect = active.record.pendingEffect;
      if (pendingEffect?.kind !== 'review-update-commit' || pendingEffect.batchId !== batch.batchId
        || pendingEffect.parentSha !== oldHead || pendingEffect.message !== message) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-commit-pendingEffect-diverged');
      }
      head = await this.dependencies.git.getHead(active.record.worktreePath);
      if (head === pendingEffect.parentSha) {
        if (!await this.authorized(active, config)) {
          return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
        }
        const validation = await coordinator.revalidate({ batch, epoch: 'pre-update', expectedHeadSha: oldHead });
        const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-precommit-revalidation-failed');
        if (validationFailure) return validationFailure;
        if (await this.dependencies.git.getTreeSha(active.record.worktreePath) !== pendingEffect.treeSha) {
          return this.blockReviewFeedback(active, 'safety', 'review-feedback-commit-tree-diverged');
        }
        try { head = await this.dependencies.git.commit({ worktreePath: active.record.worktreePath, message: pendingEffect.message }); }
        catch { return this.invokedFailure(active, 'review-feedback-commit-delivery-unknown'); }
      }
      const commit = await this.dependencies.git.inspectHead(active.record.worktreePath);
      if (commit.sha !== head || commit.parentSha !== pendingEffect.parentSha || commit.treeSha !== pendingEffect.treeSha || commit.message !== pendingEffect.message) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-commit-observation-diverged');
      }
      active = await this.persist(active, { pendingEffect: {
        kind: 'review-update-push', batchId: batch.batchId, branch: active.record.branchName,
        priorRemoteSha: oldHead, sha: commit.sha, treeSha: commit.treeSha,
      } });
    }
    const commit = await this.dependencies.git.inspectHead(active.record.worktreePath);
    const recordedCommit = active.record.pendingEffect?.kind === 'review-update-push' ? active.record.pendingEffect : undefined;
    if (commit.parentSha !== oldHead || commit.message !== message
      || (recordedCommit && (commit.sha !== recordedCommit.sha || commit.treeSha !== recordedCommit.treeSha))) {
      return this.blockReviewFeedback(active, 'safety', 'review-feedback-update-commit-identity-diverged');
    }
    head = commit.sha;

    if (!active.record.pendingEffect || active.record.pendingEffect.kind === 'review-update-push') {
      if (!active.record.pendingEffect) active = await this.persist(active, { pendingEffect: {
        kind: 'review-update-push', batchId: batch.batchId, branch: active.record.branchName,
        priorRemoteSha: oldHead, sha: head, treeSha: commit.treeSha,
      } });
      const pendingEffect = active.record.pendingEffect;
      if (pendingEffect?.kind !== 'review-update-push' || pendingEffect.batchId !== batch.batchId || pendingEffect.sha !== head
        || pendingEffect.treeSha !== commit.treeSha || pendingEffect.branch !== active.record.branchName || pendingEffect.priorRemoteSha !== oldHead) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-push-pendingEffect-diverged');
      }
      remote = await this.dependencies.git.getRemoteBranchSha(active.record.worktreePath, active.record.branchName);
      if (remote === oldHead) {
        if (!await this.authorized(active, config)) {
          return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
        }
        const validation = await coordinator.revalidate({ batch, epoch: 'pre-update', expectedHeadSha: oldHead });
        const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-prepush-revalidation-failed');
        if (validationFailure) return validationFailure;
        try { await this.dependencies.git.push({ worktreePath: active.record.worktreePath, branchName: active.record.branchName }); }
        catch { return this.invokedFailure(active, 'review-feedback-push-delivery-unknown'); }
        remote = await this.dependencies.git.getRemoteBranchSha(active.record.worktreePath, active.record.branchName);
      }
      if (remote !== head) return this.blockReviewFeedback(active, 'safety', 'review-feedback-push-observation-diverged');
    }

    const postPush = await coordinator.revalidate({ batch, epoch: 'post-push', expectedHeadSha: head });
    const postPushFailure = await this.mapFeedbackRevalidation(active, postPush, 'review-feedback-postpush-revalidation-failed');
    if (postPushFailure) return postPushFailure;
    const marker = `<!-- codex-orchestrator:run:${active.record.runId}:review-feedback:${batch.batchId} -->`;
    const body = [
      marker,
      '',
      `Addressed frozen review feedback batch ${batch.batchId}.`,
      `Updated head: ${head}`,
      'Complete independent review, configured checks, and Acceptance Proof passed.',
      'Review threads remain for human resolution.',
    ].join('\n');
    if (active.record.pendingEffect?.kind === 'review-update-push') {
      active = await this.persist(active, { pendingEffect: {
        kind: 'review-summary', batchId: batch.batchId, pullRequestNumber: batch.pullRequest.number,
        pullRequestNodeId: batch.pullRequest.nodeId, marker, bodySha256: sha256(body), epochHeadSha: head,
      } });
    }
    let summaryId = '';
    if (!active.record.pendingEffect || active.record.pendingEffect.kind === 'review-summary') {
      if (!active.record.pendingEffect) active = await this.persist(active, { pendingEffect: {
        kind: 'review-summary', batchId: batch.batchId, pullRequestNumber: batch.pullRequest.number,
        pullRequestNodeId: batch.pullRequest.nodeId, marker, bodySha256: sha256(body), epochHeadSha: head,
      } });
      const pendingEffect = active.record.pendingEffect;
      if (pendingEffect?.kind !== 'review-summary' || pendingEffect.batchId !== batch.batchId
        || pendingEffect.pullRequestNumber !== batch.pullRequest.number || pendingEffect.pullRequestNodeId !== batch.pullRequest.nodeId
        || pendingEffect.marker !== marker || pendingEffect.bodySha256 !== sha256(body) || pendingEffect.epochHeadSha !== head) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-summary-pendingEffect-diverged');
      }
      const validation = await coordinator.revalidate({ batch, epoch: 'post-push', expectedHeadSha: head });
      const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-summary-revalidation-failed');
      if (validationFailure) return validationFailure;
      let matches = (await this.dependencies.pullRequests.listConversationComments(batch.pullRequest.number))
        .filter((comment) => comment.body.split('\n')[0] === marker);
      if (matches.some((comment) => comment.body !== body) || matches.length > 1) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-summary-diverged');
      }
      if (matches.length === 0) {
        if (!await this.authorized(active, config)) {
          return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
        }
        try {
 await this.dependencies.pullRequests.postConversationComment(batch.pullRequest.number, body); }
        catch { return this.invokedFailure(active, 'review-feedback-summary-delivery-unknown'); }
        matches = (await this.dependencies.pullRequests.listConversationComments(batch.pullRequest.number))
          .filter((comment) => comment.body.split('\n')[0] === marker);
      }
      if (matches.length !== 1 || matches[0]!.body !== body) return this.blockReviewFeedback(active, 'safety', 'review-feedback-summary-observation-diverged');
      summaryId = matches[0]!.id;
      active = await this.persist(active, { pendingEffect: {
        kind: 'review-final-labels', issueNumber, batchId: batch.batchId,
        pullRequestNumber: batch.pullRequest.number, pullRequestNodeId: batch.pullRequest.nodeId,
        epochHeadSha: head, expected: [config.github.labels.review.name],
      } });
    }
    if (!summaryId) {
      const matches = (await this.dependencies.pullRequests.listConversationComments(batch.pullRequest.number))
        .filter((comment) => comment.body.split('\n')[0] === marker && comment.body === body);
      if (matches.length !== 1) return this.blockReviewFeedback(active, 'safety', 'review-feedback-summary-missing');
      summaryId = matches[0]!.id;
    }

    const finalLabels = [config.github.labels.review.name];
    if (!active.record.pendingEffect || active.record.pendingEffect.kind === 'review-final-labels') {
      if (!active.record.pendingEffect) active = await this.persist(active, { pendingEffect: {
        kind: 'review-final-labels', issueNumber, batchId: batch.batchId,
        pullRequestNumber: batch.pullRequest.number, pullRequestNodeId: batch.pullRequest.nodeId,
        epochHeadSha: head, expected: finalLabels,
      } });
      const pendingEffect = active.record.pendingEffect;
      if (pendingEffect?.kind !== 'review-final-labels' || pendingEffect.issueNumber !== issueNumber
        || pendingEffect.batchId !== batch.batchId || pendingEffect.pullRequestNumber !== batch.pullRequest.number
        || pendingEffect.pullRequestNodeId !== batch.pullRequest.nodeId || pendingEffect.epochHeadSha !== head
        || !sameStrings(pendingEffect.expected, finalLabels)) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-final-labels-pendingEffect-diverged');
      }
      const validation = await coordinator.revalidate({ batch, epoch: 'post-push', expectedHeadSha: head });
      const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-final-labels-revalidation-failed');
      if (validationFailure) return validationFailure;
      let issue = await this.readIssue(issueNumber);
      if (!issue || !sameStrings(issue.labels, finalLabels)) {
        if (!await this.authorized(active, config)) {
          return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
        }
        try {
 await this.dependencies.issues.setLabels(issueNumber, finalLabels); }
        catch { return this.invokedFailure(active, 'review-feedback-final-labels-delivery-unknown'); }
        issue = await this.readIssue(issueNumber);
      }
      if (!issue || !sameStrings(issue.labels, finalLabels)) return this.blockReviewFeedback(active, 'safety', 'review-feedback-final-labels-diverged');
      active = await this.confirmEffect(active);
    }

    const receipt = {
      kind: 'published' as const,
      batchId: batch.batchId,
      sourceIds: batch.sources.map((source) => source.sourceId),
      priorHeadSha: oldHead,
      publishedHeadSha: head,
      pullRequestNumber: batch.pullRequest.number,
      summaryCommentId: summaryId,
      publishedAt: this.timestamp(),
    };
    const pullRequestUrl = `https://github.com/${active.record.canonicalRepository}/pull/${batch.pullRequest.number}`;
    return this.persistTerminal(active, {
      status: 'review-ready', pullRequestUrl, continuationEpoch: head,
    }, 'review-ready', false, {
      reviewFeedback: publishReviewFeedback(active.record.reviewFeedback!, receipt),
    });
  }

  private async continueReviewReady(
    starting: ActiveRun,
    targetRoot: string,
    config: AgentAutoConfig,
  ): Promise<{ active: ActiveRun } | { result: RunIssueResult }> {
    const terminal = starting.record.terminalOutcome;
    const feedback = starting.record.reviewFeedback;
    if (!terminal || terminal.status !== 'review-ready' || !feedback || !this.dependencies.reviewFeedback
      || starting.record.directReview?.status !== 'clear') {
      return { result: publicOutcome(terminal!) };
    }
    const pullRequest = await this.dependencies.pullRequests.findOpen({
      headBranch: starting.record.branchName,
      baseBranch: config.github.baseBranch,
    });
    if (!pullRequest?.number || !pullRequest.nodeId || !pullRequest.headSha) {
      return { result: await this.reviewReadyObservationBlocked(starting, 'review-feedback-pr-identity-missing') };
    }
    const expectedHeadSha = feedback.previousPublishedHeadSha === null
      ? pullRequest.headSha
      : feedback.previousPublishedHeadSha;
    if (!expectedHeadSha) {
      return { result: await this.reviewReadyObservationBlocked(starting, 'review-feedback-head-missing') };
    }
    const observed = await this.dependencies.reviewFeedback.observeAndFreeze({
      runId: starting.record.runId,
      canonicalRepository: starting.record.canonicalRepository,
      pullRequestNumber: pullRequest.number,
      expectedHeadSha,
      expectedHeadRefName: starting.record.branchName,
      expectedBaseRefName: config.github.baseBranch,
      marker: `<!-- codex-orchestrator:run:${starting.record.runId}:pr -->`,
      consumedSourceIds: feedback.consumedSourceIds,
      restPullRequest: {
        number: pullRequest.number,
        nodeId: pullRequest.nodeId,
        headSha: pullRequest.headSha,
        body: pullRequest.body,
      },
    });
    if (observed.status === 'retryable') return { result: await this.invokedFailure(starting, 'review-feedback-observation-retryable') };
    if (observed.status === 'blocked') {
      return { result: await this.reviewReadyObservationBlocked(starting, 'review-feedback-observation-blocked') };
    }
    if (feedback.previousPublishedHeadSha === null) {
      const sourceIds = observed.status === 'frozen'
        ? observed.batch.sources.map((source) => source.sourceId)
        : observed.eligibleSourceIds;
      const active = await this.persist(starting, {
        reviewFeedback: initializeReviewFeedback(feedback, expectedHeadSha, sourceIds),
      });
      return { result: publicOutcome(active.record.terminalOutcome!) };
    }
    if (feedback.activeBatch || observed.status === 'none') return { result: publicOutcome(terminal) };

    if (!await this.authorizedForExactLabels(starting, [config.github.labels.review.name])) {
      return { result: publicOutcome(terminal) };
    }

    const projected = projectReviewFeedbackBatch(observed.batch, starting.record.directReview.targetRevision);
    const repairReview = beginDirectReviewRepair(starting.record.directReview, projected.repairFindings);
    let active = await this.persist(starting, {
      lifecycle: 'implementing',
      reviewFeedback: activateReviewFeedback(feedback, observed.batch),
      directReview: {
        ...repairReview,
        review: { ...repairReview.review, reportRepairs: 0, transportRetries: 0 },
      },
      reworkFindings: projected.repairFindings.map((finding) => finding.summary),
      reportRepairs: 0,
      transportRetries: 0,
      checks: [],
      checkedChangeSha256: undefined,
      proofId: undefined,
      proofReceipt: undefined,
      terminalOutcome: undefined,
      outcomeEvidenceId: undefined,
      pendingEffect: {
        kind: 'review-activation-labels',
        issueNumber: starting.record.issueNumber,
        batchId: observed.batch.batchId,
        expected: sortedUnique([config.github.labels.auto.name, config.github.labels.running.name]),
      },
    });
    return this.resumeActivatedReviewFeedback(active, targetRoot, config);
  }

  private async resumeActivatedReviewFeedback(
    starting: ActiveRun,
    targetRoot: string,
    config: AgentAutoConfig,
  ): Promise<{ active: ActiveRun } | { result: RunIssueResult }> {
    let active = starting;
    const feedback = active.record.reviewFeedback;
    const batch = feedback?.activeBatch;
    if (!feedback || !batch || feedback.verifiedReceipt || !this.dependencies.reviewFeedback) {
      return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-state-invalid') };
    }
    const expectedHeadSha = batch.priorPublishedHeadSha;
    const runningLabels = sortedUnique([config.github.labels.auto.name, config.github.labels.running.name]);
    const reviewLabels = [config.github.labels.review.name];
    const pendingEffect = active.record.pendingEffect;
    if (pendingEffect && (pendingEffect.kind !== 'review-activation-labels'
      || pendingEffect.issueNumber !== active.record.issueNumber
      || pendingEffect.batchId !== batch.batchId
      || !sameStrings(pendingEffect.expected, runningLabels))) {
      return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-pendingEffect-diverged') };
    }
    const issue = await this.readIssue(active.record.issueNumber);
    const labelsAreRunning = !!issue && issue.state === 'OPEN' && sameStrings(issue.labels, runningLabels)
      && this.hasTrustedClaim(issue, active.record);
    const labelsAreReview = !!issue && issue.state === 'OPEN' && sameStrings(issue.labels, reviewLabels)
      && this.hasTrustedClaim(issue, active.record);
    if (!labelsAreRunning && !labelsAreReview) {
      return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-authority-revoked') };
    }
    const validation = await this.dependencies.reviewFeedback.revalidate({
      batch, epoch: 'pre-update', expectedHeadSha,
    });
    const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-activation-revalidation-failed');
    if (validationFailure) return { result: validationFailure };
    if (labelsAreReview) {
      try {
 await this.dependencies.issues.setLabels(active.record.issueNumber, runningLabels); }
      catch { return { result: await this.invokedFailure(active, 'review-feedback-activation-labels-delivery-unknown') }; }
      const observed = await this.readIssue(active.record.issueNumber);
      if (!observed || !sameStrings(observed.labels, runningLabels)
        || !this.hasTrustedClaim(observed, active.record)) {
        return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-labels-diverged') };
      }
    }
    if (pendingEffect) active = await this.confirmEffect(active);
    const worktree = await this.createContinuationWorktreeEffect(active, targetRoot, expectedHeadSha);
    if ('status' in worktree) return { result: worktree };
    active = worktree.active;
    if ((await this.dependencies.git.listChangedFilesIgnoringUntrackedRoot(
        active.record.worktreePath,
        config.proof.artifactDir,
      )).length !== 0) {
      return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-worktree-diverged') };
    }
    return { active };
  }

  private async reviewReadyObservationBlocked(active: ActiveRun, code: string): Promise<RunIssueResult> {
    return this.persistTerminal(active, { status: 'blocked', kind: 'safety', resumable: false }, code, false);
  }

  async runIssue(input: { targetRoot: string; issueNumber: number }): Promise<RunIssueResult> {
    let owner: { release(): Promise<void> } | undefined;
    let active: ActiveRun | undefined;
    try {
      assertPositiveInteger(input.issueNumber, 'issueNumber');
      const targetRoot = resolve(input.targetRoot);
      const initialConfig = await this.readStrictConfig(targetRoot);
      const canonicalRepository = `${initialConfig.config.github.owner.toLowerCase()}/${initialConfig.config.github.repo.toLowerCase()}`;
      const preflightState = await this.dependencies.runRecords.inspect();
      if (preflightState.status === 'unsupported') return { status: 'state-schema-unsupported' };
      try {
        owner = await this.dependencies.ownerLock.acquire({ canonicalRepository, targetRoot });
      } catch (error) {
        if (error instanceof OwnerLockContentionError) {
          const evidence = await this.dependencies.writeEvidence({
            runId: `issue-${input.issueNumber}`, code: 'owner-contention', summary: 'A known live owner is still running.',
          });
          return { status: 'requeued', reason: 'owner-contention', evidencePath: evidence.path };
        }
        if (error instanceof OwnerLockSafetyError) {
          const evidence = await this.dependencies.writeEvidence({
            runId: `issue-${input.issueNumber}`,
            code: 'owner-lock-blocked',
            summary: 'Repository ownership is ambiguous or already held.',
          });
          return { status: 'blocked', kind: 'safety', resumable: true, evidencePath: evidence.path };
        }
        return await this.preClaimInternal('state-write-failed', input.issueNumber);
      }
      const confirmedConfig = await this.readStrictConfig(targetRoot);
      if (!confirmedConfig.bytes.equals(initialConfig.bytes)
        || canonicalRepository !== `${confirmedConfig.config.github.owner.toLowerCase()}/${confirmedConfig.config.github.repo.toLowerCase()}`) {
        return await this.preClaimInternal('config-changed-during-owner-acquire', input.issueNumber);
      }
      const config = confirmedConfig.config;
      if (this.signal.aborted) return await this.preClaimCancelled(input.issueNumber);

      let authoritativeState = await this.dependencies.runRecords.inspect();
      if (authoritativeState.status === 'unsupported') return { status: 'state-schema-unsupported' };
      if (!sameInspectionIdentity(preflightState, authoritativeState)) {
        const stableState = await this.dependencies.runRecords.inspect();
        if (stableState.status === 'unsupported') return { status: 'state-schema-unsupported' };
        if (!sameInspectionIdentity(authoritativeState, stableState)) {
          return { status: 'requeued', reason: 'state-changed' };
        }
        authoritativeState = stableState;
      }
      const persisted: RunStateFile = authoritativeState.status === 'supported'
        ? authoritativeState.state
        : { schema: 'codex-orchestrator.run-state', generation: 0, runs: [] };

      let issue: RunIssueSnapshot | undefined;
      try {
        issue = await this.dependencies.issues.read(input.issueNumber);
      } catch {
        return await this.preClaimTransport(input.issueNumber);
      }
      if (this.dependencies.git.candidateV2?.reconcileOrphans) {
        const reconciled = await this.dependencies.git.candidateV2.reconcileOrphans({
          repositoryRoot: targetRoot,
          workspaceRoot: resolve(targetRoot, config.runner.workspaceRoot),
          activeCandidateRefs: persisted.runs.flatMap((run) => run.candidateBinding ? [run.candidateBinding.candidateRef] : []),
          pendingCandidates: persisted.runs.flatMap((run) => {
            const boundary = pendingCandidateBoundary(run);
            return !run.terminalOutcome && !run.candidateBinding && boundary
              ? [{ runId: run.runId, worktreePath: run.worktreePath, expectedHeadSha: expectedImplementationHead(run), boundary, artifactDir: config.proof.artifactDir }]
              : [];
          }),
          activeMaterializations: persisted.runs.flatMap((run) => run.candidateMaterialization
            ? [{ path: run.candidateMaterialization.path, candidateCommitSha: run.candidateMaterialization.candidateCommitSha }]
            : []),
        });
        if (reconciled.kind === 'failed') return this.preClaimTransport(input.issueNumber);
      }
      const matchingRuns = persisted.runs.filter((run) => run.issueNumber === input.issueNumber && run.canonicalRepository === canonicalRepository);
      if (matchingRuns.length > 1) return await this.preClaimInternal('ambiguous-run-state', input.issueNumber);
      const existing = matchingRuns[0];
      let issueSnapshot: IssueSnapshot;
      let frozenCriteria: FrozenCriterion[];
      let runId: string;
      let branchName: string;
      let worktreePath: string;
      let baseSha: string;
      if (existing) {
        const expectedBranch = `codex/issue-${input.issueNumber}`;
        const expectedWorktree = resolve(targetRoot, config.runner.workspaceRoot, `issue-${input.issueNumber}`);
        if (existing.branchName !== expectedBranch || existing.worktreePath !== expectedWorktree) {
          return await this.preClaimInternal('run-identity-mismatch', input.issueNumber);
        }
        active = { state: persisted, record: existing, config };
        issueSnapshot = structuredClone(existing.issueSnapshot);
        frozenCriteria = structuredClone(existing.frozenCriteria);
        runId = existing.runId;
        branchName = existing.branchName;
        worktreePath = existing.worktreePath;
        baseSha = existing.baseSha;
        if (active.record.pendingEffect?.kind === 'outcome-evidence') {
          if (active.record.terminalOutcome) {
            const observed = await this.observeOutcomeEvidenceEffect(
              active,
              active.record.pendingEffect.code,
              active.record.pendingEffect.summary,
            );
            await this.confirmEffect(observed.active);
            return publicOutcome(active.record.terminalOutcome);
          }
          const seed = parseTerminalSeedSummary(active.record.pendingEffect.summary);
          return await this.persistTerminal(active, seed, active.record.pendingEffect.code, false);
        }
        if (active.record.pendingEffect?.kind === 'review-blocked-labels') {
          return await this.blockReviewFeedback(
            active,
            active.record.pendingEffect.blockKind,
            active.record.pendingEffect.evidenceCode,
          );
        }
        if (active.record.pendingEffect?.kind === 'blocked-labels') {
          return await this.publishBlockedTerminal(
            active,
            {
              status: 'blocked',
              kind: active.record.pendingEffect.blockKind,
              resumable: active.record.pendingEffect.resumable,
            },
            active.record.pendingEffect.evidenceCode,
          );
        }
        if (existing.terminalOutcome?.status === 'blocked'
          && issue?.state === 'OPEN'
          && blockedLabelProjection(issue.labels, config).status !== 'settled') {
          return await this.reconcilePersistedBlockedTerminal(active, issue, existing.terminalOutcome);
        }
        if (active.record.terminalOutcome?.status === 'transport-failed'
          && !active.record.terminalOutcome.resumable
          && active.record.candidateBinding
          && (active.record.pendingEffect?.kind === 'initial-commit' || active.record.pendingEffect?.kind === 'review-update-commit')) {
          const reconciled = await this.reconcileUnknownCandidatePublication(active);
          if ('status' in reconciled) return reconciled;
          active = reconciled.active;
        }
        if (active.record.terminalOutcome && active.record.activeAttempt) {
          const reconciled = await this.reconcilePersistedAttempt(active);
          if ('status' in reconciled) return reconciled;
          active = reconciled.active;
          const attempt = active.record.activeAttempt;
          if (attempt?.stage === 'observed' && attempt.result) {
            active = await this.adoptAttempt(active, attempt.result.sha256, {});
          } else if (attempt && attempt.stage !== 'launched') {
            active = await this.clearAttempt(active);
          }
        }
        if (active.record.terminalOutcome && active.record.candidateMaterialization) {
          const reconciled = await this.reconcilePersistedCandidateMaterialization(active, config);
          if ('status' in reconciled) return reconciled;
          active = reconciled.active;
        }
        if (active.record.terminalOutcome) {
          if (active.record.terminalOutcome.status !== 'review-ready') {
            const recovered = await this.recoverTerminalReviewReport(active, issue, config, frozenCriteria);
            if (!recovered) return publicOutcome(active.record.terminalOutcome);
            active = recovered;
          } else {
            const continuation = await this.continueReviewReady(active, targetRoot, config);
            if ('result' in continuation) return continuation.result;
            active = continuation.active;
            issueSnapshot = structuredClone(active.record.issueSnapshot);
            frozenCriteria = structuredClone(active.record.frozenCriteria);
          }
        }
        if (active.record.activeAttempt && active.record.lifecycle !== 'safe-halt') {
          const reconciled = await this.reconcilePersistedAttempt(active);
          if ('status' in reconciled) return reconciled;
          active = reconciled.active;
        }
        if (active.record.candidateMaterialization) {
          const reconciled = await this.reconcilePersistedCandidateMaterialization(active, config);
          if ('status' in reconciled) return reconciled;
          active = reconciled.active;
        }
        if (active.record.reviewFeedback?.activeBatch && active.record.pendingEffect?.kind === 'review-activation-labels') {
          const activation = await this.resumeActivatedReviewFeedback(active, targetRoot, config);
          if ('result' in activation) return activation.result;
          active = activation.active;
        }
        if (active.record.lifecycle === 'publishing') {
          return active.record.reviewFeedback?.activeBatch
            ? await this.updateExistingPullRequest(active, config, input.issueNumber)
            : await this.publish(active, config, issueSnapshot, input.issueNumber);
        }
        if (active.record.lifecycle === 'claimed') {
          if (active.record.pendingEffect?.kind !== 'worktree-create') {
            const claim = await this.reconcileClaim(active, config);
            if ('result' in claim) return claim.result;
            active = claim.active;
          }
          const worktree = await this.createInitialWorktreeEffect(active, targetRoot);
          if ('status' in worktree) return worktree;
          active = worktree.active;
          active = await this.initializeClaimedRun(active, issue);
          issueSnapshot = structuredClone(active.record.issueSnapshot);
        } else {
          if (active.record.lifecycle === 'safe-halt') {
            const attempt = active.record.activeAttempt;
            if (!attempt || attempt.stage !== 'launched') return await this.publicationDiverged(active, 'safe-halt-attempt-missing');
            try { await this.dependencies.waitForReviewProcessAbsence(attempt.process.processGroupId); }
            catch { return await this.invokedFailure(active, 'safe-halt-process-absence-unconfirmed'); }
            const observed = observeActiveAttempt(attempt, {
              leader: 'absent', group: 'absent', result: null, observedAt: this.timestamp(),
            });
            active = await this.persist(active, { activeAttempt: observed });
            active = await this.clearAttempt(active);
            active = await this.persist(active, { lifecycle: lifecycleForAttempt(attempt.operationId) });
          }
          if (active.record.lifecycle === 'publishing') {
            return active.record.reviewFeedback?.activeBatch
              ? await this.updateExistingPullRequest(active, config, input.issueNumber)
              : await this.publish(active, config, issueSnapshot, input.issueNumber);
          }
          let transitionedFromSpec = false;
          if (active.record.lifecycle === 'spec-authoring') {
            if (!await this.authorized(active, config)) return await this.revoked(active);
            const spec = await this.continueSpecRequired(active);
            if ('result' in spec) return spec.result;
            active = spec.active;
            transitionedFromSpec = active.record.lifecycle === 'implementing';
          }
          if (!['triaging', 'routed', 'implementing', 'reworking', 'checking', 'proving'].includes(active.record.lifecycle)) {
            return await this.terminal(active, { status: 'internal-error', code: 'resume-phase-not-reconciled' });
          }
          if (!await this.authorized(active, config)) return await this.revoked(active);
          if (active.record.lifecycle !== 'triaging' && active.record.lifecycle !== 'routed') {
            if (!active.record.routeExecution || !active.record.routeReceipt) throw new RouteInitializationUnrecoverableError();
            const preparedImplementationRecovery = active.record.lifecycle === 'implementing'
              && active.record.activeAttempt?.stage === 'prepared'
              && active.record.activeAttempt.operationId === 'implementation';
            if (active.record.lifecycle === 'implementing' && active.record.routeReceipt.route === 'spec-required'
              && (!active.record.activeAttempt || preparedImplementationRecovery) && !active.record.directReview) {
              const answerTrust = await this.revalidateSpecAnswers(active);
              if (answerTrust.status === 'frozen') {
                return frozenQuestionProjection(answerTrust.question, answerTrust.evidencePath);
              }
            }
            const reviewRecovery = active.record.lifecycle === 'implementing' && active.record.directReview?.status === 'active'
              && active.record.directReview.stage === 'review';
            const checkRecovery = active.record.lifecycle === 'checking'
              && active.record.directReview?.status === 'clear';
            const proofRecovery = active.record.lifecycle === 'proving'
              && active.record.directReview?.status === 'clear';
            const directReviewRepair = active.record.lifecycle === 'implementing'
              && active.record.directReview?.status === 'active'
              && active.record.directReview.stage === 'review-repair';
            const attemptResultRecovery = active.record.activeAttempt?.stage === 'observed'
              && active.record.activeAttempt.result !== null;
            if (!transitionedFromSpec && !preparedImplementationRecovery && !reviewRecovery && !checkRecovery
              && !proofRecovery && !directReviewRepair && !attemptResultRecovery) {
              if (this.repairBudgetExhausted(active, config.runner.maxCycles)) {
                return await this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true });
              }
              active = await this.startNextCycle(active, [`Recovered interrupted ${active.record.lifecycle} phase.`]);
            }
          }
        }
      } else {
        const ineligible = await this.ineligibilityReason(issue, config);
        if (ineligible) {
          const evidence = await this.dependencies.writeEvidence({ runId: `issue-${input.issueNumber}`, code: 'not-eligible', summary: ineligible });
          return { status: 'not-eligible', reason: ineligible, evidencePath: evidence.path };
        }
        issueSnapshot = snapshotIssue(issue!);
        frozenCriteria = freezeCriteria(issueSnapshot);
        runId = this.dependencies.createRunId();
        assertUuid(runId);
        branchName = `codex/issue-${input.issueNumber}`;
        worktreePath = resolve(targetRoot, config.runner.workspaceRoot, `issue-${input.issueNumber}`);
        try {
          baseSha = await this.dependencies.git.getBaseSha({ targetRoot, baseBranch: config.github.baseBranch });
        } catch {
          return await this.preClaimTransport(
            input.issueNumber,
            'base-refresh-failed',
            'The configured remote base branch could not be refreshed before claim.',
          );
        }
        assertGitSha(baseSha, 'baseSha');
        const claimBody = claimComment(runId, input.issueNumber, branchName);
        active = await this.createRun({
          runId, issueNumber: input.issueNumber, canonicalRepository, baseSha, branchName, worktreePath,
          issueSnapshot, frozenCriteria, config,
          pendingEffect: {
            kind: 'claim-comment', issueNumber: input.issueNumber, marker: claimBody.split('\n')[0]!, bodySha256: sha256(claimBody),
          },
        });
        const claim = await this.reconcileClaim(active, config);
        if ('result' in claim) return claim.result;
        active = claim.active;
        const worktree = await this.createInitialWorktreeEffect(active, targetRoot);
        if ('status' in worktree) return worktree;
        active = worktree.active;
        active = await this.initializeClaimedRun(active, issue);
        issueSnapshot = structuredClone(active.record.issueSnapshot);
      }
      if (active.record.lifecycle === 'triaging' || active.record.lifecycle === 'routed') {
        const routed = await this.routeRun(active, issueSnapshot, frozenCriteria, worktreePath, config, input.issueNumber, branchName);
        if ('result' in routed) return routed.result;
        active = routed.active;
      }
      if (!['implementing', 'checking', 'proving'].includes(active.record.lifecycle)) {
        return await this.terminal(active, { status: 'internal-error', code: 'route-dispatch-not-implementing' });
      }
      if (active.record.lifecycle === 'checking' && !active.record.directReview && active.record.routeReceipt?.route === 'direct') {
        return await this.terminal(active, { status: 'internal-error', code: 'direct-review-state-missing' });
      }
      if (active.record.routeReceipt?.route === 'direct' && !this.dependencies.git.candidateV2) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-git-v2-required');
      }
      attemptLoop: while (true) {
      if (!await this.authorized(active, config)) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }
      if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });

      let resumeAtChecks = (active.record.lifecycle === 'checking' || active.record.lifecycle === 'proving')
        && active.record.directReview?.status === 'clear';
      if (active.record.lifecycle === 'implementing'
        && active.record.directReview?.status === 'active'
        && active.record.directReview.stage === 'review') {
        const recoveryBoundary = active.record.reviewFeedback?.activeBatch
          ? {
            kind: 'review-feedback' as const,
            batchId: active.record.reviewFeedback.activeBatch.batchId,
            repairRound: active.record.reviewFeedback.repairRound as 1 | 2 | 3,
            authoritySha256: active.record.deliveryAuthority!.authoritySha256,
          }
          : { kind: 'implementation-cycle' as const, cycle: active.record.cycle, authoritySha256: active.record.deliveryAuthority!.authoritySha256 };
        const captured = await this.ensureCandidateBinding(active, config, recoveryBoundary);
        if ('status' in captured) return captured;
        active = captured.active;
        const binding = active.record.candidateBinding!;
        const candidateTargetFingerprint = directReviewCandidateTargetFingerprint({
          binding,
          routeDecisionSha256: active.record.deliveryAuthority!.authoritySha256,
          workflowGenerationHash: active.record.workflowGeneration.generationHash,
          cycle: active.record.cycle,
          frozenCriteria,
        });
        if (active.record.directReview!.targetFingerprint !== candidateTargetFingerprint) {
          active = await this.persist(active, {
            directReview: { ...active.record.directReview!, targetFingerprint: candidateTargetFingerprint },
          });
        }
        const reviewed = await this.runDirectReviewFull(
          active,
          publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          `recovered-implementation-cycle-${active.record.cycle}`,
          config.runner.maxCycles,
          config,
        );
        if ('status' in reviewed) return reviewed;
        active = reviewed;
        if (active.record.lifecycle === 'implementing') continue attemptLoop;
        resumeAtChecks = true;
      }

      if (!resumeAtChecks) {
      if (active.record.routeReceipt?.route === 'spec-required'
        && (!active.record.activeAttempt || active.record.activeAttempt.stage === 'prepared')) {
        const answerTrust = await this.revalidateSpecAnswers(active);
        if (answerTrust.status === 'frozen') {
          return frozenQuestionProjection(answerTrust.question, answerTrust.evidencePath);
        }
      }
      const feedbackBatch = active.record.reviewFeedback?.activeBatch;
      const workerBlock = await this.revalidateFeedbackWorker(active, config, input.issueNumber);
      if (workerBlock) return workerBlock;
      const feedbackProjection = feedbackBatch
        ? projectReviewFeedbackBatch(feedbackBatch, active.record.directReview!.targetRevision)
        : undefined;
      let implementationPreparationFailure: RunIssueResult | undefined;
      const implementationLaunch = {
        ...(feedbackBatch ? {
          reviewFeedbackRound: active.record.reviewFeedback!.repairRound,
          reviewFeedback: feedbackProjection!.workerFeedback,
        } : {}),
        onPrepared: async (prepared: { attemptId: string; reportPath: string }) => {
          const currentActive = active!;
          if (currentActive.record.routeReceipt?.route === 'spec-required') {
            const trust = await this.revalidateSpecAnswers(currentActive);
            if (trust.status === 'frozen') {
              implementationPreparationFailure = frozenQuestionProjection(trust.question, trust.evidencePath);
              throw new Error('implementation preparation authorization changed');
            }
          }
          if (active!.record.activeAttempt?.attemptId !== prepared.attemptId
            || active!.record.activeAttempt.resultPath !== prepared.reportPath) {
            throw new Error('implementation attempt identity mismatch');
          }
        },
        onLaunched: async (launched: { attemptId: string; pid: number; processGroupId: number }) => {
          const currentActive = active!;
          const failure = await this.revalidateFeedbackWorker(currentActive, config, input.issueNumber);
          if (failure) {
            implementationPreparationFailure = failure;
            throw new Error('implementation launch authorization changed');
          }
          if (currentActive.record.activeAttempt?.attemptId !== launched.attemptId) throw new Error('implementation launch mismatch');
          active = await this.launchAttempt(currentActive, launched.pid, launched.processGroupId);
        },
      };
      const deniedPathsBaseline = await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths);
      if (!active.record.activeAttempt) {
        active = await this.prepareAttempt(
          active,
          'implementation',
          feedbackBatch
            ? `${feedbackBatch.batchId}:${active.record.reviewFeedback!.repairRound}`
            : `${active.record.cycle}:${active.record.reportRepairs}`,
        );
      }
      const implementationAttempt = active.record.activeAttempt;
      if (!implementationAttempt) return await this.terminal(active, { status: 'internal-error', code: 'implementation-attempt-missing' });
      let implementation = await this.runImplementation({
        operation: 'implementation',
        attemptId: implementationAttempt.attemptId,
        runId,
        worktreePath,
        issue: publicIssueSnapshot(issueSnapshot),
        frozenCriteria,
        deliveryAuthority: active.record.deliveryAuthority!,
        cycle: active.record.cycle,
        reworkFindings: active.record.reworkFindings,
        repairOnly: false,
        workflowGeneration: active.record.workflowGeneration,
        ...implementationLaunch,
      });
      if (implementationPreparationFailure) return implementationPreparationFailure;
      if (implementation.kind !== 'safe-halt') active = await this.observeReturnedAttempt(
        active, implementation.kind === 'completed' ? implementation.report : implementation,
      );
      if (implementation.kind === 'safe-halt') {
        active = await this.persist(active, { lifecycle: 'safe-halt' });
        while (true) {
          try {
            await implementation.waitForAbsence();
            break;
          } catch {
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
        }
        if (await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths) !== deniedPathsBaseline) {
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'denied-path-modified');
        }
        return await this.terminal(active, { status: 'transport-failed', resumable: false }, 'process-quiescence-delayed');
      }
      if (await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths) !== deniedPathsBaseline) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'denied-path-modified');
      }
      if (implementation.kind === 'transport-failed' && implementation.resumable && active.record.transportRetries === 0) {
        active = await this.clearAttempt(active);
        active = await this.persist(active, { transportRetries: 1 });
        continue attemptLoop;
      }
      if (implementation.kind !== 'completed') return await this.mapImplementationFailure(active, implementation);
      let report;
      try {
        report = validateImplementationReport(implementation.report);
      } catch {
        if (active.record.reportRepairs >= 1) {
          return await this.terminal(active, { status: 'internal-error', code: 'implementation-report-malformed' });
        }
        const repairBaseline = await this.dependencies.git.snapshot(worktreePath);
        if (isAdoptableAttempt(active.record.activeAttempt)) {
          active = await this.adoptAttempt(active, sha256(canonicalJson(implementation.report)), { reportRepairs: 1 });
          active = await this.clearAttempt(active);
        } else {
          active = await this.persist(active, { reportRepairs: 1 });
        }
        const repairBlock = await this.revalidateFeedbackWorker(active, config, input.issueNumber);
        if (repairBlock) return repairBlock;
        active = await this.prepareAttempt(active, 'implementation', `${active.record.cycle}:report-repair`);
        implementation = await this.runImplementation({
          operation: 'implementation',
          attemptId: active.record.activeAttempt!.attemptId,
          runId,
          worktreePath,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          deliveryAuthority: active.record.deliveryAuthority!,
          cycle: active.record.cycle,
          reworkFindings: ['The previous implementation report did not match the generated schema.'],
          repairOnly: true,
          workflowGeneration: active.record.workflowGeneration,
          ...implementationLaunch,
        });
        if (implementationPreparationFailure) return implementationPreparationFailure;
        if (implementation.kind !== 'safe-halt') active = await this.observeReturnedAttempt(
          active, implementation.kind === 'completed' ? implementation.report : implementation,
        );
        if (implementation.kind === 'safe-halt') {
          active = await this.persist(active, { lifecycle: 'safe-halt' });
          while (true) {
            try { await implementation.waitForAbsence(); break; }
            catch { await new Promise((resolveWait) => setTimeout(resolveWait, 25)); }
          }
          return await this.terminal(active, { status: 'transport-failed', resumable: false }, 'process-quiescence-delayed');
        }
        if (implementation.kind !== 'completed') return await this.mapImplementationFailure(active, implementation);
        const afterRepair = await this.dependencies.git.snapshot(worktreePath);
        if (!sameFreshness(repairBaseline, afterRepair)) {
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'report-repair-modified-worktree');
        }
        try { report = validateImplementationReport(implementation.report); }
        catch { return await this.terminal(active, { status: 'internal-error', code: 'implementation-report-malformed' }); }
      }
      if (report.status === 'external-block') {
        return await this.terminal(active, { status: 'blocked', kind: 'external', resumable: true });
      }
      if (await this.dependencies.git.getHead(worktreePath) !== expectedImplementationHead(active.record)) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }
      const changedFiles = await this.dependencies.git.listChangedFiles(worktreePath);
      if (changedFiles.length === 0 || !sameStrings(changedFiles, report.changedFiles)) {
        if (changedFiles.length === 0 || active.record.reportRepairs >= 1) {
          return await this.terminal(active, { status: 'internal-error', code: 'implementation-change-set-invalid' });
        }
        const repairBaseline = await this.dependencies.git.snapshot(worktreePath);
        if (isAdoptableAttempt(active.record.activeAttempt)) {
          active = await this.adoptAttempt(active, sha256(canonicalJson(implementation.report)), { reportRepairs: 1 });
          active = await this.clearAttempt(active);
        } else {
          active = await this.persist(active, { reportRepairs: 1 });
        }
        const repairBlock = await this.revalidateFeedbackWorker(active, config, input.issueNumber);
        if (repairBlock) return repairBlock;
        active = await this.prepareAttempt(active, 'implementation', `${active.record.cycle}:changed-files-repair`);
        implementation = await this.runImplementation({
          operation: 'implementation',
          attemptId: active.record.activeAttempt!.attemptId,
          runId,
          worktreePath,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          deliveryAuthority: active.record.deliveryAuthority!,
          cycle: active.record.cycle,
          reworkFindings: [`The report changedFiles must equal the complete current product change set: ${canonicalJson(changedFiles)}.`],
          repairOnly: true,
          workflowGeneration: active.record.workflowGeneration,
          ...implementationLaunch,
        });
        if (implementationPreparationFailure) return implementationPreparationFailure;
        if (implementation.kind !== 'safe-halt') active = await this.observeReturnedAttempt(
          active, implementation.kind === 'completed' ? implementation.report : implementation,
        );
        if (implementation.kind === 'safe-halt') {
          active = await this.persist(active, { lifecycle: 'safe-halt' });
          while (true) {
            try { await implementation.waitForAbsence(); break; }
            catch { await new Promise((resolveWait) => setTimeout(resolveWait, 25)); }
          }
          return await this.terminal(active, { status: 'transport-failed', resumable: false }, 'process-quiescence-delayed');
        }
        if (implementation.kind !== 'completed') return await this.mapImplementationFailure(active, implementation);
        const afterRepair = await this.dependencies.git.snapshot(worktreePath);
        if (!sameFreshness(repairBaseline, afterRepair)) {
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'report-repair-modified-worktree');
        }
        try { report = validateImplementationReport(implementation.report); }
        catch { return await this.terminal(active, { status: 'internal-error', code: 'implementation-report-malformed' }); }
        if (report.status === 'external-block') {
          return await this.terminal(active, { status: 'blocked', kind: 'external', resumable: true });
        }
        if (!sameStrings(changedFiles, report.changedFiles)) {
          return await this.terminal(active, { status: 'internal-error', code: 'implementation-change-set-invalid' });
        }
      }

      if (isAdoptableAttempt(active.record.activeAttempt)) {
        active = await this.adoptAttempt(active, sha256(canonicalJson(report)), {
          transportRetries: active.record.transportRetries,
          reportRepairs: active.record.reportRepairs,
        });
        active = await this.clearAttempt(active);
      }

      if (active.record.routeReceipt?.route === 'direct' || active.record.routeReceipt?.route === 'spec-required') {
        const boundary = active.record.reviewFeedback?.activeBatch
          ? {
            kind: 'review-feedback' as const,
            batchId: active.record.reviewFeedback.activeBatch.batchId,
            repairRound: active.record.reviewFeedback.repairRound as 1 | 2 | 3,
            authoritySha256: active.record.deliveryAuthority!.authoritySha256,
          }
          : { kind: 'implementation-cycle' as const, cycle: active.record.cycle, authoritySha256: active.record.deliveryAuthority!.authoritySha256 };
        const captured = await this.ensureCandidateBinding(active, config, boundary);
        if ('status' in captured) return captured;
        active = captured.active;
        const binding = active.record.candidateBinding!;
        if (!sameStrings(binding.canonicalChangedFiles, report.changedFiles)) {
          const released = await this.clearAndReleaseCandidate(active);
          if ('status' in released) return released;
          return this.terminal(released.active, { status: 'internal-error', code: 'implementation-change-set-invalid' });
        }
        const targetFingerprint = directReviewCandidateTargetFingerprint({
          binding,
          routeDecisionSha256: active.record.deliveryAuthority!.authoritySha256,
          workflowGenerationHash: active.record.workflowGeneration.generationHash,
          cycle: active.record.cycle,
          frozenCriteria,
        });
        if (active.record.directReview?.stage === 'review-repair') {
          const reviewerSessionId = this.dependencies.createReviewSessionId();
          assertNonEmptyString(reviewerSessionId, 'reviewerSessionId');
          active = await this.persist(active, {
            directReview: prepareDirectReview(active.record.directReview, targetFingerprint, reviewerSessionId),
          });
        } else {
          const reviewerSessionId = this.dependencies.createReviewSessionId();
          assertNonEmptyString(reviewerSessionId, 'reviewerSessionId');
          active = await this.persist(active, {
            directReview: createInitialDirectReview({
              targetFingerprint,
              codeReviewerSessionId: reviewerSessionId,
            }),
          });
        }
        const reviewed = await this.runDirectReviewFull(
          active,
          publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          implementation.attemptId ?? `implementation-cycle-${active.record.cycle}`,
          config.runner.maxCycles,
          config,
        );
        if ('status' in reviewed) return reviewed;
        active = reviewed;
        if (active.record.lifecycle === 'implementing') continue attemptLoop;
      } else {
        active = await this.persist(active, {
          lifecycle: 'checking',
        });
      }
      }
      let checkPolicy;
      try { checkPolicy = resolveIssueCheckPolicy(active.record.issueSnapshot.body, config.checks); }
      catch (error) {
        return await this.invokedFailure(active, 'issue-verification-invalid', error instanceof Error ? error.message : undefined);
      }
      const configuredChecks = Object.entries(checkPolicy.checks);
      const finalCheckPolicySha256 = sha256(canonicalJson(checkPolicy.checks));
      const finalBinding = active.record.candidateBinding;
      if (!finalBinding) return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-git-v2-required');
      const reusableChecks = active.record.checks.filter((check) =>
        check.status === 'passed'
        && 'bindingId' in check
        && check.bindingId === finalBinding.bindingId
        && check.candidateTreeSha === finalBinding.candidateTreeSha
        && check.checkPolicySha256 === finalCheckPolicySha256
        && configuredChecks.some(([id, command]) => check.id === id && check.command === command));
      if (reusableChecks.length !== active.record.checks.length) {
        active = await this.persist(active, {
          checks: reusableChecks,
          checkedChangeSha256: undefined,
          proofId: undefined,
          proofReceipt: undefined,
        });
      }
      for (const [id, command] of configuredChecks) {
        if (active.record.checks.some((check) => check.id === id
          && check.command === command
          && check.status === 'passed'
          && 'bindingId' in check
          && check.bindingId === finalBinding.bindingId
          && check.candidateTreeSha === finalBinding.candidateTreeSha
          && check.checkPolicySha256 === finalCheckPolicySha256)) continue;
        if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
        if (this.dependencies.checks.supportsLaunchOwnership !== true) {
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-check-launch-ownership-required');
        }
        const execution = await this.prepareCandidateMaterialization(active, config, 'final-check', `${id}:${finalCheckPolicySha256}`);
        if ('status' in execution) return execution;
        active = execution.active;
        const materialization = execution.materialization;
        const checked = await this.executeOrRecoverConfiguredCheck(active, {
          id, command, source: checkPolicy.source, cwd: materialization.path, phase: 'changed',
        });
        if ('status' in checked) return checked;
        active = checked.active;
        const check = checked.check;
        if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
        if (check.observation.group !== 'absent') {
          return await this.invokedFailure(
            active,
            'check-process-quiescence-unconfirmed',
            'The configured check leader exited but its process group is still live or cannot be proven absent.',
          );
        }
        const row = {
          id, command, status: check.status, outputSha256: check.outputSha256,
          bindingId: finalBinding.bindingId,
          candidateTreeSha: finalBinding.candidateTreeSha,
          checkPolicySha256: finalCheckPolicySha256,
        } as const;
        active = await this.adoptAttempt(active, check.attemptResultSha256, { checks: [...active.record.checks, row] });
        const settledExecution = await this.settleCandidateMaterialization(active, config);
        if ('status' in settledExecution) return settledExecution;
        active = settledExecution.active;
        if (check.status === 'failed') {
          if (this.repairBudgetExhausted(active, config.runner.maxCycles)) {
            const released = await this.clearAndReleaseCandidate(active);
            if ('status' in released) return released;
            active = released.active;
            return active.record.reviewFeedback?.activeBatch
              ? await this.blockReviewFeedback(active, 'exhausted', 'review-feedback-check-repair-exhausted')
              : await this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true });
          }
          const summary = `Check ${id} failed:\n${check.output.toString('utf8').slice(0, 8 * 1024)}`;
          const reopened = await this.startNextCycleFromCandidate(active, [summary], [{
            provenance: 'check', sourceId: `check:${id}:${row.outputSha256}`, summary,
            affectedContracts: ['configured-checks'],
          }]);
          if ('status' in reopened) return reopened;
          active = reopened;
          continue attemptLoop;
        }
      }

      if (!sameCheckPolicy(active.record.checks, checkPolicy.checks)) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'configured-check-policy-drift');
      }
      const proofBinding = active.record.candidateBinding;
      if (!proofBinding || active.record.checks.some((check) => !('bindingId' in check)
        || check.bindingId !== proofBinding.bindingId || check.candidateTreeSha !== proofBinding.candidateTreeSha
        || check.checkPolicySha256 !== finalCheckPolicySha256)) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'checked-change-candidate-binding-drift');
      }
      const payload: CheckedChangePayloadV2 = {
        version: 2,
        canonicalRepository,
        runId,
        issueNumber: input.issueNumber,
        cycle: active.record.cycle,
        baseSha: expectedImplementationHead(active.record),
        deliveryAuthoritySha256: active.record.deliveryAuthority!.authoritySha256,
        binding: structuredClone(proofBinding),
        changedFiles: [...proofBinding.canonicalChangedFiles],
        checks: active.record.checks.map((check) => ({ ...check, status: 'passed' as const })) as CheckedChangePayloadV2['checks'],
        checkPolicySha256: finalCheckPolicySha256,
        packageVersion: active.record.packageVersion,
        proofSchemaVersion: 1,
      };
      const checkedChange = this.dependencies.checkedChangeMint.mint(payload);
      const checkedChangeSha256 = checkedChangePayloadSha256(payload);
      if (active.record.checkedChangeSha256 && active.record.checkedChangeSha256 !== checkedChangeSha256) {
        return await this.persistCandidateEvidenceSafetyTerminal(active, 'checked-change-recovery-binding-drift');
      }
      const proofId = active.record.proofId ?? this.dependencies.createProofId();
      assertNonEmptyString(proofId, 'proofId');
      const proofExecutionState = active.record.proofExecution ?? {
        startedAt: this.timestamp(), transportRetryCount: 0 as const, reportRepairCount: 0 as const, reportRepairFindings: [],
      };
      active = await this.persist(active, { lifecycle: 'proving', checkedChangeSha256, proofId, proofExecution: proofExecutionState });
      if (active.record.activeAttempt?.operationId === 'acceptance-proof'
        && active.record.activeAttempt.stage === 'observed' && !active.record.activeAttempt.result) {
        active = await this.clearAttempt(active);
      }
      const retainedProofMaterialization = active.record.candidateMaterialization;
      if (retainedProofMaterialization && !active.record.activeAttempt) {
        active = await this.prepareAttempt(active, 'acceptance-proof', proofId);
      }
      const preparedProofMaterialization = retainedProofMaterialization
        ? { active, materialization: retainedProofMaterialization }
        : await this.prepareCandidateMaterialization(active, config, 'acceptance-proof', proofId);
      if ('status' in preparedProofMaterialization) return preparedProofMaterialization;
      active = preparedProofMaterialization.active;
      const proofMaterialization = preparedProofMaterialization.materialization;
      const proofAttempt = active.record.activeAttempt;
      if (!proofAttempt) return this.persistCandidateEvidenceSafetyTerminal(active, 'proof-active-attempt-missing');

      let proof: ProveChangeResult;
      let proofLaunchFailure: RunIssueResult | undefined;
      try {
        proof = await this.dependencies.proof.proveChange({
          proofId,
          attemptId: proofAttempt.attemptId,
          recoverOnly: proofAttempt.stage !== 'prepared',
          proofStartedAt: proofExecutionState.startedAt,
          transportRetryCount: proofExecutionState.transportRetryCount,
          reportRepairCount: proofExecutionState.reportRepairCount,
          reportRepairFindings: proofExecutionState.reportRepairFindings,
          passedReceipt: active.record.proofReceipt,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          checkedChange,
          materialization: proofMaterialization,
          workflowGeneration: structuredClone(active.record.workflowGeneration),
          onLaunched: async ({ pid, processGroupId, launchedAt }) => {
            const failure = await this.revalidateFeedbackWorker(active!, config, input.issueNumber);
            if (failure) {
              proofLaunchFailure = failure;
              throw new Error('proof launch authorization changed');
            }
            active = await this.launchAttempt(active!, pid, processGroupId);
          },
          beforeAgentLaunch: async () => {
            const failure = await this.revalidateFeedbackWorker(active!, config, input.issueNumber);
            if (failure) throw new ProofLaunchAuthorizationError(failure);
          },
        });
      } catch (error) {
        if (proofLaunchFailure) return proofLaunchFailure;
        if (error instanceof ProofLaunchAuthorizationError) return error.outcome as RunIssueResult;
        if (error instanceof CandidateProofInspectionError) {
          return error.code === 'candidate-artifact-conflict'
            ? this.persistCandidateEvidenceSafetyTerminal(active, error.code)
            : this.mapCandidateFailure(active, error.code);
        }
        return await this.terminal(active, { status: 'internal-error', code: 'acceptance-proof-internal-failure' });
      }
      if (proofLaunchFailure) return proofLaunchFailure;
      if (active.record.activeAttempt?.stage === 'launched') {
        active = await this.adoptAttempt(active, sha256(canonicalJson(proof)), proof.status === 'passed' ? { proofReceipt: proof.receipt } : {});
      }
      const settledProofMaterialization = await this.settleCandidateMaterialization(active, config);
      if ('status' in settledProofMaterialization) return settledProofMaterialization;
      active = settledProofMaterialization.active;
      if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
      if (proof.status === 'needs-rework') {
        if (this.repairBudgetExhausted(active, config.runner.maxCycles)) {
          const released = await this.clearAndReleaseCandidate(active);
          if ('status' in released) return released;
          active = released.active;
          return active.record.reviewFeedback?.activeBatch
            ? await this.blockReviewFeedback(active, 'exhausted', 'review-feedback-proof-repair-exhausted')
            : await this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true });
        }
        const reopened = await this.startNextCycleFromCandidate(active, proof.findings, proof.findings.map((summary) => ({
          provenance: 'proof' as const,
          sourceId: `proof:${proofId}:${sha256(summary)}`,
          summary,
          affectedContracts: ['acceptance-proof'],
        })));
        if ('status' in reopened) return reopened;
        active = reopened;
        continue attemptLoop;
      }
      if (proof.status !== 'passed') return await this.mapProofFailure(active, proof);
      active = await this.persist(active, {
        lifecycle: 'publishing',
        proofReceipt: proof.receipt,
        reworkFindings: [],
        ...(active.record.reviewFeedback?.activeBatch ? {
          reviewFeedback: markReviewFeedbackVerified(active.record.reviewFeedback, {
            checkedChangeSha256,
            proofId,
            verifiedAt: this.timestamp(),
          }),
        } : {}),
      });
      break;
      }

      return active.record.reviewFeedback?.activeBatch
        ? await this.updateExistingPullRequest(active, config, input.issueNumber)
        : await this.publish(active, config, issueSnapshot, input.issueNumber);
    } catch (error) {
      if (!active && error instanceof TransportReadError) {
        return await this.preClaimTransport(input.issueNumber);
      }
      if (!active && error instanceof WorkflowGenerationUnrecoverableError) {
        return await this.preClaimInternal('workflow-generation-unrecoverable', input.issueNumber);
      }
      if (active && error instanceof PostEffectStateError) {
        return await this.invokedFailure(error.active, 'post-effect-state-write-failed');
      }
      if (active && error instanceof TransportReadError) {
        return await this.invokedFailure(active, 'authorization-read-failed');
      }
      if (error instanceof LaunchAuthorizationRevokedError) {
        return await this.revoked(error.active);
      }
      if (active && error instanceof RouteInitializationUnrecoverableError) {
        const evidence = await this.dependencies.writeEvidence({
          runId: active.record.runId,
          code: 'route-initialization-unrecoverable',
          summary: 'The claimed run cannot be safely initialized without product-state ambiguity.',
        });
        return { status: 'blocked', kind: 'safety', resumable: false, evidencePath: evidence.path };
      }
      if (active) {
        try {
          return await this.terminal(active, { status: 'internal-error', code: 'state-write-failed' });
        } catch {
          const evidence = await this.dependencies.writeEvidence({
            runId: active.record.runId,
            code: 'state-write-failed',
            summary: error instanceof Error ? error.message : 'Run state failed.',
          });
          return { status: 'internal-error', evidencePath: evidence.path };
        }
      }
      return await this.preClaimInternal('state-write-failed', input.issueNumber);
    } finally {
      if (owner) {
        try {
          await owner.release();
        } catch {
          const evidence = await this.dependencies.writeEvidence({
            runId: active?.record.runId ?? `issue-${input.issueNumber}`,
            code: 'owner-lock-release-failed',
            summary: 'Owner lock release failed.',
          });
          return { status: 'internal-error', evidencePath: evidence.path };
        }
      }
    }
  }

  async initializeClaimedRun(active: ActiveRun, issue?: RunIssueSnapshot): Promise<ActiveRun> {
    if (active.record.lifecycle !== 'claimed'
      || active.record.activeAttempt
      || active.record.pendingEffect
      || active.record.routeExecution
      || active.record.routeReceipt) {
      throw new RouteInitializationUnrecoverableError();
    }
    const [snapshot, changedFiles] = await Promise.all([
      this.dependencies.git.snapshot(active.record.worktreePath),
      this.dependencies.git.listChangedFiles(active.record.worktreePath),
    ]);
    if (snapshot.headSha !== active.record.baseSha || changedFiles.length !== 0) {
      throw new RouteInitializationUnrecoverableError();
    }
    try {
      await this.dependencies.verifyWorkflowGeneration(active.record.workflowGeneration);
    } catch {
      throw new RouteInitializationUnrecoverableError();
    }
    const issueSnapshot = issue?.state === 'OPEN'
      ? refreshClaimedIssueSnapshot(active.record.issueSnapshot, issue)
      : active.record.issueSnapshot;
    return this.persist(active, { lifecycle: 'triaging', routeExecution: initialRouteExecution(), issueSnapshot });
  }

  private async routeRun(
    starting: ActiveRun,
    issue: RunRecord['issueSnapshot'],
    frozenCriteria: FrozenCriterion[],
    worktreePath: string,
    config: AgentAutoConfig,
    issueNumber: number,
    branchName: string,
  ): Promise<{ active: ActiveRun } | { result: RunIssueResult }> {
    let active = starting;
    while (active.record.lifecycle === 'triaging') {
      let currentIssue: RunIssueSnapshot | undefined;
      try {
        currentIssue = await this.readIssue(active.record.issueNumber);
      } catch (error) {
        if (error instanceof TransportReadError) {
          return { result: await this.invokedFailure(active, 'authorization-read-failed') };
        }
        throw error;
      }
      if (!currentIssue || !this.isAuthorizedIssue(currentIssue, active.record, config)) {
        return { result: await this.revoked(active) };
      }
      active = await this.persist(active, {
        issueSnapshot: refreshClaimedIssueSnapshot(active.record.issueSnapshot, currentIssue),
      });
      issue = structuredClone(active.record.issueSnapshot);
      const state: RouteCoordinatorState = {
        read: async () => requireRouteExecution(active.record.routeExecution),
        compareAndSwap: async (expected, next) => {
          if (!sameRouteExecution(active.record.routeExecution, expected)) return false;
          active = await this.persist(active, { routeExecution: structuredClone(next) });
          return true;
        },
        prepareAttempt: async (operationId, sourceId) => {
          active = await this.prepareAttempt(active, operationId, sourceId);
          return active.record.activeAttempt!.attemptId;
        },
        launchAttempt: async (attemptId, pid, processGroupId) => {
          if (active.record.activeAttempt?.attemptId !== attemptId) throw new Error('route active attempt mismatch');
          active = await this.launchAttempt(active, pid, processGroupId);
        },
        adopt: async (expected, next, resultSha256) => {
          if (!sameRouteExecution(active.record.routeExecution, expected)) return false;
          active = isAdoptableAttempt(active.record.activeAttempt)
            ? await this.adoptAttempt(active, resultSha256, { routeExecution: structuredClone(next) })
            : await this.persist(active, { routeExecution: structuredClone(next) });
          return true;
        },
        clearAttempt: async () => {
          active = await this.clearAttempt(active);
        },
        complete: async (expected, next, receipt, resultSha256) => {
          if (!sameRouteExecution(active.record.routeExecution, expected)) return false;
          const changes = {
            lifecycle: 'routed' as const,
            routeExecution: structuredClone(next),
            routeReceipt: structuredClone(receipt),
          };
          active = isAdoptableAttempt(active.record.activeAttempt)
            ? await this.adoptAttempt(active, resultSha256, changes)
            : await this.persist(active, changes);
          return true;
        },
        cancel: async (expected) => {
          return sameRouteExecution(active.record.routeExecution, expected);
        },
      };
      const result = await this.dependencies.routeCoordinator.run({
        state,
        runId: active.record.runId,
        worktreePath,
        workflowGeneration: structuredClone(active.record.workflowGeneration),
        promptFacts: [
          `issue=${canonicalJson(issue)}`,
          `frozenCriteria=${canonicalJson(frozenCriteria)}`,
          `canonicalRepository=${active.record.canonicalRepository}`,
          `baseSha=${active.record.baseSha}`,
        ],
        signal: this.signal,
      });
      if (result.status === 'repairable' || result.status === 'retryable') continue;
      if (result.status === 'safe-halt') {
        active = await this.persist(active, {
          lifecycle: 'safe-halt',
        });
        while (true) {
          try {
            await result.waitForAbsence();
            break;
          } catch {
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
        }
        const after = await this.dependencies.git.snapshot(worktreePath);
        if (!sameFreshness(result.process.baseline, after)) {
          return { result: await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'report-operation-worktree-mutated') };
        }
        return { result: await this.terminal(active, { status: 'transport-failed', resumable: false }, 'process-quiescence-delayed') };
      }
      if (result.status === 'cancelled') {
        return { result: await this.terminal(active, { status: 'cancelled' }) };
      }
      if (result.status === 'blocked') {
        return { result: await this.terminal(active, {
          status: 'blocked',
          kind: result.kind,
          resumable: result.kind !== 'exhausted',
        }, result.code) };
      }
      if ((active.record.lifecycle as string) !== 'routed' || !active.record.routeReceipt) {
        return { result: await this.terminal(active, { status: 'internal-error', code: 'route-completion-not-persisted' }) };
      }
    }

    if (active.record.lifecycle !== 'routed' || !active.record.routeReceipt) {
      return { result: await this.terminal(active, { status: 'internal-error', code: 'route-state-not-dispatchable' }) };
    }
    try {
      if (!await this.authorized(active, config)) {
        return { result: await this.revoked(active) };
      }
    } catch (error) {
      if (error instanceof TransportReadError) return { result: await this.invokedFailure(active, 'authorization-read-failed') };
      throw error;
    }
    const receipt = structuredClone(active.record.routeReceipt);
    const lifecycle = downstreamLifecycleForRoute(receipt, active.record.workflowGeneration.generationHash);
    validateRouteTransition({
      lifecycle: 'routed',
      routeExecution: active.record.routeExecution,
      routeReceipt: receipt,
      generationHash: active.record.workflowGeneration.generationHash,
    }, {
      lifecycle,
      routeExecution: active.record.routeExecution,
      routeReceipt: receipt,
      generationHash: active.record.workflowGeneration.generationHash,
    });
    active = await this.persist(active, {
      lifecycle,
      ...(receipt.route === 'direct' ? { deliveryAuthority: createDirectDeliveryAuthority(receipt) } : {}),
    });
    try {
      if (!await this.authorized(active, config)) {
        return { result: await this.revoked(active) };
      }
    } catch (error) {
      if (error instanceof TransportReadError) return { result: await this.invokedFailure(active, 'authorization-read-failed') };
      throw error;
    }
    const context = {
      runId: active.record.runId,
      issue: structuredClone(active.record.issueSnapshot),
      frozenCriteria: structuredClone(active.record.frozenCriteria),
      worktreePath,
      workflowGeneration: structuredClone(active.record.workflowGeneration),
      receipt,
    };
    const continuation = receipt.route === 'direct'
      ? await this.dependencies.routeContinuations.direct(context)
      : await this.dependencies.routeContinuations.specRequired(context, this.specState(() => active, (next) => { active = next; }), this.signal);
    if (continuation.status === 'cancelled') return { result: await this.terminal(active, { status: 'cancelled' }) };
    if (continuation.status === 'blocked') {
      return { result: await this.terminal(active, {
        status: 'blocked', kind: continuation.kind, resumable: continuation.kind !== 'exhausted',
      }, continuation.code) };
    }
    if (continuation.status === 'retryable') {
      return { result: await this.terminal(active, { status: 'transport-failed', resumable: true }, continuation.code) };
    }
    if (receipt.route !== 'direct') {
      const specContinuation = continuation as SpecCoordinatorResult;
      if (specContinuation.status === 'decision-required') {
        return { result: specContinuation.evidencePath
          ? frozenQuestionProjection(specContinuation.receipt, specContinuation.evidencePath)
          : await this.specQuestionResult(active, specContinuation.receipt) };
      }
      if (specContinuation.status !== 'completed') return { result: await this.terminal(active, { status: 'internal-error', code: 'spec-freeze-receipt-missing' }) };
      const frozen = active.record.specDelivery?.frozen;
      if (!frozen) return { result: await this.terminal(active, { status: 'internal-error', code: 'spec-freeze-receipt-missing' }) };
      const answerTrust = await this.revalidateSpecAnswers(active);
      if (answerTrust.status === 'frozen') return { result: frozenQuestionProjection(answerTrust.question, answerTrust.evidencePath) };
      return { active: await this.persist(active, {
        lifecycle: 'implementing', deliveryAuthority: createSpecDeliveryAuthority(receipt, active.record.specDelivery!),
      }) };
    }
    return { active };
  }

  private async specQuestionResult(active: ActiveRun, receipt: FrozenSpecQuestionReceiptV1): Promise<RunIssueResult> {
    const body = specQuestionBody(receipt);
    const expected = { kind: 'spec-question-comment' as const, issueNumber: active.record.issueNumber, marker: receipt.marker, bodySha256: sha256(body) };
    if (!active.record.pendingEffect) {
      const existing = await this.readIssue(active.record.issueNumber);
      const existingMatches = existing ? commentsWithMarker(existing, receipt.marker) : [];
      const stored = active.record.specDelivery?.questionResult;
      if (existingMatches.length === 1 && sha256(existingMatches[0]!.body) === expected.bodySha256
        && stored?.questionSha256 === receipt.questionSha256) {
        return frozenQuestionProjection(receipt, stored.evidencePath);
      }
    }
    if (!active.record.pendingEffect) active = await this.persist(active, { pendingEffect: expected });
    if (canonicalJson(active.record.pendingEffect) !== canonicalJson(createPendingEffect(expected))) {
      return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'spec-question-effect-diverged');
    }
    let issue = await this.readIssue(active.record.issueNumber);
    let matches = issue ? commentsWithMarker(issue, receipt.marker) : [];
    if (matches.length > 1 || matches.some((comment) => sha256(comment.body) !== expected.bodySha256)) {
      return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'spec-question-comment-conflict');
    }
    if (matches.length === 0) {
      try { await this.dependencies.issues.postComment(active.record.issueNumber, body); }
      catch { return this.invokedFailure(active, 'spec-question-comment-unknown'); }
      issue = await this.readIssue(active.record.issueNumber);
      matches = issue ? commentsWithMarker(issue, receipt.marker) : [];
    }
    if (matches.length !== 1 || sha256(matches[0]!.body) !== expected.bodySha256) return this.invokedFailure(active, 'spec-question-comment-unobserved');
    active = await this.confirmEffect(active);
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code: 'spec-frozen', summary: receipt.questionSha256 });
    active = await this.persist(active, {
      specDelivery: {
        ...active.record.specDelivery!,
        questionResult: { questionSha256: receipt.questionSha256, evidenceId: evidence.id, evidencePath: evidence.path },
      },
    });
    return frozenQuestionProjection(receipt, evidence.path);
  }

  private async createInitialWorktreeEffect(active: ActiveRun, targetRoot: string): Promise<{ active: ActiveRun } | RunIssueResult> {
    const expected = {
      kind: 'worktree-create' as const, worktreePath: active.record.worktreePath, branchName: active.record.branchName,
      baseBranch: active.config.github.baseBranch, baseSha: active.record.baseSha,
    };
    if (!active.record.pendingEffect) active = await this.persist(active, { pendingEffect: expected });
    const effect = active.record.pendingEffect;
    if (!effect || effect.kind !== expected.kind || canonicalJson(effect) !== canonicalJson(createPendingEffect(expected))) {
      return this.invokedFailure(active, 'worktree-create-pending-effect-diverged');
    }
    let observed;
    try { observed = await this.dependencies.git.inspectWorktree({ worktreePath: effect.worktreePath, branchName: effect.branchName, baseSha: effect.baseSha }); }
    catch (error) { return this.invokedFailure(active, 'local-git-worktree-inspection-failed', claimedWorktreeInspectionFailureSummary(error)); }
    if (observed === 'diverged') return this.invokedFailure(active, 'local-git-worktree-diverged', 'The claimed worktree path does not match the persisted worktree effect.');
    if (observed === 'absent') {
      try { await this.dependencies.git.createWorktree({ targetRoot, ...effect }); }
      catch (error) { return this.invokedFailure(active, 'local-git-worktree-creation-failed', worktreeCreationFailureSummary(error)); }
      try { observed = await this.dependencies.git.inspectWorktree({ worktreePath: effect.worktreePath, branchName: effect.branchName, baseSha: effect.baseSha }); }
      catch (error) { return this.invokedFailure(active, 'local-git-worktree-inspection-failed', claimedWorktreeInspectionFailureSummary(error)); }
    }
    if (observed !== 'matching') return this.invokedFailure(active, 'local-git-worktree-observation-failed');
    return { active: await this.confirmEffect(active) };
  }

  private async createContinuationWorktreeEffect(
    active: ActiveRun,
    targetRoot: string,
    expectedHeadSha: string,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const expected = {
      kind: 'continuation-worktree-create' as const, worktreePath: active.record.worktreePath,
      branchName: active.record.branchName, baseBranch: active.config.github.baseBranch, publishedHeadSha: expectedHeadSha,
    };
    if (!active.record.pendingEffect) active = await this.persist(active, { pendingEffect: expected });
    const effect = active.record.pendingEffect;
    if (!effect || effect.kind !== expected.kind || canonicalJson(effect) !== canonicalJson(createPendingEffect(expected))) {
      return this.invokedFailure(active, 'continuation-worktree-create-pending-effect-diverged');
    }
    let observed = await this.dependencies.git.inspectWorktree({
      worktreePath: effect.worktreePath, branchName: effect.branchName, baseSha: effect.publishedHeadSha,
    });
    if (observed === 'absent') {
      if (!this.dependencies.git.ensureContinuationWorktree) return this.invokedFailure(active, 'continuation-worktree-create-unavailable');
      try { await this.dependencies.git.ensureContinuationWorktree({ targetRoot, ...effect }); }
      catch { return this.invokedFailure(active, 'continuation-worktree-create-unknown'); }
      observed = await this.dependencies.git.inspectWorktree({
        worktreePath: effect.worktreePath, branchName: effect.branchName, baseSha: effect.publishedHeadSha,
      });
    }
    const remoteSha = observed === 'matching'
      ? await this.dependencies.git.getRemoteBranchSha(effect.worktreePath, effect.branchName) : undefined;
    if (observed !== 'matching' || remoteSha !== effect.publishedHeadSha) {
      return this.invokedFailure(active, 'review-feedback-worktree-diverged');
    }
    return { active: await this.confirmEffect(active) };
  }

  private specState(readActive: () => ActiveRun, writeActive: (active: ActiveRun) => void): SpecDeliveryState {
    return {
      read: async () => structuredClone(readActive().record.specDelivery),
      compareAndSwap: async (expected, next) => {
        const active = readActive();
        const observed = active.record.specDelivery;
        if (observed === undefined || expected === undefined) {
          if (observed !== expected) return false;
        } else if (canonicalJson(observed) !== canonicalJson(expected)) return false;
        const saved = await this.persist(active, { specDelivery: structuredClone(next) });
        writeActive(saved);
        return true;
      },
      prepareAttempt: async (operationId, sourceId) => {
        const saved = await this.prepareAttempt(readActive(), operationId, sourceId);
        writeActive(saved);
        const attempt = saved.record.activeAttempt!;
        return { attemptId: attempt.attemptId, recoverOnly: attempt.stage === 'observed' && attempt.result !== null };
      },
      launchAttempt: async (attemptId, pid, processGroupId) => {
        const active = readActive();
        if (active.record.activeAttempt?.attemptId !== attemptId) throw new Error('spec active attempt mismatch');
        writeActive(await this.launchAttempt(active, pid, processGroupId));
      },
      adopt: async (expected, next, resultSha256) => {
        const active = readActive();
        if (canonicalJson(active.record.specDelivery) !== canonicalJson(expected)) return false;
        const saved = isAdoptableAttempt(active.record.activeAttempt)
          ? await this.adoptAttempt(active, resultSha256, { specDelivery: structuredClone(next) })
          : await this.persist(active, { specDelivery: structuredClone(next) });
        writeActive(saved);
        return true;
      },
      clearAttempt: async () => {
        const saved = await this.clearAttempt(readActive());
        writeActive(saved);
      },
      revalidateBeforeAttempt: async () => {
        const trust = await this.revalidateSpecAnswers(readActive());
        return trust.status === 'valid'
          ? trust
          : {
            status: 'frozen' as const, receipt: structuredClone(trust.question), evidencePath: trust.evidencePath,
          };
      },
    };
  }

  private async continueSpecRequired(active: ActiveRun): Promise<{ active: ActiveRun } | { result: RunIssueResult }> {
    if (!active.record.routeReceipt || active.record.routeReceipt.route !== 'spec-required') {
      return { result: await this.terminal(active, { status: 'internal-error', code: 'spec-route-missing' }) };
    }
    let current = active;
    if (current.record.specDelivery?.stage === 'question') {
      const accepted = await this.observeSpecAnswer(current);
      if ('result' in accepted) return accepted;
      current = accepted.active;
    }
    const context = {
      runId: current.record.runId, issue: structuredClone(current.record.issueSnapshot),
      frozenCriteria: structuredClone(current.record.frozenCriteria), worktreePath: current.record.worktreePath,
      workflowGeneration: structuredClone(current.record.workflowGeneration), receipt: structuredClone(current.record.routeReceipt!),
    };
    const result: SpecCoordinatorResult = await this.dependencies.routeContinuations.specRequired(
      context, this.specState(() => current, (next) => { current = next; }), this.signal,
    );
    if (result.status === 'completed') {
      const frozen = current.record.specDelivery?.frozen;
      if (!frozen) return { result: await this.terminal(current, { status: 'internal-error', code: 'spec-freeze-receipt-missing' }) };
      const answerTrust = await this.revalidateSpecAnswers(current);
      if (answerTrust.status === 'frozen') return { result: frozenQuestionProjection(answerTrust.question, answerTrust.evidencePath) };
      return { active: await this.persist(current, {
        lifecycle: 'implementing', deliveryAuthority: createSpecDeliveryAuthority(current.record.routeReceipt!, current.record.specDelivery!),
      }) };
    }
    if (result.status === 'decision-required') return { result: result.evidencePath
      ? frozenQuestionProjection(result.receipt, result.evidencePath)
      : await this.specQuestionResult(current, result.receipt) };
    if (result.status === 'cancelled') return { result: await this.terminal(current, { status: 'cancelled' }) };
    if (result.status === 'retryable') return { result: await this.terminal(current, { status: 'transport-failed', resumable: true }, result.code) };
    return { result: await this.terminal(current, { status: 'blocked', kind: result.kind, resumable: result.kind !== 'exhausted' }, result.code) };
  }

  private async observeSpecAnswer(active: ActiveRun): Promise<{ active: ActiveRun } | { result: RunIssueResult }> {
    const delivery = active.record.specDelivery!;
    const question = delivery.question!;
    const questionResult = delivery.questionResult;
    if (!questionResult) return { result: await this.terminal(active, { status: 'internal-error', code: 'spec-question-result-missing' }) };
    const issue = await this.readIssue(active.record.issueNumber);
    if (!issue) return { result: frozenQuestionProjection(question, questionResult.evidencePath) };
    const expectedQuestionBody = specQuestionBody(question);
    const markerMatches = commentsWithMarker(issue, question.marker);
    if (markerMatches.length !== 1 || markerMatches[0]!.body !== expectedQuestionBody) {
      return { result: frozenQuestionProjection(question, questionResult.evidencePath) };
    }
    const questionIndex = issue.comments.findIndex((comment) => comment.body === expectedQuestionBody);
    const candidates = questionIndex < 0 ? [] : issue.comments.slice(questionIndex + 1)
      .filter((comment) => comment.body.startsWith(question.answerPrefix));
    const trusted: Array<{
      comment: typeof candidates[number]; normalized: string;
      permission: { permission: 'write' | 'admin'; userId: string; checkedAt: string };
    }> = [];
    for (const comment of candidates) {
      if (!comment.id || !comment.author || !comment.authorId || !comment.createdAt || !comment.updatedAt || comment.createdAt !== comment.updatedAt) continue;
      const normalized = comment.body.slice(question.answerPrefix.length).trim().replace(/\s+/gu, ' ');
      if (!normalized || !this.dependencies.issues.getRepositoryPermission) continue;
      let permission;
      try { permission = await this.dependencies.issues.getRepositoryPermission(comment.author, comment.authorId); }
      catch { return { result: frozenQuestionProjection(question, questionResult.evidencePath) }; }
      if (!['write', 'admin'].includes(permission.permission) || permission.userId !== comment.authorId) continue;
      trusted.push({
        comment, normalized,
        permission: permission as { permission: 'write' | 'admin'; userId: string; checkedAt: string },
      });
    }
    trusted.sort((left, right) => compareStableId(left.comment.id!, right.comment.id!));
    if (trusted.length === 0) return { result: frozenQuestionProjection(question, questionResult.evidencePath) };
    const hashes = [...new Set(trusted.map((item) => sha256(item.normalized)))];
    const sources = trusted.map((item) => ({
      commentId: item.comment.id!, authorId: item.comment.authorId!, author: item.comment.author!,
      normalizedAnswer: item.normalized, normalizedSha256: sha256(item.normalized), permission: structuredClone(item.permission),
      commentCreatedAt: item.comment.createdAt!, commentUpdatedAt: item.comment.updatedAt!,
    }));
    const canonicalSource = sources[0]!;
    const answer: TrustedSpecAnswerV1 = {
      accepted: hashes.length === 1,
      question: structuredClone(question),
      frozenResult: { evidenceId: questionResult.evidenceId, evidencePath: questionResult.evidencePath },
      canonicalSource,
      duplicateCommentIds: sources.slice(1)
        .filter((source) => source.normalizedSha256 === canonicalSource.normalizedSha256)
        .map((source) => source.commentId),
      additionalSources: sources.slice(1),
    };
    return { active: await this.persist(active, { specDelivery: acceptTrustedSpecAnswer(delivery, answer) }) };
  }

  private async revalidateSpecAnswers(active: ActiveRun): Promise<
    { status: 'valid' } | { status: 'frozen'; question: FrozenSpecQuestionReceiptV1; evidencePath: string }
  > {
    const delivery = active.record.specDelivery;
    const answers = [
      ...(delivery?.acceptedAnswers ?? []),
      ...(delivery?.trustedAnswer ? [delivery.trustedAnswer] : []),
    ];
    if (answers.length === 0) return { status: 'valid' };
    const fallback = answers.at(-1)!;
    if (!this.dependencies.issues.getRepositoryPermission) {
      return { status: 'frozen', question: fallback.question, evidencePath: fallback.frozenResult.evidencePath };
    }
    let issue;
    try { issue = await this.readIssue(active.record.issueNumber); }
    catch { return { status: 'frozen', question: fallback.question, evidencePath: fallback.frozenResult.evidencePath }; }
    if (!issue) return { status: 'frozen', question: fallback.question, evidencePath: fallback.frozenResult.evidencePath };
    for (const answer of answers) {
      const questionMatches = commentsWithMarker(issue, answer.question.marker);
      if (questionMatches.length !== 1 || questionMatches[0]!.body !== specQuestionBody(answer.question)) {
        return { status: 'frozen', question: answer.question, evidencePath: answer.frozenResult.evidencePath };
      }
      for (const source of [answer.canonicalSource, ...answer.additionalSources]) {
        const comment = issue.comments.find((item) => item.id === source.commentId);
        if (!comment?.author || !comment.authorId || comment.author !== source.author || comment.authorId !== source.authorId
          || comment.createdAt !== source.commentCreatedAt || comment.updatedAt !== source.commentUpdatedAt
          || comment.createdAt !== comment.updatedAt || !comment.body.startsWith(answer.question.answerPrefix)
          || comment.body.slice(answer.question.answerPrefix.length).trim().replace(/\s+/gu, ' ') !== source.normalizedAnswer) {
          return { status: 'frozen', question: answer.question, evidencePath: answer.frozenResult.evidencePath };
        }
        try {
          const permission = await this.dependencies.issues.getRepositoryPermission(comment.author, comment.authorId);
          if (!['write', 'admin'].includes(permission.permission) || permission.userId !== comment.authorId) {
            return { status: 'frozen', question: answer.question, evidencePath: answer.frozenResult.evidencePath };
          }
        } catch {
          return { status: 'frozen', question: answer.question, evidencePath: answer.frozenResult.evidencePath };
        }
      }
    }
    return { status: 'valid' };
  }

  private async readStrictConfig(targetRoot: string): Promise<{ bytes: Buffer; config: AgentAutoConfig }> {
    const value = await this.dependencies.readConfig(targetRoot);
    return { bytes: Buffer.from(value.bytes), config: parseAgentAutoConfig(structuredClone(value.config)) };
  }

  private async ineligibilityReason(issue: RunIssueSnapshot | undefined, config: AgentAutoConfig): Promise<string | undefined> {
    if (!issue) return 'Issue does not exist.';
    const labels = new Set(issue.labels);
    if (issue.state !== 'OPEN') return 'Issue is not open.';
    if (!labels.has(config.github.labels.auto.name)) return 'Issue lacks the auto label.';
    if ([config.github.labels.running.name, config.github.labels.blocked.name, config.github.labels.review.name]
      .some((label) => labels.has(label))) {
      return 'Issue already has a terminal or running label.';
    }
    const branchName = `codex/issue-${issue.number}`;
    try {
      if (await this.dependencies.pullRequests.findOpen({ headBranch: branchName, baseBranch: config.github.baseBranch })) return 'An open pull request already exists.';
    } catch {
      throw new TransportReadError();
    }
    return undefined;
  }

  private async createRun(input: {
    runId: string;
    issueNumber: number;
    canonicalRepository: string;
    baseSha: string;
    branchName: string;
    worktreePath: string;
    issueSnapshot: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    config: AgentAutoConfig;
    pendingEffect: PendingEffectInput;
  }): Promise<ActiveRun> {
    const state = await this.dependencies.runRecords.read();
    const now = this.timestamp();
    const workflow = await this.dependencies.createWorkflowGeneration();
    const { config, ...persistedInput } = input;
    const record: RunRecord = {
      ...persistedInput,
      pendingEffect: createPendingEffect(persistedInput.pendingEffect),
      lifecycle: 'claimed', cycle: 1, reportRepairs: 0, transportRetries: 0,
      reworkFindings: [],
      packageVersion: workflow.receipt.packageVersion,
      workflowGeneration: structuredClone(workflow.receipt),
      skillHashes: structuredClone(workflow.skillHashes),
      checks: [], createdAt: now, updatedAt: now,
    };
    const saved = await this.dependencies.runRecords.compareAndSwap(state.generation, {
      schema: 'codex-orchestrator.run-state', runs: [...state.runs, record],
    });
    return { state: saved, record: findRun(saved, input.runId), config };
  }

  private async persist(
    active: ActiveRun,
    changes: Omit<Partial<RunRecord>, 'pendingEffect'> & { pendingEffect?: PendingEffect | PendingEffectInput | undefined },
  ): Promise<ActiveRun> {
    let normalized = changes;
    if (Object.hasOwn(changes, 'pendingEffect') && changes.pendingEffect) {
      const { effectId: _priorEffectId, ...payload } = changes.pendingEffect as PendingEffect;
      normalized = { ...changes, pendingEffect: createPendingEffect(payload as PendingEffectInput) };
    }
    const record = { ...active.record, ...normalized, updatedAt: this.timestamp() } as RunRecord;
    if (Object.hasOwn(changes, 'pendingEffect') && changes.pendingEffect === undefined) delete record.pendingEffect;
    for (const key of ['checkedChangeSha256', 'proofId', 'proofReceipt', 'terminalOutcome', 'outcomeEvidenceId', 'routeExecution', 'routeReceipt', 'reviewFeedback', 'changeBindingVersion', 'candidateBinding', 'candidateMaterialization', 'activeAttempt'] as const) {
      if (Object.hasOwn(changes, key) && changes[key] === undefined) delete record[key];
    }
    const runs = active.state.runs.map((candidate) => candidate.runId === record.runId ? record : candidate);
    const saved = await this.dependencies.runRecords.compareAndSwap(active.state.generation, {
      schema: 'codex-orchestrator.run-state', runs,
    });
    return { state: saved, record: findRun(saved, record.runId), config: active.config };
  }

  private clearEffect(active: ActiveRun): Promise<ActiveRun> {
    return this.persist(active, { pendingEffect: undefined });
  }

  private async confirmEffect(active: ActiveRun): Promise<ActiveRun> {
    try {
      return await this.clearEffect(active);
    } catch {
      throw new PostEffectStateError(active);
    }
  }

  private async authorized(active: ActiveRun, config: AgentAutoConfig): Promise<boolean> {
    const issue = await this.readIssue(active.record.issueNumber);
    return !!issue && this.isAuthorizedIssue(issue, active.record, config);
  }

  private isAuthorizedIssue(
    issue: RunIssueSnapshot,
    record: RunRecord,
    config: AgentAutoConfig,
  ): boolean {
    if (issue.state !== 'OPEN') return false;
    const labels = new Set(issue.labels);
    if (!labels.has(config.github.labels.auto.name)
      || labels.has(config.github.labels.blocked.name)
      || labels.has(config.github.labels.review.name)) return false;
    return this.hasTrustedClaim(issue, record);
  }

  private async authorizedForExactLabels(
    active: ActiveRun,
    expectedLabels: string[],
  ): Promise<boolean> {
    const issue = await this.readIssue(active.record.issueNumber);
    return !!issue && issue.state === 'OPEN' && sameStrings(issue.labels, expectedLabels)
      && this.hasTrustedClaim(issue, active.record);
  }

  private hasTrustedClaim(issue: RunIssueSnapshot, record: RunRecord): boolean {
    const exactBody = claimComment(record.runId, record.issueNumber, record.branchName);
    const markers = issue.comments.filter(isClaimMarkerComment);
    if (issue.comments.some((comment) => {
      const firstLine = comment.body.split('\n')[0] ?? '';
      return firstLine.startsWith(`<!-- codex-orchestrator:run:${record.runId}:claim`) && !isExactClaimMarkerLine(firstLine);
    })) return false;
    const currentMarkers = markers.filter((comment) => claimRunId(comment) === record.runId);
    if (currentMarkers.some((comment) => comment.body !== exactBody
      || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.authorAssociation))) return false;
    const historicalClaims = historicalClaimCounts(record);
    for (const comment of markers) {
      const markerRunId = claimRunId(comment);
      if (markerRunId === record.runId) continue;
      const key = observedHistoricalClaimKeys(comment, record)
        .find((candidate) => (historicalClaims.get(candidate) ?? 0) > 0);
      if (!key) return false;
      historicalClaims.set(key, historicalClaims.get(key)! - 1);
    }
    return currentMarkers.length === 1;
  }

  private async readIssue(issueNumber: number): Promise<RunIssueSnapshot | undefined> {
    try { return await this.dependencies.issues.read(issueNumber); }
    catch { throw new TransportReadError(); }
  }

  private async revalidateFeedbackWorker(
    active: ActiveRun,
    config: AgentAutoConfig,
    issueNumber: number,
  ): Promise<RunIssueResult | undefined> {
    const validation = await this.observeFeedbackWorker(active, config, issueNumber);
    if (validation.status === 'valid') return undefined;
    if (validation.status === 'retryable') return this.invokedFailure(active, `${validation.code}-retryable`);
    return this.blockReviewFeedback(active, 'safety', validation.code);
  }

  private async observeFeedbackWorker(
    active: ActiveRun,
    config: AgentAutoConfig,
    issueNumber: number,
  ): Promise<FeedbackWorkerObservation> {
    const batch = active.record.reviewFeedback?.activeBatch;
    if (!batch) return { status: 'valid' };
    if (!await this.authorized(active, config)) {
      return { status: 'blocked', code: 'review-feedback-worker-authority-revoked' };
    }
    if (!this.dependencies.reviewFeedback) {
      return { status: 'blocked', code: 'review-feedback-worker-revalidation-unavailable' };
    }
    const validation = await this.dependencies.reviewFeedback.revalidate({
      batch,
      epoch: 'pre-update',
      expectedHeadSha: batch.priorPublishedHeadSha,
    });
    return validation.status === 'valid'
      ? { status: 'valid' }
      : { status: validation.status, code: 'review-feedback-worker-revalidation-failed' };
  }

  private async mapFeedbackRevalidation(
    active: ActiveRun,
    validation: { status: 'valid'; observedHeadSha: string } | { status: 'retryable' | 'blocked'; reason: string },
    safetyCode: string,
  ): Promise<RunIssueResult | undefined> {
    if (validation.status === 'valid') return undefined;
    if (validation.status === 'retryable') return this.invokedFailure(active, `${safetyCode}-retryable`);
    return this.blockReviewFeedback(active, 'safety', safetyCode);
  }

  private async ensureCandidateBinding(
    active: ActiveRun,
    config: AgentAutoConfig,
    boundary: Parameters<NonNullable<RunIssueGit['candidateV2']>['captureAndPin']>[0]['boundary'],
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    if (!candidate) return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-git-v2-required');
    if (active.record.candidateBinding) {
      const inspection = await candidate.inspectPin(active.record.candidateBinding);
      if (inspection.kind === 'failed') return this.mapCandidateFailure(active, inspection.code);
      if (inspection.value === 'missing') return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-pin-missing');
      if (inspection.value === 'diverged') return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-pin-diverged');
      return { active };
    }
    const captured = await candidate.captureAndPin({
      worktreePath: active.record.worktreePath,
      expectedHeadSha: expectedImplementationHead(active.record),
      runId: active.record.runId,
      boundary,
      artifactDir: config.proof.artifactDir,
    });
    if (captured.kind === 'failed') return this.mapCandidateFailure(active, captured.code);
    return { active: await this.persist(active, {
      changeBindingVersion: 2,
      candidateBinding: captured.value,
    }) };
  }

  private async prepareAttempt(
    active: ActiveRun,
    operationId: string,
    operationSourceId: string,
    resultPath?: string,
  ): Promise<ActiveRun> {
    if (active.record.activeAttempt) {
      const attempt = active.record.activeAttempt;
      if (attempt.stage === 'observed' && attempt.result
        && attempt.operationId === operationId && attempt.operationSourceId === operationSourceId
        && (resultPath === undefined || attempt.resultPath === resultPath)) {
        return active;
      }
      throw new Error('run already owns an active attempt');
    }
    const incarnationId = this.dependencies.createRunId();
    const provisional = createActiveAttempt({
      runId: active.record.runId,
      operationId,
      operationSourceId,
      resultPath: resultPath ?? '/pending-attempt-result',
      preparedAt: this.timestamp(),
    }, () => incarnationId);
    const exactResultPath = resultPath ?? this.dependencies.attemptResultPath({
      canonicalRepository: active.record.canonicalRepository,
      runId: active.record.runId,
      attemptId: provisional.attemptId,
    });
    return this.persist(active, {
      activeAttempt: createActiveAttempt({
        runId: active.record.runId,
        operationId,
        operationSourceId,
        resultPath: exactResultPath,
        preparedAt: provisional.preparedAt,
      }, () => incarnationId),
    });
  }

  private async reconcilePersistedAttempt(
    active: ActiveRun,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const attempt = active.record.activeAttempt;
    if (!attempt) return { active };
    if (attempt.stage === 'prepared') return { active };
    if (attempt.stage === 'adopted') {
      return active.record.candidateMaterialization ? { active } : { active: await this.clearAttempt(active) };
    }
    if (attempt.stage === 'observed') {
      if (attempt.result) return { active };
      return active.record.candidateMaterialization ? { active } : { active: await this.clearAttempt(active) };
    }
    const observation = await this.dependencies.processIdentity.observe(attempt.process);
    if (!['absent', 'reused'].includes(observation.leader) || observation.group !== 'absent') {
      return this.invokedFailure(
        active,
        'active-attempt-process-absence-unconfirmed',
        'The prior attempt remains active or its process identity cannot yet be proven absent.',
      );
    }
    const result = await this.dependencies.inspectAttemptResult(attempt.resultPath);
    const observed = observeActiveAttempt(attempt, {
      ...observation,
      result: result ? { path: attempt.resultPath, sha256: result.sha256 } : null,
      observedAt: this.timestamp(),
    });
    active = await this.persist(active, { activeAttempt: observed });
    return observed.result || active.record.candidateMaterialization ? { active } : { active: await this.clearAttempt(active) };
  }

  private async launchAttempt(
    active: ActiveRun,
    pid: number,
    processGroupId: number,
    semanticChanges: Omit<Partial<RunRecord>, 'activeAttempt'> = {},
  ): Promise<ActiveRun> {
    const attempt = active.record.activeAttempt;
    if (!attempt || attempt.stage !== 'prepared') throw new Error('prepared active attempt is missing');
    const processStartIdentity = await this.dependencies.processIdentity.capture(pid, processGroupId);
    if (!processStartIdentity) throw new Error('process start identity is unknown');
    if (!await this.authorized(active, active.config)) throw new LaunchAuthorizationRevokedError(active);
    return this.persist(active, {
      ...semanticChanges,
      activeAttempt: launchActiveAttempt(attempt, {
        host: this.dependencies.processIdentity.host,
        bootId: this.dependencies.processIdentity.bootId,
        pid,
        processGroupId,
        processStartIdentity,
        launchedAt: this.timestamp(),
      }),
    });
  }

  private async adoptAttempt(
    active: ActiveRun,
    resultSha256: string,
    semanticChanges: Omit<Partial<RunRecord>, 'activeAttempt'>,
  ): Promise<ActiveRun> {
    let attempt = active.record.activeAttempt;
    if (!attempt || (attempt.stage !== 'launched' && attempt.stage !== 'observed')) {
      throw new Error('adoptable active attempt is missing');
    }
    if (attempt.stage === 'launched') {
      const observed = observeActiveAttempt(attempt, {
        leader: 'absent',
        group: 'absent',
        result: { path: attempt.resultPath, sha256: resultSha256 },
        observedAt: this.timestamp(),
      });
      active = await this.persistAttemptTransition(active, observed, {});
      attempt = active.record.activeAttempt;
    }
    if (!attempt || attempt.stage !== 'observed' || !attempt.result
      || attempt.result.path !== attempt.resultPath || attempt.result.sha256 !== resultSha256) {
      throw new Error('observed active attempt result identity mismatch');
    }
    return this.persistAttemptTransition(active, adoptActiveAttempt(attempt, this.timestamp()), semanticChanges);
  }

  private async observeReturnedAttempt(active: ActiveRun, result: unknown): Promise<ActiveRun> {
    const attempt = active.record.activeAttempt;
    if (!attempt || attempt.stage !== 'launched') return active;
    return this.persistAttemptTransition(active, observeActiveAttempt(attempt, {
      leader: 'absent', group: 'absent',
      result: { path: attempt.resultPath, sha256: sha256(canonicalJson(result)) },
      observedAt: this.timestamp(),
    }), {});
  }

  private async clearAttempt(active: ActiveRun): Promise<ActiveRun> {
    const attempt = active.record.activeAttempt;
    if (!attempt) return active;
    if (attempt.stage === 'launched') throw new Error('active attempt cleanup cannot be confirmed while launched');
    const confirmed = confirmActiveAttemptCleanup(
      attempt,
      attempt.cleanupConfirmedAt ?? this.timestamp(),
    );
    active = await this.persist(active, { activeAttempt: confirmed });
    return this.persist(active, { activeAttempt: undefined });
  }

  private async persistAttemptTransition(
    active: ActiveRun,
    nextAttempt: RunRecord['activeAttempt'],
    semanticChanges: Omit<Partial<RunRecord>, 'activeAttempt'>,
  ): Promise<ActiveRun> {
    try {
      return await this.persist(active, { ...semanticChanges, activeAttempt: nextAttempt });
    } catch (error) {
      const currentState = await this.dependencies.runRecords.read();
      const current = currentState.runs.find((record) => record.runId === active.record.runId);
      if (!current?.activeAttempt || !nextAttempt
        || current.activeAttempt.attemptId !== nextAttempt.attemptId) throw error;
      const currentResult = current.activeAttempt.stage === 'observed' || current.activeAttempt.stage === 'adopted'
        ? current.activeAttempt.result : undefined;
      const nextResult = nextAttempt.stage === 'observed' || nextAttempt.stage === 'adopted'
        ? nextAttempt.result : undefined;
      if (!currentResult || !nextResult || currentResult.path !== nextResult.path || currentResult.sha256 !== nextResult.sha256) throw error;
      if (nextAttempt.stage === 'observed' && (current.activeAttempt.stage === 'observed' || current.activeAttempt.stage === 'adopted')) {
        return { state: currentState, record: current, config: active.config };
      }
      if (nextAttempt.stage === 'adopted' && current.activeAttempt.stage === 'adopted'
        && semanticChangesMatch(current, semanticChanges)) {
        return { state: currentState, record: current, config: active.config };
      }
      if (nextAttempt.stage === 'adopted' && current.activeAttempt.stage === 'observed') {
        return this.persist(
          { state: currentState, record: current, config: active.config },
          { ...semanticChanges, activeAttempt: nextAttempt },
        );
      }
      throw error;
    }
  }

  private async executeOrRecoverConfiguredCheck(
    active: ActiveRun,
    input: { id: string; command: string; source: 'issue' | 'configured'; cwd: string; phase: 'changed' },
  ): Promise<{ active: ActiveRun; check: DurableConfiguredCheckResult } | RunIssueResult> {
    const attempt = active.record.activeAttempt;
    if (attempt?.stage === 'observed' && attempt.result) {
      const stored = await this.dependencies.inspectAttemptResult(attempt.resultPath);
      if (!stored || stored.sha256 !== attempt.result.sha256) {
        return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'configured-check-result-missing');
      }
      try {
        const recovered = validateConfiguredCheckAttemptBytes(stored.bytes, input);
        return { active, check: {
          status: recovered.status, output: recovered.output, outputSha256: recovered.outputSha256,
          observation: { leader: 'absent', group: 'absent' }, attemptResultSha256: stored.sha256,
        } };
      } catch {
        return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'configured-check-result-invalid');
      }
    }
    let executed: Awaited<ReturnType<RunIssueDependencies['checks']['run']>>;
    try {
      executed = await this.dependencies.checks.run({
        ...input, signal: this.signal,
        onLaunched: async ({ pid, processGroupId }) => { active = await this.launchAttempt(active, pid, processGroupId); },
      });
    } catch (error) {
      if (error instanceof CheckProcessQuiescenceError) {
        return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'check-process-quiescence-unconfirmed');
      }
      return this.invokedFailure(active, 'configured-check-execution-failed',
      error instanceof Error ? error.message : 'The configured check process did not start or settle. Retry the same run.');
    }
    if (executed.outputSha256 !== sha256(executed.output)) {
      return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'configured-check-output-sha-invalid');
    }
    const launched = active.record.activeAttempt;
    if (!launched || launched.stage !== 'launched') throw new Error('launched configured check attempt is missing');
    const bytes = configuredCheckAttemptBytes({ ...input, status: executed.status, output: executed.output });
    const attemptResultSha256 = sha256(bytes);
    try { await this.dependencies.writeAttemptResult({ path: launched.resultPath, bytes, sha256: attemptResultSha256 }); }
    catch { return this.invokedFailure(active, 'configured-check-result-write-failed'); }
    const stored = await this.dependencies.inspectAttemptResult(launched.resultPath);
    if (!stored || stored.sha256 !== attemptResultSha256) {
      return this.invokedFailure(active, 'configured-check-result-observation-failed');
    }
    return { active, check: { ...executed, attemptResultSha256 } };
  }

  private async prepareCandidateMaterialization(
    active: ActiveRun,
    config: AgentAutoConfig,
    operation: 'direct-review' | 'final-check' | 'acceptance-proof',
    operationSourceId: string,
  ): Promise<{ active: ActiveRun; materialization: CandidateMaterializationV2 } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    if (!candidate || !binding) return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-git-v2-required');
    const materializationId = sha256(canonicalJson({ bindingId: binding.bindingId, operation, operationSourceId }));
    const prepared = await candidate.prepareMaterialization({
      binding,
      runId: active.record.runId,
      workspaceRoot: resolve(dirname(active.record.worktreePath)),
      materializationId,
    });
    if (prepared.kind === 'failed') return this.mapCandidateFailure(active, prepared.code);
    if (prepared.value.kind === 'path-diverged') {
      return this.persistCandidateEvidenceSafetyTerminal(active, 'path-diverged');
    }
    let next = await this.persist(active, { candidateMaterialization: prepared.value.materialization });
    next = await this.prepareAttempt(
      next,
      operation === 'direct-review' ? 'code-review' : operation === 'acceptance-proof' ? 'acceptance-proof' : 'configured-check',
      operationSourceId,
    );
    return { active: next, materialization: prepared.value.materialization };
  }

  private async settleCandidateMaterialization(
    active: ActiveRun,
    config: AgentAutoConfig,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    const materialization = active.record.candidateMaterialization;
    if (!candidate || !binding || !materialization) return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-materialization-state-missing');
    if (active.record.activeAttempt?.stage !== 'adopted') {
      return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-result-adoption-unconfirmed');
    }
    const inspection = await candidate.inspectMaterialization({ binding, materialization, artifactDir: config.proof.artifactDir });
    if (inspection.kind === 'failed') return this.mapCandidateFailure(active, inspection.code);
    if (inspection.value !== 'matching') {
      return this.reconcilePersistedCandidateMaterialization(active, config);
    }
    const removed = await candidate.removeMaterialization({ materialization });
    if (removed.kind === 'failed') return this.mapCandidateFailure(active, removed.code);
    let cleared = await this.persist(active, { candidateMaterialization: undefined });
    cleared = await this.clearAttempt(cleared);
    return { active: cleared };
  }

  private async reconcilePersistedCandidateMaterialization(
    active: ActiveRun,
    config: AgentAutoConfig,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    const materialization = active.record.candidateMaterialization;
    if (!candidate || !binding || !materialization) {
      return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-materialization-state-missing');
    }
    const inspection = await candidate.inspectMaterialization({ binding, materialization, artifactDir: config.proof.artifactDir });
    if (inspection.kind === 'failed') return this.mapCandidateFailure(active, inspection.code);
    if (inspection.value === 'missing') {
      return active.record.terminalOutcome
        ? { active: await this.persist(active, { candidateMaterialization: undefined }) }
        : this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-execution-missing');
    }
    if (inspection.value === 'mutated') {
      return this.persistTerminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-materialization-mutated', false);
    }
    if (active.record.activeAttempt?.stage === 'observed' && active.record.activeAttempt.result) {
      return { active };
    }
    if (active.record.terminalOutcome && !active.record.activeAttempt) {
      const removed = await candidate.removeMaterialization({ materialization });
      if (removed.kind === 'failed') return this.mapCandidateFailure(active, removed.code);
      return { active: await this.persist(active, { candidateMaterialization: undefined }) };
    }
    if (active.record.activeAttempt?.stage !== 'adopted') return { active };
    const removed = await candidate.removeMaterialization({ materialization });
    if (removed.kind === 'failed') return this.mapCandidateFailure(active, removed.code);
    let cleared = await this.persist(active, { candidateMaterialization: undefined });
    cleared = await this.clearAttempt(cleared);
    return { active: cleared };
  }

  private async clearAndReleaseCandidate(active: ActiveRun): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    if (!candidate || !binding) return { active };
    if (active.record.candidateMaterialization) return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-materialization-not-cleared');
    const normalized = await candidate.normalizeSharedIndex({
      worktreePath: active.record.worktreePath,
      expectedHeadSha: expectedImplementationHead(active.record),
    });
    if (normalized.kind === 'failed') return this.mapCandidateFailure(active, normalized.code);
    const cleared = await this.persist(active, { changeBindingVersion: undefined, candidateBinding: undefined });
    const released = await candidate.releasePin({ binding, expectedPinnedCommitSha: binding.candidateCommitSha });
    if (released.kind === 'failed') {
      return this.invokedFailure(cleared, 'candidate-pin-release-pending', 'The candidate state transition is durable; orphan reconciliation will retry exact pin cleanup.');
    }
    return { active: cleared };
  }

  private async persistRetainedCommitIntentTerminal(active: ActiveRun, evidenceCode: string): Promise<RunIssueResult> {
    const pendingEffect = active.record.pendingEffect;
    if (!active.record.candidateBinding || (pendingEffect?.kind !== 'initial-commit' && pendingEffect?.kind !== 'review-update-commit')) {
      return this.invokedFailure(active, 'retained-candidate-pendingEffect-state-invalid');
    }
    return this.invokedFailure(
      active,
      evidenceCode,
      'Candidate publication stopped locally with the exact commit pendingEffect and pin retained for observation.',
    );
  }

  private async reconcileUnknownCandidatePublication(active: ActiveRun): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    const pendingEffect = active.record.pendingEffect;
    if (!candidate || !binding || (pendingEffect?.kind !== 'initial-commit' && pendingEffect?.kind !== 'review-update-commit')) {
      return publicOutcome(active.record.terminalOutcome!);
    }
    const observation = await candidate.createOrObserveCommit({
      worktreePath: active.record.worktreePath,
      branchName: active.record.branchName,
      parentSha: pendingEffect.parentSha,
      treeSha: pendingEffect.treeSha,
      message: pendingEffect.message,
      candidateRef: pendingEffect.candidateRef!,
      observeOnly: true,
    });
    if (observation.kind === 'failed') {
      return publicOutcome(active.record.terminalOutcome!);
    }
    if (observation.value.kind === 'branch-diverged') {
      return this.persistRetainedCommitIntentTerminal(active, 'candidate-branch-diverged');
    }
    let directReview = active.record.directReview;
    if (directReview?.status === 'terminal') {
      const { terminalCode: _terminalCode, terminalOutcome: _terminalOutcome, ...preserved } = structuredClone(directReview);
      directReview = { ...preserved, status: 'clear' };
    }
    return { active: await this.persist(active, {
      lifecycle: 'publishing', terminalOutcome: undefined, outcomeEvidenceId: undefined,
      ...(directReview ? { directReview } : {}),
    }) };
  }

  private async persistCandidateEvidenceSafetyTerminal(active: ActiveRun, evidenceCode: string): Promise<RunIssueResult> {
    if (!active.record.candidateBinding) return this.invokedFailure(active, 'candidate-evidence-state-invalid');
    if (active.record.reviewFeedback?.activeBatch) {
      active = await this.persist(active, {
        reviewFeedback: blockReviewFeedback(active.record.reviewFeedback, 'safety', this.timestamp()),
      });
    }
    return this.persistTerminal(active, { status: 'blocked', kind: 'safety', resumable: false }, evidenceCode, false);
  }

  private mapCandidateFailure(active: ActiveRun, code: string): Promise<RunIssueResult> {
    if (code === 'candidate-unstable' || code === 'candidate-io-failed' || code === 'candidate-materialization-io-failed') {
      return this.invokedFailure(active, code, 'Candidate operation failed before an effect and may be retried without consuming a repair budget.');
    }
    return this.terminal(active, { status: 'transport-failed', resumable: false }, code);
  }

  private async runImplementation(input: {
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
    onPrepared?: (input: { attemptId: string; reportPath: string; preparedAt: string; baseline: Omit<CheckedChangeFreshness, 'checkPolicySha256'> }) => Promise<void>;
    onLaunched?: (input: { attemptId: string; pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
  }): Promise<ImplementationAgentResult> {
    try {
      return await this.dependencies.implementationAgent.run({
        ...input,
        workflowGeneration: structuredClone(input.workflowGeneration),
        signal: this.signal,
      });
    } catch {
      return { kind: 'internal-error' };
    }
  }

  private async runDirectReviewFull(
    starting: ActiveRun,
    issue: IssueSnapshot,
    frozenCriteria: FrozenCriterion[],
    implementationAttemptId: string,
    maxCycles: number,
    config: AgentAutoConfig,
  ): Promise<ActiveRun | RunIssueResult> {
    let active = starting;
    let reportRepair: { originalReportSha256: string; originalReportBytes: Buffer; diagnostic: string } | undefined;
    while (true) {
      const directReview = active.record.directReview;
      const routeReceipt = active.record.routeReceipt;
      if (!directReview || !routeReceipt || !['direct', 'spec-required'].includes(routeReceipt.route)
        || directReview.stage !== 'review') {
        return this.terminal(active, { status: 'internal-error', code: 'direct-review-state-invalid' });
      }
      const reviewerSessionId = directReview.review.reviewerSessionId;
      if (!reviewerSessionId) return this.terminal(active, { status: 'internal-error', code: 'direct-review-session-missing' });
      const reviewerAuthorization = await this.observeFeedbackWorker(active, config, active.record.issueNumber);
      if (reviewerAuthorization.status !== 'valid') {
        const released = await this.clearAndReleaseCandidate(active);
        if ('status' in released) return released;
        active = released.active;
        return reviewerAuthorization.status === 'retryable'
          ? this.invokedFailure(active, `${reviewerAuthorization.code}-retryable`)
          : this.blockReviewFeedback(active, 'safety', reviewerAuthorization.code);
      }
      const execution = await this.prepareCandidateMaterialization(
        active,
        config,
        'direct-review',
        `${reviewerSessionId}:${directReview.targetRevision}:${implementationAttemptId}`,
      );
      if ('status' in execution) return execution;
      active = execution.active;
      const materialization = execution.materialization;
      const abortPreparedReview = async (
        validation: Exclude<FeedbackWorkerObservation, { status: 'valid' }>,
      ): Promise<RunIssueResult> => {
        const settledExecution = await this.settleCandidateMaterialization(active, config);
        if ('status' in settledExecution) return settledExecution;
        active = settledExecution.active;
        const released = await this.clearAndReleaseCandidate(active);
        if ('status' in released) return released;
        active = released.active;
        return validation.status === 'retryable'
          ? this.invokedFailure(active, `${validation.code}-retryable`)
          : this.blockReviewFeedback(active, 'safety', validation.code);
      };
      const launchAuthorization = await this.observeFeedbackWorker(active, config, active.record.issueNumber);
      if (launchAuthorization.status !== 'valid') return abortPreparedReview(launchAuthorization);
      let gatedLaunchAuthorizationFailure: Exclude<FeedbackWorkerObservation, { status: 'valid' }> | undefined;
      const result = await this.dependencies.implementationReviewer.run({
        attemptId: active.record.activeAttempt!.attemptId,
        runId: active.record.runId,
        worktreePath: materialization.path,
        operation: 'code-review',
        reviewerSessionId,
        implementationAttemptId,
        targetRevision: directReview.targetRevision,
        targetFingerprint: directReview.targetFingerprint,
        issue,
        frozenCriteria,
        routeReceipt: structuredClone(routeReceipt),
        deliveryAuthority: structuredClone(active.record.deliveryAuthority!),
        defects: structuredClone(directReview.review.defects),
        fixedRepairFindings: directReview.repairFindings.filter((finding) => finding.status === 'fixed')
          .map((finding) => ({ id: finding.id, affectedContracts: [...finding.affectedContracts] })),
        reviewFocus: ['acceptance-criteria', 'correctness', 'test-quality'],
        workflowGeneration: structuredClone(active.record.workflowGeneration),
        repairOnly: reportRepair !== undefined,
        originalReportSha256: reportRepair?.originalReportSha256 ?? null,
        validationDiagnostic: reportRepair?.diagnostic ?? null,
        originalReportBytes: reportRepair?.originalReportBytes ?? null,
        signal: this.signal,
        onPrepared: async (invocation) => {
          if (!active.record.directReview) throw new Error('direct review disappeared before prepare');
          if (invocation.attemptId !== active.record.activeAttempt?.attemptId
            || invocation.operation !== 'code-review'
            || invocation.reviewerSessionId !== reviewerSessionId) throw new Error('direct review prepare correlation mismatch');
        },
        onLaunched: async (invocation) => {
          const validation = await this.observeFeedbackWorker(active, config, active.record.issueNumber);
          if (validation.status !== 'valid') {
            gatedLaunchAuthorizationFailure = validation;
            throw new Error('direct review launch authorization changed');
          }
          if (!active.record.directReview) throw new Error('direct review disappeared before launch');
          active = await this.launchAttempt(active, invocation.pid, invocation.processGroupId);
        },
      });
      if (gatedLaunchAuthorizationFailure) {
        return abortPreparedReview(gatedLaunchAuthorizationFailure);
      }
      if (result.kind === 'completed') {
        const current = active.record.directReview;
        if (!current) return this.terminal(active, { status: 'internal-error', code: 'direct-review-result-orphaned' });
        if (result.report.verdict === 'needs-work') {
          if (this.repairBudgetExhausted(active, maxCycles)) {
            return active.record.reviewFeedback?.activeBatch
              ? this.blockReviewFeedback(active, 'exhausted', 'direct-review-repair-exhausted')
              : this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true }, 'direct-review-repair-exhausted');
          }
          const repaired = acceptNeedsWorkDirectReview(current, result.report, result.artifactSha256);
          const findings = [
            ...result.report.defects
            .filter((defect) => defect.status === 'open' || defect.status === 'reopened')
            .map((defect) => `${defect.id}: ${defect.failure}\nRepair: ${defect.repair}`),
            ...repaired.repairFindings
              .filter((finding) => finding.status === 'reopened')
              .map((finding) => `${finding.id}: ${finding.summary}`),
          ];
          active = await this.adoptAttempt(active, result.artifactSha256, {
            lifecycle: 'implementing',
            cycle: active.record.reviewFeedback?.activeBatch
              ? active.record.cycle
              : (active.record.cycle + 1) as RunRecord['cycle'],
            ...(active.record.reviewFeedback?.activeBatch ? {
              reviewFeedback: reserveNextReviewFeedbackRound(active.record.reviewFeedback),
            } : {}),
            directReview: repaired,
            reworkFindings: findings,
            checks: [],
            checkedChangeSha256: undefined,
            proofId: undefined,
            proofReceipt: undefined,
          });
          const settledExecution = await this.settleCandidateMaterialization(active, config);
          if ('status' in settledExecution) return settledExecution;
          const released = await this.clearAndReleaseCandidate(settledExecution.active);
          return 'status' in released ? released : released.active;
        }
        if (result.report.verdict !== 'approved') return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'direct-review-rejected');
        active = await this.adoptAttempt(active, result.artifactSha256, {
          lifecycle: 'checking',
          directReview: acceptApprovedDirectReview(current, result.report, result.artifactSha256),
        });
        const settledExecution = await this.settleCandidateMaterialization(active, config);
        return 'status' in settledExecution ? settledExecution : settledExecution.active;
      }
      if (result.kind === 'report-invalid') {
        const current = active.record.directReview;
        if (!current) return this.terminal(active, { status: 'internal-error', code: 'direct-review-result-orphaned' });
        if (current.review.reportRepairs >= MAX_DIRECT_REVIEW_REPORT_REPAIRS) {
          return this.terminal(
            active,
            { status: 'internal-error', code: 'direct-review-report-malformed' },
            'direct-review-report-malformed',
          );
        }
        active = await this.adoptAttempt(active, result.originalReportSha256, {
          directReview: {
            ...structuredClone(current),
            review: {
              ...current.review,
              reportRepairs: (current.review.reportRepairs + 1) as typeof current.review.reportRepairs,
            },
          },
        });
        const settledExecution = await this.settleCandidateMaterialization(active, config);
        if ('status' in settledExecution) return settledExecution;
        active = settledExecution.active;
        reportRepair = {
          originalReportSha256: result.originalReportSha256,
          originalReportBytes: Buffer.from(result.originalReportBytes),
          diagnostic: result.diagnostic,
        };
        continue;
      }
      if (result.kind === 'transport-failed') {
        const current = active.record.directReview;
        if (!current || current.review.transportRetries >= 1) {
          return this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true }, 'direct-review-transport-exhausted');
        }
        const nextReview = {
          ...structuredClone(current),
          review: { ...current.review, transportRetries: 1 as const },
        };
      if (isAdoptableAttempt(active.record.activeAttempt)) {
          active = await this.adoptAttempt(active, sha256(canonicalJson(result)), { directReview: nextReview });
        } else {
          active = await this.persist(active, { directReview: nextReview });
        }
        const settledExecution = await this.settleCandidateMaterialization(active, config);
        if ('status' in settledExecution) return settledExecution;
        active = settledExecution.active;
        continue;
      }
      if (result.kind === 'safe-halt') {
        active = await this.persist(active, { lifecycle: 'safe-halt' });
        try { await result.waitForAbsence(); }
        catch { return this.terminal(active, { status: 'transport-failed', resumable: false }, 'direct-review-quiescence-unconfirmed'); }
        return this.terminal(active, { status: 'transport-failed', resumable: false }, 'direct-review-quiescence-delayed');
      }
      if (result.kind === 'cancelled') return this.terminal(active, { status: 'cancelled' });
      return this.terminal(active, { status: 'internal-error', code: result.code });
    }
  }

  private async recoverTerminalReviewReport(
    active: ActiveRun,
    issue: RunIssueSnapshot | undefined,
    config: AgentAutoConfig,
    frozenCriteria: FrozenCriterion[],
  ): Promise<ActiveRun | undefined> {
    const directReview = active.record.directReview;
    const allowLegacyMalformed = directReview?.terminalCode === undefined
      && active.record.outcomeEvidenceId === `evidence:${active.record.runId}:direct-review-report-malformed`;
    if (!issue || !directReview || active.record.pendingEffect || active.record.activeAttempt
      || active.record.terminalOutcome?.status !== 'internal-error'
      || directReview.status !== 'terminal' || directReview.terminalOutcome?.status !== 'internal-error'
      || !canRecoverTerminalDirectReviewReport(directReview, { allowLegacyMalformed })
      || !this.isAuthorizedIssue(issue, active.record, config)) return undefined;
    let worktree: 'absent' | 'matching' | 'diverged';
    try {
      worktree = await this.dependencies.git.inspectWorktree({
        worktreePath: active.record.worktreePath,
        branchName: active.record.branchName,
        baseSha: active.record.baseSha,
      });
    } catch {
      return undefined;
    }
    if (worktree !== 'matching'
      || await this.dependencies.git.getHead(active.record.worktreePath) !== expectedImplementationHead(active.record)) return undefined;
    const changedFiles = active.record.candidateBinding?.canonicalChangedFiles
      ?? await this.dependencies.git.listChangedFiles(active.record.worktreePath);
    if (changedFiles.length === 0 || !active.record.routeReceipt) return undefined;
    const binding = active.record.candidateBinding;
    const targetFingerprint = binding
      ? directReviewCandidateTargetFingerprint({
        binding,
        routeDecisionSha256: active.record.deliveryAuthority!.authoritySha256,
        workflowGenerationHash: active.record.workflowGeneration.generationHash,
        cycle: active.record.cycle,
        frozenCriteria,
      })
      : directReviewTargetFingerprint({
        snapshot: await this.dependencies.git.snapshot(active.record.worktreePath),
        changedFiles,
        routeDecisionSha256: active.record.deliveryAuthority!.authoritySha256,
        workflowGenerationHash: active.record.workflowGeneration.generationHash,
        cycle: active.record.cycle,
        frozenCriteria,
      });
    if (targetFingerprint !== directReview.targetFingerprint) return undefined;
    return this.persist(active, {
      lifecycle: 'implementing',
      directReview: recoverTerminalDirectReviewReport(directReview, { allowLegacyMalformed }),
      terminalOutcome: undefined,
      outcomeEvidenceId: undefined,
    });
  }

  private async startNextCycle(
    active: ActiveRun,
    findings: string[],
    sources?: Array<{ provenance: 'check' | 'proof'; sourceId: string; summary: string; affectedContracts: string[] }>,
  ): Promise<ActiveRun> {
    if (active.record.directReview?.status === 'clear') {
      const fallbackProvenance = active.record.lifecycle === 'proving' ? 'proof' as const : 'check' as const;
      const normalizedSources = sources ?? findings.map((summary) => ({
        provenance: fallbackProvenance,
        sourceId: `${fallbackProvenance}:recovery:${sha256(summary)}`,
        summary,
        affectedContracts: [fallbackProvenance === 'proof' ? 'acceptance-proof' : 'configured-checks'],
      }));
      const repairFindings = normalizedSources.map((source) => ({
        id: source.sourceId,
        provenance: source.provenance,
        sourceId: source.sourceId,
        targetRevision: active.record.directReview!.targetRevision,
        summary: source.summary,
        affectedContracts: source.affectedContracts,
        status: 'open' as const,
      }));
      return this.persist(active, {
        lifecycle: 'implementing',
        changeBindingVersion: undefined,
        candidateBinding: undefined,
        cycle: active.record.reviewFeedback?.activeBatch
          ? active.record.cycle
          : (active.record.cycle + 1) as RunRecord['cycle'],
        ...(active.record.reviewFeedback?.activeBatch ? {
          reviewFeedback: reserveNextReviewFeedbackRound(active.record.reviewFeedback),
        } : {}),
        reworkFindings: [...findings],
        directReview: beginDirectReviewRepair(active.record.directReview, repairFindings),
        checks: [],
        checkedChangeSha256: undefined,
        proofId: undefined,
        proofReceipt: undefined,
      });
    }
    active = await this.persist(active, { lifecycle: 'reworking', reworkFindings: [...findings] });
    return this.persist(active, {
      lifecycle: 'implementing',
      changeBindingVersion: undefined,
      candidateBinding: undefined,
      cycle: active.record.reviewFeedback?.activeBatch
        ? active.record.cycle
        : (active.record.cycle + 1) as RunRecord['cycle'],
      ...(active.record.reviewFeedback?.activeBatch ? {
        reviewFeedback: reserveNextReviewFeedbackRound(active.record.reviewFeedback),
      } : {}),
      checks: [],
      checkedChangeSha256: undefined,
      proofId: undefined,
      proofReceipt: undefined,
    });
  }

  private async startNextCycleFromCandidate(
    active: ActiveRun,
    findings: string[],
    sources?: Array<{ provenance: 'check' | 'proof'; sourceId: string; summary: string; affectedContracts: string[] }>,
  ): Promise<ActiveRun | RunIssueResult> {
    const binding = active.record.candidateBinding;
    const candidate = this.dependencies.git.candidateV2;
    if (!binding || !candidate) return this.startNextCycle(active, findings, sources);
    if (active.record.candidateMaterialization || active.record.activeAttempt) {
      return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-execution-not-quiescent');
    }
    const normalized = await candidate.normalizeSharedIndex({
      worktreePath: active.record.worktreePath,
      expectedHeadSha: expectedImplementationHead(active.record),
    });
    if (normalized.kind === 'failed') return this.mapCandidateFailure(active, normalized.code);
    const transitioned = await this.startNextCycle(active, findings, sources);
    const released = await candidate.releasePin({ binding, expectedPinnedCommitSha: binding.candidateCommitSha });
    if (released.kind === 'failed') {
      return this.invokedFailure(transitioned, 'candidate-pin-release-pending', 'The next repair cycle is durable; orphan reconciliation will retry exact pin cleanup.');
    }
    return transitioned;
  }

  private repairBudgetExhausted(active: ActiveRun, maxCycles: number): boolean {
    return active.record.reviewFeedback?.activeBatch
      ? active.record.reviewFeedback.repairRound >= 3
      : active.record.cycle >= maxCycles;
  }

  private async blockReviewFeedback(
    active: ActiveRun,
    kind: 'safety' | 'exhausted',
    evidenceCode: string,
  ): Promise<RunIssueResult> {
    const feedback = active.record.reviewFeedback;
    if (!feedback?.activeBatch) return this.terminal(active, { status: 'blocked', kind, resumable: false }, evidenceCode);
    {
      const config = active.config;
      const blockedLabels = [config.github.labels.auto.name, config.github.labels.blocked.name].sort();
      const existingIntent = active.record.pendingEffect;
      if (existingIntent?.kind !== 'review-blocked-labels') {
        active = await this.persist(active, { pendingEffect: {
          kind: 'review-blocked-labels', issueNumber: active.record.issueNumber,
          batchId: feedback.activeBatch.batchId, expected: blockedLabels, blockKind: kind, evidenceCode,
        } });
      } else if (existingIntent.issueNumber !== active.record.issueNumber
        || existingIntent.batchId !== feedback.activeBatch.batchId
        || !sameStrings(existingIntent.expected, blockedLabels)
        || existingIntent.blockKind !== kind
        || existingIntent.evidenceCode !== evidenceCode) {
        return this.invokedFailure(active, 'review-feedback-blocked-labels-pendingEffect-diverged');
      }
      let issue = await this.readIssue(active.record.issueNumber);
      const ownedRunningLabels = [config.github.labels.auto.name, config.github.labels.running.name].sort();
      const ownedReviewLabels = [config.github.labels.review.name];
      const canReduceAuthority = !!issue && issue.state === 'OPEN'
        && (sameStrings(issue.labels, ownedRunningLabels) || sameStrings(issue.labels, ownedReviewLabels));
      if (issue?.state === 'OPEN' && !sameStrings(issue.labels, blockedLabels) && !canReduceAuthority) {
        return this.invokedFailure(active, 'review-feedback-blocked-labels-source-diverged');
      }
      if (canReduceAuthority && !sameStrings(issue!.labels, blockedLabels)) {
        try {
 await this.dependencies.issues.setLabels(active.record.issueNumber, blockedLabels); }
        catch { return this.invokedFailure(active, 'review-feedback-blocked-labels-delivery-unknown'); }
        issue = await this.readIssue(active.record.issueNumber);
      }
      if (canReduceAuthority && (!issue || !sameStrings(issue.labels, blockedLabels))) {
        return this.invokedFailure(active, 'review-feedback-blocked-labels-observation-diverged');
      }
    }
    return this.persistTerminal(active, { status: 'blocked', kind, resumable: false }, evidenceCode, false, {
      reviewFeedback: blockReviewFeedback(feedback, kind, this.timestamp()),
    }, true);
  }

  private async mapImplementationFailure(
    active: ActiveRun,
    result: Exclude<ImplementationAgentResult, { kind: 'completed' } | { kind: 'safe-halt' }>,
  ): Promise<RunIssueResult> {
    if (result.kind === 'transport-failed') return this.terminal(active, { status: 'transport-failed', resumable: result.resumable });
    if (result.kind === 'cancelled') return this.terminal(active, { status: 'cancelled' });
    return this.terminal(active, { status: 'internal-error', code: 'implementation-agent-internal-failure' });
  }

  private async mapProofFailure(active: ActiveRun, proof: Exclude<ProveChangeResult, { status: 'passed' }>): Promise<RunIssueResult> {
    if (proof.status === 'needs-rework') return this.terminal(active, { status: 'internal-error', code: 'proof-rework-loop-not-yet-implemented' });
    if (proof.status === 'external-block') return this.terminal(active, { status: 'blocked', kind: 'external', resumable: true });
    if (proof.status === 'transport-failed') return this.terminal(active, { status: 'transport-failed', resumable: proof.resumable });
    if (proof.status === 'cancelled') return this.terminal(active, { status: 'cancelled' });
    return this.terminal(active, { status: 'internal-error', code: 'acceptance-proof-internal-failure' });
  }

  private async revoked(active: ActiveRun): Promise<RunIssueResult> {
    if (active.record.pendingEffect) return this.invokedFailure(active, 'revoked-with-pending-effect');
    return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
  }

  private async invokedFailure(
    active: ActiveRun,
    code: string,
    summary = 'Publication delivery requires reconciliation.',
  ): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code, summary });
    return { status: 'transport-failed', resumable: true, evidencePath: evidence.path };
  }

  private async observeOutcomeEvidenceEffect(
    active: ActiveRun,
    code: string,
    summary: string,
    replaceConfirmedEffect = false,
  ): Promise<{ active: ActiveRun; path: string; id: string }> {
    if (!active.record.pendingEffect || replaceConfirmedEffect) {
      const recordedAt = this.timestamp();
      const path = this.dependencies.outcomeEvidencePath(active.record.runId, code, sha256(summary));
      const bytes = outcomeEvidenceBytes({ runId: active.record.runId, code, summary, recordedAt });
      active = await this.persist(active, { pendingEffect: {
        kind: 'outcome-evidence', path, runId: active.record.runId, code, summary, recordedAt, bytesSha256: sha256(bytes),
      } });
    }
    const effect = active.record.pendingEffect;
    if (effect?.kind !== 'outcome-evidence' || effect.runId !== active.record.runId
      || effect.code !== code || effect.summary !== summary
      || effect.path !== this.dependencies.outcomeEvidencePath(active.record.runId, code, sha256(summary))) {
      throw new PostEffectStateError(active);
    }
    const bytes = outcomeEvidenceBytes(effect);
    if (sha256(bytes) !== effect.bytesSha256) throw new PostEffectStateError(active);
    let observed = await this.dependencies.inspectOutcomeEvidence(effect.path);
    if (!observed) {
      try { await this.dependencies.writeOutcomeEvidence({ path: effect.path, bytes, sha256: effect.bytesSha256 }); }
      catch { throw new PostEffectStateError(active); }
      observed = await this.dependencies.inspectOutcomeEvidence(effect.path);
    }
    if (!observed || observed.sha256 !== effect.bytesSha256) throw new PostEffectStateError(active);
    return { active, path: effect.path, id: `evidence:${effect.runId}:${effect.code}` };
  }

  private async terminal(
    active: ActiveRun,
    outcome: TerminalSeed,
    evidenceCode: string = outcome.status,
    retainIntent = false,
  ): Promise<RunIssueResult> {
    if (active.record.reviewFeedback?.activeBatch && outcome.status !== 'review-ready') {
      return this.blockReviewFeedback(
        active,
        outcome.status === 'blocked' && outcome.kind === 'exhausted' ? 'exhausted' : 'safety',
        evidenceCode,
      );
    }
    if (outcome.status === 'blocked') {
      return this.publishBlockedTerminal(active, outcome, evidenceCode);
    }
    return this.persistTerminal(active, outcome, evidenceCode, retainIntent);
  }

  private async publishBlockedTerminal(
    starting: ActiveRun,
    outcome: Extract<TerminalSeed, { status: 'blocked' }>,
    evidenceCode: string,
  ): Promise<RunIssueResult> {
    let active = starting;
    const autoBlocked = [active.config.github.labels.auto.name, active.config.github.labels.blocked.name].sort();
    const blockedOnly = [active.config.github.labels.blocked.name];
    let expected = autoBlocked;
    const existing = active.record.pendingEffect;
    if (!existing) {
      active = await this.persist(active, { pendingEffect: {
        kind: 'blocked-labels',
        issueNumber: active.record.issueNumber,
        expected,
        blockKind: outcome.kind,
        resumable: outcome.resumable,
        evidenceCode,
      } });
    } else if (existing.kind !== 'blocked-labels'
      || existing.issueNumber !== active.record.issueNumber
      || existing.blockKind !== outcome.kind
      || existing.resumable !== outcome.resumable
      || existing.evidenceCode !== evidenceCode) {
      return this.invokedFailure(active, 'blocked-labels-pendingEffect-diverged');
    } else {
      expected = existing.expected;
      if (!sameStrings(expected, autoBlocked) && !sameStrings(expected, blockedOnly) && expected.length !== 0) {
        return this.invokedFailure(active, 'blocked-labels-pendingEffect-diverged');
      }
    }

    let issue = await this.readIssue(active.record.issueNumber);
    if (!issue) return this.invokedFailure(active, 'blocked-labels-issue-missing');
    let projection = blockedLabelProjection(issue.labels, active.config);
    if (issue.state === 'OPEN' && projection.status === 'transition') {
      if (!this.dependencies.issues.transitionToBlocked) {
        return this.invokedFailure(active, 'blocked-labels-transition-unavailable');
      }
      try {

        await this.dependencies.issues.transitionToBlocked(
          active.record.issueNumber,
          blockedLabelPolicy(active.config),
        );
      }
      catch { return this.invokedFailure(active, 'blocked-labels-delivery-unknown'); }
      issue = await this.readIssue(active.record.issueNumber);
      projection = issue ? blockedLabelProjection(issue.labels, active.config) : { status: 'diverged' };
    }
    if (!issue) return this.invokedFailure(active, 'blocked-labels-observation-missing');
    if (issue.state === 'OPEN') {
      if (projection.status !== 'settled') {
        return this.invokedFailure(active, 'blocked-labels-observation-diverged');
      }
      if (!sameStrings(expected, projection.expected)) {
        expected = projection.expected;
        const pendingEffect = active.record.pendingEffect;
        if (pendingEffect?.kind !== 'blocked-labels') return this.invokedFailure(active, 'blocked-labels-pendingEffect-diverged');
        try {
          const { effectId: _effectId, ...intent } = pendingEffect;
          active = await this.persist(active, { pendingEffect: { ...intent, expected } });
        } catch {
          throw new PostEffectStateError(active);
        }
      }
    }
    try {
      active = await this.confirmEffect(active);
      return await this.persistTerminal(active, outcome, evidenceCode, false);
    } catch {
      throw new PostEffectStateError(active);
    }
  }

  private async reconcilePersistedBlockedTerminal(
    active: ActiveRun,
    issue: RunIssueSnapshot,
    outcome: Extract<RunTerminalOutcome, { status: 'blocked' }>,
  ): Promise<RunIssueResult> {
    if (!this.dependencies.issues.transitionToBlocked) {
      return this.invokedFailure(active, 'blocked-labels-transition-unavailable');
    }
    try {

      await this.dependencies.issues.transitionToBlocked(
        active.record.issueNumber,
        blockedLabelPolicy(active.config),
      );
    }
    catch { return this.invokedFailure(active, 'blocked-labels-delivery-unknown'); }
    const observation = await this.readIssue(active.record.issueNumber);
    if (!observation || observation.state !== 'OPEN'
      || blockedLabelProjection(observation.labels, active.config).status !== 'settled') {
      return this.invokedFailure(active, 'blocked-labels-observation-diverged');
    }
    return publicOutcome(outcome);
  }

  private async persistTerminal(
    active: ActiveRun,
    outcome: TerminalSeed,
    evidenceCode: string,
    retainIntent: boolean,
    additionalChanges: Omit<Partial<RunRecord>, 'pendingEffect' | 'terminalOutcome' | 'outcomeEvidenceId' | 'lifecycle'> = {},
    replaceConfirmedEffect = false,
  ): Promise<RunIssueResult> {
    const evidence = await this.observeOutcomeEvidenceEffect(
      active, evidenceCode, canonicalJson(outcome), replaceConfirmedEffect,
    );
    active = evidence.active;
    const terminalOutcome = { ...outcome, evidencePath: evidence.path } as RunTerminalOutcome;
    const changes: Partial<RunRecord> & { pendingEffect?: PendingEffect | undefined } = {
      ...additionalChanges,
      lifecycle: outcome.status,
      terminalOutcome,
      outcomeEvidenceId: evidence.id,
    };
    if (outcome.status !== 'review-ready' && active.record.directReview && active.record.directReview.status !== 'terminal') {
      changes.directReview = projectTerminalDirectReview(active.record.directReview, outcome.status === 'blocked'
        ? { status: 'blocked', kind: outcome.kind }
        : { status: outcome.status }, outcome.status === 'internal-error' ? outcome.code : undefined);
    }
    if (active.record.lifecycle === 'triaging' || (active.record.lifecycle === 'safe-halt' && !active.record.routeReceipt)) {
      changes.routeExecution = undefined;
      changes.routeReceipt = undefined;
    }
    active = await this.persist(active, changes);
    if (!retainIntent) active = await this.confirmEffect(active);
    return publicOutcome(terminalOutcome);
  }

  private async preClaimInternal(code: string, issueNumber: number): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: `issue-${issueNumber}`, code, summary: code });
    return { status: 'internal-error', evidencePath: evidence.path };
  }

  private async preClaimCancelled(issueNumber: number): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: `issue-${issueNumber}`, code: 'cancelled', summary: 'Cancelled.' });
    return { status: 'cancelled', evidencePath: evidence.path };
  }

  private async preClaimTransport(
    issueNumber: number,
    code = 'issue-read-failed',
    summary = 'Issue read failed.',
  ): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: `issue-${issueNumber}`, code, summary });
    return { status: 'transport-failed', resumable: true, evidencePath: evidence.path };
  }

  private timestamp(): string {
    const value = this.dependencies.now();
    if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('runtime clock is invalid');
    return value;
  }
}

class TransportReadError extends Error {}
class LaunchAuthorizationRevokedError extends Error {
  constructor(readonly active: ActiveRun) {
    super('launch authorization revoked');
  }
}
class PostEffectStateError extends Error {
  constructor(readonly active: ActiveRun) {
    super('post-effect state write failed');
  }
}
function lifecycleForAttempt(operationId: string): RunRecord['lifecycle'] {
  if (operationId === 'triage') return 'triaging';
  if (operationId === 'configured-check') return 'checking';
  if (operationId === 'acceptance-proof') return 'proving';
  return 'implementing';
}
function findRun(state: RunStateFile, runId: string): RunRecord {
  const record = state.runs.find((candidate) => candidate.runId === runId);
  if (!record) throw new Error('persisted run is missing');
  return record;
}
interface ConfiguredCheckAttemptResult {
  schema: 'codex-orchestrator.configured-check-result';
  id: string;
  command: string;
  status: 'passed' | 'failed';
  outputBase64: string;
  outputSha256: string;
}

function configuredCheckAttemptBytes(input: {
  id: string;
  command: string;
  status: 'passed' | 'failed';
  output: Buffer;
}): Buffer {
  return Buffer.from(`${canonicalJson({
    schema: 'codex-orchestrator.configured-check-result',
    id: input.id,
    command: input.command,
    status: input.status,
    outputBase64: input.output.toString('base64'),
    outputSha256: sha256(input.output),
  })}\n`, 'utf8');
}

function parseTerminalSeedSummary(summary: string): TerminalSeed {
  const value = parseJsonWithoutDuplicateKeys(summary);
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonicalJson(value) !== summary) {
    throw new Error('outcome evidence terminal seed is invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const exact = (expected: string[]) => keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
  if (record.status === 'review-ready'
    && typeof record.pullRequestUrl === 'string'
    && (record.continuationEpoch === undefined || typeof record.continuationEpoch === 'string')
    && exact(record.continuationEpoch === undefined ? ['pullRequestUrl', 'status'] : ['continuationEpoch', 'pullRequestUrl', 'status'])) {
    return record as unknown as Extract<TerminalSeed, { status: 'review-ready' }>;
  }
  if (record.status === 'blocked' && ['external', 'safety', 'exhausted'].includes(record.kind as string)
    && typeof record.resumable === 'boolean' && exact(['kind', 'resumable', 'status'])) {
    return record as unknown as Extract<TerminalSeed, { status: 'blocked' }>;
  }
  if (record.status === 'transport-failed' && typeof record.resumable === 'boolean' && exact(['resumable', 'status'])) {
    return record as unknown as Extract<TerminalSeed, { status: 'transport-failed' }>;
  }
  if (record.status === 'cancelled' && exact(['status'])) return { status: 'cancelled' };
  if (record.status === 'internal-error' && typeof record.code === 'string' && record.code.length > 0 && exact(['code', 'status'])) {
    return record as unknown as Extract<TerminalSeed, { status: 'internal-error' }>;
  }
  throw new Error('outcome evidence terminal seed is invalid');
}

function validateConfiguredCheckAttemptBytes(
  bytes: Buffer,
  expected: { id: string; command: string },
): ConfiguredCheckAttemptResult & { output: Buffer } {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\n')) throw new Error('configured check result bytes are invalid');
  const value = parseJsonWithoutDuplicateKeys(text.slice(0, -1));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('configured check result is invalid');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ['command', 'id', 'outputBase64', 'outputSha256', 'schema', 'status'].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('configured check result must contain exact keys');
  }
  if (record.schema !== 'codex-orchestrator.configured-check-result'
    || record.id !== expected.id || record.command !== expected.command
    || (record.status !== 'passed' && record.status !== 'failed')
    || typeof record.outputBase64 !== 'string' || typeof record.outputSha256 !== 'string') {
    throw new Error('configured check result identity is invalid');
  }
  const output = Buffer.from(record.outputBase64, 'base64');
  if (output.toString('base64') !== record.outputBase64 || sha256(output) !== record.outputSha256) {
    throw new Error('configured check output identity is invalid');
  }
  if (!bytes.equals(configuredCheckAttemptBytes({
    id: record.id,
    command: record.command,
    status: record.status,
    output,
  }))) throw new Error('configured check result bytes are not canonical');
  return { ...(record as unknown as ConfiguredCheckAttemptResult), output };
}

function sameCheckPolicy(checks: RunRecord['checks'], policy: Record<string, string>): boolean {
  const expected = Object.entries(policy).sort(([left], [right]) => left.localeCompare(right));
  const actual = checks.map((check) => [check.id, check.command] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return actual.length === expected.length
    && actual.every(([id, command], index) => id === expected[index]?.[0] && command === expected[index]?.[1]);
}

function sameFreshness(
  left: Omit<CheckedChangeFreshness, 'checkPolicySha256'>,
  right: Omit<CheckedChangeFreshness, 'checkPolicySha256'>,
): boolean {
  return left.headSha === right.headSha
    && left.indexTreeSha === right.indexTreeSha
    && left.trackedContentSha256 === right.trackedContentSha256
    && left.untrackedContentSha256 === right.untrackedContentSha256
    && left.worktreeIdentity === right.worktreeIdentity;
}

function expectedImplementationHead(record: RunRecord): string {
  return record.reviewFeedback?.activeBatch?.priorPublishedHeadSha ?? record.baseSha;
}

function pendingCandidateBoundary(record: RunRecord): CandidateBoundaryV2 | undefined {
  if (record.lifecycle !== 'implementing') return undefined;
  const feedback = record.reviewFeedback;
  if (feedback?.activeBatch && feedback.repairRound >= 1 && feedback.repairRound <= 3) {
    return {
      kind: 'review-feedback',
      batchId: feedback.activeBatch.batchId,
      repairRound: feedback.repairRound as 1 | 2 | 3,
      authoritySha256: record.deliveryAuthority!.authoritySha256,
    };
  }
  return { kind: 'implementation-cycle', cycle: record.cycle, authoritySha256: record.deliveryAuthority!.authoritySha256 };
}

function commentsWithMarker(issue: RunIssueSnapshot, marker: string): Array<{ body: string; authorAssociation: string }> {
  return issue.comments.filter((comment) => comment.body.split('\n')[0] === marker);
}

function frozenQuestionProjection(receipt: FrozenSpecQuestionReceiptV1, evidencePath: string): RunIssueResult {
  return { status: 'spec-frozen', receipt: structuredClone(receipt), evidencePath };
}

function specQuestionBody(receipt: FrozenSpecQuestionReceiptV1): string {
  return [
    receipt.marker,
    `Spec revision: ${receipt.revisionSha256}`,
    `Decision gaps: ${canonicalJson(receipt.decisionGaps)}`,
    receipt.question,
    `Reply with: ${receipt.answerPrefix} <answer>`,
    `Evidence: ${receipt.evidencePath}`,
  ].join('\n');
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function worktreeCreationFailureSummary(error: unknown): string {
  return boundedLocalGitFailureSummary(
    'Local Git worktree creation failed; correct the local Git state and retry the same run.',
    error,
  );
}

function claimedWorktreeInspectionFailureSummary(error: unknown): string {
  return boundedLocalGitFailureSummary(
    'The claimed worktree could not be inspected; correct or preserve the local artifact and retry the same run.',
    error,
  );
}

function boundedLocalGitFailureSummary(prefix: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const diagnostic = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .trim();
  if (diagnostic.length === 0) return prefix;
  return `${prefix}\n${diagnostic.slice(0, 4 * 1024 - prefix.length - 1)}`;
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error('runId is invalid');
}

function assertGitSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw new Error(`${field} is invalid`);
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${field} is invalid`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) throw new Error(`${field} is invalid`);
}
