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
