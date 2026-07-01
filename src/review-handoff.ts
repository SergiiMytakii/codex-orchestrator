export const reviewHandoffFlows = [
  'small-task-implementer',
  'scoped-implementation',
  'spec-implementer',
  'issue-tree-child',
  'other',
] as const;

export type ReviewHandoffFlow = (typeof reviewHandoffFlows)[number];
