import {
  forbiddenRuntimeKeys,
  labelKeys,
  labelPreparationPolicies,
  workflowKeys,
  workflowSources,
} from './constants.js';
import { reviewHandoffFlows, type ReviewHandoffFlow } from '../review-handoff.js';
import type { WritableRootClass } from '../skills/package-skill-bundle.js';

export type LabelKey = (typeof labelKeys)[number];
export type LabelPreparationPolicy = 'report-only' | 'create-missing';
export type WorkflowId = (typeof workflowKeys)[number];
export type WorkflowSource = (typeof workflowSources)[number];
export type ClarificationGate = 'block-and-comment';
export type IssueSelectionTieBreaker = 'issue-number-asc';
export type RetryableReworkBlocker =
  | 'missing-completion-report'
  | 'idle-timeout-before-change'
  | 'incomplete-after-progress'
  | 'invalid-completion-report'
  | 'no-changed-files'
  | 'failed-configured-checks'
  | 'missing-quality-gate-evidence'
  | 'failed-acceptance-proof'
  | 'risk-routing-policy'
  | 'optional-figma-mcp-failure';
export type FreshContextReviewMode = 'advisory';
export type RiskRoutingMode = 'warn' | 'block';
export const checkExecutionPhaseKeys = ['child', 'parent-integration'] as const;
export type CheckExecutionPhase = (typeof checkExecutionPhaseKeys)[number];
export const acceptanceProofStrategies = [
  'auto',
  'visual',
  'browser-visual',
  'mobile-visual',
  'non-visual-smoke',
  'none',
] as const;
export type AcceptanceProofStrategy = (typeof acceptanceProofStrategies)[number];
export const codexPhaseKeys = [
  'plan-parent',
  'scoped-issue',
  'tree-child',
  'acceptance-proof',
  'fresh-context-review',
  'visual-proof',
  'quality-review',
] as const;
export type CodexPhase = (typeof codexPhaseKeys)[number];

export interface CodexProfileConfig {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  env?: Record<string, string>;
}

export interface CodexProfileConfigV2 {
  model: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  env: Record<string, string>;
}

export interface TargetMcpServerPolicyV2 {
  url: string;
  httpHeaders: Record<string, string>;
  enabledTools: string[];
  approvals: Record<string, 'never'>;
}

export interface TargetExecutionPolicyV2 {
  network: 'deny' | 'allow-listed';
  networkHosts: string[];
  writableRootClasses: WritableRootClass[];
  mcpServers: Record<string, TargetMcpServerPolicyV2>;
}

export interface CodexFigmaMcpConfig {
  enabled: boolean;
  url: string;
  httpHeaders: Record<string, string>;
  optionalIssueTextPatterns: string[];
  requiredIssueTextPatterns: string[];
  optionalFailure: 'retry-without-mcp';
  requiredFailure: 'block';
  issueTextPatterns?: string[];
}

export const forbiddenCodexProfileEnvKeys = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'HOME',
  'CODEX_ORCHESTRATOR_ALLOW_MOBILE_DEVICE_CONTROL',
  'CODEX_ORCHESTRATOR_MOBILE_DEVICE_GUARD',
  'CODEX_ORCHESTRATOR_PROMPT_FILE',
  'CODEX_ORCHESTRATOR_REPORT_FILE',
]);

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export interface WorkflowConfig {
  skillName: string;
  source: WorkflowSource;
  promptPath?: string;
  skillPath?: string;
}

export interface LoopPolicyConfig {
  issueSelection: {
    priorityLabels: string[];
    tieBreaker: IssueSelectionTieBreaker;
  };
  rework: {
    maxAttempts: number;
    retryableBlockers: RetryableReworkBlocker[];
  };
  freshContextReview: {
    enabled: boolean;
    mode: FreshContextReviewMode;
    blockOnHighConfidencePolicyViolations: boolean;
  };
  durableRunSummaries: {
    enabled: boolean;
  };
  policySuggestions: {
    enabled: boolean;
    maxSuggestions: number;
  };
}

export interface ExplicitBaseBranchConfig {
  mode: 'explicit';
  remote: string;
  branch: string;
}

export type BaseBranchConfig = string | ExplicitBaseBranchConfig;

export interface CodexOrchestratorConfig {
  version: 1;
  github: {
    owner: string;
    repo: string;
    prepareLabels: LabelPreparationPolicy;
    labels: {
      auto: LabelDefinition;
      planAuto: LabelDefinition;
      running: LabelDefinition;
      blocked: LabelDefinition;
      manual: LabelDefinition;
      review: LabelDefinition;
      child: LabelDefinition;
    };
  };
  runner: {
    workspaceRoot: string;
    maxParallelChildren: number;
    maxParallelScopedIssues?: number;
    stateDir: string;
    allowAgentLocalCommits: boolean;
    worktreeCleanup?: {
      enabled: boolean;
    };
    resolutionMission?: {
      mode: 'off' | 'shadow' | 'enabled';
      markerLabel: string;
    };
  };
  codex: {
    adapter: 'codex-cli';
    command: string;
    args: string[];
    timeoutMs?: number;
    mobileTimeoutMs?: number;
    idleTimeoutMs?: number;
    ignoreUserConfig?: boolean;
    figmaMcp?: CodexFigmaMcpConfig;
    profiles?: Partial<Record<CodexPhase, CodexProfileConfig>>;
    promptFileEnv: 'CODEX_ORCHESTRATOR_PROMPT_FILE';
    reportFileEnv: 'CODEX_ORCHESTRATOR_REPORT_FILE';
  };
  project: {
    configDir: '.codex-orchestrator';
    promptsDir: '.codex-orchestrator/prompts';
  };
  workflows: {
    prd: WorkflowConfig;
    issueBreakdown: WorkflowConfig;
    breakdownReview: WorkflowConfig;
    triage: WorkflowConfig;
    scopedImplementation: WorkflowConfig;
    issueTreeOrchestration: WorkflowConfig;
    acceptanceProof: WorkflowConfig;
  };
  checks: Record<string, string>;
  checksPolicy?: {
    missingNpmScript?: 'fail' | 'skip';
    lintBaseline?: {
      mode?: 'strict' | 'touched-only';
      touchedFilesCommand?: string;
    };
    scope?: Record<string, {
      phases?: CheckExecutionPhase[];
      changedPathGlobs?: string[];
    }>;
  };
  reviewGates: {
    acceptanceProof: {
      enabled: boolean;
      proofStrategy: AcceptanceProofStrategy;
      artifactDir: string;
      issueTextPatterns: string[];
      changedPathGlobs: string[];
      proofOwnedPathGlobs: string[];
      runnerValidationCommand?: string;
      runnerTimeoutMs?: number;
      envPassthrough?: string[];
      browserProof?: {
        scenarioPath?: string;
        baseUrl?: string;
        strictConsoleErrors: boolean;
        strictNetworkFailures: boolean;
      };
      maxIterations: number;
    };
    visualProof: {
      enabled: boolean;
      artifactDir: string;
      issueTextPatterns: string[];
      changedPathGlobs: string[];
      requiredValidationPatterns: string[];
      blockOnSkippedPatterns: string[];
      minScreenshotArtifacts: number;
      requireWhenDesirable?: boolean;
      runnerValidationCommand?: string;
      runnerTimeoutMs?: number;
      envPassthrough?: string[];
    };
    quality: {
      enabled: boolean;
      runtimeChangedPathGlobs: string[];
      testChangedPathGlobs: string[];
      tdd: {
        enabled: boolean;
        requireTestChange: boolean;
        requiredValidationPatterns: string[];
      };
      cleanupReview: {
        enabled: boolean;
        runtimeFileThreshold: number;
        requiredValidationPatterns: string[];
      };
      codeReview: {
        enabled: boolean;
        requiredValidationPatterns: string[];
      };
    };
    riskRouting: {
      enabled: boolean;
      mode: RiskRoutingMode;
      requireScopedReviewHandoff: boolean;
      requireParentSizeRisk: boolean;
      requireParentReviewHandoff: boolean;
      riskyChangedPathGlobs: string[];
      highRiskRequiresCodeReview: boolean;
      allowedLowRiskFlows: ReviewHandoffFlow[];
    };
  };
  loopPolicy: LoopPolicyConfig;
  deny: {
    secretFiles: string[];
    destructiveDbOrCache: boolean;
    productionDeployOrRelease: boolean;
    additionalPathGlobs: string[];
  };
  branches: {
    base: BaseBranchConfig;
    scopedIssue: string;
    issueTree: string;
  };
  pullRequests: {
    scopedIssueTitle: string;
    issueTreeTitle: string;
  };
  issueClassification: {
    promotionCriteria: string[];
    clarificationGate: ClarificationGate;
  };
}

export interface CodexOrchestratorConfigV2 extends Omit<CodexOrchestratorConfig, 'version' | 'codex' | 'project' | 'workflows'> {
  version: 2;
  codex: {
    adapter: 'codex-app-server';
    command: 'codex';
    serverArgs: [];
    requiredVersion: '0.144.4';
    timeoutMs: number;
    idleTimeoutMs: number;
    profiles: Partial<Record<CodexPhase, CodexProfileConfigV2>>;
    targetPolicy: TargetExecutionPolicyV2;
  };
  project: { configDir: '.codex-orchestrator' };
}

export type RunnerConfig = CodexOrchestratorConfig | CodexOrchestratorConfigV2;

export type ConfigValidationResult =
  | { ok: true; value: CodexOrchestratorConfig }
  | { ok: false; errors: string[] };

export type ConfigV2ValidationResult =
  | { ok: true; value: CodexOrchestratorConfigV2 }
  | { ok: false; errors: string[] };

export function validateConfigV2(input: unknown): ConfigV2ValidationResult {
  const errors: string[] = [];
  const root = asObject(input);
  if (!root) return { ok: false, errors: ['config must be an object'] };
  const allowedRoot = new Set(['version', 'github', 'runner', 'codex', 'project', 'checks', 'checksPolicy', 'reviewGates', 'loopPolicy', 'deny', 'branches', 'pullRequests', 'issueClassification']);
  for (const key of Object.keys(root)) if (!allowedRoot.has(key)) errors.push(`config v2 contains unknown key ${key}`);
  if (root.version !== 2) errors.push('version must be 2');
  const codex = asObject(root.codex);
  if (!codex) errors.push('codex must be an object');
  else {
    const allowed = new Set(['adapter', 'command', 'serverArgs', 'requiredVersion', 'timeoutMs', 'idleTimeoutMs', 'profiles', 'targetPolicy']);
    for (const key of Object.keys(codex)) if (!allowed.has(key)) errors.push(`codex contains unknown key ${key}`);
    if (codex.adapter !== 'codex-app-server') errors.push('codex.adapter must be codex-app-server');
    if (codex.command !== 'codex') errors.push('codex.command must be codex');
    if (!Array.isArray(codex.serverArgs) || codex.serverArgs.length !== 0) errors.push('codex.serverArgs must be empty');
    if (codex.requiredVersion !== '0.144.4') errors.push('codex.requiredVersion must be 0.144.4');
    if (!positiveIntegerValue(codex.timeoutMs) || !positiveIntegerValue(codex.idleTimeoutMs)) errors.push('codex timeouts must be positive integers');
    validateV2Profiles(codex.profiles, errors);
    validateTargetPolicyV2(codex.targetPolicy, errors);
  }
  const project = asObject(root.project);
  if (!project || Object.keys(project).length !== 1 || project.configDir !== '.codex-orchestrator') errors.push('project must contain only configDir=.codex-orchestrator');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as CodexOrchestratorConfigV2 };
}

function validateV2Profiles(value: unknown, errors: string[]): void {
  const profiles = asObject(value);
  if (!profiles) { errors.push('codex.profiles must be an object'); return; }
  for (const [phase, raw] of Object.entries(profiles)) {
    if (!codexPhaseKeys.includes(phase as CodexPhase)) { errors.push(`codex.profiles contains unknown phase ${phase}`); continue; }
    const profile = asObject(raw);
    if (!profile) { errors.push(`codex.profiles.${phase} must be an object`); continue; }
    const allowed = new Set(['model', 'effort', 'timeoutMs', 'idleTimeoutMs', 'env']);
    for (const key of Object.keys(profile)) if (!allowed.has(key)) errors.push(`codex.profiles.${phase} contains unknown key ${key}`);
    if (!(profile.model === null || typeof profile.model === 'string')) errors.push(`codex.profiles.${phase}.model is invalid`);
    if (![null, 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(profile.effort as any)) errors.push(`codex.profiles.${phase}.effort is invalid`);
    if ('timeoutMs' in profile && !positiveIntegerValue(profile.timeoutMs)) errors.push(`codex.profiles.${phase}.timeoutMs is invalid`);
    if ('idleTimeoutMs' in profile && !positiveIntegerValue(profile.idleTimeoutMs)) errors.push(`codex.profiles.${phase}.idleTimeoutMs is invalid`);
    const env = asObject(profile.env);
    if (!env || Object.entries(env).some(([key, item]) => forbiddenAppServerProfileEnvKeys.has(key) || typeof item !== 'string')) errors.push(`codex.profiles.${phase}.env is invalid`);
  }
}

const forbiddenAppServerProfileEnvKeys = new Set([...forbiddenCodexProfileEnvKeys, 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY']);
function validateTargetPolicyV2(value: unknown, errors: string[]): void {
  const policy = asObject(value);
  if (!policy) { errors.push('codex.targetPolicy must be an object'); return; }
  const allowed = new Set(['network', 'networkHosts', 'writableRootClasses', 'mcpServers']);
  for (const key of Object.keys(policy)) if (!allowed.has(key)) errors.push(`codex.targetPolicy contains unknown key ${key}`);
  if (!['deny', 'allow-listed'].includes(String(policy.network))) errors.push('codex.targetPolicy.network is invalid');
  if (!Array.isArray(policy.networkHosts) || policy.networkHosts.some((host) => typeof host !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host))) errors.push('codex.targetPolicy.networkHosts is invalid');
  if (policy.network === 'deny' && Array.isArray(policy.networkHosts) && policy.networkHosts.length > 0) errors.push('deny network requires empty hosts');
  if (!Array.isArray(policy.writableRootClasses) || policy.writableRootClasses.some((item) => !['proof-artifacts', 'target-state', 'worktree'].includes(String(item)))) errors.push('codex.targetPolicy.writableRootClasses is invalid');
  const mcp = asObject(policy.mcpServers);
  if (!mcp || Object.keys(mcp).length !== 0) errors.push('orchestrator-mcp-catalog-fixture-missing');
}

function positiveIntegerValue(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }

type ObjectRecord = Record<string, unknown>;

export function validateConfig(input: unknown): ConfigValidationResult {
  const errors: string[] = [];
  const root = asObject(input);

  if (!root) {
    return { ok: false, errors: ['config must be an object'] };
  }

  for (const forbiddenKey of forbiddenRuntimeKeys) {
    if (forbiddenKey in root) {
      errors.push(`${forbiddenKey} is runtime state and must not be committed config`);
    }
  }

  expectLiteral(root, 'version', 1, errors);

  const github = expectObject(root, 'github', errors);
  const runner = expectObject(root, 'runner', errors);
  const codex = expectObject(root, 'codex', errors);
  const project = expectObject(root, 'project', errors);
  const workflows = expectObject(root, 'workflows', errors);
  const checks = expectObject(root, 'checks', errors);
  const checksPolicy = expectOptionalObject(root, 'checksPolicy', errors);
  const reviewGates = expectObject(root, 'reviewGates', errors);
  const loopPolicy = expectObject(root, 'loopPolicy', errors);
  const deny = expectObject(root, 'deny', errors);
  const branches = expectObject(root, 'branches', errors);
  const pullRequests = expectObject(root, 'pullRequests', errors);
  const issueClassification = expectObject(root, 'issueClassification', errors);

  if (github) {
    expectString(github, 'github.owner', errors);
    expectString(github, 'github.repo', errors);
    expectUnion(github, 'github.prepareLabels', labelPreparationPolicies, errors);
    const labels = expectObject(github, 'github.labels', errors);
    if (labels) {
      for (const labelKey of labelKeys) {
        validateLabel(labels, `github.labels.${labelKey}`, errors);
      }
    }
  }

  if (runner) {
    expectString(runner, 'runner.workspaceRoot', errors);
    expectParallelLimit(runner, errors);
    expectOptionalParallelLimit(runner, 'runner.maxParallelScopedIssues', errors);
    expectString(runner, 'runner.stateDir', errors);
    expectBoolean(runner, 'runner.allowAgentLocalCommits', errors);
    validateWorktreeCleanup(runner, errors);
    validateResolutionMission(runner, errors);
  }

  if (codex) {
    expectLiteral(codex, 'codex.adapter', 'codex-cli', errors);
    expectString(codex, 'codex.command', errors);
    expectStringArray(codex, 'codex.args', errors);
    expectOptionalPositiveInteger(codex, 'codex.timeoutMs', errors);
    expectOptionalPositiveInteger(codex, 'codex.mobileTimeoutMs', errors);
    expectOptionalPositiveInteger(codex, 'codex.idleTimeoutMs', errors);
    expectOptionalBoolean(codex, 'codex.ignoreUserConfig', errors);
    validateCodexFigmaMcp(codex, errors);
    validateCodexProfiles(codex, errors);
    expectLiteral(codex, 'codex.promptFileEnv', 'CODEX_ORCHESTRATOR_PROMPT_FILE', errors);
    expectLiteral(codex, 'codex.reportFileEnv', 'CODEX_ORCHESTRATOR_REPORT_FILE', errors);
  }

  if (project) {
    expectLiteral(project, 'project.configDir', '.codex-orchestrator', errors);
    expectLiteral(project, 'project.promptsDir', '.codex-orchestrator/prompts', errors);
  }

  if (workflows) {
    for (const workflowKey of workflowKeys) {
      validateWorkflow(workflows, `workflows.${workflowKey}`, errors);
    }
  }

  if (checks) {
    validateChecks(checks, errors);
  }

  if (checksPolicy) {
    validateChecksPolicy(checksPolicy, errors);
  }

  if (reviewGates) {
    validateReviewGates(reviewGates, errors);
  }

  if (loopPolicy) {
    validateLoopPolicy(loopPolicy, errors);
  }

  if (deny) {
    expectStringArray(deny, 'deny.secretFiles', errors);
    expectBoolean(deny, 'deny.destructiveDbOrCache', errors);
    expectBoolean(deny, 'deny.productionDeployOrRelease', errors);
    expectStringArray(deny, 'deny.additionalPathGlobs', errors);
  }

  if (branches) {
    validateBaseBranch(branches, errors);
    expectString(branches, 'branches.scopedIssue', errors);
    expectString(branches, 'branches.issueTree', errors);
  }

  if (pullRequests) {
    expectString(pullRequests, 'pullRequests.scopedIssueTitle', errors);
    expectString(pullRequests, 'pullRequests.issueTreeTitle', errors);
  }

  if (issueClassification) {
    expectStringArray(issueClassification, 'issueClassification.promotionCriteria', errors);
    expectLiteral(issueClassification, 'issueClassification.clarificationGate', 'block-and-comment', errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: normalizeConfig(root as unknown as CodexOrchestratorConfig) };
}

function normalizeConfig(config: CodexOrchestratorConfig): CodexOrchestratorConfig {
  const figmaMcp = config.codex.figmaMcp;
  if (!figmaMcp) {
    return config;
  }
  const {
    issueTextPatterns,
    optionalIssueTextPatterns,
    requiredIssueTextPatterns,
    optionalFailure,
    requiredFailure,
    ...rest
  } = figmaMcp;
  return {
    ...config,
    codex: {
      ...config.codex,
      figmaMcp: {
        ...rest,
        optionalIssueTextPatterns: optionalIssueTextPatterns ?? issueTextPatterns ?? [],
        requiredIssueTextPatterns: requiredIssueTextPatterns ?? [],
        optionalFailure: optionalFailure ?? 'retry-without-mcp',
        requiredFailure: requiredFailure ?? 'block',
      },
    },
  };
}

function asObject(value: unknown): ObjectRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as ObjectRecord;
}

function readPath(parent: ObjectRecord, path: string): unknown {
  const lastKey = path.split('.').at(-1);
  return lastKey ? parent[lastKey] : undefined;
}

function expectObject(parent: ObjectRecord, path: string, errors: string[]): ObjectRecord | undefined {
  const value = readPath(parent, path);
  const objectValue = asObject(value);

  if (!objectValue) {
    errors.push(`${path} must be an object`);
    return undefined;
  }

  return objectValue;
}

function expectOptionalObject(parent: ObjectRecord, path: string, errors: string[]): ObjectRecord | undefined {
  const value = readPath(parent, path);
  if (value === undefined) {
    return undefined;
  }
  const objectValue = asObject(value);
  if (!objectValue) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  return objectValue;
}

function expectString(parent: ObjectRecord, path: string, errors: string[]): string | undefined {
  const value = readPath(parent, path);

  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return undefined;
  }

  return value;
}

function expectBoolean(parent: ObjectRecord, path: string, errors: string[]): boolean | undefined {
  const value = readPath(parent, path);

  if (typeof value !== 'boolean') {
    errors.push(`${path} must be a boolean`);
    return undefined;
  }

  return value;
}

function expectOptionalBoolean(parent: ObjectRecord, path: string, errors: string[]): boolean | undefined {
  const value = readPath(parent, path);
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    errors.push(`${path} must be a boolean when provided`);
    return undefined;
  }

  return value;
}

function expectLiteral<TLiteral extends string | number>(
  parent: ObjectRecord,
  path: string,
  expected: TLiteral,
  errors: string[],
): TLiteral | undefined {
  const value = readPath(parent, path);

  if (value !== expected) {
    errors.push(`${path} must be ${expected}`);
    return undefined;
  }

  return expected;
}

function expectUnion<TLiteral extends string>(
  parent: ObjectRecord,
  path: string,
  expected: readonly TLiteral[],
  errors: string[],
): TLiteral | undefined {
  const value = readPath(parent, path);

  if (typeof value !== 'string' || !expected.includes(value as TLiteral)) {
    errors.push(`${path} must be one of ${expected.join(', ')}`);
    return undefined;
  }

  return value as TLiteral;
}

function expectParallelLimit(parent: ObjectRecord, errors: string[]): number | undefined {
  const value = readPath(parent, 'runner.maxParallelChildren');

  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > 3) {
    errors.push('runner.maxParallelChildren must be an integer between 1 and 3');
    return undefined;
  }

  return value;
}

function expectOptionalParallelLimit(parent: ObjectRecord, path: string, errors: string[]): number | undefined {
  const value = readPath(parent, path);
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > 3) {
    errors.push(`${path} must be an integer between 1 and 3 when provided`);
    return undefined;
  }

  return value;
}

function expectStringArray(parent: ObjectRecord, path: string, errors: string[]): string[] | undefined {
  const value = readPath(parent, path);

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    errors.push(`${path} must be an array of non-empty strings`);
    return undefined;
  }

  return value as string[];
}

function expectOptionalStringArray(parent: ObjectRecord, path: string, errors: string[]): string[] | undefined {
  const value = readPath(parent, path);

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    errors.push(`${path} must be an array of non-empty strings when provided`);
    return undefined;
  }

  return value as string[];
}

function validateLabel(parent: ObjectRecord, path: string, errors: string[]): void {
  const label = expectObject(parent, path, errors);

  if (!label) {
    return;
  }

  expectString(label, `${path}.name`, errors);
  expectString(label, `${path}.color`, errors);
  expectString(label, `${path}.description`, errors);
}

function validateBaseBranch(branches: ObjectRecord, errors: string[]): void {
  const value = readPath(branches, 'branches.base');
  if (typeof value === 'string') {
    if (value.length === 0) {
      errors.push('branches.base must be a non-empty string or explicit base branch object');
    }
    return;
  }

  const base = asObject(value);
  if (!base) {
    errors.push('branches.base must be a non-empty string or explicit base branch object');
    return;
  }

  expectLiteral(base, 'branches.base.mode', 'explicit', errors);
  expectString(base, 'branches.base.remote', errors);
  expectString(base, 'branches.base.branch', errors);
}

function validateWorkflow(parent: ObjectRecord, path: string, errors: string[]): void {
  const workflow = expectObject(parent, path, errors);

  if (!workflow) {
    return;
  }

  const source = expectUnion(
    workflow,
    `${path}.source`,
    workflowSources,
    errors,
  );

  expectString(workflow, `${path}.skillName`, errors);

  if (source === 'existing-skill' || source === 'package-owned-skill') {
    expectString(workflow, `${path}.skillPath`, errors);
  }

  if (source === 'package-bundled-prompt' || source === 'package-owned-prompt-fallback') {
    expectString(workflow, `${path}.promptPath`, errors);
  }
}

function validateChecks(checks: ObjectRecord, errors: string[]): void {
  for (const [name, command] of Object.entries(checks)) {
    if (name.length === 0 || typeof command !== 'string' || command.length === 0) {
      errors.push('checks must map non-empty names to non-empty shell commands');
    }
  }
}

function validateCodexProfiles(codex: ObjectRecord, errors: string[]): void {
  const profiles = expectOptionalObject(codex, 'codex.profiles', errors);
  if (!profiles) {
    return;
  }

  for (const key of Object.keys(profiles)) {
    if (!codexPhaseKeys.includes(key as CodexPhase)) {
      errors.push(`codex.profiles contains unknown phase ${key}`);
      continue;
    }
    const profile = expectOptionalObject(profiles, `codex.profiles.${key}`, errors);
    if (!profile) {
      continue;
    }
    expectOptionalString(profile, `codex.profiles.${key}.command`, errors);
    expectOptionalStringArray(profile, `codex.profiles.${key}.args`, errors);
    expectOptionalPositiveInteger(profile, `codex.profiles.${key}.timeoutMs`, errors);
    expectOptionalPositiveInteger(profile, `codex.profiles.${key}.idleTimeoutMs`, errors);
    validateCodexProfileEnv(profile, key, errors);
  }
}

function validateCodexProfileEnv(profile: ObjectRecord, phase: string, errors: string[]): void {
  const env = expectOptionalObject(profile, `codex.profiles.${phase}.env`, errors);
  if (!env) {
    return;
  }
  const keys = Object.keys(env);
  if (keys.some((key) => !/^[A-Z_][A-Z0-9_]*$/.test(key))) {
    errors.push(`codex.profiles.${phase}.env must contain valid environment variable names`);
  }
  const forbidden = keys.find((key) => forbiddenCodexProfileEnvKeys.has(key));
  if (forbidden) {
    errors.push(`codex.profiles.${phase}.env must not contain forbidden key ${forbidden}`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      errors.push(`codex.profiles.${phase}.env.${key} must be a string`);
    }
  }
}

function validateCodexFigmaMcp(codex: ObjectRecord, errors: string[]): void {
  const figmaMcp = expectOptionalObject(codex, 'codex.figmaMcp', errors);
  if (!figmaMcp) {
    return;
  }

  expectBoolean(figmaMcp, 'codex.figmaMcp.enabled', errors);
  expectString(figmaMcp, 'codex.figmaMcp.url', errors);
  const hasLegacyPatterns = Array.isArray(figmaMcp.issueTextPatterns);
  if (hasLegacyPatterns) {
    expectStringArray(figmaMcp, 'codex.figmaMcp.issueTextPatterns', errors);
    validateRegexArray(figmaMcp, 'codex.figmaMcp.issueTextPatterns', errors);
  } else {
    expectStringArray(figmaMcp, 'codex.figmaMcp.optionalIssueTextPatterns', errors);
    validateRegexArray(figmaMcp, 'codex.figmaMcp.optionalIssueTextPatterns', errors);
    expectStringArray(figmaMcp, 'codex.figmaMcp.requiredIssueTextPatterns', errors);
    validateRegexArray(figmaMcp, 'codex.figmaMcp.requiredIssueTextPatterns', errors);
  }
  if ('optionalFailure' in figmaMcp) {
    expectLiteral(figmaMcp, 'codex.figmaMcp.optionalFailure', 'retry-without-mcp', errors);
  }
  if ('requiredFailure' in figmaMcp) {
    expectLiteral(figmaMcp, 'codex.figmaMcp.requiredFailure', 'block', errors);
  }

  const httpHeaders = expectObject(figmaMcp, 'codex.figmaMcp.httpHeaders', errors);
  if (!httpHeaders) {
    return;
  }
  for (const [key, value] of Object.entries(httpHeaders)) {
    if (key.length === 0 || typeof value !== 'string' || value.length === 0) {
      errors.push('codex.figmaMcp.httpHeaders must map non-empty names to non-empty string values');
    }
  }
}

function validateChecksPolicy(policy: ObjectRecord, errors: string[]): void {
  if ('missingNpmScript' in policy) {
    expectUnion(policy, 'checksPolicy.missingNpmScript', ['fail', 'skip'] as const, errors);
  }

  const lintBaseline = 'lintBaseline' in policy ? asObject(policy.lintBaseline) : undefined;
  if ('lintBaseline' in policy && !lintBaseline) {
    errors.push('checksPolicy.lintBaseline must be an object');
    return;
  }
  if (lintBaseline) {
    if ('mode' in lintBaseline) {
      expectUnion(lintBaseline, 'checksPolicy.lintBaseline.mode', ['strict', 'touched-only'] as const, errors);
    }
    if ('touchedFilesCommand' in lintBaseline) {
      expectString(lintBaseline, 'checksPolicy.lintBaseline.touchedFilesCommand', errors);
    }
  }

  const scope = 'scope' in policy ? asObject(policy.scope) : undefined;
  if ('scope' in policy && !scope) {
    errors.push('checksPolicy.scope must be an object');
    return;
  }
  if (scope) {
    validateChecksPolicyScope(scope, errors);
  }
}

function validateChecksPolicyScope(scope: ObjectRecord, errors: string[]): void {
  for (const [checkName, rawRule] of Object.entries(scope)) {
    if (checkName.length === 0) {
      errors.push('checksPolicy.scope must map non-empty check names to objects');
      continue;
    }
    const rule = asObject(rawRule);
    if (!rule) {
      errors.push(`checksPolicy.scope.${checkName} must be an object`);
      continue;
    }
    if ('phases' in rule) {
      const phases = expectOptionalStringArray(rule, `checksPolicy.scope.${checkName}.phases`, errors);
      if (phases && phases.some((phase) => !checkExecutionPhaseKeys.includes(phase as CheckExecutionPhase))) {
        errors.push(`checksPolicy.scope.${checkName}.phases must contain only ${checkExecutionPhaseKeys.join(', ')}`);
      }
    }
    if ('changedPathGlobs' in rule) {
      expectOptionalStringArray(rule, `checksPolicy.scope.${checkName}.changedPathGlobs`, errors);
    }
  }
}

function validateReviewGates(parent: ObjectRecord, errors: string[]): void {
  const acceptanceProof = expectObject(parent, 'reviewGates.acceptanceProof', errors);
  if (acceptanceProof) {
    expectBoolean(acceptanceProof, 'reviewGates.acceptanceProof.enabled', errors);
    expectUnion(acceptanceProof, 'reviewGates.acceptanceProof.proofStrategy', acceptanceProofStrategies, errors);
    expectString(acceptanceProof, 'reviewGates.acceptanceProof.artifactDir', errors);
    expectStringArray(acceptanceProof, 'reviewGates.acceptanceProof.issueTextPatterns', errors);
    expectStringArray(acceptanceProof, 'reviewGates.acceptanceProof.changedPathGlobs', errors);
    expectStringArray(acceptanceProof, 'reviewGates.acceptanceProof.proofOwnedPathGlobs', errors);
    expectPositiveInteger(acceptanceProof, 'reviewGates.acceptanceProof.maxIterations', errors);
    expectOptionalString(acceptanceProof, 'reviewGates.acceptanceProof.runnerValidationCommand', errors);
    expectOptionalPositiveInteger(acceptanceProof, 'reviewGates.acceptanceProof.runnerTimeoutMs', errors);
    expectOptionalStringArray(acceptanceProof, 'reviewGates.acceptanceProof.envPassthrough', errors);
    validateBrowserProofConfig(acceptanceProof, errors);
    validateEnvironmentVariableNames(acceptanceProof, 'reviewGates.acceptanceProof.envPassthrough', errors);
    validateRegexArray(acceptanceProof, 'reviewGates.acceptanceProof.issueTextPatterns', errors);
  }

  const visualProof = expectObject(parent, 'reviewGates.visualProof', errors);
  if (visualProof) {
    expectBoolean(visualProof, 'reviewGates.visualProof.enabled', errors);
    expectString(visualProof, 'reviewGates.visualProof.artifactDir', errors);
    expectStringArray(visualProof, 'reviewGates.visualProof.issueTextPatterns', errors);
    expectStringArray(visualProof, 'reviewGates.visualProof.changedPathGlobs', errors);
    expectStringArray(visualProof, 'reviewGates.visualProof.requiredValidationPatterns', errors);
    expectStringArray(visualProof, 'reviewGates.visualProof.blockOnSkippedPatterns', errors);
    expectPositiveInteger(visualProof, 'reviewGates.visualProof.minScreenshotArtifacts', errors);
    expectOptionalBoolean(visualProof, 'reviewGates.visualProof.requireWhenDesirable', errors);
    expectOptionalString(visualProof, 'reviewGates.visualProof.runnerValidationCommand', errors);
    expectOptionalPositiveInteger(visualProof, 'reviewGates.visualProof.runnerTimeoutMs', errors);
    expectOptionalStringArray(visualProof, 'reviewGates.visualProof.envPassthrough', errors);
    validateEnvironmentVariableNames(visualProof, 'reviewGates.visualProof.envPassthrough', errors);
    validateRegexArray(visualProof, 'reviewGates.visualProof.issueTextPatterns', errors);
    validateRegexArray(visualProof, 'reviewGates.visualProof.requiredValidationPatterns', errors);
    validateRegexArray(visualProof, 'reviewGates.visualProof.blockOnSkippedPatterns', errors);
  }

  validateQualityGate(parent, errors);
  validateRiskRoutingGate(parent, errors);
}

function validateRiskRoutingGate(parent: ObjectRecord, errors: string[]): void {
  const riskRouting = expectOptionalObject(parent, 'reviewGates.riskRouting', errors);
  if (!riskRouting) {
    return;
  }

  expectBoolean(riskRouting, 'reviewGates.riskRouting.enabled', errors);
  expectUnion(riskRouting, 'reviewGates.riskRouting.mode', ['warn', 'block'] as const, errors);
  expectBoolean(riskRouting, 'reviewGates.riskRouting.requireScopedReviewHandoff', errors);
  expectBoolean(riskRouting, 'reviewGates.riskRouting.requireParentSizeRisk', errors);
  expectBoolean(riskRouting, 'reviewGates.riskRouting.requireParentReviewHandoff', errors);
  expectStringArray(riskRouting, 'reviewGates.riskRouting.riskyChangedPathGlobs', errors);
  expectBoolean(riskRouting, 'reviewGates.riskRouting.highRiskRequiresCodeReview', errors);
  expectReviewHandoffFlows(riskRouting, errors);
}

function validateBrowserProofConfig(acceptanceProof: ObjectRecord, errors: string[]): void {
  const browserProof = expectOptionalObject(acceptanceProof, 'reviewGates.acceptanceProof.browserProof', errors);
  if (!browserProof) {
    return;
  }
  expectOptionalString(browserProof, 'reviewGates.acceptanceProof.browserProof.scenarioPath', errors);
  expectOptionalString(browserProof, 'reviewGates.acceptanceProof.browserProof.baseUrl', errors);
  expectBoolean(browserProof, 'reviewGates.acceptanceProof.browserProof.strictConsoleErrors', errors);
  expectBoolean(browserProof, 'reviewGates.acceptanceProof.browserProof.strictNetworkFailures', errors);
}

function validateLoopPolicy(parent: ObjectRecord, errors: string[]): void {
  const issueSelection = expectObject(parent, 'loopPolicy.issueSelection', errors);
  if (issueSelection) {
    expectStringArray(issueSelection, 'loopPolicy.issueSelection.priorityLabels', errors);
    expectUnion(issueSelection, 'loopPolicy.issueSelection.tieBreaker', ['issue-number-asc'] as const, errors);
  }

  const rework = expectObject(parent, 'loopPolicy.rework', errors);
  if (rework) {
    expectNonNegativeInteger(rework, 'loopPolicy.rework.maxAttempts', errors);
    expectRetryableBlockers(rework, errors);
  }

  const freshContextReview = expectObject(parent, 'loopPolicy.freshContextReview', errors);
  if (freshContextReview) {
    expectBoolean(freshContextReview, 'loopPolicy.freshContextReview.enabled', errors);
    expectUnion(freshContextReview, 'loopPolicy.freshContextReview.mode', ['advisory'] as const, errors);
    expectBoolean(
      freshContextReview,
      'loopPolicy.freshContextReview.blockOnHighConfidencePolicyViolations',
      errors,
    );
  }

  const durableRunSummaries = expectObject(parent, 'loopPolicy.durableRunSummaries', errors);
  if (durableRunSummaries) {
    expectBoolean(durableRunSummaries, 'loopPolicy.durableRunSummaries.enabled', errors);
  }

  const policySuggestions = expectObject(parent, 'loopPolicy.policySuggestions', errors);
  if (policySuggestions) {
    expectBoolean(policySuggestions, 'loopPolicy.policySuggestions.enabled', errors);
    expectPositiveInteger(policySuggestions, 'loopPolicy.policySuggestions.maxSuggestions', errors);
  }
}

function validateQualityGate(parent: ObjectRecord, errors: string[]): void {
  const quality = expectObject(parent, 'reviewGates.quality', errors);
  if (!quality) {
    return;
  }

  expectBoolean(quality, 'reviewGates.quality.enabled', errors);
  expectStringArray(quality, 'reviewGates.quality.runtimeChangedPathGlobs', errors);
  expectStringArray(quality, 'reviewGates.quality.testChangedPathGlobs', errors);

  const tdd = expectObject(quality, 'reviewGates.quality.tdd', errors);
  if (tdd) {
    expectBoolean(tdd, 'reviewGates.quality.tdd.enabled', errors);
    expectBoolean(tdd, 'reviewGates.quality.tdd.requireTestChange', errors);
    expectStringArray(tdd, 'reviewGates.quality.tdd.requiredValidationPatterns', errors);
    validateRegexArray(tdd, 'reviewGates.quality.tdd.requiredValidationPatterns', errors);
  }

  const cleanupReview = expectObject(quality, 'reviewGates.quality.cleanupReview', errors);
  if (cleanupReview) {
    expectBoolean(cleanupReview, 'reviewGates.quality.cleanupReview.enabled', errors);
    expectPositiveInteger(cleanupReview, 'reviewGates.quality.cleanupReview.runtimeFileThreshold', errors);
    expectStringArray(cleanupReview, 'reviewGates.quality.cleanupReview.requiredValidationPatterns', errors);
    validateRegexArray(cleanupReview, 'reviewGates.quality.cleanupReview.requiredValidationPatterns', errors);
  }

  const codeReview = expectObject(quality, 'reviewGates.quality.codeReview', errors);
  if (codeReview) {
    expectBoolean(codeReview, 'reviewGates.quality.codeReview.enabled', errors);
    expectStringArray(codeReview, 'reviewGates.quality.codeReview.requiredValidationPatterns', errors);
    validateRegexArray(codeReview, 'reviewGates.quality.codeReview.requiredValidationPatterns', errors);
  }
}

function validateWorktreeCleanup(parent: ObjectRecord, errors: string[]): void {
  const value = readPath(parent, 'runner.worktreeCleanup');
  if (value === undefined) {
    return;
  }

  const worktreeCleanup = asObject(value);
  if (!worktreeCleanup) {
    errors.push('runner.worktreeCleanup must be an object when provided');
    return;
  }

  expectBoolean(worktreeCleanup, 'runner.worktreeCleanup.enabled', errors);
}

function validateResolutionMission(parent: ObjectRecord, errors: string[]): void {
  const resolutionMission = expectOptionalObject(parent, 'runner.resolutionMission', errors);
  if (!resolutionMission) {
    return;
  }

  const mode = readPath(resolutionMission, 'runner.resolutionMission.mode');
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'enabled') {
    errors.push('runner.resolutionMission.mode must be off, shadow, or enabled');
  }
  const markerLabel = expectString(resolutionMission, 'runner.resolutionMission.markerLabel', errors);
  if (markerLabel !== undefined && markerLabel.trim().length === 0) {
    errors.push('runner.resolutionMission.markerLabel must contain non-whitespace characters');
  }
}

function expectOptionalString(parent: ObjectRecord, path: string, errors: string[]): string | undefined {
  const value = readPath(parent, path);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    errors.push(`${path} must be a string when provided`);
    return undefined;
  }

  return value;
}

function expectPositiveInteger(parent: ObjectRecord, path: string, errors: string[]): number | undefined {
  const value = readPath(parent, path);

  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1) {
    errors.push(`${path} must be a positive integer`);
    return undefined;
  }

  return value;
}

function expectNonNegativeInteger(parent: ObjectRecord, path: string, errors: string[]): number | undefined {
  const value = readPath(parent, path);

  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0) {
    errors.push(`${path} must be a non-negative integer`);
    return undefined;
  }

  return value;
}

function expectRetryableBlockers(parent: ObjectRecord, errors: string[]): RetryableReworkBlocker[] | undefined {
  const validBlockers = [
    'missing-completion-report',
    'idle-timeout-before-change',
    'incomplete-after-progress',
    'invalid-completion-report',
    'no-changed-files',
    'failed-configured-checks',
    'missing-quality-gate-evidence',
    'failed-acceptance-proof',
    'risk-routing-policy',
    'optional-figma-mcp-failure',
  ] as const;
  const value = readPath(parent, 'loopPolicy.rework.retryableBlockers');

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !validBlockers.includes(item as RetryableReworkBlocker))) {
    errors.push(`loopPolicy.rework.retryableBlockers must contain only ${validBlockers.join(', ')}`);
    return undefined;
  }

  return value as RetryableReworkBlocker[];
}

function expectReviewHandoffFlows(parent: ObjectRecord, errors: string[]): ReviewHandoffFlow[] | undefined {
  const value = readPath(parent, 'reviewGates.riskRouting.allowedLowRiskFlows');

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !reviewHandoffFlows.includes(item as ReviewHandoffFlow))) {
    errors.push(`reviewGates.riskRouting.allowedLowRiskFlows must contain only ${reviewHandoffFlows.join(', ')}`);
    return undefined;
  }

  return value as ReviewHandoffFlow[];
}

function expectOptionalPositiveInteger(parent: ObjectRecord, path: string, errors: string[]): number | undefined {
  const value = readPath(parent, path);

  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1) {
    errors.push(`${path} must be a positive integer when provided`);
    return undefined;
  }

  return value;
}

function validateRegexArray(parent: ObjectRecord, path: string, errors: string[]): void {
  const value = readPath(parent, path);
  if (!Array.isArray(value)) {
    return;
  }

  for (const pattern of value) {
    if (typeof pattern !== 'string') {
      continue;
    }
    try {
      new RegExp(pattern, 'iu');
    } catch {
      errors.push(`${path} contains invalid regular expression ${pattern}`);
    }
  }
}

function validateEnvironmentVariableNames(parent: ObjectRecord, path: string, errors: string[]): void {
  const value = readPath(parent, path);
  if (!Array.isArray(value)) {
    return;
  }

  const hasInvalidName = value.some((name) => typeof name === 'string' && !/^[A-Z_][A-Z0-9_]*$/u.test(name));
  if (hasInvalidName) {
    errors.push(`${path} must contain valid environment variable names`);
  }
}
