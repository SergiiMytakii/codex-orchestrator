import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { CodexCommandRunInput, CodexCommandRunResult } from '../codex/command-adapter.js';
import type { GitWorktreeManager, SessionCommitInfo } from '../git/worktree.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ShellCommandExecutor } from '../process/command.js';
import { mergeArtifacts, runConfiguredChecks } from './command-utils.js';
import { readScopedCompletionReport, type ScopedCompletionReport } from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import { classifyAcceptanceProofDiff } from './acceptance-proof.js';
import { evaluateReviewGates } from './review-gates.js';
import {
  validateChangedPaths,
  validateCompletionReportSafety,
  validateNoAgentOwnedGitPublication,
} from './safety.js';
import { runRunnerVisualProof } from './visual-proof-runner.js';
import {
  runAcceptanceProofAttempt,
  shouldRunAcceptanceProofAttempt,
  type AcceptanceProofAttemptEvidence,
} from './acceptance-proof-runner.js';

export interface LocalExecutionPhaseInput {
  phaseId: string;
  worktreePath: string;
}

export interface LocalExecutionPhaseResult {
  phaseId: string;
  status: 'passed' | 'failed';
  validation: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; summary: string }>;
  artifacts: ScopedCompletionReport['artifacts'];
  residualRisks: string[];
}

export type LocalExecutionPhaseExecutor = (input: LocalExecutionPhaseInput) => Promise<LocalExecutionPhaseResult>;

export interface LocalExecutionSessionInput {
  worktreePath: string;
  phases: string[];
  executePhase: LocalExecutionPhaseExecutor;
}

export interface LocalExecutionSessionResult {
  worktreePath: string;
  phaseResults: LocalExecutionPhaseResult[];
  status: 'passed' | 'blocked';
  publishReady: boolean;
}

export interface ImplementationPublishabilityInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  targetRoot?: string;
  worktreePath: string;
  reportPath: string;
  beforeHead: string;
  afterHead: string;
  codexResult: { stdout: string; stderr: string; exitCode: number };
  git: Pick<GitWorktreeManager, 'collectSessionChangeSet' | 'isWorktreeClean' | 'commitAll'>;
  shellExecutor: ShellCommandExecutor;
  commitMessage: string;
  localPhases?: string[];
  localPhaseExecutor?: LocalExecutionPhaseExecutor;
  acceptanceProof?: {
    targetRoot: string;
    sessionId: string;
    branchName: string;
    workflowPromptText: string;
    codexAdapter: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
    onAttemptEvent?: (event: {
      status: 'started' | 'passed' | 'needs-rework' | 'blocked';
      evidence?: AcceptanceProofAttemptEvidence;
    }) => Promise<void>;
  };
}

export type ImplementationPublishabilityResult =
  | {
      status: 'publish-ready';
      report: ScopedCompletionReport;
      changedFiles: string[];
      validation: RunnerValidationLine[];
      artifacts: ScopedCompletionReport['artifacts'];
      skippedChecks: string[];
      residualRisks: string[];
      commits: SessionCommitInfo[];
      acceptanceProofAttempt?: AcceptanceProofAttemptEvidence;
    }
  | {
      status: 'blocked';
      reasons: string[];
      changedFiles: string[];
      validation?: RunnerValidationLine[];
      skippedChecks: string[];
      residualRisks: string[];
      commits: SessionCommitInfo[];
      acceptanceProofAttempt?: AcceptanceProofAttemptEvidence;
    }
  | {
      status: 'promotion-requested';
      report: ScopedCompletionReport;
    };

export async function runLocalExecutionSession(input: LocalExecutionSessionInput): Promise<LocalExecutionSessionResult> {
  const phaseResults: LocalExecutionPhaseResult[] = [];

  for (const phaseId of input.phases) {
    const result = await input.executePhase({ phaseId, worktreePath: input.worktreePath });
    if (result.phaseId !== phaseId) {
      throw new Error(`Local execution phase ${phaseId} returned mismatched result for ${result.phaseId}`);
    }
    phaseResults.push(result);
    if (result.status === 'failed') {
      return {
        worktreePath: input.worktreePath,
        phaseResults,
        status: 'blocked',
        publishReady: false,
      };
    }
  }

  return {
    worktreePath: input.worktreePath,
    phaseResults,
    status: 'passed',
    publishReady: true,
  };
}

export async function runImplementationPublishabilityCheck(
  input: ImplementationPublishabilityInput,
): Promise<ImplementationPublishabilityResult> {
  const publicationViolations = input.config.runner.allowAgentLocalCommits
    ? []
    : validateNoAgentOwnedGitPublication(input.beforeHead, input.afterHead);
  if (publicationViolations.length > 0) {
    return blocked(publicationViolations.map((violation) => violation.message));
  }

  if (input.codexResult.exitCode !== 0) {
    return blocked([formatCodexExitReason(input.codexResult)]);
  }

  let report: ScopedCompletionReport;
  try {
    const reportResult = await readScopedCompletionReport(input.reportPath);
    if (reportResult.kind === 'missing') {
      return blocked(['Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove safety contract.']);
    }
    report = reportResult.report;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid scoped completion report';
    return blocked([message]);
  }

  if (report.status === 'needs-promotion') {
    return { status: 'promotion-requested', report };
  }

  const localSession = await runLocalExecutionSession({
    worktreePath: input.worktreePath,
    phases: input.localPhases ?? [],
    executePhase: input.localPhaseExecutor ?? defaultPassingLocalPhaseExecutor,
  });
  if (!localSession.publishReady) {
    const changeSet = await input.git.collectSessionChangeSet({
      worktreePath: input.worktreePath,
      baseHead: input.beforeHead,
    });
    return {
      status: 'blocked',
      reasons: localSessionBlockReasons(localSession.phaseResults),
      changedFiles: changeSet.changedPaths,
      validation: [...report.validation, ...localSession.phaseResults.flatMap((phase) => phase.validation)],
      skippedChecks: report.skippedChecks,
      residualRisks: [...report.residualRisks, ...localSession.phaseResults.flatMap((phase) => phase.residualRisks)],
      commits: changeSet.commits,
    };
  }

  report = {
    ...report,
    validation: [...report.validation, ...localSession.phaseResults.flatMap((phase) => phase.validation)],
    artifacts: mergeArtifacts(report.artifacts, localSession.phaseResults.flatMap((phase) => phase.artifacts)),
    residualRisks: [...report.residualRisks, ...localSession.phaseResults.flatMap((phase) => phase.residualRisks)],
  };

  let changeSet = await input.git.collectSessionChangeSet({
    worktreePath: input.worktreePath,
    baseHead: input.beforeHead,
  });
  let changedFiles = changeSet.changedPaths;
  if (changedFiles.length === 0) {
    return {
      status: 'blocked',
      reasons: ['Codex completed without file changes'],
      changedFiles: [],
      validation: report.validation,
      skippedChecks: report.skippedChecks,
      residualRisks: report.residualRisks,
      commits: changeSet.commits,
    };
  }

  const violations = [
    ...validateChangedPaths(changedFiles, input.config),
    ...validateCompletionReportSafety(report),
  ];
  if (violations.length > 0) {
    return {
      status: 'blocked',
      reasons: violations.map((violation) => violation.message),
      changedFiles,
      validation: report.validation,
      skippedChecks: report.skippedChecks,
      residualRisks: report.residualRisks,
      commits: changeSet.commits,
    };
  }

  const validationBeforeChecks = report.validation.length;
  let validation = await runConfiguredChecks(
    input.config,
    input.worktreePath,
    input.shellExecutor,
    report.validation,
    changedFiles,
  );
  const checkWarnings = validation
    .slice(validationBeforeChecks)
    .filter((line) => line.status === 'skipped')
    .map((line) => `Configured check warning: ${line.command} - ${line.summary}`);
  if (checkWarnings.length > 0) {
    report = {
      ...report,
      residualRisks: [...report.residualRisks, ...checkWarnings],
    };
  }
  const residualRisks = [...report.residualRisks];
  let acceptanceProofAttempt: AcceptanceProofAttemptEvidence | undefined;
  const adaptiveProofConfigured = input.acceptanceProof
    && input.targetRoot
    && (
      Boolean(input.config.codex.profiles?.['acceptance-proof'])
      || !input.config.reviewGates.acceptanceProof.runnerValidationCommand?.trim()
    )
    && shouldRunAcceptanceProofAttempt({
      config: input.config,
      issue: input.issue,
      changedFiles,
    });

  if (adaptiveProofConfigured && input.acceptanceProof) {
    await input.acceptanceProof.onAttemptEvent?.({ status: 'started' });
    const proofResult = await runAcceptanceProofAttempt({
      config: input.config,
      issue: input.issue,
      targetRoot: input.acceptanceProof.targetRoot,
      worktreePath: input.worktreePath,
      changedFiles,
      implementationReport: report,
      codexAdapter: input.acceptanceProof.codexAdapter,
      git: input.git,
      beforeHead: input.beforeHead,
      sessionId: input.acceptanceProof.sessionId,
      branchName: input.acceptanceProof.branchName,
      workflowPromptText: input.acceptanceProof.workflowPromptText,
    });
    acceptanceProofAttempt = proofResult.evidence;
    await input.acceptanceProof.onAttemptEvent?.({
      status: proofResult.evidence.status,
      evidence: proofResult.evidence,
    });
    validation = [...validation, ...proofResult.validation];
    report = {
      ...report,
      artifacts: mergeArtifacts(report.artifacts, proofResult.artifacts),
      residualRisks: [...report.residualRisks, ...proofResult.residualRisks],
    };
    residualRisks.push(...proofResult.residualRisks);
    changedFiles = proofResult.changedFiles;

    if (proofResult.status === 'blocked') {
      return {
        status: 'blocked',
        reasons: proofResult.blockers,
        changedFiles,
        validation,
        skippedChecks: report.skippedChecks,
        residualRisks,
        commits: changeSet.commits,
        acceptanceProofAttempt,
      };
    }
  }

  const beforeProofFileHashes = adaptiveProofConfigured ? undefined : await snapshotFileHashes(input.worktreePath, changedFiles);
  const runnerVisualProof = adaptiveProofConfigured
    ? { validation: [], artifacts: [] }
    : await runRunnerVisualProof({
      config: input.config,
      issue: input.issue,
      issueNumber: input.issue.number,
      targetRoot: input.targetRoot,
      worktreePath: input.worktreePath,
      changedFiles,
      report,
      shellExecutor: input.shellExecutor,
    });
  validation = [...validation, ...runnerVisualProof.validation];
  report = {
    ...report,
    artifacts: mergeArtifacts(report.artifacts, runnerVisualProof.artifacts),
  };
  if (!adaptiveProofConfigured && (runnerVisualProof.validation.length > 0 || runnerVisualProof.artifacts.length > 0)) {
    const beforeProofChangedFiles = new Set(changedFiles);
    changeSet = await input.git.collectSessionChangeSet({
      worktreePath: input.worktreePath,
      baseHead: input.beforeHead,
    });
    const proofPhaseChangedFiles = [
      ...changeSet.changedPaths.filter((path) => !beforeProofChangedFiles.has(path)),
      ...await changedFileHashes(input.worktreePath, beforeProofFileHashes ?? new Map()),
    ];
    changedFiles = changeSet.changedPaths;
    const proofDiff = classifyAcceptanceProofDiff(input.config, proofPhaseChangedFiles);
    if (proofDiff.forbiddenProductPaths.length > 0) {
      return {
        status: 'blocked',
        reasons: [
          `Acceptance proof produced product-code changes during acceptance proof: ${proofDiff.forbiddenProductPaths.join(', ')}.`,
        ],
        changedFiles,
        validation,
        skippedChecks: report.skippedChecks,
        residualRisks: report.residualRisks,
        commits: changeSet.commits,
        acceptanceProofAttempt,
      };
    }
  }

  const failedValidation = validation.filter((line) => line.status === 'failed');
  if (failedValidation.length > 0) {
    residualRisks.push('One or more configured checks failed.');
    return {
      status: 'blocked',
      reasons: [
        'One or more configured checks failed.',
        ...failedValidation.map((line) => `${line.command}: ${line.status} - ${line.summary}`),
      ],
      changedFiles,
      validation,
      skippedChecks: report.skippedChecks,
      residualRisks,
      commits: changeSet.commits,
      acceptanceProofAttempt,
    };
  }

  const reviewGate = evaluateReviewGates({
    config: input.config,
    issue: input.issue,
    changedFiles,
    validation,
    skippedChecks: report.skippedChecks,
    report,
    worktreePath: input.worktreePath,
  });
  if (!reviewGate.ok) {
    return {
      status: 'blocked',
      reasons: reviewGate.reasons,
      changedFiles,
      validation,
      skippedChecks: report.skippedChecks,
      residualRisks,
      commits: changeSet.commits,
      acceptanceProofAttempt,
    };
  }
  if (reviewGate.warnings.length > 0) {
    residualRisks.push(...reviewGate.warnings);
    report = {
      ...report,
      residualRisks: [...report.residualRisks, ...reviewGate.warnings],
    };
  }

  if (!(await input.git.isWorktreeClean(input.worktreePath))) {
    await input.git.commitAll({ worktreePath: input.worktreePath, message: input.commitMessage });
    changeSet = await input.git.collectSessionChangeSet({
      worktreePath: input.worktreePath,
      baseHead: input.beforeHead,
    });
  }

  return {
    status: 'publish-ready',
    report,
    changedFiles,
    validation,
    artifacts: report.artifacts,
    skippedChecks: report.skippedChecks,
    residualRisks,
    commits: changeSet.commits,
    acceptanceProofAttempt,
  };
}

async function snapshotFileHashes(worktreePath: string, paths: string[]): Promise<Map<string, string | undefined>> {
  const hashes = new Map<string, string | undefined>();
  await Promise.all(paths.map(async (path) => {
    hashes.set(path, await fileHash(join(worktreePath, path)));
  }));
  return hashes;
}

async function changedFileHashes(worktreePath: string, before: Map<string, string | undefined>): Promise<string[]> {
  const changed: string[] = [];
  await Promise.all(Array.from(before.entries()).map(async ([path, hash]) => {
    if (await fileHash(join(worktreePath, path)) !== hash) {
      changed.push(path);
    }
  }));
  return changed.sort((left, right) => left.localeCompare(right));
}

async function fileHash(path: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function defaultPassingLocalPhaseExecutor(input: { phaseId: string; worktreePath: string }) {
  return {
    phaseId: input.phaseId,
    status: 'passed' as const,
    validation: [],
    artifacts: [],
    residualRisks: [],
  };
}

function localSessionBlockReasons(phaseResults: LocalExecutionPhaseResult[]): string[] {
  return phaseResults.flatMap((phase) => {
    if (phase.status !== 'failed') {
      return [];
    }
    return [
      `Local phase ${phase.phaseId} failed`,
      ...phase.validation.map((line) => `${line.command}: ${line.status} - ${line.summary}`),
      ...phase.artifacts.map((artifact) => `${artifact.description}: ${artifact.url ?? artifact.path ?? 'missing-target'}`),
    ];
  });
}

function blocked(reasons: string[]): ImplementationPublishabilityResult {
  return {
    status: 'blocked',
    reasons,
    changedFiles: [],
    skippedChecks: [],
    residualRisks: [],
    commits: [],
  };
}

function formatCodexExitReason(result: { stdout: string; stderr: string; exitCode: number }): string {
  const output = [result.stderr, result.stdout]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join('\n');
  const timeoutLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .reverse()
    .find((line) => /timed out|timeout/iu.test(line));
  const detail = timeoutLine ?? truncate(output, 600);
  return detail
    ? `Codex exited with code ${result.exitCode}: ${truncate(detail, 600)}`
    : `Codex exited with code ${result.exitCode}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}
