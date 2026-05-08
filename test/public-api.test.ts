import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryGitHubIssueAdapter,
  RunnerStateStore,
  discoverIssueWork,
  reconcileRunnerState,
  runSetupCommand,
  runStatusCommand,
  validateConfig,
} from '../src/index.js';
import { validConfig } from './fixtures/config.js';

test('exports config schema validator from the package entrypoint', () => {
  const result = validateConfig(validConfig);

  assert.equal(result.ok, true);
});

test('exports setup command from the package entrypoint', () => {
  assert.equal(typeof runSetupCommand, 'function');
});

test('exports runner contracts from the package entrypoint', () => {
  assert.equal(typeof InMemoryGitHubIssueAdapter, 'function');
  assert.equal(typeof RunnerStateStore, 'function');
  assert.equal(typeof discoverIssueWork, 'function');
  assert.equal(typeof reconcileRunnerState, 'function');
  assert.equal(typeof runStatusCommand, 'function');
});
