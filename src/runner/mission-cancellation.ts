import {
  transitionMission,
  type MissionProcessHandle,
  type MissionRecord,
} from './mission-state-machine.js';
import {
  assertMissionApplyReceipt,
  missionApplyPermitFingerprint,
  type MissionApplyReceipt,
} from './mission-git-contracts.js';
import type { MissionStateStore } from './mission-state-store.js';

export type MissionProcessTerminationResult =
  | { kind: 'terminated' }
  | { kind: 'already-exited' }
  | { kind: 'transient-failure'; reason: string };

export interface MissionCancellationDependencies {
  terminate(process: MissionProcessHandle): Promise<MissionProcessTerminationResult>;
  reconcileApply(mission: MissionRecord): Promise<MissionCancellationApplyReconciliation>;
  nextEligibleAt(reason: string): string;
}

export type MissionCancellationApplyReconciliation =
  | { kind: 'old-identity' }
  | { kind: 'new-identity'; receipt: MissionApplyReceipt }
  | { kind: 'transient-failure'; reason: string }
  | { kind: 'safety-stop'; reason: string };

export type MissionObservedProcessIdentity = 'matching' | 'missing' | 'different';

export interface MissionProcessGroupTerminatorOptions {
  hostId: string;
  bootNonce: string;
  graceMs: number;
}

export interface MissionProcessGroupTerminatorDependencies {
  observe(process: MissionProcessHandle): Promise<MissionObservedProcessIdentity>;
  signalProcessGroup(pid: number, signal: NodeJS.Signals): void;
  wait(milliseconds: number): Promise<void>;
}

export class MissionProcessGroupTerminator {
  public constructor(
    private readonly options: MissionProcessGroupTerminatorOptions,
    private readonly dependencies: MissionProcessGroupTerminatorDependencies,
  ) {
    requireText(options.hostId, 'terminator hostId');
    requireText(options.bootNonce, 'terminator bootNonce');
    if (!Number.isSafeInteger(options.graceMs) || options.graceMs < 0) {
      throw new Error('Mission cancellation terminator graceMs must be a non-negative integer.');
    }
  }

  public async terminate(process: MissionProcessHandle): Promise<MissionProcessTerminationResult> {
    if (process.hostId !== this.options.hostId) {
      return { kind: 'transient-failure', reason: 'process-owned-by-different-host' };
    }
    if (process.bootNonce !== this.options.bootNonce) {
      return { kind: 'already-exited' };
    }
    if (await this.dependencies.observe(process) !== 'matching') {
      return { kind: 'already-exited' };
    }
    this.dependencies.signalProcessGroup(process.pid, 'SIGTERM');
    await this.dependencies.wait(this.options.graceMs);
    if (await this.dependencies.observe(process) !== 'matching') {
      return { kind: 'terminated' };
    }
    this.dependencies.signalProcessGroup(process.pid, 'SIGKILL');
    await this.dependencies.wait(this.options.graceMs);
    if (await this.dependencies.observe(process) !== 'matching') {
      return { kind: 'terminated' };
    }
    return { kind: 'transient-failure', reason: 'process-group-still-live-after-sigkill' };
  }
}

export type MissionCancellationOutcome =
  | { kind: 'cancelled'; missionId: string; state: 'cancelled' }
  | { kind: 'safety-stop'; missionId: string; state: 'safety-stop'; reason: string }
  | {
      kind: 'resumable';
      missionId: string;
      state: 'cancelling';
      reason: string;
      nextEligibleAt: string;
    };

export class MissionCancellationCoordinator {
  public constructor(
    private readonly store: MissionStateStore,
    private readonly dependencies: MissionCancellationDependencies,
  ) {}

  public async cancel(input: {
    expectedGeneration: number;
    missionId: string;
    expectedRevision: number;
    requestedAt: string;
    requestedBy: string;
  }): Promise<MissionCancellationOutcome> {
    assertTimestamp(input.requestedAt, 'requestedAt');
    requireText(input.requestedBy, 'requestedBy');
    const cancelling = await this.store.mutate(input.expectedGeneration, (draft) => {
      const current = draft.missions[input.missionId];
      if (!current) throw new Error(`Mission cancellation cannot find ${input.missionId}.`);
      if (current.revision !== input.expectedRevision) {
        throw new Error(`Mission cancellation revision conflict for ${input.missionId}.`);
      }
      const next = current.state === 'cancelling'
        ? { ...current, revision: current.revision + 1 }
        : transitionMission(current, { type: 'cancel-requested' });
      draft.missions[input.missionId] = {
        ...next,
        cancellation: {
          requestedAt: current.cancellation?.requestedAt ?? input.requestedAt,
          requestedBy: current.cancellation?.requestedBy ?? input.requestedBy,
        },
      };
    });
    const mission = cancelling.missions[input.missionId]!;
    for (const process of mission.claim?.processes ?? []) {
      const termination = await this.dependencies.terminate(process);
      if (termination.kind === 'transient-failure') {
        return this.deferCancellation(cancelling.generation, input.missionId,
          mission.revision, termination.reason);
      }
    }
    let reconciledReceipt: MissionApplyReceipt | undefined;
    if (mission.applyIntent || mission.applyReceipt) {
      const reconciliation = await this.dependencies.reconcileApply(structuredClone(mission));
      if (reconciliation.kind === 'transient-failure') {
        return this.deferCancellation(cancelling.generation, input.missionId,
          mission.revision, reconciliation.reason);
      }
      if (reconciliation.kind === 'safety-stop') {
        return this.persistSafetyStop(cancelling.generation, input.missionId,
          mission.revision, reconciliation.reason);
      }
      if (reconciliation.kind === 'old-identity') {
        if (mission.applyReceipt) {
          return this.persistSafetyStop(cancelling.generation, input.missionId,
            mission.revision, 'receipt-ref-mismatch');
        }
      } else if (!validReconciledReceipt(mission, reconciliation.receipt)) {
        return this.persistSafetyStop(cancelling.generation, input.missionId,
          mission.revision, 'apply-reconciliation-receipt-mismatch');
      } else {
        reconciledReceipt = reconciliation.receipt;
      }
    }
    const completed = await this.completeCancellation(cancelling.generation, input.missionId,
      mission.revision, reconciledReceipt);
    if (completed.missions[input.missionId]?.state !== 'cancelled') {
      throw new Error('Mission cancellation did not reach cancelled state.');
    }
    return { kind: 'cancelled', missionId: input.missionId, state: 'cancelled' };
  }

  private completeCancellation(
    expectedGeneration: number,
    missionId: string,
    expectedRevision: number,
    receipt?: MissionApplyReceipt,
  ) {
    return this.store.mutate(expectedGeneration, (draft) => {
      const current = draft.missions[missionId];
      if (!current || current.revision !== expectedRevision || current.state !== 'cancelling') {
        throw new Error(`Mission cancellation reconciliation conflict for ${missionId}.`);
      }
      if (receipt && !current.applyHistory?.some((entry) =>
        entry.permitFingerprint === receipt.permitFingerprint)) {
        current.applyHistory = [...(current.applyHistory ?? []), structuredClone(receipt)];
      }
      draft.missions[missionId] = transitionMission(current, {
        type: 'cancellation-reconciled',
      });
      delete draft.nextEligibleAt[missionId];
      delete draft.reservations[missionId];
    });
  }

  private async deferCancellation(
    expectedGeneration: number,
    missionId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<MissionCancellationOutcome> {
    const nextEligibleAt = this.dependencies.nextEligibleAt(reason);
    assertTimestamp(nextEligibleAt, 'nextEligibleAt');
    await this.store.mutate(expectedGeneration, (draft) => {
      const current = draft.missions[missionId];
      if (!current || current.revision !== expectedRevision || current.state !== 'cancelling'
        || !current.claim) {
        throw new Error(`Mission cancellation retry cannot fence ${missionId}.`);
      }
      current.claim.leaseUntil = nextEligibleAt;
      current.revision += 1;
      draft.nextEligibleAt[missionId] = nextEligibleAt;
    });
    return {
      kind: 'resumable',
      missionId,
      state: 'cancelling',
      reason,
      nextEligibleAt,
    };
  }

  private async persistSafetyStop(
    expectedGeneration: number,
    missionId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<MissionCancellationOutcome> {
    requireText(reason, 'safety-stop reason');
    await this.store.mutate(expectedGeneration, (draft) => {
      const current = draft.missions[missionId];
      if (!current || current.revision !== expectedRevision || current.state !== 'cancelling') {
        throw new Error(`Mission cancellation safety-stop cannot fence ${missionId}.`);
      }
      draft.missions[missionId] = transitionMission(current, {
        type: 'apply-reconciled-third-identity',
      });
      delete draft.nextEligibleAt[missionId];
      delete draft.reservations[missionId];
    });
    return { kind: 'safety-stop', missionId, state: 'safety-stop', reason };
  }
}

function validReconciledReceipt(mission: MissionRecord, receipt: MissionApplyReceipt): boolean {
  try {
    assertMissionApplyReceipt(receipt);
  } catch {
    return false;
  }
  const permit = mission.applyPermit;
  const intent = mission.applyIntent;
  return Boolean(permit && intent
    && intent.permitFingerprint === missionApplyPermitFingerprint(permit)
    && receipt.permitFingerprint === intent.permitFingerprint
    && receipt.targetRef === permit.targetRef
    && receipt.oldCommitSha === permit.expectedOldCommit
    && receipt.commitSha === permit.expectedNewCommit
    && receipt.treeSha === permit.expectedNewTree);
}

function assertTimestamp(value: string, field: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`Mission cancellation ${field} must be an exact UTC ISO timestamp.`);
  }
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`Mission cancellation ${field} must be non-empty.`);
}
