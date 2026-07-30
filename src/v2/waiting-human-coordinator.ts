import {
  GitHubPermissionSafetyError,
  type GitHubIssueAdapter,
  type GitHubIssueComment,
} from './adapters/issues.js';
import type { RoutedRunContext } from './route-continuations.js';
import {
  createWaitingQuestion,
  createConflictQuestion,
  hashNormalizedAnswer,
  normalizeAnswer,
  renderWaitingQuestionBody,
  type TrustedAnswerReceiptV1,
  type WaitingHumanExecutionV1,
  type WaitingQuestionReceiptV1,
} from './waiting-human.js';

export interface WaitingHumanState {
  read(): Promise<WaitingHumanExecutionV1 | undefined>;
  compareAndSwap(expected: WaitingHumanExecutionV1 | undefined, next: WaitingHumanExecutionV1): Promise<boolean>;
  publishQuestion(input: { issueNumber: number; marker: string; body: string }): Promise<
    | { status: 'settled' }
    | { status: 'retryable'; code: string }
    | { status: 'conflict'; evidence: string[] }
  >;
  projectLabels(input: {
    kind: 'waiting-wait-labels' | 'waiting-resume-labels' | 'waiting-revoke-labels';
    issueNumber: number;
    expected: string[];
  }): Promise<{ status: 'settled' } | { status: 'retryable'; code: string } | { status: 'cancelled' }>;
}

export type WaitingHumanResult =
  | { status: 'awaiting-answer'; questionId: string; answerPrefix: string }
  | { status: 'resume-ready'; answer: TrustedAnswerReceiptV1 }
  | { status: 'retryable'; owner: 'github-effect' | 'permission'; code: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; resumable: boolean; code: string; evidence: string[] }
  | { status: 'cancelled' };

export interface WaitingHumanCoordinatorDependencies {
  issues: GitHubIssueAdapter;
  labels: {
    auto: string;
    running: string;
    blocked: string;
    review: string;
    waitingHuman: string;
    manual?: string;
  };
  now?: () => string;
}

export class WaitingHumanCoordinator {
  private readonly now: () => string;

  public constructor(private readonly dependencies: WaitingHumanCoordinatorDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async run(input: RoutedRunContext, state: WaitingHumanState, signal: AbortSignal): Promise<WaitingHumanResult> {
    let current = await state.read();
    for (let step = 0; step < 24; step += 1) {
      if (signal.aborted) return { status: 'cancelled' };
      if (!current) {
        const awaiting = input.receipt.artifact.awaitingUser;
        if (input.receipt.route !== 'awaiting-user' || !awaiting) return safety('waiting-route-mismatch');
        const question = createWaitingQuestion({
          runId: input.runId,
          generation: 1,
          routeDecisionSha256: input.receipt.decisionSha256,
          workflowGenerationHash: input.workflowGeneration.generationHash,
          priorQuestionSha256: null,
          conflictHashes: [],
          recommendation: awaiting.recommendation,
          question: awaiting.question,
        });
        const next: WaitingHumanExecutionV1 = {
          ...emptyExecution(), phase: 'question-ready', question,
        };
        if (!await state.compareAndSwap(undefined, next)) { current = await state.read(); continue; }
        current = next;
        continue;
      }
      if (current.phase === 'awaiting-answer') {
        const frozen = await this.freezeAnswer(current, input.issue.number);
        if (frozen.status === 'retryable') {
          if (current.permissionRetries === 1) {
            return { status: 'blocked', kind: 'external', resumable: true, code: 'permission-retries-exhausted', evidence: [] };
          }
          const retry: WaitingHumanExecutionV1 = { ...current, permissionRetries: 1 };
          if (!await state.compareAndSwap(current, retry)) { current = await state.read(); continue; }
          return frozen.result;
        }
        if (frozen.status === 'safety') return safety(frozen.code);
        if (frozen.status === 'none') return awaitingResult(current.questionReceipt);
        if (frozen.status === 'conflict') {
          if (current.clarificationAttempts === 1 || current.questionReceipt.question.generation === 2) {
            return { status: 'blocked', kind: 'exhausted', resumable: false, code: 'answer-conflict', evidence: frozen.hashes };
          }
          const question = current.questionReceipt.question;
          const nextQuestion = createConflictQuestion({
            runId: input.runId,
            routeDecisionSha256: input.receipt.decisionSha256,
            workflowGenerationHash: input.workflowGeneration.generationHash,
            priorQuestionSha256: question.questionSha256,
            conflictHashes: frozen.hashes,
          });
          const next: WaitingHumanExecutionV1 = {
            ...current,
            clarificationAttempts: 1,
            history: [...current.history, {
              routeReceipt: structuredClone(input.receipt), question: structuredClone(question),
              questionReceipt: structuredClone(current.questionReceipt), answerReceipt: null, conflictHashes: [...frozen.hashes],
            }],
            phase: 'question-ready',
            question: nextQuestion,
          };
          delete (next as Partial<{ questionReceipt: unknown }>).questionReceipt;
          if (!await state.compareAndSwap(current, next)) { current = await state.read(); continue; }
          current = next;
          continue;
        }
        const next: WaitingHumanExecutionV1 = { ...current, phase: 'answer-frozen', answerReceipt: frozen.answer };
        if (!await state.compareAndSwap(current, next)) { current = await state.read(); continue; }
        current = next;
        continue;
      }
      if (current.phase === 'resume-ready') return { status: 'resume-ready', answer: structuredClone(current.answerReceipt) };
      if (current.phase === 'resumed') {
        const awaiting = input.receipt.artifact.awaitingUser;
        if (input.receipt.route !== 'awaiting-user' || !awaiting) return safety('waiting-route-mismatch');
        if (current.clarificationAttempts === 1 || current.history.length !== 1) {
          return { status: 'blocked', kind: 'exhausted', resumable: false, code: 'waiting-question-budget-exhausted', evidence: [] };
        }
        const prior = current.history[0]!.question;
        const question = createWaitingQuestion({
          runId: input.runId,
          generation: 2,
          routeDecisionSha256: input.receipt.decisionSha256,
          workflowGenerationHash: input.workflowGeneration.generationHash,
          priorQuestionSha256: prior.questionSha256,
          conflictHashes: [],
          recommendation: awaiting.recommendation,
          question: awaiting.question,
        });
        const next: WaitingHumanExecutionV1 = {
          ...current, clarificationAttempts: 1, phase: 'question-ready', question,
        };
        delete (next as Partial<{ trustedAnswer: unknown }>).trustedAnswer;
        if (!await state.compareAndSwap(current, next)) { current = await state.read(); continue; }
        current = next;
        continue;
      }
      if (current.phase === 'history-only') return safety('waiting-state-not-active');
      if (current.phase === 'answer-frozen') {
        const authority = await this.revalidateAnswer(input.issue.number, current.answerReceipt);
        if (authority === 'retryable') {
          if (current.permissionRetries === 1) {
            return { status: 'blocked', kind: 'external', resumable: true, code: 'permission-retries-exhausted', evidence: [] };
          }
          const retry: WaitingHumanExecutionV1 = { ...current, permissionRetries: 1 };
          if (!await state.compareAndSwap(current, retry)) { current = await state.read(); continue; }
          return { status: 'retryable', owner: 'permission', code: 'answer-revalidation-failed' };
        }
        if (authority === 'revoked') {
          const revoked = await state.projectLabels({
            kind: 'waiting-revoke-labels', issueNumber: input.issue.number,
            expected: [this.dependencies.labels.auto, this.dependencies.labels.blocked].sort(),
          });
          if (revoked.status === 'retryable') return { status: 'retryable', owner: 'github-effect', code: revoked.code };
          if (revoked.status === 'cancelled') return { status: 'cancelled' };
          return safety('answer-permission-revoked', [current.answerReceipt.commentId]);
        }
        const resumed = await state.projectLabels({
          kind: 'waiting-resume-labels', issueNumber: input.issue.number,
          expected: [this.dependencies.labels.auto, this.dependencies.labels.running].sort(),
        });
        if (resumed.status === 'retryable') return { status: 'retryable', owner: 'github-effect', code: resumed.code };
        if (resumed.status === 'cancelled') return safety('resume-label-authority-revoked');
        const finalAuthority = await this.revalidateAnswer(input.issue.number, current.answerReceipt);
        if (finalAuthority === 'retryable') return { status: 'retryable', owner: 'permission', code: 'answer-final-revalidation-failed' };
        if (finalAuthority === 'revoked') {
          const revoked = await state.projectLabels({
            kind: 'waiting-revoke-labels', issueNumber: input.issue.number,
            expected: [this.dependencies.labels.auto, this.dependencies.labels.blocked].sort(),
          });
          if (revoked.status === 'retryable') return { status: 'retryable', owner: 'github-effect', code: revoked.code };
          return revoked.status === 'cancelled' ? { status: 'cancelled' } : safety('answer-permission-revoked', [current.answerReceipt.commentId]);
        }
        const next: WaitingHumanExecutionV1 = { ...current, phase: 'resume-ready' };
        if (!await state.compareAndSwap(current, next)) { current = await state.read(); continue; }
        current = next;
        continue;
      }
      if (current.phase === 'question-ready') {
        const body = renderWaitingQuestionBody(current.question);
        const effect = await state.publishQuestion({ issueNumber: input.issue.number, marker: current.question.marker, body });
        if (effect.status === 'retryable') return { status: 'retryable', owner: 'github-effect', code: effect.code };
        if (effect.status === 'conflict') return safety('question-comment-conflict', effect.evidence);
        let observation: Awaited<ReturnType<WaitingHumanCoordinator['observeQuestion']>>;
        try { observation = await this.observeQuestion(input.issue.number, current.question.marker, body); }
        catch { return { status: 'retryable', owner: 'github-effect', code: 'question-comment-observation-failed' }; }
        if (observation.status !== 'found') return observation.status === 'conflict'
          ? safety('question-comment-conflict', observation.evidence)
          : { status: 'retryable', owner: 'github-effect', code: 'question-comment-observation-failed' };
        const next: WaitingHumanExecutionV1 = {
          ...current, phase: 'question-published', questionReceipt: receiptFor(current.question, observation.comment, this.now()),
        };
        delete (next as Partial<{ question: unknown }>).question;
        if (!await state.compareAndSwap(current, next)) { current = await state.read(); continue; }
        current = next;
        continue;
      }
      if (current.phase === 'question-published') {
        const effect = await state.projectLabels({
          kind: 'waiting-wait-labels', issueNumber: input.issue.number,
          expected: [this.dependencies.labels.auto, this.dependencies.labels.waitingHuman].sort(),
        });
        if (effect.status === 'retryable') return { status: 'retryable', owner: 'github-effect', code: effect.code };
        if (effect.status === 'cancelled') return { status: 'cancelled' };
        const next: WaitingHumanExecutionV1 = { ...current, phase: 'awaiting-answer' };
        if (!await state.compareAndSwap(current, next)) { current = await state.read(); continue; }
        current = next;
        continue;
      }
      return safety('waiting-phase-not-implemented');
    }
    return safety('waiting-coordinator-step-bound');
  }

  private async observeQuestion(issueNumber: number, marker: string, body: string): Promise<
    | { status: 'absent' }
    | { status: 'found'; comment: GitHubIssueComment }
    | { status: 'conflict'; evidence: string[] }
  > {
    const comments = await this.dependencies.issues.listAllComments(issueNumber);
    const marked = comments.filter((comment) => comment.body.includes(marker));
    if (marked.length === 0) return { status: 'absent' };
    if (marked.length !== 1 || marked[0]!.body !== body || marked[0]!.createdAt !== marked[0]!.updatedAt) {
      return { status: 'conflict', evidence: marked.map((comment) => comment.id) };
    }
    return { status: 'found', comment: marked[0]! };
  }

  private async freezeAnswer(current: Extract<WaitingHumanExecutionV1, { phase: 'awaiting-answer' }>, issueNumber: number): Promise<
    | { status: 'none' }
    | { status: 'conflict'; hashes: string[] }
    | { status: 'trusted'; answer: TrustedAnswerReceiptV1 }
    | { status: 'retryable'; result: WaitingHumanResult }
    | { status: 'safety'; code: string }
  > {
    let comments: GitHubIssueComment[];
    try { comments = await this.dependencies.issues.listAllComments(issueNumber); }
    catch { return { status: 'retryable', result: { status: 'retryable', owner: 'permission', code: 'answer-comments-read-failed' } }; }
    const observedAt = this.now();
    const question = current.questionReceipt.question;
    const candidates = comments.filter((comment) => comment.body.startsWith(question.answerPrefix)
      && comment.createdAt === comment.updatedAt
      && Date.parse(comment.createdAt) > Date.parse(current.questionReceipt.createdAt))
      .sort((left, right) => compareDecimal(left.id, right.id));
    const trusted: Array<{ comment: GitHubIssueComment; permission: 'write' | 'admin'; checkedAt: string; normalized: string; hash: string }> = [];
    for (const comment of candidates) {
      let normalized: string;
      try { normalized = normalizeAnswer(comment.body.slice(question.answerPrefix.length)); }
      catch { continue; }
      try {
        const permission = await this.dependencies.issues.getRepositoryPermission(comment.author.login, comment.author.id);
        if (Date.parse(permission.checkedAt) < Date.parse(observedAt) || permission.userId !== comment.author.id) {
          return { status: 'retryable', result: { status: 'retryable', owner: 'permission', code: 'permission-observation-stale' } };
        }
        if (permission.permission !== 'write' && permission.permission !== 'admin') continue;
        trusted.push({ comment, permission: permission.permission, checkedAt: permission.checkedAt, normalized, hash: hashNormalizedAnswer(normalized) });
      } catch (error) {
        if (error instanceof GitHubPermissionSafetyError) return { status: 'safety', code: 'permission-response-invalid' };
        return { status: 'retryable', result: { status: 'retryable', owner: 'permission', code: 'permission-read-failed' } };
      }
    }
    if (trusted.length === 0) return { status: 'none' };
    const hashes = Array.from(new Set(trusted.map((candidate) => candidate.hash))).sort();
    if (hashes.length > 1) return { status: 'conflict', hashes };
    const canonical = trusted[0]!;
    return {
      status: 'trusted',
      answer: {
        version: 1, questionId: question.questionId, questionSha256: question.questionSha256,
        commentId: canonical.comment.id, commentUrl: canonical.comment.url,
        authorId: canonical.comment.author.id, author: canonical.comment.author.login,
        permission: canonical.permission, permissionCheckedAt: canonical.checkedAt,
        commentCreatedAt: canonical.comment.createdAt, commentUpdatedAt: canonical.comment.updatedAt,
        observedAt, normalizedAnswer: canonical.normalized, normalizedSha256: canonical.hash,
        duplicateCommentIds: trusted.slice(1).map((candidate) => candidate.comment.id),
      },
    };
  }

  private async revalidateAnswer(issueNumber: number, answer: TrustedAnswerReceiptV1): Promise<'trusted' | 'revoked' | 'retryable'> {
    try {
      const comments = await this.dependencies.issues.listAllComments(issueNumber);
      const comment = comments.find((candidate) => candidate.id === answer.commentId);
      if (!comment || comment.author.id !== answer.authorId || comment.createdAt !== comment.updatedAt
        || hashNormalizedAnswer(normalizeAnswer(comment.body.slice(`Answer ${answer.questionId}:`.length))) !== answer.normalizedSha256) return 'revoked';
      const permission = await this.dependencies.issues.getRepositoryPermission(comment.author.login, answer.authorId);
      return permission.userId === answer.authorId && (permission.permission === 'write' || permission.permission === 'admin') ? 'trusted' : 'revoked';
    } catch {
      return 'retryable';
    }
  }
}

function emptyExecution(): Omit<WaitingHumanExecutionV1, 'phase'> {
  return {
    version: 1,
    clarificationAttempts: 0,
    permissionRetries: 0,
    history: [],
  } as Omit<WaitingHumanExecutionV1, 'phase'>;
}

function receiptFor(question: WaitingQuestionReceiptV1['question'], comment: GitHubIssueComment, observedAt: string): WaitingQuestionReceiptV1 {
  return {
    question: structuredClone(question), commentId: comment.id, commentUrl: comment.url,
    authorId: comment.author.id, author: comment.author.login, createdAt: comment.createdAt, observedAt,
  };
}

function awaitingResult(receipt: WaitingQuestionReceiptV1): WaitingHumanResult {
  return { status: 'awaiting-answer', questionId: receipt.question.questionId, answerPrefix: receipt.question.answerPrefix };
}

function compareDecimal(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/u, '');
  const normalizedRight = right.replace(/^0+(?=\d)/u, '');
  return normalizedLeft.length - normalizedRight.length || normalizedLeft.localeCompare(normalizedRight);
}

function safety(code: string, evidence: string[] = []): WaitingHumanResult {
  return { status: 'blocked', kind: 'safety', resumable: false, code, evidence };
}
