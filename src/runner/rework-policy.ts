import type { CodexOrchestratorConfig } from '../config/schema.js';

export const MISSING_COMPLETION_REPORT_REASON =
  'Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove safety contract.';

export const OPTIONAL_FIGMA_MCP_FAILURE_REASON =
  'Optional Figma MCP failed before completion; retry without optional Figma MCP.';

export const REQUIRED_FIGMA_MCP_FAILURE_REASON =
  'Required Figma MCP failed; required design access is unavailable.';

export type ReworkBlockerKey =
  | 'missing-completion-report'
  | 'invalid-completion-report'
  | 'no-changed-files'
  | 'failed-configured-checks'
  | 'missing-quality-gate-evidence'
  | 'invalid-acceptance-proof-report'
  | 'failed-acceptance-proof'
  | 'risk-routing-policy'
  | 'optional-figma-mcp-failure'
  | 'required-figma-mcp-failure'
  | 'denied-path'
  | 'publication-violation'
  | 'destructive-or-production-action'
  | 'unknown';

export interface ReworkDecisionInput {
  reasons: string[];
  config: CodexOrchestratorConfig;
  attempt: number;
}

export type ReworkDecision =
  | {
      kind: 'retry';
      attempt: number;
      nextAttempt: number;
      maxAttempts: number;
      blockerKeys: ReworkBlockerKey[];
      reasons: string[];
      rework: {
        attempt: number;
        blockedReasons: string[];
        disableOptionalFigmaMcp: boolean;
      };
    }
  | {
      kind: 'exhausted';
      attempt: number;
      maxAttempts: number;
      blockerKeys: ReworkBlockerKey[];
      reasons: string[];
    }
  | {
      kind: 'hard-block';
      attempt: number;
      blockerKeys: ReworkBlockerKey[];
      reasons: string[];
    };

const missingCompletionReportPattern = new RegExp(escapeRegex(MISSING_COMPLETION_REPORT_REASON), 'iu');
const optionalFigmaPattern = new RegExp(escapeRegex(OPTIONAL_FIGMA_MCP_FAILURE_REASON), 'iu');
const requiredFigmaPattern = new RegExp(escapeRegex(REQUIRED_FIGMA_MCP_FAILURE_REASON), 'iu');

const blockerPatterns: Array<[ReworkBlockerKey, RegExp]> = [
  ['denied-path', /matches denied pattern/iu],
  ['publication-violation', /runner-owned publication was violated/iu],
  ['destructive-or-production-action', /destructive-db-or-cache|production-deploy-or-release/iu],
  ['required-figma-mcp-failure', requiredFigmaPattern],
  ['optional-figma-mcp-failure', optionalFigmaPattern],
  ['missing-quality-gate-evidence', /Quality gate requires/iu],
  ['failed-configured-checks', /One or more configured checks failed|^(?!Codex exited\b)[^\n:]+:\s*failed\b/iu],
  ['invalid-acceptance-proof-report', /Invalid acceptance proof report schema/iu],
  ['failed-acceptance-proof', /Acceptance proof/iu],
  ['risk-routing-policy', /Risk routing gate requires/iu],
  ['invalid-completion-report', /Invalid scoped completion report/iu],
  ['missing-completion-report', missingCompletionReportPattern],
  ['no-changed-files', /Codex completed without file changes/iu],
];

const hardBlockerKeys = new Set<ReworkBlockerKey>([
  'denied-path',
  'publication-violation',
  'destructive-or-production-action',
  'required-figma-mcp-failure',
  'invalid-acceptance-proof-report',
  'unknown',
]);

export function decideImplementationRework(input: ReworkDecisionInput): ReworkDecision {
  const blockerKeys = classifyBlockerKeys(input.reasons);
  const hardBlockers = blockerKeys.filter((key) => hardBlockerKeys.has(key));
  if (hardBlockers.length > 0) {
    return {
      kind: 'hard-block',
      attempt: input.attempt,
      blockerKeys,
      reasons: input.reasons,
    };
  }

  const retryable = new Set<string>(input.config.loopPolicy.rework.retryableBlockers);
  const retryableBlockerKeys = blockerKeys.filter((key) => retryable.has(key));
  if (retryableBlockerKeys.length === 0) {
    return {
      kind: 'hard-block',
      attempt: input.attempt,
      blockerKeys,
      reasons: input.reasons,
    };
  }

  const maxAttempts = maxAttemptsForBlockerKeys(blockerKeys, input.config);
  if (input.attempt >= maxAttempts) {
    return {
      kind: 'exhausted',
      attempt: input.attempt,
      maxAttempts,
      blockerKeys,
      reasons: input.reasons,
    };
  }

  return {
    kind: 'retry',
    attempt: input.attempt,
    nextAttempt: input.attempt + 1,
    maxAttempts,
    blockerKeys,
    reasons: input.reasons,
    rework: {
      attempt: input.attempt + 1,
      blockedReasons: input.reasons,
      disableOptionalFigmaMcp: blockerKeys.includes('optional-figma-mcp-failure'),
    },
  };
}

function classifyBlockerKeys(reasons: string[]): ReworkBlockerKey[] {
  const keys: ReworkBlockerKey[] = [];
  for (const reason of reasons) {
    const matched = blockerPatterns
      .filter(([, pattern]) => pattern.test(reason))
      .map(([key]) => key);
    if (matched.length === 0) {
      pushUnique(keys, 'unknown');
      continue;
    }
    const effectiveMatched = matched.includes('invalid-acceptance-proof-report')
      ? matched.filter((key) => key !== 'failed-acceptance-proof')
      : matched;
    for (const key of effectiveMatched) {
      pushUnique(keys, key);
    }
  }
  return keys;
}

function maxAttemptsForBlockerKeys(blockerKeys: ReworkBlockerKey[], config: CodexOrchestratorConfig): number {
  if (blockerKeys.includes('failed-acceptance-proof')) {
    return Math.max(0, config.reviewGates.acceptanceProof.maxIterations - 1);
  }
  return config.loopPolicy.rework.maxAttempts;
}

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) {
    items.push(item);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
