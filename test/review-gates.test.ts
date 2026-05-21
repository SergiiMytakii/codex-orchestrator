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

  assert.deepEqual(result, { ok: true, reasons: [], warnings: [] });
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

  assert.deepEqual(result, { ok: true, reasons: [], warnings: [] });
});

test('quality gate accepts red evidence wording and plural tests passed in separate entries', () => {
  const result = evaluateTddGate([
    {
      command: 'TDD red evidence observed',
      status: 'passed',
      summary: 'Baseline run failed as expected before implementation.',
    },
    {
      command: 'flutter test test/foo_test.dart',
      status: 'passed',
      summary: '37 focused tests passed.',
    },
  ]);

  assert.deepEqual(result, { ok: true, reasons: [], warnings: [] });
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

test('quality gate rejects validation that says red-green proof is missing', () => {
  const result = evaluateTddGate([
    {
      command: 'npm test',
      status: 'passed',
      summary: 'all tests passed without red-green proof',
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
  assert.deepEqual(nonMatching, { ok: true, reasons: [], warnings: [] });
});

test('visual proof policy uses configured issue text and changed path globs with positive and negative cases', () => {
  const config = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      acceptanceProof: {
        ...validConfig.reviewGates.acceptanceProof,
        issueTextPatterns: ['needs visual proof'],
        changedPathGlobs: ['apps/web/**/*.tsx'],
      },
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

test('visual proof policy still applies generic acceptance proof for configured acceptance paths', () => {
  const config = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      acceptanceProof: {
        ...validConfig.reviewGates.acceptanceProof,
        runnerValidationCommand: 'npm run acceptance-proof',
        issueTextPatterns: ['needs acceptance proof'],
        changedPathGlobs: ['src/api/**'],
      },
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        issueTextPatterns: ['needs visual proof'],
        changedPathGlobs: ['src/frontend/**'],
      },
    },
  };

  assert.equal(shouldApplyVisualProofGate({
    config,
    issue: issueFixture({ number: 782, title: 'Backend cleanup', body: 'No visual proof.' }),
    changedFiles: ['src/api/routes.ts'],
  }), true);
});

test('visual proof policy does not treat internal Acceptance Proof module work as mobile UI proof', () => {
  assert.equal(shouldApplyVisualProofGate({
    config: validConfig,
    issue: issueFixture({
      number: 773,
      title: 'Self-improvement: Deepen Acceptance Proof report loading',
      body: [
        'Acceptance Proof report assertion and evaluation live in the Acceptance Proof module.',
        'Move the Proof Report read/classify helper into src/runner/acceptance-proof.ts.',
      ].join('\n'),
    }),
    changedFiles: [
      'src/runner/acceptance-proof.ts',
      'src/runner/visual-proof-runner.ts',
      'test/acceptance-proof.test.ts',
      'test/visual-proof-runner.test.ts',
    ],
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

  assert.deepEqual(result, { ok: true, reasons: [], warnings: [] });
});

test('review gates warn on failed runner-owned visual proof instead of blocking publication', async () => {
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

  assert.deepEqual(result.reasons, []);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /runner visual proof failed/);
});

test('review gates warn when no runner-owned visual proof command is configured', () => {
  const config = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      acceptanceProof: {
        ...validConfig.reviewGates.acceptanceProof,
        runnerValidationCommand: '',
      },
      quality: {
        ...validConfig.reviewGates.quality,
        enabled: false,
      },
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        runnerValidationCommand: '',
      },
    },
  };

  const result = evaluateReviewGates({
    config,
    issue: issueFixture({ number: 155, title: '[UI] Fix responsive campaign layout', body: 'Requires screenshots.' }),
    changedFiles: ['src/frontend/CampaignList.tsx'],
    validation: [{ command: '$code-review', status: 'passed', summary: 'No blocking findings.' }],
    skippedChecks: [],
    report: {
      status: 'completed',
      changes: ['src/frontend/CampaignList.tsx'],
      validation: [],
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    },
  });

  assert.deepEqual(result.reasons, []);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /visual proof/i);
  assert.doesNotMatch(result.warnings.join('\n'), /expected at least .* screenshot artifact/i);
});

test('review gates do not warn about missing screenshot artifacts when proof tooling is unavailable', () => {
  const config = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      quality: {
        ...validConfig.reviewGates.quality,
        enabled: false,
      },
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        runnerValidationCommand: 'node visual-proof.mjs',
      },
    },
  };

  const result = evaluateReviewGates({
    config,
    issue: issueFixture({ number: 155, title: '[UI] Fix responsive campaign layout', body: 'Requires screenshots.' }),
    changedFiles: ['src/frontend/CampaignList.tsx'],
    validation: [
      {
        command: 'node visual-proof.mjs',
        status: 'skipped',
        summary: 'runner visual proof warning: adb not installed and no devices connected.',
      },
      { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
    ],
    skippedChecks: [],
    report: {
      status: 'completed',
      changes: ['src/frontend/CampaignList.tsx'],
      validation: [],
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    },
  });

  assert.deepEqual(result.reasons, []);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /Visual proof capability note/i);
  assert.doesNotMatch(result.warnings.join('\n'), /expected at least .* screenshot artifact/i);
});

test('review gates still warn about missing screenshots when only the proof command name mentions tooling', () => {
  const config = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      quality: {
        ...validConfig.reviewGates.quality,
        enabled: false,
      },
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        runnerValidationCommand: 'adb screenshot',
      },
    },
  };

  const result = evaluateReviewGates({
    config,
    issue: issueFixture({ number: 155, title: '[UI] Fix responsive campaign layout', body: 'Requires screenshots.' }),
    changedFiles: ['src/frontend/CampaignList.tsx'],
    validation: [
      {
        command: 'adb screenshot',
        status: 'skipped',
        summary: 'runner visual proof warning: command completed but did not produce a screenshot artifact.',
      },
      { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
    ],
    skippedChecks: [],
    report: {
      status: 'completed',
      changes: ['src/frontend/CampaignList.tsx'],
      validation: [],
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    },
  });

  assert.match(result.warnings.join('\n'), /Visual proof validation warning/i);
  assert.match(result.warnings.join('\n'), /expected at least .* screenshot artifact/i);
  assert.doesNotMatch(result.warnings.join('\n'), /Visual proof capability note/i);
});

test('review gates block missing screenshot proof in strict visual proof mode', () => {
  const config = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      acceptanceProof: {
        ...validConfig.reviewGates.acceptanceProof,
        runnerValidationCommand: '',
      },
      quality: {
        ...validConfig.reviewGates.quality,
        enabled: false,
      },
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        runnerValidationCommand: '',
        requireWhenDesirable: true,
      },
    },
  };

  const result = evaluateReviewGates({
    config,
    issue: issueFixture({ number: 155, title: '[UI] Fix responsive campaign layout', body: 'Requires screenshots.' }),
    changedFiles: ['src/frontend/CampaignList.tsx'],
    validation: [{ command: '$code-review', status: 'passed', summary: 'No blocking findings.' }],
    skippedChecks: [],
    report: {
      status: 'completed',
      changes: ['src/frontend/CampaignList.tsx'],
      validation: [],
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /strict visual proof/i);
  assert.match(result.reasons.join('\n'), /expected at least .* screenshot artifact/i);
});
