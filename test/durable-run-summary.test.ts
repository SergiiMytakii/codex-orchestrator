import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeDurableRunSummary } from '../src/runner/durable-run-summary.js';
import { validConfig } from './fixtures/config.js';

test('durable run summary distinguishes validation-satisfied acceptance proof from not-run proof', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-summary-'));

  const evidence = await writeDurableRunSummary({
    targetRoot,
    config: validConfig,
    issueNumber: 1205,
    sessionId: 'issue-1205-session',
    outcome: 'review-ready',
    changedFiles: ['src/runner/example.ts'],
    validation: [{ command: 'npm test', status: 'passed', summary: 'test: passed' }],
    blockers: [],
    skippedChecks: [],
    residualRisks: [],
    nextAction: 'Review the draft pull request before merge.',
    logPath: '/tmp/issue-1205.log',
    reportPath: '/tmp/issue-1205.json',
  });

  assert.ok(evidence);
  assert.deepEqual(
    evidence.excerpt.filter((line) => line.startsWith('acceptance proof:')),
    ['acceptance proof: satisfied-by-validation'],
  );
});
