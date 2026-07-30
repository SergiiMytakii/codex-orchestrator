import { canonicalJson } from './containment.js';
import { decodeAgentReportForValidation } from './report-envelope.js';
import {
  hashAmbiguityReviewArtifact,
  hashTriageArtifact,
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
  DurableReportInvocationState,
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
  | { status: 'retryable'; code: string }
  | { status: 'safe-halt'; code: string }
  | { status: 'awaiting-user'; receipt: RouteReceiptV1 }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string; evidence: string[] };

export interface RouteCoordinatorState {
  read(): Promise<RouteExecutionV1>;
  compareAndSwap(expected: RouteExecutionV1, next: RouteExecutionV1): Promise<boolean>;
  complete(expected: RouteExecutionV1, next: RouteExecutionV1, receipt: RouteReceiptV1, attemptId: string): Promise<boolean>;
  cancel(expected: RouteExecutionV1): Promise<boolean>;
  invocation: DurableReportInvocationState;
  settle(expected: RouteExecutionV1, next: RouteExecutionV1, attemptId: string): Promise<boolean>;
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
      case 'triage-in-flight':
        return this.executeTriage(input, execution, null);
      case 'repair-in-flight':
        return this.executeTriage(input, execution, execution.repairInput);
      case 'review-in-flight':
        return this.executeReview(input, execution);
      case 'route-complete':
        return blocked('safety', 'route-coordinator-already-complete', ['Routed state must dispatch without rerunning routing.']);
    }
  }

  private async launchTriage(
    input: RouteCoordinatorInput,
    ready: Extract<RouteExecutionV1, { phase: 'triage-ready' | 'malformed-repair-ready' | 'candidate-repair-ready' }>,
    repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
  ): Promise<RouteCoordinatorResult> {
    const inFlight = {
      ...budgets(ready),
      phase: repairInput === null ? 'triage-in-flight' : 'repair-in-flight',
      ...(repairInput === null ? {} : { repairInput }),
    } as Extract<RouteExecutionV1, { phase: 'triage-in-flight' | 'repair-in-flight' }>;
    if (!await this.dependencies.state.compareAndSwap(ready, inFlight)) return stateConflict();

    return this.executeTriage(input, inFlight, repairInput);
  }

  private async executeTriage(
    input: RouteCoordinatorInput,
    inFlight: Extract<RouteExecutionV1, { phase: 'triage-in-flight' | 'repair-in-flight' }>,
    repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
  ): Promise<RouteCoordinatorResult> {
    const result = await this.dependencies.operation.run({
      operation: 'triage',
      runId: input.runId,
      worktreePath: input.worktreePath,
      workflowGeneration: input.workflowGeneration,
      promptFacts: triagePromptFacts(input.promptFacts, repairInput),
      signal: input.signal,
      invocationState: this.dependencies.state.invocation,
    });
    return this.adoptTriage(input, inFlight, repairInput, result);
  }

  private async adoptTriage(
    input: RouteCoordinatorInput,
    inFlight: Extract<RouteExecutionV1, { phase: 'triage-in-flight' | 'repair-in-flight' }>,
    repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
    result: ContainedReportOperationResult,
  ): Promise<RouteCoordinatorResult> {
    if (result.status === 'cancelled') return this.cancel(inFlight);
    if (result.status === 'blocked') return blocked(result.kind, result.code, []);
    if (result.status === 'retryable' || result.status === 'safe-halt') return result;

    let artifact: TriageRouteV1;
    try {
      artifact = validateTriageRoute(decodeAgentReportForValidation(result.reportBytes));
    } catch (error) {
      return this.invalidTriage(inFlight, repairInput, [finding(error)], result.attemptId);
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
      attemptId: result.attemptId,
      artifactSha256: hashTriageArtifact(artifact),
      generationHash: input.workflowGeneration.generationHash,
    };
    if (artifact.status === 'awaiting-user') {
      const candidateReady: RouteExecutionV1 = {
        ...budgets(inFlight), phase: 'candidate-ready', candidate: artifact, triage,
      };
      if (!await this.dependencies.state.settle(inFlight, candidateReady, result.attemptId)) return stateConflict();
      return this.launchReview(input, candidateReady);
    }
    return this.complete(inFlight, artifact, triage, null, result.attemptId);
  }

  private async launchReview(
    input: RouteCoordinatorInput,
    ready: Extract<RouteExecutionV1, { phase: 'candidate-ready' }>,
  ): Promise<RouteCoordinatorResult> {
    if (ready.candidateReviews === 1) {
      return blocked('exhausted', 'candidate-reviews-exhausted', [ready.triage.artifactSha256]);
    }
    const inFlight: RouteExecutionV1 = {
      ...budgets(ready),
      phase: 'review-in-flight',
      candidate: ready.candidate,
      triage: ready.triage,
    };
    if (!await this.dependencies.state.compareAndSwap(ready, inFlight)) return stateConflict();
    return this.executeReview(input, inFlight);
  }

  private async executeReview(
    input: RouteCoordinatorInput,
    inFlight: Extract<RouteExecutionV1, { phase: 'review-in-flight' }>,
  ): Promise<RouteCoordinatorResult> {
    const result = await this.dependencies.operation.run({
      operation: 'ambiguity-review',
      runId: input.runId,
      worktreePath: input.worktreePath,
      workflowGeneration: input.workflowGeneration,
      promptFacts: reviewPromptFacts(input.promptFacts, inFlight),
      signal: input.signal,
      invocationState: this.dependencies.state.invocation,
      forbiddenAttemptIds: [inFlight.triage.attemptId],
    });
    return this.adoptReview(input, inFlight, result);
  }

  private async adoptReview(
    input: RouteCoordinatorInput,
    inFlight: Extract<RouteExecutionV1, { phase: 'review-in-flight' }>,
    result: ContainedReportOperationResult,
  ): Promise<RouteCoordinatorResult> {
    if (result.status === 'cancelled') return this.cancel(inFlight);
    if (result.status === 'blocked') return blocked(result.kind, result.code, []);
    if (result.status === 'retryable' || result.status === 'safe-halt') return result;

    let review: AmbiguityReviewArtifactV1;
    try {
      review = validateAmbiguityReviewArtifact(decodeAgentReportForValidation(result.reportBytes));
    } catch (error) {
      return blocked('safety', 'ambiguity-review-artifact-invalid', [finding(error)]);
    }
    if (review.candidateSha256 !== inFlight.triage.artifactSha256) {
      return blocked('safety', 'ambiguity-review-candidate-mismatch', [
        `Expected ${inFlight.triage.artifactSha256} but review echoed ${review.candidateSha256}.`,
      ]);
    }
    if (review.verdict === 'blocked') {
      const consumed: RouteExecutionV1 = {
        ...budgets(inFlight),
        phase: 'candidate-ready',
        candidate: inFlight.candidate,
        triage: inFlight.triage,
        candidateReviews: 1,
      };
      if (!await this.dependencies.state.settle(inFlight, consumed, result.attemptId)) return stateConflict();
      return blocked('safety', 'ambiguity-review-blocked', nonEmptyFindings(review.findings, 'Ambiguity review blocked.'));
    }
    const reviewRef: AmbiguityReviewRefV1 = {
      operation: 'ambiguity-review',
      attemptId: result.attemptId,
      candidateSha256: review.candidateSha256,
      artifactSha256: hashAmbiguityReviewArtifact(review),
      verdict: review.verdict,
      generationHash: input.workflowGeneration.generationHash,
    };
    if (review.verdict === 'rejected') {
      if (inFlight.triageRepairs === 1 || inFlight.candidateReviews === 1) {
        return blocked('exhausted', 'waiting-candidate-repair-exhausted', review.findings);
      }
      const findings = nonEmptyFindings(review.findings, 'Ambiguity review rejected the waiting candidate.');
      const repairReady: RouteExecutionV1 = {
        ...budgets(inFlight),
        phase: 'candidate-repair-ready',
        candidate: inFlight.candidate,
        triage: inFlight.triage,
        review: reviewRef,
        findings,
        triageRepairs: 1,
        candidateReviews: 1,
      };
      if (!await this.dependencies.state.settle(inFlight, repairReady, result.attemptId)) return stateConflict();
      return { status: 'repairable', code: 'waiting-candidate-rejected', findings };
    }
    const reviewed = { ...inFlight, candidateReviews: 1 as const };
    return this.complete(inFlight, inFlight.candidate, inFlight.triage, reviewRef, result.attemptId, reviewed);
  }

  private async invalidTriage(
    inFlight: Extract<RouteExecutionV1, { phase: 'triage-in-flight' | 'repair-in-flight' }>,
    repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 | null,
    findings: string[],
    attemptId: string,
  ): Promise<RouteCoordinatorResult> {
    findings = nonEmptyFindings(findings, 'Triage artifact validation failed.');
    if (repairInput !== null || inFlight.triageRepairs === 1) {
      return blocked('exhausted', 'triage-repair-exhausted', findings);
    }
    const repairReady: RouteExecutionV1 = {
      ...budgets(inFlight), phase: 'malformed-repair-ready', findings, triageRepairs: 1,
    };
    if (!await this.dependencies.state.settle(inFlight, repairReady, attemptId)) return stateConflict();
    return { status: 'repairable', code: 'triage-artifact-invalid', findings };
  }

  private async complete(
    expected: RouteExecutionV1,
    artifact: TriageRouteV1,
    triage: RouteArtifactRefV1,
    review: AmbiguityReviewRefV1 | null,
    attemptId: string,
    budgetSource: RouteExecutionV1 = expected,
  ): Promise<RouteCoordinatorResult> {
    let receipt: RouteReceiptV1;
    try {
      receipt = this.dependencies.createReceipt({ artifact, triage, review, decidedAt: this.dependencies.now() });
    } catch (error) {
      return blocked('safety', 'route-receipt-creation-failed', [finding(error)]);
    }
    const complete: RouteExecutionV1 = { ...budgets(budgetSource), phase: 'route-complete', triage, review };
    if (!await this.dependencies.state.complete(expected, complete, receipt, attemptId)) return stateConflict();
    return artifact.status === 'awaiting-user'
      ? { status: 'awaiting-user', receipt }
      : { status: 'succeeded', receipt };
  }

  private async cancel(expected: RouteExecutionV1): Promise<RouteCoordinatorResult> {
    if (!await this.dependencies.state.cancel(expected)) return stateConflict();
    return { status: 'cancelled' };
  }
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
  ready: Pick<Extract<RouteExecutionV1, { phase: 'candidate-ready' | 'review-in-flight' }>, 'candidate' | 'triage'>,
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

function finding(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'route validation failed';
}

function nonEmptyFindings(findings: string[], fallback: string): string[] {
  return findings.length > 0 ? findings : [fallback];
}
