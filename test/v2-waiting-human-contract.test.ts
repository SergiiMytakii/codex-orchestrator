import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createConflictQuestion,
  createWaitingQuestion,
  hashNormalizedAnswer,
  normalizeAnswer,
  renderWaitingQuestionBody,
  validateTrustedAnswerReceipt,
  validateWaitingQuestion,
  validateWaitingQuestionReceipt,
} from '../src/v2/waiting-human.js';

const runId = '11111111-1111-4111-8111-111111111111';
const routeDecisionSha256 = 'a'.repeat(64);
const workflowGenerationHash = 'b'.repeat(64);

test('waiting question has the fixed acyclic ID, semantic hash, marker, body, and body hash', () => {
  const value = createWaitingQuestion({
    runId,
    generation: 1,
    routeDecisionSha256,
    workflowGenerationHash,
    priorQuestionSha256: null,
    conflictHashes: [],
    recommendation: 'Choose A.',
    question: 'A or B?',
  });

  assert.equal(value.questionId, 'q-adbe0439f3b75af520bf');
  assert.equal(value.questionSha256, 'd0c26a94d5e5f98a38aac6f150ce0162f0dc8c56d6590ca4ca453f89095cd23d');
  assert.equal(value.bodySha256, '2c50a37864c26b93d0050c20f8b0f0c7466c442e971f362077f3c10ab13141bb');
  assert.equal(value.marker, '<!-- codex-orchestrator:waiting-question:q-adbe0439f3b75af520bf:d0c26a94d5e5f98a38aac6f150ce0162f0dc8c56d6590ca4ca453f89095cd23d -->');
  assert.equal(value.answerPrefix, 'Answer q-adbe0439f3b75af520bf:');
  assert.equal(renderWaitingQuestionBody(value), `${value.marker}\n\nA or B?\n\nRecommendation: Choose A.\n\nReply with exactly this prefix:\n${value.answerPrefix}\n`);
  assert.deepEqual(validateWaitingQuestion(structuredClone(value)), value);
  assert.throws(() => validateWaitingQuestion({ ...value, bodySha256: '0'.repeat(64) }), /body hash/u);
});

test('conflict generation two uses fixed Runner copy and sorted unique hashes', () => {
  const value = createConflictQuestion({
    runId,
    routeDecisionSha256,
    workflowGenerationHash,
    priorQuestionSha256: 'c'.repeat(64),
    conflictHashes: ['e'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
  });
  assert.equal(value.generation, 2);
  assert.equal(value.recommendation, 'Resolve the conflict with one authoritative answer.');
  assert.equal(value.question, 'Conflicting authorized answers were received. What single product outcome should this run implement?');
  assert.deepEqual(value.conflictHashes, ['d'.repeat(64), 'e'.repeat(64)]);
  assert.throws(() => validateWaitingQuestion({ ...value, generation: 3 }), /generation/u);
});

test('answer normalization is Unicode-stable without folding case or internal whitespace', () => {
  assert.equal(normalizeAnswer('\r\n  Cafe\u0301  choice  \r\n second\tvalue \r\n'), 'Café  choice\nsecond\tvalue');
  assert.equal(normalizeAnswer('  Keep Case  '), 'Keep Case');
  assert.throws(() => normalizeAnswer(' \n\t '), /empty/u);
});

test('waiting receipts reject imprecise IDs, edits, weak permission, and unbound answer hashes', () => {
  const question = createWaitingQuestion({
    runId, generation: 1, routeDecisionSha256, workflowGenerationHash,
    priorQuestionSha256: null, conflictHashes: [], recommendation: 'Choose A.', question: 'A or B?',
  });
  const questionReceipt = {
    question,
    commentId: '9007199254740993',
    commentUrl: 'https://example.invalid/comments/9007199254740993',
    authorId: '12345678901234567',
    author: 'runner',
    createdAt: '2026-07-17T12:00:00.000Z',
    observedAt: '2026-07-17T12:00:01.000Z',
  };
  assert.deepEqual(validateWaitingQuestionReceipt(questionReceipt), questionReceipt);
  assert.throws(() => validateWaitingQuestionReceipt({ ...questionReceipt, commentId: 9007199254740993 }), /decimal/u);

  const answer = {
    version: 1 as const,
    questionId: question.questionId,
    questionSha256: question.questionSha256,
    commentId: '9007199254740995',
    commentUrl: 'https://example.invalid/comments/9007199254740995',
    authorId: '12345678901234568',
    author: 'maintainer',
    permission: 'write' as const,
    permissionCheckedAt: '2026-07-17T12:00:02.000Z',
    commentCreatedAt: '2026-07-17T12:00:00.000Z',
    commentUpdatedAt: '2026-07-17T12:00:00.000Z',
    observedAt: '2026-07-17T12:00:01.000Z',
    normalizedAnswer: 'Choose A',
    normalizedSha256: hashNormalizedAnswer('Choose A'),
    duplicateCommentIds: ['9007199254740997', '9007199254741000'],
  };
  assert.deepEqual(validateTrustedAnswerReceipt(answer, question), answer);
  assert.throws(() => validateTrustedAnswerReceipt({ ...answer, permission: 'read' }, question), /permission/u);
  assert.throws(() => validateTrustedAnswerReceipt({ ...answer, normalizedAnswer: ' Choose A' }, question), /normalized/u);
  assert.throws(() => validateTrustedAnswerReceipt({ ...answer, duplicateCommentIds: ['9007199254741000', '9007199254740997'] }, question), /sorted/u);
  assert.throws(() => validateTrustedAnswerReceipt({ ...answer, questionSha256: '0'.repeat(64) }, question), /binding/u);
});
