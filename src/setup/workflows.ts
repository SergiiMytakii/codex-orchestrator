import type { WorkflowConfig, WorkflowId } from '../config/schema.js';

export interface WorkflowDefinition {
  id: WorkflowId;
  skillName: string;
  promptPath: string;
}

export const workflowDefinitions: readonly WorkflowDefinition[] = [
  { id: 'prd', skillName: 'to-prd', promptPath: '.codex-orchestrator/prompts/workflows/prd.md' },
  {
    id: 'issueBreakdown',
    skillName: 'to-issues',
    promptPath: '.codex-orchestrator/prompts/workflows/issue-breakdown.md',
  },
  {
    id: 'breakdownReview',
    skillName: 'issue-breakdown-review',
    promptPath: '.codex-orchestrator/prompts/workflows/breakdown-review.md',
  },
  { id: 'triage', skillName: 'triage', promptPath: '.codex-orchestrator/prompts/workflows/triage.md' },
  {
    id: 'scopedImplementation',
    skillName: 'spec-implementer',
    promptPath: '.codex-orchestrator/prompts/workflows/scoped-implementation.md',
  },
  {
    id: 'issueTreeOrchestration',
    skillName: 'issue-orchestrator',
    promptPath: '.codex-orchestrator/prompts/workflows/issue-tree-orchestration.md',
  },
  {
    id: 'acceptanceProof',
    skillName: 'spec-implementer',
    promptPath: '.codex-orchestrator/prompts/workflows/acceptance-proof.md',
  },
] as const;

export type WorkflowConfigMap = Record<WorkflowId, WorkflowConfig>;

export async function resolveWorkflowConfigs(): Promise<WorkflowConfigMap> {
  const entries = workflowDefinitions.map((definition) => {
    const config: WorkflowConfig = {
      skillName: definition.skillName,
      source: 'package-bundled-prompt',
      promptPath: definition.promptPath,
    };

    return [definition.id, config] as const;
  });

  return Object.fromEntries(entries) as WorkflowConfigMap;
}
