#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultTimeoutMs = 600_000;

const scenarioDefinitions = new Map([
  ['baseline', runBaselineScenario],
  ['real-codex', runRealCodexScenario],
  ['scoped-runner-commit', runScopedRunnerCommitScenario],
  ['scoped-local-commit', runScopedLocalCommitScenario],
  ['visual-proof', runVisualProofScenario],
  ['local-commit-blocked', runLocalCommitBlockedScenario],
  ['denied-secret', runDeniedSecretScenario],
  ['invalid-report', runInvalidReportScenario],
  ['plan-auto', runPlanAutoScenario],
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const selectedScenarios = options.scenarios.length > 0 ? options.scenarios : Array.from(scenarioDefinitions.keys());
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
    visualProofPath: '',
    targetRoot: '',
    cliPath: '',
    repo: options.repo ?? await inferRepo(),
  };

  await appendReport(context, `# Live smoke ${runId}\n\nRepo: ${context.repo}\n\n`);

  try {
    context.cliPath = await preparePackagedCli(context);
    context.fakeAgentPath = await writeFakeAgent(root);
    context.visualProofPath = await writeVisualProofScript(root);
    context.targetRoot = await prepareTargetRepository(context);
    await runPackagedCli(context, ['setup', '--target', context.targetRoot, '--github-owner', ownerOf(context.repo), '--github-repo', repoNameOf(context.repo), '--prepare-labels']);
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
  } finally {
    if (options.cleanup) {
      await cleanupGitHubArtifacts(context);
    } else {
      await appendReport(context, '\n## Cleanup\n\nArtifacts kept for inspection. Run with --cleanup to close created issues and PRs.\n');
    }
  }
}

function parseArgs(args) {
  const options = {
    scenarios: [],
    cleanup: false,
    skipLocalTests: false,
    keepPackageTarball: false,
    timeoutMs: defaultTimeoutMs,
    repo: undefined,
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
      case '--repo':
        requireValue(arg, next);
        options.repo = next;
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
    '  --repo <owner/name>        GitHub repository. Defaults to gh repo view.',
    '  --target <path>            Existing local target repo. Defaults to a temp clone.',
    '  --work-dir <path>          Directory for smoke temp files and report.',
    '  --run-id <id>              Stable id used in issue titles and local state paths.',
    '  --timeout-ms <number>      Per-command timeout. Default 600000.',
    '  --cleanup                  Close created issues and PRs after the run.',
    '  --skip-local-tests         Skip npm test before npm pack.',
    '  --keep-package-tarball     Do not delete the npm pack tarball.',
    '',
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
  if (overrides.runnerValidationCommand) {
    config.reviewGates.visualProof.runnerValidationCommand = overrides.runnerValidationCommand;
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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

async function runScopedRunnerCommitScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const issue = await createIssue(context, 'scoped-runner-commit', ['agent:auto']);
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false });
}

async function runScopedLocalCommitScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const issue = await createIssue(context, 'scoped-local-commit', ['agent:auto']);
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: true });
}

async function runVisualProofScenario(context) {
  await configureTarget(context, {
    allowAgentLocalCommits: true,
    runnerValidationCommand: `${process.execPath} ${JSON.stringify(context.visualProofPath)}`,
  });
  const issue = await createIssue(
    context,
    'visual-proof',
    ['agent:auto'],
    'UI visual screenshot smoke. This should trigger the visual proof gate.',
  );
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertScopedSuccess(context, issue.number, { expectLocalCommit: false, expectScreenshotProof: true });
}

async function runLocalCommitBlockedScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: false });
  const issue = await createIssue(context, 'scoped-local-commit', ['agent:auto'], 'This scenario should block because local commits are disabled.');
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertBlockedIssue(context, issue.number, 'Codex changed git HEAD');
  await assertNoPullRequestForBranch(context, `codex/issue-${issue.number}`);
}

async function runDeniedSecretScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true, additionalPathGlobs: ['live-smoke-denied/**'] });
  const issue = await createIssue(context, 'denied-secret', ['agent:auto']);
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertBlockedIssue(context, issue.number, 'matches denied pattern live-smoke-denied/**');
  await assertNoPullRequestForBranch(context, `codex/issue-${issue.number}`);
}

async function runInvalidReportScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const issue = await createIssue(context, 'invalid-report', ['agent:auto']);
  await runDaemonOnce(context, issue.number, 'scoped-issue');
  await assertBlockedIssue(context, issue.number, 'report must be valid JSON');
  await assertNoPullRequestForBranch(context, `codex/issue-${issue.number}`);
}

async function runPlanAutoScenario(context) {
  await configureTarget(context, { allowAgentLocalCommits: true });
  const issue = await createIssue(context, 'plan-auto', ['agent:plan-auto']);
  await runDaemonOnce(context, issue.number, 'plan-parent');

  const parent = await getIssue(context, issue.number);
  assertHasLabel(parent, 'agent:review');
  assertMissingLabel(parent, 'agent:running');
  assertIssueHasComment(parent, `codex-orchestrator issue-tree review report for #${issue.number}`);

  const branchName = `codex/tree-${issue.number}`;
  context.createdBranches.push(branchName);
  await assertRemoteBranchExists(context, branchName);
  const pullRequest = await findPullRequestByBranch(context, branchName);
  assert(pullRequest, `expected draft PR for ${branchName}`);
  assert(pullRequest.isDraft === true, `expected ${branchName} PR to be a draft`);
  context.createdPullRequests.push(pullRequest.number);

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

async function runDaemonOnce(context, issueNumber, mode) {
  await assertOnlyEligibleIssue(context, issueNumber, mode);
  const result = await runPackagedCli(context, ['daemon', '--target', context.targetRoot, '--once', '--max-runs', '1']);
  assertIncludes(result.stdout, `running #${issueNumber} ${mode}`, `daemon should pick issue #${issueNumber}`);
  assertIncludes(result.stdout, `completed #${issueNumber}`, `daemon should complete issue #${issueNumber}`);
}

async function createIssue(context, scenario, labels, extraBody = '') {
  await assertNoEligibleIssues(context);
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

async function assertScopedSuccess(context, issueNumber, { expectLocalCommit, expectScreenshotProof = false }) {
  const issue = await getIssue(context, issueNumber);
  assertHasLabel(issue, 'agent:review');
  assertMissingLabel(issue, 'agent:running');
  assertIssueHasComment(issue, `codex-orchestrator review report for #${issueNumber}`);

  const branchName = `codex/issue-${issueNumber}`;
  context.createdBranches.push(branchName);
  await assertRemoteBranchExists(context, branchName);
  const pullRequest = await findPullRequestByBranch(context, branchName);
  assert(pullRequest, `expected draft PR for ${branchName}`);
  assert(pullRequest.isDraft === true, `expected ${branchName} PR to be a draft`);
  context.createdPullRequests.push(pullRequest.number);
  const body = await getPullRequestBody(context, pullRequest.number);
  assertIncludes(body, `Closes #${issueNumber}`, 'PR body should link issue');
  assertIncludes(body, 'Validation', 'PR body should include validation evidence');
  assertIncludes(body, 'Log', 'PR body should include log evidence');
  if (expectLocalCommit) {
    assertIncludes(body.toLowerCase(), 'local commits', 'PR body should include local commit summary');
    assertIncludes(body, 'Live smoke agent checkpoint', 'PR body should include fake agent commit');
    const log = await gitOutput(context.targetRoot, ['log', '--oneline', `origin/${branchName}`, '-5']);
    assertIncludes(log, 'Live smoke agent checkpoint', 'remote branch should include fake agent commit');
  }
  if (expectScreenshotProof) {
    assertIncludes(body, '![screenshot: runner visual proof live-smoke-screenshot.png]', 'PR body should embed screenshot proof markdown');
    assertIncludes(body, `.codex-orchestrator/proofs/issue-${issueNumber}/live-smoke-screenshot.png`, 'PR body should link screenshot artifact path');
    const screenshotPath = join(
      context.targetRoot,
      '.codex-orchestrator',
      'workspaces',
      `live-smoke-${context.runId}`,
      `issue-${issueNumber}`,
      '.codex-orchestrator',
      'proofs',
      `issue-${issueNumber}`,
      'live-smoke-screenshot.png',
    );
    await assertPathExists(screenshotPath, 'runner visual proof screenshot was not written');
    await appendReport(context, `Screenshot proof: ${screenshotPath}\n\n`);
  }
  await assertLogFileExists(context, issueNumber);
  await assertRunStateCleared(context, issueNumber);
}

async function assertBlockedIssue(context, issueNumber, expectedCommentText) {
  const issue = await getIssue(context, issueNumber);
  assertHasLabel(issue, 'agent:blocked');
  assertMissingLabel(issue, 'agent:running');
  assertIssueHasComment(issue, `codex-orchestrator blocked scoped execution for #${issueNumber}`);
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

async function getIssue(context, issueNumber) {
  const result = await runCommand('gh', [
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    context.repo,
    '--json',
    'number,title,body,url,state,labels,comments',
  ], { timeoutMs: context.options.timeoutMs });
  return JSON.parse(result.stdout);
}

async function listIssuesByRunId(context) {
  const result = await runCommand('gh', [
    'issue',
    'list',
    '--repo',
    context.repo,
    '--state',
    'open',
    '--limit',
    '1000',
    '--json',
    'number,title,body,url,state,labels,comments',
  ], { timeoutMs: context.options.timeoutMs });
  return JSON.parse(result.stdout).filter((issue) => issue.title.includes(`[live-smoke:${context.runId}]`));
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
  ], { timeoutMs: context.options.timeoutMs });
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
  ], { timeoutMs: context.options.timeoutMs });
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
  for (const prNumber of [...new Set(context.createdPullRequests)].reverse()) {
    await bestEffort(context, `close PR #${prNumber}`, async () => {
      await runCommand('gh', ['pr', 'close', String(prNumber), '--repo', context.repo, '--comment', `[live-smoke:${context.runId}] cleanup`], {
        timeoutMs: context.options.timeoutMs,
      });
    });
  }
  for (const branchName of [...new Set(context.createdBranches)].reverse()) {
    await bestEffort(context, `delete branch ${branchName}`, async () => {
      await runCommand('git', ['-C', context.targetRoot, 'push', 'origin', '--delete', branchName], {
        timeoutMs: context.options.timeoutMs,
      });
    });
  }
  for (const issueNumber of [...new Set(context.createdIssues)].reverse()) {
    await bestEffort(context, `close issue #${issueNumber}`, async () => {
      await runCommand('gh', ['issue', 'close', String(issueNumber), '--repo', context.repo, '--comment', `[live-smoke:${context.runId}] cleanup`], {
        timeoutMs: context.options.timeoutMs,
      });
    });
  }
}

async function discoverCreatedArtifacts(context) {
  try {
    const issues = await listIssuesByRunId(context);
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
      '100',
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
  } catch (error) {
    await appendReport(context, `- ${label}: failed - ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function inferRepo() {
  const result = await runCommand('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: sourceRoot, timeoutMs: defaultTimeoutMs });
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed.nameWithOwner !== 'string') {
    throw new Error('Could not infer GitHub repo from gh repo view');
  }
  return parsed.nameWithOwner;
}

async function defaultBranchFor(repo) {
  const result = await runCommand('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef'], { timeoutMs: defaultTimeoutMs });
  const parsed = JSON.parse(result.stdout);
  const name = parsed.defaultBranchRef?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Could not resolve default branch for ${repo}`);
  }
  return name;
}

function ownerOf(repo) {
  return repo.split('/')[0];
}

function repoNameOf(repo) {
  return repo.split('/')[1];
}

async function runPackagedCli(context, args) {
  return runCommand(process.execPath, [context.cliPath, ...args], {
    cwd: context.targetRoot || sourceRoot,
    timeoutMs: context.options.timeoutMs,
  });
}

async function gitOutput(cwd, args) {
  const result = await runCommand('git', ['-C', cwd, ...args], { timeoutMs: defaultTimeoutMs });
  return result.stdout;
}

async function runCommand(command, args, options = {}) {
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

async function writeVisualProofScript(root) {
  const scriptPath = join(root, 'live-smoke-visual-proof.mjs');
  await writeFile(scriptPath, visualProofSource(), 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function visualProofSource() {
  return String.raw`#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const proofDir = process.env.CODEX_ORCHESTRATOR_PROOF_DIR;
if (!proofDir) {
  throw new Error('CODEX_ORCHESTRATOR_PROOF_DIR is required');
}

mkdirSync(proofDir, { recursive: true });
const screenshotPath = join(proofDir, 'live-smoke-screenshot.png');

try {
  execFileSync('screencapture', ['-x', screenshotPath], { stdio: 'ignore' });
} catch (error) {
  throw new Error('screencapture failed; live smoke requires a real screenshot artifact: ' + error.message);
}

process.stdout.write('live smoke screenshot proof written to ' + screenshotPath + '\n');
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
const scenario = inferScenarioFromReportPath(reportPath) ?? readMarker(prompt, 'LIVE_SMOKE_SCENARIO');
const runId = readMarker(prompt, 'LIVE_SMOKE_RUN_ID') ?? 'unknown';

console.log(JSON.stringify({ type: 'live-smoke', message: 'starting ' + scenario + ' for #' + issueNumber }));
console.error('live-smoke fake stderr for #' + issueNumber + '\n');
mkdirSync(dirname(reportPath), { recursive: true });

switch (scenario) {
  case 'scoped-runner-commit':
    writeCodeChange(issueNumber, runId, 'runner');
    writeScopedReport(reportPath, ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts']);
    break;
  case 'scoped-local-commit':
    writeCodeChange(issueNumber, runId, 'local');
    gitCommit('Live smoke agent checkpoint #' + issueNumber);
    writeScopedReport(reportPath, ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts']);
    break;
  case 'visual-proof':
    writeVisualChange(issueNumber, runId);
    writeScopedReport(reportPath, ['components/live-smoke/issue-' + issueNumber + '.tsx', 'test/live-smoke/issue-' + issueNumber + '.test.ts']);
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
  case 'plan-child':
    writeCodeChange(issueNumber, runId, 'plan-child');
    writeScopedReport(reportPath, ['src/live-smoke/issue-' + issueNumber + '.ts', 'test/live-smoke/issue-' + issueNumber + '.test.ts']);
    break;
  default:
    throw new Error('Unknown LIVE_SMOKE_SCENARIO: ' + scenario);
}

console.log(JSON.stringify({ type: 'live-smoke', message: 'completed ' + scenario + ' for #' + issueNumber }));

function readMarker(text, key) {
  return text.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))?.[1]?.trim();
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

function writeVisualChange(issue, run) {
  mkdirSync('components/live-smoke', { recursive: true });
  mkdirSync('test/live-smoke', { recursive: true });
  writeFileSync(
    join('components', 'live-smoke', 'issue-' + issue + '.tsx'),
    'export const LiveSmokeVisualIssue' + issue + ' = ' + JSON.stringify({ issue, run, kind: 'visual-proof' }) + ';\n',
    'utf8',
  );
  writeFileSync(
    join('test', 'live-smoke', 'issue-' + issue + '.test.ts'),
    'import assert from "node:assert/strict";\nassert.match(' + JSON.stringify(run) + ', /.+/);\n',
    'utf8',
  );
}

function writeScopedReport(path, changes) {
  writeFileSync(path, JSON.stringify({
    status: 'completed',
    changes,
    validation: [
      { command: 'red-green live smoke', status: 'passed', summary: 'test failed before implementation and passed after implementation' },
      { command: 'code-review live smoke', status: 'passed', summary: 'code review completed for live smoke fixture' },
    ],
    artifacts: [],
    skippedChecks: [],
    residualRisks: [],
    prohibitedActions: [],
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
