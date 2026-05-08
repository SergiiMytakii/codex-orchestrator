import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../src/config/schema.js';
import { validConfig } from './fixtures/config.js';

test('accepts the minimal valid config contract', () => {
  const result = validateConfig(validConfig);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.github.issueLabels.auto, 'agent:auto');
    assert.equal(result.value.runner.maxParallelChildren, 3);
    assert.equal(result.value.codex.adapter, 'codex-cli');
    assert.equal(result.value.project.configDir, '.codex-orchestrator');
  }
});

test('rejects missing github.repo with a dot-path error', () => {
  const result = validateConfig({
    ...validConfig,
    github: {
      owner: 'SergiiMytakii',
      issueLabels: validConfig.github.issueLabels,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, ['github.repo must be a non-empty string']);
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

test('rejects unsupported Codex adapter values', () => {
  const result = validateConfig({
    ...validConfig,
    codex: {
      adapter: 'other-agent',
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, ['codex.adapter must be codex-cli']);
});

test('rejects unsupported project config directory values', () => {
  const result = validateConfig({
    ...validConfig,
    project: {
      configDir: '.custom',
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors, ['project.configDir must be .codex-orchestrator']);
});
