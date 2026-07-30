import { posix } from 'node:path';

import { canonicalJson, sha256 } from './containment.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface CandidateBindingV2 {
  version: 2;
  bindingId: string;
  expectedHeadSha: string;
  candidateRef: string;
  candidateCommitSha: string;
  candidateTreeSha: string;
  canonicalChangedFiles: string[];
  sourceWorktreeIdentity: string;
}

export type CandidateBoundaryV2 =
  | { kind: 'qualification'; repairAttempt: 0 | 1 | 2 | 3 | 4 | 5 }
  | { kind: 'implementation-cycle'; cycle: 1 | 2 | 3 | 4 | 5 }
  | { kind: 'review-feedback'; batchId: string; repairRound: 1 | 2 | 3 };

export interface CandidateMaterializationV2 {
  version: 2;
  bindingId: string;
  candidateCommitSha: string;
  path: string;
}

export type CandidateOperationFailureCode =
  | 'candidate-unstable'
  | 'candidate-io-failed'
  | 'candidate-materialization-io-failed'
  | 'candidate-ref-update-unknown';

export type CandidateResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'failed'; code: CandidateOperationFailureCode; detailSha256: string };

export interface CandidateGitV2 {
  reconcileOrphans?(input: {
    repositoryRoot: string;
    workspaceRoot: string;
    activeCandidateRefs: string[];
    pendingCandidates: Array<{
      runId: string;
      worktreePath: string;
      expectedHeadSha: string;
      boundary: CandidateBoundaryV2;
      artifactDir: string;
    }>;
    activeMaterializations: Array<{ path: string; candidateCommitSha: string }>;
  }): Promise<CandidateResult<void>>;
  captureAndPin(input: {
    worktreePath: string;
    expectedHeadSha: string;
    runId: string;
    boundary: CandidateBoundaryV2;
    artifactDir: string;
  }): Promise<CandidateResult<CandidateBindingV2>>;
  inspectPin(binding: CandidateBindingV2): Promise<CandidateResult<'matching' | 'missing' | 'diverged'>>;
  normalizeSharedIndex(input: { worktreePath: string; expectedHeadSha: string }): Promise<CandidateResult<void>>;
  prepareMaterialization(input: {
    binding: CandidateBindingV2;
    runId: string;
    workspaceRoot: string;
    materializationId: string;
  }): Promise<CandidateResult<{ kind: 'prepared'; materialization: CandidateMaterializationV2 } | { kind: 'path-diverged'; path: string }>>;
  inspectMaterialization(input: {
    binding: CandidateBindingV2;
    materialization: CandidateMaterializationV2;
    artifactDir: string;
  }): Promise<CandidateResult<'matching' | 'mutated' | 'missing'>>;
  removeMaterialization(input: { materialization: CandidateMaterializationV2 }): Promise<CandidateResult<void>>;
  copyProofArtifacts(input: {
    materialization: CandidateMaterializationV2;
    issueWorktreePath: string;
    artifactDir: string;
    proofId: string;
    artifacts: Array<{ relativePath: string; sha256: string }>;
  }): Promise<CandidateResult<{ kind: 'copied-or-observed' } | { kind: 'artifact-conflict'; relativePath: string }>>;
  createOrObserveCommit(input: {
    worktreePath: string;
    branchName: string;
    parentSha: string;
    treeSha: string;
    message: string;
    candidateRef: string;
    observeOnly?: true;
  }): Promise<CandidateResult<
    | { kind: 'created-or-observed'; sha: string; parentSha: string; treeSha: string; message: string }
    | { kind: 'parent-unchanged' }
    | { kind: 'branch-diverged'; observedHeadSha: string }
  >>;
  releasePin(input: { binding: CandidateBindingV2; expectedPinnedCommitSha: string }): Promise<CandidateResult<void>>;
}

export function candidateBindingSeed(runId: string, boundary: CandidateBoundaryV2): string {
  assertRunId(runId);
  validateCandidateBoundary(boundary);
  return sha256(canonicalJson({ runId, boundary }));
}

export function candidateBindingId(input: {
  bindingSeed: string;
  expectedHeadSha: string;
  candidateTreeSha: string;
  canonicalChangedFiles: string[];
  sourceWorktreeIdentity: string;
}): string {
  assertSha256(input.bindingSeed, 'candidate binding seed');
  assertGitSha(input.expectedHeadSha, 'candidate expected HEAD');
  assertGitSha(input.candidateTreeSha, 'candidate tree');
  validateCanonicalPaths(input.canonicalChangedFiles, 'candidate changed files');
  assertSha256(input.sourceWorktreeIdentity, 'candidate source worktree identity');
  return sha256(canonicalJson({ version: 2, ...input }));
}

export function candidateRef(runId: string, bindingId: string): string {
  assertRunId(runId);
  assertSha256(bindingId, 'candidate binding ID');
  return `refs/codex-orchestrator/candidates/${runId}/${bindingId}`;
}

export function validateCandidateBinding(value: unknown, field = 'candidate binding', expectedRunId?: string): CandidateBindingV2 {
  assertExactObject(value, [
    'version', 'bindingId', 'expectedHeadSha', 'candidateRef', 'candidateCommitSha', 'candidateTreeSha',
    'canonicalChangedFiles', 'sourceWorktreeIdentity',
  ], field);
  if (value.version !== 2) throw new Error(`${field}.version is invalid`);
  assertSha256(value.bindingId, `${field}.bindingId`);
  for (const key of ['expectedHeadSha', 'candidateCommitSha', 'candidateTreeSha'] as const) assertGitSha(value[key], `${field}.${key}`);
  if (typeof value.candidateRef !== 'string') {
    throw new Error(`${field}.candidateRef is invalid`);
  }
  const match = new RegExp(`^refs/codex-orchestrator/candidates/(${UUID_V4_PATTERN.source.slice(1, -1)})/(${SHA256_PATTERN.source.slice(1, -1)})$`, 'u')
    .exec(value.candidateRef);
  if (!match || match[2] !== value.bindingId || (expectedRunId !== undefined && match[1] !== expectedRunId)) {
    throw new Error(`${field}.candidateRef is not derived from its run and binding`);
  }
  validateCanonicalPaths(value.canonicalChangedFiles, `${field}.canonicalChangedFiles`);
  assertSha256(value.sourceWorktreeIdentity, `${field}.sourceWorktreeIdentity`);
  return value as unknown as CandidateBindingV2;
}

export function validateCandidateMaterialization(value: unknown, field = 'candidate materialization'): CandidateMaterializationV2 {
  assertExactObject(value, [
    'version', 'bindingId', 'candidateCommitSha', 'path',
  ], field);
  if (value.version !== 2) throw new Error(`${field}.version is invalid`);
  assertSha256(value.bindingId, `${field}.bindingId`);
  assertGitSha(value.candidateCommitSha, `${field}.candidateCommitSha`);
  if (typeof value.path !== 'string' || value.path.length === 0) throw new Error(`${field}.path is invalid`);
  return value as unknown as CandidateMaterializationV2;
}

function validateCandidateBoundary(value: CandidateBoundaryV2): void {
  if (value.kind === 'qualification') {
    if (!Number.isInteger(value.repairAttempt) || value.repairAttempt < 0 || value.repairAttempt > 5) throw new Error('candidate qualification boundary is invalid');
  } else if (value.kind === 'implementation-cycle') {
    if (!Number.isInteger(value.cycle) || value.cycle < 1 || value.cycle > 5) throw new Error('candidate implementation boundary is invalid');
  } else if (value.kind === 'review-feedback') {
    assertSha256(value.batchId, 'candidate review feedback batch ID');
    if (!Number.isInteger(value.repairRound) || value.repairRound < 1 || value.repairRound > 3) throw new Error('candidate review feedback boundary is invalid');
  } else {
    throw new Error('candidate boundary is invalid');
  }
}

function validateCanonicalPaths(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${field} is invalid`);
  for (const path of value) {
    if (typeof path !== 'string' || path.includes('\0') || path.startsWith('/') || path.includes('\\') || posix.normalize(path) !== path
      || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`${field} contains an unsafe path`);
    }
  }
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || value.some((path, index) => path !== sorted[index])) throw new Error(`${field} must be sorted and unique`);
}

function assertRunId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) throw new Error('candidate run ID is invalid');
}

function assertGitSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_SHA_PATTERN.test(value)) throw new Error(`${field} must be a Git object ID`);
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${field} has unknown or missing keys`);
}
