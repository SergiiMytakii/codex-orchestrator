import { canonicalJson, sha256 } from './containment.js';
import {
  type MalformedRepairInputV1,
  type RouteArtifactRefV1,
  type RouteExecutionV1,
  type RouteReceiptV1,
} from './route-decision.js';
import { validateTriageRoute, type TriageRouteV1 } from './triage-route.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import type { ContainedReportOperation, ContainedReportOperationResult } from './contained-report-operation.js';

export type { ContainedReportOperation, MalformedRepairInputV1, RouteArtifactRefV1, RouteExecutionV1, RouteReceiptV1 };

export type RouteCoordinatorResult =
  | { status: 'succeeded'; receipt: RouteReceiptV1 }
  | { status: 'repairable'; code: 'triage-artifact-invalid'; findings: string[] }
  | { status: 'retryable'; owner: 'triage'; code: string }
  | { status: 'safe-halt'; process: Extract<ContainedReportOperationResult, { status: 'safe-halt' }>['process'] }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string; evidence: string[] };

export interface RouteCoordinatorState {
  read(): Promise<RouteExecutionV1>;
  compareAndSwap(expected: RouteExecutionV1, next: RouteExecutionV1): Promise<boolean>;
  prepareAttempt(operationId: 'triage', sourceId: string): Promise<string>;
  launchAttempt(attemptId: string, pid: number, processGroupId: number): Promise<void>;
  adopt(expected: RouteExecutionV1, next: RouteExecutionV1, resultSha256: string): Promise<boolean>;
  clearAttempt(): Promise<void>;
  complete(expected: RouteExecutionV1, next: RouteExecutionV1, receipt: RouteReceiptV1, resultSha256: string): Promise<boolean>;
  cancel(expected: RouteExecutionV1): Promise<boolean>;
}

export interface RouteReceiptInput {
  artifact: TriageRouteV1;
  triage: RouteArtifactRefV1;
  decidedAt: string;
}

export interface RouteCoordinatorDependencies {
  state: RouteCoordinatorState;
  operation: ContainedReportOperation;
  now(): string;
  createReceipt(input: RouteReceiptInput): RouteReceiptV1;
}

export interface RouteCoordinatorInput {
  runId: string;
  worktreePath: string;
  workflowGeneration: WorkflowGenerationReceipt;
  promptFacts: string[];
  signal: AbortSignal;
}

const TRIAGE_AUTHORITY_FACTS = [
  'inspect=issue-body-and-comments',
  'inspect=relevant-implementation-callers-and-tests',
  'inspect=repository-instructions-context-domain-adrs-and-existing-behavior',
  'unavailable-evidence=record-inspected-absence',
  'technical-and-reversible-engineering-choices=resolve-autonomously',
  'source-supported-interpretation=choose-and-record-assumption',
  'product-decision-gap=spec-required',
] as const;

export function initialRouteExecution(): RouteExecutionV1 {
  return { version: 1, phase: 'triage-ready', triageRepairs: 0, triageTransportRetries: 0 };
}

export class RouteCoordinator {
  constructor(private readonly dependencies: RouteCoordinatorDependencies) {}

  async run(input: RouteCoordinatorInput): Promise<RouteCoordinatorResult> {
    const execution = await this.dependencies.state.read();
    if (execution.phase === 'route-complete') {
      return blocked('safety', 'route-coordinator-already-complete', ['Routed state must dispatch without rerunning triage.']);
    }
    return this.launchTriage(input, execution, execution.phase === 'malformed-repair-ready'
      ? { kind: 'malformed', findings: execution.findings }
      : null);
  }

  private async launchTriage(
    input: RouteCoordinatorInput,
    ready: Exclude<RouteExecutionV1, { phase: 'route-complete' }>,
    repairInput: MalformedRepairInputV1 | null,
  ): Promise<RouteCoordinatorResult> {
    const attemptId = await this.dependencies.state.prepareAttempt('triage', repairInput ? `malformed:${ready.triageRepairs}` : 'initial');
    const result = await this.dependencies.operation.run({
      operation: 'triage', attemptId, runId: input.runId, worktreePath: input.worktreePath,
      workflowGeneration: input.workflowGeneration,
      promptFacts: [...input.promptFacts, ...TRIAGE_AUTHORITY_FACTS,
        ...(repairInput ? [`repairKind=malformed`, `repairFindings=${canonicalJson(repairInput.findings)}`] : [])],
      signal: input.signal,
      onLaunched: ({ pid, processGroupId }) => this.dependencies.state.launchAttempt(attemptId, pid, processGroupId),
    });
    if (result.status === 'cancelled') return this.cancel(ready);
    if (result.status === 'blocked') return blocked(result.kind, result.code, []);
    if (result.status === 'retryable') return this.retry(ready, repairInput, result.code);
    if (result.status === 'safe-halt') return result;
    if (result.attemptId !== attemptId) return blocked('safety', 'route-attempt-mismatch', [`Expected ${attemptId} but operation returned ${result.attemptId}.`]);
    if (result.status === 'invalid') return this.invalid(ready, repairInput, result.findings, result.repairInput?.originalReportSha256);
    let artifact: TriageRouteV1;
    try { artifact = validateTriageRoute(result.validatedPayload); }
    catch (error) { return this.invalid(ready, repairInput, [finding(error)]); }
    if (artifact.status === 'blocked') return blocked(artifact.blocker.kind, artifact.blocker.code, artifact.blocker.evidence);
    const triage: RouteArtifactRefV1 = {
      operation: 'triage', attemptId, artifactSha256: result.artifactSha256,
      generationHash: input.workflowGeneration.generationHash,
    };
    let receipt: RouteReceiptV1;
    try { receipt = this.dependencies.createReceipt({ artifact, triage, decidedAt: this.dependencies.now() }); }
    catch (error) { return blocked('safety', 'route-receipt-creation-failed', [finding(error)]); }
    const complete: RouteExecutionV1 = { ...budgets(ready), phase: 'route-complete', triage };
    if (!await this.dependencies.state.complete(ready, complete, receipt, result.artifactSha256)) return stateConflict();
    await this.dependencies.state.clearAttempt();
    return { status: 'succeeded', receipt };
  }

  private async invalid(
    ready: Exclude<RouteExecutionV1, { phase: 'route-complete' }>,
    repairInput: MalformedRepairInputV1 | null,
    findings: string[],
    resultSha256 = sha256(canonicalJson(findings)),
  ): Promise<RouteCoordinatorResult> {
    findings = findings.length ? findings : ['Triage artifact validation failed.'];
    if (repairInput || ready.triageRepairs === 1) return blocked('exhausted', 'triage-repair-exhausted', findings);
    const next: RouteExecutionV1 = { ...budgets(ready), phase: 'malformed-repair-ready', findings, triageRepairs: 1 };
    if (!await this.dependencies.state.adopt(ready, next, resultSha256)) return stateConflict();
    await this.dependencies.state.clearAttempt();
    return { status: 'repairable', code: 'triage-artifact-invalid', findings };
  }

  private async retry(ready: Exclude<RouteExecutionV1, { phase: 'route-complete' }>, repairInput: MalformedRepairInputV1 | null, code: string): Promise<RouteCoordinatorResult> {
    if (ready.triageTransportRetries === 1) return blocked('exhausted', 'triage-transport-retries-exhausted', [code]);
    const next: RouteExecutionV1 = repairInput
      ? { ...budgets(ready), phase: 'malformed-repair-ready', findings: repairInput.findings, triageTransportRetries: 1 }
      : { ...budgets(ready), phase: 'triage-ready', triageTransportRetries: 1 };
    if (!await this.dependencies.state.adopt(ready, next, sha256(canonicalJson({ code })))) return stateConflict();
    await this.dependencies.state.clearAttempt();
    return { status: 'retryable', owner: 'triage', code };
  }

  private async cancel(expected: RouteExecutionV1): Promise<RouteCoordinatorResult> {
    if (!await this.dependencies.state.cancel(expected)) return stateConflict();
    return { status: 'cancelled' };
  }
}

function budgets(execution: RouteExecutionV1) {
  return { version: execution.version, triageRepairs: execution.triageRepairs, triageTransportRetries: execution.triageTransportRetries };
}

function blocked(kind: 'external' | 'safety' | 'exhausted', code: string, evidence: string[]): RouteCoordinatorResult {
  return { status: 'blocked', kind, code, evidence };
}

function stateConflict(): RouteCoordinatorResult {
  return blocked('safety', 'route-state-conflict', ['Durable route state changed before compare-and-swap.']);
}

function finding(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'route validation failed';
}
