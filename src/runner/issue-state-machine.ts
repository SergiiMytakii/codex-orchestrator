import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';

export type RunnerMode = 'scoped-issue' | 'plan-parent' | 'tree-child';

export type SkipReasonCode =
  | 'manual-label'
  | 'blocked-label'
  | 'conflicting-authorization-labels'
  | 'conflicting-state-labels'
  | 'already-running'
  | 'ready-for-review'
  | 'child-label'
  | 'missing-authorization-label'
  | 'closed';

export type IssueDiscoveryDecision =
  | {
      kind: 'eligible';
      issueNumber: number;
      title: string;
      mode: RunnerMode;
      reason: string;
    }
  | {
      kind: 'skipped';
      issueNumber: number;
      title: string;
      reasonCode: SkipReasonCode;
      reason: string;
    };

export interface ClarificationQuestion {
  question: string;
  blocks: string;
}

export type CodexSessionResult =
  | { status: 'ready' }
  | { status: 'needs-clarification'; questions: ClarificationQuestion[] };

export type CodexSessionActionResult = { action: 'none' } | { action: 'blocked-for-clarification' };

const reasonStrings = {
  eligibleScoped: 'has configured auto label and no blocking state labels',
  eligiblePlan: 'has configured plan-auto label and no blocking state labels',
  manual: 'manual label is present',
  blocked: 'blocked label is present',
  conflictingAuthorization: 'auto and plan-auto labels are both present',
  conflictingState: 'multiple state labels are present',
  running: 'running label is present',
  review: 'review label is present',
  child: 'child label is present; parent plan-auto owns child execution',
  missingAuthorization: 'no configured auto or plan-auto label is present',
  closed: 'issue is closed',
} as const;

export function discoverIssueWork(
  issues: GitHubIssue[],
  config: CodexOrchestratorConfig,
): IssueDiscoveryDecision[] {
  return [...issues]
    .sort((left, right) => left.number - right.number)
    .map((issue) => decideIssueWork(issue, config));
}

export async function claimIssue(
  adapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  issueNumber: number,
  mode: RunnerMode,
  now: Date,
): Promise<void> {
  await adapter.addLabels(issueNumber, [config.github.labels.running.name]);
  await adapter.postComment(
    issueNumber,
    `codex-orchestrator: claimed #${issueNumber} for ${mode} autonomous work at ${now.toISOString()}.`,
  );
}

export async function applyClarificationGate(
  adapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  issueNumber: number,
  questions: ClarificationQuestion[],
  _now: Date,
): Promise<void> {
  validateClarificationQuestions(questions);
  await adapter.removeLabels(issueNumber, [config.github.labels.running.name]);
  await adapter.addLabels(issueNumber, [config.github.labels.blocked.name]);
  await adapter.postComment(issueNumber, formatClarificationComment(issueNumber, questions));
}

export async function applyCodexSessionResult(
  adapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  issueNumber: number,
  result: CodexSessionResult,
  now: Date,
): Promise<CodexSessionActionResult> {
  if (result.status === 'ready') {
    return { action: 'none' };
  }

  await applyClarificationGate(adapter, config, issueNumber, result.questions, now);
  return { action: 'blocked-for-clarification' };
}

export function hasMaintainerResponseAfterLatestClarification(issue: GitHubIssue): boolean {
  const latestClarification = issue.comments
    .filter((comment) => comment.body.startsWith(`codex-orchestrator clarification questions for #${issue.number}`))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  if (!latestClarification) {
    return false;
  }

  const maintainerAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
  return issue.comments.some(
    (comment) =>
      comment.createdAt > latestClarification.createdAt && maintainerAssociations.has(comment.authorAssociation),
  );
}

export async function clearClarificationGate(
  adapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  issueNumber: number,
  now: Date,
): Promise<void> {
  await adapter.removeLabels(issueNumber, [config.github.labels.blocked.name]);
  await adapter.addLabels(issueNumber, [config.github.labels.running.name]);
  await adapter.postComment(
    issueNumber,
    `codex-orchestrator: maintainer clarification detected for #${issueNumber}; resuming at ${now.toISOString()}.`,
  );
}

function decideIssueWork(issue: GitHubIssue, config: CodexOrchestratorConfig): IssueDiscoveryDecision {
  const labels = new Set(issue.labels.map((label) => label.name));
  const auto = config.github.labels.auto.name;
  const planAuto = config.github.labels.planAuto.name;
  const manual = config.github.labels.manual.name;
  const blocked = config.github.labels.blocked.name;
  const running = config.github.labels.running.name;
  const review = config.github.labels.review.name;
  const child = config.github.labels.child.name;
  const authCount = [auto, planAuto].filter((label) => labels.has(label)).length;
  const stateCount = [running, blocked, review].filter((label) => labels.has(label)).length;

  if (stateCount > 1) {
    return skipped(issue, 'conflicting-state-labels', reasonStrings.conflictingState);
  }
  if (authCount > 1) {
    return skipped(issue, 'conflicting-authorization-labels', reasonStrings.conflictingAuthorization);
  }
  if (labels.has(manual)) {
    return skipped(issue, 'manual-label', reasonStrings.manual);
  }
  if (labels.has(blocked)) {
    return skipped(issue, 'blocked-label', reasonStrings.blocked);
  }
  if (labels.has(running)) {
    return skipped(issue, 'already-running', reasonStrings.running);
  }
  if (labels.has(review)) {
    return skipped(issue, 'ready-for-review', reasonStrings.review);
  }
  if (issue.state === 'CLOSED') {
    return skipped(issue, 'closed', reasonStrings.closed);
  }
  if (labels.has(child)) {
    return skipped(issue, 'child-label', reasonStrings.child);
  }
  if (authCount === 0) {
    return skipped(issue, 'missing-authorization-label', reasonStrings.missingAuthorization);
  }
  if (labels.has(auto)) {
    return eligible(issue, 'scoped-issue', reasonStrings.eligibleScoped);
  }
  return eligible(issue, 'plan-parent', reasonStrings.eligiblePlan);
}

function eligible(issue: GitHubIssue, mode: RunnerMode, reason: string): IssueDiscoveryDecision {
  return {
    kind: 'eligible',
    issueNumber: issue.number,
    title: issue.title,
    mode,
    reason,
  };
}

function skipped(issue: GitHubIssue, reasonCode: SkipReasonCode, reason: string): IssueDiscoveryDecision {
  return {
    kind: 'skipped',
    issueNumber: issue.number,
    title: issue.title,
    reasonCode,
    reason,
  };
}

function validateClarificationQuestions(questions: ClarificationQuestion[]): void {
  if (
    questions.length === 0 ||
    questions.some((question) => question.question.trim().length === 0 || question.blocks.trim().length === 0)
  ) {
    throw new Error('needs-clarification requires at least one question with non-empty question and blocks');
  }
}

function formatClarificationComment(issueNumber: number, questions: ClarificationQuestion[]): string {
  return [
    `codex-orchestrator clarification questions for #${issueNumber}`,
    ...questions.map((question, index) => `${index + 1}. ${question.question.trim()} Blocks: ${question.blocks.trim()}`),
  ].join('\n');
}
