import type { PersistedFrozenCriterionV1, PersistedIssueSnapshotV1 } from './run-store.js';
import type { RouteReceiptV1 } from './route-decision.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import type { WaitingHumanResult, WaitingHumanState } from './waiting-human-coordinator.js';

export interface RoutedRunContext {
  runId: string;
  issue: PersistedIssueSnapshotV1;
  frozenCriteria: PersistedFrozenCriterionV1[];
  worktreePath: string;
  workflowGeneration: WorkflowGenerationReceipt;
  receipt: RouteReceiptV1;
}

export type RoutedContinuationResult =
  | { status: 'completed' }
  | { status: 'retryable'; code: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string; evidence: string[] }
  | { status: 'cancelled' };

export interface RoutedContinuationRegistry {
  direct(input: RoutedRunContext): Promise<RoutedContinuationResult>;
  specRequired(input: RoutedRunContext): Promise<RoutedContinuationResult>;
  awaitingUser(input: RoutedRunContext, state: WaitingHumanState, signal: AbortSignal): Promise<WaitingHumanResult>;
}
