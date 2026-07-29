import {
  acceptSpecReview, acceptSpecRevision, createInitialSpecDelivery, freezeApprovedSpec,
  launchSpecInvocation, prepareSpecInvocation, recoverMalformedSpecReport, recoverSpecInvocation, reserveSpecReviewerSession,
  type FrozenSpecReceiptV1, type SpecDeliveryV1,
  type SpecReviewReportV1, type SpecRevisionV1,
} from './spec-delivery.js';
import type { RoutedRunContext } from './route-continuations.js';
import type { DurableReportInvocationState } from './contained-report-operation.js';

export interface SpecDeliveryState {
  read(): Promise<SpecDeliveryV1 | undefined>;
  compareAndSwap(expected: SpecDeliveryV1 | undefined, next: SpecDeliveryV1): Promise<boolean>;
  reviewInvocation(reviewerSessionId: string): DurableReportInvocationState;
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
    context: RoutedRunContext; state: SpecDeliveryV1; mode: 'author' | 'repair'; signal: AbortSignal;
    onPrepared(actor: { attemptId: string; sessionId: string; reportPath?: string; revisionPath?: string }): Promise<void>;
    onLaunched(actor: { attemptId: string; sessionId: string; pid: number; processGroupId: number }): Promise<void>;
  }): Promise<SpecOperationResult<SpecRevisionV1>>;
  review(input: {
    context: RoutedRunContext; state: SpecDeliveryV1; mode: 'full' | 'closure'; reviewerSessionId: string;
    signal: AbortSignal; invocationState: DurableReportInvocationState;
  }): Promise<SpecOperationResult<SpecReviewReportV1>>;
  recover(input: { context: RoutedRunContext; state: SpecDeliveryV1; signal: AbortSignal }): Promise<SpecOperationResult<SpecRevisionV1 | SpecReviewReportV1>>;
}

export type SpecCoordinatorResult =
  | { status: 'completed'; receipt: FrozenSpecReceiptV1 }
  | { status: 'retryable'; code: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string; evidence: string[] }
  | { status: 'cancelled' };

export class SpecCoordinator {
  constructor(private readonly dependencies: { state: SpecDeliveryState; operation: SpecDeliveryOperation; createReviewerSessionId(): string }) {}

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
      const author = current.invocation !== undefined || current.stage === 'authoring' || current.stage === 'author-repair';
      const mode = current.invocation?.mode ?? (author ? (current.stage === 'authoring' ? 'author' : 'repair')
        : (current.stage === 'review-full' ? 'full' : 'closure'));
      let active = current;
      const onPrepared = async (actor: { attemptId: string; sessionId: string; reportPath?: string; revisionPath?: string }) => {
        if (!author) throw new Error('spec review mechanics are canonical');
        const next = prepareSpecInvocation(active, { mode: mode as 'author' | 'repair', ...actor });
        if (!await this.dependencies.state.compareAndSwap(active, next)) throw new Error('spec prepared state conflict');
        active = next;
      };
      const onLaunched = async (actor: { attemptId: string; sessionId: string; pid: number; processGroupId: number }) => {
        if (active.invocation?.attemptId !== actor.attemptId || active.invocation.sessionId !== actor.sessionId) throw new Error('spec launch actor mismatch');
        const next = launchSpecInvocation(active, actor);
        if (!await this.dependencies.state.compareAndSwap(active, next)) throw new Error('spec launched state conflict');
        active = next;
      };
      const reviewerSessionId = author ? undefined : current.review.reviewerSessionId ?? this.dependencies.createReviewerSessionId();
      const reviewState = author ? undefined : reserveSpecReviewerSession(current, reviewerSessionId!);
      const result = current.invocation
        ? await this.dependencies.operation.recover({ context, state: current, signal })
        : author
          ? await this.dependencies.operation.author({ context, state: current, mode: mode as 'author'|'repair', signal, onPrepared, onLaunched })
          : await this.dependencies.operation.review({ context, state: reviewState!, mode: mode as 'full'|'closure', reviewerSessionId: reviewerSessionId!,
            signal, invocationState: this.dependencies.state.reviewInvocation(reviewerSessionId!) });
      if (result.status === 'retryable') {
        try {
          if (!author) return result;
          const owner = 'author';
          const recovered = result.code.includes('report-invalid')
            ? recoverMalformedSpecReport(active, owner)
            : recoverSpecInvocation(active, { attemptId: active.invocation!.attemptId, processGroupAbsent: true });
          if (!await this.dependencies.state.compareAndSwap(active, recovered)) return { status: 'retryable', code: 'spec-recovery-state-conflict' };
          current = recovered;
          continue;
        } catch {
          const exhausted: SpecDeliveryV1 = { ...structuredClone(active), stage: 'exhausted' };
          delete exhausted.invocation;
          if (!await this.dependencies.state.compareAndSwap(active, exhausted)) return { status: 'retryable', code: 'spec-exhaustion-state-conflict' };
          return { status: 'blocked', kind: 'exhausted', code: 'spec-retry-budget-exhausted', evidence: [] };
        }
      }
      if (result.status === 'invalid') {
        try {
          const refreshed = await this.dependencies.state.read();
          if (!refreshed) return { status: 'retryable', code: 'spec-review-state-missing' };
          active = refreshed;
          const recovered = recoverMalformedSpecReport(active, 'review');
          if (!await this.dependencies.state.settleReview(active, recovered, result.attemptId)) return { status: 'retryable', code: 'spec-recovery-state-conflict' };
          current = recovered;
          continue;
        } catch {
          return { status: 'blocked', kind: 'exhausted', code: 'spec-retry-budget-exhausted', evidence: [] };
        }
      }
      if (result.status !== 'completed') return result.status === 'blocked' ? { ...result, evidence: [] } : result;
      if (!author) {
        const refreshed = await this.dependencies.state.read();
        if (!refreshed) return { status: 'retryable', code: 'spec-review-state-missing' };
        active = refreshed;
      }
      const next: SpecDeliveryV1 = author
        ? acceptSpecRevision(active, result.value as SpecRevisionV1)
        : acceptSpecReview(active, result.value as SpecReviewReportV1, result.reportSha256 ?? '0'.repeat(64));
      const saved = author
        ? await this.dependencies.state.compareAndSwap(active, next)
        : await this.dependencies.state.settleReview(active, next, (result.value as SpecReviewReportV1).reviewer.attemptId);
      if (!saved) return { status: 'retryable', code: 'spec-result-state-conflict' };
      current = next;
    }
  }
}
