import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  parseBrowserVisualProofArgs,
  runBrowserVisualProofCommand,
  type BrowserProofAdapter,
} from '../src/runner/browser-visual-proof-command.js';

const artifactDir = '.codex-orchestrator/proofs';

test('browser visual proof parser accepts issue, target, scenario, and base-url options', () => {
  const parsed = parseBrowserVisualProofArgs([
    '--issue',
    '884',
    '--target',
    '/tmp/web',
    '--scenario',
    '/tmp/scenario.json',
    '--base-url',
    'http://127.0.0.1:4173',
  ], {});

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.issueNumber, 884);
  assert.equal(parsed.value.worktreePath, '/tmp/web');
  assert.equal(parsed.value.scenarioPath, '/tmp/scenario.json');
  assert.equal(parsed.value.baseUrl, 'http://127.0.0.1:4173');
});

test('browser visual proof parser rejects unknown or incomplete options clearly', () => {
  assert.deepEqual(parseBrowserVisualProofArgs(['--issue', '0'], {}), {
    ok: false,
    error: 'visual-proof browser requires --issue <number>',
  });
  assert.deepEqual(parseBrowserVisualProofArgs(['--issue', '884', '--scenario'], {}), {
    ok: false,
    error: '--scenario requires a value',
  });
  assert.deepEqual(parseBrowserVisualProofArgs(['--issue', '884', '--bogus'], {}), {
    ok: false,
    error: 'Unknown visual-proof browser option: --bogus',
  });
});

test('browser visual proof command executes a scenario and writes artifacts plus report', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));
  const scenarioPath = join(worktreePath, '.codex-orchestrator', 'proofs', 'issue-884', 'browser-proof-scenario.json');
  await mkdir(join(worktreePath, artifactDir, 'issue-884'), { recursive: true });
  await writeFile(scenarioPath, JSON.stringify(validScenario(884)), 'utf8');

  const adapter: BrowserProofAdapter = {
    async run(input) {
      assert.equal(input.scenario.baseUrl, 'http://127.0.0.1:4173');
      assert.equal(input.proofDir, join(worktreePath, artifactDir, 'issue-884'));
      await writeFile(join(input.proofDir, 'wide.png'), 'png', 'utf8');
      await writeFile(join(input.proofDir, 'wide.dom.json'), '{"text":"Dashboard"}', 'utf8');
      await writeFile(join(input.proofDir, 'console.log'), '', 'utf8');
      await writeFile(join(input.proofDir, 'network.log'), '', 'utf8');
      await writeFile(join(input.proofDir, 'browser-summary.json'), '{"status":"passed"}', 'utf8');
      return {
        checkpoints: [
          {
            checkpointId: 'final-screen',
            kind: 'screenshot',
            path: `${artifactDir}/issue-884/wide.png`,
            viewportName: 'wide-desktop',
            criteriaRefs: ['ac-web'],
            description: 'Final browser screenshot',
          },
          {
            checkpointId: 'final-dom',
            kind: 'domSnapshot',
            path: `${artifactDir}/issue-884/wide.dom.json`,
            viewportName: 'wide-desktop',
            criteriaRefs: ['ac-web'],
            description: 'Final DOM snapshot',
          },
        ],
        diagnostics: {
          consoleLogPath: `${artifactDir}/issue-884/console.log`,
          networkLogPath: `${artifactDir}/issue-884/network.log`,
          runSummaryPath: `${artifactDir}/issue-884/browser-summary.json`,
        },
        consoleErrors: [],
        networkFailures: [],
      };
    },
  };

  const result = await runBrowserVisualProofCommand({
    issueNumber: 884,
    worktreePath,
    artifactDir,
    scenarioPath,
    adapter,
    env: {},
  });

  assert.equal(result.status, 'passed');
  const report = JSON.parse(await readFile(join(worktreePath, artifactDir, 'issue-884', 'acceptance-proof-report.json'), 'utf8')) as {
    status?: string;
    artifacts?: Array<{ path?: string; type?: string }>;
    uiEvidence?: unknown;
  };
  assert.equal(report.status, 'passed');
  assert.equal(report.artifacts?.some((artifact) => artifact.type === 'ui-dump' && artifact.path?.endsWith('wide.dom.json')), true);
  assert.ok(report.uiEvidence);
});

test('browser visual proof command writes blocked proof for missing or malformed scenario', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));
  const missing = await runBrowserVisualProofCommand({
    issueNumber: 885,
    worktreePath,
    artifactDir,
    scenarioPath: join(worktreePath, 'missing.json'),
    adapter: failingAdapter(),
    env: {},
  });

  assert.equal(missing.status, 'blocked');
  let report = await readFile(join(worktreePath, artifactDir, 'issue-885', 'acceptance-proof-report.json'), 'utf8');
  assert.match(report, /invalidScenario/);

  const malformedScenarioPath = join(worktreePath, artifactDir, 'issue-885', 'browser-proof-scenario.json');
  await writeFile(malformedScenarioPath, '{"version":1}', 'utf8');
  const malformed = await runBrowserVisualProofCommand({
    issueNumber: 885,
    worktreePath,
    artifactDir,
    scenarioPath: malformedScenarioPath,
    adapter: failingAdapter(),
    env: {},
  });

  assert.equal(malformed.status, 'blocked');
  report = await readFile(join(worktreePath, artifactDir, 'issue-885', 'acceptance-proof-report.json'), 'utf8');
  assert.match(report, /baseUrl/);
});

test('browser visual proof command refuses scenario files outside proof-owned paths before reading', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));
  const secretPath = join(worktreePath, '.env');
  await writeFile(secretPath, 'not-json-secret=1', 'utf8');

  const result = await runBrowserVisualProofCommand({
    issueNumber: 885,
    worktreePath,
    artifactDir,
    scenarioPath: secretPath,
    adapter: failingAdapter(),
    env: {},
  });

  assert.equal(result.status, 'blocked');
  const report = await readFile(join(worktreePath, artifactDir, 'issue-885', 'acceptance-proof-report.json'), 'utf8');
  assert.match(report, /must not reference a secret file/);
  assert.doesNotMatch(report, /malformed/);
});

test('browser visual proof command accepts auth env listed in runner passthrough metadata', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));
  const proofDir = join(worktreePath, artifactDir, 'issue-884');
  const scenarioPath = join(proofDir, 'browser-proof-scenario.json');
  await mkdir(proofDir, { recursive: true });
  await writeFile(scenarioPath, JSON.stringify({
    ...validScenario(884),
    auth: { mode: 'real-login', env: ['SMOKE_USER_EMAIL'] },
  }), 'utf8');

  const result = await runBrowserVisualProofCommand({
    issueNumber: 884,
    worktreePath,
    artifactDir,
    scenarioPath,
    adapter: passingAdapter(worktreePath, 884),
    env: {
      CODEX_ORCHESTRATOR_BROWSER_ENV_PASSTHROUGH: 'SMOKE_USER_EMAIL',
    },
  });

  assert.equal(result.status, 'passed');
});

test('browser visual proof command classifies assertions as needs-rework', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));
  const proofDir = join(worktreePath, artifactDir, 'issue-885');
  const scenarioPath = join(proofDir, 'browser-proof-scenario.json');
  await mkdir(proofDir, { recursive: true });
  await writeFile(scenarioPath, JSON.stringify(validScenario(885)), 'utf8');
  const adapter: BrowserProofAdapter = {
    async run() {
      throw Object.assign(new Error('Expected text Dashboard was missing'), { code: 'ASSERTION_FAILED' });
    },
  };

  const result = await runBrowserVisualProofCommand({
    issueNumber: 885,
    worktreePath,
    artifactDir,
    scenarioPath,
    adapter,
    env: {},
  });

  assert.equal(result.status, 'needs-rework');
  const report = await readFile(join(proofDir, 'acceptance-proof-report.json'), 'utf8');
  assert.match(report, /needs-rework/);
  assert.match(report, /Expected text Dashboard was missing/);
});

test('browser visual proof command applies console and network strictness', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));
  const proofDir = join(worktreePath, artifactDir, 'issue-885');
  const scenarioPath = join(proofDir, 'browser-proof-scenario.json');
  await mkdir(proofDir, { recursive: true });
  await writeFile(scenarioPath, JSON.stringify(validScenario(885)), 'utf8');
  const adapter: BrowserProofAdapter = {
    async run() {
      await writeFile(join(proofDir, 'wide.png'), 'png', 'utf8');
      await writeFile(join(proofDir, 'wide.dom.json'), '{}', 'utf8');
      await writeFile(join(proofDir, 'console.log'), 'TypeError', 'utf8');
      await writeFile(join(proofDir, 'network.log'), 'GET /api failed', 'utf8');
      await writeFile(join(proofDir, 'browser-summary.json'), '{}', 'utf8');
      return {
        checkpoints: [{
          checkpointId: 'final-screen',
          kind: 'screenshot',
          path: `${artifactDir}/issue-885/wide.png`,
          viewportName: 'wide-desktop',
          criteriaRefs: ['ac-web'],
          description: 'Final browser screenshot',
        }, {
          checkpointId: 'final-dom',
          kind: 'domSnapshot',
          path: `${artifactDir}/issue-885/wide.dom.json`,
          viewportName: 'wide-desktop',
          criteriaRefs: ['ac-web'],
          description: 'Final DOM snapshot',
        }],
        diagnostics: {
          consoleLogPath: `${artifactDir}/issue-885/console.log`,
          networkLogPath: `${artifactDir}/issue-885/network.log`,
          runSummaryPath: `${artifactDir}/issue-885/browser-summary.json`,
        },
        consoleErrors: ['TypeError'],
        networkFailures: ['GET /api failed'],
      };
    },
  };

  const warning = await runBrowserVisualProofCommand({
    issueNumber: 885,
    worktreePath,
    artifactDir,
    scenarioPath,
    adapter,
    env: {},
    strictConsoleErrors: false,
    strictNetworkFailures: false,
  });
  assert.equal(warning.status, 'passed');

  const blocking = await runBrowserVisualProofCommand({
    issueNumber: 885,
    worktreePath,
    artifactDir,
    scenarioPath,
    adapter,
    env: {},
    strictConsoleErrors: true,
    strictNetworkFailures: true,
  });
  assert.equal(blocking.status, 'blocked');
  const report = JSON.parse(await readFile(join(proofDir, 'acceptance-proof-report.json'), 'utf8')) as {
    artifacts?: Array<{ path?: string }>;
    reworkRequest?: { summary?: string };
  };
  assert.match(report.reworkRequest?.summary ?? '', /consoleErrors|networkFailures/);
  assert.equal(report.artifacts?.some((artifact) => artifact.path?.endsWith('console.log')), true);
  assert.equal(report.artifacts?.some((artifact) => artifact.path?.endsWith('network.log')), true);
});

test('browser visual proof command records network strictness as network diagnostics', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));
  const proofDir = join(worktreePath, artifactDir, 'issue-885');
  const scenarioPath = join(proofDir, 'browser-proof-scenario.json');
  await mkdir(proofDir, { recursive: true });
  await writeFile(scenarioPath, JSON.stringify(validScenario(885)), 'utf8');
  const adapter: BrowserProofAdapter = {
    async run() {
      await writeFile(join(proofDir, 'console.log'), '', 'utf8');
      await writeFile(join(proofDir, 'network.log'), 'GET /api failed', 'utf8');
      await writeFile(join(proofDir, 'browser-summary.json'), '{}', 'utf8');
      return {
        checkpoints: [],
        diagnostics: {
          consoleLogPath: `${artifactDir}/issue-885/console.log`,
          networkLogPath: `${artifactDir}/issue-885/network.log`,
          runSummaryPath: `${artifactDir}/issue-885/browser-summary.json`,
        },
        consoleErrors: [],
        networkFailures: ['GET /api failed'],
      };
    },
  };

  const result = await runBrowserVisualProofCommand({
    issueNumber: 885,
    worktreePath,
    artifactDir,
    scenarioPath,
    adapter,
    env: {},
    strictNetworkFailures: true,
  });

  assert.equal(result.status, 'blocked');
  const diagnostics = await readFile(join(proofDir, 'browser-proof-diagnostics.json'), 'utf8');
  assert.match(diagnostics, /networkFailures/);
  assert.doesNotMatch(diagnostics, /consoleErrors/);
});

test('default browser adapter prefers an installed browser executable before Playwright browser install', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));
  const proofDir = join(worktreePath, artifactDir, 'issue-884');
  const browserPath = join(worktreePath, 'installed-browser');
  const nestedPath = `${artifactDir}/issue-884/screens/wide.png`;
  let launchOptions: { headless: boolean; executablePath?: string } | undefined;
  let installCalls = 0;
  const page = {
    on() {},
    async setViewportSize() {},
    async goto() {},
    async click() {},
    getByText() {
      return { async click() {}, async waitFor() {} };
    },
    async fill() {},
    async press() {},
    async waitForSelector() {},
    locator() {
      return {
        async textContent() { return 'Dashboard'; },
        async waitFor() {},
        async evaluate<T>() { return '<body>Dashboard</body>' as T; },
      };
    },
    url() { return 'http://127.0.0.1:4173/dashboard'; },
    async screenshot(options: { path: string }) {
      await writeFile(options.path, 'png', 'utf8');
    },
  };
  await writeFile(browserPath, '', 'utf8');
  const adapter = (await import('../src/runner/browser-visual-proof-command.js')).createDefaultBrowserProofAdapterForTest({
    playwright: {
      chromium: {
        async launchPersistentContext(_profileDir, options) {
          launchOptions = options;
          return {
            async newPage() { return page; },
            async close() {},
          };
        },
      },
    },
    installedBrowserPaths: [browserPath],
    installChromium: async () => {
      installCalls += 1;
    },
  });
  const scenarioPath = join(proofDir, 'browser-proof-scenario.json');
  await mkdir(proofDir, { recursive: true });
  await writeFile(scenarioPath, JSON.stringify({
    ...validScenario(884),
    steps: [
      { action: 'navigate', path: '/' },
      { action: 'waitForText', text: 'Dashboard' },
      { action: 'screenshot', checkpointId: 'final-screen', path: nestedPath, viewportName: 'wide-desktop', criteriaRefs: ['ac-web'] },
      { action: 'domSnapshot', checkpointId: 'final-dom', path: `${artifactDir}/issue-884/dom/wide.json`, viewportName: 'wide-desktop', criteriaRefs: ['ac-web'] },
    ],
  }), 'utf8');

  const result = await runBrowserVisualProofCommand({
    issueNumber: 884,
    worktreePath,
    artifactDir,
    scenarioPath,
    adapter,
    env: {},
  });

  assert.equal(result.status, 'passed');
  assert.equal(launchOptions?.executablePath, browserPath);
  assert.equal(installCalls, 0);
  assert.equal(await readFile(join(worktreePath, nestedPath), 'utf8'), 'png');
  const summary = JSON.parse(await readFile(join(proofDir, 'browser-summary.json'), 'utf8'));
  assert.equal(summary.browserRuntime.executablePath, browserPath);
  assert.equal(summary.browserRuntime.chromiumInstallAttempted, false);
  const report = await readFile(join(proofDir, 'acceptance-proof-report.json'), 'utf8');
  assert.match(report, /screens\/wide\.png/);
});

test('default browser adapter installs Chromium only after missing browser launch failure', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));
  const proofDir = join(worktreePath, artifactDir, 'issue-884');
  const scenarioPath = join(proofDir, 'browser-proof-scenario.json');
  await mkdir(proofDir, { recursive: true });
  await writeFile(scenarioPath, JSON.stringify(validScenario(884)), 'utf8');
  let launches = 0;
  let installCalls = 0;
  const adapter = (await import('../src/runner/browser-visual-proof-command.js')).createDefaultBrowserProofAdapterForTest({
    playwright: {
      chromium: {
        async launchPersistentContext() {
          launches += 1;
          if (launches === 1) {
            throw new Error('Executable doesn\'t exist at /tmp/ms-playwright/chromium_headless_shell/chrome-headless-shell\nPlease run the following command to download new browsers: npx playwright install');
          }
          return {
            async newPage() { return fakePage(proofDir); },
            async close() {},
          };
        },
      },
    },
    installedBrowserPaths: [],
    installChromium: async () => {
      installCalls += 1;
    },
  });

  const result = await runBrowserVisualProofCommand({
    issueNumber: 884,
    worktreePath,
    artifactDir,
    scenarioPath,
    adapter,
    env: {},
  });

  assert.equal(result.status, 'passed');
  assert.equal(launches, 2);
  assert.equal(installCalls, 1);
  const summary = JSON.parse(await readFile(join(proofDir, 'browser-summary.json'), 'utf8'));
  assert.equal(summary.browserRuntime.executablePath, null);
  assert.equal(summary.browserRuntime.chromiumInstallAttempted, true);
});

function failingAdapter(): BrowserProofAdapter {
  return {
    async run() {
      throw new Error('adapter should not run');
    },
  };
}

function passingAdapter(worktreePath: string, issue: number): BrowserProofAdapter {
  return {
    async run() {
      const proofDir = join(worktreePath, artifactDir, `issue-${issue}`);
      await writeFile(join(proofDir, 'wide.png'), 'png', 'utf8');
      await writeFile(join(proofDir, 'wide.dom.json'), '{}', 'utf8');
      await writeFile(join(proofDir, 'console.log'), '', 'utf8');
      await writeFile(join(proofDir, 'network.log'), '', 'utf8');
      await writeFile(join(proofDir, 'browser-summary.json'), '{}', 'utf8');
      return {
        checkpoints: [{
          checkpointId: 'final-screen',
          kind: 'screenshot',
          path: `${artifactDir}/issue-${issue}/wide.png`,
          viewportName: 'wide-desktop',
          criteriaRefs: ['ac-web'],
          description: 'Final browser screenshot',
        }, {
          checkpointId: 'final-dom',
          kind: 'domSnapshot',
          path: `${artifactDir}/issue-${issue}/wide.dom.json`,
          viewportName: 'wide-desktop',
          criteriaRefs: ['ac-web'],
          description: 'Final DOM snapshot',
        }],
        diagnostics: {
          consoleLogPath: `${artifactDir}/issue-${issue}/console.log`,
          networkLogPath: `${artifactDir}/issue-${issue}/network.log`,
          runSummaryPath: `${artifactDir}/issue-${issue}/browser-summary.json`,
        },
        consoleErrors: [],
        networkFailures: [],
      };
    },
  };
}

function fakePage(proofDir: string) {
  return {
    on() {},
    async setViewportSize() {},
    async goto() {},
    async click() {},
    getByText() {
      return { async click() {}, async waitFor() {} };
    },
    async fill() {},
    async press() {},
    async waitForSelector() {},
    locator() {
      return {
        async textContent() { return 'Dashboard'; },
        async waitFor() {},
        async evaluate<T>() { return '<body>Dashboard</body>' as T; },
      };
    },
    url() { return 'http://127.0.0.1:4173/dashboard'; },
    async screenshot(options: { path: string }) {
      await writeFile(options.path, 'png', 'utf8');
      assert.equal(options.path.startsWith(proofDir), true);
    },
  };
}

function validScenario(issue: number) {
  return {
    version: 1,
    baseUrl: 'http://127.0.0.1:4173',
    viewports: [{ name: 'wide-desktop', width: 1440, height: 900, requiredBy: 'desktop-web-layout' }],
    criteria: [{ id: 'ac-web', description: 'Dashboard appears.' }],
    sourceInputs: {
      acceptanceCriteriaRefs: [`issue-${issue}-ac-web`],
      implementationEvidenceRefs: ['browser proof command'],
    },
    auth: { mode: 'not-required' },
    steps: [
      { action: 'navigate', path: '/' },
      { action: 'waitForText', text: 'Dashboard' },
      {
        action: 'screenshot',
        checkpointId: 'final-screen',
        path: `${artifactDir}/issue-${issue}/wide.png`,
        viewportName: 'wide-desktop',
        criteriaRefs: ['ac-web'],
      },
      {
        action: 'domSnapshot',
        checkpointId: 'final-dom',
        path: `${artifactDir}/issue-${issue}/wide.dom.json`,
        viewportName: 'wide-desktop',
        criteriaRefs: ['ac-web'],
      },
    ],
  };
}
