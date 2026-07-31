import { canonicalJson, sha256 } from './containment.js';
import type { CodeReviewReportV1 } from './code-review-report.js';
import type { DeliveryAuthorityV1 } from './delivery-authority.js';
import {
  acceptApprovedDirectReview,
  acceptNeedsWorkDirectReview,
  beginDirectReviewRepair,
  createInitialDirectReview,
  prepareDirectReview,
  recoverTerminalDirectReviewReport,
} from './direct-delivery.js';
import type { DirectRepairFindingV1 } from './direct-delivery.js';
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
  | 'directReview'
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
    if (run.directReview?.status === 'terminal' || run.directReview?.status === 'clear') {
      throw new Error('implementing validation progression has an invalid review projection');
    }
    phase = run.directReview?.stage === 'review' ? 'full-review' : 'implementation';
  } else if (run.lifecycle === 'checking') {
    phase = 'checks';
  } else if (run.lifecycle === 'proving') {
    phase = 'acceptance-proof';
  } else if (run.lifecycle === 'publishing') {
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

export function projectValidationRepair(
  run: Readonly<RunRecord>,
  findings: readonly string[],
  sources?: readonly ValidationRepairSource[],
): ValidationCasTransition {
  const authority = run.deliveryAuthority;
  if (!authority) throw new Error('validation repair requires delivery authority');
  if (findings.length === 0) throw new Error('validation repair requires findings');
  const directReview = run.directReview?.status === 'clear'
    ? beginDirectReviewRepair(run.directReview, (sources ?? findings.map((summary) => {
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
      targetRevision: run.directReview!.targetRevision,
      summary: source.summary,
      affectedContracts: [...source.affectedContracts],
      status: 'open' as const,
    })))
    : run.directReview;
  return casTransition(run, 'semantic-repair', {
    lifecycle: 'implementing',
    changeBindingVersion: undefined,
    candidateBinding: undefined,
    cycle: run.reviewFeedback?.activeBatch ? run.cycle : (run.cycle + 1) as RunRecord['cycle'],
    ...(run.reviewFeedback?.activeBatch ? { reviewFeedback: reserveNextReviewFeedbackRound(run.reviewFeedback) } : {}),
    reworkFindings: [...findings],
    ...(directReview ? { directReview } : {}),
    checks: [],
    checkedChangeSha256: undefined,
    proofId: undefined,
    proofReceipt: undefined,
  });
}

export function projectValidationReviewStart(
  run: Readonly<RunRecord>,
  input: { targetFingerprint: string; reviewerSessionId: string },
): ValidationCasTransition {
  const directReview = run.directReview?.stage === 'review-repair'
    ? prepareDirectReview(run.directReview, input.targetFingerprint, input.reviewerSessionId)
    : createInitialDirectReview({
      targetFingerprint: input.targetFingerprint,
      codeReviewerSessionId: input.reviewerSessionId,
    });
  return casTransition(run, 'review-start', { directReview });
}

export function projectValidationReviewNeedsWork(
  run: Readonly<RunRecord>,
  report: CodeReviewReportV1,
  artifactSha256: string,
): ValidationCasTransition {
  if (!run.directReview) throw new Error('validation review result is orphaned');
  const repaired = acceptNeedsWorkDirectReview(run.directReview, report, artifactSha256);
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
    directReview: repaired,
    reworkFindings: findings,
    checks: [],
    checkedChangeSha256: undefined,
    proofId: undefined,
    proofReceipt: undefined,
  });
}

export function projectValidationReviewApproved(
  run: Readonly<RunRecord>,
  report: CodeReviewReportV1,
  artifactSha256: string,
): ValidationCasTransition {
  if (!run.directReview) throw new Error('validation review result is orphaned');
  return casTransition(run, 'review-approved', {
    lifecycle: 'checking',
    directReview: acceptApprovedDirectReview(run.directReview, report, artifactSha256),
  });
}

export function projectValidationReviewReportRepair(run: Readonly<RunRecord>): ValidationCasTransition {
  const current = run.directReview;
  if (!current) throw new Error('validation review result is orphaned');
  return casTransition(run, 'review-report-repair', {
    directReview: {
      ...structuredClone(current),
      review: {
        ...current.review,
        reportRepairs: (current.review.reportRepairs + 1) as typeof current.review.reportRepairs,
      },
    },
  });
}

export function projectValidationReviewTransportRetry(run: Readonly<RunRecord>): ValidationCasTransition {
  const current = run.directReview;
  if (!current) throw new Error('validation review result is orphaned');
  return casTransition(run, 'review-transport-retry', {
    directReview: {
      ...structuredClone(current),
      review: { ...current.review, transportRetries: 1 },
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

export function projectValidationFeedbackActivation(
  run: Readonly<RunRecord>,
  input: {
    batch: FrozenReviewFeedbackBatchV1;
    repairFindings: DirectRepairFindingV1[];
    pendingEffect: PendingEffectInput;
  },
): ValidationCasTransition {
  if (!run.reviewFeedback || run.directReview?.status !== 'clear') {
    throw new Error('validation feedback activation requires a clear reviewed Run');
  }
  const repairReview = beginDirectReviewRepair(run.directReview, input.repairFindings);
  return casTransition(run, 'feedback-activation', {
    lifecycle: 'implementing',
    reviewFeedback: activateReviewFeedback(run.reviewFeedback, input.batch),
    directReview: {
      ...repairReview,
      review: { ...repairReview.review, reportRepairs: 0, transportRetries: 0 },
    },
    reworkFindings: input.repairFindings.map((finding) => finding.summary),
    reportRepairs: 0,
    transportRetries: 0,
    checks: [],
    checkedChangeSha256: undefined,
    proofId: undefined,
    proofReceipt: undefined,
    terminalOutcome: undefined,
    outcomeEvidenceId: undefined,
    pendingEffect: structuredClone(input.pendingEffect),
  });
}

export function projectTerminalValidationReviewRecovery(run: Readonly<RunRecord>): ValidationCasTransition {
  if (!run.directReview) throw new Error('terminal validation review is missing');
  return casTransition(run, 'terminal-review-recovery', {
    lifecycle: 'implementing',
    directReview: recoverTerminalDirectReviewReport(run.directReview),
    terminalOutcome: undefined,
    outcomeEvidenceId: undefined,
  });
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
