import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activateReviewFeedback,
  appendConsumedReviewSourceIds,
  createFrozenReviewFeedbackBatch,
  createReviewFeedbackRunData,
  hashReviewFeedbackText,
  projectReviewFeedbackBatch,
  reserveNextReviewFeedbackRound,
  validateReviewFeedbackRunData,
  type FrozenReviewFeedbackSourceV1,
} from '../src/v2/review-feedback.js';

test('consumed sources are append-preserving and batch hashes are deterministic', () => {
  const sourceA = source('pr-thread:T_1', 'Thread body');
  const sourceB = source('pr-review:R_1', 'Review body');
  const common = {
    runId: '00000000-0000-4000-8000-000000000001',
    canonicalRepository: 'owner/repo',
    pullRequest: {
      nodeId: 'PR_1', number: 17, headSha: 'a'.repeat(40),
      headRefName: 'codex/issue-42', baseRefName: 'main',
      marker: '<!-- codex-orchestrator:run:00000000-0000-4000-8000-000000000001 -->',
    },
    priorPublishedHeadSha: 'a'.repeat(40),
    frozenAt: '2026-07-27T10:00:00.000Z',
  };
  const left = createFrozenReviewFeedbackBatch({ ...common, sources: [sourceB, sourceA] });
  const right = createFrozenReviewFeedbackBatch({ ...common, sources: [sourceA, sourceB] });
  assert.equal(left.batchId, right.batchId);
  assert.deepEqual(left.sources.map((item) => item.sourceId), ['pr-review:R_1', 'pr-thread:T_1']);

  const initialized = appendConsumedReviewSourceIds(
    { ...createReviewFeedbackRunData(), previousPublishedHeadSha: 'a'.repeat(40) },
    ['pr-thread:old', 'pr-review:old'],
  );
  const active = activateReviewFeedback(initialized, left);
  assert.deepEqual(active.consumedSourceIds, ['pr-review:old', 'pr-thread:old', 'pr-review:R_1', 'pr-thread:T_1']);
  assert.equal(active.repairRound, 1);
  assert.equal(reserveNextReviewFeedbackRound(active).repairRound, 2);
});

test('review feedback validation rejects unknown keys and permits fourth and later rounds', () => {
  const sourceA = source('pr-thread:T_1', 'Thread body');
  const batch = createFrozenReviewFeedbackBatch({
    runId: '00000000-0000-4000-8000-000000000001', canonicalRepository: 'owner/repo',
    pullRequest: { nodeId: 'PR_1', number: 17, headSha: 'a'.repeat(40), headRefName: 'codex/issue-42', baseRefName: 'main', marker: '<!-- marker -->' },
    priorPublishedHeadSha: 'a'.repeat(40), sources: [sourceA], frozenAt: '2026-07-27T10:00:00.000Z',
  });
  const active = activateReviewFeedback(
    { ...createReviewFeedbackRunData(), previousPublishedHeadSha: 'a'.repeat(40) }, batch,
  );
  assert.doesNotThrow(() => validateReviewFeedbackRunData(active));
  assert.throws(() => validateReviewFeedbackRunData({ ...active, extra: true } as never), /keys/u);
  assert.throws(() => validateReviewFeedbackRunData({ ...active, extraLifecycle: 'blocked-safety' } as never), /keys/u);
  const round3 = reserveNextReviewFeedbackRound(reserveNextReviewFeedbackRound(active));
  assert.equal(reserveNextReviewFeedbackRound(round3).repairRound, 4);
});

test('review feedback history and consumed source dedup remain valid beyond old numeric caps', () => {
  const history = Array.from({ length: 300 }, (_, index) => ({
    kind: 'published' as const,
    batchId: index.toString(16).padStart(64, '0'),
    sourceIds: [`pr-review:history-${index}`],
    priorHeadSha: 'a'.repeat(40),
    publishedHeadSha: 'b'.repeat(40),
    pullRequestNumber: 17,
    summaryCommentId: `comment-${index}`,
    publishedAt: '2026-07-27T10:00:00.000Z',
  }));
  const consumedSourceIds = Array.from({ length: 1_100 }, (_, index) => `pr-thread:consumed-${index}`);
  const execution = {
    ...createReviewFeedbackRunData(),
    previousPublishedHeadSha: 'b'.repeat(40),
    history,
    consumedSourceIds,
  };

  assert.doesNotThrow(() => validateReviewFeedbackRunData(execution));
  const appended = appendConsumedReviewSourceIds(execution, ['pr-thread:consumed-1099', 'pr-review:new-source']);
  assert.equal(appended.consumedSourceIds.length, 1_101);
  assert.equal(appended.consumedSourceIds.filter((id) => id === 'pr-thread:consumed-1099').length, 1);
});

test('257 trusted sources survive freeze persistence restart and activation without a semantic ceiling', () => {
  const sources = Array.from({ length: 257 }, (_, index) => source(`pr-thread:T_${index.toString().padStart(3, '0')}`, `Trusted body ${index}`));
  const batch = createFrozenReviewFeedbackBatch({
    runId: '00000000-0000-4000-8000-000000000001', canonicalRepository: 'owner/repo',
    pullRequest: { nodeId: 'PR_1', number: 17, headSha: 'a'.repeat(40), headRefName: 'codex/issue-42', baseRefName: 'main', marker: '<!-- marker -->' },
    priorPublishedHeadSha: 'a'.repeat(40), sources, frozenAt: '2026-07-27T10:00:00.000Z',
  });
  const activated = activateReviewFeedback(
    { ...createReviewFeedbackRunData(), previousPublishedHeadSha: 'a'.repeat(40) },
    JSON.parse(JSON.stringify(batch)),
  );
  const restarted = JSON.parse(JSON.stringify(activated));
  assert.doesNotThrow(() => validateReviewFeedbackRunData(restarted));
  assert.equal(restarted.activeBatch.sources.length, 257);
  assert.equal(restarted.consumedSourceIds.length, 257);
});

test('review feedback validation binds trusted bodies and verified receipts to the active batch', () => {
  assert.throws(() => createFrozenReviewFeedbackBatch({
    runId: '00000000-0000-4000-8000-000000000001', canonicalRepository: 'owner/repo',
    pullRequest: { nodeId: 'PR_1', number: 17, headSha: 'a'.repeat(40), headRefName: 'codex/issue-42', baseRefName: 'main', marker: '<!-- marker -->' },
    priorPublishedHeadSha: 'a'.repeat(40),
    sources: [{ ...source('pr-thread:T_1', 'Trusted body'), bodySha256: 'f'.repeat(64) }],
    frozenAt: '2026-07-27T10:00:00.000Z',
  }), /body hash/u);

  const batch = createFrozenReviewFeedbackBatch({
    runId: '00000000-0000-4000-8000-000000000001', canonicalRepository: 'owner/repo',
    pullRequest: { nodeId: 'PR_1', number: 17, headSha: 'a'.repeat(40), headRefName: 'codex/issue-42', baseRefName: 'main', marker: '<!-- marker -->' },
    priorPublishedHeadSha: 'a'.repeat(40), sources: [source('pr-thread:T_1', 'Trusted body')],
    frozenAt: '2026-07-27T10:00:00.000Z',
  });
  const active = activateReviewFeedback(
    { ...createReviewFeedbackRunData(), previousPublishedHeadSha: 'a'.repeat(40) }, batch,
  );
  assert.throws(() => validateReviewFeedbackRunData({
    ...active,
    verifiedReceipt: {
      batchId: 'f'.repeat(64), checkedChangeSha256: 'e'.repeat(64), proofId: 'proof-1',
      verifiedAt: '2026-07-27T10:00:00.000Z',
    },
  }), /batch/u);
});

test('projects only trusted frozen bodies into pr-review repair findings and worker input', () => {
  const batch = createFrozenReviewFeedbackBatch({
    runId: '00000000-0000-4000-8000-000000000001', canonicalRepository: 'owner/repo',
    pullRequest: { nodeId: 'PR_1', number: 17, headSha: 'a'.repeat(40), headRefName: 'codex/issue-42', baseRefName: 'main', marker: '<!-- marker -->' },
    priorPublishedHeadSha: 'a'.repeat(40), sources: [source('pr-thread:T_1', 'Line one\r\nLine two')], frozenAt: '2026-07-27T10:00:00.000Z',
  });
  const projected = projectReviewFeedbackBatch(batch, 3);
  assert.deepEqual(projected.workerFeedback, [{
    id: 'pr-thread:T_1', sourceUrl: 'https://example.invalid/pr-thread:T_1', path: 'src/a.ts', line: 10, body: 'Line one\nLine two',
  }]);
  assert.equal(projected.repairFindings[0]!.provenance, 'pr-review');
  assert.equal(projected.repairFindings[0]!.targetRevision, 3);
  assert.deepEqual(projected.repairFindings[0]!.affectedContracts, ['path:src/a.ts', 'pr-review']);
  assert.match(projected.repairFindings[0]!.summary, /Line one\nLine two/u);
});

function source(sourceId: string, body: string): FrozenReviewFeedbackSourceV1 {
  return {
    sourceId,
    kind: sourceId.startsWith('pr-thread:') ? 'thread' : 'review',
    sourceUrl: `https://example.invalid/${sourceId}`,
    path: sourceId.startsWith('pr-thread:') ? 'src/a.ts' : null,
    line: sourceId.startsWith('pr-thread:') ? 10 : null,
    body,
    bodySha256: hashReviewFeedbackText(body),
    snapshotSha256: sourceId.startsWith('pr-thread:') ? '3'.repeat(64) : '4'.repeat(64),
    threadState: sourceId.startsWith('pr-thread:') ? { isResolved: false, isOutdated: false } : null,
    commitSha: 'a'.repeat(40),
    sourceCreatedAt: '2026-07-27T09:00:00.000Z',
    sourceUpdatedAt: '2026-07-27T09:00:00.000Z',
    author: { login: 'writer', userId: '42' },
    permission: { permission: 'write', userId: '42', checkedAt: '2026-07-27T09:01:00.000Z' },
  };
}
