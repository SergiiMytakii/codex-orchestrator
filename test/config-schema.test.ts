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
    assert.equal(result.value.codex.idleTimeoutMs, 300_000);
    assert.equal(result.value.reviewGates.visualProof.enabled, true);
    assert.equal(result.value.reviewGates.visualProof.minScreenshotArtifacts, 1);
    assert.equal(result.value.reviewGates.visualProof.runnerTimeoutMs, 900_000);
    assert.deepEqual(result.value.reviewGates.visualProof.envPassthrough, []);
    assert.equal(result.value.reviewGates.quality.enabled, true);
    assert.equal(result.value.reviewGates.quality.tdd.requireTestChange, true);
    assert.equal(result.value.reviewGates.quality.cleanupReview.runtimeFileThreshold, 3);
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

test('rejects invalid codex command contract', () => {
  const result = validateConfig({
    ...validConfig,
    codex: {
      ...validConfig.codex,
      command: '',
      args: 'exec',
      timeoutMs: 0,
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
