import type { EvaluationResult } from './mission-evaluation.js';
import {
  authorizeMissionCapability,
  type MissionCapabilityPermit,
} from './mission-capability-kernel.js';
import type {
  MissionApplyIntent,
  MissionApplyPermit,
  MissionApplyReceipt,
} from './mission-git-contracts.js';
import {
  assertMissionApplyIntent,
  assertMissionApplyReceipt,
  missionApplyPermitFingerprint,
  validateMissionApplyPermit,
} from './mission-git-contracts.js';

export const missionStates = [
  'created', 'claiming', 'evaluating', 'diagnosing', 'authorizing', 'executing',
  'auditing', 'apply-authorizing', 'apply-prepared', 'applying', 'reconciling',
  'candidate-ready', 'publication-prepared', 'integration-ready', 'resumable',
  'cancelling', 'external-input-required', 'safety-stop', 'cancelled', 'completed',
] as const;

export type MissionState = (typeof missionStates)[number];

export interface MissionRecord {
  id: string;
  revision: number;
  state: MissionState;
  findingIds?: string[];
  residualFindingIds?: string[];
  resumeTarget?: SafeResumeTarget;
  nextEligibleAt?: string;
  actionKey?: string;
  inputSnapshot?: string;
  fencingEpoch?: number;
  authorizedPermit?: MissionCapabilityPermit;
  actionExecutions?: Record<string, MissionActionExecution>;
  applyPermit?: MissionApplyPermit;
  applyIntent?: MissionApplyIntent;
  applyReceipt?: MissionApplyReceipt;
  applyHistory?: MissionApplyReceipt[];
}

export interface MissionActionExecution {
  permitFingerprint: string;
  status: 'in-flight' | 'completed';
  receiptSha256?: string;
}

export const safeResumeTargets = [
  'claiming',
  'diagnosing',
  'authorizing',
  'apply-authorizing',
  'reconciling',
  'publication-prepared',
] as const;

export type SafeResumeTarget = (typeof safeResumeTargets)[number];

export type MissionEvent =
  | {
      type: 'evaluation-completed';
      result: EvaluationResult;
    }
  | {
      type: 'execution-transient-failure';
      actionKey: string;
      nextEligibleAt: string;
    }
  | {
      type: 'resume-eligible';
      now: string;
    }
  | {
      type: 'apply-reconciled-old-identity';
    }
  | {
      type:
        | 'claim-transient-failure'
        | 'diagnosis-transient-failure'
        | 'authorization-temporary'
        | 'apply-authorization-temporary'
        | 'reconciliation-transient-failure'
        | 'publication-transient-failure';
      actionKey: string;
      nextEligibleAt: string;
    }
  | {
      type: 'capability-authorized';
      actionKey: string;
      permit: MissionCapabilityPermit;
    }
  | {
      type: 'apply-authorized';
      actionKey: string;
      permit: MissionApplyPermit;
    }
  | {
      type: 'apply-started';
      intent: MissionApplyIntent;
    }
  | {
      type: 'apply-reconciled-new-identity';
      intent: MissionApplyIntent;
      receipt: MissionApplyReceipt;
    }
  | {
      type:
        | 'claim-requested'
        | 'claim-observed'
        | 'diagnosis-valid'
        | 'diagnosis-invalid'
        | 'authorization-rejected'
        | 'authorization-external'
        | 'authorization-safety'
        | 'patch-received'
        | 'observation-received'
        | 'execution-deterministic-failure'
        | 'audit-rejected'
        | 'audit-safety'
        | 'audit-accepted'
        | 'apply-authorization-rejected'
        | 'apply-reconciled-third-identity'
        | 'reconciliation-satisfied'
        | 'adapt-to-publication'
        | 'adapt-to-integration'
        | 'publication-review-ready'
        | 'publication-external'
        | 'publication-safety'
        | 'publication-cancelled'
        | 'integration-accepted'
        | 'cancel-requested'
        | 'cancellation-reconciled';
    };

export const missionEventTypes = [
  'evaluation-completed',
  'execution-transient-failure',
  'resume-eligible',
  'apply-reconciled-old-identity',
  'claim-transient-failure',
  'diagnosis-transient-failure',
  'authorization-temporary',
  'apply-authorization-temporary',
  'reconciliation-transient-failure',
  'publication-transient-failure',
  'capability-authorized',
  'claim-requested',
  'claim-observed',
  'diagnosis-valid',
  'diagnosis-invalid',
  'authorization-rejected',
  'authorization-external',
  'authorization-safety',
  'patch-received',
  'observation-received',
  'execution-deterministic-failure',
  'audit-rejected',
  'audit-safety',
  'audit-accepted',
  'apply-authorized',
  'apply-authorization-rejected',
  'apply-started',
  'apply-reconciled-new-identity',
  'apply-reconciled-third-identity',
  'reconciliation-satisfied',
  'adapt-to-publication',
  'adapt-to-integration',
  'publication-review-ready',
  'publication-external',
  'publication-safety',
  'publication-cancelled',
  'integration-accepted',
  'cancel-requested',
  'cancellation-reconciled',
] as const satisfies ReadonlyArray<MissionEvent['type']>;

type MissingMissionEventType = Exclude<MissionEvent['type'], (typeof missionEventTypes)[number]>;
const missionEventTypesAreExhaustive: MissingMissionEventType extends never ? true : false = true;
void missionEventTypesAreExhaustive;

export type MissionCliOutcome =
  | { kind: 'success'; missionId: string; state: 'completed' }
  | { kind: 'retryable'; missionId: string; state: 'resumable'; nextEligibleAt: string }
  | { kind: 'external-input'; missionId: string; state: 'external-input-required'; resumePredicate: string }
  | { kind: 'safety-stop'; missionId: string; state: 'safety-stop'; reason: string }
  | { kind: 'cancelled'; missionId: string; state: 'cancelled' };

export const terminalMissionStates = new Set<MissionState>([
  'external-input-required',
  'safety-stop',
  'cancelled',
  'completed',
]);

const transitionTargets: Partial<Record<MissionState, Partial<Record<MissionEvent['type'], MissionState>>>> = {
  created: {
    'claim-requested': 'claiming',
  },
  claiming: {
    'claim-observed': 'evaluating',
  },
  diagnosing: {
    'diagnosis-valid': 'authorizing',
    'diagnosis-invalid': 'diagnosing',
  },
  authorizing: {
    'capability-authorized': 'executing',
    'authorization-rejected': 'diagnosing',
    'authorization-external': 'external-input-required',
    'authorization-safety': 'safety-stop',
  },
  executing: {
    'patch-received': 'auditing',
    'observation-received': 'reconciling',
    'execution-deterministic-failure': 'diagnosing',
  },
  auditing: {
    'audit-rejected': 'diagnosing',
    'audit-safety': 'safety-stop',
    'audit-accepted': 'apply-authorizing',
  },
  'apply-authorizing': {
    'apply-authorized': 'apply-prepared',
    'apply-authorization-rejected': 'diagnosing',
  },
  'apply-prepared': {
    'apply-started': 'applying',
    'apply-reconciled-new-identity': 'reconciling',
    'apply-reconciled-third-identity': 'safety-stop',
  },
  applying: {
    'apply-reconciled-new-identity': 'reconciling',
    'apply-reconciled-third-identity': 'safety-stop',
  },
  reconciling: {
    'reconciliation-satisfied': 'evaluating',
    'apply-reconciled-third-identity': 'safety-stop',
  },
  'candidate-ready': {
    'adapt-to-publication': 'publication-prepared',
    'adapt-to-integration': 'integration-ready',
  },
  'publication-prepared': {
    'publication-review-ready': 'completed',
    'publication-external': 'external-input-required',
    'publication-safety': 'safety-stop',
    'publication-cancelled': 'cancelled',
  },
  'integration-ready': {
    'integration-accepted': 'completed',
  },
  cancelling: {
    'cancellation-reconciled': 'cancelled',
  },
};

const transientResumeTargets: Partial<Record<MissionEvent['type'], SafeResumeTarget>> = {
  'claim-transient-failure': 'claiming',
  'diagnosis-transient-failure': 'diagnosing',
  'authorization-temporary': 'authorizing',
  'execution-transient-failure': 'authorizing',
  'apply-authorization-temporary': 'apply-authorizing',
  'reconciliation-transient-failure': 'reconciling',
  'publication-transient-failure': 'publication-prepared',
};

export function transitionMission(record: MissionRecord, event: MissionEvent): MissionRecord {
  let authorizedCapabilityPermit: MissionCapabilityPermit | undefined;
  let authorizedApplyPermit: MissionApplyPermit | undefined;
  if (event.type === 'capability-authorized') {
    authorizedCapabilityPermit = authorizeMissionCapability(event.permit);
    if (authorizedCapabilityPermit.missionId !== record.id
      || authorizedCapabilityPermit.actionKey !== event.actionKey) {
      throw new Error('Mission capability authorization does not match the aggregate identity.');
    }
  }
  if (event.type === 'apply-authorized') {
    authorizedApplyPermit = validateMissionApplyPermit(event.permit);
    if (authorizedApplyPermit.missionId !== record.id
      || authorizedApplyPermit.actionKey !== event.actionKey) {
      throw new Error('Mission apply authorization does not match the aggregate identity.');
    }
    const fingerprint = missionApplyPermitFingerprint(authorizedApplyPermit);
    if (record.applyHistory?.some((receipt) => receipt.permitFingerprint === fingerprint)) {
      throw new Error('Mission apply authorization reuses an already completed permit.');
    }
  }
  if (event.type === 'apply-started') {
    assertMissionApplyIntent(event.intent);
    if (!record.applyPermit
      || event.intent.permitFingerprint !== missionApplyPermitFingerprint(record.applyPermit)) {
      throw new Error('Mission apply intent does not match the authorized permit.');
    }
  }
  if (event.type === 'apply-reconciled-new-identity') {
    assertMissionApplyIntent(event.intent);
    assertMissionApplyReceipt(event.receipt);
    if (!record.applyPermit
      || event.intent.permitFingerprint !== missionApplyPermitFingerprint(record.applyPermit)
      || event.receipt.permitFingerprint !== event.intent.permitFingerprint) {
      throw new Error('Mission apply receipt does not match the authorized intent.');
    }
  }
  if (record.state === 'evaluating' && event.type === 'evaluation-completed') {
    return {
      ...record,
      revision: record.revision + 1,
      state: stateForEvaluation(event.result.blockingDisposition),
      findingIds: event.result.findings.map((finding) => finding.id),
      residualFindingIds: event.result.findings
        .filter((finding) => finding.disposition === 'residual-warning')
        .map((finding) => finding.id),
    };
  }

  if (record.state === 'reconciling' && event.type === 'reconciliation-satisfied'
    && record.applyReceipt) {
    const {
      applyPermit: _applyPermit,
      applyIntent: _applyIntent,
      applyReceipt,
      ...rest
    } = record;
    return {
      ...rest,
      revision: record.revision + 1,
      state: 'evaluating',
      applyHistory: [...(record.applyHistory ?? []), structuredClone(applyReceipt)],
    };
  }

  if (record.state === 'executing' && event.type === 'execution-transient-failure') {
    return resumable(record, 'authorizing', event.actionKey, event.nextEligibleAt);
  }

  if (record.state === 'executing' && (event.type === 'patch-received'
    || event.type === 'observation-received'
    || event.type === 'execution-deterministic-failure')) {
    const { authorizedPermit: _authorizedPermit, ...rest } = record;
    return {
      ...rest,
      revision: record.revision + 1,
      state: event.type === 'patch-received' ? 'auditing'
        : event.type === 'observation-received' ? 'reconciling' : 'diagnosing',
    };
  }

  const transientTarget = transientResumeTargets[event.type];
  if (transientTarget && 'actionKey' in event && 'nextEligibleAt' in event
    && transientEventAllowed(record.state, event.type)) {
    return resumable(record, transientTarget, event.actionKey, event.nextEligibleAt);
  }

  if (record.state === 'resumable' && event.type === 'resume-eligible') {
    if (!record.resumeTarget || !record.nextEligibleAt || event.now < record.nextEligibleAt) {
      throw new Error('Mission is not eligible to resume.');
    }
    const { resumeTarget, nextEligibleAt: _nextEligibleAt, ...rest } = record;
    return {
      ...rest,
      revision: record.revision + 1,
      state: resumeTarget,
    };
  }

  if ((record.state === 'apply-prepared' || record.state === 'applying')
    && event.type === 'apply-reconciled-old-identity') {
    const {
      applyPermit: _applyPermit,
      applyIntent: _applyIntent,
      applyReceipt: _applyReceipt,
      ...rest
    } = record;
    return {
      ...rest,
      revision: record.revision + 1,
      state: 'apply-authorizing',
    };
  }

  if (event.type === 'cancel-requested' && !terminalMissionStates.has(record.state) && record.state !== 'cancelling') {
    const { resumeTarget: _resumeTarget, nextEligibleAt: _nextEligibleAt, ...rest } = record;
    return {
      ...rest,
      revision: record.revision + 1,
      state: 'cancelling',
    };
  }

  const target = transitionTargets[record.state]?.[event.type];
  if (target) {
    return {
      ...record,
      revision: record.revision + 1,
      state: target,
      ...('actionKey' in event ? { actionKey: event.actionKey } : {}),
      ...(event.type === 'capability-authorized' ? {
        authorizedPermit: authorizedCapabilityPermit!,
        inputSnapshot: authorizedCapabilityPermit!.inputSnapshot,
        fencingEpoch: authorizedCapabilityPermit!.fencingEpoch,
      } : {}),
      ...(event.type === 'apply-authorized' ? {
        actionKey: event.actionKey,
        applyPermit: authorizedApplyPermit!,
        fencingEpoch: authorizedApplyPermit!.fencingEpoch,
      } : {}),
      ...(event.type === 'apply-started' ? {
        applyIntent: structuredClone(event.intent),
      } : {}),
      ...(event.type === 'apply-reconciled-new-identity' ? {
        applyIntent: structuredClone(event.intent),
        applyReceipt: structuredClone(event.receipt),
      } : {}),
    };
  }

  throw new Error(`Mission transition is not allowed: ${record.state} + ${event.type}`);
}

function resumable(
  record: MissionRecord,
  resumeTarget: SafeResumeTarget,
  actionKey: string,
  nextEligibleAt: string,
): MissionRecord {
  const { authorizedPermit: _authorizedPermit, ...rest } = record;
  return {
    ...rest,
    revision: record.revision + 1,
    state: 'resumable',
    resumeTarget,
    nextEligibleAt,
    actionKey,
  };
}

function transientEventAllowed(state: MissionState, type: MissionEvent['type']): boolean {
  return (state === 'claiming' && type === 'claim-transient-failure')
    || (state === 'diagnosing' && type === 'diagnosis-transient-failure')
    || (state === 'authorizing' && type === 'authorization-temporary')
    || (state === 'apply-authorizing' && type === 'apply-authorization-temporary')
    || (state === 'reconciling' && type === 'reconciliation-transient-failure')
    || (state === 'publication-prepared' && type === 'publication-transient-failure');
}

function stateForEvaluation(disposition: EvaluationResult['blockingDisposition']): MissionState {
  switch (disposition) {
    case 'none':
      return 'candidate-ready';
    case 'diagnose':
      return 'diagnosing';
    case 'external-input':
      return 'external-input-required';
    case 'safety-stop':
      return 'safety-stop';
  }
}
