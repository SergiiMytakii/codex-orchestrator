import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import {
  acceptsScreenshotArtifactPath,
  classifyChangedPaths,
  isRunnerVisualProofCodeArtifactPath,
} from '../path-policy.js';
import type { ScopedCompletionReport } from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import {
  hasPassedTddValidation,
  hasPassedValidation,
  isRunnerVisualValidation,
  isStrongVisualValidation,
  regexMatches,
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

export function evaluateReviewGates(input: ReviewGateInput): ReviewGateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  reasons.push(...evaluateQualityGate(input));

  if (!shouldApplyVisualProofGate(input)) {
    return { ok: reasons.length === 0, reasons, warnings };
  }

  const visualProof = input.config.reviewGates.visualProof;
  const runnerCommand = visualProof.runnerValidationCommand?.trim() ?? '';

  const runnerVisualValidation = input.validation.filter(isRunnerVisualValidation);
  const hasPassedRunnerVisualValidation = runnerVisualValidation.some((line) =>
    line.status === 'passed' && isStrongVisualValidation(line),
  );
  const nonPassingRunnerVisualValidation = runnerVisualValidation.filter((line) => line.status !== 'passed');
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
      artifactDir: visualProof.artifactDir,
      changedFiles: input.changedFiles,
      hasPassedRunnerVisualValidation,
      exists: worktreePath ? (path) => existsSync(join(worktreePath, path)) : undefined,
    });
  });

  if (!runnerCommand) {
    warnings.push(
      'Visual proof was applicable for this issue, but no runner-owned visual proof command is configured; skipping screenshot proof.',
    );
  }

  for (const line of nonPassingRunnerVisualValidation) {
    warnings.push(`Visual proof validation warning: ${line.command} - ${line.summary}`);
  }

  if (screenshotArtifacts.length < visualProof.minScreenshotArtifacts) {
    warnings.push(
      `Visual proof warning: expected at least ${visualProof.minScreenshotArtifacts} screenshot artifact under ${visualProof.artifactDir} or a screenshot URL.`,
    );
  }

  return { ok: reasons.length === 0, reasons, warnings };
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
    return isRunnerVisualProofCodeArtifactPath(file, input.config.reviewGates.visualProof.artifactDir);
  });
}
