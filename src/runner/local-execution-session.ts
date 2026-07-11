import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { CodexCommandRunInput, CodexCommandRunResult } from '../codex/command-adapter.js';
import type { GitWorktreeManager, SessionCommitInfo } from '../git/worktree.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ShellCommandExecutor } from '../process/command.js';
import { mergeArtifacts, runConfiguredChecks } from './command-utils.js';
import {
  readScopedCompletionReportDetailed,
  type ScopedCompletionReport,
  type ScopedCompletionReportDetailedReadResult,
} from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import { sessionPromptPath, writeDurablePrompt } from './prompt.js';
import { sessionLogPath } from './run-log.js';
import { evaluateReviewGates, shouldApplyVisualProofGate, type ReviewGateResult } from './review-gates.js';
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
  type RunnerBlocker,
} from './rework-policy.js';
import { cleanupSessionCodexHome, sessionCodexHomePath } from './session-home.js';

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
  git: Pick<GitWorktreeManager, 'collectSessionChangeSet' | 'isWorktreeClean' | 'commitAll'> &
    Partial<Pick<GitWorktreeManager, 'getHead'>>;
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
  reportRepair?: {
    targetRoot: string;
    sessionId: string;
    branchName: string;
    workflowPromptText: string;
    codexAdapter: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  };
}

export interface PublishabilityRepairAttempt {
  kind: 'completion-report' | 'evidence';
  status: 'passed' | 'blocked';
  reason: string;
  sessionId: string;
  promptPath: string;
  reportPath: string;
  logPath: string;
  blockers?: RunnerBlocker[];
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
      repairAttempts?: PublishabilityRepairAttempt[];
    }
  | {
      status: 'blocked';
      reasons: string[];
      blockers?: RunnerBlocker[];
      changedFiles: string[];
      validation?: RunnerValidationLine[];
      skippedChecks: string[];
      residualRisks: string[];
      commits: SessionCommitInfo[];
      acceptanceProofAttempt?: AcceptanceProofAttemptEvidence;
      repairAttempts?: PublishabilityRepairAttempt[];
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
  const repairAttempts: PublishabilityRepairAttempt[] = [];
  const publicationViolations = input.config.runner.allowAgentLocalCommits
    ? []
    : validateNoAgentOwnedGitPublication(input.beforeHead, input.afterHead);
  if (publicationViolations.length > 0) {
    return blocked(publicationViolations.map((violation) => violation.message));
  }

  let report: ScopedCompletionReport;
  const idleTimeout = isIdleTimeoutResult(input.codexResult);
  if (input.codexResult.exitCode !== 0) {
    const figmaReason = formatFigmaMcpFailureReason(input.codexResult);
    if (figmaReason) {
      return blocked([figmaReason]);
    }

    if (!idleTimeout) {
      return blocked([formatCodexExitReason(input.codexResult)]);
    }

    const reportResult = await readScopedCompletionReportDetailed(input.reportPath);
    const preparedReport = await resolveInitialReportRead(input, reportResult, {
      idleTimeout,
      repairAttempts,
    });
    if (preparedReport.kind === 'blocked') {
      return preparedReport.result;
    }
    report = preparedReport.report;
  } else {
    const reportResult = await readScopedCompletionReportDetailed(input.reportPath);
    const preparedReport = await resolveInitialReportRead(input, reportResult, {
      idleTimeout,
      repairAttempts,
    });
    if (preparedReport.kind === 'blocked') {
      return preparedReport.result;
    }
    report = preparedReport.report;
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
      ...repairAttemptsField(repairAttempts),
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
      ...repairAttemptsField(repairAttempts),
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
      ...repairAttemptsField(repairAttempts),
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
      ...repairAttemptsField(repairAttempts),
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
    implementationReport: report,
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
        ...repairAttemptsField(repairAttempts),
      };
    }
  }

  const isFailedValidation = (line: RunnerValidationLine) =>
    line.status === 'failed' && !isStructuredTddRedEvidence(line);
  const failedReportValidation = validation
    .slice(0, validationBeforeChecks)
    .filter(isFailedValidation);
  if (failedReportValidation.length > 0) {
    residualRisks.push('One or more reported validation checks failed.');
    return {
      status: 'blocked',
      reasons: [
        'One or more reported validation checks failed.',
        ...failedReportValidation.map((line) => `${line.command}: ${line.status} - ${line.summary}`),
      ],
      changedFiles,
      validation,
      skippedChecks: report.skippedChecks,
      residualRisks,
      commits: changeSet.commits,
      acceptanceProofAttempt,
      ...repairAttemptsField(repairAttempts),
    };
  }
  const failedConfiguredCheckWarnings = validation
    .slice(validationBeforeChecks)
    .filter(isFailedValidation)
    .map((line) => `Configured check warning: ${line.command} - ${line.summary}`);
  if (failedConfiguredCheckWarnings.length > 0) {
    residualRisks.push(...failedConfiguredCheckWarnings);
    report = {
      ...report,
      residualRisks: [...report.residualRisks, ...failedConfiguredCheckWarnings],
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
  let reviewGateWarnings = reviewGate.warnings;
  if (!reviewGate.ok) {
    const evidenceRepair = await maybeRunEvidenceReportRepair(input, {
      report,
      reviewGate,
      changedFiles,
      changeSet,
      validation,
      residualRisks,
      acceptanceProofAttempt,
      repairAttempts,
    });
    if (evidenceRepair.kind === 'publish-ready') {
      report = evidenceRepair.report;
      validation = evidenceRepair.validation;
      reviewGateWarnings = evidenceRepair.reviewWarnings;
    } else if (evidenceRepair.kind === 'blocked') {
      return evidenceRepair.result;
    } else {
      return {
        status: 'blocked',
        reasons: reviewGate.reasons,
        blockers: reviewGate.blockers,
        changedFiles,
        validation,
        skippedChecks: report.skippedChecks,
        residualRisks,
        commits: changeSet.commits,
        acceptanceProofAttempt,
        ...repairAttemptsField(repairAttempts),
      };
    }
  }
  if (reviewGateWarnings.length > 0) {
    residualRisks.push(...reviewGateWarnings);
    report = {
      ...report,
      residualRisks: [...report.residualRisks, ...reviewGateWarnings],
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
    ...repairAttemptsField(repairAttempts),
  };
}

type InitialReportReadResolution =
  | { kind: 'valid'; report: ScopedCompletionReport }
  | { kind: 'blocked'; result: ImplementationPublishabilityResult };

async function resolveInitialReportRead(
  input: ImplementationPublishabilityInput,
  reportResult: ScopedCompletionReportDetailedReadResult,
  state: {
    idleTimeout: boolean;
    repairAttempts: PublishabilityRepairAttempt[];
  },
): Promise<InitialReportReadResolution> {
  if (reportResult.kind === 'valid') {
    return { kind: 'valid', report: reportResult.report };
  }

  const repair = state.idleTimeout
    ? { kind: 'not-eligible' as const }
    : await maybeRunCompletionReportRepair(input, reportResult, state.repairAttempts);
  if (repair.kind === 'valid') {
    return repair;
  }
  if (repair.kind === 'blocked') {
    return repair;
  }

  if (reportResult.kind === 'missing') {
    if (!state.idleTimeout) {
      return {
        kind: 'blocked',
        result: blocked(
          [MISSING_COMPLETION_REPORT_REASON],
          {
            blockers: [runnerBlocker(
              'missing-completion-report',
              MISSING_COMPLETION_REPORT_REASON,
              'completion-report',
              'completion-report',
            )],
            repairAttempts: state.repairAttempts,
          },
        ),
      };
    }

    const changeSet = repair.changeSet ?? await input.git.collectSessionChangeSet({
      worktreePath: input.worktreePath,
      baseHead: input.beforeHead,
    });
    const changedFiles = changeSet.changedPaths;
    if (changedFiles.length === 0) {
      return {
        kind: 'blocked',
        result: blocked(['Codex completed without file changes'], { repairAttempts: state.repairAttempts }),
      };
    }

    const changedPathViolations = validateChangedPaths(changedFiles, input.config);
    if (changedPathViolations.length > 0) {
      return {
        kind: 'blocked',
        result: blocked(
          changedPathViolations.map((violation) => violation.message),
          {
            changedFiles,
            commits: changeSet.commits,
            repairAttempts: state.repairAttempts,
          },
        ),
      };
    }

    const scopeIsolation = evaluateScopeIsolation({
      config: input.config,
      issue: input.issue,
      changedFiles,
    });
    if (scopeIsolation.blockers.length > 0) {
      return {
        kind: 'blocked',
        result: blocked(scopeIsolation.blockers, {
          changedFiles,
          commits: changeSet.commits,
          repairAttempts: state.repairAttempts,
        }),
      };
    }

    return {
      kind: 'blocked',
      result: blocked([INCOMPLETE_AFTER_PROGRESS_REASON], {
        changedFiles,
        validation: [],
        commits: changeSet.commits,
        repairAttempts: state.repairAttempts,
        blockers: [runnerBlocker(
          'incomplete-after-progress',
          INCOMPLETE_AFTER_PROGRESS_REASON,
          'recovery',
          'implementation-rework',
        )],
      }),
    };
  }

  return {
    kind: 'blocked',
    result: blocked([reportResult.message], {
      blockers: [runnerBlocker(
        'invalid-completion-report',
        reportResult.message,
        'completion-report',
        'completion-report',
      )],
      repairAttempts: state.repairAttempts,
    }),
  };
}

type CompletionReportRepairResolution =
  | { kind: 'valid'; report: ScopedCompletionReport }
  | { kind: 'blocked'; result: ImplementationPublishabilityResult }
  | {
      kind: 'not-eligible';
      changeSet?: Awaited<ReturnType<GitWorktreeManager['collectSessionChangeSet']>>;
    };

async function maybeRunCompletionReportRepair(
  input: ImplementationPublishabilityInput,
  reportIssue: Exclude<ScopedCompletionReportDetailedReadResult, { kind: 'valid' }>,
  repairAttempts: PublishabilityRepairAttempt[],
): Promise<CompletionReportRepairResolution> {
  const changeSet = await input.git.collectSessionChangeSet({
    worktreePath: input.worktreePath,
    baseHead: input.beforeHead,
  });
  const changedFiles = changeSet.changedPaths;
  if (changedFiles.length === 0) {
    return { kind: 'not-eligible', changeSet };
  }

  const changedPathViolations = validateChangedPaths(changedFiles, input.config);
  if (changedPathViolations.length > 0) {
    return {
      kind: 'blocked',
      result: blocked(changedPathViolations.map((violation) => violation.message), {
        changedFiles,
        commits: changeSet.commits,
      }),
    };
  }

  const scopeIsolation = evaluateScopeIsolation({
    config: input.config,
    issue: input.issue,
    changedFiles,
  });
  if (scopeIsolation.blockers.length > 0) {
    return {
      kind: 'blocked',
      result: blocked(scopeIsolation.blockers, {
        changedFiles,
        commits: changeSet.commits,
      }),
    };
  }

  if (!input.reportRepair || !input.git.getHead) {
    return { kind: 'not-eligible', changeSet };
  }

  const repairSessionId = `${input.reportRepair.sessionId}-completion-report-repair`;
  const promptPath = sessionPromptPath({
    targetRoot: input.reportRepair.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: repairSessionId,
  });
  const logPath = sessionLogPath({
    targetRoot: input.reportRepair.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: repairSessionId,
  });
  const repairAttemptBase = {
    kind: 'completion-report' as const,
    sessionId: repairSessionId,
    promptPath,
    reportPath: input.reportPath,
    logPath,
  };
  const preRepairHead = await input.git.getHead(input.worktreePath);
  const protectedBefore = await captureRepairProtectedFingerprint(input, changeSet);
  const promptText = buildCompletionReportRepairPrompt({
    input,
    reportIssue,
    changedFiles,
  });
  await writeDurablePrompt({
    targetRoot: input.reportRepair.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: repairSessionId,
    promptText,
  });
  const isolatedHomePath = sessionCodexHomePath({
    targetRoot: input.reportRepair.targetRoot,
    sessionId: repairSessionId,
  });

  let repairResult: CodexCommandRunResult;
  try {
    repairResult = await input.reportRepair.codexAdapter.run({
      targetRoot: input.reportRepair.targetRoot,
      config: input.config,
      worktreePath: input.worktreePath,
      promptPath,
      promptText,
      reportPath: input.reportPath,
      isolatedHomePath,
      issueNumber: input.issue.number,
      sessionId: repairSessionId,
      branchName: input.reportRepair.branchName,
      phase: 'scoped-issue',
      logPath,
      env: {
        CODEX_ORCHESTRATOR_REPAIR_MODE: 'completion-report',
      },
    });
  } finally {
    await cleanupSessionCodexHome(isolatedHomePath);
  }

  if (repairResult.exitCode !== 0) {
    const reason = `Completion report repair failed: ${formatCodexExitReason(repairResult)}`;
    const blockers = [runnerBlocker('invalid-completion-report', reason, 'completion-report', 'none')];
    repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles,
        commits: changeSet.commits,
        blockers,
        repairAttempts,
      }),
    };
  }

  const postRepairHead = await input.git.getHead(input.worktreePath);
  if (postRepairHead !== preRepairHead) {
    const reason = 'Completion report repair created or moved HEAD; repair sessions must not create local commits.';
    const blockers = [runnerBlocker('publication-violation', reason, 'safety', 'none')];
    repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles,
        commits: changeSet.commits,
        blockers,
        repairAttempts,
      }),
    };
  }

  const postChangeSet = await input.git.collectSessionChangeSet({
    worktreePath: input.worktreePath,
    baseHead: input.beforeHead,
  });
  const protectedAfter = await captureRepairProtectedFingerprint(input, postChangeSet);
  if (protectedAfter !== protectedBefore) {
    const reason = 'Completion report repair changed protected worktree content; repair may only write the completion report JSON.';
    const blockers = [runnerBlocker('destructive-or-production-action', reason, 'safety', 'none')];
    repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles: postChangeSet.changedPaths,
        commits: postChangeSet.commits,
        blockers,
        repairAttempts,
      }),
    };
  }

  const repairedReport = await readScopedCompletionReportDetailed(input.reportPath);
  if (repairedReport.kind === 'missing') {
    const reason = `${MISSING_COMPLETION_REPORT_REASON} Completion report repair did not write CODEX_ORCHESTRATOR_REPORT_FILE.`;
    const blockers = [runnerBlocker('missing-completion-report', reason, 'completion-report', 'none')];
    repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles,
        commits: changeSet.commits,
        blockers,
        repairAttempts,
      }),
    };
  }
  if (repairedReport.kind === 'invalid') {
    const reason = `Completion report repair wrote an invalid report: ${repairedReport.message}`;
    const blockers = [runnerBlocker('invalid-completion-report', reason, 'completion-report', 'none')];
    repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles,
        commits: changeSet.commits,
        blockers,
        repairAttempts,
      }),
    };
  }

  repairAttempts.push({ ...repairAttemptBase, status: 'passed', reason: 'Completion report repair wrote a valid scoped report.' });
  return { kind: 'valid', report: repairedReport.report };
}

type EvidenceReportRepairResolution =
  | {
      kind: 'publish-ready';
      report: ScopedCompletionReport;
      validation: RunnerValidationLine[];
      reviewWarnings: string[];
    }
  | { kind: 'blocked'; result: ImplementationPublishabilityResult }
  | { kind: 'not-eligible' };

async function maybeRunEvidenceReportRepair(
  input: ImplementationPublishabilityInput,
  context: {
    report: ScopedCompletionReport;
    reviewGate: ReviewGateResult;
    changedFiles: string[];
    changeSet: Awaited<ReturnType<GitWorktreeManager['collectSessionChangeSet']>>;
    validation: RunnerValidationLine[];
    residualRisks: string[];
    acceptanceProofAttempt?: AcceptanceProofAttemptEvidence;
    repairAttempts: PublishabilityRepairAttempt[];
  },
): Promise<EvidenceReportRepairResolution> {
  const repairableBlockers = (context.reviewGate.blockers ?? [])
    .filter((blocker) => blocker.repair === 'evidence'
      && (blocker.key === 'missing-quality-gate-evidence' || blocker.key === 'risk-routing-policy'));
  if (repairableBlockers.length === 0 || !input.reportRepair || !input.git.getHead) {
    return { kind: 'not-eligible' };
  }

  const repairSessionId = `${input.reportRepair.sessionId}-evidence-repair`;
  const promptPath = sessionPromptPath({
    targetRoot: input.reportRepair.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: repairSessionId,
  });
  const logPath = sessionLogPath({
    targetRoot: input.reportRepair.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: repairSessionId,
  });
  const repairAttemptBase = {
    kind: 'evidence' as const,
    sessionId: repairSessionId,
    promptPath,
    reportPath: input.reportPath,
    logPath,
  };
  const preRepairHead = await input.git.getHead(input.worktreePath);
  const protectedBefore = await captureRepairProtectedFingerprint(input, context.changeSet);
  const promptText = buildEvidenceReportRepairPrompt({
    input,
    changedFiles: context.changedFiles,
    reviewGate: context.reviewGate,
    validation: context.validation,
  });
  await writeDurablePrompt({
    targetRoot: input.reportRepair.targetRoot,
    config: input.config,
    issueNumber: input.issue.number,
    sessionId: repairSessionId,
    promptText,
  });
  const isolatedHomePath = sessionCodexHomePath({
    targetRoot: input.reportRepair.targetRoot,
    sessionId: repairSessionId,
  });

  let repairResult: CodexCommandRunResult;
  try {
    repairResult = await input.reportRepair.codexAdapter.run({
      targetRoot: input.reportRepair.targetRoot,
      config: input.config,
      worktreePath: input.worktreePath,
      promptPath,
      promptText,
      reportPath: input.reportPath,
      isolatedHomePath,
      issueNumber: input.issue.number,
      sessionId: repairSessionId,
      branchName: input.reportRepair.branchName,
      phase: 'scoped-issue',
      logPath,
      env: {
        CODEX_ORCHESTRATOR_REPAIR_MODE: 'evidence',
      },
    });
  } finally {
    await cleanupSessionCodexHome(isolatedHomePath);
  }

  if (repairResult.exitCode !== 0) {
    const reason = `Evidence repair failed: ${formatCodexExitReason(repairResult)}`;
    const blockers = [runnerBlocker('missing-quality-gate-evidence', reason, 'review-gate', 'none')];
    context.repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles: context.changedFiles,
        validation: context.validation,
        skippedChecks: context.report.skippedChecks,
        residualRisks: context.residualRisks,
        commits: context.changeSet.commits,
        acceptanceProofAttempt: context.acceptanceProofAttempt,
        blockers,
        repairAttempts: context.repairAttempts,
      }),
    };
  }

  const postRepairHead = await input.git.getHead(input.worktreePath);
  if (postRepairHead !== preRepairHead) {
    const reason = 'Evidence repair created or moved HEAD; repair sessions must not create local commits.';
    const blockers = [runnerBlocker('publication-violation', reason, 'safety', 'none')];
    context.repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles: context.changedFiles,
        validation: context.validation,
        skippedChecks: context.report.skippedChecks,
        residualRisks: context.residualRisks,
        commits: context.changeSet.commits,
        acceptanceProofAttempt: context.acceptanceProofAttempt,
        blockers,
        repairAttempts: context.repairAttempts,
      }),
    };
  }

  const postChangeSet = await input.git.collectSessionChangeSet({
    worktreePath: input.worktreePath,
    baseHead: input.beforeHead,
  });
  const protectedAfter = await captureRepairProtectedFingerprint(input, postChangeSet);
  if (protectedAfter !== protectedBefore) {
    const reason = 'Evidence repair changed protected worktree content; repair may only write corrected completion report evidence.';
    const blockers = [runnerBlocker('destructive-or-production-action', reason, 'safety', 'none')];
    context.repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles: postChangeSet.changedPaths,
        validation: context.validation,
        skippedChecks: context.report.skippedChecks,
        residualRisks: context.residualRisks,
        commits: postChangeSet.commits,
        acceptanceProofAttempt: context.acceptanceProofAttempt,
        blockers,
        repairAttempts: context.repairAttempts,
      }),
    };
  }

  const repairedRead = await readScopedCompletionReportDetailed(input.reportPath);
  if (repairedRead.kind !== 'valid') {
    const reason = repairedRead.kind === 'missing'
      ? `${MISSING_COMPLETION_REPORT_REASON} Evidence repair did not write CODEX_ORCHESTRATOR_REPORT_FILE.`
      : `Evidence repair wrote an invalid report: ${repairedRead.message}`;
    const blockers = [runnerBlocker(
      repairedRead.kind === 'missing' ? 'missing-completion-report' : 'invalid-completion-report',
      reason,
      'completion-report',
      'none',
    )];
    context.repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles: context.changedFiles,
        validation: context.validation,
        skippedChecks: context.report.skippedChecks,
        residualRisks: context.residualRisks,
        commits: context.changeSet.commits,
        acceptanceProofAttempt: context.acceptanceProofAttempt,
        blockers,
        repairAttempts: context.repairAttempts,
      }),
    };
  }
  if (repairedRead.report.status !== context.report.status) {
    const reason = 'Evidence repair changed completion report status; repair may only correct review-gate evidence.';
    const blockers = [runnerBlocker('missing-quality-gate-evidence', reason, 'review-gate', 'none')];
    context.repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked([reason], {
        changedFiles: context.changedFiles,
        validation: context.validation,
        skippedChecks: context.report.skippedChecks,
        residualRisks: context.residualRisks,
        commits: context.changeSet.commits,
        acceptanceProofAttempt: context.acceptanceProofAttempt,
        blockers,
        repairAttempts: context.repairAttempts,
      }),
    };
  }

  const externalValidation = context.validation.slice(context.report.validation.length);
  const repairedReport = {
    ...context.report,
    ...repairedRead.report,
    skippedChecks: applicableSkippedChecks(input, repairedRead.report, context.changedFiles),
    artifacts: mergeArtifacts(repairedRead.report.artifacts, context.report.artifacts),
  };
  const repairedValidation = [...repairedReport.validation, ...externalValidation];
  const repairedReviewGate = evaluateReviewGates({
    config: input.config,
    issue: input.issue,
    changedFiles: context.changedFiles,
    validation: repairedValidation,
    skippedChecks: repairedReport.skippedChecks,
    report: repairedReport,
    worktreePath: input.worktreePath,
  });
  if (!repairedReviewGate.ok) {
    const reason = `Evidence repair did not satisfy review gates: ${repairedReviewGate.reasons.join('; ')}`;
    const blockers = repairedReviewGate.blockers ?? repairableBlockers;
    context.repairAttempts.push({ ...repairAttemptBase, status: 'blocked', reason, blockers });
    return {
      kind: 'blocked',
      result: blocked(repairedReviewGate.reasons, {
        changedFiles: context.changedFiles,
        validation: repairedValidation,
        skippedChecks: repairedReport.skippedChecks,
        residualRisks: context.residualRisks,
        commits: context.changeSet.commits,
        acceptanceProofAttempt: context.acceptanceProofAttempt,
        blockers,
        repairAttempts: context.repairAttempts,
      }),
    };
  }

  context.repairAttempts.push({ ...repairAttemptBase, status: 'passed', reason: 'Evidence repair wrote review-gate evidence that passed rerun review gates.' });
  return {
    kind: 'publish-ready',
    report: repairedReport,
    validation: repairedValidation,
    reviewWarnings: repairedReviewGate.warnings,
  };
}

async function captureRepairProtectedFingerprint(
  input: ImplementationPublishabilityInput,
  changeSet: Awaited<ReturnType<GitWorktreeManager['collectSessionChangeSet']>>,
): Promise<string> {
  const reportRelativePath = relativeReportPathInsideWorktree(input);
  const entries: Array<{ path: string; state: 'file' | 'missing'; sha256?: string }> = [];
  for (const changedPath of changeSet.changedPaths) {
    if (reportRelativePath && changedPath === reportRelativePath) {
      continue;
    }
    const absolutePath = join(input.worktreePath, changedPath);
    try {
      const content = await readFile(absolutePath);
      entries.push({
        path: changedPath,
        state: 'file',
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        entries.push({ path: changedPath, state: 'missing' });
        continue;
      }
      throw error;
    }
  }
  return JSON.stringify(entries);
}

function relativeReportPathInsideWorktree(input: ImplementationPublishabilityInput): string | undefined {
  const worktreePath = resolve(input.worktreePath);
  const reportPath = resolve(input.reportPath);
  const relativePath = relative(worktreePath, reportPath);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.split(/[\\/]+/u).join('/');
}

function buildCompletionReportRepairPrompt(input: {
  input: ImplementationPublishabilityInput;
  reportIssue: Exclude<ScopedCompletionReportDetailedReadResult, { kind: 'valid' }>;
  changedFiles: string[];
}): string {
  const issue = input.input.issue;
  const reportIssueText = input.reportIssue.kind === 'missing'
    ? 'The completion report is missing.'
    : [
        input.reportIssue.message,
        ...input.reportIssue.errors,
        input.reportIssue.rawContent ? `Raw invalid report content (truncated):\n${input.reportIssue.rawContent}` : undefined,
      ].filter(Boolean).join('\n');

  return [
    '# Completion Report Repair',
    '',
    'Repair only the completion report JSON at CODEX_ORCHESTRATOR_REPORT_FILE.',
    'Do not edit product files. Do not edit GitHub. Do not create commits.',
    'Use the changed files, issue text, schema errors/raw content, and validation/check evidence to write the corrected scoped completion report.',
    'Final response raw JSON only.',
    '',
    `Issue #${issue.number}: ${issue.title}`,
    issue.body,
    '',
    'Changed files:',
    ...input.changedFiles.map((file) => `- ${file}`),
    '',
    'Report problem:',
    reportIssueText,
    '',
    'Original workflow prompt:',
    input.input.reportRepair?.workflowPromptText ?? '',
  ].join('\n');
}

function buildEvidenceReportRepairPrompt(input: {
  input: ImplementationPublishabilityInput;
  changedFiles: string[];
  reviewGate: ReviewGateResult;
  validation: RunnerValidationLine[];
}): string {
  const issue = input.input.issue;
  return [
    '# Evidence Repair',
    '',
    'Repair only missing review-gate evidence in the completion report JSON at CODEX_ORCHESTRATOR_REPORT_FILE.',
    'Do not edit product files. Do not edit GitHub. Do not create commits.',
    'Only correct completion report JSON evidence fields such as validation, skippedChecks, residualRisks, and reviewHandoff.',
    'You may run read-only review commands or review skills if needed, but final publication still depends on the runner rerunning gates.',
    'Final response raw JSON only.',
    '',
    `Issue #${issue.number}: ${issue.title}`,
    issue.body,
    '',
    'Changed files:',
    ...input.changedFiles.map((file) => `- ${file}`),
    '',
    'Review gate reasons to repair:',
    ...input.reviewGate.reasons.map((reason) => `- ${reason}`),
    '',
    'Typed blocker keys:',
    ...(input.reviewGate.blockers ?? []).map((blocker) => `- ${blocker.key}: ${blocker.reason}`),
    '',
    'Current validation evidence:',
    ...input.validation.map((line) => `- ${line.command}: ${line.status} - ${line.summary}`),
    '',
    'Original workflow prompt:',
    input.input.reportRepair?.workflowPromptText ?? '',
  ].join('\n');
}

function runnerBlocker(
  key: RunnerBlocker['key'],
  reason: string,
  source: RunnerBlocker['source'],
  repair: RunnerBlocker['repair'],
): RunnerBlocker {
  return { key, reason, source, repair };
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

function blocked(
  reasons: string[],
  options: {
    blockers?: RunnerBlocker[];
    changedFiles?: string[];
    validation?: RunnerValidationLine[];
    skippedChecks?: string[];
    residualRisks?: string[];
    commits?: SessionCommitInfo[];
    repairAttempts?: PublishabilityRepairAttempt[];
    acceptanceProofAttempt?: AcceptanceProofAttemptEvidence;
  } = {},
): ImplementationPublishabilityResult {
  const result: Extract<ImplementationPublishabilityResult, { status: 'blocked' }> = {
    status: 'blocked',
    reasons,
    changedFiles: options.changedFiles ?? [],
    skippedChecks: options.skippedChecks ?? [],
    residualRisks: options.residualRisks ?? [],
    commits: options.commits ?? [],
  };
  if (options.validation) {
    result.validation = options.validation;
  }
  if (options.blockers && options.blockers.length > 0) {
    result.blockers = options.blockers;
  }
  if (options.repairAttempts && options.repairAttempts.length > 0) {
    result.repairAttempts = options.repairAttempts;
  }
  if (options.acceptanceProofAttempt) {
    result.acceptanceProofAttempt = options.acceptanceProofAttempt;
  }
  return result;
}

function repairAttemptsField(
  repairAttempts: PublishabilityRepairAttempt[],
): { repairAttempts?: PublishabilityRepairAttempt[] } {
  return repairAttempts.length > 0 ? { repairAttempts } : {};
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
