import {
  acceptSpecReview, acceptSpecRevision, createInitialSpecDelivery, freezeApprovedSpec,
  launchSpecInvocation, prepareSpecInvocation, recoverMalformedSpecReport, recoverSpecInvocation,
  type FrozenSpecReceiptV1, type SpecDeliveryV1,
  type SpecReviewReportV1, type SpecRevisionV1,
} from './spec-delivery.js';
import type { RoutedRunContext } from './route-continuations.js';

export interface SpecDeliveryState {
  read(): Promise<SpecDeliveryV1 | undefined>;
  compareAndSwap(expected: SpecDeliveryV1 | undefined, next: SpecDeliveryV1): Promise<boolean>;
}

export type SpecOperationResult<T> =
  | { status: 'completed'; value: T; reportSha256?: string }
  | { status: 'retryable'; code: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string }
  | { status: 'cancelled' };

export interface SpecDeliveryOperation {
  author(input: {
    context: RoutedRunContext;
    state: SpecDeliveryV1;
    mode: 'author' | 'repair';
    signal: AbortSignal;
    onPrepared(actor: { attemptId: string; sessionId: string; reportPath?: string; revisionPath?: string }): Promise<void>;
    onLaunched(actor: { attemptId: string; sessionId: string; pid: number; processGroupId: number }): Promise<void>;
  }): Promise<SpecOperationResult<SpecRevisionV1>>;
  review(input: {
    context: RoutedRunContext;
    state: SpecDeliveryV1;
    mode: 'full' | 'closure';
    signal: AbortSignal;
    onPrepared(actor: { attemptId: string; sessionId: string; reportPath?: string }): Promise<void>;
    onLaunched(actor: { attemptId: string; sessionId: string; pid: number; processGroupId: number }): Promise<void>;
  }): Promise<SpecOperationResult<SpecReviewReportV1>>;
  recover(input: { context: RoutedRunContext; state: SpecDeliveryV1; signal: AbortSignal }): Promise<SpecOperationResult<SpecRevisionV1 | SpecReviewReportV1>>;
}

export type SpecCoordinatorResult =
  | { status: 'completed'; receipt: FrozenSpecReceiptV1 }
  | { status: 'retryable'; code: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string; evidence: string[] }
  | { status: 'cancelled' };

export class SpecCoordinator {
  constructor(private readonly dependencies: { state: SpecDeliveryState; operation: SpecDeliveryOperation }) {}

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
      const author: boolean = current.invocation ? current.invocation.purpose === 'author' : current.stage === 'authoring' || current.stage === 'author-repair';
      const mode = current.invocation?.mode ?? (author ? (current.stage === 'authoring' ? 'author' : 'repair') : (current.stage === 'review-full' ? 'full' : 'closure'));
      let active = current;
      const onPrepared = async (actor: { attemptId: string; sessionId: string; reportPath?: string; revisionPath?: string }) => {
        const next = prepareSpecInvocation(active, { purpose: author ? 'author' : 'review', mode, ...actor });
        if (!await this.dependencies.state.compareAndSwap(active, next)) throw new Error('spec prepared state conflict');
        active = next;
      };
      const onLaunched = async (actor: { attemptId: string; sessionId: string; pid: number; processGroupId: number }) => {
        if (active.invocation?.attemptId !== actor.attemptId || active.invocation.sessionId !== actor.sessionId) throw new Error('spec launch actor mismatch');
        const next = launchSpecInvocation(active, actor);
        if (!await this.dependencies.state.compareAndSwap(active, next)) throw new Error('spec launched state conflict');
        active = next;
      };
      const result = current.invocation
        ? await this.dependencies.operation.recover({ context, state: current, signal })
        : author
          ? await this.dependencies.operation.author({ context, state: current, mode: mode as 'author'|'repair', signal, onPrepared, onLaunched })
          : await this.dependencies.operation.review({ context, state: current, mode: mode as 'full'|'closure', signal, onPrepared, onLaunched });
      if (result.status === 'retryable') {
        try {
          const owner = author ? 'author' : 'review';
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
      if (result.status !== 'completed') return result.status === 'blocked' ? { ...result, evidence: [] } : result;
      const next: SpecDeliveryV1 = author
        ? acceptSpecRevision(active, result.value as SpecRevisionV1)
        : acceptSpecReview(active, result.value as SpecReviewReportV1, result.reportSha256 ?? '0'.repeat(64));
      if (!await this.dependencies.state.compareAndSwap(active, next)) return { status: 'retryable', code: 'spec-result-state-conflict' };
      current = next;
    }
  }
}
