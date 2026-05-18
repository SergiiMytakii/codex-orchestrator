import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryGitHubIssueAdapter,
  InMemoryGitHubPullRequestAdapter,
  RunnerStateStore,
  buildPlanAutoPrompt,
  buildScopedImplementationPrompt,
  closeIssueWithEvidence,
  runScopedAutoCommand,
  runPlanAutoCommand,
  runLocalExecutionSession,
  runDaemonCommand,
  discoverIssueWork,
  ensureAutonomousChildBody,
  isAutonomousChildOfParent,
  reconcileRunnerState,
  renderAutonomousChildMarker,
  runSetupCommand,
  runStatusCommand,
  formatIssueClosureEvidenceComment,
  validatePlanGraph,
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
  assert.equal(typeof InMemoryGitHubPullRequestAdapter, 'function');
  assert.equal(typeof discoverIssueWork, 'function');
  assert.equal(typeof buildScopedImplementationPrompt, 'function');
  assert.equal(typeof buildPlanAutoPrompt, 'function');
  assert.equal(typeof runScopedAutoCommand, 'function');
  assert.equal(typeof runPlanAutoCommand, 'function');
  assert.equal(typeof runLocalExecutionSession, 'function');
  assert.equal(typeof renderAutonomousChildMarker, 'function');
  assert.equal(typeof ensureAutonomousChildBody, 'function');
  assert.equal(typeof isAutonomousChildOfParent, 'function');
  assert.equal(typeof validatePlanGraph, 'function');
  assert.equal(typeof reconcileRunnerState, 'function');
  assert.equal(typeof runStatusCommand, 'function');
  assert.equal(typeof runDaemonCommand, 'function');
  assert.equal(typeof closeIssueWithEvidence, 'function');
  assert.equal(typeof formatIssueClosureEvidenceComment, 'function');
});
