import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import { globMatches } from '../path-policy.js';
import type { ProofPlan, ProofPlanMode } from './completion-report.js';
import { resolveAcceptanceProofStrategy } from './proof-strategy.js';

export type VisualProofDispatchTarget = 'browser' | 'mobile' | 'none';
export type ProofRoutingAction = 'skip' | 'dispatch' | 'allow-non-visual' | 'error';

export interface ProofRoutingDecision {
  applies: boolean;
  desirable: boolean;
  dispatchTarget: VisualProofDispatchTarget;
  proofStrategy: ReturnType<typeof resolveAcceptanceProofStrategy>['strategy'];
  action: ProofRoutingAction;
  reason: string;
}

export function decideProofRouting(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): ProofRoutingDecision {
  const proofStrategy = resolveAcceptanceProofStrategy({ config: input.config, issue: input.issue }).strategy;
  const dispatchTarget = proofStrategyDispatchTarget(input, proofStrategy);
  const desirable = visualProofDesirable(input, proofStrategy);
  const applies = acceptanceProofApplies(input, proofStrategy, desirable);

  if (proofStrategy === 'none' || proofStrategy === 'non-visual-smoke') {
    return {
      applies,
      desirable,
      dispatchTarget,
      proofStrategy,
      action: 'skip',
      reason: 'proof strategy disables browser/mobile visual proof',
    };
  }

  if (dispatchTarget === 'browser' || dispatchTarget === 'mobile') {
    return {
      applies,
      desirable,
      dispatchTarget,
      proofStrategy,
      action: 'dispatch',
      reason: `${dispatchTarget} proof target matched`,
    };
  }

  if (applies && !desirable) {
    return {
      applies: true,
      desirable,
      dispatchTarget,
      proofStrategy,
      action: 'allow-non-visual',
      reason: 'acceptance proof applies without browser or mobile dispatch',
    };
  }

  if (applies || desirable) {
    return {
      applies,
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
  const commandTemplate = acceptanceProof.runnerValidationCommand?.trim();
  return {
    commandTemplate: commandTemplate || undefined,
    artifactDir: acceptanceProof.artifactDir,
    envPassthrough: acceptanceProof.envPassthrough ?? [],
    timeoutMs: acceptanceProof.runnerTimeoutMs,
    minScreenshotArtifacts: visualProof.minScreenshotArtifacts,
    requireWhenDesirable: visualProof.requireWhenDesirable ?? false,
    blockOnMissingProof: true,
    browserProof: {
      strictConsoleErrors: acceptanceProof.browserProof?.strictConsoleErrors ?? false,
      strictNetworkFailures: acceptanceProof.browserProof?.strictNetworkFailures ?? false,
      scenarioPath: acceptanceProof.browserProof?.scenarioPath,
      baseUrl: acceptanceProof.browserProof?.baseUrl,
    },
  };
}

export function acceptanceProofApplies(
  input: {
    config: CodexOrchestratorConfig;
    issue: GitHubIssue;
    changedFiles: string[];
  },
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

export function proofStrategyDispatchTarget(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}, proofStrategy: ReturnType<typeof resolveAcceptanceProofStrategy>['strategy']): VisualProofDispatchTarget {
  if (proofStrategy === 'none' || proofStrategy === 'non-visual-smoke') {
    return 'none';
  }
  if (proofStrategy === 'browser-visual') {
    return 'browser';
  }
  if (proofStrategy === 'mobile-visual') {
    return 'mobile';
  }
  return changedFilesVisualDispatchTarget(input);
}

export function changedFilesVisualDispatchTarget(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): VisualProofDispatchTarget {
  const normalizedFiles = input.changedFiles.map((path) => path.replaceAll('\\', '/').replace(/^\.\//u, ''));
  const issueText = `${input.issue.title}\n${input.issue.body}`;
  if (normalizedFiles.some(isMobileProofPath) || normalizedFiles.some((path) => isFlutterEntrypoint(path) && isMobileIssueText(issueText))) {
    return 'mobile';
  }
  if (normalizedFiles.some((path) => input.config.reviewGates.visualProof.changedPathGlobs.some((pattern) => globMatches(pattern, path)))) {
    return 'browser';
  }
  return 'none';
}

export function proofPlanDispatchTarget(proofPlan: ProofPlan): VisualProofDispatchTarget {
  if (proofPlan.mode === 'browser-visual') {
    return 'browser';
  }
  if (proofPlan.mode === 'mobile-visual') {
    return 'mobile';
  }
  return 'none';
}

export function isNonVisualProofMode(mode: ProofPlanMode): boolean {
  return mode === 'non-visual-smoke' || mode === 'cli' || mode === 'api' || mode === 'worker';
}

export function visualStrategyDowngradeBlocker(target: Exclude<VisualProofDispatchTarget, 'none'>): string {
  return `Invalid proofPlan: non-visual proof cannot satisfy ${target} visual strategy`;
}

export function visualProofDesirable(input: {
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

function isInternalRunnerProofPath(path: string): boolean {
  return /^src\/runner\/(?:acceptance-proof|proof-routing|visual-proof-runner)\.ts$/u.test(path)
    || /^test\/(?:acceptance-proof|visual-proof-runner)\.test\.ts$/u.test(path);
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
