import { createHash } from 'node:crypto';

import { canonicalJson } from './containment.js';
import type { DirectRepairFindingV1 } from './review-data.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SOURCE_ID = /^pr-(?:thread|review):[^\s]+$/u;
const MAX_SOURCES = 256;

export interface ReviewFeedbackPermissionReceiptV1 {
  permission: 'write' | 'admin';
  userId: string;
  checkedAt: string;
}

export interface FrozenReviewFeedbackSourceV1 {
  sourceId: string;
  kind: 'thread' | 'review';
  sourceUrl: string;
  path: string | null;
  line: number | null;
  body: string;
  bodySha256: string;
  snapshotSha256: string;
  threadState: { isResolved: boolean; isOutdated: boolean } | null;
  commitSha: string;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  author: { login: string; userId: string };
  permission: ReviewFeedbackPermissionReceiptV1;
}

export interface FrozenReviewFeedbackBatchV1 {
  version: 1;
  batchId: string;
  runId: string;
  canonicalRepository: string;
  pullRequest: {
    nodeId: string;
    number: number;
    headSha: string;
    headRefName: string;
    baseRefName: string;
    marker: string;
  };
  priorPublishedHeadSha: string;
  sources: FrozenReviewFeedbackSourceV1[];
  frozenAt: string;
}

export interface ReviewFeedbackPublishedReceiptV1 {
  kind: 'published';
  batchId: string;
  sourceIds: string[];
  priorHeadSha: string;
  publishedHeadSha: string;
  pullRequestNumber: number;
  summaryCommentId: string;
  publishedAt: string;
}

export interface ReviewFeedbackBlockedReceiptV1 {
  kind: 'blocked-safety' | 'blocked-exhausted';
  batchId: string;
  blockedAt: string;
}

export interface ReviewFeedbackRunDataV1 {
  version: 1;
  updateEpoch: number;
  consumedSourceIds: string[];
  previousPublishedHeadSha: string | null;
  repairRound: 0 | 1 | 2 | 3;
  activeBatch: FrozenReviewFeedbackBatchV1 | null;
  history: Array<ReviewFeedbackPublishedReceiptV1 | ReviewFeedbackBlockedReceiptV1>;
  verifiedReceipt: { batchId: string; checkedChangeSha256: string; proofId: string; verifiedAt: string } | null;
}

export function createReviewFeedbackRunData(): ReviewFeedbackRunDataV1 {
  return {
    version: 1,
    updateEpoch: 0,
    consumedSourceIds: [],
    previousPublishedHeadSha: null,
    repairRound: 0,
    activeBatch: null,
    history: [],
    verifiedReceipt: null,
  };
}

export function createFrozenReviewFeedbackBatch(
  input: Omit<FrozenReviewFeedbackBatchV1, 'version' | 'batchId'>,
): FrozenReviewFeedbackBatchV1 {
  const sources = structuredClone(input.sources).map((source) => ({
    ...source,
    body: normalizeReviewFeedbackBody(source.body),
  })).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const identity = {
    runId: input.runId,
    canonicalRepository: input.canonicalRepository,
    pullRequest: input.pullRequest,
    priorPublishedHeadSha: input.priorPublishedHeadSha,
    sources,
  };
  const batch: FrozenReviewFeedbackBatchV1 = {
    version: 1,
    batchId: createHash('sha256')
      .update(`codex-orchestrator-review-feedback-batch-v1\0${canonicalJson(identity)}`)
      .digest('hex'),
    ...structuredClone(input),
    sources,
  };
  validateFrozenReviewFeedbackBatch(batch);
  return batch;
}

export function normalizeReviewFeedbackBody(body: string): string {
  return body.replace(/\r\n?/gu, '\n');
}

export function hashReviewFeedbackText(body: string): string {
  return createHash('sha256').update(normalizeReviewFeedbackBody(body)).digest('hex');
}

export function hashReviewFeedbackSnapshot(value: unknown): string {
  return createHash('sha256')
    .update(`codex-orchestrator-review-feedback-snapshot-v1\0${canonicalJson(value)}`)
    .digest('hex');
}

export function projectReviewFeedbackBatch(batch: FrozenReviewFeedbackBatchV1, targetRevision: number): {
  repairFindings: DirectRepairFindingV1[];
  workerFeedback: Array<{ id: string; sourceUrl: string; path: string | null; line: number | null; body: string }>;
} {
  validateFrozenReviewFeedbackBatch(batch);
  if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) throw new Error('review feedback target revision is invalid');
  const sources = [...batch.sources].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return {
    repairFindings: sources.map((source) => ({
      id: source.sourceId,
      provenance: 'pr-review',
      sourceId: source.sourceId,
      targetRevision,
      summary: [
        `${source.kind === 'thread' ? 'Pull request review thread' : 'Pull request changes-requested review'}: ${source.sourceUrl}`,
        ...(source.path ? [`Location: ${source.path}${source.line === null ? '' : `:${source.line}`}`] : []),
        source.body,
      ].join('\n'),
      affectedContracts: [...new Set([
        'pr-review',
        ...(source.path ? [`path:${source.path}`] : []),
      ])].sort(),
      status: 'open',
    })),
    workerFeedback: sources.map((source) => ({
      id: source.sourceId,
      sourceUrl: source.sourceUrl,
      path: source.path,
      line: source.line,
      body: source.body,
    })),
  };
}

export function appendConsumedReviewSourceIds(
  execution: ReviewFeedbackRunDataV1,
  sourceIds: string[],
): ReviewFeedbackRunDataV1 {
  validateReviewFeedbackRunData(execution);
  const seen = new Set(execution.consumedSourceIds);
  const consumedSourceIds = [...execution.consumedSourceIds];
  for (const sourceId of [...sourceIds].sort()) {
    assertSourceId(sourceId, 'review feedback consumed source ID');
    if (!seen.has(sourceId)) {
      seen.add(sourceId);
      consumedSourceIds.push(sourceId);
    }
  }
  return { ...structuredClone(execution), consumedSourceIds };
}

export function initializeReviewFeedback(
  execution: ReviewFeedbackRunDataV1,
  previousPublishedHeadSha: string,
  existingSourceIds: string[],
): ReviewFeedbackRunDataV1 {
  if (execution.previousPublishedHeadSha !== null || execution.activeBatch !== null) throw new Error('review feedback bootstrap is already complete');
  assertGitSha(previousPublishedHeadSha, 'review feedback previous published head');
  const next = appendConsumedReviewSourceIds(execution, existingSourceIds);
  const result: ReviewFeedbackRunDataV1 = {
    ...next, previousPublishedHeadSha, repairRound: 0,
  };
  validateReviewFeedbackRunData(result);
  return result;
}

export function activateReviewFeedback(
  execution: ReviewFeedbackRunDataV1,
  batch: FrozenReviewFeedbackBatchV1,
): ReviewFeedbackRunDataV1 {
  validateReviewFeedbackRunData(execution);
  validateFrozenReviewFeedbackBatch(batch);
  if (execution.activeBatch !== null || execution.previousPublishedHeadSha !== batch.priorPublishedHeadSha
    || batch.sources.some((source) => execution.consumedSourceIds.includes(source.sourceId))) {
    throw new Error('review feedback execution cannot activate this batch');
  }
  const withConsumed = appendConsumedReviewSourceIds(execution, batch.sources.map((source) => source.sourceId));
  const result: ReviewFeedbackRunDataV1 = {
    ...withConsumed,
    updateEpoch: execution.updateEpoch + 1,
    repairRound: 1,
    activeBatch: structuredClone(batch),
    verifiedReceipt: null,
  };
  validateReviewFeedbackRunData(result);
  return result;
}

export function reserveNextReviewFeedbackRound(execution: ReviewFeedbackRunDataV1): ReviewFeedbackRunDataV1 {
  validateReviewFeedbackRunData(execution);
  if (!execution.activeBatch || execution.repairRound >= 3) {
    throw new Error('review feedback repair budget is exhausted or inactive');
  }
  const result = {
    ...structuredClone(execution),
    repairRound: (execution.repairRound + 1) as 2 | 3,
    verifiedReceipt: null,
  };
  validateReviewFeedbackRunData(result);
  return result;
}

export function markReviewFeedbackVerified(execution: ReviewFeedbackRunDataV1, input: {
  checkedChangeSha256: string;
  proofId: string;
  verifiedAt: string;
}): ReviewFeedbackRunDataV1 {
  validateReviewFeedbackRunData(execution);
  if (!execution.activeBatch) throw new Error('review feedback is not ready to verify');
  const result: ReviewFeedbackRunDataV1 = {
    ...structuredClone(execution),
    verifiedReceipt: { batchId: execution.activeBatch.batchId, ...structuredClone(input) },
  };
  validateReviewFeedbackRunData(result);
  return result;
}

export function publishReviewFeedback(execution: ReviewFeedbackRunDataV1, receipt: ReviewFeedbackPublishedReceiptV1): ReviewFeedbackRunDataV1 {
  validateReviewFeedbackRunData(execution);
  validatePublishedReceipt(receipt);
  if (!execution.activeBatch || !execution.verifiedReceipt || receipt.batchId !== execution.activeBatch.batchId) {
    throw new Error('review feedback publication receipt does not match active batch');
  }
  const result: ReviewFeedbackRunDataV1 = {
    ...createReviewFeedbackRunData(),
    updateEpoch: execution.updateEpoch,
    consumedSourceIds: [...execution.consumedSourceIds],
    previousPublishedHeadSha: receipt.publishedHeadSha,
    history: [...execution.history, structuredClone(receipt)],
  };
  validateReviewFeedbackRunData(result);
  return result;
}

export function blockReviewFeedback(
  execution: ReviewFeedbackRunDataV1,
  kind: 'safety' | 'exhausted',
  blockedAt: string,
): ReviewFeedbackRunDataV1 {
  validateReviewFeedbackRunData(execution);
  if (!execution.activeBatch) throw new Error('review feedback has no active batch to block');
  const receipt: ReviewFeedbackBlockedReceiptV1 = {
    kind: kind === 'safety' ? 'blocked-safety' : 'blocked-exhausted',
    batchId: execution.activeBatch.batchId,
    blockedAt,
  };
  const result: ReviewFeedbackRunDataV1 = {
    ...structuredClone(execution),
    activeBatch: null,
    repairRound: 0,
    history: [...execution.history, receipt],
    verifiedReceipt: null,
  };
  validateReviewFeedbackRunData(result);
  return result;
}

export function validateReviewFeedbackRunData(value: unknown): asserts value is ReviewFeedbackRunDataV1 {
  exactObject(value, [
    'version', 'updateEpoch', 'consumedSourceIds', 'previousPublishedHeadSha', 'repairRound', 'activeBatch',
    'history', 'verifiedReceipt',
  ], 'review feedback execution');
  if (value.version !== 1) throw new Error('review feedback execution version is invalid');
  if (!Number.isSafeInteger(value.updateEpoch) || (value.updateEpoch as number) < 0) throw new Error('review feedback update epoch is invalid');
  validateSourceIds(value.consumedSourceIds, 'review feedback consumed source IDs');
  if (value.previousPublishedHeadSha !== null) assertGitSha(value.previousPublishedHeadSha, 'review feedback previous published head');
  if (![0, 1, 2, 3].includes(value.repairRound as number)) throw new Error('review feedback repair round is invalid');
  if (!Array.isArray(value.history) || value.history.length > MAX_SOURCES) throw new Error('review feedback history is invalid');
  for (const item of value.history) validateHistory(item);
  if (value.activeBatch !== null) validateFrozenReviewFeedbackBatch(value.activeBatch);
  if (value.verifiedReceipt !== null) validateVerifiedReceipt(value.verifiedReceipt);
  if (value.previousPublishedHeadSha === null && (value.repairRound !== 0 || value.activeBatch !== null || value.updateEpoch !== 0)) {
    throw new Error('review feedback bootstrap state is invalid');
  }
  if (value.activeBatch === null && value.previousPublishedHeadSha !== null && value.repairRound !== 0) {
    throw new Error('review feedback idle state is invalid');
  }
  if (value.activeBatch !== null && (value.previousPublishedHeadSha === null
    || ![1, 2, 3].includes(value.repairRound as number)
    || (value.activeBatch as FrozenReviewFeedbackBatchV1).priorPublishedHeadSha !== value.previousPublishedHeadSha)) {
    throw new Error('review feedback active state is invalid');
  }
  if (value.verifiedReceipt !== null
    && (value.verifiedReceipt as { batchId?: unknown }).batchId !== (value.activeBatch as FrozenReviewFeedbackBatchV1 | null)?.batchId) {
    throw new Error('review feedback verified receipt batch does not match active batch');
  }
}

export function validateFrozenReviewFeedbackBatch(value: unknown): asserts value is FrozenReviewFeedbackBatchV1 {
  exactObject(value, ['version', 'batchId', 'runId', 'canonicalRepository', 'pullRequest', 'priorPublishedHeadSha', 'sources', 'frozenAt'], 'review feedback batch');
  if (value.version !== 1) throw new Error('review feedback batch version is invalid');
  assertSha(value.batchId, 'review feedback batch ID');
  assertString(value.runId, 'review feedback run ID');
  if (typeof value.canonicalRepository !== 'string' || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(value.canonicalRepository)) {
    throw new Error('review feedback canonical repository is invalid');
  }
  exactObject(value.pullRequest, ['nodeId', 'number', 'headSha', 'headRefName', 'baseRefName', 'marker'], 'review feedback pull request');
  assertString(value.pullRequest.nodeId, 'review feedback pull request node ID');
  if (!Number.isSafeInteger(value.pullRequest.number) || (value.pullRequest.number as number) < 1) throw new Error('review feedback pull request number is invalid');
  assertGitSha(value.pullRequest.headSha, 'review feedback pull request head');
  for (const field of ['headRefName', 'baseRefName', 'marker'] as const) assertString(value.pullRequest[field], `review feedback pull request ${field}`);
  assertGitSha(value.priorPublishedHeadSha, 'review feedback prior published head');
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > MAX_SOURCES) throw new Error('review feedback sources are invalid');
  let prior = '';
  for (const source of value.sources) {
    validateFrozenSource(source);
    if (source.sourceId <= prior) throw new Error('review feedback sources must be sorted and unique');
    prior = source.sourceId;
  }
  assertTimestamp(value.frozenAt, 'review feedback frozenAt');
  const expected = createHash('sha256').update(`codex-orchestrator-review-feedback-batch-v1\0${canonicalJson({
    runId: value.runId,
    canonicalRepository: value.canonicalRepository,
    pullRequest: value.pullRequest,
    priorPublishedHeadSha: value.priorPublishedHeadSha,
    sources: value.sources,
  })}`).digest('hex');
  if (value.batchId !== expected) throw new Error('review feedback batch hash is invalid');
}

function validateFrozenSource(value: unknown): asserts value is FrozenReviewFeedbackSourceV1 {
  exactObject(value, ['sourceId', 'kind', 'sourceUrl', 'path', 'line', 'body', 'bodySha256', 'snapshotSha256', 'threadState', 'commitSha', 'sourceCreatedAt', 'sourceUpdatedAt', 'author', 'permission'], 'review feedback source');
  assertSourceId(value.sourceId, 'review feedback source ID');
  if (value.kind !== 'thread' && value.kind !== 'review') throw new Error('review feedback source kind is invalid');
  if ((value.kind === 'thread') !== (value.sourceId as string).startsWith('pr-thread:')) throw new Error('review feedback source ID kind mismatch');
  assertString(value.sourceUrl, 'review feedback source URL');
  if (value.path !== null) assertString(value.path, 'review feedback source path');
  if (value.line !== null && (!Number.isSafeInteger(value.line) || (value.line as number) < 1)) throw new Error('review feedback source line is invalid');
  if (typeof value.body !== 'string' || value.body.length === 0 || value.body.length > 131_072) throw new Error('review feedback source body is invalid');
  assertSha(value.bodySha256, 'review feedback source body hash');
  if (value.bodySha256 !== hashReviewFeedbackText(value.body)) throw new Error('review feedback source body hash is invalid');
  assertSha(value.snapshotSha256, 'review feedback source snapshot hash');
  if (value.kind === 'thread') {
    exactObject(value.threadState, ['isResolved', 'isOutdated'], 'review feedback thread state');
    if (typeof value.threadState.isResolved !== 'boolean' || typeof value.threadState.isOutdated !== 'boolean') throw new Error('review feedback thread state is invalid');
  } else if (value.threadState !== null) throw new Error('review feedback review source cannot have thread state');
  assertGitSha(value.commitSha, 'review feedback source commit');
  assertTimestamp(value.sourceCreatedAt, 'review feedback source createdAt');
  assertTimestamp(value.sourceUpdatedAt, 'review feedback source updatedAt');
  exactObject(value.author, ['login', 'userId'], 'review feedback source author');
  assertString(value.author.login, 'review feedback source author login');
  assertString(value.author.userId, 'review feedback source author ID');
  exactObject(value.permission, ['permission', 'userId', 'checkedAt'], 'review feedback source permission');
  if (value.permission.permission !== 'write' && value.permission.permission !== 'admin') throw new Error('review feedback source permission is invalid');
  if (value.permission.userId !== value.author.userId) throw new Error('review feedback permission identity mismatch');
  assertTimestamp(value.permission.checkedAt, 'review feedback permission checkedAt');
}

function validateHistory(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('review feedback history item is invalid');
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'published') validatePublishedReceipt(value);
  else if (kind === 'blocked-safety' || kind === 'blocked-exhausted') {
    exactObject(value, ['kind', 'batchId', 'blockedAt'], 'review feedback blocked receipt');
    assertSha(value.batchId, 'review feedback blocked batch ID');
    assertTimestamp(value.blockedAt, 'review feedback blockedAt');
  } else throw new Error('review feedback history kind is invalid');
}

function validatePublishedReceipt(value: unknown): void {
  exactObject(value, ['kind', 'batchId', 'sourceIds', 'priorHeadSha', 'publishedHeadSha', 'pullRequestNumber', 'summaryCommentId', 'publishedAt'], 'review feedback published receipt');
  if (value.kind !== 'published') throw new Error('review feedback published receipt kind is invalid');
  assertSha(value.batchId, 'review feedback published batch ID');
  validateSourceIds(value.sourceIds, 'review feedback published source IDs');
  assertGitSha(value.priorHeadSha, 'review feedback prior head');
  assertGitSha(value.publishedHeadSha, 'review feedback published head');
  if (!Number.isSafeInteger(value.pullRequestNumber) || (value.pullRequestNumber as number) < 1) throw new Error('review feedback published PR number is invalid');
  assertString(value.summaryCommentId, 'review feedback summary comment ID');
  assertTimestamp(value.publishedAt, 'review feedback publishedAt');
}

function validateVerifiedReceipt(value: unknown): void {
  exactObject(value, ['batchId', 'checkedChangeSha256', 'proofId', 'verifiedAt'], 'review feedback verified receipt');
  assertSha(value.batchId, 'review feedback verified batch ID');
  assertSha(value.checkedChangeSha256, 'review feedback checked change hash');
  assertString(value.proofId, 'review feedback proof ID');
  assertTimestamp(value.verifiedAt, 'review feedback verifiedAt');
}

function validateSourceIds(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCES * 4) throw new Error(`${field} is invalid`);
  const seen = new Set<string>();
  for (const item of value) {
    assertSourceId(item, field);
    if (seen.has(item)) throw new Error(`${field} must be unique`);
    seen.add(item);
  }
}

function assertSourceId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SOURCE_ID.test(value)) throw new Error(`${field} is invalid`);
}

function exactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${field} has unknown or missing keys`);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 131_072) throw new Error(`${field} is invalid`);
}

function assertSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${field} is invalid`);
}

function assertGitSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_SHA.test(value)) throw new Error(`${field} is invalid`);
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${field} is invalid`);
}
