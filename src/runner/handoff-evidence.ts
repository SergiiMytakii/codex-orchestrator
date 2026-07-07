import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { GitHubPullRequest } from '../github/pull-requests.js';
import type { SessionCommitInfo } from '../git/worktree.js';
import type { AutonomousChildNode } from './issue-tree.js';
import type { PlanAutoCompletionReport, ScopedCompletionReport, ValidationItem } from './completion-report.js';
import type { DurableRunSummaryEvidence, ReworkAttemptEvidence } from './durable-run-summary.js';
import type { AcceptanceProofAttemptEvidence } from './acceptance-proof-runner.js';
import type { PublishabilityRepairAttempt } from './local-execution-session.js';

export type RunnerValidationLine = ValidationItem;

type CommitEvidence = Pick<SessionCommitInfo, 'sha' | 'subject'>;
type ReviewHandoffEvidence = ScopedCompletionReport['reviewHandoff'];
type PlanSizeRiskEvidence = PlanAutoCompletionReport['sizeRisk'];
type ParentReviewHandoffEvidence = PlanAutoCompletionReport['parentReviewHandoff'];

export interface FreshContextReviewEvidence {
  status: 'passed' | 'blocked';
  findings: string[];
  residualRisks: string[];
  logPath: string;
  snapshotPath?: string;
}

export interface ScopedHandoffEvidence {
  config: CodexOrchestratorConfig;
  branchName: string;
  issueNumber: number;
  changedFiles: string[];
  validation: RunnerValidationLine[];
  artifacts: ScopedCompletionReport['artifacts'];
  skippedChecks: string[];
  residualRisks: string[];
  logPath: string;
  commits: CommitEvidence[];
  reviewHandoff?: ReviewHandoffEvidence;
  freshContextReview?: FreshContextReviewEvidence;
  durableRunSummary?: DurableRunSummaryEvidence;
  acceptanceProof?: AcceptanceProofAttemptEvidence;
  repairAttempts?: PublishabilityRepairAttempt[];
}

export interface ChildHandoffEvidence {
  child: AutonomousChildNode;
  branchName: string;
  changedFiles: string[];
  validation: RunnerValidationLine[];
  artifacts: ScopedCompletionReport['artifacts'];
  commits: CommitEvidence[];
  skippedChecks: string[];
  residualRisks: string[];
  logPath: string;
  reviewHandoff?: ReviewHandoffEvidence;
  freshContextReview?: FreshContextReviewEvidence;
  durableRunSummary?: DurableRunSummaryEvidence;
  acceptanceProof?: AcceptanceProofAttemptEvidence;
  repairAttempts?: PublishabilityRepairAttempt[];
  recovered?: boolean;
}

export function buildScopedReviewReport(
  input: ScopedHandoffEvidence & { pullRequest?: GitHubPullRequest; pullRequestUrl?: string },
): string {
  return [
    `codex-orchestrator review report for #${input.issueNumber}: review-ready`,
    'Outcome',
    `- PR: ${input.pullRequestUrl ?? input.pullRequest?.url ?? 'none'}`,
    `- Risk: ${input.reviewHandoff?.riskLevel ?? 'unknown'}`,
    `- Acceptance Proof: ${formatAcceptanceProofDigest(input.acceptanceProof)}`,
    `- Changed files: ${input.changedFiles.length}`,
    'What changed',
    ...renderHumanDigestList(input.reviewHandoff?.implementedContract ?? summarizeChangedFiles(input.changedFiles)),
    'Proof',
    ...renderValidationDigest(input.validation),
    ...renderKeyScopedProofArtifacts(input),
    ...renderRepairAttemptDigest(input.repairAttempts),
    ...renderKeyAcceptanceProofArtifacts(input.acceptanceProof),
    ...renderFreshContextReviewDigest(input.freshContextReview),
    'Review focus',
    ...renderHumanDigestList([
      ...(input.reviewHandoff?.reviewFocus ?? []),
      ...(input.reviewHandoff?.humanReviewChecklist ?? []),
    ]),
    'Audit trail',
    ...renderAuditTrail(input),
  ].join('\n');
}

export function buildScopedPullRequestBody(input: ScopedHandoffEvidence): string {
  return [
    `Closes #${input.issueNumber}`,
    '',
    'Changed files:',
    ...bulletList(input.changedFiles),
    '',
    'Validation:',
    ...renderValidationEvidence(input.validation),
    '',
    'Proof artifacts:',
    ...renderScopedProofArtifacts(input),
    ...renderRepairAttemptEvidence(input.repairAttempts),
    ...renderAcceptanceProofEvidence(input.acceptanceProof),
    '',
    'Log:',
    ...bulletList([input.logPath]),
    '',
    'Local commits:',
    ...renderCommitEvidence(input.commits),
    '',
    ...renderReviewHandoffPullRequestSection(input.reviewHandoff),
    ...renderFreshContextReviewPullRequestSection(input.freshContextReview),
    ...renderDurableRunSummaryPullRequestSection(input.durableRunSummary),
    'Skipped checks:',
    ...bulletList(input.skippedChecks),
    '',
    'Residual risks:',
    ...bulletList(input.residualRisks),
  ].join('\n');
}

export function buildScopedBlockedReport(input: {
  issueNumber: number;
  reasons: string[];
  changedFiles: string[];
  logPath: string;
  skippedChecks: string[];
  residualRisks: string[];
  freshContextReview?: FreshContextReviewEvidence;
  durableRunSummary?: DurableRunSummaryEvidence;
  reworkAttempts?: ReworkAttemptEvidence[];
  repairAttempts?: PublishabilityRepairAttempt[];
  acceptanceProof?: AcceptanceProofAttemptEvidence;
}): string {
  return [
    `codex-orchestrator blocked scoped execution for #${input.issueNumber}`,
    'Reasons',
    ...bulletList(input.reasons),
    'Changed Files',
    ...bulletList(input.changedFiles),
    'Log',
    ...bulletList([input.logPath]),
    ...renderFreshContextReviewEvidence(input.freshContextReview),
    ...renderRepairAttemptEvidence(input.repairAttempts),
    ...renderReworkAttemptEvidence(input.reworkAttempts),
    ...renderDurableRunSummaryEvidence(input.durableRunSummary),
    ...renderAcceptanceProofEvidence(input.acceptanceProof),
    'Skipped Checks',
    ...bulletList(input.skippedChecks),
    'Residual Risks',
    ...bulletList(input.residualRisks),
  ].join('\n');
}

function renderDurableRunSummaryEvidence(evidence: DurableRunSummaryEvidence | undefined): string[] {
  if (!evidence) {
    return [];
  }
  return [
    'Durable Run Summary',
    `- ${evidence.path}`,
    ...evidence.excerpt.map((line) => `- ${line}`),
  ];
}

function renderReworkAttemptEvidence(attempts: ReworkAttemptEvidence[] | undefined): string[] {
  if (!attempts || attempts.length === 0) {
    return [];
  }
  if (!attempts.some((attempt) => attempt.attempt > 0 || attempt.decisionKind !== 'hard-block')) {
    return [];
  }
  return [
    'Rework Attempts',
    ...attempts.map((attempt) => [
      `- attempt ${attempt.attempt}: ${attempt.decisionKind}${typeof attempt.maxAttempts === 'number' ? `/${attempt.maxAttempts}` : ''}`,
      `  prompt: ${attempt.promptPath}`,
      `  report: ${attempt.reportPath}`,
      `  log: ${attempt.logPath}`,
      ...(attempt.snapshotPath ? [`  snapshot: ${attempt.snapshotPath}`] : []),
      ...attempt.reasons.map((reason) => `  reason: ${reason}`),
    ].join('\n')),
  ];
}

function renderRepairAttemptEvidence(attempts: PublishabilityRepairAttempt[] | undefined): string[] {
  if (!attempts || attempts.length === 0) {
    return [];
  }
  return [
    'Repair Attempts',
    ...attempts.map((attempt) => [
      `- ${attempt.kind}: ${attempt.status} - ${attempt.reason}`,
      `  prompt: ${attempt.promptPath}`,
      `  report: ${attempt.reportPath}`,
      `  log: ${attempt.logPath}`,
      ...(attempt.blockers && attempt.blockers.length > 0
        ? [`  blocker keys: ${[...new Set(attempt.blockers.map((blocker) => blocker.key))].join(', ')}`]
        : []),
    ].join('\n')),
  ];
}

function renderDurableRunSummaryPullRequestSection(evidence: DurableRunSummaryEvidence | undefined): string[] {
  if (!evidence) {
    return [];
  }
  return [
    'Durable Run Summary:',
    `- ${evidence.path}`,
    ...evidence.excerpt.map((line) => `- ${line}`),
    '',
  ];
}

function renderAcceptanceProofEvidence(evidence: AcceptanceProofAttemptEvidence | undefined): string[] {
  if (!evidence) {
    return [];
  }
  return [
    'Acceptance Proof',
    `- status: ${evidence.status}`,
    ...(evidence.promptPath ? [`- prompt: ${evidence.promptPath}`] : []),
    `- report: ${evidence.reportPath}`,
    `- artifact dir: ${evidence.artifactDir}`,
    'Acceptance Proof Artifacts',
    ...bulletList(evidence.artifactPaths),
    'Acceptance Proof Validation',
    ...renderValidationEvidence(evidence.validation),
    'Acceptance Proof Blockers',
    ...bulletList(evidence.blockers),
  ];
}

function renderFreshContextReviewEvidence(evidence: FreshContextReviewEvidence | undefined): string[] {
  if (!evidence) {
    return [];
  }
  return [
    'Fresh-Context Review',
    `- status: ${evidence.status}`,
    ...bulletList(evidence.findings),
    'Fresh-Context Review Residual Risks',
    ...bulletList(evidence.residualRisks),
    'Fresh-Context Review Log',
    ...bulletList([evidence.logPath]),
    'Fresh-Context Review Snapshot',
    ...bulletList(evidence.snapshotPath ? [evidence.snapshotPath] : []),
  ];
}

function renderFreshContextReviewPullRequestSection(evidence: FreshContextReviewEvidence | undefined): string[] {
  if (!evidence) {
    return [];
  }
  return [
    'Fresh-Context Review:',
    `- status: ${evidence.status}`,
    ...bulletList(evidence.findings),
    ...(evidence.snapshotPath ? [`- snapshot: ${evidence.snapshotPath}`] : []),
    '',
  ];
}

function formatAcceptanceProofDigest(evidence: AcceptanceProofAttemptEvidence | undefined): string {
  if (!evidence) {
    return 'not required or satisfied by validation';
  }
  const blockerText = evidence.blockers.length > 0 ? `, ${evidence.blockers.length} blocker(s)` : '';
  const artifactText = evidence.artifactPaths.length > 0 ? `, ${evidence.artifactPaths.length} artifact(s)` : '';
  return `${evidence.status}${artifactText}${blockerText}`;
}

function summarizeChangedFiles(changedFiles: string[]): string[] {
  if (changedFiles.length === 0) {
    return [];
  }
  return [`Changed ${changedFiles.length} file(s); inspect the PR diff for the full file list.`];
}

function renderHumanDigestList(items: string[], limit = 5): string[] {
  if (items.length === 0) {
    return ['- none'];
  }
  const visible = items.slice(0, limit).map((item) => `- ${item}`);
  const hiddenCount = items.length - visible.length;
  return hiddenCount > 0 ? [...visible, `- ${hiddenCount} more item(s) in the full run artifacts.`] : visible;
}

function renderValidationDigest(validation: RunnerValidationLine[]): string[] {
  if (validation.length === 0) {
    return ['- Validation: none reported'];
  }
  return (['failed', 'passed', 'skipped'] as const)
    .flatMap((status) => {
      const commands = validation.filter((line) => line.status === status).map((line) => line.command);
      return commands.length > 0 ? [`- ${status}: ${formatDigestCommandList(commands)}`] : [];
    });
}

function formatDigestCommandList(commands: string[], limit = 5): string {
  const visible = commands.slice(0, limit).map((command) => truncateInline(command, 96));
  const hiddenCount = commands.length - visible.length;
  return hiddenCount > 0 ? `${visible.join(', ')} (${hiddenCount} more)` : visible.join(', ');
}

function truncateInline(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function renderKeyScopedProofArtifacts(input: {
  config: CodexOrchestratorConfig;
  branchName: string;
  artifacts: ScopedCompletionReport['artifacts'];
}): string[] {
  if (input.artifacts.length === 0) {
    return [];
  }
  const rendered = renderScopedProofArtifacts(input);
  const visible = rendered.slice(0, 5);
  const hiddenCount = rendered.length - visible.length;
  return hiddenCount > 0 ? [...visible, `- ${hiddenCount} more proof artifact(s) in the full run artifacts.`] : visible;
}

function renderKeyAcceptanceProofArtifacts(evidence: AcceptanceProofAttemptEvidence | undefined): string[] {
  if (!evidence) {
    return [];
  }
  const lines = [
    `- Acceptance proof report: ${evidence.reportPath}`,
    `- Acceptance proof artifact dir: ${evidence.artifactDir}`,
    ...evidence.artifactPaths.slice(0, 5).map((path) => `- Acceptance proof artifact: ${path}`),
  ];
  const hiddenCount = evidence.artifactPaths.length - Math.min(evidence.artifactPaths.length, 5);
  return hiddenCount > 0 ? [...lines, `- ${hiddenCount} more acceptance proof artifact(s) in the full report.`] : lines;
}

function renderFreshContextReviewDigest(evidence: FreshContextReviewEvidence | undefined): string[] {
  if (!evidence) {
    return [];
  }
  return [
    `- Fresh-Context Review: ${evidence.status}`,
    ...evidence.findings.slice(0, 3).map((finding) => `- Fresh-Context finding: ${finding}`),
  ];
}

function renderRepairAttemptDigest(attempts: PublishabilityRepairAttempt[] | undefined): string[] {
  if (!attempts || attempts.length === 0) {
    return [];
  }
  return attempts.map((attempt) => `- Repair ${attempt.kind}: ${attempt.status} (${attempt.reportPath})`);
}

function renderAuditTrail(input: ScopedHandoffEvidence): string[] {
  const lines = [
    `- Log: ${input.logPath}`,
    ...(input.repairAttempts && input.repairAttempts.length > 0
      ? [`- Repair attempts: ${input.repairAttempts.map((attempt) => `${attempt.kind}:${attempt.status}`).join('; ')}`]
      : []),
    ...(input.durableRunSummary ? [`- Durable Run Summary: ${input.durableRunSummary.path}`] : []),
    `- Local Commits: ${formatCommitEvidenceInline(input.commits)}`,
    ...(input.skippedChecks.length > 0 ? [`- Skipped checks: ${input.skippedChecks.join('; ')}`] : []),
    ...(input.residualRisks.length > 0 ? [`- Residual risks: ${input.residualRisks.join('; ')}`] : []),
  ];
  return lines;
}

function formatCommitEvidenceInline(commits: CommitEvidence[]): string {
  if (commits.length === 0) {
    return 'none';
  }
  return commits.map((commit) => `${commit.sha.slice(0, 12)} ${commit.subject}`).join('; ');
}

function renderReviewHandoff(handoff: ReviewHandoffEvidence | undefined): string[] {
  if (!handoff) {
    return [];
  }
  return [
    'Review Handoff',
    `- flow: ${handoff.flowUsed}`,
    `- risk: ${handoff.riskLevel}`,
    'Implemented Contract',
    ...bulletList(handoff.implementedContract),
    'Proof By Acceptance Criteria',
    ...bulletList(handoff.proofByAcceptanceCriteria),
    'Review Focus',
    ...bulletList(handoff.reviewFocus),
    'Human Review Checklist',
    ...bulletList(handoff.humanReviewChecklist),
  ];
}

function renderReviewHandoffPullRequestSection(handoff: ReviewHandoffEvidence | undefined): string[] {
  if (!handoff) {
    return [];
  }
  return [
    'Review handoff:',
    `- flow: ${handoff.flowUsed}`,
    `- risk: ${handoff.riskLevel}`,
    ...handoff.reviewFocus.map((item) => `- review focus: ${item}`),
    ...handoff.humanReviewChecklist.map((item) => `- human check: ${item}`),
    '',
  ];
}

export function buildPromotionRequestReport(input: {
  issueNumber: number;
  report: ScopedCompletionReport;
  durableRunSummary?: DurableRunSummaryEvidence;
}): string {
  const promotion = input.report.promotion;
  if (!promotion) {
    throw new Error('promotion is required for needs-promotion');
  }
  return [
    `codex-orchestrator promotion requested for #${input.issueNumber}`,
    `Reason: ${promotion.reason}`,
    'Criteria',
    ...bulletList(promotion.criteria),
    'Evidence',
    ...bulletList(promotion.evidence),
    ...renderDurableRunSummaryEvidence(input.durableRunSummary),
    'Review this evidence and replace agent:auto with agent:plan-auto when parent issue-tree orchestration is desired.',
  ].join('\n');
}

export function buildChildReviewReport(input: { parentIssueNumber: number; result: ChildHandoffEvidence }): string {
  return [
    `codex-orchestrator child review report for #${input.result.child.issue.number}`,
    `Parent issue: #${input.parentIssueNumber}`,
    `Integration branch: ${input.result.branchName}`,
    'Changes',
    ...bulletList(input.result.changedFiles),
    'Validation',
    ...renderValidationEvidence(input.result.validation),
    'Proof Artifacts',
    ...renderLocalProofArtifacts({ artifacts: input.result.artifacts }),
    ...renderReviewHandoff(input.result.reviewHandoff),
    'Local Commits',
    ...renderCommitEvidence(input.result.commits),
    'Log',
    ...bulletList([input.result.logPath]),
    'Skipped Checks',
    ...bulletList(input.result.skippedChecks),
    'Residual Risks',
    ...bulletList(input.result.residualRisks),
    ...renderFreshContextReviewEvidence(input.result.freshContextReview),
    ...renderDurableRunSummaryEvidence(input.result.durableRunSummary),
  ].join('\n');
}

export function buildIssueTreeReviewReport(input: {
  parentIssueNumber: number;
  pullRequest: GitHubPullRequest;
  batches: AutonomousChildNode[][];
  childResults: ChildHandoffEvidence[];
  finalValidation: RunnerValidationLine[];
  sizeRisk?: PlanSizeRiskEvidence;
  parentReviewHandoff?: ParentReviewHandoffEvidence;
  riskRoutingWarnings?: string[];
}): string {
  return [
    `codex-orchestrator issue-tree review report for #${input.parentIssueNumber}`,
    'Pull Request',
    `- ${input.pullRequest.url}`,
    'Execution Batches',
    ...input.batches.map((batch, index) => `- Batch ${index + 1}: ${batch.map((child) => `#${child.issue.number}`).join(', ')}`),
    'Child Issues',
    ...input.childResults.map((result) => `- #${result.child.issue.number} ${result.recovered ? 'recovered ' : ''}${result.child.issue.title}: ${result.branchName}`),
    'Child Loop Outcomes',
    ...input.childResults.map((result) => (
      `- #${result.child.issue.number}: ${result.durableRunSummary?.excerpt[0] ?? 'outcome: review-ready'}`
    )),
    ...renderPlanningRiskProof(input.sizeRisk, input.parentReviewHandoff),
    ...renderRiskRoutingWarnings(input.riskRoutingWarnings),
    'Validation',
    ...input.childResults.flatMap((result) => renderValidationEvidence(result.validation, { prefix: `#${result.child.issue.number} ` })),
    ...renderValidationEvidence(input.finalValidation, { prefix: 'final ' }),
    'Skipped Checks',
    ...bulletList(input.childResults.flatMap((result) => result.skippedChecks)),
    'Proof Artifacts',
    ...input.childResults.flatMap((result) =>
      renderLocalProofArtifacts({ artifacts: result.artifacts, prefix: `#${result.child.issue.number} ` })),
    'Parent Risk/Proof Mini-Report',
    ...renderParentRiskProofMiniReport(input.childResults),
    'Logs',
    ...input.childResults.map((result) => `- #${result.child.issue.number}: ${result.logPath}`),
    'Local Commits',
    ...input.childResults.flatMap((result) => renderCommitEvidence(result.commits, { prefix: `#${result.child.issue.number} ` })),
    'Residual Risks',
    ...bulletList(input.childResults.flatMap((result) => result.residualRisks)),
  ].join('\n');
}

export function buildIssueTreePullRequestBody(input: {
  parentIssueNumber: number;
  childIssues: GitHubIssue[];
  childResults: ChildHandoffEvidence[];
  finalValidation: RunnerValidationLine[];
  sizeRisk?: PlanSizeRiskEvidence;
  parentReviewHandoff?: ParentReviewHandoffEvidence;
  riskRoutingWarnings?: string[];
}): string {
  return [
    `Parent issue: #${input.parentIssueNumber}`,
    '',
    'Child issues:',
    ...input.childIssues.map((issue) => `- #${issue.number} ${issue.title}`),
    '',
    'Planning risk/proof:',
    ...renderPlanningRiskProofBullets(input.sizeRisk, input.parentReviewHandoff),
    '',
    ...renderRiskRoutingWarnings(input.riskRoutingWarnings),
    ...(input.riskRoutingWarnings?.length ? [''] : []),
    'Changed files:',
    ...input.childResults.flatMap((result) => [
      `- #${result.child.issue.number}:`,
      ...result.changedFiles.map((file) => `  - ${file}`),
    ]),
    '',
    'Validation:',
    ...input.childResults.flatMap((result) => renderValidationEvidence(result.validation, { prefix: `#${result.child.issue.number} ` })),
    ...renderValidationEvidence(input.finalValidation, { prefix: 'final ' }),
    '',
    'Skipped checks:',
    ...bulletList(input.childResults.flatMap((result) => result.skippedChecks)),
    '',
    'Proof artifacts:',
    ...input.childResults.flatMap((result) =>
      renderLocalProofArtifacts({ artifacts: result.artifacts, prefix: `#${result.child.issue.number} ` })),
    '',
    'Parent risk/proof mini-report:',
    ...renderParentRiskProofMiniReport(input.childResults),
    '',
    'Logs:',
    ...input.childResults.map((result) => `- #${result.child.issue.number}: ${result.logPath}`),
    '',
    'Local commits:',
    ...input.childResults.flatMap((result) => renderCommitEvidence(result.commits, { prefix: `#${result.child.issue.number} ` })),
    '',
    'Residual risks:',
    ...bulletList(input.childResults.flatMap((result) => result.residualRisks)),
    '',
    'Child loop outcomes:',
    ...input.childResults.map((result) => (
      `- #${result.child.issue.number}: ${result.durableRunSummary?.excerpt[0] ?? 'outcome: review-ready'}`
    )),
    '',
    'Merge summary:',
    ...input.childResults.map((result) => `- ${result.branchName} ${result.recovered ? 'recovered from durable summary' : 'merged'} for #${result.child.issue.number}`),
    '',
    'Auto-merge is disabled.',
  ].join('\n');
}

export function buildChildBlockedReport(input: {
  parentIssueNumber: number;
  childIssueNumber: number;
  reasons: string[];
  details?: string[];
  branchName?: string;
  worktreePath?: string;
  batchChildren?: Array<{ issueNumber: number; branchName: string }>;
  gitOutput?: string;
  freshContextReview?: FreshContextReviewEvidence;
  durableRunSummary?: DurableRunSummaryEvidence;
  reworkAttempts?: ReworkAttemptEvidence[];
  acceptanceProof?: AcceptanceProofAttemptEvidence;
}): string {
  return [
    `codex-orchestrator blocked child #${input.childIssueNumber} for parent #${input.parentIssueNumber}`,
    'Reasons',
    ...bulletList(input.reasons),
    ...(input.details ?? []),
    ...(input.branchName ? [`- Branch preserved: ${input.branchName}`] : []),
    ...(input.worktreePath ? [`- Worktree preserved: ${input.worktreePath}`] : []),
    ...renderFreshContextReviewEvidence(input.freshContextReview),
    ...renderReworkAttemptEvidence(input.reworkAttempts),
    ...renderDurableRunSummaryEvidence(input.durableRunSummary),
    ...renderAcceptanceProofEvidence(input.acceptanceProof),
    ...(input.batchChildren ? ['Batch Children', ...bulletList(input.batchChildren.map((child) => `#${child.issueNumber} ${child.branchName}`))] : []),
    ...(input.gitOutput ? ['Git Output', ...bulletList([input.gitOutput])] : []),
  ].join('\n');
}

export function buildParentBlockedReport(input: {
  parentIssueNumber: number;
  reasons: string[];
  logPath: string;
  mutatedChildren: GitHubIssue[];
}): string {
  return [
    `codex-orchestrator blocked parent issue-tree execution for #${input.parentIssueNumber}`,
    'Reasons',
    ...bulletList(input.reasons),
    'Log',
    ...bulletList([input.logPath]),
    'Mutated Child Issues',
    ...bulletList(input.mutatedChildren.map((issue) => `#${issue.number} ${issue.title}`)),
  ].join('\n');
}

export function renderValidationEvidence(
  lines: RunnerValidationLine[],
  options: { prefix?: string } = {},
): string[] {
  return lines.map((line) => `- ${options.prefix ?? ''}${line.command}: ${line.status} - ${line.summary}`);
}

export function renderCommitEvidence(
  commits: CommitEvidence[],
  options: { prefix?: string } = {},
): string[] {
  if (commits.length === 0) {
    return [`- ${options.prefix ?? ''}none`];
  }
  return commits.map((commit) => `- ${options.prefix ?? ''}${commit.sha.slice(0, 12)} ${commit.subject}`);
}

export function renderScopedProofArtifacts(input: {
  config: CodexOrchestratorConfig;
  branchName: string;
  artifacts: ScopedCompletionReport['artifacts'];
}): string[] {
  if (input.artifacts.length === 0) {
    return ['- none'];
  }
  return input.artifacts.map((artifact) => {
    const target = artifact.url ?? rawGitHubUrl(input.config, input.branchName, artifact.path ?? '');
    const label = `${artifact.type}: ${artifact.description}`;
    return artifact.type === 'screenshot' ? `- ![${escapeMarkdownAlt(label)}](${target})` : `- ${label}: ${target}`;
  });
}

export function renderLocalProofArtifacts(input: {
  artifacts: ScopedCompletionReport['artifacts'];
  prefix?: string;
}): string[] {
  if (input.artifacts.length === 0) {
    return [`- ${input.prefix ?? ''}none`];
  }
  return input.artifacts.map((artifact) => {
    const target = artifact.url ?? artifact.path ?? 'missing-target';
    const label = `${artifact.type}: ${artifact.description}`;
    const line = artifact.type === 'screenshot' ? `![${escapeMarkdownAlt(label)}](${target})` : `${label}: ${target}`;
    return `- ${input.prefix ?? ''}${line}`;
  });
}

function renderParentRiskProofMiniReport(results: ChildHandoffEvidence[]): string[] {
  if (results.length === 0) {
    return ['- none'];
  }

  return results.map((result) => {
    const handoff = result.reviewHandoff;
    if (!handoff) {
      return `- #${result.child.issue.number}: no structured review handoff; inspect validation, proof artifacts, and residual risks.`;
    }
    const focus = handoff.reviewFocus.length > 0 ? handoff.reviewFocus.join('; ') : 'none';
    return `- #${result.child.issue.number}: flow=${handoff.flowUsed}; risk=${handoff.riskLevel}; review focus=${focus}`;
  });
}

function renderPlanningRiskProof(
  sizeRisk: PlanSizeRiskEvidence,
  handoff: ParentReviewHandoffEvidence,
): string[] {
  if (!sizeRisk && !handoff) {
    return [];
  }
  return [
    'Planning Risk/Proof',
    ...renderPlanningRiskProofBullets(sizeRisk, handoff),
  ];
}

function renderPlanningRiskProofBullets(
  sizeRisk: PlanSizeRiskEvidence,
  handoff: ParentReviewHandoffEvidence,
): string[] {
  const lines: string[] = [];
  if (sizeRisk) {
    lines.push(`- size/risk: small=${formatListInline(sizeRisk.small)}; medium=${formatListInline(sizeRisk.medium)}; high=${formatListInline(sizeRisk.high)}`);
  }
  if (handoff) {
    lines.push(...handoff.risks.map((risk) => `- risk: ${risk}`));
    lines.push(...handoff.proofStrategy.map((proof) => `- proof: ${proof}`));
    lines.push(...handoff.humanReviewFocus.map((focus) => `- human review focus: ${focus}`));
  }
  return lines.length > 0 ? lines : ['- none'];
}

function renderRiskRoutingWarnings(warnings: string[] | undefined): string[] {
  if (!warnings || warnings.length === 0) {
    return [];
  }
  return [
    'Risk routing warnings',
    ...bulletList(warnings),
  ];
}

function formatListInline(items: string[]): string {
  return items.length > 0 ? items.join(', ') : 'none';
}

function bulletList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- none'];
}

function rawGitHubUrl(config: CodexOrchestratorConfig, branchName: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${encodeURIComponent(config.github.owner)}/${encodeURIComponent(config.github.repo)}/${encodeURIComponent(branchName)}/${encodedPath}`;
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/[\[\]]/g, '');
}
