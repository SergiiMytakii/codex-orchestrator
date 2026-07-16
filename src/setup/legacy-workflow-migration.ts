import type { WorkflowConfig, WorkflowId } from '../config/schema.js';

export interface LegacyWorkflowDefinition {
  id: WorkflowId;
  skillName: string;
  promptPath: string;
}

export const legacyWorkflowDefinitions: readonly LegacyWorkflowDefinition[] = [
  { id: 'prd', skillName: 'to-prd', promptPath: '.codex-orchestrator/prompts/workflows/prd.md' },
  { id: 'issueBreakdown', skillName: 'to-issues', promptPath: '.codex-orchestrator/prompts/workflows/issue-breakdown.md' },
  { id: 'breakdownReview', skillName: 'issue-breakdown-review', promptPath: '.codex-orchestrator/prompts/workflows/breakdown-review.md' },
  { id: 'triage', skillName: 'triage', promptPath: '.codex-orchestrator/prompts/workflows/triage.md' },
  { id: 'scopedImplementation', skillName: 'spec-implementer', promptPath: '.codex-orchestrator/prompts/workflows/scoped-implementation.md' },
  { id: 'issueTreeOrchestration', skillName: 'issue-orchestrator', promptPath: '.codex-orchestrator/prompts/workflows/issue-tree-orchestration.md' },
  { id: 'acceptanceProof', skillName: 'spec-implementer', promptPath: '.codex-orchestrator/prompts/workflows/acceptance-proof.md' },
] as const;

export type LegacyWorkflowConfigMap = Record<WorkflowId, WorkflowConfig>;

export function legacyWorkflowConfigs(): LegacyWorkflowConfigMap {
  return Object.fromEntries(legacyWorkflowDefinitions.map((definition) => [definition.id, {
    skillName: definition.skillName,
    source: 'package-bundled-prompt',
    promptPath: definition.promptPath,
  }])) as LegacyWorkflowConfigMap;
}
