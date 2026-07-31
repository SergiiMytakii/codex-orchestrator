import { canonicalJson, sha256 } from './containment.js';
import {
  acceptSpecReview, acceptSpecRevision, createInitialSpecDelivery, freezeApprovedSpec, freezeSpecQuestion,
  consumeSpecTransportRetry, recoverMalformedSpecReport,
  type FrozenSpecQuestionReceiptV1, type FrozenSpecReceiptV1, type SpecDecisionGapV1, type SpecDeliveryV1,
  type SpecReviewReportV1, type SpecRevisionV1,
} from './spec-delivery.js';
import type { RoutedRunContext } from './route-continuations.js';

export interface SpecDeliveryState {
  read(): Promise<SpecDeliveryV1 | undefined>;
  compareAndSwap(expected: SpecDeliveryV1 | undefined, next: SpecDeliveryV1): Promise<boolean>;
  prepareAttempt(operationId: 'spec-author' | 'spec-review', sourceId: string): Promise<{ attemptId: string; recoverOnly: boolean }>;
  launchAttempt(attemptId: string, pid: number, processGroupId: number): Promise<void>;
  adopt(expected: SpecDeliveryV1, next: SpecDeliveryV1, resultSha256: string): Promise<boolean>;
  clearAttempt(): Promise<void>;
  revalidateBeforeAttempt(state: SpecDeliveryV1): Promise<
    { status: 'valid' } | { status: 'frozen'; receipt: FrozenSpecQuestionReceiptV1; evidencePath: string }
  >;
}

export type SpecOperationResult<T> =
  | { status: 'completed'; value: T; attemptResultSha256: string; reportSha256?: string }
  | { status: 'decision-required'; value: SpecRevisionV1; decisionGaps: SpecDecisionGapV1[]; question: string; attemptResultSha256: string }
  | { status: 'retryable'; code: string }
  | { status: 'safe-halt' }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string }
  | { status: 'cancelled' };

export interface SpecDeliveryOperation {
  author(input: {
    attemptId: string;
    context: RoutedRunContext;
    state: SpecDeliveryV1;
    mode: 'author' | 'repair';
    recoverOnly: boolean;
    signal: AbortSignal;
    onPrepared(actor: { attemptId: string; sessionId: string; reportPath?: string; revisionPath?: string }): Promise<void>;
    onLaunched(actor: { attemptId: string; sessionId: string; pid: number; processGroupId: number }): Promise<void>;
  }): Promise<SpecOperationResult<SpecRevisionV1>>;
  review(input: {
    attemptId: string;
    context: RoutedRunContext;
    state: SpecDeliveryV1;
    recoverOnly: boolean;
    signal: AbortSignal;
    onPrepared(actor: { attemptId: string; sessionId: string; reportPath?: string }): Promise<void>;
    onLaunched(actor: { attemptId: string; sessionId: string; pid: number; processGroupId: number }): Promise<void>;
  }): Promise<SpecOperationResult<SpecReviewReportV1>>;
}

export type SpecCoordinatorResult =
  | { status: 'completed'; receipt: FrozenSpecReceiptV1 }
  | { status: 'decision-required'; receipt: FrozenSpecQuestionReceiptV1; evidencePath?: string }
  | { status: 'retryable'; code: string }
  | { status: 'safe-halt' }
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
      if (current.stage === 'question') return { status: 'decision-required', receipt: current.question! };
      if (current.stage === 'rejected' || current.stage === 'exhausted') {
        return { status: 'blocked', kind: current.stage === 'rejected' ? 'safety' : 'exhausted', code: `spec-${current.stage}`, evidence: [] };
      }
      if (current.stage === 'approved') {
        const frozen = freezeApprovedSpec(current);
        if (!await this.dependencies.state.compareAndSwap(current, frozen)) return { status: 'retryable', code: 'spec-freeze-state-conflict' };
        current = frozen;
        continue;
      }
      const author = current.stage === 'authoring' || current.stage === 'author-repair' || current.stage === 'answer-authoring';
      const mode = author ? (current.stage === 'author-repair' ? 'repair' : 'author') : 'review';
      const revalidated = await this.dependencies.state.revalidateBeforeAttempt(current);
      if (revalidated.status === 'frozen') return {
        status: 'decision-required', receipt: revalidated.receipt, evidencePath: revalidated.evidencePath,
      };
      const attempt = await this.dependencies.state.prepareAttempt(
        author ? 'spec-author' : 'spec-review',
        `${mode}:${current.revisions.length + 1}:${current.budgets.repairCycles}`,
      );
      const { attemptId, recoverOnly } = attempt;
      let preparedActor: { attemptId: string; sessionId: string } | undefined;
      const onPrepared = async (actor: { attemptId: string; sessionId: string; reportPath?: string; revisionPath?: string }) => {
        if (preparedActor) throw new Error('spec attempt was prepared twice');
        if (actor.attemptId !== attemptId) throw new Error('spec prepared attempt mismatch');
        preparedActor = { attemptId: actor.attemptId, sessionId: actor.sessionId };
      };
      const onLaunched = async (actor: { attemptId: string; sessionId: string; pid: number; processGroupId: number }) => {
        if (preparedActor?.attemptId !== actor.attemptId || preparedActor.sessionId !== actor.sessionId) throw new Error('spec launch actor mismatch');
        await this.dependencies.state.launchAttempt(actor.attemptId, actor.pid, actor.processGroupId);
      };
      const result = author
        ? await this.dependencies.operation.author({ attemptId, context, state: current, mode: mode as 'author'|'repair', recoverOnly, signal, onPrepared, onLaunched })
        : await this.dependencies.operation.review({ attemptId, context, state: current, recoverOnly, signal, onPrepared, onLaunched });
      if (result.status === 'safe-halt') return result;
      if (result.status === 'retryable') {
        try {
          const owner = author ? 'author' : 'review';
          const recovered = result.code.includes('report-invalid')
            ? recoverMalformedSpecReport(current, owner)
            : consumeSpecTransportRetry(current, owner);
          if (!await this.dependencies.state.adopt(current, recovered, sha256(canonicalJson(result)))) return { status: 'retryable', code: 'spec-recovery-state-conflict' };
          await this.dependencies.state.clearAttempt();
          current = recovered;
          continue;
        } catch {
          const exhausted: SpecDeliveryV1 = { ...structuredClone(current), stage: 'exhausted' };
          if (!await this.dependencies.state.adopt(current, exhausted, sha256(canonicalJson(result)))) return { status: 'retryable', code: 'spec-exhaustion-state-conflict' };
          await this.dependencies.state.clearAttempt();
          return { status: 'blocked', kind: 'exhausted', code: 'spec-retry-budget-exhausted', evidence: [] };
        }
      }
      if (result.status === 'decision-required') {
        const next = freezeSpecQuestion(current, result.value, result.decisionGaps, result.question);
        if (!await this.dependencies.state.adopt(current, next, result.attemptResultSha256)) return { status: 'retryable', code: 'spec-question-state-conflict' };
        await this.dependencies.state.clearAttempt();
        return { status: 'decision-required', receipt: next.question! };
      }
      if (result.status !== 'completed') return result.status === 'blocked' ? { ...result, evidence: [] } : result;
      const next: SpecDeliveryV1 = author
        ? acceptSpecRevision(current, result.value as SpecRevisionV1)
        : acceptSpecReview(current, result.value as SpecReviewReportV1, result.reportSha256 ?? '0'.repeat(64));
      if (!await this.dependencies.state.adopt(current, next, result.attemptResultSha256)) return { status: 'retryable', code: 'spec-result-state-conflict' };
      await this.dependencies.state.clearAttempt();
      current = next;
    }
  }
}
