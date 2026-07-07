import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blockersFromReasons,
  decideImplementationRework,
  INCOMPLETE_AFTER_PROGRESS_REASON,
  MISSING_COMPLETION_REPORT_REASON,
  type RunnerBlocker,
} from '../src/runner/rework-policy.js';
import type { CodexOrchestratorConfig } from '../src/config/schema.js';
import { validConfig } from './fixtures/config.js';

function withReworkConfig(input: {
  maxAttempts?: number;
  retryableBlockers?: string[];
  acceptanceProofMaxIterations?: number;
} = {}): CodexOrchestratorConfig {
  return {
    ...validConfig,
    loopPolicy: {
      ...validConfig.loopPolicy,
      rework: {
        ...validConfig.loopPolicy.rework,
        maxAttempts: input.maxAttempts ?? validConfig.loopPolicy.rework.maxAttempts,
        retryableBlockers: (input.retryableBlockers
          ?? validConfig.loopPolicy.rework.retryableBlockers) as CodexOrchestratorConfig['loopPolicy']['rework']['retryableBlockers'],
      },
    },
    reviewGates: {
      ...validConfig.reviewGates,
      acceptanceProof: {
        ...validConfig.reviewGates.acceptanceProof,
        maxIterations: input.acceptanceProofMaxIterations ?? validConfig.reviewGates.acceptanceProof.maxIterations,
      },
    },
  };
}

test('quality gate blockers retry then exhaust by zero-based attempt budget', () => {
  const config = withReworkConfig({ maxAttempts: 1 });
  const reasons = ['Quality gate requires TDD red-to-green proof in validation.'];

  assert.deepEqual(decideImplementationRework({ reasons, config, attempt: 0 }), {
    kind: 'retry',
    attempt: 0,
    nextAttempt: 1,
    maxAttempts: 1,
    blockerKeys: ['missing-quality-gate-evidence'],
    reasons,
    rework: {
      attempt: 1,
      blockedReasons: reasons,
      disableOptionalFigmaMcp: false,
    },
  });

  assert.deepEqual(decideImplementationRework({ reasons, config, attempt: 1 }), {
    kind: 'exhausted',
    attempt: 1,
    maxAttempts: 1,
    blockerKeys: ['missing-quality-gate-evidence'],
    reasons,
  });
});

test('typed blockers drive retry decisions without depending on reason wording', () => {
  const config = withReworkConfig({ maxAttempts: 1 });
  const blockers: RunnerBlocker[] = [
    {
      key: 'missing-quality-gate-evidence',
      reason: 'Reviewer wording changed, but the key is stable.',
      source: 'review-gate',
      repair: 'implementation-rework',
    },
    {
      key: 'failed-configured-checks',
      reason: 'Tool-specific failure wording.',
      source: 'configured-check',
      repair: 'implementation-rework',
    },
    {
      key: 'incomplete-after-progress',
      reason: 'Safe progress was observed.',
      source: 'recovery',
      repair: 'implementation-rework',
    },
  ];
  const reasons = blockers.map((blocker) => blocker.reason);

  assert.deepEqual(decideImplementationRework({ blockers, reasons, config, attempt: 0 }), {
    kind: 'retry',
    attempt: 0,
    nextAttempt: 1,
    maxAttempts: 1,
    blockerKeys: ['missing-quality-gate-evidence', 'failed-configured-checks', 'incomplete-after-progress'],
    reasons,
    rework: {
      attempt: 1,
      blockedReasons: reasons,
      disableOptionalFigmaMcp: false,
    },
  });
});

test('hard typed blockers override retryable typed blockers', () => {
  const reasons = ['quality evidence missing', 'secret path changed'];
  const blockers: RunnerBlocker[] = [
    {
      key: 'missing-quality-gate-evidence',
      reason: reasons[0]!,
      source: 'review-gate',
      repair: 'implementation-rework',
    },
    {
      key: 'denied-path',
      reason: reasons[1]!,
      source: 'safety',
      repair: 'none',
    },
  ];

  assert.deepEqual(decideImplementationRework({ blockers, reasons, config: withReworkConfig(), attempt: 0 }), {
    kind: 'hard-block',
    attempt: 0,
    blockerKeys: ['missing-quality-gate-evidence', 'denied-path'],
    reasons,
  });
});

test('typed repair-none blockers hard-block even when their key is retryable', () => {
  const reasons = ['Completion report repair did not write CODEX_ORCHESTRATOR_REPORT_FILE.'];
  const blockers: RunnerBlocker[] = [{
    key: 'missing-completion-report',
    reason: reasons[0]!,
    source: 'completion-report',
    repair: 'none',
  }];

  assert.deepEqual(decideImplementationRework({ blockers, reasons, config: withReworkConfig(), attempt: 0 }), {
    kind: 'hard-block',
    attempt: 0,
    blockerKeys: ['missing-completion-report'],
    reasons,
  });
});

test('hard blockers take precedence over retryable reasons', () => {
  const reasons = [
    'Quality gate requires TDD red-to-green proof in validation.',
    'Changed path .env matches denied pattern .env',
    'runner-owned publication was violated by agent push',
    'destructive-db-or-cache command was requested',
  ];

  assert.deepEqual(decideImplementationRework({ reasons, config: withReworkConfig(), attempt: 0 }), {
    kind: 'hard-block',
    attempt: 0,
    blockerKeys: [
      'missing-quality-gate-evidence',
      'denied-path',
      'publication-violation',
      'destructive-or-production-action',
    ],
    reasons,
  });
});

test('acceptance proof blockers use proof iteration budget', () => {
  const config = withReworkConfig({ maxAttempts: 1, acceptanceProofMaxIterations: 5 });
  const reasons = ['Acceptance proof needs rework.'];

  assert.equal(decideImplementationRework({ reasons, config, attempt: 3 }).kind, 'retry');
  assert.deepEqual(decideImplementationRework({ reasons, config, attempt: 4 }), {
    kind: 'exhausted',
    attempt: 4,
    maxAttempts: 4,
    blockerKeys: ['failed-acceptance-proof'],
    reasons,
  });
});

test('typed acceptance proof blockers use proof iteration budget', () => {
  const config = withReworkConfig({ maxAttempts: 1, acceptanceProofMaxIterations: 5 });
  const reasons = ['Acceptance proof wording changed.'];
  const blockers: RunnerBlocker[] = [{
    key: 'failed-acceptance-proof',
    reason: reasons[0]!,
    source: 'acceptance-proof',
    repair: 'implementation-rework',
  }];

  assert.equal(decideImplementationRework({ blockers, reasons, config, attempt: 3 }).kind, 'retry');
  assert.deepEqual(decideImplementationRework({ blockers, reasons, config, attempt: 4 }), {
    kind: 'exhausted',
    attempt: 4,
    maxAttempts: 4,
    blockerKeys: ['failed-acceptance-proof'],
    reasons,
  });
});

test('invalid acceptance proof report schema hard-blocks implementation rework', () => {
  const reasons = ['Invalid acceptance proof report schema: criteria must be an array; artifacts must be an array'];

  assert.deepEqual(decideImplementationRework({ reasons, config: withReworkConfig(), attempt: 0 }), {
    kind: 'hard-block',
    attempt: 0,
    blockerKeys: ['invalid-acceptance-proof-report'],
    reasons,
  });
});

test('failed command summaries stay retryable with configured check blockers', () => {
  const config = withReworkConfig({ maxAttempts: 1 });
  const reasons = [
    'One or more configured checks failed.',
    'npm test: failed - FAIL src/prediction-markets/prediction-markets.controller.spec.ts\n  thrown: "Exceeded timeout of 5000 ms"',
  ];

  assert.deepEqual(decideImplementationRework({ reasons, config, attempt: 0 }), {
    kind: 'retry',
    attempt: 0,
    nextAttempt: 1,
    maxAttempts: 1,
    blockerKeys: ['failed-configured-checks'],
    reasons,
    rework: {
      attempt: 1,
      blockedReasons: reasons,
      disableOptionalFigmaMcp: false,
    },
  });
});

test('risk routing policy blockers retry only when configured', () => {
  const reason = 'Risk routing gate requires: scoped review handoff is required.';

  assert.deepEqual(decideImplementationRework({ reasons: [reason], config: validConfig, attempt: 0 }), {
    kind: 'hard-block',
    attempt: 0,
    blockerKeys: ['risk-routing-policy'],
    reasons: [reason],
  });

  const configured = withReworkConfig({
    retryableBlockers: [
      ...validConfig.loopPolicy.rework.retryableBlockers,
      'risk-routing-policy',
    ],
  });
  assert.equal(decideImplementationRework({ reasons: [reason], config: configured, attempt: 0 }).kind, 'retry');
});

test('figma failure reasons split optional retry from required hard block', () => {
  const optionalReason = 'Optional Figma MCP failed before completion; retry without optional Figma MCP.';
  const requiredReason = 'Required Figma MCP failed; required design access is unavailable.';
  const config = withReworkConfig({
    maxAttempts: 1,
    retryableBlockers: [
      ...validConfig.loopPolicy.rework.retryableBlockers,
      'optional-figma-mcp-failure',
    ],
  });

  assert.deepEqual(decideImplementationRework({ reasons: [optionalReason], config, attempt: 0 }), {
    kind: 'retry',
    attempt: 0,
    nextAttempt: 1,
    maxAttempts: 1,
    blockerKeys: ['optional-figma-mcp-failure'],
    reasons: [optionalReason],
    rework: {
      attempt: 1,
      blockedReasons: [optionalReason],
      disableOptionalFigmaMcp: true,
    },
  });

  assert.deepEqual(decideImplementationRework({ reasons: [requiredReason], config, attempt: 0 }), {
    kind: 'hard-block',
    attempt: 0,
    blockerKeys: ['required-figma-mcp-failure'],
    reasons: [requiredReason],
  });
});

test('missing report is retryable and unknown codex exits hard-block', () => {
  assert.equal(
    decideImplementationRework({ reasons: [MISSING_COMPLETION_REPORT_REASON], config: validConfig, attempt: 0 }).kind,
    'retry',
  );
  assert.deepEqual(decideImplementationRework({
    reasons: ['Codex exited with code 1: failed for an unknown reason'],
    config: validConfig,
    attempt: 0,
  }), {
    kind: 'hard-block',
    attempt: 0,
    blockerKeys: ['unknown'],
    reasons: ['Codex exited with code 1: failed for an unknown reason'],
  });
});

test('incomplete progress sentinel retries only from runner-owned reason', () => {
  const config = withReworkConfig({
    maxAttempts: 1,
    retryableBlockers: [
      ...validConfig.loopPolicy.rework.retryableBlockers,
      'incomplete-after-progress',
    ],
  });

  assert.deepEqual(decideImplementationRework({
    reasons: [INCOMPLETE_AFTER_PROGRESS_REASON],
    config,
    attempt: 0,
  }), {
    kind: 'retry',
    attempt: 0,
    nextAttempt: 1,
    maxAttempts: 1,
    blockerKeys: ['incomplete-after-progress'],
    reasons: [INCOMPLETE_AFTER_PROGRESS_REASON],
    rework: {
      attempt: 1,
      blockedReasons: [INCOMPLETE_AFTER_PROGRESS_REASON],
      disableOptionalFigmaMcp: false,
    },
  });

  assert.deepEqual(decideImplementationRework({
    reasons: [INCOMPLETE_AFTER_PROGRESS_REASON],
    config,
    attempt: 1,
  }), {
    kind: 'exhausted',
    attempt: 1,
    maxAttempts: 1,
    blockerKeys: ['incomplete-after-progress'],
    reasons: [INCOMPLETE_AFTER_PROGRESS_REASON],
  });

  const rawIdleTimeout = 'Codex exited with code 124: Command idle timed out after 300000ms.';
  assert.deepEqual(decideImplementationRework({
    reasons: [rawIdleTimeout],
    config,
    attempt: 0,
  }), {
    kind: 'hard-block',
    attempt: 0,
    blockerKeys: ['unknown'],
    reasons: [rawIdleTimeout],
  });
});

test('legacy reason adapter keeps unknown fallback isolated', () => {
  assert.deepEqual(blockersFromReasons([
    'Quality gate requires TDD red-to-green proof in validation.',
    'unclassified blocker text',
  ]), [
    {
      key: 'missing-quality-gate-evidence',
      reason: 'Quality gate requires TDD red-to-green proof in validation.',
      source: 'publishability',
      repair: 'implementation-rework',
    },
    {
      key: 'unknown',
      reason: 'unclassified blocker text',
      source: 'publishability',
      repair: 'none',
    },
  ]);
});

test('old rework helper exports are unavailable', async () => {
  const moduleExports = await import('../src/runner/rework-policy.js');
  const oldBooleanHelper = ['shouldRequestImplementation', 'Rework'].join('');
  const oldBudgetHelper = ['maxReworkAttemptsFor', 'Reasons'].join('');

  assert.equal(oldBooleanHelper in moduleExports, false);
  assert.equal(oldBudgetHelper in moduleExports, false);
});
