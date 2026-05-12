import type { CodexOrchestratorConfig } from '../config/schema.js';
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
    const normalized = normalizePath(path);
    const matched = patterns.find((pattern) => globMatches(pattern, normalized));
    return matched ? [{ code: 'secret-file-change' as const, message: `Changed path ${normalized} matches denied pattern ${matched}` }] : [];
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

function globMatches(pattern: string, path: string): boolean {
  const escaped = pattern
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
  return new RegExp(`^${escaped}$`).test(path);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}
