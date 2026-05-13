import type { CodexOrchestratorConfig } from '../config/schema.js';
import { findDeniedPathMatch } from '../path-policy.js';
import type { ScopedCompletionReport } from './completion-report.js';

export type SafetyViolationCode =
  | 'secret-file-change'
  | 'secret-file-read'
  | 'destructive-db-or-cache'
  | 'production-deploy-or-release'
  | 'agent-owned-git-publication';

export interface SafetyViolation {
  code: SafetyViolationCode;
  message: string;
}

/**
 * Supports exact path literals, `*` within one path segment, and `**` across path segments.
 */
export function validateChangedPaths(paths: string[], config: CodexOrchestratorConfig): SafetyViolation[] {
  const patterns = [...config.deny.secretFiles, ...config.deny.additionalPathGlobs];
  return paths.flatMap((path) => {
    const matched = findDeniedPathMatch(path, patterns);
    return matched
      ? [{ code: 'secret-file-change' as const, message: `Changed path ${matched.path} matches denied pattern ${matched.pattern}` }]
      : [];
  });
}

export function validateCompletionReportSafety(report: ScopedCompletionReport): SafetyViolation[] {
  return report.prohibitedActions.map((action) => ({
    code: action.type,
    message: action.description,
  }));
}

export function validateNoAgentOwnedGitPublication(beforeHead: string, afterHead: string): SafetyViolation[] {
  if (beforeHead !== afterHead) {
    return [
      {
        code: 'agent-owned-git-publication',
        message: 'Codex changed git HEAD; runner-owned publication was violated',
      },
    ];
  }
  return [];
}
