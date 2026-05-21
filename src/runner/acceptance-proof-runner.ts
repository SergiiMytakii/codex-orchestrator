import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexCommandRunInput, CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitWorktreeManager } from '../git/worktree.js';
import type { GitHubIssue } from '../github/issues.js';
import { globMatches, normalizePath } from '../path-policy.js';
import type { ScopedCompletionReport } from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import {
  createAcceptanceProofDiffCapture,
  evaluateAcceptanceProofReport,
  readAcceptanceProofReport,
  uiEvidenceFailureDimensions,
  type AcceptanceProofReport,
} from './acceptance-proof.js';
import { cleanupSessionCodexHome, sessionCodexHomePath } from './session-home.js';

export interface AcceptanceProofAttemptEvidence {
  status: 'passed' | 'needs-rework' | 'blocked';
  promptPath: string;
  reportPath: string;
  artifactDir: string;
  artifactPaths: string[];
  validation: RunnerValidationLine[];
  blockers: string[];
  residualRisks: string[];
  reworkRequest?: {
    summary: string;
    requiredChanges: string[];
    evidenceRefs: string[];
  };
}

export interface RunAcceptanceProofAttemptInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  targetRoot: string;
  worktreePath: string;
  changedFiles: string[];
  implementationReport: ScopedCompletionReport;
  codexAdapter: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  git: Pick<GitWorktreeManager, 'collectSessionChangeSet'>;
  beforeHead: string;
  sessionId: string;
  branchName: string;
  workflowPromptText: string;
  logPath?: string;
}

export interface AcceptanceProofAttemptResult {
  status: 'passed' | 'blocked';
  changedFiles: string[];
  validation: RunnerValidationLine[];
  artifacts: ScopedCompletionReport['artifacts'];
  residualRisks: string[];
  blockers: string[];
  evidence: AcceptanceProofAttemptEvidence;
}

export function shouldRunAcceptanceProofAttempt(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): boolean {
  const acceptanceProof = input.config.reviewGates.acceptanceProof;
  if (!acceptanceProof.enabled) {
    return false;
  }

  const issueText = `${input.issue.title}\n${input.issue.body}`;
  return acceptanceProof.issueTextPatterns.some((pattern) => new RegExp(pattern, 'iu').test(issueText))
    || input.changedFiles.some((path) => acceptanceProof.changedPathGlobs.some((pattern) => globMatches(pattern, path)));
}

export async function runAcceptanceProofAttempt(
  input: RunAcceptanceProofAttemptInput,
): Promise<AcceptanceProofAttemptResult> {
  const proofDir = join(
    input.worktreePath,
    input.config.reviewGates.acceptanceProof.artifactDir,
    `issue-${input.issue.number}`,
  );
  const proofReportPath = join(proofDir, 'acceptance-proof-report.json');
  const proofSessionId = `${input.sessionId}-acceptance-proof`;
  const isolatedHomePath = sessionCodexHomePath({ targetRoot: input.targetRoot, sessionId: proofSessionId });
  const proofPromptPath = join(
    input.targetRoot,
    input.config.runner.stateDir,
    'prompts',
    `issue-${input.issue.number}-${input.sessionId}-acceptance-proof.md`,
  );
  await mkdir(proofDir, { recursive: true });
  await mkdir(dirname(proofPromptPath), { recursive: true });
  await mkdir(isolatedHomePath, { recursive: true });

  const promptText = buildAcceptanceProofPrompt({
    issue: input.issue,
    config: input.config,
    workflowPromptText: input.workflowPromptText,
    changedFiles: input.changedFiles,
    implementationReport: input.implementationReport,
    promptPath: proofPromptPath,
    reportPath: proofReportPath,
    artifactDir: proofDir,
    worktreePath: input.worktreePath,
  });
  await writeFile(proofPromptPath, promptText, 'utf8');
  const proofDiffCapture = await createAcceptanceProofDiffCapture({
    worktreePath: input.worktreePath,
    changedFiles: input.changedFiles,
  });
  let proofResult: CodexCommandRunResult;
  try {
    proofResult = await input.codexAdapter.run({
      targetRoot: input.targetRoot,
      config: input.config,
      worktreePath: input.worktreePath,
      promptPath: proofPromptPath,
      promptText,
      reportPath: proofReportPath,
      isolatedHomePath,
      issueNumber: input.issue.number,
      sessionId: proofSessionId,
      branchName: input.branchName,
      phase: 'acceptance-proof',
      logPath: input.logPath,
      env: {
        CODEX_ORCHESTRATOR_PROOF_DIR: proofDir,
        CODEX_ORCHESTRATOR_PROOF_REPORT_PATH: proofReportPath,
        CODEX_ORCHESTRATOR_PROOF_ARTIFACT_DIR: proofDir,
        CODEX_ORCHESTRATOR_CHANGED_FILES: input.changedFiles.join('\n'),
        CODEX_ORCHESTRATOR_PROOF_OWNED_PATH_GLOBS: input.config.reviewGates.acceptanceProof.proofOwnedPathGlobs.join('\n'),
      },
    });
  } finally {
    await cleanupSessionCodexHome(isolatedHomePath);
  }

  const changeSet = await input.git.collectSessionChangeSet({
    worktreePath: input.worktreePath,
    baseHead: input.beforeHead,
  });
  const proofPhaseChangedFiles = await proofDiffCapture.collectProofPhaseChangedFiles(changeSet.changedPaths);
  const reportRead = await readAcceptanceProofReport(proofReportPath);

  if (reportRead.kind === 'missing') {
    return blocked({
      proofResult,
      proofPromptPath,
      proofReportPath,
      proofDir,
      changedFiles: changeSet.changedPaths,
      artifactPaths: proofPhaseChangedFiles,
      validationSummary: 'Acceptance proof blocked: proof session did not write CODEX_ORCHESTRATOR_PROOF_REPORT_PATH.',
      blockers: ['Acceptance proof blocked: proof session did not write CODEX_ORCHESTRATOR_PROOF_REPORT_PATH.'],
      residualRisks: [],
    });
  }
  if (reportRead.kind === 'invalid') {
    return blocked({
      proofResult,
      proofPromptPath,
      proofReportPath,
      proofDir,
      changedFiles: changeSet.changedPaths,
      artifactPaths: proofPhaseChangedFiles,
      validationSummary: reportRead.message,
      blockers: [`Acceptance proof blocked: ${reportRead.message}`],
      residualRisks: [],
    });
  }

  const evaluation = evaluateAcceptanceProofReport({
    config: input.config,
    report: reportRead.report,
    proofPhaseChangedFiles,
    artifactExists: (path) => existsSync(join(input.worktreePath, path)),
  });
  const status = proofStatus(reportRead.report, evaluation.ok, proofResult.exitCode);
  const artifactPaths = artifactPathsFromReport(reportRead.report, proofPhaseChangedFiles);
  const validation: RunnerValidationLine[] = [{
    command: 'adaptive acceptance proof',
    status: status === 'passed' ? 'passed' : 'failed',
    summary: status === 'passed'
      ? `Acceptance proof passed: ${reportRead.report.criteria.length} criterion/criteria mapped to high-confidence artifacts.`
      : `Acceptance proof ${status}: ${[
        proofResult.exitCode === 0 ? undefined : `proof session exited ${proofResult.exitCode}`,
        ...evaluation.reasons,
      ].filter(Boolean).join('; ')}`,
  }];
  const evidence: AcceptanceProofAttemptEvidence = {
    status,
    promptPath: proofPromptPath,
    reportPath: proofReportPath,
    artifactDir: proofDir,
    artifactPaths,
    validation,
    blockers: status === 'passed' ? [] : validation.map((line) => line.summary),
    residualRisks: [...reportRead.report.residualRisks, ...evaluation.warnings],
    reworkRequest: reportRead.report.reworkRequest,
  };

  if (status !== 'passed') {
    return {
      status: 'blocked',
      changedFiles: changeSet.changedPaths,
      validation,
      artifacts: reportRead.report.artifacts,
      residualRisks: evidence.residualRisks,
      blockers: evidence.blockers,
      evidence,
    };
  }

  return {
    status: 'passed',
    changedFiles: changeSet.changedPaths,
    validation,
    artifacts: reportRead.report.artifacts,
    residualRisks: evidence.residualRisks,
    blockers: [],
    evidence,
  };
}

function buildAcceptanceProofPrompt(input: {
  issue: GitHubIssue;
  config: CodexOrchestratorConfig;
  workflowPromptText: string;
  changedFiles: string[];
  implementationReport: ScopedCompletionReport;
  promptPath: string;
  reportPath: string;
  artifactDir: string;
  worktreePath: string;
}): string {
  return [
    '# Adaptive Proof Agent',
    '## Workflow',
    input.workflowPromptText,
    '## Issue',
    `#${input.issue.number} ${input.issue.title}`,
    input.issue.body,
    '## Changed Files',
    input.changedFiles.length === 0 ? 'none' : input.changedFiles.map((path) => `- ${path}`).join('\n'),
    '## Implementation Evidence',
    JSON.stringify({
      validation: input.implementationReport.validation,
      artifacts: input.implementationReport.artifacts,
      residualRisks: input.implementationReport.residualRisks,
    }, null, 2),
    '## Runner Contract',
    `Prompt path: ${input.promptPath}`,
    `Proof Report path: ${input.reportPath}`,
    `Proof artifact directory: ${input.artifactDir}`,
    `Worktree: ${input.worktreePath}`,
    `Proof-owned repair paths: ${input.config.reviewGates.acceptanceProof.proofOwnedPathGlobs.join(', ')}`,
    'You do not have GitHub write authority or publication authority. Do not edit GitHub labels, comments, issues, pull requests, branches, or releases.',
    'Do not change product code during proof. If behavior is missing, return needs-rework.',
    'For UI proof, derive task-specific checks from issue acceptance criteria, implementation evidence, reproduction signals, validation sections, Manual QA Plan content when present, and runtime/media artifacts.',
    'When you include screenshot or ui-dump artifacts, include uiEvidence with workflowScope, viewportCoverage, artifactFreshness, layoutReview, copyReview, and sourceInputs. The runner is the only pass/fail authority for UI Evidence.',
    'workflowScope must record the exact entrypoint, user path, screenState, and authPath. Prefer real UI login when configured credentials are available; if you seed a session or cookie, set authPath to "seeded-session" and provide authShortcutReason.',
    'viewportCoverage must record width, height, artifactRefs, and requiredBy. Use requiredBy "desktop-web-layout" with wide desktop coverage for web layout proof. Add mobile coverage only when the issue or acceptance criteria call for mobile or responsive behavior.',
    'artifactFreshness must name current post-run artifact refs and checkedAfterFinalRun: true.',
    'layoutReview findings must cover spacing, padding, clipping, overlap, alignment, and the specific visual complaint being verified, with each finding mapped to artifactRefs.',
    'copyReview findings must cover user-facing copy and rejected implementation terms when copy is part of the acceptance path, with each finding mapped to artifactRefs.',
    'sourceInputs must cite acceptanceCriteriaRefs and implementationEvidenceRefs; cite reproductionSignalRefs, manualQaPlanRefs, and runtimeValidationRefs when those inputs exist. Source inputs cannot replace workflow, viewport, freshness, layout, or copy evidence.',
    `Stable UI Evidence failure dimensions are: ${uiEvidenceFailureDimensions.join(', ')}.`,
    'Your final response must be only raw valid JSON, with no markdown fence or explanatory prose.',
    'Schema: { "status": "passed" | "needs-rework" | "blocked", "criteria": { "id": string, "description": string, "status": "passed" | "failed" | "unknown", "confidence": "high" | "medium" | "low", "reasoningSummary": string, "artifactRefs": string[] }[], "artifacts": { "type": "screenshot" | "ui-dump" | "log" | "smoke-output" | "other", "path"?: string, "url"?: string, "description": string }[], "uiEvidence"?: { "workflowScope": { "entrypoint": string, "path": string[], "screenState": string, "authPath"?: "real-login" | "seeded-session" | "not-required" | "blocked", "authShortcutReason"?: string }, "viewportCoverage": { "name": string, "width": number, "height": number, "artifactRefs": string[], "requiredBy": "desktop-web-layout" | "mobile-or-responsive" | "issue-specific" | "other" }[], "artifactFreshness": { "currentArtifactRefs": string[], "checkedAfterFinalRun": boolean }, "layoutReview": { "checked": boolean, "findings": { "summary": string, "artifactRefs": string[] }[] }, "copyReview": { "checked": boolean, "acceptedTerms"?: string[], "rejectedTermsAbsent"?: string[], "findings": { "summary": string, "artifactRefs": string[] }[] }, "sourceInputs": { "acceptanceCriteriaRefs": string[], "implementationEvidenceRefs": string[], "reproductionSignalRefs"?: string[], "manualQaPlanRefs"?: string[], "runtimeValidationRefs"?: string[] } }, "proofScriptRepair"?: { "changedPaths": string[], "summary": string }, "proofPhaseDiff": { "allowedProofPaths": string[], "forbiddenProductPaths": string[] }, "reworkRequest"?: { "summary": string, "requiredChanges": string[], "evidenceRefs": string[] }, "residualRisks": string[] }.',
  ].join('\n\n');
}

function proofStatus(
  report: AcceptanceProofReport,
  evaluationOk: boolean,
  exitCode: number,
): AcceptanceProofAttemptEvidence['status'] {
  if (exitCode !== 0 || report.status === 'blocked') {
    return 'blocked';
  }
  if (!evaluationOk || report.status === 'needs-rework') {
    return 'needs-rework';
  }
  return 'passed';
}

function blocked(input: {
  proofResult: CodexCommandRunResult;
  proofPromptPath: string;
  proofReportPath: string;
  proofDir: string;
  changedFiles: string[];
  artifactPaths: string[];
  validationSummary: string;
  blockers: string[];
  residualRisks: string[];
}): AcceptanceProofAttemptResult {
  const validation = [{
    command: 'adaptive acceptance proof',
    status: 'failed' as const,
    summary: input.proofResult.exitCode === 0
      ? input.validationSummary
      : `${input.validationSummary} Codex exited with code ${input.proofResult.exitCode}: ${input.proofResult.stderr || input.proofResult.stdout}`,
  }];
  return {
    status: 'blocked',
    changedFiles: input.changedFiles,
    validation,
    artifacts: input.artifactPaths.map((path) => ({ type: 'other' as const, path, description: `acceptance proof artifact ${path}` })),
    residualRisks: input.residualRisks,
    blockers: input.blockers,
    evidence: {
      status: 'blocked',
      promptPath: input.proofPromptPath,
      reportPath: input.proofReportPath,
      artifactDir: input.proofDir,
      artifactPaths: input.artifactPaths,
      validation,
      blockers: input.blockers,
      residualRisks: input.residualRisks,
    },
  };
}

function artifactPathsFromReport(report: AcceptanceProofReport, changedFiles: string[]): string[] {
  return Array.from(new Set([
    ...changedFiles,
    ...report.artifacts.flatMap((artifact) => artifact.path ? [normalizePath(artifact.path)] : []),
  ])).sort((left, right) => left.localeCompare(right));
}
