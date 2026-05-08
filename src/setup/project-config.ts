import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { forbiddenRuntimeKeys } from '../config/constants.js';
import type { CodexOrchestratorConfig, LabelDefinition, LabelPreparationPolicy } from '../config/schema.js';
import { validateConfig } from '../config/schema.js';
import type { WorkflowConfigMap } from './workflows.js';

export interface BuildProjectConfigInput {
  owner: string;
  repo: string;
  prepareLabels: LabelPreparationPolicy;
  workflows: WorkflowConfigMap;
}

export const defaultLabels: CodexOrchestratorConfig['github']['labels'] = {
  auto: label('agent:auto', '0E8A16', 'Scoped autonomous Codex implementation'),
  planAuto: label('agent:plan-auto', '5319E7', 'Autonomous Codex planning and issue-tree execution'),
  running: label('agent:running', '1D76DB', 'Codex orchestration is currently running'),
  blocked: label('agent:blocked', 'B60205', 'Codex orchestration is blocked and needs maintainer input'),
  manual: label('agent:manual', 'BFDADC', 'Issue is reserved for manual work'),
  review: label('agent:review', 'FBCA04', 'Codex work is ready for human review'),
  child: label('agent:child', 'C2E0C6', 'Child issue owned by an autonomous parent issue tree'),
};

export function buildProjectConfig(input: BuildProjectConfigInput): CodexOrchestratorConfig {
  return {
    version: 1,
    github: {
      owner: input.owner,
      repo: input.repo,
      prepareLabels: input.prepareLabels,
      labels: defaultLabels,
    },
    runner: {
      workspaceRoot: '.codex-orchestrator/workspaces',
      maxParallelChildren: 3,
      stateDir: '.codex-orchestrator/state',
    },
    codex: {
      adapter: 'codex-cli',
    },
    project: {
      configDir: '.codex-orchestrator',
      promptsDir: '.codex-orchestrator/prompts',
    },
    workflows: input.workflows,
    checks: {
      typecheck: 'npm run typecheck',
      test: 'npm test',
    },
    deny: {
      secretFiles: ['.env', '.env.*'],
      destructiveDbOrCache: true,
      productionDeployOrRelease: true,
      additionalPathGlobs: [],
    },
    branches: {
      scopedIssue: 'codex/issue-${issueNumber}',
      issueTree: 'codex/tree-${parentIssueNumber}',
    },
    pullRequests: {
      scopedIssueTitle: 'Codex: issue #${issueNumber}',
      issueTreeTitle: 'Codex: parent issue #${parentIssueNumber}',
    },
    issueClassification: {
      promotionCriteria: [
        'api-contract',
        'dto-or-schema',
        'persistence',
        'auth-or-permissions',
        'billing',
        'background-job',
        'shared-state',
        'multi-service',
        'three-or-more-runtime-files',
      ],
      clarificationGate: 'block-and-comment',
    },
  };
}

export async function readExistingConfig(configPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(configPath, 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

export function assertNoRuntimeState(value: Record<string, unknown> | undefined): void {
  if (!value) {
    return;
  }

  const forbiddenKey = forbiddenRuntimeKeys.find((key) => key in value);
  if (forbiddenKey) {
    throw new Error(`${forbiddenKey} is runtime state and must not be committed config`);
  }
}

export async function writeProjectConfig(targetRoot: string, config: CodexOrchestratorConfig): Promise<string> {
  const configPath = projectConfigPath(targetRoot);
  const validation = validateConfig(config);

  if (!validation.ok) {
    throw new Error(`Generated config is invalid: ${validation.errors.join('; ')}`);
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

export function projectConfigPath(targetRoot: string): string {
  return join(targetRoot, '.codex-orchestrator', 'config.json');
}

function label(name: string, color: string, description: string): LabelDefinition {
  return { name, color, description };
}
