import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFile,
  readdir,
  readlink,
  realpath,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  verifyBridgeRuntimeManifest,
  type BridgeRuntimeManifestV1,
} from '../bridge-runtime.js';
import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import { readRunnerConfig, rereadRunnerConfigUnderFence } from '../runner/command-utils.js';
import { RunnerStateStore } from '../runner/local-state.js';
import {
  acquireTargetActivityFence,
  readCurrentBootNonce,
} from '../runner/target-activity-fence.js';

const execFileAsync = promisify(execFile);

export interface BridgeProcessIdentity {
  pid: number;
  uid: number;
  startTime: string;
  executable: string;
  argv: string[];
}

export interface PreparedSkillRuntimeGenerationV1 {
  version: 1;
  canonicalTargetRoot: string;
  preparedAt: string;
  hostId: string;
  bootNonce: string;
  bridgePackageVersion: string;
  bridgePackageHash: string;
  activityFenceGeneration: number;
  inspectedProcesses: BridgeProcessIdentity[];
  runnerState: { path: string; sha256: string; nonterminalV1RunIds: [] };
  githubDrain: { queriedAt: string; runningIssueNumbers: [] };
}

export interface PrepareSkillRuntimeV2Input {
  targetRoot: string;
}

interface PrepareSkillRuntimeV2Dependencies {
  packageRoot?: string;
  issueAdapter?: GitHubIssueAdapter;
  inspectProcesses?: () => Promise<BridgeProcessIdentity[]>;
  platform?: NodeJS.Platform;
  now?: Date;
  hostId?: string;
  bootNonce?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface PrepareSkillRuntimeV2Result {
  path: string;
  generation: PreparedSkillRuntimeGenerationV1;
}

export interface BridgeProcessInspectionInput {
  platform?: NodeJS.Platform;
  procRoot?: string;
  readExecutable?: (pid: number) => Promise<string>;
  runCommand?: (command: string, args: string[]) => Promise<string>;
}

export async function prepareSkillRuntimeV2(
  input: PrepareSkillRuntimeV2Input,
  dependencies: PrepareSkillRuntimeV2Dependencies = {},
): Promise<PrepareSkillRuntimeV2Result> {
  const targetRoot = await realpath(resolve(input.targetRoot));
  const packageRoot = resolve(dependencies.packageRoot ?? defaultPackageRoot());
  const config = await readRunnerConfig(targetRoot);
  const bridge = await verifyBridgeRuntimeManifest(packageRoot);
  const hostId = requireText(dependencies.hostId ?? hostname(), 'hostId');
  const platform = dependencies.platform ?? process.platform;
  const bootNonce = requireText(dependencies.bootNonce ?? await readCurrentBootNonce(platform), 'bootNonce');
  const inspect = dependencies.inspectProcesses ?? (() => inspectBridgeProcesses({ platform }));

  const lease = await acquireTargetActivityFence({
    targetRoot,
    stateDir: config.runner.stateDir,
    mode: 'exclusive',
    purpose: 'preparation',
    hostId,
    bootNonce,
    pid: dependencies.pid,
    isProcessAlive: dependencies.isProcessAlive,
    now: dependencies.now,
  });
  try {
    const fencedConfig = await rereadRunnerConfigUnderFence(targetRoot, config.runner.stateDir);
    const issueAdapter = dependencies.issueAdapter
      ?? new GhCliIssueAdapter(fencedConfig.github.owner, fencedConfig.github.repo);
    const matchingProcesses = await findMatchingDaemonProcesses(await inspect(), targetRoot, bridge);
    if (matchingProcesses.length > 0) {
      throw new Error(`bridge-v1-daemon-active: matching daemon pid ${matchingProcesses[0]?.pid} is still running.`);
    }

    const store = new RunnerStateStore(targetRoot, fencedConfig);
    const state = await store.load();
    const runIds = state.runs.map((run) => run.sessionId).sort();
    if (runIds.length > 0) {
      throw new Error(`bridge-v1-local-state-active: nonterminal v1 runs ${runIds.join(', ')}.`);
    }
    await store.save(state);
    const stateBytes = await readFile(store.statePath());

    const queriedAt = (dependencies.now ?? new Date()).toISOString();
    let runningIssues: Awaited<ReturnType<GitHubIssueAdapter['listOpenIssuesWithAnyLabel']>>;
    try {
      runningIssues = await issueAdapter.listOpenIssuesWithAnyLabel([fencedConfig.github.labels.running.name]);
    } catch (error) {
      throw new Error(`bridge-github-drain-unavailable: ${error instanceof Error ? error.message : 'GitHub read failed'}`);
    }
    const issueNumbers = runningIssues.map((issue) => issue.number).sort((left, right) => left - right);
    if (issueNumbers.length > 0) {
      throw new Error(`bridge-v1-github-claim-active: open running issues ${issueNumbers.join(', ')}.`);
    }

    const generation: PreparedSkillRuntimeGenerationV1 = {
      version: 1,
      canonicalTargetRoot: targetRoot,
      preparedAt: (dependencies.now ?? new Date()).toISOString(),
      hostId,
      bootNonce,
      bridgePackageVersion: bridge.packageVersion,
      bridgePackageHash: bridge.packageHash,
      activityFenceGeneration: lease.generation,
      inspectedProcesses: matchingProcesses,
      runnerState: {
        path: store.statePath(),
        sha256: createHash('sha256').update(stateBytes).digest('hex'),
        nonterminalV1RunIds: [],
      },
      githubDrain: { queriedAt, runningIssueNumbers: [] },
    };
    const path = join(targetRoot, fencedConfig.runner.stateDir, 'skill-runtime-v2', 'prepared-generation.json');
    await writeDurableAtomicFile(path, `${JSON.stringify(generation, null, 2)}\n`);
    return { path, generation };
  } finally {
    await lease.release();
  }
}

export async function inspectBridgeProcesses(
  input: BridgeProcessInspectionInput = {},
): Promise<BridgeProcessIdentity[]> {
  const platform = input.platform ?? process.platform;
  if (platform === 'linux') return inspectLinuxProcesses(input);
  if (platform === 'darwin') return inspectDarwinProcesses(input);
  throw new Error(`bridge-process-introspection-unsupported: platform ${platform} is not supported.`);
}

async function inspectLinuxProcesses(input: BridgeProcessInspectionInput): Promise<BridgeProcessIdentity[]> {
  const procRoot = input.procRoot ?? '/proc';
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch (error) {
    throw unsupported(`Linux procfs is unavailable: ${errorMessage(error)}`);
  }
  const processes: BridgeProcessIdentity[] = [];
  for (const name of names.filter((entry) => /^\d+$/u.test(entry)).sort((left, right) => Number(left) - Number(right))) {
    const pid = Number(name);
    try {
      const [status, statContent, cmdline, executable] = await Promise.all([
        readFile(join(procRoot, name, 'status'), 'utf8'),
        readFile(join(procRoot, name, 'stat'), 'utf8'),
        readFile(join(procRoot, name, 'cmdline')),
        input.readExecutable ? input.readExecutable(pid) : readlink(join(procRoot, name, 'exe')),
      ]);
      const uidMatch = status.match(/^Uid:\s+(\d+)/mu);
      const close = statContent.lastIndexOf(')');
      const fields = close >= 0 ? statContent.slice(close + 1).trim().split(/\s+/u) : [];
      const startTime = fields[19];
      const argv = cmdline.toString('utf8').split('\0').filter((part) => part.length > 0);
      if (!uidMatch?.[1] || !startTime || argv.length === 0 || !executable.trim()) {
        throw unsupported(`Linux process ${pid} identity is ambiguous.`);
      }
      processes.push({ pid, uid: Number(uidMatch[1]), startTime, executable: executable.trim(), argv });
    } catch (error) {
      if (isCode(error, 'ENOENT')) continue;
      if (error instanceof Error && error.message.startsWith('bridge-process-introspection-unsupported:')) throw error;
      throw unsupported(`Linux process ${pid} cannot be inspected: ${errorMessage(error)}`);
    }
  }
  return processes;
}

async function inspectDarwinProcesses(input: BridgeProcessInspectionInput): Promise<BridgeProcessIdentity[]> {
  const run = input.runCommand ?? defaultRunCommand;
  let pidOutput: string;
  try {
    pidOutput = await run('ps', ['-axo', 'pid=']);
  } catch (error) {
    throw unsupported(`Darwin ps is unavailable: ${errorMessage(error)}`);
  }
  const pids = pidOutput.split(/\s+/u).filter(Boolean).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const processes: BridgeProcessIdentity[] = [];
  for (const pid of pids.sort((left, right) => left - right)) {
    let identity: string;
    try {
      identity = await run('ps', ['-p', String(pid), '-o', 'uid=,lstart=,command=']);
    } catch {
      continue;
    }
    try {
      const match = identity.trim().match(/^(\d+)\s+(.{24})\s+(.+)$/u);
      if (!match?.[1] || !match[2] || !match[3]) {
        throw unsupported(`Darwin process ${pid} identity is ambiguous.`);
      }
      const rawCommand = match[3];
      if (!mayBeOrchestratorDaemonCommand(rawCommand)) {
        parseDarwinCommand(rawCommand);
        continue;
      }
      const lsof = await run('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
      const executable = lsof.split(/\r?\n/u).find((line) => line.startsWith('n'))?.slice(1);
      if (!executable) throw unsupported(`Darwin process ${pid} executable identity is ambiguous.`);
      throw unsupported(
        `Darwin process ${pid} is an orchestrator daemon, but ps does not preserve exact argv boundaries.`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('bridge-process-introspection-unsupported:')) throw error;
      throw unsupported(`Darwin process ${pid} cannot be inspected: ${errorMessage(error)}`);
    }
  }
  return processes;
}

async function findMatchingDaemonProcesses(
  processes: BridgeProcessIdentity[],
  canonicalTargetRoot: string,
  currentBridge: BridgeRuntimeManifestV1,
): Promise<BridgeProcessIdentity[]> {
  const matches: BridgeProcessIdentity[] = [];
  for (const candidate of processes) {
    if (!isOrchestratorDaemonArgv(candidate.argv)) continue;
    const daemonIndex = candidate.argv.indexOf('daemon');
    const targetIndexes = candidate.argv.flatMap((arg, index) => arg === '--target' ? [index] : []);
    if (targetIndexes.length !== 1) {
      throw new Error(`bridge-process-argv-ambiguous: daemon pid ${candidate.pid} has ambiguous --target arguments.`);
    }
    const targetArg = candidate.argv[targetIndexes[0]! + 1];
    if (!targetArg || !isAbsolute(targetArg)) {
      throw new Error(`bridge-process-argv-ambiguous: daemon pid ${candidate.pid} target is not absolute.`);
    }
    let target: string;
    try {
      target = await realpath(targetArg);
    } catch {
      throw new Error(`bridge-process-argv-ambiguous: daemon pid ${candidate.pid} target cannot be canonicalized.`);
    }
    if (target !== canonicalTargetRoot) continue;
    if (typeof process.getuid === 'function' && candidate.uid !== process.getuid()) {
      throw new Error(`bridge-process-owner-mismatch: daemon pid ${candidate.pid} belongs to uid ${candidate.uid}.`);
    }
    const executable = await realpath(candidate.executable).catch(() => undefined);
    const argvExecutable = candidate.argv[0] && isAbsolute(candidate.argv[0])
      ? await realpath(candidate.argv[0]).catch(() => undefined)
      : undefined;
    if (!executable || !argvExecutable || executable !== argvExecutable) {
      throw new Error(`bridge-process-executable-mismatch: daemon pid ${candidate.pid} executable identity is ambiguous.`);
    }
    const cliArg = candidate.argv.slice(0, daemonIndex).reverse().find((arg) => /(?:^|\/)cli\.js$/u.test(arg));
    if (!cliArg || !isAbsolute(cliArg)) {
      throw new Error(`bridge-process-argv-ambiguous: daemon pid ${candidate.pid} package CLI path is ambiguous.`);
    }
    const cliPath = await realpath(cliArg).catch(() => undefined);
    if (!cliPath) throw new Error(`bridge-process-argv-ambiguous: daemon pid ${candidate.pid} CLI path is unavailable.`);
    const candidateRoot = resolve(dirname(cliPath), '../..');
    let candidateBridge: BridgeRuntimeManifestV1;
    try {
      candidateBridge = await verifyBridgeRuntimeManifest(candidateRoot);
    } catch (error) {
      throw new Error(`bridge-package-generation-mismatch: daemon pid ${candidate.pid}: ${errorMessage(error)}`);
    }
    if (candidateBridge.packageVersion !== currentBridge.packageVersion
      || candidateBridge.packageHash !== currentBridge.packageHash) {
      throw new Error(`bridge-package-generation-mismatch: daemon pid ${candidate.pid} uses ${candidateBridge.packageHash}.`);
    }
    matches.push(candidate);
  }
  return matches.sort((left, right) => left.pid - right.pid);
}

function parseDarwinCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote) throw unsupported('Darwin command argv quoting is ambiguous.');
  if (current) args.push(current);
  if (args.length === 0) throw unsupported('Darwin command argv is empty.');
  return args;
}

function mayBeOrchestratorDaemonCommand(command: string): boolean {
  const cli = command.match(/codex-orchestrator|cli\.js/u);
  if (!cli || cli.index === undefined) return false;
  return /(?:^|[^A-Za-z0-9_-])daemon(?:$|[^A-Za-z0-9_-])/u.test(command.slice(cli.index + cli[0].length));
}

function isOrchestratorDaemonArgv(argv: string[]): boolean {
  const cliIndex = argv.findIndex((arg) => /(?:^|\/)(?:codex-orchestrator|cli\.js)$/u.test(arg));
  return cliIndex >= 0 && cliIndex <= 1 && argv[cliIndex + 1] === 'daemon';
}

async function defaultRunCommand(command: string, args: string[]): Promise<string> {
  return (await execFileAsync(command, args)).stdout;
}

function defaultPackageRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

function unsupported(message: string): Error {
  return new Error(`bridge-process-introspection-unsupported: ${message}`);
}

function requireText(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`Bridge preparation ${field} must be non-empty.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
