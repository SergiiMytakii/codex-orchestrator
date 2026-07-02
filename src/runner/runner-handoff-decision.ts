import type { AcceptanceProofAttemptEvidence } from './acceptance-proof-runner.js';
import type { FreshContextReviewEvidence, RunnerValidationLine } from './handoff-evidence.js';
import type { ImplementationPublishabilityResult } from './local-execution-session.js';

export interface RunnerHandoffEvidence {
  outcome: 'review-ready' | 'blocked' | 'promotion-requested';
  changedFiles: string[];
  validation: RunnerValidationLine[];
  skippedChecks: string[];
  residualRisks: string[];
  blockers: string[];
  nextAction: string;
  suggestionEvidence?: string[];
  acceptanceProof?: AcceptanceProofAttemptEvidence;
}

type BlockablePublishability =
  | Extract<ImplementationPublishabilityResult, { status: 'blocked' }>
  | Extract<ImplementationPublishabilityResult, { status: 'publish-ready' }>;

export function buildBlockedHandoffEvidence(input: {
  publishability: BlockablePublishability;
  freshContextReview?: FreshContextReviewEvidence;
  nextAction: string;
}): RunnerHandoffEvidence {
  const blockers = input.freshContextReview?.status === 'blocked'
    ? ['Fresh-Context Review blocked publication', ...input.freshContextReview.findings]
    : input.publishability.status === 'blocked'
      ? input.publishability.reasons
      : [];
  return {
    outcome: 'blocked',
    changedFiles: input.publishability.changedFiles,
    validation: input.publishability.validation ?? [],
    skippedChecks: input.publishability.skippedChecks,
    residualRisks: [
      ...input.publishability.residualRisks,
      ...(input.freshContextReview?.residualRisks ?? []),
    ],
    blockers,
    nextAction: input.nextAction,
    suggestionEvidence: input.freshContextReview?.findings,
    acceptanceProof: input.publishability.acceptanceProofAttempt,
  };
}

export function buildPromotionRequestedHandoffEvidence(input: {
  publishability: Extract<ImplementationPublishabilityResult, { status: 'promotion-requested' }>;
  nextAction: string;
  fallbackReason?: string;
}): RunnerHandoffEvidence {
  return promotionHandoffEvidence({
    outcome: 'promotion-requested',
    publishability: input.publishability,
    nextAction: input.nextAction,
    fallbackReason: input.fallbackReason ?? 'Promotion requested',
  });
}

export function buildPromotionAsBlockedHandoffEvidence(input: {
  publishability: Extract<ImplementationPublishabilityResult, { status: 'promotion-requested' }>;
  nextAction: string;
  fallbackReason: string;
}): RunnerHandoffEvidence {
  return promotionHandoffEvidence({
    outcome: 'blocked',
    publishability: input.publishability,
    nextAction: input.nextAction,
    fallbackReason: input.fallbackReason,
  });
}

export function buildReviewReadyHandoffEvidence(input: {
  publishability: Extract<ImplementationPublishabilityResult, { status: 'publish-ready' }>;
  freshContextReview?: FreshContextReviewEvidence;
  nextAction: string;
}): RunnerHandoffEvidence {
  return {
    outcome: 'review-ready',
    changedFiles: input.publishability.changedFiles,
    validation: input.publishability.validation,
    skippedChecks: input.publishability.skippedChecks,
    residualRisks: [
      ...input.publishability.residualRisks,
      ...(input.freshContextReview?.residualRisks ?? []),
    ],
    blockers: [],
    nextAction: input.nextAction,
    suggestionEvidence: input.freshContextReview?.findings,
    acceptanceProof: input.publishability.acceptanceProofAttempt,
  };
}

function promotionHandoffEvidence(input: {
  outcome: 'blocked' | 'promotion-requested';
  publishability: Extract<ImplementationPublishabilityResult, { status: 'promotion-requested' }>;
  nextAction: string;
  fallbackReason: string;
}): RunnerHandoffEvidence {
  const promotion = input.publishability.report.promotion;
  return {
    outcome: input.outcome,
    changedFiles: [],
    validation: input.publishability.report.validation,
    skippedChecks: input.publishability.report.skippedChecks,
    residualRisks: input.publishability.report.residualRisks,
    blockers: [promotion?.reason ?? input.fallbackReason],
    nextAction: input.nextAction,
  };
}
