import { canonicalJson, sha256 } from './containment.js';
import type { WorkflowExecutionProfile, WorkflowGenerationReceipt, WorkflowOperationPolicy } from './workflow-assets.js';

const POLICY_KEYS = [
  'sandboxMode', 'cwdClass', 'worktreeAccess', 'writableRootClasses', 'runnerPostcondition',
  'network', 'networkHosts', 'mcpTools', 'approvalCeiling', 'externalWrite',
] as const;

export type ContainedReportOperationId = 'triage' | 'ambiguity-review' | 'code-review' | 'spec-review';

export interface ReportOnlyWorktreeSnapshot {
  headSha: string; indexTreeSha: string; trackedContentSha256: string;
  untrackedContentSha256: string; worktreeIdentity: string;
}

export interface DurableReportInvocationV1 {
  version: 1;
  operation: ContainedReportOperationId; attemptId: string;
  generationHash: string; promptFactsSha256: string; reportPath: string;
  phase: 'prepared' | 'launched';
  host: string; bootId: string; preparedAt: string; launchedAt: string | null;
  pid: number | null; processStartIdentity: string | null; processGroupId: number | null;
  baseline: ReportOnlyWorktreeSnapshot;
}

export interface DurableReportInvocationState {
  read(): Promise<DurableReportInvocationV1 | undefined>;
  compareAndSwap(expected: DurableReportInvocationV1 | undefined,
    next: DurableReportInvocationV1 | undefined): Promise<boolean>;
}

export interface ContainedReportOperationInput {
  operation: ContainedReportOperationId;
  runId: string;
  worktreePath: string;
  workflowGeneration: WorkflowGenerationReceipt;
  promptFacts: string[];
  signal: AbortSignal;
  invocationState: DurableReportInvocationState;
  forbiddenAttemptIds?: string[];
}

export type ContainedReportOperationResult =
  | { status: 'completed'; attemptId: string; reportBytes: Buffer; reportSha256: string }
  | { status: 'retryable'; code: string }
  | { status: 'safe-halt'; code: string }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety'; code: string };

export interface ContainedReportOperation { run(input: ContainedReportOperationInput): Promise<ContainedReportOperationResult> }

export interface PreparedContainedReportAttempt {
  operation: ContainedReportOperationId;
  generationHash: string;
  policy: WorkflowOperationPolicy;
  reportPath: string;
  workflowRoot?: string; operationPath?: string; schemaPath?: string;
  toolHome?: string; tmpDir?: string; profile?: WorkflowExecutionProfile;
}

export type ContainedReportLaunchResult =
  | { status: 'completed'; reportBytes: Buffer }
  | { status: 'retryable'; code: string }
  | { status: 'safe-halt' }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety'; code: string };

export type ProcessIdentityObservation =
  | { status: 'present'; processStartIdentity: string; processGroupAlive: boolean | 'unknown' }
  | { status: 'absent'; processGroupAlive: false }
  | { status: 'unknown' };

export type ReportObservation =
  | { status: 'available'; bytes: Buffer }
  | { status: 'absent' }
  | { status: 'unknown' };

export interface ContainedReportOperationDependencies {
  host: string;
  bootId: string;
  now(): string;
  createAttemptId(): string;
  prepare(input: { operation: ContainedReportOperationId; attemptId: string; runId: string; workflowGeneration: WorkflowGenerationReceipt }): Promise<PreparedContainedReportAttempt>;
  snapshot(worktreePath: string): Promise<unknown>;
  readReport(path: string): Promise<ReportObservation>;
  settleAttempt(attempt: PreparedContainedReportAttempt): Promise<void>;
  processStartIdentity(pid: number): Promise<string | undefined>;
  inspectProcess(invocation: DurableReportInvocationV1): Promise<ProcessIdentityObservation>;
  launch(input: ContainedReportOperationInput & { attempt: PreparedContainedReportAttempt;
    onSpawned(identity: { pid: number; processGroupId: number }): Promise<void> }): Promise<ContainedReportLaunchResult>;
}

export class InjectedContainedReportOperation implements ContainedReportOperation {
  constructor(private readonly dependencies: ContainedReportOperationDependencies) {}

  async run(input: ContainedReportOperationInput): Promise<ContainedReportOperationResult> {
    const existing = await input.invocationState.read();
    if (existing) return this.recover(input, validateDurableReportInvocation(existing));
    return this.launch(input);
  }

  private async launch(input: ContainedReportOperationInput): Promise<ContainedReportOperationResult> {
    let baseline: ReportOnlyWorktreeSnapshot;
    try { baseline = requireReportSnapshot(await this.dependencies.snapshot(input.worktreePath)); }
    catch { return blocked('safety', 'report-operation-snapshot-failed'); }
    const attemptId = this.dependencies.createAttemptId();
    if (!attemptId || input.forbiddenAttemptIds?.includes(attemptId)) return blocked('safety', 'report-operation-attempt-identity-invalid');
    let attempt: PreparedContainedReportAttempt;
    try { attempt = await this.prepare(input, attemptId); }
    catch (error) {
      return error instanceof ReportAuthorityError
        ? blocked('safety', 'report-operation-authority-drift')
        : blocked('external', 'report-operation-prepare-failed');
    }
    const prepared: DurableReportInvocationV1 = {
      version: 1, operation: input.operation, attemptId, generationHash: input.workflowGeneration.generationHash,
      promptFactsSha256: promptFactsSha256(input.promptFacts),
      reportPath: attempt.reportPath, phase: 'prepared', host: this.dependencies.host, bootId: this.dependencies.bootId,
      preparedAt: this.dependencies.now(), launchedAt: null, pid: null, processStartIdentity: null,
      processGroupId: null, baseline,
    };
    if (!await input.invocationState.compareAndSwap(undefined, prepared)) return blocked('safety', 'report-operation-state-conflict');
    let current = prepared;
    let result: ContainedReportLaunchResult;
    try {
      result = await this.dependencies.launch({
        ...input,
        attempt,
        onSpawned: async ({ pid, processGroupId }) => {
          const processStartIdentity = await this.dependencies.processStartIdentity(pid);
          if (!processStartIdentity) throw new Error('report process identity unavailable');
          const launched: DurableReportInvocationV1 = {
            ...prepared, phase: 'launched', launchedAt: this.dependencies.now(), pid, processStartIdentity, processGroupId,
          };
          if (!await input.invocationState.compareAndSwap(prepared, launched)) throw new Error('report launch state conflict');
          current = launched;
        },
      });
    } catch { result = { status: 'retryable', code: 'report-operation-launch-failed' }; }
    if (result.status === 'completed') return this.finish(input, current, attempt, result.reportBytes);
    if (result.status === 'safe-halt') return { status: 'safe-halt', code: 'report-operation-process-unresolved' };
    if (result.status === 'cancelled' || result.status === 'blocked') {
      const abandoned = await this.abandon(input, current, attempt);
      if (abandoned) return abandoned;
      return result;
    }
    const recovered = await this.observeReport(current.reportPath);
    if (recovered.status === 'unknown') return { status: 'safe-halt', code: 'report-operation-report-observation-unknown' };
    if (recovered.status === 'available') return this.finish(input, current, attempt, recovered.bytes);
    const abandoned = await this.abandon(input, current, attempt);
    if (abandoned) return abandoned;
    return result;
  }

  private async recover(input: ContainedReportOperationInput, invocation: DurableReportInvocationV1): Promise<ContainedReportOperationResult> {
    if (invocation.operation !== input.operation || invocation.generationHash !== input.workflowGeneration.generationHash
      || invocation.host !== this.dependencies.host || invocation.bootId !== this.dependencies.bootId) {
      return { status: 'safe-halt', code: 'report-operation-owner-identity-unresolved' };
    }
    if (invocation.promptFactsSha256 !== promptFactsSha256(input.promptFacts)) {
      return { status: 'safe-halt', code: 'report-operation-prompt-facts-drift' };
    }
    let attempt: PreparedContainedReportAttempt;
    try { attempt = await this.prepare(input, invocation.attemptId); }
    catch (error) {
      return error instanceof ReportAuthorityError
        ? blocked('safety', 'report-operation-authority-drift')
        : blocked('external', 'report-operation-prepare-failed');
    }
    if (attempt.reportPath !== invocation.reportPath) return blocked('safety', 'report-operation-report-path-drift');
    const report = await this.observeReport(invocation.reportPath);
    if (report.status === 'unknown') return { status: 'safe-halt', code: 'report-operation-report-observation-unknown' };
    if (invocation.phase === 'prepared') {
      if (report.status === 'available') return this.finish(input, invocation, attempt, report.bytes);
      if (!await this.settleAttempt(attempt)) return { status: 'safe-halt', code: 'report-operation-attempt-cleanup-failed' };
      if (!await input.invocationState.compareAndSwap(invocation, undefined)) return blocked('safety', 'report-operation-state-conflict');
      return { status: 'retryable', code: 'report-operation-prepared-attempt-abandoned' };
    }
    const unresolved = await this.unresolvedProcess(invocation);
    if (unresolved) return unresolved;
    if (report.status === 'available') return this.finish(input, invocation, attempt, report.bytes);
    if (!await this.settleAttempt(attempt)) return { status: 'safe-halt', code: 'report-operation-attempt-cleanup-failed' };
    if (!await input.invocationState.compareAndSwap(invocation, undefined)) return blocked('safety', 'report-operation-state-conflict');
    return { status: 'retryable', code: 'report-operation-output-unavailable' };
  }

  private async abandon(input: ContainedReportOperationInput, invocation: DurableReportInvocationV1,
    attempt: PreparedContainedReportAttempt): Promise<ContainedReportOperationResult | undefined> {
    if (invocation.phase === 'launched') {
      const unresolved = await this.unresolvedProcess(invocation);
      if (unresolved) return unresolved;
    }
    if (!await this.settleAttempt(attempt)) return { status: 'safe-halt', code: 'report-operation-attempt-cleanup-failed' };
    if (!await input.invocationState.compareAndSwap(invocation, undefined)) return blocked('safety', 'report-operation-state-conflict');
    return undefined;
  }

  private async observeReport(path: string): Promise<ReportObservation> {
    try { return await this.dependencies.readReport(path); }
    catch { return { status: 'unknown' }; }
  }

  private async unresolvedProcess(invocation: DurableReportInvocationV1): Promise<ContainedReportOperationResult | undefined> {
    const observed = await this.dependencies.inspectProcess(invocation).catch(() => ({ status: 'unknown' as const }));
    if (observed.status === 'unknown') return { status: 'safe-halt', code: 'report-operation-process-observation-unknown' };
    if (observed.status === 'present' && (observed.processStartIdentity === invocation.processStartIdentity || observed.processGroupAlive !== false)) {
      return { status: 'safe-halt', code: 'report-operation-process-active-or-uncertain' };
    }
    return observed.status === 'absent' && observed.processGroupAlive !== false
      ? { status: 'safe-halt', code: 'report-operation-process-group-unresolved' } : undefined;
  }

  private async settleAttempt(attempt: PreparedContainedReportAttempt): Promise<boolean> {
    try { await this.dependencies.settleAttempt(attempt); return true; }
    catch { return false; }
  }

  private async prepare(input: ContainedReportOperationInput, attemptId: string): Promise<PreparedContainedReportAttempt> {
    const attempt = await this.dependencies.prepare({
      operation: input.operation, attemptId, runId: input.runId, workflowGeneration: input.workflowGeneration,
    });
    if (!hasExactReadOnlyAuthority(attempt, input) || !attempt.reportPath) throw new ReportAuthorityError();
    return attempt;
  }

  private async finish(input: ContainedReportOperationInput, invocation: DurableReportInvocationV1,
    attempt: PreparedContainedReportAttempt, reportBytes: Buffer): Promise<ContainedReportOperationResult> {
    let after: ReportOnlyWorktreeSnapshot;
    try { after = requireReportSnapshot(await this.dependencies.snapshot(input.worktreePath)); }
    catch { return blocked('safety', 'report-operation-snapshot-failed'); }
    if (canonicalJson(invocation.baseline) !== canonicalJson(after)) return blocked('safety', 'report-operation-worktree-mutated');
    if (!await this.settleAttempt(attempt)) return { status: 'safe-halt', code: 'report-operation-attempt-cleanup-failed' };
    return { status: 'completed', attemptId: invocation.attemptId, reportBytes: Buffer.from(reportBytes), reportSha256: sha256(reportBytes) };
  }
}

export type MutableWorktreeOperationId = 'qualification-repair' | 'implementation' | 'review-feedback-implementation';
export interface MutableInvocationContextV1 { repairOnly: boolean; reworkFindings: string[] }
export interface DurableMutableInvocationV1 {
  version: 1; operation: MutableWorktreeOperationId;
  attemptId: string; generationHash: string; promptFactsSha256: string; worktreePath: string; reportPath: string;
  context: MutableInvocationContextV1;
  phase: 'prepared' | 'launched' | 'adopted';
  host: string; bootId: string; preparedAt: string; launchedAt: string | null;
  pid: number | null; processStartIdentity: string | null; processGroupId: number | null;
  baseline: ReportOnlyWorktreeSnapshot;
  reportSha256: string | null; resultSnapshot: ReportOnlyWorktreeSnapshot | null;
}
export interface DurableMutableInvocationState {
  read(): Promise<DurableMutableInvocationV1 | undefined>; compareAndSwap(expected: DurableMutableInvocationV1 | undefined,
    next: DurableMutableInvocationV1 | undefined): Promise<boolean>;
}
export interface ContainedMutableOperationInput {
  operation: MutableWorktreeOperationId; runId: string; worktreePath: string;
  workflowGeneration: WorkflowGenerationReceipt; promptFacts: string[]; signal: AbortSignal;
  context: MutableInvocationContextV1;
  invocationState: DurableMutableInvocationState; beforeLaunch?: () => Promise<void>;
}
export type ContainedMutableOperationResult =
  | { status: 'completed'; attemptId: string; reportBytes: Buffer }
  | { status: 'retryable'; code: string }
  | { status: 'safe-halt'; code: string }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety'; code: string };
export type ContainedMutableSettlementResult =
  | { status: 'settled' }
  | { status: 'safe-halt'; code: string };
export type PreparedContainedMutableAttempt = Omit<PreparedContainedReportAttempt, 'operation'> & { operation: 'qualification-repair' | 'implementation' };
export type ContainedMutableLaunchResult =
  | { status: 'completed'; reportBytes: Buffer }
  | { status: 'retryable'; code: string }
  | { status: 'safe-halt' }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety'; code: string };
export interface ContainedMutableOperationDependencies {
  host: string; bootId: string; now(): string; createAttemptId(): string;
  prepare(input: { operation: 'qualification-repair' | 'implementation'; attemptId: string; runId: string;
    workflowGeneration: WorkflowGenerationReceipt }): Promise<PreparedContainedMutableAttempt>;
  snapshot(worktreePath: string): Promise<unknown>; readReport(path: string): Promise<ReportObservation>;
  processStartIdentity(pid: number): Promise<string | undefined>; inspectProcess(invocation: DurableMutableInvocationV1): Promise<ProcessIdentityObservation>;
  launch(input: ContainedMutableOperationInput & { attempt: PreparedContainedMutableAttempt;
    onSpawned(identity: { pid: number; processGroupId: number }): Promise<void> }): Promise<ContainedMutableLaunchResult>;
}
export class InjectedContainedMutableOperation {
  constructor(private readonly dependencies: ContainedMutableOperationDependencies) {}
  async run(input: ContainedMutableOperationInput): Promise<ContainedMutableOperationResult> {
    const existing = await input.invocationState.read();
    return existing ? this.recover(input, validateDurableMutableInvocation(existing)) : this.launch(input);
  }
  async settle(input: ContainedMutableOperationInput): Promise<ContainedMutableSettlementResult> {
    const existing = await input.invocationState.read();
    if (!existing) return { status: 'settled' };
    const recovered = await this.recover(input, validateDurableMutableInvocation(existing));
    if (recovered.status === 'retryable') {
      return await input.invocationState.read() === undefined
        ? { status: 'settled' }
        : { status: 'safe-halt', code: 'mutable-operation-state-conflict' };
    }
    if (recovered.status === 'completed') {
      const adopted = await input.invocationState.read();
      if (!adopted || adopted.attemptId !== recovered.attemptId || adopted.phase !== 'adopted') {
        return { status: 'safe-halt', code: 'mutable-operation-state-conflict' };
      }
      return await input.invocationState.compareAndSwap(adopted, undefined)
        ? { status: 'settled' }
        : { status: 'safe-halt', code: 'mutable-operation-state-conflict' };
    }
    return { status: 'safe-halt', code: recovered.status === 'cancelled'
      ? 'mutable-operation-settlement-cancelled' : recovered.code };
  }
  private async launch(input: ContainedMutableOperationInput): Promise<ContainedMutableOperationResult> {
    let baseline: ReportOnlyWorktreeSnapshot;
    try { baseline = requireReportSnapshot(await this.dependencies.snapshot(input.worktreePath)); }
    catch { return blocked('safety', 'mutable-operation-snapshot-failed'); }
    const attemptId = this.dependencies.createAttemptId();
    if (!attemptId) return blocked('safety', 'mutable-operation-attempt-identity-invalid');
    let attempt: PreparedContainedMutableAttempt;
    try { attempt = await this.prepare(input, attemptId); }
    catch (error) { return error instanceof ReportAuthorityError
      ? blocked('safety', 'mutable-operation-authority-drift') : blocked('external', 'mutable-operation-prepare-failed'); }
    const prepared: DurableMutableInvocationV1 = {
      version: 1, operation: input.operation, attemptId, generationHash: input.workflowGeneration.generationHash,
      promptFactsSha256: promptFactsSha256(input.promptFacts), worktreePath: input.worktreePath, reportPath: attempt.reportPath,
      context: structuredClone(input.context),
      phase: 'prepared', host: this.dependencies.host, bootId: this.dependencies.bootId, preparedAt: this.dependencies.now(),
      launchedAt: null, pid: null, processStartIdentity: null, processGroupId: null, baseline, reportSha256: null, resultSnapshot: null,
    };
    if (!await input.invocationState.compareAndSwap(undefined, prepared)) return blocked('safety', 'mutable-operation-state-conflict');
    let current = prepared;
    let result: ContainedMutableLaunchResult;
    try {
      await input.beforeLaunch?.();
      result = await this.dependencies.launch({
        ...input, attempt,
        onSpawned: async ({ pid, processGroupId }) => {
          const processStartIdentity = await this.dependencies.processStartIdentity(pid);
          if (!processStartIdentity) throw new Error('mutable process identity unavailable');
          const launched: DurableMutableInvocationV1 = { ...prepared, phase: 'launched', launchedAt: this.dependencies.now(),
            pid, processStartIdentity, processGroupId };
          if (!await input.invocationState.compareAndSwap(prepared, launched)) throw new Error('mutable launch state conflict');
          current = launched;
        },
      });
    } catch { return { status: 'retryable', code: 'mutable-operation-launch-failed' }; }
    if (result.status === 'completed') return current.phase === 'launched'
      ? this.adopt(input, current, result.reportBytes)
      : { status: 'safe-halt', code: 'mutable-operation-launch-unfenced' };
    if (result.status === 'safe-halt') return { status: 'safe-halt', code: 'mutable-operation-process-unresolved' };
    if (result.status === 'cancelled' || result.status === 'blocked') {
      const unresolved = current.phase === 'launched' ? await this.unresolvedProcess(current) : undefined;
      if (unresolved) return unresolved;
      const snapshot = await this.stableSnapshot(input.worktreePath);
      if (!snapshot || canonicalJson(snapshot) !== canonicalJson(current.baseline))
        return { status: 'safe-halt', code: 'mutable-operation-abandonment-ambiguous' };
      if (!await input.invocationState.compareAndSwap(current, undefined)) return blocked('safety', 'mutable-operation-state-conflict');
    }
    return result;
  }
  private async recover(input: ContainedMutableOperationInput, invocation: DurableMutableInvocationV1): Promise<ContainedMutableOperationResult> {
    if (invocation.operation !== input.operation
      || invocation.generationHash !== input.workflowGeneration.generationHash || invocation.promptFactsSha256 !== promptFactsSha256(input.promptFacts)
      || canonicalJson(invocation.context) !== canonicalJson(input.context)
      || invocation.worktreePath !== input.worktreePath || invocation.host !== this.dependencies.host || invocation.bootId !== this.dependencies.bootId)
      return { status: 'safe-halt', code: 'mutable-operation-correlation-drift' };
    let attempt: PreparedContainedMutableAttempt;
    try { attempt = await this.prepare(input, invocation.attemptId); }
    catch { return { status: 'safe-halt', code: 'mutable-operation-prepare-recovery-failed' }; }
    if (attempt.reportPath !== invocation.reportPath) return { status: 'safe-halt', code: 'mutable-operation-report-path-drift' };
    const report = await this.observeReport(invocation.reportPath);
    if (report.status === 'unknown') return { status: 'safe-halt', code: 'mutable-operation-report-observation-unknown' };
    if (invocation.phase === 'adopted') {
      if (report.status !== 'available' || sha256(report.bytes) !== invocation.reportSha256)
        return { status: 'safe-halt', code: 'mutable-operation-adopted-report-drift' };
      const snapshot = await this.stableSnapshot(input.worktreePath);
      if (!snapshot || canonicalJson(snapshot) !== canonicalJson(invocation.resultSnapshot))
        return { status: 'safe-halt', code: 'mutable-operation-adopted-worktree-drift' };
      return this.completeAdopted(input, invocation, report.bytes);
    }
    if (invocation.phase === 'prepared') {
      if (report.status === 'available') return { status: 'safe-halt', code: 'mutable-operation-prepared-report-ambiguous' };
      const snapshot = await this.stableSnapshot(input.worktreePath);
      if (!snapshot || canonicalJson(snapshot) !== canonicalJson(invocation.baseline))
        return { status: 'safe-halt', code: 'mutable-operation-prepared-worktree-ambiguous' };
      if (!await input.invocationState.compareAndSwap(invocation, undefined)) return blocked('safety', 'mutable-operation-state-conflict');
      return { status: 'retryable', code: 'mutable-operation-prepared-attempt-abandoned' };
    }
    const unresolved = await this.unresolvedProcess(invocation);
    if (unresolved) return unresolved;
    if (report.status === 'available') return this.adopt(input, invocation, report.bytes);
    const snapshot = await this.stableSnapshot(input.worktreePath);
    if (!snapshot || canonicalJson(snapshot) !== canonicalJson(invocation.baseline))
      return { status: 'safe-halt', code: 'mutable-operation-worktree-without-report' };
    if (!await input.invocationState.compareAndSwap(invocation, undefined)) return blocked('safety', 'mutable-operation-state-conflict');
    return { status: 'retryable', code: 'mutable-operation-output-unavailable' };
  }
  private async adopt(input: ContainedMutableOperationInput, invocation: DurableMutableInvocationV1,
    reportBytes: Buffer): Promise<ContainedMutableOperationResult> {
    const resultSnapshot = await this.stableSnapshot(input.worktreePath);
    if (!resultSnapshot || resultSnapshot.worktreeIdentity !== invocation.baseline.worktreeIdentity || resultSnapshot.headSha !== invocation.baseline.headSha)
      return { status: 'safe-halt', code: 'mutable-operation-result-worktree-mismatch' };
    const adopted: DurableMutableInvocationV1 = { ...invocation, phase: 'adopted', reportSha256: sha256(reportBytes), resultSnapshot };
    if (!await input.invocationState.compareAndSwap(invocation, adopted)) return blocked('safety', 'mutable-operation-state-conflict');
    return this.completeAdopted(input, adopted, reportBytes);
  }
  private async completeAdopted(input: ContainedMutableOperationInput, invocation: DurableMutableInvocationV1,
    reportBytes: Buffer): Promise<ContainedMutableOperationResult> {
    if (invocation.context.repairOnly && canonicalJson(invocation.baseline) !== canonicalJson(invocation.resultSnapshot)) {
      if (!await input.invocationState.compareAndSwap(invocation, undefined)) return blocked('safety', 'mutable-operation-state-conflict');
      return blocked('safety', 'report-repair-modified-worktree');
    }
    return completedMutable(invocation, reportBytes);
  }
  private async prepare(input: ContainedMutableOperationInput, attemptId: string): Promise<PreparedContainedMutableAttempt> {
    const operation = workerOperation(input.operation);
    const attempt = await this.dependencies.prepare({ operation, attemptId, runId: input.runId, workflowGeneration: input.workflowGeneration });
    if (attempt.operation !== operation || attempt.generationHash !== input.workflowGeneration.generationHash || !hasExactMutableAuthority(attempt.policy)
      || !attempt.reportPath) throw new ReportAuthorityError();
    return attempt;
  }
  private async observeReport(path: string): Promise<ReportObservation> {
    try { return await this.dependencies.readReport(path); } catch { return { status: 'unknown' }; }
  }
  private async stableSnapshot(worktreePath: string): Promise<ReportOnlyWorktreeSnapshot | undefined> {
    try {
      const first = requireReportSnapshot(await this.dependencies.snapshot(worktreePath));
      const second = requireReportSnapshot(await this.dependencies.snapshot(worktreePath));
      return canonicalJson(first) === canonicalJson(second) ? first : undefined;
    } catch { return undefined; }
  }
  private async unresolvedProcess(invocation: DurableMutableInvocationV1): Promise<ContainedMutableOperationResult | undefined> {
    const observed = await this.dependencies.inspectProcess(invocation).catch(() => ({ status: 'unknown' as const }));
    if (observed.status === 'unknown') return { status: 'safe-halt', code: 'mutable-operation-process-observation-unknown' };
    if (observed.status === 'present' && (observed.processStartIdentity === invocation.processStartIdentity || observed.processGroupAlive !== false))
      return { status: 'safe-halt', code: 'mutable-operation-process-active-or-uncertain' };
    return observed.status === 'absent' && observed.processGroupAlive !== false
      ? { status: 'safe-halt', code: 'mutable-operation-process-group-unresolved' } : undefined;
  }
}

export function validateDurableMutableInvocation(value: unknown): DurableMutableInvocationV1 {
  const keys = [
    'version', 'operation', 'attemptId', 'generationHash', 'promptFactsSha256', 'worktreePath', 'reportPath',
    'context', 'phase', 'host', 'bootId', 'preparedAt', 'launchedAt', 'pid', 'processStartIdentity', 'processGroupId', 'baseline',
    'reportSha256', 'resultSnapshot',
  ];
  if (!hasExactKeys(value, keys)) throw new Error('durable mutable invocation is invalid');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !['qualification-repair', 'implementation', 'review-feedback-implementation'].includes(record.operation as string)
    || !nonEmpty(record.attemptId) || !/^[0-9a-f]{64}$/u.test(record.generationHash as string)
    || !/^[0-9a-f]{64}$/u.test(record.promptFactsSha256 as string) || !nonEmpty(record.worktreePath) || !nonEmpty(record.reportPath)
    || !nonEmpty(record.host) || !nonEmpty(record.bootId) || !timestamp(record.preparedAt)
    || !['prepared', 'launched', 'adopted'].includes(record.phase as string)) throw new Error('durable mutable invocation fields are invalid');
  const context = record.context as Record<string, unknown>;
  if (!hasExactKeys(context, ['repairOnly', 'reworkFindings']) || typeof context.repairOnly !== 'boolean'
    || !Array.isArray(context.reworkFindings) || !context.reworkFindings.every(nonEmpty)) {
    throw new Error('durable mutable invocation context is invalid');
  }
  const launched = record.phase === 'launched' || record.phase === 'adopted';
  if (launched !== (positive(record.pid) && positive(record.processGroupId) && nonEmpty(record.processStartIdentity) && timestamp(record.launchedAt)))
    throw new Error('durable mutable invocation process identity is invalid');
  if (!launched && (record.pid !== null || record.processGroupId !== null || record.processStartIdentity !== null || record.launchedAt !== null))
    throw new Error('prepared mutable invocation has process identity');
  const adopted = record.phase === 'adopted';
  if (adopted !== (typeof record.reportSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(record.reportSha256) && record.resultSnapshot !== null)) throw new Error('durable mutable invocation adoption is invalid');
  if (!adopted && (record.reportSha256 !== null || record.resultSnapshot !== null))
    throw new Error('unfinished mutable invocation has adoption evidence');
  requireReportSnapshot(record.baseline);
  if (adopted) requireReportSnapshot(record.resultSnapshot);
  return structuredClone(value as unknown as DurableMutableInvocationV1);
}

export function validateDurableReportInvocation(value: unknown): DurableReportInvocationV1 {
  const keys = [
    'version', 'operation', 'attemptId', 'generationHash', 'promptFactsSha256', 'reportPath', 'phase', 'host', 'bootId', 'preparedAt',
    'launchedAt', 'pid', 'processStartIdentity', 'processGroupId', 'baseline',
  ];
  if (!hasExactKeys(value, keys)) throw new Error('durable report invocation is invalid');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !['triage', 'ambiguity-review', 'code-review', 'spec-review'].includes(record.operation as string)
    || !nonEmpty(record.attemptId) || !/^[0-9a-f]{64}$/u.test(record.generationHash as string)
    || !nonEmpty(record.reportPath) || !nonEmpty(record.host) || !nonEmpty(record.bootId)
    || !/^[0-9a-f]{64}$/u.test(record.promptFactsSha256 as string)
    || !timestamp(record.preparedAt) || !['prepared', 'launched'].includes(record.phase as string)) throw new Error('durable report invocation fields are invalid');
  const launched = record.phase === 'launched';
  if (launched !== (positive(record.pid) && positive(record.processGroupId) && nonEmpty(record.processStartIdentity)
    && timestamp(record.launchedAt))) throw new Error('durable report invocation process identity is invalid');
  if (!launched && (record.pid !== null || record.processGroupId !== null || record.processStartIdentity !== null || record.launchedAt !== null)) {
    throw new Error('prepared report invocation has process identity');
  }
  requireReportSnapshot(record.baseline);
  return structuredClone(value as unknown as DurableReportInvocationV1);
}

function hasExactReadOnlyAuthority(attempt: PreparedContainedReportAttempt, input: ContainedReportOperationInput): boolean {
  const policy = attempt.policy;
  return attempt.operation === input.operation && attempt.generationHash === input.workflowGeneration.generationHash
    && hasExactKeys(policy, POLICY_KEYS) && policy.sandboxMode === 'read-only' && policy.cwdClass === 'worktree'
    && policy.worktreeAccess === 'read-only' && Array.isArray(policy.writableRootClasses) && policy.writableRootClasses.length === 0
    && policy.runnerPostcondition === 'report-only' && policy.network === 'deny' && policy.networkHosts.length === 0
    && policy.mcpTools.length === 0 && policy.approvalCeiling === 'never' && policy.externalWrite === false;
}

function hasExactMutableAuthority(policy: WorkflowOperationPolicy): boolean {
  return hasExactKeys(policy, POLICY_KEYS) && policy.sandboxMode === 'workspace-write' && policy.cwdClass === 'worktree'
    && policy.worktreeAccess === 'write' && canonicalJson(policy.writableRootClasses) === canonicalJson(['worktree'])
    && policy.runnerPostcondition === 'change-set' && policy.network === 'deny' && policy.networkHosts.length === 0
    && policy.mcpTools.length === 0 && policy.approvalCeiling === 'never' && policy.externalWrite === false;
}

function workerOperation(operation: MutableWorktreeOperationId): 'qualification-repair' | 'implementation' {
  return operation === 'qualification-repair' ? operation : 'implementation'; }

function completedMutable(invocation: DurableMutableInvocationV1, reportBytes: Buffer): ContainedMutableOperationResult {
  return { status: 'completed', attemptId: invocation.attemptId, reportBytes: Buffer.from(reportBytes) }; }

function requireReportSnapshot(value: unknown): ReportOnlyWorktreeSnapshot {
  const keys = ['headSha', 'indexTreeSha', 'trackedContentSha256', 'untrackedContentSha256', 'worktreeIdentity'];
  if (!hasExactKeys(value, keys) || !keys.every((key) => nonEmpty((value as Record<string, unknown>)[key]))) throw new Error('report snapshot is invalid');
  return structuredClone(value as unknown as ReportOnlyWorktreeSnapshot);
}

function blocked(kind: 'external' | 'safety', code: string): Extract<ContainedReportOperationResult, { status: 'blocked' }> {
  return { status: 'blocked', kind, code };
}
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function timestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function promptFactsSha256(promptFacts: string[]): string { return sha256(canonicalJson(promptFacts)); }

class ReportAuthorityError extends Error {}
