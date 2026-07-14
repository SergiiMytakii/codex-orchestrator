import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../src/config/schema.js';
import { validConfig } from './fixtures/config.js';

test('accepts the expanded valid config contract', () => {
  const result = validateConfig(validConfig);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.github.labels.auto.name, 'agent:auto');
    assert.equal(result.value.runner.maxParallelChildren, 3);
    assert.equal(result.value.runner.maxParallelScopedIssues, 3);
    assert.equal(result.value.runner.allowAgentLocalCommits, false);
    assert.equal(result.value.workflows.prd.source, 'package-bundled-prompt');
    assert.equal(result.value.codex.command, 'codex');
    assert.equal(result.value.codex.timeoutMs, 1_800_000);
    assert.equal(result.value.codex.mobileTimeoutMs, 3_600_000);
    assert.equal(result.value.codex.idleTimeoutMs, 300_000);
    assert.equal(result.value.codex.ignoreUserConfig, true);
    assert.equal(result.value.codex.figmaMcp?.enabled, true);
    assert.equal(result.value.codex.figmaMcp?.url, 'https://mcp.figma.com/mcp');
    assert.deepEqual(result.value.codex.figmaMcp?.httpHeaders, { 'X-Figma-Region': 'us-east-1' });
    assert.deepEqual(result.value.codex.figmaMcp?.optionalIssueTextPatterns, [
      'https?://(?:www\\.)?figma\\.com/\\S+',
      '\\bFigma\\b.{0,80}\\b(design|file|node|mockup|prototype|дизайн|макет)\\b',
      '\\b(design|file|node|mockup|prototype|дизайн|макет)\\b.{0,80}\\bFigma\\b',
    ]);
    assert.deepEqual(result.value.codex.figmaMcp?.requiredIssueTextPatterns, [
      '\\b(?:must|requires?|required)\\b.{0,80}\\bFigma\\b',
      '\\bFigma\\b.{0,80}\\b(?:must|required|source of truth)\\b',
    ]);
    assert.equal(result.value.codex.figmaMcp?.optionalFailure, 'retry-without-mcp');
    assert.equal(result.value.codex.figmaMcp?.requiredFailure, 'block');
    assert.deepEqual(result.value.codex.profiles, {});
    assert.equal(result.value.reviewGates.visualProof.enabled, true);
    assert.equal(result.value.reviewGates.visualProof.minScreenshotArtifacts, 1);
    assert.equal(result.value.reviewGates.visualProof.requireWhenDesirable, false);
    assert.equal(result.value.reviewGates.visualProof.runnerTimeoutMs, 900_000);
    assert.deepEqual(result.value.reviewGates.visualProof.envPassthrough, []);
    assert.equal(result.value.reviewGates.acceptanceProof.enabled, true);
    assert.equal(result.value.reviewGates.acceptanceProof.proofStrategy, 'auto');
    assert.equal(result.value.reviewGates.acceptanceProof.artifactDir, '.codex-orchestrator/proofs');
    assert.equal(result.value.reviewGates.acceptanceProof.runnerValidationCommand, 'codex-orchestrator visual-proof auto --issue ${issueNumber}');
    assert.equal(result.value.reviewGates.acceptanceProof.maxIterations, 5);
    assert.deepEqual(result.value.reviewGates.acceptanceProof.browserProof, {
      strictConsoleErrors: false,
      strictNetworkFailures: false,
    });
    assert.deepEqual(result.value.reviewGates.acceptanceProof.proofOwnedPathGlobs, ['.codex-orchestrator/proofs/**']);
    assert.equal(result.value.reviewGates.quality.enabled, true);
    assert.equal(result.value.reviewGates.quality.tdd.requireTestChange, true);
    assert.equal(result.value.reviewGates.quality.cleanupReview.runtimeFileThreshold, 3);
    assert.deepEqual(result.value.reviewGates.riskRouting, {
      enabled: true,
      mode: 'warn',
      requireScopedReviewHandoff: true,
      requireParentSizeRisk: true,
      requireParentReviewHandoff: true,
      riskyChangedPathGlobs: [],
      highRiskRequiresCodeReview: true,
      allowedLowRiskFlows: ['small-task-implementer', 'scoped-implementation'],
    });
    assert.deepEqual(result.value.loopPolicy.issueSelection.priorityLabels, ['priority:critical', 'priority:high', 'priority:medium', 'priority:low']);
    assert.equal(result.value.loopPolicy.issueSelection.tieBreaker, 'issue-number-asc');
    assert.equal(result.value.loopPolicy.rework.maxAttempts, 1);
    assert.deepEqual(result.value.loopPolicy.rework.retryableBlockers, [
      'missing-completion-report',
      'idle-timeout-before-change',
      'incomplete-after-progress',
      'invalid-completion-report',
      'no-changed-files',
      'failed-configured-checks',
      'missing-quality-gate-evidence',
      'failed-acceptance-proof',
      'optional-figma-mcp-failure',
    ]);
    assert.equal(result.value.loopPolicy.freshContextReview.enabled, false);
    assert.equal(result.value.loopPolicy.freshContextReview.mode, 'advisory');
    assert.equal(result.value.loopPolicy.freshContextReview.blockOnHighConfidencePolicyViolations, true);
    assert.equal(result.value.loopPolicy.durableRunSummaries.enabled, true);
    assert.equal(result.value.loopPolicy.policySuggestions.enabled, true);
    assert.equal(result.value.loopPolicy.policySuggestions.maxSuggestions, 5);
    assert.deepEqual(result.value.codex.args, [
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
    ]);
    assert.deepEqual(result.value.branches.base, { mode: 'explicit', remote: 'origin', branch: 'main' });
    assert.equal(result.value.branches.scopedIssue, 'codex/issue-${issueNumber}');
  }
});

test('resolution mission accepts enabled mode after the compatibility gate', () => {
  for (const mode of ['off', 'shadow', 'enabled'] as const) {
    const result = validateConfig({
      ...validConfig,
      runner: {
        ...validConfig.runner,
        resolutionMission: {
          mode,
          markerLabel: 'agent:mission',
        },
      },
    });
    assert.equal(result.ok, true, mode);
  }

  const blankMarker = validateConfig({
    ...validConfig,
    runner: {
      ...validConfig.runner,
      resolutionMission: {
        mode: 'shadow',
        markerLabel: '   ',
      },
    },
  });
  assert.equal(blankMarker.ok, false);
  if (!blankMarker.ok) {
    assert.deepEqual(blankMarker.errors, [
      'runner.resolutionMission.markerLabel must contain non-whitespace characters',
    ]);
  }
});

test('accepts runner-classified idle recovery states as retryable rework blockers', () => {
  const result = validateConfig({
    ...validConfig,
    loopPolicy: {
      ...validConfig.loopPolicy,
      rework: {
        ...validConfig.loopPolicy.rework,
        retryableBlockers: [
          'missing-completion-report',
          'idle-timeout-before-change',
          'incomplete-after-progress',
        ],
      },
    },
  });

  assert.equal(result.ok, true);
});

test('accepts stale config without risk routing gate for migration compatibility', () => {
  const legacyReviewGates = { ...validConfig.reviewGates } as Record<string, unknown>;
  delete legacyReviewGates.riskRouting;

  const result = validateConfig({
    ...validConfig,
    reviewGates: legacyReviewGates,
  });

  assert.equal(result.ok, true);
});

test('normalizes legacy figma issue text patterns to optional figma policy', () => {
  const result = validateConfig({
    ...validConfig,
    codex: {
      ...validConfig.codex,
      figmaMcp: {
        enabled: true,
        url: 'https://mcp.figma.com/mcp',
        httpHeaders: {},
        issueTextPatterns: ['legacy figma link'],
      },
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.codex.figmaMcp?.optionalIssueTextPatterns, ['legacy figma link']);
    assert.deepEqual(result.value.codex.figmaMcp?.requiredIssueTextPatterns, []);
    assert.equal(result.value.codex.figmaMcp?.optionalFailure, 'retry-without-mcp');
    assert.equal(result.value.codex.figmaMcp?.requiredFailure, 'block');
  }
});

test('accepts legacy string base branch config for migration compatibility', () => {
  const result = validateConfig({
    ...validConfig,
    branches: {
      ...validConfig.branches,
      base: 'main',
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.branches.base, 'main');
  }
});

test('accepts config without scoped issue daemon concurrency for migration compatibility', () => {
  const legacyConfig = {
    ...validConfig,
    runner: {
      workspaceRoot: validConfig.runner.workspaceRoot,
      maxParallelChildren: validConfig.runner.maxParallelChildren,
      stateDir: validConfig.runner.stateDir,
      allowAgentLocalCommits: validConfig.runner.allowAgentLocalCommits,
      worktreeCleanup: validConfig.runner.worktreeCleanup,
    },
  };

  const result = validateConfig(legacyConfig);

  assert.equal(result.ok, true);
});

test('accepts scoped configured-check policy', () => {
  const result = validateConfig({
    ...validConfig,
    checksPolicy: {
      ...validConfig.checksPolicy,
      scope: {
        test: {
          phases: ['child', 'parent-integration'],
          changedPathGlobs: ['src/**', 'test/**'],
        },
      },
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.checksPolicy?.scope?.test?.phases, ['child', 'parent-integration']);
    assert.deepEqual(result.value.checksPolicy?.scope?.test?.changedPathGlobs, ['src/**', 'test/**']);
  }
});

test('rejects invalid scoped configured-check phase', () => {
  const result = validateConfig({
    ...validConfig,
    checksPolicy: {
      ...validConfig.checksPolicy,
      scope: {
        test: {
          phases: ['child', 'release'],
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'checksPolicy.scope.test.phases must contain only child, parent-integration',
  ]);
});

test('retryable blocker validation message includes runner-classified idle recovery states', () => {
  const result = validateConfig({
    ...validConfig,
    loopPolicy: {
      ...validConfig.loopPolicy,
      rework: {
        ...validConfig.loopPolicy.rework,
        retryableBlockers: ['unknown'],
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'loopPolicy.rework.retryableBlockers must contain only missing-completion-report, idle-timeout-before-change, incomplete-after-progress, invalid-completion-report, no-changed-files, failed-configured-checks, missing-quality-gate-evidence, failed-acceptance-proof, risk-routing-policy, optional-figma-mcp-failure',
  ]);
});

test('rejects invalid explicit base branch config', () => {
  const result = validateConfig({
    ...validConfig,
    branches: {
      ...validConfig.branches,
      base: {
        mode: 'explicit',
        remote: '',
        branch: '',
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'branches.base.remote must be a non-empty string',
    'branches.base.branch must be a non-empty string',
  ]);
});

test('accepts phase-specific codex profiles with deterministic fallback fields', () => {
  const result = validateConfig({
    ...validConfig,
    codex: {
      ...validConfig.codex,
      profiles: {
        'plan-parent': {
          command: 'codex-plan',
          args: ['exec', '--profile', '${sessionId}'],
          timeoutMs: 10_000,
          idleTimeoutMs: 5_000,
          env: {
            CODEX_ORCHESTRATOR_PHASE: 'plan-parent',
          },
        },
      },
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.codex.profiles?.['plan-parent']?.command, 'codex-plan');
  }
});

test('rejects invalid phase-specific codex profile config', () => {
  const result = validateConfig({
    ...validConfig,
    codex: {
      ...validConfig.codex,
      profiles: {
        unknown: {
          command: '',
        },
        'scoped-issue': {
          args: ['exec', ''],
          timeoutMs: 0,
          idleTimeoutMs: 0,
          env: {
            GH_TOKEN: 'secret',
          },
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'codex.profiles contains unknown phase unknown',
    'codex.profiles.scoped-issue.args must be an array of non-empty strings when provided',
    'codex.profiles.scoped-issue.timeoutMs must be a positive integer when provided',
    'codex.profiles.scoped-issue.idleTimeoutMs must be a positive integer when provided',
    'codex.profiles.scoped-issue.env must not contain forbidden key GH_TOKEN',
  ]);
});

test('rejects invalid codex command contract', () => {
  const result = validateConfig({
    ...validConfig,
    codex: {
      ...validConfig.codex,
      command: '',
      args: 'exec',
      timeoutMs: 0,
      mobileTimeoutMs: 0,
      idleTimeoutMs: 0,
      promptFileEnv: 'PROMPT',
      reportFileEnv: 'REPORT',
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'codex.command must be a non-empty string',
    'codex.args must be an array of non-empty strings',
    'codex.timeoutMs must be a positive integer when provided',
    'codex.mobileTimeoutMs must be a positive integer when provided',
    'codex.idleTimeoutMs must be a positive integer when provided',
    'codex.promptFileEnv must be CODEX_ORCHESTRATOR_PROMPT_FILE',
    'codex.reportFileEnv must be CODEX_ORCHESTRATOR_REPORT_FILE',
  ]);
});

test('rejects codex profile env attempts to disable mobile device guard', () => {
  const result = validateConfig({
    ...validConfig,
    codex: {
      ...validConfig.codex,
      profiles: {
        'scoped-issue': {
          env: {
            CODEX_ORCHESTRATOR_ALLOW_MOBILE_DEVICE_CONTROL: '1',
          },
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'codex.profiles.scoped-issue.env must not contain forbidden key CODEX_ORCHESTRATOR_ALLOW_MOBILE_DEVICE_CONTROL',
  ]);
});

test('rejects invalid scoped issue daemon concurrency', () => {
  const result = validateConfig({
    ...validConfig,
    runner: {
      ...validConfig.runner,
      maxParallelScopedIssues: 4,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'runner.maxParallelScopedIssues must be an integer between 1 and 3 when provided',
  ]);
});

test('rejects invalid workflow source with a dot-path error', () => {
  const result = validateConfig({
    ...validConfig,
    workflows: {
      ...validConfig.workflows,
      prd: {
        ...validConfig.workflows.prd,
        source: 'unknown',
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'workflows.prd.source must be one of existing-skill, package-owned-skill, package-bundled-prompt, package-owned-prompt-fallback',
  ]);
});

test('rejects invalid check commands', () => {
  const result = validateConfig({
    ...validConfig,
    checks: {
      test: '',
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, ['checks must map non-empty names to non-empty shell commands']);
});

test('rejects invalid visual proof gate config', () => {
  const result = validateConfig({
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        issueTextPatterns: ['['],
        minScreenshotArtifacts: 0,
        requireWhenDesirable: 'yes',
        runnerTimeoutMs: 0,
        envPassthrough: ['CODEX_ORCHESTRATOR_LOGIN_EMAIL', 'bad-name'],
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'reviewGates.visualProof.minScreenshotArtifacts must be a positive integer',
    'reviewGates.visualProof.requireWhenDesirable must be a boolean when provided',
    'reviewGates.visualProof.runnerTimeoutMs must be a positive integer when provided',
    'reviewGates.visualProof.envPassthrough must contain valid environment variable names',
    'reviewGates.visualProof.issueTextPatterns contains invalid regular expression [',
  ]);
});

test('rejects invalid acceptance proof gate config', () => {
  const result = validateConfig({
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      acceptanceProof: {
        ...validConfig.reviewGates.acceptanceProof,
        issueTextPatterns: ['['],
        proofStrategy: 'analytics',
        proofOwnedPathGlobs: ['.codex-orchestrator/proofs/**', ''],
        maxIterations: 0,
        runnerTimeoutMs: 0,
        envPassthrough: ['CODEX_ORCHESTRATOR_LOGIN_EMAIL', 'bad-name'],
        browserProof: {
          scenarioPath: 12,
          baseUrl: 34,
          strictConsoleErrors: 'yes',
          strictNetworkFailures: 'no',
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'reviewGates.acceptanceProof.proofStrategy must be one of auto, visual, browser-visual, mobile-visual, non-visual-smoke, none',
    'reviewGates.acceptanceProof.proofOwnedPathGlobs must be an array of non-empty strings',
    'reviewGates.acceptanceProof.maxIterations must be a positive integer',
    'reviewGates.acceptanceProof.runnerTimeoutMs must be a positive integer when provided',
    'reviewGates.acceptanceProof.browserProof.scenarioPath must be a string when provided',
    'reviewGates.acceptanceProof.browserProof.baseUrl must be a string when provided',
    'reviewGates.acceptanceProof.browserProof.strictConsoleErrors must be a boolean',
    'reviewGates.acceptanceProof.browserProof.strictNetworkFailures must be a boolean',
    'reviewGates.acceptanceProof.envPassthrough must contain valid environment variable names',
    'reviewGates.acceptanceProof.issueTextPatterns contains invalid regular expression [',
  ]);
});

test('rejects invalid risk routing gate config', () => {
  const result = validateConfig({
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      riskRouting: {
        ...validConfig.reviewGates.riskRouting,
        enabled: 'yes',
        mode: 'strict',
        requireScopedReviewHandoff: 'yes',
        requireParentSizeRisk: 'yes',
        requireParentReviewHandoff: 'yes',
        riskyChangedPathGlobs: ['src/**', ''],
        highRiskRequiresCodeReview: 'yes',
        allowedLowRiskFlows: ['small-task-implementer', 'invalid-flow'],
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'reviewGates.riskRouting.enabled must be a boolean',
    'reviewGates.riskRouting.mode must be one of warn, block',
    'reviewGates.riskRouting.requireScopedReviewHandoff must be a boolean',
    'reviewGates.riskRouting.requireParentSizeRisk must be a boolean',
    'reviewGates.riskRouting.requireParentReviewHandoff must be a boolean',
    'reviewGates.riskRouting.riskyChangedPathGlobs must be an array of non-empty strings',
    'reviewGates.riskRouting.highRiskRequiresCodeReview must be a boolean',
    'reviewGates.riskRouting.allowedLowRiskFlows must contain only small-task-implementer, scoped-implementation, spec-implementer, issue-tree-child, other',
  ]);
});

test('accepts risk routing policy as a retryable rework blocker', () => {
  const result = validateConfig({
    ...validConfig,
    loopPolicy: {
      ...validConfig.loopPolicy,
      rework: {
        ...validConfig.loopPolicy.rework,
        retryableBlockers: [
          ...validConfig.loopPolicy.rework.retryableBlockers,
          'risk-routing-policy',
        ],
      },
    },
  });

  assert.equal(result.ok, true);
});

test('rejects invalid quality gate config', () => {
  const result = validateConfig({
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      quality: {
        ...validConfig.reviewGates.quality,
        runtimeChangedPathGlobs: ['src/**', ''],
        tdd: {
          ...validConfig.reviewGates.quality.tdd,
          requireTestChange: 'yes',
          requiredValidationPatterns: ['['],
        },
        cleanupReview: {
          ...validConfig.reviewGates.quality.cleanupReview,
          runtimeFileThreshold: 0,
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'reviewGates.quality.runtimeChangedPathGlobs must be an array of non-empty strings',
    'reviewGates.quality.tdd.requireTestChange must be a boolean',
    'reviewGates.quality.tdd.requiredValidationPatterns contains invalid regular expression [',
    'reviewGates.quality.cleanupReview.runtimeFileThreshold must be a positive integer',
  ]);
});

test('rejects invalid loop policy config', () => {
  const result = validateConfig({
    ...validConfig,
    loopPolicy: {
      issueSelection: {
        priorityLabels: ['priority:high', ''],
        tieBreaker: 'created-at',
      },
      rework: {
        maxAttempts: -1,
        retryableBlockers: ['no-changed-files', 'unknown'],
      },
      freshContextReview: {
        enabled: 'yes',
        mode: 'strict',
        blockOnHighConfidencePolicyViolations: 'yes',
      },
      durableRunSummaries: {
        enabled: 'yes',
      },
      policySuggestions: {
        enabled: 'yes',
        maxSuggestions: 0,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'loopPolicy.issueSelection.priorityLabels must be an array of non-empty strings',
    'loopPolicy.issueSelection.tieBreaker must be one of issue-number-asc',
    'loopPolicy.rework.maxAttempts must be a non-negative integer',
    'loopPolicy.rework.retryableBlockers must contain only missing-completion-report, idle-timeout-before-change, incomplete-after-progress, invalid-completion-report, no-changed-files, failed-configured-checks, missing-quality-gate-evidence, failed-acceptance-proof, risk-routing-policy, optional-figma-mcp-failure',
    'loopPolicy.freshContextReview.enabled must be a boolean',
    'loopPolicy.freshContextReview.mode must be one of advisory',
    'loopPolicy.freshContextReview.blockOnHighConfidencePolicyViolations must be a boolean',
    'loopPolicy.durableRunSummaries.enabled must be a boolean',
    'loopPolicy.policySuggestions.enabled must be a boolean',
    'loopPolicy.policySuggestions.maxSuggestions must be a positive integer',
  ]);
});

test('rejects invalid label preparation policy', () => {
  const result = validateConfig({
    ...validConfig,
    github: {
      ...validConfig.github,
      prepareLabels: 'always',
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, ['github.prepareLabels must be one of report-only, create-missing']);
});

test('rejects maxParallelChildren outside the first contract limit', () => {
  const result = validateConfig({
    ...validConfig,
    runner: {
      ...validConfig.runner,
      maxParallelChildren: 4,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, ['runner.maxParallelChildren must be an integer between 1 and 3']);
});

test('rejects missing branch templates', () => {
  const result = validateConfig({
    ...validConfig,
    branches: {
      base: validConfig.branches.base,
      scopedIssue: '',
      issueTree: validConfig.branches.issueTree,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, ['branches.scopedIssue must be a non-empty string']);
});

test('rejects runtime state sections in committed config', () => {
  const result = validateConfig({
    ...validConfig,
    runtime: {
      activePid: 123,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, ['runtime is runtime state and must not be committed config']);
});
