import { createHash } from 'node:crypto';

export interface MissionDeploymentRecord {
  version: 1;
  repository: string;
  deploymentId: string;
  hostId: string;
  serviceId: string;
  githubAppInstallationId: string;
  credentialGeneration: string;
  compatibilityEpoch: number;
  priorCredentialRevokedAt: string;
  priorTokenExpiresAt: string;
  takeoverGraceUntil: string;
  takeoverNotBefore: string;
  approvedByCommit: string;
}

const deploymentFields: ReadonlyArray<keyof MissionDeploymentRecord> = [
  'version',
  'repository',
  'deploymentId',
  'hostId',
  'serviceId',
  'githubAppInstallationId',
  'credentialGeneration',
  'compatibilityEpoch',
  'priorCredentialRevokedAt',
  'priorTokenExpiresAt',
  'takeoverGraceUntil',
  'takeoverNotBefore',
  'approvedByCommit',
];

export function canonicalMissionDeploymentRecord(record: MissionDeploymentRecord): string {
  assertMissionDeploymentRecord(record);
  return JSON.stringify(Object.fromEntries(deploymentFields.map((field) => [field, record[field]])));
}

export function parseMissionDeploymentRecord(content: string): MissionDeploymentRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid Mission deployment record: expected JSON.');
  }
  assertMissionDeploymentRecord(parsed);
  const canonical = canonicalMissionDeploymentRecord(parsed);
  if (content !== canonical) {
    throw new Error('Invalid Mission deployment record: file must use canonical JSON.');
  }
  return parsed;
}

export function missionDeploymentRecordHash(record: MissionDeploymentRecord): string {
  return `sha256:${createHash('sha256')
    .update(Buffer.from(canonicalMissionDeploymentRecord(record), 'utf8'))
    .digest('hex')}`;
}

export function takeoverNotBefore(record: Pick<
MissionDeploymentRecord,
'priorTokenExpiresAt' | 'takeoverGraceUntil'
>): string {
  const tokenExpiry = parseExactTimestamp(record.priorTokenExpiresAt, 'priorTokenExpiresAt');
  const grace = parseExactTimestamp(record.takeoverGraceUntil, 'takeoverGraceUntil');
  return new Date(Math.max(tokenExpiry, grace)).toISOString();
}

export function assertMissionDeploymentRecord(value: unknown): asserts value is MissionDeploymentRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Mission deployment record: root must be an object.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(deploymentFields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid Mission deployment record: unexpected field ${key}.`);
    }
  }
  for (const field of deploymentFields) {
    if (!(field in record)) {
      throw new Error(`Invalid Mission deployment record: missing field ${field}.`);
    }
  }
  if (record.version !== 1) {
    throw new Error('Invalid Mission deployment record: version must be 1.');
  }
  for (const field of [
    'repository',
    'deploymentId',
    'hostId',
    'serviceId',
    'githubAppInstallationId',
    'credentialGeneration',
  ]) {
    requireNonEmpty(record[field], field);
  }
  if (!Number.isSafeInteger(record.compatibilityEpoch) || (record.compatibilityEpoch as number) <= 0) {
    throw new Error('Invalid Mission deployment record: compatibilityEpoch must be a positive integer.');
  }
  for (const field of [
    'priorCredentialRevokedAt',
    'priorTokenExpiresAt',
    'takeoverGraceUntil',
    'takeoverNotBefore',
  ]) {
    parseExactTimestamp(record[field], field);
  }
  if (record.takeoverNotBefore !== takeoverNotBefore(record as unknown as MissionDeploymentRecord)) {
    throw new Error('Invalid Mission deployment record: takeoverNotBefore must equal the later token expiry or grace boundary.');
  }
  if (typeof record.approvedByCommit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(record.approvedByCommit)) {
    throw new Error('Invalid Mission deployment record: approvedByCommit must be a Git object ID.');
  }
}

function parseExactTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Mission deployment record: ${field} must be an ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Invalid Mission deployment record: ${field} must be an exact UTC ISO timestamp.`);
  }
  return parsed;
}

function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid Mission deployment record: ${field} must be non-empty.`);
  }
}
