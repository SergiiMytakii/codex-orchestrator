import { createHash } from 'node:crypto';

import { canonicalJson } from './containment.js';
import { validateRouteReceipt, type RouteReceiptV1 } from './route-decision.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const QUESTION_ID_PATTERN = /^q-[0-9a-f]{20}$/u;

export interface WaitingQuestionV1 {
  version: 1;
  generation: 1 | 2;
  questionId: string;
  questionSha256: string;
  routeDecisionSha256: string;
  workflowGenerationHash: string;
  priorQuestionSha256: string | null;
  conflictHashes: string[];
  marker: string;
  answerPrefix: string;
  bodySha256: string;
  recommendation: string;
  question: string;
}

export interface CreateWaitingQuestionInput {
  runId: string;
  generation: 1 | 2;
  routeDecisionSha256: string;
  workflowGenerationHash: string;
  priorQuestionSha256: string | null;
  conflictHashes: string[];
  recommendation: string;
  question: string;
}

export type RepositoryPermission = 'none' | 'read' | 'write' | 'admin';

export interface WaitingQuestionReceiptV1 {
  question: WaitingQuestionV1;
  commentId: string;
  commentUrl: string;
  authorId: string;
  author: string;
  createdAt: string;
  observedAt: string;
}

export interface TrustedAnswerReceiptV1 {
  version: 1;
  questionId: string;
  questionSha256: string;
  commentId: string;
  commentUrl: string;
  authorId: string;
  author: string;
  permission: 'write' | 'admin';
  permissionCheckedAt: string;
  commentCreatedAt: string;
  commentUpdatedAt: string;
  observedAt: string;
  normalizedAnswer: string;
  normalizedSha256: string;
  duplicateCommentIds: string[];
}

export interface WaitingHistoryEntryV1 {
  routeReceipt: RouteReceiptV1;
  question: WaitingQuestionV1;
  questionReceipt: WaitingQuestionReceiptV1 | null;
  answerReceipt: TrustedAnswerReceiptV1 | null;
  conflictHashes: string[];
}

interface WaitingBudgetsV1 {
  version: 1;
  clarificationAttempts: 0 | 1;
  permissionRetries: 0 | 1;
  effectRetries: { questionComment: 0 | 1; waitLabels: 0 | 1; resumeLabels: 0 | 1; revokeLabels: 0 | 1 };
  history: WaitingHistoryEntryV1[];
}

export type WaitingHumanExecutionV1 = WaitingBudgetsV1 & (
  | { phase: 'question-ready'; question: WaitingQuestionV1 }
  | { phase: 'question-comment-intent'; question: WaitingQuestionV1 }
  | { phase: 'question-published'; questionReceipt: WaitingQuestionReceiptV1 }
  | { phase: 'wait-labels-intent'; questionReceipt: WaitingQuestionReceiptV1 }
  | { phase: 'awaiting-answer'; questionReceipt: WaitingQuestionReceiptV1 }
  | { phase: 'answer-frozen'; questionReceipt: WaitingQuestionReceiptV1; answerReceipt: TrustedAnswerReceiptV1 }
  | { phase: 'resume-labels-intent'; questionReceipt: WaitingQuestionReceiptV1; answerReceipt: TrustedAnswerReceiptV1 }
  | { phase: 'resume-ready'; questionReceipt: WaitingQuestionReceiptV1; answerReceipt: TrustedAnswerReceiptV1 }
  | { phase: 'revoke-labels-intent'; questionReceipt: WaitingQuestionReceiptV1; answerReceipt: TrustedAnswerReceiptV1; reason: 'permission-revoked' }
  | { phase: 'resumed'; trustedAnswer: TrustedAnswerReceiptV1 }
  | { phase: 'history-only'; terminalOutcome:
      | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted' }
      | { status: 'cancelled' | 'review-ready' | 'transport-failed' | 'internal-error' } }
);

export interface WaitingExecutionContext {
  runId: string;
  lifecycle: string;
  workflowGenerationHash: string;
  routeReceipt?: RouteReceiptV1;
  terminalOutcome?: { status: string; kind?: string };
}

export function createWaitingQuestion(input: CreateWaitingQuestionInput): WaitingQuestionV1 {
  assertNonEmpty(input.runId, 'runId');
  assertSha256(input.routeDecisionSha256, 'routeDecisionSha256');
  assertSha256(input.workflowGenerationHash, 'workflowGenerationHash');
  if (input.generation !== 1 && input.generation !== 2) throw new Error('question generation is invalid');
  if (input.priorQuestionSha256 !== null) assertSha256(input.priorQuestionSha256, 'priorQuestionSha256');
  const conflictHashes = sortedUniqueHashes(input.conflictHashes);
  assertNonEmpty(input.recommendation, 'recommendation');
  assertNonEmpty(input.question, 'question');
  if (input.generation === 1 && (input.priorQuestionSha256 !== null || conflictHashes.length !== 0)) {
    throw new Error('generation one cannot have prior question evidence');
  }
  if (input.generation === 2 && input.priorQuestionSha256 === null) throw new Error('generation two requires prior question hash');

  const questionId = `q-${domainHash('codex-orchestrator-question-id-v1', canonicalJson({
    runId: input.runId,
    generation: input.generation,
    routeDecisionSha256: input.routeDecisionSha256,
    workflowGenerationHash: input.workflowGenerationHash,
  })).slice(0, 20)}`;
  const semantic = {
    version: 1,
    generation: input.generation,
    questionId,
    routeDecisionSha256: input.routeDecisionSha256,
    workflowGenerationHash: input.workflowGenerationHash,
    priorQuestionSha256: input.priorQuestionSha256,
    conflictHashes,
    recommendation: input.recommendation,
    question: input.question,
  } as const;
  const questionSha256 = domainHash('codex-orchestrator-question-v1', canonicalJson(semantic));
  const marker = `<!-- codex-orchestrator:waiting-question:${questionId}:${questionSha256} -->`;
  const answerPrefix = `Answer ${questionId}:`;
  const body = renderBody(marker, input.question, input.recommendation, answerPrefix);
  return {
    ...semantic,
    questionSha256,
    marker,
    answerPrefix,
    bodySha256: sha256(body),
  };
}

export function createConflictQuestion(input: {
  runId: string;
  routeDecisionSha256: string;
  workflowGenerationHash: string;
  priorQuestionSha256: string;
  conflictHashes: string[];
}): WaitingQuestionV1 {
  return createWaitingQuestion({
    ...input,
    generation: 2,
    recommendation: 'Resolve the conflict with one authoritative answer.',
    question: 'Conflicting authorized answers were received. What single product outcome should this run implement?',
  });
}

export function validateWaitingQuestion(value: unknown): WaitingQuestionV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('waiting question must be an object');
  const record = value as Record<string, unknown>;
  const expected = [
    'version', 'generation', 'questionId', 'questionSha256', 'routeDecisionSha256', 'workflowGenerationHash',
    'priorQuestionSha256', 'conflictHashes', 'marker', 'answerPrefix', 'bodySha256', 'recommendation', 'question',
  ].sort();
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('waiting question keys are invalid');
  if (record.version !== 1 || (record.generation !== 1 && record.generation !== 2)) throw new Error('question generation is invalid');
  if (typeof record.questionId !== 'string' || !QUESTION_ID_PATTERN.test(record.questionId)) throw new Error('question ID is invalid');
  for (const key of ['questionSha256', 'routeDecisionSha256', 'workflowGenerationHash', 'bodySha256'] as const) assertSha256(record[key], key);
  if (record.priorQuestionSha256 !== null) assertSha256(record.priorQuestionSha256, 'priorQuestionSha256');
  if (!Array.isArray(record.conflictHashes)) throw new Error('conflict hashes are invalid');
  for (const hash of record.conflictHashes) assertSha256(hash, 'conflict hash');
  const conflictHashes = sortedUniqueHashes(record.conflictHashes as string[]);
  if (!deepEqual(conflictHashes, record.conflictHashes)) throw new Error('conflict hashes must be sorted and unique');
  if (record.generation === 1 && (record.priorQuestionSha256 !== null || conflictHashes.length !== 0)) {
    throw new Error('generation one cannot have prior question evidence');
  }
  if (record.generation === 2 && record.priorQuestionSha256 === null) throw new Error('generation two requires prior question hash');
  if (conflictHashes.length !== 0 && (conflictHashes.length < 2
    || record.recommendation !== 'Resolve the conflict with one authoritative answer.'
    || record.question !== 'Conflicting authorized answers were received. What single product outcome should this run implement?')) {
    throw new Error('conflict question copy or evidence is invalid');
  }
  for (const key of ['marker', 'answerPrefix', 'recommendation', 'question'] as const) assertNonEmpty(record[key], key);
  // questionId cannot reveal runId, so validate every derived field except the ID hash here.
  const semantic = {
    version: 1,
    generation: record.generation,
    questionId: record.questionId,
    routeDecisionSha256: record.routeDecisionSha256,
    workflowGenerationHash: record.workflowGenerationHash,
    priorQuestionSha256: record.priorQuestionSha256,
    conflictHashes,
    recommendation: record.recommendation,
    question: record.question,
  };
  const questionSha256 = domainHash('codex-orchestrator-question-v1', canonicalJson(semantic));
  const marker = `<!-- codex-orchestrator:waiting-question:${record.questionId}:${questionSha256} -->`;
  const answerPrefix = `Answer ${record.questionId}:`;
  const body = renderBody(marker, record.question as string, record.recommendation as string, answerPrefix);
  if (record.questionSha256 !== questionSha256) throw new Error('question hash mismatch');
  if (record.marker !== marker || record.answerPrefix !== answerPrefix) throw new Error('question rendering mismatch');
  if (record.bodySha256 !== sha256(body)) throw new Error('question body hash mismatch');
  return structuredClone(value) as WaitingQuestionV1;
}

export function renderWaitingQuestionBody(question: WaitingQuestionV1): string {
  const validated = validateWaitingQuestion(question);
  return renderBody(validated.marker, validated.question, validated.recommendation, validated.answerPrefix);
}

function renderBody(marker: string, question: string, recommendation: string, answerPrefix: string): string {
  return `${marker}\n\n${question}\n\nRecommendation: ${recommendation}\n\nReply with exactly this prefix:\n${answerPrefix}\n`;
}

export function normalizeAnswer(value: string): string {
  if (typeof value !== 'string') throw new Error('answer must be text');
  const normalized = value.replace(/\r\n?/gu, '\n').normalize('NFC')
    .split('\n').map((line) => line.trim()).join('\n')
    .replace(/^\n+|\n+$/gu, '');
  if (!normalized) throw new Error('normalized answer is empty');
  return normalized;
}

export function hashNormalizedAnswer(value: string): string {
  const normalized = normalizeAnswer(value);
  if (normalized !== value) throw new Error('answer must already be normalized');
  return domainHash('codex-orchestrator-answer-v1', normalized);
}

export function validateWaitingQuestionReceipt(value: unknown): WaitingQuestionReceiptV1 {
  assertExactObject(value, ['question', 'commentId', 'commentUrl', 'authorId', 'author', 'createdAt', 'observedAt'], 'waiting question receipt');
  const question = validateWaitingQuestion(value.question);
  assertDecimalId(value.commentId, 'waiting question receipt.commentId');
  assertNonEmpty(value.commentUrl, 'waiting question receipt.commentUrl');
  assertDecimalId(value.authorId, 'waiting question receipt.authorId');
  assertNonEmpty(value.author, 'waiting question receipt.author');
  assertTimestamp(value.createdAt, 'waiting question receipt.createdAt');
  assertTimestamp(value.observedAt, 'waiting question receipt.observedAt');
  if (Date.parse(value.observedAt) < Date.parse(value.createdAt)) throw new Error('waiting question receipt observation predates comment');
  return { ...(structuredClone(value) as unknown as WaitingQuestionReceiptV1), question };
}

export function validateTrustedAnswerReceipt(value: unknown, question?: WaitingQuestionV1): TrustedAnswerReceiptV1 {
  assertExactObject(value, [
    'version', 'questionId', 'questionSha256', 'commentId', 'commentUrl', 'authorId', 'author', 'permission',
    'permissionCheckedAt', 'commentCreatedAt', 'commentUpdatedAt', 'observedAt', 'normalizedAnswer',
    'normalizedSha256', 'duplicateCommentIds',
  ], 'trusted answer receipt');
  if (value.version !== 1) throw new Error('trusted answer receipt.version is invalid');
  if (typeof value.questionId !== 'string' || !QUESTION_ID_PATTERN.test(value.questionId)) throw new Error('trusted answer receipt.questionId is invalid');
  assertSha256(value.questionSha256, 'trusted answer receipt.questionSha256');
  assertDecimalId(value.commentId, 'trusted answer receipt.commentId');
  assertNonEmpty(value.commentUrl, 'trusted answer receipt.commentUrl');
  assertDecimalId(value.authorId, 'trusted answer receipt.authorId');
  assertNonEmpty(value.author, 'trusted answer receipt.author');
  if (value.permission !== 'write' && value.permission !== 'admin') throw new Error('trusted answer receipt.permission is invalid');
  for (const field of ['permissionCheckedAt', 'commentCreatedAt', 'commentUpdatedAt', 'observedAt'] as const) assertTimestamp(value[field], `trusted answer receipt.${field}`);
  const commentCreatedAt = value.commentCreatedAt as string;
  const commentUpdatedAt = value.commentUpdatedAt as string;
  const observedAt = value.observedAt as string;
  const permissionCheckedAt = value.permissionCheckedAt as string;
  if (commentUpdatedAt !== commentCreatedAt) throw new Error('trusted answer receipt comment must be unedited');
  if (Date.parse(observedAt) < Date.parse(commentUpdatedAt) || Date.parse(permissionCheckedAt) < Date.parse(observedAt)) {
    throw new Error('trusted answer receipt observation or permission predates comment');
  }
  assertNonEmpty(value.normalizedAnswer, 'trusted answer receipt.normalizedAnswer');
  if (normalizeAnswer(value.normalizedAnswer) !== value.normalizedAnswer) throw new Error('trusted answer receipt answer is not normalized');
  assertSha256(value.normalizedSha256, 'trusted answer receipt.normalizedSha256');
  if (value.normalizedSha256 !== hashNormalizedAnswer(value.normalizedAnswer)) throw new Error('trusted answer receipt normalized hash mismatch');
  validateDecimalIdList(value.duplicateCommentIds, 'trusted answer receipt.duplicateCommentIds');
  if ((value.duplicateCommentIds as string[]).includes(value.commentId as string)) throw new Error('trusted answer receipt duplicate IDs include canonical comment');
  if (question && (value.questionId !== question.questionId || value.questionSha256 !== question.questionSha256)) {
    throw new Error('trusted answer receipt question binding mismatch');
  }
  return structuredClone(value) as unknown as TrustedAnswerReceiptV1;
}

export function validateWaitingHumanExecution(value: unknown, context: WaitingExecutionContext): WaitingHumanExecutionV1 {
  assertRecord(value, 'waiting execution');
  const common = ['version', 'clarificationAttempts', 'permissionRetries', 'effectRetries', 'history', 'phase'];
  const phaseKeys: Record<string, string[]> = {
    'question-ready': ['question'],
    'question-comment-intent': ['question'],
    'question-published': ['questionReceipt'],
    'wait-labels-intent': ['questionReceipt'],
    'awaiting-answer': ['questionReceipt'],
    'answer-frozen': ['questionReceipt', 'answerReceipt'],
    'resume-labels-intent': ['questionReceipt', 'answerReceipt'],
    'resume-ready': ['questionReceipt', 'answerReceipt'],
    'revoke-labels-intent': ['questionReceipt', 'answerReceipt', 'reason'],
    resumed: ['trustedAnswer'],
    'history-only': ['terminalOutcome'],
  };
  if (typeof value.phase !== 'string' || !phaseKeys[value.phase]) throw new Error('waiting execution phase is invalid');
  assertExactObject(value, [...common, ...phaseKeys[value.phase]!], 'waiting execution');
  if (value.version !== 1 || !isBit(value.clarificationAttempts) || !isBit(value.permissionRetries)) throw new Error('waiting execution budgets are invalid');
  assertExactObject(value.effectRetries, ['questionComment', 'waitLabels', 'resumeLabels', 'revokeLabels'], 'waiting execution.effectRetries');
  for (const name of ['questionComment', 'waitLabels', 'resumeLabels', 'revokeLabels'] as const) {
    if (!isBit(value.effectRetries[name])) throw new Error(`waiting execution.effectRetries.${name} is invalid`);
  }
  if (!Array.isArray(value.history) || value.history.length > 2) throw new Error('waiting execution history is invalid');
  const history = value.history.map((entry, index) => validateHistoryEntry(entry, context, index));
  for (let index = 1; index < history.length; index += 1) {
    if (history[index]!.question.generation !== history[index - 1]!.question.generation + 1) throw new Error('waiting execution history generations are invalid');
    if (history[index]!.question.priorQuestionSha256 !== history[index - 1]!.question.questionSha256) throw new Error('waiting execution history chain is invalid');
  }
  if (history.length > 0 && history[0]!.question.generation !== 1) throw new Error('waiting execution history must begin at generation one');

  const active = !['resumed', 'history-only'].includes(value.phase);
  if (active) {
    if (context.lifecycle !== 'waiting-human') throw new Error('active waiting execution requires waiting-human lifecycle');
    if (!context.routeReceipt || context.routeReceipt.route !== 'awaiting-user') throw new Error('active waiting execution requires awaiting-user route');
    const route = validateRouteReceipt(context.routeReceipt, context.workflowGenerationHash);
    const question = 'question' in value
      ? validateWaitingQuestion(value.question)
      : validateWaitingQuestionReceipt(value.questionReceipt).question;
    validateActiveQuestion(question, history, route, context);
    if ('questionReceipt' in value) validateWaitingQuestionReceipt(value.questionReceipt);
    if ('answerReceipt' in value) {
      const questionReceipt = validateWaitingQuestionReceipt(value.questionReceipt);
      const answerReceipt = validateTrustedAnswerReceipt(value.answerReceipt, question);
      validateAnswerAfterQuestion(questionReceipt, answerReceipt);
    }
    if (value.phase === 'revoke-labels-intent' && value.reason !== 'permission-revoked') throw new Error('waiting execution revocation reason is invalid');
  } else if (value.phase === 'resumed') {
    if (!['triaging', 'routed', 'implementing', 'spec-authoring', 'reworking', 'checking', 'proving', 'publishing', 'safe-halt'].includes(context.lifecycle)) {
      throw new Error('resumed waiting execution lifecycle is invalid');
    }
    if (history.length === 0 || history.at(-1)!.answerReceipt === null) throw new Error('resumed waiting execution requires answer history');
    const trusted = validateTrustedAnswerReceipt(value.trustedAnswer, history.at(-1)!.question);
    if (!deepEqual(trusted, history.at(-1)!.answerReceipt)) throw new Error('resumed trusted answer does not match history');
  } else {
    if (!['blocked', 'cancelled', 'review-ready', 'transport-failed', 'internal-error'].includes(context.lifecycle)) {
      throw new Error('history-only waiting execution lifecycle is invalid');
    }
    if (history.length === 0) throw new Error('history-only waiting execution requires history');
    validateTerminalProjection(value.terminalOutcome, context);
  }
  return structuredClone(value) as unknown as WaitingHumanExecutionV1;
}

function validateHistoryEntry(value: unknown, context: WaitingExecutionContext, index: number): WaitingHistoryEntryV1 {
  assertExactObject(value, ['routeReceipt', 'question', 'questionReceipt', 'answerReceipt', 'conflictHashes'], `waiting history[${index}]`);
  const routeReceipt = validateRouteReceipt(value.routeReceipt, context.workflowGenerationHash);
  if (routeReceipt.route !== 'awaiting-user') throw new Error(`waiting history[${index}] route is not awaiting-user`);
  const question = validateWaitingQuestion(value.question);
  validateQuestionIdentity(question, routeReceipt, context);
  const conflicts = sortedUniqueHashes(value.conflictHashes as string[]);
  if (!deepEqual(conflicts, value.conflictHashes)) throw new Error(`waiting history[${index}] conflict hashes mismatch`);
  const questionReceipt = value.questionReceipt === null ? null : validateWaitingQuestionReceipt(value.questionReceipt);
  if (questionReceipt && !deepEqual(questionReceipt.question, question)) throw new Error(`waiting history[${index}] question receipt mismatch`);
  const answerReceipt = value.answerReceipt === null ? null : validateTrustedAnswerReceipt(value.answerReceipt, question);
  if (answerReceipt && questionReceipt === null) throw new Error(`waiting history[${index}] answer requires publication receipt`);
  if (answerReceipt && questionReceipt) validateAnswerAfterQuestion(questionReceipt, answerReceipt);
  return { routeReceipt, question, questionReceipt, answerReceipt, conflictHashes: conflicts };
}

function validateAnswerAfterQuestion(question: WaitingQuestionReceiptV1, answer: TrustedAnswerReceiptV1): void {
  if (Date.parse(answer.commentCreatedAt) <= Date.parse(question.createdAt)) {
    throw new Error('trusted answer receipt must be posted after the waiting question');
  }
}

function validateActiveQuestion(question: WaitingQuestionV1, history: WaitingHistoryEntryV1[], route: RouteReceiptV1, context: WaitingExecutionContext): void {
  validateQuestionIdentity(question, route, context);
  if (question.generation === 1) {
    if (history.length !== 0) throw new Error('generation one active question requires empty history');
  } else {
    if (history.length !== 1 || question.priorQuestionSha256 !== history[0]!.question.questionSha256) throw new Error('generation two active question requires prior history');
    if (!deepEqual(question.conflictHashes, history[0]!.conflictHashes)) throw new Error('generation two conflict evidence does not match history');
  }
}

function validateQuestionIdentity(question: WaitingQuestionV1, route: RouteReceiptV1, context: WaitingExecutionContext): void {
  if (question.routeDecisionSha256 !== route.decisionSha256 || question.workflowGenerationHash !== context.workflowGenerationHash) {
    throw new Error('waiting question route or workflow generation mismatch');
  }
  const rebuilt = createWaitingQuestion({
    runId: context.runId,
    generation: question.generation,
    routeDecisionSha256: question.routeDecisionSha256,
    workflowGenerationHash: question.workflowGenerationHash,
    priorQuestionSha256: question.priorQuestionSha256,
    conflictHashes: question.conflictHashes,
    recommendation: question.recommendation,
    question: question.question,
  });
  if (!deepEqual(rebuilt, question)) throw new Error('waiting question run identity mismatch');
}

function validateTerminalProjection(value: unknown, context: WaitingExecutionContext): void {
  assertRecord(value, 'waiting execution terminalOutcome');
  if (context.lifecycle !== 'blocked') {
    assertExactObject(value, ['status'], 'waiting execution terminalOutcome');
    if (value.status !== context.lifecycle || context.terminalOutcome?.status !== context.lifecycle) throw new Error('waiting terminal outcome mismatch');
  } else {
    assertExactObject(value, ['status', 'kind'], 'waiting execution terminalOutcome');
    if (value.status !== 'blocked' || !['external', 'safety', 'exhausted'].includes(value.kind as string)
      || context.terminalOutcome?.status !== 'blocked' || context.terminalOutcome.kind !== value.kind) {
      throw new Error('waiting terminal outcome mismatch');
    }
  }
}

function domainHash(domain: string, value: string): string {
  return createHash('sha256').update(domain).update(Buffer.from([0])).update(value, 'utf8').digest('hex');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sortedUniqueHashes(values: string[]): string[] {
  if (!Array.isArray(values)) throw new Error('conflict hashes are invalid');
  for (const value of values) assertSha256(value, 'conflict hash');
  return Array.from(new Set(values)).sort();
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${field} is invalid`);
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is empty`);
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  assertRecord(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${field} is invalid`);
}

function assertDecimalId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${field} must be a positive decimal string`);
}

function validateDecimalIdList(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${field} is invalid`);
  for (const id of value) assertDecimalId(id, field);
  const sorted = [...value].sort(compareDecimalIds);
  if (new Set(value).size !== value.length || !deepEqual(sorted, value)) throw new Error(`${field} must be sorted and unique`);
}

function compareDecimalIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

function isBit(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
