import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
] as const;

export type WorkflowConfigMap = Record<WorkflowId, WorkflowConfig>;

export function defaultSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ? join(env.CODEX_HOME, 'skills') : join(homedir(), '.codex', 'skills');
}

export async function resolveWorkflowConfigs(skillsRoot: string): Promise<WorkflowConfigMap> {
  const entries = await Promise.all(
    workflowDefinitions.map(async (definition) => {
      const skillPath = join(skillsRoot, definition.skillName, 'SKILL.md');
      const exists = await pathExists(skillPath);
      const config: WorkflowConfig = exists
        ? {
            skillName: definition.skillName,
            source: 'existing-skill',
            skillPath,
            promptPath: definition.promptPath,
          }
        : {
            skillName: definition.skillName,
            source: 'package-owned-prompt-fallback',
            promptPath: definition.promptPath,
          };

      return [definition.id, config] as const;
    }),
  );

  return Object.fromEntries(entries) as WorkflowConfigMap;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
