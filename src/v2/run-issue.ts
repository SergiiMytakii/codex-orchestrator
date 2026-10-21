import { runnerCheckPolicySha256, type RunnerCheckResult } from './runner-checks.js';
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
import { decodeAgentReportForValidation } from './report-envelope.js';
import { projectTerminalDirectReview } from './direct-delivery.js';
import { CandidateProofInspectionError, type FrozenCriterion, type IssueSnapshot, type ProveChangeResult, type ProofProcessFailure } from './acceptance-proof.js';
import { readIssueProofRequirements } from './issue-proof-policy.js';
import type { ProofReceipt, ProofReportV1 } from './proof-report.js';
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
  activateReviewFeedback,
  markReviewFeedbackVerified,
  blockReviewFeedback,
  initializeReviewFeedback,
  projectReviewFeedbackBatch,
  publishReviewFeedback,
  respondReviewFeedback,
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
  settleCommentEffect,
  settleCommitEffect,
  settleCleanupEffect,
  settleDraftPullRequestEffect,
  settleLabelsEffect,
  settlePushEffect,
} from './pending-effect-settlement.js';

class ReviewTargetCredentialError extends Error {
  constructor() {
    super('Review target contains potential credential material; remove real credentials or use explicit dummy session tokens.');
  }
}

export type RunIssueResult =
  | { status: 'state-schema-unsupported'; reason?: string }
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
  criteria: FrozenCriterion[];
  impactTargets: string[];
}

export type ImplementationAgentResult =
  | { kind: 'completed'; report: unknown; reportBytes?: Buffer; attemptId?: string }
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
    isReauthorized?(record: RunRecord, issue: RunIssueSnapshot): Promise<boolean>;
    getAuthorizationGrantId?(issueNumber: number, label: string): Promise<string | undefined>;
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
  configuredChecks?: { run(input: { checks: Record<string, string>; worktreePath: string; proofId: string; signal: AbortSignal }): Promise<RunnerCheckResult[]> };
  implementationAgent: {
    run(input: {
      operation: 'implementation';
      proofId: string;
      baseSha?: string;
      sessionId?: string;
      androidProofPreparation?: RunRecord['androidProofPreparation'];
      runnerChecks?: RunRecord['runnerChecks'];
      onSessionStarted?: (sessionId: string) => Promise<void>;
      reportCorrection?: { bytes: Buffer; sha256: string; diagnostic: string };
      attemptId: string;
      runId: string;
      worktreePath: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      deliveryAuthority: DeliveryAuthority;
      cycle: number;
      reworkFindings: string[];
      workflowGeneration: WorkflowGenerationReceipt;
      reviewFeedbackRound?: number;
      reviewFeedback?: Array<{ id: string; sourceUrl: string; path: string | null; line: number | null; body: string }>;
      reviewFeedbackPullRequest?: { number: number; headSha: string; headRefName: string; url: string };
      onPrepared?: (input: { attemptId: string; reportPath: string; preparedAt: string; baseline: Omit<CheckedChangeFreshness, 'checkPolicySha256'> }) => Promise<void>;
      onLaunched?: (input: { attemptId: string; pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
      signal: AbortSignal;
    }): Promise<ImplementationAgentResult>;
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
  proof: {
    prepareAndroid?(input: { proofId: string; issue: IssueSnapshot; observeOnly?: boolean; checkedChange: CheckedChange<CheckedChangePayloadV2> }): Promise<Omit<NonNullable<RunRecord['androidProofPreparation']>, 'checkedChangeSha256' | 'status'> & { status: 'prepared' | 'blocked' }>;
    cleanupMobileLeases?: (input: { canonicalRepository: string; worktreePath: string; proofId: string }) => Promise<void>;
    admitReport(input: {
      proofId: string; proofStartedAt: string; issue: IssueSnapshot; frozenCriteria: FrozenCriterion[];
      checkedChange: CheckedChange<CheckedChangePayloadV1 | CheckedChangePayloadV2>; report: ProofReportV1;
    }): Promise<ProveChangeResult>;
  };
  checkedChangeMint: CheckedChangeMintCapability;
  runRecords: RunRecordWriter;
  inventoryRuns?(): Promise<RunRecord[]>;
  writeEvidence(input: { runId: string; code: string; summary: string; failure?: ProofProcessFailure }): Promise<{ id: string; path: string }>;
  outcomeEvidencePath(runId: string, code: string, summarySha256: string): string;
  inspectOutcomeEvidence(path: string): Promise<{ sha256: string } | undefined>;
  writeOutcomeEvidence(input: { path: string; bytes: Buffer; sha256: string }): Promise<void>;
  packageVersion: string;
  createWorkflowGeneration(): Promise<{ receipt: WorkflowGenerationReceipt; skillHashes: Record<string, string> }>;
  verifyWorkflowGeneration(receipt: WorkflowGenerationReceipt): Promise<void>;
  createRunId(): string;
  attemptResultPath(input: { canonicalRepository: string; runId: string; attemptId: string }): string;
  createProofId(): string;
  now(): string;
  signal?: AbortSignal;
}

type FeedbackWorkerObservation =
  | { status: 'valid' }
  | { status: 'retryable' | 'blocked'; code: string };

export class RunConfigurationError extends Error {}
export class OwnerLockSafetyError extends Error {}
export class OwnerLockContentionError extends Error {}

interface ActiveRun {
  state: RunStateFile;
  record: RunRecord;
  config: AgentAutoConfig;
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
    if (claimLabelProjectionSettled(observation.labels, config) && !active.record.pendingEffect) return { active };
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
    const admission = await this.admitConfiguredCheckReceipts(starting, config, true);
    if (admission) return admission;
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
        const recaptured = await candidate.inspectSource({
          binding: candidateBinding,
          worktreePath,
          runId,
          boundary: {
            kind: 'implementation-cycle', cycle: active.record.cycle,
            authoritySha256: active.record.deliveryAuthority!.authoritySha256,
          },
          artifactDir: config.proof.artifactDir,
        });
        if (recaptured.kind === 'failed') return this.mapCandidateFailure(active, recaptured.code);
        if (recaptured.value === 'changed') {
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-worktree-drift');
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

    return await this.terminal(active, {
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

  private async publicationDiverged(active: ActiveRun, code: string): Promise<RunIssueResult> {
    return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, code);
  }

  private async updateExistingPullRequest(
    starting: ActiveRun,
    config: AgentAutoConfig,
    issueNumber: number,
  ): Promise<RunIssueResult> {
    const admission = await this.admitConfiguredCheckReceipts(starting, config, true);
    if (admission) return admission;
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
        const recaptured = await candidate.inspectSource({
          binding: candidateBinding,
          worktreePath: active.record.worktreePath,
          runId: active.record.runId,
          boundary: {
            kind: 'review-feedback', batchId: batch.batchId,
            repairRound: feedback.repairRound,
            authoritySha256: active.record.deliveryAuthority!.authoritySha256,
          },
          artifactDir: config.proof.artifactDir,
        });
        if (recaptured.kind === 'failed') return this.mapCandidateFailure(active, recaptured.code);
        if (recaptured.value === 'changed') {
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'review-feedback-candidate-worktree-drift');
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
      'Independent review, configured checks, and acceptance proof passed in the owner session.',
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
    return await this.terminal(active, {
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
      || !starting.record.implementationResult?.review) {
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

    const projected = projectReviewFeedbackBatch(observed.batch, ready.record.cycle);
    const active = await this.persist(ready, {
      lifecycle: 'implementing', cycle: ready.record.cycle + 1,
      reviewFeedback: activateReviewFeedback(readyFeedback, observed.batch),
      reworkFindings: projected.repairFindings.map(finding => finding.summary),
      directReview: undefined, failedCheckRepair: undefined,
      reportRepairs: 0, transportRetries: 0,
      proofId: this.dependencies.createProofId(), proofExecution: undefined,
      terminalOutcome: undefined, outcomeEvidenceId: undefined, terminalNotifications: undefined,
      pendingEffect: { kind: 'review-activation-labels', issueNumber: starting.record.issueNumber,
        batchId: observed.batch.batchId, expected: sortedUnique([config.github.labels.auto.name, config.github.labels.running.name]) },
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
      if (preflightState.status === 'unsupported') return { status: 'state-schema-unsupported', ...(preflightState.reason ? { reason: preflightState.reason } : {}) };
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
        return await this.preClaimTransport(input.issueNumber, 'owner-lock-transport-failed', 'Repository ownership could not be acquired due to a technical failure.');
      }
      const confirmedConfig = await this.readStrictConfig(targetRoot);
      if (!confirmedConfig.bytes.equals(initialConfig.bytes)
        || canonicalRepository !== `${confirmedConfig.config.github.owner.toLowerCase()}/${confirmedConfig.config.github.repo.toLowerCase()}`) {
        return await this.preClaimInternal('config-changed-during-owner-acquire', input.issueNumber);
      }
      const config = confirmedConfig.config;
      if (this.signal.aborted) return await this.preClaimCancelled(input.issueNumber);

      let authoritativeState = await this.dependencies.runRecords.inspect();
      if (authoritativeState.status === 'unsupported') return { status: 'state-schema-unsupported', ...(authoritativeState.reason ? { reason: authoritativeState.reason } : {}) };
      if (!sameInspectionIdentity(preflightState, authoritativeState)) {
        const stableState = await this.dependencies.runRecords.inspect();
        if (stableState.status === 'unsupported') return { status: 'state-schema-unsupported', ...(stableState.reason ? { reason: stableState.reason } : {}) };
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
      } catch (error) {
        return await this.preClaimTransport(input.issueNumber, 'issue-read-failed', transportReadSummary(error));
      }
      const sourceBaseMarkers = issue?.body.match(/^source-base-sha:.*$/gmu) ?? [];
      const expectedBaseSha = sourceBaseMarkers[0]?.slice('source-base-sha:'.length);
      if (sourceBaseMarkers.length > 1 || (expectedBaseSha !== undefined && !/^[a-f0-9]{40}$/u.test(expectedBaseSha))) {
        return await this.discoveryBaseMismatch(input.issueNumber);
      }
      const inventoryRuns = this.dependencies.inventoryRuns ? await this.dependencies.inventoryRuns() : persisted.runs;
      if (this.dependencies.git.candidateV2?.reconcileOrphans) {
        const reconciled = await this.dependencies.git.candidateV2.reconcileOrphans({
          repositoryRoot: targetRoot,
          workspaceRoot: resolve(targetRoot, config.runner.workspaceRoot),
          activeCandidateRefs: inventoryRuns.flatMap((run) => run.candidateBinding ? [run.candidateBinding.candidateRef] : []),
          pendingCandidates: inventoryRuns.flatMap((run) => {
            const boundary = pendingCandidateBoundary(run);
            return !run.terminalOutcome && !run.candidateBinding && boundary
              ? [{ runId: run.runId, worktreePath: run.worktreePath, expectedHeadSha: expectedImplementationHead(run), boundary, artifactDir: config.proof.artifactDir }]
              : [];
          }),
          activeMaterializations: inventoryRuns.flatMap((run) => run.candidateMaterialization
            ? [{ path: run.candidateMaterialization.path, candidateCommitSha: run.candidateMaterialization.candidateCommitSha }]
            : []),
        });
        if (reconciled.kind === 'failed') {
          return await this.preClaimTransport(input.issueNumber, 'candidate-reconciliation-failed',
            `Candidate reconciliation failed: ${reconciled.code}; detail SHA-256: ${reconciled.detailSha256}.`);
        }
      }
      const matchingRuns = persisted.runs.filter((run) => run.issueNumber === input.issueNumber && run.canonicalRepository === canonicalRepository);
      if (matchingRuns.length > 1) return await this.preClaimInternal('ambiguous-run-state', input.issueNumber);
      const existing = matchingRuns[0];
      if (existing && expectedBaseSha !== undefined && existing.baseSha !== expectedBaseSha) {
        return await this.discoveryBaseMismatch(input.issueNumber);
      }
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
        let reauthorized = !!issue && !!active.record.terminalOutcome && active.record.terminalOutcome.status !== 'review-ready'
          && await this.dependencies.issues.isReauthorized?.(active.record, issue) === true;
        let resumedGitHubAuthorization = false;
        if (!active.record.terminalOutcome && active.record.pendingEffect?.kind === 'claim-labels') {
          const reclaimed = await this.reconcileClaim(active, config);
          if ('result' in reclaimed) return reclaimed.result;
          active = reclaimed.active;
          resumedGitHubAuthorization = true;
        }
        if (active.record.lifecycle === 'implementing' && active.record.pendingEffect?.kind === 'candidate-pin-release') {
          const released = await this.finishRepairCandidateRelease(active);
          if ('status' in released) return released;
          active = released.active;
        }
        issueSnapshot = structuredClone(existing.issueSnapshot);
        frozenCriteria = structuredClone(existing.frozenCriteria);
        runId = existing.runId;
        branchName = existing.branchName;
        worktreePath = existing.worktreePath;
        baseSha = existing.baseSha;
        if (active.record.pendingEffect?.kind === 'issue-feedback-comment') {
          try { active = await this.settleIssueFeedbackResponse(active); } catch { /* Delivery cannot replace the established outcome. */ }
          return publicOutcome(active.record.terminalOutcome!);
        }
        if (active.record.pendingEffect?.kind === 'outcome-evidence') {
          if (active.record.terminalOutcome) {
            const observed = await this.observeOutcomeEvidenceEffect(
              active,
              active.record.pendingEffect.code,
              active.record.pendingEffect.summary,
            );
            active = await this.confirmEffect(observed.active);
            if (!reauthorized) {
              active = await this.settleTerminalNotificationsBestEffort(active);
              return publicOutcome(active.record.terminalOutcome!);
            }
          } else {
            const seed = parseTerminalSeedSummary(active.record.pendingEffect.summary);
            const result = await this.terminal(active, seed, active.record.pendingEffect.code);
            const recovered = await this.dependencies.runRecords.read();
            const record = recovered.runs.find(run => run.runId === active!.record.runId);
            if (!record?.terminalOutcome || record.pendingEffect?.kind === 'outcome-evidence') return result;
            active = { state: recovered, record, config };
            reauthorized = !!issue && await this.dependencies.issues.isReauthorized?.(record, issue) === true;
            if (!reauthorized) return result;
          }
        }
        if (!reauthorized && active.record.terminalOutcome && (active.record.terminalNotifications
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
        if (reauthorized && active.record.activeAttempt?.stage === 'adopted' && !active.record.candidateMaterialization) {
          active = await this.clearAttempt(active);
        }
        if (reauthorized && active.record.terminalOutcome) {
          const resumed = await this.resumeGitHubAuthorization(active, config);
          if ('result' in resumed) return resumed.result;
          active = resumed.active;
          resumedGitHubAuthorization = true;
          issueSnapshot = structuredClone(active.record.issueSnapshot);
          frozenCriteria = structuredClone(active.record.frozenCriteria);
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
        if (expectedBaseSha !== undefined && baseSha !== expectedBaseSha) {
          return await this.discoveryBaseMismatch(input.issueNumber);
        }
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
      if (!active.record.codexSession) {
        try { await this.dependencies.verifyWorkflowGeneration(active.record.workflowGeneration); }
        catch { return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'owner-contract-upgrade-required'); }
      }
      if (!active.record.codexSession && active.record.implementationResult) return await this.terminal(active,
        { status: 'blocked', kind: 'safety', resumable: true }, 'owner-contract-upgrade-required');
      if (!await this.authorized(active, config)) return await this.revoked(active);
      if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
      if (!active.record.proofId) active = await this.persist(active, { proofId: this.dependencies.createProofId() });

      if (config.runner.checkExecution === 'host' && active.record.runnerChecks?.status === 'pending')
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'runner-checks-interrupted');

      const recoveringAndroidPreparation = active.record.androidProofPreparation?.status === 'pending';
      let androidProofRequested = recoveringAndroidPreparation;
      // One Codex session owns implementation, all verification and independent Review.
      // Recovery admits its retained final report; it never launches another semantic phase.
      if (!recoveringAndroidPreparation && (active.record.lifecycle !== 'checking' || !active.record.implementationResult?.proof
        || !active.record.implementationResult.review)) {
        if (active.record.lifecycle !== 'implementing') active = await this.persist(active, { lifecycle: 'implementing' });
        const feedbackBatch = active.record.reviewFeedback?.activeBatch;
        const workerBlock = await this.revalidateFeedbackWorker(active, config, input.issueNumber);
        if (workerBlock) return workerBlock;
        const feedbackProjection = feedbackBatch ? projectReviewFeedbackBatch(feedbackBatch, active.record.cycle) : undefined;
        let reportCorrection: { bytes: Buffer; sha256: string; diagnostic: string } | undefined;
        if (active.record.implementationReportCorrection) {
          const retained = active.record.implementationReportCorrection;
          const stored = await this.dependencies.inspectAttemptResult(retained.path);
          if (!stored || stored.sha256 !== retained.sha256) return await this.invokedFailure(active, 'implementation-report-correction-unavailable');
          reportCorrection = { bytes: stored.bytes, sha256: retained.sha256, diagnostic: retained.diagnostic };
        }
        const deniedPathsBaseline = await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths);
        if (!active.record.activeAttempt) active = await this.prepareAttempt(active, 'implementation',
          feedbackBatch ? `${feedbackBatch.batchId}:${active.record.reviewFeedback!.repairRound}`
            : `${active.record.cycle}:${active.record.reportRepairs}`);
        const attempt = active.record.activeAttempt!;
        let launchFailure: RunIssueResult | undefined;
        const implementation = await this.dependencies.implementationAgent.run({
          operation: 'implementation', attemptId: attempt.attemptId, runId, worktreePath, baseSha: active.record.baseSha,
          issue: publicIssueSnapshot(issueSnapshot), frozenCriteria,
          deliveryAuthority: active.record.deliveryAuthority!, cycle: active.record.cycle,
          reworkFindings: active.record.reworkFindings, workflowGeneration: active.record.workflowGeneration,
          proofId: active.record.proofId!, sessionId: active.record.codexSession?.id,
          androidProofPreparation: active.record.androidProofPreparation,
          runnerChecks: active.record.runnerChecks,
          ...(reportCorrection ? { reportCorrection } : {}),
          ...(feedbackBatch ? { reviewFeedbackRound: active.record.reviewFeedback!.repairRound,
            reviewFeedback: feedbackProjection!.workerFeedback, reviewFeedbackPullRequest: {
              number: feedbackBatch.pullRequest.number, headSha: feedbackBatch.pullRequest.headSha,
              headRefName: feedbackBatch.pullRequest.headRefName,
              url: `https://github.com/${active.record.canonicalRepository}/pull/${feedbackBatch.pullRequest.number}`,
            } } : {}),
          onPrepared: async prepared => {
            if (active!.record.activeAttempt?.attemptId !== prepared.attemptId
              || active!.record.activeAttempt.resultPath !== prepared.reportPath) throw new Error('implementation attempt identity mismatch');
          },
          onLaunched: async launched => {
            const failure = await this.revalidateFeedbackWorker(active!, config, input.issueNumber);
            if (failure) { launchFailure = failure; throw new Error('implementation launch authorization changed'); }
            if (active!.record.activeAttempt?.attemptId !== launched.attemptId) throw new Error('implementation launch mismatch');
            active = await this.launchAttempt(active!, launched.pid, launched.processGroupId);
          },
          onSessionStarted: async sessionId => {
            if (active!.record.codexSession && active!.record.codexSession.id !== sessionId) throw new Error('Codex session identity changed');
            if (!active!.record.codexSession) active = await this.persist(active!, {
              codexSession: { id: sessionId, startedAt: this.timestamp() },
            });
          }, signal: this.signal,
        });
        if (launchFailure) return launchFailure;
        if (implementation.kind !== 'safe-halt') active = await this.observeReturnedAttempt(active,
          implementation.kind === 'completed' ? implementation.report : implementation);
        if (implementation.kind === 'safe-halt') {
          active = await this.persist(active, { lifecycle: 'safe-halt' });
          return await this.invokedFailure(active, 'active-attempt-observation-deferred',
            'The Codex session process remains unresolved; the next tick observes its result and cleanup before continuing.');
        }
        if (await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths) !== deniedPathsBaseline)
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'denied-path-modified');
        if (implementation.kind === 'transport-failed' && implementation.resumable) {
          active = await this.clearAttempt(active);
          active = await this.persist(active, { transportRetries: active.record.transportRetries + 1 });
          return await this.invokedFailure(active, 'implementation-transport-retryable', 'The next invocation resumes the same Codex session after confirmed cleanup.');
        }
        if (implementation.kind !== 'completed') return await this.mapImplementationFailure(active, implementation);
        let report: ImplementationReportV1;
        try { report = validateImplementationReport(implementation.report, {
          issueFeedbackActive: feedbackBatch?.sources.every(source => source.kind === 'issue-comment') === true,
          ownerSessionId: active.record.codexSession?.id,
        }); } catch (error) {
          return await this.retainImplementationReportCorrection(active, implementation,
            error instanceof Error ? error.message : 'Owner completion report is invalid.');
        }
        if (report.status === 'external-block') return await this.terminal(active, implementationBlockerOutcome(report.blocker!));
        if (report.status === 'answer-only' || report.status === 'boundary') return await this.completeIssueFeedbackResponse(active,
          report as ImplementationReportV1 & { status: 'answer-only' | 'boundary'; response: string }, config);
        if (!active.record.codexSession) return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'codex-session-identity-missing');
        if (await this.dependencies.git.getHead(worktreePath) !== expectedImplementationHead(active.record))
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'implementation-head-drift');
        if (report.status === 'checks-request') {
          if (config.runner.checkExecution !== 'host' || !this.dependencies.configuredChecks)
            return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'runner-checks-unavailable');
          active = isAdoptableAttempt(active.record.activeAttempt)
            ? await this.adoptAttempt(active, sha256(canonicalJson(implementation.report)), {}) : active;
          active = await this.clearAttempt(active);
          const sourceSha256 = sha256(canonicalJson(await this.dependencies.git.snapshot(worktreePath)));
          const policySha256 = runnerCheckPolicySha256(config.checks);
          active = await this.persist(active, { lifecycle: 'checking', implementationResult: undefined,
            implementationReportCorrection: undefined, reportRepairs: 0,
            runnerChecks: { status: 'pending', sourceSha256, policySha256, results: [] } });
          if (!await this.authorized(active, config)) return await this.revoked(active);
          const protectedBefore = await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths);
          const results = await this.dependencies.configuredChecks.run({ checks: config.checks, worktreePath,
            proofId: active.record.proofId!, signal: this.signal });
          if (await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths) !== protectedBefore)
            return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'denied-path-modified');
          active = await this.persist(active, { lifecycle: 'implementing',
            runnerChecks: { status: 'complete', sourceSha256, policySha256, results } });
          return await this.invokedFailure(active, 'runner-checks-ready', 'The next invocation resumes the same Codex session with complete host-check logs and results before proof and independent Review.');
        }
        const changedFiles = await this.dependencies.git.listChangedFiles(worktreePath);
        if (changedFiles.length === 0) return await this.terminal(active, { status: 'internal-error', code: 'implementation-change-set-invalid' });
        if (!sameStrings(changedFiles, report.changedFiles)) return await this.retainImplementationReportCorrection(active, implementation,
          `The report must describe the complete current change set ${canonicalJson(changedFiles)}.`);
        androidProofRequested = report.status === 'android-proof-request';
        if (androidProofRequested && active.record.androidProofPreparation) return await this.terminal(active,
          { status: 'blocked', kind: 'safety', resumable: false }, 'android-preparation-already-requested');
        const changes = { lifecycle: 'checking' as const, transportRetries: 0, reportRepairs: 0,
          implementationReportCorrection: undefined,
          implementationResult: { summary: report.summary, residualRisks: report.residualRisks,
            checks: report.checks, ...(report.proof ? { proof: report.proof } : {}), ...(report.review ? { review: report.review } : {}) },
          checkedChangeSha256: undefined, proofExecution: undefined, proofReceipt: undefined, directReview: undefined };
        // The observed identity belongs to the raw decoded payload, including nullable proof fields.
        active = isAdoptableAttempt(active.record.activeAttempt)
          ? await this.adoptAttempt(active, sha256(canonicalJson(implementation.report)), changes) : await this.persist(active, changes);
        active = await this.clearAttempt(active);
      }

      if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
      const ownerResult = active.record.implementationResult!;
      const source = await this.dependencies.git.snapshot(worktreePath);
      if (!androidProofRequested && (!ownerResult.proof || !ownerResult.review || source.trackedContentSha256 !== ownerResult.review.trackedContentSha256
        || source.untrackedContentSha256 !== ownerResult.review.untrackedContentSha256))
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'owner-review-source-drift');
      if (config.runner.checkExecution === 'host') {
        const trusted = active.record.runnerChecks;
        if (!trusted || trusted.status !== 'complete'
          || trusted.sourceSha256 !== sha256(canonicalJson(source))
          || trusted.policySha256 !== runnerCheckPolicySha256(config.checks)
          || Object.entries(config.checks).some(([id, command]) => !trusted.results.some(result =>
            result.id === id && result.command === command && result.exitCode === 0
            && ownerResult.checks?.some(check => check.id === id && check.command === command
              && check.status === 'passed' && check.outputSha256 === result.outputSha256))))
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'runner-checks-evidence-mismatch');
      }
      const ownerChecks = ownerResult.checks;
      if (!ownerChecks || Object.entries(config.checks).some(([id, command]) =>
        !ownerChecks.some(check => check.id === id && check.command === command && check.status === 'passed')))
        return await this.terminal(active, { status: 'blocked', kind: 'external', resumable: false,
          blocker: { kind: 'tool', resumable: false, summary: 'The owner did not return passing evidence for every exact configured command.',
            attempted: ['Validate owner verification against the unchanged configured command policy.'] } }, 'implementation-verification-missing');
      const captured = await this.ensureCandidateBinding(active, config,
        active.record.reviewFeedback?.activeBatch
          ? { kind: 'review-feedback', batchId: active.record.reviewFeedback.activeBatch.batchId,
            repairRound: active.record.reviewFeedback.repairRound, authoritySha256: active.record.deliveryAuthority!.authoritySha256 }
          : { kind: 'implementation-cycle', cycle: active.record.cycle, authoritySha256: active.record.deliveryAuthority!.authoritySha256 });
      if ('status' in captured) return captured;
      active = captured.active;
      const binding = active.record.candidateBinding!;
      const target = await this.dependencies.git.diffTrees(worktreePath, active.record.baseSha, binding.candidateTreeSha);
      if (containsCredentialEvidence(target.patch)) return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-credential-evidence');
      if (!target.patch.trim() || target.changedFiles.some(path => findDeniedPathMatch(path, config.deny.readPaths)))
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-path-policy');
      const checkPolicySha256 = sha256(canonicalJson(config.checks));
      active = await this.persist(active, { checks: Object.entries(config.checks).map(([id, command]) => ({
        ...ownerChecks.find(check => check.id === id && check.command === command)!,
        bindingId: binding.bindingId, candidateTreeSha: binding.candidateTreeSha, checkPolicySha256,
      })) });
      const payload: CheckedChangePayloadV2 = {
        version: 2, canonicalRepository, runId, issueNumber: input.issueNumber, cycle: active.record.cycle,
        baseSha: expectedImplementationHead(active.record), deliveryAuthoritySha256: active.record.deliveryAuthority!.authoritySha256,
        binding: structuredClone(binding), changedFiles: [...binding.canonicalChangedFiles],
        checks: active.record.checks as CheckedChangePayloadV2['checks'], checkPolicySha256,
        packageVersion: active.record.packageVersion, proofSchemaVersion: 1,
      };
      const checkedChangeSha256 = checkedChangePayloadSha256(payload);
      if (active.record.checkedChangeSha256 && active.record.checkedChangeSha256 !== checkedChangeSha256)
        return await this.persistCandidateEvidenceSafetyTerminal(active, 'checked-change-recovery-binding-drift');
      active = await this.persist(active, { checkedChangeSha256 });
      if (androidProofRequested) {
        if (!this.dependencies.proof.prepareAndroid) return await this.terminal(active,
          { status: 'blocked', kind: 'external', resumable: false }, 'android-preparation-unavailable');
        if (!recoveringAndroidPreparation) active = await this.persist(active, { androidProofPreparation: {
          status: 'pending', checkedChangeSha256, runnerPreparedArtifactPaths: [], runnerPreparedArtifactSha256: {}, runnerPreparationWarnings: [],
        } });
        let prepared;
        try { prepared = await this.dependencies.proof.prepareAndroid({ proofId: active.record.proofId!,
          issue: publicIssueSnapshot(issueSnapshot), observeOnly: recoveringAndroidPreparation, checkedChange: this.dependencies.checkedChangeMint.mint(payload) }); }
        catch (error) {
          await this.dependencies.proof.cleanupMobileLeases?.({ canonicalRepository, worktreePath, proofId: active.record.proofId! });
          throw error;
        }
        if (prepared.status === 'blocked') await this.dependencies.proof.cleanupMobileLeases?.({ canonicalRepository, worktreePath, proofId: active.record.proofId! });
        const preparation = prepared;
        active = await this.persist(active, { androidProofPreparation: { ...preparation, checkedChangeSha256 }, lifecycle: 'implementing' });
        return await this.invokedFailure(active, 'android-preparation-ready', 'The next invocation resumes the same Codex session with the Runner resource result.');
      }
      const admitted = active.record.proofReceipt
        ? { status: 'passed' as const, receipt: active.record.proofReceipt }
        : await this.dependencies.proof.admitReport({
        proofId: active.record.proofId!, proofStartedAt: active.record.codexSession!.startedAt,
        issue: publicIssueSnapshot(issueSnapshot), frozenCriteria, checkedChange: this.dependencies.checkedChangeMint.mint(payload),
        report: ownerResult.proof!,
      });
      if (admitted.status === 'cleanup-pending') {
        if (admitted.outcome.status === 'passed') active = await this.persist(active, { proofReceipt: admitted.outcome.receipt });
        return await this.invokedFailure(active, 'acceptance-proof-cleanup-pending', 'Mobile resources must be released before publication.');
      }
      if (admitted.status !== 'passed') return await this.mapProofFailure(active, admitted);
      if (this.dependencies.proof.cleanupMobileLeases) {
        try { await this.dependencies.proof.cleanupMobileLeases({ canonicalRepository,
          worktreePath, proofId: active.record.proofId! }); }
        catch { active = await this.persist(active, { proofReceipt: admitted.receipt });
          return await this.invokedFailure(active, 'acceptance-proof-cleanup-pending'); }
      }
      active = await this.persist(active, { lifecycle: 'publishing', proofReceipt: admitted.receipt,
        ...(active.record.reviewFeedback?.activeBatch ? { reviewFeedback: markReviewFeedbackVerified(active.record.reviewFeedback,
          { checkedChangeSha256, proofId: active.record.proofId!, verifiedAt: this.timestamp() }) } : {}) });
      if (!await this.authorized(active, config)) return await this.revoked(active);
      return active.record.reviewFeedback?.activeBatch
        ? await this.updateExistingPullRequest(active, config, input.issueNumber)
        : await this.publish(active, config, issueSnapshot, input.issueNumber);
    } catch (error) {
      if (error instanceof RunConfigurationError) {
        return active
          ? this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'config-invalid')
          : this.preClaimInternal('config-invalid', input.issueNumber);
      }
      if (!active && error instanceof TransportReadError) {
        return await this.preClaimTransport(input.issueNumber, 'issue-read-failed', error.message);
      }
      if (!active && error instanceof WorkflowGenerationUnrecoverableError) {
        return await this.preClaimInternal('workflow-generation-unrecoverable', input.issueNumber);
      }
      if (active && error instanceof PostEffectStateError) {
        return await this.invokedFailure(error.active, 'post-effect-state-write-failed');
      }
      if (active && error instanceof TransportReadError) {
        return await this.invokedFailure(active, 'authorization-read-failed', error.message);
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
      const diagnostic = error instanceof Error ? error.message : 'Runner operation failed.';
      if (active) return await this.invokedFailure(active, 'runner-operation-failed', publicBlockedText(diagnostic, 'Runner operation failed.', 1024));
      return await this.preClaimTransport(input.issueNumber);
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

  private async resumeGitHubAuthorization(active: ActiveRun, config: AgentAutoConfig): Promise<{ active: ActiveRun } | { result: RunIssueResult }> {
    const stopped = active.record.terminalOutcome!;
    const unchanged = () => ({ result: publicOutcome(stopped) });
    if (active.record.activeAttempt || active.record.candidateMaterialization
      || (active.record.pendingEffect && !['terminal-comment', 'terminal-labels'].includes(active.record.pendingEffect.kind))) return unchanged();
    const issue = await this.readIssue(active.record.issueNumber);
    if (!issue || await this.dependencies.issues.isReauthorized?.(active.record, issue) !== true) return unchanged();
    // Current authorization does not permit replacing an existing PR or accepting drifted local work.
    if (await this.ineligibilityReason(issue, config)) return unchanged();
    if (active.record.codexSession) await this.dependencies.verifyWorkflowGeneration(active.record.workflowGeneration);
    if (await this.dependencies.git.inspectWorktree({ worktreePath: active.record.worktreePath,
      branchName: active.record.branchName, baseSha: expectedImplementationHead(active.record) }) !== 'matching') return unchanged();
    if (active.record.candidateBinding) {
      const pin = await this.dependencies.git.candidateV2?.inspectPin(active.record.candidateBinding);
      if (pin?.kind !== 'ok' || pin.value !== 'matching') return unchanged();
    }
    const refreshed = await this.readIssue(active.record.issueNumber);
    if (!refreshed || await this.dependencies.issues.isReauthorized?.(active.record, refreshed) !== true) return unchanged();
    const refreshedWorkflow = await this.dependencies.createWorkflowGeneration();
    const issueSnapshot = snapshotIssue(refreshed);
    const frozenCriteria = freezeCriteria(issueSnapshot);
    const deliveryAuthority = createIssueDeliveryAuthority({ issueNumber: issueSnapshot.number,
      issueUrl: issueSnapshot.url, authorizationLabel: config.github.labels.auto.name,
      title: issueSnapshot.title, body: issueSnapshot.body });
    await this.dependencies.writeEvidence({ runId: active.record.runId, code: 'github-reauthorization',
      summary: canonicalJson({ previousOutcome: stopped, lifecycle: 'implementing', refreshedTask: true }) });
    active = await this.persist(active, { lifecycle: 'implementing', terminalOutcome: undefined, outcomeEvidenceId: undefined,
      terminalNotifications: undefined, issueSnapshot, frozenCriteria, deliveryAuthority,
      workflowGeneration: refreshedWorkflow.receipt,
      skillHashes: refreshedWorkflow.skillHashes, packageVersion: this.dependencies.packageVersion,
      directReview: undefined, reworkFindings: [], androidProofPreparation: undefined, runnerChecks: undefined, checks: [], implementationResult: undefined, checkedChangeSha256: undefined,
      proofReceipt: undefined, proofExecution: undefined, proofId: this.dependencies.createProofId(),
      implementationReportCorrection: undefined, reportRepairs: 0,
      pendingEffect: undefined });
    const released = await this.clearAndReleaseCandidate(active);
    if ('status' in released) return { result: released };
    active = released.active;
    active = await this.persist(active, { cycle: active.record.cycle + 1,
      pendingEffect: { kind: 'claim-labels', issueNumber: active.record.issueNumber,
        expected: sortedUnique([config.github.labels.auto.name, config.github.labels.running.name]) } });
    const claimed = await this.reconcileClaim(active, config);
    if ('result' in claimed) return claimed;
    return { active: claimed.active };
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
    let config: AgentAutoConfig;
    try { config = parseAgentAutoConfig(value.config); }
    catch (error) { throw new RunConfigurationError(error instanceof Error ? error.message : 'Run configuration is invalid.'); }
    return { bytes: Buffer.from(value.bytes), config };
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
    } catch (error) {
      throw new TransportReadError(error);
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
    if (Object.hasOwn(changes, 'terminalOutcome') && changes.terminalOutcome === undefined) {
      delete record.terminalAuthorizationGrantId;
      if (!Object.hasOwn(changes, 'terminalNotifications')) delete record.terminalNotifications;
    }
    for (const key of ['terminalAuthorizationGrantId', 'checkedChangeSha256', 'proofId', 'proofExecution', 'proofReceipt', 'terminalOutcome', 'outcomeEvidenceId', 'reviewFeedback', 'changeBindingVersion', 'candidateBinding', 'candidateMaterialization', 'activeAttempt', 'terminalNotifications', 'failedCheckRepair', 'implementationReportCorrection', 'directReview', 'implementationResult', 'codexSession', 'androidProofPreparation', 'runnerChecks'] as const) {
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
    catch (error) { throw new TransportReadError(error); }
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
    if (!candidate) return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-git-v2-required');
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
      // Match normal completion: identify the decoded payload before validation normalizes it.
      result: result ? { path: attempt.resultPath, sha256: attempt.operationId === 'implementation'
        ? sha256(canonicalJson(decodeAgentReportForValidation(result.bytes))) : result.sha256 } : null,
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

  private async prepareCandidateMaterialization(
    active: ActiveRun,
    config: AgentAutoConfig,
    operation: 'direct-review' | 'acceptance-proof',
    operationSourceId: string,
  ): Promise<{ active: ActiveRun; materialization: CandidateMaterializationV2 } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    if (!candidate || !binding) return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-git-v2-required');
    const materializationId = sha256(canonicalJson({ bindingId: binding.bindingId, operation, operationSourceId }));
    const retained = active.record.candidateMaterialization;
    const attempt = active.record.activeAttempt;
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
      operation === 'direct-review' ? 'code-review' : 'acceptance-proof',
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
    if (!candidate || !binding || !materialization) return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-materialization-state-missing');
    const attempt = active.record.activeAttempt;
    if (attempt?.stage !== (settledPreLaunch ? 'prepared' : 'adopted')) {
      return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-result-adoption-unconfirmed');
    }
    const inspection = await candidate.inspectMaterialization({
      binding, materialization, artifactDir: config.proof.artifactDir,
    });
    if (inspection.kind === 'failed') return this.mapCandidateFailure(active, inspection.code);
    if (inspection.value !== 'matching') {
      return this.reconcilePersistedCandidateMaterialization(active, config);
    }
    const removed = await candidate.removeMaterialization({ materialization });
    if (removed.kind === 'failed') return this.mapCandidateFailure(active, removed.code);
    const proofExecution = active.record.proofExecution;
    const changes: Partial<RunRecord> = { candidateMaterialization: undefined };
    if (proofExecution?.cleanupOutcome) {
      const { cleanupOutcome: _cleanupOutcome, ...settledProofExecution } = proofExecution;
      changes.proofExecution = settledProofExecution;
    }
    let cleared = await this.persist(active, changes);
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
    const inspection = await candidate.inspectMaterialization({
      binding, materialization, artifactDir: config.proof.artifactDir,
    });
    if (inspection.kind === 'failed') return this.mapCandidateFailure(active, inspection.code);
    if (inspection.value === 'missing') {
      return active.record.terminalOutcome
        ? { active: await this.persist(active, { candidateMaterialization: undefined }) }
        : this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-execution-missing');
    }
    if (inspection.value === 'mutated') {
      return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-materialization-mutated');
    }
    if (active.record.activeAttempt?.stage === 'observed' && active.record.activeAttempt.result) {
      return { active };
    }
    if (active.record.activeAttempt?.stage === 'adopted'
      && active.record.activeAttempt.operationId === 'acceptance-proof'
      && !active.record.proofReceipt) {
      return active.record.proofExecution?.reportCorrection
        ? { active: await this.clearAttempt(active) }
        : { active };
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
    return this.settleCandidateMaterialization(active, config);
  }

  private async clearAndReleaseCandidate(active: ActiveRun): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    if (!candidate || !binding) return { active };
    if (active.record.candidateMaterialization) return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-materialization-not-cleared');
    const normalized = await candidate.normalizeSharedIndex({
      worktreePath: active.record.worktreePath,
      expectedHeadSha: expectedImplementationHead(active.record),
    });
    if (normalized.kind === 'failed') return this.mapCandidateFailure(active, normalized.code);
    const retained = await this.persist(active, { pendingEffect: { kind: 'candidate-pin-release', bindingId: binding.bindingId, expectedPinnedCommitSha: binding.candidateCommitSha } });
    return this.finishRepairCandidateRelease(retained);
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
    return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, evidenceCode);
  }

  private async mapCandidateFailure(active: ActiveRun, code: string): Promise<RunIssueResult> {
    if (code === 'candidate-unstable' || code === 'candidate-io-failed' || code === 'candidate-materialization-io-failed') {
      return this.invokedFailure(active, code, 'Candidate operation failed before an effect and may be retried without consuming a repair budget.');
    }
    return await this.terminal(active, { status: 'transport-failed', resumable: false }, code);
  }

  private async admitConfiguredCheckReceipts(
    active: ActiveRun,
    config: AgentAutoConfig,
    publication: boolean,
  ): Promise<RunIssueResult | undefined> {
    let publishedTreeSha: string | undefined;
    if (publication && !active.record.candidateBinding) {
      try {
        publishedTreeSha = (await this.dependencies.git.inspectHead(active.record.worktreePath)).treeSha;
      } catch {
        return this.invokedFailure(active, 'configured-check-tree-observation-unavailable',
          'The committed candidate tree could not be inspected. Work and pending publication intent are preserved for retry.');
      }
    }
    if (!hasCurrentConfiguredCheckReceipts(active.record, config.checks, publishedTreeSha)) {
      return this.invokedFailure(active, 'configured-check-policy-drift',
        'Retained validation does not confirm every current configured check on this candidate. Work, proof, and pending publication intent are preserved.');
    }
    return undefined;
  }

  private async retainImplementationReportCorrection(
    active: ActiveRun,
    implementation: Extract<ImplementationAgentResult, { kind: 'completed' }>,
    diagnostic: string,
  ): Promise<RunIssueResult> {
    const bytes = implementation.reportBytes ?? Buffer.from(canonicalJson(implementation.report));
    if (bytes.length > 1024 * 1024 || containsCredentialEvidence(bytes.toString('utf8'))
      || !Buffer.from(bytes.toString('utf8')).equals(bytes)) return await this.terminal(active,
        { status: 'blocked', kind: 'safety', resumable: false }, 'implementation-report-correction-unsafe');
    const hash = sha256(bytes);
    const path = `${active.record.activeAttempt!.resultPath}.report-correction-${hash}`;
    await this.dependencies.writeAttemptResult({ path, bytes, sha256: hash });
    const stored = await this.dependencies.inspectAttemptResult(path);
    if (!stored || stored.sha256 !== hash) return this.invokedFailure(active, 'implementation-report-correction-write-pending');
    const changes = { reportRepairs: active.record.reportRepairs + 1,
      implementationReportCorrection: { path, sha256: hash, diagnostic } };
    active = isAdoptableAttempt(active.record.activeAttempt)
      ? await this.adoptAttempt(active, sha256(canonicalJson(implementation.report)), changes)
      : await this.persist(active, changes);
    active = await this.clearAttempt(active);
    return this.invokedFailure(active, 'implementation-report-retryable',
      `The existing implementation report requires correction: ${diagnostic}`);
  }

  private async finishRepairCandidateRelease(active: ActiveRun): Promise<{ active: ActiveRun } | RunIssueResult> {
    const effect = active.record.pendingEffect;
    const binding = active.record.candidateBinding;
    const candidate = this.dependencies.git.candidateV2;
    if (!candidate || !binding || effect?.kind !== 'candidate-pin-release'
      || binding.bindingId !== effect.bindingId || binding.candidateCommitSha !== effect.expectedPinnedCommitSha)
      return this.invokedFailure(active, 'candidate-pin-release-binding-diverged');
    const settled = await settleCleanupEffect(effect, {
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
    if (settled.status !== 'confirmed') return this.invokedFailure(active, 'candidate-pin-release-pending', 'The exact owned candidate cleanup intent remains durable for the next bounded tick.');
    return { active: await this.persist(active, { pendingEffect: undefined, changeBindingVersion: undefined, candidateBinding: undefined }) };
  }

  private async blockReviewFeedback(
    active: ActiveRun,
    kind: 'external' | 'safety' | 'decision-delta' | 'out-of-scope' | 'authority-boundary',
    evidenceCode: string,
    outcome: Extract<TerminalSeed, { status: 'blocked' }> = { status: 'blocked', kind, resumable: false },
  ): Promise<RunIssueResult> {
    return await this.terminal(active, outcome, evidenceCode);
  }

  private async mapImplementationFailure(
    active: ActiveRun,
    result: Exclude<ImplementationAgentResult, { kind: 'completed' } | { kind: 'safe-halt' }>,
  ): Promise<RunIssueResult> {
    if (result.kind === 'transport-failed') return await this.terminal(active, { status: 'transport-failed', resumable: result.resumable });
    if (result.kind === 'cancelled') return await this.terminal(active, { status: 'cancelled' });
    return await this.terminal(active, { status: 'internal-error', code: 'implementation-agent-internal-failure' });
  }

  private async mapProofFailure(active: ActiveRun, proof: Exclude<ProveChangeResult, { status: 'passed' }>): Promise<RunIssueResult> {
    if (proof.status === 'needs-rework') return await this.terminal(active, { status: 'internal-error', code: 'owner-proof-admission-rejected' });
    if (proof.status === 'external-block') {
      return await this.terminal(active, implementationBlockerOutcome(proof.blocker));
    }
    if (proof.status === 'transport-failed') return await this.terminal(active, { status: 'transport-failed', resumable: proof.resumable });
    if (proof.status === 'cancelled') return await this.terminal(active, { status: 'cancelled' });
    if (proof.status === 'internal-error') {
      try {
        await this.dependencies.writeEvidence({
          runId: active.record.runId,
          code: 'acceptance-proof-diagnostic',
          summary: canonicalJson({
            summary: publicBlockedText(proof.receipt.summary, 'Proof failure detail was redacted.', 1024),
            packageVersion: active.record.packageVersion,
            workflowGenerationHash: active.record.workflowGeneration.generationHash,
            workflowManifestSha256: active.record.workflowGeneration.manifestSha256,
            candidateCommitSha: active.record.candidateBinding?.candidateCommitSha ?? null,
          }),
        });
      } catch {
        // Diagnostic storage is best-effort; it cannot authorize proof or prevent the safe terminal outcome.
      }
    }
    return await this.terminal(active, { status: 'internal-error', code: 'acceptance-proof-internal-failure' });
  }

  private async revoked(active: ActiveRun): Promise<RunIssueResult> {
    if (active.record.pendingEffect) return this.invokedFailure(active, 'revoked-with-pending-effect');
    return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'authorization-revoked');
  }

  private async invokedFailure(
    active: ActiveRun,
    code: string,
    summary = 'Publication delivery requires reconciliation.',
    failure?: ProofProcessFailure,
  ): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code, summary, ...(failure ? { failure } : {}) });
    return { status: 'transport-failed', resumable: true, evidencePath: evidence.path };
  }

  private async observeOutcomeEvidenceEffect(
    active: ActiveRun,
    code: string,
    summary: string,
    authorizationGrantId?: string,
  ): Promise<{ active: ActiveRun; path: string; id: string }> {
    if (!active.record.pendingEffect) {
      const recordedAt = this.timestamp();
      // Include immutable occurrence context so a later terminal outcome for the
      // same run/code/summary cannot collide with bytes written by an earlier one.
      const occurrenceSha256 = code === 'review-ready'
        ? sha256(summary)
        : sha256(canonicalJson({
          summarySha256: sha256(summary),
          recordedAt,
          authorizationGrantId: authorizationGrantId ?? null,
        }));
      const path = this.dependencies.outcomeEvidencePath(active.record.runId, code, occurrenceSha256);
      const bytes = outcomeEvidenceBytes({ runId: active.record.runId, code, summary, recordedAt });
      active = await this.persist(active, { pendingEffect: {
        kind: 'outcome-evidence', path, runId: active.record.runId, code, summary, recordedAt, bytesSha256: sha256(bytes),
        ...(authorizationGrantId ? { authorizationGrantId } : {}),
      } });
    }
    const effect = active.record.pendingEffect;
    const legacyPath = this.dependencies.outcomeEvidencePath(active.record.runId, code, sha256(summary));
    const occurrenceSha256 = effect?.kind === 'outcome-evidence'
      ? effect.code === 'review-ready'
        ? sha256(summary)
        : sha256(canonicalJson({
          summarySha256: sha256(summary),
          recordedAt: effect.recordedAt,
          authorizationGrantId: effect.authorizationGrantId ?? null,
        }))
      : '';
    const occurrencePath = this.dependencies.outcomeEvidencePath(active.record.runId, code, occurrenceSha256);
    if (effect?.kind !== 'outcome-evidence' || effect.runId !== active.record.runId
      || effect.code !== code || effect.summary !== summary
      || (effect.path !== occurrencePath && effect.path !== legacyPath)) {
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
      return await this.terminal(active, { status: 'internal-error', code: 'issue-feedback-response-source-invalid' });
    }
    if (await this.dependencies.git.getHead(active.record.worktreePath) !== batch.priorPublishedHeadSha
      || (await this.dependencies.git.listChangedFilesIgnoringUntrackedRoot(
        active.record.worktreePath, config.proof.artifactDir,
      )).length !== 0) {
      return await this.terminal(active, { status: 'internal-error', code: 'issue-feedback-response-mutated-worktree' });
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

    const sourceIds = batch.sources.map(source => source.sourceId);
    const pullRequest = await this.dependencies.pullRequests.findOpen({
      headBranch: active.record.branchName,
      baseBranch: config.github.baseBranch,
    });
    if (!pullRequest?.url || pullRequest.number !== batch.pullRequest.number
      || pullRequest.nodeId !== batch.pullRequest.nodeId || pullRequest.headSha !== batch.pullRequest.headSha
      || pullRequest.headRefName !== batch.pullRequest.headRefName
      || pullRequest.baseRefName !== batch.pullRequest.baseRefName) {
      return await this.terminal(
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
      proofId: active.record.proofReceipt?.proofId,
      pendingEffect: { kind: 'issue-feedback-comment' as const, issueNumber: active.record.issueNumber, batchId: batch.batchId, batch: structuredClone(batch), marker, body, bodySha256: sha256(body) },
      terminalOutcome,
      outcomeEvidenceId: `evidence:${active.record.runId}:review-ready`,
      reviewFeedback: respondReviewFeedback(feedback, initialReceipt),
      directReview: undefined,
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

    try { active = await this.settleIssueFeedbackResponse(active); } catch { /* Exact durable intent remains for the next tick. */ }
    return publicOutcome(active.record.terminalOutcome!);
  }

  private async settleIssueFeedbackResponse(starting: ActiveRun): Promise<ActiveRun> {
    let active = starting;
    const effect = active.record.pendingEffect;
    if (effect?.kind !== 'issue-feedback-comment') return active;
    const feedback = active.record.reviewFeedback;
    const prior = feedback?.history.at(-1);
    if (!feedback || prior?.kind !== 'responded' || prior.batchId !== effect.batchId
      || effect.issueNumber !== active.record.issueNumber || sha256(effect.body) !== effect.bodySha256
      || effect.marker !== `<!-- codex-orchestrator:run:${active.record.runId}:issue-feedback:${effect.batchId} -->`) return active;
    const settlement = await settleCommentEffect(effect, {
      observe: async () => {
        const issue = await this.readIssue(effect.issueNumber);
        const matches = issue ? commentsWithMarker(issue, effect.marker) : [];
        if (matches.length > 0) return matches.length === 1 && sha256(matches[0]!.body) === effect.bodySha256 ? 'confirmed' : 'diverged';
        if (!issue || issue.state !== 'OPEN' || !issue.labels.includes(active.config.github.labels.auto.name)
          || !this.hasTrustedClaim(issue, active.record)) return 'diverged';
        const validation = await this.dependencies.reviewFeedback?.revalidate({
          batch: effect.batch, issueNumber: effect.issueNumber, epoch: 'pre-update', expectedHeadSha: effect.batch.priorPublishedHeadSha,
        });
        if (validation?.status === 'retryable') throw new TransportReadError();
        return validation?.status === 'valid' ? 'absent' : 'diverged';
      },
      invoke: async () => {
        const issue = await this.readIssue(effect.issueNumber);
        if (!issue || issue.state !== 'OPEN' || !issue.labels.includes(active.config.github.labels.auto.name)
          || !this.hasTrustedClaim(issue, active.record)) throw new LaunchAuthorizationRevokedError(active);
        const validation = await this.dependencies.reviewFeedback?.revalidate({ batch: effect.batch, issueNumber: effect.issueNumber,
          epoch: 'pre-update', expectedHeadSha: effect.batch.priorPublishedHeadSha });
        if (validation?.status !== 'valid') throw new TransportReadError();
        await this.dependencies.issues.postComment(effect.issueNumber, effect.body);
      },
    });
    if (settlement.status === 'unknown' || settlement.status === 'unobserved' || settlement.status === 'unauthorized') return active;
    const { diagnostic: _deliveryDiagnostic, commentId: _priorCommentId, ...retainedReceipt } = prior;
    const receipt = { ...retainedReceipt, publication: settlement.status === 'confirmed' ? 'delivered' as const : 'suppressed' as const,
      ...(settlement.status === 'confirmed' ? { commentId: `marker:${effect.batchId}` }
        : { diagnostic: 'issue-feedback-response-observation-diverged' }) };
    active = await this.persist(active, { reviewFeedback: settleReviewFeedbackResponse(feedback, receipt), pendingEffect: undefined });
    try { await this.dependencies.issues.setLabels(effect.issueNumber, [active.config.github.labels.review.name]); } catch { return active; }
    return this.clearAttempt(active);
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
    if (active.record.proofId && this.dependencies.proof.cleanupMobileLeases) {
      try {
        await this.dependencies.proof.cleanupMobileLeases({
          canonicalRepository: active.record.canonicalRepository,
          worktreePath: active.record.candidateMaterialization?.path ?? active.record.worktreePath, proofId: active.record.proofId,
        });
        if (active.record.proofExecution?.cleanupOutcome) {
          const { cleanupOutcome: _cleanupOutcome, ...settledProofExecution } = active.record.proofExecution;
          active = await this.persist(active, { proofExecution: settledProofExecution });
        }
      } catch {
        return this.invokedFailure(active, 'acceptance-proof-cleanup-pending', 'Mobile resources must be released before the Run can finish.');
      }
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
    let notifications = active.record.terminalNotifications!;
    if (notifications.comment.status === 'delivered' || notifications.comment.diagnostic === 'terminal-comment-observation-diverged') return active;
    if (notifications.comment.status === 'exhausted') {
      notifications = { ...notifications, comment: { ...notifications.comment, status: 'pending' } };
      active = await this.persist(active, { terminalNotifications: notifications });
    }
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
        const matching = issue ? commentsWithMarker(issue, marker) : [];
        if (matching.length > 0) return matching.length === 1 && sha256(matching[0]!.body) === effect.bodySha256 ? 'confirmed' : 'diverged';
        if (!issue || issue.state !== 'OPEN' || !this.hasTrustedClaim(issue, active.record)) return 'diverged';
        return 'absent';
      },
      authorize: async () => {
        const issue = await this.readIssue(effect.issueNumber);
        return !!issue && issue.state === 'OPEN' && this.hasTrustedClaim(issue, active.record);
      },
      invoke: () => this.dependencies.issues.postComment(effect.issueNumber, body),
    });
    const delivered = settlement.status === 'confirmed';
    const status = delivered ? 'delivered' as const
      : settlement.status === 'diverged' ? 'exhausted' as const : 'pending' as const;
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
    if (notifications.labels.diagnostic === 'terminal-labels-observation-diverged') return active;
    if (notifications.labels.status === 'exhausted') {
      notifications = { ...notifications, labels: { ...notifications.labels, status: 'pending' } };
      active = await this.persist(active, { terminalNotifications: notifications });
    }
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
      authorize: async () => {
        const autoLabel = active.config.github.labels.auto.name;
        if (!policy.remove.includes(autoLabel) || !this.dependencies.issues.isReauthorized) return true;
        const issue = await this.readIssue(effect.issueNumber);
        return !!issue && await this.dependencies.issues.isReauthorized(active.record, issue) !== true;
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
      : settlement.status === 'diverged' ? 'exhausted' as const : 'pending' as const;
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
    let terminalAuthorizationGrantId: string | undefined;
    const recoveringOutcomeEvidence = active.record.pendingEffect?.kind === 'outcome-evidence';
    if (!recoveringOutcomeEvidence) {
      try { terminalAuthorizationGrantId = await this.dependencies.issues.getAuthorizationGrantId?.(
        active.record.issueNumber, active.config.github.labels.auto.name); }
      catch { /* Without a baseline, only a provably later GitHub grant may reopen this outcome. */ }
    }
    const evidence = await this.observeOutcomeEvidenceEffect(
      active, evidenceCode, canonicalJson(outcome), terminalAuthorizationGrantId,
    );
    active = evidence.active;
    terminalAuthorizationGrantId = active.record.pendingEffect?.kind === 'outcome-evidence'
      ? active.record.pendingEffect.authorizationGrantId : undefined;
    const terminalOutcome = { ...outcome, evidencePath: evidence.path } as RunTerminalOutcome;
    let terminalComments = active.record.issueSnapshot.comments ?? [];
    if (outcome.status !== 'transport-failed') {
      try {
        terminalComments = (await this.readIssue(active.record.issueNumber))?.comments ?? terminalComments;
      } catch {
        // Terminal notification observation is best-effort and cannot change the Run outcome.
      }
    }
    const notifications = terminalNotificationState(active.record, outcome, this.timestamp(), terminalComments, evidenceCode);
    const changes: Partial<RunRecord> & { pendingEffect?: PendingEffect | undefined } = {
      ...additionalChanges,
      ...(outcome.status === 'review-ready' ? { failedCheckRepair: undefined } : {}),
      lifecycle: outcome.status,
      terminalOutcome,
      terminalAuthorizationGrantId,
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
    if (recoveringOutcomeEvidence) {
      try {
        const issue = await this.readIssue(active.record.issueNumber);
        if (issue && await this.dependencies.issues.isReauthorized?.(active.record, issue) === true) return publicOutcome(terminalOutcome);
      } catch { return publicOutcome(terminalOutcome); }
    }
    active = await this.settleTerminalNotificationsBestEffort(active);
    return publicOutcome(terminalOutcome);
  }

  private async discoveryBaseMismatch(issueNumber: number): Promise<RunIssueResult> {
    const reason = 'The execution base differs from the analyzed commit; revalidate the issue on the current remote base.';
    const evidence = await this.dependencies.writeEvidence({ runId: `issue-${issueNumber}`, code: 'discovery-base-mismatch', summary: reason });
    return { status: 'not-eligible', reason, evidencePath: evidence.path };
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

class TransportReadError extends Error {
  constructor(cause?: unknown) {
    super(transportReadSummary(cause), { cause });
  }
}

function transportReadSummary(error: unknown): string {
  if (!(error instanceof Error)) return 'Issue read failed.';
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  return publicBlockedText(`Issue read failed: ${error.message}${stderr ? `; ${stderr}` : ''}`, 'Issue read failure detail was redacted.', 1024);
}
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

function terminalNotificationState(
  record: RunRecord,
  outcome: TerminalSeed,
  observedAt: string,
  comments: Array<{ id?: string }>,
  evidenceCode?: string,
): TerminalNotificationStateV1 | undefined {
  if (outcome.status === 'transport-failed') return undefined;
  const commentId = issueCommentHighWaterMark(comments);
  return {
    version: 1,
    commentCutoff: { commentId, observedAt },
    report: terminalReportSnapshot(record, outcome, evidenceCode),
    comment: { status: 'pending', attempts: 0 },
    labels: { status: 'pending', attempts: 0 },
  };
}

function terminalReportSnapshot(record: RunRecord, outcome: Exclude<TerminalSeed, { status: 'transport-failed' }>, evidenceCode?: string): TerminalReportSnapshotV1 {
  const code = evidenceCode ?? (outcome.status === 'internal-error' ? outcome.code : outcome.status);
  const diagnostic = blockedDiagnostic(code, record);
  const summary = outcome.status === 'blocked'
    ? `${outcome.blocker?.summary ?? diagnostic.summary} (Code: ${code})`
    : outcome.status === 'internal-error'
      ? internalErrorSummary(outcome.code)
      : outcome.status === 'cancelled'
        ? 'The run was cancelled before completion.'
        : record.implementationResult?.summary ?? record.proofReceipt?.summary ?? 'The authorized implementation is ready for review.';
  const nextAction = outcome.status === 'review-ready'
    ? 'Review the draft PR. To request an in-scope follow-up, comment on this issue.'
    : outcome.status === 'blocked'
      ? diagnostic.nextAction ?? (outcome.resumable
        ? 'Resolve the stated blocker, then rerun the same issue.'
        : outcome.kind === 'external'
          ? 'Inspect the retained report and Runner diagnostics, correct the reported condition, then explicitly retry the retained work.'
          : 'Provide the missing decision or authority in this issue before continuing.')
      : outcome.status === 'internal-error'
        ? 'Inspect the package-owned evidence for the code above, correct the runner condition, and retry the same issue.'
        : 'Re-add the authorization label and rerun the same issue if the work should continue.';
  return {
    version: 1,
    outcome: outcome.status,
    summary: publicTerminalText(summary, 'Terminal summary is unavailable.'),
    ...(outcome.status === 'review-ready' ? { pullRequestUrl: outcome.pullRequestUrl } : {}),
    retainedWork: [
      ...(record.implementationResult ? [publicTerminalText(
        `Implementation report retained: ${record.implementationResult.summary}`, 'Implementation report retained; its detail was redacted.',
      )] : []),
      ...(record.candidateBinding ? ['An immutable Git candidate is retained.'] : []),
    ],
    passedChecks: record.checks.filter((check) => check.status === 'passed').slice(0, 16)
      .map((check) => publicTerminalText(check.id, 'Unnamed check.', 200)),
    publishableProof: (record.proofReceipt?.publishableEvidence ?? []).slice(0, 4).map((proof) => publicTerminalText(
      `${proof.ref}: ${proof.description}`, 'Publishable proof detail is unavailable.', 500,
    )),
    unverified: record.proofReceipt ? [] : ['No verified proof receipt was retained.'],
    risks: (record.implementationResult?.residualRisks ?? []).slice(0, 4)
      .map((risk) => publicTerminalText(risk, 'Risk detail is unavailable.', 500)),
    reviewFocus: (record.implementationResult?.review?.coverage ?? []).slice(0, 8)
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

function blockedDiagnostic(code: string, record: RunRecord): { summary: string; nextAction?: string } {
  if (code === 'candidate-git-v2-required') return {
    summary: record.candidateBinding
      ? 'The Runner cannot freeze and verify the exact Git candidate because its candidate Git adapter is unavailable.'
      : 'The Runner cannot freeze and verify the exact Git candidate: the required Git candidate adapter or immutable candidate binding is unavailable.',
    nextAction: 'Repair the Runner candidate handling, then rerun this issue. Retain the existing worktree; checks, Acceptance Proof and Review must pass before publication.',
  };
  const summaries: Record<string, string> = {
    'authorization-revoked': 'The issue no longer authorizes this run. The Runner stopped before doing further work.',
    'denied-path-modified': 'Implementation changed a protected path that this issue is not allowed to modify.',
    'implementation-head-drift': 'The implementation changed the worktree Git HEAD. The Runner cannot attribute those commits to its authorized candidate.',
    'candidate-pin-missing': 'The saved Git reference for the exact candidate is missing. Previous checks cannot establish the identity of the remaining files.',
    'candidate-pin-diverged': 'The saved Git reference points to a different candidate. Previous checks and proof cannot authorize publication of that version.',
    'configured-check-policy-drift': 'The configured checks changed after validation started; the recorded results no longer match the required check policy.',
    'candidate-check-launch-ownership-required': 'The check adapter cannot record ownership of its process, so the Runner cannot safely track completion or recovery.',
    'checked-change-candidate-binding-drift': 'The checked change does not match the frozen Git candidate. Its check results cannot authorize proof or publication.',
    'checked-change-recovery-binding-drift': 'The recovered check results do not match the frozen Git candidate. They cannot be reused.',
    'config-invalid': 'The Runner configuration failed validation before publication.',
    'candidate-materialization-state-missing': 'The saved state for the isolated candidate workspace is missing; its execution cannot be safely recovered.',
    'candidate-materialization-mutated': 'The isolated candidate workspace changed during validation. Its results no longer prove the frozen candidate.',
    'candidate-execution-not-quiescent': 'A candidate process may still be running. The Runner cannot safely change or publish its files.',
    'review-feedback-pr-identity-missing': 'The Runner could not find the draft PR belonging to this run, so it cannot apply follow-up feedback safely.',
    'review-feedback-worktree-diverged': 'The follow-up worktree no longer matches the published PR revision.',
  };
  return { summary: summaries[code] ?? `The Runner could not safely complete the operation identified by "${code}". Inspect the retained evidence for this operation before retrying.` };
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
      ...(report.retainedWork ?? []),
      ...report.passedChecks.map((check) => `Passed check: ${check}`),
      ...report.publishableProof.map((proof) => `Proof: ${proof}`),
    ]),
    '',
    '## Not verified', ...terminalList(report.unverified),
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

function hasCurrentConfiguredCheckReceipts(record: RunRecord, policy: Record<string, string>, publishedTreeSha?: string): boolean {
  const binding = record.candidateBinding;
  // Publication releases the pin after committing the checked tree. Subsequent
  // effect reconciliation must validate the retained receipts against that tree.
  const treeSha = binding?.candidateTreeSha ?? publishedTreeSha;
  const firstCheck = record.checks[0];
  const bindingId = binding?.bindingId ?? (firstCheck && 'bindingId' in firstCheck ? firstCheck.bindingId : undefined);
  const policySha256 = sha256(canonicalJson(policy));
  return !!record.codexSession && !!record.implementationResult?.review && record.implementationResult.proof?.status === 'passed'
    && !!treeSha && !!record.checkedChangeSha256 && !!record.proofReceipt && sameCheckPolicy(record.checks, policy)
    && record.checks.every(check => check.status === 'passed' && 'bindingId' in check
      && check.bindingId === bindingId && check.candidateTreeSha === treeSha
      && check.checkPolicySha256 === policySha256);
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
