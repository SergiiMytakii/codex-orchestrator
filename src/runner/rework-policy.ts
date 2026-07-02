import type { CodexOrchestratorConfig } from '../config/schema.js';

export const MISSING_COMPLETION_REPORT_REASON =
  'Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove safety contract.';

const missingCompletionReportPattern = new RegExp(escapeRegex(MISSING_COMPLETION_REPORT_REASON), 'iu');

const nonRetryableBlockerPatterns = [
  /matches denied pattern/iu,
  /runner-owned publication was violated/iu,
  /destructive-db-or-cache|production-deploy-or-release/iu,
] as const;

const retryableBlockerPatterns = [
  ['missing-quality-gate-evidence', /Quality gate requires/iu],
  ['failed-configured-checks', /One or more configured checks failed/iu],
  ['failed-acceptance-proof', /Acceptance proof/iu],
  ['risk-routing-policy', /Risk routing gate requires/iu],
  ['invalid-completion-report', /Invalid scoped completion report/iu],
  ['missing-completion-report', missingCompletionReportPattern],
  ['no-changed-files', /Codex completed without file changes/iu],
] as const;

export function shouldRequestImplementationRework(reasons: string[], config: CodexOrchestratorConfig): boolean {
  if (reasons.some((reason) => nonRetryableBlockerPatterns.some((pattern) => pattern.test(reason)))) {
    return false;
  }

  const retryable = new Set(config.loopPolicy.rework.retryableBlockers);
  return reasons.some((reason) => retryableBlockerPatterns.some(
    ([blocker, pattern]) => retryable.has(blocker) && pattern.test(reason),
  ));
}

export function maxReworkAttemptsForReasons(reasons: string[], config: CodexOrchestratorConfig): number {
  if (reasons.some((reason) => /Acceptance proof/iu.test(reason))) {
    return Math.max(0, config.reviewGates.acceptanceProof.maxIterations - 1);
  }
  return config.loopPolicy.rework.maxAttempts;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
