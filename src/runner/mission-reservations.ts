import { uniqueSortedPaths } from '../path-policy.js';
import { assertMissionPathPattern, missionPathPatternsOverlap } from './mission-path-language.js';
import type { JsonValue, MissionStateSnapshot, MissionStateStore } from './mission-state-store.js';

export interface MissionScopeReservation {
  missionId: string;
  paths: string[];
  fencingEpoch: number;
  leaseUntil: string;
}

export class MissionReservationCoordinator {
  public constructor(
    private readonly store: MissionStateStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public reserve(
    expectedGeneration: number,
    reservation: MissionScopeReservation,
  ): Promise<MissionStateSnapshot> {
    const normalized = normalizeReservation(reservation);
    const now = this.now().toISOString();
    if (normalized.leaseUntil <= now) {
      throw new Error('Mission reservation leaseUntil must be in the future.');
    }
    return this.store.mutate(expectedGeneration, (draft) => {
      const currentOwnerReservation = draft.reservations[normalized.missionId];
      if (currentOwnerReservation) {
        const current = parseReservation(
          currentOwnerReservation.value,
          `reservation ${normalized.missionId}`,
        );
        if (current.leaseUntil > now) {
          if (normalized.fencingEpoch < current.fencingEpoch) {
            throw new Error(`Mission reservation stale fencing epoch for ${normalized.missionId}.`);
          }
          if (normalized.fencingEpoch !== current.fencingEpoch) {
            throw new Error(`Mission reservation renewal cannot change fencing epoch for ${normalized.missionId}.`);
          }
          if (normalized.paths.join('\0') !== current.paths.join('\0')) {
            throw new Error(`Mission reservation renewal cannot change scope for ${normalized.missionId}.`);
          }
          if (normalized.leaseUntil < current.leaseUntil) {
            throw new Error(`Mission reservation renewal cannot shorten lease for ${normalized.missionId}.`);
          }
        }
      }
      for (const [ownerId, aggregate] of Object.entries(draft.reservations)) {
        if (ownerId === normalized.missionId) {
          continue;
        }
        const existing = parseReservation(aggregate.value, `reservation ${ownerId}`);
        if (existing.leaseUntil <= now) {
          delete draft.reservations[ownerId];
          continue;
        }
        if (scopesOverlap(existing.paths, normalized.paths)) {
          throw new Error(`Mission scope reservation overlaps ${ownerId}.`);
        }
      }
      const current = draft.reservations[normalized.missionId];
      draft.reservations[normalized.missionId] = {
        revision: (current?.revision ?? 0) + 1,
        value: normalized as unknown as JsonValue,
      };
    });
  }

  public release(
    expectedGeneration: number,
    missionId: string,
    fencingEpoch: number,
  ): Promise<MissionStateSnapshot> {
    return this.store.mutate(expectedGeneration, (draft) => {
      const aggregate = draft.reservations[missionId];
      if (!aggregate) {
        return;
      }
      const reservation = parseReservation(aggregate.value, `reservation ${missionId}`);
      if (reservation.missionId !== missionId) {
        throw new Error(`Mission reservation owner mismatch for ${missionId}.`);
      }
      if (reservation.fencingEpoch !== fencingEpoch) {
        throw new Error(`Mission reservation fencing epoch mismatch for ${missionId}.`);
      }
      delete draft.reservations[missionId];
    });
  }
}

function normalizeReservation(reservation: MissionScopeReservation): MissionScopeReservation {
  if (reservation.missionId.trim().length === 0) {
    throw new Error('Mission reservation missionId must be non-empty.');
  }
  if (!Number.isSafeInteger(reservation.fencingEpoch) || reservation.fencingEpoch <= 0) {
    throw new Error('Mission reservation fencing epoch must be a positive integer.');
  }
  const lease = Date.parse(reservation.leaseUntil);
  if (!Number.isFinite(lease) || new Date(lease).toISOString() !== reservation.leaseUntil) {
    throw new Error('Mission reservation leaseUntil must be an exact UTC ISO timestamp.');
  }
  const paths = uniqueSortedPaths(reservation.paths);
  if (paths.length === 0) {
    throw new Error('Mission reservation paths must be non-empty repository-relative globs.');
  }
  paths.forEach((path) => assertMissionPathPattern(path, 'Mission reservation path'));
  return { ...reservation, paths };
}

function parseReservation(value: JsonValue, context: string): MissionScopeReservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${context}.`);
  }
  const record = value as Record<string, JsonValue>;
  const exact = ['missionId', 'paths', 'fencingEpoch', 'leaseUntil'];
  if (Object.keys(record).length !== exact.length || exact.some((key) => !(key in record))
    || typeof record.missionId !== 'string'
    || !Array.isArray(record.paths) || record.paths.some((path) => typeof path !== 'string')
    || typeof record.fencingEpoch !== 'number'
    || typeof record.leaseUntil !== 'string') {
    throw new Error(`Invalid ${context}.`);
  }
  return normalizeReservation({
    missionId: record.missionId,
    paths: record.paths as string[],
    fencingEpoch: record.fencingEpoch,
    leaseUntil: record.leaseUntil,
  });
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftPattern) => right.some((rightPattern) =>
    patternsOverlap(leftPattern, rightPattern)));
}

function patternsOverlap(left: string, right: string): boolean {
  return missionPathPatternsOverlap(left, right);
}
