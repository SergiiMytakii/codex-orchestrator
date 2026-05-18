import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import { hasIssueClosureEvidence } from '../github/issues.js';
import {
  clearClarificationGate,
  hasMaintainerResponseAfterLatestClarification,
  type RunnerMode,
} from './issue-state-machine.js';
import type { RunnerStateStore } from './local-state.js';

export type RecoveryStatus =
  | 'active'
  | 'stale'
  | 'missing'
  | 'completed'
  | 'closed-missing-evidence'
  | 'waiting-for-clarification'
  | 'clarification-resumable';

export interface RecoveryEntry {
  issueNumber: number;
  mode: RunnerMode;
  status: RecoveryStatus;
  reason: string;
  workspacePath: string;
  sessionId: string;
  retryCount: number;
}

export interface ReconcileRunnerStateInput {
  store: RunnerStateStore;
  issueAdapter: GitHubIssueAdapter;
  config: CodexOrchestratorConfig;
  now: Date;
  allowClarificationResume?: boolean;
  updateLocalState?: boolean;
}

const recoveryReasons: Record<RecoveryStatus, string> = {
  active: 'GitHub still marks the issue running',
  stale: 'local run exists but GitHub no longer marks it running',
  missing: 'local run has no matching GitHub issue',
  completed: 'GitHub marks the work completed',
  'closed-missing-evidence': 'GitHub marks the issue closed without completion evidence',
  'waiting-for-clarification': 'blocked clarification is waiting for maintainer response',
  'clarification-resumable': 'maintainer clarification response detected',
};

export async function reconcileRunnerState(input: ReconcileRunnerStateInput): Promise<RecoveryEntry[]> {
  const allowClarificationResume = input.allowClarificationResume ?? false;
  const updateLocalState = input.updateLocalState ?? true;
  const state = await input.store.load();
  const entries: RecoveryEntry[] = [];

  for (const run of state.runs) {
    const issue = await input.issueAdapter.getIssue(run.issueNumber);
    const status = classifyIssue(issue, input.config);

    if (status === 'clarification-resumable' && allowClarificationResume) {
      await clearClarificationGate(input.issueAdapter, input.config, run.issueNumber, input.now);
    }

    entries.push({
      issueNumber: run.issueNumber,
      mode: run.mode,
      status,
      reason: recoveryReasons[status],
      workspacePath: run.workspacePath,
      sessionId: run.sessionId,
      retryCount: run.retryCount,
    });
  }

  if (updateLocalState) {
    await input.store.save({
      version: 1,
      runs: state.runs.map((run) => ({
        ...run,
        lastRecoveredAt: input.now.toISOString(),
      })),
    });
  }

  return entries.sort((left, right) => left.issueNumber - right.issueNumber);
}

function classifyIssue(issue: GitHubIssue | undefined, config: CodexOrchestratorConfig): RecoveryStatus {
  if (!issue) {
    return 'missing';
  }

  const labels = new Set(issue.labels.map((label) => label.name));
  if (issue.state === 'CLOSED') {
    return hasIssueClosureEvidence(issue) ? 'completed' : 'closed-missing-evidence';
  }
  if (labels.has(config.github.labels.review.name) || issue.closedByPullRequestsReferences.length > 0) {
    return 'completed';
  }
  if (labels.has(config.github.labels.blocked.name)) {
    return hasMaintainerResponseAfterLatestClarification(issue)
      ? 'clarification-resumable'
      : 'waiting-for-clarification';
  }
  if (labels.has(config.github.labels.running.name)) {
    return 'active';
  }
  return 'stale';
}
