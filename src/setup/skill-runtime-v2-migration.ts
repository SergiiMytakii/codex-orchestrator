import type { CodexOrchestratorConfig, CodexOrchestratorConfigV2, CodexProfileConfigV2 } from '../config/schema.js';
import { validateConfigV2 } from '../config/schema.js';
import { legacyWorkflowDefinitions } from './legacy-workflow-migration.js';

const defaultArgs = ['exec', '--cd', '${worktreePath}', '--sandbox', 'workspace-write', '--add-dir', '${stateDir}', '--ignore-user-config', '-c', 'sandbox_workspace_write.network_access=true', '--output-last-message', '${reportPath}', '-'];
const forbiddenProfileEnv = new Set([
  'HOME', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY',
  'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS',
  'CODEX_ORCHESTRATOR_ALLOW_MOBILE_DEVICE_CONTROL', 'CODEX_ORCHESTRATOR_MOBILE_DEVICE_GUARD',
  'CODEX_ORCHESTRATOR_PROMPT_FILE', 'CODEX_ORCHESTRATOR_REPORT_FILE',
]);

export const workflowMigrationAliases = {
  prd: 'to-spec',
  issueBreakdown: 'to-tickets',
  breakdownReview: 'tickets-breakdown-review',
  triage: 'triage',
  scopedImplementation: 'implementation-attempt',
  issueTreeOrchestration: 'implementation-attempt',
  acceptanceProof: 'acceptance-proof',
} as const;

export function migrateConfigV1ToV2(config: CodexOrchestratorConfig): CodexOrchestratorConfigV2 {
  if (config.codex.adapter !== 'codex-cli') throw blocker('config-v2-adapter-unsupported');
  if (config.codex.command !== 'codex' || Object.values(config.codex.profiles ?? {}).some((profile) => profile.command && profile.command !== 'codex')) throw blocker('config-v2-command-unsupported');
  if (!same(config.codex.args, defaultArgs) || Object.values(config.codex.profiles ?? {}).some((profile) => profile.args && !same(profile.args, defaultArgs))) throw blocker('config-v2-args-unsupported');
  if ((config.codex.timeoutMs !== undefined && !positiveInteger(config.codex.timeoutMs))
    || (config.codex.idleTimeoutMs !== undefined && !positiveInteger(config.codex.idleTimeoutMs))
    || Object.values(config.codex.profiles ?? {}).some((profile) => (profile.timeoutMs !== undefined && !positiveInteger(profile.timeoutMs))
      || (profile.idleTimeoutMs !== undefined && !positiveInteger(profile.idleTimeoutMs)))) throw blocker('config-v2-timeout-invalid');
  if (config.codex.ignoreUserConfig === false) throw blocker('config-v2-user-config-enabled');
  if (config.codex.figmaMcp?.enabled) throw blocker('config-v2-figma-tools-required');
  if (config.codex.promptFileEnv !== 'CODEX_ORCHESTRATOR_PROMPT_FILE'
    || config.codex.reportFileEnv !== 'CODEX_ORCHESTRATOR_REPORT_FILE') throw blocker('config-v2-report-env-unsupported');
  if (config.project.promptsDir !== '.codex-orchestrator/prompts') throw blocker('config-v2-prompts-dir-unsupported');
  for (const definition of legacyWorkflowDefinitions) {
    const workflow = config.workflows[definition.id];
    if (workflow.source !== 'package-bundled-prompt' || workflow.skillName !== definition.skillName
      || workflow.promptPath !== definition.promptPath || workflow.skillPath !== undefined) {
      throw blocker('config-v2-workflow-override');
    }
  }
  const profiles: CodexOrchestratorConfigV2['codex']['profiles'] = {};
  for (const [phase, source] of Object.entries(config.codex.profiles ?? {})) {
    const env = source.env ?? {};
    if (Object.keys(env).some((key) => forbiddenProfileEnv.has(key))) throw blocker('config-v2-profile-env-forbidden');
    profiles[phase as keyof typeof profiles] = { model: null, effort: null, ...(source.timeoutMs ? { timeoutMs: source.timeoutMs } : {}), ...(source.idleTimeoutMs ? { idleTimeoutMs: source.idleTimeoutMs } : {}), env } as CodexProfileConfigV2;
  }
  if (config.codex.mobileTimeoutMs) {
    const visual = profiles['visual-proof'];
    if (visual?.timeoutMs && visual.timeoutMs !== config.codex.mobileTimeoutMs) throw blocker('config-v2-mobile-timeout-conflict');
    profiles['visual-proof'] = { model: visual?.model ?? null, effort: visual?.effort ?? null, ...visual, timeoutMs: config.codex.mobileTimeoutMs, env: visual?.env ?? {} };
  }
  const { workflows: _workflows, ...withoutWorkflows } = config;
  const candidate: CodexOrchestratorConfigV2 = {
    ...withoutWorkflows,
    version: 2,
    codex: {
      adapter: 'codex-app-server', command: 'codex', serverArgs: [], requiredVersion: '0.144.4',
      timeoutMs: config.codex.timeoutMs ?? 1_800_000, idleTimeoutMs: config.codex.idleTimeoutMs ?? 300_000,
      profiles,
      targetPolicy: { network: 'deny', networkHosts: [], writableRootClasses: ['proof-artifacts', 'target-state', 'worktree'], mcpServers: {} },
    },
    project: { configDir: '.codex-orchestrator' },
  };
  const validation = validateConfigV2(candidate);
  if (!validation.ok) throw new Error(`config-v2-invalid: ${validation.errors.join('; ')}`);
  return validation.value;
}

export function requireConfigV2(config: CodexOrchestratorConfig | CodexOrchestratorConfigV2): CodexOrchestratorConfigV2 {
  if (config.version === 2) {
    const validation = validateConfigV2(config);
    if (!validation.ok) throw new Error(`config-v2-invalid: ${validation.errors.join('; ')}`);
    return validation.value;
  }
  return migrateConfigV1ToV2(config);
}

function same(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function positiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function blocker(id: string): Error { return new Error(id); }
