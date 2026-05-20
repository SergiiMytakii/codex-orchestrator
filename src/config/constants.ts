export const labelKeys = ['auto', 'planAuto', 'running', 'blocked', 'manual', 'review', 'child'] as const;

export const workflowKeys = [
  'prd',
  'issueBreakdown',
  'breakdownReview',
  'triage',
  'scopedImplementation',
  'issueTreeOrchestration',
  'acceptanceProof',
] as const;

export const labelPreparationPolicies = ['report-only', 'create-missing'] as const;

export const workflowSources = [
  'existing-skill',
  'package-owned-skill',
  'package-bundled-prompt',
  'package-owned-prompt-fallback',
] as const;

export const forbiddenRuntimeKeys = ['runtime', 'state', 'locks', 'sessions', 'worktrees', 'retries', 'cache'] as const;
