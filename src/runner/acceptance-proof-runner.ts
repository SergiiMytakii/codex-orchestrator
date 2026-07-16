import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CodexCommandRunInput, CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ScopedCompletionReport } from './completion-report.js';
import type { AcceptanceProofAdapterResult } from './acceptance-proof-loop.js';
import { writeDurablePrompt } from './prompt.js';
import { prepareSkillRuntimeExecution } from './skill-runtime-execution.js';

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
  logPath?: string;
  repairSchemaErrors?: string[];
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
  const proofLogPath = input.logPath ?? join(proofDir, 'acceptance-proof.log');
  const proofSessionId = `${input.sessionId}-acceptance-proof`;
  const proofPromptPath = join(
    input.targetRoot,
    input.config.runner.stateDir,
    'prompts',
    `issue-${input.issue.number}-${input.sessionId}-acceptance-proof.md`,
  );
  await mkdir(proofDir, { recursive: true });
  let proofResult: CodexCommandRunResult;
  const execution = await prepareSkillRuntimeExecution({
      targetRoot: input.targetRoot,
      config: input.config,
      worktreePath: input.worktreePath,
      runId: `issue-${input.issue.number}-${proofSessionId}`,
      issueNumber: input.issue.number,
      reportPath: proofReportPath,
      sessionId: proofSessionId,
      branchName: input.branchName,
      phase: 'acceptance-proof',
      logPath: proofLogPath,
      operationId: 'acceptance-proof',
      attemptId: `${proofSessionId}-acceptance-proof`,
      phaseEnv: {
        CODEX_ORCHESTRATOR_PROOF_DIR: proofDir,
        CODEX_ORCHESTRATOR_PROOF_REPORT_PATH: proofReportPath,
        CODEX_ORCHESTRATOR_PROOF_ARTIFACT_DIR: proofDir,
        CODEX_ORCHESTRATOR_CHANGED_FILES: input.changedFiles.join('\n'),
        CODEX_ORCHESTRATOR_PROOF_OWNED_PATH_GLOBS: input.config.reviewGates.acceptanceProof.proofOwnedPathGlobs.join('\n'),
      },
      context: {
        issue: input.issue,
        changedFiles: input.changedFiles,
        implementationReport: input.implementationReport,
        promptPath: proofPromptPath,
        reportPath: proofReportPath,
        artifactDir: proofDir,
        worktreePath: input.worktreePath,
        repairSchemaErrors: input.repairSchemaErrors,
      },
    });
  await writeDurablePrompt({
    targetRoot: input.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: proofSessionId,
    contextArtifactPath: execution.contextArtifactPath,
  });
  proofResult = await input.codexAdapter.run(execution.input);
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
