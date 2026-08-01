import { canonicalJson, sha256 } from './containment.js';
import type { CodeReviewReportV1 } from './code-review-report.js';
import type { DeliveryAuthorityV1 } from './delivery-authority.js';
import {
  acceptApprovedReviewData,
  acceptNeedsWorkReviewData,
  beginReviewDataRepair,
  createInitialReviewData,
  hasApprovedReviewReceipt,
  MAX_DIRECT_REVIEW_REPORT_REPAIRS,
  prepareReviewData,
  recoverTerminalReviewDataReport,
} from './review-data.js';
import type { DirectRepairFindingV1 } from './review-data.js';
import {
  activateReviewFeedback,
  markReviewFeedbackVerified,
  reserveNextReviewFeedbackRound,
  type FrozenReviewFeedbackBatchV1,
} from './review-feedback.js';
import type { Lifecycle, PendingEffect, PendingEffectInput, RunRecord } from './run-store.js';

export type ValidationProgressionPhase =
  | 'implementation'
  | 'full-review'
  | 'checks'
  | 'acceptance-proof'
  | 'publication';

export interface ValidationProgressionTransition {
  kind: 'dispatch';
  phase: ValidationProgressionPhase;
  expected: {
    runId: string;
    lifecycle: Lifecycle;
    cycle: RunRecord['cycle'];
    authoritySha256: string;
    activeAttemptId: string | null;
    pendingEffectId: string | null;
  };
  feedback: { batchId: string; repairRound: 1 | 2 | 3 } | null;
}

export interface ValidationRepairSource {
  provenance: 'check' | 'proof';
  sourceId: string;
  summary: string;
  affectedContracts: string[];
}

export type ValidationProgressionChanges = Partial<Pick<RunRecord,
  | 'lifecycle'
  | 'cycle'
  | 'reviewData'
  | 'reviewFeedback'
  | 'reworkFindings'
  | 'checks'
  | 'checkedChangeSha256'
  | 'proofId'
  | 'proofExecution'
  | 'proofReceipt'
  | 'terminalOutcome'
  | 'outcomeEvidenceId'
  | 'changeBindingVersion'
  | 'candidateBinding'
  | 'reportRepairs'
  | 'transportRetries'
>>;
export type ValidationTransitionChanges = ValidationProgressionChanges & {
  pendingEffect?: PendingEffect | PendingEffectInput | undefined;
};

export interface ValidationCasTransition {
  kind: 'cas';
  reason:
    | 'review-start'
    | 'review-needs-work'
    | 'review-approved'
    | 'review-report-repair'
    | 'review-transport-retry'
    | 'semantic-repair'
    | 'proof-start'
    | 'proof-receipt-retained'
    | 'proof-recovery-advanced'
    | 'proof-passed'
    | 'feedback-activation'
    | 'terminal-review-recovery';
  expected: ValidationProgressionTransition['expected'];
  changes: ValidationTransitionChanges;
}

export function nextValidationTransition(
  run: Readonly<RunRecord>,
  authority: Readonly<DeliveryAuthorityV1>,
): ValidationProgressionTransition {
  if (!run.deliveryAuthority || canonicalJson(run.deliveryAuthority) !== canonicalJson(authority)) {
    throw new Error('validation progression authority mismatch');
  }
  if (run.pendingEffect) throw new Error('validation progression cannot dispatch with a pending effect');

  let phase: ValidationProgressionPhase;
  if (run.lifecycle === 'implementing') {
    phase = run.reviewData?.receipt === null ? 'full-review' : 'implementation';
  } else if (run.lifecycle === 'checking') {
    requireApprovedReviewReceipt(run);
    phase = 'checks';
  } else if (run.lifecycle === 'proving') {
    requireApprovedReviewReceipt(run);
    phase = 'acceptance-proof';
  } else if (run.lifecycle === 'publishing') {
    requireApprovedReviewReceipt(run);
    if (!run.proofReceipt) throw new Error('publication validation progression requires a proof receipt');
    phase = 'publication';
  } else {
    throw new Error(`run lifecycle ${run.lifecycle} is outside validation progression`);
  }

  const batch = run.reviewFeedback?.activeBatch;
  const repairRound = run.reviewFeedback?.repairRound;
  if (batch && repairRound !== 1 && repairRound !== 2 && repairRound !== 3) {
    throw new Error('post-PR validation progression repair round is invalid');
  }
  return {
    kind: 'dispatch',
    phase,
    expected: transitionExpected(run, authority),
    feedback: batch ? { batchId: batch.batchId, repairRound: repairRound as 1 | 2 | 3 } : null,
  };
}

export function validationRepairBudgetExhausted(run: Readonly<RunRecord>, maxCycles: number): boolean {
  return run.reviewFeedback?.activeBatch
    ? run.reviewFeedback.repairRound >= 3
    : run.cycle >= maxCycles;
}

export function projectValidationRepair(
  run: Readonly<RunRecord>,
  findings: readonly string[],
  sources?: readonly ValidationRepairSource[],
): ValidationCasTransition {
  const authority = run.deliveryAuthority;
  if (!authority) throw new Error('validation repair requires delivery authority');
  if (findings.length === 0) throw new Error('validation repair requires findings');
  const reviewData = run.reviewData && hasApprovedReviewReceipt(run.reviewData)
    ? beginReviewDataRepair(run.reviewData, (sources ?? findings.map((summary) => {
      const provenance = run.lifecycle === 'proving' ? 'proof' as const : 'check' as const;
      return {
        provenance,
        sourceId: `${provenance}:recovery:${sha256(summary)}`,
        summary,
        affectedContracts: [provenance === 'proof' ? 'acceptance-proof' : 'configured-checks'],
      };
    })).map((source) => ({
      id: source.sourceId,
      provenance: source.provenance,
      sourceId: source.sourceId,
      targetRevision: run.reviewData!.targetRevision,
      summary: source.summary,
      affectedContracts: [...source.affectedContracts],
      status: 'open' as const,
    })))
    : run.reviewData;
  return casTransition(run, 'semantic-repair', {
    lifecycle: 'implementing',
    changeBindingVersion: undefined,
    candidateBinding: undefined,
    cycle: run.reviewFeedback?.activeBatch ? run.cycle : (run.cycle + 1) as RunRecord['cycle'],
    ...(run.reviewFeedback?.activeBatch ? { reviewFeedback: reserveNextReviewFeedbackRound(run.reviewFeedback) } : {}),
    reworkFindings: [...findings],
    ...(reviewData ? { reviewData } : {}),
    checks: [],
    checkedChangeSha256: undefined,
    proofId: undefined,
    proofExecution: undefined,
    proofReceipt: undefined,
  });
}

export function projectValidationReviewStart(
  run: Readonly<RunRecord>,
  input: { targetFingerprint: string; reviewerSessionId: string },
): ValidationCasTransition {
  const reviewData = run.reviewData && run.reviewData.receipt !== null
    ? prepareReviewData(run.reviewData, input.targetFingerprint, input.reviewerSessionId)
    : createInitialReviewData({
      targetFingerprint: input.targetFingerprint,
      codeReviewerSessionId: input.reviewerSessionId,
    });
  return casTransition(run, 'review-start', { reviewData });
}

export function projectValidationReviewNeedsWork(
  run: Readonly<RunRecord>,
  report: CodeReviewReportV1,
  artifactSha256: string,
): ValidationCasTransition {
  if (!run.reviewData) throw new Error('validation review result is orphaned');
  const repaired = acceptNeedsWorkReviewData(run.reviewData, report, artifactSha256);
  const findings = [
    ...report.defects
      .filter((defect) => defect.status === 'open' || defect.status === 'reopened')
      .map((defect) => `${defect.id}: ${defect.failure}\nRepair: ${defect.repair}`),
    ...repaired.repairFindings
      .filter((finding) => finding.status === 'reopened')
      .map((finding) => `${finding.id}: ${finding.summary}`),
  ];
  return casTransition(run, 'review-needs-work', {
    lifecycle: 'implementing',
    cycle: run.reviewFeedback?.activeBatch ? run.cycle : (run.cycle + 1) as RunRecord['cycle'],
    ...(run.reviewFeedback?.activeBatch ? { reviewFeedback: reserveNextReviewFeedbackRound(run.reviewFeedback) } : {}),
    reviewData: repaired,
    reworkFindings: findings,
    checks: [],
    checkedChangeSha256: undefined,
    proofId: undefined,
    proofExecution: undefined,
    proofReceipt: undefined,
  });
}

export function projectValidationReviewApproved(
  run: Readonly<RunRecord>,
  report: CodeReviewReportV1,
  artifactSha256: string,
): ValidationCasTransition {
  if (!run.reviewData) throw new Error('validation review result is orphaned');
  return casTransition(run, 'review-approved', {
    lifecycle: 'checking',
    reviewData: acceptApprovedReviewData(run.reviewData, report, artifactSha256),
  });
}

export function projectValidationReviewReportRepair(run: Readonly<RunRecord>): ValidationCasTransition {
  const current = run.reviewData;
  if (!current) throw new Error('validation review result is orphaned');
  if (current.receipt !== null || current.reportRepairs >= MAX_DIRECT_REVIEW_REPORT_REPAIRS) {
    throw new Error('validation review report repair budget is exhausted');
  }
  return casTransition(run, 'review-report-repair', {
    reviewData: {
      ...structuredClone(current),
      reportRepairs: (current.reportRepairs + 1) as typeof current.reportRepairs,
    },
  });
}

export function projectValidationReviewTransportRetry(run: Readonly<RunRecord>): ValidationCasTransition {
  const current = run.reviewData;
  if (!current) throw new Error('validation review result is orphaned');
  if (current.receipt !== null || current.transportRetries >= 1) {
    throw new Error('validation review transport retry budget is exhausted');
  }
  return casTransition(run, 'review-transport-retry', {
    reviewData: {
      ...structuredClone(current),
      transportRetries: 1,
    },
  });
}

export function projectValidationProofStart(
  run: Readonly<RunRecord>,
  input: {
    checkedChangeSha256: string;
    proofId: string;
    proofExecution: NonNullable<RunRecord['proofExecution']>;
  },
): ValidationCasTransition {
  return casTransition(run, 'proof-start', {
    lifecycle: 'proving',
    checkedChangeSha256: input.checkedChangeSha256,
    proofId: input.proofId,
    proofExecution: structuredClone(input.proofExecution),
  });
}

export function projectValidationProofPassed(
  run: Readonly<RunRecord>,
  input: {
    checkedChangeSha256: string;
    proofId: string;
    proofReceipt: NonNullable<RunRecord['proofReceipt']>;
    verifiedAt: string;
  },
): ValidationCasTransition {
  return casTransition(run, 'proof-passed', {
    lifecycle: 'publishing',
    proofReceipt: structuredClone(input.proofReceipt),
    reworkFindings: [],
    ...(run.reviewFeedback?.activeBatch ? {
      reviewFeedback: markReviewFeedbackVerified(run.reviewFeedback, {
        checkedChangeSha256: input.checkedChangeSha256,
        proofId: input.proofId,
        verifiedAt: input.verifiedAt,
      }),
    } : {}),
  });
}

export function projectValidationProofReceiptRetained(
  run: Readonly<RunRecord>,
  proofReceipt: NonNullable<RunRecord['proofReceipt']>,
): ValidationCasTransition {
  return casTransition(run, 'proof-receipt-retained', {
    lifecycle: 'proving',
    proofReceipt: structuredClone(proofReceipt),
  });
}

export function projectValidationProofRecovery(
  run: Readonly<RunRecord>,
  proofExecution: NonNullable<RunRecord['proofExecution']>,
): ValidationCasTransition {
  return casTransition(run, 'proof-recovery-advanced', {
    lifecycle: 'proving',
    proofExecution: structuredClone(proofExecution),
  });
}

export function projectValidationFeedbackActivation(
  run: Readonly<RunRecord>,
  input: {
    batch: FrozenReviewFeedbackBatchV1;
    repairFindings: DirectRepairFindingV1[];
    pendingEffect: PendingEffectInput;
  },
): ValidationCasTransition {
  if (run.lifecycle !== 'review-ready' || !run.reviewFeedback || !run.reviewData
    || !hasApprovedReviewReceipt(run.reviewData)) {
    throw new Error('validation feedback activation requires an approved review receipt');
  }
  const repairReview = beginReviewDataRepair(run.reviewData, input.repairFindings);
  return casTransition(run, 'feedback-activation', {
    lifecycle: 'implementing',
    reviewFeedback: activateReviewFeedback(run.reviewFeedback, input.batch),
    reviewData: {
      ...repairReview,
      reportRepairs: 0,
      transportRetries: 0,
    },
    reworkFindings: input.repairFindings.map((finding) => finding.summary),
    reportRepairs: 0,
    transportRetries: 0,
    checks: [],
    checkedChangeSha256: undefined,
    proofId: undefined,
    proofExecution: undefined,
    proofReceipt: undefined,
    terminalOutcome: undefined,
    outcomeEvidenceId: undefined,
    pendingEffect: structuredClone(input.pendingEffect),
  });
}

export function projectTerminalValidationReviewRecovery(run: Readonly<RunRecord>): ValidationCasTransition {
  if (!run.reviewData || run.lifecycle !== 'internal-error'
    || run.terminalOutcome?.status !== 'internal-error'
    || run.terminalOutcome.code !== 'direct-review-report-malformed') {
    throw new Error('terminal validation review is missing');
  }
  return casTransition(run, 'terminal-review-recovery', {
    lifecycle: 'implementing',
    reviewData: recoverTerminalReviewDataReport(run.reviewData),
    terminalOutcome: undefined,
    outcomeEvidenceId: undefined,
  });
}

function requireApprovedReviewReceipt(run: Readonly<RunRecord>): void {
  if (!run.reviewData || !hasApprovedReviewReceipt(run.reviewData)) {
    throw new Error(`${run.lifecycle} validation progression requires an approved review receipt`);
  }
}

export function consumeValidationTransition(
  run: Readonly<RunRecord>,
  transition: Readonly<ValidationCasTransition>,
): ValidationTransitionChanges {
  const authority = run.deliveryAuthority;
  if (!authority || canonicalJson(transition.expected) !== canonicalJson(transitionExpected(run, authority))) {
    throw new Error('validation transition expected state mismatch');
  }
  return structuredClone(transition.changes);
}

export function applyValidationTransition<T>(
  run: Readonly<RunRecord>,
  transition: Readonly<ValidationCasTransition>,
  write: (changes: ValidationTransitionChanges) => T,
): T {
  return write(consumeValidationTransition(run, transition));
}

function transitionExpected(
  run: Readonly<RunRecord>,
  authority: Readonly<DeliveryAuthorityV1>,
): ValidationProgressionTransition['expected'] {
  return {
    runId: run.runId,
    lifecycle: run.lifecycle,
    cycle: run.cycle,
    authoritySha256: authority.authoritySha256,
    activeAttemptId: run.activeAttempt?.attemptId ?? null,
    pendingEffectId: run.pendingEffect?.effectId ?? null,
  };
}

function casTransition(
  run: Readonly<RunRecord>,
  reason: ValidationCasTransition['reason'],
  changes: ValidationTransitionChanges,
): ValidationCasTransition {
  const authority = run.deliveryAuthority;
  if (!authority) throw new Error('validation transition requires delivery authority');
  return { kind: 'cas', reason, expected: transitionExpected(run, authority), changes };
}
