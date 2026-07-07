import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { CodexCommandRunInput, CodexCommandRunResult } from '../codex/command-adapter.js';
import type { GitWorktreeManager, SessionCommitInfo } from '../git/worktree.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ShellCommandExecutor } from '../process/command.js';
import { mergeArtifacts, runConfiguredChecks } from './command-utils.js';
import { readScopedCompletionReport, type ScopedCompletionReport } from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import { evaluateReviewGates, shouldApplyVisualProofGate } from './review-gates.js';
import {
  validateChangedPaths,
  validateCompletionReportSafety,
  validateNoAgentOwnedGitPublication,
} from './safety.js';
import { evaluateScopeIsolation } from './scope-isolation-policy.js';
import { runRunnerVisualProofAdapter } from './visual-proof-runner.js';
import {
  runAcceptanceProofAdapter,
  type AcceptanceProofAttemptEvidence,
} from './acceptance-proof-runner.js';
import { runAcceptanceProofLoopAttempt } from './acceptance-proof-loop.js';
import {
  INCOMPLETE_AFTER_PROGRESS_REASON,
  MISSING_COMPLETION_REPORT_REASON,
  OPTIONAL_FIGMA_MCP_FAILURE_REASON,
  REQUIRED_FIGMA_MCP_FAILURE_REASON,
} from './rework-policy.js';

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
  codexResult: CodexCommandRunResult;
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

  let report: ScopedCompletionReport;
  if (input.codexResult.exitCode !== 0) {
    const figmaReason = formatFigmaMcpFailureReason(input.codexResult);
    if (figmaReason) {
      return blocked([figmaReason]);
    }

    if (!isIdleTimeoutResult(input.codexResult)) {
      return blocked([formatCodexExitReason(input.codexResult)]);
    }

    try {
      const reportResult = await readScopedCompletionReport(input.reportPath);
      if (reportResult.kind === 'missing') {
        const changeSet = await input.git.collectSessionChangeSet({
          worktreePath: input.worktreePath,
          baseHead: input.beforeHead,
        });
        const changedFiles = changeSet.changedPaths;
        if (changedFiles.length === 0) {
          return blocked(['Codex completed without file changes']);
        }

        const changedPathViolations = validateChangedPaths(changedFiles, input.config);
        if (changedPathViolations.length > 0) {
          return {
            status: 'blocked',
            reasons: changedPathViolations.map((violation) => violation.message),
            changedFiles,
            skippedChecks: [],
            residualRisks: [],
            commits: changeSet.commits,
          };
        }

        const scopeIsolation = evaluateScopeIsolation({
          config: input.config,
          issue: input.issue,
          changedFiles,
        });
        if (scopeIsolation.blockers.length > 0) {
          return {
            status: 'blocked',
            reasons: scopeIsolation.blockers,
            changedFiles,
            skippedChecks: [],
            residualRisks: [],
            commits: changeSet.commits,
          };
        }

        return {
          status: 'blocked',
          reasons: [INCOMPLETE_AFTER_PROGRESS_REASON],
          changedFiles,
          validation: [],
          skippedChecks: [],
          residualRisks: [],
          commits: changeSet.commits,
        };
      }
      report = reportResult.report;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid scoped completion report';
      return blocked([message]);
    }
  } else {
    try {
      const reportResult = await readScopedCompletionReport(input.reportPath);
      if (reportResult.kind === 'missing') {
        return blocked([MISSING_COMPLETION_REPORT_REASON]);
      }
      report = reportResult.report;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid scoped completion report';
      return blocked([message]);
    }
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
      skippedChecks: applicableSkippedChecks(input, report, changeSet.changedPaths),
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
  report = {
    ...report,
    skippedChecks: applicableSkippedChecks(input, report, changedFiles),
  };
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

  const scopeIsolation = evaluateScopeIsolation({
    config: input.config,
    issue: input.issue,
    changedFiles,
  });
  if (scopeIsolation.blockers.length > 0) {
    return {
      status: 'blocked',
      reasons: scopeIsolation.blockers,
      changedFiles,
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
    { phase: 'child', changedFiles },
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
  let proofChangeSet: typeof changeSet | undefined;
  const proofOutcome = await runAcceptanceProofLoopAttempt({
    config: input.config,
    issue: input.issue,
    worktreePath: input.worktreePath,
    beforeHead: input.beforeHead,
    initialChangedFiles: changedFiles,
    adaptiveAdapterAvailable: Boolean(input.acceptanceProof),
    executeAdaptiveProof: input.acceptanceProof
      ? async () => {
          await input.acceptanceProof?.onAttemptEvent?.({ status: 'started' });
          return runAcceptanceProofAdapter({
            config: input.config,
            issue: input.issue,
            targetRoot: input.acceptanceProof!.targetRoot,
            worktreePath: input.worktreePath,
            changedFiles,
            implementationReport: report,
            codexAdapter: input.acceptanceProof!.codexAdapter,
            sessionId: input.acceptanceProof!.sessionId,
            branchName: input.acceptanceProof!.branchName,
            workflowPromptText: input.acceptanceProof!.workflowPromptText,
          });
        }
      : undefined,
    executeAdaptiveProofRepair: input.acceptanceProof
      ? async ({ schemaErrors }) => runAcceptanceProofAdapter({
          config: input.config,
          issue: input.issue,
          targetRoot: input.acceptanceProof!.targetRoot,
          worktreePath: input.worktreePath,
          changedFiles,
          implementationReport: report,
          codexAdapter: input.acceptanceProof!.codexAdapter,
          sessionId: input.acceptanceProof!.sessionId,
          branchName: input.acceptanceProof!.branchName,
          workflowPromptText: input.acceptanceProof!.workflowPromptText,
          repairSchemaErrors: schemaErrors,
        })
      : undefined,
    executeCommandProof: async () => {
      const result = await runRunnerVisualProofAdapter({
        config: input.config,
        issue: input.issue,
        issueNumber: input.issue.number,
        targetRoot: input.targetRoot,
        worktreePath: input.worktreePath,
        changedFiles,
        report,
        shellExecutor: input.shellExecutor,
      });
      if (!result) {
        throw new Error('Acceptance proof planning selected command proof, but runner visual proof adapter did not execute.');
      }
      return result;
    },
    collectChangeSet: async ({ worktreePath, baseHead }) => {
      proofChangeSet = await input.git.collectSessionChangeSet({ worktreePath, baseHead });
      return proofChangeSet;
    },
    evaluateScope: ({ changedFiles: finalChangedFiles }) => evaluateScopeIsolation({
      config: input.config,
      issue: input.issue,
      changedFiles: finalChangedFiles,
    }),
    artifactExists: (path) => existsSync(join(input.worktreePath, path)),
  });
  if (proofOutcome.status !== 'skipped') {
    validation = [...validation, ...proofOutcome.validation];
    acceptanceProofAttempt = proofOutcome.evidence ?? acceptanceProofAttempt;
    if (acceptanceProofAttempt) {
      await input.acceptanceProof?.onAttemptEvent?.({
        status: acceptanceProofAttempt.status,
        evidence: acceptanceProofAttempt,
      });
    }
    report = {
      ...report,
      artifacts: mergeArtifacts(report.artifacts, proofOutcome.artifacts),
      residualRisks: [...report.residualRisks, ...proofOutcome.residualRisks],
    };
    residualRisks.push(...proofOutcome.residualRisks);
    changedFiles = proofOutcome.changedFiles;
    if (proofChangeSet) {
      changeSet = proofChangeSet;
    }
    if (proofOutcome.status === 'blocked') {
      return {
        status: 'blocked',
        reasons: proofOutcome.blockers,
        changedFiles,
        validation,
        skippedChecks: report.skippedChecks,
        residualRisks,
        commits: changeSet.commits,
        acceptanceProofAttempt,
      };
    }
  }

  const failedValidation = validation.filter((line) => line.status === 'failed' && !isStructuredTddRedEvidence(line));
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

function applicableSkippedChecks(
  input: Pick<ImplementationPublishabilityInput, 'config' | 'issue'>,
  report: ScopedCompletionReport,
  changedFiles: string[],
): string[] {
  if (shouldApplyVisualProofGate({ config: input.config, issue: input.issue, changedFiles })) {
    return report.skippedChecks;
  }

  return report.skippedChecks.filter((check) => !isRunnerOwnedVisualProofNonExecutionSkip(check));
}

function isRunnerOwnedVisualProofNonExecutionSkip(check: string): boolean {
  return /\brunner-owned\b[\s\S]*\bvisual[- ]proof\b[\s\S]*\bnot executed\b/iu.test(check);
}

function isStructuredTddRedEvidence(line: RunnerValidationLine): boolean {
  const evidence = line.evidence;
  return evidence?.kind === 'tdd-red-green'
    && evidence.red.status === 'failed'
    && evidence.red.command.trim().length > 0
    && evidence.red.summary.trim().length > 0
    && evidence.green.status === 'passed'
    && evidence.green.command.trim().length > 0
    && evidence.green.summary.trim().length > 0;
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

function formatCodexExitReason(result: CodexCommandRunResult): string {
  const figmaReason = formatFigmaMcpFailureReason(result);
  if (figmaReason) {
    return figmaReason;
  }
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

function isIdleTimeoutResult(result: CodexCommandRunResult): boolean {
  if (result.exitCode !== 124) {
    return false;
  }
  return `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => /^Command idle timed out after [1-9][0-9]*ms\.$/u.test(line));
}

function formatFigmaMcpFailureReason(result: CodexCommandRunResult): string | undefined {
  if (result.exitCode === 0 || result.figmaMcp?.enabled !== true) {
    return undefined;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  const looksLikeFigmaMcpFailure = /\bfigma\b[\s\S]{0,120}\b(?:mcp|server|tool|connection|connect|timeout|timed out|401|403|auth|unauthorized|forbidden|unavailable|failed)\b/iu.test(output)
    || /mcp_servers\.figma/iu.test(output);
  if (!looksLikeFigmaMcpFailure) {
    return undefined;
  }
  return result.figmaMcp.requirement === 'required'
    ? REQUIRED_FIGMA_MCP_FAILURE_REASON
    : OPTIONAL_FIGMA_MCP_FAILURE_REASON;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}
