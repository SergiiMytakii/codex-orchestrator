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
import { canonicalJson, containsCredentialEvidence, containsHostIdentityEvidence, parseJsonWithoutDuplicateKeys, sha256 } from './containment.js';
import { findDeniedPathMatch } from './adapters/path-policy.js';
import {
  adoptActiveAttempt,
  confirmActiveAttemptCleanup,
  createActiveAttempt,
  launchActiveAttempt,
  observeActiveAttempt,
  type AttemptProcessIdentity,
  type ProcessStartIdentity,
} from './active-attempt.js';
import { validateImplementationReport, type ImplementationReportV1 } from './implementation-report.js';
import { validateCompletedReport } from './contained-report-operation.js';
import {
  directReviewCandidateTargetFingerprint,
  projectTerminalDirectReview,
} from './direct-delivery.js';
import type { ImplementationReviewerInput, ImplementationReviewerResult } from './implementation-reviewer.js';
import { CandidateProofInspectionError, ProofLaunchAuthorizationError, type FrozenCriterion, type IssueSnapshot, type ProveChangeResult } from './acceptance-proof.js';
import { CheckProcessQuiescenceError, resolveIssueCheckPolicy } from './issue-check-policy.js';
import type { ProofReceipt } from './proof-report.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import {
  IssueInitializationUnrecoverableError,
  WorkflowGenerationUnrecoverableError,
} from './run-store.js';
import type {
  PendingEffect,
  PendingEffectInput,
  RunRecord,
  RunRecordWriter,
  RunStateInspection,
  RunStateFile,
  RunTerminalOutcome,
  TerminalNotificationStateV1,
  TerminalReportSnapshotV1,
} from './run-store.js';
import { createPendingEffect } from './run-store.js';
import type { ReviewFeedbackObserver } from './review-feedback-coordinator.js';
import {
  blockReviewFeedback,
  initializeReviewFeedback,
  projectReviewFeedbackBatch,
  publishReviewFeedback,
  respondReviewFeedback,
  reserveNextReviewFeedbackRound,
  settleReviewFeedbackResponse,
} from './review-feedback.js';
import type { CandidateGitV2 } from './candidate.js';
import type { CandidateBindingV2, CandidateBoundaryV2, CandidateMaterializationV2 } from './candidate.js';
import { createIssueDeliveryAuthority, type DeliveryAuthority } from './delivery-authority.js';
import {
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
  refreshClaimedIssueSnapshot,
  snapshotIssue,
  sameInspectionIdentity,
  sameStrings,
  semanticChangesMatch,
} from './run-state-projections.js';
import {
  applyValidationTransition,
  nextValidationTransition,
  projectValidationFeedbackActivation,
  projectValidationProofPassed,
  projectValidationProofStart,
  projectValidationRepair,
  projectValidationReviewApproved,
  projectValidationReviewNeedsWork,
  projectValidationReviewReportRepair,
  projectValidationReviewStart,
  projectValidationReviewTransportRetry,
  type ValidationCasTransition,
} from './validation-progression.js';
import {
  settleCommentEffect,
  settleCommitEffect,
  settleCleanupEffect,
  settleDraftPullRequestEffect,
  settleLabelsEffect,
  settlePushEffect,
} from './pending-effect-settlement.js';

export type RunIssueResult =
  | { status: 'state-schema-unsupported' }
  | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string; continuationEpoch?: string }
  | { status: 'repair-ready'; source: 'check' | 'proof' | 'review'; blockerIds: string[]; evidencePath: string }
  | { status: 'not-eligible'; reason: string; evidencePath: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'decision-delta' | 'out-of-scope' | 'authority-boundary'; resumable: boolean; evidencePath: string; blocker?: { kind: string; summary: string; attempted: string[]; resumable: boolean; reviewerRejectionDetail?: string } }
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
  diffTrees(worktreePath: string, previousTreeSha: string, candidateTreeSha: string): Promise<{
    changedFiles: string[];
    patch: string;
  }>;
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

interface ReviewValidationScope {
  mode: 'complete' | 'targeted';
  repairPatch: string | null;
  targetPatch: string;
  changedFiles: string[];
  checks: Record<string, string>;
  criteria: FrozenCriterion[];
  impactTargets: string[];
}

export type ImplementationAgentResult =
  | { kind: 'completed'; report: unknown; attemptId?: string }
  | { kind: 'transport-failed'; resumable: boolean }
  | { kind: 'cancelled' }
  | { kind: 'internal-error' }
  | { kind: 'safe-halt' };

export interface AttemptCleanupIdentity {
  runId: string;
  attemptId: string;
  resultPath: string;
}

export interface RunIssueDependencies {
  readConfig(targetRoot: string): Promise<{ bytes: Buffer; config: AgentAutoConfig }>;
  ownerLock: {
    acquire(input: { canonicalRepository: string; targetRoot: string }): Promise<{ release(): Promise<void> }>;
  };
  issues: {
    read(issueNumber: number): Promise<RunIssueSnapshot | undefined>;
    setLabels(issueNumber: number, labels: string[]): Promise<void>;
    reconcileTerminalLabels?(issueNumber: number, labels: {
      outcome: 'review-ready' | 'blocked' | 'internal-error' | 'cancelled'; add: string[]; remove: string[];
    }): Promise<void>;
    postComment(issueNumber: number, body: string): Promise<void>;
    getRepositoryPermission?(login: string, expectedUserId: string): Promise<{ permission: 'none' | 'read' | 'write' | 'admin'; checkedAt: string; userId: string }>;
  };
  pullRequests: {
    findOpen(input: { headBranch: string; baseBranch: string }): Promise<{
      url: string; body: string; number?: number; nodeId?: string; headSha?: string;
      headRefName?: string; baseRefName?: string;
    } | undefined>;
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
      deliveryAuthority: DeliveryAuthority;
      cycle: number;
      reworkFindings: string[];
      repairOnly: boolean;
      workflowGeneration: WorkflowGenerationReceipt;
      reviewFeedbackRound?: number;
      reviewFeedback?: Array<{ id: string; sourceUrl: string; path: string | null; line: number | null; body: string }>;
      reviewFeedbackPullRequest?: { number: number; headSha: string; headRefName: string; url: string };
      onPrepared?: (input: { attemptId: string; reportPath: string; preparedAt: string; baseline: Omit<CheckedChangeFreshness, 'checkPolicySha256'> }) => Promise<void>;
      onLaunched?: (input: { attemptId: string; pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
      signal: AbortSignal;
    }): Promise<ImplementationAgentResult>;
  };
  implementationReviewer: {
    run(input: ImplementationReviewerInput): Promise<ImplementationReviewerResult>;
  };
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
  observeAttemptCleanup(identity: AttemptCleanupIdentity): Promise<'confirmed' | 'pending'>;
  writeAttemptResult(input: { path: string; bytes: Buffer; sha256: string }): Promise<void>;
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
  | { status: 'blocked'; kind: 'external' | 'safety' | 'decision-delta' | 'out-of-scope' | 'authority-boundary'; resumable: boolean; blocker?: { kind: string; summary: string; attempted: string[]; resumable: boolean; reviewerRejectionDetail?: string } }
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
      const effect = active.record.pendingEffect;
      if (effect.issueNumber !== issueNumber || effect.marker !== marker || effect.bodySha256 !== sha256(body)) {
        return { result: await this.publicationDiverged(active, 'claim-comment-pendingEffect-diverged') };
      }
      const settlement = await settleCommentEffect(effect, {
        observe: async () => {
          observation = await this.readIssue(issueNumber);
          const comments = observation ? commentsWithMarker(observation, marker) : [];
          if (comments.length === 0) return 'absent';
          return comments.length === 1 && comments[0]!.body === body
            && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comments[0]!.authorAssociation)
            ? 'confirmed' : 'diverged';
        },
        invoke: () => this.dependencies.issues.postComment(issueNumber, body),
      });
      if (settlement.status === 'unknown') {
        return { result: await this.invokedFailure(active, 'claim-comment-delivery-unknown') };
      }
      if (settlement.status !== 'confirmed') {
        return { result: await this.publicationDiverged(active, 'claim-comment-observation-diverged') };
      }
      active = await this.confirmEffect(active);
    }

    observation = await this.readIssue(issueNumber);
    if (!observation || observation.state !== 'OPEN' || !this.hasTrustedClaim(observation, active.record)) {
      return { result: await this.publicationDiverged(active, 'claim-comment-observation-diverged') };
    }
    if (claimLabelProjectionSettled(observation.labels, config)) return { active };
    const labels = new Set(observation.labels);
    if (!labels.has(config.github.labels.auto.name)
      || labels.has(config.github.labels.blocked.name)
      || labels.has(config.github.labels.review.name)) {
      return { result: await this.publicationDiverged(active, 'claim-labels-diverged') };
    }
    if (!active.record.pendingEffect) {
      active = await this.persist(active, { pendingEffect: { kind: 'claim-labels', issueNumber, expected: expectedLabels } });
    }
    if (active.record.pendingEffect?.kind !== 'claim-labels'
      || active.record.pendingEffect.issueNumber !== issueNumber
      || !sameStrings(active.record.pendingEffect.expected, expectedLabels)) {
      return { result: await this.publicationDiverged(active, 'claim-labels-pendingEffect-diverged') };
    }
    const labelSettlement = await settleLabelsEffect(active.record.pendingEffect, {
      observe: async () => {
        observation = await this.readIssue(issueNumber);
        if (!observation || !this.hasTrustedClaim(observation, active.record)) return 'diverged';
        return claimLabelProjectionSettled(observation.labels, config) ? 'confirmed' : 'absent';
      },
      invoke: () => this.dependencies.issues.setLabels(issueNumber, expectedLabels),
    });
    if (labelSettlement.status === 'unknown') {
      return { result: await this.invokedFailure(active, 'claim-labels-delivery-unknown') };
    }
    if (labelSettlement.status !== 'confirmed') {
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
      if (active.record.pendingEffect?.kind === 'candidate-pin-release') {
        const cleaned = await this.settleCandidatePinRelease(active, candidateBinding, {
          kind: 'initial-push', branch: branchName, sha: commitSha,
        });
        if ('status' in cleaned) return cleaned;
        active = cleaned;
      } else {
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
      const settlement = await settleCommitEffect(pendingEffect, {
        observe: async () => {
          const observed = await candidate.createOrObserveCommit({
            worktreePath, branchName, parentSha: pendingEffect.parentSha, treeSha: pendingEffect.treeSha,
            message: pendingEffect.message, candidateRef: pendingEffect.candidateRef!, observeOnly: true,
          });
          if (observed.kind === 'failed') throw new Error(observed.code);
          return observed.value.kind === 'created-or-observed' ? 'confirmed'
            : observed.value.kind === 'parent-unchanged' ? 'absent' : 'diverged';
        },
        authorize: async () => !this.signal.aborted && await this.authorized(active, config),
        invoke: async () => {
          const invoked = await candidate.createOrObserveCommit({
            worktreePath, branchName, parentSha: pendingEffect.parentSha, treeSha: pendingEffect.treeSha,
            message: pendingEffect.message, candidateRef: pendingEffect.candidateRef!,
          });
          if (invoked.kind === 'failed') throw new Error(invoked.code);
        },
      });
      if (settlement.status === 'unauthorized') {
        return this.persistRetainedCommitIntentTerminal(active, this.signal.aborted
          ? 'candidate-publication-cancelled' : 'candidate-publication-authority-revoked');
      }
      if (settlement.status === 'unknown') {
        return this.invokedFailure(active, 'candidate-ref-update-unknown', 'Candidate commit outcome is unknown; retain and observe the exact commit effect.');
      }
      if (settlement.status !== 'confirmed') return this.persistRetainedCommitIntentTerminal(active, 'candidate-branch-diverged');
      commitSha = await this.dependencies.git.getHead(worktreePath);
      const normalized = await candidate.normalizeSharedIndex({ worktreePath, expectedHeadSha: commitSha });
      if (normalized.kind === 'failed') return this.mapCandidateFailure(active, normalized.code);
      const residual = await this.dependencies.git.listChangedFilesIgnoringUntrackedRoot(worktreePath, config.proof.artifactDir);
      if (residual.length > 0) return this.persistRetainedCommitIntentTerminal(active, 'candidate-residual-worktree-drift');
      const cleaned = await this.settleCandidatePinRelease(active, candidateBinding, {
        kind: 'initial-push', branch: branchName, sha: commitSha,
      });
      if ('status' in cleaned) return cleaned;
      active = cleaned;
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
        const settlement = await settleCommitEffect(pendingEffect, {
          observe: async () => {
            const observed = await this.dependencies.git.inspectHead(worktreePath);
            if (observed.parentSha === pendingEffect.parentSha && observed.treeSha === pendingEffect.treeSha
              && observed.message === pendingEffect.message) return 'confirmed';
            if (observed.sha === pendingEffect.parentSha) {
              return await this.dependencies.git.getTreeSha(worktreePath) === pendingEffect.treeSha ? 'absent' : 'diverged';
            }
            return 'diverged';
          },
          authorize: async () => !this.signal.aborted && await this.authorized(active, config),
          invoke: async () => { await this.dependencies.git.commit({ worktreePath, message: pendingEffect.message }); },
        });
        if (settlement.status === 'unauthorized') {
          return this.signal.aborted
            ? await this.terminal(await this.confirmEffect(active), { status: 'cancelled' })
            : await this.revoked(active);
        }
        if (settlement.status === 'unknown') return await this.invokedFailure(active, 'commit-delivery-unknown');
        if (settlement.status !== 'confirmed') {
          return await this.publicationDiverged(active, 'commit-observation-diverged');
        }
        commitSha = await this.dependencies.git.getHead(worktreePath);
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
      const settlement = await settlePushEffect(pendingEffect, {
        observe: async () => {
          const remoteSha = await this.dependencies.git.getRemoteBranchSha(worktreePath, branchName);
          return remoteSha === commitSha ? 'confirmed' : remoteSha ? 'diverged' : 'absent';
        },
        authorize: async () => !this.signal.aborted && await this.authorized(active, config),
        invoke: () => this.dependencies.git.push({ worktreePath, branchName }),
      });
      if (settlement.status === 'unauthorized') {
        return this.signal.aborted
          ? await this.terminal(await this.confirmEffect(active), { status: 'cancelled' })
          : await this.revoked(active);
      }
      if (settlement.status === 'unknown') return await this.invokedFailure(active, 'push-delivery-unknown');
      if (settlement.status !== 'confirmed') return await this.publicationDiverged(active, 'push-observation-diverged');
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
      const pendingEffect = active.record.pendingEffect;
      if (pendingEffect?.kind !== 'draft-pr' || pendingEffect.owner !== config.github.owner
        || pendingEffect.repo !== config.github.repo || pendingEffect.head !== branchName
        || pendingEffect.base !== config.github.baseBranch || pendingEffect.issueNumber !== issueNumber
        || pendingEffect.marker !== prMarker) {
        return this.publicationDiverged(active, 'pr-pendingEffect-diverged');
      }
      const settlement = await settleDraftPullRequestEffect(pendingEffect, {
        observe: async () => {
          const observed = await this.dependencies.pullRequests.findOpen({ headBranch: branchName, baseBranch: config.github.baseBranch });
          return !observed ? 'absent' : observed.body === prBody ? 'confirmed' : 'diverged';
        },
        authorize: async () => !this.signal.aborted && await this.authorized(active, config),
        invoke: async () => {
          await this.dependencies.pullRequests.createDraft({
            title: `Implement #${issueNumber}: ${issue.title}`,
            body: prBody,
            headBranch: branchName,
            baseBranch: config.github.baseBranch,
          });
        },
      });
      if (settlement.status === 'unauthorized') {
        return this.signal.aborted
          ? await this.terminal(await this.confirmEffect(active), { status: 'cancelled' })
          : await this.revoked(active);
      }
      if (settlement.status === 'unknown') return await this.invokedFailure(active, 'pr-delivery-unknown');
      if (settlement.status !== 'confirmed') return await this.publicationDiverged(active, 'pr-observation-diverged');
      active = await this.confirmEffect(active);
    }
    const pullRequest = await this.dependencies.pullRequests.findOpen({ headBranch: branchName, baseBranch: config.github.baseBranch });
    if (!pullRequest || pullRequest.body !== prBody) return await this.publicationDiverged(active, 'pr-missing-before-handoff');

    return this.terminal(active, {
      status: 'review-ready', pullRequestUrl: pullRequest.url, continuationEpoch: commitSha,
    }, 'review-ready', {
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
      if (active.record.pendingEffect?.kind === 'candidate-pin-release') {
        const cleaned = await this.settleCandidatePinRelease(active, candidateBinding, {
          kind: 'review-update-push', batchId: batch.batchId, branch: active.record.branchName,
          priorRemoteSha: oldHead, sha: head, treeSha: candidateBinding.candidateTreeSha,
        });
        if ('status' in cleaned) return cleaned;
        active = cleaned;
      } else {
      if (!active.record.pendingEffect) {
        const recaptured = await candidate.captureAndPin({
          worktreePath: active.record.worktreePath,
          expectedHeadSha: oldHead,
          runId: active.record.runId,
          boundary: {
            kind: 'review-feedback', batchId: batch.batchId,
            repairRound: feedback.repairRound,
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
      let authorizationValidation: Awaited<ReturnType<ReviewFeedbackObserver['revalidate']>> | undefined;
      const settlement = await settleCommitEffect(pendingEffect, {
        observe: async () => {
          const observed = await candidate.createOrObserveCommit({
            worktreePath: active.record.worktreePath, branchName: active.record.branchName,
            parentSha: pendingEffect.parentSha, treeSha: pendingEffect.treeSha,
            message: pendingEffect.message, candidateRef: pendingEffect.candidateRef!, observeOnly: true,
          });
          if (observed.kind === 'failed') throw new Error(observed.code);
          return observed.value.kind === 'created-or-observed' ? 'confirmed'
            : observed.value.kind === 'parent-unchanged' ? 'absent' : 'diverged';
        },
        authorize: async () => {
          if (!await this.authorized(active, config)) return false;
          authorizationValidation = await coordinator.revalidate({ batch, issueNumber, epoch: 'pre-update', expectedHeadSha: oldHead });
          return authorizationValidation.status === 'valid';
        },
        invoke: async () => {
          const invoked = await candidate.createOrObserveCommit({
            worktreePath: active.record.worktreePath, branchName: active.record.branchName,
            parentSha: pendingEffect.parentSha, treeSha: pendingEffect.treeSha,
            message: pendingEffect.message, candidateRef: pendingEffect.candidateRef!,
          });
          if (invoked.kind === 'failed') throw new Error(invoked.code);
        },
      });
      if (settlement.status === 'unauthorized') {
        if (authorizationValidation?.status === 'retryable') {
          return this.invokedFailure(active, 'review-feedback-precommit-revalidation-failed-retryable');
        }
        active = await this.confirmEffect(active);
        if (authorizationValidation) {
          const failure = await this.mapFeedbackRevalidation(active, authorizationValidation, 'review-feedback-precommit-revalidation-failed');
          if (failure) return failure;
        }
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
      }
      if (settlement.status === 'unknown') {
        return this.invokedFailure(active, 'candidate-ref-update-unknown', 'Candidate update outcome is unknown; retain and observe the exact commit effect.');
      }
      if (settlement.status !== 'confirmed') return this.persistRetainedCommitIntentTerminal(active, 'candidate-branch-diverged');
      head = await this.dependencies.git.getHead(active.record.worktreePath);
      const normalized = await candidate.normalizeSharedIndex({ worktreePath: active.record.worktreePath, expectedHeadSha: head });
      if (normalized.kind === 'failed') return this.mapCandidateFailure(active, normalized.code);
      if ((await this.dependencies.git.listChangedFilesIgnoringUntrackedRoot(active.record.worktreePath, config.proof.artifactDir)).length > 0) {
        return this.persistRetainedCommitIntentTerminal(active, 'candidate-residual-worktree-drift');
      }
      const cleaned = await this.settleCandidatePinRelease(active, candidateBinding, {
        kind: 'review-update-push', batchId: batch.batchId, branch: active.record.branchName,
        priorRemoteSha: oldHead, sha: head, treeSha: candidateBinding.candidateTreeSha,
      });
      if ('status' in cleaned) return cleaned;
      active = cleaned;
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
      let authorizationValidation: Awaited<ReturnType<ReviewFeedbackObserver['revalidate']>> | undefined;
      const settlement = await settleCommitEffect(pendingEffect, {
        observe: async () => {
          const observed = await this.dependencies.git.inspectHead(active.record.worktreePath);
          if (observed.parentSha === pendingEffect.parentSha && observed.treeSha === pendingEffect.treeSha
            && observed.message === pendingEffect.message) return 'confirmed';
          if (observed.sha === pendingEffect.parentSha) {
            return await this.dependencies.git.getTreeSha(active.record.worktreePath) === pendingEffect.treeSha ? 'absent' : 'diverged';
          }
          return 'diverged';
        },
        authorize: async () => {
          if (!await this.authorized(active, config)) return false;
          authorizationValidation = await coordinator.revalidate({ batch, issueNumber, epoch: 'pre-update', expectedHeadSha: oldHead });
          return authorizationValidation.status === 'valid';
        },
        invoke: async () => {
          await this.dependencies.git.commit({ worktreePath: active.record.worktreePath, message: pendingEffect.message });
        },
      });
      if (settlement.status === 'unauthorized') {
        if (authorizationValidation?.status === 'retryable') {
          return this.invokedFailure(active, 'review-feedback-precommit-revalidation-failed-retryable');
        }
        active = await this.confirmEffect(active);
        if (authorizationValidation) {
          const failure = await this.mapFeedbackRevalidation(active, authorizationValidation, 'review-feedback-precommit-revalidation-failed');
          if (failure) return failure;
        }
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
      }
      if (settlement.status === 'unknown') return this.invokedFailure(active, 'review-feedback-commit-delivery-unknown');
      if (settlement.status === 'diverged') {
        return this.blockReviewFeedback(await this.confirmEffect(active), 'safety', 'review-feedback-commit-observation-diverged');
      }
      if (settlement.status !== 'confirmed') {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-commit-observation-diverged');
      }
      const commit = await this.dependencies.git.inspectHead(active.record.worktreePath);
      head = commit.sha;
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
      let authorizationValidation: Awaited<ReturnType<ReviewFeedbackObserver['revalidate']>> | undefined;
      const settlement = await settlePushEffect(pendingEffect, {
        observe: async () => {
          remote = await this.dependencies.git.getRemoteBranchSha(active.record.worktreePath, active.record.branchName);
          return remote === head ? 'confirmed' : remote === oldHead ? 'absent' : 'diverged';
        },
        authorize: async () => {
          if (!await this.authorized(active, config)) return false;
          authorizationValidation = await coordinator.revalidate({ batch, issueNumber, epoch: 'pre-update', expectedHeadSha: oldHead });
          return authorizationValidation.status === 'valid';
        },
        invoke: () => this.dependencies.git.push({
          worktreePath: active.record.worktreePath,
          branchName: active.record.branchName,
        }),
      });
      if (settlement.status === 'unauthorized') {
        if (authorizationValidation?.status === 'retryable') {
          return this.invokedFailure(active, 'review-feedback-prepush-revalidation-failed-retryable');
        }
        active = await this.confirmEffect(active);
        if (authorizationValidation) {
          const failure = await this.mapFeedbackRevalidation(active, authorizationValidation, 'review-feedback-prepush-revalidation-failed');
          if (failure) return failure;
        }
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
      }
      if (settlement.status === 'unknown') return this.invokedFailure(active, 'review-feedback-push-delivery-unknown');
      if (settlement.status === 'diverged') {
        return this.blockReviewFeedback(await this.confirmEffect(active), 'safety', 'review-feedback-push-observation-diverged');
      }
      if (settlement.status !== 'confirmed') {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-push-observation-diverged');
      }
      active = await this.confirmEffect(active);
    }

    const postPush = await coordinator.revalidate({ batch, issueNumber, epoch: 'post-push', expectedHeadSha: head });
    const postPushFailure = await this.mapFeedbackRevalidation(active, postPush, 'review-feedback-postpush-revalidation-failed');
    if (postPushFailure) return postPushFailure;
    const marker = `<!-- codex-orchestrator:run:${active.record.runId}:review-feedback:${batch.batchId} -->`;
    const body = [
      marker,
      '',
      `Addressed frozen review feedback batch ${batch.batchId}.`,
      `Updated head: ${head}`,
      `${active.record.directReview?.previousTarget ? 'Targeted' : 'Complete'} independent review, configured checks, and Acceptance Proof passed.`,
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
      let authorizationValidation: Awaited<ReturnType<ReviewFeedbackObserver['revalidate']>> | undefined;
      let matches: Array<{ id: string; body: string }> = [];
      const settlement = await settleCommentEffect(pendingEffect, {
        observe: async () => {
          matches = (await this.dependencies.pullRequests.listConversationComments!(batch.pullRequest.number))
            .filter((comment) => comment.body.split('\n')[0] === marker);
          if (matches.length === 0) return 'absent';
          return matches.length === 1 && matches[0]!.body === body ? 'confirmed' : 'diverged';
        },
        authorize: async () => {
          if (!await this.authorized(active, config)) return false;
          authorizationValidation = await coordinator.revalidate({ batch, issueNumber, epoch: 'post-push', expectedHeadSha: head });
          return authorizationValidation.status === 'valid';
        },
        invoke: async () => {
          await this.dependencies.pullRequests.postConversationComment!(batch.pullRequest.number, body);
        },
      });
      if (settlement.status === 'unauthorized') {
        if (authorizationValidation?.status === 'retryable') {
          return this.invokedFailure(active, 'review-feedback-summary-revalidation-failed-retryable');
        }
        active = await this.confirmEffect(active);
        if (authorizationValidation) {
          const failure = await this.mapFeedbackRevalidation(active, authorizationValidation, 'review-feedback-summary-revalidation-failed');
          if (failure) return failure;
        }
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
      }
      if (settlement.status === 'unknown') return this.invokedFailure(active, 'review-feedback-summary-delivery-unknown');
      if (settlement.status === 'diverged') {
        return this.blockReviewFeedback(await this.confirmEffect(active), 'safety', 'review-feedback-summary-observation-diverged');
      }
      if (settlement.status !== 'confirmed') {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-summary-observation-diverged');
      }
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
      let authorizationValidation: Awaited<ReturnType<ReviewFeedbackObserver['revalidate']>> | undefined;
      const settlement = await settleLabelsEffect(pendingEffect, {
        observe: async () => {
          const issue = await this.readIssue(issueNumber);
          return !issue ? 'diverged' : sameStrings(managedLabelProjection(issue.labels, config), finalLabels) ? 'confirmed' : 'absent';
        },
        authorize: async () => {
          if (!await this.authorized(active, config)) return false;
          authorizationValidation = await coordinator.revalidate({ batch, issueNumber, epoch: 'post-push', expectedHeadSha: head });
          return authorizationValidation.status === 'valid';
        },
        invoke: () => this.dependencies.issues.setLabels(issueNumber, finalLabels),
      });
      if (settlement.status === 'unauthorized') {
        if (authorizationValidation?.status === 'retryable') {
          return this.invokedFailure(active, 'review-feedback-final-labels-revalidation-failed-retryable');
        }
        active = await this.confirmEffect(active);
        if (authorizationValidation) {
          const failure = await this.mapFeedbackRevalidation(active, authorizationValidation, 'review-feedback-final-labels-revalidation-failed');
          if (failure) return failure;
        }
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
      }
      if (settlement.status === 'unknown') return this.invokedFailure(active, 'review-feedback-final-labels-delivery-unknown');
      if (settlement.status === 'diverged') {
        return this.blockReviewFeedback(await this.confirmEffect(active), 'safety', 'review-feedback-final-labels-diverged');
      }
      if (settlement.status !== 'confirmed') {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-final-labels-diverged');
      }
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
    const pullRequest = await this.dependencies.pullRequests.findOpen({
      headBranch: active.record.branchName,
      baseBranch: config.github.baseBranch,
    });
    if (!pullRequest || pullRequest.number !== batch.pullRequest.number || pullRequest.nodeId !== batch.pullRequest.nodeId
      || pullRequest.headSha !== head) {
      return this.blockReviewFeedback(active, 'safety', 'review-feedback-published-pr-identity-diverged');
    }
    return this.terminal(active, {
      status: 'review-ready', pullRequestUrl: pullRequest.url, continuationEpoch: head,
    }, 'review-ready', {
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
      return { result: await this.terminal(starting, { status: 'blocked', kind: 'safety', resumable: false }, 'review-feedback-pr-identity-missing') };
    }
    if (pullRequest.url !== terminal.pullRequestUrl) {
      return { result: await this.terminal(starting, { status: 'blocked', kind: 'safety', resumable: false }, 'review-feedback-prior-handoff-identity-mismatch') };
    }
    const expectedHeadSha = feedback.previousPublishedHeadSha === null
      ? pullRequest.headSha
      : feedback.previousPublishedHeadSha;
    if (!expectedHeadSha) {
      return { result: await this.terminal(starting, { status: 'blocked', kind: 'safety', resumable: false }, 'review-feedback-head-missing') };
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
      ...(starting.record.terminalNotifications ? {
        issueCommentCutoff: {
          issueNumber: starting.record.issueNumber,
          ...starting.record.terminalNotifications.commentCutoff,
        },
      } : {}),
    });
    if (observed.status === 'retryable') return { result: await this.invokedFailure(starting, 'review-feedback-observation-retryable') };
    if (observed.status === 'blocked') {
      return { result: await this.terminal(starting, { status: 'blocked', kind: 'safety', resumable: false }, 'review-feedback-observation-blocked') };
    }
    let ready = starting;
    if (feedback.previousPublishedHeadSha === null) {
      const issueCommentBatch = observed.status === 'frozen'
        && observed.batch.sources.every((source) => source.kind === 'issue-comment');
      const sourceIds = observed.status === 'frozen' && !issueCommentBatch
        ? observed.batch.sources.map((source) => source.sourceId)
        : observed.status === 'none' ? observed.eligibleSourceIds : [];
      ready = await this.persist(starting, {
        reviewFeedback: initializeReviewFeedback(feedback, expectedHeadSha, sourceIds),
      });
      if (!issueCommentBatch) return { result: publicOutcome(ready.record.terminalOutcome!) };
    }
    const readyFeedback = ready.record.reviewFeedback!;
    if (readyFeedback.activeBatch || observed.status === 'none') return { result: publicOutcome(terminal) };

    if (!await this.authorizedForExactLabels(starting, [config.github.labels.review.name])) {
      return { result: publicOutcome(terminal) };
    }

    const projected = projectReviewFeedbackBatch(observed.batch, ready.record.directReview!.targetRevision);
    const candidateTreeSha = await this.dependencies.git.getTreeSha(ready.record.worktreePath);
    const activation = projectValidationFeedbackActivation(ready.record, {
      batch: observed.batch,
      repairFindings: projected.repairFindings,
      candidateTreeSha,
      pendingEffect: {
        kind: 'review-activation-labels',
        issueNumber: starting.record.issueNumber,
        batchId: observed.batch.batchId,
        expected: sortedUnique([config.github.labels.auto.name, config.github.labels.running.name]),
      },
    });
    if (observed.batch.sources.every((source) => source.kind === 'issue-comment')) {
      activation.changes.cycle = ready.record.cycle + 1;
      activation.changes.checks = structuredClone(ready.record.checks);
      activation.changes.checkedChangeSha256 = ready.record.checkedChangeSha256;
      activation.changes.proofId = ready.record.proofId;
      activation.changes.proofReceipt = structuredClone(ready.record.proofReceipt);
      activation.changes.implementationResult = structuredClone(ready.record.implementationResult);
      activation.changes.terminalNotifications = undefined;
    }
    const active = await this.persistValidationTransition(ready, activation);
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
    const activationEffect = pendingEffect?.kind === 'review-activation-labels' ? pendingEffect : undefined;
    if (pendingEffect && pendingEffect.kind !== 'continuation-worktree-create' && (!activationEffect
      || activationEffect.issueNumber !== active.record.issueNumber
      || activationEffect.batchId !== batch.batchId
      || !sameStrings(activationEffect.expected, runningLabels))) {
      return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-pendingEffect-diverged') };
    }
    const issue = await this.readIssue(active.record.issueNumber);
    const labelsAreRunning = !!issue && issue.state === 'OPEN' && sameStrings(managedLabelProjection(issue.labels, config), runningLabels)
      && this.hasTrustedClaim(issue, active.record);
    const labelsAreReview = !!issue && issue.state === 'OPEN' && sameStrings(managedLabelProjection(issue.labels, config), reviewLabels)
      && this.hasTrustedClaim(issue, active.record);
    if (!labelsAreRunning && !labelsAreReview) {
      return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-authority-revoked') };
    }
    const validation = await this.dependencies.reviewFeedback.revalidate({
      batch, issueNumber: active.record.issueNumber, epoch: 'pre-update', expectedHeadSha,
    });
    const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-activation-revalidation-failed');
    if (validationFailure) return { result: validationFailure };
    if (activationEffect) {
      const settlement = await settleLabelsEffect(activationEffect, {
        observe: async () => {
          const observed = await this.readIssue(active.record.issueNumber);
          if (!observed || !this.hasTrustedClaim(observed, active.record)) return 'diverged';
          if (sameStrings(managedLabelProjection(observed.labels, config), runningLabels)) return 'confirmed';
          return sameStrings(managedLabelProjection(observed.labels, config), reviewLabels) ? 'absent' : 'diverged';
        },
        invoke: () => this.dependencies.issues.setLabels(active.record.issueNumber, runningLabels),
      });
      if (settlement.status === 'unknown') {
        return { result: await this.invokedFailure(active, 'review-feedback-activation-labels-delivery-unknown') };
      }
      if (settlement.status === 'diverged') {
        return { result: await this.blockReviewFeedback(await this.confirmEffect(active), 'safety', 'review-feedback-activation-labels-diverged') };
      }
      if (settlement.status !== 'confirmed') {
        return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-labels-diverged') };
      }
      active = await this.confirmEffect(active);
    }
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
            active = await this.confirmEffect(observed.active);
            active = await this.settleTerminalNotificationsBestEffort(active);
            return publicOutcome(active.record.terminalOutcome!);
          }
          const seed = parseTerminalSeedSummary(active.record.pendingEffect.summary);
          return await this.terminal(active, seed, active.record.pendingEffect.code);
        }
        if (active.record.terminalOutcome && (active.record.terminalNotifications
          || active.record.pendingEffect?.kind === 'terminal-comment'
          || active.record.pendingEffect?.kind === 'terminal-labels')) {
          active = await this.settleTerminalNotificationsBestEffort(active);
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
            return publicOutcome(active.record.terminalOutcome);
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
        if (active.record.reviewFeedback?.activeBatch
          && (active.record.pendingEffect?.kind === 'review-activation-labels'
            || active.record.pendingEffect?.kind === 'continuation-worktree-create')) {
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
          let resumedSafeHalt = false;
          if (active.record.lifecycle === 'safe-halt') {
            const attempt = active.record.activeAttempt;
            if (!attempt || (attempt.stage !== 'launched' && attempt.stage !== 'observed')) {
              return await this.publicationDiverged(active, 'safe-halt-attempt-missing');
            }
            const reconciled = await this.reconcilePersistedAttempt(active);
            if ('status' in reconciled) return reconciled;
            active = reconciled.active;
            active = await this.persist(active, { lifecycle: lifecycleForAttempt(attempt.operationId) });
            resumedSafeHalt = true;
          }
          if (active.record.lifecycle === 'publishing') {
            return active.record.reviewFeedback?.activeBatch
              ? await this.updateExistingPullRequest(active, config, input.issueNumber)
              : await this.publish(active, config, issueSnapshot, input.issueNumber);
          }
          if (!['implementing', 'checking', 'proving', 'reviewing'].includes(active.record.lifecycle)) {
            return await this.terminal(active, { status: 'internal-error', code: 'resume-phase-not-reconciled' });
          }
          if (!await this.authorized(active, config)) return await this.revoked(active);
          {
            const preparedImplementationRecovery = active.record.lifecycle === 'implementing'
              && active.record.activeAttempt?.stage === 'prepared'
              && active.record.activeAttempt.operationId === 'implementation';
            const reviewRecovery = active.record.lifecycle === 'reviewing' && active.record.directReview?.status === 'active'
              && active.record.directReview.stage === 'review';
            const checkRecovery = active.record.lifecycle === 'checking';
            const proofRecovery = active.record.lifecycle === 'proving';
            const directReviewRepair = active.record.lifecycle === 'implementing'
              && active.record.directReview?.status === 'active'
              && active.record.directReview.stage === 'review-repair';
            const plannedRepairRecovery = active.record.lifecycle === 'implementing'
              && active.record.reworkFindings.length > 0;
            const attemptResultRecovery = active.record.activeAttempt?.stage === 'observed'
              && active.record.activeAttempt.result !== null;
            const implementationInfrastructureRecovery = active.record.lifecycle === 'implementing'
              && !active.record.activeAttempt
              && (active.record.transportRetries > 0 || active.record.reportRepairs > 0);
            if (!resumedSafeHalt && !preparedImplementationRecovery && !reviewRecovery && !checkRecovery
              && !proofRecovery && !directReviewRepair && !plannedRepairRecovery && !attemptResultRecovery
              && !implementationInfrastructureRecovery) {
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
      if (!active.record.deliveryAuthority) {
        return await this.terminal(active, { status: 'internal-error', code: 'delivery-authority-missing' });
      }
      if (!this.dependencies.git.candidateV2) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-git-v2-required');
      }
      attemptLoop: while (true) {
        if (!await this.authorized(active, config)) {
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'authorization-revoked');
        }
        if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });

      let progression = nextValidationTransition(active.record, active.record.deliveryAuthority!);
      const resumeAtChecks = progression.phase === 'checks' || progression.phase === 'acceptance-proof';
      if (progression.phase === 'review') {
        const reviewed = await this.runFullReview(
          active,
          publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          `implementation-owner:${active.record.runId}`,
          config,
        );
        if ('status' in reviewed) return reviewed;
        active = reviewed;
        if (active.record.lifecycle === 'implementing') continue attemptLoop;
        break;
      }

      if (!resumeAtChecks) {
        if (progression.phase !== 'implementation') {
          return await this.terminal(active, { status: 'internal-error', code: 'validation-progression-dispatch-invalid' });
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
          reviewFeedbackPullRequest: {
            number: feedbackBatch.pullRequest.number,
            headSha: feedbackBatch.pullRequest.headSha,
            headRefName: feedbackBatch.pullRequest.headRefName,
            url: `https://github.com/${active.record.canonicalRepository}/pull/${feedbackBatch.pullRequest.number}`,
          },
        } : {}),
        onPrepared: async (prepared: { attemptId: string; reportPath: string }) => {
          const currentActive = active!;
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
      const reportOnlyRecovery = active.record.reportRepairs > 0;
      const reportOnlyBaseline = reportOnlyRecovery ? await this.dependencies.git.snapshot(worktreePath) : null;
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
      let implementation: Awaited<ReturnType<RunIssueDependencies['implementationAgent']['run']>>;
      try {
        implementation = await this.dependencies.implementationAgent.run({
          operation: 'implementation',
          attemptId: implementationAttempt.attemptId,
          runId,
          worktreePath,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          deliveryAuthority: active.record.deliveryAuthority!,
          cycle: active.record.cycle,
          reworkFindings: reportOnlyRecovery
            ? ['Emit a schema-valid implementation report for the existing exact product result.']
            : active.record.reworkFindings,
          repairOnly: reportOnlyRecovery,
          workflowGeneration: active.record.workflowGeneration,
          signal: this.signal,
          ...implementationLaunch,
        });
      } catch (error) {
        if (implementationPreparationFailure) return implementationPreparationFailure;
        throw error;
      }
      if (implementationPreparationFailure) return implementationPreparationFailure;
      if (implementation.kind !== 'safe-halt') active = await this.observeReturnedAttempt(
        active, implementation.kind === 'completed' ? implementation.report : implementation,
      );
      if (implementation.kind === 'safe-halt') {
        active = await this.persist(active, { lifecycle: 'safe-halt' });
        return await this.invokedFailure(active, 'active-attempt-observation-deferred',
          'The implementation process remains unresolved; the next daemon tick will make one fresh bounded observation.');
      }
      if (await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths) !== deniedPathsBaseline) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'denied-path-modified');
      }
      if (implementation.kind === 'transport-failed' && implementation.resumable) {
        active = await this.clearAttempt(active);
        active = await this.persist(active, { transportRetries: active.record.transportRetries + 1 });
        return this.invokedFailure(active, 'implementation-transport-retryable',
          'Implementation infrastructure is temporarily unavailable; a later bounded invocation may retry.');
      }
      if (implementation.kind !== 'completed') return await this.mapImplementationFailure(active, implementation);
      if (reportOnlyBaseline && !sameFreshness(reportOnlyBaseline, await this.dependencies.git.snapshot(worktreePath))) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'report-repair-modified-worktree');
      }
      let report;
      try {
        report = validateImplementationReport(implementation.report);
      } catch {
        if (isAdoptableAttempt(active.record.activeAttempt)) {
          active = await this.adoptAttempt(active, sha256(canonicalJson(implementation.report)), { reportRepairs: active.record.reportRepairs + 1 });
          active = await this.clearAttempt(active);
        } else {
          active = await this.persist(active, { reportRepairs: active.record.reportRepairs + 1 });
        }
        return this.invokedFailure(active, 'implementation-report-retryable',
          'The implementation report was malformed; a later bounded invocation will retry report-only.');
      }
      if (report.status === 'external-block') {
        if (report.blocker!.resumable) {
          if (isAdoptableAttempt(active.record.activeAttempt)) {
            active = await this.adoptAttempt(active, sha256(canonicalJson(report)), {
              transportRetries: active.record.transportRetries + 1,
            });
          }
          active = await this.clearAttempt(active);
          return this.invokedFailure(active, 'implementation-external-block-retryable', report.blocker!.summary);
        }
        return await this.terminal(active, implementationBlockerOutcome(report.blocker!));
      }
      if (report.status === 'answer-only' || report.status === 'boundary') {
        return this.completeIssueFeedbackResponse(active, report as ImplementationReportV1 & {
          status: 'answer-only' | 'boundary'; response: string;
        }, config);
      }
      if (await this.dependencies.git.getHead(worktreePath) !== expectedImplementationHead(active.record)) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'implementation-head-drift');
      }
      const changedFiles = await this.dependencies.git.listChangedFiles(worktreePath);
      if (changedFiles.length === 0 || !sameStrings(changedFiles, report.changedFiles)) {
        if (changedFiles.length === 0) {
          return await this.terminal(active, { status: 'internal-error', code: 'implementation-change-set-invalid' });
        }
        if (isAdoptableAttempt(active.record.activeAttempt)) {
          active = await this.adoptAttempt(active, sha256(canonicalJson(implementation.report)), { reportRepairs: active.record.reportRepairs + 1 });
          active = await this.clearAttempt(active);
        } else {
          active = await this.persist(active, { reportRepairs: active.record.reportRepairs + 1 });
        }
        return this.invokedFailure(active, 'implementation-change-set-report-retryable',
          `The implementation report must describe the current exact change set ${canonicalJson(changedFiles)}; a later bounded invocation will retry report-only.`);
      }

      if (isAdoptableAttempt(active.record.activeAttempt)) {
        active = await this.adoptAttempt(active, sha256(canonicalJson(report)), {
          transportRetries: active.record.transportRetries,
          reportRepairs: 0,
          implementationResult: { summary: report.summary, residualRisks: report.residualRisks },
        });
        active = await this.clearAttempt(active);
      }

      const boundary = active.record.reviewFeedback?.activeBatch
          ? {
            kind: 'review-feedback' as const,
            batchId: active.record.reviewFeedback.activeBatch.batchId,
            repairRound: active.record.reviewFeedback.repairRound,
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
        active = await this.persist(active, { lifecycle: 'checking' });
      }
      progression = nextValidationTransition(active.record, active.record.deliveryAuthority!);
      if (progression.phase !== 'checks' && progression.phase !== 'acceptance-proof') {
        return await this.terminal(active, { status: 'internal-error', code: 'validation-progression-checks-invalid' });
      }
      let checkPolicy;
      try { checkPolicy = resolveIssueCheckPolicy(active.record.issueSnapshot.body, config.checks); }
      catch (error) {
        const detail = error instanceof Error ? error.message : 'Verification policy is invalid.';
        return await this.terminal(active, {
          status: 'blocked', kind: 'decision-delta', resumable: false,
          blocker: {
            kind: 'decision-delta',
            summary: 'The unchanged issue Verification policy is malformed or unsafe and cannot be executed as authority.',
            attempted: ['Parsed the issue Verification section against the configured command safety policy.'],
            resumable: false,
            reviewerRejectionDetail: detail,
          },
        }, 'issue-verification-invalid');
      }
      const finalBinding = active.record.candidateBinding;
      if (!finalBinding) return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-git-v2-required');
      let reviewScope: ReviewValidationScope;
      try {
        reviewScope = await this.reviewValidationScope(active, frozenCriteria, checkPolicy.checks, config.deny.readPaths);
      } catch (error) {
        return this.invokedFailure(active, 'review-target-unavailable', error instanceof Error ? error.message : undefined);
      }
      const configuredChecks = Object.entries(reviewScope.checks);
      const finalCheckPolicySha256 = sha256(canonicalJson(reviewScope.checks));
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
          const summary = `Check ${id} failed:\n${check.output.toString('utf8').slice(0, 8 * 1024)}`;
          const reopened = await this.startNextCycleFromCandidate(active, [summary], [{
            provenance: 'check', sourceId: `check:${id}:${row.outputSha256}`, summary,
            affectedContracts: ['configured-checks'],
          }]);
          if ('status' in reopened) return reopened;
          return this.semanticContinuation(reopened, 'check', [`check:${id}:${row.outputSha256}`],
            'The consolidated affected-check repair batch is ready for the next bounded invocation.');
        }
      }

      if (!sameCheckPolicy(active.record.checks, reviewScope.checks)) {
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
      active = await this.persistValidationTransition(active, projectValidationProofStart(active.record, {
        checkedChangeSha256,
        proofId,
        proofExecution: proofExecutionState,
      }));
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
      let proofSettledBeforeLaunch = false;
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
          frozenCriteria: reviewScope.criteria,
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
        if (active.record.activeAttempt?.stage === 'prepared') {
          const settled = await this.settleCandidateMaterialization(active, config, true);
          if ('status' in settled) return settled;
          active = settled.active;
          proofSettledBeforeLaunch = true;
        }
        if (proofLaunchFailure) return proofLaunchFailure;
        if (error instanceof ProofLaunchAuthorizationError) return error.outcome as RunIssueResult;
        if (error instanceof CandidateProofInspectionError) {
          return error.code === 'candidate-artifact-conflict'
            ? this.persistCandidateEvidenceSafetyTerminal(active, error.code)
            : this.mapCandidateFailure(active, error.code);
        }
        return proofSettledBeforeLaunch
          ? this.invokedFailure(active, 'acceptance-proof-pre-launch-retryable',
            'Acceptance Proof infrastructure failed before launch; a later bounded invocation may retry.')
          : this.terminal(active, { status: 'internal-error', code: 'acceptance-proof-internal-failure' });
      }
      if (proofLaunchFailure) return proofLaunchFailure;
      if (proof.status === 'safe-halt') {
        active = await this.persist(active, { lifecycle: 'safe-halt' });
        return await this.invokedFailure(active, 'active-attempt-observation-deferred',
          'The acceptance-proof process remains unresolved; the next daemon tick will make one fresh bounded observation.');
      }
      if (proof.status === 'passed') {
        if (!isAdoptableAttempt(active.record.activeAttempt)) {
          return this.persistCandidateEvidenceSafetyTerminal(active, 'proof-result-adoption-unconfirmed');
        }
        const targetFingerprint = directReviewCandidateTargetFingerprint({
          binding: active.record.candidateBinding!,
          deliveryAuthoritySha256: active.record.deliveryAuthority!.authoritySha256,
          workflowGenerationHash: active.record.workflowGeneration.generationHash,
          cycle: active.record.cycle,
          frozenCriteria,
        });
        const reviewerSessionId = this.dependencies.createReviewSessionId();
        assertNonEmptyString(reviewerSessionId, 'reviewerSessionId');
        active = await this.adoptValidationTransition(
          active,
          sha256(canonicalJson(proof)),
          projectValidationProofPassed(active.record, {
            checkedChangeSha256,
            proofId,
            proofReceipt: proof.receipt,
            verifiedAt: this.timestamp(),
            targetFingerprint,
            reviewerSessionId,
          }),
        );
      } else if (isAdoptableAttempt(active.record.activeAttempt)) {
        active = await this.adoptAttempt(active, sha256(canonicalJson(proof)), {});
      }
      const settledProofMaterialization = await this.settleCandidateMaterialization(active, config);
      if ('status' in settledProofMaterialization) return settledProofMaterialization;
      active = settledProofMaterialization.active;
      if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
      if (proof.status === 'report-repair') {
        active = await this.persist(active, { proofExecution: {
          ...proofExecutionState,
          reportRepairCount: proof.reportRepairCount,
          reportRepairFindings: [...proof.findings],
        } });
        return this.invokedFailure(active, 'acceptance-proof-report-retryable',
          'The Acceptance Proof report was malformed; a later bounded invocation may retry.');
      }
      if (proof.status === 'transport-failed' && proof.resumable) {
        active = await this.persist(active, { proofExecution: {
          ...proofExecutionState,
          transportRetryCount: proofExecutionState.transportRetryCount + 1,
        } });
        return this.invokedFailure(active, 'acceptance-proof-transport-retryable',
          'Acceptance Proof infrastructure is temporarily unavailable; a later bounded invocation may retry.');
      }
      if (proof.status === 'needs-rework') {
        const reopened = await this.startNextCycleFromCandidate(active, proof.findings, proof.findings.map((summary) => ({
          provenance: 'proof' as const,
          sourceId: `proof:${proofId}:${sha256(summary)}`,
          summary,
          affectedContracts: ['acceptance-proof'],
        })));
        if ('status' in reopened) return reopened;
        return this.semanticContinuation(reopened, 'proof', proof.findings.map((finding) => `proof:${proofId}:${sha256(finding)}`),
          'The consolidated Acceptance Proof repair batch is ready for the next bounded invocation.');
      }
      if (proof.status !== 'passed') return await this.mapProofFailure(active, proof);
      const reviewed = await this.runFullReview(
        active,
        publicIssueSnapshot(issueSnapshot),
        frozenCriteria,
        `implementation-owner:${active.record.runId}`,
        config,
        reviewScope,
      );
      if ('status' in reviewed) return reviewed;
      active = reviewed;
      if (active.record.lifecycle === 'implementing') continue attemptLoop;
      break;
      }

      const publicationTransition = nextValidationTransition(active.record, active.record.deliveryAuthority!);
      if (publicationTransition.phase !== 'publication') {
        return await this.terminal(active, { status: 'internal-error', code: 'validation-progression-publication-invalid' });
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
      if (active && error instanceof IssueInitializationUnrecoverableError) {
        const evidence = await this.dependencies.writeEvidence({
          runId: active.record.runId,
          code: 'issue-initialization-unrecoverable',
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
      ) {
      throw new IssueInitializationUnrecoverableError();
    }
    const [snapshot, changedFiles] = await Promise.all([
      this.dependencies.git.snapshot(active.record.worktreePath),
      this.dependencies.git.listChangedFiles(active.record.worktreePath),
    ]);
    if (snapshot.headSha !== active.record.baseSha || changedFiles.length !== 0) {
      throw new IssueInitializationUnrecoverableError();
    }
    try {
      await this.dependencies.verifyWorkflowGeneration(active.record.workflowGeneration);
    } catch {
      throw new IssueInitializationUnrecoverableError();
    }
    const issueSnapshot = issue?.state === 'OPEN'
      ? refreshClaimedIssueSnapshot(active.record.issueSnapshot, issue)
      : active.record.issueSnapshot;
    return this.persist(active, {
      lifecycle: 'implementing',
      deliveryAuthority: createIssueDeliveryAuthority({
        issueNumber: issueSnapshot.number,
        issueUrl: issueSnapshot.url,
        title: issueSnapshot.title,
        body: issueSnapshot.body,
        authorizationLabel: active.config.github.labels.auto.name,
      }),
      issueSnapshot,
    });
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
    if (Object.hasOwn(changes, 'terminalOutcome') && changes.terminalOutcome === undefined
      && !Object.hasOwn(changes, 'terminalNotifications')) delete record.terminalNotifications;
    for (const key of ['checkedChangeSha256', 'proofId', 'proofReceipt', 'terminalOutcome', 'outcomeEvidenceId', 'reviewFeedback', 'changeBindingVersion', 'candidateBinding', 'candidateMaterialization', 'activeAttempt', 'terminalNotifications'] as const) {
      if (Object.hasOwn(changes, key) && changes[key] === undefined) delete record[key];
    }
    const runs = active.state.runs.map((candidate) => candidate.runId === record.runId ? record : candidate);
    const saved = await this.dependencies.runRecords.compareAndSwap(active.state.generation, {
      schema: 'codex-orchestrator.run-state', runs,
    });
    return { state: saved, record: findRun(saved, record.runId), config: active.config };
  }

  private persistValidationTransition(
    active: ActiveRun,
    transition: ValidationCasTransition,
  ): Promise<ActiveRun> {
    return applyValidationTransition(
      active.record,
      transition,
      (changes) => this.persist(active, changes),
    );
  }

  private adoptValidationTransition(
    active: ActiveRun,
    resultSha256: string,
    transition: ValidationCasTransition,
  ): Promise<ActiveRun> {
    return applyValidationTransition(
      active.record,
      transition,
      (changes) => this.adoptAttempt(active, resultSha256, changes),
    );
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

  private async settleCandidatePinRelease(
    active: ActiveRun,
    binding: CandidateBindingV2,
    nextEffect: PendingEffectInput,
  ): Promise<ActiveRun | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    if (!candidate) return this.invokedFailure(active, 'candidate-git-v2-required');
    if (active.record.pendingEffect?.kind !== 'candidate-pin-release') {
      try {
        active = await this.persist(active, { pendingEffect: {
          kind: 'candidate-pin-release',
          bindingId: binding.bindingId,
          expectedPinnedCommitSha: binding.candidateCommitSha,
        } });
      } catch {
        throw new PostEffectStateError(active);
      }
    }
    const effect = active.record.pendingEffect;
    if (effect?.kind !== 'candidate-pin-release' || effect.bindingId !== binding.bindingId
      || effect.expectedPinnedCommitSha !== binding.candidateCommitSha) {
      return this.invokedFailure(active, 'candidate-pin-release-pendingEffect-diverged');
    }
    const settlement = await settleCleanupEffect(effect, {
      observe: async () => {
        const observed = await candidate.inspectPin(binding);
        if (observed.kind === 'failed') throw new Error(observed.code);
        return observed.value === 'missing' ? 'confirmed' : observed.value === 'matching' ? 'absent' : 'diverged';
      },
      invoke: async () => {
        const released = await candidate.releasePin({ binding, expectedPinnedCommitSha: binding.candidateCommitSha });
        if (released.kind === 'failed') throw new Error(released.code);
      },
    });
    if (settlement.status === 'unknown') {
      return this.invokedFailure(active, 'candidate-pin-release-unknown', 'Retain the exact candidate cleanup intent for observation.');
    }
    if (settlement.status !== 'confirmed') {
      return this.invokedFailure(active, 'candidate-pin-release-diverged', 'Candidate cleanup postcondition diverged from its exact intent.');
    }
    try {
      return await this.persist(active, {
        pendingEffect: nextEffect,
        changeBindingVersion: undefined,
        candidateBinding: undefined,
      });
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
    return !!issue && issue.state === 'OPEN' && sameStrings(managedLabelProjection(issue.labels, active.config), expectedLabels)
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
      issueNumber,
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
      const cleanup = await this.observeSafeHaltCleanup(active);
      if ('status' in cleanup) return cleanup;
      active = cleanup.active;
      if (attempt.result) return { active };
      if (active.record.lifecycle === 'safe-halt') {
        active = await this.persist(active, { lifecycle: lifecycleForAttempt(attempt.operationId) });
      }
      return { active: await this.clearAttempt(active) };
    }
    let observation;
    try { observation = await this.dependencies.processIdentity.observe(attempt.process); }
    catch {
      return this.invokedFailure(
        active,
        'active-attempt-observation-inaccessible',
        'Process identity observation is inaccessible; ownership remains frozen until a later daemon tick.',
      );
    }
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
    const cleanup = await this.observeSafeHaltCleanup(active);
    if ('status' in cleanup) return cleanup;
    active = cleanup.active;
    if (observed.result) return { active };
    if (active.record.lifecycle === 'safe-halt') {
      active = await this.persist(active, { lifecycle: lifecycleForAttempt(attempt.operationId) });
    }
    return { active: await this.clearAttempt(active) };
  }

  private async observeSafeHaltCleanup(active: ActiveRun): Promise<{ active: ActiveRun } | RunIssueResult> {
    const attempt = active.record.activeAttempt;
    if (!attempt || (attempt.stage !== 'observed' && attempt.stage !== 'adopted')) {
      return this.invokedFailure(active, 'active-attempt-cleanup-observation-invalid');
    }
    if (attempt.cleanup === 'confirmed') return { active };
    let cleanup;
    try {
      cleanup = await this.dependencies.observeAttemptCleanup({
        runId: attempt.runId,
        attemptId: attempt.attemptId,
        resultPath: attempt.resultPath,
      });
    }
    catch { cleanup = 'pending' as const; }
    if (cleanup !== 'confirmed') {
      return this.invokedFailure(active, 'active-attempt-cleanup-unconfirmed',
        'Attempt cleanup remains unresolved; ownership and result identity stay frozen until a later daemon tick.');
    }
    return { active: await this.persist(active, {
      activeAttempt: confirmActiveAttemptCleanup(attempt, this.timestamp()),
    }) };
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
    semanticChanges: Omit<Partial<RunRecord>, 'activeAttempt' | 'pendingEffect'> & {
      pendingEffect?: PendingEffect | PendingEffectInput | undefined;
    },
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
    semanticChanges: Omit<Partial<RunRecord>, 'activeAttempt' | 'pendingEffect'> & {
      pendingEffect?: PendingEffect | PendingEffectInput | undefined;
    },
  ): Promise<ActiveRun> {
    let comparableChanges: Omit<Partial<RunRecord>, 'activeAttempt'> = semanticChanges as Omit<Partial<RunRecord>, 'activeAttempt'>;
    if (Object.hasOwn(semanticChanges, 'pendingEffect') && semanticChanges.pendingEffect) {
      const { effectId: _priorEffectId, ...payload } = semanticChanges.pendingEffect as PendingEffect;
      comparableChanges = { ...semanticChanges, pendingEffect: createPendingEffect(payload as PendingEffectInput) };
    }
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
        && semanticChangesMatch(current, comparableChanges)) {
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
      if (active.record.activeAttempt?.stage === 'prepared') {
        const settled = await this.settleCandidateMaterialization(active, active.config, true);
        if ('status' in settled) return settled;
        active = settled.active;
      }
      if (error instanceof CheckProcessQuiescenceError) {
        active = await this.persist(active, { lifecycle: 'safe-halt' });
        return this.invokedFailure(active, 'active-attempt-observation-deferred',
          'The configured-check process remains unresolved; the next daemon tick will make one fresh bounded observation.');
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
    settledPreLaunch = false,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    const materialization = active.record.candidateMaterialization;
    if (!candidate || !binding || !materialization) return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-materialization-state-missing');
    if (active.record.activeAttempt?.stage !== (settledPreLaunch ? 'prepared' : 'adopted')) {
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
      return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-materialization-mutated');
    }
    if (active.record.activeAttempt?.stage === 'observed' && active.record.activeAttempt.result) {
      return { active };
    }
    if (active.record.activeAttempt?.stage === 'adopted'
      && active.record.activeAttempt.operationId === 'code-review'
      && (active.record.directReview?.review.reportRepairs ?? 0) > 0) {
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
    return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, evidenceCode);
  }

  private mapCandidateFailure(active: ActiveRun, code: string): Promise<RunIssueResult> {
    if (code === 'candidate-unstable' || code === 'candidate-io-failed' || code === 'candidate-materialization-io-failed') {
      return this.invokedFailure(active, code, 'Candidate operation failed before an effect and may be retried without consuming a repair budget.');
    }
    return this.terminal(active, { status: 'transport-failed', resumable: false }, code);
  }

  private async reviewValidationScope(
    active: ActiveRun,
    frozenCriteria: FrozenCriterion[],
    configuredChecks: Record<string, string>,
    deniedPaths: string[],
  ): Promise<ReviewValidationScope> {
    const binding = active.record.candidateBinding;
    const review = active.record.directReview;
    if (!binding) throw new Error('review scope requires candidate identity');
    const completeDiff = await this.dependencies.git.diffTrees(
      active.record.worktreePath,
      active.record.baseSha,
      binding.candidateTreeSha,
    );
    if (completeDiff.changedFiles.length === 0 || completeDiff.patch.trim().length === 0
      || Buffer.byteLength(completeDiff.patch, 'utf8') > 1024 * 1024
      || containsCredentialEvidence(completeDiff.patch)
      || completeDiff.changedFiles.some((path) => findDeniedPathMatch(path, deniedPaths))) {
      throw new Error('exact complete Review target is unavailable');
    }
    if (!review?.previousTarget) return {
      mode: 'complete', repairPatch: null, targetPatch: completeDiff.patch,
      changedFiles: completeDiff.changedFiles,
      checks: structuredClone(configuredChecks), criteria: structuredClone(frozenCriteria), impactTargets: [],
    };

    let treeDiff: Awaited<ReturnType<RunIssueGit['diffTrees']>>;
    try {
      treeDiff = await this.dependencies.git.diffTrees(
        active.record.worktreePath,
        review.previousTarget.candidateTreeSha,
        binding.candidateTreeSha,
      );
    } catch {
      return {
        mode: 'complete', repairPatch: null, targetPatch: completeDiff.patch, changedFiles: completeDiff.changedFiles,
        checks: structuredClone(configuredChecks), criteria: structuredClone(frozenCriteria),
        impactTargets: [],
      };
    }
    const repairDefects = review.review.defects.filter((defect) => ['open', 'reopened', 'fixed'].includes(defect.status));
    const repairFindings = review.repairFindings.filter((finding) => ['open', 'reopened', 'fixed'].includes(finding.status));
    const repairedBlockerIds = [...new Set([
      ...repairDefects.map((defect) => defect.id),
      ...repairFindings.map((finding) => finding.id),
      ...repairFindings.map((finding) => finding.sourceId),
    ])].sort();
    const contracts = [...new Set([
      ...repairDefects.flatMap((defect) => defect.affectedTargets),
      ...repairFindings.flatMap((finding) => finding.affectedContracts),
    ])].sort();
    const checkEntries = Object.entries(configuredChecks);
    const exactChecks = new Set(contracts.filter((target) => target.startsWith('check:')).map((target) => target.slice('check:'.length)));
    const exactCriteria = new Set(contracts.filter((target) => target.startsWith('criterion:')).map((target) => target.slice('criterion:'.length)));
    const affectedChecks = checkEntries.filter(([id]) => exactChecks.has(id));
    const affectedCriteria = frozenCriteria.filter((criterion) => exactCriteria.has(criterion.id));
    const directImpact = new Set([
      ...treeDiff.changedFiles,
      ...treeDiff.changedFiles.map((path) => `path:${path}`),
      ...review.review.defects
        .filter((defect) => defect.introducedTargetRevision < review.targetRevision)
        .flatMap((defect) => defect.affectedTargets),
      ...repairFindings.flatMap((finding) => finding.affectedContracts),
    ]);
    const retainedOutOfConeDefect = review.stage === 'review' && review.review.defects
      .filter((defect) => defect.introducedTargetRevision === review.targetRevision
        && (defect.status === 'open' || defect.status === 'reopened'))
      .some((defect) => defect.affectedTargets.length === 0
        || defect.affectedTargets.some((target) => !directImpact.has(target)));
    const isolated = treeDiff.changedFiles.length > 0 && repairedBlockerIds.length > 0
      && treeDiff.patch.trim().length > 0
      && Buffer.byteLength(treeDiff.patch, 'utf8') <= 1024 * 1024
      && !containsCredentialEvidence(treeDiff.patch)
      && !treeDiff.changedFiles.some((path) => findDeniedPathMatch(path, deniedPaths))
      && !retainedOutOfConeDefect;
    return {
      mode: isolated ? 'targeted' : 'complete',
      repairPatch: isolated ? treeDiff.patch : null,
      targetPatch: isolated ? treeDiff.patch : completeDiff.patch,
      changedFiles: isolated ? treeDiff.changedFiles : [...binding.canonicalChangedFiles],
      checks: isolated && affectedChecks.length > 0
        ? Object.fromEntries(affectedChecks)
        : structuredClone(configuredChecks),
      criteria: isolated && affectedCriteria.length > 0
        ? structuredClone(affectedCriteria)
        : structuredClone(frozenCriteria),
      impactTargets: isolated ? [...new Set([
        ...contracts,
        ...treeDiff.changedFiles,
        ...treeDiff.changedFiles.map((path) => `path:${path}`),
      ])].sort() : [],
    };
  }

  private async runFullReview(
    starting: ActiveRun,
    issue: IssueSnapshot,
    frozenCriteria: FrozenCriterion[],
    implementationAttemptId: string,
    config: AgentAutoConfig,
    suppliedScope?: ReviewValidationScope,
  ): Promise<ActiveRun | RunIssueResult> {
    let active = starting;
    let reviewScope: ReviewValidationScope;
    try {
      reviewScope = suppliedScope ?? await this.reviewValidationScope(
        active,
        frozenCriteria,
        resolveIssueCheckPolicy(active.record.issueSnapshot.body, config.checks).checks,
        config.deny.readPaths,
      );
    } catch (error) {
      return this.invokedFailure(active, 'review-scope-unavailable', error instanceof Error ? error.message : undefined);
    }
    let reportRepair: { originalReportSha256: string; originalReportBytes: Buffer; diagnostic: string } | undefined;
    const retainedAttempt = active.record.activeAttempt;
    const retainedReview = active.record.directReview;
    if (retainedReview?.review.reportRepairs && retainedAttempt?.stage === 'adopted' && retainedAttempt.result) {
      const stored = await this.dependencies.inspectAttemptResult(retainedAttempt.resultPath);
      if (!stored || stored.sha256 !== retainedAttempt.result.sha256) {
        return this.invokedFailure(active, 'direct-review-report-result-unavailable',
          'The exact malformed Review result is not currently observable; report-only recovery remains fenced.');
      }
      const validation = validateCompletedReport('code-review', retainedAttempt.attemptId, stored.bytes, {
        operation: 'code-review',
        targetRevision: retainedReview.targetRevision,
        targetFingerprint: retainedReview.targetFingerprint,
        reviewerSessionId: retainedReview.review.reviewerSessionId!,
        previousFindingIds: [
          ...retainedReview.review.defects.filter((defect) => defect.status === 'fixed').map((defect) => defect.id),
          ...retainedReview.repairFindings.filter((finding) => finding.status === 'fixed').map((finding) => finding.id),
        ].sort(),
        requiredCoverage: reviewScope.mode === 'complete' ? [
          'candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability',
          'repository-standards', 'requirements', 'tests', 'zero-legacy',
        ] : [],
        requireAllReviewers: reviewScope.mode === 'complete',
        requireReviewerEvidence: true,
      });
      if (validation.status !== 'invalid' || !validation.repairInput) {
        return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'direct-review-retained-result-diverged');
      }
      reportRepair = {
        originalReportSha256: validation.repairInput.originalReportSha256,
        originalReportBytes: Buffer.from(validation.repairInput.originalReportBytes),
        diagnostic: validation.findings[0] ?? 'review report is invalid',
      };
      active = await this.clearAttempt(active);
    }
    while (true) {
      const directReview = active.record.directReview;
      if (!directReview || directReview.stage !== 'review') {
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
        const settledExecution = await this.settleCandidateMaterialization(active, config, true);
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
        currentTreeSha: active.record.candidateBinding!.candidateTreeSha,
        previousTarget: structuredClone(directReview.previousTarget),
        repairPatch: reviewScope.repairPatch,
        targetPatch: reviewScope.targetPatch,
        changedFiles: reviewScope.changedFiles,
        repairFindings: directReview.repairFindings.filter((finding) => finding.status === 'fixed')
          .map((finding) => ({
            id: finding.id,
            sourceId: finding.sourceId,
            summary: finding.summary,
            affectedContracts: structuredClone(finding.affectedContracts),
          })),
        checkedChangeSha256: active.record.checkedChangeSha256!,
        checks: structuredClone(active.record.checks),
        proofReceipt: structuredClone(active.record.proofReceipt!),
        issue,
        frozenCriteria: reviewScope.criteria,
        deliveryAuthority: structuredClone(active.record.deliveryAuthority!),
        defects: structuredClone(directReview.review.defects),
        reviewFocus: [
          'candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability',
          'repository-standards', 'requirements', 'tests', 'zero-legacy',
        ],
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
        if (reviewScope.mode === 'targeted') {
          const impact = new Set(reviewScope.impactTargets);
          const defectsInCone = result.report.defects
            .filter((defect) => defect.introducedTargetRevision === current.targetRevision
              || defect.statusTargetRevision === current.targetRevision)
            .every((defect) => defect.affectedTargets.length > 0
              && defect.affectedTargets.every((target) => impact.has(target)));
          const reopenedInCone = result.report.repairFindingOutcomes
            .filter((outcome) => outcome.status === 'reopened')
            .every((outcome) => {
              const contracts = current.repairFindings.find((finding) => finding.id === outcome.id)?.affectedContracts;
              return contracts !== undefined && contracts.length > 0 && contracts.every((target) => impact.has(target));
            });
          if (!defectsInCone || !reopenedInCone) {
            active = await this.adoptAttempt(active, result.artifactSha256, {});
            const settledExecution = await this.settleCandidateMaterialization(active, config);
            if ('status' in settledExecution) return settledExecution;
            const completeReview = structuredClone(settledExecution.active.record.directReview!);
            completeReview.review.defects = structuredClone(result.report.defects);
            completeReview.review.reviewerSessionId = this.dependencies.createReviewSessionId();
            completeReview.review.reportRepairs = 0;
            completeReview.review.transportRetries = 0;
            active = await this.persist(settledExecution.active, {
              lifecycle: 'checking',
              checks: [],
              checkedChangeSha256: undefined,
              proofId: undefined,
              proofReceipt: undefined,
              ...(settledExecution.active.record.reviewFeedback ? {
                reviewFeedback: { ...settledExecution.active.record.reviewFeedback, verifiedReceipt: null },
              } : {}),
              directReview: completeReview,
            });
            return this.invokedFailure(active, 'targeted-review-impact-unisolated',
              'The targeted Review reported an out-of-cone finding; full checks, proof, and complete Review will resume for the same target.');
          }
        }
        if (result.report.verdict === 'needs-work') {
          active = await this.adoptValidationTransition(
            active,
            result.artifactSha256,
            projectValidationReviewNeedsWork(active.record, result.report, result.artifactSha256),
          );
          const settledExecution = await this.settleCandidateMaterialization(active, config);
          if ('status' in settledExecution) return settledExecution;
          const released = await this.clearAndReleaseCandidate(settledExecution.active);
          return 'status' in released
            ? released
            : this.semanticContinuation(released.active, 'review', [
              ...result.report.defects.filter((defect) => defect.status === 'open' || defect.status === 'reopened').map((defect) => defect.id),
              ...result.report.repairFindingOutcomes.filter((finding) => finding.status === 'reopened').map((finding) => finding.id),
            ], 'The consolidated Review repair batch is ready for the next bounded invocation.');
        }
        if (result.report.verdict !== 'approved') {
          const feedbackActive = active.record.reviewFeedback?.activeBatch !== null
            && active.record.reviewFeedback?.activeBatch !== undefined;
          const kind: 'authority-boundary' | 'decision-delta' = feedbackActive ? 'authority-boundary' : 'decision-delta';
          const findings = [
            ...result.report.defects.map((defect) => `${defect.id}: ${defect.failure}`),
            ...result.report.residualRisks,
          ];
          const outcome = {
            status: 'blocked' as const,
            kind,
            resumable: false,
            blocker: {
              kind,
              summary: `Standards Review rejected revision ${result.report.targetRevision}.`,
              attempted: ['Reviewed the immutable candidate against issue authority, current checks, and Acceptance Proof.'],
              resumable: false,
              reviewerRejectionDetail: findings.join('\n') || 'The reviewer rejected the candidate without an authorized in-scope repair.',
            },
          };
          return feedbackActive
            ? this.blockReviewFeedback(active, kind, 'direct-review-rejected', outcome)
            : this.terminal(active, outcome, 'direct-review-rejected');
        }
        active = await this.adoptValidationTransition(
          active,
          result.artifactSha256,
          projectValidationReviewApproved(active.record, result.report, result.artifactSha256, reviewScope.mode),
        );
        const settledExecution = await this.settleCandidateMaterialization(active, config);
        return 'status' in settledExecution ? settledExecution : settledExecution.active;
      }
      if (result.kind === 'report-invalid') {
        const current = active.record.directReview;
        if (!current) return this.terminal(active, { status: 'internal-error', code: 'direct-review-result-orphaned' });
        active = await this.adoptValidationTransition(
          active,
          result.originalReportSha256,
          projectValidationReviewReportRepair(active.record),
        );
        return this.invokedFailure(active, 'direct-review-report-retryable',
          'The review report was malformed; a later bounded invocation may retry the same immutable candidate.');
      }
      if (result.kind === 'transport-failed') {
        const current = active.record.directReview;
        if (!current) return this.terminal(active, { status: 'internal-error', code: 'direct-review-result-orphaned' });
        const transition = projectValidationReviewTransportRetry(active.record);
        if (isAdoptableAttempt(active.record.activeAttempt)) {
          active = await this.adoptValidationTransition(active, sha256(canonicalJson(result)), transition);
        } else {
          active = await this.persistValidationTransition(active, transition);
        }
        const settledExecution = await this.settleCandidateMaterialization(
          active,
          config,
          active.record.activeAttempt?.stage === 'prepared',
        );
        if ('status' in settledExecution) return settledExecution;
        return this.invokedFailure(settledExecution.active, 'direct-review-transport-retryable',
          'Review infrastructure is temporarily unavailable; a later bounded invocation may retry.');
      }
      if (result.kind === 'safe-halt') {
        active = await this.persist(active, { lifecycle: 'safe-halt' });
        return this.invokedFailure(active, 'active-attempt-observation-deferred',
          'The code-review process remains unresolved; the next daemon tick will make one fresh bounded observation.');
      }
      if (result.kind === 'cancelled') return this.terminal(active, { status: 'cancelled' });
      return this.terminal(active, { status: 'internal-error', code: result.code });
    }
  }

  private async startNextCycle(
    active: ActiveRun,
    findings: string[],
    sources?: Array<{ provenance: 'check' | 'proof'; sourceId: string; summary: string; affectedContracts: string[] }>,
  ): Promise<ActiveRun> {
    const transition = projectValidationRepair(active.record, findings, sources);
    return this.persistValidationTransition(active, transition);
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

  private async blockReviewFeedback(
    active: ActiveRun,
    kind: 'external' | 'safety' | 'decision-delta' | 'out-of-scope' | 'authority-boundary',
    evidenceCode: string,
    outcome: Extract<TerminalSeed, { status: 'blocked' }> = { status: 'blocked', kind, resumable: false },
  ): Promise<RunIssueResult> {
    return this.terminal(active, outcome, evidenceCode);
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
    if (proof.status === 'external-block') {
      if (proof.blocker.resumable) {
        const proofExecution = active.record.proofExecution;
        if (proofExecution) active = await this.persist(active, { proofExecution: {
          ...proofExecution,
          transportRetryCount: proofExecution.transportRetryCount + 1,
        } });
        return this.invokedFailure(active, 'acceptance-proof-external-block-retryable', proof.blocker.summary);
      }
      return this.terminal(active, implementationBlockerOutcome(proof.blocker));
    }
    if (proof.status === 'transport-failed') return this.terminal(active, { status: 'transport-failed', resumable: proof.resumable });
    if (proof.status === 'cancelled') return this.terminal(active, { status: 'cancelled' });
    return this.terminal(active, { status: 'internal-error', code: 'acceptance-proof-internal-failure' });
  }

  private async revoked(active: ActiveRun): Promise<RunIssueResult> {
    if (active.record.pendingEffect) return this.invokedFailure(active, 'revoked-with-pending-effect');
    return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'authorization-revoked');
  }

  private async invokedFailure(
    active: ActiveRun,
    code: string,
    summary = 'Publication delivery requires reconciliation.',
  ): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code, summary });
    return { status: 'transport-failed', resumable: true, evidencePath: evidence.path };
  }

  private async semanticContinuation(
    active: ActiveRun,
    source: 'check' | 'proof' | 'review',
    blockerIds: string[],
    summary: string,
  ): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({
      runId: active.record.runId,
      code: `${source}-repair-ready`,
      summary,
    });
    return { status: 'repair-ready', source, blockerIds: [...new Set(blockerIds)].sort(), evidencePath: evidence.path };
  }

  private async observeOutcomeEvidenceEffect(
    active: ActiveRun,
    code: string,
    summary: string,
  ): Promise<{ active: ActiveRun; path: string; id: string }> {
    if (!active.record.pendingEffect) {
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

  private async completeIssueFeedbackResponse(
    starting: ActiveRun,
    report: ImplementationReportV1 & { status: 'answer-only' | 'boundary'; response: string },
    config: AgentAutoConfig,
  ): Promise<RunIssueResult> {
    let active = starting;
    const feedback = active.record.reviewFeedback;
    const batch = feedback?.activeBatch;
    if (!feedback || !batch || batch.sources.some((source) => source.kind !== 'issue-comment')) {
      return this.terminal(active, { status: 'internal-error', code: 'issue-feedback-response-source-invalid' });
    }
    if (await this.dependencies.git.getHead(active.record.worktreePath) !== batch.priorPublishedHeadSha
      || (await this.dependencies.git.listChangedFilesIgnoringUntrackedRoot(
        active.record.worktreePath, config.proof.artifactDir,
      )).length !== 0) {
      return this.terminal(active, { status: 'internal-error', code: 'issue-feedback-response-mutated-worktree' });
    }
    const marker = `<!-- codex-orchestrator:run:${active.record.runId}:issue-feedback:${batch.batchId} -->`;
    const response = publicIssueFeedbackText(report.response,
      report.status === 'boundary'
        ? 'This request cannot be acted on without a new issue-local decision or authority.'
        : 'The requested answer could not be published safely.');
    const body = [
      marker,
      report.status === 'boundary' ? 'codex-orchestrator reached an authority boundary.' : 'codex-orchestrator answered this follow-up.',
      '',
      response,
      ...(report.status === 'boundary' ? ['', `Boundary: ${report.boundary!.kind}`] : []),
    ].join('\n');

    const directReview = active.record.directReview!;
    const sourceIds = batch.sources.map((source) => source.sourceId);
    const restoredDirectReview = {
      ...structuredClone(directReview),
      status: 'clear' as const,
      stage: 'review' as const,
      review: { ...structuredClone(directReview.review), disposition: 'clear' as const },
      repairFindings: directReview.repairFindings.filter((finding) => !sourceIds.includes(finding.sourceId)),
    };
    const pullRequest = await this.dependencies.pullRequests.findOpen({
      headBranch: active.record.branchName,
      baseBranch: config.github.baseBranch,
    });
    if (!pullRequest?.url || pullRequest.number !== batch.pullRequest.number
      || pullRequest.nodeId !== batch.pullRequest.nodeId || pullRequest.headSha !== batch.pullRequest.headSha
      || pullRequest.headRefName !== batch.pullRequest.headRefName
      || pullRequest.baseRefName !== batch.pullRequest.baseRefName) {
      return this.terminal(
        active,
        { status: 'blocked', kind: 'safety', resumable: false },
        'issue-feedback-prior-handoff-identity-mismatch',
        { reviewFeedback: blockReviewFeedback({
          ...feedback,
          consumedSourceIds: feedback.consumedSourceIds.filter((id) => !sourceIds.includes(id)),
        }, 'safety', this.timestamp()) },
      );
    }
    const terminalSeed = {
      status: 'review-ready' as const,
      pullRequestUrl: pullRequest.url,
      continuationEpoch: batch.priorPublishedHeadSha,
    };
    const terminalOutcome = {
      ...terminalSeed,
      evidencePath: this.dependencies.outcomeEvidencePath(
        active.record.runId, 'review-ready', sha256(canonicalJson(terminalSeed)),
      ),
    };
    const respondedAt = this.timestamp();
    const initialReceipt = {
      kind: 'responded' as const,
      batchId: batch.batchId,
      sourceIds,
      responseKind: report.status,
      publication: 'failed' as const,
      diagnostic: 'issue-feedback-response-publication-not-settled',
      respondedAt,
    };
    let comments = active.record.issueSnapshot.comments ?? [];
    try { comments = (await this.readIssue(active.record.issueNumber))?.comments ?? comments; } catch { /* bounded fallback */ }
    const freshNotifications = terminalNotificationState(active.record, terminalSeed, this.timestamp(), comments)!;
    const consumedChanges = {
      lifecycle: 'review-ready' as const,
      terminalOutcome,
      outcomeEvidenceId: `evidence:${active.record.runId}:review-ready`,
      reviewFeedback: respondReviewFeedback(feedback, initialReceipt),
      directReview: restoredDirectReview,
      reworkFindings: [],
      reportRepairs: 0,
      transportRetries: 0,
      terminalNotifications: {
        ...freshNotifications,
        comment: { status: 'delivered' as const, attempts: 0 },
        labels: { status: 'delivered' as const, attempts: 0 },
      },
    };
    active = isAdoptableAttempt(active.record.activeAttempt)
      ? await this.adoptAttempt(active, sha256(canonicalJson(report)), consumedChanges)
      : await this.persist(active, consumedChanges);

    let publication: 'delivered' | 'failed' | 'suppressed' = 'failed';
    let commentId: string | undefined;
    let diagnostic: string | undefined;
    const validation = this.dependencies.reviewFeedback
      ? await this.dependencies.reviewFeedback.revalidate({
        batch, issueNumber: active.record.issueNumber, epoch: 'pre-update', expectedHeadSha: batch.priorPublishedHeadSha,
      })
      : { status: 'blocked' as const, reason: 'review feedback revalidation unavailable' };
    if (validation.status !== 'valid') {
      publication = 'suppressed';
      diagnostic = validation.status === 'retryable'
        ? 'issue-feedback-response-revalidation-retryable'
        : 'issue-feedback-response-revalidation-blocked';
    } else {
      try {
        let issue = await this.readIssue(active.record.issueNumber);
        let matches = issue ? commentsWithMarker(issue, marker) : [];
        if (matches.length === 0) {
          await this.dependencies.issues.postComment(active.record.issueNumber, body);
          issue = await this.readIssue(active.record.issueNumber);
          matches = issue ? commentsWithMarker(issue, marker) : [];
        }
        const match = matches.length === 1 && sha256(matches[0]!.body) === sha256(body) ? matches[0] : undefined;
        if (match) {
          publication = 'delivered';
          commentId = match.id ?? `marker:${batch.batchId}`;
        } else {
          diagnostic = 'issue-feedback-response-observation-diverged';
        }
      } catch {
        diagnostic = 'issue-feedback-response-delivery-failed';
      }
    }
    try {
      await this.dependencies.issues.setLabels(active.record.issueNumber, [config.github.labels.review.name]);
    } catch {
      diagnostic = diagnostic ?? 'issue-feedback-review-label-reconciliation-failed';
    }

    const receipt = {
      kind: 'responded' as const,
      batchId: batch.batchId,
      sourceIds,
      responseKind: report.status,
      publication,
      ...(commentId ? { commentId } : {}),
      ...(diagnostic ? { diagnostic } : {}),
      respondedAt,
    };
    try {
      active = await this.persist(active, {
        reviewFeedback: settleReviewFeedbackResponse(active.record.reviewFeedback!, receipt),
      });
    } catch {
      return publicOutcome(terminalOutcome);
    }
    try { active = await this.clearAttempt(active); }
    catch { return publicOutcome(terminalOutcome); }
    return publicOutcome(active.record.terminalOutcome!);
  }

  private async terminal(
    active: ActiveRun,
    outcome: TerminalSeed,
    evidenceCode: string = outcome.status,
    additionalChanges: Omit<Partial<RunRecord>, 'pendingEffect' | 'terminalOutcome' | 'outcomeEvidenceId' | 'lifecycle'> = {},
  ): Promise<RunIssueResult> {
    if (active.record.pendingEffect && active.record.pendingEffect.kind !== 'outcome-evidence') {
      return this.invokedFailure(active, 'terminal-pending-effect-unsettled', 'Terminal state requires the existing effect postcondition to settle first.');
    }
    const feedback = active.record.reviewFeedback;
    const terminalChanges = feedback?.activeBatch && !additionalChanges.reviewFeedback ? {
      ...additionalChanges,
      reviewFeedback: blockReviewFeedback(feedback, outcome.status === 'blocked' ? outcome.kind : 'safety', this.timestamp()),
    } : additionalChanges;
    return this.persistTerminal(active, outcome, evidenceCode, terminalChanges);
  }

  private async settleTerminalNotificationsBestEffort(starting: ActiveRun): Promise<ActiveRun> {
    let active = starting;
    if (!active.record.terminalOutcome || !active.record.terminalNotifications) return active;
    if (active.record.pendingEffect && active.record.pendingEffect.kind !== 'terminal-comment'
      && active.record.pendingEffect.kind !== 'terminal-labels') return active;
    try { active = await this.settleTerminalComment(active); } catch { return active; }
    try { active = await this.settleTerminalLabels(active); } catch { return active; }
    return active;
  }

  private async settleTerminalComment(starting: ActiveRun): Promise<ActiveRun> {
    let active = starting;
    const notifications = active.record.terminalNotifications!;
    if (notifications.comment.status !== 'pending' || notifications.comment.attempts >= TERMINAL_NOTIFICATION_ATTEMPTS) return active;
    const body = terminalComment(active.record.runId, active.record.cycle, notifications.report);
    const marker = body.split('\n')[0]!;
    const attempt = notifications.comment.attempts + 1;
    if (!active.record.pendingEffect) {
      active = await this.persist(active, { pendingEffect: {
        kind: 'terminal-comment', issueNumber: active.record.issueNumber, marker, bodySha256: sha256(body),
        outcome: notifications.report.outcome, attempt,
      } });
    }
    const effect = active.record.pendingEffect;
    if (effect?.kind !== 'terminal-comment' || effect.issueNumber !== active.record.issueNumber
      || effect.marker !== marker || effect.bodySha256 !== sha256(body)
      || effect.outcome !== notifications.report.outcome || effect.attempt !== attempt) return active;
    const settlement = await settleCommentEffect(effect, {
      observe: async () => {
        const issue = await this.readIssue(effect.issueNumber);
        if (!issue || issue.state !== 'OPEN') return 'diverged';
        const matching = commentsWithMarker(issue, marker);
        if (matching.length === 0) return 'absent';
        return matching.length === 1 && sha256(matching[0]!.body) === effect.bodySha256 ? 'confirmed' : 'diverged';
      },
      invoke: () => this.dependencies.issues.postComment(effect.issueNumber, body),
    });
    const delivered = settlement.status === 'confirmed';
    const status = delivered ? 'delivered' as const
      : attempt >= TERMINAL_NOTIFICATION_ATTEMPTS ? 'exhausted' as const : 'pending' as const;
    const diagnostic = delivered ? {} : { diagnostic: terminalNotificationDiagnostic('comment', settlement.status) };
    return this.persist(active, {
      terminalNotifications: {
        ...notifications,
        comment: { status, attempts: attempt, ...diagnostic },
      },
      pendingEffect: undefined,
    });
  }

  private async settleTerminalLabels(starting: ActiveRun): Promise<ActiveRun> {
    let active = starting;
    let notifications = active.record.terminalNotifications!;
    const policy = terminalLabelChanges(active.config, notifications.report.outcome);
    if (notifications.labels.status === 'delivered') {
      const issue = await this.readIssue(active.record.issueNumber);
      const settled = issue && policy.add.every((label) => issue.labels.includes(label))
        && policy.remove.every((label) => !issue.labels.includes(label));
      if (settled) return active;
      notifications = { ...notifications, labels: { status: 'pending', attempts: 0 } };
      active = await this.persist(active, { terminalNotifications: notifications });
    }
    if (notifications.labels.status !== 'pending' || notifications.labels.attempts >= TERMINAL_NOTIFICATION_ATTEMPTS) return active;
    const attempt = notifications.labels.attempts + 1;
    if (!active.record.pendingEffect) {
      active = await this.persist(active, { pendingEffect: {
        kind: 'terminal-labels', issueNumber: active.record.issueNumber, ...policy,
        outcome: notifications.report.outcome, attempt,
      } });
    }
    const effect = active.record.pendingEffect;
    if (effect?.kind !== 'terminal-labels' || effect.issueNumber !== active.record.issueNumber
      || effect.outcome !== notifications.report.outcome || effect.attempt !== attempt
      || !sameStrings(effect.add, policy.add) || !sameStrings(effect.remove, policy.remove)) return active;
    const settlement = await settleLabelsEffect(effect, {
      observe: async () => {
        const issue = await this.readIssue(effect.issueNumber);
        if (!issue) return 'diverged';
        return effect.add.every((label) => issue.labels.includes(label))
          && effect.remove.every((label) => !issue.labels.includes(label)) ? 'confirmed' : 'absent';
      },
      invoke: async () => {
        if (!this.dependencies.issues.reconcileTerminalLabels) throw new Error('terminal label reconciliation unavailable');
        await this.dependencies.issues.reconcileTerminalLabels(effect.issueNumber, {
          outcome: effect.outcome, add: effect.add, remove: effect.remove,
        });
      },
    });
    const delivered = settlement.status === 'confirmed';
    const status = delivered ? 'delivered' as const
      : attempt >= TERMINAL_NOTIFICATION_ATTEMPTS ? 'exhausted' as const : 'pending' as const;
    const diagnostic = delivered ? {} : { diagnostic: terminalNotificationDiagnostic('labels', settlement.status) };
    return this.persist(active, {
      terminalNotifications: {
        ...notifications,
        labels: { status, attempts: attempt, ...diagnostic },
      },
      pendingEffect: undefined,
    });
  }

  private async persistTerminal(
    active: ActiveRun,
    outcome: TerminalSeed,
    evidenceCode: string,
    additionalChanges: Omit<Partial<RunRecord>, 'pendingEffect' | 'terminalOutcome' | 'outcomeEvidenceId' | 'lifecycle'> = {},
  ): Promise<RunIssueResult> {
    const evidence = await this.observeOutcomeEvidenceEffect(
      active, evidenceCode, canonicalJson(outcome),
    );
    active = evidence.active;
    const terminalOutcome = { ...outcome, evidencePath: evidence.path } as RunTerminalOutcome;
    let terminalComments = active.record.issueSnapshot.comments ?? [];
    if (outcome.status !== 'transport-failed') {
      try {
        terminalComments = (await this.readIssue(active.record.issueNumber))?.comments ?? terminalComments;
      } catch {
        // Terminal notification observation is best-effort and cannot change the Run outcome.
      }
    }
    const notifications = terminalNotificationState(active.record, outcome, this.timestamp(), terminalComments);
    const changes: Partial<RunRecord> & { pendingEffect?: PendingEffect | undefined } = {
      ...additionalChanges,
      lifecycle: outcome.status,
      terminalOutcome,
      outcomeEvidenceId: evidence.id,
      ...(notifications ? { terminalNotifications: notifications } : {}),
    };
    if (outcome.status !== 'review-ready' && active.record.directReview && active.record.directReview.status !== 'terminal') {
      changes.directReview = projectTerminalDirectReview(active.record.directReview, outcome.status === 'blocked'
        ? { status: 'blocked', kind: outcome.kind }
        : { status: outcome.status }, outcome.status === 'internal-error' ? outcome.code : undefined);
    }
    active = await this.persist(active, changes);
    try { active = await this.confirmEffect(active); } catch { return publicOutcome(terminalOutcome); }
    active = await this.settleTerminalNotificationsBestEffort(active);
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
const TERMINAL_NOTIFICATION_ATTEMPTS = 3;

function terminalNotificationState(
  record: RunRecord,
  outcome: TerminalSeed,
  observedAt: string,
  comments: Array<{ id?: string }>,
): TerminalNotificationStateV1 | undefined {
  if (outcome.status === 'transport-failed') return undefined;
  const commentId = issueCommentHighWaterMark(comments);
  return {
    version: 1,
    commentCutoff: { commentId, observedAt },
    report: terminalReportSnapshot(record, outcome),
    comment: { status: 'pending', attempts: 0 },
    labels: { status: 'pending', attempts: 0 },
  };
}

function terminalReportSnapshot(record: RunRecord, outcome: Exclude<TerminalSeed, { status: 'transport-failed' }>): TerminalReportSnapshotV1 {
  const summary = outcome.status === 'blocked'
    ? outcome.blocker?.summary ?? `The run stopped at ${outcome.kind}.`
    : outcome.status === 'internal-error'
      ? internalErrorSummary(outcome.code)
      : outcome.status === 'cancelled'
        ? 'The run was cancelled before completion.'
        : record.implementationResult?.summary ?? record.proofReceipt?.summary ?? 'The authorized implementation is ready for review.';
  const nextAction = outcome.status === 'review-ready'
    ? 'Review the draft PR. To request an in-scope follow-up, comment on this issue.'
    : outcome.status === 'blocked'
      ? outcome.resumable
        ? 'Resolve the stated blocker, then rerun the same issue.'
        : 'Provide the missing decision or authority in this issue before continuing.'
      : outcome.status === 'internal-error'
        ? 'Inspect the package-owned evidence for the code above, correct the runner condition, and retry the same issue.'
        : 'Re-add the authorization label and rerun the same issue if the work should continue.';
  return {
    version: 1,
    outcome: outcome.status,
    summary: publicTerminalText(summary, 'Terminal summary is unavailable.'),
    ...(outcome.status === 'review-ready' ? { pullRequestUrl: outcome.pullRequestUrl } : {}),
    passedChecks: record.checks.filter((check) => check.status === 'passed').slice(0, 16)
      .map((check) => publicTerminalText(check.id, 'Unnamed check.', 200)),
    publishableProof: (record.proofReceipt?.publishableEvidence ?? []).slice(0, 4).map((proof) => publicTerminalText(
      `${proof.ref}: ${proof.description}`, 'Publishable proof detail is unavailable.', 500,
    )),
    unverified: record.proofReceipt ? [] : ['No publishable Acceptance Proof receipt was retained.'],
    risks: (record.implementationResult?.residualRisks ?? []).slice(0, 4)
      .map((risk) => publicTerminalText(risk, 'Risk detail is unavailable.', 500)),
    reviewFocus: (record.directReview?.review.coverage ?? []).slice(0, 8)
      .map((focus) => publicTerminalText(focus, 'Review focus is unavailable.', 250)),
    nextAction,
    ...(outcome.status === 'blocked' ? { blocker: {
      kind: outcome.kind,
      resumable: outcome.resumable,
      attempted: (outcome.blocker?.attempted ?? []).slice(0, 8)
        .map((attempt) => publicTerminalText(attempt, 'Attempt detail is unavailable.', 500)),
    } } : {}),
  };
}

function internalErrorSummary(code: string): string {
  return code === 'implementation-change-set-invalid'
    ? 'The implementation report declared changed files, but the runner found no matching worktree changes.'
    : `The runner encountered an internal failure (${code}) and could not complete this run.`;
}

function terminalComment(runId: string, cycle: number, report: TerminalReportSnapshotV1): string {
  const markerKind = report.outcome === 'review-ready' ? 'handoff' : report.outcome;
  const marker = `<!-- codex-orchestrator:run:${runId}:cycle:${cycle}:${markerKind} -->`;
  if (report.outcome === 'review-ready') {
    return [
      marker,
      'codex-orchestrator completed this run.',
      '',
      '## Summary', report.summary,
      '',
      '## Pull request', report.pullRequestUrl ?? 'Draft PR URL is unavailable.',
      '',
      '## Passed checks', ...terminalList(report.passedChecks),
      '',
      '## Publishable proof', ...terminalList(report.publishableProof),
      '',
      '## Not verified', ...terminalList(report.unverified),
      '',
      '## Known risks', ...terminalList(report.risks),
      '',
      '## Review focus', ...terminalList(report.reviewFocus),
      '',
      '## Follow-up', report.nextAction,
    ].join('\n');
  }
  const title = report.outcome === 'blocked' ? 'blocked' : report.outcome === 'internal-error' ? 'stopped after an internal error' : 'was cancelled';
  return [
    marker,
    `codex-orchestrator ${title} this run.`,
    '',
    ...(report.blocker ? [`Kind: ${report.blocker.kind}`, `Resumable: ${report.blocker.resumable ? 'yes' : 'no'}`, ''] : []),
    '## Reason', `Reason: ${report.summary}`,
    ...(report.blocker ? ['', 'Attempted:', ...terminalList(report.blocker.attempted)] : []),
    '',
    '## Retained work and state',
    ...terminalList([
      ...report.passedChecks.map((check) => `Passed check: ${check}`),
      ...report.publishableProof.map((proof) => `Proof: ${proof}`),
    ]),
    '',
    '## Next action', report.nextAction,
  ].join('\n');
}

function terminalList(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ['- None recorded.'];
}

function terminalNotificationDiagnostic(kind: 'comment' | 'labels', status: string): string {
  return status === 'unknown'
    ? `terminal-${kind}-delivery-unknown`
    : `terminal-${kind}-observation-${status}`;
}

function terminalLabelChanges(
  config: AgentAutoConfig,
  outcome: TerminalReportSnapshotV1['outcome'],
): { add: string[]; remove: string[] } {
  const labels = config.github.labels;
  if (outcome === 'review-ready') return {
    add: [labels.review.name], remove: [labels.auto.name, labels.running.name, labels.blocked.name].sort(),
  };
  if (outcome === 'blocked') return { add: [labels.blocked.name], remove: [labels.running.name, labels.review.name].sort() };
  return {
    add: [],
    remove: [labels.running.name, labels.blocked.name, labels.review.name, ...(outcome === 'cancelled' ? [labels.auto.name] : [])].sort(),
  };
}

function claimLabelProjectionSettled(labels: string[], config: AgentAutoConfig): boolean {
  const policy = config.github.labels;
  return labels.includes(policy.auto.name) && labels.includes(policy.running.name)
    && !labels.includes(policy.blocked.name) && !labels.includes(policy.review.name);
}

function issueCommentHighWaterMark(comments: Array<{ id?: string }>): string | null {
  const ids = comments.map((comment) => comment.id).filter((id): id is string => Boolean(id));
  const decimal = ids.filter((id) => /^\d+$/u.test(id));
  if (decimal.length > 0) return decimal.reduce((highest, id) => BigInt(id) > BigInt(highest) ? id : highest);
  return ids.at(-1) ?? null;
}

function publicTerminalText(value: string, fallback: string, maxLength = 2_000): string {
  return publicBlockedText(value, fallback, maxLength);
}
function lifecycleForAttempt(operationId: string): RunRecord['lifecycle'] {
  if (operationId === 'configured-check') return 'checking';
  if (operationId === 'acceptance-proof') return 'proving';
  if (operationId === 'code-review') return 'reviewing';
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
  const hasBlocker = Object.prototype.hasOwnProperty.call(record, 'blocker');
  if (record.status === 'blocked'
    && ['external', 'safety', 'decision-delta', 'out-of-scope', 'authority-boundary'].includes(record.kind as string)
    && typeof record.resumable === 'boolean'
    && (!hasBlocker || isTerminalBlockerDetail(record.blocker))
    && exact(['kind', 'resumable', 'status', ...(hasBlocker ? ['blocker'] : [])])) {
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

function isTerminalBlockerDetail(value: unknown): value is {
  kind: string; summary: string; attempted: string[]; resumable: boolean; reviewerRejectionDetail?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const blocker = value as Record<string, unknown>;
  const expected = ['attempted', 'kind', 'resumable', 'summary',
    ...(Object.prototype.hasOwnProperty.call(blocker, 'reviewerRejectionDetail') ? ['reviewerRejectionDetail'] : [])].sort();
  const keys = Object.keys(blocker).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    && typeof blocker.kind === 'string' && blocker.kind.length > 0
    && typeof blocker.summary === 'string' && blocker.summary.length > 0
    && typeof blocker.resumable === 'boolean'
    && Array.isArray(blocker.attempted) && blocker.attempted.every((item) => typeof item === 'string' && item.length > 0)
    && (blocker.reviewerRejectionDetail === undefined
      || (typeof blocker.reviewerRejectionDetail === 'string' && blocker.reviewerRejectionDetail.length > 0));
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
  if (feedback?.activeBatch && feedback.repairRound >= 1) {
    return {
      kind: 'review-feedback',
      batchId: feedback.activeBatch.batchId,
      repairRound: feedback.repairRound,
      authoritySha256: record.deliveryAuthority!.authoritySha256,
    };
  }
  return { kind: 'implementation-cycle', cycle: record.cycle, authoritySha256: record.deliveryAuthority!.authoritySha256 };
}

function commentsWithMarker(issue: RunIssueSnapshot, marker: string): Array<{ id?: string; body: string; authorAssociation: string }> {
  return issue.comments.filter((comment) => comment.body.split('\n')[0] === marker);
}

function managedLabelProjection(labels: string[], config: AgentAutoConfig): string[] {
  const policy = config.github.labels;
  const managed = new Set([policy.auto.name, policy.running.name, policy.blocked.name, policy.review.name]);
  return labels.filter((label) => managed.has(label)).sort();
}

function publicBlockedText(value: string, fallback: string, maxLength: number): string {
  if (containsCredentialEvidence(value) || containsHostIdentityEvidence(value)
    || /["']?token["']?\s*[:=]\s*["']?[^\s"']{8,}/iu.test(value)) return fallback;
  const normalized = value.replace(/[\r\n]+/gu, ' ').trim();
  if (normalized.length === 0) return fallback;
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 12))} [truncated]`;
}

function publicIssueFeedbackText(value: string, fallback: string): string {
  if (/\b(?:chain[- ]of[- ]thought|reasoning artifact|local-only log|private reasoning|debug log)\b/iu.test(value)) return fallback;
  return publicBlockedText(value, fallback, 4_000);
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

function implementationBlockerOutcome(blocker: {
  kind: 'credential' | 'tool' | 'service' | 'decision-delta' | 'out-of-scope' | 'authority-boundary';
  summary: string;
  attempted: string[];
  resumable: boolean;
  reviewerRejectionDetail?: string;
}): Extract<TerminalSeed, { status: 'blocked' }> {
  const kind = ['decision-delta', 'out-of-scope', 'authority-boundary'].includes(blocker.kind)
    ? blocker.kind as 'decision-delta' | 'out-of-scope' | 'authority-boundary'
    : 'external';
  return { status: 'blocked', kind, resumable: blocker.resumable, blocker: structuredClone(blocker) };
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
