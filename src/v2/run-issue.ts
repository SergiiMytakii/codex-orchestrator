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
import { canonicalJson, sha256 } from './containment.js';
import { validateImplementationReport } from './implementation-report.js';
import {
  acceptApprovedDirectReview,
  acceptNeedsWorkDirectReview,
  beginDirectReviewRepair,
  createInitialDirectReview,
  directReviewCandidateTargetFingerprint,
  directReviewClosureRequestSha256,
  directReviewTargetFingerprint,
  MAX_DIRECT_REVIEW_REPORT_REPAIRS,
  prepareDirectReviewClosure,
  projectTerminalDirectReview,
} from './direct-delivery.js';
import type { ImplementationReviewerInput, ImplementationReviewerResult } from './implementation-reviewer.js';
import { CandidateProofInspectionError, ProofLaunchAuthorizationError, ProofQuiescenceError, ProofReportRecoveryError, type FrozenCriterion, type IssueSnapshot, type ProveChangeResult } from './acceptance-proof.js';
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
import { reserveSpecAuthorSession, reserveSpecReviewerSession, type FrozenSpecReceiptV1, type SpecDeliveryV1 } from './spec-delivery.js';
import type { WaitingHumanState } from './waiting-human-coordinator.js';
import type { TrustedAnswerReceiptV1, WaitingHumanExecutionV1 } from './waiting-human.js';
import {
  downstreamLifecycleForRoute,
  validateRouteTransition,
  validateTrustedAnswerResumeTransition,
  type RouteExecutionV1,
} from './route-decision.js';
import type {
  PublicationIntent,
  RunRecordV1,
  RunRecordWriter,
  RunStateFileV1,
  RunTerminalOutcome,
} from './run-store.js';
import type { ReviewFeedbackCoordinator } from './review-feedback-coordinator.js';
import {
  activateReviewFeedback,
  blockReviewFeedback,
  bootstrapReviewFeedback,
  markReviewFeedbackPublishing,
  markReviewFeedbackRepairing,
  markReviewFeedbackVerified,
  projectReviewFeedbackBatch,
  publishReviewFeedback,
  reserveNextReviewFeedbackRound,
} from './review-feedback.js';
import type { CandidateGitV2 } from './candidate.js';
import type { CandidateBindingV2, CandidateBoundaryV2, CandidateExecutionLeaseV2 } from './candidate.js';
import type {
  DurableMutableInvocationState,
  DurableReportInvocationState,
  DurableReportInvocationV1,
  MutableWorktreeOperationId,
} from './contained-report-operation.js';

export type RunIssueResult =
  | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string; continuationEpoch?: string }
  | { status: 'route-ready'; route: 'spec-required' | 'awaiting-user'; evidencePath: string }
  | { status: 'spec-frozen'; receipt: FrozenSpecReceiptV1; evidencePath: string }
  | { status: 'awaiting-user'; questionId: string; answerPrefix: string; evidencePath: string }
  | { status: 'not-eligible'; reason: string; evidencePath: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; resumable: boolean; evidencePath: string }
  | { status: 'transport-failed'; resumable: boolean; evidencePath: string }
  | { status: 'cancelled'; evidencePath: string }
  | { status: 'internal-error'; evidencePath: string }
  | { status: 'requeued'; reason: 'owner-contention'; evidencePath: string };

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
  | { kind: 'transport-failed'; resumable: boolean; code?: string }
  | { kind: 'cancelled' }
  | { kind: 'internal-error' }
  | { kind: 'safe-halt'; code: string };

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
      waitingHuman: string;
    }): Promise<void>;
    postComment(issueNumber: number, body: string): Promise<void>;
  };
  pullRequests: {
    findOpen(input: { headBranch: string; baseBranch: string }): Promise<{ url: string; body: string; number?: number; nodeId?: string; headSha?: string } | undefined>;
    createDraft(input: { title: string; body: string; headBranch: string; baseBranch: string }): Promise<{ url: string }>;
    listConversationComments?(number: number): Promise<Array<{ id: string; body: string }>>;
    postConversationComment?(number: number, body: string): Promise<{ id: string; body: string }>;
  };
  reviewFeedback?: ReviewFeedbackCoordinator;
  git: RunIssueGit;
  implementationAgent: {
    run(input: {
      operation: MutableWorktreeOperationId;
      runId: string;
      worktreePath: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      cycle: number;
      reworkFindings: string[];
      repairOnly: boolean;
      workflowGeneration: WorkflowGenerationReceipt;
      reviewFeedbackRound?: number;
      reviewFeedback?: Array<{ id: string; sourceUrl: string; path: string | null; line: number | null; body: string }>;
      phaseFacts?: string[];
      invocationState: DurableMutableInvocationState;
      beforeLaunch?: () => Promise<void>;
      signal: AbortSignal;
    }): Promise<ImplementationAgentResult>;
    settle(input: {
      operation: MutableWorktreeOperationId;
      runId: string;
      worktreePath: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      cycle: number;
      reworkFindings: string[];
      repairOnly: boolean;
      workflowGeneration: WorkflowGenerationReceipt;
      reviewFeedbackRound?: number;
      reviewFeedback?: Array<{ id: string; sourceUrl: string; path: string | null; line: number | null; body: string }>;
      phaseFacts?: string[];
      invocationState: DurableMutableInvocationState;
      signal: AbortSignal;
    }): Promise<{ kind: 'settled' } | { kind: 'safe-halt'; code: string }>;
  };
  implementationReviewer: {
    run(input: ImplementationReviewerInput): Promise<ImplementationReviewerResult>;
  };
  waitForReviewProcessAbsence(processGroupId: number): Promise<void>;
  routeCoordinator: {
    run(input: RouteCoordinatorInput & { state: RouteCoordinatorState }): Promise<RouteCoordinatorResult>;
  };
  routeContinuations: RoutedContinuationRegistry;
  checks: {
    supportsLaunchOwnership?: true;
    run(input: {
      id: string; command: string; source: 'issue' | 'configured'; cwd: string; phase: 'qualification' | 'changed'; signal: AbortSignal;
      onLaunched?: (input: { pid: number; processGroupId: number }) => Promise<void>;
    }): Promise<{
      status: 'passed' | 'failed'; output: Buffer; outputSha256: string;
    }>;
  };
  proof: {
    proveChange(input: {
      proofId: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      checkedChange: CheckedChange<CheckedChangePayloadV1 | CheckedChangePayloadV2>;
      executionLease?: CandidateExecutionLeaseV2;
      recoverAttemptOnly?: boolean;
      workflowGeneration: WorkflowGenerationReceipt;
      beforeAgentLaunch?: () => Promise<void>;
      onLaunched?: (input: { pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
    }): Promise<ProveChangeResult>;
  };
  checkedChangeMint: CheckedChangeMintCapability;
  runRecords: RunRecordWriter;
  writeEvidence(input: { runId: string; code: string; summary: string }): Promise<{ id: string; path: string }>;
  packageVersion: string;
  createWorkflowGeneration(): Promise<{ receipt: WorkflowGenerationReceipt; skillHashes: Record<string, string> }>;
  verifyWorkflowGeneration(receipt: WorkflowGenerationReceipt): Promise<void>;
  createRunId(): string;
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
  state: RunStateFileV1;
  record: RunRecordV1;
  config: AgentAutoConfig;
}

type TerminalSeed =
  | { status: 'review-ready'; pullRequestUrl: string }
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
    if (active.record.intent && !['claim-labels', 'comment'].includes(active.record.intent.kind)) {
      return { result: await this.publicationDiverged(active, 'claim-intent-diverged') };
    }
    let observation = await this.readIssue(issueNumber);
    if (!observation || observation.state !== 'OPEN') return { result: await this.publicationDiverged(active, 'claim-issue-missing') };
    const body = claimComment(runId, issueNumber, branchName);
    const marker = body.split('\n')[0]!;
    const commentIntent = { kind: 'comment' as const, issueNumber, marker, bodySha256: sha256(body) };

    // Compatibility with runs persisted by the former label-first claim order.
    // If the label effect is already visible, confirm it. Otherwise establish
    // the trusted claim comment before granting the running status label.
    if (active.record.intent?.kind === 'claim-labels') {
      if (sameStrings(observation.labels, expectedLabels)) {
        active = await this.confirmEffect(active);
      } else if (!this.hasTrustedClaim(observation, active.record)) {
        const labels = new Set(observation.labels);
        if (!labels.has(config.github.labels.auto.name)
          || labels.has(config.github.labels.blocked.name)
          || labels.has(config.github.labels.review.name)
          || labels.has(config.github.labels.waitingHuman.name)) {
          return { result: await this.publicationDiverged(active, 'claim-labels-diverged') };
        }
        active = await this.persist(active, { intent: commentIntent });
      }
    }

    if (!active.record.intent) {
      observation = await this.readIssue(issueNumber);
      if (!observation || observation.state !== 'OPEN') return { result: await this.publicationDiverged(active, 'claim-issue-missing') };
      if (!this.hasTrustedClaim(observation, active.record)) {
        active = await this.persist(active, { intent: commentIntent });
      }
    }
    if (active.record.intent?.kind === 'comment') {
      if (active.record.intent.marker !== marker || active.record.intent.bodySha256 !== sha256(body)) {
        return { result: await this.publicationDiverged(active, 'claim-comment-intent-diverged') };
      }
      observation = await this.readIssue(issueNumber);
      let comments = observation ? commentsWithMarker(observation, marker) : [];
      if (comments.some((comment) => comment.body !== body) || comments.length > 1) {
        return { result: await this.publicationDiverged(active, 'claim-comment-diverged') };
      }
      if (comments.length === 0) {
        try { await this.markV3ExternalEffect(active); await this.dependencies.issues.postComment(issueNumber, body); }
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
      || labels.has(config.github.labels.review.name)
      || labels.has(config.github.labels.waitingHuman.name)) {
      return { result: await this.publicationDiverged(active, 'claim-labels-diverged') };
    }
    if (!active.record.intent) {
      active = await this.persist(active, { intent: { kind: 'claim-labels', issueNumber, expected: expectedLabels } });
    }
    if (active.record.intent?.kind !== 'claim-labels' || !sameStrings(active.record.intent.expected, expectedLabels)) {
      return { result: await this.publicationDiverged(active, 'claim-labels-intent-diverged') };
    }
    try { await this.markV3ExternalEffect(active); await this.dependencies.issues.setLabels(issueNumber, expectedLabels); }
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
      if (!active.record.intent) {
        if (commitSha !== candidateBinding.expectedHeadSha) return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-branch-diverged-without-intent');
        const recaptured = await candidate.captureAndPin({
          worktreePath,
          expectedHeadSha: candidateBinding.expectedHeadSha,
          runId,
          boundary: { kind: 'implementation-cycle', cycle: active.record.cycle },
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
        active = await this.persist(active, { intent: {
          kind: 'commit',
          parentSha: candidateBinding.expectedHeadSha,
          treeSha: candidateBinding.candidateTreeSha,
          message,
          candidateRef: candidateBinding.candidateRef,
        } });
      }
      const intent = active.record.intent;
      if (intent?.kind !== 'commit' || intent.parentSha !== candidateBinding.expectedHeadSha
        || intent.treeSha !== candidateBinding.candidateTreeSha || intent.message !== message
        || intent.candidateRef !== candidateBinding.candidateRef) {
        return this.persistRetainedCommitIntentTerminal(active, 'candidate-commit-intent-diverged');
      }
      if (this.signal.aborted) return await this.persistRetainedCommitIntentTerminal(active, 'candidate-publication-cancelled');
      if (!await this.authorized(active, config)) return await this.persistRetainedCommitIntentTerminal(active, 'candidate-publication-authority-revoked');
      await this.markV3ExternalEffect(active);
      const publication = await candidate.createOrObserveCommit({
        worktreePath,
        branchName,
        parentSha: intent.parentSha,
        treeSha: intent.treeSha,
        message: intent.message,
        candidateRef: intent.candidateRef,
      });
      if (publication.kind === 'failed') {
        return publication.code === 'candidate-ref-update-unknown'
          ? this.persistTerminal(active, { status: 'transport-failed', resumable: false }, publication.code, true)
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
          intent: { kind: 'push', branch: branchName, sha: commitSha },
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
    } else if (active.record.intent?.kind === 'commit' || !active.record.intent) {
      if (!active.record.intent) {
        if (commitSha === baseSha) {
          active = await this.persist(active, {
            intent: { kind: 'commit', parentSha: baseSha, treeSha: await this.dependencies.git.getTreeSha(worktreePath), message },
          });
        }
      }
      const intent = active.record.intent;
      if (intent?.kind === 'commit') {
        if (commitSha === intent.parentSha) {
          if (await this.dependencies.git.getTreeSha(worktreePath) !== intent.treeSha) return await this.publicationDiverged(active, 'commit-tree-diverged');
          if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
          if (!await this.authorized(active, config)) return await this.revoked(active);
          try { commitSha = await this.dependencies.git.commit({ worktreePath, message: intent.message }); }
          catch { return await this.invokedFailure(active, 'commit-delivery-unknown'); }
        }
        const observed = await this.dependencies.git.inspectHead(worktreePath);
        if (observed.sha !== commitSha || observed.parentSha !== intent.parentSha || observed.treeSha !== intent.treeSha || observed.message !== intent.message) {
          return await this.publicationDiverged(active, 'commit-observation-diverged');
        }
        active = await this.confirmEffect(active);
      }
    }
    const commit = await this.dependencies.git.inspectHead(worktreePath);
    if (commit.sha !== commitSha || commit.parentSha !== baseSha || commit.message !== message || commit.treeSha !== await this.dependencies.git.getTreeSha(worktreePath)) {
      return await this.publicationDiverged(active, 'commit-identity-diverged');
    }

    if (active.record.intent?.kind === 'push' || !active.record.intent) {
      if (!active.record.intent) active = await this.persist(active, { intent: { kind: 'push', branch: branchName, sha: commitSha } });
      const intent = active.record.intent;
      if (intent?.kind !== 'push' || intent.branch !== branchName || intent.sha !== commitSha) return await this.publicationDiverged(active, 'push-intent-diverged');
      let remoteSha = await this.dependencies.git.getRemoteBranchSha(worktreePath, branchName);
      if (remoteSha && remoteSha !== commitSha) return await this.publicationDiverged(active, 'remote-branch-diverged');
      if (!remoteSha) {
        if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
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
    if (active.record.intent?.kind === 'pr' || !active.record.intent) {
      if (!active.record.intent) {
        active = await this.persist(active, {
          intent: {
            kind: 'pr', owner: config.github.owner, repo: config.github.repo, head: branchName,
            base: config.github.baseBranch, issueNumber, marker: prMarker,
          },
        });
      }
      let observed = await this.dependencies.pullRequests.findOpen({ headBranch: branchName, baseBranch: config.github.baseBranch });
      if (observed && observed.body !== prBody) return await this.publicationDiverged(active, 'pr-marker-diverged');
      if (!observed) {
        if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
        if (!await this.authorized(active, config)) return await this.revoked(active);
        try {
          await this.markV3ExternalEffect(active);
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
    if (active.record.intent?.kind === 'comment' || !active.record.intent) {
      if (!active.record.intent) {
        active = await this.persist(active, {
          intent: { kind: 'comment', issueNumber, marker: handoffMarker, bodySha256: sha256(handoffBody) },
        });
      }
      let observation = await this.readIssue(issueNumber);
      if (!observation) return await this.publicationDiverged(active, 'issue-missing-during-handoff');
      let matching = commentsWithMarker(observation, handoffMarker);
      if (matching.some((comment) => sha256(comment.body) !== sha256(handoffBody)) || matching.length > 1) {
        return await this.publicationDiverged(active, 'handoff-comment-diverged');
      }
      if (matching.length === 0) {
        if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
        if (!await this.authorized(active, config)) return await this.revoked(active);
        try { await this.markV3ExternalEffect(active); await this.dependencies.issues.postComment(issueNumber, handoffBody); }
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
    if (active.record.intent?.kind === 'labels' || !active.record.intent) {
      if (!active.record.intent) active = await this.persist(active, { intent: { kind: 'labels', issueNumber, expected: terminalLabels } });
      let observation = await this.readIssue(issueNumber);
      if (!observation) return await this.publicationDiverged(active, 'issue-missing-during-labels');
      if (!sameStrings(observation.labels, terminalLabels)) {
        if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
        if (!await this.authorized(active, config)) return await this.revoked(active);
        try { await this.markV3ExternalEffect(active); await this.dependencies.issues.setLabels(issueNumber, terminalLabels); }
        catch { return await this.invokedFailure(active, 'terminal-labels-delivery-unknown'); }
        observation = await this.readIssue(issueNumber);
      }
      if (!observation || !sameStrings(observation.labels, terminalLabels)) return await this.publicationDiverged(active, 'terminal-labels-diverged');
    }

    const evidence = await this.dependencies.writeEvidence({ runId, code: 'review-ready', summary: pullRequest.url });
    const outcome: RunTerminalOutcome = { status: 'review-ready', pullRequestUrl: pullRequest.url, evidencePath: evidence.path, continuationEpoch: commitSha };
    try {
      await this.persist(active, {
        lifecycle: 'review-ready', intent: undefined, outcomeEvidenceId: evidence.id, terminalOutcome: outcome,
        ...(active.record.routeReceipt?.route === 'direct' ? {
          reviewFeedback: bootstrapReviewFeedback(
            active.record.reviewFeedback ?? {
              version: 1, phase: 'bootstrap-required', consumedSourceIds: [], previousPublishedHeadSha: null,
              repairRound: 0, activeBatch: null, history: [],
              verifiedReceipt: null, terminal: null,
            },
            commitSha,
            [],
          ),
        } : {}),
        ...(active.record.waitingHuman ? { waitingHuman: terminalWaiting(active.record.waitingHuman, { status: 'review-ready' }) } : {}),
      });
    } catch { throw new PostEffectStateError(active); }
    return outcome;
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
    if (!feedback || feedback.phase !== 'publishing' || !batch || !coordinator
      || !this.dependencies.pullRequests.listConversationComments || !this.dependencies.pullRequests.postConversationComment) {
      return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-contract-missing');
    }
    const oldHead = batch.priorPublishedHeadSha;
    const message = `fix: address review feedback for #${issueNumber}`;
    let head = await this.dependencies.git.getHead(active.record.worktreePath);
    let remote = await this.dependencies.git.getRemoteBranchSha(active.record.worktreePath, active.record.branchName);
    if (!active.record.intent) {
      if (head !== oldHead || remote !== oldHead) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-update-baseline-diverged');
      }
    }

    const candidateBinding = active.record.candidateBinding;
    if (candidateBinding) {
      const candidate = this.dependencies.git.candidateV2;
      if (!candidate) return this.persistRetainedCommitIntentTerminal(active, 'candidate-git-v2-required');
      if (!active.record.intent) {
        const recaptured = await candidate.captureAndPin({
          worktreePath: active.record.worktreePath,
          expectedHeadSha: oldHead,
          runId: active.record.runId,
          boundary: {
            kind: 'review-feedback', batchId: batch.batchId,
            repairRound: feedback.repairRound as 1 | 2 | 3,
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
        active = await this.persist(active, { intent: {
          kind: 'review-update-commit', batchId: batch.batchId, parentSha: oldHead,
          treeSha: candidateBinding.candidateTreeSha, message, candidateRef: candidateBinding.candidateRef,
        } });
      }
      const intent = active.record.intent;
      if (intent?.kind !== 'review-update-commit' || intent.batchId !== batch.batchId
        || intent.parentSha !== oldHead || intent.treeSha !== candidateBinding.candidateTreeSha
        || intent.message !== message || intent.candidateRef !== candidateBinding.candidateRef) {
        return this.persistRetainedCommitIntentTerminal(active, 'review-feedback-candidate-intent-diverged');
      }
      if (!await this.authorized(active, config)) return this.persistRetainedCommitIntentTerminal(active, 'review-feedback-publication-authority-revoked');
      const validation = await coordinator.revalidate({ batch, epoch: 'pre-update', expectedHeadSha: oldHead });
      const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-precommit-revalidation-failed');
      if (validationFailure) return validationFailure;
      await this.markV3ExternalEffect(active);
      const publication = await candidate.createOrObserveCommit({
        worktreePath: active.record.worktreePath,
        branchName: active.record.branchName,
        parentSha: intent.parentSha,
        treeSha: intent.treeSha,
        message: intent.message,
        candidateRef: intent.candidateRef,
      });
      if (publication.kind === 'failed') {
        return publication.code === 'candidate-ref-update-unknown'
          ? this.persistTerminal(active, { status: 'transport-failed', resumable: false }, publication.code, true)
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
          intent: {
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
    } else if (!active.record.intent || active.record.intent.kind === 'review-update-commit') {
      if (!active.record.intent) {
        active = await this.persist(active, { intent: {
          kind: 'review-update-commit', batchId: batch.batchId, parentSha: oldHead,
          treeSha: await this.dependencies.git.getTreeSha(active.record.worktreePath), message,
        } });
      }
      const intent = active.record.intent;
      if (intent?.kind !== 'review-update-commit' || intent.batchId !== batch.batchId
        || intent.parentSha !== oldHead || intent.message !== message) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-commit-intent-diverged');
      }
      head = await this.dependencies.git.getHead(active.record.worktreePath);
      if (head === intent.parentSha) {
        if (!await this.authorized(active, config)) {
          return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
        }
        const validation = await coordinator.revalidate({ batch, epoch: 'pre-update', expectedHeadSha: oldHead });
        const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-precommit-revalidation-failed');
        if (validationFailure) return validationFailure;
        if (await this.dependencies.git.getTreeSha(active.record.worktreePath) !== intent.treeSha) {
          return this.blockReviewFeedback(active, 'safety', 'review-feedback-commit-tree-diverged');
        }
        try { head = await this.dependencies.git.commit({ worktreePath: active.record.worktreePath, message: intent.message }); }
        catch { return this.invokedFailure(active, 'review-feedback-commit-delivery-unknown'); }
      }
      const commit = await this.dependencies.git.inspectHead(active.record.worktreePath);
      if (commit.sha !== head || commit.parentSha !== intent.parentSha || commit.treeSha !== intent.treeSha || commit.message !== intent.message) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-commit-observation-diverged');
      }
      active = await this.persist(active, { intent: {
        kind: 'review-update-push', batchId: batch.batchId, branch: active.record.branchName,
        priorRemoteSha: oldHead, sha: commit.sha, treeSha: commit.treeSha,
      } });
    }
    const commit = await this.dependencies.git.inspectHead(active.record.worktreePath);
    const recordedCommit = active.record.intent?.kind === 'review-update-push' ? active.record.intent : undefined;
    if (commit.parentSha !== oldHead || commit.message !== message
      || (recordedCommit && (commit.sha !== recordedCommit.sha || commit.treeSha !== recordedCommit.treeSha))) {
      return this.blockReviewFeedback(active, 'safety', 'review-feedback-update-commit-identity-diverged');
    }
    head = commit.sha;

    if (!active.record.intent || active.record.intent.kind === 'review-update-push') {
      if (!active.record.intent) active = await this.persist(active, { intent: {
        kind: 'review-update-push', batchId: batch.batchId, branch: active.record.branchName,
        priorRemoteSha: oldHead, sha: head, treeSha: commit.treeSha,
      } });
      const intent = active.record.intent;
      if (intent?.kind !== 'review-update-push' || intent.batchId !== batch.batchId || intent.sha !== head
        || intent.treeSha !== commit.treeSha || intent.branch !== active.record.branchName || intent.priorRemoteSha !== oldHead) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-push-intent-diverged');
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
      'Affected Closure, configured checks, and Acceptance Proof passed.',
      'Review threads remain for human resolution.',
    ].join('\n');
    if (active.record.intent?.kind === 'review-update-push') {
      active = await this.persist(active, { intent: {
        kind: 'review-summary', batchId: batch.batchId, pullRequestNumber: batch.pullRequest.number,
        pullRequestNodeId: batch.pullRequest.nodeId, marker, bodySha256: sha256(body), epochHeadSha: head,
      } });
    }
    let summaryId = '';
    if (!active.record.intent || active.record.intent.kind === 'review-summary') {
      if (!active.record.intent) active = await this.persist(active, { intent: {
        kind: 'review-summary', batchId: batch.batchId, pullRequestNumber: batch.pullRequest.number,
        pullRequestNodeId: batch.pullRequest.nodeId, marker, bodySha256: sha256(body), epochHeadSha: head,
      } });
      const intent = active.record.intent;
      if (intent?.kind !== 'review-summary' || intent.batchId !== batch.batchId
        || intent.pullRequestNumber !== batch.pullRequest.number || intent.pullRequestNodeId !== batch.pullRequest.nodeId
        || intent.marker !== marker || intent.bodySha256 !== sha256(body) || intent.epochHeadSha !== head) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-summary-intent-diverged');
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
        try { await this.markV3ExternalEffect(active); await this.dependencies.pullRequests.postConversationComment(batch.pullRequest.number, body); }
        catch { return this.invokedFailure(active, 'review-feedback-summary-delivery-unknown'); }
        matches = (await this.dependencies.pullRequests.listConversationComments(batch.pullRequest.number))
          .filter((comment) => comment.body.split('\n')[0] === marker);
      }
      if (matches.length !== 1 || matches[0]!.body !== body) return this.blockReviewFeedback(active, 'safety', 'review-feedback-summary-observation-diverged');
      summaryId = matches[0]!.id;
      active = await this.persist(active, { intent: {
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
    if (!active.record.intent || active.record.intent.kind === 'review-final-labels') {
      if (!active.record.intent) active = await this.persist(active, { intent: {
        kind: 'review-final-labels', issueNumber, batchId: batch.batchId,
        pullRequestNumber: batch.pullRequest.number, pullRequestNodeId: batch.pullRequest.nodeId,
        epochHeadSha: head, expected: finalLabels,
      } });
      const intent = active.record.intent;
      if (intent?.kind !== 'review-final-labels' || intent.issueNumber !== issueNumber
        || intent.batchId !== batch.batchId || intent.pullRequestNumber !== batch.pullRequest.number
        || intent.pullRequestNodeId !== batch.pullRequest.nodeId || intent.epochHeadSha !== head
        || !sameStrings(intent.expected, finalLabels)) {
        return this.blockReviewFeedback(active, 'safety', 'review-feedback-final-labels-intent-diverged');
      }
      const validation = await coordinator.revalidate({ batch, epoch: 'post-push', expectedHeadSha: head });
      const validationFailure = await this.mapFeedbackRevalidation(active, validation, 'review-feedback-final-labels-revalidation-failed');
      if (validationFailure) return validationFailure;
      let issue = await this.readIssue(issueNumber);
      if (!issue || !sameStrings(issue.labels, finalLabels)) {
        if (!await this.authorized(active, config)) {
          return this.blockReviewFeedback(active, 'safety', 'review-feedback-publication-authority-revoked');
        }
        try { await this.markV3ExternalEffect(active); await this.dependencies.issues.setLabels(issueNumber, finalLabels); }
        catch { return this.invokedFailure(active, 'review-feedback-final-labels-delivery-unknown'); }
        issue = await this.readIssue(issueNumber);
      }
      if (!issue || !sameStrings(issue.labels, finalLabels)) return this.blockReviewFeedback(active, 'safety', 'review-feedback-final-labels-diverged');
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
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code: 'review-ready', summary: active.record.terminalOutcome?.status === 'review-ready' ? active.record.terminalOutcome.pullRequestUrl : `PR #${batch.pullRequest.number}` });
    const pullRequestUrl = `https://github.com/${active.record.canonicalRepository}/pull/${batch.pullRequest.number}`;
    const outcome: RunTerminalOutcome = { status: 'review-ready', pullRequestUrl, evidencePath: evidence.path, continuationEpoch: head };
    try {
      await this.persist(active, {
        lifecycle: 'review-ready',
        reviewFeedback: publishReviewFeedback(active.record.reviewFeedback!, receipt),
        terminalOutcome: outcome,
        outcomeEvidenceId: evidence.id,
        intent: undefined,
      });
    } catch { throw new PostEffectStateError(active); }
    return publicOutcome(outcome);
  }

  private async continueReviewReady(
    starting: ActiveRun,
    targetRoot: string,
    config: AgentAutoConfig,
  ): Promise<{ active: ActiveRun } | { result: RunIssueResult }> {
    const terminal = starting.record.terminalOutcome;
    const feedback = starting.record.reviewFeedback;
    if (!terminal || terminal.status !== 'review-ready' || !feedback || !this.dependencies.reviewFeedback
      || starting.record.routeReceipt?.route !== 'direct' || starting.record.directReview?.status !== 'clear') {
      return { result: publicOutcome(terminal!) };
    }
    const pullRequest = await this.dependencies.pullRequests.findOpen({
      headBranch: starting.record.branchName,
      baseBranch: config.github.baseBranch,
    });
    if (!pullRequest?.number || !pullRequest.nodeId || !pullRequest.headSha) {
      return { result: await this.reviewReadyObservationBlocked(starting, 'review-feedback-pr-identity-missing') };
    }
    const expectedHeadSha = feedback.phase === 'bootstrap-required'
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
    });
    if (observed.status === 'retryable') return { result: await this.invokedFailure(starting, 'review-feedback-observation-retryable') };
    if (observed.status === 'blocked') {
      return { result: await this.reviewReadyObservationBlocked(starting, 'review-feedback-observation-blocked') };
    }
    if (feedback.phase === 'bootstrap-required') {
      const sourceIds = observed.status === 'frozen'
        ? observed.batch.sources.map((source) => source.sourceId)
        : observed.eligibleSourceIds;
      const active = await this.persist(starting, {
        reviewFeedback: bootstrapReviewFeedback(feedback, expectedHeadSha, sourceIds),
      });
      return { result: publicOutcome(active.record.terminalOutcome!) };
    }
    if (feedback.phase !== 'idle' || observed.status === 'none') return { result: publicOutcome(terminal) };

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
        review: { ...repairReview.review, reportRepairs: 0 },
      },
      reworkFindings: projected.repairFindings.map((finding) => finding.summary),
      reportRepairs: 0,
      checks: [],
      checkedChangeSha256: undefined,
      proofId: undefined,
      proofReceipt: undefined,
      terminalOutcome: undefined,
      outcomeEvidenceId: undefined,
      intent: {
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
    if (!feedback || feedback.phase !== 'frozen' || !batch || !this.dependencies.reviewFeedback) {
      return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-state-invalid') };
    }
    const expectedHeadSha = batch.priorPublishedHeadSha;
    const runningLabels = sortedUnique([config.github.labels.auto.name, config.github.labels.running.name]);
    const reviewLabels = [config.github.labels.review.name];
    const intent = active.record.intent;
    if (intent && (intent.kind !== 'review-activation-labels'
      || intent.issueNumber !== active.record.issueNumber
      || intent.batchId !== batch.batchId
      || !sameStrings(intent.expected, runningLabels))) {
      return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-intent-diverged') };
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
      try { await this.markV3ExternalEffect(active); await this.dependencies.issues.setLabels(active.record.issueNumber, runningLabels); }
      catch { return { result: await this.invokedFailure(active, 'review-feedback-activation-labels-delivery-unknown') }; }
      const observed = await this.readIssue(active.record.issueNumber);
      if (!observed || !sameStrings(observed.labels, runningLabels)
        || !this.hasTrustedClaim(observed, active.record)) {
        return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-activation-labels-diverged') };
      }
    }
    if (intent) active = await this.confirmEffect(active);
    let worktree = await this.dependencies.git.inspectWorktree({
      worktreePath: active.record.worktreePath,
      branchName: active.record.branchName,
      baseSha: expectedHeadSha,
    });
    if (worktree === 'absent' && this.dependencies.git.ensureContinuationWorktree) {
      try {
        await this.dependencies.git.ensureContinuationWorktree({
          targetRoot,
          worktreePath: active.record.worktreePath,
          branchName: active.record.branchName,
          baseBranch: config.github.baseBranch,
          publishedHeadSha: expectedHeadSha,
        });
        worktree = await this.dependencies.git.inspectWorktree({
          worktreePath: active.record.worktreePath,
          branchName: active.record.branchName,
          baseSha: expectedHeadSha,
        });
      } catch { worktree = 'diverged'; }
    }
    const remoteSha = await this.dependencies.git.getRemoteBranchSha(active.record.worktreePath, active.record.branchName);
    if (worktree !== 'matching' || remoteSha !== expectedHeadSha
      || (await this.dependencies.git.listChangedFilesIgnoringUntrackedRoot(
        active.record.worktreePath,
        config.proof.artifactDir,
      )).length !== 0) {
      return { result: await this.blockReviewFeedback(active, 'safety', 'review-feedback-worktree-diverged') };
    }
    active = await this.persist(active, { reviewFeedback: markReviewFeedbackRepairing(active.record.reviewFeedback!) });
    return { active };
  }

  private async reviewReadyObservationBlocked(active: ActiveRun, code: string): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code, summary: 'Review feedback observation failed closed before activation.' });
    const terminalOutcome: RunTerminalOutcome = {
      status: 'blocked', kind: 'safety', resumable: false, evidencePath: evidence.path,
    };
    await this.persist(active, {
      lifecycle: 'blocked',
      reviewFeedback: active.record.reviewFeedback,
      directReview: active.record.directReview && active.record.directReview.status !== 'terminal'
        ? projectTerminalDirectReview(active.record.directReview, { status: 'blocked', kind: 'safety' })
        : active.record.directReview,
      terminalOutcome,
      outcomeEvidenceId: evidence.id,
      intent: undefined,
    });
    return publicOutcome(terminalOutcome);
  }

  async runIssue(input: { targetRoot: string; issueNumber: number }): Promise<RunIssueResult> {
    let owner: { release(): Promise<void> } | undefined;
    let active: ActiveRun | undefined;
    try {
      assertPositiveInteger(input.issueNumber, 'issueNumber');
      const targetRoot = resolve(input.targetRoot);
      const initialConfig = await this.readStrictConfig(targetRoot);
      const canonicalRepository = `${initialConfig.config.github.owner.toLowerCase()}/${initialConfig.config.github.repo.toLowerCase()}`;
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

      let issue: RunIssueSnapshot | undefined;
      try {
        issue = await this.dependencies.issues.read(input.issueNumber);
      } catch {
        return await this.preClaimTransport(input.issueNumber);
      }
      const persisted = await this.dependencies.runRecords.read();
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
          activeExecutions: persisted.runs.flatMap((run) => run.executionLease
            ? [{ path: run.executionLease.path, candidateCommitSha: run.executionLease.candidateCommitSha }]
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
        if (active.record.intent?.kind === 'review-blocked-labels') {
          return await this.blockReviewFeedback(
            active,
            active.record.intent.blockKind,
            active.record.intent.evidenceCode,
          );
        }
        if (active.record.intent?.kind === 'blocked-labels') {
          return await this.publishBlockedTerminal(
            active,
            {
              status: 'blocked',
              kind: active.record.intent.blockKind,
              resumable: active.record.intent.resumable,
            },
            active.record.intent.evidenceCode,
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
          && (active.record.intent?.kind === 'commit' || active.record.intent?.kind === 'review-update-commit')) {
          const reconciled = await this.reconcileUnknownCandidatePublication(active);
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
        const canonicalReviewRecovery = active.record.executionLease?.operation === 'direct-review'
          && active.record.reportInvocation?.operation === 'code-review';
        if (active.record.executionLease && !canonicalReviewRecovery) {
          const reconciled = await this.reconcilePersistedCandidateExecution(active, config);
          if ('status' in reconciled) return reconciled;
          active = reconciled.active;
        }
        if (active.state.version === 2 && active.record.lifecycle === 'proving'
          && active.record.routeReceipt?.route === 'direct') {
          const resumed = await this.resumeLegacyProof(active, config, issueSnapshot, frozenCriteria);
          if ('status' in resumed) return resumed;
          active = resumed.active;
        } else if (active.state.version === 2 && active.record.lifecycle === 'checking'
          && active.record.routeReceipt?.route === 'direct') {
          const cutover = await this.cutoverLegacyImmutableBoundary(active, config, frozenCriteria);
          if ('status' in cutover) return cutover;
          active = cutover.active;
        }
        if (active.record.reviewFeedback?.phase === 'frozen') {
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
          const claim = await this.reconcileClaim(active, config);
          if ('result' in claim) return claim.result;
          active = claim.active;
          let worktree: 'absent' | 'matching' | 'diverged';
          try {
            worktree = await this.dependencies.git.inspectWorktree({ worktreePath, branchName, baseSha });
          } catch (error) {
            return await this.invokedFailure(
              active,
              'local-git-worktree-inspection-failed',
              claimedWorktreeInspectionFailureSummary(error),
            );
          }
          if (worktree === 'diverged') {
            return await this.invokedFailure(
              active,
              'local-git-worktree-diverged',
              'The claimed worktree path is present but does not match the expected branch and base. Correct or preserve the local artifact, then retry the same run.',
            );
          }
          if (worktree === 'absent') {
            try { await this.dependencies.git.createWorktree({ targetRoot, worktreePath, branchName, baseBranch: config.github.baseBranch, baseSha }); }
            catch (error) {
              return await this.invokedFailure(
                active,
                'local-git-worktree-creation-failed',
                worktreeCreationFailureSummary(error),
              );
            }
          }
          active = await this.initializeClaimedRun(active, issue);
          issueSnapshot = structuredClone(active.record.issueSnapshot);
        } else {
          if (active.record.lifecycle === 'safe-halt') {
            const process = active.record.process;
            if (!process) return await this.publicationDiverged(active, 'safe-halt-process-missing');
            try { await this.dependencies.waitForReviewProcessAbsence(process.processGroupId); }
            catch { return await this.invokedFailure(active, 'safe-halt-process-absence-unconfirmed'); }
            active = await this.persist(active, { lifecycle: process.resumeLifecycle, process: undefined });
            if (active.state.version === 2 && active.record.lifecycle === 'proving'
              && active.record.routeReceipt?.route === 'direct') {
              const resumed = await this.resumeLegacyProof(active, config, issueSnapshot, frozenCriteria, true);
              if ('status' in resumed) return resumed;
              active = resumed.active;
            } else if (active.state.version === 2 && active.record.lifecycle === 'checking'
              && active.record.routeReceipt?.route === 'direct') {
              const cutover = await this.cutoverLegacyImmutableBoundary(active, config, frozenCriteria);
              if ('status' in cutover) return cutover;
              active = cutover.active;
            }
          }
          if (active.record.lifecycle === 'publishing') {
            return active.record.reviewFeedback?.activeBatch
              ? await this.updateExistingPullRequest(active, config, input.issueNumber)
              : await this.publish(active, config, issueSnapshot, input.issueNumber);
          }
          if (active.record.lifecycle === 'waiting-human') {
            const waiting = await this.continueWaitingHuman(active);
            if ('result' in waiting) return waiting.result;
            active = waiting.active;
            issueSnapshot = structuredClone(active.record.issueSnapshot);
            frozenCriteria = structuredClone(active.record.frozenCriteria);
          }
          if (active.record.lifecycle === 'spec-authoring') {
            if (!await this.authorized(active, config)) return await this.revoked(active);
            return await this.continueSpecRequired(active);
          }
          if (!['triaging', 'routed', 'implementing', 'reworking', 'checking', 'proving'].includes(active.record.lifecycle)) {
            return await this.terminal(active, { status: 'internal-error', code: 'resume-phase-not-reconciled' });
          }
          if (!await this.authorized(active, config)) return await this.revoked(active);
          if (active.record.lifecycle !== 'triaging' && active.record.lifecycle !== 'routed') {
            if (!active.record.routeExecution || !active.record.routeReceipt) throw new RouteInitializationUnrecoverableError();
            const reviewRecovery = active.record.lifecycle === 'implementing' && active.record.directReview?.status === 'active'
              && (active.record.directReview.stage === 'review-full' || active.record.directReview.stage === 'review-closure');
            const checkRecovery = active.record.lifecycle === 'checking'
              && active.record.directReview?.status === 'clear';
            const proofRecovery = active.record.lifecycle === 'proving'
              && active.record.directReview?.status === 'clear';
            const directReviewRepair = active.record.lifecycle === 'implementing'
              && active.record.directReview?.status === 'active'
              && active.record.directReview.stage === 'review-repair';
            const mutableRecovery = active.record.lifecycle === 'implementing' && active.record.mutableInvocation !== undefined;
            const qualificationRecovery = active.record.lifecycle === 'implementing'
              && !active.record.directReview;
            if (!reviewRecovery && !checkRecovery && !proofRecovery && !directReviewRepair && !qualificationRecovery && !mutableRecovery) {
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
          intent: {
            kind: 'comment', issueNumber: input.issueNumber, marker: claimBody.split('\n')[0]!, bodySha256: sha256(claimBody),
          },
        });
        const claim = await this.reconcileClaim(active, config);
        if ('result' in claim) return claim.result;
        active = claim.active;
        try { await this.dependencies.git.createWorktree({ targetRoot, worktreePath, branchName, baseBranch: config.github.baseBranch, baseSha }); }
        catch (error) {
          return await this.invokedFailure(
            active,
            'local-git-worktree-creation-failed',
            worktreeCreationFailureSummary(error),
          );
        }
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
      if (active.record.lifecycle === 'implementing' && active.record.routeReceipt?.route === 'direct'
        && !active.record.directReview
        && (!active.record.mutableInvocation || active.record.mutableInvocation.operation === 'qualification-repair')) {
        const qualification = await this.qualifyChecks(active, config, issueSnapshot, frozenCriteria);
        if ('status' in qualification) return qualification;
        active = qualification.active;
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
        && (active.record.directReview.stage === 'review-full' || active.record.directReview.stage === 'review-closure')) {
        const recoveryBoundary = active.record.reviewFeedback?.activeBatch
          ? {
            kind: 'review-feedback' as const,
            batchId: active.record.reviewFeedback.activeBatch.batchId,
            repairRound: active.record.reviewFeedback.repairRound as 1 | 2 | 3,
          }
          : { kind: 'implementation-cycle' as const, cycle: active.record.cycle };
        const captured = await this.ensureCandidateBinding(active, config, recoveryBoundary);
        if ('status' in captured) return captured;
        active = captured.active;
        const binding = active.record.candidateBinding!;
        const candidateTargetFingerprint = directReviewCandidateTargetFingerprint({
          binding,
          routeDecisionSha256: active.record.routeReceipt!.decisionSha256,
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
      const feedbackBatch = active.record.reviewFeedback?.activeBatch;
      const workerBlock = await this.revalidateFeedbackWorker(active, config, input.issueNumber);
      if (workerBlock) return workerBlock;
      const feedbackProjection = feedbackBatch
        ? projectReviewFeedbackBatch(feedbackBatch, active.record.directReview!.targetRevision)
        : undefined;
      let feedbackImplementationLaunchFailure: RunIssueResult | undefined;
      const implementationLaunch = feedbackBatch ? {
        reviewFeedbackRound: active.record.reviewFeedback!.repairRound,
        reviewFeedback: feedbackProjection!.workerFeedback,
        beforeLaunch: async () => {
          const failure = await this.revalidateFeedbackWorker(active!, config, input.issueNumber);
          if (failure) {
            feedbackImplementationLaunchFailure = failure;
            throw new Error('review feedback implementation launch authorization changed');
          }
        },
      } : {};
      const deniedPathsBaseline = await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths);
      const phaseFacts = [deniedPathsBaseline, sha256(canonicalJson(resolveIssueCheckPolicy(active.record.issueSnapshot.body, config.checks).checks)), canonicalJson(active.record.checkQualification?.checks ?? [])];
      const recoveredContext = active.record.mutableInvocation?.context;
      const invocationState = this.mutableInvocationState(() => active!, (next) => { active = next; });
      let implementation = await this.runImplementation({
        operation: feedbackBatch ? 'review-feedback-implementation' : 'implementation',
        runId,
        worktreePath,
        issue: publicIssueSnapshot(issueSnapshot),
        frozenCriteria,
        cycle: active.record.cycle,
        reworkFindings: recoveredContext?.reworkFindings ?? active.record.reworkFindings,
        repairOnly: recoveredContext?.repairOnly ?? false,
        workflowGeneration: active.record.workflowGeneration,
        phaseFacts,
        invocationState,
        ...implementationLaunch,
      });
      if (feedbackImplementationLaunchFailure) return feedbackImplementationLaunchFailure;
      if (implementation.kind === 'safe-halt') {
        if (implementation.code === 'report-repair-modified-worktree') {
          return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, implementation.code);
        }
        if (implementation.code === 'mutable-operation-result-worktree-mismatch') {
          active = await this.persist(active, { mutableInvocation: undefined });
          return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, implementation.code);
        }
        return await this.invokedFailure(active, implementation.code, 'Mutable implementation recovery remains fenced and requires a later bounded observation.');
      }
      if (await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths) !== deniedPathsBaseline) {
        active = await this.persist(active, { mutableInvocation: undefined });
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'denied-path-modified');
      }
      if (implementation.kind === 'transport-failed') return this.invokedFailure(
        active, implementation.code ?? 'implementation-agent-transport-failed',
        'Mutable implementation did not produce recoverable output; the durable invocation remains available for recovery.',
      );
      if (implementation.kind !== 'completed') return await this.mapImplementationFailure(active, implementation);
      let report;
      try {
        report = validateImplementationReport(implementation.report);
      } catch {
        if (active.record.reportRepairs >= 1) {
          active = await this.persist(active, { mutableInvocation: undefined }); return await this.terminal(active, { status: 'internal-error', code: 'implementation-report-malformed' });
        }
        const repairBaseline = await this.dependencies.git.snapshot(worktreePath);
        active = await this.persist(active, { reportRepairs: 1, mutableInvocation: undefined });
        const repairBlock = await this.revalidateFeedbackWorker(active, config, input.issueNumber);
        if (repairBlock) return repairBlock;
        implementation = await this.runImplementation({
          operation: feedbackBatch ? 'review-feedback-implementation' : 'implementation',
          runId,
          worktreePath,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          cycle: active.record.cycle,
          reworkFindings: ['The previous implementation report did not match the generated schema.'],
          repairOnly: true,
          workflowGeneration: active.record.workflowGeneration,
          phaseFacts,
          invocationState,
          ...implementationLaunch,
        });
        if (feedbackImplementationLaunchFailure) return feedbackImplementationLaunchFailure;
        if (implementation.kind === 'safe-halt') {
          if (implementation.code === 'report-repair-modified-worktree') {
            return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, implementation.code);
          }
          return this.invokedFailure(active, implementation.code);
        }
        if (implementation.kind === 'transport-failed') return this.invokedFailure(active, implementation.code ?? 'implementation-agent-transport-failed');
        if (implementation.kind !== 'completed') return await this.mapImplementationFailure(active, implementation);
        const afterRepair = await this.dependencies.git.snapshot(worktreePath);
        if (!sameFreshness(repairBaseline, afterRepair)) {
          active = await this.persist(active, { mutableInvocation: undefined }); return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'report-repair-modified-worktree');
        }
        try { report = validateImplementationReport(implementation.report); }
        catch { active = await this.persist(active, { mutableInvocation: undefined }); return await this.terminal(active, { status: 'internal-error', code: 'implementation-report-malformed' }); }
      }
      if (report.status === 'external-block') {
        active = await this.persist(active, { mutableInvocation: undefined });
        return await this.terminal(active, { status: 'blocked', kind: 'external', resumable: true });
      }
      if (await this.dependencies.git.getHead(worktreePath) !== expectedImplementationHead(active.record)) {
        active = await this.persist(active, { mutableInvocation: undefined });
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }
      const changedFiles = await this.dependencies.git.listChangedFiles(worktreePath);
      if (changedFiles.length === 0 || !sameStrings(changedFiles, report.changedFiles)) {
        if (changedFiles.length === 0 || active.record.reportRepairs >= 1) {
          active = await this.persist(active, { mutableInvocation: undefined });
          return await this.terminal(active, { status: 'internal-error', code: 'implementation-change-set-invalid' });
        }
        const repairBaseline = await this.dependencies.git.snapshot(worktreePath);
        active = await this.persist(active, { reportRepairs: 1, mutableInvocation: undefined });
        const repairBlock = await this.revalidateFeedbackWorker(active, config, input.issueNumber);
        if (repairBlock) return repairBlock;
        implementation = await this.runImplementation({
          operation: feedbackBatch ? 'review-feedback-implementation' : 'implementation',
          runId,
          worktreePath,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          cycle: active.record.cycle,
          reworkFindings: [`The report changedFiles must equal the complete current product change set: ${canonicalJson(changedFiles)}.`],
          repairOnly: true,
          workflowGeneration: active.record.workflowGeneration,
          phaseFacts,
          invocationState,
          ...implementationLaunch,
        });
        if (feedbackImplementationLaunchFailure) return feedbackImplementationLaunchFailure;
        if (implementation.kind === 'safe-halt') {
          if (implementation.code === 'report-repair-modified-worktree') {
            return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, implementation.code);
          }
          return this.invokedFailure(active, implementation.code);
        }
        if (implementation.kind === 'transport-failed') return this.invokedFailure(active, implementation.code ?? 'implementation-agent-transport-failed');
        if (implementation.kind !== 'completed') return await this.mapImplementationFailure(active, implementation);
        const afterRepair = await this.dependencies.git.snapshot(worktreePath);
        if (!sameFreshness(repairBaseline, afterRepair)) {
          active = await this.persist(active, { mutableInvocation: undefined }); return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'report-repair-modified-worktree');
        }
        try { report = validateImplementationReport(implementation.report); }
        catch { active = await this.persist(active, { mutableInvocation: undefined }); return await this.terminal(active, { status: 'internal-error', code: 'implementation-report-malformed' }); }
        if (report.status === 'external-block') {
          active = await this.persist(active, { mutableInvocation: undefined });
          return await this.terminal(active, { status: 'blocked', kind: 'external', resumable: true });
        }
        if (!sameStrings(changedFiles, report.changedFiles)) {
          active = await this.persist(active, { mutableInvocation: undefined });
          return await this.terminal(active, { status: 'internal-error', code: 'implementation-change-set-invalid' });
        }
      }

      if (active.record.routeReceipt?.route === 'direct') {
        const boundary = active.record.reviewFeedback?.activeBatch
          ? {
            kind: 'review-feedback' as const,
            batchId: active.record.reviewFeedback.activeBatch.batchId,
            repairRound: active.record.reviewFeedback.repairRound as 1 | 2 | 3,
          }
          : { kind: 'implementation-cycle' as const, cycle: active.record.cycle };
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
          routeDecisionSha256: active.record.routeReceipt!.decisionSha256,
          workflowGenerationHash: active.record.workflowGeneration.generationHash,
          cycle: active.record.cycle,
          frozenCriteria,
        });
        if (active.record.directReview?.stage === 'review-repair') {
          active = await this.persist(active, {
            directReview: prepareDirectReviewClosure(active.record.directReview, targetFingerprint).state,
            mutableInvocation: undefined,
          });
        } else {
          const reviewerSessionId = this.dependencies.createReviewSessionId();
          assertNonEmptyString(reviewerSessionId, 'reviewerSessionId');
          active = await this.persist(active, {
            directReview: createInitialDirectReview({
              targetFingerprint,
              codeReviewerSessionId: reviewerSessionId,
            }),
            mutableInvocation: undefined,
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
          mutableInvocation: undefined,
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
        const execution = await this.prepareCandidateExecution(active, config, 'final-check', `${id}:${finalCheckPolicySha256}`);
        if ('status' in execution) return execution;
        active = execution.active;
        const lease = execution.lease;
        let check;
        try {
          check = await this.dependencies.checks.run({
            id, command, source: checkPolicy.source, cwd: lease.path, phase: 'changed', signal: this.signal,
            onLaunched: async ({ pid, processGroupId }) => {
              active = await this.persist(active!, {
                executionLease: this.dependencies.git.candidateV2!.markExecutionLaunched({
                  lease, pid, processGroupId, launchedAt: this.timestamp(),
                }),
              });
            },
          });
        } catch (error) {
          if (error instanceof CheckProcessQuiescenceError) {
            return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'check-process-quiescence-unconfirmed');
          }
          return await this.invokedFailure(
            active,
            'configured-check-execution-failed',
            error instanceof Error ? error.message : 'The check process did not start or settle. Retry the same run.',
          );
        }
        if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
        const settledExecution = await this.settleCandidateExecution(active, config);
        if ('status' in settledExecution) return settledExecution;
        active = settledExecution.active;
        const row = {
          id, command, status: check.status, outputSha256: check.outputSha256,
          bindingId: finalBinding.bindingId,
          candidateTreeSha: finalBinding.candidateTreeSha,
          checkPolicySha256: finalCheckPolicySha256,
        } as const;
        active = await this.persist(active, { checks: [...active.record.checks, row] });
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
      active = await this.persist(active, { lifecycle: 'proving', checkedChangeSha256, proofId });
      const retainedProofLease = active.record.executionLease?.operation === 'acceptance-proof'
        ? active.record.executionLease
        : undefined;
      const preparedProofExecution = retainedProofLease
        ? { active, lease: retainedProofLease }
        : await this.prepareCandidateExecution(active, config, 'acceptance-proof', proofId);
      if ('status' in preparedProofExecution) return preparedProofExecution;
      active = preparedProofExecution.active;
      const proofExecution = preparedProofExecution;

      let proof: ProveChangeResult;
      let proofLaunchFailure: RunIssueResult | undefined;
      try {
        proof = await this.dependencies.proof.proveChange({
          proofId,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          checkedChange,
          executionLease: proofExecution.lease,
          workflowGeneration: structuredClone(active.record.workflowGeneration),
          onLaunched: async ({ pid, processGroupId, launchedAt }) => {
            const failure = await this.revalidateFeedbackWorker(active!, config, input.issueNumber);
            if (failure) {
              proofLaunchFailure = failure;
              throw new Error('proof launch authorization changed');
            }
            active = await this.persist(active!, {
              executionLease: this.dependencies.git.candidateV2!.markExecutionLaunched({
                lease: proofExecution.lease, pid, processGroupId, launchedAt,
              }),
            });
          },
          beforeAgentLaunch: async () => {
            const failure = await this.revalidateFeedbackWorker(active!, config, input.issueNumber);
            if (failure) throw new ProofLaunchAuthorizationError(failure);
          },
        });
      } catch (error) {
        if (proofLaunchFailure) return proofLaunchFailure;
        if (error instanceof ProofLaunchAuthorizationError) return error.outcome as RunIssueResult;
        if (error instanceof ProofQuiescenceError) {
          active = await this.persist(active, {
            lifecycle: 'safe-halt',
            process: {
              pid: error.pid,
              processGroupId: error.processGroupId,
              startedAt: this.timestamp(),
              baseline: {
                headSha: proofBinding.expectedHeadSha,
                indexTreeSha: proofBinding.candidateTreeSha,
                trackedContentSha256: proofBinding.bindingId,
                untrackedContentSha256: proofBinding.bindingId,
                worktreeIdentity: proofBinding.sourceWorktreeIdentity,
              },
              purpose: 'proof',
              resumeLifecycle: 'proving',
              resumeReviewStage: null,
            },
          });
          while (true) {
            try {
              await error.waitForAbsence();
              break;
            } catch {
              await new Promise((resolveWait) => setTimeout(resolveWait, 25));
            }
          }
          return await this.terminal(active, { status: 'transport-failed', resumable: false }, 'proof-process-quiescence-delayed');
        }
        if (error instanceof CandidateProofInspectionError) {
          return error.code === 'candidate-artifact-conflict'
            ? this.persistCandidateEvidenceSafetyTerminal(active, error.code)
            : this.mapCandidateFailure(active, error.code);
        }
        if (error instanceof ProofReportRecoveryError) {
          return this.invokedFailure(active, 'proof-report-recovery-pending', 'The launched proof attempt exited without a recoverable report; its exact lease is retained for inspection.');
        }
        return await this.terminal(active, { status: 'internal-error', code: 'acceptance-proof-internal-failure' });
      }
      if (proofLaunchFailure) return proofLaunchFailure;
      const settledProofExecution = await this.settleCandidateExecution(active, config);
      if ('status' in settledProofExecution) return settledProofExecution;
      active = settledProofExecution.active;
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
          reviewFeedback: markReviewFeedbackPublishing(markReviewFeedbackVerified(active.record.reviewFeedback, {
            checkedChangeSha256,
            proofId,
            verifiedAt: this.timestamp(),
          })),
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
          const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code: 'state-write-failed', summary: 'Run state failed.' });
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
      || active.record.process
      || active.record.intent
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
    issue: RunRecordV1['issueSnapshot'],
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
        complete: async (expected, next, receipt, attemptId) => {
          if (!sameRouteExecution(active.record.routeExecution, expected)) return false;
          if (active.record.reportInvocation?.attemptId !== attemptId) return false;
          active = await this.persist(active, {
            lifecycle: 'routed',
            routeExecution: structuredClone(next),
            routeReceipt: structuredClone(receipt),
            reportInvocation: undefined,
          });
          return true;
        },
        cancel: async (expected) => {
          if (!sameRouteExecution(active.record.routeExecution, expected)) return false;
          const evidence = await this.dependencies.writeEvidence({
            runId: active.record.runId,
            code: 'cancelled',
            summary: 'Routing was cancelled.',
          });
          active = await this.persist(active, {
            lifecycle: 'cancelled',
            routeExecution: undefined,
            routeReceipt: undefined,
            outcomeEvidenceId: evidence.id,
            terminalOutcome: { status: 'cancelled', evidencePath: evidence.path },
            reportInvocation: undefined,
            ...(active.record.waitingHuman ? { waitingHuman: terminalWaiting(active.record.waitingHuman, { status: 'cancelled' }) } : {}),
          });
          return true;
        },
        invocation: this.reportInvocationState(() => active, (next) => { active = next; }),
        settle: async (expected, next, attemptId) => {
          if (!sameRouteExecution(active.record.routeExecution, expected)
            || active.record.reportInvocation?.attemptId !== attemptId) return false;
          active = await this.persist(active, { routeExecution: structuredClone(next), reportInvocation: undefined });
          return true;
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
          ...(active.record.waitingHuman?.phase === 'resumed' ? [
            `trustedAnswer=${canonicalJson(active.record.waitingHuman.trustedAnswer)}`,
            `priorWaitingRoute=${active.record.waitingHuman.history.at(-1)?.routeReceipt.decisionSha256 ?? ''}`,
          ] : []),
        ],
        signal: this.signal,
      });
      if (result.status === 'repairable') continue;
      if (result.status === 'retryable') {
        return { result: await this.invokedFailure(active, result.code, 'Report-only recovery is deferred to the next runner tick.') };
      }
      if (result.status === 'safe-halt') {
        return { result: await this.invokedFailure(active, result.code, 'Report-only process ownership remains unresolved; no relaunch was attempted.') };
      }
      if (result.status === 'cancelled') {
        if (!active.record.terminalOutcome) throw new Error('route cancellation was not persisted');
        return { result: publicOutcome(active.record.terminalOutcome) };
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
    if (receipt.route !== 'awaiting-user') active = await this.persist(active, { lifecycle });
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
    if (receipt.route === 'awaiting-user') {
      const waiting = await this.dependencies.routeContinuations.awaitingUser(
        context, this.waitingState(() => active, (next) => { active = next; }), this.signal,
      );
      const mapped = await this.mapWaitingResult(active, waiting);
      if ('result' in mapped) return mapped;
      return this.routeRun(mapped.active, mapped.active.record.issueSnapshot, mapped.active.record.frozenCriteria, worktreePath, config, issueNumber, branchName);
    }
    const continuation = receipt.route === 'direct'
      ? await this.dependencies.routeContinuations.direct(context)
      : await this.dependencies.routeContinuations.specRequired(context, this.specState(() => active, (next) => { active = next; }), this.signal);
    if (continuation.status === 'cancelled') return { result: await this.terminal(active, { status: 'cancelled' }) };
    if (continuation.status === 'blocked') {
      return { result: await this.terminal(active, {
        status: 'blocked', kind: continuation.kind, resumable: continuation.kind !== 'exhausted',
      }, continuation.code) };
    }
    if (continuation.status === 'retryable') return { result: await this.invokedFailure(active, continuation.code) };
    if (receipt.route !== 'direct') {
      const specContinuation = continuation as SpecCoordinatorResult;
      if (specContinuation.status !== 'completed') return { result: await this.terminal(active, { status: 'internal-error', code: 'spec-freeze-receipt-missing' }) };
      const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code: 'spec-frozen', summary: specContinuation.receipt.receiptSha256 });
      return { result: { status: 'spec-frozen', receipt: specContinuation.receipt, evidencePath: evidence.path } };
    }
    return { active };
  }

  private waitingState(readActive: () => ActiveRun, writeActive: (active: ActiveRun) => void): WaitingHumanState {
    return {
      read: async () => structuredClone(readActive().record.waitingHuman),
      compareAndSwap: async (expected, next) => {
        const active = readActive();
        const observed = active.record.waitingHuman;
        if (observed === undefined || expected === undefined) {
          if (observed !== expected) return false;
        } else if (canonicalJson(observed) !== canonicalJson(expected)) return false;
        const saved = await this.persist(active, {
          ...(active.record.lifecycle === 'routed'
            && (expected === undefined || (expected.phase === 'resumed' && next.phase !== 'resumed' && next.phase !== 'history-only'))
            ? { lifecycle: 'waiting-human' as const }
            : {}),
          waitingHuman: structuredClone(next),
        });
        writeActive(saved);
        return true;
      },
    };
  }

  private specState(readActive: () => ActiveRun, writeActive: (active: ActiveRun) => void): SpecDeliveryState {
    const invocation = (reserveSession: (state: SpecDeliveryV1) => SpecDeliveryV1): DurableReportInvocationState => ({
      read: async () => structuredClone(readActive().record.reportInvocation),
      compareAndSwap: async (expected, next) => {
        const active = readActive();
        const observed = active.record.reportInvocation;
        if (observed === undefined || expected === undefined ? observed !== expected
          : canonicalJson(observed) !== canonicalJson(expected)) return false;
        const preparing = expected === undefined && next?.phase === 'prepared';
        const specDelivery = preparing ? reserveSession(active.record.specDelivery!) : active.record.specDelivery;
        writeActive(await this.persist(active, { ...(specDelivery ? { specDelivery } : {}),
          reportInvocation: next ? structuredClone(next) : undefined }));
        return true;
      },
    });
    const settle = async (expected: SpecDeliveryV1, next: SpecDeliveryV1, attemptId: string): Promise<boolean> => {
      const active = readActive();
      if (canonicalJson(active.record.specDelivery) !== canonicalJson(expected)
        || active.record.reportInvocation?.attemptId !== attemptId) return false;
      writeActive(await this.persist(active, { specDelivery: structuredClone(next), reportInvocation: undefined }));
      return true;
    };
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
      authorInvocation: (authorSessionId) => invocation((state) => reserveSpecAuthorSession(state, authorSessionId)),
      reviewInvocation: (reviewerSessionId) => invocation((state) => reserveSpecReviewerSession(state, reviewerSessionId)),
      settleAuthor: settle,
      settleReview: settle,
    };
  }

  private reportInvocationState(
    readActive: () => ActiveRun,
    writeActive: (active: ActiveRun) => void,
    launch?: {
      beforeLaunch(): Promise<void>;
      launchChanges(invocation: DurableReportInvocationV1): Partial<RunRecordV1>;
    },
  ): DurableReportInvocationState {
    return {
      read: async () => structuredClone(readActive().record.reportInvocation),
      compareAndSwap: async (expected, next) => {
        const active = readActive();
        const observed = active.record.reportInvocation;
        if (observed === undefined || expected === undefined) {
          if (observed !== expected) return false;
        } else if (canonicalJson(observed) !== canonicalJson(expected)) return false;
        const launching = expected?.phase === 'prepared' && next?.phase === 'launched';
        if (launching) await launch?.beforeLaunch();
        const launchChanges = launching && launch ? launch.launchChanges(next) : {};
        writeActive(await this.persist(active, {
          ...launchChanges,
          reportInvocation: next ? structuredClone(next) : undefined,
        }));
        return true;
      },
    };
  }

  private async continueSpecRequired(active: ActiveRun): Promise<RunIssueResult> {
    if (!active.record.routeReceipt || active.record.routeReceipt.route !== 'spec-required') {
      return await this.terminal(active, { status: 'internal-error', code: 'spec-route-missing' });
    }
    let current = active;
    const context = {
      runId: current.record.runId, issue: structuredClone(current.record.issueSnapshot),
      frozenCriteria: structuredClone(current.record.frozenCriteria), worktreePath: current.record.worktreePath,
      workflowGeneration: structuredClone(current.record.workflowGeneration), receipt: structuredClone(current.record.routeReceipt!),
    };
    const result: SpecCoordinatorResult = await this.dependencies.routeContinuations.specRequired(
      context, this.specState(() => current, (next) => { current = next; }), this.signal,
    );
    if (result.status === 'completed') {
      const evidence = await this.dependencies.writeEvidence({ runId: current.record.runId, code: 'spec-frozen', summary: result.receipt.receiptSha256 });
      return { status: 'spec-frozen', receipt: result.receipt, evidencePath: evidence.path };
    }
    if (result.status === 'cancelled') return await this.terminal(current, { status: 'cancelled' });
    if (result.status === 'retryable') return await this.invokedFailure(current, result.code);
    return await this.terminal(current, { status: 'blocked', kind: result.kind, resumable: result.kind !== 'exhausted' }, result.code);
  }

  private async continueWaitingHuman(active: ActiveRun): Promise<{ result: RunIssueResult } | { active: ActiveRun }> {
    if (!active.record.routeReceipt || !active.record.workflowGeneration) {
      return { result: await this.terminal(active, { status: 'internal-error', code: 'waiting-route-missing' }) };
    }
    const context = {
      runId: active.record.runId,
      issue: structuredClone(active.record.issueSnapshot),
      frozenCriteria: structuredClone(active.record.frozenCriteria),
      worktreePath: active.record.worktreePath,
      workflowGeneration: structuredClone(active.record.workflowGeneration),
      receipt: structuredClone(active.record.routeReceipt),
    };
    let current = active;
    const result = await this.dependencies.routeContinuations.awaitingUser(
      context, this.waitingState(() => current, (next) => { current = next; }), this.signal,
    );
    return this.mapWaitingResult(current, result);
  }

  private async mapWaitingResult(
    active: ActiveRun,
    result: Awaited<ReturnType<RoutedContinuationRegistry['awaitingUser']>>,
  ): Promise<{ result: RunIssueResult } | { active: ActiveRun }> {
    if (result.status === 'awaiting-answer') {
      const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code: 'awaiting-user', summary: result.questionId });
      return { result: { status: 'awaiting-user', questionId: result.questionId, answerPrefix: result.answerPrefix, evidencePath: evidence.path } };
    }
    if (result.status === 'retryable') {
      const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code: result.code, summary: result.owner });
      return { result: { status: 'transport-failed', resumable: true, evidencePath: evidence.path } };
    }
    if (result.status === 'cancelled') return { result: await this.terminal(active, { status: 'cancelled' }) };
    if (result.status === 'blocked') {
      return { result: await this.terminal(active, { status: 'blocked', kind: result.kind, resumable: result.resumable }, result.code) };
    }
    const waitingHuman = archiveWaiting(active.record, result.answer, {
      phase: 'resumed', trustedAnswer: structuredClone(result.answer),
    });
    const routeExecution = initialRouteExecution();
    validateTrustedAnswerResumeTransition({
      lifecycle: active.record.lifecycle,
      routeExecution: active.record.routeExecution,
      routeReceipt: active.record.routeReceipt,
      generationHash: active.record.workflowGeneration.generationHash,
    }, {
      lifecycle: 'triaging', routeExecution, routeReceipt: undefined,
      generationHash: active.record.workflowGeneration.generationHash,
    }, active.record.waitingHuman!);
    const resumed = await this.persist(active, {
      lifecycle: 'triaging',
      issueSnapshot: structuredClone(active.record.issueSnapshot),
      routeExecution,
      routeReceipt: undefined,
      waitingHuman,
    });
    return { active: resumed };
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
    if ([config.github.labels.running.name, config.github.labels.blocked.name, config.github.labels.review.name, config.github.labels.waitingHuman.name]
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
    intent: PublicationIntent;
  }): Promise<ActiveRun> {
    const state = await this.dependencies.runRecords.read();
    const now = this.timestamp();
    const workflow = await this.dependencies.createWorkflowGeneration();
    const { config, ...persistedInput } = input;
    const record: RunRecordV1 = {
      ...persistedInput,
      lifecycle: 'claimed', cycle: 1, reportRepairs: 0,
      reworkFindings: [],
      packageVersion: workflow.receipt.packageVersion,
      workflowGeneration: structuredClone(workflow.receipt),
      skillHashes: structuredClone(workflow.skillHashes),
      checks: [], createdAt: now, updatedAt: now,
    };
    const saved = await this.dependencies.runRecords.compareAndSwap(state.generation, {
      schema: 'codex-orchestrator.agent-auto-state', version: state.version, runs: [...state.runs, record],
    });
    return { state: saved, record: findRun(saved, input.runId), config };
  }

  private async persist(
    active: ActiveRun,
    changes: Partial<RunRecordV1> & { intent?: PublicationIntent | undefined },
    stateVersion: 2 | 3 = active.state.version,
  ): Promise<ActiveRun> {
    const record = { ...active.record, ...changes, updatedAt: this.timestamp() } as RunRecordV1;
    if (Object.hasOwn(changes, 'intent') && changes.intent === undefined) delete record.intent;
    if (Object.hasOwn(changes, 'process') && changes.process === undefined) delete record.process;
    for (const key of ['checkedChangeSha256', 'proofId', 'proofReceipt', 'terminalOutcome', 'outcomeEvidenceId', 'routeExecution', 'routeReceipt', 'reportInvocation', 'mutableInvocation', 'reviewFeedback', 'checkQualification', 'baselineChecks', 'changeBindingVersion', 'candidateBinding', 'executionLease'] as const) {
      if (Object.hasOwn(changes, key) && changes[key] === undefined) delete record[key];
    }
    const runs = active.state.runs.map((candidate) => candidate.runId === record.runId ? record : candidate);
    const saved = await this.dependencies.runRecords.compareAndSwap(active.state.generation, {
      schema: 'codex-orchestrator.agent-auto-state', version: stateVersion, runs,
    });
    return { state: saved, record: findRun(saved, record.runId), config: active.config };
  }

  private clearIntent(active: ActiveRun): Promise<ActiveRun> {
    return this.persist(active, { intent: undefined });
  }

  private async confirmEffect(active: ActiveRun): Promise<ActiveRun> {
    try {
      return await this.clearIntent(active);
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
    record: RunRecordV1,
    config: AgentAutoConfig,
  ): boolean {
    if (issue.state !== 'OPEN') return false;
    const labels = new Set(issue.labels);
    if (!labels.has(config.github.labels.auto.name)
      || labels.has(config.github.labels.blocked.name)
      || labels.has(config.github.labels.review.name)
      || labels.has(config.github.labels.waitingHuman.name)) return false;
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

  private hasTrustedClaim(issue: RunIssueSnapshot, record: RunRecordV1): boolean {
    const exactBody = claimComment(record.runId, record.issueNumber, record.branchName);
    const markers = issue.comments.filter(isClaimMarkerComment);
    if (issue.comments.some((comment) => {
      const firstLine = comment.body.split('\n')[0] ?? '';
      return firstLine.startsWith(`<!-- codex-orchestrator:run:${record.runId}:claim`) && !claimMarkerPattern.test(firstLine);
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
    }, 3) };
  }

  private async cutoverLegacyImmutableBoundary(
    active: ActiveRun,
    config: AgentAutoConfig,
    frozenCriteria: FrozenCriterion[],
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const captured = await this.ensureCandidateBinding(active, config, {
      kind: 'implementation-cycle', cycle: active.record.cycle,
    });
    if ('status' in captured) return captured;
    active = captured.active;
    const binding = active.record.candidateBinding!;
    const targetFingerprint = directReviewCandidateTargetFingerprint({
      binding,
      routeDecisionSha256: active.record.routeReceipt!.decisionSha256,
      workflowGenerationHash: active.record.workflowGeneration.generationHash,
      cycle: active.record.cycle,
      frozenCriteria,
    });
    return { active: await this.persist(active, {
      lifecycle: 'implementing',
      directReview: createInitialDirectReview({
        targetFingerprint,
        codeReviewerSessionId: this.dependencies.createReviewSessionId(),
      }),
      checks: [], checkedChangeSha256: undefined, proofId: undefined, proofReceipt: undefined,
      checkQualification: undefined, baselineChecks: undefined,
      terminalOutcome: undefined, outcomeEvidenceId: undefined,
    }) };
  }

  private async resumeLegacyProof(
    active: ActiveRun,
    config: AgentAutoConfig,
    issue: IssueSnapshot,
    frozenCriteria: FrozenCriterion[],
    recoverAttemptOnly = false,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const proofId = active.record.proofId;
    const recordedCheckedChange = active.record.checkedChangeSha256;
    if (!proofId || !recordedCheckedChange || active.record.checks.some((check) => check.status !== 'passed' || 'bindingId' in check)) {
      return this.cutoverLegacyImmutableBoundary(active, config, frozenCriteria);
    }
    let checkPolicy;
    try { checkPolicy = resolveIssueCheckPolicy(active.record.issueSnapshot.body, config.checks); }
    catch (error) { return this.invokedFailure(active, 'issue-verification-invalid', error instanceof Error ? error.message : undefined); }
    if (!sameCheckPolicy(active.record.checks, checkPolicy.checks)) {
      return this.cutoverLegacyImmutableBoundary(active, config, frozenCriteria);
    }
    const snapshot = await this.dependencies.git.snapshot(active.record.worktreePath);
    const payload: CheckedChangePayloadV1 = {
      version: 1,
      canonicalRepository: active.record.canonicalRepository,
      runId: active.record.runId,
      issueNumber: active.record.issueNumber,
      cycle: active.record.cycle,
      baseSha: expectedImplementationHead(active.record),
      headSha: snapshot.headSha,
      indexTreeSha: snapshot.indexTreeSha,
      trackedContentSha256: snapshot.trackedContentSha256,
      untrackedContentSha256: snapshot.untrackedContentSha256,
      worktreeIdentity: snapshot.worktreeIdentity,
      changedFiles: await this.dependencies.git.listChangedFiles(active.record.worktreePath),
      checks: active.record.checks.map(({ id, command, outputSha256 }) => ({ id, command, status: 'passed' as const, outputSha256 })),
      checkPolicySha256: sha256(canonicalJson(checkPolicy.checks)),
      packageVersion: active.record.packageVersion,
      proofSchemaVersion: 1,
    };
    if (checkedChangePayloadSha256(payload) !== recordedCheckedChange) {
      return this.cutoverLegacyImmutableBoundary(active, config, frozenCriteria);
    }
    const checkedChange = this.dependencies.checkedChangeMint.mint(payload);
    let proof: ProveChangeResult;
    try {
      proof = await this.dependencies.proof.proveChange({
        proofId,
        issue: publicIssueSnapshot(issue),
        frozenCriteria,
        checkedChange,
        recoverAttemptOnly,
        workflowGeneration: structuredClone(active.record.workflowGeneration),
        beforeAgentLaunch: async () => {
          const failure = await this.revalidateFeedbackWorker(active, config, active.record.issueNumber);
          if (failure) throw new ProofLaunchAuthorizationError(failure);
        },
        onLaunched: async ({ pid, processGroupId, launchedAt }) => {
          active = await this.persist(active, {
            lifecycle: 'safe-halt',
            process: {
              pid, processGroupId, startedAt: launchedAt, baseline: snapshot,
              purpose: 'proof', resumeLifecycle: 'proving', resumeReviewStage: null,
            },
          });
        },
      });
    } catch (error) {
      if (error instanceof ProofLaunchAuthorizationError) return error.outcome as RunIssueResult;
      if (error instanceof ProofQuiescenceError) {
        return this.persistTerminal(active, { status: 'transport-failed', resumable: false }, 'proof-process-quiescence-delayed', false);
      }
      return this.persistTerminal(active, { status: 'internal-error', code: 'acceptance-proof-internal-failure' }, 'acceptance-proof-internal-failure', false);
    }
    active = await this.persist(active, { lifecycle: 'proving', process: undefined });
    if (proof.status === 'passed') {
      return { active: await this.persist(active, { lifecycle: 'publishing', proofReceipt: proof.receipt, reworkFindings: [] }) };
    }
    if (proof.status === 'needs-rework') return this.cutoverLegacyImmutableBoundary(active, config, frozenCriteria);
    return this.mapProofFailure(active, proof);
  }

  private async prepareCandidateExecution(
    active: ActiveRun,
    config: AgentAutoConfig,
    operation: CandidateExecutionLeaseV2['operation'],
    operationSourceId: string,
  ): Promise<{ active: ActiveRun; lease: CandidateExecutionLeaseV2 } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    if (!candidate || !binding) return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-git-v2-required');
    const attemptId = sha256(canonicalJson({ bindingId: binding.bindingId, operation, operationSourceId }));
    const prepared = await candidate.prepareExecution({
      binding,
      runId: active.record.runId,
      workspaceRoot: resolve(dirname(active.record.worktreePath)),
      operation,
      attemptId,
    });
    if (prepared.kind === 'failed') return this.mapCandidateFailure(active, prepared.code);
    if (prepared.value.kind === 'path-diverged') {
      return this.persistCandidateEvidenceSafetyTerminal(active, 'path-diverged');
    }
    const next = await this.persist(active, { executionLease: prepared.value.lease });
    return { active: next, lease: prepared.value.lease };
  }

  private async settleCandidateExecution(
    active: ActiveRun,
    config: AgentAutoConfig,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    const lease = active.record.executionLease;
    if (!candidate || !binding || !lease) return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-execution-state-missing');
    const inspection = await candidate.inspectExecution({ binding, lease, artifactDir: config.proof.artifactDir });
    if (inspection.kind === 'failed') return this.mapCandidateFailure(active, inspection.code);
    if (inspection.value !== 'matching') {
      return this.reconcilePersistedCandidateExecution(active, config);
    }
    const cleared = await this.persist(active, { executionLease: undefined });
    const removed = await candidate.removeExecution({ lease, requireProcessAbsent: true });
    if (removed.kind === 'failed') return this.mapCandidateFailure(cleared, removed.code);
    return { active: cleared };
  }

  private async inspectCompletedReviewExecution(
    active: ActiveRun,
    config: AgentAutoConfig,
  ): Promise<{ lease: CandidateExecutionLeaseV2 } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    const lease = active.record.executionLease;
    if (!candidate || !binding || !lease || lease.operation !== 'direct-review') {
      return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-execution-state-missing');
    }
    const inspection = await candidate.inspectExecution({ binding, lease, artifactDir: config.proof.artifactDir });
    if (inspection.kind === 'failed') return this.mapCandidateFailure(active, inspection.code);
    if (inspection.value !== 'matching') return this.persistCandidateEvidenceSafetyTerminal(active, `candidate-execution-${inspection.value}`);
    return { lease };
  }

  private async removeCompletedReviewExecution(
    active: ActiveRun,
    lease: CandidateExecutionLeaseV2,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    if (!candidate) return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-execution-state-missing');
    const removed = await candidate.removeExecution({ lease, requireProcessAbsent: true });
    if (removed.kind === 'failed') return this.mapCandidateFailure(active, removed.code);
    return { active };
  }

  private async reconcilePersistedCandidateExecution(
    active: ActiveRun,
    config: AgentAutoConfig,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    const lease = active.record.executionLease;
    if (!candidate || !binding || !lease) {
      return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-execution-state-missing');
    }
    if (lease.operation === 'direct-review' && lease.phase === 'launched') {
      return this.persistCandidateEvidenceSafetyTerminal(active, 'direct-review-canonical-invocation-missing');
    }
    if (lease.phase === 'launched') {
      try { await this.dependencies.waitForReviewProcessAbsence(lease.processGroupId!); }
      catch { return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-execution-process-absence-unconfirmed'); }
    }
    const inspection = await candidate.inspectExecution({ binding, lease, artifactDir: config.proof.artifactDir });
    if (inspection.kind === 'failed') return this.mapCandidateFailure(active, inspection.code);
    if (inspection.value === 'missing') return this.persistCandidateEvidenceSafetyTerminal(active, 'candidate-execution-missing');
    if (inspection.value === 'mutated') {
      const cleared = await this.persist(active, {
        executionLease: undefined, changeBindingVersion: undefined, candidateBinding: undefined,
      });
      const removed = await candidate.removeExecution({ lease, requireProcessAbsent: true });
      if (removed.kind === 'failed') return this.mapCandidateFailure(cleared, removed.code);
      const released = await candidate.releasePin({ binding, expectedPinnedCommitSha: binding.candidateCommitSha });
      if (released.kind === 'failed') return this.mapCandidateFailure(cleared, released.code);
      return this.persistTerminal(cleared, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-materialization-mutated', false);
    }
    if (lease.operation === 'acceptance-proof') {
      return { active };
    }
    const cleared = await this.persist(active, { executionLease: undefined });
    const removed = await candidate.removeExecution({ lease, requireProcessAbsent: true });
    if (removed.kind === 'failed') return this.mapCandidateFailure(cleared, removed.code);
    return { active: cleared };
  }

  private async clearAndReleaseCandidate(active: ActiveRun): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    if (!candidate || !binding) return { active };
    if (active.record.executionLease) return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'candidate-execution-not-quiescent');
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
    const intent = active.record.intent;
    if (!active.record.candidateBinding || (intent?.kind !== 'commit' && intent?.kind !== 'review-update-commit')) {
      return this.invokedFailure(active, 'retained-candidate-intent-state-invalid');
    }
    const evidence = await this.dependencies.writeEvidence({
      runId: active.record.runId,
      code: evidenceCode,
      summary: 'Candidate publication stopped locally with the exact commit intent and pin retained.',
    });
    const terminalOutcome: RunTerminalOutcome = {
      status: 'blocked', kind: 'safety', resumable: false, evidencePath: evidence.path,
    };
    const directReview = active.record.directReview && active.record.directReview.status !== 'terminal'
      ? projectTerminalDirectReview(active.record.directReview, { status: 'blocked', kind: 'safety' })
      : active.record.directReview;
    await this.persist(active, {
      lifecycle: 'blocked',
      terminalOutcome,
      outcomeEvidenceId: evidence.id,
      ...(directReview ? { directReview } : {}),
      ...(active.record.reviewFeedback?.activeBatch ? {
        reviewFeedback: blockReviewFeedback(active.record.reviewFeedback, 'safety', this.timestamp()),
      } : {}),
      process: undefined,
      reportInvocation: undefined,
    });
    return publicOutcome(terminalOutcome);
  }

  private async reconcileUnknownCandidatePublication(active: ActiveRun): Promise<{ active: ActiveRun } | RunIssueResult> {
    const candidate = this.dependencies.git.candidateV2;
    const binding = active.record.candidateBinding;
    const intent = active.record.intent;
    if (!candidate || !binding || (intent?.kind !== 'commit' && intent?.kind !== 'review-update-commit')) {
      return publicOutcome(active.record.terminalOutcome!);
    }
    const observation = await candidate.createOrObserveCommit({
      worktreePath: active.record.worktreePath,
      branchName: active.record.branchName,
      parentSha: intent.parentSha,
      treeSha: intent.treeSha,
      message: intent.message,
      candidateRef: intent.candidateRef!,
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
    const evidence = await this.dependencies.writeEvidence({
      runId: active.record.runId,
      code: evidenceCode,
      summary: 'Candidate evidence was retained without a Git or GitHub effect.',
    });
    const terminalOutcome: RunTerminalOutcome = {
      status: 'blocked', kind: 'safety', resumable: false, evidencePath: evidence.path,
    };
    const directReview = active.record.directReview && active.record.directReview.status !== 'terminal'
      ? projectTerminalDirectReview(active.record.directReview, { status: 'blocked', kind: 'safety' })
      : active.record.directReview;
    await this.persist(active, {
      lifecycle: 'blocked', terminalOutcome, outcomeEvidenceId: evidence.id,
      ...(directReview ? { directReview } : {}),
      ...(active.record.reviewFeedback?.activeBatch ? {
        reviewFeedback: blockReviewFeedback(active.record.reviewFeedback, 'safety', this.timestamp()),
      } : {}),
      process: undefined,
      reportInvocation: undefined,
    });
    return publicOutcome(terminalOutcome);
  }

  private mapCandidateFailure(active: ActiveRun, code: string): Promise<RunIssueResult> {
    if (code === 'candidate-unstable' || code === 'candidate-io-failed' || code === 'candidate-materialization-io-failed') {
      return this.invokedFailure(active, code, 'Candidate operation failed before an effect and may be retried without consuming a repair budget.');
    }
    return this.terminal(active, { status: 'transport-failed', resumable: false }, code);
  }

  private async runImplementation(input: {
    operation: MutableWorktreeOperationId;
    runId: string;
    worktreePath: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    cycle: number;
    reworkFindings: string[];
    repairOnly: boolean;
    workflowGeneration: WorkflowGenerationReceipt;
    reviewFeedbackRound?: number;
    reviewFeedback?: Array<{ id: string; sourceUrl: string; path: string | null; line: number | null; body: string }>;
    phaseFacts?: string[];
    invocationState: DurableMutableInvocationState;
    beforeLaunch?: () => Promise<void>;
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

  private mutableInvocationState(current: () => ActiveRun, replace: (active: ActiveRun) => void): DurableMutableInvocationState {
    return {
      read: async () => structuredClone(current().record.mutableInvocation),
      compareAndSwap: async (expected, next) => {
        const active = current();
        if (canonicalJson(active.record.mutableInvocation ?? null) !== canonicalJson(expected ?? null)) return false;
        try { replace(await this.persist(active, { mutableInvocation: next })); return true; }
        catch { return false; }
      },
    };
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
      if (!directReview || !routeReceipt || routeReceipt.route !== 'direct'
        || (directReview.stage !== 'review-full' && directReview.stage !== 'review-closure')) {
        return this.terminal(active, { status: 'internal-error', code: 'direct-review-state-invalid' });
      }
      const reviewerSessionId = directReview.review.reviewerSessionId;
      if (!reviewerSessionId) return this.terminal(active, { status: 'internal-error', code: 'direct-review-session-missing' });
      const closureRequestSha256 = directReview.stage === 'review-closure'
        ? directReviewClosureRequestSha256(directReview)
        : null;
      const mode = directReview.stage === 'review-closure' ? 'closure' as const : 'full' as const;
      const reviewerAuthorization = await this.observeFeedbackWorker(active, config, active.record.issueNumber);
      if (reviewerAuthorization.status !== 'valid') {
        const released = await this.clearAndReleaseCandidate(active);
        if ('status' in released) return released;
        active = released.active;
        return reviewerAuthorization.status === 'retryable'
          ? this.invokedFailure(active, `${reviewerAuthorization.code}-retryable`)
          : this.blockReviewFeedback(active, 'safety', reviewerAuthorization.code);
      }
      let executionLease: CandidateExecutionLeaseV2;
      if (active.record.reportInvocation?.operation === 'code-review') {
        if (active.record.executionLease?.operation !== 'direct-review') {
          return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'direct-review-candidate-execution-missing');
        }
        executionLease = active.record.executionLease;
      } else {
        const execution = await this.prepareCandidateExecution(
          active,
          config,
          'direct-review',
          `${reviewerSessionId}:${directReview.targetRevision}:${mode}:${implementationAttemptId}`,
        );
        if ('status' in execution) return execution;
        active = execution.active;
        executionLease = execution.lease;
      }
      const abortPreparedReview = async (
        validation: Exclude<FeedbackWorkerObservation, { status: 'valid' }>,
      ): Promise<RunIssueResult> => {
        const settledExecution = await this.settleCandidateExecution(active, config);
        if ('status' in settledExecution) return settledExecution;
        active = settledExecution.active;
        if (active.record.reportInvocation) return this.invokedFailure(active, 'direct-review-authorization-changed-after-prepare');
        const released = await this.clearAndReleaseCandidate(active);
        if ('status' in released) return released;
        active = released.active;
        return validation.status === 'retryable'
          ? this.invokedFailure(active, `${validation.code}-retryable`)
          : this.blockReviewFeedback(active, 'safety', validation.code);
      };
      const launchAuthorization = await this.observeFeedbackWorker(active, config, active.record.issueNumber);
      if (launchAuthorization.status !== 'valid') return abortPreparedReview(launchAuthorization);
      let launchAuthorizationFailure: Exclude<FeedbackWorkerObservation, { status: 'valid' }> | undefined;
      const result = await this.dependencies.implementationReviewer.run({
        runId: active.record.runId,
        worktreePath: executionLease.path,
        operation: 'code-review',
        mode,
        reviewerSessionId,
        implementationAttemptId,
        targetRevision: directReview.targetRevision,
        targetFingerprint: directReview.targetFingerprint,
        closureRequestSha256,
        issue,
        frozenCriteria,
        routeReceipt: structuredClone(routeReceipt),
        defects: structuredClone(directReview.review.defects),
        affectedDefectIds: [...directReview.review.affectedDefectIds],
        fixedRepairFindings: directReview.repairFindings.filter((finding) => finding.status === 'fixed')
          .map((finding) => ({ id: finding.id, affectedContracts: [...finding.affectedContracts] })),
        reviewFocus: ['acceptance-criteria', 'correctness', 'test-quality'],
        workflowGeneration: structuredClone(active.record.workflowGeneration),
        repairOnly: reportRepair !== undefined,
        originalReportSha256: reportRepair?.originalReportSha256 ?? null,
        validationDiagnostic: reportRepair?.diagnostic ?? null,
        originalReportBytes: reportRepair?.originalReportBytes ?? null,
        signal: this.signal,
        invocationState: this.reportInvocationState(() => active, (next) => { active = next; }, {
          beforeLaunch: async () => {
            const authorization = await this.observeFeedbackWorker(active, config, active.record.issueNumber);
            if (authorization.status !== 'valid') {
              launchAuthorizationFailure = authorization;
              throw new Error('direct review launch authorization changed');
            }
          },
          launchChanges: (invocation) => {
            const lease = active.record.executionLease;
            if (!lease || invocation.pid === null || invocation.processGroupId === null || invocation.launchedAt === null) {
              throw new Error('direct review candidate execution is missing at launch');
            }
            return {
              executionLease: this.dependencies.git.candidateV2!.markExecutionLaunched({
                lease, pid: invocation.pid, processGroupId: invocation.processGroupId, launchedAt: invocation.launchedAt,
              }),
            };
          },
        }),
      });
      if (launchAuthorizationFailure) return abortPreparedReview(launchAuthorizationFailure);
      let adoptedExecution: CandidateExecutionLeaseV2 | undefined;
      if (result.kind === 'completed' || result.kind === 'report-invalid') {
        const inspected = await this.inspectCompletedReviewExecution(active, config);
        if ('status' in inspected) return inspected;
        adoptedExecution = inspected.lease;
      } else if (result.kind !== 'safe-halt') {
        const settledExecution = await this.settleCandidateExecution(active, config);
        if ('status' in settledExecution) return settledExecution;
        active = settledExecution.active;
      }
      if (result.kind === 'completed') {
        const current = active.record.directReview;
        if (!current) return this.terminal(active, { status: 'internal-error', code: 'direct-review-result-orphaned' });
        if (result.report.verdict === 'needs-work') {
          const exhausted = this.repairBudgetExhausted(active, maxCycles);
          const repaired = acceptNeedsWorkDirectReview(current, result.report, result.artifactSha256);
          const findings = [
            ...result.report.defects
            .filter((defect) => defect.status === 'open' || defect.status === 'reopened')
            .map((defect) => `${defect.id}: ${defect.failure}\nRepair: ${defect.repair}`),
            ...repaired.repairFindings
              .filter((finding) => finding.status === 'reopened')
              .map((finding) => `${finding.id}: ${finding.summary}`),
          ];
          active = await this.persist(active, {
            ...(!exhausted ? {
              lifecycle: 'implementing' as const,
              cycle: active.record.reviewFeedback?.activeBatch
                ? active.record.cycle
                : (active.record.cycle + 1) as RunRecordV1['cycle'],
              ...(active.record.reviewFeedback?.activeBatch ? {
                reviewFeedback: reserveNextReviewFeedbackRound(active.record.reviewFeedback),
              } : {}),
            } : {}),
            directReview: repaired,
            reworkFindings: findings,
            checks: [],
            checkedChangeSha256: undefined,
            proofId: undefined,
            proofReceipt: undefined,
            reportInvocation: undefined,
            executionLease: undefined,
          });
          const removed = await this.removeCompletedReviewExecution(active, adoptedExecution!);
          if ('status' in removed) return removed;
          active = removed.active;
          const released = await this.clearAndReleaseCandidate(active);
          if ('status' in released) return released;
          active = released.active;
          if (exhausted) {
            return active.record.reviewFeedback?.activeBatch
              ? this.blockReviewFeedback(active, 'exhausted', 'direct-review-repair-exhausted')
              : this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true }, 'direct-review-repair-exhausted');
          }
          return active;
        }
        if (result.report.verdict !== 'approved') {
          const terminal = await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'direct-review-rejected');
          await this.dependencies.git.candidateV2!.removeExecution({ lease: adoptedExecution!, requireProcessAbsent: true });
          return terminal;
        }
        active = await this.persist(active, {
          lifecycle: 'checking',
          directReview: acceptApprovedDirectReview(current, result.report, result.artifactSha256),
          reportInvocation: undefined,
          executionLease: undefined,
        });
        const removed = await this.removeCompletedReviewExecution(active, adoptedExecution!);
        return 'status' in removed ? removed : removed.active;
      }
      if (result.kind === 'report-invalid') {
        const current = active.record.directReview;
        if (!current) return this.terminal(active, { status: 'internal-error', code: 'direct-review-result-orphaned' });
        if (current.review.reportRepairs >= MAX_DIRECT_REVIEW_REPORT_REPAIRS) {
          const terminal = await this.terminal(
            active,
            { status: 'internal-error', code: 'direct-review-report-malformed' },
            'direct-review-report-malformed',
          );
          await this.dependencies.git.candidateV2!.removeExecution({ lease: adoptedExecution!, requireProcessAbsent: true });
          return terminal;
        }
        const withoutInvocation = structuredClone(current);
        active = await this.persist(active, {
          directReview: {
            ...withoutInvocation,
            review: {
              ...withoutInvocation.review,
              reportRepairs: (withoutInvocation.review.reportRepairs + 1) as typeof withoutInvocation.review.reportRepairs,
            },
          },
          reportInvocation: undefined,
          executionLease: undefined,
        });
        const removed = await this.removeCompletedReviewExecution(active, adoptedExecution!);
        if ('status' in removed) return removed;
        active = removed.active;
        reportRepair = {
          originalReportSha256: result.originalReportSha256,
          originalReportBytes: Buffer.from(result.originalReportBytes),
          diagnostic: result.diagnostic,
        };
        continue;
      }
      if (result.kind === 'transport-failed') {
        return this.invokedFailure(active, 'direct-review-transport-failed');
      }
      if (result.kind === 'safe-halt') {
        return this.invokedFailure(active, result.code, 'Code-review process ownership remains unresolved; no relaunch was attempted.');
      }
      if (result.kind === 'cancelled') return this.terminal(active, { status: 'cancelled' });
      return this.terminal(active, { status: 'internal-error', code: result.code });
    }
  }

  private async qualifyChecks(
    starting: ActiveRun,
    config: AgentAutoConfig,
    issue: IssueSnapshot,
    frozenCriteria: FrozenCriterion[],
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    let active = starting;
    let checkPolicy;
    try { checkPolicy = resolveIssueCheckPolicy(active.record.issueSnapshot.body, config.checks); }
    catch (error) {
      active = await this.persist(active, { lifecycle: 'routed' });
      return this.invokedFailure(active, 'issue-verification-invalid', error instanceof Error ? error.message : undefined);
    }
    const configuredChecks = Object.entries(checkPolicy.checks);
    const checkPolicySha256 = sha256(canonicalJson(checkPolicy.checks));
    const existingQualification = active.record.checkQualification;
    const prior = existingQualification?.checkPolicySha256 === checkPolicySha256
      ? existingQualification
      : undefined;
    let repairAttempts = prior?.repairAttempts ?? 0;
    if (!prior) {
      active = await this.persist(active, {
        checkQualification: {
          version: 1, checkPolicySha256, repairAttempts, checks: [],
        },
        baselineChecks: undefined,
      });
    }

    if (active.record.mutableInvocation?.operation === 'qualification-repair') {
      const findings = active.record.checkQualification?.repairFindings;
      if (!findings?.length) return this.invokedFailure(active, 'qualification-repair-correlation-missing');
      const deniedPathsBaseline = await this.dependencies.git.fingerprintDeniedPaths(active.record.worktreePath, config.deny.readPaths);
      const invocationState = this.mutableInvocationState(() => active, (next) => { active = next; });
      const recovered = await this.runImplementation({
        operation: 'qualification-repair', runId: active.record.runId, worktreePath: active.record.worktreePath,
        issue, frozenCriteria, cycle: repairAttempts + 1, reworkFindings: findings, repairOnly: false,
        workflowGeneration: active.record.workflowGeneration, phaseFacts: [deniedPathsBaseline], invocationState,
      });
      if (recovered.kind === 'safe-halt') return this.invokedFailure(active, recovered.code);
      if (recovered.kind === 'transport-failed') return this.invokedFailure(active, recovered.code ?? 'qualification-repair-agent-failed');
      if (recovered.kind === 'cancelled') return this.terminal(active, { status: 'cancelled' });
      if (recovered.kind !== 'completed') return this.invokedFailure(active, 'qualification-repair-agent-failed');
      const settled = await this.settleQualificationRepair(active, config, recovered, deniedPathsBaseline);
      if ('status' in settled) return settled;
      active = settled.active;
      repairAttempts = active.record.checkQualification!.repairAttempts;
    }

    while (true) {
      const captured = await this.ensureCandidateBinding(active, config, {
        kind: 'qualification', repairAttempt: repairAttempts,
      });
      if ('status' in captured) return captured;
      active = captured.active;
      const qualificationBinding = active.record.candidateBinding!;
      const checks: NonNullable<RunRecordV1['checkQualification']>['checks'] = [];
      const failures: string[] = [];
      for (const [id, command] of configuredChecks) {
        if (this.signal.aborted) return this.terminal(active, { status: 'cancelled' });
        if (this.dependencies.checks.supportsLaunchOwnership !== true) {
          return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'candidate-check-launch-ownership-required');
        }
        const execution = await this.prepareCandidateExecution(active, config, 'qualification-check', `${id}:${checkPolicySha256}`);
        if ('status' in execution) return execution;
        active = execution.active;
        const lease = execution.lease;
        let check: { status: 'passed' | 'failed'; output: Buffer; outputSha256: string };
        try {
          check = await this.dependencies.checks.run({
            id, command, source: checkPolicy.source,
            cwd: lease.path,
            phase: 'qualification',
            signal: this.signal,
            onLaunched: async ({ pid, processGroupId }) => {
              active = await this.persist(active, {
                executionLease: this.dependencies.git.candidateV2!.markExecutionLaunched({
                  lease, pid, processGroupId, launchedAt: this.timestamp(),
                }),
              });
            },
          });
        } catch (error) {
          if (error instanceof CheckProcessQuiescenceError) {
            return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'check-process-quiescence-unconfirmed');
          }
          return this.invokedFailure(
            active,
            'qualification-check-execution-failed',
            error instanceof Error ? error.message : 'The qualification check process did not start or settle. Retry the same run.',
          );
        }
        const settledExecution = await this.settleCandidateExecution(active, config);
        if ('status' in settledExecution) return settledExecution;
        active = settledExecution.active;
        if (this.signal.aborted) return this.terminal(active, { status: 'cancelled' });
        checks.push({
          id, command, status: check.status, outputSha256: check.outputSha256,
          bindingId: qualificationBinding.bindingId,
          candidateTreeSha: qualificationBinding.candidateTreeSha,
          checkPolicySha256,
        });
        if (check.status === 'failed') {
          failures.push(`Pre-implementation scoped check ${id} failed (${command}):\n${check.output.toString('utf8').slice(0, 8 * 1024)}`);
        }
      }

      active = await this.persist(active, {
        checkQualification: {
          version: 1, checkPolicySha256, repairAttempts, checks,
        },
        baselineChecks: undefined,
      });
      if (failures.length === 0) {
        const released = await this.clearAndReleaseCandidate(active);
        return 'status' in released ? released : { active: released.active };
      }
      if (repairAttempts >= config.runner.maxCycles) {
        return this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true }, 'qualification-repair-exhausted');
      }
      if (!await this.authorized(active, config)) {
        return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }

      const released = await this.clearAndReleaseCandidate(active);
      if ('status' in released) return released;
      active = released.active;

      const deniedPathsBaseline = await this.dependencies.git.fingerprintDeniedPaths(active.record.worktreePath, config.deny.readPaths);
      active = await this.persist(active, {
        checkQualification: { ...active.record.checkQualification!, repairFindings: [...failures] },
      });
      const invocationState = this.mutableInvocationState(() => active, (next) => { active = next; });
      const repair = await this.runImplementation({
        operation: 'qualification-repair',
        runId: active.record.runId,
        worktreePath: active.record.worktreePath,
        issue,
        frozenCriteria,
        cycle: repairAttempts + 1,
        reworkFindings: failures,
        repairOnly: false,
        workflowGeneration: active.record.workflowGeneration,
        phaseFacts: [deniedPathsBaseline],
        invocationState,
      });
      if (repair.kind === 'safe-halt') {
        return this.invokedFailure(active, repair.code);
      }
      if (repair.kind !== 'completed'
        && await this.dependencies.git.fingerprintDeniedPaths(active.record.worktreePath, config.deny.readPaths) !== deniedPathsBaseline) {
        return this.invokedFailure(active, 'qualification-repair-effect-unresolved');
      }
      if (repair.kind === 'cancelled') return this.terminal(active, { status: 'cancelled' });
      if (repair.kind !== 'completed') {
        return this.invokedFailure(active, 'qualification-repair-agent-failed', 'Qualification repair did not complete. Retry the same run.');
      }
      const settled = await this.settleQualificationRepair(active, config, repair, deniedPathsBaseline);
      if ('status' in settled) return settled;
      active = settled.active;
      repairAttempts = active.record.checkQualification!.repairAttempts;
    }
  }

  private async settleQualificationRepair(
    active: ActiveRun,
    config: AgentAutoConfig,
    repair: Extract<ImplementationAgentResult, { kind: 'completed' }>,
    deniedPathsBaseline: string,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    if (await this.dependencies.git.fingerprintDeniedPaths(active.record.worktreePath, config.deny.readPaths) !== deniedPathsBaseline) {
      active = await this.persist(active, { mutableInvocation: undefined });
      return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'denied-path-modified');
    }
    const qualification = { ...active.record.checkQualification! };
    delete qualification.repairFindings;
    qualification.repairAttempts = (qualification.repairAttempts + 1) as typeof qualification.repairAttempts;
    active = await this.persist(active, { checkQualification: qualification, mutableInvocation: undefined });
    let report;
    try { report = validateImplementationReport(repair.report); }
    catch { return this.invokedFailure(active, 'qualification-repair-report-invalid', 'Qualification repair report was invalid. Retry the same run.'); }
    if (report.status === 'external-block') {
      return this.terminal(active, { status: 'blocked', kind: 'external', resumable: true }, 'qualification-repair-external-block');
    }
    if (await this.dependencies.git.getHead(active.record.worktreePath) !== expectedImplementationHead(active.record)) {
      return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'qualification-repair-head-changed');
    }
    const changedFiles = await this.dependencies.git.listChangedFiles(active.record.worktreePath);
    if (changedFiles.length === 0 || !sameStrings(changedFiles, report.changedFiles)) {
      return this.invokedFailure(active, 'qualification-repair-change-set-invalid', 'Qualification repair must report the complete cumulative worktree change set.');
    }
    return { active };
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
          : (active.record.cycle + 1) as RunRecordV1['cycle'],
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
        : (active.record.cycle + 1) as RunRecordV1['cycle'],
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
    if (active.record.executionLease) {
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
    if (active.record.mutableInvocation) {
      const reconciled = await this.reconcileMutableBeforeTerminal(active);
      if ('status' in reconciled) return reconciled;
      active = reconciled.active;
    }
    const feedback = active.record.reviewFeedback;
    if (!feedback?.activeBatch) return this.terminal(active, { status: 'blocked', kind, resumable: false }, evidenceCode);
    {
      const config = active.config;
      const blockedLabels = [config.github.labels.auto.name, config.github.labels.blocked.name].sort();
      const existingIntent = active.record.intent;
      if (existingIntent?.kind !== 'review-blocked-labels') {
        active = await this.persist(active, { intent: {
          kind: 'review-blocked-labels', issueNumber: active.record.issueNumber,
          batchId: feedback.activeBatch.batchId, expected: blockedLabels, blockKind: kind, evidenceCode,
        } });
      } else if (existingIntent.issueNumber !== active.record.issueNumber
        || existingIntent.batchId !== feedback.activeBatch.batchId
        || !sameStrings(existingIntent.expected, blockedLabels)
        || existingIntent.blockKind !== kind
        || existingIntent.evidenceCode !== evidenceCode) {
        return this.invokedFailure(active, 'review-feedback-blocked-labels-intent-diverged');
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
        try { await this.markV3ExternalEffect(active); await this.dependencies.issues.setLabels(active.record.issueNumber, blockedLabels); }
        catch { return this.invokedFailure(active, 'review-feedback-blocked-labels-delivery-unknown'); }
        issue = await this.readIssue(active.record.issueNumber);
      }
      if (canReduceAuthority && (!issue || !sameStrings(issue.labels, blockedLabels))) {
        return this.invokedFailure(active, 'review-feedback-blocked-labels-observation-diverged');
      }
    }
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code: evidenceCode, summary: `review feedback ${kind}` });
    const terminalOutcome: RunTerminalOutcome = { status: 'blocked', kind, resumable: false, evidencePath: evidence.path };
    const directReview = active.record.directReview && active.record.directReview.status !== 'terminal'
      ? projectTerminalDirectReview(active.record.directReview, { status: 'blocked', kind })
      : active.record.directReview;
    await this.persist(active, {
      lifecycle: 'blocked',
      reviewFeedback: blockReviewFeedback(feedback, kind, this.timestamp()),
      ...(directReview ? { directReview } : {}),
      terminalOutcome,
      outcomeEvidenceId: evidence.id,
      process: undefined,
      reportInvocation: undefined,
      intent: undefined,
    });
    return publicOutcome(terminalOutcome);
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
    return this.terminal(await this.clearIntent(active), { status: 'blocked', kind: 'safety', resumable: true });
  }

  private async invokedFailure(
    active: ActiveRun,
    code: string,
    summary = 'Publication delivery requires reconciliation.',
  ): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code, summary });
    return { status: 'transport-failed', resumable: true, evidencePath: evidence.path };
  }

  private async markV3ExternalEffect(active: ActiveRun): Promise<void> {
    if (active.state.version !== 3) return;
    if (!this.dependencies.runRecords.markPublicationEffectPossible) {
      throw new Error('run-state publication watermark is unavailable');
    }
    await this.dependencies.runRecords.markPublicationEffectPossible();
  }

  private async terminal(
    active: ActiveRun,
    outcome: TerminalSeed,
    evidenceCode: string = outcome.status,
    retainIntent = false,
  ): Promise<RunIssueResult> {
    if (active.record.mutableInvocation) {
      const reconciled = await this.reconcileMutableBeforeTerminal(active);
      if ('status' in reconciled) return reconciled;
      active = reconciled.active;
    }
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

  private async reconcileMutableBeforeTerminal(
    starting: ActiveRun,
  ): Promise<{ active: ActiveRun } | RunIssueResult> {
    let active = starting;
    const invocation = active.record.mutableInvocation;
    if (!invocation) return { active };
    let deniedPathsBaseline: string;
    try {
      deniedPathsBaseline = await this.dependencies.git.fingerprintDeniedPaths(
        active.record.worktreePath,
        active.config.deny.readPaths,
      );
    } catch {
      return this.invokedFailure(active, 'mutable-operation-terminal-baseline-unavailable');
    }
    const qualification = invocation.operation === 'qualification-repair';
    const feedback = invocation.operation === 'review-feedback-implementation';
    const repairFindings = invocation.context.reworkFindings;
    if (qualification && !repairFindings?.length) {
      return this.invokedFailure(active, 'qualification-repair-correlation-missing');
    }
    const activeBatch = feedback ? active.record.reviewFeedback?.activeBatch : undefined;
    const directReview = feedback ? active.record.directReview : undefined;
    if (feedback && (!activeBatch || !directReview)) {
      return this.invokedFailure(active, 'review-feedback-implementation-correlation-missing');
    }
    const feedbackProjection = activeBatch && directReview
      ? projectReviewFeedbackBatch(activeBatch, directReview.targetRevision)
      : undefined;
    const phaseFacts = qualification
      ? [deniedPathsBaseline]
      : [
        deniedPathsBaseline,
        sha256(canonicalJson(resolveIssueCheckPolicy(active.record.issueSnapshot.body, active.config.checks).checks)),
        canonicalJson(active.record.checkQualification?.checks ?? []),
      ];
    const invocationState = this.mutableInvocationState(() => active, (next) => { active = next; });
    let settled: { kind: 'settled' } | { kind: 'safe-halt'; code: string };
    try {
      settled = await this.dependencies.implementationAgent.settle({
        operation: invocation.operation,
        runId: active.record.runId,
        worktreePath: active.record.worktreePath,
        issue: publicIssueSnapshot(active.record.issueSnapshot),
        frozenCriteria: active.record.frozenCriteria,
        cycle: qualification ? active.record.checkQualification!.repairAttempts + 1 : active.record.cycle,
        reworkFindings: repairFindings ?? [],
        repairOnly: invocation.context.repairOnly,
        workflowGeneration: active.record.workflowGeneration,
        ...(feedbackProjection ? {
          reviewFeedbackRound: active.record.reviewFeedback!.repairRound,
          reviewFeedback: feedbackProjection.workerFeedback,
        } : {}),
        phaseFacts,
        invocationState,
        signal: this.signal,
      });
    } catch {
      return this.invokedFailure(active, 'mutable-operation-terminal-settlement-failed');
    }
    return settled.kind === 'settled'
      ? { active }
      : this.invokedFailure(active, settled.code, 'Mutable invocation remains fenced before terminal reconciliation.');
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
    const existing = active.record.intent;
    if (!existing) {
      active = await this.persist(active, { intent: {
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
      return this.invokedFailure(active, 'blocked-labels-intent-diverged');
    } else {
      expected = existing.expected;
      if (!sameStrings(expected, autoBlocked) && !sameStrings(expected, blockedOnly) && expected.length !== 0) {
        return this.invokedFailure(active, 'blocked-labels-intent-diverged');
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
        await this.markV3ExternalEffect(active);
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
        const intent = active.record.intent;
        if (intent?.kind !== 'blocked-labels') return this.invokedFailure(active, 'blocked-labels-intent-diverged');
        try {
          active = await this.persist(active, { intent: { ...intent, expected } });
        } catch {
          throw new PostEffectStateError(active);
        }
      }
    }
    try {
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
      await this.markV3ExternalEffect(active);
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
  ): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code: evidenceCode, summary: outcome.status });
    const terminalOutcome = { ...outcome, evidencePath: evidence.path } as RunTerminalOutcome;
    const changes: Partial<RunRecordV1> & { intent?: PublicationIntent | undefined } = {
      lifecycle: outcome.status,
      terminalOutcome,
      outcomeEvidenceId: evidence.id,
      process: undefined,
      reportInvocation: undefined,
    };
    if (active.record.reportInvocation?.operation === 'code-review') changes.executionLease = undefined;
    if (outcome.status !== 'review-ready' && active.record.directReview && active.record.directReview.status !== 'terminal') {
      changes.directReview = projectTerminalDirectReview(active.record.directReview, outcome.status === 'blocked'
        ? { status: 'blocked', kind: outcome.kind }
        : { status: outcome.status }, outcome.status === 'internal-error' ? outcome.code : undefined);
    }
    if (active.record.waitingHuman && (active.record.lifecycle === 'waiting-human' || active.record.waitingHuman.phase === 'resumed')) {
      if (active.record.waitingHuman.phase === 'resumed') {
        changes.waitingHuman = {
          version: 1,
          clarificationAttempts: active.record.waitingHuman.clarificationAttempts,
          permissionRetries: active.record.waitingHuman.permissionRetries,
          effectRetries: structuredClone(active.record.waitingHuman.effectRetries),
          history: structuredClone(active.record.waitingHuman.history),
          phase: 'history-only',
          terminalOutcome: outcome.status === 'blocked'
            ? { status: 'blocked', kind: outcome.kind }
            : { status: outcome.status },
        } as WaitingHumanExecutionV1;
      } else if (outcome.status === 'blocked' || outcome.status === 'cancelled') {
      changes.waitingHuman = archiveWaiting(active.record, waitingAnswer(active.record.waitingHuman), {
        phase: 'history-only',
        terminalOutcome: outcome.status === 'cancelled'
          ? { status: 'cancelled' }
          : { status: 'blocked', kind: outcome.kind },
      });
      }
    }
    if (active.record.lifecycle === 'triaging') {
      changes.routeExecution = undefined;
      changes.routeReceipt = undefined;
    }
    if (!retainIntent) changes.intent = undefined;
    await this.persist(active, changes);
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

class PostEffectStateError extends Error {
  constructor(readonly active: ActiveRun) {
    super('post-effect state write failed');
  }
}

const claimMarkerPattern = /^<!-- codex-orchestrator:run:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):claim -->$/u;

function isClaimMarkerComment(comment: { body: string }): boolean {
  return claimMarkerPattern.test(comment.body.split('\n')[0] ?? '');
}

function claimRunId(comment: { body: string }): string | undefined {
  return (comment.body.split('\n')[0] ?? '').match(claimMarkerPattern)?.[1];
}

function trustedHistoricalClaimBodyKey(
  comment: { body: string; authorAssociation: string },
  issueNumber: number,
  branchName: string,
): string | undefined {
  const runId = claimRunId(comment);
  if (!runId || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.authorAssociation)) return undefined;
  if (comment.body !== claimComment(runId, issueNumber, branchName)) return undefined;
  return `${comment.authorAssociation}\u0000${comment.body}`;
}

function frozenHistoricalClaimKey(
  comment: { id?: string; body: string; authorAssociation: string },
  issueNumber: number,
  branchName: string,
): string | undefined {
  const bodyKey = trustedHistoricalClaimBodyKey(comment, issueNumber, branchName);
  if (!bodyKey) return undefined;
  return comment.id ? `id\u0000${comment.id}\u0000${bodyKey}` : `legacy\u0000${bodyKey}`;
}

function observedHistoricalClaimKeys(
  comment: RunIssueSnapshot['comments'][number],
  record: RunRecordV1,
): string[] {
  const bodyKey = trustedHistoricalClaimBodyKey(comment, record.issueNumber, record.branchName);
  if (!bodyKey) return [];
  const keys = comment.id ? [`id\u0000${comment.id}\u0000${bodyKey}`] : [];
  if (timestampAtOrBefore(comment.createdAt, record.createdAt)
    && timestampAtOrBefore(comment.updatedAt, record.createdAt)) {
    keys.push(`legacy\u0000${bodyKey}`);
  }
  return keys;
}

function timestampAtOrBefore(value: string | undefined, cutoff: string): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && timestamp <= Date.parse(cutoff);
}

function historicalClaimCounts(record: RunRecordV1): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of record.issueSnapshot.comments ?? []) {
    const key = frozenHistoricalClaimKey(comment, record.issueNumber, record.branchName);
    if (!key || claimRunId(comment) === record.runId) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function refreshClaimedIssueSnapshot(
  baseline: RunRecordV1['issueSnapshot'],
  issue: RunIssueSnapshot,
): RunRecordV1['issueSnapshot'] {
  return {
    ...structuredClone(baseline),
    comments: [
      ...(baseline.comments ?? []).filter(isClaimMarkerComment),
      ...issue.comments.filter((comment) => !isClaimMarkerComment(comment)),
    ],
  };
}

function snapshotIssue(issue: RunIssueSnapshot): IssueSnapshot & Pick<RunIssueSnapshot, 'comments'> {
  if (issue.state !== 'OPEN') throw new Error('cannot snapshot a closed issue');
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: 'OPEN',
    labels: sortedUnique(issue.labels),
    comments: structuredClone(issue.comments),
  };
}

function publicIssueSnapshot(issue: IssueSnapshot): IssueSnapshot {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state,
    labels: [...issue.labels],
  };
}

function freezeCriteria(issue: IssueSnapshot): FrozenCriterion[] {
  const lines = issue.body.split(/\r?\n/u);
  const heading = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/iu.test(line.trim()));
  const texts: string[] = [];
  if (heading >= 0) {
    for (const line of lines.slice(heading + 1)) {
      if (/^#{1,6}\s+/u.test(line.trim())) break;
      const match = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/u);
      const text = match?.[1]?.trim();
      if (text && !texts.includes(text)) texts.push(text);
    }
  }
  if (texts.length === 0) return [{ id: 'fallback-001', order: 1, source: 'fallback', text: `${issue.title}\n\n${issue.body}` }];
  return texts.map((text, index) => ({ id: `ac-${String(index + 1).padStart(3, '0')}`, order: index + 1, source: 'explicit', text }));
}

function claimComment(runId: string, issueNumber: number, branchName: string): string {
  return `<!-- codex-orchestrator:run:${runId}:claim -->\ncodex-orchestrator claimed #${issueNumber} for branch ${branchName}`;
}

function findRun(state: RunStateFileV1, runId: string): RunRecordV1 {
  const record = state.runs.find((candidate) => candidate.runId === runId);
  if (!record) throw new Error('persisted run is missing');
  return record;
}

function waitingAnswer(waiting: WaitingHumanExecutionV1): TrustedAnswerReceiptV1 | null {
  if ('answerReceipt' in waiting) return structuredClone(waiting.answerReceipt);
  if (waiting.phase === 'resumed') return structuredClone(waiting.trustedAnswer);
  return null;
}

function archiveWaiting(
  record: RunRecordV1,
  answer: TrustedAnswerReceiptV1 | null,
  terminal: Pick<Extract<WaitingHumanExecutionV1, { phase: 'resumed' }>, 'phase' | 'trustedAnswer'>
    | Pick<Extract<WaitingHumanExecutionV1, { phase: 'history-only' }>, 'phase' | 'terminalOutcome'>,
): WaitingHumanExecutionV1 {
  const waiting = record.waitingHuman;
  const routeReceipt = record.routeReceipt;
  if (!waiting || !routeReceipt) throw new Error('waiting archive requires active route evidence');
  const question = 'question' in waiting ? waiting.question : 'questionReceipt' in waiting ? waiting.questionReceipt.question : undefined;
  if (!question) throw new Error('waiting archive requires current question');
  const questionReceipt = 'questionReceipt' in waiting ? waiting.questionReceipt : null;
  const entry = {
    routeReceipt: structuredClone(routeReceipt),
    question: structuredClone(question),
    questionReceipt: questionReceipt ? structuredClone(questionReceipt) : null,
    answerReceipt: answer ? structuredClone(answer) : null,
    conflictHashes: [...question.conflictHashes],
  };
  const history = [...waiting.history];
  if (history.at(-1)?.question.questionSha256 === question.questionSha256) {
    if (canonicalJson(history.at(-1)) !== canonicalJson(entry)) throw new Error('waiting archive evidence mismatch');
  } else {
    history.push(entry);
  }
  return {
    version: 1,
    clarificationAttempts: waiting.clarificationAttempts,
    permissionRetries: waiting.permissionRetries,
    effectRetries: structuredClone(waiting.effectRetries),
    history,
    ...terminal,
  } as WaitingHumanExecutionV1;
}

function terminalWaiting(
  waiting: WaitingHumanExecutionV1,
  terminalOutcome: Extract<WaitingHumanExecutionV1, { phase: 'history-only' }>['terminalOutcome'],
): WaitingHumanExecutionV1 {
  if (waiting.phase !== 'resumed' && waiting.phase !== 'history-only') throw new Error('terminal waiting projection requires archived history');
  return {
    version: 1,
    clarificationAttempts: waiting.clarificationAttempts,
    permissionRetries: waiting.permissionRetries,
    effectRetries: structuredClone(waiting.effectRetries),
    history: structuredClone(waiting.history),
    phase: 'history-only',
    terminalOutcome,
  };
}

function publicOutcome(outcome: RunTerminalOutcome): Exclude<RunIssueResult, { status: 'not-eligible' }> {
  if (outcome.status === 'internal-error') return { status: 'internal-error', evidencePath: outcome.evidencePath };
  return structuredClone(outcome);
}

function requireRouteExecution(value: RouteExecutionV1 | undefined): RouteExecutionV1 {
  if (!value) throw new Error('route execution is missing');
  return structuredClone(value);
}

function sameRouteExecution(left: RouteExecutionV1 | undefined, right: RouteExecutionV1): boolean {
  return left !== undefined && canonicalJson(left) === canonicalJson(right);
}

function sameStrings(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function blockedLabelPolicy(config: AgentAutoConfig): {
  auto: string;
  running: string;
  blocked: string;
  review: string;
  waitingHuman: string;
} {
  return {
    auto: config.github.labels.auto.name,
    running: config.github.labels.running.name,
    blocked: config.github.labels.blocked.name,
    review: config.github.labels.review.name,
    waitingHuman: config.github.labels.waitingHuman.name,
  };
}

function blockedLabelProjection(
  labels: string[],
  config: AgentAutoConfig,
): { status: 'settled'; expected: string[] } | { status: 'transition' | 'diverged' } {
  const policy = blockedLabelPolicy(config);
  const present = new Set(labels);
  if (present.has(policy.review) || present.has(policy.waitingHuman)) return { status: 'diverged' };
  const auto = present.has(policy.auto);
  const running = present.has(policy.running);
  const blocked = present.has(policy.blocked);
  if (running || (auto && !blocked)) return { status: 'transition' };
  if (blocked) return { status: 'settled', expected: auto ? [policy.auto, policy.blocked].sort() : [policy.blocked] };
  return { status: 'settled', expected: [] };
}

function sameCheckPolicy(checks: RunRecordV1['checks'], policy: Record<string, string>): boolean {
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

function expectedImplementationHead(record: RunRecordV1): string {
  return record.reviewFeedback?.activeBatch?.priorPublishedHeadSha ?? record.baseSha;
}

function pendingCandidateBoundary(record: RunRecordV1): CandidateBoundaryV2 | undefined {
  if (record.lifecycle !== 'implementing') return undefined;
  const feedback = record.reviewFeedback;
  if (feedback?.activeBatch && feedback.repairRound >= 1 && feedback.repairRound <= 3) {
    return {
      kind: 'review-feedback',
      batchId: feedback.activeBatch.batchId,
      repairRound: feedback.repairRound as 1 | 2 | 3,
    };
  }
  if (record.mutableInvocation?.operation === 'qualification-repair' && record.checkQualification) {
    return {
      kind: 'qualification',
      repairAttempt: record.checkQualification.repairAttempts as 0 | 1 | 2 | 3 | 4 | 5,
    };
  }
  return { kind: 'implementation-cycle', cycle: record.cycle };
}

function commentsWithMarker(issue: RunIssueSnapshot, marker: string): Array<{ body: string; authorAssociation: string }> {
  return issue.comments.filter((comment) => comment.body.split('\n')[0] === marker);
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
