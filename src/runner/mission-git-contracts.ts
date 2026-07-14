import { createHash } from 'node:crypto';

export interface MissionGitCommitIdentity {
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
}

export interface MissionGitManifestEntry {
  path: string;
  operation: 'add' | 'delete' | 'modify';
  oldMode: string | null;
  newMode: string | null;
  beforeBlob: string | null;
  afterBlob: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface MissionPatchCandidate {
  baseCommit: string;
  baseTree: string;
  patchSha256: string;
  treeSha: string;
  commitSha: string;
  manifest: MissionGitManifestEntry[];
}

export interface MissionApplyPermit {
  version: 1;
  missionId: string;
  actionKey: string;
  fencingEpoch: number;
  expiresAt: string;
  targetRef: string;
  auditReceiptSha256: string;
  patchSha256: string;
  expectedOldCommit: string;
  expectedOldTree: string;
  expectedNewCommit: string;
  expectedNewTree: string;
  manifest: MissionGitManifestEntry[];
  commit: MissionGitCommitIdentity;
}

export interface MissionApplyIntent {
  version: 1;
  permitFingerprint: string;
  permit: MissionApplyPermit;
  preparedAt: string;
}

export interface MissionApplyReceipt {
  version: 1;
  permitFingerprint: string;
  targetRef: string;
  oldCommitSha: string;
  commitSha: string;
  treeSha: string;
  recovered: boolean;
  appliedAt: string;
}

export function createMissionApplyPermit(input: {
  missionId: string;
  actionKey: string;
  fencingEpoch: number;
  expiresAt: string;
  targetRef: string;
  auditReceiptSha256: string;
  candidate: MissionPatchCandidate;
  commit: MissionGitCommitIdentity;
}): MissionApplyPermit {
  return validateMissionApplyPermit({
    version: 1,
    missionId: input.missionId,
    actionKey: input.actionKey,
    fencingEpoch: input.fencingEpoch,
    expiresAt: input.expiresAt,
    targetRef: input.targetRef,
    auditReceiptSha256: input.auditReceiptSha256,
    patchSha256: input.candidate.patchSha256,
    expectedOldCommit: input.candidate.baseCommit,
    expectedOldTree: input.candidate.baseTree,
    expectedNewCommit: input.candidate.commitSha,
    expectedNewTree: input.candidate.treeSha,
    manifest: input.candidate.manifest,
    commit: input.commit,
  });
}

export function validateMissionApplyPermit(value: unknown): MissionApplyPermit {
  const permit = object(value, 'Mission apply permit') as unknown as MissionApplyPermit;
  exactKeys(permit as unknown as Record<string, unknown>, [
    'version', 'missionId', 'actionKey', 'fencingEpoch', 'expiresAt', 'targetRef',
    'auditReceiptSha256', 'patchSha256', 'expectedOldCommit', 'expectedOldTree',
    'expectedNewCommit', 'expectedNewTree', 'manifest', 'commit',
  ], 'Mission apply permit');
  if (permit.version !== 1) fail('version must be 1');
  nonEmpty(permit.missionId, 'missionId');
  nonEmpty(permit.actionKey, 'actionKey');
  if (!Number.isInteger(permit.fencingEpoch) || permit.fencingEpoch <= 0) fail('fencingEpoch must be positive');
  timestamp(permit.expiresAt, 'expiresAt');
  if (!/^refs\/(?:heads|codex-orchestrator)\/[A-Za-z0-9._\/-]+$/u.test(permit.targetRef)
    || permit.targetRef.includes('..') || permit.targetRef.endsWith('/') || permit.targetRef.includes('//')
    || permit.targetRef.split('/').some((segment) => segment.startsWith('.') || segment.endsWith('.lock'))) {
    fail('targetRef must be an allowed full ref');
  }
  digest(permit.auditReceiptSha256, 'auditReceiptSha256');
  digest(permit.patchSha256, 'patchSha256');
  objectId(permit.expectedOldCommit, 'expectedOldCommit');
  objectId(permit.expectedOldTree, 'expectedOldTree');
  objectId(permit.expectedNewCommit, 'expectedNewCommit');
  objectId(permit.expectedNewTree, 'expectedNewTree');
  if (!Array.isArray(permit.manifest) || permit.manifest.length === 0) fail('manifest must be non-empty');
  const paths = new Set<string>();
  for (const [index, entry] of permit.manifest.entries()) {
    validateManifestEntry(entry, `manifest[${index}]`);
    if (paths.has(entry.path)) fail(`manifest contains duplicate path ${entry.path}`);
    paths.add(entry.path);
  }
  validateCommitIdentity(permit.commit);
  return structuredClone(permit);
}

export function missionApplyPermitFingerprint(permit: MissionApplyPermit): string {
  const valid = validateMissionApplyPermit(permit);
  return `sha256:${createHash('sha256').update(canonicalJson(valid), 'utf8').digest('hex')}`;
}

export function validateMissionGitCommitIdentity(value: MissionGitCommitIdentity): MissionGitCommitIdentity {
  validateCommitIdentity(value);
  return structuredClone(value);
}

export function assertMissionApplyIntent(value: unknown): asserts value is MissionApplyIntent {
  const intent = object(value, 'Mission apply intent');
  exactKeys(intent, ['version', 'permitFingerprint', 'permit', 'preparedAt'], 'Mission apply intent');
  if (intent.version !== 1) fail('apply intent version must be 1');
  digest(intent.permitFingerprint, 'apply intent permitFingerprint');
  const permit = validateMissionApplyPermit(intent.permit);
  if (intent.permitFingerprint !== missionApplyPermitFingerprint(permit)) fail('apply intent fingerprint does not match permit');
  timestamp(intent.preparedAt, 'apply intent preparedAt');
}

export function assertMissionApplyReceipt(value: unknown): asserts value is MissionApplyReceipt {
  const receipt = object(value, 'Mission apply receipt');
  exactKeys(receipt, [
    'version', 'permitFingerprint', 'targetRef', 'oldCommitSha', 'commitSha',
    'treeSha', 'recovered', 'appliedAt',
  ], 'Mission apply receipt');
  if (receipt.version !== 1) fail('apply receipt version must be 1');
  digest(receipt.permitFingerprint, 'apply receipt permitFingerprint');
  nonEmpty(receipt.targetRef, 'apply receipt targetRef');
  objectId(receipt.oldCommitSha, 'apply receipt oldCommitSha');
  objectId(receipt.commitSha, 'apply receipt commitSha');
  objectId(receipt.treeSha, 'apply receipt treeSha');
  if (typeof receipt.recovered !== 'boolean') fail('apply receipt recovered must be boolean');
  timestamp(receipt.appliedAt, 'apply receipt appliedAt');
}

function validateManifestEntry(entry: MissionGitManifestEntry, path: string): void {
  const record = object(entry, path);
  exactKeys(record, [
    'path', 'operation', 'oldMode', 'newMode', 'beforeBlob', 'afterBlob',
    'beforeSha256', 'afterSha256',
  ], path);
  nonEmpty(entry.path, `${path}.path`);
  if (entry.path.startsWith('/') || entry.path.split('/').includes('..') || entry.path === '.git' || entry.path.startsWith('.git/')) {
    fail(`${path}.path is not a repository-relative path`);
  }
  if (/[\0\r\n\\]/u.test(entry.path)) fail(`${path}.path contains forbidden characters`);
  if (!['add', 'delete', 'modify'].includes(entry.operation)) fail(`${path}.operation is invalid`);
  nullableMode(entry.oldMode, `${path}.oldMode`);
  nullableMode(entry.newMode, `${path}.newMode`);
  nullableObjectId(entry.beforeBlob, `${path}.beforeBlob`);
  nullableObjectId(entry.afterBlob, `${path}.afterBlob`);
  nullableDigest(entry.beforeSha256, `${path}.beforeSha256`);
  nullableDigest(entry.afterSha256, `${path}.afterSha256`);
  if (entry.operation === 'add' && (entry.oldMode !== null || entry.beforeBlob !== null || entry.beforeSha256 !== null
    || entry.newMode === null || entry.afterBlob === null || entry.afterSha256 === null)) fail(`${path} add must have only a complete new side`);
  if (entry.operation === 'delete' && (entry.newMode !== null || entry.afterBlob !== null || entry.afterSha256 !== null
    || entry.oldMode === null || entry.beforeBlob === null || entry.beforeSha256 === null)) fail(`${path} delete must have only a complete old side`);
  if (entry.operation === 'modify' && (entry.oldMode === null || entry.newMode === null
    || entry.beforeBlob === null || entry.afterBlob === null
    || entry.beforeSha256 === null || entry.afterSha256 === null)) fail(`${path} modify must have both complete sides`);
}

function validateCommitIdentity(value: MissionGitCommitIdentity): void {
  const identity = object(value, 'Mission commit identity');
  exactKeys(identity, [
    'message', 'authorName', 'authorEmail', 'authoredAt', 'committerName',
    'committerEmail', 'committedAt',
  ], 'Mission commit identity');
  for (const field of ['message', 'authorName', 'authorEmail', 'committerName', 'committerEmail'] as const) {
    nonEmpty(value[field], `commit.${field}`);
    if (value[field].includes('\0') || value[field].includes('\r')) fail(`commit.${field} contains forbidden characters`);
  }
  for (const field of ['authorName', 'authorEmail', 'committerName', 'committerEmail'] as const) {
    if (value[field].includes('\n')) fail(`commit.${field} contains forbidden characters`);
  }
  timestamp(value.authoredAt, 'commit.authoredAt');
  timestamp(value.committedAt, 'commit.committedAt');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new Error(`${label} has unexpected field ${key}.`);
  for (const key of allowed) if (!(key in value)) throw new Error(`${label} is missing field ${key}.`);
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be non-empty`);
}

function timestamp(value: unknown, label: string): asserts value is string {
  nonEmpty(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || Number.isNaN(Date.parse(value))) fail(`${label} must be an ISO timestamp`);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail(`${label} must be sha256 hex`);
}

function nullableDigest(value: unknown, label: string): void {
  if (value !== null) digest(value, label);
}

function objectId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) fail(`${label} must be a Git object ID`);
}

function nullableObjectId(value: unknown, label: string): void {
  if (value !== null) objectId(value, label);
}

function nullableMode(value: unknown, label: string): void {
  if (value !== null && value !== '100644') fail(`${label} must be 100644 or null`);
}

function fail(message: string): never {
  throw new Error(`Invalid Mission apply contract: ${message}.`);
}
