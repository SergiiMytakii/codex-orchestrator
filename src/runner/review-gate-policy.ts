import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import { globMatches } from '../path-policy.js';
import type { RunnerValidationLine } from './handoff-evidence.js';

export function buildVisualProofPromptLines(config: CodexOrchestratorConfig, issueNumber: number): string[] {
  const command = config.reviewGates.visualProof.runnerValidationCommand?.trim();
  if (!command) {
    return [
      'For visual/UI work, use the BrowserUse/browser plugin when it is available in the session. If it is unavailable, state that explicitly in skippedChecks instead of claiming visual validation.',
      `For visual/UI work, save screenshot proof files under ${config.reviewGates.visualProof.artifactDir}/issue-${issueNumber}/ and include them as screenshot artifacts.`,
    ];
  }

  const envNames = config.reviewGates.visualProof.envPassthrough ?? [];
  const loginEnvLine = envNames.length > 0
    ? `The runner visual proof command will receive these project environment variables when they exist: ${envNames.join(', ')}. Use them for login if authentication is required; never hardcode credentials.`
    : 'If authentication is required, make the visual proof script read credentials from environment variables configured in reviewGates.visualProof.envPassthrough; never hardcode credentials.';

  return [
    `For visual/UI work, prepare screenshot proof files under ${config.reviewGates.visualProof.artifactDir}/issue-${issueNumber}/ and include them as screenshot artifacts when you create them.`,
    `After your run, the runner will execute this visual proof command outside the child Codex sandbox: ${command}.`,
    'Prepare any project files this command needs, but do not execute this runner-owned command yourself or start long-lived browser/dev-server proof loops from child Codex.',
    'Do not open BrowserUse, Playwright, or any other browser from the child Codex session when this runner-owned visual proof command is configured.',
    'When this runner-owned proof command can validate the visual behavior, treat it as the primary visual proof path.',
    'Do not report BrowserUse or browser unavailability as a skipped check or residual risk when the runner-owned proof command is prepared.',
    'For UI layout fixes, a focused visual proof script with concrete assertions can be the TDD evidence when regular unit tests cannot observe the layout.',
    'Do not claim the runner-owned visual proof passed; the runner will append the passed/failed result after your run.',
    'The runner will expose CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR for proof scripts that need a stable Playwright user data directory.',
    loginEnvLine,
    'If required login environment variables are missing, the visual proof script must fail with a short clear error.',
  ];
}

export function buildQualityGatePromptLines(config: CodexOrchestratorConfig): string[] {
  const quality = config.reviewGates.quality;
  if (!quality.enabled) {
    return [];
  }

  return [
    '## Quality Gate Contract',
    'For runtime behavior changes, use strict TDD red-to-green: write one focused behavior test first, prove the test fails before implementation, then make the smallest implementation that passes after implementation.',
    'Report TDD as a passed validation line that includes failing/red and passing/green evidence. Do not batch many tests before implementation.',
    `Runtime files are detected with these globs: ${quality.runtimeChangedPathGlobs.join(', ')}.`,
    `Test files are detected with these globs: ${quality.testChangedPathGlobs.join(', ')}.`,
    'Run code-review before completion for runtime changes and report it as a passed validation line.',
    `Run cleanup-review before code-review when the runtime change touches at least ${quality.cleanupReview.runtimeFileThreshold} runtime files, and report it as a passed validation line.`,
  ];
}

export function shouldApplyVisualProofGate(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): boolean {
  const visualProof = input.config.reviewGates.visualProof;
  if (!visualProof.enabled) {
    return false;
  }

  const issueText = `${input.issue.title}\n${input.issue.body}`;
  const issueLooksVisual = visualProof.issueTextPatterns.some((pattern) => regexMatches(pattern, issueText));
  const changedUiFiles = input.changedFiles.filter((path) =>
    visualProof.changedPathGlobs.some((pattern) => globMatches(pattern, path)),
  );

  return issueLooksVisual || changedUiFiles.length > 0;
}

export function hasPassedValidation(validation: RunnerValidationLine[], patterns: string[]): boolean {
  return validation.some((line) =>
    line.status === 'passed' && patterns.some((pattern) => regexMatches(pattern, validationText(line))),
  );
}

export function hasPassedTddValidation(validation: RunnerValidationLine[], patterns: string[]): boolean {
  if (validation.some((line) =>
    line.status === 'passed'
      && !hasMissingTddProofText(validationText(line))
      && patterns.some((pattern) => regexMatches(pattern, validationText(line))),
  )) {
    return true;
  }

  const passedTexts = validation
    .filter((line) => line.status === 'passed')
    .map(validationText)
    .filter((text) => !hasMissingTddProofText(text));
  const hasRedEvidence = passedTexts.some(hasTddRedEvidence);
  const hasGreenEvidence = passedTexts.some(hasTddGreenEvidence);
  return hasRedEvidence && hasGreenEvidence;
}

export function validationText(line: RunnerValidationLine): string {
  return `${line.command}\n${line.summary}`;
}

export function isStrongVisualValidation(line: RunnerValidationLine): boolean {
  return /(BrowserUse|Playwright|screenshot|viewport)/iu.test(validationText(line));
}

export function isRunnerVisualValidation(line: RunnerValidationLine): boolean {
  return /runner visual proof/iu.test(validationText(line));
}

export function regexMatches(pattern: string, text: string): boolean {
  return new RegExp(pattern, 'iu').test(text);
}

export function runnerVisualProofPolicy(config: CodexOrchestratorConfig): {
  commandTemplate?: string;
  artifactDir: string;
  envPassthrough: string[];
  timeoutMs?: number;
  minScreenshotArtifacts: number;
} {
  const visualProof = config.reviewGates.visualProof;
  return {
    commandTemplate: visualProof.runnerValidationCommand?.trim() || undefined,
    artifactDir: visualProof.artifactDir,
    envPassthrough: visualProof.envPassthrough ?? [],
    timeoutMs: visualProof.runnerTimeoutMs,
    minScreenshotArtifacts: visualProof.minScreenshotArtifacts,
  };
}

function hasTddRedEvidence(text: string): boolean {
  return /\bred\s*:/iu.test(text) || /\b(?:test|spec|check)\b[\s\S]{0,120}\bfail(?:ed|ing)?\b/iu.test(text);
}

function hasTddGreenEvidence(text: string): boolean {
  return /\bgreen\s*:/iu.test(text)
    || /\b(?:test|spec|jest|vitest|playwright|pytest)\b[\s\S]{0,120}\bpass(?:ed|ing)?\b/iu.test(text)
    || /\b(?:flutter|dart|npm|pnpm|yarn)\s+(?:run\s+)?test\b[\s\S]{0,120}\bpass(?:ed|ing)?\b/iu.test(text);
}

function hasMissingTddProofText(text: string): boolean {
  return /\b(?:without|missing|no|lack(?:s|ing)?)\b[\s\S]{0,40}\bred[-\s]?green\b/iu.test(text)
    || /\bred[-\s]?green\b[\s\S]{0,40}\b(?:missing|without|no|lack(?:s|ing)?)\b/iu.test(text);
}
