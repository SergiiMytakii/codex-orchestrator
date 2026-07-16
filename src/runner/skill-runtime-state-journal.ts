import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

import type { CodexExecutionRunInputV2, CodexExecutionRunResultV2 } from '../codex/execution-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { RuntimeSkillBundleManifestV1 } from '../skills/package-skill-bundle.js';
import {
  applyNodeControlEnvelope,
  appendRecoveryExecution,
  prepareNodeAttempt,
  updateAttemptExecution,
  type GraphProgressRecordV2,
  type NodeControlEnvelopeV1,
  type WorktreeBaselineV2,
} from '../skills/package-skill-graph.js';
import { readCurrentBootNonce } from './target-activity-fence.js';
import { RunnerStateStore, type RunnerProcessMetadataV2, type RunnerStateFileV2 } from './local-state.js';
import { skillExecutionPolicyHash } from './skill-runtime-execution.js';

const execFileAsync = promisify(execFile);

export class SkillRuntimeStateJournal {
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly store: RunnerStateStore,
    private readonly manifest: RuntimeSkillBundleManifestV1,
    private readonly runId: string,
    private progress: GraphProgressRecordV2,
  ) {}

  public static async open(input: CodexExecutionRunInputV2, manifest: RuntimeSkillBundleManifestV1, initial: GraphProgressRecordV2): Promise<SkillRuntimeStateJournal | undefined> {
    const store = new RunnerStateStore(input.targetRoot, input.config as unknown as CodexOrchestratorConfig);
    const state = await store.load();
    if (state.version !== 2) return undefined;
    const existing = state.runs.find((run) => run.issueNumber === input.issueNumber);
    if (!existing) throw new Error(`orchestrator-runner-state-run-missing:${input.issueNumber}`);
    const progress = 'stateVersion' in existing && existing.runId === input.runId ? existing.graph : initial;
    const journal = new SkillRuntimeStateJournal(store, manifest, input.runId, progress);
    if (!('stateVersion' in existing) || existing.runId !== input.runId) {
      await journal.mutate((current) => ({
        ...current,
        runs: current.runs.map((run) => run.issueNumber === input.issueNumber ? {
          ...run,
          stateVersion: 2,
          runId: input.runId,
          skillRuntime: input.skillRuntime,
          executionPolicyHash: skillExecutionPolicyHash(input.manifestNode),
          effectivePolicySummary: input.targetPolicy,
          graph: initial,
        } as RunnerProcessMetadataV2 : run),
      }));
      journal.progress = initial;
    }
    return journal;
  }

  public current(): GraphProgressRecordV2 { return this.progress; }

  public async prepare(input: CodexExecutionRunInputV2): Promise<string> {
    return this.serialize(async () => {
      const executionId = randomUUID();
      const baseline = await captureBaseline(input.worktreePath, input.runId);
      await this.replaceProgress(prepareNodeAttempt(this.progress, {
        attemptId: input.attemptId,
        executionId,
        nodeId: this.progress.currentNodeId,
        baseline,
        reportPath: input.reportPath,
        intentPersistedAt: new Date().toISOString(),
      }));
      return executionId;
    });
  }

  public async running(input: { attemptId: string; executionId: string; pid: number; processGroupId: number }): Promise<void> {
    await this.serialize(async () => {
      const processIdentity = {
        pid: input.pid,
        processGroupId: input.processGroupId,
        host: hostname(),
        bootNonce: await readCurrentBootNonce(),
        startedAt: new Date().toISOString(),
      };
      await this.replaceProgress(updateAttemptExecution(this.progress, {
        attemptId: input.attemptId,
        executionId: input.executionId,
        process: processIdentity,
        status: 'running',
      }));
    });
  }

  public async appServer(input: { attemptId: string; executionId: string; threadId: string; turnId: string }): Promise<void> {
    await this.serialize(async () => {
      await this.replaceProgress(updateAttemptExecution(this.progress, {
        attemptId: input.attemptId,
        executionId: input.executionId,
        appServer: { threadId: input.threadId, turnId: input.turnId },
        status: 'running',
      }));
    });
  }

  public async terminal(input: { attemptId: string; executionId: string; result: CodexExecutionRunResultV2 }): Promise<void> {
    await this.serialize(async () => {
      const reportPath = this.reportPath(input.attemptId);
      const bytes = await readFile(reportPath);
      const terminalKind = input.result.status === 'completed' ? 'completed' : input.result.status;
      await this.replaceProgress(updateAttemptExecution(this.progress, {
        attemptId: input.attemptId,
        executionId: input.executionId,
        appServer: input.result.threadId ? { threadId: input.result.threadId, ...(input.result.turnId ? { turnId: input.result.turnId } : {}) } : undefined,
        report: { path: reportPath, sha256: createHash('sha256').update(bytes).digest('hex'), atomicWriteComplete: true },
        terminal: {
          kind: terminalKind,
          acknowledgedAt: new Date().toISOString(),
          sideEffectsQuiescedAt: new Date().toISOString(),
          quiescenceProof: 'thread-clean-empty',
        },
        status: 'terminal',
      }));
    });
  }

  public async blocked(input: {
    attemptId: string;
    executionId: string;
    reason: string;
    recovery: CodexExecutionRunResultV2['recovery'];
  }): Promise<void> {
    await this.serialize(async () => {
      await this.replaceProgress(updateAttemptExecution(this.progress, {
        attemptId: input.attemptId,
        executionId: input.executionId,
        recovery: { kind: input.recovery, reason: input.reason },
        status: 'blocked',
      }));
    });
  }

  public async protocolDeath(input: { attemptId: string; executionId: string; reason: string }): Promise<void> {
    await this.serialize(async () => {
      const now = new Date().toISOString();
      await this.replaceProgress(updateAttemptExecution(this.progress, {
        attemptId: input.attemptId,
        executionId: input.executionId,
        terminal: {
          kind: 'protocol-death',
          acknowledgedAt: now,
          sideEffectsQuiescedAt: now,
          quiescenceProof: 'process-group-absent',
        },
        recovery: { kind: 'partial-node-mutation', reason: input.reason },
        status: 'blocked',
      }));
    });
  }

  public async prepareRecovery(input: CodexExecutionRunInputV2): Promise<{
    executionId: string;
    kind: 'clean-retry' | 'partial-continuation';
  } | undefined> {
    return this.serialize(async () => {
      const attempt = this.progress.attempts.find((candidate) => candidate.attemptId === input.attemptId);
      if (!attempt) throw new Error(`orchestrator-node-attempt-missing:${input.attemptId}`);
      const current = await captureBaseline(input.worktreePath, input.runId);
      const baselineUnchanged = sameBaseline(attempt.baseline, current);
      const partialContinuationAllowed = !baselineUnchanged
        && input.manifestNode.executionPolicy.worktreeAccess === 'write'
        && attempt.baseline.headSha === current.headSha
        && attempt.baseline.indexTreeSha === current.indexTreeSha
        && attempt.baseline.ownershipToken === current.ownershipToken;
      const kind = baselineUnchanged && attempt.cleanRetriesConsumed === 0
        ? 'clean-retry' as const
        : partialContinuationAllowed && attempt.partialContinuationsConsumed === 0
          ? 'partial-continuation' as const
          : undefined;
      if (!kind) return undefined;
      const executionId = randomUUID();
      await this.replaceProgress(appendRecoveryExecution(this.progress, {
        attemptId: input.attemptId,
        executionId,
        kind,
        reportPath: input.reportPath,
        intentPersistedAt: new Date().toISOString(),
        baselineUnchanged,
        partialContinuationAllowed,
        ...(kind === 'partial-continuation' ? { recoveryArtifactPath: input.contextArtifactPath } : {}),
      }));
      return { executionId, kind };
    });
  }

  public async transition(envelope: NodeControlEnvelopeV1): Promise<GraphProgressRecordV2> {
    return this.serialize(async () => {
      const currentNodeId = this.progress.currentNodeId;
      let reconciled = 0;
      const attempts = this.progress.attempts.map((attempt) => {
        if (attempt.nodeId !== currentNodeId || attempt.status !== 'terminal') return attempt;
        const latest = attempt.executions.at(-1);
        if (!latest || latest.status !== 'terminal') return attempt;
        reconciled += 1;
        return {
          ...attempt,
          status: 'reconciled' as const,
          executions: attempt.executions.map((execution, index) => index === attempt.executions.length - 1
            ? { ...execution, status: 'reconciled' as const }
            : execution),
        };
      });
      if (reconciled === 0) throw new Error(`orchestrator-node-attempt-terminal-missing:${currentNodeId}`);
      await this.replaceProgress(applyNodeControlEnvelope(this.manifest, { ...this.progress, attempts }, envelope));
      return this.progress;
    });
  }

  public async persistProgress(progress: GraphProgressRecordV2): Promise<void> {
    await this.serialize(() => this.replaceProgress(progress));
  }

  public async persistReviewProgress(progress: GraphProgressRecordV2): Promise<void> {
    await this.serialize(() => this.replaceProgress({
      ...progress,
      attempts: this.progress.attempts,
    }));
  }

  private reportPath(attemptId: string): string {
    const attempt = this.progress.attempts.find((candidate) => candidate.attemptId === attemptId);
    const path = attempt?.executions.at(-1)?.report.path;
    if (!path) throw new Error(`orchestrator-node-attempt-report-path-missing:${attemptId}`);
    return path;
  }

  private async replaceProgress(progress: GraphProgressRecordV2): Promise<void> {
    await this.mutate((state) => ({
      ...state,
      runs: state.runs.map((run) => 'stateVersion' in run && run.runId === this.runId ? { ...run, graph: progress } : run),
    }));
    this.progress = progress;
  }

  private async mutate(mutation: (state: RunnerStateFileV2) => RunnerStateFileV2): Promise<void> {
    await this.store.mutateLatestV2(mutation);
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function captureBaseline(worktreePath: string, ownershipToken: string): Promise<WorktreeBaselineV2> {
  const run = async (args: string[]) => (await execFileAsync('git', ['-C', worktreePath, ...args], { encoding: 'buffer' })).stdout as Buffer;
  const head = await run(['rev-parse', 'HEAD']);
  const index = await run(['write-tree']);
  const status = await run(['status', '--porcelain=v1', '-z']);
  const diff = await run(['diff', '--binary', 'HEAD']);
  return {
    headSha: head.toString('utf8').trim(),
    indexTreeSha: index.toString('utf8').trim(),
    statusSha256: createHash('sha256').update(status).digest('hex'),
    contentSha256: createHash('sha256').update(diff).digest('hex'),
    ownershipToken,
  };
}

function sameBaseline(left: WorktreeBaselineV2, right: WorktreeBaselineV2): boolean {
  return left.headSha === right.headSha
    && left.indexTreeSha === right.indexTreeSha
    && left.statusSha256 === right.statusSha256
    && left.contentSha256 === right.contentSha256
    && left.ownershipToken === right.ownershipToken;
}
