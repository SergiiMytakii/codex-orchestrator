export const PUBLIC_COMMANDS = ['setup', 'doctor', 'status', 'run', 'daemon'] as const;

export const RUN_ISSUE_STATUSES = [
  'review-ready',
  'route-ready',
  'spec-frozen',
  'awaiting-user',
  'not-eligible',
  'blocked',
  'transport-failed',
  'cancelled',
  'internal-error',
  'requeued',
] as const;

export type PublicCommand = typeof PUBLIC_COMMANDS[number];
export type RunIssueStatus = typeof RUN_ISSUE_STATUSES[number];

export function runIssueExitCode(result: RunIssueResult): 0 | 20 | 21 | 70 | 130 {
  switch (result.status) {
    case 'review-ready': return 0;
    case 'route-ready': return 0;
    case 'spec-frozen': return 0;
    case 'awaiting-user': return 0;
    case 'blocked': return 20;
    case 'requeued': return 0;
    case 'not-eligible': return 21;
    case 'transport-failed':
    case 'internal-error': return 70;
    case 'cancelled': return 130;
    default: return assertNever(result);
  }
}

export function renderRunResultJson(result: RunIssueResult): string {
  return `${canonicalJson({
    schema: 'codex-orchestrator.agent-auto-run-result',
    version: 1,
    result: structuredClone(result),
  })}\n`;
}

function assertNever(value: never): never {
  throw new Error(`unmapped runIssue result: ${String(value)}`);
}
import type { RunIssueResult } from './run-issue.js';
import { canonicalJson } from './containment.js';
