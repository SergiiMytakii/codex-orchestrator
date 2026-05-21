import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateAcceptanceProofReport } from '../src/runner/acceptance-proof.js';
import {
  assembleBlockedBrowserProofReport,
  assembleBrowserAcceptanceProofReport,
  browserProofRuntimeEnv,
  validateBrowserProofScenario,
  type BrowserProofScenario,
} from '../src/runner/browser-proof-contract.js';
import { validConfig } from './fixtures/config.js';

const artifactDir = '.codex-orchestrator/proofs';
const issueNumber = 883;
const screenshotPath = `${artifactDir}/issue-${issueNumber}/wide-desktop.png`;
const domPath = `${artifactDir}/issue-${issueNumber}/wide-desktop.dom.json`;
const consolePath = `${artifactDir}/issue-${issueNumber}/console.log`;
const networkPath = `${artifactDir}/issue-${issueNumber}/network.log`;
const summaryPath = `${artifactDir}/issue-${issueNumber}/browser-summary.json`;

test('browser proof scenario contract accepts a valid v1 scenario', () => {
  const result = validateBrowserProofScenario(validScenario(), {
    artifactDir,
    issueNumber,
    envPassthrough: ['SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD'],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scenario.version, 1);
  assert.equal(result.scenario.criteria[0]?.id, 'ac-web');
});

test('browser proof scenario contract rejects malformed scenarios before browser launch', () => {
  const cases: Array<{ name: string; scenario: unknown; message: RegExp }> = [
    { name: 'missing version', scenario: { ...validScenario(), version: undefined }, message: /version must be 1/ },
    { name: 'invalid baseUrl', scenario: { ...validScenario(), baseUrl: 'file:///tmp/app.html' }, message: /baseUrl must be an absolute http/ },
    {
      name: 'invalid viewport',
      scenario: { ...validScenario(), viewports: [{ name: 'desktop', width: 0, height: 900, requiredBy: 'desktop-web-layout' }] },
      message: /viewport.*width and height/,
    },
    { name: 'unknown action', scenario: { ...validScenario(), steps: [{ action: 'hover', selector: '#x' }] }, message: /unknown action/ },
    { name: 'missing selector', scenario: { ...validScenario(), steps: [{ action: 'click' }] }, message: /click.*selector or text/ },
    { name: 'missing text', scenario: { ...validScenario(), steps: [{ action: 'waitForText' }] }, message: /waitForText.*text/ },
    {
      name: 'unmapped criteria',
      scenario: { ...validScenario(), steps: validScenario().steps.filter((step) => step.action !== 'screenshot' && step.action !== 'domSnapshot') },
      message: /criteria.*ac-web.*checkpoint/,
    },
    {
      name: 'invalid auth env',
      scenario: { ...validScenario(), auth: { mode: 'real-login', env: ['SMOKE_USER_EMAIL', 'bad-name'] } },
      message: /auth env.*bad-name/,
    },
    {
      name: 'secret-like auth metadata',
      scenario: { ...validScenario(), auth: { mode: 'real-login', env: ['.env'] } },
      message: /auth env.*secret file/,
    },
    {
      name: 'seeded session without reason',
      scenario: { ...validScenario(), auth: { mode: 'seeded-session' } },
      message: /seeded-session.*shortcutReason/,
    },
  ];

  for (const item of cases) {
    const result = validateBrowserProofScenario(item.scenario, {
      artifactDir,
      issueNumber,
      envPassthrough: ['SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD'],
    });
    assert.equal(result.ok, false, item.name);
    if (result.ok) continue;
    assert.match(result.errors.join('\n'), item.message, item.name);
  }
});

test('blocked browser proof report is validly shaped and rejected only as blocked proof', () => {
  const report = assembleBlockedBrowserProofReport({
    issueNumber,
    artifactDir,
    scenario: validScenario(),
    issue: {
      kind: 'playwrightPackage',
      diagnostic: 'Playwright package is not installed.',
      requiredChanges: ['Install or expose Playwright before running browser proof.'],
    },
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.artifacts[0]?.type, 'log');
  assert.equal(report.artifacts[0]?.path, `${artifactDir}/issue-${issueNumber}/browser-proof-diagnostics.json`);

  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report,
    proofPhaseChangedFiles: [report.artifacts[0]?.path ?? ''],
    artifactExists: () => true,
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /Acceptance proof blocked/);
  assert.doesNotMatch(result.reasons.join('\n'), /UI Evidence/);
  assert.doesNotMatch(result.reasons.join('\n'), /missing artifact path/);
});

test('browser proof report assembly maps artifacts to existing Acceptance Proof UI Evidence', () => {
  const scenario = validScenario();
  const report = assembleBrowserAcceptanceProofReport({
    issueNumber,
    artifactDir,
    scenario,
    checkpoints: [
      {
        checkpointId: 'final-screen',
        kind: 'screenshot',
        path: screenshotPath,
        viewportName: 'wide-desktop',
        criteriaRefs: ['ac-web'],
        description: 'Final wide desktop browser screenshot',
      },
      {
        checkpointId: 'final-dom',
        kind: 'domSnapshot',
        path: domPath,
        viewportName: 'wide-desktop',
        criteriaRefs: ['ac-web'],
        description: 'Final DOM snapshot',
      },
    ],
    diagnostics: {
      consoleLogPath: consolePath,
      networkLogPath: networkPath,
      runSummaryPath: summaryPath,
    },
    workflow: {
      entrypoint: 'http://127.0.0.1:4173/',
      path: ['Navigate to /', 'Click Start', 'Wait for Dashboard'],
      screenState: 'Dashboard with browser proof marker is visible',
    },
    layoutFindings: ['No clipping, overlap, or alignment defects were visible.'],
    copyFindings: ['Visible copy matches issue terms.'],
  });

  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report,
    proofPhaseChangedFiles: report.artifacts.map((artifact) => artifact.path).filter((path): path is string => Boolean(path)),
    artifactExists: (path) => path.startsWith(`${artifactDir}/issue-${issueNumber}/`),
  });

  assert.equal(result.ok, true, result.reasons.join('\n'));
  assert.equal(report.artifacts.some((artifact) => artifact.type === 'ui-dump' && artifact.path === domPath), true);
  assert.equal(report.uiEvidence?.viewportCoverage[0]?.width, 1440);
});

test('browser proof contract rejects artifact paths outside the proof directory', () => {
  const cases = [
    '/tmp/shot.png',
    `${artifactDir}/issue-${issueNumber}/../issue-1/shot.png`,
    'src/frontend/shot.png',
    `${artifactDir}/issue-${issueNumber}/playwright-profile/cache.png`,
    `${artifactDir}/issue-${issueNumber}/ms-playwright/browser.png`,
  ];

  for (const path of cases) {
    assert.throws(() => assembleBrowserAcceptanceProofReport({
      issueNumber,
      artifactDir,
      scenario: validScenario(),
      checkpoints: [{
        checkpointId: 'bad',
        kind: 'screenshot',
        path,
        viewportName: 'wide-desktop',
        criteriaRefs: ['ac-web'],
        description: 'bad path',
      }],
      diagnostics: {},
      workflow: {
        entrypoint: 'http://127.0.0.1:4173/',
        path: ['Navigate to /'],
        screenState: 'Screen is visible',
      },
      layoutFindings: ['Layout checked.'],
      copyFindings: ['Copy checked.'],
    }), /proof artifact path/i, path);
  }
});

test('browser proof runtime env constants keep runner and browser contract aligned', () => {
  assert.deepEqual(browserProofRuntimeEnv, {
    proofDir: 'CODEX_ORCHESTRATOR_PROOF_DIR',
    reportPath: 'CODEX_ORCHESTRATOR_PROOF_REPORT_PATH',
    playwrightProfileDir: 'CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR',
    playwrightBrowsersPath: 'PLAYWRIGHT_BROWSERS_PATH',
    browserCacheDir: 'CODEX_ORCHESTRATOR_BROWSER_CACHE_DIR',
    browserExecutablePath: 'CODEX_ORCHESTRATOR_BROWSER_EXECUTABLE_PATH',
  });
});

function validScenario(): BrowserProofScenario {
  return {
    version: 1,
    baseUrl: 'http://127.0.0.1:4173',
    viewports: [{
      name: 'wide-desktop',
      width: 1440,
      height: 900,
      requiredBy: 'desktop-web-layout',
    }],
    criteria: [{
      id: 'ac-web',
      description: 'The requested web workflow reaches the final dashboard state.',
    }],
    sourceInputs: {
      acceptanceCriteriaRefs: ['issue-883-ac-web'],
      implementationEvidenceRefs: ['npm test'],
    },
    auth: {
      mode: 'real-login',
      env: ['SMOKE_USER_EMAIL', 'SMOKE_USER_PASSWORD'],
    },
    steps: [
      { action: 'navigate', path: '/' },
      { action: 'click', text: 'Start' },
      { action: 'fill', selector: '#email', value: '${SMOKE_USER_EMAIL}' },
      { action: 'press', selector: '#email', key: 'Enter' },
      { action: 'waitForSelector', selector: '[data-testid="dashboard"]' },
      { action: 'waitForText', text: 'Dashboard' },
      { action: 'assertText', selector: '[data-testid="dashboard"]', text: 'Dashboard' },
      { action: 'assertUrl', expected: '/dashboard' },
      { action: 'screenshot', checkpointId: 'final-screen', path: screenshotPath, viewportName: 'wide-desktop', criteriaRefs: ['ac-web'] },
      { action: 'domSnapshot', checkpointId: 'final-dom', path: domPath, viewportName: 'wide-desktop', criteriaRefs: ['ac-web'] },
    ],
  };
}
