import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { forbiddenRuntimeKeys } from '../config/constants.js';
import type { BaseBranchConfig, CodexFigmaMcpConfig, CodexOrchestratorConfig, LabelDefinition, LabelPreparationPolicy } from '../config/schema.js';
import { validateConfig } from '../config/schema.js';
import type { WorkflowConfigMap } from './workflows.js';

export interface BuildProjectConfigInput {
  owner: string;
  repo: string;
  prepareLabels: LabelPreparationPolicy;
  workflows: WorkflowConfigMap;
  baseBranch?: BaseBranchConfig;
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

export const packageOwnedDefaultChecks: CodexOrchestratorConfig['checks'] = {
  typecheck: 'npm run typecheck',
  test: 'npm test',
};

export const packageOwnedMobileVisualProofCommand = 'codex-orchestrator visual-proof mobile --issue ${issueNumber}';
export const packageOwnedAutoVisualProofCommand = 'codex-orchestrator visual-proof auto --issue ${issueNumber}';

export function defaultFigmaMcpConfig(): CodexFigmaMcpConfig {
  return {
    enabled: true,
    url: 'https://mcp.figma.com/mcp',
    httpHeaders: {
      'X-Figma-Region': 'us-east-1',
    },
    optionalIssueTextPatterns: [
      'https?://(?:www\\.)?figma\\.com/\\S+',
      '\\bFigma\\b.{0,80}\\b(design|file|node|mockup|prototype|дизайн|макет)\\b',
      '\\b(design|file|node|mockup|prototype|дизайн|макет)\\b.{0,80}\\bFigma\\b',
    ],
    requiredIssueTextPatterns: [
      '\\b(?:must|requires?|required)\\b.{0,80}\\bFigma\\b',
      '\\bFigma\\b.{0,80}\\b(?:must|required|source of truth)\\b',
    ],
    optionalFailure: 'retry-without-mcp',
    requiredFailure: 'block',
  };
}

export function defaultAcceptanceProofConfig(): CodexOrchestratorConfig['reviewGates']['acceptanceProof'] {
  return {
    enabled: true,
    proofStrategy: 'auto',
    artifactDir: '.codex-orchestrator/proofs',
    issueTextPatterns: [
      '\\bUI\\b',
      'frontend',
      'responsive',
      'layout',
      'visual',
      'screenshot',
      '\\bAPI\\b',
      'worker',
      '\\bCLI\\b',
      'скриншот',
      'скріншот',
      'viewport',
      'dark theme',
      'мобіл',
      'mobile',
    ],
    changedPathGlobs: [
      'src/frontend/**',
      'frontend/**',
      'app/**',
      'pages/**',
      'components/**',
    ],
    proofOwnedPathGlobs: [
      '.codex-orchestrator/proofs/**',
    ],
    runnerValidationCommand: packageOwnedAutoVisualProofCommand,
    runnerTimeoutMs: 900_000,
    envPassthrough: [],
    browserProof: {
      strictConsoleErrors: false,
      strictNetworkFailures: false,
    },
    maxIterations: 5,
  };
}

export function defaultRiskRoutingConfig(): CodexOrchestratorConfig['reviewGates']['riskRouting'] {
  return {
    enabled: true,
    mode: 'warn',
    requireScopedReviewHandoff: true,
    requireParentSizeRisk: true,
    requireParentReviewHandoff: true,
    riskyChangedPathGlobs: [],
    highRiskRequiresCodeReview: true,
    allowedLowRiskFlows: ['small-task-implementer', 'scoped-implementation'],
  };
}

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
      maxParallelScopedIssues: 3,
      stateDir: '.codex-orchestrator/state',
      allowAgentLocalCommits: false,
      worktreeCleanup: {
        enabled: true,
      },
    },
    codex: {
      adapter: 'codex-cli',
      command: 'codex',
      args: [
        'exec',
        '--cd',
        '${worktreePath}',
        '--sandbox',
        'workspace-write',
        '--add-dir',
        '${stateDir}',
        '--ignore-user-config',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '--output-last-message',
        '${reportPath}',
        '-',
      ],
      timeoutMs: 1_800_000,
      mobileTimeoutMs: 3_600_000,
      idleTimeoutMs: 300_000,
      ignoreUserConfig: true,
      figmaMcp: defaultFigmaMcpConfig(),
      profiles: {},
      promptFileEnv: 'CODEX_ORCHESTRATOR_PROMPT_FILE',
      reportFileEnv: 'CODEX_ORCHESTRATOR_REPORT_FILE',
    },
    project: {
      configDir: '.codex-orchestrator',
      promptsDir: '.codex-orchestrator/prompts',
    },
    workflows: input.workflows,
    checks: packageOwnedDefaultChecks,
    checksPolicy: {
      missingNpmScript: 'skip',
      lintBaseline: {
        mode: 'strict',
      },
    },
    reviewGates: {
      acceptanceProof: defaultAcceptanceProofConfig(),
      visualProof: {
        enabled: true,
        artifactDir: '.codex-orchestrator/proofs',
        issueTextPatterns: [
          '\\bUI\\b',
          'frontend',
          'responsive',
          'layout',
          'visual',
          'screenshot',
          'скриншот',
          'скріншот',
          'viewport',
          'dark theme',
          'мобіл',
          'mobile',
        ],
        changedPathGlobs: [
          'src/frontend/**',
          'frontend/**',
          'app/**',
          'pages/**',
          'components/**',
        ],
        requiredValidationPatterns: [
          'Playwright',
          'screenshot',
          'visual',
          'viewport',
          'runner visual proof',
        ],
        blockOnSkippedPatterns: [
          'Playwright',
          'screenshot',
          'visual',
          'viewport',
          'runner visual proof',
        ],
        minScreenshotArtifacts: 1,
        requireWhenDesirable: false,
        runnerValidationCommand: packageOwnedAutoVisualProofCommand,
        runnerTimeoutMs: 900_000,
        envPassthrough: [],
      },
      quality: {
        enabled: true,
        runtimeChangedPathGlobs: [
          'src/**',
          'app/**',
          'pages/**',
          'components/**',
          'lib/**',
          'packages/**',
          '*.js',
          '*.jsx',
          '*.ts',
          '*.tsx',
          '*.mjs',
          '*.cjs',
        ],
        testChangedPathGlobs: [
          'test/**',
          'tests/**',
          '__tests__/**',
          '*.test.*',
          '*.spec.*',
          'src/**/*.test.*',
          'src/**/*.spec.*',
        ],
        tdd: {
          enabled: true,
          requireTestChange: true,
          requiredValidationPatterns: [
            'red.*green',
            'fail(?:ed|ing)?.*pass(?:ed|ing)?',
            'test.*fail(?:ed|ing)?.*test.*pass(?:ed|ing)?',
          ],
        },
        cleanupReview: {
          enabled: true,
          runtimeFileThreshold: 3,
          requiredValidationPatterns: [
            '\\$?cleanup-review',
            'cleanup review',
          ],
        },
        codeReview: {
          enabled: true,
          requiredValidationPatterns: [
            '\\$?code-review',
            'code review',
          ],
        },
      },
      riskRouting: defaultRiskRoutingConfig(),
    },
    loopPolicy: {
      issueSelection: {
        priorityLabels: ['priority:critical', 'priority:high', 'priority:medium', 'priority:low'],
        tieBreaker: 'issue-number-asc',
      },
      rework: {
        maxAttempts: 1,
        retryableBlockers: [
          'missing-completion-report',
          'idle-timeout-before-change',
          'incomplete-after-progress',
          'invalid-completion-report',
          'no-changed-files',
          'failed-configured-checks',
          'missing-quality-gate-evidence',
          'failed-acceptance-proof',
          'optional-figma-mcp-failure',
        ],
      },
      freshContextReview: {
        enabled: false,
        mode: 'advisory',
        blockOnHighConfidencePolicyViolations: true,
      },
      durableRunSummaries: {
        enabled: true,
      },
      policySuggestions: {
        enabled: true,
        maxSuggestions: 5,
      },
    },
    deny: {
      secretFiles: ['.env', '.env.*'],
      destructiveDbOrCache: true,
      productionDeployOrRelease: true,
      additionalPathGlobs: [],
    },
    branches: {
      base: input.baseBranch ?? { mode: 'explicit', remote: 'origin', branch: 'main' },
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

export function mergeExistingProjectConfig(
  defaults: CodexOrchestratorConfig,
  existing: Record<string, unknown> | undefined,
): CodexOrchestratorConfig {
  if (!existing) {
    return defaults;
  }

  const existingGithub = readObject(existing.github);
  const existingRunner = readObject(existing.runner);
  const existingCodex = readObject(existing.codex);
  const existingProject = readObject(existing.project);
  const existingWorkflows = readObject(existing.workflows);
  const existingChecks = readStringRecord(existing.checks);
  const existingChecksPolicy = readObject(existing.checksPolicy);
  const existingReviewGates = readObject(existing.reviewGates);
  const existingAcceptanceProof = readObject(existingReviewGates?.acceptanceProof);
  const existingVisualProof = readObject(existingReviewGates?.visualProof);
  const existingQuality = readObject(existingReviewGates?.quality);
  const existingRiskRouting = readObject(existingReviewGates?.riskRouting);
  const existingLoopPolicy = readObject(existing.loopPolicy);
  const existingIssueSelection = readObject(existingLoopPolicy?.issueSelection);
  const existingRework = readObject(existingLoopPolicy?.rework);
  const existingFreshContextReview = readObject(existingLoopPolicy?.freshContextReview);
  const existingDurableRunSummaries = readObject(existingLoopPolicy?.durableRunSummaries);
  const existingPolicySuggestions = readObject(existingLoopPolicy?.policySuggestions);
  const existingDeny = readObject(existing.deny);
  const existingBranches = readObject(existing.branches);
  const existingPullRequests = readObject(existing.pullRequests);
  const existingIssueClassification = readObject(existing.issueClassification);

  const defaultChecksPolicy = defaults.checksPolicy ?? {};
  return {
    ...defaults,
    github: {
      ...defaults.github,
      ...existingGithub,
      owner: defaults.github.owner,
      repo: defaults.github.repo,
      prepareLabels: defaults.github.prepareLabels,
      labels: {
        ...defaults.github.labels,
        ...readObject(existingGithub?.labels),
      },
    },
    runner: {
      ...defaults.runner,
      ...existingRunner,
    },
    codex: {
      ...defaults.codex,
      ...existingCodex,
      args: migrateCodexArgs(readStringArray(existingCodex?.args), defaults.codex.args),
      timeoutMs: migrateCodexTimeout(readPositiveInteger(existingCodex?.timeoutMs), defaults.codex.timeoutMs ?? 1_800_000),
      mobileTimeoutMs: readPositiveInteger(existingCodex?.mobileTimeoutMs) ?? defaults.codex.mobileTimeoutMs,
      idleTimeoutMs: readPositiveInteger(existingCodex?.idleTimeoutMs) ?? defaults.codex.idleTimeoutMs,
      ignoreUserConfig: readBoolean(existingCodex?.ignoreUserConfig) ?? defaults.codex.ignoreUserConfig,
      figmaMcp: migrateFigmaMcpConfig(defaults.codex.figmaMcp, readObject(existingCodex?.figmaMcp)),
      profiles: (readObject(existingCodex?.profiles) as CodexOrchestratorConfig['codex']['profiles'] | undefined)
        ?? defaults.codex.profiles,
      promptFileEnv: defaults.codex.promptFileEnv,
      reportFileEnv: defaults.codex.reportFileEnv,
      adapter: defaults.codex.adapter,
    },
    project: {
      ...defaults.project,
      ...existingProject,
    },
    workflows: migrateWorkflowConfigs(defaults.workflows, existingWorkflows),
    checks: existingChecks ?? defaults.checks,
    checksPolicy: {
      ...defaultChecksPolicy,
      ...existingChecksPolicy,
      lintBaseline: {
        ...readObject((defaultChecksPolicy as Record<string, unknown>).lintBaseline),
        ...readObject(existingChecksPolicy?.lintBaseline),
      },
    },
    reviewGates: {
      ...defaults.reviewGates,
      ...existingReviewGates,
      acceptanceProof: migrateAcceptanceProofConfig(
        defaults.reviewGates.acceptanceProof,
        existingAcceptanceProof,
      ),
      visualProof: migrateVisualProofConfig(defaults.reviewGates.visualProof, existingVisualProof),
      quality: {
        ...defaults.reviewGates.quality,
        ...existingQuality,
        tdd: {
          ...defaults.reviewGates.quality.tdd,
          ...readObject(existingQuality?.tdd),
        },
        cleanupReview: {
          ...defaults.reviewGates.quality.cleanupReview,
          ...readObject(existingQuality?.cleanupReview),
        },
        codeReview: {
          ...defaults.reviewGates.quality.codeReview,
          ...readObject(existingQuality?.codeReview),
        },
      },
      riskRouting: {
        ...defaults.reviewGates.riskRouting,
        ...existingRiskRouting,
        allowedLowRiskFlows: readStringArray(existingRiskRouting?.allowedLowRiskFlows)
          ?? defaults.reviewGates.riskRouting.allowedLowRiskFlows,
        riskyChangedPathGlobs: readStringArray(existingRiskRouting?.riskyChangedPathGlobs)
          ?? defaults.reviewGates.riskRouting.riskyChangedPathGlobs,
      },
    },
    loopPolicy: {
      ...defaults.loopPolicy,
      ...existingLoopPolicy,
      issueSelection: {
        ...defaults.loopPolicy.issueSelection,
        ...existingIssueSelection,
      },
      rework: {
        ...defaults.loopPolicy.rework,
        ...existingRework,
        retryableBlockers: migrateRetryableBlockers(
          defaults.loopPolicy.rework.retryableBlockers,
          readStringArray(existingRework?.retryableBlockers),
        ),
      },
      freshContextReview: {
        ...defaults.loopPolicy.freshContextReview,
        ...existingFreshContextReview,
      },
      durableRunSummaries: {
        ...defaults.loopPolicy.durableRunSummaries,
        ...existingDurableRunSummaries,
      },
      policySuggestions: {
        ...defaults.loopPolicy.policySuggestions,
        ...existingPolicySuggestions,
      },
    },
    deny: {
      ...defaults.deny,
      ...existingDeny,
    },
    branches: {
      ...defaults.branches,
      ...existingBranches,
      base: migrateBaseBranch(existingBranches?.base, defaults.branches.base),
    },
    pullRequests: {
      ...defaults.pullRequests,
      ...existingPullRequests,
    },
    issueClassification: {
      ...defaults.issueClassification,
      ...existingIssueClassification,
    },
  } as CodexOrchestratorConfig;
}

export async function applyTargetPackageConfigDefaults(
  targetRoot: string,
  config: CodexOrchestratorConfig,
): Promise<CodexOrchestratorConfig> {
  return {
    ...config,
    checks: await adaptPackageOwnedChecks(targetRoot, config),
    reviewGates: {
      ...config.reviewGates,
      acceptanceProof: migrateAcceptanceProofConfig(
        config.reviewGates.acceptanceProof,
        config.reviewGates.acceptanceProof,
      ),
      visualProof: migrateVisualProofConfig(config.reviewGates.visualProof, config.reviewGates.visualProof),
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

async function adaptPackageOwnedChecks(
  targetRoot: string,
  config: CodexOrchestratorConfig,
): Promise<CodexOrchestratorConfig['checks']> {
  if ((config.checksPolicy?.missingNpmScript ?? 'skip') !== 'skip') {
    return config.checks;
  }

  if (!Object.entries(config.checks).some(([name, command]) => isPackageOwnedDefaultCheck(name, command))) {
    return config.checks;
  }

  const scripts = await readPackageScripts(targetRoot);
  const entries = Object.entries(config.checks).filter(([name, command]) => {
    if (!isPackageOwnedDefaultCheck(name, command)) {
      return true;
    }

    const script = npmScriptName(command);
    return script !== undefined && scripts.has(script);
  });
  return Object.fromEntries(entries);
}

async function readPackageScripts(targetRoot: string): Promise<Set<string>> {
  let content = '';
  try {
    content = await readFile(join(targetRoot, 'package.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }

  const parsed = JSON.parse(content) as { scripts?: unknown };
  if (typeof parsed.scripts !== 'object' || parsed.scripts === null || Array.isArray(parsed.scripts)) {
    return new Set();
  }
  return new Set(Object.entries(parsed.scripts)
    .filter(([, value]) => typeof value === 'string')
    .map(([name]) => name));
}

function isPackageOwnedDefaultCheck(name: string, command: string): boolean {
  return packageOwnedDefaultChecks[name] === command;
}

function npmScriptName(command: string): string | undefined {
  if (command === 'npm test') {
    return 'test';
  }
  return /^npm\s+run(?:-script)?\s+([^\s]+)/u.exec(command)?.[1];
}

function migrateVisualProofConfig(
  defaults: CodexOrchestratorConfig['reviewGates']['visualProof'],
  existing: Record<string, unknown> | CodexOrchestratorConfig['reviewGates']['visualProof'] | undefined,
): CodexOrchestratorConfig['reviewGates']['visualProof'] {
  const visualProof = {
    ...defaults,
    ...existing,
  } as CodexOrchestratorConfig['reviewGates']['visualProof'];
  const command = visualProof.runnerValidationCommand?.trim();
  if (visualProof.enabled && !command) {
    visualProof.runnerValidationCommand = packageOwnedAutoVisualProofCommand;
  }
  return visualProof;
}

function migrateAcceptanceProofConfig(
  defaults: CodexOrchestratorConfig['reviewGates']['acceptanceProof'],
  existing: Record<string, unknown> | CodexOrchestratorConfig['reviewGates']['acceptanceProof'] | undefined,
): CodexOrchestratorConfig['reviewGates']['acceptanceProof'] {
  const acceptanceProof = {
    ...defaults,
    ...existing,
  } as CodexOrchestratorConfig['reviewGates']['acceptanceProof'];
  acceptanceProof.proofStrategy = acceptanceProof.proofStrategy ?? defaults.proofStrategy;
  const command = acceptanceProof.runnerValidationCommand?.trim();
  if (acceptanceProof.enabled && !command) {
    acceptanceProof.runnerValidationCommand = packageOwnedAutoVisualProofCommand;
  }
  return acceptanceProof;
}

function migrateRetryableBlockers(
  defaults: CodexOrchestratorConfig['loopPolicy']['rework']['retryableBlockers'],
  existing: string[] | undefined,
): CodexOrchestratorConfig['loopPolicy']['rework']['retryableBlockers'] {
  return Array.from(new Set([...(existing ?? defaults), ...defaults])) as CodexOrchestratorConfig['loopPolicy']['rework']['retryableBlockers'];
}

function migrateFigmaMcpConfig(
  defaults: CodexFigmaMcpConfig | undefined,
  existing: Record<string, unknown> | undefined,
): CodexFigmaMcpConfig | undefined {
  if (!defaults) {
    return undefined;
  }
  if (!existing) {
    return defaults;
  }
  return {
    enabled: readBoolean(existing.enabled) ?? defaults.enabled,
    url: readString(existing.url) ?? defaults.url,
    httpHeaders: readStringRecord(existing.httpHeaders) ?? defaults.httpHeaders,
    optionalIssueTextPatterns: readStringArray(existing.optionalIssueTextPatterns)
      ?? readStringArray(existing.issueTextPatterns)
      ?? defaults.optionalIssueTextPatterns,
    requiredIssueTextPatterns: readStringArray(existing.requiredIssueTextPatterns) ?? defaults.requiredIssueTextPatterns,
    optionalFailure: 'retry-without-mcp',
    requiredFailure: 'block',
  };
}

function label(name: string, color: string, description: string): LabelDefinition {
  return { name, color, description };
}

function migrateWorkflowConfigs(
  defaults: WorkflowConfigMap,
  existingWorkflows: Record<string, unknown> | undefined,
): WorkflowConfigMap {
  const entries = Object.entries(defaults).map(([id, workflow]) => {
    const existing = readObject(existingWorkflows?.[id]);
    const promptPath = readString(existing?.promptPath) ?? workflow.promptPath;
    return [
      id,
      {
        skillName: workflow.skillName,
        source: 'package-bundled-prompt',
        promptPath,
      },
    ] as const;
  });

  return Object.fromEntries(entries) as WorkflowConfigMap;
}

function migrateCodexArgs(existingArgs: string[] | undefined, defaultArgs: string[]): string[] {
  const args = existingArgs ?? defaultArgs;
  const migrated = [...args];

  if (migrated[0] !== 'exec') {
    return migrated;
  }

  if (!migrated.includes('--ignore-user-config')) {
    const insertAt = migrated[0] === 'exec' ? 1 : 0;
    migrated.splice(insertAt, 0, '--ignore-user-config');
  }

  if (!migrated.includes('sandbox_workspace_write.network_access=true')) {
    const outputIndex = migrated.indexOf('--output-last-message');
    const insertAt = outputIndex >= 0 ? outputIndex : migrated.length;
    migrated.splice(insertAt, 0, '-c', 'sandbox_workspace_write.network_access=true');
  }

  return migrated;
}

function migrateBaseBranch(existingBase: unknown, defaultBase: BaseBranchConfig): BaseBranchConfig {
  if (typeof existingBase === 'string' && existingBase.length > 0) {
    return { mode: 'explicit', remote: 'origin', branch: existingBase };
  }

  const objectBase = readObject(existingBase);
  if (
    objectBase?.mode === 'explicit'
    && typeof objectBase.remote === 'string'
    && objectBase.remote.length > 0
    && typeof objectBase.branch === 'string'
    && objectBase.branch.length > 0
  ) {
    return { mode: 'explicit', remote: objectBase.remote, branch: objectBase.branch };
  }

  return defaultBase;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  const object = readObject(value);
  if (!object || Object.values(object).some((item) => typeof item !== 'string')) {
    return undefined;
  }
  return object as Record<string, string>;
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === 'number' && value > 0 ? value : undefined;
}

function migrateCodexTimeout(existingTimeoutMs: number | undefined, defaultTimeoutMs: number): number {
  if (existingTimeoutMs === undefined || existingTimeoutMs === 600_000) {
    return defaultTimeoutMs;
  }
  return existingTimeoutMs;
}
