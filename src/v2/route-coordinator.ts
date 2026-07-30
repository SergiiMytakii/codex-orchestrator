import { canonicalJson, sha256 } from './containment.js';
import {
  validateAmbiguityReviewArtifact,
  type AmbiguityReviewRefV1,
  type AmbiguityReviewArtifactV1,
  type CandidateRepairInputV1,
  type MalformedRepairInputV1,
  type RouteArtifactRefV1,
  type RouteExecutionV1,
  type RouteReceiptV1,
} from './route-decision.js';
import { validateTriageRoute, type TriageRouteV1 } from './triage-route.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import type {
  ContainedReportOperation,
  ContainedReportOperationResult,
} from './contained-report-operation.js';

export type {
  AmbiguityReviewRefV1,
  CandidateRepairInputV1,
  ContainedReportOperation,
  MalformedRepairInputV1,
  RouteArtifactRefV1,
  RouteExecutionV1,
  RouteReceiptV1,
};

export type RouteCoordinatorResult =
  | { status: 'succeeded'; receipt: RouteReceiptV1 }
  | { status: 'repairable'; code: 'triage-artifact-invalid' | 'waiting-candidate-rejected'; findings: string[] }
  | { status: 'retryable'; owner: 'triage' | 'ambiguity-review'; code: string }
  | { status: 'safe-halt'; process: Extract<ContainedReportOperationResult, { status: 'safe-halt' }>['process']; waitForAbsence(): Promise<void> }
  | { status: 'awaiting-user'; receipt: RouteReceiptV1 }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string; evidence: string[] };

export interface RouteCoordinatorState {
  read(): Promise<RouteExecutionV1>;
  compareAndSwap(expected: RouteExecutionV1, next: RouteExecutionV1): Promise<boolean>;
  prepareAttempt(operationId: 'triage' | 'ambiguity-review', sourceId: string): Promise<string>;
  launchAttempt(attemptId: string, pid: number, processGroupId: number): Promise<void>;
  adopt(expected: RouteExecutionV1, next: RouteExecutionV1, resultSha256: string): Promise<boolean>;
  clearAttempt(): Promise<void>;
  complete(expected: RouteExecutionV1, next: RouteExecutionV1, receipt: RouteReceiptV1, resultSha256: string): Promise<boolean>;
  cancel(expected: RouteExecutionV1): Promise<boolean>;
}

export interface RouteReceiptInput {
  artifact: TriageRouteV1;
  triage: RouteArtifactRefV1;
  review: AmbiguityReviewRefV1 | null;
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
  'awaiting-user=two-materially-different-observable-product-outcomes-only',
] as const;

export function initialRouteExecution(): RouteExecutionV1 {
  return {
    version: 1,
    phase: 'triage-ready',
    triageRepairs: 0,
    triageTransportRetries: 0,
    ambiguityTransportRetries: 0,
    candidateReviews: 0,
  };
}

export class RouteCoordinator {
  constructor(private readonly dependencies: RouteCoordinatorDependencies) {}

  async run(input: RouteCoordinatorInput): Promise<RouteCoordinatorResult> {
    const execution = await this.dependencies.state.read();
    switch (execution.phase) {
      case 'triage-ready':
        return this.launchTriage(input, execution, null);
      case 'malformed-repair-ready':
        return this.launchTriage(input, execution, { kind: 'malformed', findings: execution.findings });
      case 'candidate-repair-ready':
        return this.launchTriage(input, execution, {
          kind: 'rejected-candidate',
          candidate: execution.candidate,
          triage: execution.triage,
          review: execution.review,
          findings: execution.findings,
        });
      case 'candidate-ready':
        return this.launchReview(input, execution);
      case 'route-complete':
        return blocked('safety', 'route-coordinator-already-complete', ['Routed state must dispatch without rerunning routing.']);
    }
  }

  private async launchTriage(
    input: RouteCoordinatorInput,
    ready: Extract<RouteExecutionV1, { phase: 'triage-ready' | 'malformed-repair-ready' | 'candidate-repair-ready' }>,
    repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
  ): Promise<RouteCoordinatorResult> {
    const attemptId = await this.dependencies.state.prepareAttempt(
      'triage',
      repairInput === null ? 'initial' : `${repairInput.kind}:${ready.triageRepairs}`,
    );

    const result = await this.dependencies.operation.run({
      operation: 'triage',
      attemptId,
      runId: input.runId,
      worktreePath: input.worktreePath,
      workflowGeneration: input.workflowGeneration,
      promptFacts: triagePromptFacts(input.promptFacts, repairInput),
      signal: input.signal,
      onLaunched: ({ pid, processGroupId }) => this.dependencies.state.launchAttempt(attemptId, pid, processGroupId),
    });
    return this.adoptTriage(input, ready, attemptId, repairInput, result);
  }

  private async adoptTriage(
    input: RouteCoordinatorInput,
    ready: Extract<RouteExecutionV1, { phase: 'triage-ready' | 'malformed-repair-ready' | 'candidate-repair-ready' }>,
    attemptId: string,
    repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
    result: ContainedReportOperationResult,
  ): Promise<RouteCoordinatorResult> {
    if (result.status === 'cancelled') return this.cancel(ready);
    if (result.status === 'blocked') return blocked(result.kind, result.code, []);
    if (result.status === 'retryable') return this.retryTriage(ready, repairInput, result.code);
    if (result.status === 'safe-halt') return result;
    if (result.attemptId !== attemptId) return attemptMismatch(attemptId, result.attemptId);
    if (result.status === 'invalid') return this.invalidTriage(ready, repairInput, result.findings, result.repairInput?.originalReportSha256);

    let artifact: TriageRouteV1;
    try {
      artifact = validateTriageRoute(result.validatedPayload);
    } catch (error) {
      return this.invalidTriage(ready, repairInput, [finding(error)]);
    }
    if (artifact.status === 'blocked') {
      return blocked(artifact.blocker.kind, artifact.blocker.code, artifact.blocker.evidence);
    }
    if (artifact.status === 'awaiting-user' && repairInput !== null) {
      return blocked('exhausted', 'waiting-candidate-repair-exhausted', [
        'A repaired candidate may not ask another question.',
      ]);
    }

    const triage: RouteArtifactRefV1 = {
      operation: 'triage',
      attemptId,
      artifactSha256: result.artifactSha256,
      generationHash: input.workflowGeneration.generationHash,
    };
    if (artifact.status === 'awaiting-user') {
      const candidateReady: RouteExecutionV1 = {
        ...budgets(ready), phase: 'candidate-ready', candidate: artifact, triage,
      };
      if (!await this.dependencies.state.adopt(ready, candidateReady, result.artifactSha256)) return stateConflict();
      await this.dependencies.state.clearAttempt();
      return this.launchReview(input, candidateReady);
    }
    return this.complete(ready, artifact, triage, null, ready, result.artifactSha256);
  }

  private async launchReview(
    input: RouteCoordinatorInput,
    ready: Extract<RouteExecutionV1, { phase: 'candidate-ready' }>,
  ): Promise<RouteCoordinatorResult> {
    if (ready.candidateReviews === 1) {
      return blocked('exhausted', 'candidate-reviews-exhausted', [ready.triage.artifactSha256]);
    }
    const attemptId = await this.dependencies.state.prepareAttempt(
      'ambiguity-review',
      `${ready.triage.artifactSha256}:${ready.candidateReviews}`,
    );
    if (attemptId === ready.triage.attemptId) {
      return blocked('safety', 'ambiguity-review-attempt-not-fresh', ['Triage and review attempt IDs must be distinct.']);
    }
    const result = await this.dependencies.operation.run({
      operation: 'ambiguity-review',
      attemptId,
      runId: input.runId,
      worktreePath: input.worktreePath,
      workflowGeneration: input.workflowGeneration,
      promptFacts: reviewPromptFacts(input.promptFacts, ready),
      signal: input.signal,
      onLaunched: ({ pid, processGroupId }) => this.dependencies.state.launchAttempt(attemptId, pid, processGroupId),
    });
    return this.adoptReview(input, ready, attemptId, result);
  }

  private async adoptReview(
    input: RouteCoordinatorInput,
    ready: Extract<RouteExecutionV1, { phase: 'candidate-ready' }>,
    attemptId: string,
    result: ContainedReportOperationResult,
  ): Promise<RouteCoordinatorResult> {
    if (result.status === 'cancelled') return this.cancel(ready);
    if (result.status === 'blocked') return blocked(result.kind, result.code, []);
    if (result.status === 'retryable') return this.retryReview(ready, result.code);
    if (result.status === 'safe-halt') return result;
    if (result.attemptId !== attemptId) return attemptMismatch(attemptId, result.attemptId);
    if (result.status === 'invalid') {
      return blocked('safety', 'ambiguity-review-artifact-invalid', result.findings);
    }

    let review: AmbiguityReviewArtifactV1;
    try {
      review = validateAmbiguityReviewArtifact(result.validatedPayload);
    } catch (error) {
      return blocked('safety', 'ambiguity-review-artifact-invalid', [finding(error)]);
    }
    if (review.candidateSha256 !== ready.triage.artifactSha256) {
      return blocked('safety', 'ambiguity-review-candidate-mismatch', [
        `Expected ${ready.triage.artifactSha256} but review echoed ${review.candidateSha256}.`,
      ]);
    }
    if (review.verdict === 'blocked') {
      const consumed: RouteExecutionV1 = {
        ...budgets(ready),
        phase: 'candidate-ready',
        candidate: ready.candidate,
        triage: ready.triage,
        candidateReviews: 1,
      };
      if (!await this.dependencies.state.adopt(ready, consumed, result.artifactSha256)) return stateConflict();
      await this.dependencies.state.clearAttempt();
      return blocked('safety', 'ambiguity-review-blocked', nonEmptyFindings(review.findings, 'Ambiguity review blocked.'));
    }
    const reviewRef: AmbiguityReviewRefV1 = {
      operation: 'ambiguity-review',
      attemptId,
      candidateSha256: review.candidateSha256,
      artifactSha256: result.artifactSha256,
      verdict: review.verdict,
      generationHash: input.workflowGeneration.generationHash,
    };
    if (review.verdict === 'rejected') {
      if (ready.triageRepairs === 1 || ready.candidateReviews === 1) {
        return blocked('exhausted', 'waiting-candidate-repair-exhausted', review.findings);
      }
      const findings = nonEmptyFindings(review.findings, 'Ambiguity review rejected the waiting candidate.');
      const repairReady: RouteExecutionV1 = {
        ...budgets(ready),
        phase: 'candidate-repair-ready',
        candidate: ready.candidate,
        triage: ready.triage,
        review: reviewRef,
        findings,
        triageRepairs: 1,
        candidateReviews: 1,
      };
      if (!await this.dependencies.state.adopt(ready, repairReady, result.artifactSha256)) return stateConflict();
      await this.dependencies.state.clearAttempt();
      return { status: 'repairable', code: 'waiting-candidate-rejected', findings };
    }
    const reviewed = { ...ready, candidateReviews: 1 as const };
    return this.complete(ready, ready.candidate, ready.triage, reviewRef, reviewed, result.artifactSha256);
  }

  private async invalidTriage(
    ready: Extract<RouteExecutionV1, { phase: 'triage-ready' | 'malformed-repair-ready' | 'candidate-repair-ready' }>,
    repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
    findings: string[],
    resultSha256 = sha256(canonicalJson(findings)),
  ): Promise<RouteCoordinatorResult> {
    findings = nonEmptyFindings(findings, 'Triage artifact validation failed.');
    if (repairInput !== null || ready.triageRepairs === 1) {
      return blocked('exhausted', 'triage-repair-exhausted', findings);
    }
    const repairReady: RouteExecutionV1 = {
      ...budgets(ready), phase: 'malformed-repair-ready', findings, triageRepairs: 1,
    };
    if (!await this.dependencies.state.adopt(ready, repairReady, resultSha256)) return stateConflict();
    await this.dependencies.state.clearAttempt();
    return { status: 'repairable', code: 'triage-artifact-invalid', findings };
  }

  private async retryTriage(
    ready: Extract<RouteExecutionV1, { phase: 'triage-ready' | 'malformed-repair-ready' | 'candidate-repair-ready' }>,
    repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
    code: string,
  ): Promise<RouteCoordinatorResult> {
    if (ready.triageTransportRetries === 1) {
      return blocked('exhausted', 'triage-transport-retries-exhausted', [code]);
    }
    const next = triageReadyAfterFailure(ready, repairInput, 1);
    if (!await this.dependencies.state.adopt(ready, next, sha256(canonicalJson({ code })))) return stateConflict();
    await this.dependencies.state.clearAttempt();
    return { status: 'retryable', owner: 'triage', code };
  }

  private async retryReview(
    current: Extract<RouteExecutionV1, { phase: 'candidate-ready' }>,
    code: string,
  ): Promise<RouteCoordinatorResult> {
    if (current.ambiguityTransportRetries === 1) {
      return blocked('exhausted', 'ambiguity-review-transport-retries-exhausted', [code]);
    }
    const ready: RouteExecutionV1 = {
      ...budgets(current),
      phase: 'candidate-ready',
      candidate: current.candidate,
      triage: current.triage,
      ambiguityTransportRetries: 1,
    };
    if (!await this.dependencies.state.adopt(current, ready, sha256(canonicalJson({ code })))) return stateConflict();
    await this.dependencies.state.clearAttempt();
    return { status: 'retryable', owner: 'ambiguity-review', code };
  }

  private async complete(
    expected: RouteExecutionV1,
    artifact: TriageRouteV1,
    triage: RouteArtifactRefV1,
    review: AmbiguityReviewRefV1 | null,
    budgetSource: RouteExecutionV1,
    resultSha256: string,
  ): Promise<RouteCoordinatorResult> {
    let receipt: RouteReceiptV1;
    try {
      receipt = this.dependencies.createReceipt({ artifact, triage, review, decidedAt: this.dependencies.now() });
    } catch (error) {
      return blocked('safety', 'route-receipt-creation-failed', [finding(error)]);
    }
    const complete: RouteExecutionV1 = { ...budgets(budgetSource), phase: 'route-complete', triage, review };
    if (!await this.dependencies.state.complete(expected, complete, receipt, resultSha256)) return stateConflict();
    await this.dependencies.state.clearAttempt();
    return artifact.status === 'awaiting-user'
      ? { status: 'awaiting-user', receipt }
      : { status: 'succeeded', receipt };
  }

  private async cancel(expected: RouteExecutionV1): Promise<RouteCoordinatorResult> {
    if (!await this.dependencies.state.cancel(expected)) return stateConflict();
    return { status: 'cancelled' };
  }
}

function triageReadyAfterFailure(
  current: Extract<RouteExecutionV1, { phase: 'triage-ready' | 'malformed-repair-ready' | 'candidate-repair-ready' }>,
  repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
  retries: 1,
): RouteExecutionV1 {
  if (repairInput?.kind === 'malformed') {
    return { ...budgets(current), phase: 'malformed-repair-ready', findings: repairInput.findings, triageTransportRetries: retries };
  }
  if (repairInput?.kind === 'rejected-candidate') {
    return {
      ...budgets(current),
      phase: 'candidate-repair-ready',
      candidate: repairInput.candidate,
      triage: repairInput.triage,
      review: repairInput.review,
      findings: repairInput.findings,
      triageTransportRetries: retries,
    };
  }
  return {
    ...budgets(current),
    phase: 'triage-ready',
    triageTransportRetries: retries,
  };
}

function triagePromptFacts(
  base: string[],
  repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
): string[] {
  const facts = [...base, ...TRIAGE_AUTHORITY_FACTS];
  if (repairInput === null) return facts;
  facts.push(`repairKind=${repairInput.kind}`, `repairFindings=${canonicalJson(repairInput.findings)}`);
  if (repairInput.kind === 'rejected-candidate') {
    facts.push(
      `candidateSha256=${repairInput.triage.artifactSha256}`,
      `candidateArtifact=${canonicalJson(repairInput.candidate)}`,
      `reviewRef=${canonicalJson(repairInput.review)}`,
      'repairResult=direct-or-spec-required-or-typed-blocker',
      'repairResultMayNotAwaitUser=true',
    );
  }
  return facts;
}

function reviewPromptFacts(
  base: string[],
  ready: Extract<RouteExecutionV1, { phase: 'candidate-ready' }>,
): string[] {
  return [
    ...base,
    `candidateSha256=${ready.triage.artifactSha256}`,
    `candidateArtifact=${canonicalJson(ready.candidate)}`,
    `candidateEvidence=${canonicalJson(ready.candidate.inspectedEvidence)}`,
    'review=materially-different-observable-product-outcomes',
    'review=authorized-source-choice-must-be-absent',
    'triage-process-identity=withheld',
  ];
}

function budgets(execution: RouteExecutionV1) {
  return {
    version: execution.version,
    triageRepairs: execution.triageRepairs,
    triageTransportRetries: execution.triageTransportRetries,
    ambiguityTransportRetries: execution.ambiguityTransportRetries,
    candidateReviews: execution.candidateReviews,
  };
}

function blocked(
  kind: 'external' | 'safety' | 'exhausted',
  code: string,
  evidence: string[],
): RouteCoordinatorResult {
  return { status: 'blocked', kind, code, evidence };
}

function stateConflict(): RouteCoordinatorResult {
  return blocked('safety', 'route-state-conflict', ['Durable route state changed before compare-and-swap.']);
}

function attemptMismatch(expected: string, actual: string): RouteCoordinatorResult {
  return blocked('safety', 'route-attempt-mismatch', [`Expected ${expected} but operation returned ${actual}.`]);
}

function finding(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'route validation failed';
}

function nonEmptyFindings(findings: string[], fallback: string): string[] {
  return findings.length > 0 ? findings : [fallback];
}
