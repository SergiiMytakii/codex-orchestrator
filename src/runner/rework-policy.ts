import type { CodexOrchestratorConfig } from '../config/schema.js';

const nonRetryableBlockerPatterns = [
  /matches denied pattern/iu,
  /runner-owned publication was violated/iu,
  /destructive-db-or-cache|production-deploy-or-release/iu,
] as const;

const retryableBlockerPatterns = [
  ['missing-quality-gate-evidence', /Quality gate requires/iu],
  ['failed-configured-checks', /One or more configured checks failed/iu],
  ['invalid-completion-report', /Invalid scoped completion report/iu],
  ['missing-completion-report', /Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE/iu],
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
