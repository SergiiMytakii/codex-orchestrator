import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateChangedPaths,
  validateCompletionReportSafety,
  validateNoAgentOwnedGitPublication,
} from '../src/runner/safety.js';
import { validConfig } from './fixtures/config.js';

test('safety rejects configured secret and deny glob changes', () => {
  const config = {
    ...validConfig,
    deny: {
      ...validConfig.deny,
      additionalPathGlobs: ['secrets/**'],
    },
  };

  assert.deepEqual(validateChangedPaths(['src/index.ts'], config), []);
  assert.equal(validateChangedPaths(['.env.local'], config)[0]?.code, 'secret-file-change');
  assert.equal(validateChangedPaths(['secrets/nested/value.txt'], config)[0]?.code, 'secret-file-change');
});

test('safety validates denied paths from a combined session change set', () => {
  const config = {
    ...validConfig,
    deny: {
      ...validConfig.deny,
      additionalPathGlobs: ['secrets/**'],
    },
  };

  const violations = validateChangedPaths([
    'secrets/committed.txt',
    'src/index.ts',
    'secrets/untracked.txt',
  ], config);

  assert.deepEqual(violations.map((violation) => violation.message), [
    'Changed path secrets/committed.txt matches denied pattern secrets/**',
    'Changed path secrets/untracked.txt matches denied pattern secrets/**',
  ]);
});

test('safety preserves one-character top-level directories while normalizing relative paths', () => {
  const config = {
    ...validConfig,
    deny: {
      ...validConfig.deny,
      additionalPathGlobs: ['x/**'],
    },
  };

  assert.equal(validateChangedPaths(['x/secret.txt'], config)[0]?.code, 'secret-file-change');
  assert.equal(validateChangedPaths(['./x/secret.txt'], config)[0]?.code, 'secret-file-change');
});

test('safety maps prohibited report actions and changed HEAD', () => {
  assert.deepEqual(
    validateCompletionReportSafety({
      status: 'completed',
      changes: [],
      validation: [],
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [
        { type: 'destructive-db-or-cache', description: 'attempted db drop' },
        { type: 'production-deploy-or-release', description: 'attempted deploy' },
      ],
    }).map((violation) => violation.code),
    ['destructive-db-or-cache', 'production-deploy-or-release'],
  );
  assert.deepEqual(validateNoAgentOwnedGitPublication('a', 'a'), []);
  assert.equal(validateNoAgentOwnedGitPublication('a', 'b')[0]?.code, 'agent-owned-git-publication');
});
