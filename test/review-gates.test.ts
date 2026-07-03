import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  evaluateParentRiskRoutingGate,
  evaluateReviewGates,
  type ReviewGateInput,
} from '../src/runner/review-gates.js';
import type { PlanAutoCompletionReport } from '../src/runner/completion-report.js';
import { classifyVisualProofDispatchTarget, decideProofRouting, shouldApplyVisualProofGate } from '../src/runner/review-gate-policy.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const defaultReviewHandoff: NonNullable<ReviewGateInput['report']['reviewHandoff']> = {
  flowUsed: 'scoped-implementation',
  riskLevel: 'medium',
  implementedContract: ['Focused scoped change completed.'],
  proofByAcceptanceCriteria: ['Focused validation covers the acceptance criteria.'],
  reviewFocus: ['Review changed behavior and validation evidence.'],
  humanReviewChecklist: ['Confirm the scoped contract is satisfied.'],
};

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
    reviewHandoff: defaultReviewHandoff,
  },
};

function evaluateTddGate(validation: ReviewGateInput['validation']) {
  return evaluateReviewGates({
    ...baseRuntimeGateInput,
    validation: [
      ...validation,
      { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
    ],
  });
}

function riskRoutingConfig(overrides: Partial<typeof validConfig.reviewGates.riskRouting> = {}) {
  return {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      quality: {
        ...validConfig.reviewGates.quality,
        enabled: false,
      },
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        enabled: false,
      },
      acceptanceProof: {
        ...validConfig.reviewGates.acceptanceProof,
        enabled: false,
      },
      riskRouting: {
        ...validConfig.reviewGates.riskRouting,
        ...overrides,
      },
    },
  };
}

function scopedRiskInput(overrides: Partial<ReviewGateInput> = {}): ReviewGateInput {
  return {
    config: riskRoutingConfig(),
    issue: issueFixture({ number: 2148, title: 'Scoped policy change', body: 'Runner policy.' }),
    changedFiles: ['src/runner/policy.ts'],
    validation: [],
    skippedChecks: [],
    report: {
      status: 'completed',
      changes: ['src/runner/policy.ts'],
      validation: [],
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
      reviewHandoff: defaultReviewHandoff,
    },
    ...overrides,
  };
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

test('quality gate accepts structured TDD evidence without regex-friendly summary text', () => {
  const result = evaluateTddGate([
    {
      command: 'focused behavior proof',
      status: 'passed',
      summary: 'machine-readable proof attached',
      evidence: {
        kind: 'tdd-red-green',
        red: {
          command: 'node --test dist/test/filters.test.js',
          status: 'failed',
          summary: 'pre-change behavior failed',
        },
        green: {
          command: 'node --test dist/test/filters.test.js',
          status: 'passed',
          summary: 'post-change behavior passed',
        },
      },
    },
  ]);

  assert.deepEqual(result, { ok: true, reasons: [], warnings: [] });
});

test('quality gate rejects malformed structured TDD evidence', () => {
  const result = evaluateTddGate([
    {
      command: 'focused behavior proof',
      status: 'passed',
      summary: 'machine-readable proof attached',
      evidence: {
        kind: 'tdd-red-green',
        red: {
          command: 'node --test dist/test/filters.test.js',
          status: 'passed',
          summary: 'red did not fail',
        },
        green: {
          command: 'node --test dist/test/filters.test.js',
          status: 'passed',
          summary: 'green passed',
        },
      },
    } as unknown as ReviewGateInput['validation'][number],
  ]);

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /Quality gate requires TDD red-to-green proof/);
});

test('risk routing warns when scoped review handoff is missing in warn mode', () => {
  const result = evaluateReviewGates(scopedRiskInput({
    report: {
      ...scopedRiskInput().report,
      reviewHandoff: undefined,
    },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
  assert.match(result.warnings.join('\n'), /Risk routing warning: scoped review handoff is required/);
});

test('risk routing warns when scoped review handoff evidence arrays are empty in warn mode', () => {
  const input = scopedRiskInput();
  const result = evaluateReviewGates({
    ...input,
    report: {
      ...input.report,
      reviewHandoff: {
        flowUsed: 'scoped-implementation',
        riskLevel: 'medium',
        implementedContract: [],
        proofByAcceptanceCriteria: [],
        reviewFocus: [],
        humanReviewChecklist: [],
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
  assert.match(result.warnings.join('\n'), /implementedContract must describe the delivered contract/);
  assert.match(result.warnings.join('\n'), /proofByAcceptanceCriteria must map proof to acceptance criteria/);
  assert.match(result.warnings.join('\n'), /reviewFocus must identify review targets/);
  assert.match(result.warnings.join('\n'), /humanReviewChecklist must identify human review checks/);
});

test('risk routing warns when low-risk scoped metadata uses a disallowed flow or configured risky path', () => {
  const input = scopedRiskInput({
    config: riskRoutingConfig({
      riskyChangedPathGlobs: ['src/runner/**'],
    }),
  });
  const result = evaluateReviewGates({
    ...input,
    report: {
      ...input.report,
      reviewHandoff: {
        flowUsed: 'spec-implementer',
        riskLevel: 'low',
        implementedContract: ['Low-risk contract claim.'],
        proofByAcceptanceCriteria: ['Proof.'],
        reviewFocus: ['Focus.'],
        humanReviewChecklist: ['Checklist.'],
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
  assert.match(result.warnings.join('\n'), /low-risk scoped work used flow spec-implementer/);
  assert.match(result.warnings.join('\n'), /low-risk scoped work changed configured risky path src\/runner\/policy\.ts/);
});

test('risk routing warns when high-risk scoped work lacks code-review proof in warn mode', () => {
  const input = scopedRiskInput();
  const result = evaluateReviewGates({
    ...input,
    report: {
      ...input.report,
      reviewHandoff: {
        flowUsed: 'scoped-implementation',
        riskLevel: 'high',
        implementedContract: ['High-risk policy change.'],
        proofByAcceptanceCriteria: ['Proof.'],
        reviewFocus: ['Focus.'],
        humanReviewChecklist: ['Checklist.'],
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
  assert.match(result.warnings.join('\n'), /high-risk scoped work requires passed code-review validation/);
});

test('risk routing blocks scoped findings in block mode without warning-mode weakening', () => {
  const result = evaluateReviewGates(scopedRiskInput({
    config: riskRoutingConfig({ mode: 'block' }),
    report: {
      ...scopedRiskInput().report,
      reviewHandoff: undefined,
    },
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.warnings, []);
  assert.match(result.reasons.join('\n'), /Risk routing gate requires: scoped review handoff is required/);
});

test('parent risk routing warns about missing duplicate and unknown size-risk ids in warn mode', () => {
  const report: PlanAutoCompletionReport = {
    status: 'completed',
    parent: { body: 'Updated parent body' },
    graph: {
      nodes: [
        {
          stableId: 'child-a',
          title: 'Child A',
          body: 'Child A body',
          afkHitl: 'afk',
          ownershipScope: ['src/a.ts'],
          dependsOn: [],
          verification: ['npm test'],
        },
        {
          stableId: 'child-b',
          title: 'Child B',
          body: 'Child B body',
          afkHitl: 'afk',
          ownershipScope: ['src/b.ts'],
          dependsOn: [],
          verification: ['npm test'],
        },
      ],
      edges: [],
      specGate: 'wave-level',
    },
    sizeRisk: {
      small: ['child-a', 'child-a', 'unknown-child'],
      medium: [],
      high: [],
    },
    parentReviewHandoff: {
      risks: [],
      proofStrategy: [],
      humanReviewFocus: [],
    },
    residualRisks: [],
  };

  const result = evaluateParentRiskRoutingGate({
    config: riskRoutingConfig(),
    report,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
  assert.match(result.warnings.join('\n'), /sizeRisk is missing stable id child-b/);
  assert.match(result.warnings.join('\n'), /sizeRisk lists stable id child-a more than once/);
  assert.match(result.warnings.join('\n'), /sizeRisk lists unknown stable id unknown-child/);
  assert.match(result.warnings.join('\n'), /parentReviewHandoff.risks must describe parent orchestration risks/);
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

test('proof routing decision centralizes visual, non-visual, and no-target outcomes', () => {
  const genericAcceptanceConfig = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      acceptanceProof: {
        ...validConfig.reviewGates.acceptanceProof,
        runnerValidationCommand: 'npm run acceptance-proof',
        changedPathGlobs: ['src/api/**'],
      },
    },
  };

  assert.deepEqual(decideProofRouting({
    config: validConfig,
    issue: issueFixture({
      number: 901,
      title: 'Record analytics event',
      body: 'Proof Strategy: non-visual-smoke\nUse deterministic event smoke output.',
    }),
    changedFiles: ['lib/presentation/screens/live/live_screen.dart'],
  }), {
    applies: false,
    desirable: false,
    dispatchTarget: 'none',
    proofStrategy: 'non-visual-smoke',
    action: 'skip',
    reason: 'proof strategy disables browser/mobile visual proof',
  });

  assert.deepEqual(decideProofRouting({
    config: genericAcceptanceConfig,
    issue: issueFixture({ number: 902, title: 'Backend API smoke proof', body: 'Acceptance proof by API smoke output.' }),
    changedFiles: ['src/api/routes.ts'],
  }), {
    applies: true,
    desirable: false,
    dispatchTarget: 'none',
    proofStrategy: 'auto',
    action: 'allow-non-visual',
    reason: 'acceptance proof applies without browser or mobile dispatch',
  });

  assert.deepEqual(decideProofRouting({
    config: validConfig,
    issue: issueFixture({ number: 903, title: 'Needs visual proof', body: 'The layout proof must include a screenshot.' }),
    changedFiles: ['src/server.ts'],
  }), {
    applies: true,
    desirable: true,
    dispatchTarget: 'none',
    proofStrategy: 'auto',
    action: 'error',
    reason: 'visual proof is desirable but no browser or mobile dispatch target matched',
  });
});

test('visual proof policy does not require device screenshots for explicit non-visual Firebase analytics proof', () => {
  assert.equal(shouldApplyVisualProofGate({
    config: validConfig,
    issue: issueFixture({
      number: 160,
      title: 'Add Firebase-visible analytics for Live entry',
      body: [
        'Proof Strategy: non-visual-smoke',
        'Send Firebase Analytics events from the mobile app when a user enters the Live screen.',
        'Route live_screen_viewed, sub_purchased, and points_purchased through AnalyticsService.logEvent.',
        'Tests or debug proof verify the event paths.',
      ].join('\n'),
    }),
    changedFiles: [
      'lib/presentation/screens/prediction_markets/prediction_markets_discovery_screen.dart',
      'test/core/services/analytics_service_test.dart',
    ],
  }), false);
});

test('explicit non-visual proof contract disables visual proof without issue text heuristics', () => {
  const issue = issueFixture({
    number: 901,
    title: 'Record Live entry event',
    body: [
      'Proof Strategy: non-visual-smoke',
      'Emit the event when the Live tab opens.',
      'The changed Flutter screen is not itself the proof surface.',
    ].join('\n'),
  });

  assert.equal(shouldApplyVisualProofGate({
    config: validConfig,
    issue,
    changedFiles: [
      'lib/presentation/screens/live/live_screen.dart',
      'test/presentation/screens/live/live_screen_test.dart',
    ],
  }), false);
  assert.equal(classifyVisualProofDispatchTarget({
    config: validConfig,
    issue,
    changedFiles: ['lib/presentation/screens/live/live_screen.dart'],
  }), 'none');
});

test('explicit visual proof contracts route browser and mobile proof deterministically', () => {
  const browserIssue = issueFixture({
    number: 902,
    title: 'Verify dashboard copy',
    body: 'proofStrategy: browser-visual',
  });
  const mobileIssue = issueFixture({
    number: 903,
    title: 'Verify Flutter launch',
    body: 'Proof Strategy: mobile-visual',
  });

  assert.equal(shouldApplyVisualProofGate({ config: validConfig, issue: browserIssue, changedFiles: ['src/server.ts'] }), true);
  assert.equal(classifyVisualProofDispatchTarget({ config: validConfig, issue: browserIssue, changedFiles: ['src/server.ts'] }), 'browser');
  assert.equal(shouldApplyVisualProofGate({ config: validConfig, issue: mobileIssue, changedFiles: ['src/server.ts'] }), true);
  assert.equal(classifyVisualProofDispatchTarget({ config: validConfig, issue: mobileIssue, changedFiles: ['src/server.ts'] }), 'mobile');
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

test('visual proof dispatch policy classifies web, mobile, mixed, and backend changes', () => {
  const webIssue = issueFixture({ number: 882, title: 'Web UI proof', body: 'Frontend layout requires proof.' });
  const mobileIssue = issueFixture({ number: 882, title: 'Flutter mobile proof', body: 'Mobile app visual proof for Flutter.' });
  const backendIssue = issueFixture({ number: 882, title: 'Backend worker', body: 'No UI proof.' });

  assert.equal(classifyVisualProofDispatchTarget({
    config: validConfig,
    issue: webIssue,
    changedFiles: ['src/frontend/App.tsx'],
  }), 'browser');
  assert.equal(classifyVisualProofDispatchTarget({
    config: validConfig,
    issue: webIssue,
    changedFiles: ['app/page.tsx'],
  }), 'browser');
  assert.equal(classifyVisualProofDispatchTarget({
    config: validConfig,
    issue: mobileIssue,
    changedFiles: ['android/app/build.gradle'],
  }), 'mobile');
  assert.equal(classifyVisualProofDispatchTarget({
    config: validConfig,
    issue: mobileIssue,
    changedFiles: ['ios/App.xcodeproj/project.pbxproj'],
  }), 'mobile');
  assert.equal(classifyVisualProofDispatchTarget({
    config: validConfig,
    issue: mobileIssue,
    changedFiles: ['lib/main.dart'],
  }), 'mobile');
  assert.equal(classifyVisualProofDispatchTarget({
    config: validConfig,
    issue: webIssue,
    changedFiles: ['src/frontend/App.tsx', 'android/app/build.gradle'],
  }), 'mobile');
  assert.equal(classifyVisualProofDispatchTarget({
    config: validConfig,
    issue: backendIssue,
    changedFiles: ['src/server.ts'],
  }), 'none');
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
      reviewHandoff: defaultReviewHandoff,
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
