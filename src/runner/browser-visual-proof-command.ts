import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  assembleBlockedBrowserProofReport,
  assembleBrowserAcceptanceProofReport,
  assertBrowserProofArtifactPath,
  browserProofArtifactPath,
  browserProofRuntimeEnv,
  validateBrowserProofScenario,
  type BrowserProofCheckpointEvidence,
  type BrowserProofDiagnostics,
  type BrowserProofScenario,
} from './browser-proof-contract.js';
import type { AcceptanceProofReport, AcceptanceProofStatus } from './acceptance-proof.js';

const require = createRequire(import.meta.url);

export interface BrowserVisualProofCommandInput {
  issueNumber: number;
  worktreePath?: string;
  artifactDir?: string;
  scenarioPath?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  envPassthrough?: string[];
  strictConsoleErrors?: boolean;
  strictNetworkFailures?: boolean;
  adapter?: BrowserProofAdapter;
}

export interface BrowserProofRunResult {
  checkpoints: BrowserProofCheckpointEvidence[];
  diagnostics: BrowserProofDiagnostics;
  consoleErrors: string[];
  networkFailures: string[];
  browserRuntime?: {
    executablePath?: string;
    chromiumInstallAttempted: boolean;
  };
}

export interface BrowserProofAdapter {
  run(input: {
    scenario: BrowserProofScenario;
    worktreePath: string;
    proofDir: string;
    artifactDir: string;
    issueNumber: number;
    env: NodeJS.ProcessEnv;
  }): Promise<BrowserProofRunResult>;
}

export function parseBrowserVisualProofArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: BrowserVisualProofCommandInput } | { ok: false; error: string } {
  const parsed: BrowserVisualProofCommandInput = {
    issueNumber: Number(env.CODEX_ORCHESTRATOR_ISSUE_NUMBER),
    worktreePath: env.CODEX_ORCHESTRATOR_WORKTREE_PATH ?? process.cwd(),
    artifactDir: env.CODEX_ORCHESTRATOR_ARTIFACT_DIR,
    scenarioPath: env.CODEX_ORCHESTRATOR_BROWSER_PROOF_SCENARIO_PATH,
    baseUrl: env.CODEX_ORCHESTRATOR_BROWSER_BASE_URL,
    envPassthrough: envListFromEnv(env.CODEX_ORCHESTRATOR_BROWSER_ENV_PASSTHROUGH),
    strictConsoleErrors: booleanFromEnv(env.CODEX_ORCHESTRATOR_BROWSER_STRICT_CONSOLE),
    strictNetworkFailures: booleanFromEnv(env.CODEX_ORCHESTRATOR_BROWSER_STRICT_NETWORK),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = (): string | undefined => {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) return undefined;
      index += 1;
      return value;
    };

    switch (arg) {
      case '--issue': {
        const value = next();
        if (!value || !Number.isInteger(Number(value)) || Number(value) < 1) {
          return { ok: false, error: 'visual-proof browser requires --issue <number>' };
        }
        parsed.issueNumber = Number(value);
        break;
      }
      case '--target':
      case '--worktree': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.worktreePath = value;
        break;
      }
      case '--artifact-dir': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.artifactDir = value;
        break;
      }
      case '--scenario': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.scenarioPath = value;
        break;
      }
      case '--base-url': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.baseUrl = value;
        break;
      }
      case '--strict-console':
        parsed.strictConsoleErrors = true;
        break;
      case '--strict-network':
        parsed.strictNetworkFailures = true;
        break;
      default:
        return { ok: false, error: `Unknown visual-proof browser option: ${arg ?? ''}` };
    }
  }

  if (!Number.isInteger(parsed.issueNumber) || parsed.issueNumber < 1) {
    return { ok: false, error: 'visual-proof browser requires --issue <number>' };
  }

  return { ok: true, value: parsed };
}

export async function runBrowserVisualProofCommand(
  input: BrowserVisualProofCommandInput,
): Promise<{ status: AcceptanceProofStatus; reportPath: string }> {
  const env = input.env ?? process.env;
  const issueNumber = input.issueNumber;
  const worktreePath = resolve(input.worktreePath ?? env.CODEX_ORCHESTRATOR_WORKTREE_PATH ?? process.cwd());
  const artifactDir = input.artifactDir ?? env.CODEX_ORCHESTRATOR_ARTIFACT_DIR ?? '.codex-orchestrator/proofs';
  const proofDir = resolve(worktreePath, artifactDir, `issue-${issueNumber}`);
  const reportPath = env[browserProofRuntimeEnv.reportPath] ?? join(proofDir, 'acceptance-proof-report.json');
  const scenarioPath = input.scenarioPath
    ? resolve(worktreePath, input.scenarioPath)
    : join(proofDir, 'browser-proof-scenario.json');
  const envPassthrough = input.envPassthrough ?? envListFromEnv(env.CODEX_ORCHESTRATOR_BROWSER_ENV_PASSTHROUGH) ?? [];
  await mkdir(proofDir, { recursive: true });

  const scenarioGuard = validateScenarioPath(scenarioPath, proofDir);
  if (!scenarioGuard.ok) {
    const report = assembleBlockedBrowserProofReport({
      issueNumber,
      artifactDir,
      issue: {
        kind: 'invalidScenario',
        diagnostic: scenarioGuard.error,
        requiredChanges: [scenarioGuard.error],
      },
    });
    await writeReportWithDiagnostics(worktreePath, reportPath, report, { kind: 'invalidScenario', diagnostic: scenarioGuard.error });
    return { status: 'blocked', reportPath };
  }

  const loaded = await loadScenario(scenarioPath, input.baseUrl);
  if (!loaded.ok) {
    const report = assembleBlockedBrowserProofReport({
      issueNumber,
      artifactDir,
      issue: {
        kind: 'invalidScenario',
        diagnostic: loaded.error,
        requiredChanges: [loaded.error],
      },
    });
    await writeReportWithDiagnostics(worktreePath, reportPath, report, { kind: 'invalidScenario', diagnostic: loaded.error });
    return { status: 'blocked', reportPath };
  }

  const validated = validateBrowserProofScenario(loaded.scenario, {
    artifactDir,
    issueNumber,
    envPassthrough,
  });
  if (!validated.ok) {
    const diagnostic = validated.errors.join('; ');
    const report = assembleBlockedBrowserProofReport({
      issueNumber,
      artifactDir,
      issue: {
        kind: 'invalidScenario',
        diagnostic,
        requiredChanges: validated.errors,
      },
    });
    await writeReportWithDiagnostics(worktreePath, reportPath, report, { kind: 'invalidScenario', diagnostic });
    return { status: 'blocked', reportPath };
  }

  try {
    const runtimeDirs = await ensureBrowserRuntimeDirs(env);
    if (!runtimeDirs.ok) {
      const report = assembleBlockedBrowserProofReport({
        issueNumber,
        artifactDir,
        scenario: validated.scenario,
        issue: {
          kind: runtimeDirs.kind,
          diagnostic: runtimeDirs.error,
          requiredChanges: [runtimeDirs.error],
        },
      });
      await writeReportWithDiagnostics(worktreePath, reportPath, report, { kind: runtimeDirs.kind, diagnostic: runtimeDirs.error });
      return { status: 'blocked', reportPath };
    }
    const adapter = input.adapter ?? defaultBrowserProofAdapter();
    const run = await adapter.run({ scenario: validated.scenario, worktreePath, proofDir, artifactDir, issueNumber, env });
    const strictBlockers = [
      ...(input.strictConsoleErrors && run.consoleErrors.length > 0 ? [`Console errors: ${run.consoleErrors.join('; ')}`] : []),
      ...(input.strictNetworkFailures && run.networkFailures.length > 0 ? [`Network failures: ${run.networkFailures.join('; ')}`] : []),
    ];
    if (strictBlockers.length > 0) {
      const strictKind = run.consoleErrors.length > 0 ? 'consoleErrors' : 'networkFailures';
      const report = assembleBlockedBrowserProofReport({
        issueNumber,
        artifactDir,
        scenario: validated.scenario,
        issue: {
          kind: strictKind,
          diagnostic: strictBlockers.join('; '),
          requiredChanges: strictBlockers,
        },
        diagnostics: run.diagnostics,
      });
      await writeReportWithDiagnostics(worktreePath, reportPath, report, { kind: strictKind, diagnostic: strictBlockers.join('; ') });
      return { status: 'blocked', reportPath };
    }

    const report = assembleBrowserAcceptanceProofReport({
      issueNumber,
      artifactDir,
      scenario: validated.scenario,
      checkpoints: run.checkpoints,
      diagnostics: run.diagnostics,
      workflow: workflowFromScenario(validated.scenario),
      layoutFindings: ['Browser proof reviewed layout-relevant viewport artifacts.'],
      copyFindings: ['Browser proof reviewed visible text through DOM and screenshot artifacts.'],
    });
    await writeJson(reportPath, report);
    return { status: 'passed', reportPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'browser proof failed';
    const assertion = error instanceof Error && 'code' in error && error.code === 'ASSERTION_FAILED';
    if (assertion) {
      const report = needsReworkReport(issueNumber, artifactDir, validated.scenario, message);
      await writeJson(reportPath, report);
      return { status: 'needs-rework', reportPath };
    }
    const report = assembleBlockedBrowserProofReport({
      issueNumber,
      artifactDir,
      scenario: validated.scenario,
      issue: {
        kind: /playwright/iu.test(message) ? 'playwrightPackage' : 'browserBinary',
        diagnostic: message,
        requiredChanges: [message],
      },
    });
    await writeReportWithDiagnostics(worktreePath, reportPath, report, { kind: 'browserBinary', diagnostic: message });
    return { status: 'blocked', reportPath };
  }
}

type PlaywrightLikeModule = {
  chromium?: {
    launchPersistentContext: (profileDir: string, options: { headless: boolean; executablePath?: string }) => Promise<{
      newPage: () => Promise<PlaywrightLikePage>;
      close: () => Promise<void>;
    }>;
  };
};

interface BrowserProofAdapterRuntime {
  playwright: PlaywrightLikeModule;
  installedBrowserPaths: string[];
  installChromium: (env: NodeJS.ProcessEnv) => Promise<void>;
}

export function createDefaultBrowserProofAdapterForTest(
  runtime: PlaywrightLikeModule | Partial<BrowserProofAdapterRuntime>,
): BrowserProofAdapter {
  if ('chromium' in runtime) {
    return defaultBrowserProofAdapter({ playwright: runtime });
  }
  return defaultBrowserProofAdapter(runtime as Partial<BrowserProofAdapterRuntime>);
}

function defaultBrowserProofAdapter(runtime: Partial<BrowserProofAdapterRuntime> = {}): BrowserProofAdapter {
  return {
    async run(input) {
      const moduleName = 'playwright-core';
      const playwright = runtime.playwright ?? (await import(moduleName) as PlaywrightLikeModule);
      if (!playwright.chromium) {
        throw new Error('Playwright chromium runtime is unavailable.');
      }
      const profileDir = input.env[browserProofRuntimeEnv.playwrightProfileDir] ?? join(input.proofDir, 'playwright-profile');
      const executablePath = input.env[browserProofRuntimeEnv.browserExecutablePath]
        ?? firstExistingPath(runtime.installedBrowserPaths ?? installedBrowserExecutableCandidates(input.env));
      let chromiumInstallAttempted = false;
      const context = await launchBrowserContext({
        chromium: playwright.chromium,
        profileDir,
        executablePath,
        env: input.env,
        installChromium: async (installEnv) => {
          chromiumInstallAttempted = true;
          await (runtime.installChromium ?? installPlaywrightChromium)(installEnv);
        },
      });
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const networkFailures: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('requestfailed', (request) => {
        networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`.trim());
      });
      const checkpoints: BrowserProofCheckpointEvidence[] = [];
      try {
        for (const viewport of input.scenario.viewports) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          for (const step of input.scenario.steps) {
            await runBrowserStep(page, input.scenario.baseUrl, step, input, checkpoints);
          }
        }
      } finally {
        await context.close();
      }
      const browserRuntime = { executablePath, chromiumInstallAttempted };
      const diagnostics = await writeBrowserDiagnostics(input, consoleErrors, networkFailures, browserRuntime);
      return { checkpoints, diagnostics, consoleErrors, networkFailures, browserRuntime };
    },
  };
}

async function launchBrowserContext(input: {
  chromium: NonNullable<PlaywrightLikeModule['chromium']>;
  profileDir: string;
  executablePath: string | undefined;
  env: NodeJS.ProcessEnv;
  installChromium: (env: NodeJS.ProcessEnv) => Promise<void>;
}): Promise<{
  newPage: () => Promise<PlaywrightLikePage>;
  close: () => Promise<void>;
}> {
  try {
    return await input.chromium.launchPersistentContext(input.profileDir, {
      headless: true,
      ...(input.executablePath ? { executablePath: input.executablePath } : {}),
    });
  } catch (error) {
    if (input.executablePath || !isMissingPlaywrightBrowser(error)) {
      throw error;
    }
    await input.installChromium(input.env);
    return input.chromium.launchPersistentContext(input.profileDir, { headless: true });
  }
}

function installedBrowserExecutableCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    ...macBrowserExecutableCandidates(),
    ...linuxBrowserExecutableCandidates(env),
    ...windowsBrowserExecutableCandidates(env),
  ];
}

function macBrowserExecutableCandidates(): string[] {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    join(homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
  ];
}

function linuxBrowserExecutableCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    findExecutableOnPath('google-chrome-stable', env),
    findExecutableOnPath('google-chrome', env),
    findExecutableOnPath('chromium', env),
    findExecutableOnPath('chromium-browser', env),
    findExecutableOnPath('microsoft-edge', env),
    findExecutableOnPath('microsoft-edge-stable', env),
  ].filter((path): path is string => Boolean(path));
}

function windowsBrowserExecutableCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    env.PROGRAMFILES ? join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    env['PROGRAMFILES(X86)'] ? join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    env.PROGRAMFILES ? join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    env['PROGRAMFILES(X86)'] ? join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
  ].filter((path): path is string => Boolean(path));
}

function findExecutableOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathEntries = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const pathEntry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(pathEntry, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function firstExistingPath(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function isMissingPlaywrightBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist/iu.test(message)
    || /run (?:the following command to )?download new browsers/iu.test(message)
    || /playwright install/iu.test(message);
}

async function installPlaywrightChromium(env: NodeJS.ProcessEnv): Promise<void> {
  const cliPath = require.resolve('playwright-core/cli.js');
  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [cliPath, 'install', 'chromium'],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Playwright Chromium install failed: ${error.message}\n${stderr}\n${stdout}`.trim()));
          return;
        }
        resolvePromise();
      },
    );
  });
}

type PlaywrightLikePage = {
  on: (event: 'console' | 'requestfailed', handler: (value: PlaywrightLikeConsoleMessage & PlaywrightLikeRequest) => void) => void;
  setViewportSize: (size: { width: number; height: number }) => Promise<void>;
  goto: (url: string) => Promise<unknown>;
  click: (selector: string) => Promise<void>;
  getByText: (text: string) => { click: () => Promise<void>; waitFor: () => Promise<void> };
  fill: (selector: string, value: string) => Promise<void>;
  press: (selector: string, key: string) => Promise<void>;
  waitForSelector: (selector: string) => Promise<void>;
  locator: (selector: string) => {
    textContent: () => Promise<string | null>;
    waitFor: () => Promise<void>;
    evaluate: <T>(fn: (element: Element) => T) => Promise<T>;
  };
  url: () => string;
  screenshot: (options: { path: string; fullPage: boolean }) => Promise<unknown>;
};
type PlaywrightLikeConsoleMessage = { type: () => string; text: () => string };
type PlaywrightLikeRequest = { method: () => string; url: () => string; failure: () => { errorText?: string } | null };

async function runBrowserStep(
  page: PlaywrightLikePage,
  baseUrl: string,
  step: BrowserProofScenario['steps'][number],
  input: Parameters<BrowserProofAdapter['run']>[0],
  checkpoints: BrowserProofCheckpointEvidence[],
): Promise<void> {
  switch (step.action) {
    case 'navigate':
      await page.goto(step.url ?? new URL(step.path ?? '/', baseUrl).toString());
      break;
    case 'click':
      if (step.selector) await page.click(step.selector);
      else await page.getByText(step.text ?? '').click();
      break;
    case 'fill':
      await page.fill(step.selector, step.value);
      break;
    case 'press':
      await page.press(step.selector, step.key);
      break;
    case 'waitForSelector':
      await page.waitForSelector(step.selector);
      break;
    case 'waitForText':
      await page.getByText(step.text).waitFor();
      break;
    case 'assertText': {
      const text = step.selector ? await page.locator(step.selector).textContent() : step.text;
      if (!text?.includes(step.text)) throw assertionError(`Expected text ${step.text} was missing`);
      break;
    }
    case 'assertUrl':
      if (!page.url().includes(step.expected)) throw assertionError(`Expected URL ${step.expected} but got ${page.url()}`);
      break;
    case 'screenshot':
      await mkdir(dirname(browserProofArtifactFilePath(input.worktreePath, step.path, input.artifactDir, input.issueNumber)), { recursive: true });
      await page.screenshot({ path: browserProofArtifactFilePath(input.worktreePath, step.path, input.artifactDir, input.issueNumber), fullPage: true });
      checkpoints.push({ ...step, kind: 'screenshot', description: `Browser screenshot ${step.checkpointId}` });
      break;
    case 'domSnapshot': {
      const html = await page.locator('body').evaluate((element) => element.outerHTML);
      await mkdir(dirname(browserProofArtifactFilePath(input.worktreePath, step.path, input.artifactDir, input.issueNumber)), { recursive: true });
      await writeFile(browserProofArtifactFilePath(input.worktreePath, step.path, input.artifactDir, input.issueNumber), html, 'utf8');
      checkpoints.push({ ...step, kind: 'domSnapshot', description: `Browser DOM snapshot ${step.checkpointId}` });
      break;
    }
  }
}

async function writeBrowserDiagnostics(
  input: Parameters<BrowserProofAdapter['run']>[0],
  consoleErrors: string[],
  networkFailures: string[],
  browserRuntime?: BrowserProofRunResult['browserRuntime'],
): Promise<BrowserProofDiagnostics> {
  const consoleLogRef = browserProofArtifactPath(input.artifactDir, input.issueNumber, 'console.log');
  const networkLogRef = browserProofArtifactPath(input.artifactDir, input.issueNumber, 'network.log');
  const runSummaryRef = browserProofArtifactPath(input.artifactDir, input.issueNumber, 'browser-summary.json');
  const consoleLogPath = browserProofArtifactFilePath(input.worktreePath, consoleLogRef, input.artifactDir, input.issueNumber);
  const networkLogPath = browserProofArtifactFilePath(input.worktreePath, networkLogRef, input.artifactDir, input.issueNumber);
  const runSummaryPath = browserProofArtifactFilePath(input.worktreePath, runSummaryRef, input.artifactDir, input.issueNumber);
  await writeFile(consoleLogPath, consoleErrors.join('\n'), 'utf8');
  await writeFile(networkLogPath, networkFailures.join('\n'), 'utf8');
  await writeFile(runSummaryPath, JSON.stringify({
    status: 'completed',
    steps: input.scenario.steps.length,
    browserRuntime: browserRuntime
      ? {
          executablePath: browserRuntime.executablePath ?? null,
          chromiumInstallAttempted: browserRuntime.chromiumInstallAttempted,
        }
      : undefined,
  }, null, 2), 'utf8');
  return {
    consoleLogPath: consoleLogRef,
    networkLogPath: networkLogRef,
    runSummaryPath: runSummaryRef,
  };
}

function needsReworkReport(
  issueNumber: number,
  artifactDir: string,
  scenario: BrowserProofScenario,
  message: string,
): AcceptanceProofReport {
  const diagnosticPath = `${artifactDir}/issue-${issueNumber}/browser-proof-diagnostics.json`;
  return {
    status: 'needs-rework',
    criteria: scenario.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      status: 'failed',
      confidence: 'high',
      reasoningSummary: message,
      artifactRefs: [diagnosticPath],
    })),
    artifacts: [{ type: 'log', path: diagnosticPath, description: 'Browser assertion failure' }],
    proofPhaseDiff: { allowedProofPaths: [diagnosticPath], forbiddenProductPaths: [] },
    reworkRequest: {
      summary: message,
      requiredChanges: [message],
      evidenceRefs: [diagnosticPath],
    },
    residualRisks: [],
  };
}

async function loadScenario(path: string, baseUrl: string | undefined): Promise<
  | { ok: true; scenario: unknown }
  | { ok: false; error: string }
> {
  try {
    const scenario = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    return { ok: true, scenario: baseUrl ? { ...scenario, baseUrl } : scenario };
  } catch (error) {
    const message = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? `Browser proof scenario file was not found: ${path}`
      : `Browser proof scenario is malformed: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, error: message };
  }
}

function validateScenarioPath(path: string, proofDir: string): { ok: true } | { ok: false; error: string } {
  const resolvedPath = resolve(path);
  const resolvedProofDir = resolve(proofDir);
  const relativePath = relative(resolvedProofDir, resolvedPath);
  const name = resolvedPath.split('/').at(-1) ?? '';
  if (name === '.env' || name.startsWith('.env.')) {
    return { ok: false, error: `Browser proof scenario path must not reference a secret file: ${path}` };
  }
  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return { ok: false, error: `Browser proof scenario path must stay under the proof directory: ${path}` };
  }
  return { ok: true };
}

async function ensureBrowserRuntimeDirs(env: NodeJS.ProcessEnv): Promise<
  | { ok: true }
  | { ok: false; kind: 'cacheDir' | 'profileDir'; error: string }
> {
  const dirs = [
    { kind: 'profileDir' as const, path: env[browserProofRuntimeEnv.playwrightProfileDir] },
    { kind: 'cacheDir' as const, path: env[browserProofRuntimeEnv.browserCacheDir] },
  ];
  for (const dir of dirs) {
    if (!dir.path) continue;
    try {
      await mkdir(dir.path, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        kind: dir.kind,
        error: `Browser proof could not prepare ${dir.kind}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true };
}

function browserProofArtifactFilePath(worktreePath: string, artifactPath: string, artifactDir: string, issueNumber: number): string {
  return resolve(worktreePath, assertBrowserProofArtifactPath(artifactPath, artifactDir, issueNumber));
}

function workflowFromScenario(scenario: BrowserProofScenario): Parameters<typeof assembleBrowserAcceptanceProofReport>[0]['workflow'] {
  return {
    entrypoint: scenario.baseUrl,
    path: scenario.steps.map((step) => step.action),
    screenState: 'Browser proof scenario completed with mapped checkpoint evidence.',
  };
}

async function writeReportWithDiagnostics(
  worktreePath: string,
  reportPath: string,
  report: AcceptanceProofReport,
  diagnostic: Record<string, unknown>,
): Promise<void> {
  const diagnosticPath = report.artifacts[0]?.path;
  if (diagnosticPath) {
    await mkdir(dirname(join(worktreePath, diagnosticPath)), { recursive: true });
    await writeFile(join(worktreePath, diagnosticPath), JSON.stringify(diagnostic, null, 2), 'utf8');
  }
  await writeJson(reportPath, report);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertionError(message: string): Error {
  return Object.assign(new Error(message), { code: 'ASSERTION_FAILED' });
}

function booleanFromEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return /^(?:1|true|yes)$/iu.test(value);
}

function envListFromEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(/[,\n]/u).map((entry) => entry.trim()).filter(Boolean);
}
