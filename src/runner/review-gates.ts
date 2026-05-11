import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ScopedCompletionReport } from './prompt.js';

interface ValidationLine {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
}

export interface ReviewGateInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
  validation: ValidationLine[];
  skippedChecks: string[];
  report: ScopedCompletionReport;
}

export interface ReviewGateResult {
  ok: boolean;
  reasons: string[];
}

export function evaluateReviewGates(input: ReviewGateInput): ReviewGateResult {
  const visualProof = input.config.reviewGates.visualProof;
  if (!visualProof.enabled) {
    return { ok: true, reasons: [] };
  }

  const issueText = `${input.issue.title}\n${input.issue.body}`;
  const issueLooksVisual = visualProof.issueTextPatterns.some((pattern) => regexMatches(pattern, issueText));
  const changedUiFiles = input.changedFiles.filter((path) =>
    visualProof.changedPathGlobs.some((pattern) => globMatches(pattern, normalizePath(path))),
  );

  if (!issueLooksVisual && changedUiFiles.length === 0) {
    return { ok: true, reasons: [] };
  }

  const reasons: string[] = [];
  const matchingValidation = input.validation.filter((line) =>
    visualProof.requiredValidationPatterns.some((pattern) => regexMatches(pattern, validationText(line))),
  );
  const hasPassedVisualValidation = matchingValidation.some((line) => line.status === 'passed');
  const failedVisualValidation = matchingValidation.filter((line) => line.status !== 'passed');
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
    return globMatches(`${normalizePath(visualProof.artifactDir)}/**`, path)
      && input.changedFiles.some((file) => changedPathCovers(normalizePath(file), path));
  });

  if (!hasPassedVisualValidation) {
    reasons.push('Visual proof gate requires a passed BrowserUse/Playwright/screenshot validation line.');
  }
  for (const line of failedVisualValidation) {
    reasons.push(`Visual proof validation is ${line.status}: ${line.command} - ${line.summary}`);
  }
  for (const line of skippedVisualChecks) {
    reasons.push(`Visual proof check was skipped: ${line}`);
  }
  if (screenshotArtifacts.length < visualProof.minScreenshotArtifacts) {
    reasons.push(
      `Visual proof gate requires at least ${visualProof.minScreenshotArtifacts} screenshot artifact under ${visualProof.artifactDir} or a screenshot URL.`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}

function validationText(line: ValidationLine): string {
  return `${line.command}\n${line.summary}`;
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
