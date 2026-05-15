import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CodexCommandRunInput, CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { FreshContextReviewEvidence } from './handoff-evidence.js';
import type { runImplementationPublishabilityCheck } from './local-execution-session.js';
import { sessionPromptPath, sessionReportPath, writeDurablePrompt } from './prompt.js';
import { sessionLogPath } from './run-log.js';
import { cleanupSessionCodexHome, sessionCodexHomePath } from './session-home.js';

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
  const isolatedHomePath = sessionCodexHomePath({ targetRoot: input.targetRoot, sessionId: input.isolatedSessionId });
  await mkdir(dirname(reviewReportPath), { recursive: true });
  await mkdir(isolatedHomePath, { recursive: true });
  const promptText = buildFreshContextReviewPrompt(input);
  await writeDurablePrompt({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: input.isolatedSessionId,
    promptText,
  });

  let codexResult: CodexCommandRunResult;
  try {
    codexResult = await input.codexAdapter.run({
      targetRoot: input.targetRoot,
      config: input.config,
      worktreePath: input.worktreePath,
      promptPath: reviewPromptPath,
      promptText,
      reportPath: reviewReportPath,
      isolatedHomePath,
      issueNumber: input.issue.number,
      sessionId: input.isolatedSessionId,
      branchName: input.branchName,
      timeoutMs: input.config.codex.timeoutMs,
      logPath: reviewLogPath,
    });
  } finally {
    await cleanupSessionCodexHome(isolatedHomePath);
  }

  if (codexResult.exitCode !== 0) {
    return {
      status: 'blocked',
      findings: [`Fresh-Context Review Codex exited with code ${codexResult.exitCode}`],
      residualRisks: [],
      logPath: reviewLogPath,
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
  };
}

function buildFreshContextReviewPrompt(input: {
  issue: GitHubIssue;
  publishability: PublishReadyResult;
}): string {
  return [
    '# Fresh-Context Review',
    `Issue: #${input.issue.number}`,
    `Title: ${input.issue.title}`,
    `Body:\n${input.issue.body}`,
    'Review the implementation evidence without relying on the implementation session transcript.',
    'Focus on high-confidence safety, policy, and handoff blockers. Do not edit files and do not publish to GitHub.',
    'Changed files:',
    ...input.publishability.changedFiles.map((file) => `- ${file}`),
    'Validation:',
    ...input.publishability.validation.map((line) => `- ${line.command}: ${line.status} - ${line.summary}`),
    'Skipped checks:',
    ...input.publishability.skippedChecks.map((check) => `- ${check}`),
    'Residual risks:',
    ...input.publishability.residualRisks.map((risk) => `- ${risk}`),
    'Return only raw JSON: { "status": "completed", "findings": { "severity": "advisory" | "policy-violation", "confidence": "low" | "medium" | "high", "summary": string, "evidence": string }[], "residualRisks": string[] }.',
  ].join('\n\n');
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
