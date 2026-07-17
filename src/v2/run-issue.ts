import { resolve } from 'node:path';

import {
  checkedChangePayloadSha256,
  type CheckedChange,
  type CheckedChangeFreshness,
  type CheckedChangeMintCapability,
  type CheckedChangePayloadV1,
} from './checked-change.js';
import { parseAgentAutoConfig, type AgentAutoConfigV1 } from './config.js';
import { canonicalJson, sha256 } from './containment.js';
import { validateImplementationReport } from './implementation-report.js';
import { ProofQuiescenceError, type FrozenCriterion, type IssueSnapshot, type ProveChangeResult } from './acceptance-proof.js';
import type { ProofReceipt } from './proof-report.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import {
  RouteMigrationUnrecoverableError,
  WorkflowGenerationUnrecoverableError,
} from './run-store.js';
import {
  initialRouteExecution,
  type RouteCoordinatorInput,
  type RouteCoordinatorResult,
  type RouteCoordinatorState,
} from './route-coordinator.js';
import type { RoutedContinuationRegistry } from './route-continuations.js';
import {
  downstreamLifecycleForRoute,
  validateRouteTransition,
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
  | { status: 'not-eligible'; reason: string; evidencePath: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; resumable: boolean; evidencePath: string }
  | { status: 'transport-failed'; resumable: boolean; evidencePath: string }
  | { status: 'cancelled'; evidencePath: string }
  | { status: 'internal-error'; evidencePath: string };

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
  stageAll(worktreePath: string): Promise<void>;
  getTreeSha(worktreePath: string): Promise<string>;
  getHead(worktreePath: string): Promise<string>;
  inspectHead(worktreePath: string): Promise<{ sha: string; parentSha: string; treeSha: string; message: string }>;
  getRemoteBranchSha(worktreePath: string, branchName: string): Promise<string | undefined>;
  commit(input: { worktreePath: string; message: string }): Promise<string>;
  push(input: { worktreePath: string; branchName: string }): Promise<void>;
}

export type ImplementationAgentResult =
  | { kind: 'completed'; report: unknown }
  | { kind: 'transport-failed'; resumable: boolean }
  | { kind: 'cancelled' }
  | { kind: 'internal-error' }
  | { kind: 'safe-halt'; process: NonNullable<RunRecordV1['process']>; waitForAbsence(): Promise<void> };

export interface RunIssueDependencies {
  readConfig(targetRoot: string): Promise<{ bytes: Buffer; config: AgentAutoConfigV1 }>;
  validateContainment(config: AgentAutoConfigV1): Promise<void>;
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
  now(): string;
  signal?: AbortSignal;
}

export class OwnerLockSafetyError extends Error {}

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
    config: AgentAutoConfigV1,
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
    config: AgentAutoConfigV1,
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
      await this.persist(active, { lifecycle: 'review-ready', intent: undefined, outcomeEvidenceId: evidence.id, terminalOutcome: outcome });
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
          active = await this.migratePreRouteRun(active, issue);
          issueSnapshot = structuredClone(active.record.issueSnapshot);
        } else {
          if (existing.lifecycle === 'safe-halt') return await this.publicationDiverged(active, 'safe-halt-requires-process-absence');
          if (existing.lifecycle === 'waiting-human' || existing.lifecycle === 'spec-authoring') {
            const evidence = await this.dependencies.writeEvidence({
              runId,
              code: 'route-ready',
              summary: existing.routeReceipt?.route ?? existing.lifecycle,
            });
            return {
              status: 'route-ready',
              route: existing.lifecycle === 'waiting-human' ? 'awaiting-user' : 'spec-required',
              evidencePath: evidence.path,
            };
          }
          if (!['triaging', 'routed', 'implementing', 'reworking', 'checking', 'proving'].includes(existing.lifecycle)) {
            return await this.terminal(active, { status: 'internal-error', code: 'resume-phase-not-reconciled' });
          }
          if (!await this.authorized(input.issueNumber, runId, branchName, config)) return await this.revoked(active);
          if (existing.lifecycle !== 'triaging' && existing.lifecycle !== 'routed') {
            if (!existing.routeExecution || !existing.routeReceipt) throw new RouteMigrationUnrecoverableError();
            if (existing.cycle >= config.runner.maxCycles) {
              return await this.terminal(active, { status: 'blocked', kind: 'exhausted', resumable: true });
            }
            active = await this.startNextCycle(active, [`Recovered interrupted ${existing.lifecycle} phase.`]);
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
        active = await this.migratePreRouteRun(active, issue);
        issueSnapshot = structuredClone(active.record.issueSnapshot);
      }
      if (active.record.lifecycle === 'triaging' || active.record.lifecycle === 'routed') {
        const routed = await this.routeRun(active, issueSnapshot, frozenCriteria, worktreePath, config, input.issueNumber, branchName);
        if ('result' in routed) return routed.result;
        active = routed.active;
      }
      if (active.record.lifecycle !== 'implementing') {
        return await this.terminal(active, { status: 'internal-error', code: 'route-dispatch-not-implementing' });
      }
      attemptLoop: while (true) {
      if (!await this.authorized(input.issueNumber, runId, branchName, config)) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }
      if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });

      const implementationBaseline = await this.dependencies.git.snapshot(worktreePath);
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
        active = await this.persist(active, { lifecycle: 'safe-halt', process: implementation.process });
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
        const afterTransport = await this.dependencies.git.snapshot(worktreePath);
        if (!sameFreshness(implementationBaseline, afterTransport)) {
          return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true }, 'transport-baseline-changed');
        }
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
          active = await this.persist(active, { lifecycle: 'safe-halt', process: implementation.process });
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
        return await this.terminal(active, { status: 'internal-error', code: 'implementation-change-set-invalid' });
      }

      active = await this.persist(active, { lifecycle: 'checking' });
      for (const [id, command] of Object.entries(config.checks)) {
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
          active = await this.startNextCycle(active, [`Check ${id} failed:\n${check.output.toString('utf8').slice(0, 8 * 1024)}`]);
          continue attemptLoop;
        }
      }

      try {
        await this.dependencies.git.stageAll(worktreePath);
      } catch {
        return await this.terminal(active, { status: 'internal-error', code: 'local-git-effect-failed' });
      }
      if (await this.dependencies.git.getHead(worktreePath) !== baseSha) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }
      const proofChangedFiles = await this.dependencies.git.listChangedFiles(worktreePath);
      const freshness = await this.dependencies.git.snapshot(worktreePath);
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
        active = await this.startNextCycle(active, proof.findings);
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
      if (active && error instanceof RouteMigrationUnrecoverableError) {
        const evidence = await this.dependencies.writeEvidence({
          runId: active.record.runId,
          code: 'route-migration-unrecoverable',
          summary: 'The pre-route run cannot be safely migrated without product-state ambiguity.',
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

  async migratePreRouteRun(active: ActiveRun, issue?: RunIssueSnapshot): Promise<ActiveRun> {
    if (active.record.lifecycle !== 'claimed'
      || active.record.process
      || active.record.intent
      || active.record.routeExecution
      || active.record.routeReceipt) {
      throw new RouteMigrationUnrecoverableError();
    }
    const [snapshot, changedFiles] = await Promise.all([
      this.dependencies.git.snapshot(active.record.worktreePath),
      this.dependencies.git.listChangedFiles(active.record.worktreePath),
    ]);
    if (snapshot.headSha !== active.record.baseSha || changedFiles.length !== 0) {
      throw new RouteMigrationUnrecoverableError();
    }
    try {
      await this.dependencies.verifyWorkflowGeneration(active.record.workflowGeneration);
    } catch {
      throw new RouteMigrationUnrecoverableError();
    }
    const issueSnapshot = issue?.state === 'OPEN' ? snapshotIssue(issue) : active.record.issueSnapshot;
    return this.persist(active, { lifecycle: 'triaging', routeExecution: initialRouteExecution(), issueSnapshot });
  }

  private async routeRun(
    starting: ActiveRun,
    issue: IssueSnapshot,
    frozenCriteria: FrozenCriterion[],
    worktreePath: string,
    config: AgentAutoConfigV1,
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
        ],
        signal: this.signal,
      });
      if (result.status === 'repairable' || result.status === 'retryable') continue;
      if (result.status === 'safe-halt') {
        active = await this.persist(active, { lifecycle: 'safe-halt', process: result.process });
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
    active = await this.persist(active, { lifecycle });
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
    const continuation = receipt.route === 'direct'
      ? await this.dependencies.routeContinuations.direct(context)
      : receipt.route === 'spec-required'
        ? await this.dependencies.routeContinuations.specRequired(context)
        : await this.dependencies.routeContinuations.awaitingUser(context);
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
      const evidence = await this.dependencies.writeEvidence({
        runId: active.record.runId,
        code: 'route-ready',
        summary: receipt.route,
      });
      return { result: { status: 'route-ready', route: receipt.route, evidencePath: evidence.path } };
    }
    return { active };
  }

  private async readStrictConfig(targetRoot: string): Promise<{ bytes: Buffer; config: AgentAutoConfigV1 }> {
    const value = await this.dependencies.readConfig(targetRoot);
    return { bytes: Buffer.from(value.bytes), config: parseAgentAutoConfig(structuredClone(value.config)) };
  }

  private async ineligibilityReason(issue: RunIssueSnapshot | undefined, config: AgentAutoConfigV1): Promise<string | undefined> {
    if (!issue) return 'Issue does not exist.';
    const labels = new Set(issue.labels);
    if (issue.state !== 'OPEN') return 'Issue is not open.';
    if (!labels.has(config.github.labels.auto.name)) return 'Issue lacks the auto label.';
    if ([config.github.labels.running.name, config.github.labels.blocked.name, config.github.labels.review.name].some((label) => labels.has(label))) {
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

  private async authorized(issueNumber: number, runId: string, branchName: string, config: AgentAutoConfigV1): Promise<boolean> {
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

  private async startNextCycle(active: ActiveRun, findings: string[]): Promise<ActiveRun> {
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
