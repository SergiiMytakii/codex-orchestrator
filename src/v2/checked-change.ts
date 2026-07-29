import { posix } from 'node:path';

import { canonicalJson, sha256 } from './containment.js';
import { validateCandidateBinding, type CandidateBindingV2 } from './candidate.js';

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
  cycle: 1 | 2 | 3 | 4 | 5;
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

export interface CheckedChangePayloadV2 {
  version: 2;
  canonicalRepository: string;
  runId: string;
  issueNumber: number;
  cycle: 1 | 2 | 3 | 4 | 5;
  baseSha: string;
  binding: CandidateBindingV2;
  changedFiles: string[];
  checks: Array<{
    id: string;
    command: string;
    status: 'passed';
    outputSha256: string;
    bindingId: string;
    candidateTreeSha: string;
    checkPolicySha256: string;
  }>;
  checkPolicySha256: string;
  packageVersion: string;
  proofSchemaVersion: 1;
}

export interface CheckedChangeCandidateFreshness {
  bindingId: string;
  candidateTreeSha: string;
  checkPolicySha256: string;
}

export type CheckedChangePayload = CheckedChangePayloadV1 | CheckedChangePayloadV2;
export type CheckedChangeFreshnessAny = CheckedChangeFreshness | CheckedChangeCandidateFreshness;

export interface CheckedChange<TPayload extends CheckedChangePayload = CheckedChangePayloadV1> {
  readonly [checkedChangeBrand]: true;
  readonly __checkedChangePayload?: TPayload;
}

export interface CheckedChangeMintCapability {
  mint<TPayload extends CheckedChangePayload>(payload: TPayload): CheckedChange<TPayload>;
}

export interface CheckedChangeReadCapability {
  verifyAndRead<TPayload extends CheckedChangePayload>(value: CheckedChange<TPayload>): { payload: TPayload; checkedChangeSha256: string };
}

export function checkedChangePayloadSha256(payload: CheckedChangePayload): string {
  validatePayload(payload);
  return sha256(canonicalJson(payload));
}

export function createCheckedChangeCapabilities(): CheckedChangeMintCapability & CheckedChangeReadCapability {
  const values = new WeakMap<object, { payload: CheckedChangePayload; checkedChangeSha256: string }>();
  return {
    mint(payload) {
      validatePayload(payload);
      const stored = structuredClone(payload);
      deepFreeze(stored);
      const value = Object.freeze({}) as CheckedChange<typeof payload>;
      values.set(value as object, { payload: stored, checkedChangeSha256: checkedChangePayloadSha256(stored) });
      return value;
    },
    verifyAndRead(value) {
      if (typeof value !== 'object' || value === null) throw new Error('CheckedChange was not minted by this capability');
      const stored = values.get(value as object);
      if (!stored) throw new Error('CheckedChange was not minted by this capability');
      return { payload: structuredClone(stored.payload), checkedChangeSha256: stored.checkedChangeSha256 } as never;
    },
  };
}

export function checkedChangeFreshnessMatches(
  payload: CheckedChangePayload,
  current: CheckedChangeFreshnessAny,
): boolean {
  if (payload.version === 2) {
    return 'bindingId' in current
      && payload.binding.bindingId === current.bindingId
      && payload.binding.candidateTreeSha === current.candidateTreeSha
      && payload.checkPolicySha256 === current.checkPolicySha256;
  }
  if (!('headSha' in current)) return false;
  return payload.headSha === current.headSha
    && payload.indexTreeSha === current.indexTreeSha
    && payload.trackedContentSha256 === current.trackedContentSha256
    && payload.untrackedContentSha256 === current.untrackedContentSha256
    && payload.worktreeIdentity === current.worktreeIdentity
    && payload.checkPolicySha256 === current.checkPolicySha256;
}

function validatePayload(value: unknown): asserts value is CheckedChangePayload {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { version?: unknown }).version === 2) {
    validatePayloadV2(value);
    return;
  }
  validatePayloadV1(value);
}

function validatePayloadV1(value: unknown): asserts value is CheckedChangePayloadV1 {
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
  if (value.version !== 1 || !Number.isSafeInteger(value.cycle) || (value.cycle as number) < 1 || (value.cycle as number) > 5 || value.proofSchemaVersion !== 1) {
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

function validatePayloadV2(value: unknown): asserts value is CheckedChangePayloadV2 {
  assertExactObject(value, [
    'version', 'canonicalRepository', 'runId', 'issueNumber', 'cycle', 'baseSha', 'binding', 'changedFiles',
    'checks', 'checkPolicySha256', 'packageVersion', 'proofSchemaVersion',
  ], 'CheckedChange payload');
  if (value.version !== 2 || !Number.isSafeInteger(value.cycle) || (value.cycle as number) < 1 || (value.cycle as number) > 5 || value.proofSchemaVersion !== 1) {
    throw new Error('CheckedChange payload versions/cycle are invalid');
  }
  validateCommonIdentity(value);
  assertGitSha(value.baseSha, 'CheckedChange.baseSha');
  const binding = validateCandidateBinding(value.binding, 'CheckedChange.binding', value.runId as string);
  validateChangedFiles(value.changedFiles);
  if (!sameStrings(value.changedFiles, binding.canonicalChangedFiles)) throw new Error('CheckedChange changedFiles must equal candidate binding paths');
  assertSha256(value.checkPolicySha256, 'CheckedChange.checkPolicySha256');
  if (!Array.isArray(value.checks) || value.checks.length > 256) throw new Error('CheckedChange checks are invalid');
  const checkIds: string[] = [];
  for (const [index, check] of value.checks.entries()) {
    const field = `CheckedChange.checks[${index}]`;
    assertExactObject(check, ['id', 'command', 'status', 'outputSha256', 'bindingId', 'candidateTreeSha', 'checkPolicySha256'], field);
    assertNonEmptyString(check.id, `${field}.id`);
    assertNonEmptyString(check.command, `${field}.command`);
    if (check.status !== 'passed') throw new Error(`${field}.status must be passed`);
    assertSha256(check.outputSha256, `${field}.outputSha256`);
    assertSha256(check.bindingId, `${field}.bindingId`);
    assertGitSha(check.candidateTreeSha, `${field}.candidateTreeSha`);
    assertSha256(check.checkPolicySha256, `${field}.checkPolicySha256`);
    if (check.bindingId !== binding.bindingId || check.candidateTreeSha !== binding.candidateTreeSha
      || check.checkPolicySha256 !== value.checkPolicySha256) throw new Error(`${field} candidate binding is invalid`);
    checkIds.push(check.id);
  }
  assertUnique(checkIds, 'CheckedChange check ids');
  assertNonEmptyString(value.packageVersion, 'CheckedChange.packageVersion');
}

function validateCommonIdentity(value: Record<string, unknown>): void {
  if (typeof value.canonicalRepository !== 'string' || !REPOSITORY_PATTERN.test(value.canonicalRepository)) throw new Error('CheckedChange canonicalRepository is invalid');
  if (typeof value.runId !== 'string' || !UUID_V4_PATTERN.test(value.runId)) throw new Error('CheckedChange runId is invalid');
  if (!Number.isSafeInteger(value.issueNumber) || (value.issueNumber as number) <= 0) throw new Error('CheckedChange issueNumber is invalid');
}

function validateChangedFiles(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) throw new Error('CheckedChange changedFiles must contain 1 to 256 paths');
  for (const path of value) assertRelativePath(path, 'CheckedChange.changedFiles');
  assertUnique(value, 'CheckedChange.changedFiles');
}

function sameStrings(left: unknown, right: string[]): left is string[] {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
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
