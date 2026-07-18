import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSetupArgs, renderSetupResultJson, setupOutcomeExitCode } from '../src/v2/setup-cli.js';
import type { SetupOutcome } from '../src/v2/setup.js';

test('candidate setup parser maps only operational intent and rejects ambiguous flags', () => {
  assert.deepEqual(parseSetupArgs(['setup', '--target', '/repo']), {
    targetRoot: '/repo', operation: 'configure', dryRun: false,
  });
  assert.deepEqual(parseSetupArgs(['setup', '--target', '/repo', '--prepare-labels', '--dry-run', '--github-owner', 'o', '--github-repo', 'r']), {
    targetRoot: '/repo', operation: 'prepare-labels', dryRun: true, repository: { owner: 'o', repo: 'r' },
  });
  assert.deepEqual(parseSetupArgs(['setup', '--target', '/repo', '--fresh']), {
    targetRoot: '/repo', operation: 'fresh', dryRun: false,
  });
  assert.deepEqual(parseSetupArgs(['doctor', '--target', '/repo']), {
    targetRoot: '/repo', operation: 'doctor', dryRun: false,
  });
  assert.deepEqual(parseSetupArgs(['status', '--target', '/repo']), {
    targetRoot: '/repo', operation: 'status', dryRun: false,
  });
  for (const argv of [
    ['setup', '--target', '/repo', '--fresh', '--prepare-labels'],
    ['doctor', '--target', '/repo', '--dry-run'],
    ['setup', '--target', '/repo', '--github-owner', 'o'],
    ['setup', '--target', '/repo', '--unknown'],
  ]) assert.throws(() => parseSetupArgs(argv));
});

test('candidate setup JSON and exit mapping are total over typed outcomes', () => {
  const cases: Array<{ outcome: SetupOutcome; exit: number }> = [
    { outcome: { status: 'created' }, exit: 0 },
    { outcome: { status: 'unchanged' }, exit: 0 },
    { outcome: { status: 'labels-prepared' }, exit: 0 },
    { outcome: { status: 'fresh-reset' }, exit: 0 },
    { outcome: { status: 'migrated' }, exit: 0 },
    { outcome: { status: 'planned', actions: [] }, exit: 0 },
    { outcome: { status: 'inspected', disposition: 'ok', diagnostics: [] }, exit: 0 },
    { outcome: { status: 'inspected', disposition: 'blocked', diagnostics: [] }, exit: 20 },
    { outcome: { status: 'legacy-detected', reason: 'fresh required' }, exit: 20 },
    { outcome: { status: 'blocked-active', reason: 'owner active' }, exit: 20 },
    { outcome: { status: 'repository-mismatch', reason: 'mismatch' }, exit: 20 },
    { outcome: { status: 'unsupported-schema', reason: 'future' }, exit: 20 },
    { outcome: { status: 'labels-partial', created: [], missing: ['agent:auto'], cause: { code: 'partial', summary: 'partial' } }, exit: 20 },
    { outcome: { status: 'transport-failed', detail: { code: 'transport', summary: 'failed' } }, exit: 70 },
    { outcome: { status: 'io-failed', detail: { code: 'io', summary: 'failed' } }, exit: 70 },
  ];
  for (const entry of cases) {
    assert.equal(setupOutcomeExitCode(entry.outcome), entry.exit);
    assert.deepEqual(JSON.parse(renderSetupResultJson(entry.outcome)), {
      schema: 'codex-orchestrator.agent-auto-setup-result', version: 1, result: entry.outcome,
    });
  }
});
