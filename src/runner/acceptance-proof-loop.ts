import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ProofPlan, ProofPlanMode, ScopedCompletionReport } from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import {
  buildAcceptanceProofReportOutcome,
  buildBlockedAcceptanceProofOutcome,
  buildForbiddenAcceptanceProofDiffEvidence,
  classifyAcceptanceProofDiff,
  createAcceptanceProofDiffCapture,
  readAcceptanceProofReport,
  type AcceptanceProofAttemptEvidence,
} from './acceptance-proof.js';
import { resolveAcceptanceProofStrategy } from './proof-strategy.js';
import {
  acceptanceProofApplies,
  changedFilesVisualDispatchTarget,
  isNonVisualProofMode,
  proofPlanDispatchTarget,
  proofStrategyDispatchTarget,
  runnerVisualProofPolicy,
  visualProofDesirable,
  visualStrategyDowngradeBlocker,
  type VisualProofDispatchTarget,
} from './proof-routing.js';

export type AcceptanceProofPlanKind = 'skip' | 'adaptive' | 'command' | 'report-validation' | 'blocked';

export interface AcceptanceProofPlan {
  kind: AcceptanceProofPlanKind;
  applies: boolean;
  reason: string;
  commandTemplate?: string;
  blocker?: string;
}

export interface AcceptanceProofPlanInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
  adaptiveAdapterAvailable: boolean;
  implementationReport: ScopedCompletionReport;
}

export interface AcceptanceProofAdapterResult {
  adapterKind: 'adaptive' | 'command';
  command: string;
  exitCode: number;
  outputSummary: string;
  promptPath?: string;
  reportPath: string;
  artifactDir: string;
  artifactPaths: string[];
  preliminaryArtifacts: ScopedCompletionReport['artifacts'];
  residualRisks: string[];
}

export interface AcceptanceProofRepairInput {
  reportPath: string;
  artifactDir: string;
  schemaErrors: string[];
  previousResult: AcceptanceProofAdapterResult;
}

export interface AcceptanceProofLoopOutcome {
  status: 'passed' | 'blocked' | 'skipped';
  changedFiles: string[];
  validation: RunnerValidationLine[];
  artifacts: ScopedCompletionReport['artifacts'];
  residualRisks: string[];
  blockers: string[];
  scopeBlockers: string[];
  evidence?: AcceptanceProofAttemptEvidence;
  proofReportPath?: string;
  proofArtifactDir?: string;
}

export interface AcceptanceProofLoopChangeSet {
  changedPaths: string[];
}

export interface AcceptanceProofScopeResult {
  blockers: string[];
}

export interface RunAcceptanceProofLoopAttemptInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  worktreePath: string;
  beforeHead: string;
  initialChangedFiles: string[];
  implementationReport: ScopedCompletionReport;
  adaptiveAdapterAvailable: boolean;
  executeAdaptiveProof?: () => Promise<AcceptanceProofAdapterResult>;
  executeAdaptiveProofRepair?: (input: AcceptanceProofRepairInput) => Promise<AcceptanceProofAdapterResult>;
  executeCommandProof?: () => Promise<AcceptanceProofAdapterResult>;
  collectChangeSet: (input: { worktreePath: string; baseHead: string }) => Promise<AcceptanceProofLoopChangeSet>;
  evaluateScope: (input: { changedFiles: string[] }) => AcceptanceProofScopeResult;
  artifactExists?: (path: string) => boolean;
}

export type ProofPlanValidationResult =
  | {
    ok: true;
    proofPlan: ProofPlan;
    proofMode: ProofPlanMode;
    dispatchTarget: VisualProofDispatchTarget;
    reason: string;
  }
  | {
    ok: false;
    blocker: string;
    retryable: boolean;
  };

export function planAcceptanceProofAttempt(input: AcceptanceProofPlanInput): AcceptanceProofPlan {
  const proofStrategy = resolveAcceptanceProofStrategy({ config: input.config, issue: input.issue }).strategy;
  const proofPlanValidation = validateProofPlan(input);
  if (!proofPlanValidation.ok) {
    return {
      kind: 'blocked',
      applies: true,
      reason: proofPlanValidation.blocker,
      blocker: proofPlanValidation.blocker,
    };
  }
  const proofPlan = proofPlanValidation.proofPlan;
  const commandTemplate = runnerVisualProofPolicy(input.config).commandTemplate;
  const desirable = visualProofDesirable(input, proofStrategy);
  const applies = acceptanceProofApplies(input, proofStrategy, desirable);

  if (proofPlan.mode === 'none') {
    if (!applies || proofStrategy === 'none') {
      return {
        kind: 'skip',
        applies: false,
        reason: 'proofPlan mode none disables acceptance proof',
      };
    }
    return {
      kind: 'blocked',
      applies: true,
      reason: 'Invalid proofPlan: none cannot satisfy required acceptance proof',
      blocker: 'Invalid proofPlan: none cannot satisfy required acceptance proof',
    };
  }

  if (isNonVisualProofMode(proofPlan.mode)) {
    if (!input.config.reviewGates.acceptanceProof.enabled) {
      return {
        kind: 'skip',
        applies: false,
        reason: 'acceptance proof is disabled',
      };
    }
    return {
      kind: 'report-validation',
      applies: true,
      reason: 'agent-authored non-visual proof plan accepted',
    };
  }

  if (!applies) {
    return {
      kind: 'skip',
      applies: false,
      reason: proofStrategy === 'none' || proofStrategy === 'non-visual-smoke'
        ? 'proof strategy disables browser/mobile visual proof'
        : 'acceptance proof does not apply',
    };
  }

  if (input.adaptiveAdapterAvailable && (hasAcceptanceProofProfile(input.config) || !commandTemplate)) {
    return {
      kind: 'adaptive',
      applies: true,
      reason: 'adaptive acceptance proof is available',
    };
  }

  if (commandTemplate) {
    return {
      kind: 'command',
      applies: true,
      reason: 'runner-owned acceptance proof command is available',
      commandTemplate,
    };
  }

  return {
    kind: 'skip',
    applies: true,
    reason: 'acceptance proof applies but no adaptive adapter or runner command is available',
  };
}

export function validateProofPlan(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
  implementationReport: ScopedCompletionReport;
}): ProofPlanValidationResult {
  const proofPlan = input.implementationReport.proofPlan;
  const proofStrategy = resolveAcceptanceProofStrategy({ config: input.config, issue: input.issue }).strategy;
  const dispatchTarget = proofPlanDispatchTarget(proofPlan);
  const inferredDispatchTarget = proofStrategyDispatchTarget(input, proofStrategy);
  const changedFilesVisualTarget = changedFilesVisualDispatchTarget(input);

  if (proofStrategy === 'mobile-visual' && proofPlan.mode !== 'mobile-visual') {
    return { ok: false, blocker: visualStrategyDowngradeBlocker('mobile'), retryable: true };
  }
  if (proofStrategy === 'browser-visual' && proofPlan.mode !== 'browser-visual') {
    return { ok: false, blocker: visualStrategyDowngradeBlocker('browser'), retryable: true };
  }
  if (proofStrategy === 'visual' && dispatchTarget === 'none') {
    return { ok: false, blocker: 'Invalid proofPlan: non-visual proof cannot satisfy visual strategy', retryable: true };
  }
  if (proofStrategy === 'non-visual-smoke' && (proofPlan.mode === 'browser-visual' || proofPlan.mode === 'mobile-visual')) {
    return { ok: false, blocker: 'Invalid proofPlan: visual proof cannot satisfy non-visual proof strategy', retryable: true };
  }
  if (
    isNonVisualProofMode(proofPlan.mode)
    && (inferredDispatchTarget !== 'none' || changedFilesVisualTarget !== 'none')
  ) {
    const visualTarget = inferredDispatchTarget !== 'none' ? inferredDispatchTarget : changedFilesVisualTarget;
    if (visualTarget === 'none') {
      throw new Error('Expected visual proof target for non-visual proof plan downgrade.');
    }
    return {
      ok: false,
      blocker: visualStrategyDowngradeBlocker(visualTarget),
      retryable: true,
    };
  }

  return {
    ok: true,
    proofPlan,
    proofMode: proofPlan.mode,
    dispatchTarget,
    reason: `proofPlan mode ${proofPlan.mode} accepted`,
  };
}

export async function runAcceptanceProofLoopAttempt(
  input: RunAcceptanceProofLoopAttemptInput,
): Promise<AcceptanceProofLoopOutcome> {
  const plan = planAcceptanceProofAttempt({
    config: input.config,
    issue: input.issue,
    changedFiles: input.initialChangedFiles,
    adaptiveAdapterAvailable: input.adaptiveAdapterAvailable,
    implementationReport: input.implementationReport,
  });
  if (plan.kind === 'skip') {
    return {
      status: 'skipped',
      changedFiles: input.initialChangedFiles,
      validation: [],
      artifacts: [],
      residualRisks: [],
      blockers: [],
      scopeBlockers: [],
    };
  }
  if (plan.kind === 'blocked') {
    const blocker = plan.blocker ?? plan.reason;
    return {
      status: 'blocked',
      changedFiles: input.initialChangedFiles,
      validation: [{
        command: 'acceptance proof plan validation',
        status: 'failed',
        summary: blocker,
      }],
      artifacts: [],
      residualRisks: [],
      blockers: [blocker],
      scopeBlockers: [],
    };
  }
  if (plan.kind === 'report-validation') {
    return evaluateReportValidationProof({
      implementationReport: input.implementationReport,
      proofPlan: input.implementationReport.proofPlan,
      changedFiles: input.initialChangedFiles,
    });
  }

  const diffCapture = await createAcceptanceProofDiffCapture({
    worktreePath: input.worktreePath,
    changedFiles: input.initialChangedFiles,
  });
  let adapterResult = await executeSelectedAdapter(input, plan);
  adapterResult = await repairInvalidAdaptiveProofReport(input, adapterResult);
  const changeSet = await input.collectChangeSet({
    worktreePath: input.worktreePath,
    baseHead: input.beforeHead,
  });
  const changedFiles = changeSet.changedPaths;
  const proofPhaseChangedFiles = await diffCapture.collectProofPhaseChangedFiles(changedFiles);
  const reportOutcome = await evaluateAdapterReport({
    config: input.config,
    adapterResult,
    proofPhaseChangedFiles,
    artifactExists: input.artifactExists,
  });
  const proofDiff = classifyAcceptanceProofDiff(input.config, proofPhaseChangedFiles);
  const forbiddenDiffEvidence = proofDiff.forbiddenProductPaths.length > 0
    ? buildForbiddenAcceptanceProofDiffEvidence({
        command: adapterResult.command,
        baseEvidence: reportOutcome.evidence,
        reportPath: adapterResult.reportPath,
        artifactDir: adapterResult.artifactDir,
        artifactPaths: proofPhaseChangedFiles,
        forbiddenProductPaths: proofDiff.forbiddenProductPaths,
      })
    : undefined;
  const proofOutcome = forbiddenDiffEvidence
    ? {
        ...reportOutcome,
        status: 'blocked' as const,
        validation: forbiddenDiffEvidence.validation,
        blockers: forbiddenDiffEvidence.blockers,
        evidence: forbiddenDiffEvidence,
      }
    : reportOutcome;
  const scopeBlockers = input.evaluateScope({ changedFiles }).blockers;
  const scopeValidation = scopeBlockers.length > 0
    ? [{
        command: 'acceptance proof scope isolation',
        status: 'failed' as const,
        summary: scopeBlockers.join('; '),
      }]
    : [];
  const status = proofOutcome.status === 'passed' && scopeBlockers.length === 0 ? 'passed' : 'blocked';
  const blockers = uniqueStrings([...proofOutcome.blockers, ...scopeBlockers]);
  const residualRisks = uniqueStrings([
    ...adapterResult.residualRisks,
    ...proofOutcome.residualRisks,
  ]);
  const evidence = scopeBlockers.length > 0
    ? {
        ...proofOutcome.evidence,
        status: 'blocked' as const,
        validation: [...proofOutcome.evidence.validation, ...scopeValidation],
        blockers,
      }
    : proofOutcome.evidence;

  return {
    status,
    changedFiles,
    validation: [...proofOutcome.validation, ...scopeValidation],
    artifacts: mergeProofArtifacts(adapterResult.preliminaryArtifacts, proofOutcome.artifacts),
    residualRisks,
    blockers,
    scopeBlockers,
    evidence,
    proofReportPath: adapterResult.reportPath,
    proofArtifactDir: adapterResult.artifactDir,
  };
}

async function repairInvalidAdaptiveProofReport(
  input: RunAcceptanceProofLoopAttemptInput,
  adapterResult: AcceptanceProofAdapterResult,
): Promise<AcceptanceProofAdapterResult> {
  const maxSchemaRepairAttempts = 1;
  if (adapterResult.adapterKind !== 'adaptive' || !input.executeAdaptiveProofRepair) {
    return adapterResult;
  }

  let currentResult = adapterResult;
  for (let attempt = 0; attempt < maxSchemaRepairAttempts; attempt += 1) {
    const reportRead = await readAcceptanceProofReport(currentResult.reportPath);
    if (reportRead.kind !== 'invalid') {
      return currentResult;
    }
    currentResult = await input.executeAdaptiveProofRepair({
      reportPath: currentResult.reportPath,
      artifactDir: currentResult.artifactDir,
      schemaErrors: reportRead.errors,
      previousResult: currentResult,
    });
  }

  return currentResult;
}

async function executeSelectedAdapter(
  input: RunAcceptanceProofLoopAttemptInput,
  plan: AcceptanceProofPlan,
): Promise<AcceptanceProofAdapterResult> {
  if (plan.kind === 'adaptive') {
    if (!input.executeAdaptiveProof) {
      throw new Error('Acceptance proof plan selected adaptive proof, but no adaptive adapter callback was provided.');
    }
    return input.executeAdaptiveProof();
  }
  if (plan.kind === 'command') {
    if (!input.executeCommandProof) {
      throw new Error('Acceptance proof plan selected command proof, but no command adapter callback was provided.');
    }
    return input.executeCommandProof();
  }
  throw new Error(`Unsupported acceptance proof plan kind: ${plan.kind}`);
}

function evaluateReportValidationProof(input: {
  implementationReport: ScopedCompletionReport;
  proofPlan: ProofPlan;
  changedFiles: string[];
}): AcceptanceProofLoopOutcome {
  const blockers: string[] = [];
  if (input.proofPlan.validationCommands.length + input.proofPlan.requiredArtifacts.length === 0) {
    blockers.push('Invalid proofPlan: non-visual proof requires at least one validation command or required artifact.');
  }
  for (const command of input.proofPlan.validationCommands) {
    if (command.trim().length === 0) {
      blockers.push('Invalid proofPlan: validation command must be non-empty.');
      continue;
    }
    const match = input.implementationReport.validation.find((line) =>
      line.command.trim().length > 0 && line.command === command && line.status === 'passed',
    );
    if (!match) {
      blockers.push(`Invalid proofPlan: validation command was not reported as passed: ${command}`);
    }
  }

  const artifactTargets = new Set(
    input.implementationReport.artifacts.flatMap((artifact) => [artifact.path, artifact.url].filter(Boolean)),
  );
  for (const artifact of input.proofPlan.requiredArtifacts) {
    if (artifact.trim().length === 0) {
      blockers.push('Invalid proofPlan: required artifact must be non-empty.');
      continue;
    }
    if (!artifactTargets.has(artifact)) {
      blockers.push(`Invalid proofPlan: artifact was not reported: ${artifact}`);
    }
  }

  if (!input.implementationReport.reviewHandoff?.proofByAcceptanceCriteria.length) {
    blockers.push('Invalid proofPlan: reviewHandoff.proofByAcceptanceCriteria must map proof to acceptance criteria.');
  }

  const passed = blockers.length === 0;
  const validation: RunnerValidationLine[] = [{
    command: 'acceptance proof plan report validation',
    status: passed ? 'passed' : 'failed',
    summary: passed
      ? `agent-authored ${input.proofPlan.mode} proof plan passed report validation`
      : blockers.join('; '),
  }];
  const artifactPaths = input.implementationReport.artifacts
    .flatMap((artifact) => [artifact.path, artifact.url].filter((value): value is string => Boolean(value)));
  return {
    status: passed ? 'passed' : 'blocked',
    changedFiles: input.changedFiles,
    validation,
    artifacts: input.implementationReport.artifacts,
    residualRisks: [],
    blockers,
    scopeBlockers: [],
    evidence: {
      status: passed ? 'passed' : 'blocked',
      reportPath: 'completion-report:proofPlan',
      artifactDir: 'completion-report:artifacts',
      artifactPaths,
      validation,
      blockers,
      residualRisks: [],
    },
  };
}

async function evaluateAdapterReport(input: {
  config: CodexOrchestratorConfig;
  adapterResult: AcceptanceProofAdapterResult;
  proofPhaseChangedFiles: string[];
  artifactExists?: (path: string) => boolean;
}) {
  const reportRead = await readAcceptanceProofReport(input.adapterResult.reportPath);
  if (reportRead.kind === 'missing') {
    const validationSummary = missingReportValidationSummary(input.adapterResult);
    const blockers = input.adapterResult.exitCode === 0
      ? ['Acceptance proof blocked: proof session did not write CODEX_ORCHESTRATOR_PROOF_REPORT_PATH.']
      : [commandFailureSummary(input.adapterResult)];
    return buildBlockedAcceptanceProofOutcome({
      command: input.adapterResult.command,
      promptPath: input.adapterResult.promptPath,
      reportPath: input.adapterResult.reportPath,
      artifactDir: input.adapterResult.artifactDir,
      artifactPaths: input.adapterResult.artifactPaths,
      validationSummary,
      blockers,
      residualRisks: input.adapterResult.residualRisks,
      commandExitCode: input.adapterResult.exitCode,
      commandOutputSummary: input.adapterResult.outputSummary,
    });
  }
  if (reportRead.kind === 'invalid') {
    const validationSummary = invalidReportSchemaSummary(reportRead.errors);
    return buildBlockedAcceptanceProofOutcome({
      command: input.adapterResult.command,
      promptPath: input.adapterResult.promptPath,
      reportPath: input.adapterResult.reportPath,
      artifactDir: input.adapterResult.artifactDir,
      artifactPaths: input.adapterResult.artifactPaths,
      validationSummary,
      blockers: [validationSummary],
      residualRisks: input.adapterResult.residualRisks,
      commandExitCode: input.adapterResult.exitCode,
      commandOutputSummary: input.adapterResult.outputSummary,
    });
  }

  return buildAcceptanceProofReportOutcome({
    command: input.adapterResult.command,
    config: input.config,
    report: reportRead.report,
    proofPhaseChangedFiles: input.proofPhaseChangedFiles,
    artifactExists: input.artifactExists,
    commandExitCode: input.adapterResult.exitCode,
    commandOutputSummary: input.adapterResult.outputSummary,
    promptPath: input.adapterResult.promptPath,
    reportPath: input.adapterResult.reportPath,
    artifactDir: input.adapterResult.artifactDir,
    passedSummary: (report) => `${input.adapterResult.adapterKind === 'adaptive' ? 'Acceptance proof' : 'runner acceptance proof'} passed: ${report.criteria.length} criterion/criteria mapped to high-confidence artifacts.`,
    failedSummaryPrefix: input.adapterResult.adapterKind === 'adaptive' ? 'Acceptance proof' : 'runner acceptance proof',
  });
}

function invalidReportSchemaSummary(errors: string[]): string {
  return `Invalid acceptance proof report schema: ${errors.join('; ')}`;
}

function missingReportValidationSummary(adapterResult: AcceptanceProofAdapterResult): string {
  if (adapterResult.preliminaryArtifacts.length > 0) {
    return `runner acceptance proof failed: command completed and produced ${adapterResult.preliminaryArtifacts.length} artifact(s), but did not write a valid machine-readable acceptance proof report at ${adapterResult.reportPath}.`;
  }
  return 'Acceptance proof blocked: proof session did not write CODEX_ORCHESTRATOR_PROOF_REPORT_PATH.';
}

function commandFailureSummary(adapterResult: AcceptanceProofAdapterResult): string {
  const prefix = adapterResult.adapterKind === 'adaptive' ? 'Acceptance proof failed' : 'runner acceptance proof failed';
  return `${prefix}: ${adapterResult.outputSummary || `exit ${adapterResult.exitCode}`}`;
}

function hasAcceptanceProofProfile(config: CodexOrchestratorConfig): boolean {
  return Boolean(config.codex.profiles?.['acceptance-proof']);
}

function mergeProofArtifacts(
  left: ScopedCompletionReport['artifacts'],
  right: ScopedCompletionReport['artifacts'],
): ScopedCompletionReport['artifacts'] {
  const seen = new Set(left.map((artifact) => artifact.url ?? artifact.path ?? artifact.description));
  const merged = [...left];
  for (const artifact of right) {
    const key = artifact.url ?? artifact.path ?? artifact.description;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(artifact);
  }
  return merged;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
