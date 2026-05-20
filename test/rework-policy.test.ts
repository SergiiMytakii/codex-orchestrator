import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maxReworkAttemptsForReasons } from '../src/runner/rework-policy.js';
import { validConfig } from './fixtures/config.js';

test('acceptance proof blockers use the proof iteration limit instead of the generic rework limit', () => {
  const config = {
    ...validConfig,
    loopPolicy: {
      ...validConfig.loopPolicy,
      rework: { ...validConfig.loopPolicy.rework, maxAttempts: 1 },
    },
    reviewGates: {
      ...validConfig.reviewGates,
      acceptanceProof: { ...validConfig.reviewGates.acceptanceProof, maxIterations: 5 },
    },
  };

  assert.equal(maxReworkAttemptsForReasons(['Acceptance proof needs rework.'], config), 4);
  assert.equal(maxReworkAttemptsForReasons(['Quality gate requires TDD red-to-green proof in validation.'], config), 1);
});
