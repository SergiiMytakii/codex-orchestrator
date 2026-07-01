import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  maxReworkAttemptsForReasons,
  shouldRequestImplementationRework,
} from '../src/runner/rework-policy.js';
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

test('risk routing policy blockers request rework only when configured', () => {
  const reason = 'Risk routing gate requires: scoped review handoff is required.';
  const configured = {
    ...validConfig,
    loopPolicy: {
      ...validConfig.loopPolicy,
      rework: {
        ...validConfig.loopPolicy.rework,
        retryableBlockers: [
          ...validConfig.loopPolicy.rework.retryableBlockers,
          'risk-routing-policy' as const,
        ],
      },
    },
  };

  assert.equal(shouldRequestImplementationRework([reason], validConfig), false);
  assert.equal(shouldRequestImplementationRework([reason], configured), true);
});
