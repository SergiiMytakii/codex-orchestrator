import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAutoVisualProofCommand } from '../src/runner/auto-visual-proof-command.js';
import { validConfig } from './fixtures/config.js';

test('visual-proof auto dispatches web changes to browser proof', async () => {
  let browserIssue = 0;
  const result = await runAutoVisualProofCommand({
    args: ['--issue', '887', '--target', '/tmp/web', '--scenario', '/tmp/scenario.json'],
    config: validConfig,
    env: {
      CODEX_ORCHESTRATOR_CHANGED_FILES: 'src/frontend/App.tsx',
      CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Frontend UI proof',
      CODEX_ORCHESTRATOR_ISSUE_BODY: 'Web layout proof',
    },
    browserRunner: async (input) => {
      browserIssue = input.issueNumber;
    },
  });

  assert.equal(result.target, 'browser');
  assert.equal(browserIssue, 887);
});

test('visual-proof auto dispatches mobile changes to device-backed proof', async () => {
  let mobileIssue = 0;
  const result = await runAutoVisualProofCommand({
    args: ['--issue', '887', '--target', '/tmp/mobile'],
    config: validConfig,
    env: {
      CODEX_ORCHESTRATOR_CHANGED_FILES: 'android/app/build.gradle',
      CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Android proof',
      CODEX_ORCHESTRATOR_ISSUE_BODY: 'Mobile app proof',
    },
    mobileRunner: async (input) => {
      mobileIssue = input.issueNumber;
    },
  });

  assert.equal(result.target, 'mobile');
  assert.equal(mobileIssue, 887);
});

test('visual-proof auto uses the validated proof plan mode instead of changed-path inference', async () => {
  let browserRuns = 0;
  const result = await runAutoVisualProofCommand({
    args: ['--issue', '887', '--target', '/tmp/mixed', '--scenario', '/tmp/scenario.json'],
    config: validConfig,
    env: {
      CODEX_ORCHESTRATOR_PROOF_MODE: 'browser-visual',
      CODEX_ORCHESTRATOR_CHANGED_FILES: 'android/app/build.gradle',
      CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Browser proof selected by the validated plan',
    },
    browserRunner: async () => {
      browserRuns += 1;
    },
    mobileRunner: async () => {
      throw new Error('changed-path inference must not override the validated browser proof plan');
    },
  });

  assert.equal(result.target, 'browser');
  assert.equal(browserRuns, 1);
});

test('visual-proof auto treats Flutter lib changes as mobile when issue asks for mobile proof', async () => {
  let mobileIssue = 0;
  const result = await runAutoVisualProofCommand({
    args: ['--issue', '160', '--target', '/tmp/flutter-app'],
    config: validConfig,
    env: {
      CODEX_ORCHESTRATOR_CHANGED_FILES: 'lib/presentation/screens/prediction_markets/prediction_markets_discovery_screen.dart',
      CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Add Live screen Firebase analytics in Flutter',
      CODEX_ORCHESTRATOR_ISSUE_BODY: 'Mobile app proof should validate the Flutter screen change.',
    },
    mobileRunner: async (input) => {
      mobileIssue = input.issueNumber;
    },
  });

  assert.equal(result.target, 'mobile');
  assert.equal(mobileIssue, 160);
});

test('visual-proof auto honors explicit non-visual proof contract without running device proof', async () => {
  const result = await runAutoVisualProofCommand({
    args: ['--issue', '160', '--target', '/tmp/flutter-app'],
    config: validConfig,
    env: {
      CODEX_ORCHESTRATOR_CHANGED_FILES: 'lib/presentation/screens/prediction_markets/prediction_markets_discovery_screen.dart',
      CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Add event dispatch',
      CODEX_ORCHESTRATOR_ISSUE_BODY: 'Proof Strategy: non-visual-smoke\nUse tests and smoke output as proof.',
    },
    mobileRunner: async () => {
      throw new Error('mobile proof should not run for non-visual proof strategy');
    },
  });

  assert.equal(result.target, 'none');
});

test('visual-proof auto honors markdown bullet non-visual proof contract', async () => {
  const result = await runAutoVisualProofCommand({
    args: ['--issue', '264', '--target', '/tmp/backend'],
    config: validConfig,
    env: {
      CODEX_ORCHESTRATOR_CHANGED_FILES: 'docs/contracts/live-challenge-results-v1.fixture.json',
      CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Contract fixture',
      CODEX_ORCHESTRATOR_ISSUE_BODY: '- Proof Strategy: non-visual-smoke\n- Automated: parse fixture JSON.',
    },
    browserRunner: async () => {
      throw new Error('browser proof should not run for markdown bullet non-visual proof strategy');
    },
    mobileRunner: async () => {
      throw new Error('mobile proof should not run for markdown bullet non-visual proof strategy');
    },
  });

  assert.equal(result.target, 'none');
});

test('visual-proof auto accepts backend-only acceptance proof without browser or mobile dispatch', async () => {
  const result = await runAutoVisualProofCommand({
    args: ['--issue', '263', '--target', '/tmp/backend'],
    config: validConfig,
    env: {
      CODEX_ORCHESTRATOR_CHANGED_FILES: [
        'src/live-challenges/live-challenges.service.ts',
        'src/live-challenges/live-challenges.service.spec.ts',
        'docs/agents/contract-test-ledger.md',
      ].join('\n'),
      CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Live match challenges: round 60 min - closing too fast',
      CODEX_ORCHESTRATOR_ISSUE_BODY: [
        'Final proof includes deterministic test evidence or a live/manual timing fixture.',
        'The backend API timing behavior is proven by smoke-output artifacts.',
      ].join('\n'),
    },
    browserRunner: async () => {
      throw new Error('browser proof should not run for backend-only acceptance proof');
    },
    mobileRunner: async () => {
      throw new Error('mobile proof should not run for backend-only acceptance proof');
    },
  });

  assert.equal(result.target, 'none');
});

test('visual-proof auto accepts configured non-visual acceptance paths without browser dispatch', async () => {
  const config = {
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

  const result = await runAutoVisualProofCommand({
    args: ['--issue', '263', '--target', '/tmp/backend'],
    config,
    env: {
      CODEX_ORCHESTRATOR_CHANGED_FILES: 'src/api/routes.ts',
      CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Backend API smoke proof',
      CODEX_ORCHESTRATOR_ISSUE_BODY: 'Acceptance proof by API smoke output.',
    },
    browserRunner: async () => {
      throw new Error('browser proof should not run for configured non-visual acceptance paths');
    },
  });

  assert.equal(result.target, 'none');
});

test('visual-proof auto reports no-match failures clearly', async () => {
  await assert.rejects(
    runAutoVisualProofCommand({
      args: ['--issue', '887'],
      config: validConfig,
      env: {
        CODEX_ORCHESTRATOR_CHANGED_FILES: 'src/server.ts',
      },
    }),
    /could not select browser or mobile proof/,
  );
});

test('visual-proof auto still rejects visual proof requests without a browser or mobile dispatch path', async () => {
  await assert.rejects(
    runAutoVisualProofCommand({
      args: ['--issue', '887'],
      config: validConfig,
      env: {
        CODEX_ORCHESTRATOR_CHANGED_FILES: 'src/server.ts',
        CODEX_ORCHESTRATOR_ISSUE_TITLE: 'Needs visual proof',
        CODEX_ORCHESTRATOR_ISSUE_BODY: 'The layout proof must include a screenshot.',
      },
    }),
    /could not select browser or mobile proof/,
  );
});
