import {
  linkWaveChildren,
  planParentScheduleKey,
  transitionPlanParent,
  type PlanParentChildDescriptor,
  type PlanParentIntegrationIntent,
  type PlanParentRecord,
  type PlanParentResumeTarget,
} from './mission-plan-parent.js';
import {
  integrationRecoveryMissionId,
  validationRecoveryMissionId,
} from './mission-identifiers.js';
import { terminalMissionStates, transitionMission, type MissionClaim } from './mission-state-machine.js';
import {
  assertMissionPublicationRecord,
  publicationScheduleKey,
  transitionMissionPublication,
  type MissionPublicationRecord,
} from './mission-publication.js';
import type { JsonValue, MissionStateSnapshot, MissionStateStore } from './mission-state-store.js';

export class MissionPlanParentCoordinator {
  public constructor(private readonly store: MissionStateStore) {}

  public create(input: {
    expectedGeneration: number;
    parent: PlanParentRecord;
  }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      if (draft.planParents[input.parent.id]) {
        throw new Error(`Plan Parent ${input.parent.id} already exists.`);
      }
      draft.planParents[input.parent.id] = structuredClone(input.parent);
    });
  }

  public linkNextWave(input: ParentFence): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      const linked = linkWaveChildren(current);
      for (const stableId of linked.waves[linked.currentWave] ?? []) {
        const child = linked.children[stableId]!;
        const existing = draft.missions[child.missionId];
        if (existing) {
          if (existing.id !== child.missionId) {
            throw new Error(`Plan Parent child Mission collision for ${stableId}.`);
          }
          continue;
        }
        draft.missions[child.missionId] = {
          id: child.missionId,
          revision: 1,
          state: 'created',
          inputSnapshot: `commit:${child.baseCheckpointCommit}:tree:${child.baseCheckpointTree}`,
        };
      }
      draft.planParents[input.parentId] = linked;
    });
  }

  public prepareWave(input: ParentFence & {
    descriptors: PlanParentChildDescriptor[];
  }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      for (const stableId of current.waves[current.currentWave] ?? []) {
        const child = current.children[stableId];
        if (!child || draft.missions[child.missionId]?.state !== 'integration-ready') {
          throw new Error(`Plan Parent child ${stableId} is not integration-ready.`);
        }
      }
      draft.planParents[input.parentId] = transitionPlanParent(current, {
        type: 'wave-prepared',
        descriptors: input.descriptors,
      });
    });
  }

  public startIntegration(input: ParentFence & {
    intent: PlanParentIntegrationIntent;
  }): Promise<MissionStateSnapshot> {
    return this.store.exclusive(async (session) => {
      const snapshot = await session.load();
      if (snapshot.generation !== input.expectedGeneration) {
        throw new Error('Plan Parent generation conflict.');
      }
      const current = requireParent(snapshot.planParents[input.parentId], input);
      if (current.state === 'integrating' && sameIntent(current.integrationIntent, input.intent)) {
        return snapshot;
      }
      return session.mutate(input.expectedGeneration, (draft) => {
        const parent = requireParent(draft.planParents[input.parentId], input);
        draft.planParents[input.parentId] = transitionPlanParent(parent, {
          type: 'integration-started',
          intent: input.intent,
        });
      });
    });
  }

  public completeIntegration(input: ParentFence & { actionKey: string }): Promise<MissionStateSnapshot> {
    return this.store.exclusive(async (session) => {
      const snapshot = await session.load();
      if (snapshot.generation !== input.expectedGeneration) {
        throw new Error('Plan Parent generation conflict.');
      }
      const current = requireParent(snapshot.planParents[input.parentId], input);
      if (current.integrationHistory.some((entry) => entry.actionKey === input.actionKey)) {
        return snapshot;
      }
      return session.mutate(input.expectedGeneration, (draft) => {
        const parent = requireParent(draft.planParents[input.parentId], input);
        draft.planParents[input.parentId] = transitionPlanParent(parent, {
          type: 'integration-completed',
          actionKey: input.actionKey,
        });
      });
    });
  }

  public recordValidation(input: ParentFence & { receiptIds: string[] }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      draft.planParents[input.parentId] = transitionPlanParent(current, {
        type: 'validation-passed',
        receiptIds: input.receiptIds,
      });
    });
  }

  public checkpoint(input: ParentFence & {
    checkpoint: { commitSha: string; treeSha: string };
  }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      draft.planParents[input.parentId] = transitionPlanParent(current, {
        type: 'checkpoint-committed',
        checkpoint: input.checkpoint,
      });
    });
  }

  public defer(input: ParentFence & {
    resumeTarget: PlanParentResumeTarget;
    actionKey: string;
    nextEligibleAt: string;
    reason: string;
    requiredPredicate: string;
  }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      if ((current.claim?.processes.length ?? 0) > 0) {
        throw new Error('Plan Parent cannot defer while live process handles remain.');
      }
      const waiting = transitionPlanParent(current, {
        type: 'transient-failure',
        resumeTarget: input.resumeTarget,
        actionKey: input.actionKey,
        nextEligibleAt: input.nextEligibleAt,
        reason: input.reason,
        requiredPredicate: input.requiredPredicate,
      });
      draft.planParents[input.parentId] = waiting;
      draft.nextEligibleAt[planParentScheduleKey(input.parentId)] = input.nextEligibleAt;
      delete draft.reservations[input.parentId];
    });
  }

  public claim(input: ParentFence & { now: string; claim: MissionClaim }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      const key = planParentScheduleKey(input.parentId);
      if (draft.nextEligibleAt[key] > input.now || input.claim.claimedAt !== input.now
        || input.claim.leaseUntil <= input.now) {
        throw new Error('Plan Parent claim is not eligible.');
      }
      let claimed;
      let priorProcesses: MissionClaim['processes'] = [];
      if (current.state === 'wave-waiting') {
        claimed = transitionPlanParent(current, { type: 'resume-eligible', now: input.now });
      } else {
        if (!current.claim || current.claim.leaseUntil !== draft.nextEligibleAt[key]
          || current.claim.leaseUntil > input.now) throw new Error('Plan Parent claim is not expired.');
        if (current.claim.hostId !== input.claim.hostId) {
          throw new Error('Plan Parent cross-host reclaim is forbidden.');
        }
        priorProcesses = current.claim.bootNonce === input.claim.bootNonce
          ? current.claim.processes : [];
        claimed = { ...current, revision: current.revision + 1 };
      }
      claimed.claim = {
        ...structuredClone(input.claim),
        processes: mergeProcesses(priorProcesses, input.claim.processes),
      };
      draft.planParents[input.parentId] = claimed;
      draft.nextEligibleAt[key] = input.claim.leaseUntil;
    });
  }

  public recordIntegrationConflict(input: ParentFence): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      const stableId = current.waves[current.currentWave]?.[current.integrationCursor];
      const descriptor = stableId ? current.children[stableId]?.descriptor : undefined;
      if (!stableId || !descriptor) throw new Error('Plan Parent conflict child descriptor is missing.');
      const recoveryMissionId = integrationRecoveryMissionId({
        parentId: current.id,
        wave: current.currentWave,
        checkpointCommit: current.checkpoint.commitSha,
        integratedTree: current.integratedTree,
        cursor: current.integrationCursor,
        childCommit: descriptor.childCommit,
        configHash: current.configHash,
      });
      const existing = draft.missions[recoveryMissionId];
      if (existing && existing.id !== recoveryMissionId) {
        throw new Error('Plan Parent recovery Mission identity collision.');
      }
      draft.missions[recoveryMissionId] ??= {
        id: recoveryMissionId,
        revision: 1,
        state: 'created',
        inputSnapshot: `checkpoint:${current.checkpoint.commitSha}:tree:${current.integratedTree}`,
      };
      draft.planParents[input.parentId] = transitionPlanParent(current, {
        type: 'integration-conflict', recoveryMissionId,
      });
    });
  }

  public completeIntegrationRecovery(input: ParentFence & {
    descriptor: PlanParentChildDescriptor;
  }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      if (!current.recoveryMissionId
        || draft.missions[current.recoveryMissionId]?.state !== 'integration-ready') {
        throw new Error('Plan Parent integration recovery Mission is not ready.');
      }
      draft.planParents[input.parentId] = transitionPlanParent(current, {
        type: 'recovery-ready', descriptor: input.descriptor,
      });
    });
  }

  public recordValidationFailure(input: ParentFence): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      if (current.state !== 'wave-validating' && current.state !== 'final-validating') {
        throw new Error('Plan Parent is not validating.');
      }
      const recoveryMissionId = validationRecoveryMissionId({
        parentId: current.id,
        phase: current.state === 'final-validating' ? 'final' : `wave-${current.currentWave}`,
        candidateTree: current.integratedTree,
        configHash: current.configHash,
      });
      draft.missions[recoveryMissionId] ??= {
        id: recoveryMissionId,
        revision: 1,
        state: 'created',
        inputSnapshot: `validation-tree:${current.integratedTree}`,
      };
      draft.planParents[input.parentId] = transitionPlanParent(current, {
        type: 'validation-failed', recoveryMissionId, recoveryTarget: current.state,
      });
    });
  }

  public completeValidationRecovery(input: ParentFence): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      if (!current.recoveryMissionId || !current.recoveryTarget
        || draft.missions[current.recoveryMissionId]?.state !== 'integration-ready') {
        throw new Error('Plan Parent validation recovery Mission is not ready.');
      }
      draft.planParents[input.parentId] = transitionPlanParent(current, {
        type: 'validation-recovery-ready',
      });
    });
  }

  public async reconcileIntegration(input: ParentFence & {
    execute(intent: PlanParentIntegrationIntent): Promise<
      | { kind: 'applied' }
      | { kind: 'transient-failure'; nextEligibleAt: string; reason: string }
      | { kind: 'conflict' }
      | { kind: 'safety-stop' }
    >;
  }): Promise<MissionStateSnapshot> {
    const snapshot = await this.store.load();
    if (snapshot.generation !== input.expectedGeneration) {
      throw new Error('Plan Parent generation conflict.');
    }
    const parent = requireParent(snapshot.planParents[input.parentId], input);
    if (parent.state !== 'integrating' || !parent.integrationIntent) {
      throw new Error('Plan Parent integration intent is missing.');
    }
    const outcome = await input.execute(structuredClone(parent.integrationIntent));
    if (outcome.kind === 'applied') {
      return this.completeIntegration({
        ...input,
        actionKey: parent.integrationIntent.actionKey,
      });
    }
    if (outcome.kind === 'conflict') return this.recordIntegrationConflict(input);
    if (outcome.kind === 'transient-failure') {
      return this.defer({
        ...input,
        resumeTarget: 'integrating',
        actionKey: parent.integrationIntent.actionKey,
        nextEligibleAt: outcome.nextEligibleAt,
        reason: outcome.reason,
        requiredPredicate: 'integration transaction can be reconciled',
      });
    }
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      draft.planParents[input.parentId] = transitionPlanParent(current, { type: 'safety-stop' });
      delete draft.nextEligibleAt[planParentScheduleKey(input.parentId)];
      delete draft.reservations[input.parentId];
    });
  }

  public preparePublication(input: ParentFence & {
    receiptIds: string[];
    validationSnapshot: string;
    publication: MissionPublicationRecord;
  }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      assertMissionPublicationRecord(input.publication);
      if (draft.publications[input.publication.id]) {
        throw new Error(`Plan Parent publication ${input.publication.id} already exists.`);
      }
      if (input.publication.ownerId !== current.id
        || input.publication.repository !== current.repository
        || input.publication.issueNumber !== current.issueNumber
        || input.publication.candidateCommit !== current.checkpoint.commitSha
        || input.publication.candidateTree !== current.checkpoint.treeSha
        || input.publication.baseSha !== current.baseCommit
        || input.publication.configHash !== current.configHash
        || input.publication.validationSnapshot !== input.validationSnapshot
        || !sameStrings(input.publication.validationReceiptIds, input.receiptIds)) {
        throw new Error('Plan Parent publication candidate does not match final validation.');
      }
      const prepared = transitionPlanParent(current, {
        type: 'final-validation-passed',
        receiptIds: input.receiptIds,
        publicationId: input.publication.id,
      });
      draft.planParents[input.parentId] = prepared;
      draft.publications[input.publication.id] = {
        revision: input.publication.revision,
        value: structuredClone(input.publication) as unknown as JsonValue,
      };
    });
  }

  public requestCancellation(input: ParentFence & {
    requestedAt: string;
    requestedBy: string;
  }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      const cancellation = { requestedAt: input.requestedAt, requestedBy: input.requestedBy };
      draft.planParents[input.parentId] = transitionPlanParent(current, {
        type: 'cancel-requested', cancellation,
      });
      for (const child of Object.values(current.children)) {
        const mission = draft.missions[child.missionId];
        if (!mission || terminalMissionStates.has(mission.state) || mission.state === 'cancelling') continue;
        draft.missions[child.missionId] = transitionMission(mission, { type: 'cancel-requested' });
        delete draft.nextEligibleAt[child.missionId];
        delete draft.reservations[child.missionId];
      }
      for (const [publicationId, aggregate] of Object.entries(draft.publications)) {
        const publication = aggregate.value as unknown as MissionPublicationRecord;
        if (publication.ownerId !== current.id
          || ['review-ready', 'external-input-required', 'safety-stop', 'cancelled'].includes(publication.state)) {
          continue;
        }
        const cancelled = transitionMissionPublication(publication, { type: 'cancel-requested' });
        draft.publications[publicationId] = {
          revision: cancelled.revision,
          value: structuredClone(cancelled) as unknown as JsonValue,
        };
        delete draft.nextEligibleAt[publicationScheduleKey(publicationId)];
      }
      delete draft.nextEligibleAt[planParentScheduleKey(input.parentId)];
      delete draft.reservations[input.parentId];
    });
  }

  public reconcileCancellationIntegration(input: ParentFence & {
    observedIdentity: 'old' | 'new' | 'third';
  }): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      if (input.observedIdentity === 'third') {
        draft.planParents[input.parentId] = transitionPlanParent(current, { type: 'safety-stop' });
      } else {
        draft.planParents[input.parentId] = transitionPlanParent(current, {
          type: 'cancellation-integration-reconciled',
          applied: input.observedIdentity === 'new',
        });
      }
    });
  }

  public completeCancellation(input: ParentFence): Promise<MissionStateSnapshot> {
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireParent(draft.planParents[input.parentId], input);
      if (current.state !== 'cancelling') throw new Error('Plan Parent is not cancelling.');
      if (current.integrationIntent) {
        throw new Error('Plan Parent cancellation must reconcile integration intent first.');
      }
      if ((current.claim?.processes.length ?? 0) > 0) {
        throw new Error('Plan Parent cancellation still owns live process handles.');
      }
      for (const child of Object.values(current.children)) {
        const mission = draft.missions[child.missionId];
        if (mission && !terminalMissionStates.has(mission.state)) {
          throw new Error(`Plan Parent cancellation child ${child.stableId} is not terminal.`);
        }
      }
      for (const aggregate of Object.values(draft.publications)) {
        const publication = aggregate.value as unknown as MissionPublicationRecord;
        if (publication.ownerId === current.id && publication.state !== 'cancelled') {
          throw new Error(`Plan Parent cancellation Publication ${publication.id} is not cancelled.`);
        }
      }
      draft.planParents[input.parentId] = transitionPlanParent(current, {
        type: 'cancellation-reconciled',
      });
      delete draft.nextEligibleAt[planParentScheduleKey(input.parentId)];
      delete draft.reservations[input.parentId];
    });
  }
}

function mergeProcesses(
  left: MissionClaim['processes'],
  right: MissionClaim['processes'],
): MissionClaim['processes'] {
  return [...new Map([...left, ...right].map((process) => [
    `${process.hostId}:${process.bootNonce}:${process.pid}:${process.actionKey}`,
    structuredClone(process),
  ])).values()];
}

export function listEligiblePlanParents(
  snapshot: MissionStateSnapshot,
  now: string,
  limit = 100,
): Array<{ parentId: string; revision: number; state: string; nextEligibleAt: string }> {
  const milliseconds = Date.parse(now);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== now) {
    throw new Error('Plan Parent scheduler now must be an exact UTC ISO timestamp.');
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Plan Parent scheduler limit must be a positive integer.');
  }
  const result: Array<{ parentId: string; revision: number; state: string; nextEligibleAt: string }> = [];
  for (const [key, nextEligibleAt] of Object.entries(snapshot.nextEligibleAt)
    .filter(([key, time]) => key.startsWith('plan-parent:') && time <= now)
    .sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]))) {
    if (result.length >= Math.min(limit, 100)) break;
    const parentId = key.slice('plan-parent:'.length);
    const parent = snapshot.planParents[parentId];
    if (!parent) continue;
    const eligible = parent.state === 'wave-waiting' && parent.nextEligibleAt === nextEligibleAt;
    const recovery = parent.claim?.leaseUntil === nextEligibleAt;
    if (!eligible && !recovery) continue;
    result.push({ parentId, revision: parent.revision, state: parent.state, nextEligibleAt });
  }
  return result;
}

interface ParentFence {
  expectedGeneration: number;
  parentId: string;
  expectedRevision: number;
}

function requireParent(parent: PlanParentRecord | undefined, input: ParentFence): PlanParentRecord {
  if (!parent) throw new Error(`Plan Parent ${input.parentId} does not exist.`);
  if (parent.revision !== input.expectedRevision) {
    throw new Error(`Plan Parent revision conflict for ${input.parentId}.`);
  }
  return parent;
}

function sameIntent(
  left: PlanParentIntegrationIntent | undefined,
  right: PlanParentIntegrationIntent,
): boolean {
  return left !== undefined
    && left.version === right.version
    && left.actionKey === right.actionKey
    && left.wave === right.wave
    && left.cursor === right.cursor
    && left.stableId === right.stableId
    && left.expectedOldCommit === right.expectedOldCommit
    && left.expectedNewCommit === right.expectedNewCommit
    && left.expectedNewTree === right.expectedNewTree;
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}
