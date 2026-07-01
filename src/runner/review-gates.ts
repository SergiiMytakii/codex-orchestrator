import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import {
  acceptsScreenshotArtifactPath,
  classifyChangedPaths,
  globMatches,
  isRunnerVisualProofCodeArtifactPath,
} from '../path-policy.js';
import type { ScopedCompletionReport } from './completion-report.js';
import type { PlanAutoCompletionReport } from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import {
  hasPassedTddValidation,
  hasPassedValidation,
  isVisualProofDesirable,
  isRunnerVisualValidation,
  isStrongVisualValidation,
  regexMatches,
  runnerVisualProofPolicy,
  shouldApplyVisualProofGate,
  validationText,
} from './review-gate-policy.js';

export interface ReviewGateInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
  validation: RunnerValidationLine[];
  skippedChecks: string[];
  report: ScopedCompletionReport;
  worktreePath?: string;
}

export interface ReviewGateResult {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

export { shouldApplyVisualProofGate } from './review-gate-policy.js';

export function evaluateParentRiskRoutingGate(input: {
  config: CodexOrchestratorConfig;
  report: PlanAutoCompletionReport;
}): ReviewGateResult {
  const findings = evaluateParentRiskRoutingFindings(input);
  const reasons: string[] = [];
  const warnings: string[] = [];
  applyRiskRoutingFindings(findings, input.config, reasons, warnings);
  return { ok: reasons.length === 0, reasons, warnings };
}

export function evaluateReviewGates(input: ReviewGateInput): ReviewGateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  reasons.push(...evaluateQualityGate(input));
  applyRiskRoutingFindings(evaluateScopedRiskRoutingGate(input), input.config, reasons, warnings);

  const visualProofDesirable = isVisualProofDesirable(input);
  const visualProofGateApplies = shouldApplyVisualProofGate(input);
  if (!visualProofDesirable && !visualProofGateApplies) {
    return { ok: reasons.length === 0, reasons, warnings };
  }

  const visualProof = input.config.reviewGates.visualProof;
  const runnerPolicy = runnerVisualProofPolicy(input.config);
  const runnerCommand = runnerPolicy.commandTemplate ?? '';

  const runnerVisualValidation = input.validation.filter(isRunnerVisualValidation);
  const hasPassedRunnerVisualValidation = runnerVisualValidation.some((line) =>
    line.status === 'passed' && isStrongVisualValidation(line),
  );
  const nonPassingRunnerVisualValidation = runnerVisualValidation.filter((line) => line.status !== 'passed');
  const capabilityUnavailableRunnerValidation = nonPassingRunnerVisualValidation.filter(isVisualProofCapabilityUnavailable);
  const otherNonPassingRunnerVisualValidation = nonPassingRunnerVisualValidation.filter((line) =>
    !capabilityUnavailableRunnerValidation.includes(line),
  );
  const screenshotArtifacts = input.report.artifacts.filter((artifact) => {
    if (artifact.type !== 'screenshot') {
      return false;
    }
    if (artifact.url) {
      return true;
    }
    if (!artifact.path) {
      return false;
    }
    const worktreePath = input.worktreePath;
    return acceptsScreenshotArtifactPath({
      artifactPath: artifact.path,
      artifactDir: runnerPolicy.artifactDir,
      changedFiles: input.changedFiles,
      hasPassedRunnerVisualValidation,
      exists: worktreePath ? (path) => existsSync(join(worktreePath, path)) : undefined,
    });
  });

  const proofPossible = Boolean(runnerCommand) && capabilityUnavailableRunnerValidation.length === 0;
  const strictVisualProofRequired = visualProofDesirable && runnerPolicy.requireWhenDesirable;
  if (!runnerCommand && visualProofDesirable) {
    const message = strictVisualProofRequired
      ? 'Visual proof is required by strict visual proof config, but no runner-owned visual proof command/provider is configured.'
      : 'Visual proof capability note: visual proof is desirable, but no runner-owned visual proof command/provider is configured; not required for review-ready outcome.';
    (strictVisualProofRequired ? reasons : warnings).push(message);
  }

  for (const line of capabilityUnavailableRunnerValidation) {
    if (strictVisualProofRequired) {
      reasons.push(`Visual proof is required by strict visual proof config, but proof capability is unavailable: ${line.command} - ${line.summary}.`);
    } else {
      warnings.push(`Visual proof capability note: ${line.command} - ${line.summary}; not required for review-ready outcome.`);
    }
  }

  for (const line of otherNonPassingRunnerVisualValidation) {
    const message = strictVisualProofRequired
      ? `Visual proof validation failed under strict visual proof config: ${line.command} - ${line.summary}`
      : `Visual proof validation warning: ${line.command} - ${line.summary}`;
    (strictVisualProofRequired ? reasons : warnings).push(message);
  }

  if (visualProofDesirable
    && (proofPossible || runnerPolicy.requireWhenDesirable)
    && screenshotArtifacts.length < visualProof.minScreenshotArtifacts) {
    const message = strictVisualProofRequired
      ? `Visual proof is required by strict visual proof config, but expected at least ${visualProof.minScreenshotArtifacts} screenshot artifact under ${runnerPolicy.artifactDir} or a screenshot URL.`
      : `Visual proof warning: expected at least ${visualProof.minScreenshotArtifacts} screenshot artifact under ${runnerPolicy.artifactDir} or a screenshot URL.`;
    (strictVisualProofRequired ? reasons : warnings).push(message);
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

function evaluateScopedRiskRoutingGate(input: ReviewGateInput): string[] {
  const riskRouting = input.config.reviewGates.riskRouting;
  if (!riskRouting.enabled) {
    return [];
  }

  const findings: string[] = [];
  const reviewHandoff = input.report.reviewHandoff;
  if (!reviewHandoff) {
    if (riskRouting.requireScopedReviewHandoff) {
      findings.push('scoped review handoff is required');
    }
    return findings;
  }

  if (riskRouting.requireScopedReviewHandoff) {
    requireNonEmptyEvidence(
      findings,
      reviewHandoff.implementedContract,
      'implementedContract must describe the delivered contract',
    );
    requireNonEmptyEvidence(
      findings,
      reviewHandoff.proofByAcceptanceCriteria,
      'proofByAcceptanceCriteria must map proof to acceptance criteria',
    );
    requireNonEmptyEvidence(
      findings,
      reviewHandoff.reviewFocus,
      'reviewFocus must identify review targets',
    );
    requireNonEmptyEvidence(
      findings,
      reviewHandoff.humanReviewChecklist,
      'humanReviewChecklist must identify human review checks',
    );
  }

  if (reviewHandoff.riskLevel === 'low') {
    if (!riskRouting.allowedLowRiskFlows.includes(reviewHandoff.flowUsed)) {
      findings.push(`low-risk scoped work used flow ${reviewHandoff.flowUsed}`);
    }
    for (const file of input.changedFiles) {
      if (riskRouting.riskyChangedPathGlobs.some((pattern) => globMatches(pattern, file))) {
        findings.push(`low-risk scoped work changed configured risky path ${file}`);
      }
    }
  }

  if (reviewHandoff.riskLevel === 'high' && riskRouting.highRiskRequiresCodeReview) {
    const hasCodeReview = hasPassedValidation(
      input.validation,
      input.config.reviewGates.quality.codeReview.requiredValidationPatterns,
    );
    if (!hasCodeReview) {
      findings.push('high-risk scoped work requires passed code-review validation');
    }
  }

  return findings;
}

function evaluateParentRiskRoutingFindings(input: {
  config: CodexOrchestratorConfig;
  report: PlanAutoCompletionReport;
}): string[] {
  const riskRouting = input.config.reviewGates.riskRouting;
  if (!riskRouting.enabled) {
    return [];
  }

  const findings: string[] = [];
  const stableIds = input.report.graph.nodes.map((node) => node.stableId);
  if (!input.report.sizeRisk) {
    if (riskRouting.requireParentSizeRisk) {
      findings.push('parent sizeRisk is required');
    }
  } else if (riskRouting.requireParentSizeRisk) {
    findings.push(...evaluateSizeRiskPartition(stableIds, input.report.sizeRisk));
  }

  const parentReviewHandoff = input.report.parentReviewHandoff;
  if (!parentReviewHandoff) {
    if (riskRouting.requireParentReviewHandoff) {
      findings.push('parentReviewHandoff is required');
    }
  } else if (riskRouting.requireParentReviewHandoff) {
    requireNonEmptyEvidence(
      findings,
      parentReviewHandoff.risks,
      'parentReviewHandoff.risks must describe parent orchestration risks',
    );
    requireNonEmptyEvidence(
      findings,
      parentReviewHandoff.proofStrategy,
      'parentReviewHandoff.proofStrategy must describe parent proof strategy',
    );
    requireNonEmptyEvidence(
      findings,
      parentReviewHandoff.humanReviewFocus,
      'parentReviewHandoff.humanReviewFocus must describe human review focus',
    );
  }

  return findings;
}

function evaluateSizeRiskPartition(
  stableIds: string[],
  sizeRisk: NonNullable<PlanAutoCompletionReport['sizeRisk']>,
): string[] {
  const findings: string[] = [];
  const known = new Set(stableIds);
  const counts = new Map<string, number>();
  const listed = [...sizeRisk.small, ...sizeRisk.medium, ...sizeRisk.high];
  for (const stableId of listed) {
    counts.set(stableId, (counts.get(stableId) ?? 0) + 1);
  }
  for (const stableId of stableIds) {
    if (!counts.has(stableId)) {
      findings.push(`sizeRisk is missing stable id ${stableId}`);
    }
  }
  for (const stableId of listed) {
    if (!known.has(stableId)) {
      findings.push(`sizeRisk lists unknown stable id ${stableId}`);
    } else if ((counts.get(stableId) ?? 0) > 1) {
      findings.push(`sizeRisk lists stable id ${stableId} more than once`);
      counts.set(stableId, 1);
    }
  }
  return findings;
}

function requireNonEmptyEvidence(findings: string[], values: string[], message: string): void {
  if (values.length === 0 || values.every((value) => value.trim().length === 0)) {
    findings.push(message);
  }
}

function applyRiskRoutingFindings(
  findings: string[],
  config: CodexOrchestratorConfig,
  reasons: string[],
  warnings: string[],
): void {
  if (findings.length === 0) {
    return;
  }

  if (config.reviewGates.riskRouting.mode === 'block') {
    reasons.push(...findings.map((finding) => `Risk routing gate requires: ${finding}.`));
    return;
  }

  warnings.push(...findings.map((finding) => `Risk routing warning: ${finding}.`));
}

function isVisualProofCapabilityUnavailable(line: RunnerValidationLine): boolean {
  if (line.status !== 'skipped') {
    return false;
  }

  return /(?:no runner-owned|not configured|no .*provider|unavailable|not available|not installed|not found|missing tool|no devices? connected|no usable .*device|adb|emulator|xcodebuild|simctl|flutter .*requires flutter|flutter was not found)/iu
    .test(line.summary);
}

function evaluateQualityGate(input: ReviewGateInput): string[] {
  const quality = input.config.reviewGates.quality;
  if (!quality.enabled) {
    return [];
  }

  const { runtimeFiles, testFiles } = classifyChangedPaths(input.changedFiles, {
    runtimeChangedPathGlobs: quality.runtimeChangedPathGlobs,
    testChangedPathGlobs: quality.testChangedPathGlobs,
  });
  if (runtimeFiles.length === 0) {
    return [];
  }

  const reasons: string[] = [];

  if (quality.tdd.enabled) {
    const hasTddValidation = hasPassedTddValidation(input.validation, quality.tdd.requiredValidationPatterns);
    const hasRunnerVisualProofEvidence = hasPassedRunnerVisualProofEvidence(input);
    if (quality.tdd.requireTestChange && testFiles.length === 0 && !hasRunnerVisualProofEvidence) {
      reasons.push('Quality gate requires TDD test file change for runtime changes.');
    }
    if (!hasTddValidation && !hasRunnerVisualProofEvidence) {
      reasons.push('Quality gate requires TDD red-to-green proof in validation.');
    }
  }

  if (quality.cleanupReview.enabled && runtimeFiles.length >= quality.cleanupReview.runtimeFileThreshold) {
    const hasCleanupReview = hasPassedValidation(input.validation, quality.cleanupReview.requiredValidationPatterns);
    if (!hasCleanupReview) {
      reasons.push('Quality gate requires passed cleanup-review validation for medium or large runtime changes.');
    }
  }

  if (quality.codeReview.enabled) {
    const hasCodeReview = hasPassedValidation(input.validation, quality.codeReview.requiredValidationPatterns);
    if (!hasCodeReview) {
      reasons.push('Quality gate requires passed code-review validation for runtime changes.');
    }
  }

  return reasons;
}

function hasPassedRunnerVisualProofEvidence(input: ReviewGateInput): boolean {
  if (!shouldApplyVisualProofGate(input)) {
    return false;
  }

  const hasPassedRunnerProof = input.validation.some((line) =>
    line.status === 'passed'
      && isRunnerVisualValidation(line)
      && isStrongVisualValidation(line),
  );
  if (!hasPassedRunnerProof) {
    return false;
  }

  return input.changedFiles.some((file) => {
    return isRunnerVisualProofCodeArtifactPath(file, runnerVisualProofPolicy(input.config).artifactDir);
  });
}
