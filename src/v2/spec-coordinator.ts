import {
  acceptSpecReview, acceptSpecRevision, createInitialSpecDelivery, freezeApprovedSpec,
  recoverMalformedSpecReport, reserveSpecAuthorSession, reserveSpecReviewerSession,
  type FrozenSpecReceiptV1, type SpecDeliveryV1,
  type SpecReviewReportV1, type SpecRevisionV1,
} from './spec-delivery.js';
import type { RoutedRunContext } from './route-continuations.js';
import type { DurableReportInvocationState } from './contained-report-operation.js';

export interface SpecDeliveryState {
  read(): Promise<SpecDeliveryV1 | undefined>;
  compareAndSwap(expected: SpecDeliveryV1 | undefined, next: SpecDeliveryV1): Promise<boolean>;
  authorInvocation(authorSessionId: string): DurableReportInvocationState;
  reviewInvocation(reviewerSessionId: string): DurableReportInvocationState;
  settleAuthor(expected: SpecDeliveryV1, next: SpecDeliveryV1, attemptId: string): Promise<boolean>;
  settleReview(expected: SpecDeliveryV1, next: SpecDeliveryV1, attemptId: string): Promise<boolean>;
}

export type SpecOperationResult<T> =
  | { status: 'completed'; value: T; reportSha256?: string }
  | { status: 'invalid'; code: string; attemptId: string }
  | { status: 'retryable'; code: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string }
  | { status: 'cancelled' };

export interface SpecDeliveryOperation {
  author(input: {
    context: RoutedRunContext; state: SpecDeliveryV1; mode: 'author' | 'repair'; authorSessionId: string;
    signal: AbortSignal; invocationState: DurableReportInvocationState;
  }): Promise<SpecOperationResult<SpecRevisionV1>>;
  review(input: {
    context: RoutedRunContext; state: SpecDeliveryV1; mode: 'full' | 'closure'; reviewerSessionId: string;
    signal: AbortSignal; invocationState: DurableReportInvocationState;
  }): Promise<SpecOperationResult<SpecReviewReportV1>>;
}

export type SpecCoordinatorResult =
  | { status: 'completed'; receipt: FrozenSpecReceiptV1 }
  | { status: 'retryable'; code: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string; evidence: string[] }
  | { status: 'cancelled' };

type InvalidSettlement =
  | { status: 'continued'; state: SpecDeliveryV1 }
  | { status: 'returned'; result: SpecCoordinatorResult };

export class SpecCoordinator {
  constructor(private readonly dependencies: { state: SpecDeliveryState; operation: SpecDeliveryOperation;
    createAuthorSessionId(): string; createReviewerSessionId(): string }) {}

  async run(context: RoutedRunContext, signal: AbortSignal): Promise<SpecCoordinatorResult> {
    const observed = await this.dependencies.state.read();
    let current: SpecDeliveryV1;
    if (!observed) {
      const initial = createInitialSpecDelivery({
        issueNumber: context.issue.number, runId: context.runId,
        workflowGenerationSha256: context.workflowGeneration.generationHash,
      });
      if (!await this.dependencies.state.compareAndSwap(undefined, initial)) return { status: 'retryable', code: 'spec-state-conflict' };
      current = initial;
    } else current = observed;
    while (true) {
      if (signal.aborted) return { status: 'cancelled' };
      if (current.stage === 'frozen') return { status: 'completed', receipt: current.frozen! };
      if (current.stage === 'rejected' || current.stage === 'exhausted') {
        return { status: 'blocked', kind: current.stage === 'rejected' ? 'safety' : 'exhausted', code: `spec-${current.stage}`, evidence: [] };
      }
      if (current.stage === 'approved') {
        const frozen = freezeApprovedSpec(current);
        if (!await this.dependencies.state.compareAndSwap(current, frozen)) return { status: 'retryable', code: 'spec-freeze-state-conflict' };
        current = frozen;
        continue;
      }
      const author = current.stage === 'authoring' || current.stage === 'author-repair';
      const mode = author ? (current.stage === 'authoring' ? 'author' : 'repair')
        : (current.stage === 'review-full' ? 'full' : 'closure');
      let active = current;
      const authorSessionId = author ? current.authorSessionId ?? this.dependencies.createAuthorSessionId() : undefined;
      const reviewerSessionId = author ? undefined : current.review.reviewerSessionId ?? this.dependencies.createReviewerSessionId();
      const reviewState = author ? undefined : reserveSpecReviewerSession(current, reviewerSessionId!);
      const authorState = author ? reserveSpecAuthorSession(current, authorSessionId!) : undefined;
      const result = author
          ? await this.dependencies.operation.author({ context, state: authorState!, mode: mode as 'author'|'repair', authorSessionId: authorSessionId!,
            signal, invocationState: this.dependencies.state.authorInvocation(authorSessionId!) })
          : await this.dependencies.operation.review({ context, state: reviewState!, mode: mode as 'full'|'closure', reviewerSessionId: reviewerSessionId!,
            signal, invocationState: this.dependencies.state.reviewInvocation(reviewerSessionId!) });
      if (result.status === 'retryable') {
        return result;
      }
      if (result.status === 'invalid') {
        const settlement = await this.settleInvalid(author ? 'author' : 'review', result.attemptId);
        if (settlement.status === 'returned') return settlement.result;
        current = settlement.state;
        continue;
      }
      if (result.status !== 'completed') return result.status === 'blocked' ? { ...result, evidence: [] } : result;
      const refreshed = await this.dependencies.state.read();
      if (!refreshed) return { status: 'retryable', code: 'spec-state-missing' };
      active = refreshed;
      const attemptId = author
        ? (result.value as SpecRevisionV1).author.attemptId
        : (result.value as SpecReviewReportV1).reviewer.attemptId;
      let next: SpecDeliveryV1;
      try {
        next = author
          ? acceptSpecRevision(active, result.value as SpecRevisionV1)
          : acceptSpecReview(active, result.value as SpecReviewReportV1, result.reportSha256 ?? '0'.repeat(64));
      } catch {
        const settlement = await this.settleInvalid(author ? 'author' : 'review', attemptId);
        if (settlement.status === 'returned') return settlement.result;
        current = settlement.state;
        continue;
      }
      let saved: boolean;
      try {
        saved = author
          ? await this.dependencies.state.settleAuthor(active, next, attemptId)
          : await this.dependencies.state.settleReview(active, next, attemptId);
      } catch { return { status: 'retryable', code: 'spec-result-state-conflict' }; }
      if (!saved) return { status: 'retryable', code: 'spec-result-state-conflict' };
      current = next;
    }
  }

  private async settleInvalid(owner: 'author' | 'review', attemptId: string): Promise<InvalidSettlement> {
    const active = await this.dependencies.state.read();
    if (!active) return { status: 'returned', result: { status: 'retryable', code: 'spec-state-missing' } };
    let next: SpecDeliveryV1;
    let exhausted = false;
    try { next = recoverMalformedSpecReport(active, owner); }
    catch { next = { ...structuredClone(active), stage: 'exhausted' }; exhausted = true; }
    let settled: boolean;
    try {
      settled = owner === 'author'
        ? await this.dependencies.state.settleAuthor(active, next, attemptId)
        : await this.dependencies.state.settleReview(active, next, attemptId);
    } catch {
      return { status: 'returned', result: { status: 'retryable', code: exhausted
        ? 'spec-exhaustion-state-conflict' : 'spec-recovery-state-conflict' } };
    }
    if (!settled) return { status: 'returned', result: { status: 'retryable', code: exhausted
      ? 'spec-exhaustion-state-conflict' : 'spec-recovery-state-conflict' } };
    return exhausted
      ? { status: 'returned', result: { status: 'blocked', kind: 'exhausted', code: 'spec-retry-budget-exhausted', evidence: [] } }
      : { status: 'continued', state: next };
  }
}
