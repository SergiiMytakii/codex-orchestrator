import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import { globMatches } from '../path-policy.js';
import { uiEvidenceFailureDimensions } from './acceptance-proof.js';
import type { RunnerValidationLine } from './handoff-evidence.js';
import { resolveAcceptanceProofStrategy } from './proof-strategy.js';

export function buildVisualProofPromptLines(config: CodexOrchestratorConfig, issue: GitHubIssue): string[] {
  const acceptanceProof = config.reviewGates.acceptanceProof;
  const policy = runnerVisualProofPolicy(config);
  const command = policy.commandTemplate;
  const proofStrategy = resolveAcceptanceProofStrategy({ config, issue });
  const issueNumber = issue.number;
  const strategyLines = proofStrategyPromptLines(proofStrategy);
  if (proofStrategy.strategy === 'non-visual-smoke') {
    return [
      ...strategyLines,
      `For acceptance proof, save non-visual smoke, test, log, or machine-readable artifacts under ${policy.artifactDir}/issue-${issueNumber}/ and include them as log, smoke-output, or other artifacts.`,
      'Do not create browser/mobile routing markers, placeholder UI files, screenshot scenarios, emulator scripts, or other visual-proof shims just to satisfy the configured runner-owned visual proof command.',
      'Do not change files outside the child ownership scope for proof routing. If non-visual evidence is insufficient, report the exact gap in skippedChecks or residualRisks.',
    ];
  }
  if (proofStrategy.strategy === 'none') {
    return [
      ...strategyLines,
      `If ordinary validation artifacts are useful, save them under ${policy.artifactDir}/issue-${issueNumber}/ and include them as log, smoke-output, or other artifacts.`,
      'Do not create browser/mobile routing markers, placeholder UI files, screenshot scenarios, emulator scripts, or other visual-proof shims.',
    ];
  }
  if (!command) {
    return [
      ...strategyLines,
      `For acceptance proof, save proof artifacts under ${policy.artifactDir}/issue-${issueNumber}/ and include them as screenshot, ui-dump, log, smoke-output, or other artifacts.`,
      'For visual/UI work, screenshots and UI dumps require a Proof Report uiEvidence contract with workflowScope, viewportCoverage, artifactFreshness, layoutReview, copyReview, and sourceInputs; screenshot existence alone is not enough proof.',
      'For browser/web UI work, prefer a Playwright-based proof script when available; do not rely on in-session browser plugins for proof.',
      ...androidMobileProofPromptLines(),
      ...iosMobileProofPromptLines(),
      'For non-visual acceptance criteria, prefer a live smoke proof that exercises observable product behavior and records the output as an artifact.',
      'If acceptance proof is not possible in this environment, state that explicitly in skippedChecks along with the concrete reason (missing dependencies, missing credentials, dev server cannot start, etc.).',
    ];
  }

  const envNames = policy.envPassthrough;
  const loginEnvLine = envNames.length > 0
    ? `The runner acceptance proof command will receive these project environment variables when they exist: ${envNames.join(', ')}. Use them for login if authentication is required; never hardcode credentials.`
    : 'If authentication is required, make the acceptance proof script read credentials from environment variables configured in reviewGates.acceptanceProof.envPassthrough; never hardcode credentials.';

  return [
    ...strategyLines,
    `For acceptance proof, prepare proof artifacts under ${policy.artifactDir}/issue-${issueNumber}/ and include them as screenshot, ui-dump, log, smoke-output, or other artifacts when you create them.`,
    `After your run, the runner will execute this visual proof command outside the child Codex sandbox as the configured acceptance proof command: ${command}.`,
    'Prepare any project files this command needs, but do not execute this runner-owned command yourself or start long-lived browser/dev-server proof loops from child Codex.',
    `Proof script repair is allowed only in these proof-owned paths: ${acceptanceProof.proofOwnedPathGlobs.join(', ')}.`,
    'Product-code changes made during the proof phase are blockers; route missing behavior back through implementation instead.',
    'Every required acceptance criterion must map to high-confidence artifact evidence before Draft PR Handoff.',
    'For visual/UI work, screenshots and UI dumps require a Proof Report uiEvidence contract with workflowScope, viewportCoverage, artifactFreshness, layoutReview, copyReview, and sourceInputs.',
    `UI Evidence failure dimensions are runner-owned and stable: ${uiEvidenceFailureDimensions.join(', ')}.`,
    'For web layout proof, include wide desktop viewport coverage; include mobile coverage only when the issue or acceptance criteria call for mobile or responsive behavior.',
    'Prefer real UI login when configured credentials exist; session or cookie seeding must be explained in uiEvidence.authShortcutReason.',
    'For browser/web UI work, prefer Playwright-based screenshot proof via the runner-owned command; do not rely on in-session browser plugins for proof.',
    ...androidMobileProofPromptLines(),
    ...iosMobileProofPromptLines(),
    'When this runner-owned proof command can validate the visual behavior, treat it as the primary visual proof path.',
    'Do not report browser tool unavailability as a skipped check or residual risk when the runner-owned proof command is prepared.',
    'For UI layout fixes, a focused visual proof script with concrete assertions can be the TDD evidence when regular unit tests cannot observe the layout.',
    'For non-visual acceptance criteria, prefer a live smoke proof that exercises observable product behavior and records the output as an artifact.',
    'Do not claim the runner-owned visual proof passed or acceptance proof passed; the runner will append the passed/failed result after your run.',
    'The runner will expose CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR for proof scripts that need a stable Playwright user data directory.',
    loginEnvLine,
    'If required login environment variables are missing, the visual proof script must fail with a short clear error.',
  ];
}

function proofStrategyPromptLines(proofStrategy: ReturnType<typeof resolveAcceptanceProofStrategy>): string[] {
  const lines = [
    `Resolved proof strategy: ${proofStrategy.strategy} (${proofStrategy.source}).`,
    'Issue bodies may override the default with an explicit `Proof Strategy: auto|visual|browser-visual|mobile-visual|non-visual-smoke|none` line.',
  ];
  if (proofStrategy.strategy === 'non-visual-smoke') {
    return [
      ...lines,
      'Do not prepare browser, screenshot, emulator, simulator, or device-backed visual proof for this issue.',
      'Prepare non-visual smoke, test, log, or machine-readable artifact evidence that maps each acceptance criterion to observable behavior.',
    ];
  }
  if (proofStrategy.strategy === 'none') {
    return [
      ...lines,
      'Do not prepare runner-owned acceptance proof artifacts unless the implementation itself needs ordinary validation artifacts.',
    ];
  }
  if (proofStrategy.strategy === 'browser-visual') {
    return [...lines, 'Prepare browser visual proof artifacts; the runner-owned auto proof command must route to browser proof.'];
  }
  if (proofStrategy.strategy === 'mobile-visual') {
    return [...lines, 'Prepare mobile visual proof expectations; the runner-owned auto proof command must route to device-backed mobile proof.'];
  }
  return lines;
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
  const acceptanceProof = input.config.reviewGates.acceptanceProof;
  if (!acceptanceProof.enabled) {
    return false;
  }

  const policy = runnerVisualProofPolicy(input.config);
  if (!policy.commandTemplate) {
    return false;
  }

  const issueText = `${input.issue.title}\n${input.issue.body}`;
  const acceptanceCommand = acceptanceProof.runnerValidationCommand?.trim();
  const proofStrategy = resolveAcceptanceProofStrategy({ config: input.config, issue: input.issue }).strategy;
  if (proofStrategy === 'none' || proofStrategy === 'non-visual-smoke') {
    return false;
  }
  if (proofStrategy === 'browser-visual' || proofStrategy === 'mobile-visual' || proofStrategy === 'visual') {
    return Boolean(acceptanceCommand);
  }
  const internalRunnerProofOnlyChange = input.changedFiles.length > 0
    && input.changedFiles.every(isInternalRunnerProofPath);
  const canRunGenericAcceptanceProof = Boolean(acceptanceCommand) && !isMobileVisualProofCommand(acceptanceCommand);
  const issueNeedsAcceptanceProof = canRunGenericAcceptanceProof
    && !internalRunnerProofOnlyChange
    && acceptanceProof.issueTextPatterns.some((pattern) => regexMatches(pattern, issueText));
  const changedAcceptanceProofFiles = canRunGenericAcceptanceProof
    && input.changedFiles.some((path) =>
      acceptanceProof.changedPathGlobs.some((pattern) => globMatches(pattern, path)),
    );
  return issueNeedsAcceptanceProof || changedAcceptanceProofFiles || isVisualProofDesirable(input);
}

export type VisualProofDispatchTarget = 'browser' | 'mobile' | 'none';

export function classifyVisualProofDispatchTarget(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): VisualProofDispatchTarget {
  const normalizedFiles = input.changedFiles.map((path) => path.replaceAll('\\', '/').replace(/^\.\//u, ''));
  const issueText = `${input.issue.title}\n${input.issue.body}`;
  const proofStrategy = resolveAcceptanceProofStrategy({ config: input.config, issue: input.issue }).strategy;
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
  if (normalizedFiles.some((path) => input.config.reviewGates.acceptanceProof.changedPathGlobs.some((pattern) => globMatches(pattern, path)))
    || normalizedFiles.some((path) => input.config.reviewGates.visualProof.changedPathGlobs.some((pattern) => globMatches(pattern, path)))) {
    return 'browser';
  }
  return 'none';
}

export function isVisualProofDesirable(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): boolean {
  const visualProof = input.config.reviewGates.visualProof;
  if (!visualProof.enabled) {
    return false;
  }

  const issueText = `${input.issue.title}\n${input.issue.body}`;
  const command = runnerVisualProofPolicy(input.config).commandTemplate;
  const proofStrategy = resolveAcceptanceProofStrategy({ config: input.config, issue: input.issue }).strategy;
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

function isInternalRunnerProofPath(path: string): boolean {
  return /^src\/runner\/(?:acceptance-proof|visual-proof-runner)\.ts$/u.test(path)
    || /^test\/(?:acceptance-proof|visual-proof-runner)\.test\.ts$/u.test(path);
}

export function hasPassedValidation(validation: RunnerValidationLine[], patterns: string[]): boolean {
  return validation.some((line) =>
    line.status === 'passed' && patterns.some((pattern) => regexMatches(pattern, validationText(line))),
  );
}

export function hasPassedTddValidation(validation: RunnerValidationLine[], patterns: string[]): boolean {
  if (validation.some((line) => line.status === 'passed' && hasStructuredTddEvidence(line))) {
    return true;
  }

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

function hasStructuredTddEvidence(line: RunnerValidationLine): boolean {
  const evidence = line.evidence;
  return evidence?.kind === 'tdd-red-green'
    && evidence.red.status === 'failed'
    && evidence.red.command.trim().length > 0
    && evidence.red.summary.trim().length > 0
    && evidence.green.status === 'passed'
    && evidence.green.command.trim().length > 0
    && evidence.green.summary.trim().length > 0;
}

export function validationText(line: RunnerValidationLine): string {
  return `${line.command}\n${line.summary}`;
}

export function isStrongVisualValidation(line: RunnerValidationLine): boolean {
  return /(Playwright|screenshot|viewport)/iu.test(validationText(line));
}

export function isRunnerVisualValidation(line: RunnerValidationLine): boolean {
  return /runner (?:visual|acceptance) proof/iu.test(validationText(line));
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

function isMobileVisualProofCommand(command: string | undefined): boolean {
  return /\bcodex-orchestrator\s+visual-proof\s+(?:mobile|android|ios)\b/iu.test(command ?? '');
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
