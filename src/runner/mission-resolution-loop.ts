import { createHash } from 'node:crypto';

import {
  evaluate,
  type EvaluationResult,
  type EvaluationSnapshot,
} from './mission-evaluation.js';
import type { MissionScopeExpansionProposal } from './mission-scope-expansion.js';

export type MissionResolutionProposal =
  | {
      version: 1;
      kind: 'runner-action';
      executorId: string;
      findingIds: string[];
      rationale: string;
    }
  | ({ kind: 'scope-expansion'; rationale: string } & MissionScopeExpansionProposal)
  | {
      version: 1;
      kind: 'external-input';
      evidence: string[];
      resumePredicate: string;
    }
  | {
      version: 1;
      kind: 'safety-stop';
      evidence: string[];
      invariant: string;
    };

export interface MissionResolutionPermit {
  id: string;
  actionKey: string;
  strategyFingerprint: string;
  proposal: MissionResolutionProposal;
}

export interface MissionExecutionReceipt {
  id: string;
  actionKey: string;
  evidenceRefs: string[];
}

export type MissionAuthorizationDecision =
  | { kind: 'allowed'; permit: MissionResolutionPermit }
  | { kind: 'rejected-recoverable'; reason: string; alternatives: string[] }
  | { kind: 'temporary'; reason: string; nextEligibleAt: string }
  | { kind: 'external-input-required'; evidence: string[]; resumePredicate: string }
  | { kind: 'safety-stop'; evidence: string[]; invariant: string };

export type MissionExecutionDecision =
  | { kind: 'completed'; receipt: MissionExecutionReceipt }
  | { kind: 'deterministic-failure'; reason: string; alternatives: string[] }
  | { kind: 'transient'; reason: string; nextEligibleAt: string };

export type MissionReconciliationDecision =
  | {
      kind: 'satisfied';
      snapshot: EvaluationSnapshot;
      scope: string[];
      validationReceiptIds: string[];
      acceptanceCoverage: string[];
    }
  | { kind: 'transient'; reason: string; nextEligibleAt: string }
  | { kind: 'external-input-required'; evidence: string[]; resumePredicate: string }
  | { kind: 'safety-stop'; evidence: string[]; invariant: string };

export interface MissionDiagnosisContext {
  missionId: string;
  snapshot: EvaluationSnapshot;
  evaluation: EvaluationResult;
  alternatives: string[];
  suppressedStrategyFingerprints: string[];
  history: MissionStrategyHistory[];
}

export interface MissionStrategyHistory {
  actionKey: string;
  strategyFingerprint: string;
  outcome:
    | 'authorization-rejected'
    | 'deterministic-failure'
    | 'strategy-stagnated'
    | 'proposal-suppressed'
    | 'progress';
  reason?: string;
  alternatives?: string[];
}

export interface MissionResolutionResume {
  stage: 'authorizing' | 'executing' | 'reconciling';
  actionKey: string;
  strategyFingerprint: string;
  proposal: MissionResolutionProposal;
  permit?: MissionResolutionPermit;
  receipt?: MissionExecutionReceipt;
}

export interface MissionResolutionInput {
  missionId: string;
  snapshot: EvaluationSnapshot;
  scope: string[];
  validationReceiptIds: string[];
  acceptanceCoverage: string[];
  maxSteps: number;
  history?: MissionStrategyHistory[];
  resume?: MissionResolutionResume;
}

export interface MissionResolutionDependencies {
  diagnose(context: Readonly<MissionDiagnosisContext>): Promise<MissionResolutionProposal>;
  authorize(input: Readonly<{
    missionId: string;
    snapshot: EvaluationSnapshot;
    evaluation: EvaluationResult;
    proposal: MissionResolutionProposal;
    actionKey: string;
    strategyFingerprint: string;
  }>): Promise<MissionAuthorizationDecision>;
  execute(input: Readonly<{
    missionId: string;
    actionKey: string;
    strategyFingerprint: string;
    proposal: MissionResolutionProposal;
    permit: MissionResolutionPermit;
  }>): Promise<MissionExecutionDecision>;
  reconcile(input: Readonly<{
    missionId: string;
    snapshot: EvaluationSnapshot;
    proposal: MissionResolutionProposal;
    permit: MissionResolutionPermit;
    receipt: MissionExecutionReceipt;
  }>): Promise<MissionReconciliationDecision>;
  nextEligibleAt(reason: string): string;
}

export type MissionResolutionOutcome =
  | {
      kind: 'candidate-ready';
      snapshot: EvaluationSnapshot;
      evaluation: EvaluationResult;
      history: MissionStrategyHistory[];
      scope: string[];
      validationReceiptIds: string[];
      acceptanceCoverage: string[];
    }
  | {
      kind: 'resumable';
      resumeTarget: 'authorizing' | 'executing' | 'reconciling' | 'diagnosing';
      reason: string;
      nextEligibleAt: string;
      resume?: MissionResolutionResume;
      history: MissionStrategyHistory[];
    }
  | {
      kind: 'external-input-required';
      evidence: string[];
      resumePredicate: string;
      history: MissionStrategyHistory[];
    }
  | {
      kind: 'safety-stop';
      evidence: string[];
      invariant: string;
      history: MissionStrategyHistory[];
    };

export async function runResolutionMission(
  input: MissionResolutionInput,
  dependencies: MissionResolutionDependencies,
): Promise<MissionResolutionOutcome> {
  assertInput(input);
  let snapshot = structuredClone(input.snapshot);
  let scope = unique(input.scope);
  let validationReceiptIds = unique(input.validationReceiptIds);
  let acceptanceCoverage = unique(input.acceptanceCoverage);
  const history = structuredClone(input.history ?? []);
  let alternatives = latestAlternatives(history);
  let resume = input.resume ? structuredClone(input.resume) : undefined;

  for (let step = 0; step < input.maxSteps; step += 1) {
    const evaluation = evaluate(snapshot);
    const direct = directEvaluationOutcome(evaluation, history);
    if (direct) return direct;
    if (evaluation.blockingDisposition === 'none') {
      return {
        kind: 'candidate-ready',
        snapshot,
        evaluation,
        history,
        scope,
        validationReceiptIds,
        acceptanceCoverage,
      };
    }

    let proposal: MissionResolutionProposal;
    let strategyFingerprint: string;
    let actionKey: string;
    if (resume) {
      ({ proposal, strategyFingerprint, actionKey } = resume);
    } else {
      const suppressed = suppressedFingerprints(history);
      proposal = await dependencies.diagnose({
        missionId: input.missionId,
        snapshot: structuredClone(snapshot),
        evaluation: structuredClone(evaluation),
        alternatives: [...alternatives],
        suppressedStrategyFingerprints: suppressed,
        history: structuredClone(history),
      });
      strategyFingerprint = missionStrategyFingerprint(proposal);
      actionKey = missionActionKey(input.missionId, snapshot, strategyFingerprint);
      if (suppressed.includes(strategyFingerprint)) {
        history.push({
          actionKey,
          strategyFingerprint,
          outcome: 'proposal-suppressed',
          reason: 'strategy-already-completed-without-progress',
          alternatives: ['choose a materially different strategy'],
        });
        alternatives = ['choose a materially different strategy'];
        continue;
      }
    }
    if (resume && (strategyFingerprint !== missionStrategyFingerprint(proposal)
      || actionKey !== missionActionKey(input.missionId, snapshot, strategyFingerprint))) {
      return safety([actionKey], 'stale-resolution-resume', history);
    }

    let permit = resume?.permit;
    if (!resume || resume.stage === 'authorizing') {
      const authorization = await dependencies.authorize({
        missionId: input.missionId,
        snapshot: structuredClone(snapshot),
        evaluation: structuredClone(evaluation),
        proposal: structuredClone(proposal),
        actionKey,
        strategyFingerprint,
      });
      if (authorization.kind === 'rejected-recoverable') {
        alternatives = unique(authorization.alternatives);
        history.push({
          actionKey,
          strategyFingerprint,
          outcome: 'authorization-rejected',
          reason: authorization.reason,
          alternatives,
        });
        resume = undefined;
        continue;
      }
      if (authorization.kind === 'temporary') {
        return resumable('authorizing', authorization.reason, authorization.nextEligibleAt, history, {
          stage: 'authorizing', actionKey, strategyFingerprint, proposal,
        });
      }
      if (authorization.kind === 'external-input-required') {
        return external(authorization.evidence, authorization.resumePredicate, history);
      }
      if (authorization.kind === 'safety-stop') {
        return safety(authorization.evidence, authorization.invariant, history);
      }
      if (proposal.kind === 'external-input' || proposal.kind === 'safety-stop') {
        return safety([
          `proposal:${proposal.kind}`,
          `authorization:${authorization.kind}`,
        ], 'terminal-boundary-not-runner-verified', history);
      }
      requireText(authorization.permit.id, 'permit.id');
      permit = {
        ...structuredClone(authorization.permit),
        actionKey,
        strategyFingerprint,
        proposal: structuredClone(proposal),
      };
    }
    if (!permit) throw new Error('Mission resolution authorization produced no permit.');

    let receipt = resume?.receipt;
    if (!resume || resume.stage !== 'reconciling') {
      const execution = await dependencies.execute({
        missionId: input.missionId,
        actionKey,
        strategyFingerprint,
        proposal: structuredClone(proposal),
        permit: structuredClone(permit),
      });
      if (execution.kind === 'transient') {
        return resumable('executing', execution.reason, execution.nextEligibleAt, history, {
          stage: 'executing', actionKey, strategyFingerprint, proposal, permit,
        });
      }
      if (execution.kind === 'deterministic-failure') {
        alternatives = unique(execution.alternatives);
        history.push({
          actionKey,
          strategyFingerprint,
          outcome: 'deterministic-failure',
          reason: execution.reason,
          alternatives,
        });
        resume = undefined;
        continue;
      }
      receipt = structuredClone(execution.receipt);
      requireText(receipt.id, 'receipt.id');
      if (receipt.actionKey !== actionKey) {
        return safety([`expected:${actionKey}`, `received:${receipt.actionKey}`],
          'execution-receipt-action-mismatch', history);
      }
    }
    if (!receipt) throw new Error('Mission resolution execution produced no receipt.');

    const before = progressVector({
      snapshot,
      evaluation,
      scope,
      validationReceiptIds,
      acceptanceCoverage,
      strategyFingerprint,
    });
    const reconciliation = await dependencies.reconcile({
      missionId: input.missionId,
      snapshot: structuredClone(snapshot),
      proposal: structuredClone(proposal),
      permit: structuredClone(permit),
      receipt: structuredClone(receipt),
    });
    if (reconciliation.kind === 'transient') {
      return resumable('reconciling', reconciliation.reason, reconciliation.nextEligibleAt, history, {
        stage: 'reconciling', actionKey, strategyFingerprint, proposal, permit, receipt,
      });
    }
    if (reconciliation.kind === 'external-input-required') {
      return external(reconciliation.evidence, reconciliation.resumePredicate, history);
    }
    if (reconciliation.kind === 'safety-stop') {
      return safety(reconciliation.evidence, reconciliation.invariant, history);
    }
    if (reconciliation.snapshot.issueNumber !== snapshot.issueNumber
      || reconciliation.snapshot.baseSha !== snapshot.baseSha
      || reconciliation.snapshot.configHash !== snapshot.configHash) {
      return safety([
        `expected:${snapshot.issueNumber}:${snapshot.baseSha}:${snapshot.configHash}`,
        `received:${reconciliation.snapshot.issueNumber}:${reconciliation.snapshot.baseSha}:${reconciliation.snapshot.configHash}`,
      ], 'reconciliation-snapshot-identity-mismatch', history);
    }
    snapshot = structuredClone(reconciliation.snapshot);
    scope = unique(reconciliation.scope);
    validationReceiptIds = unique(reconciliation.validationReceiptIds);
    acceptanceCoverage = unique(reconciliation.acceptanceCoverage);
    const reevaluation = evaluate(snapshot);
    const after = progressVector({
      snapshot,
      evaluation: reevaluation,
      scope,
      validationReceiptIds,
      acceptanceCoverage,
      strategyFingerprint,
    });
    history.push({
      actionKey,
      strategyFingerprint,
      outcome: before === after ? 'strategy-stagnated' : 'progress',
      ...(before === after ? {
        reason: 'deterministic-action-left-progress-vector-unchanged',
        alternatives: ['choose a materially different strategy'],
      } : {}),
    });
    alternatives = before === after ? ['choose a materially different strategy'] : [];
    resume = undefined;
  }

  return {
    kind: 'resumable',
    resumeTarget: 'diagnosing',
    reason: 'resolution-step-budget-exhausted',
    nextEligibleAt: dependencies.nextEligibleAt('resolution-step-budget-exhausted'),
    history,
  };
}

export function missionStrategyFingerprint(proposal: MissionResolutionProposal): string {
  return digest(['mission-strategy-v1', canonicalize(proposal)]);
}

function missionActionKey(
  missionId: string,
  snapshot: EvaluationSnapshot,
  strategyFingerprint: string,
): string {
  return `action:v1:${digest([missionId, progressSnapshotIdentity(snapshot), strategyFingerprint]).slice(7)}`;
}

function progressVector(input: {
  snapshot: EvaluationSnapshot;
  evaluation: EvaluationResult;
  scope: string[];
  validationReceiptIds: string[];
  acceptanceCoverage: string[];
  strategyFingerprint: string;
}): string {
  return canonicalize({
    findingIds: input.evaluation.findings.map((finding) => `${finding.disposition}:${finding.id}`),
    candidate: normalizedCandidateIdentity(input.snapshot.candidateIdentity),
    scope: unique(input.scope),
    validationReceiptIds: unique(input.validationReceiptIds),
    acceptanceCoverage: unique(input.acceptanceCoverage),
    strategyFingerprint: input.strategyFingerprint,
  });
}

function progressSnapshotIdentity(snapshot: EvaluationSnapshot): string {
  return digest([
    snapshot.issueNumber,
    snapshot.baseSha,
    snapshot.configHash,
    normalizedCandidateIdentity(snapshot.candidateIdentity),
  ]);
}

function directEvaluationOutcome(
  evaluation: EvaluationResult,
  history: MissionStrategyHistory[],
): MissionResolutionOutcome | undefined {
  if (evaluation.blockingDisposition === 'safety-stop') {
    const findings = evaluation.findings.filter((finding) => finding.disposition === 'safety-stop');
    return safety(findings.flatMap((finding) => [finding.id, ...finding.evidenceRefs]),
      findings.map((finding) => finding.key).join(',') || 'evaluation-safety-stop', history);
  }
  if (evaluation.blockingDisposition === 'external-input') {
    const findings = evaluation.findings.filter((finding) => finding.disposition === 'external-input');
    return external(findings.flatMap((finding) => [finding.id, ...finding.evidenceRefs]),
      findings.map((finding) => finding.reason).join('\n'), history);
  }
  return undefined;
}

function resumable(
  resumeTarget: 'authorizing' | 'executing' | 'reconciling',
  reason: string,
  nextEligibleAt: string,
  history: MissionStrategyHistory[],
  resume: MissionResolutionResume,
): MissionResolutionOutcome {
  return { kind: 'resumable', resumeTarget, reason, nextEligibleAt, resume, history };
}

function external(
  evidence: string[],
  resumePredicate: string,
  history: MissionStrategyHistory[],
): MissionResolutionOutcome {
  assertEvidence(evidence, 'external-input');
  requireText(resumePredicate, 'resumePredicate');
  return {
    kind: 'external-input-required',
    evidence: unique(evidence),
    resumePredicate,
    history,
  };
}

function safety(
  evidence: string[],
  invariant: string,
  history: MissionStrategyHistory[],
): MissionResolutionOutcome {
  assertEvidence(evidence, 'safety-stop');
  requireText(invariant, 'invariant');
  return { kind: 'safety-stop', evidence: unique(evidence), invariant, history };
}

function latestAlternatives(history: MissionStrategyHistory[]): string[] {
  return unique(history.at(-1)?.alternatives ?? []);
}

function suppressedFingerprints(history: MissionStrategyHistory[]): string[] {
  return unique(history
    .filter((entry) => entry.outcome === 'authorization-rejected'
      || entry.outcome === 'deterministic-failure'
      || entry.outcome === 'strategy-stagnated'
      || entry.outcome === 'proposal-suppressed')
    .map((entry) => entry.strategyFingerprint));
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

function normalizedCandidateIdentity(
  candidate: EvaluationSnapshot['candidateIdentity'],
): EvaluationSnapshot['candidateIdentity'] {
  return candidate.kind === 'legacy-unobserved'
    ? { ...candidate }
    : { ...candidate, changedFiles: unique(candidate.changedFiles) };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function assertInput(input: MissionResolutionInput): void {
  requireText(input.missionId, 'missionId');
  if (!Number.isSafeInteger(input.maxSteps) || input.maxSteps <= 0) {
    throw new Error('Mission resolution maxSteps must be a positive integer.');
  }
}

function assertEvidence(evidence: string[], kind: string): void {
  if (unique(evidence).length === 0) {
    throw new Error(`Mission resolution ${kind} requires evidence.`);
  }
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Mission resolution ${field} must be non-empty.`);
  }
}
