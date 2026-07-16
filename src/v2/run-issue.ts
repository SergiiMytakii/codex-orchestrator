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
import type {
  PublicationIntent,
  RunRecordV1,
  RunRecordWriter,
  RunStateFileV1,
  RunTerminalOutcome,
} from './run-store.js';

export type RunIssueResult =
  | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string }
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
  snapshot(worktreePath: string): Promise<Omit<CheckedChangeFreshness, 'checkPolicySha256'>>;
  listChangedFiles(worktreePath: string): Promise<string[]>;
  stageAll(worktreePath: string): Promise<void>;
  getTreeSha(worktreePath: string): Promise<string>;
  getHead(worktreePath: string): Promise<string>;
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
    findOpen(input: { headBranch: string; baseBranch: string }): Promise<{ url: string } | undefined>;
    createDraft(input: { title: string; body: string; headBranch: string; baseBranch: string }): Promise<{ url: string }>;
  };
  git: RunIssueGit;
  implementationAgent: {
    run(input: {
      runId: string;
      worktreePath: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      signal: AbortSignal;
    }): Promise<ImplementationAgentResult>;
  };
  checks: {
    run(input: { id: string; command: string; cwd: string; signal: AbortSignal }): Promise<{ status: 'passed' | 'failed'; output: Buffer }>;
  };
  proof: {
    proveChange(input: {
      proofId: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      checkedChange: CheckedChange;
    }): Promise<ProveChangeResult>;
  };
  checkedChangeMint: CheckedChangeMintCapability;
  runRecords: RunRecordWriter;
  writeEvidence(input: { runId: string; code: string; summary: string }): Promise<{ id: string; path: string }>;
  packageVersion: string;
  skillHashes: Record<string, string>;
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
      const ineligible = await this.ineligibilityReason(issue, config);
      if (ineligible) {
        const evidence = await this.dependencies.writeEvidence({ runId: `issue-${input.issueNumber}`, code: 'not-eligible', summary: ineligible });
        return { status: 'not-eligible', reason: ineligible, evidencePath: evidence.path };
      }
      const eligibleIssue = issue!;
      const issueSnapshot = snapshotIssue(eligibleIssue);
      const frozenCriteria = freezeCriteria(issueSnapshot);
      const runId = this.dependencies.createRunId();
      assertUuid(runId);
      const proofId = this.dependencies.createProofId();
      assertNonEmptyString(proofId, 'proofId');
      const branchName = `codex/issue-${input.issueNumber}`;
      const worktreePath = resolve(targetRoot, config.runner.workspaceRoot, `issue-${input.issueNumber}`);
      const baseSha = await this.dependencies.git.getBaseSha({ targetRoot, baseBranch: config.github.baseBranch });
      assertGitSha(baseSha, 'baseSha');
      const claimBody = claimComment(runId, input.issueNumber, branchName);
      const runningLabels = sortedUnique([config.github.labels.auto.name, config.github.labels.running.name]);

      active = await this.createRun({
        runId,
        issueNumber: input.issueNumber,
        canonicalRepository,
        baseSha,
        branchName,
        worktreePath,
        intent: { kind: 'claim-labels', issueNumber: input.issueNumber, expected: runningLabels },
      });
      try {
        await this.dependencies.issues.setLabels(input.issueNumber, runningLabels);
      } catch {
        return await this.invokedFailure(active, 'claim-labels-delivery-unknown');
      }
      active = await this.confirmEffect(active);
      active = await this.persist(active, {
        intent: { kind: 'comment', issueNumber: input.issueNumber, marker: claimBody.split('\n')[0]!, bodySha256: sha256(claimBody) },
      });
      try {
        await this.dependencies.issues.postComment(input.issueNumber, claimBody);
      } catch {
        return await this.invokedFailure(active, 'claim-comment-delivery-unknown');
      }
      active = await this.confirmEffect(active);

      try {
        await this.dependencies.git.createWorktree({ targetRoot, worktreePath, branchName, baseBranch: config.github.baseBranch, baseSha });
      } catch {
        return await this.terminal(active, { status: 'internal-error', code: 'local-git-effect-failed' });
      }
      active = await this.persist(active, { lifecycle: 'implementing' });
      if (!await this.authorized(input.issueNumber, runId, branchName, config)) {
        return await this.terminal(active, { status: 'blocked', kind: 'safety', resumable: true });
      }
      if (this.signal.aborted) return await this.terminal(active, { status: 'cancelled' });

      const implementation = await this.runImplementation({ runId, worktreePath, issue: issueSnapshot, frozenCriteria });
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
        return await this.terminal(active, { status: 'transport-failed', resumable: false }, 'process-quiescence-delayed');
      }
      if (implementation.kind !== 'completed') return await this.mapImplementationFailure(active, implementation);
      let report;
      try {
        report = validateImplementationReport(implementation.report);
      } catch {
        return await this.terminal(active, { status: 'internal-error', code: 'implementation-report-malformed' });
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
          return await this.terminal(active, { status: 'internal-error', code: 'check-rework-loop-not-yet-implemented' });
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
        cycle: 1,
        baseSha,
        headSha: freshness.headSha,
        indexTreeSha: freshness.indexTreeSha,
        trackedContentSha256: freshness.trackedContentSha256,
        untrackedContentSha256: freshness.untrackedContentSha256,
        worktreeIdentity: freshness.worktreeIdentity,
        changedFiles: proofChangedFiles,
        checks: active.record.checks.map((check) => ({ ...check, status: 'passed' as const })),
        checkPolicySha256: sha256(canonicalJson(config.checks)),
        packageVersion: this.dependencies.packageVersion,
        proofSchemaVersion: 1,
      };
      const checkedChange = this.dependencies.checkedChangeMint.mint(payload);
      const checkedChangeSha256 = checkedChangePayloadSha256(payload);
      active = await this.persist(active, { lifecycle: 'proving', checkedChangeSha256, proofId });

      let proof: ProveChangeResult;
      try {
        proof = await this.dependencies.proof.proveChange({ proofId, issue: issueSnapshot, frozenCriteria, checkedChange });
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
      if (proof.status !== 'passed') return await this.mapProofFailure(active, proof);
      active = await this.persist(active, { lifecycle: 'publishing', proofReceipt: proof.receipt });

      const message = `feat: implement #${input.issueNumber}`;
      const parentSha = await this.dependencies.git.getHead(worktreePath);
      const treeSha = await this.dependencies.git.getTreeSha(worktreePath);
      active = await this.persist(active, { intent: { kind: 'commit', parentSha, treeSha, message } });
      if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
      if (!await this.authorized(input.issueNumber, runId, branchName, config)) return await this.revoked(active);
      let commitSha: string;
      try {
        commitSha = await this.dependencies.git.commit({ worktreePath, message });
      } catch {
        return await this.terminal(await this.clearIntent(active), { status: 'internal-error', code: 'local-git-effect-failed' });
      }
      active = await this.confirmEffect(active);

      active = await this.persist(active, { intent: { kind: 'push', branch: branchName, sha: commitSha } });
      if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
      if (!await this.authorized(input.issueNumber, runId, branchName, config)) return await this.revoked(active);
      try {
        await this.dependencies.git.push({ worktreePath, branchName });
      } catch {
        return await this.invokedFailure(active, 'push-delivery-unknown');
      }
      active = await this.confirmEffect(active);

      const prMarker = `<!-- codex-orchestrator:run:${runId}:pr -->`;
      active = await this.persist(active, {
        intent: {
          kind: 'pr', owner: config.github.owner, repo: config.github.repo, head: branchName,
          base: config.github.baseBranch, issueNumber: input.issueNumber, marker: prMarker,
        },
      });
      if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
      if (!await this.authorized(input.issueNumber, runId, branchName, config)) return await this.revoked(active);
      let pullRequest: { url: string };
      try {
        pullRequest = await this.dependencies.pullRequests.createDraft({
          title: `Implement #${input.issueNumber}: ${issueSnapshot.title}`,
          body: `${prMarker}\n\nCloses #${input.issueNumber}`,
          headBranch: branchName,
          baseBranch: config.github.baseBranch,
        });
      } catch {
        return await this.invokedFailure(active, 'pr-delivery-unknown');
      }
      active = await this.confirmEffect(active);

      const handoffMarker = `<!-- codex-orchestrator:run:${runId}:handoff -->`;
      const handoffBody = `${handoffMarker}\nReview-ready draft PR: ${pullRequest.url}`;
      active = await this.persist(active, {
        intent: { kind: 'comment', issueNumber: input.issueNumber, marker: handoffMarker, bodySha256: sha256(handoffBody) },
      });
      if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
      if (!await this.authorized(input.issueNumber, runId, branchName, config)) return await this.revoked(active);
      try {
        await this.dependencies.issues.postComment(input.issueNumber, handoffBody);
      } catch {
        return await this.invokedFailure(active, 'handoff-comment-delivery-unknown');
      }
      active = await this.confirmEffect(active);

      const terminalLabels = [config.github.labels.review.name];
      active = await this.persist(active, { intent: { kind: 'labels', issueNumber: input.issueNumber, expected: terminalLabels } });
      if (this.signal.aborted) return await this.terminal(await this.clearIntent(active), { status: 'cancelled' });
      if (!await this.authorized(input.issueNumber, runId, branchName, config)) return await this.revoked(active);
      try {
        await this.dependencies.issues.setLabels(input.issueNumber, terminalLabels);
      } catch {
        return await this.invokedFailure(active, 'terminal-labels-delivery-unknown');
      }
      const evidence = await this.dependencies.writeEvidence({ runId, code: 'review-ready', summary: pullRequest.url });
      const outcome: RunTerminalOutcome = { status: 'review-ready', pullRequestUrl: pullRequest.url, evidencePath: evidence.path };
      try {
        active = await this.persist(active, {
          lifecycle: 'review-ready', intent: undefined, outcomeEvidenceId: evidence.id, terminalOutcome: outcome,
        });
      } catch {
        throw new PostEffectStateError(active);
      }
      return outcome;
    } catch (error) {
      if (!active && error instanceof TransportReadError) {
        return await this.preClaimTransport(input.issueNumber);
      }
      if (active && error instanceof PostEffectStateError) {
        return await this.invokedFailure(error.active, 'post-effect-state-write-failed');
      }
      if (active && error instanceof TransportReadError) {
        return await this.terminal(active, { status: 'transport-failed', resumable: true }, 'authorization-read-failed');
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
    intent: PublicationIntent;
  }): Promise<ActiveRun> {
    const state = await this.dependencies.runRecords.read();
    const now = this.timestamp();
    const record: RunRecordV1 = {
      ...input,
      lifecycle: 'claimed', cycle: 1, reportRepairs: 0,
      packageVersion: this.dependencies.packageVersion,
      skillHashes: structuredClone(this.dependencies.skillHashes),
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
    let issue: RunIssueSnapshot | undefined;
    try {
      issue = await this.dependencies.issues.read(issueNumber);
    } catch {
      throw new TransportReadError();
    }
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

  private async runImplementation(input: { runId: string; worktreePath: string; issue: IssueSnapshot; frozenCriteria: FrozenCriterion[] }): Promise<ImplementationAgentResult> {
    try {
      return await this.dependencies.implementationAgent.run({ ...input, signal: this.signal });
    } catch {
      return { kind: 'internal-error' };
    }
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
    return this.terminal(active, { status: 'transport-failed', resumable: false }, code, true);
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

function snapshotIssue(issue: RunIssueSnapshot): IssueSnapshot {
  if (issue.state !== 'OPEN') throw new Error('cannot snapshot a closed issue');
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: 'OPEN',
    labels: sortedUnique(issue.labels),
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

function sameStrings(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
