import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CodexCommandRunInput, CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { formatBaseBranch } from '../git/base-branch.js';
import type { GitHubIssue } from '../github/issues.js';
import { writeContextSnapshot } from './context-snapshot.js';
import type { FreshContextReviewEvidence } from './handoff-evidence.js';
import type { runImplementationPublishabilityCheck } from './local-execution-session.js';
import { sessionPromptPath, sessionReportPath, writeDurablePrompt } from './prompt.js';
import { sessionLogPath } from './run-log.js';
import { prepareSkillRuntimeExecution } from './skill-runtime-execution.js';

type PublishReadyResult = Extract<
  Awaited<ReturnType<typeof runImplementationPublishabilityCheck>>,
  { status: 'publish-ready' }
>;

export async function runFreshContextReviewIfEnabled(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  codexAdapter: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  worktreePath: string;
  isolatedSessionId: string;
  branchName: string;
  publishability: PublishReadyResult;
}): Promise<FreshContextReviewEvidence | undefined> {
  if (!input.config.loopPolicy.freshContextReview.enabled) {
    return undefined;
  }

  const reviewPromptPath = sessionPromptPath({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: input.isolatedSessionId,
  });
  const reviewReportPath = sessionReportPath({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: input.isolatedSessionId,
  });
  const reviewLogPath = sessionLogPath({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: input.isolatedSessionId,
  });
  await mkdir(dirname(reviewReportPath), { recursive: true });
  const snapshot = await writeContextSnapshot({
    targetRoot: input.targetRoot,
    config: input.config,
    issue: input.issue,
    mode: 'scoped-issue',
    phase: 'fresh-context-review',
    decision: 'fresh context review before publication',
    sessionId: input.isolatedSessionId,
    worktreePath: input.worktreePath,
    promptPath: reviewPromptPath,
    reportPath: reviewReportPath,
    logPath: reviewLogPath,
    branchName: input.branchName,
    baseBranch: formatBaseBranch(input.config.branches.base),
  });

  let codexResult: CodexCommandRunResult;
  const execution = await prepareSkillRuntimeExecution({
      targetRoot: input.targetRoot,
      config: input.config,
      worktreePath: input.worktreePath,
      runId: `issue-${input.issue.number}-${input.isolatedSessionId}`,
      issueNumber: input.issue.number,
      reportPath: reviewReportPath,
      sessionId: input.isolatedSessionId,
      branchName: input.branchName,
      phase: 'fresh-context-review',
      logPath: reviewLogPath,
      operationId: 'fresh-context-review',
      attemptId: `${input.isolatedSessionId}-fresh-context-review`,
      context: {
        issue: input.issue,
        publishability: input.publishability,
        promptPath: reviewPromptPath,
        reportPath: reviewReportPath,
      },
    });
  await writeDurablePrompt({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: input.isolatedSessionId,
    contextArtifactPath: execution.contextArtifactPath,
  });
  codexResult = await input.codexAdapter.run(execution.input);

  if (codexResult.exitCode !== 0) {
    return {
      status: 'blocked',
      findings: [`Fresh-Context Review Codex exited with code ${codexResult.exitCode}`],
      residualRisks: [],
      logPath: reviewLogPath,
      snapshotPath: snapshot.path,
    };
  }

  let report: FreshContextReviewReport;
  try {
    report = await readFreshContextReviewReport(reviewReportPath);
  } catch (error) {
    return {
      status: 'blocked',
      findings: [error instanceof Error ? error.message : 'Fresh-Context Review report could not be read'],
      residualRisks: [],
      logPath: reviewLogPath,
      snapshotPath: snapshot.path,
    };
  }
  const findings = report.findings.map(
    (finding) => `${finding.severity} ${finding.confidence}: ${finding.summary}`,
  );
  const blocksPublication = input.config.loopPolicy.freshContextReview.blockOnHighConfidencePolicyViolations
    && report.findings.some((finding) => finding.severity === 'policy-violation' && finding.confidence === 'high');
  return {
    status: blocksPublication ? 'blocked' : 'passed',
    findings,
    residualRisks: report.residualRisks,
    logPath: reviewLogPath,
    snapshotPath: snapshot.path,
  };
}

interface FreshContextReviewReport {
  status: 'completed';
  findings: Array<{
    severity: 'advisory' | 'policy-violation';
    confidence: 'low' | 'medium' | 'high';
    summary: string;
    evidence: string;
  }>;
  residualRisks: string[];
}

async function readFreshContextReviewReport(path: string): Promise<FreshContextReviewReport> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Fresh-Context Review did not write review report');
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error('Invalid Fresh-Context Review report: report must be valid JSON');
  }
  assertFreshContextReviewReport(parsed);
  return parsed;
}

function assertFreshContextReviewReport(value: unknown): asserts value is FreshContextReviewReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Fresh-Context Review report: report must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.status !== 'completed') {
    throw new Error('Invalid Fresh-Context Review report: status must be completed');
  }
  if (!Array.isArray(record.findings)) {
    throw new Error('Invalid Fresh-Context Review report: findings must be an array');
  }
  for (const item of record.findings) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Invalid Fresh-Context Review report: finding must be an object');
    }
    const finding = item as Record<string, unknown>;
    if (
      !['advisory', 'policy-violation'].includes(String(finding.severity))
      || !['low', 'medium', 'high'].includes(String(finding.confidence))
      || typeof finding.summary !== 'string'
      || finding.summary.trim().length === 0
      || typeof finding.evidence !== 'string'
    ) {
      throw new Error('Invalid Fresh-Context Review report: finding is malformed');
    }
  }
  if (!Array.isArray(record.residualRisks) || record.residualRisks.some((risk) => typeof risk !== 'string')) {
    throw new Error('Invalid Fresh-Context Review report: residualRisks must be a string array');
  }
}
