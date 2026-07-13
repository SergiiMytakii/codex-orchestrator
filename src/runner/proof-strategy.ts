import { acceptanceProofStrategies, type AcceptanceProofStrategy, type CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';

export interface ResolvedProofStrategy {
  strategy: AcceptanceProofStrategy;
  source: 'issue contract' | 'config default';
}

export type AcceptanceProofRequirement = Exclude<AcceptanceProofStrategy, 'auto'>;

export interface ResolvedAcceptanceProofRequirement {
  mode: AcceptanceProofRequirement | null;
  source: ResolvedProofStrategy['source'];
}

export function resolveAcceptanceProofStrategy(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
}): ResolvedProofStrategy {
  const explicit = parseIssueProofStrategy(`${input.issue.title}\n${input.issue.body}`);
  if (explicit) {
    return { strategy: explicit, source: 'issue contract' };
  }
  return {
    strategy: input.config.reviewGates.acceptanceProof.proofStrategy,
    source: 'config default',
  };
}

export function resolveAcceptanceProofRequirement(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
}): ResolvedAcceptanceProofRequirement {
  const resolved = resolveAcceptanceProofStrategy(input);
  return {
    mode: resolved.strategy === 'auto' ? null : resolved.strategy,
    source: resolved.source,
  };
}

export function parseIssueProofStrategy(text: string): AcceptanceProofStrategy | undefined {
  const match = text.match(
    /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:proof\s*strategy|proofStrategy)(?:\*\*)?\s*:\s*([a-z-]+)\s*(?:\n|$)/iu,
  );
  const value = match?.[1]?.toLowerCase();
  return acceptanceProofStrategies.includes(value as AcceptanceProofStrategy)
    ? value as AcceptanceProofStrategy
    : undefined;
}
