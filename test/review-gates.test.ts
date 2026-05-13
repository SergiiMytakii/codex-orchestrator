import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateReviewGates, type ReviewGateInput } from '../src/runner/review-gates.js';
import { shouldApplyVisualProofGate } from '../src/runner/review-gate-policy.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const baseRuntimeGateInput: Omit<ReviewGateInput, 'validation'> = {
  config: validConfig,
  issue: issueFixture({ number: 155, title: 'Fix saved filters', body: 'Runtime behavior fix.' }),
  changedFiles: ['src/filters.ts', 'test/filters.test.ts'],
  skippedChecks: [],
  report: {
    status: 'completed',
    changes: ['src/filters.ts', 'test/filters.test.ts'],
    validation: [],
    artifacts: [],
    skippedChecks: [],
    residualRisks: [],
    prohibitedActions: [],
  },
};

function evaluateTddGate(validation: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; summary: string }>) {
  return evaluateReviewGates({
    ...baseRuntimeGateInput,
    validation: [
      ...validation,
      { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
    ],
  });
}

test('quality gate accepts TDD red-to-green proof in one validation entry', () => {
  const result = evaluateTddGate([
    {
      command: 'TDD red-to-green',
      status: 'passed',
      summary: 'Focused behavior test failed before implementation and passed after implementation.',
    },
  ]);

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('quality gate accepts TDD red-to-green proof split across passed validation entries', () => {
  const result = evaluateTddGate([
    {
      command: 'pre-change HEAD check',
      status: 'passed',
      summary: 'RED: focused behavior test failed before implementation.',
    },
    {
      command: 'npm test -- filters',
      status: 'passed',
      summary: 'Focused behavior test passed after implementation.',
    },
  ]);

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('quality gate rejects TDD proof with only red evidence', () => {
  const result = evaluateTddGate([
    {
      command: 'pre-change HEAD check',
      status: 'passed',
      summary: 'RED: focused behavior test failed before implementation.',
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /Quality gate requires TDD red-to-green proof/);
});

test('quality gate rejects split TDD proof when green evidence is only a generic passed check', () => {
  const result = evaluateTddGate([
    {
      command: 'pre-change HEAD check',
      status: 'passed',
      summary: 'RED: focused behavior test failed before implementation.',
    },
    {
      command: 'npm run typecheck',
      status: 'passed',
      summary: 'typecheck: passed',
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /Quality gate requires TDD red-to-green proof/);
});

test('quality gate rejects TDD proof with only green evidence', () => {
  const result = evaluateTddGate([
    {
      command: 'npm test -- filters',
      status: 'passed',
      summary: 'Focused behavior test passed after implementation.',
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /Quality gate requires TDD red-to-green proof/);
});

test('quality gate ignores skipped or failed TDD validation evidence', () => {
  const result = evaluateTddGate([
    {
      command: 'pre-change HEAD check',
      status: 'failed',
      summary: 'RED: focused behavior test failed before implementation.',
    },
    {
      command: 'npm test -- filters',
      status: 'skipped',
      summary: 'Focused behavior test passed after implementation.',
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /Quality gate requires TDD red-to-green proof/);
});

test('quality gate uses configured runtime and test path globs with positive and negative cases', () => {
  const config = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      quality: {
        ...validConfig.reviewGates.quality,
        runtimeChangedPathGlobs: ['packages/runtime/**/*.ts'],
        testChangedPathGlobs: ['packages/runtime/**/*.test.ts'],
      },
    },
  };

  const matching = evaluateReviewGates({
    ...baseRuntimeGateInput,
    config,
    changedFiles: ['packages/runtime/session/index.ts', 'packages/runtime/session/index.test.ts'],
    validation: [],
  });
  const nonMatching = evaluateReviewGates({
    ...baseRuntimeGateInput,
    config,
    changedFiles: ['docs/runtime-notes.md'],
    validation: [],
  });

  assert.equal(matching.ok, false);
  assert.match(matching.reasons.join('\n'), /Quality gate requires TDD red-to-green proof/);
  assert.deepEqual(nonMatching, { ok: true, reasons: [] });
});

test('visual proof policy uses configured issue text and changed path globs with positive and negative cases', () => {
  const config = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        issueTextPatterns: ['needs visual proof'],
        changedPathGlobs: ['apps/web/**/*.tsx'],
      },
    },
  };

  assert.equal(shouldApplyVisualProofGate({
    config,
    issue: issueFixture({ number: 155, title: 'Backend cleanup', body: 'No screenshots.' }),
    changedFiles: ['apps/web/screens/Home.tsx'],
  }), true);
  assert.equal(shouldApplyVisualProofGate({
    config,
    issue: issueFixture({ number: 155, title: 'Needs visual proof', body: 'No UI files changed.' }),
    changedFiles: ['src/server.ts'],
  }), true);
  assert.equal(shouldApplyVisualProofGate({
    config,
    issue: issueFixture({ number: 155, title: 'Backend cleanup', body: 'No screenshots.' }),
    changedFiles: ['src/server.ts'],
  }), false);
});

test('review gates accept runner-owned visual proof as UI layout test evidence', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-review-gates-'));
  const screenshotPath = '.codex-orchestrator/proofs/issue-155/390.png';
  await mkdir(join(worktreePath, '.codex-orchestrator', 'proofs', 'issue-155'), { recursive: true });
  await writeFile(join(worktreePath, screenshotPath), 'png fixture\n', 'utf8');

  const result = evaluateReviewGates({
    config: validConfig,
    issue: issueFixture({ number: 155, title: '[UI] Fix responsive campaign layout', body: 'Requires screenshots.' }),
    changedFiles: [
      'src/frontend/CampaignList.tsx',
      '.codex-orchestrator/proofs/issue-155/visual-proof.mjs',
    ],
    validation: [
      {
        command: 'node .codex-orchestrator/proofs/issue-155/visual-proof.mjs',
        status: 'passed',
        summary: 'runner visual proof passed: Playwright screenshot command completed with 1 screenshot artifact(s).',
      },
      { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
    ],
    skippedChecks: [
      'BrowserUse direct visual session was unavailable in this child session; runner-owned Playwright proof was used.',
    ],
    report: {
      status: 'completed',
      changes: ['src/frontend/CampaignList.tsx'],
      validation: [],
      artifacts: [{
        type: 'screenshot',
        path: screenshotPath,
        description: '390px campaign layout',
      }],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    },
    worktreePath,
  });

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('review gates block failed runner-owned visual proof even when a child claimed visual success', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-review-gates-'));
  const screenshotPath = '.codex-orchestrator/proofs/issue-155/390.png';
  await mkdir(join(worktreePath, '.codex-orchestrator', 'proofs', 'issue-155'), { recursive: true });
  await writeFile(join(worktreePath, screenshotPath), 'png fixture\n', 'utf8');

  const result = evaluateReviewGates({
    config: validConfig,
    issue: issueFixture({ number: 155, title: '[UI] Fix responsive campaign layout', body: 'Requires screenshots.' }),
    changedFiles: [
      'src/frontend/CampaignList.tsx',
      'test/CampaignList.test.ts',
      '.codex-orchestrator/proofs/issue-155/visual-proof.mjs',
      screenshotPath,
    ],
    validation: [
      { command: 'Playwright screenshots', status: 'passed', summary: '390px viewport has no overlap.' },
      {
        command: 'node .codex-orchestrator/proofs/issue-155/visual-proof.mjs',
        status: 'failed',
        summary: 'runner visual proof failed: overlap detected',
      },
      {
        command: 'TDD red-to-green',
        status: 'passed',
        summary: 'Focused behavior test failed before implementation and passed after implementation.',
      },
      { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
    ],
    skippedChecks: [],
    report: {
      status: 'completed',
      changes: ['src/frontend/CampaignList.tsx'],
      validation: [],
      artifacts: [{
        type: 'screenshot',
        path: screenshotPath,
        description: '390px campaign layout',
      }],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    },
    worktreePath,
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /runner visual proof failed/);
});
