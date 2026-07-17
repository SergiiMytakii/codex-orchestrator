#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import { GhCliPullRequestAdapter } from '../github/gh-pull-request-adapter.js';
import { parseAgentAutoConfig } from './config.js';
import { sha256 } from './containment.js';
import { renderRunResultJson, runIssueExitCode } from './cli-contract.js';
import { createV2Runtime } from './runtime.js';
import { parseSetupArgs, renderSetupResultJson, setupOutcomeExitCode } from './setup-cli.js';
import { createProductionSetup } from './setup-runtime.js';
import type { SetupIntent, SetupOutcome } from './setup.js';
import type { RunIssueResult } from './run-issue.js';

export interface CandidateRunIntent { targetRoot: string; issueNumber: number }

export function parseCandidateRunArgs(argv: string[]): CandidateRunIntent {
  if (argv.length !== 5 || argv[0] !== 'run' || argv[1] !== '--target' || argv[3] !== '--issue') {
    throw new Error('usage: candidate-cli run --target <absolute-path> --issue <positive-integer>');
  }
  const targetRoot = argv[2]!;
  const issueNumber = Number(argv[4]);
  if (!isAbsolute(targetRoot) || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error('candidate run intent is invalid');
  return { targetRoot: resolve(targetRoot), issueNumber };
}

export async function runCandidateCli(argv: string[], dependencies: {
  executeRun?: (input: CandidateRunIntent) => Promise<RunIssueResult>;
  executeSetup?: (input: SetupIntent) => Promise<SetupOutcome>;
  packageVersion?: string;
  write?: (text: string) => void;
} = {}): Promise<number> {
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  if (argv.length === 1 && argv[0] === '--help') {
    write(candidateHelp());
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
  const intent = parseCandidateRunArgs(argv);
  const result = await (dependencies.executeRun ?? executeProductionRun)(intent);
  write(renderRunResultJson(result));
  return runIssueExitCode(result);
}

async function executeProductionRun(intent: CandidateRunIntent): Promise<RunIssueResult> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const packageVersion = await readPackageVersion();
  const config = parseAgentAutoConfig(JSON.parse(await readFile(join(intent.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8')));
  const skillHashes = {
    'agent-auto': sha256(await readFile(join(packageRoot, 'internal-skills', 'agent-auto', 'SKILL.md'))),
    'acceptance-proof': sha256(await readFile(join(packageRoot, 'internal-skills', 'acceptance-proof', 'SKILL.md'))),
  };
  const runtime = createV2Runtime({
    targetRoot: intent.targetRoot,
    orchestratorHome: resolve(process.env.CODEX_ORCHESTRATOR_HOME ?? join(homedir(), '.codex-orchestrator')),
    bootId: await readBootId(),
    packageVersion,
    skillHashes,
    issues: new GhCliIssueAdapter(config.github.owner, config.github.repo),
    pullRequests: new GhCliPullRequestAdapter(config.github.owner, config.github.repo),
    packageRoot,
    parentCodexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')),
    safePath: process.env.CODEX_ORCHESTRATOR_SAFE_PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
  });
  try { return await runtime.runIssue(intent); }
  finally { runtime.dispose(); }
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

function candidateHelp(): string {
  return [
    'codex-orchestrator V2 candidate',
    '  setup --target <absolute-path> [--github-owner <owner> --github-repo <repo>] [--prepare-labels|--fresh] [--dry-run]',
    '  doctor --target <absolute-path>',
    '  status --target <absolute-path>',
    '  run --target <absolute-path> --issue <positive-integer>',
    '',
  ].join('\n');
}

async function readBootId(): Promise<string> {
  if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (process.platform === 'darwin') {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolveBoot, rejectBoot) => execFile('/usr/sbin/sysctl', ['-n', 'kern.boottime'], (error, stdout) => {
      if (error || !stdout.trim()) rejectBoot(error ?? new Error('boot identity is unavailable'));
      else resolveBoot(stdout.trim());
    }));
  }
  throw new Error(`platform ${process.platform} cannot prove boot identity`);
}

export function isDirectCandidateExecution(entryPath: string, modulePath: string): boolean {
  try { return realpathSync.native(entryPath) === realpathSync.native(modulePath); }
  catch { return false; }
}

if (process.argv[1] && isDirectCandidateExecution(process.argv[1], fileURLToPath(import.meta.url))) {
  runCandidateCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 70;
  });
}
