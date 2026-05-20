import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import { globMatches } from '../path-policy.js';
import type { RunnerValidationLine } from './handoff-evidence.js';

export function buildVisualProofPromptLines(config: CodexOrchestratorConfig, issueNumber: number): string[] {
  const command = config.reviewGates.visualProof.runnerValidationCommand?.trim();
  if (!command) {
    return [
      `For visual/UI work, if you can produce screenshot proof, save it under ${config.reviewGates.visualProof.artifactDir}/issue-${issueNumber}/ and include it as screenshot artifacts.`,
      'For browser/web UI work, prefer a Playwright-based proof script when available; do not rely on in-session browser plugins for proof.',
      ...androidMobileProofPromptLines(),
      ...iosMobileProofPromptLines(),
      'If screenshot proof is not possible in this environment, state that explicitly in skippedChecks along with the concrete reason (missing dependencies, missing credentials, dev server cannot start, etc.).',
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
    'For browser/web UI work, prefer Playwright-based screenshot proof via the runner-owned command; do not rely on in-session browser plugins for proof.',
    ...androidMobileProofPromptLines(),
    ...iosMobileProofPromptLines(),
    'When this runner-owned proof command can validate the visual behavior, treat it as the primary visual proof path.',
    'Do not report browser tool unavailability as a skipped check or residual risk when the runner-owned proof command is prepared.',
    'For UI layout fixes, a focused visual proof script with concrete assertions can be the TDD evidence when regular unit tests cannot observe the layout.',
    'Do not claim the runner-owned visual proof passed; the runner will append the passed/failed result after your run.',
    'The runner will expose CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR for proof scripts that need a stable Playwright user data directory.',
    loginEnvLine,
    'If required login environment variables are missing, the visual proof script must fail with a short clear error.',
  ];
}

function androidMobileProofPromptLines(): string[] {
  return [
    'For Android mobile app UI work, use runner-owned device-backed proof instead of browser automation. Do not start Android emulators from child Codex; the runner-owned mobile proof command serializes shared adb/emulator access.',
    'If a specific connected Android target is required, document the desired `ANDROID_SERIAL` value or project environment requirement, but leave device selection and emulator startup to the runner-owned proof command.',
    'If Test Android Apps skills are unavailable, try to enable or load that plugin through the available Codex plugin/tool discovery mechanism before falling back.',
    'When a target is already selected by the runner or provided through the environment, use Test Android Apps skills for app launch, navigation, screenshots, logs, and performance evidence.',
    'For native Android projects, use the project Gradle wrapper (`./gradlew`) with a writable `GRADLE_USER_HOME`, build the relevant debug APK, then install and launch it through adb on the selected target.',
    'For Flutter Android projects only, start Flutter rebuild/install with the detected Flutter SDK and writable `PUB_CACHE` and `GRADLE_USER_HOME` directories. If rebuild/install fails because the SDK cache is read-only, retry only when `CODEX_ORCHESTRATOR_FLUTTER_ROOT` points to a preconfigured writable Flutter SDK: set `FLUTTER_ROOT` to that path, prepend `$FLUTTER_ROOT/bin` to `PATH`, run `flutter precache --android`, then rebuild/install again. If no writable Flutter SDK is configured, report the concrete SDK cache permission error.',
    'Do not use Playwright as the primary proof path for Android mobile app verification.',
    'If Test Android Apps cannot be enabled, or no usable Android device or emulator is available, report the mobile proof as a warning/skipped check with the concrete plugin or adb/emulator reason; this is not a publication blocker by itself.',
  ];
}

function iosMobileProofPromptLines(): string[] {
  return [
    'For native iOS app UI work, use simulator- or device-backed proof through Xcode tooling: run `xcrun simctl list devices available`, choose an available simulator when no device is provided, build with `xcodebuild` using a writable `-derivedDataPath`, then install and launch with `xcrun simctl install` and `xcrun simctl launch`.',
    'Do not use Android or Flutter proof steps for native iOS projects unless the repository is explicitly a Flutter project targeting iOS.',
    'If no usable iOS simulator/device or Xcode tooling is available, report the mobile proof as a warning/skipped check with the concrete xcodebuild/simctl reason; this is not a publication blocker by itself.',
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
  return /(Playwright|screenshot|viewport)/iu.test(validationText(line));
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
  return /\bred\s*:/iu.test(text)
    || /\bred\b[\s\S]{0,160}\bfail(?:ed|ing)?\b/iu.test(text)
    || /\bfail(?:ed|ing)?\b[\s\S]{0,160}\bred\b/iu.test(text)
    || /\b(?:test|tests|spec|specs|check|checks)\b[\s\S]{0,120}\bfail(?:ed|ing)?\b/iu.test(text);
}

function hasTddGreenEvidence(text: string): boolean {
  return /\bgreen\s*:/iu.test(text)
    || /\bgreen\b[\s\S]{0,160}\bpass(?:ed|ing)?\b/iu.test(text)
    || /\bpass(?:ed|ing)?\b[\s\S]{0,160}\bgreen\b/iu.test(text)
    || /\b(?:test|tests|spec|specs|check|checks|jest|vitest|playwright|pytest)\b[\s\S]{0,120}\bpass(?:ed|ing)?\b/iu.test(text)
    || /\b(?:flutter|dart|npm|pnpm|yarn)\s+(?:run\s+)?test\b[\s\S]{0,120}\bpass(?:ed|ing)?\b/iu.test(text);
}

function hasMissingTddProofText(text: string): boolean {
  return /\b(?:without|missing|no|lack(?:s|ing)?)\b[\s\S]{0,40}\bred[-\s]?green\b/iu.test(text)
    || /\bred[-\s]?green\b[\s\S]{0,40}\b(?:missing|without|no|lack(?:s|ing)?)\b/iu.test(text);
}
