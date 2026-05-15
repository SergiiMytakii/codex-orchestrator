#!/usr/bin/env node

import { resolve } from 'node:path';

import { GhCliIssueAdapter } from './github/gh-issue-adapter.js';
import { readPackageInfo } from './package-info.js';
import { readRunnerConfig } from './runner/command-utils.js';
import { discoverIssueWork } from './runner/issue-state-machine.js';
import { runDaemonCommand } from './runner/daemon-command.js';
import { runDoctorCommand } from './runner/doctor-command.js';
import { runPlanAutoCommand } from './runner/plan-auto-command.js';
import { runScopedAutoCommand } from './runner/scoped-auto-command.js';
import { runStatusCommand } from './runner/status-command.js';
import { runSetupCommand } from './setup/setup-command.js';

const helpText = `codex-orchestrator

Usage:
  codex-orchestrator --help
  codex-orchestrator --version
  codex-orchestrator health
  codex-orchestrator doctor --target <path> [--json]
  codex-orchestrator setup [--target <path>] [--github-owner <owner>] [--github-repo <repo>] [--dry-run] [--prepare-labels]
  codex-orchestrator status --target <path> [--dry-run] [--json]
  codex-orchestrator run --target <path> --issue <number>
  codex-orchestrator daemon --target <path> [--interval-seconds <number>] [--once] [--max-runs <number>]

Commands:
  health       Run a no-op local health check.
  doctor       Run read-only runner readiness diagnostics.
  setup        Create or dry-run project-local orchestrator config. Use --prepare-labels to create missing agent labels.
  status       Show eligible/skipped issue work and local recovery state.
  run          Execute one authorized issue: scoped agent:auto or full agent:plan-auto issue tree.
  daemon       Poll GitHub Issues and execute eligible autonomous work until stopped.

Options:
  --help, -h      Show this help.
  --version, -v   Show package version.
`;

interface SetupCliArgs {
  target?: string;
  githubOwner?: string;
  githubRepo?: string;
  skillsRoot?: string;
  dryRun: boolean;
  prepareLabels: boolean;
  replacePackageSkills: boolean;
}

interface StatusCliArgs {
  target?: string;
  dryRun: boolean;
  json: boolean;
}

interface DoctorCliArgs {
  target?: string;
  json: boolean;
}

interface RunCliArgs {
  target?: string;
  issue?: number;
}

interface DaemonCliArgs {
  target?: string;
  intervalSeconds?: number;
  once: boolean;
  maxRuns?: number;
}

async function main(args: string[]): Promise<number> {
  const [command] = args;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(helpText);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    const packageInfo = await readPackageInfo();
    process.stdout.write(`${packageInfo.name} ${packageInfo.version}\n`);
    return 0;
  }

  if (command === 'health') {
    process.stdout.write('codex-orchestrator health: ok\n');
    return 0;
  }

  if (command === 'setup') {
    const parsed = parseSetupArgs(args.slice(1));

    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
      return 2;
    }

    try {
      const result = await runSetupCommand({
        targetRoot: parsed.value.target,
        githubOwner: parsed.value.githubOwner,
        githubRepo: parsed.value.githubRepo,
        dryRun: parsed.value.dryRun,
        prepareLabels: parsed.value.prepareLabels,
        skillsRoot: parsed.value.skillsRoot,
        replacePackageSkills: parsed.value.replacePackageSkills,
      });
      process.stdout.write(`${result.output}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'setup failed';
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }

  if (command === 'doctor') {
    const parsed = parseDoctorArgs(args.slice(1));

    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
      return 2;
    }

    try {
      const result = await runDoctorCommand({
        targetRoot: parsed.value.target,
        json: parsed.value.json,
      });
      process.stdout.write(`${result.output}\n`);
      return result.json.summary.fail > 0 ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'doctor failed';
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }

  if (command === 'status') {
    const parsed = parseStatusArgs(args.slice(1));

    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
      return 2;
    }

    try {
      const result = await runStatusCommand({
        targetRoot: parsed.value.target,
        dryRun: parsed.value.dryRun,
        json: parsed.value.json,
      });
      process.stdout.write(`${result.output}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'status failed';
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }

  if (command === 'run') {
    const parsed = parseRunArgs(args.slice(1));

    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
      return 2;
    }

    try {
      const result = await runIssueCommand(parsed.value.target, parsed.value.issue);
      process.stdout.write(`${result.reportComment}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'run failed';
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }

  if (command === 'daemon') {
    const parsed = parseDaemonArgs(args.slice(1));

    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
      return 2;
    }

    try {
      await runDaemonCommand({
        targetRoot: parsed.value.target,
        intervalMs: parsed.value.intervalSeconds * 1000,
        once: parsed.value.once,
        maxRuns: parsed.value.maxRuns,
        onEvent: (line) => {
          process.stdout.write(`${line}\n`);
        },
      });
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'daemon failed';
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }

  process.stderr.write(`Unknown command: ${command}\nRun codex-orchestrator --help for usage.\n`);
  return 1;
}

async function runIssueCommand(targetRootInput: string, issueNumber: number): Promise<{ reportComment: string }> {
  const targetRoot = resolve(targetRootInput);
  const config = await readRunnerConfig(targetRoot);
  const issueAdapter = new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const issue = await issueAdapter.getIssue(issueNumber);
  if (!issue) {
    throw new Error(`Issue #${issueNumber} was not found`);
  }
  const decision = discoverIssueWork([issue], config)[0];
  if (!decision || decision.kind !== 'eligible') {
    const reason = decision?.kind === 'skipped' ? decision.reason : 'not eligible';
    throw new Error(`Issue #${issueNumber} is not eligible for autonomous work: ${reason}`);
  }
  if (decision.mode === 'plan-parent') {
    return runPlanAutoCommand({ targetRoot, issueNumber });
  }
  return runScopedAutoCommand({ targetRoot, issueNumber });
}

function parseRunArgs(
  args: string[],
): { ok: true; value: RunCliArgs & { target: string; issue: number } } | { ok: false; error: string } {
  const parsed: RunCliArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--target':
        if (!next || next.startsWith('--')) {
          return { ok: false, error: `${arg} requires a value` };
        }
        parsed.target = next;
        index += 1;
        break;
      case '--issue':
        if (!next || next.startsWith('--') || !Number.isInteger(Number(next)) || Number(next) < 1) {
          return { ok: false, error: 'run requires --issue <number>' };
        }
        parsed.issue = Number(next);
        index += 1;
        break;
      default:
        return { ok: false, error: `Unknown run option: ${arg ?? ''}` };
    }
  }

  if (!parsed.target) {
    return { ok: false, error: 'run requires --target <path>' };
  }
  if (!parsed.issue) {
    return { ok: false, error: 'run requires --issue <number>' };
  }

  return { ok: true, value: { ...parsed, target: parsed.target, issue: parsed.issue } };
}

function parseStatusArgs(args: string[]): { ok: true; value: StatusCliArgs & { target: string } } | { ok: false; error: string } {
  const parsed: StatusCliArgs = {
    dryRun: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--target':
        if (!next || next.startsWith('--')) {
          return { ok: false, error: `${arg} requires a value` };
        }
        parsed.target = next;
        index += 1;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      default:
        return { ok: false, error: `Unknown status option: ${arg ?? ''}` };
    }
  }

  if (!parsed.target) {
    return { ok: false, error: 'status requires --target <path>' };
  }

  return { ok: true, value: { ...parsed, target: parsed.target } };
}

function parseDoctorArgs(args: string[]): { ok: true; value: DoctorCliArgs & { target: string } } | { ok: false; error: string } {
  const parsed: DoctorCliArgs = {
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--target':
        if (!next || next.startsWith('--')) {
          return { ok: false, error: `${arg} requires a value` };
        }
        parsed.target = next;
        index += 1;
        break;
      case '--json':
        parsed.json = true;
        break;
      default:
        return { ok: false, error: `Unknown doctor option: ${arg ?? ''}` };
    }
  }

  if (!parsed.target) {
    return { ok: false, error: 'doctor requires --target <path>' };
  }

  return { ok: true, value: { ...parsed, target: parsed.target } };
}

function parseDaemonArgs(
  args: string[],
): { ok: true; value: DaemonCliArgs & { target: string; intervalSeconds: number } } | { ok: false; error: string } {
  const parsed: DaemonCliArgs = {
    intervalSeconds: 300,
    once: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--target':
        if (!next || next.startsWith('--')) {
          return { ok: false, error: `${arg} requires a value` };
        }
        parsed.target = next;
        index += 1;
        break;
      case '--interval-seconds':
        if (!next || next.startsWith('--') || !Number.isInteger(Number(next)) || Number(next) < 1) {
          return { ok: false, error: 'daemon requires --interval-seconds <positive integer>' };
        }
        parsed.intervalSeconds = Number(next);
        index += 1;
        break;
      case '--once':
        parsed.once = true;
        break;
      case '--max-runs':
        if (!next || next.startsWith('--') || !Number.isInteger(Number(next)) || Number(next) < 1) {
          return { ok: false, error: 'daemon requires --max-runs <positive integer>' };
        }
        parsed.maxRuns = Number(next);
        index += 1;
        break;
      default:
        return { ok: false, error: `Unknown daemon option: ${arg ?? ''}` };
    }
  }

  if (!parsed.target) {
    return { ok: false, error: 'daemon requires --target <path>' };
  }

  return { ok: true, value: { ...parsed, target: parsed.target, intervalSeconds: parsed.intervalSeconds ?? 300 } };
}

function parseSetupArgs(args: string[]): { ok: true; value: SetupCliArgs & { target: string } } | { ok: false; error: string } {
  const parsed: SetupCliArgs = {
    dryRun: false,
    prepareLabels: false,
    replacePackageSkills: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--target':
        if (!next || next.startsWith('--')) {
          return { ok: false, error: `${arg} requires a value` };
        }
        parsed.target = next;
        index += 1;
        break;
      case '--github-owner':
        if (!next || next.startsWith('--')) {
          return { ok: false, error: `${arg} requires a value` };
        }
        parsed.githubOwner = next;
        index += 1;
        break;
      case '--github-repo':
        if (!next || next.startsWith('--')) {
          return { ok: false, error: `${arg} requires a value` };
        }
        parsed.githubRepo = next;
        index += 1;
        break;
      case '--skills-root':
        if (!next || next.startsWith('--')) {
          return { ok: false, error: `${arg} requires a value` };
        }
        parsed.skillsRoot = next;
        index += 1;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--prepare-labels':
        parsed.prepareLabels = true;
        break;
      case '--replace-package-skills':
        parsed.replacePackageSkills = true;
        break;
      default:
        return { ok: false, error: `Unknown setup option: ${arg ?? ''}` };
    }
  }

  return { ok: true, value: { ...parsed, target: parsed.target ?? process.cwd() } };
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
