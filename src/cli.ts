#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { GhCliIssueAdapter } from './github/gh-issue-adapter.js';
import { readPackageInfo } from './package-info.js';
import { readRunnerConfig } from './runner/command-utils.js';
import { discoverIssueWork } from './runner/issue-state-machine.js';
import { runDaemonCommand } from './runner/daemon-command.js';
import { runDoctorCommand } from './runner/doctor-command.js';
import { runPlanAutoCommand } from './runner/plan-auto-command.js';
import { runScopedAutoCommand } from './runner/scoped-auto-command.js';
import { recoverScopedRun } from './runner/scoped-recovery.js';
import { runStatusCommand } from './runner/status-command.js';
import { parseAndroidVisualProofArgs, runAndroidVisualProofCommand } from './runner/android-visual-proof-command.js';
import { parseBrowserVisualProofArgs, runBrowserVisualProofCommand } from './runner/browser-visual-proof-command.js';
import { parseIosVisualProofArgs, runIosVisualProofCommand } from './runner/ios-visual-proof-command.js';
import { parseMobileVisualProofArgs, runMobileVisualProofCommand } from './runner/mobile-visual-proof-command.js';
import { runSetupCommand } from './setup/setup-command.js';
import { runAutoVisualProofCommand } from './runner/auto-visual-proof-command.js';
import { formatAcceptanceProofShapeErrors, validateAcceptanceProofReportShape } from './runner/acceptance-proof.js';
import { runAuthLoginCommand } from './codex/auth-command.js';

const helpText = `codex-orchestrator

Usage:
  codex-orchestrator --help
  codex-orchestrator --version
  codex-orchestrator health
  codex-orchestrator auth login
  codex-orchestrator doctor --target <path> [--json]
  codex-orchestrator setup [--target <path>] [--github-owner <owner>] [--github-repo <repo>] [--dry-run] [--prepare-labels] [--prepare-skill-runtime-v2 | --activate-skill-runtime-v2]
  codex-orchestrator status --target <path> [--dry-run] [--json]
  codex-orchestrator run --target <path> --issue <number>
  codex-orchestrator daemon --target <path> [--interval-seconds <number>] [--once] [--max-runs <number>] [--concurrency <number>]
  codex-orchestrator acceptance-proof validate --report <path>
  codex-orchestrator visual-proof auto --issue <number> [--target <path>]
  codex-orchestrator visual-proof browser --issue <number> [--target <path>] [--scenario <path>] [--base-url <url>]
  codex-orchestrator visual-proof mobile --issue <number> [--target <path>]
  codex-orchestrator visual-proof android --issue <number> [--target <path>]
  codex-orchestrator visual-proof ios --issue <number> [--target <path>]

Commands:
  health       Run a no-op local health check.
  auth         Authenticate the package-owned Codex runtime home.
  doctor       Run read-only runner readiness diagnostics.
  setup        Create or dry-run project-local orchestrator config. Use --prepare-labels to create missing agent labels.
  status       Show eligible/skipped issue work and local recovery state.
  run          Execute one authorized issue: scoped agent:auto or full agent:plan-auto issue tree.
  daemon       Poll GitHub Issues and execute eligible autonomous work until stopped.
  acceptance-proof Validate machine-readable Acceptance Proof reports.
  visual-proof Run package-owned proof commands used by review gates.

Options:
  --help, -h      Show this help.
  --version, -v   Show package version.

`;

interface SetupCliArgs {
  target?: string;
  githubOwner?: string;
  githubRepo?: string;
  dryRun: boolean;
  prepareLabels: boolean;
  prepareSkillRuntimeV2: boolean;
  activateSkillRuntimeV2: boolean;
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
  concurrency?: number;
}

interface AcceptanceProofValidateCliArgs {
  report?: string;
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

  if (command === 'auth') {
    const [kind, ...rest] = args.slice(1);
    if (kind !== 'login' || rest.length > 0) {
      process.stderr.write('auth requires exactly: auth login\nRun codex-orchestrator --help for usage.\n');
      return 2;
    }
    try {
      const result = await runAuthLoginCommand({
        onAuthUrl: (url) => process.stdout.write(`Open this URL to authenticate Codex:\n${url}\n`),
      });
      process.stdout.write(result.status === 'already-authenticated'
        ? 'Codex package runtime is already authenticated.\n'
        : 'Codex package runtime authentication completed.\n');
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'auth login failed';
      process.stderr.write(`${message}\n`);
      return 1;
    }
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
        prepareSkillRuntimeV2: parsed.value.prepareSkillRuntimeV2,
        activateSkillRuntimeV2: parsed.value.activateSkillRuntimeV2,
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
        concurrency: parsed.value.concurrency,
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

  if (command === 'acceptance-proof') {
    const [kind, ...rest] = args.slice(1);
    if (kind !== 'validate') {
      process.stderr.write('acceptance-proof requires a supported kind: validate\nRun codex-orchestrator --help for usage.\n');
      return 2;
    }
    const parsed = parseAcceptanceProofValidateArgs(rest);
    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
      return 2;
    }
    try {
      const result = await validateAcceptanceProofReportFile(parsed.value.report);
      if (!result.ok) {
        process.stderr.write(`${result.message}\n`);
        return 1;
      }
      process.stdout.write('acceptance proof report shape valid\n');
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'acceptance-proof validate failed';
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }

  if (command === 'visual-proof') {
    const [kind, ...rest] = args.slice(1);
    if (kind !== 'auto' && kind !== 'browser' && kind !== 'mobile' && kind !== 'android' && kind !== 'ios') {
      process.stderr.write('visual-proof requires a supported kind: auto, browser, mobile, android, or ios\nRun codex-orchestrator --help for usage.\n');
      return 2;
    }
    try {
      if (kind === 'auto') {
        const config = await readRunnerConfig(visualProofTargetFromArgs(rest) ?? process.cwd());
        const result = await runAutoVisualProofCommand({ args: rest, config });
        process.stdout.write(`auto visual proof selected ${result.target}\n`);
      } else if (kind === 'browser') {
        const parsed = parseBrowserVisualProofArgs(rest);
        if (!parsed.ok) {
          process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
          return 2;
        }
        const result = await runBrowserVisualProofCommand(parsed.value);
        process.stdout.write(`browser visual proof ${result.status} for issue #${parsed.value.issueNumber}\n`);
      } else if (kind === 'mobile') {
        const parsed = parseMobileVisualProofArgs(rest);
        if (!parsed.ok) {
          process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
          return 2;
        }
        await runMobileVisualProofCommand(parsed.value);
        process.stdout.write(`mobile visual proof captured for issue #${parsed.value.issueNumber}\n`);
      } else if (kind === 'ios') {
        const parsed = parseIosVisualProofArgs(rest);
        if (!parsed.ok) {
          process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
          return 2;
        }
        await runIosVisualProofCommand(parsed.value);
        process.stdout.write(`ios visual proof captured for issue #${parsed.value.issueNumber}\n`);
      } else {
        const parsed = parseAndroidVisualProofArgs(rest);
        if (!parsed.ok) {
          process.stderr.write(`${parsed.error}\nRun codex-orchestrator --help for usage.\n`);
          return 2;
        }
        await runAndroidVisualProofCommand(parsed.value);
        process.stdout.write(`android visual proof captured for issue #${parsed.value.issueNumber}\n`);
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'visual proof failed';
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }

  process.stderr.write(`Unknown command: ${command}\nRun codex-orchestrator --help for usage.\n`);
  return 1;
}

async function validateAcceptanceProofReportFile(reportPath: string): Promise<{ ok: true } | { ok: false; message: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(reportPath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    return { ok: false, message: `Invalid acceptance proof report JSON: ${message}` };
  }

  const validation = validateAcceptanceProofReportShape(parsed);
  return validation.ok
    ? { ok: true }
    : { ok: false, message: formatAcceptanceProofShapeErrors(validation.errors) };
}

function visualProofTargetFromArgs(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== '--target' && arg !== '--worktree') {
      continue;
    }
    const value = args[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
  }
  return undefined;
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
    const recovered = await recoverScopedRun({
      targetRoot,
      issueNumber,
      invocation: 'targeted',
      issueAdapter,
    });
    if (recovered.status !== 'not-recoverable') {
      return { reportComment: recovered.reportComment };
    }
    const labels = new Set(issue.labels.map((label) => label.name));
    const alreadyRunningPlanParent = decision?.kind === 'skipped'
      && decision.reasonCode === 'already-running'
      && issue.state === 'OPEN'
      && labels.has(config.github.labels.planAuto.name)
      && !labels.has(config.github.labels.child.name);
    if (alreadyRunningPlanParent) {
      return runPlanAutoCommand({ targetRoot, issueNumber });
    }
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

function parseAcceptanceProofValidateArgs(
  args: string[],
): { ok: true; value: AcceptanceProofValidateCliArgs & { report: string } } | { ok: false; error: string } {
  const parsed: AcceptanceProofValidateCliArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--report':
        if (!next || next.startsWith('--')) {
          return { ok: false, error: `${arg} requires a value` };
        }
        parsed.report = next;
        index += 1;
        break;
      default:
        return { ok: false, error: `Unknown acceptance-proof validate option: ${arg ?? ''}` };
    }
  }

  if (!parsed.report) {
    return { ok: false, error: 'acceptance-proof validate requires --report <path>' };
  }

  return { ok: true, value: { ...parsed, report: parsed.report } };
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
      case '--concurrency':
        if (!next || next.startsWith('--') || !Number.isInteger(Number(next)) || Number(next) < 1 || Number(next) > 3) {
          return { ok: false, error: 'daemon requires --concurrency <integer between 1 and 3>' };
        }
        parsed.concurrency = Number(next);
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
    prepareSkillRuntimeV2: false,
    activateSkillRuntimeV2: false,
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
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--prepare-labels':
        parsed.prepareLabels = true;
        break;
      case '--prepare-skill-runtime-v2':
        parsed.prepareSkillRuntimeV2 = true;
        break;
      case '--activate-skill-runtime-v2':
        parsed.activateSkillRuntimeV2 = true;
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
