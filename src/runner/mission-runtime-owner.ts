import type { MissionDeploymentRecord } from './mission-deployment.js';
import { missionDeploymentRecordHash } from './mission-deployment.js';

export interface RuntimeOwnerRecord {
  version: 1;
  repository: string;
  deploymentId: string;
  githubAppInstallationId: string;
  credentialGeneration: string;
  compatibilityEpoch: number;
  deploymentRecordHash: string;
  approvedByCommit: string;
  fencingEpoch: number;
}

export interface RuntimeOwnerObservation {
  sha: string;
  record: RuntimeOwnerRecord;
}

export interface RuntimeOwnerRefAdapter {
  read(): Promise<RuntimeOwnerObservation | undefined>;
  compareAndSwap(
    expectedSha: string | undefined,
    record: RuntimeOwnerRecord,
  ): Promise<RuntimeOwnerObservation>;
}

const runtimeOwnerFields: ReadonlyArray<keyof RuntimeOwnerRecord> = [
  'version',
  'repository',
  'deploymentId',
  'githubAppInstallationId',
  'credentialGeneration',
  'compatibilityEpoch',
  'deploymentRecordHash',
  'approvedByCommit',
  'fencingEpoch',
];

export function canonicalRuntimeOwnerRecord(record: RuntimeOwnerRecord): string {
  assertRuntimeOwnerRecord(record);
  return JSON.stringify(Object.fromEntries(runtimeOwnerFields.map((field) => [field, record[field]])));
}

export function parseRuntimeOwnerRecord(content: string): RuntimeOwnerRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid Mission runtime owner record: expected JSON.');
  }
  assertRuntimeOwnerRecord(parsed);
  if (content !== canonicalRuntimeOwnerRecord(parsed)) {
    throw new Error('Invalid Mission runtime owner record: expected canonical JSON.');
  }
  return parsed;
}

export function assertRuntimeOwnerRecord(value: unknown): asserts value is RuntimeOwnerRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Mission runtime owner record: root must be an object.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(runtimeOwnerFields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid Mission runtime owner record: unexpected field ${key}.`);
    }
  }
  if (Object.keys(record).length !== runtimeOwnerFields.length
    || runtimeOwnerFields.some((field) => !(field in record))) {
    throw new Error('Invalid Mission runtime owner record: exact fields are required.');
  }
  if (record.version !== 1) {
    throw new Error('Invalid Mission runtime owner record: version must be 1.');
  }
  for (const field of [
    'repository',
    'deploymentId',
    'githubAppInstallationId',
    'credentialGeneration',
  ]) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim().length === 0) {
      throw new Error(`Invalid Mission runtime owner record: ${field} must be non-empty.`);
    }
  }
  if (!Number.isSafeInteger(record.compatibilityEpoch) || (record.compatibilityEpoch as number) <= 0
    || !Number.isSafeInteger(record.fencingEpoch) || (record.fencingEpoch as number) <= 0) {
    throw new Error('Invalid Mission runtime owner record: epochs must be positive integers.');
  }
  if (typeof record.deploymentRecordHash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(record.deploymentRecordHash)) {
    throw new Error('Invalid Mission runtime owner record: deploymentRecordHash must be SHA-256.');
  }
  if (typeof record.approvedByCommit !== 'string'
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(record.approvedByCommit)) {
    throw new Error('Invalid Mission runtime owner record: approvedByCommit must be a Git object ID.');
  }
}

export class RuntimeOwnerConflictError extends Error {
  public constructor(message: string) {
    super(`Mission runtime owner conflict: ${message}`);
    this.name = 'RuntimeOwnerConflictError';
  }
}

export class MissionRuntimeOwnership {
  public constructor(private readonly adapter: RuntimeOwnerRefAdapter) {}

  public async acquireInitial(deployment: MissionDeploymentRecord): Promise<RuntimeOwnerObservation> {
    const observed = await this.adapter.read();
    if (observed) {
      throw new RuntimeOwnerConflictError(`already owned by ${observed.record.deploymentId}`);
    }
    return this.adapter.compareAndSwap(undefined, ownerRecord(deployment, 1));
  }

  public async transfer(
    deployment: MissionDeploymentRecord,
    githubServerTime: string,
  ): Promise<RuntimeOwnerObservation> {
    const observed = await this.adapter.read();
    if (!observed) {
      throw new RuntimeOwnerConflictError('cannot transfer an absent owner; use initial acquisition');
    }
    if (deployment.repository !== observed.record.repository) {
      throw new RuntimeOwnerConflictError('repository does not match current owner');
    }
    if (deployment.deploymentId === observed.record.deploymentId) {
      throw new RuntimeOwnerConflictError('transfer requires a different deployment ID');
    }
    const now = exactTimestamp(githubServerTime, 'GitHub server time');
    const notBefore = exactTimestamp(deployment.takeoverNotBefore, 'takeoverNotBefore');
    if (now < notBefore) {
      throw new RuntimeOwnerConflictError(`takeoverNotBefore is ${deployment.takeoverNotBefore}`);
    }
    if (exactTimestamp(deployment.priorCredentialRevokedAt, 'priorCredentialRevokedAt') > now) {
      throw new RuntimeOwnerConflictError('prior credential revocation is not yet observed');
    }
    if (deployment.credentialGeneration === observed.record.credentialGeneration) {
      throw new RuntimeOwnerConflictError('transfer requires a new credential generation');
    }
    if (deployment.compatibilityEpoch < observed.record.compatibilityEpoch) {
      throw new RuntimeOwnerConflictError('compatibility epoch cannot move backward');
    }
    return this.adapter.compareAndSwap(
      observed.sha,
      ownerRecord(deployment, observed.record.fencingEpoch + 1),
    );
  }

  public async assertMutationFence(
    deployment: MissionDeploymentRecord,
    expectedFencingEpoch: number,
  ): Promise<RuntimeOwnerObservation> {
    if (!Number.isSafeInteger(expectedFencingEpoch) || expectedFencingEpoch <= 0) {
      throw new RuntimeOwnerConflictError('fencing epoch must be a positive integer');
    }
    const observed = await this.adapter.read();
    if (!observed) {
      throw new RuntimeOwnerConflictError('owner ref is absent');
    }
    const expected = ownerRecord(deployment, expectedFencingEpoch);
    if (observed.record.credentialGeneration !== expected.credentialGeneration) {
      throw new RuntimeOwnerConflictError('credential generation does not match current owner');
    }
    for (const field of [
      'repository',
      'deploymentId',
      'githubAppInstallationId',
      'compatibilityEpoch',
      'deploymentRecordHash',
      'approvedByCommit',
    ] as const) {
      if (observed.record[field] !== expected[field]) {
        throw new RuntimeOwnerConflictError(`${field} does not match the protected deployment record`);
      }
    }
    if (observed.record.fencingEpoch !== expectedFencingEpoch) {
      throw new RuntimeOwnerConflictError('fencing epoch does not match current owner');
    }
    return observed;
  }

  public async runFencedMutation<T>(
    deployment: MissionDeploymentRecord,
    expectedFencingEpoch: number,
    mutation: (fence: RuntimeOwnerObservation) => Promise<T>,
  ): Promise<T> {
    const fence = await this.assertMutationFence(deployment, expectedFencingEpoch);
    return mutation(fence);
  }
}

export function ownerRecord(
  deployment: MissionDeploymentRecord,
  fencingEpoch: number,
): RuntimeOwnerRecord {
  if (!Number.isSafeInteger(fencingEpoch) || fencingEpoch <= 0) {
    throw new Error('Mission runtime owner fencingEpoch must be a positive integer.');
  }
  return {
    version: 1,
    repository: deployment.repository,
    deploymentId: deployment.deploymentId,
    githubAppInstallationId: deployment.githubAppInstallationId,
    credentialGeneration: deployment.credentialGeneration,
    compatibilityEpoch: deployment.compatibilityEpoch,
    deploymentRecordHash: missionDeploymentRecordHash(deployment),
    approvedByCommit: deployment.approvedByCommit,
    fencingEpoch,
  };
}

function exactTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new RuntimeOwnerConflictError(`${field} is not an exact UTC ISO timestamp`);
  }
  return parsed;
}
