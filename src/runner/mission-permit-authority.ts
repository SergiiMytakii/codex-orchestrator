import {
  missionCapabilityPermitFingerprint,
  type MissionCapabilityPermit,
} from './mission-capability-kernel.js';
import type { MissionRecord } from './mission-state-machine.js';
import { MissionStateStore } from './mission-state-store.js';

export type MissionPermitBeginResult =
  | { kind: 'execute' }
  | { kind: 'resume-in-flight' }
  | { kind: 'completed'; receiptSha256: string };

export interface MissionPermitAuthority {
  begin(permit: MissionCapabilityPermit): Promise<MissionPermitBeginResult>;
  complete(permit: MissionCapabilityPermit, payload: Uint8Array, artifacts?: Uint8Array[]): Promise<string>;
  readReceipt(receiptSha256: string): Promise<Buffer>;
}

export class MissionStatePermitAuthority implements MissionPermitAuthority {
  public constructor(
    private readonly store: MissionStateStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async begin(permit: MissionCapabilityPermit): Promise<MissionPermitBeginResult> {
    const fingerprint = missionCapabilityPermitFingerprint(permit);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot = await this.store.load();
      const mission = this.requireAuthorizedMission(snapshot.missions[permit.missionId], permit, fingerprint);
      const existing = mission.actionExecutions?.[permit.actionKey];
      if (existing) {
        if (existing.permitFingerprint !== fingerprint) {
          if (existing.status === 'completed') {
            throw new Error(`Mission completed action is bound to a different permit: ${permit.actionKey}.`);
          }
          try {
            await this.store.mutate(snapshot.generation, (draft) => {
              const current = this.requireAuthorizedMission(
                draft.missions[permit.missionId], permit, fingerprint,
              );
              const stale = current.actionExecutions?.[permit.actionKey];
              if (!stale || stale.status !== 'in-flight') {
                throw new Error(`Mission action cannot rebind permit: ${permit.actionKey}.`);
              }
              current.actionExecutions![permit.actionKey] = {
                permitFingerprint: fingerprint,
                status: 'in-flight',
              };
              current.revision += 1;
            });
            return { kind: 'execute' };
          } catch (error) {
            if (error instanceof Error && /generation conflict/u.test(error.message)) continue;
            throw error;
          }
        }
        if (existing.status === 'completed') {
          return { kind: 'completed', receiptSha256: existing.receiptSha256! };
        }
        this.assertNotExpired(permit);
        return { kind: 'resume-in-flight' };
      }
      this.assertNotExpired(permit);
      try {
        await this.store.mutate(snapshot.generation, (draft) => {
          const current = this.requireAuthorizedMission(
            draft.missions[permit.missionId], permit, fingerprint,
          );
          current.actionExecutions = {
            ...(current.actionExecutions ?? {}),
            [permit.actionKey]: { permitFingerprint: fingerprint, status: 'in-flight' },
          };
          current.revision += 1;
        });
        return { kind: 'execute' };
      } catch (error) {
        if (error instanceof Error && /generation conflict/u.test(error.message)) continue;
        throw error;
      }
    }
    throw new Error('Mission permit could not begin after repeated generation conflicts.');
  }

  public async complete(
    permit: MissionCapabilityPermit,
    payload: Uint8Array,
    artifacts: Uint8Array[] = [],
  ): Promise<string> {
    const fingerprint = missionCapabilityPermitFingerprint(permit);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot = await this.store.load();
      const mission = this.requireAuthorizedMission(snapshot.missions[permit.missionId], permit, fingerprint);
      const existing = mission.actionExecutions?.[permit.actionKey];
      if (!existing || existing.permitFingerprint !== fingerprint) {
        throw new Error(`Mission action is not in flight: ${permit.actionKey}.`);
      }
      if (existing.status === 'completed') {
        const persisted = await this.readReceipt(existing.receiptSha256!);
        if (!persisted.equals(Buffer.from(payload))) {
          throw new Error(`Mission action completed with a different receipt: ${permit.actionKey}.`);
        }
        return existing.receiptSha256!;
      }
      this.assertNotExpired(permit);
      try {
        const saved = await this.store.mutateWithBlobs(snapshot.generation, [payload, ...artifacts], (draft, [reference, ...artifactReferences]) => {
          if (!reference) throw new Error('Mission action receipt was not materialized.');
          const current = this.requireAuthorizedMission(
            draft.missions[permit.missionId], permit, fingerprint,
          );
          const action = current.actionExecutions?.[permit.actionKey];
          if (!action || action.permitFingerprint !== fingerprint || action.status !== 'in-flight') {
            throw new Error(`Mission action is not in flight: ${permit.actionKey}.`);
          }
          current.actionExecutions![permit.actionKey] = {
            permitFingerprint: fingerprint,
            status: 'completed',
            receiptSha256: reference.sha256,
          };
          draft.blobs[reference.sha256] = reference;
          for (const artifactReference of artifactReferences) {
            draft.blobs[artifactReference.sha256] = artifactReference;
          }
          current.revision += 1;
        });
        return saved.missions[permit.missionId]!.actionExecutions![permit.actionKey]!.receiptSha256!;
      } catch (error) {
        if (error instanceof Error && /generation conflict/u.test(error.message)) continue;
        throw error;
      }
    }
    throw new Error('Mission action could not complete after repeated generation conflicts.');
  }

  public async readReceipt(receiptSha256: string): Promise<Buffer> {
    const snapshot = await this.store.load();
    const reference = snapshot.blobs[receiptSha256];
    if (!reference) throw new Error(`Mission action receipt is missing: ${receiptSha256}.`);
    return this.store.readBlob(reference);
  }

  private requireAuthorizedMission(
    mission: MissionRecord | undefined,
    permit: MissionCapabilityPermit,
    fingerprint: string,
  ): MissionRecord {
    if (!mission) throw new Error(`Mission permit references unknown mission: ${permit.missionId}.`);
    if (mission.state !== 'executing') {
      throw new Error(`Mission permit is revoked by current state: ${mission.state}.`);
    }
    if (mission.fencingEpoch !== permit.fencingEpoch) {
      throw new Error('Mission permit fencing epoch is stale.');
    }
    if (mission.inputSnapshot !== permit.inputSnapshot) {
      throw new Error('Mission permit input snapshot is stale.');
    }
    if (mission.actionKey !== permit.actionKey || !mission.authorizedPermit
      || missionCapabilityPermitFingerprint(mission.authorizedPermit) !== fingerprint) {
      throw new Error('Mission permit does not match the durable authorization.');
    }
    return mission;
  }

  private assertNotExpired(permit: MissionCapabilityPermit): void {
    if (Date.parse(permit.expiresAt) <= this.now().getTime()) {
      throw new Error('Mission permit has expired.');
    }
  }
}
