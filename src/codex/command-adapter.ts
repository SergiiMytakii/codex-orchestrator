import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CodexOrchestratorConfigV2 } from '../config/schema.js';
import { loadToolCatalogFixture } from './tool-catalog.js';
import { AppServerProcessOwner } from './app-server-process.js';
import { assertCodexVersion, preparePackageRuntimeHome, type PackageRuntimeHome } from './package-runtime-home.js';
import type {
  CodexExecutionAdapter,
  CodexExecutionRunInputV2,
  CodexExecutionRunResultV2,
} from './execution-adapter.js';
import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';
import { loadPackageSkillBundle, verifyMaterializedSkillBundle } from '../skills/package-skill-bundle.js';
import {
  applyNodeControlEnvelope,
  expandReviewTemplate,
  graphNode,
  intersectExecutionPolicy,
  recordReviewNodeResult,
  runnableReviewNodes,
  startOperationGraph,
  type GraphProgressRecordV2,
  type NodeControlEnvelopeV1,
} from '../skills/package-skill-graph.js';
import type { RuntimeSkillBundleManifestV1 } from '../skills/package-skill-bundle.js';
import { SkillRuntimeStateJournal } from '../runner/skill-runtime-state-journal.js';

export type CodexCommandRunInput = CodexExecutionRunInputV2;

export type CodexCommandRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  logPath?: string;
} & Partial<Omit<CodexExecutionRunResultV2, 'exitCode' | 'stdout' | 'stderr' | 'logPath'>> & {
  figmaMcp?: {
    requirement: 'none' | 'optional' | 'required';
    enabled: boolean;
  };
};
export type { CodexExecutionRunResultV2 as CodexCommandRunResultV2 } from './execution-adapter.js';

export interface AppServerOwner {
  process?: { pid?: number };
  processGroupId?: number;
  session: {
    run(
      input: CodexExecutionRunInputV2,
      signal?: AbortSignal,
      observer?: { onTurnStarted(identity: { threadId: string; turnId: string }): Promise<void> },
    ): Promise<CodexExecutionRunResultV2>;
    interrupt(input: {
      runId: string;
      attemptId: string;
      threadId: string;
      turnId: string;
      reason: 'cancelled' | 'timeout' | 'idle-timeout';
    }): Promise<void>;
  };
  close(reason?: string): Promise<void>;
}

export interface CodexCommandAdapterOptions {
  orchestratorHome?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  packageRoot?: string;
  allowAccessToken?: boolean;
  ownerFactory?: (input: {
    runId: string;
    runtimeHome: PackageRuntimeHome;
    command: string;
    args: string[];
    cwd: string;
    supervisorPath: string;
  }) => Promise<AppServerOwner>;
  versionChecker?: (command: string, requiredVersion: string, env: Record<string, string>) => Promise<void>;
  toolCatalogLoader?: (path: string) => Promise<unknown>;
  retainedOwner?: AppServerOwner;
}

export class CodexCommandAdapter implements CodexExecutionAdapter {
  private readonly owners = new Map<string, AppServerOwner>();
  private retainedOwner: AppServerOwner | undefined;

  public constructor(
    private readonly config: CodexOrchestratorConfigV2,
    private readonly options: CodexCommandAdapterOptions = {},
  ) {
    if (config.codex.adapter !== 'codex-app-server') throw new Error('orchestrator-codex-adapter-v2-required');
    this.retainedOwner = options.retainedOwner;
  }

  public async run(input: CodexExecutionRunInputV2, signal?: AbortSignal): Promise<CodexExecutionRunResultV2> {
    try {
      return await this.runGraph(input, signal);
    } catch (error) {
      await this.closeRun({ runId: input.runId, reason: 'failed' });
      throw error;
    }
  }

  private async runGraph(input: CodexExecutionRunInputV2, signal?: AbortSignal): Promise<CodexExecutionRunResultV2> {
    if (input.config.codex.adapter !== 'codex-app-server') throw new Error('orchestrator-codex-adapter-v2-required');
    const manifest = await this.manifestFor(input);
    let progress = startOperationGraph(manifest, input.operationId);
    const journal = await SkillRuntimeStateJournal.open(input, manifest, progress);
    if (journal) progress = journal.current();
    if (progress.currentNodeId !== input.nodeId) throw new Error(`orchestrator-package-graph-resume-node-mismatch:${progress.currentNodeId}`);
    const initialExecutionId = journal ? await journal.prepare(input) : undefined;
    const owner = await this.ownerForRun(input);
    if (journal && initialExecutionId) await this.markJournalRunning(journal, owner, input.attemptId, initialExecutionId);
    let nodeInput = input;
    let result = await this.runSessionWithRecovery(owner, nodeInput, signal, journal, initialExecutionId);
    if (!result.controlEnvelope) {
      await this.closeRun({ runId: input.runId, reason: 'failed' });
      return result;
    }
    for (let executionIndex = 0; executionIndex < 32; executionIndex += 1) {
      if (!result.controlEnvelope) throw new Error('orchestrator-node-control-envelope-missing');
      progress = journal
        ? await journal.transition(result.controlEnvelope)
        : applyNodeControlEnvelope(manifest, progress, result.controlEnvelope);
      if (progress.aggregateVerdict) {
        await this.closeRun({ runId: input.runId, reason: result.exitCode === 0 ? 'completed' : 'failed' });
        return result;
      }
      if (progress.currentNodeId === 'code-review' && progress.templateId === 'code-review') {
        const review = await this.executeReviewTemplate(owner, input, manifest, progress, executionIndex, journal, signal);
        progress = review.progress;
        result = review.result;
        const outcome = progress.reviewers.some((reviewer) => reviewer.mode === 'full'
          && (reviewer.verdict !== 'Approved' || reviewer.findingIds.length > 0)
          && !progress.reviewers.some((closure) => closure.reviewerSlot === reviewer.reviewerSlot && closure.mode === 'closure' && closure.verdict === 'Approved'))
          ? 'needs-work' as const
          : 'approved' as const;
        const aggregateEnvelope: NodeControlEnvelopeV1 = {
          version: 1,
          nodeId: 'code-review',
          outcome,
          artifactRefs: progress.reviewers.map((reviewer) => `review://${reviewer.nodeId}`),
          result: { verdict: outcome === 'approved' ? 'Approved' : 'Needs Work', findings: progress.findings },
        };
        progress = journal
          ? await journal.transition(aggregateEnvelope)
          : applyNodeControlEnvelope(manifest, progress, aggregateEnvelope);
        result = { ...result, controlEnvelope: aggregateEnvelope };
        if (progress.aggregateVerdict) {
          await this.closeRun({ runId: input.runId, reason: result.exitCode === 0 ? 'completed' : 'failed' });
          return result;
        }
      }
      const signedNode = graphNode(manifest, progress);
      const profile = input.config.codex.profiles[input.phase];
      const manifestNode = {
        ...signedNode,
        executionPolicy: intersectExecutionPolicy(signedNode.executionPolicy, input.targetPolicy, {
          model: profile?.model ?? null,
          effort: profile?.effort ?? null,
          timeoutMs: profile?.timeoutMs ?? input.config.codex.timeoutMs,
          idleTimeoutMs: profile?.idleTimeoutMs ?? input.config.codex.idleTimeoutMs,
        }),
      };
      const contextArtifactPath = await this.contextForNode(input.contextArtifactPath, signedNode.id, executionIndex + 1);
      nodeInput = {
        ...input,
        nodeId: signedNode.id,
        attemptId: `${input.attemptId}-${executionIndex + 2}`,
        manifestNode,
        contextArtifactPath,
        reportPath: this.nodeArtifactPath(input.reportPath, signedNode.id, executionIndex + 1),
        logPath: this.nodeArtifactPath(input.logPath, signedNode.id, executionIndex + 1),
      };
      const executionId = journal ? await journal.prepare(nodeInput) : undefined;
      if (journal && executionId) await this.markJournalRunning(journal, owner, nodeInput.attemptId, executionId);
      result = await this.runSessionWithRecovery(owner, nodeInput, signal, journal, executionId);
      if (result.exitCode !== 0 || result.status !== 'completed') {
        await this.closeRun({ runId: input.runId, reason: 'failed' });
        return result;
      }
    }
    await this.closeRun({ runId: input.runId, reason: 'failed' });
    throw new Error('orchestrator-package-graph-execution-budget-exhausted');
  }

  private async markJournalRunning(
    journal: SkillRuntimeStateJournal,
    owner: AppServerOwner,
    attemptId: string,
    executionId: string,
  ): Promise<void> {
    const pid = owner.process?.pid;
    const processGroupId = owner.processGroupId;
    if (!pid || !processGroupId) throw new Error('orchestrator-app-server-process-identity-missing');
    await journal.running({ attemptId, executionId, pid, processGroupId });
  }

  private journalObserver(journal: SkillRuntimeStateJournal, attemptId: string, executionId: string) {
    return {
      onTurnStarted: ({ threadId, turnId }: { threadId: string; turnId: string }) => journal.appServer({
        attemptId,
        executionId,
        threadId,
        turnId,
      }),
    };
  }

  private async runSession(
    owner: AppServerOwner,
    input: CodexExecutionRunInputV2,
    signal?: AbortSignal,
    journal?: SkillRuntimeStateJournal,
    executionId?: string,
  ): Promise<CodexExecutionRunResultV2> {
    try {
      const result = await owner.session.run(
        input,
        signal,
        journal && executionId ? this.journalObserver(journal, input.attemptId, executionId) : undefined,
      );
      if (journal && executionId) {
        if (result.controlEnvelope && result.status === 'completed') {
          await journal.terminal({ attemptId: input.attemptId, executionId, result });
        } else {
          await journal.blocked({
            attemptId: input.attemptId,
            executionId,
            reason: result.stderr || result.status,
            recovery: result.recovery,
          });
        }
      }
      return result;
    } catch (error) {
      if (journal && executionId) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.includes('orchestrator-app-server-protocol-death')) {
          await this.closeRun({ runId: input.runId, reason: 'failed' });
          await journal.protocolDeath({ attemptId: input.attemptId, executionId, reason });
          return {
            exitCode: 1, stdout: '', stderr: reason, logPath: input.logPath, status: 'protocol-death',
            attemptId: input.attemptId, expectedToolCatalogHash: '', recovery: 'partial-node-mutation',
          };
        }
        await journal.blocked({ attemptId: input.attemptId, executionId, reason, recovery: 'partial-node-mutation' });
      }
      throw error;
    }
  }

  private async runSessionWithRecovery(
    owner: AppServerOwner,
    input: CodexExecutionRunInputV2,
    signal?: AbortSignal,
    journal?: SkillRuntimeStateJournal,
    initialExecutionId?: string,
  ): Promise<CodexExecutionRunResultV2> {
    let executionId = initialExecutionId;
    let nodeInput = input;
    let lastError: unknown;
    let lastResult: CodexExecutionRunResultV2 | undefined;
    for (let recoveryIndex = 0; recoveryIndex < 3; recoveryIndex += 1) {
      try {
        lastResult = await this.runSession(owner, nodeInput, signal, journal, executionId);
        lastError = undefined;
        if (lastResult.status === 'completed' && lastResult.controlEnvelope) return lastResult;
      } catch (error) {
        lastError = error;
      }
      if (this.recoveryForbidden(lastResult, lastError, signal)) break;
      if (!journal || !executionId) break;
      const recovery = await journal.prepareRecovery(nodeInput);
      if (!recovery) break;
      executionId = recovery.executionId;
      nodeInput = recovery.kind === 'partial-continuation'
        ? {
            ...nodeInput,
            contextArtifactPath: await this.contextForNode(nodeInput.contextArtifactPath, `${nodeInput.nodeId}-partial-continuation`, recoveryIndex + 1, {
              recovery: { kind: recovery.kind, priorAttemptId: nodeInput.attemptId },
            }),
          }
        : nodeInput;
      await this.markJournalRunning(journal, owner, nodeInput.attemptId, executionId);
    }
    if (lastError) throw lastError;
    if (!lastResult) throw new Error(`orchestrator-node-execution-produced-no-result:${input.nodeId}`);
    return lastResult;
  }

  private recoveryForbidden(
    result: CodexExecutionRunResultV2 | undefined,
    error: unknown,
    signal?: AbortSignal,
  ): boolean {
    if (signal?.aborted) return true;
    const detail = `${error instanceof Error ? error.message : error ?? ''}\n${result?.stderr ?? ''}`;
    return detail.includes('turn-cleanup-unconfirmed')
      || detail.includes('unexpected-server-request')
      || detail.includes('unexpected-process-server-request')
      || detail.includes('orchestrator-app-server-protocol-death')
      || result?.status === 'interrupted';
  }

  public async interruptTurn(input: {
    runId: string;
    attemptId: string;
    threadId: string;
    turnId: string;
    reason: 'cancelled' | 'timeout' | 'idle-timeout';
  }): Promise<void> {
    const owner = this.owners.get(input.runId);
    if (!owner) return;
    await owner.session.interrupt(input);
  }

  public async closeRun(input: { runId: string; reason: 'completed' | 'cancelled' | 'failed' | 'runner-shutdown' }): Promise<void> {
    const owner = this.owners.get(input.runId);
    if (!owner) return;
    await owner.close(input.reason);
    if (this.owners.get(input.runId) === owner) this.owners.delete(input.runId);
  }

  public async closeRetainedOwner(reason = 'preclaim-failed'): Promise<void> {
    const owner = this.retainedOwner;
    if (!owner) return;
    await owner.close(reason);
    if (this.retainedOwner === owner) this.retainedOwner = undefined;
  }

  private async ownerForRun(input: CodexExecutionRunInputV2): Promise<AppServerOwner> {
    const existing = this.owners.get(input.runId);
    if (existing) return existing;
    if (this.retainedOwner) {
      const retained = this.retainedOwner;
      this.retainedOwner = undefined;
      this.owners.set(input.runId, retained);
      return retained;
    }
    const runtimeHome = await preparePackageRuntimeHome({
      runId: input.runId,
      orchestratorHome: this.options.orchestratorHome,
      sourceEnv: this.options.sourceEnv,
      phaseEnv: input.phaseEnv,
      allowAccessToken: this.options.allowAccessToken,
    });
    await (this.options.versionChecker ?? assertCodexVersion)(this.config.codex.command, this.config.codex.requiredVersion, runtimeHome.env);
    await (this.options.toolCatalogLoader ?? loadToolCatalogFixture)(join(input.skillRuntime.bundleRoot, 'tool-catalogs', `codex-${this.config.codex.requiredVersion}.json`));
    const owner = await (this.options.ownerFactory ?? AppServerProcessOwner.start)({
      runId: input.runId,
      runtimeHome,
      command: this.config.codex.command,
      args: ['app-server', ...this.config.codex.serverArgs],
      cwd: input.worktreePath,
      supervisorPath: join(dirname(fileURLToPath(import.meta.url)), 'app-server-supervisor.js'),
    });
    this.owners.set(input.runId, owner);
    return owner;
  }

  private async manifestFor(input: CodexExecutionRunInputV2) {
    const loaded = await loadPackageSkillBundle();
    const manifest = resolve(input.skillRuntime.bundleRoot) === resolve(loaded.bundleRoot)
      ? loaded.manifest
      : await verifyMaterializedSkillBundle(input.skillRuntime.bundleRoot, input.skillRuntime.bundleHash);
    if (manifest.bundleHash !== input.skillRuntime.bundleHash || manifest.package.version !== input.skillRuntime.packageVersion) {
      throw new Error('orchestrator-skill-runtime-pinned-bundle-mismatch');
    }
    return manifest;
  }

  private async contextForNode(sourcePath: string, nodeId: string, ordinal: number, extra: Record<string, unknown> = {}): Promise<string> {
    const parsed = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>;
    const targetPath = `${sourcePath}.node-${ordinal}-${nodeId}.json`;
    await writeDurableAtomicFile(targetPath, `${JSON.stringify({ ...parsed, nodeId, ...extra }, null, 2)}\n`);
    return targetPath;
  }

  private async executeReviewTemplate(
    owner: AppServerOwner,
    input: CodexExecutionRunInputV2,
    manifest: RuntimeSkillBundleManifestV1,
    initialProgress: GraphProgressRecordV2,
    executionIndex: number,
    journal?: SkillRuntimeStateJournal,
    signal?: AbortSignal,
  ): Promise<{ progress: GraphProgressRecordV2; result: CodexExecutionRunResultV2 }> {
    const expanded = expandReviewTemplate(manifest, 'code-review');
    const reviewNode = graphNode(manifest, initialProgress);
    let progress = initialProgress;
    let lastResult: CodexExecutionRunResultV2 | undefined;
    for (let wave = 0; wave < expanded.length; wave += 1) {
      const runnable = runnableReviewNodes(expanded, progress);
      if (runnable.length === 0) break;
      const prepared = [] as Array<{
        reviewer: (typeof runnable)[number];
        reviewInput: CodexExecutionRunInputV2;
        executionId?: string;
      }>;
      for (let index = 0; index < runnable.length; index += 1) {
        const reviewer = runnable[index]!;
        const contextArtifactPath = await this.contextForNode(
          input.contextArtifactPath,
          reviewer.id,
          executionIndex + wave + index + 1,
          { reviewNode: reviewer },
        );
        const reviewInput: CodexExecutionRunInputV2 = {
          ...input,
          nodeId: reviewer.id,
          attemptId: `${input.attemptId}-review-${reviewer.id}`,
          manifestNode: reviewNode,
          contextArtifactPath,
          reportPath: this.nodeArtifactPath(input.reportPath, reviewer.id, executionIndex + wave + index + 1),
          logPath: this.nodeArtifactPath(input.logPath, reviewer.id, executionIndex + wave + index + 1),
          ...(reviewer.mode === 'closure'
            ? { resumeThreadId: progress.reviewers.find((item) => item.reviewerSlot === reviewer.reviewerSlot && item.mode === 'full')?.threadId }
            : {}),
        };
        const executionId = journal ? await journal.prepare({ ...reviewInput, nodeId: 'code-review' }) : undefined;
        if (journal && executionId) await this.markJournalRunning(journal, owner, reviewInput.attemptId, executionId);
        prepared.push({ reviewer, reviewInput, executionId });
      }
      const settled = await Promise.allSettled(prepared.map(async ({ reviewer, reviewInput, executionId }) => {
        const result = await this.runSessionWithRecovery(owner, reviewInput, signal, journal, executionId);
        if (result.exitCode !== 0 || result.status !== 'completed' || !result.controlEnvelope) {
          throw new Error(`orchestrator-review-node-failed:${reviewer.id}`);
        }
        if (result.controlEnvelope.nodeId !== reviewer.id || !['approved', 'needs-work', 'rejected'].includes(result.controlEnvelope.outcome)) {
          throw new Error(`orchestrator-review-node-envelope-invalid:${reviewer.id}`);
        }
        const findingIds = (result.controlEnvelope.result as Record<string, unknown>).findingIds;
        if (!Array.isArray(findingIds) || findingIds.some((item) => typeof item !== 'string' || item.length === 0)
          || new Set(findingIds).size !== findingIds.length
          || findingIds.some((item, index) => index > 0 && findingIds[index - 1]! > item)) {
          throw new Error(`orchestrator-review-node-result-invalid:${reviewer.id}`);
        }
        return { reviewer, result, findingIds };
      }));
      const failed = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
      if (failed) throw failed.reason;
      const results = settled.map((item) => (item as PromiseFulfilledResult<{
        reviewer: (typeof runnable)[number]; result: CodexExecutionRunResultV2; findingIds: string[];
      }>).value);
      for (const item of results) {
        if (item.reviewer.mode === 'closure' && item.result.controlEnvelope!.outcome !== 'approved') {
          throw new Error(`orchestrator-review-closure-unresolved:${item.reviewer.id}`);
        }
        progress = recordReviewNodeResult(expanded, progress, {
          nodeId: item.reviewer.id,
          reviewerId: `${input.runId}:${item.reviewer.reviewerSlot}`,
          threadId: item.result.threadId ?? `${input.runId}:${item.reviewer.id}`,
          verdict: item.result.controlEnvelope!.outcome === 'approved' ? 'Approved' : item.result.controlEnvelope!.outcome === 'rejected' ? 'Rejected' : 'Needs Work',
          findingIds: [...new Set(item.findingIds)],
        });
        lastResult = item.result;
      }
      if (journal) await journal.persistReviewProgress(progress);
      if (results.some((item) => item.reviewer.mode === 'full'
        && (item.result.controlEnvelope!.outcome !== 'approved' || item.findingIds.length > 0))) {
        lastResult = await this.executeReviewRepair(owner, input, manifest, progress, wave + 1, journal, signal);
      }
    }
    if (!lastResult) throw new Error('orchestrator-review-template-produced-no-result');
    return { progress, result: lastResult };
  }

  private async executeReviewRepair(
    owner: AppServerOwner,
    input: CodexExecutionRunInputV2,
    manifest: RuntimeSkillBundleManifestV1,
    progress: GraphProgressRecordV2,
    ordinal: number,
    journal?: SkillRuntimeStateJournal,
    signal?: AbortSignal,
  ): Promise<CodexExecutionRunResultV2> {
    const signedNode = manifest.graphs[progress.graphId]?.nodes.find((node) => node.id === 'spec-implementer');
    if (!signedNode) throw new Error('orchestrator-review-repair-node-missing');
    const profile = input.config.codex.profiles[input.phase];
    const manifestNode = {
      ...signedNode,
      executionPolicy: intersectExecutionPolicy(signedNode.executionPolicy, input.targetPolicy, {
        model: profile?.model ?? null,
        effort: profile?.effort ?? null,
        timeoutMs: profile?.timeoutMs ?? input.config.codex.timeoutMs,
        idleTimeoutMs: profile?.idleTimeoutMs ?? input.config.codex.idleTimeoutMs,
      }),
    };
    const nodeId = `review-repair-${ordinal}`;
    const contextArtifactPath = await this.contextForNode(input.contextArtifactPath, nodeId, 100 + ordinal, {
      reviewRepair: { findingIds: progress.findings, reviewers: progress.reviewers },
    });
    const repairInput: CodexExecutionRunInputV2 = {
      ...input,
      nodeId,
      attemptId: `${input.attemptId}-${nodeId}`,
      manifestNode,
      contextArtifactPath,
      reportPath: this.nodeArtifactPath(input.reportPath, nodeId, 100 + ordinal),
      logPath: this.nodeArtifactPath(input.logPath, nodeId, 100 + ordinal),
    };
    const executionId = journal ? await journal.prepare({ ...repairInput, nodeId: 'code-review' }) : undefined;
    if (journal && executionId) await this.markJournalRunning(journal, owner, repairInput.attemptId, executionId);
    const result = await this.runSessionWithRecovery(owner, repairInput, signal, journal, executionId);
    if (result.exitCode !== 0 || result.status !== 'completed' || result.controlEnvelope?.nodeId !== nodeId
      || result.controlEnvelope.outcome !== 'succeeded') throw new Error(`orchestrator-review-repair-failed:${nodeId}`);
    return result;
  }

  private nodeArtifactPath(basePath: string, nodeId: string, ordinal: number): string {
    return `${basePath}.node-${ordinal}-${nodeId}`;
  }
}
