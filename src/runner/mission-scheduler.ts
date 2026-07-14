import type { MissionEvent, MissionProcessHandle, MissionRecord } from './mission-state-machine.js';
import { terminalMissionStates, transitionMission } from './mission-state-machine.js';
import type { MissionStateSnapshot, MissionStateStore } from './mission-state-store.js';

type MissionDeferralEvent = Extract<MissionEvent, {
  actionKey: string;
  nextEligibleAt: string;
}>;

export interface EligibleMission {
  missionId: string;
  revision: number;
  state: MissionRecord['state'];
  nextEligibleAt: string;
  actionKey?: string;
  recovery: boolean;
}

export class MissionScheduler {
  public constructor(private readonly store: MissionStateStore) {}

  public defer(input: {
    expectedGeneration: number;
    missionId: string;
    expectedRevision: number;
    event: MissionDeferralEvent;
    reason: string;
    requiredPredicate: string;
  }): Promise<MissionStateSnapshot> {
    requireText(input.reason, 'deferral reason');
    requireText(input.requiredPredicate, 'required predicate');
    assertTimestamp(input.event.nextEligibleAt, 'nextEligibleAt');
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireMission(draft.missions[input.missionId], input);
      if ((current.claim?.processes.length ?? 0) > 0) {
        throw new Error('Mission scheduler cannot defer while live process handles remain.');
      }
      const deferred = transitionMission(current, input.event);
      if (deferred.state !== 'resumable' || !deferred.resumeTarget || !deferred.nextEligibleAt) {
        throw new Error('Mission scheduler deferral event did not produce resumable state.');
      }
      draft.missions[input.missionId] = {
        ...deferred,
        resumableReason: input.reason,
        requiredPredicate: input.requiredPredicate,
      };
      draft.nextEligibleAt[input.missionId] = deferred.nextEligibleAt;
      delete draft.reservations[input.missionId];
    });
  }

  public claim(input: {
    expectedGeneration: number;
    missionId: string;
    expectedRevision: number;
    now: string;
    claim: NonNullable<MissionRecord['claim']>;
  }): Promise<MissionStateSnapshot> {
    assertTimestamp(input.now, 'claim now');
    validateClaim(input.claim);
    if (input.claim.claimedAt !== input.now || input.claim.leaseUntil <= input.now) {
      throw new Error('Mission scheduler claim timestamps are inconsistent.');
    }
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireMission(draft.missions[input.missionId], input);
      const indexedAt = draft.nextEligibleAt[input.missionId];
      if (!indexedAt || indexedAt > input.now) {
        throw new Error('Mission scheduler claim is not eligible.');
      }
      let claimed: MissionRecord;
      let priorProcesses: MissionProcessHandle[] = [];
      if (current.state === 'resumable') {
        if (current.nextEligibleAt !== indexedAt) {
          throw new Error('Mission scheduler resumable index does not match the aggregate.');
        }
        claimed = transitionMission(current, { type: 'resume-eligible', now: input.now });
      } else {
        if (!current.claim || current.claim.leaseUntil !== indexedAt
          || current.claim.leaseUntil > input.now) {
          throw new Error('Mission scheduler active claim is not expired.');
        }
        if (input.claim.fencingEpoch < current.claim.fencingEpoch) {
          throw new Error('Mission scheduler claim fencing epoch is stale.');
        }
        if (current.claim.hostId !== input.claim.hostId) {
          throw new Error('Mission scheduler cannot reclaim a claim from another host.');
        }
        priorProcesses = current.claim.bootNonce === input.claim.bootNonce
          ? current.claim.processes : [];
        claimed = { ...current, revision: current.revision + 1 };
      }
      claimed.claim = {
        ...structuredClone(input.claim),
        processes: mergeProcesses(priorProcesses, input.claim.processes),
      };
      draft.missions[input.missionId] = claimed;
      draft.nextEligibleAt[input.missionId] = input.claim.leaseUntil;
    });
  }

  public registerProcess(input: {
    expectedGeneration: number;
    missionId: string;
    expectedRevision: number;
    claimToken: string;
    process: MissionProcessHandle;
  }): Promise<MissionStateSnapshot> {
    validateProcess(input.process);
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireMission(draft.missions[input.missionId], input);
      if (!current.claim || current.claim.token !== input.claimToken) {
        throw new Error('Mission scheduler claim token mismatch.');
      }
      if (current.state === 'cancelling' || terminalMissionStates.has(current.state)) {
        throw new Error(`Mission scheduler cannot register a process in ${current.state}.`);
      }
      current.claim.processes = mergeProcesses(current.claim.processes, [input.process]);
      current.revision += 1;
    });
  }

  public completeProcess(input: {
    expectedGeneration: number;
    missionId: string;
    expectedRevision: number;
    claimToken: string;
    actionKey: string;
    pid: number;
  }): Promise<MissionStateSnapshot> {
    requireText(input.actionKey, 'completed process actionKey');
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
      throw new Error('Mission scheduler completed process pid must be a positive integer.');
    }
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireMission(draft.missions[input.missionId], input);
      if (!current.claim || current.claim.token !== input.claimToken) {
        throw new Error('Mission scheduler claim token mismatch.');
      }
      const before = current.claim.processes.length;
      current.claim.processes = current.claim.processes.filter((process) =>
        process.actionKey !== input.actionKey || process.pid !== input.pid);
      if (current.claim.processes.length === before) {
        throw new Error('Mission scheduler completed process handle is missing.');
      }
      current.revision += 1;
    });
  }

  public compactTerminal(input: {
    expectedGeneration: number;
    missionId: string;
    expectedRevision: number;
    retainedAt: string;
  }): Promise<MissionStateSnapshot> {
    assertTimestamp(input.retainedAt, 'retainedAt');
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const current = requireMission(draft.missions[input.missionId], input);
      if (!terminalMissionStates.has(current.state)) {
        throw new Error('Mission scheduler can compact only terminal missions.');
      }
      delete draft.missions[input.missionId];
      delete draft.nextEligibleAt[input.missionId];
      delete draft.reservations[input.missionId];
      draft.tombstones[input.missionId] = {
        kind: 'mission',
        terminalState: current.state,
        retainedAt: input.retainedAt,
      };
    });
  }
}

export function listEligibleMissions(
  snapshot: MissionStateSnapshot,
  now: string,
  limit = 100,
): EligibleMission[] {
  assertTimestamp(now, 'scheduler now');
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Mission scheduler limit must be a positive integer.');
  }
  const result: EligibleMission[] = [];
  const entries = Object.entries(snapshot.nextEligibleAt)
    .filter(([, nextEligibleAt]) => nextEligibleAt <= now)
    .sort(([leftId, leftTime], [rightId, rightTime]) =>
      compare(leftTime, rightTime) || compare(leftId, rightId));
  for (const [missionId, nextEligibleAt] of entries) {
    if (result.length >= Math.min(limit, 100)) break;
    const mission = snapshot.missions[missionId];
    if (!mission) continue;
    const resumable = mission.state === 'resumable'
      && mission.nextEligibleAt === nextEligibleAt && !mission.claim;
    const recovery = Boolean(mission.claim && mission.claim.leaseUntil === nextEligibleAt
      && mission.claim.leaseUntil <= now);
    if (!resumable && !recovery) continue;
    result.push({
      missionId,
      revision: mission.revision,
      state: mission.state,
      nextEligibleAt,
      ...(mission.actionKey ? { actionKey: mission.actionKey } : {}),
      recovery,
    });
  }
  return result;
}

function requireMission(
  mission: MissionRecord | undefined,
  input: { missionId: string; expectedRevision: number },
): MissionRecord {
  if (!mission) throw new Error(`Mission scheduler cannot find ${input.missionId}.`);
  if (mission.revision !== input.expectedRevision) {
    throw new Error(`Mission scheduler revision conflict for ${input.missionId}.`);
  }
  return mission;
}

function validateClaim(claim: NonNullable<MissionRecord['claim']>): void {
  if (claim.version !== 1 || !Number.isSafeInteger(claim.fencingEpoch) || claim.fencingEpoch <= 0) {
    throw new Error('Mission scheduler claim is invalid.');
  }
  for (const [value, field] of [
    [claim.token, 'token'], [claim.daemonId, 'daemonId'], [claim.hostId, 'hostId'],
    [claim.bootNonce, 'bootNonce'],
  ] as const) requireText(value, `claim ${field}`);
  assertTimestamp(claim.claimedAt, 'claim claimedAt');
  assertTimestamp(claim.leaseUntil, 'claim leaseUntil');
  claim.processes.forEach(validateProcess);
}

function validateProcess(process: MissionProcessHandle): void {
  requireText(process.actionKey, 'process actionKey');
  requireText(process.hostId, 'process hostId');
  requireText(process.bootNonce, 'process bootNonce');
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
    throw new Error('Mission scheduler process pid must be a positive integer.');
  }
  assertTimestamp(process.startedAt, 'process startedAt');
}

function mergeProcesses(left: MissionProcessHandle[], right: MissionProcessHandle[]): MissionProcessHandle[] {
  const merged = new Map<string, MissionProcessHandle>();
  for (const process of [...left, ...right]) {
    validateProcess(process);
    merged.set(`${process.hostId}:${process.bootNonce}:${process.pid}:${process.actionKey}`,
      structuredClone(process));
  }
  return [...merged.values()].sort((a, b) =>
    compare(a.actionKey, b.actionKey) || a.pid - b.pid);
}

function assertTimestamp(value: string, field: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`Mission scheduler ${field} must be an exact UTC ISO timestamp.`);
  }
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`Mission scheduler ${field} must be non-empty.`);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
