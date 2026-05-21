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
