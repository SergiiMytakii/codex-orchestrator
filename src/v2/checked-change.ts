import { posix } from 'node:path';

import { canonicalJson, sha256 } from './containment.js';

const checkedChangeBrand: unique symbol = Symbol('CheckedChange');
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export interface CheckedChangePayloadV1 {
  version: 1;
  canonicalRepository: string;
  runId: string;
  issueNumber: number;
  cycle: 1;
  baseSha: string;
  headSha: string;
  indexTreeSha: string;
  trackedContentSha256: string;
  untrackedContentSha256: string;
  worktreeIdentity: string;
  changedFiles: string[];
  checks: Array<{ id: string; command: string; status: 'passed'; outputSha256: string }>;
  checkPolicySha256: string;
  packageVersion: string;
  proofSchemaVersion: 1;
}

export interface CheckedChangeFreshness {
  headSha: string;
  indexTreeSha: string;
  trackedContentSha256: string;
  untrackedContentSha256: string;
  worktreeIdentity: string;
  checkPolicySha256: string;
}

export interface CheckedChange {
  readonly [checkedChangeBrand]: true;
}

export interface CheckedChangeMintCapability {
  mint(payload: CheckedChangePayloadV1): CheckedChange;
}

export interface CheckedChangeReadCapability {
  verifyAndRead(value: CheckedChange): { payload: CheckedChangePayloadV1; checkedChangeSha256: string };
}

export function createCheckedChangeCapabilities(): CheckedChangeMintCapability & CheckedChangeReadCapability {
  const values = new WeakMap<object, { payload: CheckedChangePayloadV1; checkedChangeSha256: string }>();
  return {
    mint(payload) {
      validatePayload(payload);
      const stored = structuredClone(payload);
      deepFreeze(stored);
      const value = Object.freeze({}) as CheckedChange;
      values.set(value as object, { payload: stored, checkedChangeSha256: sha256(canonicalJson(stored)) });
      return value;
    },
    verifyAndRead(value) {
      if (typeof value !== 'object' || value === null) throw new Error('CheckedChange was not minted by this capability');
      const stored = values.get(value as object);
      if (!stored) throw new Error('CheckedChange was not minted by this capability');
      return { payload: structuredClone(stored.payload), checkedChangeSha256: stored.checkedChangeSha256 };
    },
  };
}

export function checkedChangeFreshnessMatches(
  payload: CheckedChangePayloadV1,
  current: CheckedChangeFreshness,
): boolean {
  return payload.headSha === current.headSha
    && payload.indexTreeSha === current.indexTreeSha
    && payload.trackedContentSha256 === current.trackedContentSha256
    && payload.untrackedContentSha256 === current.untrackedContentSha256
    && payload.worktreeIdentity === current.worktreeIdentity
    && payload.checkPolicySha256 === current.checkPolicySha256;
}

function validatePayload(value: unknown): asserts value is CheckedChangePayloadV1 {
  assertExactObject(value, [
    'version',
    'canonicalRepository',
    'runId',
    'issueNumber',
    'cycle',
    'baseSha',
    'headSha',
    'indexTreeSha',
    'trackedContentSha256',
    'untrackedContentSha256',
    'worktreeIdentity',
    'changedFiles',
    'checks',
    'checkPolicySha256',
    'packageVersion',
    'proofSchemaVersion',
  ], 'CheckedChange payload');
  if (value.version !== 1 || value.cycle !== 1 || value.proofSchemaVersion !== 1) {
    throw new Error('CheckedChange payload versions/cycle are invalid');
  }
  if (typeof value.canonicalRepository !== 'string' || !REPOSITORY_PATTERN.test(value.canonicalRepository)) {
    throw new Error('CheckedChange canonicalRepository is invalid');
  }
  if (typeof value.runId !== 'string' || !UUID_V4_PATTERN.test(value.runId)) throw new Error('CheckedChange runId is invalid');
  if (!Number.isSafeInteger(value.issueNumber) || (value.issueNumber as number) <= 0) throw new Error('CheckedChange issueNumber is invalid');
  for (const field of ['baseSha', 'headSha', 'indexTreeSha'] as const) assertGitSha(value[field], `CheckedChange.${field}`);
  for (const field of ['trackedContentSha256', 'untrackedContentSha256', 'checkPolicySha256'] as const) {
    assertSha256(value[field], `CheckedChange.${field}`);
  }
  assertNonEmptyString(value.worktreeIdentity, 'CheckedChange.worktreeIdentity');
  if (!Array.isArray(value.changedFiles) || value.changedFiles.length === 0 || value.changedFiles.length > 256) {
    throw new Error('CheckedChange changedFiles must contain 1 to 256 paths');
  }
  for (const path of value.changedFiles) assertRelativePath(path, 'CheckedChange.changedFiles');
  assertUnique(value.changedFiles, 'CheckedChange.changedFiles');
  if (!Array.isArray(value.checks) || value.checks.length > 256) throw new Error('CheckedChange checks are invalid');
  const checkIds: string[] = [];
  for (const [index, check] of value.checks.entries()) {
    const field = `CheckedChange.checks[${index}]`;
    assertExactObject(check, ['id', 'command', 'status', 'outputSha256'], field);
    assertNonEmptyString(check.id, `${field}.id`);
    assertNonEmptyString(check.command, `${field}.command`);
    if (check.status !== 'passed') throw new Error(`${field}.status must be passed`);
    assertSha256(check.outputSha256, `${field}.outputSha256`);
    checkIds.push(check.id);
  }
  assertUnique(checkIds, 'CheckedChange check ids');
  assertNonEmptyString(value.packageVersion, 'CheckedChange.packageVersion');
}

function assertRelativePath(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (value.startsWith('/') || value.includes('\\') || posix.normalize(value) !== value) {
    throw new Error(`${field} must contain normalized repository-relative paths`);
  }
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${field} contains an unsafe path segment`);
  }
}

function assertGitSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_SHA_PATTERN.test(value)) throw new Error(`${field} must be a Git object ID`);
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) throw new Error(`${field} is invalid`);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}
