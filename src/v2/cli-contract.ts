export const CANDIDATE_COMMANDS = ['setup', 'doctor', 'status', 'run', 'daemon'] as const;

export const RUN_ISSUE_STATUSES = [
  'review-ready',
  'not-eligible',
  'blocked',
  'transport-failed',
  'cancelled',
  'internal-error',
] as const;

export type CandidateCommand = typeof CANDIDATE_COMMANDS[number];
export type RunIssueStatus = typeof RUN_ISSUE_STATUSES[number];
