import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateImplementationReport } from '../src/v2/implementation-report.js';

test('implementation can request trusted host checks before proof and Review', () => {
  assert.deepEqual(validateImplementationReport({
    version: 1, status: 'checks-request', summary: 'Source is ready for configured checks.',
    changedFiles: ['feature.ts'], residualRisks: [],
  }).status, 'checks-request');
});
