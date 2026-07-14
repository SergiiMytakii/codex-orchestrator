#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultTimeoutMs = 600_000;
const defaultLiveSmokeRepo = process.env.CODEX_ORCHESTRATOR_LIVE_SMOKE_REPO
  ?? 'SergiiMytakii/codex-orchestrator-live-smoke';
const cleanupModes = new Set(['delete', 'close']);
const defaultScenarioProfile = 'core-release';

const scenarioDefinitions = new Map([
  ['baseline', runBaselineScenario],
  ['package-install', runPackageInstallScenario],
  ['discovery-matrix', runDiscoveryMatrixScenario],
  ['real-codex', runRealCodexScenario],
  ['remote-base-branch', runRemoteBaseBranchScenario],
  ['scoped-runner-commit', runScopedRunnerCommitScenario],
  ['commit-policy', runCommitPolicyScenario],
  ['run-scoped', runDirectScopedScenario],
  ['loop-policy', runLoopPolicyScenario],
  ['incomplete-progress-rework', runIncompleteProgressReworkScenario],
  ['report-repair', runReportRepairScenario],
  ['diagnostics', runDiagnosticsScenario],
  ['browser-proof', runBrowserProofScenario],
  ['acceptance-proof-positive', runAcceptanceProofPositiveScenario],
  ['proof-strategy-non-visual-smoke', runProofStrategyNonVisualSmokeScenario],
  ['acceptance-proof-rework', runAcceptanceProofReworkScenario],
  ['acceptance-proof-negative', runAcceptanceProofNegativeScenario],
  ['quality-gates', runQualityGatesScenario],
  ['risk-routing', runRiskRoutingScenario],
  ['safety-negative', runSafetyNegativeScenario],
  ['plan-auto', runPlanAutoScenario],
  ['run-plan-auto', runDirectPlanAutoScenario],
  ['plan-auto-blocking', runPlanAutoBlockingScenario],
  ['tree-child-quality-rework', runTreeChildQualityReworkScenario],
  ['plan-auto-tree-recovery', runPlanAutoTreeRecoveryScenario],
]);

const scenarioProfiles = new Map([
  ['core-release', [
    'baseline',
    'package-install',
    'discovery-matrix',
    'real-codex',
    'scoped-runner-commit',
    'commit-policy',
    'run-scoped',
    'diagnostics',
    'browser-proof',
    'acceptance-proof-positive',
    'quality-gates',
    'risk-routing',
    'safety-negative',
    'plan-auto',
    'run-plan-auto',
  ]],
  ['extended-policy', [
    'remote-base-branch',
    'loop-policy',
    'incomplete-progress-rework',
    'report-repair',
    'acceptance-proof-rework',
    'acceptance-proof-negative',
    'plan-auto-blocking',
    'tree-child-quality-rework',
    'plan-auto-tree-recovery',
  ]],
  ['proof-matrix', [
    'browser-proof',
    'acceptance-proof-positive',
    'proof-strategy-non-visual-smoke',
    'acceptance-proof-rework',
    'acceptance-proof-negative',
  ]],
  ['full', Array.from(scenarioDefinitions.keys())],
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const selectedScenarios = selectedScenariosForOptions(options);
  for (const scenario of selectedScenarios) {
    if (!scenarioDefinitions.has(scenario)) {
      throw new Error(`Unknown scenario "${scenario}". Known scenarios: ${Array.from(scenarioDefinitions.keys()).join(', ')}`);
    }
  }

  const runId = options.runId ?? new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const root = options.workDir ? resolve(options.workDir) : await mkdtemp(join(tmpdir(), `codex-orchestrator-live-smoke-${runId}-`));
  await mkdir(root, { recursive: true });
  const reportPath = join(root, 'live-smoke-report.md');
  const context = {
    options,
    runId,
    root,
    sourceRoot,
    reportPath,
    createdIssues: [],
    createdPullRequests: [],
    createdBranches: [],
    notes: [],
    fakeAgentPath: '',
    browserProofPath: '',
    acceptanceProofPath: '',
    targetRoot: '',
    cliPath: '',
    repo: options.repo,
  };

  await appendReport(context, `# Live smoke ${runId}\n\nRepo: ${context.repo}\n\n`);

  let runFailure;
  try {
    context.cliPath = await preparePackagedCli(context);
    context.fakeAgentPath = await writeFakeAgent(root);
    context.browserProofPath = await writeBrowserProofScript(root, context.cliPath, context.sourceRoot);
    context.acceptanceProofPath = await writeAcceptanceProofScript(root);
    context.targetRoot = await prepareTargetRepository(context);
    await runPackagedCli(context, ['setup', '--target', context.targetRoot, '--github-owner', ownerOf(context.repo), '--github-repo', repoNameOf(context.repo), '--prepare-labels']);
    await ensureLiveSmokeLabels(context);
    context.realCodexConfig = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8')).codex;
    await configureTarget(context, { allowAgentLocalCommits: true });

    for (const scenario of selectedScenarios) {
      const started = Date.now();
      await appendReport(context, `## ${scenario}\n\n`);
      process.stdout.write(`\n[live-smoke] scenario ${scenario}\n`);
      await scenarioDefinitions.get(scenario)(context);
      await appendReport(context, `Result: passed in ${Date.now() - started}ms\n\n`);
    }

    await appendReport(context, '## Result\n\nAll selected live smoke scenarios passed.\n');
    process.stdout.write(`\n[live-smoke] passed. Report: ${reportPath}\n`);
  } catch (error) {
    runFailure = error;
    throw error;
  } finally {
    if (options.cleanup) {
      try {
        await cleanupGitHubArtifacts(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendReport(context, `\nCleanup failed: ${message}\n`);
        if (!runFailure) {
          throw error;
        }
        process.stderr.write(`[live-smoke] cleanup failed after run failure: ${message}\n`);
      }
    } else {
      await appendReport(context, '\n## Cleanup\n\nArtifacts kept for inspection. Run without --keep-artifacts to clean created issues and PRs.\n');
    }
  }
}

function parseArgs(args) {
  const options = {
    scenarios: [],
    cleanup: true,
    cleanupMode: 'delete',
    skipLocalTests: false,
    keepPackageTarball: false,
    timeoutMs: defaultTimeoutMs,
    repo: defaultLiveSmokeRepo,
    profile: defaultScenarioProfile,
    target: undefined,
    workDir: undefined,
    runId: undefined,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--scenario':
        requireValue(arg, next);
        options.scenarios.push(next);
        index += 1;
        break;
      case '--profile':
        requireValue(arg, next);
        options.profile = next;
        index += 1;
        break;
      case '--repo':
        requireValue(arg, next);
        options.repo = next;
        index += 1;
        break;
      case '--cleanup-mode':
        requireValue(arg, next);
        if (!cleanupModes.has(next)) {
          throw new Error('--cleanup-mode must be one of: delete, close');
        }
        options.cleanupMode = next;
        index += 1;
        break;
      case '--target':
        requireValue(arg, next);
        options.target = next;
        index += 1;
        break;
      case '--work-dir':
        requireValue(arg, next);
        options.workDir = next;
        index += 1;
        break;
      case '--run-id':
        requireValue(arg, next);
        options.runId = next.replace(/[^a-zA-Z0-9._-]/g, '-');
        index += 1;
        break;
      case '--timeout-ms':
        requireValue(arg, next);
        options.timeoutMs = Number(next);
        if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
          throw new Error('--timeout-ms requires a positive integer');
        }
        index += 1;
        break;
      case '--cleanup':
        options.cleanup = true;
        break;
      case '--no-cleanup':
      case '--keep-artifacts':
        options.cleanup = false;
        break;
      case '--skip-local-tests':
        options.skipLocalTests = true;
        break;
      case '--keep-package-tarball':
        options.keepPackageTarball = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function selectedScenariosForOptions(options) {
  if (options.scenarios.length > 0) {
    return options.scenarios;
  }
  const scenarios = scenarioProfiles.get(options.profile);
  if (!scenarios) {
    throw new Error(`Unknown profile "${options.profile}". Known profiles: ${Array.from(scenarioProfiles.keys()).join(', ')}`);
  }
  return scenarios;
}

function requireValue(arg, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`);
  }
}

function helpText() {
  return [
    'codex-orchestrator live smoke',
    '',
    'Usage:',
    '  npm run smoke:live -- [options]',
    '',
    'Options:',
    '  --scenario <name>          Run one scenario. Can be repeated.',
    `  --profile <name>           Run a scenario profile. Default ${defaultScenarioProfile}.`,
    `  --repo <owner/name>        GitHub repository. Defaults to ${defaultLiveSmokeRepo}.`,
    '  --target <path>            Existing local target repo. Defaults to a temp clone.',
    '  --work-dir <path>          Directory for smoke temp files and report.',
    '  --run-id <id>              Stable id used in issue titles and local state paths.',
    '  --timeout-ms <number>      Per-command timeout. Default 600000.',
    '  --cleanup                  Clean up created issues, PRs, and branches after the run by default.',
    '  --cleanup-mode <mode>      Cleanup mode: delete or close. Default delete.',
    '  --keep-artifacts           Keep created GitHub artifacts for inspection.',
    '  --no-cleanup               Alias for --keep-artifacts.',
    '  --skip-local-tests         Skip npm test before npm pack.',
    '  --keep-package-tarball     Do not delete the npm pack tarball.',
    '',
    `Profiles: ${Array.from(scenarioProfiles.keys()).join(', ')}`,
    `Scenarios: ${Array.from(scenarioDefinitions.keys()).join(', ')}`,
    '',
  ].join('\n');
}

async function preparePackagedCli(context) {
  if (!context.options.skipLocalTests) {
    await runCommand('npm', ['test'], { cwd: sourceRoot, timeoutMs: context.options.timeoutMs });
  }

  const packResult = await runCommand('npm', ['pack', '--json'], { cwd: sourceRoot, timeoutMs: context.options.timeoutMs });
  const pack = JSON.parse(packResult.stdout);
  const tarballName = pack[0]?.filename;
  if (typeof tarballName !== 'string') {
    throw new Error('npm pack did not return a tarball filename');
  }
  const tarballPath = join(sourceRoot, tarballName);
  const packageRoot = join(context.root, 'packed-cli');
  await mkdir(packageRoot, { recursive: true });
  await runCommand('tar', ['-xzf', tarballPath, '-C', packageRoot], { timeoutMs: context.options.timeoutMs });
  if (!context.options.keepPackageTarball) {
    await rm(tarballPath, { force: true });
  }
  const cliPath = join(packageRoot, 'package', 'dist', 'src', 'cli.js');
  await assertPathExists(cliPath, 'packaged CLI was not found after npm pack extraction');
  await appendReport(context, `Packaged CLI: ${cliPath}\n\n`);
  return cliPath;
}

async function prepareTargetRepository(context) {
  if (context.options.target) {
    const target = resolve(context.options.target);
    await assertPathExists(target, `target repository does not exist: ${target}`);
    await appendReport(context, `Target repository: ${target}\n\n`);
    return target;
  }

  const target = join(context.root, 'target');
  const defaultBranch = await defaultBranchFor(context.repo);
  await runCommand('gh', ['repo', 'clone', context.repo, target, '--', '--branch', defaultBranch], {
    timeoutMs: context.options.timeoutMs,
  });
  await appendReport(context, `Target repository: ${target}\n\n`);
  return target;
}

async function ensureLiveSmokeLabels(context) {
  await ensureGitHubLabel(context, {
    name: 'priority:loop',
    color: '5319E7',
    description: 'Live smoke priority label for loop policy scenarios',
  });
}

async function ensureGitHubLabel(context, label) {
  const existing = await runCommand('gh', ['label', 'list', '--repo', context.repo, '--limit', '200', '--json', 'name'], {
    timeoutMs: context.options.timeoutMs,
    retryTransient: true,
  });
  const labels = JSON.parse(existing.stdout);
  if (labels.some((entry) => entry.name === label.name)) {
    return;
  }
  await runCommand('gh', [
    'label',
    'create',
    label.name,
    '--repo',
    context.repo,
    '--color',
    label.color,
    '--description',
    label.description,
  ], { timeoutMs: context.options.timeoutMs });
  await appendReport(context, `Created live smoke label: ${label.name}\n\n`);
}

async function configureTarget(context, overrides = {}) {
  const configPath = join(context.targetRoot, '.codex-orchestrator', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.github.owner = ownerOf(context.repo);
  config.github.repo = repoNameOf(context.repo);
  config.runner.allowAgentLocalCommits = overrides.allowAgentLocalCommits ?? true;
  config.runner.workspaceRoot = `.codex-orchestrator/workspaces/live-smoke-${context.runId}`;
  config.runner.stateDir = `.codex-orchestrator/state/live-smoke-${context.runId}`;
  config.runner.maxParallelChildren = 2;
  if (overrides.codexMode === 'real') {
    config.codex = { ...context.realCodexConfig };
  } else {
    config.codex.command = process.execPath;
    config.codex.args = [context.fakeAgentPath];
    config.codex.timeoutMs = 120_000;
    config.codex.idleTimeoutMs = 30_000;
  }
  config.checks = {
    smoke: 'node --version',
  };
  if (overrides.additionalPathGlobs) {
    config.deny.additionalPathGlobs = overrides.additionalPathGlobs;
  }
  if (overrides.baseBranch) {
    config.branches.base = overrides.baseBranch;
  }
  if (overrides.runnerValidationCommand) {
    config.reviewGates.visualProof.runnerValidationCommand = overrides.runnerValidationCommand;
  }
  config.reviewGates.acceptanceProof = {
    ...config.reviewGates.acceptanceProof,
    // Every synthetic issue title contains "live-smoke"; keep Acceptance Proof opt-in per scenario.
    issueTextPatterns: ['ACCEPTANCE_PROOF_LIVE_SMOKE'],
    ...(overrides.acceptanceProof ?? {}),
  };
  if (overrides.acceptanceRunnerValidationCommand) {
    config.reviewGates.acceptanceProof.runnerValidationCommand = overrides.acceptanceRunnerValidationCommand;
  }
  if (overrides.loopPolicy) {
    config.loopPolicy = mergeLoopPolicy(config.loopPolicy, overrides.loopPolicy);
  }
  if (overrides.codexProfiles) {
    config.codex.profiles = overrides.codexProfiles;
  }
  if (overrides.codexCommand) {
    config.codex.command = overrides.codexCommand;
  }
  if (overrides.codexArgs) {
    config.codex.args = overrides.codexArgs;
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function mergeLoopPolicy(base, overrides) {
  return {
    ...base,
    ...overrides,
    issueSelection: {
      ...base.issueSelection,
      ...(overrides.issueSelection ?? {}),
    },
    rework: {
      ...base.rework,
      ...(overrides.rework ?? {}),
    },
    freshContextReview: {
      ...base.freshContextReview,
      ...(overrides.freshContextReview ?? {}),
    },
    durableRunSummaries: {
      ...base.durableRunSummaries,
      ...(overrides.durableRunSummaries ?? {}),
    },
    policySuggestions: {
      ...base.policySuggestions,
      ...(overrides.policySuggestions ?? {}),
    },
  };
}

async function runBaselineScenario(context) {
  await runPackagedCli(context, ['--help']);
  await runPackagedCli(context, ['--version']);
  await runPackagedCli(context, ['health']);
  await runPackagedCli(context, ['setup', '--target', context.targetRoot, '--github-owner', ownerOf(context.repo), '--github-repo', repoNameOf(context.repo), '--dry-run']);
  const status = await runPackagedCli(context, ['status', '--target', context.targetRoot, '--dry-run']);
  assertIncludes(status.stdout, 'codex-orchestrator status', 'status output should include header');
  assertIncludes(status.stdout, `repo: ${context.repo}`, 'status output should show target repo');
  await assertNoEligibleIssues(context);
  await assertPackageSurface(context);
}

async function runPackageInstallScenario(context) {
  const packageDir = dirname(dirname(dirname(context.cliPath)));
  const externalProject = join(context.root, 'external-package-install');
  await mkdir(externalProject, { recursive: true });
  await writeFile(join(externalProject, 'package.json'), '{"type":"module","private":true}\n', 'utf8');
  await runCommand('npm', ['install', packageDir, '--ignore-scripts'], {
    cwd: externalProject,
    timeoutMs: context.options.timeoutMs,
  });
  const importCheck = [
    'import { validateConfig, runStatusCommand, runDaemonCommand } from "codex-orchestrator";',
    'import { validateConfig as validateConfigSubpath } from "codex-orchestrator/config/schema";',
    'if (typeof validateConfig !== "function") throw new Error("missing root validateConfig");',
    'if (typeof validateConfigSubpath !== "function") throw new Error("missing subpath validateConfig");',
    'if (typeof runStatusCommand !== "function") throw new Error("missing runStatusCommand");',
    'if (typeof runDaemonCommand !== "function") throw new Error("missing runDaemonCommand");',
  ].join('\n');
  await writeFile(join(externalProject, 'import-check.mjs'), importCheck, 'utf8');
  await runCommand(process.execPath, ['import-check.mjs'], {
    cwd: externalProject,
    timeoutMs: context.options.timeoutMs,
  });
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const binResult = await runCommand(join(externalProject, 'node_modules', '.bin', 'codex-orchestrator'), ['--version'], {
    cwd: externalProject,
    timeoutMs: context.options.timeoutMs,
  });
  assertIncludes(binResult.stdout, `${packageJson.name} ${packageJson.version}`, 'installed package bin should report packaged version');
}

async function runDiscoveryMatrixScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const cases = [
    {
      scenario: 'discovery-manual',
      labels: ['agent:manual'],
      expected: 'manual-label: manual label is present',
    },
    {
      scenario: 'discovery-conflicting-auth',
      labels: ['agent:auto', 'agent:plan-auto'],
      expected: 'conflicting-authorization-labels: auto and plan-auto labels are both present',
    },
    {
      scenario: 'discovery-running',
      labels: ['agent:auto', 'agent:running'],
      expected: 'already-running: running label is present',
    },
    {
      scenario: 'discovery-blocked',
      labels: ['agent:auto', 'agent:blocked'],
      expected: 'blocked-label: blocked label is present',
    },
    {
      scenario: 'discovery-review',
      labels: ['agent:auto', 'agent:review'],
      expected: 'ready-for-review: review label is present',
    },
  ];

  const issues = [];
  for (const entry of cases) {
    issues.push({ entry, issue: await createIssue(context, entry.scenario, entry.labels) });
  }

  const status = await runPackagedCli(context, ['status', '--target', context.targetRoot, '--dry-run']);
  assert(eligibleLinesFromStatus(status.stdout).length === 0, `expected no eligible issues in discovery matrix\n${status.stdout}`);
  for (const { entry, issue } of issues) {
    assertIncludes(status.stdout, `#${issue.number} ${entry.expected}`, `status should show ${entry.scenario} skip reason`);
  }
}

async function runRealCodexScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true, codexMode: 'real' });
  const artifactName = `live-smoke-real-codex-${context.runId}.md`;
  const issue = await createIssue(
    context,
    'real-codex',
    ['agent:auto'],
    [
      'Real Codex live smoke. Make exactly one small documentation-only change.',
      '',
      `Create docs/${artifactName} with one short sentence that includes this issue number.`,
      'Do not edit runtime source files.',
      'Do not run publish, deploy, push, gh pr create, or gh issue mutation commands.',
      'Write the required completion report with status completed, the changed docs path, passed validation evidence, empty skippedChecks, empty residualRisks, and empty prohibitedActions.',
    ].join('\n'),
  );
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false });
  const pullRequest = await findPullRequestByBranch(context, `codex/issue-${issue.number}`);
  const body = await getPullRequestBody(context, pullRequest.number);
  assertIncludes(body, `docs/${artifactName}`, 'real Codex PR should include the requested docs artifact');
}

async function runRemoteBaseBranchScenario(context) {
  const remoteBase = await createRemoteBaseBranch(context);
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    baseBranch: { mode: 'explicit', remote: 'origin', branch: remoteBase.branchName },
  });

  const issue = await createIssue(
    context,
    'remote-base-branch',
    ['agent:auto'],
    `Remote base branch smoke. Codex PRs must target ${remoteBase.branchName}.`,
  );
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, {
    expectLocalCommit: false,
    expectedBaseBranch: remoteBase.branchName,
    expectedBaseSha: remoteBase.sha,
    expectedBaseMarkerPath: remoteBase.markerPath,
  });
}

async function runScopedRunnerCommitScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const issue = await createIssue(context, 'scoped-runner-commit', ['agent:auto']);
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false });
}

async function runCommitPolicyScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const accepted = await createIssue(context, 'scoped-local-commit', ['agent:auto']);
  await runDaemonOnce(context, accepted.number, 'scoped-issue');
  await assertScopedSuccess(context, accepted.number, { expectLocalCommit: true });

  await configureTarget(context, { allowAgentLocalCommits: false });
  const blocked = await createIssue(
    context,
    'scoped-local-commit',
    ['agent:auto'],
    'This scenario should block because local commits are disabled.',
  );
  await runDaemonOnce(context, blocked.number, 'scoped-issue');
  await assertBlockedIssue(context, blocked.number, 'Codex changed git HEAD');
  await assertNoPullRequestForBranch(context, `codex/issue-${blocked.number}`);
}

async function runDirectScopedScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const issue = await createIssue(context, 'scoped-runner-commit', ['agent:auto'], 'Direct run smoke for scoped issue.');
  await runDirectIssue(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false });
}

async function runLoopPolicyScenario(context) {
  const loopPolicy = {
    issueSelection: {
      priorityLabels: ['priority:loop'],
      tieBreaker: 'issue-number-asc',
    },
    rework: {
      maxAttempts: 1,
      retryableBlockers: [
        'missing-completion-report',
        'invalid-completion-report',
        'no-changed-files',
        'failed-configured-checks',
        'missing-quality-gate-evidence',
      ],
    },
    freshContextReview: {
      enabled: true,
      mode: 'advisory',
      blockOnHighConfidencePolicyViolations: true,
    },
    durableRunSummaries: {
      enabled: true,
    },
    policySuggestions: {
      enabled: true,
      maxSuggestions: 5,
    },
  };
  await configureTarget(context, { allowAgentLocalCommits: true, loopPolicy });

  const lowerPriority = await createIssue(
    context,
    'loop-policy-lower-priority',
    ['agent:auto'],
    'Lower-priority issue used to prove daemon priority selection.',
  );
  const selected = await createIssue(
    context,
    'loop-policy-rework',
    ['agent:auto', 'priority:loop'],
    'Higher-priority Loop Policy issue. The fake agent intentionally needs one bounded rework attempt.',
    { skipNoEligibleCheck: true },
  );

  const status = await runPackagedCli(context, ['status', '--target', context.targetRoot, '--dry-run']);
  const eligible = eligibleLinesFromStatus(status.stdout);
  assert(
    eligible.some((line) => line.startsWith(`  - #${lowerPriority.number} scoped-issue:`))
      && eligible.some((line) => line.startsWith(`  - #${selected.number} scoped-issue:`)),
    `expected both loop-policy priority candidates to be eligible\n${status.stdout}`,
  );
  const daemon = await runPackagedCli(context, ['daemon', '--target', context.targetRoot, '--once', '--max-runs', '1']);
  assertIncludes(daemon.stdout, `running #${selected.number} scoped-issue`, 'daemon should select the configured priority issue');
  assert(!daemon.stdout.includes(`running #${lowerPriority.number} scoped-issue`), 'daemon should not select lower-priority issue first');
  assertIncludes(daemon.stdout, 'selection: priority priority:loop, tie-breaker issue-number-asc', 'daemon should report priority selection policy');
  await assertScopedSuccess(context, selected.number, {
    expectLocalCommit: false,
    expectLoopPolicyEvidence: true,
  });
  await closeIssue(context, lowerPriority.number, 'lower-priority Loop Policy candidate was intentionally not executed');

  await configureTarget(context, { allowAgentLocalCommits: true, loopPolicy });
  const parent = await createIssue(
    context,
    'plan-auto',
    ['agent:plan-auto'],
    'Loop Policy issue-tree compatibility smoke.',
  );
  await runDaemonOnce(context, parent.number, 'plan-parent');
  await assertPlanAutoSuccess(context, parent.number, { expectLoopPolicyEvidence: true });
}

async function runIncompleteProgressReworkScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    loopPolicy: {
      rework: {
        maxAttempts: 1,
        retryableBlockers: [
          'missing-completion-report',
          'idle-timeout-before-change',
          'incomplete-after-progress',
          'invalid-completion-report',
          'no-changed-files',
          'failed-configured-checks',
          'missing-quality-gate-evidence',
          'failed-acceptance-proof',
          'optional-figma-mcp-failure',
        ],
      },
      durableRunSummaries: {
        enabled: true,
      },
    },
  });
  const issue = await createIssue(
    context,
    'incomplete-progress-rework',
    ['agent:auto'],
    'Fake Codex writes safe local progress, exits with exact idle timeout, omits the completion report, then finishes on the bounded rework attempt.',
  );
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false });

  const pullRequest = await findPullRequestByBranch(context, `codex/issue-${issue.number}`);
  assert(pullRequest, `expected draft PR for codex/issue-${issue.number}`);
  const body = await getPullRequestBody(context, pullRequest.number);
  assertIncludes(body, 'rework attempts: 1', 'incomplete-progress PR should include bounded rework evidence');
  const summaryPath = body.match(/Durable Run Summary:\n- ([^\n]+\.json)/)?.[1];
  assert(summaryPath, 'incomplete-progress PR should link a durable run summary JSON file');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  assert(
    JSON.stringify(summary.reworkAttempts ?? []).includes('Codex idle timed out after safe local progress'),
    'durable summary should preserve the incomplete-progress sentinel reason',
  );
  await appendReport(context, `Incomplete-progress rework issue #${issue.number} reached review after one retry.\n\n`);
}

async function runReportRepairScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    loopPolicy: {
      durableRunSummaries: {
        enabled: true,
      },
    },
  });

  const missingReport = await createIssue(
    context,
    'completion-report-repair',
    ['agent:auto'],
    'Fake Codex writes safe code and omits the completion report; runner should repair only CODEX_ORCHESTRATOR_REPORT_FILE and publish after normal gates rerun.',
  );
  await runDaemonOnce(context, missingReport.number, 'scoped-issue');
  await assertScopedSuccess(context, missingReport.number, {
    expectLocalCommit: false,
    expectRepairAttemptKind: 'completion-report',
  });

  const missingEvidence = await createIssue(
    context,
    'evidence-repair',
    ['agent:auto'],
    'Fake Codex writes a valid report with missing code-review evidence; runner should repair only report evidence and publish after review gates rerun.',
  );
  await runDaemonOnce(context, missingEvidence.number, 'scoped-issue');
  await assertScopedSuccess(context, missingEvidence.number, {
    expectLocalCommit: false,
    expectRepairAttemptKind: 'evidence',
  });

  await appendReport(
    context,
    `Report repair issues #${missingReport.number} and #${missingEvidence.number} reached review with repair attempt evidence.\n\n`,
  );
}

async function runDiagnosticsScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    codexCommand: process.execPath,
    codexArgs: ['-e', 'process.exit(7)'],
    codexProfiles: {
      'scoped-issue': {
        command: process.execPath,
        args: [context.fakeAgentPath],
        timeoutMs: 120_000,
        idleTimeoutMs: 30_000,
        env: {
          CODEX_ORCHESTRATOR_LIVE_SMOKE_PHASE: 'scoped-issue',
        },
      },
    },
    loopPolicy: {
      freshContextReview: {
        enabled: false,
      },
    },
  });
  const doctor = await runPackagedCli(context, ['doctor', '--target', context.targetRoot, '--json']);
  const doctorJson = JSON.parse(doctor.stdout);
  assert(doctorJson.summary.fail === 0, `doctor should pass diagnostics readiness\n${doctor.stdout}`);

  const issue = await createIssue(context, 'diagnostics', ['agent:auto']);
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false });

  const status = await runPackagedCli(context, ['status', '--target', context.targetRoot, '--json']);
  const statusJson = JSON.parse(status.stdout);
  const recentEvents = statusJson.recentEvents ?? [];
  assert(recentEvents.length > 0, 'status --json should include recent lifecycle events');
  const snapshotArtifact = recentEvents.flatMap((event) => event.artifacts ?? []).find((artifact) => artifact.kind === 'snapshot');
  assert(snapshotArtifact?.path, `expected snapshot artifact in recent events\n${status.stdout}`);
  await assertPathExists(snapshotArtifact.path, 'diagnostics context snapshot should exist');
  await appendReport(context, `Diagnostics snapshot: ${snapshotArtifact.path}\n\n`);
}

async function runBrowserProofScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    acceptanceRunnerValidationCommand: `${process.execPath} ${JSON.stringify(context.browserProofPath)}`,
  });
  const issue = await createIssue(
    context,
    'browser-proof',
    ['agent:auto'],
    [
      'ACCEPTANCE_PROOF_LIVE_SMOKE: browser-proof. This should exercise visual-proof auto through package-owned browser proof.',
      'Acceptance Criteria:',
      '- Browser proof navigates to the live smoke web page.',
      '- Browser proof captures screenshot and DOM evidence mapped to this criterion.',
      '- Browser proof report satisfies the UI Evidence Contract.',
    ].join('\n'),
  );
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false, expectBrowserProof: true });
}

async function runAcceptanceProofPositiveScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    acceptanceRunnerValidationCommand: `${process.execPath} ${JSON.stringify(context.acceptanceProofPath)} pass`,
  });
  const issue = await createIssue(
    context,
    'acceptance-proof',
    ['agent:auto'],
    'ACCEPTANCE_PROOF_LIVE_SMOKE: pass. This should trigger canonical acceptance proof with a machine-readable report.',
  );
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false, expectAcceptanceProof: true });

  await configureTarget(context, {
    allowAgentLocalCommits: true,
    acceptanceRunnerValidationCommand: `${process.execPath} ${JSON.stringify(context.acceptanceProofPath)} pass-ui`,
  });
  const uiEvidence = await createIssue(
    context,
    'acceptance-proof-ui-evidence',
    ['agent:auto'],
    [
      'ACCEPTANCE_PROOF_LIVE_SMOKE: pass-ui. This should trigger canonical UI Evidence Contract validation.',
      'Acceptance Criteria:',
      '- Desktop layout proof uses a wide viewport and current screenshot artifact.',
      '- Copy proof verifies the live smoke heading is visible and no implementation-only placeholder term is visible.',
      'Manual QA Plan:',
      '- Open the live smoke UI route after the implementation run and inspect the final screen.',
    ].join('\n'),
  );
  await runDaemonOnce(context, uiEvidence.number, 'scoped-issue');
  await assertScopedSuccess(context, uiEvidence.number, {
    expectLocalCommit: false,
    expectAcceptanceProof: true,
    expectUiEvidenceProof: true,
  });
}

async function runProofStrategyNonVisualSmokeScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    acceptanceRunnerValidationCommand: `${process.execPath} ${JSON.stringify(context.acceptanceProofPath)} pass`,
  });
  const issue = await createIssue(
    context,
    'proof-strategy-non-visual-smoke',
    ['agent:auto'],
    [
      'Proof Strategy: non-visual-smoke',
      'ACCEPTANCE_PROOF_LIVE_SMOKE: pass. This marker would normally trigger runner-owned acceptance proof.',
      'Acceptance Criteria:',
      '- Non-visual smoke proof records event-dispatch behavior through tests and machine-readable output.',
      '- Browser, screenshot, emulator, simulator, and device-backed proof are not required for this issue.',
    ].join('\n'),
  );
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, {
    expectLocalCommit: false,
    expectNonVisualSmokeProof: true,
    forbidRunnerAcceptanceProof: true,
  });
}

async function runAcceptanceProofReworkScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    acceptanceRunnerValidationCommand: `${process.execPath} ${JSON.stringify(context.acceptanceProofPath)} rework`,
  });
  const issue = await createIssue(
    context,
    'acceptance-proof-rework',
    ['agent:auto'],
    'ACCEPTANCE_PROOF_LIVE_SMOKE: rework. The first proof attempt should fail, then implementation rework should satisfy the proof.',
  );
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false, expectAcceptanceProof: true });
}

async function runAcceptanceProofNegativeScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    acceptanceRunnerValidationCommand: `${process.execPath} ${JSON.stringify(context.acceptanceProofPath)} low-confidence`,
    acceptanceProof: { maxIterations: 1 },
  });
  const lowConfidence = await createIssue(
    context,
    'acceptance-proof-low-confidence',
    ['agent:auto'],
    'ACCEPTANCE_PROOF_LIVE_SMOKE: low-confidence. This should block because the proof report is not high confidence.',
  );
  await runDaemonOnce(context, lowConfidence.number, 'scoped-issue');
  await assertBlockedIssue(context, lowConfidence.number, 'Acceptance proof criterion ac-live-smoke has confidence medium');
  await assertNoPullRequestForBranch(context, `codex/issue-${lowConfidence.number}`);
  await assertNoRemoteBranch(context, `codex/issue-${lowConfidence.number}`);

  await configureTarget(context, {
    allowAgentLocalCommits: true,
    acceptanceRunnerValidationCommand: `${process.execPath} ${JSON.stringify(context.acceptanceProofPath)} product-diff`,
    acceptanceProof: { maxIterations: 1 },
  });
  const productDiff = await createIssue(
    context,
    'acceptance-proof-product-diff',
    ['agent:auto'],
    'ACCEPTANCE_PROOF_LIVE_SMOKE: product-diff. This should block because proof edits product code.',
  );
  await runDaemonOnce(context, productDiff.number, 'scoped-issue');
  await assertBlockedIssue(context, productDiff.number, 'Acceptance proof produced product-code changes during acceptance proof');
  await assertNoPullRequestForBranch(context, `codex/issue-${productDiff.number}`);
  await assertNoRemoteBranch(context, `codex/issue-${productDiff.number}`);

  await configureTarget(context, {
    allowAgentLocalCommits: true,
    acceptanceRunnerValidationCommand: `${process.execPath} ${JSON.stringify(context.acceptanceProofPath)} missing-ui-evidence`,
    acceptanceProof: { maxIterations: 1 },
  });
  const missingUiEvidence = await createIssue(
    context,
    'acceptance-proof-ui-evidence-missing',
    ['agent:auto'],
    'ACCEPTANCE_PROOF_LIVE_SMOKE: missing-ui-evidence. This should block because screenshot proof has no UI Evidence Contract.',
  );
  await runDaemonOnce(context, missingUiEvidence.number, 'scoped-issue');
  await assertBlockedIssue(
    context,
    missingUiEvidence.number,
    'UI Evidence workflow: UI artifacts require a complete UI Evidence Contract.',
  );
  await assertNoPullRequestForBranch(context, `codex/issue-${missingUiEvidence.number}`);
  await assertNoRemoteBranch(context, `codex/issue-${missingUiEvidence.number}`);

  await configureTarget(context, {
    allowAgentLocalCommits: true,
    acceptanceRunnerValidationCommand: `${process.execPath} ${JSON.stringify(context.acceptanceProofPath)} narrow-ui-viewport`,
    acceptanceProof: { maxIterations: 1 },
  });
  const narrowViewport = await createIssue(
    context,
    'acceptance-proof-ui-evidence-narrow-viewport',
    ['agent:auto'],
    'ACCEPTANCE_PROOF_LIVE_SMOKE: narrow-ui-viewport. This should block because desktop UI proof is not wide enough.',
  );
  await runDaemonOnce(context, narrowViewport.number, 'scoped-issue');
  await assertBlockedIssue(
    context,
    narrowViewport.number,
    'UI Evidence viewport: desktop-web-layout viewport width must be at least 1280.',
  );
  await assertNoPullRequestForBranch(context, `codex/issue-${narrowViewport.number}`);
  await assertNoRemoteBranch(context, `codex/issue-${narrowViewport.number}`);
}

async function runQualityGatesScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const cases = [
    {
      scenario: 'quality-missing-tdd',
      expected: 'Quality gate requires TDD red-to-green proof',
    },
    {
      scenario: 'quality-missing-code-review',
      expected: 'Quality gate requires passed code-review validation',
    },
    {
      scenario: 'quality-missing-cleanup-review',
      expected: 'Quality gate requires passed cleanup-review validation',
    },
  ];

  for (const entry of cases) {
    const issue = await createIssue(context, entry.scenario, ['agent:auto']);
    await runDaemonOnce(context, issue.number, 'scoped-issue');
    await assertBlockedIssue(context, issue.number, entry.expected);
    await assertNoPullRequestForBranch(context, `codex/issue-${issue.number}`);
    await assertNoRemoteBranch(context, `codex/issue-${issue.number}`);
  }
}

async function runRiskRoutingScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const issue = await createIssue(
    context,
    'risk-routing-plan-warning',
    ['agent:plan-auto'],
    'Risk-routing live smoke. Parent planning intentionally omits sizeRisk and parentReviewHandoff in warn mode.',
  );
  await runDaemonOnce(context, issue.number, 'plan-parent');
  await assertPlanAutoSuccess(context, issue.number);
  const branchName = `codex/tree-${issue.number}`;
  const pullRequest = await findPullRequestByBranch(context, branchName);
  const body = await getPullRequestBody(context, pullRequest.number);
  assertIncludes(body, 'Risk routing warnings', 'risk-routing PR body should include warning heading');
  assertIncludes(body, 'parent sizeRisk is required', 'risk-routing PR body should include parent size warning');
  assertIncludes(body, 'parentReviewHandoff is required', 'risk-routing PR body should include parent review warning');
  const parent = await getIssue(context, issue.number);
  assertIssueHasComment(parent, 'Risk routing warnings');
  await appendReport(context, `Risk-routing warning PR: ${pullRequest.url}\n\n`);
}

async function runSafetyNegativeScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true, additionalPathGlobs: ['live-smoke-denied/**'] });
  const denied = await createIssue(context, 'denied-secret', ['agent:auto']);
  await runDaemonOnce(context, denied.number, 'scoped-issue');
  await assertBlockedIssue(context, denied.number, 'matches denied pattern live-smoke-denied/**');
  await assertNoPullRequestForBranch(context, `codex/issue-${denied.number}`);

  await configureTarget(context, { allowAgentLocalCommits: true });
  const invalidReport = await createIssue(context, 'invalid-report', ['agent:auto']);
  await runDaemonOnce(context, invalidReport.number, 'scoped-issue');
  await assertBlockedIssue(context, invalidReport.number, 'report must be valid JSON');
  await assertNoPullRequestForBranch(context, `codex/issue-${invalidReport.number}`);
}

async function runPlanAutoScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const issue = await createIssue(context, 'plan-auto', ['agent:plan-auto']);
  await runDaemonOnce(context, issue.number, 'plan-parent');
  await assertPlanAutoSuccess(context, issue.number);
}

async function runDirectPlanAutoScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const issue = await createIssue(context, 'plan-auto', ['agent:plan-auto'], 'Direct run smoke for plan-auto parent.');
  await runDirectIssue(context, issue.number, 'plan-parent');
  await assertPlanAutoSuccess(context, issue.number);
}

async function runPlanAutoBlockingScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const malformed = await createIssue(context, 'plan-malformed-graph', ['agent:plan-auto']);
  await runDaemonOnce(context, malformed.number, 'plan-parent');
  await assertPlanBlockedIssue(context, malformed.number, 'graph.nodes must contain at least one child node');
  await assertNoPullRequestForBranch(context, `codex/tree-${malformed.number}`);
  await assertNoRemoteBranch(context, `codex/tree-${malformed.number}`);

  const mutating = await createIssue(context, 'plan-mutates-files', ['agent:plan-auto']);
  await runDaemonOnce(context, mutating.number, 'plan-parent');
  await assertPlanBlockedIssue(context, mutating.number, 'Planning session changed repository files');
  await assertNoPullRequestForBranch(context, `codex/tree-${mutating.number}`);
  await assertNoRemoteBranch(context, `codex/tree-${mutating.number}`);

  const arbitrary = await createIssue(context, 'plan-arbitrary-existing-child-target', ['agent:manual']);
  const parent = await createIssue(
    context,
    'plan-arbitrary-existing-issue',
    ['agent:plan-auto'],
    `LIVE_SMOKE_ARBITRARY_ISSUE: ${arbitrary.number}`,
  );
  await runDaemonOnce(context, parent.number, 'plan-parent');
  await assertPlanBlockedIssue(context, parent.number, 'refusing to update arbitrary issue');
  await assertNoPullRequestForBranch(context, `codex/tree-${parent.number}`);
  await assertNoRemoteBranch(context, `codex/tree-${parent.number}`);
}

async function runTreeChildQualityReworkScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    loopPolicy: {
      rework: {
        maxAttempts: 1,
      },
    },
  });
  const issue = await createIssue(
    context,
    'plan-quality-rework',
    ['agent:plan-auto'],
    'Tree-child quality rework live smoke. Child attempt 0 intentionally misses structured TDD evidence; attempt 1 fixes it.',
  );
  await runDaemonOnce(context, issue.number, 'plan-parent');

  const parent = await getIssue(context, issue.number);
  assertHasLabel(parent, 'agent:review');
  assertMissingLabel(parent, 'agent:blocked');
  assertIssueHasComment(parent, `codex-orchestrator issue-tree review report for #${issue.number}`);

  const branchName = `codex/tree-${issue.number}`;
  context.createdBranches.push(branchName);
  await assertRemoteBranchExists(context, branchName);
  const pullRequest = await findPullRequestByBranch(context, branchName);
  assert(pullRequest, `expected draft PR for ${branchName}`);
  context.createdPullRequests.push(pullRequest.number);
  const body = await getPullRequestBody(context, pullRequest.number);
  assertIncludes(body, 'Child loop outcomes:', 'tree-child quality rework PR should include child loop outcomes');

  const childIssues = await listIssuesByRunId(context);
  const child = childIssues.find((entry) => entry.title.includes('quality rework child'));
  assert(child, 'expected quality rework child issue to be created');
  context.createdIssues.push(child.number);
  assertHasLabel(child, 'agent:child');
  assertHasLabel(child, 'agent:review');
  assertMissingLabel(child, 'agent:blocked');
  assertIssueHasComment(child, 'codex-orchestrator child review report');
  assertIssueHasComment(child, 'rework attempts: 1');
  assertIssueHasComment(parent, 'codex-orchestrator issue-tree review report');
}

async function runPlanAutoTreeRecoveryScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    loopPolicy: {
      rework: {
        maxAttempts: 1,
      },
      durableRunSummaries: {
        enabled: true,
      },
    },
  });

  const parent = await createIssue(
    context,
    'plan-tree-recovery',
    ['agent:plan-auto'],
    'Plan-auto tree recovery live smoke. The harness prepares stale runner-owned parent state, one closed recovered child, and one retryable blocked child.',
  );
  const recoveredChild = await createIssue(
    context,
    'plan-tree-recovery-recovered-child',
    ['agent:child'],
    autonomousChildBody({
      parentIssueNumber: parent.number,
      stableId: 'live-smoke-recovered',
      body: 'Recovered child already merged before parent resume.',
      ownership: ['src/live-smoke/recovered-child.ts'],
      verification: ['live smoke recovered child validation'],
    }),
    { skipNoEligibleCheck: true },
  );
  const blockedChild = await createIssue(
    context,
    'plan-tree-recovery-blocked-child',
    ['agent:child'],
    autonomousChildBody({
      parentIssueNumber: parent.number,
      stableId: 'live-smoke-blocked-rework',
      body: [
        'Blocked child should resume through automatic rework.',
        '',
        `LIVE_SMOKE_RUN_ID: ${context.runId}`,
        'LIVE_SMOKE_SCENARIO: plan-child-quality-rework',
        'LIVE_SMOKE_CHILD_ID: tree-recovery-rework',
      ].join('\n'),
      dependsOn: ['live-smoke-recovered'],
      ownership: [
        'src/live-smoke/issue-owned-by-child-tree-recovery-rework.ts',
        'test/live-smoke/issue-owned-by-child-tree-recovery-rework.test.ts',
      ],
      verification: ['live smoke retryable blocked child recovery validation'],
    }),
    { skipNoEligibleCheck: true },
  );

  await closeIssue(context, recoveredChild.number, 'completed child recovery fixture');
  await runCommand('gh', [
    'issue',
    'edit',
    String(blockedChild.number),
    '--repo',
    context.repo,
    '--add-label',
    'agent:blocked',
  ], { timeoutMs: context.options.timeoutMs });
  await runCommand('gh', [
    'issue',
    'edit',
    String(parent.number),
    '--repo',
    context.repo,
    '--add-label',
    'agent:running',
  ], { timeoutMs: context.options.timeoutMs });

  const recoveryFixture = await preparePlanAutoTreeRecoveryFixture(context, {
    parentIssueNumber: parent.number,
    recoveredChildIssueNumber: recoveredChild.number,
    blockedChildIssueNumber: blockedChild.number,
  });
  await appendReport(context, `Prepared plan-auto tree recovery fixture at ${recoveryFixture.parentWorktreePath}\n\n`);

  const result = await runPackagedCli(context, ['run', '--target', context.targetRoot, '--issue', String(parent.number)]);
  assertIncludes(result.stdout, `codex-orchestrator issue-tree review report for #${parent.number}`, 'direct recovery run should print parent review report');

  const updatedParent = await getIssue(context, parent.number);
  assertHasLabel(updatedParent, 'agent:review');
  assertMissingLabel(updatedParent, 'agent:running');
  assertMissingLabel(updatedParent, 'agent:blocked');
  assertIssueHasComment(updatedParent, `codex-orchestrator issue-tree review report for #${parent.number}`);

  const branchName = `codex/tree-${parent.number}`;
  context.createdBranches.push(branchName);
  await assertRemoteBranchExists(context, branchName);
  const pullRequest = await findPullRequestByBranch(context, branchName);
  assert(pullRequest, `expected draft PR for ${branchName}`);
  context.createdPullRequests.push(pullRequest.number);
  const body = await getPullRequestBody(context, pullRequest.number);
  assertIncludes(body, 'recovered from durable summary', 'tree recovery PR should show recovered child evidence');
  assertIncludes(body, `#${recoveredChild.number}`, 'tree recovery PR should identify the recovered child');
  assertIncludes(body, `#${blockedChild.number}`, 'tree recovery PR should identify the resumed child');
  assertIncludes(body, 'tree-child quality rework structured TDD', 'tree recovery PR should show blocked child rework validation evidence');
  assertIncludes(body, 'attempt-1', 'tree recovery PR should link the resumed child attempt-1 log');

  const recovered = await getIssue(context, recoveredChild.number);
  assert(recovered.state === 'CLOSED', `expected recovered child #${recoveredChild.number} to remain closed`);
  assertHasLabel(recovered, 'agent:child');
  assertMissingLabel(recovered, 'agent:running');
  assertMissingLabel(recovered, 'agent:blocked');

  const resumed = await getIssue(context, blockedChild.number);
  assertHasLabel(resumed, 'agent:child');
  assertHasLabel(resumed, 'agent:review');
  assertMissingLabel(resumed, 'agent:blocked');
  assertMissingLabel(resumed, 'agent:running');
  assertIssueHasComment(resumed, 'codex-orchestrator child review report');
  assertIssueHasComment(resumed, 'tree-child quality rework structured TDD');
  assertIssueHasComment(resumed, 'attempt-1');
}

async function assertPlanAutoSuccess(context, issueNumber, { expectLoopPolicyEvidence = false } = {}) {
  const parent = await getIssue(context, issueNumber);
  assertHasLabel(parent, 'agent:review');
  assertMissingLabel(parent, 'agent:running');
  assertIssueHasComment(parent, `codex-orchestrator issue-tree review report for #${issueNumber}`);

  const branchName = `codex/tree-${issueNumber}`;
  context.createdBranches.push(branchName);
  await assertRemoteBranchExists(context, branchName);
  const pullRequest = await findPullRequestByBranch(context, branchName);
  assert(pullRequest, `expected draft PR for ${branchName}`);
  assert(pullRequest.isDraft === true, `expected ${branchName} PR to be a draft`);
  context.createdPullRequests.push(pullRequest.number);
  const body = await getPullRequestBody(context, pullRequest.number);
  assertIncludes(body, 'Child loop outcomes:', 'issue-tree PR body should include child loop outcome evidence');
  assertIncludes(body, 'Auto-merge is disabled.', 'issue-tree PR body should preserve runner-owned publication boundary');
  if (expectLoopPolicyEvidence) {
    assertIncludes(body, 'outcome: review-ready', 'issue-tree PR should include child durable outcome evidence');
  }

  const childIssues = await listIssuesByRunId(context);
  const children = childIssues.filter((child) => child.title.includes('plan child'));
  assert(children.length >= 3, `expected at least 3 plan child issues, got ${children.length}`);
  for (const child of children) {
    context.createdIssues.push(child.number);
    assertHasLabel(child, 'agent:child');
    assertHasLabel(child, 'agent:review');
    assertIssueHasComment(child, 'codex-orchestrator child review report');
  }
}

async function runDirectIssue(context, issueNumber, mode) {
  await assertOnlyEligibleIssue(context, issueNumber, mode);
  const result = await runPackagedCli(context, ['run', '--target', context.targetRoot, '--issue', String(issueNumber)]);
  const expectedHeading = mode === 'plan-parent'
    ? `codex-orchestrator issue-tree review report for #${issueNumber}`
    : `codex-orchestrator review report for #${issueNumber}`;
  assertIncludes(result.stdout, expectedHeading, `direct run should print ${mode} report`);
}

async function runDaemonOnce(context, issueNumber, mode) {
  await assertOnlyEligibleIssue(context, issueNumber, mode);
  let lastResult;
  let lastOutput = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      lastResult = await runPackagedCli(context, ['daemon', '--target', context.targetRoot, '--once', '--max-runs', '1']);
      lastOutput = lastResult.stdout;
    } catch (error) {
      lastOutput = error instanceof Error ? error.message : String(error);
      if (!isTransientCommandOutput(lastOutput) || attempt >= 3) {
        throw error;
      }
      await appendReport(context, `Daemon transient failure for #${issueNumber}; retrying attempt ${attempt + 1}.\n\n`);
      await sleep(1000 * attempt);
      continue;
    }
    assertIncludes(lastResult.stdout, `running #${issueNumber} ${mode}`, `daemon should pick issue #${issueNumber}`);
    if (lastResult.stdout.includes(`completed #${issueNumber}`)) {
      return;
    }
    if (!isTransientCommandOutput(lastResult.stdout)) {
      break;
    }
    await appendReport(context, `Daemon transient failure for #${issueNumber}; retrying attempt ${attempt + 1}.\n\n`);
    await sleep(1000 * attempt);
  }
  assertIncludes(lastOutput, `completed #${issueNumber}`, `daemon should complete issue #${issueNumber}`);
}

async function createIssue(context, scenario, labels, extraBody = '', options = {}) {
  if (!options.skipNoEligibleCheck) {
    await assertNoEligibleIssues(context);
  }
  const title = `[live-smoke:${context.runId}] ${scenario}`;
  const body = [
    'Live smoke issue created by scripts/live-smoke.mjs.',
    '',
    `LIVE_SMOKE_RUN_ID: ${context.runId}`,
    `LIVE_SMOKE_SCENARIO: ${scenario}`,
    '',
    extraBody,
  ].join('\n');
  const args = ['issue', 'create', '--repo', context.repo, '--title', title, '--body', body];
  for (const label of labels) {
    args.push('--label', label);
  }
  const result = await runCommand('gh', args, { timeoutMs: context.options.timeoutMs });
  const match = result.stdout.match(/\/issues\/(\d+)/);
  if (!match) {
    throw new Error(`Could not parse created issue number from: ${result.stdout}`);
  }
  const issueNumber = Number(match[1]);
  context.createdIssues.push(issueNumber);
  await appendReport(context, `Created issue #${issueNumber}: ${title}\n\n`);
  return getIssue(context, issueNumber);
}

function autonomousChildBody({
  parentIssueNumber,
  stableId,
  body,
  dependsOn = [],
  ownership,
  verification,
}) {
  return [
    `<!-- codex-orchestrator:autonomous-child parent=#${parentIssueNumber} -->`,
    body,
    '',
    '## codex-orchestrator metadata',
    `Stable ID: ${stableId}`,
    'AFK/HITL: afk',
    `Depends on: ${dependsOn.length > 0 ? dependsOn.join(', ') : 'none'}`,
    'Ownership:',
    ...ownership.map((entry) => `- ${entry}`),
    'Spec gate: wave-level',
    'Verification:',
    ...verification.map((entry) => `- ${entry}`),
  ].join('\n');
}

async function assertScopedSuccess(
  context,
  issueNumber,
  {
    expectLocalCommit,
    expectAcceptanceProof = false,
    expectLoopPolicyEvidence = false,
    expectedBaseBranch,
    expectedBaseSha,
    expectedBaseMarkerPath,
    expectUiEvidenceProof = false,
    expectBrowserProof = false,
    expectNonVisualSmokeProof = false,
    forbidRunnerAcceptanceProof = false,
    expectRepairAttemptKind,
  },
) {
  const issue = await getIssue(context, issueNumber);
  assertHasLabel(issue, 'agent:review');
  assertMissingLabel(issue, 'agent:running');
  assertIssueHasComment(issue, `codex-orchestrator review report for #${issueNumber}`);
  if (expectLoopPolicyEvidence) {
    assertIssueHasComment(issue, 'Fresh-Context Review');
    assertIssueHasComment(issue, 'Durable Run Summary');
    assertIssueHasComment(issue, 'policy suggestions: Non-mutating recommendation');
  }

  const branchName = `codex/issue-${issueNumber}`;
  context.createdBranches.push(branchName);
  await assertRemoteBranchExists(context, branchName);
  const pullRequest = await findPullRequestByBranch(context, branchName);
  assert(pullRequest, `expected draft PR for ${branchName}`);
  assert(pullRequest.isDraft === true, `expected ${branchName} PR to be a draft`);
  if (expectedBaseBranch) {
    assert(
      pullRequest.baseRefName === expectedBaseBranch,
      `expected ${branchName} PR base branch ${expectedBaseBranch}, got ${pullRequest.baseRefName}`,
    );
  }
  context.createdPullRequests.push(pullRequest.number);
  const body = await getPullRequestBody(context, pullRequest.number);
  assertIncludes(body, `Closes #${issueNumber}`, 'PR body should link issue');
  assertIncludes(body, 'Validation', 'PR body should include validation evidence');
  assertIncludes(body, 'Log', 'PR body should include log evidence');
  if (expectLoopPolicyEvidence) {
    assertIncludes(body, 'Fresh-Context Review:', 'PR body should include Fresh-Context Review evidence');
    assertIncludes(body, 'Durable Run Summary:', 'PR body should include Durable Run Summary evidence');
    assertIncludes(body, 'policy suggestions: Non-mutating recommendation', 'PR body should include non-mutating Policy Suggestions');
  }
  if (expectRepairAttemptKind) {
    assertIncludes(body, 'Repair Attempts', 'PR body should include repair attempt evidence');
    assertIncludes(body, `- ${expectRepairAttemptKind}: passed`, `PR body should include ${expectRepairAttemptKind} repair status`);
    assertIssueHasComment(issue, `Repair ${expectRepairAttemptKind}: passed`);
  }
  if (expectLocalCommit) {
    assertIncludes(body.toLowerCase(), 'local commits', 'PR body should include local commit summary');
    assertIncludes(body, 'Live smoke agent checkpoint', 'PR body should include fake agent commit');
    const log = await gitOutput(context.targetRoot, ['log', '--oneline', `origin/${branchName}`, '-5']);
    assertIncludes(log, 'Live smoke agent checkpoint', 'remote branch should include fake agent commit');
  }
  if (expectAcceptanceProof) {
    assertIncludes(body, 'runner acceptance proof passed', 'PR body should include acceptance proof validation evidence');
    assertIncludes(body, `.codex-orchestrator/proofs/issue-${issueNumber}/live-smoke-proof.txt`, 'PR body should link acceptance proof artifact path');
    const proofPath = join(
      context.targetRoot,
      '.codex-orchestrator',
      'workspaces',
      `live-smoke-${context.runId}`,
      `issue-${issueNumber}`,
      '.codex-orchestrator',
      'proofs',
      `issue-${issueNumber}`,
      'live-smoke-proof.txt',
    );
    await assertPathExists(proofPath, 'runner acceptance proof artifact was not written');
    await appendReport(context, `Acceptance proof artifact: ${proofPath}\n\n`);
  }
  if (forbidRunnerAcceptanceProof) {
    assert(
      !body.includes('runner acceptance proof passed'),
      'PR body should not include runner acceptance proof validation when proof strategy is non-visual-smoke',
    );
    assert(
      !body.includes(`.codex-orchestrator/proofs/issue-${issueNumber}/live-smoke-proof.txt`),
      'PR body should not link runner-owned acceptance proof artifact when proof strategy is non-visual-smoke',
    );
  }
  if (expectNonVisualSmokeProof) {
    assertIncludes(body, `.codex-orchestrator/proofs/issue-${issueNumber}/non-visual-smoke-proof.txt`, 'PR body should link child non-visual smoke proof artifact path');
    const proofPath = join(
      context.targetRoot,
      '.codex-orchestrator',
      'workspaces',
      `live-smoke-${context.runId}`,
      `issue-${issueNumber}`,
      '.codex-orchestrator',
      'proofs',
      `issue-${issueNumber}`,
      'non-visual-smoke-proof.txt',
    );
    await assertPathExists(proofPath, 'child non-visual smoke proof artifact was not written');
    await appendReport(context, `Non-visual smoke proof artifact: ${proofPath}\n\n`);
  }
  if (expectUiEvidenceProof) {
    assertIncludes(body, `.codex-orchestrator/proofs/issue-${issueNumber}/live-smoke-ui-screenshot.png`, 'PR body should link UI Evidence screenshot artifact path');
    const screenshotPath = join(
      context.targetRoot,
      '.codex-orchestrator',
      'workspaces',
      `live-smoke-${context.runId}`,
      `issue-${issueNumber}`,
      '.codex-orchestrator',
      'proofs',
      `issue-${issueNumber}`,
      'live-smoke-ui-screenshot.png',
    );
    await assertPathExists(screenshotPath, 'runner UI Evidence screenshot was not written');
    await appendReport(context, `UI Evidence screenshot: ${screenshotPath}\n\n`);
  }
  if (expectBrowserProof) {
    assertIncludes(body, 'runner acceptance proof passed', 'PR body should include browser proof validation evidence');
    assertIncludes(body, `.codex-orchestrator/proofs/issue-${issueNumber}/browser-live-smoke-screenshot.png`, 'PR body should link browser screenshot artifact path');
    assertIncludes(body, `.codex-orchestrator/proofs/issue-${issueNumber}/browser-live-smoke-dom.html`, 'PR body should link browser DOM artifact path');
    assertIncludes(body, `.codex-orchestrator/proofs/issue-${issueNumber}/browser-summary.json`, 'PR body should link browser summary artifact path');
    const proofRoot = join(
      context.targetRoot,
      '.codex-orchestrator',
      'workspaces',
      `live-smoke-${context.runId}`,
      `issue-${issueNumber}`,
      '.codex-orchestrator',
      'proofs',
      `issue-${issueNumber}`,
    );
    await assertPathExists(join(proofRoot, 'browser-live-smoke-screenshot.png'), 'browser proof screenshot was not written');
    await assertPathExists(join(proofRoot, 'browser-live-smoke-dom.html'), 'browser proof DOM snapshot was not written');
    await assertPathExists(join(proofRoot, 'browser-summary.json'), 'browser proof run summary was not written');
    await appendReport(context, `Browser proof artifacts: ${proofRoot}\n\n`);
  }
  if (expectedBaseSha) {
    await fetchRemoteBranch(context, branchName);
    await runCommand('git', ['-C', context.targetRoot, 'merge-base', '--is-ancestor', expectedBaseSha, `origin/${branchName}`], {
      timeoutMs: context.options.timeoutMs,
    });
  }
  if (expectedBaseMarkerPath) {
    const marker = await gitOutput(context.targetRoot, ['show', `origin/${branchName}:${expectedBaseMarkerPath}`]);
    assertIncludes(marker, context.runId, 'remote issue branch should include marker from configured remote base');
  }
  if (expectedBaseBranch || expectedBaseSha) {
    const snapshot = await readSnapshotForIssue(context, issueNumber);
    const repository = snapshot.repository ?? {};
    if (expectedBaseBranch) {
      assert(repository.baseBranch === expectedBaseBranch, 'snapshot should record PR base branch');
      assert(repository.base?.remote === 'origin', 'snapshot should record base remote');
      assert(repository.base?.branch === expectedBaseBranch, 'snapshot should record resolved base branch');
      assert(repository.base?.ref === `refs/remotes/origin/${expectedBaseBranch}`, 'snapshot should record resolved remote ref');
    }
    if (expectedBaseSha) {
      assert(repository.base?.sha === expectedBaseSha, 'snapshot should record resolved base SHA');
    }
  }
  await assertLogFileExists(context, issueNumber);
  await assertRunStateCleared(context, issueNumber);
}

async function closeIssue(context, issueNumber, reason) {
  const { closeIssueWithEvidence } = await importIssueHelpers(context);
  await closeIssueWithEvidence(
    issueNumber,
    {
      reason: {
        type: 'closed-because',
        reason: 'manually-completed',
        details: `[live-smoke:${context.runId}] ${reason}`,
      },
      validation: 'Validation not run: live smoke cleanup closes temporary test artifacts.',
    },
    {
      postComment: async (targetIssueNumber, body) => {
        await runCommand('gh', [
          'issue',
          'comment',
          String(targetIssueNumber),
          '--repo',
          context.repo,
          '--body',
          body,
        ], { timeoutMs: context.options.timeoutMs });
      },
      closeIssue: async (targetIssueNumber) => {
        await runCommand('gh', [
          'issue',
          'close',
          String(targetIssueNumber),
          '--repo',
          context.repo,
        ], { timeoutMs: context.options.timeoutMs });
      },
    },
  );
  await appendReport(context, `Closed issue #${issueNumber}: ${reason}\n\n`);
}

async function importIssueHelpers(context) {
  const packageIndexPath = join(dirname(context.cliPath), 'index.js');
  return import(pathToFileURL(packageIndexPath).href);
}

async function assertBlockedIssue(context, issueNumber, expectedCommentText) {
  const issue = await getIssue(context, issueNumber);
  assertHasLabel(issue, 'agent:blocked');
  assertMissingLabel(issue, 'agent:running');
  assertIssueHasComment(issue, `codex-orchestrator blocked scoped execution for #${issueNumber}`);
  assertIssueHasComment(issue, expectedCommentText);
  await assertLogFileExists(context, issueNumber);
}

async function assertPlanBlockedIssue(context, issueNumber, expectedCommentText) {
  const issue = await getIssue(context, issueNumber);
  assertHasLabel(issue, 'agent:blocked');
  assertMissingLabel(issue, 'agent:running');
  assertIssueHasComment(issue, `codex-orchestrator blocked parent issue-tree execution for #${issueNumber}`);
  assertIssueHasComment(issue, expectedCommentText);
  await assertLogFileExists(context, issueNumber);
}

async function assertNoEligibleIssues(context) {
  const status = await runPackagedCli(context, ['status', '--target', context.targetRoot, '--dry-run']);
  const eligibleLines = eligibleLinesFromStatus(status.stdout);
  if (eligibleLines.length > 0) {
    throw new Error(`Refusing live smoke while other eligible issues exist:\n${eligibleLines.join('\n')}`);
  }
}

async function assertOnlyEligibleIssue(context, issueNumber, mode) {
  const status = await runPackagedCli(context, ['status', '--target', context.targetRoot, '--dry-run']);
  const line = `  - #${issueNumber} ${mode}:`;
  assert(status.stdout.includes(line), `expected status to show ${line}\n${status.stdout}`);
  const eligibleLines = eligibleLinesFromStatus(status.stdout);
  assert(
    eligibleLines.length === 1 && eligibleLines[0].startsWith(line),
    `expected only #${issueNumber} to be eligible, got:\n${eligibleLines.join('\n')}`,
  );
}

function eligibleLinesFromStatus(output) {
  const lines = output.split('\n');
  const start = lines.indexOf('eligible:');
  const end = lines.indexOf('skipped:');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not parse status output:\n${output}`);
  }
  return lines.slice(start + 1, end).filter((line) => /^  - #\d+ /.test(line));
}

async function assertPackageSurface(context) {
  const packageDir = dirname(dirname(dirname(context.cliPath)));
  await assertPathExists(join(packageDir, 'dist', 'src', 'index.js'), 'package should include dist/src/index.js');
  await assertPathExists(join(packageDir, 'dist', 'src', 'config', 'schema.js'), 'package should include config/schema export');
  await assertPathExists(join(packageDir, 'prompts'), 'package should include prompts');
  await assertPathExists(join(packageDir, 'README.md'), 'package should include README.md');
  await assertPathExists(join(packageDir, 'LICENSE'), 'package should include LICENSE');
  const importCheck = [
    'import { validateConfig } from "codex-orchestrator/config/schema";',
    'if (typeof validateConfig !== "function") throw new Error("missing validateConfig");',
  ].join('\n');
  const checkPath = join(packageDir, 'live-smoke-import-check.mjs');
  await writeFile(checkPath, importCheck, 'utf8');
  await runCommand(process.execPath, [checkPath], {
    cwd: packageDir,
    timeoutMs: context.options.timeoutMs,
    env: { ...process.env, NODE_PATH: join(packageDir, 'node_modules') },
  });
}

async function assertRemoteBranchExists(context, branchName) {
  const output = await gitOutput(context.targetRoot, ['ls-remote', '--heads', 'origin', branchName]);
  assert(output.includes(branchName), `expected remote branch ${branchName}`);
}

async function assertNoRemoteBranch(context, branchName) {
  const output = await gitOutput(context.targetRoot, ['ls-remote', '--heads', 'origin', branchName]);
  assert(!output.includes(branchName), `expected no remote branch ${branchName}`);
}

async function assertNoPullRequestForBranch(context, branchName) {
  const pullRequest = await findPullRequestByBranch(context, branchName);
  assert(!pullRequest, `expected no PR for ${branchName}, got #${pullRequest?.number}`);
}

async function assertLogFileExists(context, issueNumber) {
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
  const logRoot = join(context.targetRoot, config.runner.stateDir, 'logs');
  const logs = existsSync(logRoot) ? await walkFiles(logRoot) : [];
  const match = logs.find((file) => basename(file).startsWith(`issue-${issueNumber}-`) && file.endsWith('.log'));
  assert(match, `expected durable log for issue #${issueNumber} under ${logRoot}`);
  const content = await readFile(match, 'utf8');
  assertIncludes(content, '[lifecycle]', 'durable log should include lifecycle lines');
}

async function assertRunStateCleared(context, issueNumber) {
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
  const statePath = join(context.targetRoot, config.runner.stateDir, 'runs.json');
  if (!existsSync(statePath)) {
    return;
  }
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const active = Array.isArray(state.runs) ? state.runs.some((run) => run.issueNumber === issueNumber) : false;
  assert(!active, `expected issue #${issueNumber} to be removed from active runner state`);
}

async function readSnapshotForIssue(context, issueNumber) {
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
  const snapshotRoot = join(context.targetRoot, config.runner.stateDir, 'snapshots');
  const snapshots = existsSync(snapshotRoot) ? await walkFiles(snapshotRoot) : [];
  const match = snapshots.find((file) => basename(file).startsWith(`issue-${issueNumber}-`) && file.endsWith('.json'));
  assert(match, `expected context snapshot for issue #${issueNumber} under ${snapshotRoot}`);
  return JSON.parse(await readFile(match, 'utf8'));
}

async function getIssue(context, issueNumber) {
  const result = await runCommand('gh', [
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    context.repo,
    '--json',
    'number,title,body,url,state,labels,comments',
  ], { timeoutMs: context.options.timeoutMs, retryTransient: true });
  return JSON.parse(result.stdout);
}

async function getIssueIfExists(context, issueNumber) {
  try {
    return await getIssue(context, issueNumber);
  } catch (error) {
    if (isNotFoundCommandError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function getPullRequestIfExists(context, prNumber) {
  try {
    const result = await runCommand('gh', [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      context.repo,
      '--json',
      'number,state',
    ], { timeoutMs: context.options.timeoutMs, retryTransient: true });
    return JSON.parse(result.stdout);
  } catch (error) {
    if (isNotFoundCommandError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNotFoundCommandError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|Could not resolve|HTTP 404|GraphQL:.*not.*found/iu.test(message);
}

async function listIssuesByRunId(context, { state = 'open' } = {}) {
  const result = await runCommand('gh', [
    'issue',
    'list',
    '--repo',
    context.repo,
    '--state',
    state,
    '--limit',
    '1000',
    '--json',
    'number,title,body,url,state,labels,comments',
  ], { timeoutMs: context.options.timeoutMs, retryTransient: true });
  return JSON.parse(result.stdout).filter((issue) =>
    issue.title.includes(`[live-smoke:${context.runId}]`)
      || issue.body?.includes(`LIVE_SMOKE_RUN_ID: ${context.runId}`),
  );
}

async function findPullRequestByBranch(context, branchName) {
  const result = await runCommand('gh', [
    'pr',
    'list',
    '--repo',
    context.repo,
    '--head',
    branchName,
    '--state',
    'all',
    '--json',
    'number,url,isDraft,headRefName,baseRefName,title',
    '--limit',
    '10',
  ], { timeoutMs: context.options.timeoutMs, retryTransient: true });
  const pullRequests = JSON.parse(result.stdout);
  return pullRequests[0];
}

async function getPullRequestBody(context, number) {
  const result = await runCommand('gh', [
    'pr',
    'view',
    String(number),
    '--repo',
    context.repo,
    '--json',
    'body',
  ], { timeoutMs: context.options.timeoutMs, retryTransient: true });
  return JSON.parse(result.stdout).body;
}

function assertHasLabel(issue, label) {
  assert(issue.labels.some((entry) => entry.name === label), `expected issue #${issue.number} to have label ${label}`);
}

function assertMissingLabel(issue, label) {
  assert(!issue.labels.some((entry) => entry.name === label), `expected issue #${issue.number} not to have label ${label}`);
}

function assertIssueHasComment(issue, text) {
  assert(
    issue.comments.some((comment) => comment.body.includes(text)),
    `expected issue #${issue.number} to have comment containing: ${text}`,
  );
}

async function cleanupGitHubArtifacts(context) {
  await appendReport(context, '\n## Cleanup\n\n');
  await discoverCreatedArtifacts(context);
  const failures = [];
  for (const prNumber of [...new Set(context.createdPullRequests)].reverse()) {
    const failure = await bestEffort(context, `close PR #${prNumber}`, async () => {
      await runCommand('gh', [
        'pr',
        'close',
        String(prNumber),
        '--repo',
        context.repo,
        '--comment',
        `[live-smoke:${context.runId}] cleanup`,
        '--delete-branch',
      ], {
        timeoutMs: context.options.timeoutMs,
      });
    });
    if (failure) {
      failures.push(failure);
    }
  }
  for (const branchName of [...new Set(context.createdBranches)].reverse()) {
    const failure = await bestEffort(context, `delete branch ${branchName}`, async () => {
      await deleteRemoteBranchIfExists(context, branchName);
    });
    if (failure) {
      failures.push(failure);
    }
  }
  for (const issueNumber of [...new Set(context.createdIssues)].reverse()) {
    const action = context.options.cleanupMode === 'delete' ? 'delete' : 'close';
    const failure = await bestEffort(context, `${action} issue #${issueNumber}`, async () => {
      if (context.options.cleanupMode === 'delete') {
        await deleteIssue(context, issueNumber);
      } else {
        await closeIssue(context, issueNumber, 'cleanup');
      }
    });
    if (failure) {
      failures.push(failure);
    }
  }
  failures.push(...await verifyCleanupArtifacts(context));
  if (failures.length > 0) {
    throw new Error(`Live smoke cleanup incomplete:\n${failures.join('\n')}`);
  }
}

async function discoverCreatedArtifacts(context) {
  try {
    const issues = await listIssuesByRunId(context, { state: 'all' });
    for (const issue of issues) {
      context.createdIssues.push(issue.number);
    }
  } catch {
    // Cleanup must remain best-effort.
  }
  try {
    const result = await runCommand('gh', [
      'pr',
      'list',
      '--repo',
      context.repo,
      '--search',
      `live-smoke:${context.runId}`,
      '--state',
      'all',
      '--json',
      'number,headRefName',
      '--limit',
      '1000',
    ], { timeoutMs: context.options.timeoutMs });
    for (const pullRequest of JSON.parse(result.stdout)) {
      context.createdPullRequests.push(pullRequest.number);
      if (pullRequest.headRefName) {
        context.createdBranches.push(pullRequest.headRefName);
      }
    }
  } catch {
    // Cleanup must remain best-effort.
  }
}

async function bestEffort(context, label, fn) {
  try {
    await fn();
    await appendReport(context, `- ${label}: done\n`);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendReport(context, `- ${label}: failed - ${message}\n`);
    return `${label}: ${message}`;
  }
}

async function deleteIssue(context, issueNumber) {
  await runCommand('gh', [
    'issue',
    'delete',
    String(issueNumber),
    '--repo',
    context.repo,
    '--yes',
  ], { timeoutMs: context.options.timeoutMs });
}

async function deleteRemoteBranchIfExists(context, branchName) {
  const output = await gitOutput(context.targetRoot, ['ls-remote', '--heads', 'origin', branchName]);
  if (!output.includes(branchName)) {
    return;
  }
  await runCommand('git', ['-C', context.targetRoot, 'push', 'origin', '--delete', branchName], {
    timeoutMs: context.options.timeoutMs,
  });
}

async function verifyCleanupArtifacts(context) {
  const failures = [];
  const openIssues = await listIssuesByRunId(context, { state: 'open' });
  if (openIssues.length > 0) {
    failures.push(`open live-smoke issues remain: ${openIssues.map((issue) => `#${issue.number}`).join(', ')}`);
  }

  for (const issueNumber of [...new Set(context.createdIssues)]) {
    const issue = await getIssueIfExists(context, issueNumber);
    if (context.options.cleanupMode === 'delete' && issue) {
      failures.push(`issue #${issueNumber} still exists after delete-mode cleanup`);
    }
    if (context.options.cleanupMode === 'close' && issue?.state === 'OPEN') {
      failures.push(`issue #${issueNumber} is still open after close-mode cleanup`);
    }
  }

  for (const prNumber of [...new Set(context.createdPullRequests)]) {
    const pullRequest = await getPullRequestIfExists(context, prNumber);
    if (pullRequest?.state === 'OPEN') {
      failures.push(`PR #${prNumber} is still open after cleanup`);
    }
  }

  for (const branchName of [...new Set(context.createdBranches)]) {
    const output = await gitOutput(context.targetRoot, ['ls-remote', '--heads', 'origin', branchName]);
    if (output.includes(branchName)) {
      failures.push(`remote branch ${branchName} still exists after cleanup`);
    }
  }

  if (failures.length === 0) {
    await appendReport(context, '- cleanup verification: passed\n');
  } else {
    await appendReport(context, `- cleanup verification: failed - ${failures.join('; ')}\n`);
  }
  return failures;
}

async function defaultBranchFor(repo) {
  const result = await runCommand('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef'], {
    timeoutMs: defaultTimeoutMs,
    retryTransient: true,
  });
  const parsed = JSON.parse(result.stdout);
  const name = parsed.defaultBranchRef?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Could not resolve default branch for ${repo}`);
  }
  return name;
}

async function createRemoteBaseBranch(context) {
  const branchName = `live-smoke-base-${context.runId}`;
  const markerPath = `live-smoke-base/${context.runId}.txt`;
  const worktreePath = join(context.root, `base-${context.runId}`);
  const defaultBranch = await defaultBranchFor(context.repo);

  await gitOutput(context.targetRoot, ['fetch', 'origin', '--prune']);
  await runCommand('git', [
    '-C',
    context.targetRoot,
    'worktree',
    'add',
    '--no-track',
    '-b',
    branchName,
    worktreePath,
    `origin/${defaultBranch}`,
  ], { timeoutMs: context.options.timeoutMs });
  await mkdir(dirname(join(worktreePath, markerPath)), { recursive: true });
  await writeFile(join(worktreePath, markerPath), `live smoke remote base ${context.runId}\n`, 'utf8');
  await runCommand('git', ['-C', worktreePath, 'add', markerPath], { timeoutMs: context.options.timeoutMs });
  await runCommand('git', [
    '-C',
    worktreePath,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=live-smoke',
    '-c',
    'user.email=live-smoke@example.invalid',
    'commit',
    '--no-verify',
    '-m',
    `Live smoke remote base ${context.runId}`,
  ], { timeoutMs: context.options.timeoutMs });
  const sha = (await gitOutput(worktreePath, ['rev-parse', 'HEAD'])).trim();
  await runCommand('git', ['-C', worktreePath, 'push', '-u', 'origin', branchName], {
    timeoutMs: context.options.timeoutMs,
  });
  context.createdBranches.push(branchName);
  await runCommand('git', ['-C', context.targetRoot, 'worktree', 'remove', worktreePath], {
    timeoutMs: context.options.timeoutMs,
  });
  await runCommand('git', ['-C', context.targetRoot, 'branch', '-D', branchName], {
    timeoutMs: context.options.timeoutMs,
  });
  await fetchRemoteBranch(context, branchName);
  await appendReport(context, `Remote base branch: origin/${branchName}@${sha}\n\n`);
  return { branchName, markerPath, sha };
}

async function preparePlanAutoTreeRecoveryFixture(context, input) {
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
  const defaultBranch = await defaultBranchFor(context.repo);
  await gitOutput(context.targetRoot, ['fetch', 'origin', '--prune']);
  const baseSha = (await gitOutput(context.targetRoot, ['rev-parse', `refs/remotes/origin/${defaultBranch}`])).trim();
  const now = new Date();
  const staleLease = new Date(now.getTime() - 31 * 60 * 1000).toISOString();
  const parentBranchName = `codex/tree-${input.parentIssueNumber}`;
  const parentWorktreePath = join(context.targetRoot, config.runner.workspaceRoot, `tree-${input.parentIssueNumber}`);
  const recoveredSessionId = `tree-${input.parentIssueNumber}-issue-${input.recoveredChildIssueNumber}-recovered-live-smoke`;
  const blockedSessionId = `tree-${input.parentIssueNumber}-issue-${input.blockedChildIssueNumber}-blocked-live-smoke`;
  const recoveredBranchName = `codex/tree-${input.parentIssueNumber}-issue-${input.recoveredChildIssueNumber}`;
  const blockedBranchName = `codex/tree-${input.parentIssueNumber}-issue-${input.blockedChildIssueNumber}`;
  const recoveredWorktreePath = join(
    context.targetRoot,
    config.runner.workspaceRoot,
    `tree-${input.parentIssueNumber}-issue-${input.recoveredChildIssueNumber}`,
  );
  const blockedWorktreePath = join(
    context.targetRoot,
    config.runner.workspaceRoot,
    `tree-${input.parentIssueNumber}-issue-${input.blockedChildIssueNumber}`,
  );

  await mkdir(dirname(parentWorktreePath), { recursive: true });
  await runCommand('git', [
    '-C',
    context.targetRoot,
    'worktree',
    'add',
    '--no-track',
    '-b',
    parentBranchName,
    parentWorktreePath,
    `refs/remotes/origin/${defaultBranch}`,
  ], { timeoutMs: context.options.timeoutMs });
  await runCommand('git', ['-C', context.targetRoot, 'branch', recoveredBranchName, parentBranchName], {
    timeoutMs: context.options.timeoutMs,
  });
  await runCommand('git', [
    '-C',
    context.targetRoot,
    'worktree',
    'add',
    '--no-track',
    '-b',
    blockedBranchName,
    blockedWorktreePath,
    parentBranchName,
  ], { timeoutMs: context.options.timeoutMs });

  await writeLiveSmokeDurableSummary(context, config, {
    issueNumber: input.recoveredChildIssueNumber,
    sessionId: recoveredSessionId,
    outcome: 'review-ready',
    changedFiles: ['src/live-smoke/recovered-child.ts'],
    validation: [
      { command: 'live smoke recovered child validation', status: 'passed', summary: 'child branch already merged into parent branch' },
    ],
    blockers: [],
    skippedChecks: [],
    residualRisks: [],
    nextAction: 'Recovered completed child should be included in parent handoff without re-running Codex.',
  });
  await writeLiveSmokeDurableSummary(context, config, {
    issueNumber: input.blockedChildIssueNumber,
    sessionId: blockedSessionId,
    outcome: 'blocked',
    changedFiles: [],
    validation: [],
    blockers: ['Quality gate requires TDD red-to-green proof'],
    skippedChecks: [],
    residualRisks: [],
    nextAction: 'Retry blocked child through automatic rework.',
  });

  await writeFile(join(context.targetRoot, config.runner.stateDir, 'runner-state.json'), `${JSON.stringify({
    version: 1,
    runs: [
      {
        issueNumber: input.parentIssueNumber,
        mode: 'plan-parent',
        workspacePath: parentWorktreePath,
        sessionId: `plan-${input.parentIssueNumber}-stale-live-smoke`,
        retryCount: 0,
        createdAt: staleLease,
        updatedAt: staleLease,
        branchName: parentBranchName,
        ownerPid: 2_147_483_647,
        host: hostname(),
        leaseUpdatedAt: staleLease,
        baseSha,
      },
      {
        issueNumber: input.recoveredChildIssueNumber,
        parentIssueNumber: input.parentIssueNumber,
        mode: 'tree-child',
        workspacePath: recoveredWorktreePath,
        sessionId: recoveredSessionId,
        retryCount: 0,
        createdAt: staleLease,
        updatedAt: staleLease,
        branchName: recoveredBranchName,
        promptPath: join(context.targetRoot, config.runner.stateDir, 'prompts', `${recoveredSessionId}.md`),
        reportPath: join(context.targetRoot, config.runner.stateDir, 'reports', `issue-${input.recoveredChildIssueNumber}-${recoveredSessionId}.json`),
        logPath: join(context.targetRoot, config.runner.stateDir, 'logs', `issue-${input.recoveredChildIssueNumber}-${recoveredSessionId}.log`),
      },
      {
        issueNumber: input.blockedChildIssueNumber,
        parentIssueNumber: input.parentIssueNumber,
        mode: 'tree-child',
        workspacePath: blockedWorktreePath,
        sessionId: blockedSessionId,
        retryCount: 0,
        createdAt: staleLease,
        updatedAt: staleLease,
        branchName: blockedBranchName,
        promptPath: join(context.targetRoot, config.runner.stateDir, 'prompts', `${blockedSessionId}.md`),
        reportPath: join(context.targetRoot, config.runner.stateDir, 'reports', `issue-${input.blockedChildIssueNumber}-${blockedSessionId}.json`),
        logPath: join(context.targetRoot, config.runner.stateDir, 'logs', `issue-${input.blockedChildIssueNumber}-${blockedSessionId}.log`),
      },
    ],
  }, null, 2)}\n`, 'utf8');

  return { parentWorktreePath };
}

async function writeLiveSmokeDurableSummary(context, config, input) {
  const reportPath = join(context.targetRoot, config.runner.stateDir, 'reports', `issue-${input.issueNumber}-${input.sessionId}.json`);
  const logPath = join(context.targetRoot, config.runner.stateDir, 'logs', `issue-${input.issueNumber}-${input.sessionId}.log`);
  const summaryPath = join(context.targetRoot, config.runner.stateDir, 'summaries', `issue-${input.issueNumber}-${input.sessionId}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(logPath), { recursive: true });
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ status: input.outcome === 'review-ready' ? 'completed' : 'blocked' }, null, 2) + '\n', 'utf8');
  await writeFile(logPath, `[lifecycle] live smoke recovery fixture for #${input.issueNumber}\n`, 'utf8');
  await writeFile(summaryPath, `${JSON.stringify({
    issueNumber: input.issueNumber,
    sessionId: input.sessionId,
    outcome: input.outcome,
    changedFiles: input.changedFiles,
    confirmedFacts: input.changedFiles.length > 0 ? [`${input.changedFiles.length} changed file(s) detected`] : [],
    validation: input.validation,
    blockers: input.blockers,
    skippedChecks: input.skippedChecks,
    residualRisks: input.residualRisks,
    policySuggestions: [],
    nextAction: input.nextAction,
    evidence: {
      logPath,
      reportPath,
    },
  }, null, 2)}\n`, 'utf8');
}

function ownerOf(repo) {
  return repo.split('/')[0];
}

function repoNameOf(repo) {
  return repo.split('/')[1];
}

async function runPackagedCli(context, args) {
  const readOnly = isReadOnlyPackagedCliArgs(args);
  return runCommand(process.execPath, [context.cliPath, ...args], {
    cwd: context.targetRoot || sourceRoot,
    timeoutMs: context.options.timeoutMs,
    retryTransient: readOnly,
  });
}

async function gitOutput(cwd, args) {
  const result = await runCommand('git', ['-C', cwd, ...args], { timeoutMs: defaultTimeoutMs });
  return result.stdout;
}

async function fetchRemoteBranch(context, branchName) {
  await runCommand('git', [
    '-C',
    context.targetRoot,
    'fetch',
    'origin',
    `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    '--prune',
  ], { timeoutMs: context.options.timeoutMs });
}

function isReadOnlyPackagedCliArgs(args) {
  const command = args[0];
  return command === '--help'
    || command === '--version'
    || command === 'health'
    || command === 'doctor'
    || command === 'status'
    || (command === 'setup' && args.includes('--dry-run'));
}

async function runCommand(command, args, options = {}) {
  const attempts = options.retryTransient ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runCommandOnce(command, args, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientCommandError(error)) {
        throw error;
      }
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

function runCommandOnce(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${options.timeoutMs ?? defaultTimeoutMs}ms: ${command} ${args.join(' ')}`));
    }, options.timeoutMs ?? defaultTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (options.stream) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.stream) {
        process.stderr.write(chunk);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      if (status === 0) {
        resolvePromise({ stdout, stderr, status });
        return;
      }
      reject(new Error(`Command failed (${status}): ${command} ${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });
}

function isTransientCommandError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return isTransientCommandOutput(message);
}

function isTransientCommandOutput(message) {
  return /stream error: stream ID \d+; CANCEL; received from peer/iu.test(message)
    || /HTTP 5\d\d/iu.test(message)
    || /non-200 OK status code: 5\d\d/iu.test(message)
    || /TLS handshake timeout/iu.test(message)
    || /connection reset by peer/iu.test(message)
    || /network is unreachable/iu.test(message);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function appendReport(context, text) {
  await writeFile(context.reportPath, text, { encoding: 'utf8', flag: 'a' });
}

async function assertPathExists(path, message) {
  try {
    await stat(path);
  } catch {
    throw new Error(`${message}: ${path}`);
  }
}

async function walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function assertIncludes(value, expected, message) {
  assert(value.includes(expected), `${message}\nExpected to include: ${expected}\nActual:\n${value}`);
}

async function writeFakeAgent(root) {
  const fakePath = join(root, 'live-smoke-fake-codex.mjs');
  await writeFile(fakePath, fakeAgentSource(), 'utf8');
  await chmod(fakePath, 0o755);
  return fakePath;
}

async function writeBrowserProofScript(root, cliPath, sourceRootPath) {
  const scriptPath = join(root, 'live-smoke-browser-proof.mjs');
  await writeFile(scriptPath, browserProofSource(cliPath, sourceRootPath), 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeAcceptanceProofScript(root) {
  const scriptPath = join(root, 'live-smoke-acceptance-proof.mjs');
  await writeFile(scriptPath, acceptanceProofSource(), 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function browserProofSource(cliPath, sourceRootPath) {
  const packageDir = dirname(dirname(dirname(cliPath)));
  return String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const cliPath = ${JSON.stringify(cliPath)};
const packageDir = ${JSON.stringify(packageDir)};
const sourceRoot = ${JSON.stringify(sourceRootPath)};
const issueNumber = Number(process.env.CODEX_ORCHESTRATOR_ISSUE_NUMBER ?? 0);
const targetRoot = process.env.CODEX_ORCHESTRATOR_TARGET_ROOT;
if (!Number.isInteger(issueNumber) || issueNumber < 1) {
  throw new Error('CODEX_ORCHESTRATOR_ISSUE_NUMBER is required for browser proof live smoke');
}
if (!targetRoot) {
  throw new Error('CODEX_ORCHESTRATOR_TARGET_ROOT is required for browser proof live smoke');
}

ensurePlaywrightCoreDependency();

const html = '<!doctype html><html><head><title>Browser proof live smoke</title></head><body><main><h1>Browser proof live smoke ready</h1><p data-testid="status">Issue #' + issueNumber + ' rendered through package-owned browser proof.</p></main></body></html>';
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const baseUrl = 'http://127.0.0.1:' + address.port;

try {
  await run(process.execPath, [cliPath, 'visual-proof', 'auto', '--issue', String(issueNumber)], {
    cwd: targetRoot,
    env: {
      ...process.env,
      CODEX_ORCHESTRATOR_BROWSER_BASE_URL: baseUrl,
    },
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function ensurePlaywrightCoreDependency() {
  const packagePlaywright = join(packageDir, 'node_modules', 'playwright-core');
  if (existsSync(join(packagePlaywright, 'package.json'))) {
    return;
  }
  const sourcePlaywright = join(sourceRoot, 'node_modules', 'playwright-core');
  if (!existsSync(join(sourcePlaywright, 'package.json'))) {
    throw new Error('playwright-core is not available in the source checkout; run npm install before browser-proof live smoke');
  }
  mkdirSync(join(packageDir, 'node_modules'), { recursive: true });
  symlinkSync(sourcePlaywright, packagePlaywright, 'dir');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (status) => {
      status === 0
        ? resolve()
        : reject(new Error('Command failed (' + status + '): ' + command + ' ' + args.join(' ')));
    });
  });
}
`;
}

function acceptanceProofSource() {
  return String.raw`#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const mode = process.argv[2] ?? 'pass';
const proofDir = process.env.CODEX_ORCHESTRATOR_PROOF_DIR;
const reportPath = process.env.CODEX_ORCHESTRATOR_PROOF_REPORT_PATH;
const issueNumber = Number(process.env.CODEX_ORCHESTRATOR_ISSUE_NUMBER ?? 0);
const artifactDir = process.env.CODEX_ORCHESTRATOR_ARTIFACT_DIR ?? '.codex-orchestrator/proofs';

if (!proofDir || !reportPath || !Number.isInteger(issueNumber) || issueNumber < 1) {
  throw new Error('acceptance proof requires CODEX_ORCHESTRATOR_PROOF_DIR, CODEX_ORCHESTRATOR_PROOF_REPORT_PATH, and CODEX_ORCHESTRATOR_ISSUE_NUMBER');
}

mkdirSync(proofDir, { recursive: true });
const artifactPath = join(proofDir, 'live-smoke-proof.txt');
const artifactRef = artifactDir.replace(/\/+$/, '') + '/issue-' + issueNumber + '/live-smoke-proof.txt';
writeFileSync(artifactPath, 'live smoke acceptance proof for #' + issueNumber + ' mode=' + mode + '\n', 'utf8');
const uiModes = new Set(['pass-ui', 'missing-ui-evidence', 'narrow-ui-viewport']);
const uiArtifactPath = join(proofDir, 'live-smoke-ui-screenshot.png');
const uiArtifactRef = artifactDir.replace(/\/+$/, '') + '/issue-' + issueNumber + '/live-smoke-ui-screenshot.png';
if (uiModes.has(mode)) {
  writeFileSync(uiArtifactPath, 'fake live smoke ui screenshot artifact for #' + issueNumber + '\n', 'utf8');
}

if (mode === 'product-diff') {
  const productPath = join('src', 'live-smoke', 'proof-side-effect-' + issueNumber + '.ts');
  mkdirSync(dirname(productPath), { recursive: true });
  writeFileSync(productPath, 'export const proofSideEffect' + issueNumber + ' = true;\n', 'utf8');
}

const proofReady = existsSync(join('src', 'live-smoke', 'issue-' + issueNumber + '-proof-ready.ts'));
const shouldPass = mode === 'pass' || mode === 'pass-ui' || mode === 'missing-ui-evidence' || mode === 'narrow-ui-viewport' || mode === 'low-confidence' || mode === 'product-diff' || (mode === 'rework' && proofReady);
const confidence = mode === 'low-confidence' ? 'medium' : 'high';
const reportStatus = shouldPass ? 'passed' : 'needs-rework';
const criterionStatus = shouldPass ? 'passed' : 'failed';
const artifacts = [{
  type: 'smoke-output',
  path: artifactRef,
  description: 'Live smoke acceptance proof output',
}];
if (uiModes.has(mode)) {
  artifacts.push({
    type: 'screenshot',
    path: uiArtifactRef,
    description: 'Live smoke UI Evidence screenshot',
  });
}
const artifactRefs = uiModes.has(mode) ? [artifactRef, uiArtifactRef] : [artifactRef];

const report = {
  status: reportStatus,
  criteria: [{
    id: 'ac-live-smoke',
    description: uiModes.has(mode)
      ? 'Live smoke UI Evidence artifact exists and maps to the issue acceptance marker.'
      : 'Live smoke acceptance proof artifact exists and maps to the issue acceptance marker.',
    status: criterionStatus,
    confidence,
    reasoningSummary: shouldPass
      ? uiModes.has(mode)
        ? 'The runner-owned proof command produced a current screenshot artifact with UI Evidence Contract fields.'
        : 'The runner-owned proof command produced a durable smoke-output artifact for the acceptance criterion.'
      : 'The implementation has not produced the proof-ready marker required by this scenario.',
    artifactRefs,
  }],
  artifacts,
  proofPhaseDiff: {
    allowedProofPaths: artifactRefs,
    forbiddenProductPaths: [],
  },
  residualRisks: [],
  reworkRequest: shouldPass ? undefined : {
    summary: 'Implementation rework must create the proof-ready live smoke marker.',
    requiredChanges: ['Create src/live-smoke/issue-' + issueNumber + '-proof-ready.ts during implementation rework.'],
    evidenceRefs: [artifactRef],
  },
};

if (mode === 'pass-ui') {
  report.uiEvidence = buildUiEvidence(uiArtifactRef, 1440);
}
if (mode === 'narrow-ui-viewport') {
  report.uiEvidence = buildUiEvidence(uiArtifactRef, 1024);
}

writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

process.stdout.write('live smoke acceptance proof wrote ' + reportPath + '\n');

function buildUiEvidence(artifactRef, width) {
  return {
    workflowScope: {
      entrypoint: 'live smoke UI route',
      path: ['daemon once', 'scoped implementation', 'acceptance proof UI inspection'],
      screenState: 'final UI Evidence screen after implementation',
      authPath: 'not-required',
    },
    viewportCoverage: [{
      name: 'desktop wide',
      width,
      height: 900,
      artifactRefs: [artifactRef],
      requiredBy: 'desktop-web-layout',
    }],
    artifactFreshness: {
      currentArtifactRefs: [artifactRef],
      checkedAfterFinalRun: true,
    },
    layoutReview: {
      checked: true,
      findings: [{
        summary: 'Spacing, alignment, clipping, and overlap were checked for the final live smoke UI state.',
        artifactRefs: [artifactRef],
      }],
    },
    copyReview: {
      checked: true,
      acceptedTerms: ['live smoke heading'],
      rejectedTermsAbsent: ['implementation-only placeholder'],
      findings: [{
        summary: 'Visible copy matches the issue terms and omits rejected placeholder language.',
        artifactRefs: [artifactRef],
      }],
    },
    sourceInputs: {
      acceptanceCriteriaRefs: ['issue body: Acceptance Criteria'],
      implementationEvidenceRefs: ['completion report validation: red-green live smoke'],
      manualQaPlanRefs: ['issue body: Manual QA Plan'],
      runtimeValidationRefs: ['acceptance proof command completed after implementation'],
    },
  };
}
`;
}

function fakeAgentSource() {
  return String.raw`#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const promptPath = process.env.CODEX_ORCHESTRATOR_PROMPT_FILE;
const reportPath = process.env.CODEX_ORCHESTRATOR_REPORT_FILE;
if (!promptPath || !reportPath) {
  throw new Error('Missing CODEX_ORCHESTRATOR_PROMPT_FILE or CODEX_ORCHESTRATOR_REPORT_FILE');
}

const prompt = readFileSync(promptPath, 'utf8');
const issueNumber = Number(basename(reportPath).match(/^issue-(\d+)-/)?.[1] ?? 0);
const inferredScenario = inferScenarioFromReportPath(reportPath);
const scenario = inferredScenario === 'plan-child'
  ? readLastMarker(prompt, 'LIVE_SMOKE_SCENARIO') ?? inferredScenario
  : readMarker(prompt, 'LIVE_SMOKE_SCENARIO') ?? inferredScenario;
const runId = readMarker(prompt, 'LIVE_SMOKE_RUN_ID') ?? 'unknown';
const repairMode = process.env.CODEX_ORCHESTRATOR_REPAIR_MODE ?? '';

console.log(JSON.stringify({ type: 'live-smoke', message: 'starting ' + scenario + ' for #' + issueNumber }));
console.error('live-smoke fake stderr for #' + issueNumber + '\n');
mkdirSync(dirname(reportPath), { recursive: true });

if (prompt.includes('# Fresh-Context Review')) {
  writeFreshContextReviewReport(reportPath, scenario);
  console.log(JSON.stringify({ type: 'live-smoke', message: 'completed fresh-context review for ' + scenario + ' #' + issueNumber }));
  process.exit(0);
}

  switch (scenario) {
  case 'remote-base-branch':
  case 'scoped-runner-commit':
  case 'diagnostics':
    writeCodeChange(issueNumber, runId, 'runner');
    writeScopedReport(reportPath, ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts']);
    break;
  case 'scoped-local-commit':
    writeCodeChange(issueNumber, runId, 'local');
    gitCommit('Live smoke agent checkpoint #' + issueNumber);
    writeScopedReport(reportPath, ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts']);
    break;
  case 'loop-policy-rework':
    if (!prompt.includes('automatic rework attempt (#1)')) {
      writeScopedReport(
        reportPath,
        [],
        [
          { command: 'red-green live smoke', status: 'passed', summary: 'test failed before implementation and passed after implementation' },
          { command: 'code-review live smoke', status: 'passed', summary: 'code review completed for live smoke fixture' },
        ],
      );
      break;
    }
    writeCodeChange(issueNumber, runId, 'loop-policy-rework');
    writeScopedReport(
      reportPath,
      ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts'],
      undefined,
      ['policy suggestion smoke evidence after bounded rework'],
    );
    break;
  case 'incomplete-progress-rework':
    if (!prompt.includes('automatic rework attempt (#1)')) {
      mkdirSync('src/live-smoke', { recursive: true });
      writeFileSync(
        join('src', 'live-smoke', 'issue-' + issueNumber + '.ts'),
        'export const liveSmokeIncompleteProgressIssue' + issueNumber + ' = ' + JSON.stringify({ issue: issueNumber, run: runId, kind: 'incomplete-progress-rework' }) + ';\n',
        'utf8',
      );
      console.error('Command idle timed out after 300000ms.');
      process.exit(124);
    }
    writeCodeChange(issueNumber, runId, 'incomplete-progress-rework');
    writeScopedReport(reportPath, ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts']);
    break;
  case 'completion-report-repair':
    if (repairMode === 'completion-report') {
      writeScopedReport(
        reportPath,
        ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts'],
        [
          {
            command: 'completion-report repair TDD',
            status: 'passed',
            summary: 'Focused smoke failed before implementation and passed after implementation.',
            evidence: {
              kind: 'tdd-red-green',
              red: { command: 'node --test', status: 'failed', summary: 'failed before implementation' },
              green: { command: 'node --test', status: 'passed', summary: 'passed after implementation' },
            },
          },
          { command: '$code-review', status: 'passed', summary: 'No blocking findings after completion report repair.' },
        ],
      );
      break;
    }
    writeCodeChange(issueNumber, runId, 'completion-report-repair');
    break;
  case 'evidence-repair':
    if (repairMode !== 'evidence') {
      writeCodeChange(issueNumber, runId, 'evidence-repair');
    }
    writeScopedReport(
      reportPath,
      ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts'],
      repairMode === 'evidence'
        ? [
          {
            command: 'evidence repair TDD',
            status: 'passed',
            summary: 'Focused smoke failed before implementation and passed after implementation.',
            evidence: {
              kind: 'tdd-red-green',
              red: { command: 'node --test', status: 'failed', summary: 'failed before implementation' },
              green: { command: 'node --test', status: 'passed', summary: 'passed after implementation' },
            },
          },
          { command: '$code-review', status: 'passed', summary: 'No blocking findings after evidence repair.' },
        ]
        : [
          {
            command: 'evidence repair TDD',
            status: 'passed',
            summary: 'Focused smoke failed before implementation and passed after implementation.',
            evidence: {
              kind: 'tdd-red-green',
              red: { command: 'node --test', status: 'failed', summary: 'failed before implementation' },
              green: { command: 'node --test', status: 'passed', summary: 'passed after implementation' },
            },
          },
        ],
    );
    break;
  case 'browser-proof':
    writeBrowserProofChange(issueNumber, runId);
    writeScopedReport(reportPath, [
      'components/live-smoke/issue-' + issueNumber + '.tsx',
      '.codex-orchestrator/proofs/issue-' + issueNumber + '/browser-proof-scenario.json',
      'test/live-smoke/issue-' + issueNumber + '.test.ts',
    ]);
    break;
  case 'acceptance-proof':
  case 'acceptance-proof-ui-evidence':
  case 'acceptance-proof-low-confidence':
  case 'acceptance-proof-product-diff':
  case 'acceptance-proof-ui-evidence-missing':
  case 'acceptance-proof-ui-evidence-narrow-viewport':
    writeAcceptanceChange(issueNumber, runId, scenario, false);
    writeScopedReport(reportPath, ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts']);
    break;
  case 'proof-strategy-non-visual-smoke':
    if (!prompt.includes('Resolved proof strategy: non-visual-smoke (issue contract).')) {
      throw new Error('Expected child prompt to resolve Proof Strategy: non-visual-smoke from the issue contract.');
    }
    if (!prompt.includes('Do not prepare browser, screenshot, emulator, simulator, or device-backed visual proof for this issue.')) {
      throw new Error('Expected child prompt to prohibit visual/device proof for non-visual-smoke strategy.');
    }
    writeNonVisualSmokeChange(issueNumber, runId);
    writeNonVisualSmokeReport(reportPath, issueNumber);
    break;
  case 'acceptance-proof-rework': {
    const acceptanceProofReady = prompt.includes('automatic rework attempt (#1)');
    writeAcceptanceChange(issueNumber, runId, scenario, acceptanceProofReady);
    writeScopedReport(
      reportPath,
      acceptanceProofReady
        ? [
          'src/live-smoke/issue-' + issueNumber + '.ts',
          'src/live-smoke/issue-' + issueNumber + '-proof-ready.ts',
          'test/live-smoke/issue-' + issueNumber + '.test.ts',
        ]
        : ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts'],
    );
    break;
  }
  case 'quality-missing-tdd':
    writeCodeChange(issueNumber, runId, 'quality-missing-tdd');
    writeScopedReport(
      reportPath,
      ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts'],
      [{ command: 'npm test', status: 'passed', summary: 'all tests passed without red-green proof' }],
    );
    break;
  case 'quality-missing-code-review':
    writeCodeChange(issueNumber, runId, 'quality-missing-code-review');
    writeScopedReport(
      reportPath,
      ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts'],
      [{ command: 'TDD red-to-green', status: 'passed', summary: 'Focused behavior test failed before implementation and passed after implementation.' }],
    );
    break;
  case 'quality-missing-cleanup-review':
    writeMediumRuntimeChange(issueNumber, runId);
    writeScopedReport(
      reportPath,
      [
        'src/live-smoke/issue-' + issueNumber + '-a.ts',
        'src/live-smoke/issue-' + issueNumber + '-b.ts',
        'src/live-smoke/issue-' + issueNumber + '-c.ts',
        'test/live-smoke/issue-' + issueNumber + '.test.ts',
      ],
      [
        { command: 'TDD red-to-green', status: 'passed', summary: 'Focused behavior test failed before implementation and passed after implementation.' },
        { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
      ],
    );
    break;
  case 'denied-secret':
    mkdirSync('live-smoke-denied', { recursive: true });
    writeFileSync('live-smoke-denied/secret.txt', 'LIVE_SMOKE_SHOULD_BLOCK=1\n', 'utf8');
    writeScopedReport(reportPath, ['live-smoke-denied/secret.txt']);
    break;
  case 'invalid-report':
    writeCodeChange(issueNumber, runId, 'invalid-report');
    writeFileSync(reportPath, '{ invalid json', 'utf8');
    break;
  case 'plan-auto':
    writePlanReport(reportPath, runId);
    break;
  case 'plan-quality-rework':
    writePlanQualityReworkReport(reportPath, runId);
    break;
  case 'plan-tree-recovery':
    {
      const children = readTreeRecoveryChildNumbers(prompt, reportPath, issueNumber);
      writePlanTreeRecoveryReport(
        reportPath,
        runId,
        children.recoveredChildIssueNumber,
        children.blockedChildIssueNumber,
      );
    }
    break;
  case 'risk-routing-plan-warning':
    writePlanRiskRoutingWarningReport(reportPath, runId);
    break;
  case 'plan-malformed-graph':
    writeMalformedPlanReport(reportPath, runId);
    break;
  case 'plan-mutates-files':
    writeFileSync('live-smoke-plan-mutation.txt', 'planning must not mutate repository files\n', 'utf8');
    writePlanReport(reportPath, runId);
    break;
  case 'plan-arbitrary-existing-issue':
    writePlanReportForExistingIssue(reportPath, runId, Number(readMarker(prompt, 'LIVE_SMOKE_ARBITRARY_ISSUE')));
    break;
  case 'plan-child':
    writePlanChildChange(readMarker(prompt, 'LIVE_SMOKE_CHILD_ID'), runId);
    writeScopedReport(reportPath, planChildChangePaths(readMarker(prompt, 'LIVE_SMOKE_CHILD_ID')));
    break;
  case 'plan-child-quality-rework': {
    const childId = readMarker(prompt, 'LIVE_SMOKE_CHILD_ID');
    writePlanChildChange(childId, runId);
    const reworkReady = prompt.includes('automatic rework attempt (#1)');
    writeScopedReport(
      reportPath,
      planChildChangePaths(childId),
      reworkReady
        ? [
          {
            command: 'tree-child quality rework structured TDD',
            status: 'passed',
            summary: 'machine-readable proof attached',
            evidence: {
              kind: 'tdd-red-green',
              red: { command: 'node --test', status: 'failed', summary: 'failed before implementation' },
              green: { command: 'node --test', status: 'passed', summary: 'passed after implementation' },
            },
          },
          { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
        ]
        : [{ command: 'npm test', status: 'passed', summary: 'all tests passed without red-green proof' }],
    );
    break;
  }
  default:
    throw new Error('Unknown LIVE_SMOKE_SCENARIO: ' + scenario);
}

console.log(JSON.stringify({ type: 'live-smoke', message: 'completed ' + scenario + ' for #' + issueNumber }));

function readMarker(text, key) {
  return text.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))?.[1]?.trim();
}

function readLastMarker(text, key) {
  const matches = Array.from(text.matchAll(new RegExp('^' + key + ':\\s*(.+)$', 'gm')));
  return matches.at(-1)?.[1]?.trim();
}

function readTreeRecoveryChildNumbers(text, reportPath, parentIssueNumber) {
  const markedRecovered = Number(readMarker(text, 'LIVE_SMOKE_RECOVERED_CHILD'));
  const markedBlocked = Number(readMarker(text, 'LIVE_SMOKE_BLOCKED_CHILD'));
  if (Number.isInteger(markedRecovered) && markedRecovered > 0 && Number.isInteger(markedBlocked) && markedBlocked > 0) {
    return {
      recoveredChildIssueNumber: markedRecovered,
      blockedChildIssueNumber: markedBlocked,
    };
  }
  const statePath = join(dirname(dirname(reportPath)), 'runner-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const children = Array.isArray(state.runs)
    ? state.runs.filter((run) => run.mode === 'tree-child' && run.parentIssueNumber === parentIssueNumber)
    : [];
  const recovered = children.find((run) => String(run.sessionId).includes('recovered'))?.issueNumber;
  const blocked = children.find((run) => String(run.sessionId).includes('blocked'))?.issueNumber;
  if (!Number.isInteger(recovered) || recovered < 1) {
    throw new Error('LIVE_SMOKE_RECOVERED_CHILD must be a positive integer');
  }
  if (!Number.isInteger(blocked) || blocked < 1) {
    throw new Error('LIVE_SMOKE_BLOCKED_CHILD must be a positive integer');
  }
  return {
    recoveredChildIssueNumber: recovered,
    blockedChildIssueNumber: blocked,
  };
}

function inferScenarioFromReportPath(path) {
  const file = basename(path);
  if (file.includes('-plan-')) return 'plan-auto';
  if (file.includes('-tree-')) return 'plan-child';
  return undefined;
}

function writeCodeChange(issue, run, kind) {
  mkdirSync('src/live-smoke', { recursive: true });
  mkdirSync('test/live-smoke', { recursive: true });
  writeFileSync(
    join('src', 'live-smoke', 'issue-' + issue + '.ts'),
    'export const liveSmokeIssue' + issue + ' = ' + JSON.stringify({ issue, run, kind }) + ';\n',
    'utf8',
  );
  writeFileSync(
    join('test', 'live-smoke', 'issue-' + issue + '.test.ts'),
    'import assert from "node:assert/strict";\nassert.equal(' + JSON.stringify(run) + ', ' + JSON.stringify(run) + ');\n',
    'utf8',
  );
}

function planChildChangePaths(childId) {
  if (!childId) {
    throw new Error('Missing LIVE_SMOKE_CHILD_ID for plan-child scenario');
  }
  return [
    'src/live-smoke/issue-owned-by-child-' + childId + '.ts',
    'test/live-smoke/issue-owned-by-child-' + childId + '.test.ts',
  ];
}

function writePlanChildChange(childId, run) {
  const [sourcePath, testPath] = planChildChangePaths(childId);
  mkdirSync(dirname(sourcePath), { recursive: true });
  mkdirSync(dirname(testPath), { recursive: true });
  const identifier = childId.replace(/[^a-zA-Z0-9_$]/g, '_');
  writeFileSync(
    sourcePath,
    'export const liveSmokePlanChild' + identifier + ' = ' + JSON.stringify({ childId, run, kind: 'plan-child' }) + ';\n',
    'utf8',
  );
  writeFileSync(
    testPath,
    'import assert from "node:assert/strict";\nassert.equal(' + JSON.stringify(run) + ', ' + JSON.stringify(run) + ');\n',
    'utf8',
  );
}

function writeMediumRuntimeChange(issue, run) {
  mkdirSync('src/live-smoke', { recursive: true });
  mkdirSync('test/live-smoke', { recursive: true });
  for (const suffix of ['a', 'b', 'c']) {
    writeFileSync(
      join('src', 'live-smoke', 'issue-' + issue + '-' + suffix + '.ts'),
      'export const liveSmokeIssue' + issue + suffix.toUpperCase() + ' = ' + JSON.stringify({ issue, run, suffix }) + ';\n',
      'utf8',
    );
  }
  writeFileSync(
    join('test', 'live-smoke', 'issue-' + issue + '.test.ts'),
    'import assert from "node:assert/strict";\nassert.match(' + JSON.stringify(run) + ', /.+/);\n',
    'utf8',
  );
}

function writeBrowserProofChange(issue, run) {
  mkdirSync('components/live-smoke', { recursive: true });
  mkdirSync('test/live-smoke', { recursive: true });
  mkdirSync(join('.codex-orchestrator', 'proofs', 'issue-' + issue), { recursive: true });
  writeFileSync(
    join('components', 'live-smoke', 'issue-' + issue + '.tsx'),
    'export const LiveSmokeBrowserIssue' + issue + ' = ' + JSON.stringify({ issue, run, kind: 'browser-proof' }) + ';\n',
    'utf8',
  );
  writeFileSync(
    join('test', 'live-smoke', 'issue-' + issue + '.test.ts'),
    'import assert from "node:assert/strict";\nassert.match(' + JSON.stringify(run) + ', /.+/);\n',
    'utf8',
  );
  writeFileSync(
    join('.codex-orchestrator', 'proofs', 'issue-' + issue, 'browser-proof-scenario.json'),
    JSON.stringify(browserProofScenario(issue), null, 2) + '\n',
    'utf8',
  );
}

function browserProofScenario(issue) {
  const artifactPrefix = '.codex-orchestrator/proofs/issue-' + issue;
  return {
    version: 1,
    baseUrl: 'http://127.0.0.1:1',
    viewports: [{
      name: 'desktop-wide',
      width: 1440,
      height: 900,
      requiredBy: 'desktop-web-layout',
    }],
    criteria: [{
      id: 'browser-live-smoke',
      description: 'Browser proof navigates to the live smoke page and captures mapped UI evidence.',
    }],
    sourceInputs: {
      acceptanceCriteriaRefs: ['issue body: Browser proof live smoke acceptance criteria'],
      implementationEvidenceRefs: ['completion report validation: red-green live smoke'],
      runtimeValidationRefs: ['visual-proof auto dispatched to package-owned browser proof'],
    },
    auth: { mode: 'not-required' },
    steps: [
      { action: 'navigate', path: '/' },
      { action: 'waitForText', text: 'Browser proof live smoke ready' },
      { action: 'assertText', selector: 'body', text: 'Browser proof live smoke ready' },
      {
        action: 'screenshot',
        checkpointId: 'browser-live-smoke-screen',
        path: artifactPrefix + '/browser-live-smoke-screenshot.png',
        viewportName: 'desktop-wide',
        criteriaRefs: ['browser-live-smoke'],
      },
      {
        action: 'domSnapshot',
        checkpointId: 'browser-live-smoke-dom',
        path: artifactPrefix + '/browser-live-smoke-dom.html',
        viewportName: 'desktop-wide',
        criteriaRefs: ['browser-live-smoke'],
      },
    ],
  };
}

function writeAcceptanceChange(issue, run, kind, proofReady) {
  mkdirSync('src/live-smoke', { recursive: true });
  mkdirSync('test/live-smoke', { recursive: true });
  writeFileSync(
    join('src', 'live-smoke', 'issue-' + issue + '.ts'),
    'export const liveSmokeAcceptanceIssue' + issue + ' = ' + JSON.stringify({ issue, run, kind, proofReady }) + ';\n',
    'utf8',
  );
  if (proofReady) {
    writeFileSync(
      join('src', 'live-smoke', 'issue-' + issue + '-proof-ready.ts'),
      'export const liveSmokeAcceptanceProofReady' + issue + ' = true;\n',
      'utf8',
    );
  }
  writeFileSync(
    join('test', 'live-smoke', 'issue-' + issue + '.test.ts'),
    'import assert from "node:assert/strict";\nassert.match(' + JSON.stringify(run) + ', /.+/);\n',
    'utf8',
  );
}

function writeNonVisualSmokeChange(issue, run) {
  mkdirSync('src/live-smoke', { recursive: true });
  mkdirSync('test/live-smoke', { recursive: true });
  const proofDir = join('.codex-orchestrator', 'proofs', 'issue-' + issue);
  mkdirSync(proofDir, { recursive: true });
  writeFileSync(
    join('src', 'live-smoke', 'issue-' + issue + '.ts'),
    'export const nonVisualSmokeIssue' + issue + ' = ' + JSON.stringify({ issue, run, proofStrategy: 'non-visual-smoke' }) + ';\n',
    'utf8',
  );
  writeFileSync(
    join('test', 'live-smoke', 'issue-' + issue + '.test.ts'),
    'import assert from "node:assert/strict";\nassert.equal(' + JSON.stringify('non-visual-smoke') + ', "non-visual-smoke");\n',
    'utf8',
  );
  writeFileSync(
    join(proofDir, 'non-visual-smoke-proof.txt'),
    'non-visual smoke proof for issue #' + issue + ' via tests and machine-readable event output\n',
    'utf8',
  );
}

function writeNonVisualSmokeReport(path, issue) {
  const artifactPath = '.codex-orchestrator/proofs/issue-' + issue + '/non-visual-smoke-proof.txt';
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    changes: [
      'src/live-smoke/issue-' + issue + '.ts',
      'test/live-smoke/issue-' + issue + '.test.ts',
      artifactPath,
    ],
    validation: [
      { command: 'TDD red-to-green', status: 'passed', summary: 'Focused non-visual smoke test failed before implementation and passed after implementation.' },
      { command: 'code-review live smoke', status: 'passed', summary: 'code review completed for non-visual proof strategy fixture' },
    ],
    artifacts: [{
      type: 'smoke-output',
      path: artifactPath,
      description: 'Child-authored non-visual smoke proof artifact',
    }],
    skippedChecks: [
      'Runner-owned visual/device proof skipped because issue declares Proof Strategy: non-visual-smoke.',
    ],
    residualRisks: [],
    prohibitedActions: [],
    reviewHandoff: {
      flowUsed: 'scoped-implementation',
      riskLevel: 'medium',
      implementedContract: ['Explicit non-visual proof strategy is honored by the child prompt and runner handoff.'],
      proofByAcceptanceCriteria: ['Non-visual smoke-output artifact maps the acceptance criterion without runner-owned screenshot or device proof.'],
      reviewFocus: ['Confirm runner acceptance proof was not invoked for this issue.'],
      humanReviewChecklist: ['Check that Proof Strategy: non-visual-smoke is present in the issue body.'],
    },
  }, null, 2), 'utf8');
}

function writeScopedReport(path, changes, validation = [
  { command: 'red-green live smoke', status: 'passed', summary: 'test failed before implementation and passed after implementation' },
  { command: 'code-review live smoke', status: 'passed', summary: 'code review completed for live smoke fixture' },
], residualRisks = []) {
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    changes,
    validation,
    artifacts: [],
    skippedChecks: [],
    residualRisks,
    prohibitedActions: [],
  }, null, 2), 'utf8');
}

function writeFreshContextReviewReport(path, scenario) {
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    findings: [{
      severity: 'advisory',
      confidence: 'medium',
      summary: 'Loop Policy live smoke Fresh-Context Review evidence for ' + scenario + '.',
      evidence: 'The fake review ran in a separate runner-owned session and did not mutate GitHub.',
    }],
    residualRisks: ['policy suggestion smoke evidence from Fresh-Context Review'],
  }, null, 2), 'utf8');
}

function writeMalformedPlanReport(path, run) {
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    parent: {
      title: '[live-smoke:' + run + '] malformed plan parent',
      body: 'Live smoke malformed graph parent.\n\nLIVE_SMOKE_RUN_ID: ' + run,
    },
    graph: {
      nodes: [],
      edges: [],
      specGate: 'wave-level',
    },
    residualRisks: [],
  }, null, 2), 'utf8');
}

function writePlanReportForExistingIssue(path, run, issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error('LIVE_SMOKE_ARBITRARY_ISSUE must be a positive integer');
  }
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    parent: {
      title: '[live-smoke:' + run + '] arbitrary existing issue parent',
      body: 'Live smoke parent attempting arbitrary issue update.\n\nLIVE_SMOKE_RUN_ID: ' + run,
    },
    graph: {
      nodes: [{
        stableId: 'live-smoke-existing',
        issueNumber,
        title: '[live-smoke:' + run + '] should not update arbitrary issue',
        body: 'This node intentionally points at an unmarked existing issue.',
        afkHitl: 'afk',
        ownershipScope: ['src/live-smoke/arbitrary-existing.ts'],
        dependsOn: [],
        verification: ['live smoke arbitrary existing issue block'],
      }],
      edges: [],
      specGate: 'wave-level',
    },
    residualRisks: [],
  }, null, 2), 'utf8');
}

function writePlanReport(path, run) {
  const nodes = ['a', 'b', 'c'].map((id) => ({
    stableId: 'live-smoke-' + id,
    title: '[live-smoke:' + run + '] plan child ' + id,
    body: [
      'Live smoke child ' + id + '.',
      '',
      'LIVE_SMOKE_RUN_ID: ' + run,
      'LIVE_SMOKE_SCENARIO: plan-child',
      'LIVE_SMOKE_CHILD_ID: ' + id,
    ].join('\n'),
    afkHitl: 'afk',
    ownershipScope: ['src/live-smoke/issue-owned-by-child-' + id + '.ts', 'test/live-smoke/issue-owned-by-child-' + id + '.test.ts'],
    dependsOn: id === 'c' ? ['live-smoke-a', 'live-smoke-b'] : [],
    verification: ['live smoke fake child validation'],
  }));
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    parent: {
      title: '[live-smoke:' + run + '] plan-auto parent updated',
      body: 'Live smoke parent updated by fake planning session.\n\nLIVE_SMOKE_RUN_ID: ' + run,
    },
    graph: {
      nodes,
      edges: [
        { from: 'live-smoke-a', to: 'live-smoke-c', reason: 'dependency smoke edge' },
        { from: 'live-smoke-b', to: 'live-smoke-c', reason: 'dependency smoke edge' },
      ],
      specGate: 'wave-level',
    },
    sizeRisk: {
      small: ['live-smoke-a'],
      medium: ['live-smoke-b'],
      high: ['live-smoke-c'],
    },
    parentReviewHandoff: {
      risks: ['Child c depends on child a and child b integration order.'],
      proofStrategy: ['Run final configured checks after all child branches merge.'],
      humanReviewFocus: ['Inspect child wave ordering and integration branch diff.'],
    },
    residualRisks: [],
  }, null, 2), 'utf8');
}

function writePlanQualityReworkReport(path, run) {
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    parent: {
      title: '[live-smoke:' + run + '] tree child quality rework parent updated',
      body: 'Live smoke parent updated for tree-child quality rework.\n\nLIVE_SMOKE_RUN_ID: ' + run,
    },
    graph: {
      nodes: [{
        stableId: 'live-smoke-quality-rework',
        title: '[live-smoke:' + run + '] quality rework child',
        body: [
          'Live smoke quality rework child.',
          '',
          'LIVE_SMOKE_RUN_ID: ' + run,
          'LIVE_SMOKE_SCENARIO: plan-child-quality-rework',
          'LIVE_SMOKE_CHILD_ID: quality-rework',
        ].join('\n'),
        afkHitl: 'afk',
        ownershipScope: [
          'src/live-smoke/issue-owned-by-child-quality-rework.ts',
          'test/live-smoke/issue-owned-by-child-quality-rework.test.ts',
        ],
        dependsOn: [],
        verification: ['live smoke tree-child quality rework validation'],
      }],
      edges: [],
      specGate: 'wave-level',
    },
    sizeRisk: {
      small: ['live-smoke-quality-rework'],
      medium: [],
      high: [],
    },
    parentReviewHandoff: {
      risks: ['Child attempt 0 intentionally misses structured TDD evidence.'],
      proofStrategy: ['Runner must rework the child once and keep the parent unblocked.'],
      humanReviewFocus: ['Inspect child loop outcome evidence.'],
    },
    residualRisks: [],
  }, null, 2), 'utf8');
}

function writePlanTreeRecoveryReport(path, run, recoveredChildIssueNumber, blockedChildIssueNumber) {
  if (!Number.isInteger(recoveredChildIssueNumber) || recoveredChildIssueNumber < 1) {
    throw new Error('LIVE_SMOKE_RECOVERED_CHILD must be a positive integer');
  }
  if (!Number.isInteger(blockedChildIssueNumber) || blockedChildIssueNumber < 1) {
    throw new Error('LIVE_SMOKE_BLOCKED_CHILD must be a positive integer');
  }
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    parent: {
      title: '[live-smoke:' + run + '] tree recovery parent resumed',
      body: 'Live smoke parent resumed from stale runner-owned tree state.\n\nLIVE_SMOKE_RUN_ID: ' + run,
    },
    graph: {
      nodes: [
        {
          stableId: 'live-smoke-recovered',
          issueNumber: recoveredChildIssueNumber,
          title: '[live-smoke:' + run + '] recovered child',
          body: 'Recovered child already completed before parent resume.',
          afkHitl: 'afk',
          ownershipScope: ['src/live-smoke/recovered-child.ts'],
          dependsOn: [],
          verification: ['live smoke recovered child validation'],
        },
        {
          stableId: 'live-smoke-blocked-rework',
          issueNumber: blockedChildIssueNumber,
          title: '[live-smoke:' + run + '] blocked child rework resumed',
          body: [
            'Blocked child should resume through automatic rework.',
            '',
            'LIVE_SMOKE_RUN_ID: ' + run,
            'LIVE_SMOKE_SCENARIO: plan-child-quality-rework',
            'LIVE_SMOKE_CHILD_ID: tree-recovery-rework',
          ].join('\n'),
          afkHitl: 'afk',
          ownershipScope: [
            'src/live-smoke/issue-owned-by-child-tree-recovery-rework.ts',
            'test/live-smoke/issue-owned-by-child-tree-recovery-rework.test.ts',
          ],
          dependsOn: ['live-smoke-recovered'],
          verification: ['live smoke retryable blocked child recovery validation'],
        },
      ],
      edges: [
        { from: 'live-smoke-recovered', to: 'live-smoke-blocked-rework', reason: 'recovered child must unblock resumed rework child' },
      ],
      specGate: 'wave-level',
    },
    sizeRisk: {
      small: ['live-smoke-recovered'],
      medium: ['live-smoke-blocked-rework'],
      high: [],
    },
    parentReviewHandoff: {
      risks: ['Parent starts from stale runner-owned state with one recovered child and one retryable blocked child.'],
      proofStrategy: ['Verify recovered durable summary evidence and automatic rework attempt evidence in the parent PR.'],
      humanReviewFocus: ['Confirm recovered child was not re-run and blocked child resumed from existing worktree.'],
    },
    residualRisks: [],
  }, null, 2), 'utf8');
}

function writePlanRiskRoutingWarningReport(path, run) {
  const nodes = ['risk-a', 'risk-b', 'risk-c'].map((id) => ({
    stableId: 'live-smoke-' + id,
    title: '[live-smoke:' + run + '] plan child ' + id,
    body: [
      'Live smoke risk-routing child ' + id + '.',
      '',
      'LIVE_SMOKE_RUN_ID: ' + run,
      'LIVE_SMOKE_SCENARIO: plan-child',
      'LIVE_SMOKE_CHILD_ID: ' + id,
    ].join('\n'),
    afkHitl: 'afk',
    ownershipScope: ['src/live-smoke/issue-owned-by-child-' + id + '.ts', 'test/live-smoke/issue-owned-by-child-' + id + '.test.ts'],
    dependsOn: id === 'risk-c' ? ['live-smoke-risk-a', 'live-smoke-risk-b'] : [],
    verification: ['live smoke fake child validation'],
  }));
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    parent: {
      title: '[live-smoke:' + run + '] risk-routing parent updated',
      body: 'Live smoke parent updated with intentionally missing risk routing metadata.\n\nLIVE_SMOKE_RUN_ID: ' + run,
    },
    graph: {
      nodes,
      edges: [
        { from: 'live-smoke-risk-a', to: 'live-smoke-risk-c', reason: 'dependency smoke edge' },
        { from: 'live-smoke-risk-b', to: 'live-smoke-risk-c', reason: 'dependency smoke edge' },
      ],
      specGate: 'wave-level',
    },
    residualRisks: [],
  }, null, 2), 'utf8');
}

function gitCommit(message) {
  execFileSync('git', ['add', '--all'], { stdio: 'pipe' });
  execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=live-smoke-fake-agent',
    '-c', 'user.email=live-smoke@example.invalid',
    'commit',
    '--no-verify',
    '-m',
    message,
  ], { stdio: 'pipe' });
}
`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
