import type { CodexOrchestratorConfig } from '../../src/config/schema.js';
import { buildProjectConfig } from '../../src/setup/project-config.js';
import { workflowDefinitions, type WorkflowConfigMap } from '../../src/setup/workflows.js';

export const fallbackWorkflows = Object.fromEntries(
  workflowDefinitions.map((definition) => [
    definition.id,
    {
      skillName: definition.skillName,
      source: 'package-owned-prompt-fallback',
      promptPath: definition.promptPath,
    },
  ]),
) as WorkflowConfigMap;

export const validConfig: CodexOrchestratorConfig = buildProjectConfig({
  owner: 'SergiiMytakii',
  repo: 'IntelleReach',
  prepareLabels: 'report-only',
  workflows: fallbackWorkflows,
});
