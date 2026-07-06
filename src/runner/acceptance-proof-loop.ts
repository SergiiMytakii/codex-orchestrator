import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import { globMatches } from '../path-policy.js';
import type { ScopedCompletionReport } from './completion-report.js';
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

export type AcceptanceProofPlanKind = 'skip' | 'adaptive' | 'command';
export type VisualProofDispatchTarget = 'browser' | 'mobile' | 'none';
export type ProofRoutingAction = 'skip' | 'dispatch' | 'allow-non-visual' | 'error';

export interface AcceptanceProofPlan {
  kind: AcceptanceProofPlanKind;
  applies: boolean;
  reason: string;
  commandTemplate?: string;
}

export interface AcceptanceProofPlanInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
  adaptiveAdapterAvailable: boolean;
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
  adaptiveAdapterAvailable: boolean;
  executeAdaptiveProof?: () => Promise<AcceptanceProofAdapterResult>;
  executeAdaptiveProofRepair?: (input: AcceptanceProofRepairInput) => Promise<AcceptanceProofAdapterResult>;
  executeCommandProof?: () => Promise<AcceptanceProofAdapterResult>;
  collectChangeSet: (input: { worktreePath: string; baseHead: string }) => Promise<AcceptanceProofLoopChangeSet>;
  evaluateScope: (input: { changedFiles: string[] }) => AcceptanceProofScopeResult;
  artifactExists?: (path: string) => boolean;
}

export interface ProofRoutingDecision {
  applies: boolean;
  desirable: boolean;
  dispatchTarget: VisualProofDispatchTarget;
  proofStrategy: ReturnType<typeof resolveAcceptanceProofStrategy>['strategy'];
  action: ProofRoutingAction;
  reason: string;
}

export function planAcceptanceProofAttempt(input: AcceptanceProofPlanInput): AcceptanceProofPlan {
  const proofStrategy = resolveAcceptanceProofStrategy({ config: input.config, issue: input.issue }).strategy;
  const commandTemplate = runnerVisualProofPolicy(input.config).commandTemplate;
  const desirable = visualProofDesirable(input, proofStrategy);
  const applies = acceptanceProofApplies(input, proofStrategy, desirable);

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

export async function runAcceptanceProofLoopAttempt(
  input: RunAcceptanceProofLoopAttemptInput,
): Promise<AcceptanceProofLoopOutcome> {
  const plan = planAcceptanceProofAttempt({
    config: input.config,
    issue: input.issue,
    changedFiles: input.initialChangedFiles,
    adaptiveAdapterAvailable: input.adaptiveAdapterAvailable,
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

export function decideProofRouting(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): ProofRoutingDecision {
  const proofStrategy = resolveAcceptanceProofStrategy({ config: input.config, issue: input.issue }).strategy;
  const dispatchTarget = proofStrategyDispatchTarget(input, proofStrategy);
  const desirable = visualProofDesirable(input, proofStrategy);
  const plan = planAcceptanceProofAttempt({ ...input, adaptiveAdapterAvailable: false });

  if (proofStrategy === 'none' || proofStrategy === 'non-visual-smoke') {
    return {
      applies: plan.applies,
      desirable,
      dispatchTarget,
      proofStrategy,
      action: 'skip',
      reason: 'proof strategy disables browser/mobile visual proof',
    };
  }

  if (dispatchTarget === 'browser' || dispatchTarget === 'mobile') {
    return {
      applies: plan.applies,
      desirable,
      dispatchTarget,
      proofStrategy,
      action: 'dispatch',
      reason: `${dispatchTarget} proof target matched`,
    };
  }

  if (plan.applies && !desirable) {
    return {
      applies: true,
      desirable,
      dispatchTarget,
      proofStrategy,
      action: 'allow-non-visual',
      reason: 'acceptance proof applies without browser or mobile dispatch',
    };
  }

  if (plan.applies || desirable) {
    return {
      applies: plan.applies,
      desirable,
      dispatchTarget,
      proofStrategy,
      action: 'error',
      reason: 'visual proof is desirable but no browser or mobile dispatch target matched',
    };
  }

  return {
    applies: false,
    desirable,
    dispatchTarget,
    proofStrategy,
    action: 'error',
    reason: 'proof routing did not match issue text or changed paths',
  };
}

export function shouldApplyVisualProofGate(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): boolean {
  return decideProofRouting(input).applies;
}

export function classifyVisualProofDispatchTarget(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): VisualProofDispatchTarget {
  return decideProofRouting(input).dispatchTarget;
}

export function isVisualProofDesirable(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): boolean {
  return decideProofRouting(input).desirable;
}

export function runnerVisualProofPolicy(config: CodexOrchestratorConfig): {
  commandTemplate?: string;
  artifactDir: string;
  envPassthrough: string[];
  timeoutMs?: number;
  minScreenshotArtifacts: number;
  requireWhenDesirable: boolean;
  blockOnMissingProof: boolean;
  browserProof: {
    scenarioPath?: string;
    baseUrl?: string;
    strictConsoleErrors: boolean;
    strictNetworkFailures: boolean;
  };
} {
  const visualProof = config.reviewGates.visualProof;
  const acceptanceProof = config.reviewGates.acceptanceProof;
  const preferLegacyVisual = isLegacyVisualProofOverride(acceptanceProof, visualProof);
  const commandTemplate = preferLegacyVisual
    ? visualProof.runnerValidationCommand?.trim()
    : acceptanceProof.runnerValidationCommand?.trim() || visualProof.runnerValidationCommand?.trim();
  return {
    commandTemplate: commandTemplate || undefined,
    artifactDir: preferLegacyVisual ? visualProof.artifactDir : acceptanceProof.artifactDir,
    envPassthrough: preferLegacyVisual
      ? visualProof.envPassthrough ?? acceptanceProof.envPassthrough ?? []
      : acceptanceProof.envPassthrough?.length
        ? acceptanceProof.envPassthrough
        : visualProof.envPassthrough ?? [],
    timeoutMs: preferLegacyVisual
      ? visualProof.runnerTimeoutMs ?? acceptanceProof.runnerTimeoutMs
      : acceptanceProof.runnerTimeoutMs ?? visualProof.runnerTimeoutMs,
    minScreenshotArtifacts: visualProof.minScreenshotArtifacts,
    requireWhenDesirable: visualProof.requireWhenDesirable ?? false,
    blockOnMissingProof: !preferLegacyVisual,
    browserProof: {
      strictConsoleErrors: acceptanceProof.browserProof?.strictConsoleErrors ?? false,
      strictNetworkFailures: acceptanceProof.browserProof?.strictNetworkFailures ?? false,
      scenarioPath: acceptanceProof.browserProof?.scenarioPath,
      baseUrl: acceptanceProof.browserProof?.baseUrl,
    },
  };
}

function acceptanceProofApplies(
  input: AcceptanceProofPlanInput,
  proofStrategy: ReturnType<typeof resolveAcceptanceProofStrategy>['strategy'],
  desirable: boolean,
): boolean {
  const acceptanceProof = input.config.reviewGates.acceptanceProof;
  if (!acceptanceProof.enabled) {
    return false;
  }
  if (proofStrategy === 'none' || proofStrategy === 'non-visual-smoke') {
    return false;
  }
  if (proofStrategy === 'browser-visual' || proofStrategy === 'mobile-visual' || proofStrategy === 'visual') {
    return true;
  }

  const issueText = `${input.issue.title}\n${input.issue.body}`;
  const internalRunnerProofOnlyChange = input.changedFiles.length > 0
    && input.changedFiles.every(isInternalRunnerProofPath);
  const issueNeedsAcceptanceProof = !internalRunnerProofOnlyChange
    && acceptanceProof.issueTextPatterns.some((pattern) => regexMatches(pattern, issueText));
  const changedAcceptanceProofFiles = input.changedFiles.some((path) =>
    acceptanceProof.changedPathGlobs.some((pattern) => globMatches(pattern, path)),
  );
  return issueNeedsAcceptanceProof || changedAcceptanceProofFiles || desirable;
}

function proofStrategyDispatchTarget(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}, proofStrategy: ReturnType<typeof resolveAcceptanceProofStrategy>['strategy']): VisualProofDispatchTarget {
  const normalizedFiles = input.changedFiles.map((path) => path.replaceAll('\\', '/').replace(/^\.\//u, ''));
  const issueText = `${input.issue.title}\n${input.issue.body}`;
  if (proofStrategy === 'none' || proofStrategy === 'non-visual-smoke') {
    return 'none';
  }
  if (proofStrategy === 'browser-visual') {
    return 'browser';
  }
  if (proofStrategy === 'mobile-visual') {
    return 'mobile';
  }
  if (normalizedFiles.some(isMobileProofPath) || normalizedFiles.some((path) => isFlutterEntrypoint(path) && isMobileIssueText(issueText))) {
    return 'mobile';
  }
  if (normalizedFiles.some((path) => input.config.reviewGates.visualProof.changedPathGlobs.some((pattern) => globMatches(pattern, path)))) {
    return 'browser';
  }
  return 'none';
}

function visualProofDesirable(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}, proofStrategy: ReturnType<typeof resolveAcceptanceProofStrategy>['strategy']): boolean {
  const visualProof = input.config.reviewGates.visualProof;
  if (!visualProof.enabled) {
    return false;
  }

  const issueText = `${input.issue.title}\n${input.issue.body}`;
  const command = runnerVisualProofPolicy(input.config).commandTemplate;
  if (proofStrategy === 'none' || proofStrategy === 'non-visual-smoke') {
    return false;
  }
  if (proofStrategy === 'browser-visual' || proofStrategy === 'mobile-visual' || proofStrategy === 'visual') {
    return Boolean(command);
  }
  const internalRunnerProofOnlyChange = input.changedFiles.length > 0
    && input.changedFiles.every(isInternalRunnerProofPath);
  const issueNeedsVisualProof = visualProof.enabled
    && !internalRunnerProofOnlyChange
    && visualProof.issueTextPatterns.some((pattern) => regexMatches(pattern, issueText));
  const changedProofFiles = input.changedFiles.filter((path) =>
    visualProof.changedPathGlobs.some((pattern) => globMatches(pattern, path)),
  );

  return issueNeedsVisualProof || changedProofFiles.length > 0;
}

function hasAcceptanceProofProfile(config: CodexOrchestratorConfig): boolean {
  return Boolean(config.codex.profiles?.['acceptance-proof']);
}

function isInternalRunnerProofPath(path: string): boolean {
  return /^src\/runner\/(?:acceptance-proof|visual-proof-runner)\.ts$/u.test(path)
    || /^test\/(?:acceptance-proof|visual-proof-runner)\.test\.ts$/u.test(path);
}

function isLegacyVisualProofOverride(
  acceptanceProof: CodexOrchestratorConfig['reviewGates']['acceptanceProof'],
  visualProof: CodexOrchestratorConfig['reviewGates']['visualProof'],
): boolean {
  const defaultMobileCommand = 'codex-orchestrator visual-proof mobile --issue ${issueNumber}';
  const defaultAutoCommand = 'codex-orchestrator visual-proof auto --issue ${issueNumber}';
  const acceptanceCommand = acceptanceProof.runnerValidationCommand?.trim() || '';
  return (acceptanceCommand === defaultMobileCommand || acceptanceCommand === defaultAutoCommand)
    && Boolean(visualProof.runnerValidationCommand?.trim())
    && visualProof.runnerValidationCommand?.trim() !== defaultMobileCommand
    && visualProof.runnerValidationCommand?.trim() !== defaultAutoCommand;
}

function isMobileProofPath(path: string): boolean {
  return /^(?:android|ios)\//u.test(path)
    || /\.(?:xcodeproj|xcworkspace)\//u.test(path)
    || /(?:^|\/)(?:build\.gradle|build\.gradle\.kts|gradlew|gradlew\.bat)$/u.test(path);
}

function isFlutterEntrypoint(path: string): boolean {
  return path === 'pubspec.yaml' || /^lib\/.+\.dart$/u.test(path);
}

function isMobileIssueText(text: string): boolean {
  return /\b(?:android|ios|iphone|ipad|flutter|mobile|emulator|apk|aab|dart)\b/iu.test(text);
}

function regexMatches(pattern: string, text: string): boolean {
  return new RegExp(pattern, 'iu').test(text);
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
