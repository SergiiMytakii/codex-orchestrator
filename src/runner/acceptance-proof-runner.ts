import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexCommandRunInput, CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ScopedCompletionReport } from './completion-report.js';
import { uiEvidenceFailureDimensions } from './acceptance-proof.js';
import type { AcceptanceProofAdapterResult } from './acceptance-proof-loop.js';
import { cleanupSessionCodexHome, sessionCodexHomePath } from './session-home.js';

export type { AcceptanceProofAttemptEvidence } from './acceptance-proof.js';

export interface RunAcceptanceProofAttemptInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  targetRoot: string;
  worktreePath: string;
  changedFiles: string[];
  implementationReport: ScopedCompletionReport;
  codexAdapter: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  sessionId: string;
  branchName: string;
  workflowPromptText: string;
  logPath?: string;
}

export async function runAcceptanceProofAdapter(
  input: RunAcceptanceProofAttemptInput,
): Promise<AcceptanceProofAdapterResult> {
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
  return {
    adapterKind: 'adaptive',
    command: 'adaptive acceptance proof',
    exitCode: proofResult.exitCode,
    outputSummary: `proof session exited ${proofResult.exitCode}: ${proofResult.stderr || proofResult.stdout}`,
    promptPath: proofPromptPath,
    reportPath: proofReportPath,
    artifactDir: proofDir,
    artifactPaths: [],
    preliminaryArtifacts: [],
    residualRisks: [],
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
