import { resolve } from 'node:path';

import {
  checkedChangePayloadSha256,
  type CheckedChange,
  type CheckedChangeFreshness,
  type CheckedChangeMintCapability,
  type CheckedChangePayloadV1,
} from './checked-change.js';
import { parseAgentAutoConfig, type AgentAutoConfig } from './config.js';
import { canonicalJson, sha256 } from './containment.js';
import { validateImplementationReport } from './implementation-report.js';
import {
  acceptApprovedDirectReview,
  acceptNeedsWorkDirectReview,
  beginDirectReviewRepair,
  createInitialDirectReview,
  directReviewClosureRequestSha256,
  directReviewTargetFingerprint,
  launchDirectReviewInvocation,
  prepareDirectReviewClosure,
  prepareDirectReviewInvocation,
  projectTerminalDirectReview,
} from './direct-delivery.js';
import type { ImplementationReviewerInput, ImplementationReviewerResult } from './implementation-reviewer.js';
import { ProofQuiescenceError, type FrozenCriterion, type IssueSnapshot, type ProveChangeResult } from './acceptance-proof.js';
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
import type { FrozenSpecReceiptV1 } from './spec-delivery.js';
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

export type RunIssueResult =
  | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string }
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
  comments: Array<{ body: string; authorAssociation: string }>;
}

export interface RunIssueGit {
  getBaseSha(input: { targetRoot: string; baseBranch: string }): Promise<string>;
  createWorktree(input: { targetRoot: string; worktreePath: string; branchName: string; baseBranch: string; baseSha: string }): Promise<void>;
  inspectWorktree(input: { worktreePath: string; branchName: string; baseSha: string }): Promise<'absent' | 'matching' | 'diverged'>;
  snapshot(worktreePath: string): Promise<Omit<CheckedChangeFreshness, 'checkPolicySha256'>>;
  fingerprintDeniedPaths(worktreePath: string, deniedPaths: string[]): Promise<string>;
  listChangedFiles(worktreePath: string): Promise<string[]>;
  fingerprintChangedFiles(worktreePath: string, changedFiles: string[]): Promise<string>;
  stageAll(worktreePath: string): Promise<void>;
  getTreeSha(worktreePath: string): Promise<string>;
  getHead(worktreePath: string): Promise<string>;
  inspectHead(worktreePath: string): Promise<{ sha: string; parentSha: string; treeSha: string; message: string }>;
  getRemoteBranchSha(worktreePath: string, branchName: string): Promise<string | undefined>;
  commit(input: { worktreePath: string; message: string }): Promise<string>;
  push(input: { worktreePath: string; branchName: string }): Promise<void>;
}

type InterruptedProcess = Omit<NonNullable<RunRecordV1['process']>, 'purpose' | 'resumeLifecycle' | 'resumeReviewStage'>;

export type ImplementationAgentResult =
  | { kind: 'completed'; report: unknown; attemptId?: string }
  | { kind: 'transport-failed'; resumable: boolean }
  | { kind: 'cancelled' }
  | { kind: 'internal-error' }
  | { kind: 'safe-halt'; process: InterruptedProcess; waitForAbsence(): Promise<void> };

export interface RunIssueDependencies {
  readConfig(targetRoot: string): Promise<{ bytes: Buffer; config: AgentAutoConfig }>;
  validateContainment(config: AgentAutoConfig): Promise<void>;
  ownerLock: {
    acquire(input: { canonicalRepository: string; targetRoot: string }): Promise<{ release(): Promise<void> }>;
  };
  issues: {
    read(issueNumber: number): Promise<RunIssueSnapshot | undefined>;
    setLabels(issueNumber: number, labels: string[]): Promise<void>;
    postComment(issueNumber: number, body: string): Promise<void>;
  };
  pullRequests: {
    findOpen(input: { headBranch: string; baseBranch: string }): Promise<{ url: string; body: string } | undefined>;
    createDraft(input: { title: string; body: string; headBranch: string; baseBranch: string }): Promise<{ url: string }>;
  };
  git: RunIssueGit;
  implementationAgent: {
    run(input: {
      runId: string;
      worktreePath: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      cycle: number;
      reworkFindings: string[];
      repairOnly: boolean;
      workflowGeneration: WorkflowGenerationReceipt;
      signal: AbortSignal;
    }): Promise<ImplementationAgentResult>;
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
    run(input: { id: string; command: string; cwd: string; signal: AbortSignal }): Promise<{ status: 'passed' | 'failed'; output: Buffer }>;
  };
  proof: {
    proveChange(input: {
      proofId: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      checkedChange: CheckedChange;
      workflowGeneration: WorkflowGenerationReceipt;
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

export class OwnerLockSafetyError extends Error {}
export class OwnerLockContentionError extends Error {}

interface ActiveRun {
  state: RunStateFileV1;
  record: RunRecordV1;
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
    if (active.record.intent?.kind === 'claim-labels') {
      if (!sameStrings(observation.labels, expectedLabels)) {
        const labels = new Set(observation.labels);
        if (!labels.has(config.github.labels.auto.name)
          || labels.has(config.github.labels.blocked.name)
          || labels.has(config.github.labels.review.name)) {
          return { result: await this.publicationDiverged(active, 'claim-labels-diverged') };
        }
        try { await this.dependencies.issues.setLabels(issueNumber, expectedLabels); }
        catch { return { result: await this.invokedFailure(active, 'claim-labels-delivery-unknown') }; }
        observation = await this.readIssue(issueNumber);
      }
      if (!observation || !sameStrings(observation.labels, expectedLabels)) {
        return { result: await this.publicationDiverged(active, 'claim-labels-observation-diverged') };
      }
      active = await this.confirmEffect(active);
    } else if (!sameStrings(observation.labels, expectedLabels)) {
      return { result: await this.publicationDiverged(active, 'claim-labels-missing-before-comment') };
    }

    const body = claimComment(runId, issueNumber, branchName);
    const marker = body.split('\n')[0]!;
    if (!active.record.intent) {
      active = await this.persist(active, { intent: { kind: 'comment', issueNumber, marker, bodySha256: sha256(body) } });
    }
    if (active.record.intent?.kind !== 'comment' || active.record.intent.marker !== marker || active.record.intent.bodySha256 !== sha256(body)) {
      return { result: await this.publicationDiverged(active, 'claim-comment-intent-diverged') };
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
    if (active.record.intent?.kind === 'commit' || !active.record.intent) {
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
          if (!await this.authorized(issueNumber, runId, branchName, config)) return await this.revoked(active);
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
        if (!await this.authorized(issueNumber, runId, branchName, config)) return await this.revoked(active);
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
        if (!await this.authorized(issueNumber, runId, branchName, config)) return await this.revoked(active);
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
        if (!await this.authorized(issueNumber, runId, branchName, config)) return await this.revoked(active);
        try { await this.dependencies.issues.postComment(issueNumber, handoffBody); }
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
        if (!await this.authorized(issueNumber, runId, branchName, config)) return await this.revoked(active);
        try { await this.dependencies.issues.setLabels(issueNumber, terminalLabels); }
        catch { return await this.invokedFailure(active, 'terminal-labels-delivery-unknown'); }
        observation = await this.readIssue(issueNumber);
      }
      if (!observation || !sameStrings(observation.labels, terminalLabels)) return await this.publicationDiverged(active, 'terminal-labels-diverged');
    }

    const evidence = await this.dependencies.writeEvidence({ runId, code: 'review-ready', summary: pullRequest.url });
    const outcome: RunTerminalOutcome = { status: 'review-ready', pullRequestUrl: pullRequest.url, evidencePath: evidence.path };
    try {
      await this.persist(active, {
        lifecycle: 'review-ready', intent: undefined, outcomeEvidenceId: evidence.id, terminalOutcome: outcome,
        ...(active.record.waitingHuman ? { waitingHuman: terminalWaiting(active.record.waitingHuman, { status: 'review-ready' }) } : {}),
      });
    } catch { throw new PostEffectStateError(active); }
    return outcome;
  }

  private publicationDiverged(active: ActiveRun, code: string): Promise<RunIssueResult> {
    return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, code);
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
      try {
        await this.dependencies.validateContainment(config);
      } catch {
        const evidence = await this.dependencies.writeEvidence({
          runId: `issue-${input.issueNumber}`,
          code: 'containment-certificate-invalid',
          summary: 'Containment certification is unavailable or stale.',
        });
        return { status: 'blocked', kind: 'safety', resumable: true, evidencePath: evidence.path };
      }
      if (this.signal.aborted) return await this.preClaimCancelled(input.issueNumber);

      let issue: RunIssueSnapshot | undefined;
      try {
        issue = await this.dependencies.issues.read(input.issueNumber);
      } catch {
        return await this.preClaimTransport(input.issueNumber);
      }
      const persisted = await this.dependencies.runRecords.read();
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
        if (existing.terminalOutcome) return publicOutcome(existing.terminalOutcome);
        active = { state: persisted, record: existing };
        issueSnapshot = structuredClone(existing.issueSnapshot);
        frozenCriteria = structuredClone(existing.frozenCriteria);
        runId = existing.runId;
        branchName = existing.branchName;
        worktreePath = existing.worktreePath;
        baseSha = existing.baseSha;
        if (existing.lifecycle === 'publishing') {
          return await this.publish(active, config, issueSnapshot, input.issueNumber);
        }
        if (existing.lifecycle === 'claimed') {
          const claim = await this.reconcileClaim(active, config);
          if ('result' in claim) return claim.result;
          active = claim.active;
          const worktree = await this.dependencies.git.inspectWorktree({ worktreePath, branchName, baseSha });
          if (worktree === 'diverged') return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'claim-worktree-diverged');
          if (worktree === 'absent') {
            try { await this.dependencies.git.createWorktree({ targetRoot, worktreePath, branchName, baseBranch: config.github.baseBranch, baseSha }); }
            catch { return await this.terminal(active, { status: 'internal-error', code: 'local-git-effect-failed' }); }
          }
          active = await this.initializeClaimedRun(active, issue);
          issueSnapshot = structuredClone(active.record.issueSnapshot);
        } else {
          if (existing.lifecycle === 'safe-halt') {
            const process = existing.process;
            if (!process) return await this.publicationDiverged(active, 'safe-halt-process-missing');
            try { await this.dependencies.waitForReviewProcessAbsence(process.processGroupId); }
            catch { return await this.invokedFailure(active, 'safe-halt-process-absence-unconfirmed'); }
            active = await this.persist(active, { lifecycle: process.resumeLifecycle, process: undefined });
          }
          if (existing.lifecycle === 'waiting-human') {
            const waiting = await this.continueWaitingHuman(active);
            if ('result' in waiting) return waiting.result;
            active = waiting.active;
            issueSnapshot = structuredClone(active.record.issueSnapshot);
            frozenCriteria = structuredClone(active.record.frozenCriteria);
          }
          if (existing.lifecycle === 'spec-authoring') {
            if (!await this.authorized(input.issueNumber, runId, branchName, config)) return await this.revoked(active);
            return await this.continueSpecRequired(active);
          }
          if (!['triaging', 'routed', 'implementing', 'reworking', 'checking', 'proving'].includes(active.record.lifecycle)) {
            return await this.terminal(active, { status: 'internal-error', code: 'resume-phase-not-reconciled' });
          }
          if (!await this.authorized(input.issueNumber, runId, branchName, config)) return await this.revoked(active);
          if (active.record.lifecycle !== 'triaging' && active.record.lifecycle !== 'routed') {
            if (!active.record.routeExecution || !active.record.routeReceipt) throw new RouteInitializationUnrecoverableError();
            const reviewRecovery = active.record.lifecycle === 'implementing' && active.record.directReview?.status === 'active'
              && (active.record.directReview.stage === 'review-full' || active.record.directReview.stage === 'review-closure');
            const checkRecovery = active.record.lifecycle === 'checking'
              && active.record.directReview?.status === 'clear';
            if (!reviewRecovery && !checkRecovery) {
              if (active.record.cycle >= config.runner.maxCycles) {
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
        baseSha = await this.dependencies.git.getBaseSha({ targetRoot, baseBranch: config.github.baseBranch });
        assertGitSha(baseSha, 'baseSha');
        const runningLabels = sortedUnique([config.github.labels.auto.name, config.github.labels.running.name]);
        active = await this.createRun({
          runId, issueNumber: input.issueNumber, canonicalRepository, baseSha, branchName, worktreePath,
          issueSnapshot, frozenCriteria,
          intent: { kind: 'claim-labels', issueNumber: input.issueNumber, expected: runningLabels },
        });
        const claim = await this.reconcileClaim(active, config);
        if ('result' in claim) return claim.result;
        active = claim.active;
        try { await this.dependencies.git.createWorktree({ targetRoot, worktreePath, branchName, baseBranch: config.github.baseBranch, baseSha }); }
        catch { return await this.terminal(active, { status: 'internal-error', code: 'local-git-effect-failed' }); }
        active = await this.initializeClaimedRun(active, issue);
        issueSnapshot = structuredClone(active.record.issueSnapshot);
      }
      if (active.record.lifecycle === 'triaging' || active.record.lifecycle === 'routed') {
        const routed = await this.routeRun(active, issueSnapshot, frozenCriteria, worktreePath, config, input.issueNumber, branchName);
        if ('result' in routed) return routed.result;
        active = routed.active;
      }
      if (active.record.lifecycle !== 'implementing' && active.record.lifecycle !== 'checking') {
        return await this.terminal(active, { status: 'internal-error', code: 'route-dispatch-not-implementing' });
      }
      if (active.record.lifecycle === 'checking' && !active.record.directReview && active.record.routeReceipt?.route === 'direct') {
        return await this.terminal(active, { status: 'internal-error', code: 'direct-review-state-missing' });
      }
      attemptLoop: while (true) {
      if (!await this.authorized(input.issueNumber, runId, branchName, config)) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }
      if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });

      let resumeAtChecks = active.record.lifecycle === 'checking'
        && active.record.directReview?.status === 'clear';
      if (active.record.lifecycle === 'implementing'
        && active.record.directReview?.status === 'active'
        && (active.record.directReview.stage === 'review-full' || active.record.directReview.stage === 'review-closure')) {
        const recovered = await this.recoverDirectReviewInvocation(active);
        if ('status' in recovered) return recovered;
        active = recovered;
        const reviewed = await this.runDirectReviewFull(
          active,
          publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          `recovered-implementation-cycle-${active.record.cycle}`,
          config.runner.maxCycles,
        );
        if ('status' in reviewed) return reviewed;
        active = reviewed;
        if (active.record.lifecycle === 'implementing') continue attemptLoop;
        resumeAtChecks = true;
      }

      if (!resumeAtChecks) {
      const deniedPathsBaseline = await this.dependencies.git.fingerprintDeniedPaths(worktreePath, config.deny.readPaths);
      let implementation = await this.runImplementation({
        runId,
        worktreePath,
        issue: publicIssueSnapshot(issueSnapshot),
        frozenCriteria,
        cycle: active.record.cycle,
        reworkFindings: active.record.reworkFindings,
        repairOnly: false,
        workflowGeneration: active.record.workflowGeneration,
      });
      if (implementation.kind === 'safe-halt') {
        active = await this.persist(active, {
          lifecycle: 'safe-halt',
          process: {
            ...implementation.process,
            purpose: 'implementation',
            resumeLifecycle: 'implementing',
            resumeReviewStage: null,
          },
        });
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
        active = await this.persist(active, { reportRepairs: 1 });
        implementation = await this.runImplementation({
          runId,
          worktreePath,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          cycle: active.record.cycle,
          reworkFindings: ['The previous implementation report did not match the generated schema.'],
          repairOnly: true,
          workflowGeneration: active.record.workflowGeneration,
        });
        if (implementation.kind === 'safe-halt') {
          active = await this.persist(active, {
            lifecycle: 'safe-halt',
            process: {
              ...implementation.process,
              purpose: 'implementation',
              resumeLifecycle: 'implementing',
              resumeReviewStage: null,
            },
          });
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
      if (await this.dependencies.git.getHead(worktreePath) !== baseSha) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }
      const changedFiles = await this.dependencies.git.listChangedFiles(worktreePath);
      if (changedFiles.length === 0 || !sameStrings(changedFiles, report.changedFiles)) {
        if (changedFiles.length === 0 || active.record.reportRepairs >= 1) {
          return await this.terminal(active, { status: 'internal-error', code: 'implementation-change-set-invalid' });
        }
        const repairBaseline = await this.dependencies.git.snapshot(worktreePath);
        active = await this.persist(active, { reportRepairs: 1 });
        implementation = await this.runImplementation({
          runId,
          worktreePath,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          cycle: active.record.cycle,
          reworkFindings: [`The report changedFiles must equal the complete current product change set: ${canonicalJson(changedFiles)}.`],
          repairOnly: true,
          workflowGeneration: active.record.workflowGeneration,
        });
        if (implementation.kind === 'safe-halt') {
          active = await this.persist(active, {
            lifecycle: 'safe-halt',
            process: {
              ...implementation.process,
              purpose: 'implementation',
              resumeLifecycle: 'implementing',
              resumeReviewStage: null,
            },
          });
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

      if (active.record.routeReceipt?.route === 'direct') {
        const targetFingerprint = directReviewTargetFingerprint({
          snapshot: await this.dependencies.git.snapshot(worktreePath),
          changedFiles,
          routeDecisionSha256: active.record.routeReceipt.decisionSha256,
          workflowGenerationHash: active.record.workflowGeneration.generationHash,
          cycle: active.record.cycle,
          frozenCriteria,
        });
        if (active.record.directReview?.stage === 'review-repair') {
          active = await this.persist(active, {
            directReview: prepareDirectReviewClosure(active.record.directReview, targetFingerprint).state,
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
        );
        if ('status' in reviewed) return reviewed;
        active = reviewed;
        if (active.record.lifecycle === 'implementing') continue attemptLoop;
      } else {
        active = await this.persist(active, { lifecycle: 'checking' });
      }
      }
      for (const [id, command] of Object.entries(config.checks)) {
        if (active.record.checks.some((check) => check.id === id && check.status === 'passed')) continue;
        if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
        let check;
        try {
          check = await this.dependencies.checks.run({ id, command, cwd: worktreePath, signal: this.signal });
        } catch {
          return await this.terminal(active, { status: 'internal-error', code: 'configured-check-execution-failed' });
        }
        if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
        const row = { id, command, status: check.status, outputSha256: sha256(check.output) } as const;
        active = await this.persist(active, { checks: [...active.record.checks, row] });
        if (check.status !== 'passed') {
          if (active.record.cycle >= config.runner.maxCycles) {
            return await this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true });
          }
          const summary = `Check ${id} failed:\n${check.output.toString('utf8').slice(0, 8 * 1024)}`;
          active = await this.startNextCycle(active, [summary], [{
            provenance: 'check', sourceId: `check:${id}:${row.outputSha256}`, summary,
            affectedContracts: ['configured-checks'],
          }]);
          continue attemptLoop;
        }
      }

      let reviewedStageBinding: { files: string[]; contentSha256: string } | undefined;
      try {
        const reviewedFiles = await this.dependencies.git.listChangedFiles(worktreePath);
        const reviewedContentSha256 = await this.dependencies.git.fingerprintChangedFiles(worktreePath, reviewedFiles);
        reviewedStageBinding = { files: reviewedFiles, contentSha256: reviewedContentSha256 };
        if (active.record.directReview?.status === 'clear') {
          const currentFingerprint = directReviewTargetFingerprint({
            snapshot: await this.dependencies.git.snapshot(worktreePath),
            changedFiles: await this.dependencies.git.listChangedFiles(worktreePath),
            routeDecisionSha256: active.record.routeReceipt!.decisionSha256,
            workflowGenerationHash: active.record.workflowGeneration.generationHash,
            cycle: active.record.cycle,
            frozenCriteria,
          });
          if (currentFingerprint !== active.record.directReview.targetFingerprint) {
            return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'direct-review-target-drift');
          }
        }
        await this.dependencies.git.stageAll(worktreePath);
        const stagedFiles = await this.dependencies.git.listChangedFiles(worktreePath);
        const stagedContentSha256 = await this.dependencies.git.fingerprintChangedFiles(worktreePath, stagedFiles);
        if (!sameStrings(reviewedFiles, stagedFiles) || reviewedContentSha256 !== stagedContentSha256) {
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'post-stage-review-binding-drift');
        }
      } catch {
        return await this.terminal(active, { status: 'internal-error', code: 'local-git-effect-failed' });
      }
      if (await this.dependencies.git.getHead(worktreePath) !== baseSha) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }
      const proofChangedFiles = await this.dependencies.git.listChangedFiles(worktreePath);
      const freshness = await this.dependencies.git.snapshot(worktreePath);
      const proofContentSha256 = await this.dependencies.git.fingerprintChangedFiles(worktreePath, proofChangedFiles);
      if (!reviewedStageBinding || !sameStrings(reviewedStageBinding.files, proofChangedFiles)
        || reviewedStageBinding.contentSha256 !== proofContentSha256) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'checked-change-review-binding-drift');
      }
      const payload: CheckedChangePayloadV1 = {
        version: 1,
        canonicalRepository,
        runId,
        issueNumber: input.issueNumber,
        cycle: active.record.cycle,
        baseSha,
        headSha: freshness.headSha,
        indexTreeSha: freshness.indexTreeSha,
        trackedContentSha256: freshness.trackedContentSha256,
        untrackedContentSha256: freshness.untrackedContentSha256,
        worktreeIdentity: freshness.worktreeIdentity,
        changedFiles: proofChangedFiles,
        checks: active.record.checks.map((check) => ({ ...check, status: 'passed' as const })),
        checkPolicySha256: sha256(canonicalJson(config.checks)),
        packageVersion: active.record.packageVersion,
        proofSchemaVersion: 1,
      };
      const checkedChange = this.dependencies.checkedChangeMint.mint(payload);
      const checkedChangeSha256 = checkedChangePayloadSha256(payload);
      const proofId = this.dependencies.createProofId();
      assertNonEmptyString(proofId, 'proofId');
      active = await this.persist(active, { lifecycle: 'proving', checkedChangeSha256, proofId });

      let proof: ProveChangeResult;
      try {
        proof = await this.dependencies.proof.proveChange({
          proofId,
          issue: publicIssueSnapshot(issueSnapshot),
          frozenCriteria,
          checkedChange,
          workflowGeneration: structuredClone(active.record.workflowGeneration),
        });
      } catch (error) {
        if (error instanceof ProofQuiescenceError) {
          active = await this.persist(active, {
            lifecycle: 'safe-halt',
            process: {
              pid: error.pid,
              processGroupId: error.processGroupId,
              startedAt: this.timestamp(),
              baseline: {
                headSha: freshness.headSha,
                indexTreeSha: freshness.indexTreeSha,
                trackedContentSha256: freshness.trackedContentSha256,
                untrackedContentSha256: freshness.untrackedContentSha256,
                worktreeIdentity: freshness.worktreeIdentity,
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
        return await this.terminal(active, { status: 'internal-error', code: 'acceptance-proof-internal-failure' });
      }
      if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });
      if (proof.status === 'needs-rework') {
        if (active.record.cycle >= config.runner.maxCycles) {
          return await this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true });
        }
        active = await this.startNextCycle(active, proof.findings, proof.findings.map((summary) => ({
          provenance: 'proof' as const,
          sourceId: `proof:${proofId}:${sha256(summary)}`,
          summary,
          affectedContracts: ['acceptance-proof'],
        })));
        continue attemptLoop;
      }
      if (proof.status !== 'passed') return await this.mapProofFailure(active, proof);
      active = await this.persist(active, { lifecycle: 'publishing', proofReceipt: proof.receipt, reworkFindings: [] });
      break;
      }

      return await this.publish(active, config, issueSnapshot, input.issueNumber);
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
    const issueSnapshot = issue?.state === 'OPEN' ? snapshotIssue(issue) : active.record.issueSnapshot;
    return this.persist(active, { lifecycle: 'triaging', routeExecution: initialRouteExecution(), issueSnapshot });
  }

  private async routeRun(
    starting: ActiveRun,
    issue: IssueSnapshot,
    frozenCriteria: FrozenCriterion[],
    worktreePath: string,
    config: AgentAutoConfig,
    issueNumber: number,
    branchName: string,
  ): Promise<{ active: ActiveRun } | { result: RunIssueResult }> {
    let active = starting;
    while (active.record.lifecycle === 'triaging') {
      const state: RouteCoordinatorState = {
        read: async () => requireRouteExecution(active.record.routeExecution),
        compareAndSwap: async (expected, next) => {
          if (!sameRouteExecution(active.record.routeExecution, expected)) return false;
          active = await this.persist(active, { routeExecution: structuredClone(next) });
          return true;
        },
        complete: async (expected, next, receipt) => {
          if (!sameRouteExecution(active.record.routeExecution, expected)) return false;
          active = await this.persist(active, {
            lifecycle: 'routed',
            routeExecution: structuredClone(next),
            routeReceipt: structuredClone(receipt),
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
            ...(active.record.waitingHuman ? { waitingHuman: terminalWaiting(active.record.waitingHuman, { status: 'cancelled' }) } : {}),
          });
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
      if (result.status === 'repairable' || result.status === 'retryable') continue;
      if (result.status === 'safe-halt') {
        active = await this.persist(active, {
          lifecycle: 'safe-halt',
          process: {
            ...result.process,
            purpose: 'route',
            resumeLifecycle: 'triaging',
            resumeReviewStage: null,
          },
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
      if (!await this.authorized(issueNumber, active.record.runId, branchName, config)) {
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
      if (!await this.authorized(issueNumber, active.record.runId, branchName, config)) {
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
    if (continuation.status === 'retryable') {
      return { result: await this.terminal(active, { status: 'transport-failed', resumable: true }, continuation.code) };
    }
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
    if (result.status === 'retryable') return await this.terminal(current, { status: 'transport-failed', resumable: true }, result.code);
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
    intent: PublicationIntent;
  }): Promise<ActiveRun> {
    const state = await this.dependencies.runRecords.read();
    const now = this.timestamp();
    const workflow = await this.dependencies.createWorkflowGeneration();
    const record: RunRecordV1 = {
      ...input,
      lifecycle: 'claimed', cycle: 1, reportRepairs: 0, transportRetries: 0,
      reworkFindings: [],
      packageVersion: workflow.receipt.packageVersion,
      workflowGeneration: structuredClone(workflow.receipt),
      skillHashes: structuredClone(workflow.skillHashes),
      checks: [], createdAt: now, updatedAt: now,
    };
    const saved = await this.dependencies.runRecords.compareAndSwap(state.generation, {
      schema: 'codex-orchestrator.agent-auto-state', version: 1, runs: [...state.runs, record],
    });
    return { state: saved, record: findRun(saved, input.runId) };
  }

  private async persist(active: ActiveRun, changes: Partial<RunRecordV1> & { intent?: PublicationIntent | undefined }): Promise<ActiveRun> {
    const record = { ...active.record, ...changes, updatedAt: this.timestamp() } as RunRecordV1;
    if (Object.hasOwn(changes, 'intent') && changes.intent === undefined) delete record.intent;
    if (Object.hasOwn(changes, 'process') && changes.process === undefined) delete record.process;
    for (const key of ['checkedChangeSha256', 'proofId', 'proofReceipt', 'terminalOutcome', 'outcomeEvidenceId', 'routeExecution', 'routeReceipt'] as const) {
      if (Object.hasOwn(changes, key) && changes[key] === undefined) delete record[key];
    }
    const runs = active.state.runs.map((candidate) => candidate.runId === record.runId ? record : candidate);
    const saved = await this.dependencies.runRecords.compareAndSwap(active.state.generation, {
      schema: 'codex-orchestrator.agent-auto-state', version: 1, runs,
    });
    return { state: saved, record: findRun(saved, record.runId) };
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

  private async authorized(issueNumber: number, runId: string, branchName: string, config: AgentAutoConfig): Promise<boolean> {
    const issue = await this.readIssue(issueNumber);
    if (!issue || issue.state !== 'OPEN') return false;
    const labels = new Set(issue.labels);
    if (!labels.has(config.github.labels.auto.name) || !labels.has(config.github.labels.running.name)) return false;
    const exactBody = claimComment(runId, issueNumber, branchName);
    const markerPattern = /^<!-- codex-orchestrator:run:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):claim -->$/u;
    const markers = issue.comments.filter((comment) => markerPattern.test(comment.body.split('\n')[0] ?? ''));
    if (issue.comments.some((comment) => {
      const firstLine = comment.body.split('\n')[0] ?? '';
      return firstLine.startsWith(`<!-- codex-orchestrator:run:${runId}:claim`) && !markerPattern.test(firstLine);
    })) return false;
    if (markers.some((comment) => (comment.body.split('\n')[0] ?? '').match(markerPattern)?.[1] !== runId)) return false;
    const current = markers.filter((comment) => comment.body === exactBody);
    return current.length === 1 && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(current[0]!.authorAssociation);
  }

  private async readIssue(issueNumber: number): Promise<RunIssueSnapshot | undefined> {
    try { return await this.dependencies.issues.read(issueNumber); }
    catch { throw new TransportReadError(); }
  }

  private async runImplementation(input: {
    runId: string;
    worktreePath: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    cycle: number;
    reworkFindings: string[];
    repairOnly: boolean;
    workflowGeneration: WorkflowGenerationReceipt;
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
      const result = await this.dependencies.implementationReviewer.run({
        runId: active.record.runId,
        worktreePath: active.record.worktreePath,
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
        mandatoryCoverage: directReview.stage === 'review-closure'
          ? [...directReview.review.coverage]
          : ['acceptance-criteria', 'correctness', 'test-quality'],
        workflowGeneration: structuredClone(active.record.workflowGeneration),
        repairOnly: reportRepair !== undefined,
        originalReportSha256: reportRepair?.originalReportSha256 ?? null,
        validationDiagnostic: reportRepair?.diagnostic ?? null,
        originalReportBytes: reportRepair?.originalReportBytes ?? null,
        signal: this.signal,
        onPrepared: async (invocation) => {
          const current = active.record.directReview;
          if (!current) throw new Error('direct review disappeared before prepare');
          active = await this.persist(active, {
            directReview: prepareDirectReviewInvocation(current, invocation),
          });
        },
        onLaunched: async (invocation) => {
          const current = active.record.directReview;
          if (!current) throw new Error('direct review disappeared before launch');
          active = await this.persist(active, {
            directReview: launchDirectReviewInvocation(current, invocation),
          });
        },
      });
      if (result.kind === 'completed') {
        const current = active.record.directReview;
        if (!current) return this.terminal(active, { status: 'internal-error', code: 'direct-review-result-orphaned' });
        if (result.report.verdict === 'needs-work') {
          if (active.record.cycle >= maxCycles) {
            return this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true }, 'direct-review-repair-exhausted');
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
          return this.persist(active, {
            lifecycle: 'implementing',
            cycle: (active.record.cycle + 1) as RunRecordV1['cycle'],
            directReview: repaired,
            reworkFindings: findings,
            checks: [],
            checkedChangeSha256: undefined,
            proofId: undefined,
            proofReceipt: undefined,
          });
        }
        if (result.report.verdict !== 'approved') return this.terminal(active, { status: 'blocked', kind: 'safety', resumable: false }, 'direct-review-rejected');
        return this.persist(active, {
          lifecycle: 'checking',
          directReview: acceptApprovedDirectReview(current, result.report, result.artifactSha256),
        });
      }
      if (result.kind === 'report-invalid') {
        const current = active.record.directReview;
        if (!current) return this.terminal(active, { status: 'internal-error', code: 'direct-review-result-orphaned' });
        if (current.review.reportRepairs >= 1 || reportRepair) {
          return this.terminal(active, { status: 'internal-error', code: 'direct-review-report-malformed' });
        }
        const { invocation: _invocation, ...withoutInvocation } = structuredClone(current);
        active = await this.persist(active, {
          directReview: {
            ...withoutInvocation,
            review: { ...withoutInvocation.review, reportRepairs: 1 },
          },
        });
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
        const { invocation: _invocation, ...withoutInvocation } = structuredClone(current);
        active = await this.persist(active, {
          directReview: {
            ...withoutInvocation,
            review: { ...withoutInvocation.review, transportRetries: 1 },
          },
        });
        continue;
      }
      if (result.kind === 'safe-halt') {
        active = await this.persist(active, {
          lifecycle: 'safe-halt',
          process: {
            ...result.process,
            purpose: 'code-review',
            resumeLifecycle: 'implementing',
            resumeReviewStage: directReview.stage,
          },
        });
        try { await result.waitForAbsence(); }
        catch { return this.terminal(active, { status: 'transport-failed', resumable: false }, 'direct-review-quiescence-unconfirmed'); }
        return this.terminal(active, { status: 'transport-failed', resumable: false }, 'direct-review-quiescence-delayed');
      }
      if (result.kind === 'cancelled') return this.terminal(active, { status: 'cancelled' });
      return this.terminal(active, { status: 'internal-error', code: result.code });
    }
  }

  private async recoverDirectReviewInvocation(starting: ActiveRun): Promise<ActiveRun | RunIssueResult> {
    const directReview = starting.record.directReview;
    const invocation = directReview?.invocation;
    if (!directReview || !invocation) return starting;
    const { invocation: _invocation, ...withoutInvocation } = structuredClone(directReview);
    if (invocation.status === 'prepared') {
      return this.persist(starting, { directReview: withoutInvocation });
    }
    if (invocation.status === 'launched') {
      try { await this.dependencies.waitForReviewProcessAbsence(invocation.processGroupId!); }
      catch { return this.terminal(starting, { status: 'blocked', kind: 'safety', resumable: false }, 'direct-review-process-absence-unconfirmed'); }
      if (directReview.review.transportRetries >= 1) {
        return this.terminal(starting, { status: 'blocked', kind: 'exhausted', resumable: true }, 'direct-review-transport-exhausted');
      }
      return this.persist(starting, {
        directReview: {
          ...withoutInvocation,
          review: { ...withoutInvocation.review, transportRetries: 1 },
        },
      });
    }
    return this.persist(starting, { directReview: withoutInvocation });
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
        cycle: (active.record.cycle + 1) as RunRecordV1['cycle'],
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
      cycle: (active.record.cycle + 1) as RunRecordV1['cycle'],
      checks: [],
      checkedChangeSha256: undefined,
      proofId: undefined,
      proofReceipt: undefined,
    });
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

  private async invokedFailure(active: ActiveRun, code: string): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code, summary: 'Publication delivery requires reconciliation.' });
    return { status: 'transport-failed', resumable: true, evidencePath: evidence.path };
  }

  private async terminal(
    active: ActiveRun,
    outcome: TerminalSeed,
    evidenceCode: string = outcome.status,
    retainIntent = false,
  ): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: active.record.runId, code: evidenceCode, summary: outcome.status });
    const terminalOutcome = { ...outcome, evidencePath: evidence.path } as RunTerminalOutcome;
    const changes: Partial<RunRecordV1> & { intent?: PublicationIntent | undefined } = {
      lifecycle: outcome.status,
      terminalOutcome,
      outcomeEvidenceId: evidence.id,
      process: undefined,
    };
    if (outcome.status !== 'review-ready' && active.record.directReview && active.record.directReview.status !== 'terminal') {
      changes.directReview = projectTerminalDirectReview(active.record.directReview, outcome.status === 'blocked'
        ? { status: 'blocked', kind: outcome.kind }
        : { status: outcome.status });
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
    if (active.record.lifecycle === 'triaging' || (active.record.lifecycle === 'safe-halt' && !active.record.routeReceipt)) {
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

  private async preClaimTransport(issueNumber: number): Promise<RunIssueResult> {
    const evidence = await this.dependencies.writeEvidence({ runId: `issue-${issueNumber}`, code: 'issue-read-failed', summary: 'Issue read failed.' });
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

function commentsWithMarker(issue: RunIssueSnapshot, marker: string): Array<{ body: string; authorAssociation: string }> {
  return issue.comments.filter((comment) => comment.body.split('\n')[0] === marker);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
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
