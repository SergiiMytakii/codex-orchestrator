import { canonicalJson, sha256 } from './containment.js';
import {
  acceptTrustedSpecAnswer,
  type FrozenSpecQuestionReceiptV1,
  type SpecDeliveryV1,
  type TrustedSpecAnswerV1,
} from './spec-delivery.js';

export interface SpecAnswerComment {
  id?: string;
  body: string;
  author?: string;
  authorId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SpecAnswerIssue {
  comments: SpecAnswerComment[];
}

export type RepositoryPermissionReader = (
  login: string,
  expectedUserId: string,
) => Promise<{ permission: 'none' | 'read' | 'write' | 'admin'; checkedAt: string; userId: string }>;

export function specQuestionBody(receipt: FrozenSpecQuestionReceiptV1): string {
  return [
    receipt.marker,
    `Spec revision: ${receipt.revisionSha256}`,
    `Decision gaps: ${canonicalJson(receipt.decisionGaps)}`,
    receipt.question,
    `Reply with: ${receipt.answerPrefix} <answer>`,
    `Evidence: ${receipt.evidencePath}`,
  ].join('\n');
}

export async function observeTrustedSpecAnswer(input: {
  delivery: SpecDeliveryV1;
  issue: SpecAnswerIssue | undefined;
  getRepositoryPermission?: RepositoryPermissionReader;
}): Promise<{ status: 'frozen' } | { status: 'accepted'; delivery: SpecDeliveryV1 }> {
  const question = input.delivery.question;
  const questionResult = input.delivery.questionResult;
  if (!question || !questionResult || !input.issue) return { status: 'frozen' };
  const expectedQuestionBody = specQuestionBody(question);
  const markerMatches = commentsWithMarker(input.issue.comments, question.marker);
  if (markerMatches.length !== 1 || markerMatches[0]!.body !== expectedQuestionBody) return { status: 'frozen' };
  const questionIndex = input.issue.comments.findIndex((comment) => comment.body === expectedQuestionBody);
  const candidates = questionIndex < 0 ? [] : input.issue.comments.slice(questionIndex + 1)
    .filter((comment) => comment.body.startsWith(question.answerPrefix));
  const trusted: Array<{
    comment: SpecAnswerComment;
    normalized: string;
    permission: { permission: 'write' | 'admin'; userId: string; checkedAt: string };
  }> = [];
  for (const comment of candidates) {
    if (!comment.id || !comment.author || !comment.authorId || !comment.createdAt || !comment.updatedAt
      || comment.createdAt !== comment.updatedAt || !input.getRepositoryPermission) continue;
    const normalized = normalizeAnswer(comment.body, question.answerPrefix);
    if (!normalized) continue;
    let permission;
    try { permission = await input.getRepositoryPermission(comment.author, comment.authorId); }
    catch { return { status: 'frozen' }; }
    if (!['write', 'admin'].includes(permission.permission) || permission.userId !== comment.authorId) continue;
    trusted.push({
      comment,
      normalized,
      permission: permission as { permission: 'write' | 'admin'; userId: string; checkedAt: string },
    });
  }
  trusted.sort((left, right) => compareStableId(left.comment.id!, right.comment.id!));
  if (trusted.length === 0) return { status: 'frozen' };
  const hashes = [...new Set(trusted.map((item) => sha256(item.normalized)))];
  const sources = trusted.map((item) => ({
    commentId: item.comment.id!, authorId: item.comment.authorId!, author: item.comment.author!,
    normalizedAnswer: item.normalized, normalizedSha256: sha256(item.normalized), permission: structuredClone(item.permission),
    commentCreatedAt: item.comment.createdAt!, commentUpdatedAt: item.comment.updatedAt!,
  }));
  const canonicalSource = sources[0]!;
  const answer: TrustedSpecAnswerV1 = {
    accepted: hashes.length === 1,
    question: structuredClone(question),
    frozenResult: { evidenceId: questionResult.evidenceId, evidencePath: questionResult.evidencePath },
    canonicalSource,
    duplicateCommentIds: sources.slice(1)
      .filter((source) => source.normalizedSha256 === canonicalSource.normalizedSha256)
      .map((source) => source.commentId),
    additionalSources: sources.slice(1),
  };
  return { status: 'accepted', delivery: acceptTrustedSpecAnswer(input.delivery, answer) };
}

export async function revalidateTrustedSpecAnswers(input: {
  delivery: SpecDeliveryV1 | undefined;
  issue: SpecAnswerIssue | undefined;
  getRepositoryPermission?: RepositoryPermissionReader;
}): Promise<{ status: 'valid' } | { status: 'frozen'; question: FrozenSpecQuestionReceiptV1; evidencePath: string }> {
  const answers = [
    ...(input.delivery?.acceptedAnswers ?? []),
    ...(input.delivery?.trustedAnswer ? [input.delivery.trustedAnswer] : []),
  ];
  if (answers.length === 0) return { status: 'valid' };
  const fallback = answers.at(-1)!;
  if (!input.getRepositoryPermission || !input.issue) return frozen(fallback);
  for (const answer of answers) {
    const questionMatches = commentsWithMarker(input.issue.comments, answer.question.marker);
    if (questionMatches.length !== 1 || questionMatches[0]!.body !== specQuestionBody(answer.question)) return frozen(answer);
    for (const source of [answer.canonicalSource, ...answer.additionalSources]) {
      const comment = input.issue.comments.find((item) => item.id === source.commentId);
      if (!comment?.author || !comment.authorId || comment.author !== source.author || comment.authorId !== source.authorId
        || comment.createdAt !== source.commentCreatedAt || comment.updatedAt !== source.commentUpdatedAt
        || comment.createdAt !== comment.updatedAt || normalizeAnswer(comment.body, answer.question.answerPrefix) !== source.normalizedAnswer) {
        return frozen(answer);
      }
      try {
        const permission = await input.getRepositoryPermission(comment.author, comment.authorId);
        if (!['write', 'admin'].includes(permission.permission) || permission.userId !== comment.authorId) return frozen(answer);
      } catch { return frozen(answer); }
    }
  }
  return { status: 'valid' };
}

function frozen(answer: TrustedSpecAnswerV1) {
  return { status: 'frozen' as const, question: answer.question, evidencePath: answer.frozenResult.evidencePath };
}

function commentsWithMarker(comments: SpecAnswerComment[], marker: string): SpecAnswerComment[] {
  return comments.filter((comment) => comment.body.split('\n')[0] === marker);
}

function normalizeAnswer(body: string, prefix: string): string {
  return body.startsWith(prefix) ? body.slice(prefix.length).trim().replace(/\s+/gu, ' ') : '';
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
