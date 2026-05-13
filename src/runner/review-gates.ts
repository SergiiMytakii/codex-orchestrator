import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ScopedCompletionReport } from './completion-report.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import {
  changedPathCovers,
  globMatches,
  hasPassedTddValidation,
  hasPassedValidation,
  isRunnerVisualValidation,
  isStrongVisualValidation,
  normalizePath,
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
}

export { shouldApplyVisualProofGate } from './review-gate-policy.js';

export function evaluateReviewGates(input: ReviewGateInput): ReviewGateResult {
  const reasons: string[] = [];
  reasons.push(...evaluateQualityGate(input));

  const visualProof = input.config.reviewGates.visualProof;
  if (!shouldApplyVisualProofGate(input)) {
    return { ok: reasons.length === 0, reasons };
  }

  const matchingValidation = input.validation.filter((line) =>
    visualProof.requiredValidationPatterns.some((pattern) => regexMatches(pattern, validationText(line)))
      && isStrongVisualValidation(line),
  );
  const runnerVisualValidation = input.validation.filter(isRunnerVisualValidation);
  const hasPassedVisualValidation = matchingValidation.some((line) => line.status === 'passed');
  const hasPassedRunnerVisualValidation = runnerVisualValidation.some((line) =>
    line.status === 'passed' && isStrongVisualValidation(line),
  );
  const failedVisualValidation = matchingValidation.filter((line) => line.status !== 'passed');
  const failedRunnerVisualValidation = runnerVisualValidation.filter((line) => line.status === 'failed');
  const skippedVisualChecks = input.skippedChecks.filter((line) =>
    visualProof.blockOnSkippedPatterns.some((pattern) => regexMatches(pattern, line)),
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
    const path = normalizePath(artifact.path);
    if (input.worktreePath && !existsSync(join(input.worktreePath, path))) {
      return false;
    }
    return globMatches(`${normalizePath(visualProof.artifactDir)}/**`, path)
      && (
        hasPassedRunnerVisualValidation
        || input.changedFiles.some((file) => changedPathCovers(normalizePath(file), path))
      );
  });

  if (!hasPassedVisualValidation) {
    reasons.push('Visual proof gate requires a passed BrowserUse/Playwright/screenshot validation line.');
    for (const line of failedVisualValidation) {
      reasons.push(`Visual proof validation is ${line.status}: ${line.command} - ${line.summary}`);
    }
    for (const line of skippedVisualChecks) {
      reasons.push(`Visual proof check was skipped: ${line}`);
    }
  }
  for (const line of failedRunnerVisualValidation) {
    reasons.push(`Visual proof validation is failed: ${line.command} - ${line.summary}`);
  }
  if (screenshotArtifacts.length < visualProof.minScreenshotArtifacts) {
    reasons.push(
      `Visual proof gate requires at least ${visualProof.minScreenshotArtifacts} screenshot artifact under ${visualProof.artifactDir} or a screenshot URL.`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}

function evaluateQualityGate(input: ReviewGateInput): string[] {
  const quality = input.config.reviewGates.quality;
  if (!quality.enabled) {
    return [];
  }

  const runtimeFiles = input.changedFiles
    .map(normalizePath)
    .filter((path) => quality.runtimeChangedPathGlobs.some((pattern) => globMatches(pattern, path)))
    .filter((path) => !quality.testChangedPathGlobs.some((pattern) => globMatches(pattern, path)));
  if (runtimeFiles.length === 0) {
    return [];
  }

  const reasons: string[] = [];
  const testFiles = input.changedFiles
    .map(normalizePath)
    .filter((path) => quality.testChangedPathGlobs.some((pattern) => globMatches(pattern, path)));

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

  const artifactDir = normalizePath(input.config.reviewGates.visualProof.artifactDir);
  return input.changedFiles.some((file) => {
    const path = normalizePath(file);
    return globMatches(`${artifactDir}/**`, path) && /\.(?:cjs|js|mjs|ts|tsx)$/iu.test(path);
  });
}
