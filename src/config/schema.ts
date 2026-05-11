import {
  forbiddenRuntimeKeys,
  labelKeys,
  labelPreparationPolicies,
  workflowKeys,
  workflowSources,
} from './constants.js';

export type LabelKey = (typeof labelKeys)[number];
export type LabelPreparationPolicy = 'report-only' | 'create-missing';
export type WorkflowId = (typeof workflowKeys)[number];
export type WorkflowSource = (typeof workflowSources)[number];
export type ClarificationGate = 'block-and-comment';

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
    stateDir: string;
    worktreeCleanup?: {
      enabled: boolean;
    };
  };
  codex: {
    adapter: 'codex-cli';
    command: string;
    args: string[];
    timeoutMs?: number;
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
  };
  checks: Record<string, string>;
  reviewGates: {
    visualProof: {
      enabled: boolean;
      artifactDir: string;
      issueTextPatterns: string[];
      changedPathGlobs: string[];
      requiredValidationPatterns: string[];
      blockOnSkippedPatterns: string[];
      minScreenshotArtifacts: number;
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
  };
  deny: {
    secretFiles: string[];
    destructiveDbOrCache: boolean;
    productionDeployOrRelease: boolean;
    additionalPathGlobs: string[];
  };
  branches: {
    base: string;
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

export type ConfigValidationResult =
  | { ok: true; value: CodexOrchestratorConfig }
  | { ok: false; errors: string[] };

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
  const reviewGates = expectObject(root, 'reviewGates', errors);
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
    expectString(runner, 'runner.stateDir', errors);
    validateWorktreeCleanup(runner, errors);
  }

  if (codex) {
    expectLiteral(codex, 'codex.adapter', 'codex-cli', errors);
    expectString(codex, 'codex.command', errors);
    expectStringArray(codex, 'codex.args', errors);
    expectOptionalPositiveInteger(codex, 'codex.timeoutMs', errors);
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

  if (reviewGates) {
    validateReviewGates(reviewGates, errors);
  }

  if (deny) {
    expectStringArray(deny, 'deny.secretFiles', errors);
    expectBoolean(deny, 'deny.destructiveDbOrCache', errors);
    expectBoolean(deny, 'deny.productionDeployOrRelease', errors);
    expectStringArray(deny, 'deny.additionalPathGlobs', errors);
  }

  if (branches) {
    expectString(branches, 'branches.base', errors);
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

  return { ok: true, value: input as CodexOrchestratorConfig };
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

  if (source === 'package-owned-prompt-fallback') {
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

function validateReviewGates(parent: ObjectRecord, errors: string[]): void {
  const visualProof = expectObject(parent, 'reviewGates.visualProof', errors);
  if (visualProof) {
    expectBoolean(visualProof, 'reviewGates.visualProof.enabled', errors);
    expectString(visualProof, 'reviewGates.visualProof.artifactDir', errors);
    expectStringArray(visualProof, 'reviewGates.visualProof.issueTextPatterns', errors);
    expectStringArray(visualProof, 'reviewGates.visualProof.changedPathGlobs', errors);
    expectStringArray(visualProof, 'reviewGates.visualProof.requiredValidationPatterns', errors);
    expectStringArray(visualProof, 'reviewGates.visualProof.blockOnSkippedPatterns', errors);
    expectPositiveInteger(visualProof, 'reviewGates.visualProof.minScreenshotArtifacts', errors);
    expectOptionalString(visualProof, 'reviewGates.visualProof.runnerValidationCommand', errors);
    expectOptionalPositiveInteger(visualProof, 'reviewGates.visualProof.runnerTimeoutMs', errors);
    expectOptionalStringArray(visualProof, 'reviewGates.visualProof.envPassthrough', errors);
    validateEnvironmentVariableNames(visualProof, 'reviewGates.visualProof.envPassthrough', errors);
    validateRegexArray(visualProof, 'reviewGates.visualProof.issueTextPatterns', errors);
    validateRegexArray(visualProof, 'reviewGates.visualProof.requiredValidationPatterns', errors);
    validateRegexArray(visualProof, 'reviewGates.visualProof.blockOnSkippedPatterns', errors);
  }

  validateQualityGate(parent, errors);
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
