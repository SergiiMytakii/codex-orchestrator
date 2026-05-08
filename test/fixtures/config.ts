import type { CodexOrchestratorConfig } from '../../src/config/schema.js';

export const validConfig: CodexOrchestratorConfig = {
  github: {
    owner: 'SergiiMytakii',
    repo: 'IntelleReach',
    issueLabels: {
      auto: 'agent:auto',
      planAuto: 'agent:plan-auto',
    },
  },
  runner: {
    workspaceRoot: '/tmp/workspaces',
    maxParallelChildren: 3,
  },
  codex: {
    adapter: 'codex-cli',
  },
  project: {
    configDir: '.codex-orchestrator',
  },
};
