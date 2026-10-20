#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultGhExecutor, ghExecutorFromProcessExecutor } from './adapters/gh-cli.js';
import { defaultProcessExecutor } from './adapters/command.js';
import { GhCliIssueAdapter } from './adapters/gh-issue-adapter.js';
import { GhCliPullRequestAdapter } from './adapters/gh-pull-request-adapter.js';
import { parseAgentAutoConfig, type AgentAutoConfig } from './config.js';
import { renderRunResultJson, runIssueExitCode } from './cli-contract.js';
import { createV2Runtime, hasGitHubReauthorization } from './runtime.js';
import { materializeWorkflowGeneration, workflowSkillHashes } from './workflow-assets.js';
import { parseSetupArgs, renderSetupResultJson, setupOutcomeExitCode } from './setup-cli.js';
import { createProductionSetup } from './setup-runtime.js';
import type { SetupIntent, SetupOutcome } from './setup.js';
import { FileRunRecordWriter, type RunRecord } from './run-store.js';
import type { RunIssueResult } from './run-issue.js';
import type { GitHubIssue } from './adapters/issues.js';

export interface RunIntent { targetRoot: string; issueNumber: number }
export interface DaemonIntent { targetRoot: string; once: boolean; issueNumber?: number }

export function parseRunArgs(argv: string[]): RunIntent {
  if (argv.length !== 5 || argv[0] !== 'run' || argv[1] !== '--target' || argv[3] !== '--issue') {
    throw new Error('usage: cli run --target <absolute-path> --issue <positive-integer>');
  }
  const targetRoot = argv[2]!;
  const issueNumber = Number(argv[4]);
  if (!isAbsolute(targetRoot) || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error('CLI run intent is invalid');
  return { targetRoot: resolve(targetRoot), issueNumber };
}

export function parseDaemonArgs(argv: string[]): DaemonIntent {
  const targetedOnce = argv.length === 6 && argv[3] === '--once' && argv[4] === '--issue';
  if ((argv.length !== 3 && argv.length !== 4 && !targetedOnce)
    || argv[0] !== 'daemon'
    || argv[1] !== '--target'
    || (argv.length === 4 && argv[3] !== '--once')) {
    throw new Error('usage: cli daemon --target <absolute-path> [--once [--issue <positive-integer>]]');
  }
  const targetRoot = argv[2]!;
  const issueNumber = targetedOnce ? Number(argv[5]) : undefined;
  if (!isAbsolute(targetRoot) || (targetedOnce && (!Number.isSafeInteger(issueNumber) || issueNumber! <= 0))) {
    throw new Error('CLI daemon target is invalid');
  }
  return { targetRoot: resolve(targetRoot), once: argv[3] === '--once', ...(issueNumber ? { issueNumber } : {}) };
}

export async function runCli(argv: string[], dependencies: {
  executeRun?: (input: RunIntent) => Promise<RunIssueResult>;
  executeDaemon?: (input: DaemonIntent, write: (text: string) => void) => Promise<number>;
  executeSetup?: (input: SetupIntent) => Promise<SetupOutcome>;
  packageVersion?: string;
  write?: (text: string) => void;
} = {}): Promise<number> {
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  if (argv.length === 1 && argv[0] === '--help') {
    write(cliHelp());
    return 0;
  }
  if (argv.length === 1 && argv[0] === '--version') {
    write(`${dependencies.packageVersion ?? await readPackageVersion()}\n`);
    return 0;
  }
  if (argv[0] === 'setup' || argv[0] === 'doctor' || argv[0] === 'status') {
    const intent = parseSetupArgs(argv);
    const outcome = await (dependencies.executeSetup ?? executeProductionSetup)(intent);
    write(renderSetupResultJson(outcome));
    return setupOutcomeExitCode(outcome);
  }
  if (argv[0] === 'daemon') {
    const intent = parseDaemonArgs(argv);
    return (dependencies.executeDaemon ?? executeProductionDaemon)(intent, write);
  }
  const intent = parseRunArgs(argv);
  const result = await (dependencies.executeRun ?? executeProductionRun)(intent);
  write(renderRunResultJson(result));
  return runIssueExitCode(result);
}

async function executeProductionDaemon(
  intent: DaemonIntent,
  write: (text: string) => void,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try { return await executeDaemonLoop(intent, write, {
    signal: controller.signal,
    discover: async () => [],
    executeRun: executeProductionRun,
    readTick: () => discoverConfiguredDaemonTick(intent.targetRoot, {
      readConfigBytes: () => readConfigBytes(intent.targetRoot),
      discover: (config) => new GhCliIssueAdapter(config.github.owner, config.github.repo, defaultGhExecutor, undefined, { signal: controller.signal }).listOpenIssuesWithAnyLabel([config.github.labels.auto.name, config.github.labels.review.name]),
      inventory: async (config) => (await FileRunRecordWriter.forRepository(join(intent.targetRoot, config.runner.stateDir, 'v2', 'run-state.json'), `${config.github.owner.toLowerCase()}/${config.github.repo.toLowerCase()}`).inventory()).runs,
      isReauthorized: (record, issue, config) => hasGitHubReauthorization({ targetRoot: intent.targetRoot, config, record, issue: { ...issue, labels: issue.labels.map(label => label.name) }, issues: new GhCliIssueAdapter(config.github.owner, config.github.repo, defaultGhExecutor, undefined, { signal: controller.signal }) }),
      executeRun: (runIntent, snapshot) => executeProductionRun(runIntent, snapshot, controller),
    }),
    delay: (milliseconds) => new Promise((resolveDelay) => {
      if (controller.signal.aborted) { resolveDelay(undefined); return; }
      const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolveDelay(undefined); };
      const timer = setTimeout(finish, milliseconds);
      controller.signal.addEventListener('abort', finish, { once: true });
    }),
    pollIntervalMilliseconds: 30_000,
  }); } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
}

export async function discoverConfiguredDaemonTick(targetRoot: string, dependencies: {
  readConfigBytes(): Promise<Buffer>;
  discover(config: AgentAutoConfig): Promise<GitHubIssue[]>;
  inventory(config: AgentAutoConfig): Promise<RunRecord[]>;
  isReauthorized?(run: RunRecord, issue: GitHubIssue, config: AgentAutoConfig): Promise<boolean>;
  executeRun(intent: RunIntent, snapshot: { bytes: Buffer; config: AgentAutoConfig }): Promise<RunIssueResult>;
}): Promise<DaemonTickSnapshot> {
  const bytes = await dependencies.readConfigBytes();
  let config: AgentAutoConfig;
  try { config = parseTargetConfigForExecution(JSON.parse(bytes.toString('utf8')), targetRoot); }
  catch (error) { throw new InvalidDaemonConfigError(error instanceof Error ? error.message : String(error)); }
  const discovered = await dependencies.discover(config);
  const runs = await dependencies.inventory(config);
  const latest = new Map<number, RunRecord>();
  for (const run of runs) {
    const previous = latest.get(run.issueNumber);
    if (!previous || previous.createdAt <= run.createdAt) latest.set(run.issueNumber, run);
  }
  const needed = new Set<number>();
  for (const run of latest.values()) {
    if (runNeedsDaemonTick(run)) needed.add(run.issueNumber);
  }
  const finalStopped = new Set([...latest.values()].filter((run) => !needed.has(run.issueNumber) && run.terminalOutcome?.status !== 'review-ready').map((run) => run.issueNumber));
  const candidates: GitHubIssue[] = [];
  for (const issue of discovered) {
    if (!finalStopped.has(issue.number)) { candidates.push(issue); continue; }
    try {
      if (await dependencies.isReauthorized?.(latest.get(issue.number)!, issue, config)) candidates.push(issue);
    } catch { /* A failed timeline read leaves this issue stopped; other issues remain runnable. */ }
  }
  for (const run of latest.values()) {
    if (needed.has(run.issueNumber)) candidates.push({ ...run.issueSnapshot, labels: run.issueSnapshot.labels.map((name) => ({ name })), comments: [], closedByPullRequestsReferences: [] });
  }
  return {
    candidates,
    pollIntervalMilliseconds: config.runner.pollIntervalSeconds * 1_000,
    executeRun: async (intent) => {
      if (intent.targetRoot !== targetRoot || !(await dependencies.readConfigBytes()).equals(bytes)) throw new Error('config-snapshot-changed');
      return dependencies.executeRun(intent, { bytes, config });
    },
  };
}

class InvalidDaemonConfigError extends Error {}

export function runNeedsDaemonTick(run: RunRecord): boolean {
  return !run.terminalOutcome || Boolean(run.activeAttempt || run.pendingEffect || run.candidateMaterialization)
    || (run.terminalOutcome.status === 'transport-failed' && run.terminalOutcome.resumable)
    || Boolean(run.terminalNotifications && [run.terminalNotifications.comment, run.terminalNotifications.labels].some((delivery) =>
      delivery.status === 'pending' || (delivery.status === 'exhausted' && !delivery.diagnostic?.endsWith('-diverged'))));
}

export interface DaemonTickSnapshot {
  candidates: GitHubIssue[];
  executeRun(input: RunIntent): Promise<RunIssueResult>;
  pollIntervalMilliseconds: number;
}

export async function executeDaemonLoop(
  intent: DaemonIntent,
  write: (text: string) => void,
  dependencies: {
    signal?: AbortSignal;
    readTick?(): Promise<DaemonTickSnapshot>;
    discover(): Promise<GitHubIssue[]>;
    executeRun(input: RunIntent): Promise<RunIssueResult>;
    delay(milliseconds: number): Promise<void>;
    pollIntervalMilliseconds: number;
  },
): Promise<number> {
  let exitCode = 0;
  const lastResults = new Map<number, string>();
  let pollInterval = dependencies.pollIntervalMilliseconds;
  do {
    if (dependencies.signal?.aborted) return Math.max(exitCode, 130);
    let tick: DaemonTickSnapshot | undefined;
    let discovered: GitHubIssue[] | undefined;
    try {
      if (dependencies.readTick) {
        tick = await dependencies.readTick();
        pollInterval = tick.pollIntervalMilliseconds;
        discovered = tick.candidates;
      } else discovered = await dependencies.discover();
    } catch (error) {
      if (error instanceof InvalidDaemonConfigError) throw error;
      exitCode = Math.max(exitCode, 70);
      try { write(`daemon discovery failed: ${error instanceof Error ? error.message : String(error)}\n`); }
      catch { /* output failure cannot terminate the daemon */ }
    }
    if (discovered) {
      const candidates = intent.issueNumber === undefined
        ? discovered
        : discovered.filter((issue) => issue.number === intent.issueNumber);
      exitCode = Math.max(exitCode, await executeDaemonCandidates({
        targetRoot: intent.targetRoot,
        candidates,
        executeRun: tick?.executeRun ?? dependencies.executeRun,
        signal: dependencies.signal,
        write,
        lastResults,
      }));
    }
    if (dependencies.signal?.aborted) return Math.max(exitCode, 130);
    if (intent.once) return exitCode;
    await dependencies.delay(pollInterval);
  } while (true);
}

export async function executeDaemonTick(input: {
  targetRoot: string;
  issueNumber?: number;
  discoverCandidates(): Promise<GitHubIssue[]>;
  executeRun(input: RunIntent): Promise<RunIssueResult>;
  write(text: string): void;
  lastResults: Map<number, string>;
}): Promise<number> {
  const discovered = await input.discoverCandidates();
  const candidates = input.issueNumber === undefined
    ? discovered
    : discovered.filter((issue) => issue.number === input.issueNumber);
  return executeDaemonCandidates({
    targetRoot: input.targetRoot,
    candidates,
    executeRun: input.executeRun,
    write: input.write,
    lastResults: input.lastResults,
  });
}

export async function executeDaemonCandidates(input: {
  signal?: AbortSignal;
  targetRoot: string;
  candidates: GitHubIssue[];
  executeRun(input: RunIntent): Promise<RunIssueResult>;
  write(text: string): void;
  lastResults: Map<number, string>;
}): Promise<number> {
  let exitCode = 0;
  const candidates = [...new Map(input.candidates.map((issue) => [issue.number, issue])).values()]
    .sort((left, right) => left.number - right.number);
  for (const issue of candidates) {
    if (input.signal?.aborted) return Math.max(exitCode, 130);
    let result: RunIssueResult;
    try {
      result = await input.executeRun({ targetRoot: input.targetRoot, issueNumber: issue.number });
    } catch (error) {
      exitCode = Math.max(exitCode, 70);
      try { input.write(`daemon issue ${issue.number} failed: ${error instanceof Error ? error.message : String(error)}\n`); }
      catch { /* output failure cannot stop later frozen candidates */ }
      continue;
    }
    exitCode = Math.max(exitCode, runIssueExitCode(result));
    try {
      const rendered = renderRunResultJson(result);
      const previous = input.lastResults.get(issue.number);
      if (previous !== rendered) input.write(rendered);
      input.lastResults.set(issue.number, rendered);
    } catch {
      exitCode = Math.max(exitCode, 70);
    }
  }
  return exitCode;
}

async function executeProductionRun(intent: RunIntent, snapshot?: { bytes: Buffer; config: AgentAutoConfig }, abortController = new AbortController()): Promise<RunIssueResult> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const packageVersion = await readPackageVersion();
  const config = snapshot?.config ?? await readTargetConfig(intent.targetRoot);
  if (snapshot && !(await readConfigBytes(intent.targetRoot)).equals(snapshot.bytes)) throw new Error('config-snapshot-changed');
  const orchestratorHome = resolve(process.env.CODEX_ORCHESTRATOR_HOME ?? join(homedir(), '.codex-orchestrator'));
  const bootId = await readBootId();
  const runtime = createV2Runtime({
    targetRoot: intent.targetRoot,
    abortController,
    ...(snapshot ? { expectedConfigBytes: snapshot.bytes } : {}),
    orchestratorHome,
    bootId,
    packageVersion,
    createWorkflowGeneration: async () => {
      const receipt = await materializeWorkflowGeneration({ packageRoot, runtimeRoot: orchestratorHome, packageVersion, bootId });
      return { receipt, skillHashes: await workflowSkillHashes(receipt) };
    },
    createGitHubAdapters: (signal, executor) => {
      const ghExecutor = ghExecutorFromProcessExecutor(executor);
      return { issues: new GhCliIssueAdapter(config.github.owner, config.github.repo, ghExecutor, undefined, { signal }),
        pullRequests: new GhCliPullRequestAdapter(config.github.owner, config.github.repo, ghExecutor, { signal }) };
    },
    parentCodexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')),
    safePath: process.env.CODEX_ORCHESTRATOR_SAFE_PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
  });
  try { return await runtime.runIssue(intent); }
  finally { runtime.dispose(); }
}

async function readConfigBytes(targetRoot: string): Promise<Buffer> {
  return readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), { signal: AbortSignal.timeout(5_000) });
}

async function readTargetConfig(targetRoot: string) {
  return parseTargetConfigForExecution(JSON.parse((await readConfigBytes(targetRoot)).toString('utf8')), targetRoot);
}

export function parseTargetConfigForExecution(value: unknown, targetRoot: string): AgentAutoConfig {
  void targetRoot;
  return parseAgentAutoConfig(value);
}

async function executeProductionSetup(intent: SetupIntent): Promise<SetupOutcome> {
  const setup = createProductionSetup({
    orchestratorHome: resolve(process.env.CODEX_ORCHESTRATOR_HOME ?? join(homedir(), '.codex-orchestrator')),
    bootId: await readBootId(),
  });
  return setup.execute(intent);
}

async function readPackageVersion(): Promise<string> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string') throw new Error('package version is unavailable');
  return packageJson.version;
}

function cliHelp(): string {
  return [
    'codex-orchestrator',
    '  setup --target <absolute-path> [--github-owner <owner> --github-repo <repo>] [--prepare-labels] [--flutter-sdk <absolute-sdk-root>] [--dry-run]',
    '  doctor --target <absolute-path>',
    '  status --target <absolute-path>',
    '  run --target <absolute-path> --issue <positive-integer>',
    '  daemon --target <absolute-path> [--once [--issue <positive-integer>]]',
    '',
  ].join('\n');
}

async function readBootId(): Promise<string> {
  if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (process.platform === 'darwin') {
    const result = await defaultProcessExecutor('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeoutMs: 5_000, processGroup: true, maxOutputBytes: 16_384 });
    if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error('boot identity is unavailable');
    return result.stdout.trim();
  }
  throw new Error(`platform ${process.platform} cannot prove boot identity`);
}

export function isDirectCliExecution(entryPath: string, modulePath: string): boolean {
  try { return realpathSync.native(entryPath) === realpathSync.native(modulePath); }
  catch { return false; }
}

if (process.argv[1] && isDirectCliExecution(process.argv[1], fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 70;
  });
}
