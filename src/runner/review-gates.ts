import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { RunnerValidationLine } from './command-utils.js';
import type { ScopedCompletionReport } from './completion-report.js';

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

export function shouldApplyVisualProofGate(
  input: Pick<ReviewGateInput, 'config' | 'issue' | 'changedFiles'>,
): boolean {
  const visualProof = input.config.reviewGates.visualProof;
  if (!visualProof.enabled) {
    return false;
  }

  const issueText = `${input.issue.title}\n${input.issue.body}`;
  const issueLooksVisual = visualProof.issueTextPatterns.some((pattern) => regexMatches(pattern, issueText));
  const changedUiFiles = input.changedFiles.filter((path) =>
    visualProof.changedPathGlobs.some((pattern) => globMatches(pattern, normalizePath(path))),
  );

  return issueLooksVisual || changedUiFiles.length > 0;
}

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

function hasPassedValidation(validation: RunnerValidationLine[], patterns: string[]): boolean {
  return validation.some((line) =>
    line.status === 'passed' && patterns.some((pattern) => regexMatches(pattern, validationText(line))),
  );
}

function hasPassedTddValidation(validation: RunnerValidationLine[], patterns: string[]): boolean {
  if (hasPassedValidation(validation, patterns)) {
    return true;
  }

  const passedTexts = validation
    .filter((line) => line.status === 'passed')
    .map(validationText);
  const hasRedEvidence = passedTexts.some(hasTddRedEvidence);
  const hasGreenEvidence = passedTexts.some(hasTddGreenEvidence);
  return hasRedEvidence && hasGreenEvidence;
}

function hasTddRedEvidence(text: string): boolean {
  return /\bred\b/iu.test(text) || /\b(?:test|spec|check)\b[\s\S]{0,120}\bfail(?:ed|ing)?\b/iu.test(text);
}

function hasTddGreenEvidence(text: string): boolean {
  return /\bgreen\b/iu.test(text)
    || /\b(?:test|spec|jest|vitest|playwright|pytest)\b[\s\S]{0,120}\bpass(?:ed|ing)?\b/iu.test(text)
    || /\b(?:flutter|dart|npm|pnpm|yarn)\s+(?:run\s+)?test\b[\s\S]{0,120}\bpass(?:ed|ing)?\b/iu.test(text);
}

function validationText(line: RunnerValidationLine): string {
  return `${line.command}\n${line.summary}`;
}

function isStrongVisualValidation(line: RunnerValidationLine): boolean {
  return /(BrowserUse|Playwright|screenshot|viewport)/iu.test(validationText(line));
}

function isRunnerVisualValidation(line: RunnerValidationLine): boolean {
  return /runner visual proof/iu.test(validationText(line));
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

function regexMatches(pattern: string, text: string): boolean {
  return new RegExp(pattern, 'iu').test(text);
}

function globMatches(pattern: string, path: string): boolean {
  const escaped = normalizePath(pattern)
    .split('/')
    .map((segment) => {
      if (segment === '**') {
        return '.*';
      }
      return segment
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('*', '[^/]*');
    })
    .join('/');
  return new RegExp(`^${escaped}$`).test(normalizePath(path));
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function changedPathCovers(changedPath: string, artifactPath: string): boolean {
  return changedPath === artifactPath || artifactPath.startsWith(changedPath.replace(/\/?$/, '/'));
}
