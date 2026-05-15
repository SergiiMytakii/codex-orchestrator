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
    assert.equal(result.value.runner.allowAgentLocalCommits, false);
    assert.equal(result.value.workflows.prd.source, 'package-owned-prompt-fallback');
    assert.equal(result.value.codex.command, 'codex');
    assert.equal(result.value.codex.timeoutMs, 1_800_000);
    assert.equal(result.value.codex.mobileTimeoutMs, 3_600_000);
    assert.equal(result.value.codex.idleTimeoutMs, 300_000);
    assert.deepEqual(result.value.codex.profiles, {});
    assert.equal(result.value.reviewGates.visualProof.enabled, true);
    assert.equal(result.value.reviewGates.visualProof.minScreenshotArtifacts, 1);
    assert.equal(result.value.reviewGates.visualProof.runnerTimeoutMs, 900_000);
    assert.deepEqual(result.value.reviewGates.visualProof.envPassthrough, []);
    assert.equal(result.value.reviewGates.quality.enabled, true);
    assert.equal(result.value.reviewGates.quality.tdd.requireTestChange, true);
    assert.equal(result.value.reviewGates.quality.cleanupReview.runtimeFileThreshold, 3);
    assert.deepEqual(result.value.loopPolicy.issueSelection.priorityLabels, ['priority:critical', 'priority:high', 'priority:medium', 'priority:low']);
    assert.equal(result.value.loopPolicy.issueSelection.tieBreaker, 'issue-number-asc');
    assert.equal(result.value.loopPolicy.rework.maxAttempts, 1);
    assert.deepEqual(result.value.loopPolicy.rework.retryableBlockers, [
      'missing-completion-report',
      'invalid-completion-report',
      'no-changed-files',
      'failed-configured-checks',
      'missing-quality-gate-evidence',
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
      '-c',
      'sandbox_workspace_write.network_access=true',
      '--output-last-message',
      '${reportPath}',
      '-',
    ]);
    assert.equal(result.value.branches.base, 'main');
    assert.equal(result.value.branches.scopedIssue, 'codex/issue-${issueNumber}');
  }
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
    'workflows.prd.source must be one of existing-skill, package-owned-skill, package-owned-prompt-fallback',
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
        runnerTimeoutMs: 0,
        envPassthrough: ['CODEX_ORCHESTRATOR_LOGIN_EMAIL', 'bad-name'],
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, [
    'reviewGates.visualProof.minScreenshotArtifacts must be a positive integer',
    'reviewGates.visualProof.runnerTimeoutMs must be a positive integer when provided',
    'reviewGates.visualProof.envPassthrough must contain valid environment variable names',
    'reviewGates.visualProof.issueTextPatterns contains invalid regular expression [',
  ]);
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
    'loopPolicy.rework.retryableBlockers must contain only missing-completion-report, invalid-completion-report, no-changed-files, failed-configured-checks, missing-quality-gate-evidence',
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
