#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultTimeoutMs = 1_800_000;
const liveSmokeModel = 'gpt-5.6-luna';
const defaultLiveSmokeRepo = process.env.CODEX_ORCHESTRATOR_LIVE_SMOKE_REPO
  ?? 'SergiiMytakii/codex-orchestrator-live-smoke';
const cleanupModes = new Set(['delete', 'close']);

const scenarioDefinitions = new Map([
  ['package-install', runPackageInstallScenario],
  ['discovery-matrix', runDiscoveryMatrixScenario],
  ['real-codex', runRealCodexScenario],
  ['commit-policy', runCommitPolicyScenario],
  ['incomplete-progress-rework', runReviewReadyScenario],
  ['report-repair', runReviewReadyScenario],
  ['diagnostics', runDiagnosticsScenario],
  ['browser-proof', runReviewReadyScenario],
  ['acceptance-proof-positive', runReviewReadyScenario],
  ['acceptance-proof-rework', runReviewReadyScenario],
  ['acceptance-proof-negative', runAcceptanceProofNegativeScenario],
  ['android-proof', runAndroidProofScenario],
  ['ios-proof', runIosProofScenario],
  ['quality-gates', runQualityGatesScenario],
  ['safety-negative', runSafetyNegativeScenario],
]);

const scenarioProfiles = new Map([
  ['core-release', [
    'package-install', 'real-codex', 'browser-proof', 'safety-negative',
  ]],
  ['v2-regression', [
    'discovery-matrix', 'commit-policy', 'incomplete-progress-rework', 'report-repair',
    'diagnostics', 'acceptance-proof-positive', 'acceptance-proof-rework',
    'acceptance-proof-negative', 'quality-gates',
  ]],
  ['mobile-proof', ['android-proof', 'ios-proof']],
  ['full', Array.from(scenarioDefinitions.keys())],
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(helpText()); return; }
  if (options.selfTestFakeAgent) { await selfTestFakeAgent(); return; }
  if (options.selfTestLiveCodex) { await selfTestLiveCodex(); return; }
  const selected = selectScenarios(options);
  const runId = options.runId ?? new Date().toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14);
  const root = options.workDir ? resolve(options.workDir) : await mkdtemp(join(tmpdir(), `codex-orchestrator-v2-smoke-${runId}-`));
  const context = {
    options, runId, root, sourceRoot, repo: options.repo,
    reportPath: join(root, 'live-smoke-report.md'), modelAuditPath: join(root, 'model-audit.jsonl'),
    targetRoot: '', cliPath: '', liveCodexPath: '',
    baseConfig: undefined, createdIssues: [], createdPullRequests: [], createdBranches: [],
  };
  await appendReport(context, `# V2 live smoke ${runId}\n\nRepository: ${context.repo}\n\nModel: ${liveSmokeModel}\n\n`);
  let failed = false;
  try {
    context.cliPath = await preparePackagedCandidate(context);
    context.liveCodexPath = await writeLiveCodex(context);
    context.targetRoot = await prepareTarget(context);
    await requireTypedSetup(context, ['setup', '--target', context.targetRoot, '--github-owner', ownerOf(context.repo), '--github-repo', repoOf(context.repo), '--prepare-labels']);
    context.baseConfig = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
    await configureTarget(context);
    for (const scenario of selected) {
      process.stdout.write(`[v2-live-smoke] ${scenario}\n`);
      const started = Date.now();
      const modelCallsBefore = await readModelAudit(context);
      await scenarioDefinitions.get(scenario)(context, scenario);
      const modelCallsAfter = await readModelAudit(context);
      const modelCalls = modelCallsAfter.slice(modelCallsBefore.length);
      assertScenarioModelUsage(scenario, modelCalls);
      const modelEvidence = modelCalls.length > 0 ? `${modelCalls.length} x ${liveSmokeModel}` : 'not model-backed';
      await appendReport(context, `- ${scenario}: passed (${Date.now() - started}ms; ${modelEvidence})\n`);
    }
    await appendReport(context, '\nAll selected scenarios passed.\n');
    process.stdout.write(`[v2-live-smoke] passed; report ${context.reportPath}\n`);
  } catch (error) {
    failed = true;
    await appendReport(context, `\nFailure: ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  } finally {
    if (options.cleanup) {
      try { await cleanup(context); }
      catch (error) {
        if (!failed) throw error;
        process.stderr.write(`[v2-live-smoke] cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    } else {
      await appendReport(context, '\nArtifacts retained by --keep-artifacts.\n');
    }
  }
}

function parseArgs(args) {
  const options = {
    scenarios: [], profile: 'core-release', repo: defaultLiveSmokeRepo, cleanup: true,
    cleanupMode: 'delete', skipLocalTests: false, keepPackageTarball: false,
    timeoutMs: defaultTimeoutMs, target: undefined, workDir: undefined, runId: undefined, help: false,
    selfTestFakeAgent: false, selfTestLiveCodex: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]; const value = args[index + 1];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (flag === '--keep-artifacts') { options.cleanup = false; continue; }
    if (flag === '--skip-local-tests') { options.skipLocalTests = true; continue; }
    if (flag === '--keep-package-tarball') { options.keepPackageTarball = true; continue; }
    if (flag === '--self-test-fake-agent') { options.selfTestFakeAgent = true; continue; }
    if (flag === '--self-test-live-codex') { options.selfTestLiveCodex = true; continue; }
    if (['--scenario', '--profile', '--repo', '--cleanup-mode', '--timeout-ms', '--target', '--work-dir', '--run-id'].includes(flag)) {
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      if (flag === '--scenario') options.scenarios.push(value);
      else if (flag === '--profile') options.profile = value;
      else if (flag === '--repo') options.repo = value;
      else if (flag === '--cleanup-mode') options.cleanupMode = value;
      else if (flag === '--timeout-ms') options.timeoutMs = Number(value);
      else if (flag === '--target') options.target = value;
      else if (flag === '--work-dir') options.workDir = value;
      else if (flag === '--run-id') options.runId = value.replace(/[^a-zA-Z0-9._-]/gu, '-');
      index += 1; continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (!cleanupModes.has(options.cleanupMode)) throw new Error('--cleanup-mode must be one of: delete, close');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  return options;
}

function selectScenarios(options) {
  if (options.scenarios.length > 0) {
    for (const scenario of options.scenarios) requireKnown('scenario', scenario, scenarioDefinitions);
    return [...new Set(options.scenarios)];
  }
  requireKnown('profile', options.profile, scenarioProfiles);
  return scenarioProfiles.get(options.profile);
}

function requireKnown(kind, value, registry) {
  if (!registry.has(value)) throw new Error(`Unknown ${kind} "${value}". Known ${kind}s: ${Array.from(registry.keys()).join(', ')}`);
}

function helpText() {
  return [
    'V2 packed live smoke against a scratch GitHub repository.',
    `Default repository: ${defaultLiveSmokeRepo}`,
    `Scenarios: ${Array.from(scenarioDefinitions.keys()).join(', ')}`,
    `Profiles: ${Array.from(scenarioProfiles.keys()).join(', ')}`,
    'Default core-release. Use --profile or repeat --scenario.',
    'Clean up created issues, PRs, and branches after the run by default.',
    'Cleanup mode: delete or close. Default delete.',
    '',
  ].join('\n');
}

async function preparePackagedCandidate(context) {
  if (!context.options.skipLocalTests) {
    await runCommand('npm', ['run', 'typecheck', '--silent'], { cwd: sourceRoot, timeoutMs: context.options.timeoutMs });
    await runCommand('npm', ['run', 'build', '--silent'], { cwd: sourceRoot, timeoutMs: context.options.timeoutMs });
    await runCommand(process.execPath, [
      'dist/test/v2-cli.test.js', 'dist/test/v2-package-consumer.test.js', 'dist/test/v2-live-smoke-script.test.js',
    ], { cwd: sourceRoot, timeoutMs: context.options.timeoutMs });
  }
  const packed = await runCommand('npm', ['pack', '--json'], { cwd: sourceRoot, timeoutMs: context.options.timeoutMs });
  const file = parseNpmPackOutput(packed.stdout)?.[0]?.filename;
  if (typeof file !== 'string') throw new Error('npm pack did not return one tarball');
  const tarball = join(sourceRoot, file);
  const extracted = join(context.root, 'packed');
  await mkdir(extracted, { recursive: true });
  await runCommand('tar', ['-xzf', tarball, '-C', extracted], { timeoutMs: context.options.timeoutMs });
  if (!context.options.keepPackageTarball) await rm(tarball, { force: true });
  const cliPath = join(extracted, 'package', 'dist', 'src', 'v2', 'cli.js');
  await readFile(cliPath);
  const help = await runCommand(process.execPath, [cliPath, '--help'], { timeoutMs: context.options.timeoutMs });
  if (!help.stdout.startsWith('codex-orchestrator\n')) throw new Error('packed CLI help is not public V2');
  return cliPath;
}

export function parseNpmPackOutput(stdout) {
  const lines = String(stdout).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== '[') continue;
    try {
      const value = JSON.parse(lines.slice(index).join('\n'));
      if (Array.isArray(value)) return value;
    } catch {
      // A lifecycle script may have printed an unrelated bracketed line; keep searching.
    }
  }
  throw new Error('npm pack did not return a JSON array');
}

async function prepareTarget(context) {
  if (context.options.target) return resolve(context.options.target);
  const target = join(context.root, 'target');
  const branch = await defaultBranch(context.repo);
  await runCommand('gh', ['repo', 'clone', context.repo, target, '--', '--branch', branch], { timeoutMs: context.options.timeoutMs });
  return target;
}

async function configureTarget(context, overrides = {}) {
  const config = structuredClone(context.baseConfig);
  config.runner.workspaceRoot = `.codex-orchestrator/workspaces-v2-${context.runId}`;
  config.runner.stateDir = `.codex-orchestrator/v2/state-${context.runId}`;
  config.proof.artifactDir = `.codex-orchestrator/v2/proofs-${context.runId}`;
  config.codex.command = context.liveCodexPath;
  config.codex.timeoutMs = 600_000;
  config.codex.idleTimeoutMs = overrides.idleTimeoutMs ?? 60_000;
  config.checks = overrides.failingCheck
    ? { smoke: `${process.execPath} -e "process.exit(1)"` }
    : { smoke: `${process.execPath} --version` };
  await writeFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function runReviewReadyScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true);
  const result = await runIssue(context, issue.number);
  assertResult(result, { status: 'review-ready' }, scenario);
  if (scenario === 'acceptance-proof-rework') await assertReworkCycle(context, issue.number);
  await recordPublication(context, issue.number);
}

async function assertReworkCycle(context, issueNumber) {
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
  const state = JSON.parse(await readFile(join(context.targetRoot, config.runner.stateDir, 'v2', 'run-state.json'), 'utf8'));
  const run = state.runs.find((candidate) => candidate.issueNumber === issueNumber);
  if (run?.cycle !== 2) throw new Error(`acceptance-proof-rework: expected cycle=2, received ${run?.cycle ?? 'missing'}`);
}

async function runPackageInstallScenario(context, scenario) {
  const external = join(context.root, 'consumer');
  await mkdir(external, { recursive: true });
  await writeFile(join(external, 'package.json'), '{"private":true,"type":"module"}\n');
  const packageRoot = resolve(dirname(context.cliPath), '../../..');
  await runCommand('npm', ['install', packageRoot, '--ignore-scripts'], { cwd: external, timeoutMs: context.options.timeoutMs });
  await readFile(join(external, 'node_modules', 'codex-orchestrator', 'dist', 'src', 'v2', 'cli.js'));
  await runReviewReadyScenario(context, scenario);
}

async function runDiscoveryMatrixScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, false);
  assertResult(await runIssue(context, issue.number), { status: 'not-eligible' }, scenario);
}

async function runRealCodexScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true, [
    'Create src/live-smoke/real-codex.txt containing this issue number.',
    'Implementation and proof reports satisfy the runner-generated JSON schemas; neither agent commits nor publishes.',
  ], false);
  assertResult(await runIssue(context, issue.number), { status: 'review-ready' }, scenario);
  await recordPublication(context, issue.number);
}

async function runCommitPolicyScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true);
  assertResult(await runIssue(context, issue.number), { status: 'blocked', kind: 'safety' }, scenario);
}

async function runDiagnosticsScenario(context, scenario) {
  await configureTarget(context);
  for (const command of ['doctor', 'status']) {
    const envelope = await requireTypedSetup(context, [command, '--target', context.targetRoot]);
    if (envelope.result.status !== 'inspected') throw new Error(`${command} did not return an inspected Setup result`);
  }
  await runReviewReadyScenario(context, scenario);
}

async function runAcceptanceProofNegativeScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true);
  assertResult(await runIssue(context, issue.number), { status: 'blocked', kind: 'external' }, scenario);
}

async function runAndroidProofScenario(context) {
  await runCommand(process.execPath, [join(sourceRoot, 'dist', 'test', 'v2-android-real-gate.js')], { timeoutMs: context.options.timeoutMs });
}

async function runIosProofScenario(context) {
  await runCommand(process.execPath, [join(sourceRoot, 'dist', 'test', 'v2-ios-real-gate.js')], { timeoutMs: context.options.timeoutMs });
}

async function runQualityGatesScenario(context, scenario) {
  await configureTarget(context, { failingCheck: true });
  const issue = await createIssue(context, scenario, true);
  assertResult(await runIssue(context, issue.number), { status: 'blocked', kind: 'exhausted' }, scenario);
}

async function runSafetyNegativeScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true);
  assertResult(await runIssue(context, issue.number), { status: 'blocked', kind: 'safety' }, scenario);
}

async function createIssue(context, scenario, eligible, extraCriteria = [], markersAsCriteria = true) {
  const title = `[live-smoke:${context.runId}] ${scenario}`;
  const markers = [`LIVE_SMOKE_SCENARIO=${scenario}`, `LIVE_SMOKE_RUN_ID=${context.runId}`];
  const behaviorCriteria = extraCriteria.length > 0 || !eligible ? extraCriteria : [
    `Create src/live-smoke/${scenario}.txt as one line containing ${scenario}, followed by one LF newline.`,
    `Create test/live-smoke/${scenario}.txt as one line containing proof for ${scenario}, followed by one LF newline.`,
  ];
  const criteria = [...(markersAsCriteria ? markers : []), ...behaviorCriteria];
  const args = ['issue', 'create', '--repo', context.repo, '--title', title, '--body', [
    'V2 packed live-smoke fixture.', ...markers.map((value) => `${value}`), '',
    '## Acceptance Criteria', ...criteria.map((value) => `- ${value}`),
  ].join('\n')];
  if (eligible) args.push('--label', 'agent:auto');
  const created = await runCommand('gh', args, { timeoutMs: context.options.timeoutMs });
  const number = Number(created.stdout.match(/\/issues\/(\d+)/u)?.[1]);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('GitHub did not return a created issue number');
  context.createdIssues.push(number);
  return { number };
}

async function runIssue(context, issueNumber) {
  const command = await runCommand(process.execPath, [context.cliPath, 'run', '--target', context.targetRoot, '--issue', String(issueNumber)], {
    cwd: context.targetRoot, timeoutMs: context.options.timeoutMs, allowedExitCodes: [0, 20, 21, 70, 130],
    env: { ...process.env, CODEX_ORCHESTRATOR_LIVE_SMOKE_MODEL: liveSmokeModel },
  });
  const envelope = parseExactEnvelope(command.stdout, 'codex-orchestrator.agent-auto-run-result');
  const expectedExit = { 'review-ready': 0, blocked: 20, 'not-eligible': 21, 'transport-failed': 70, cancelled: 130, 'internal-error': 70 }[envelope.result.status];
  if (expectedExit === undefined || command.status !== expectedExit) throw new Error('typed run result and process exit disagree');
  return envelope.result;
}

async function requireTypedSetup(context, args) {
  const command = await runCommand(process.execPath, [context.cliPath, ...args], {
    cwd: context.targetRoot || sourceRoot, timeoutMs: context.options.timeoutMs, allowedExitCodes: [0, 20, 70],
  });
  return parseExactEnvelope(command.stdout, 'codex-orchestrator.agent-auto-setup-result');
}

function parseExactEnvelope(stdout, schema) {
  let value;
  try { value = JSON.parse(stdout); } catch { throw new Error(`package returned non-JSON output for ${schema}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'result,schema,version'
    || value.schema !== schema || value.version !== 1 || !value.result || typeof value.result !== 'object') {
    throw new Error(`package returned an invalid ${schema} envelope`);
  }
  return value;
}

function assertResult(actual, expected, scenario) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`${scenario}: expected ${key}=${value}, received ${actual[key]}`);
  }
}

async function recordPublication(context, issueNumber) {
  const branch = `codex/issue-${issueNumber}`;
  context.createdBranches.push(branch);
  const result = await runCommand('gh', ['pr', 'list', '--repo', context.repo, '--head', branch, '--state', 'open', '--json', 'number,isDraft', '--limit', '2'], {
    timeoutMs: context.options.timeoutMs,
  });
  const pulls = JSON.parse(result.stdout);
  if (!Array.isArray(pulls) || pulls.length !== 1 || !Number.isSafeInteger(pulls[0].number) || pulls[0].isDraft !== true) {
    throw new Error(`one draft PR was not found for ${branch}`);
  }
  await runCommand('git', ['-C', context.targetRoot, 'fetch', 'origin', branch], { timeoutMs: context.options.timeoutMs });
  const commits = await runCommand('git', ['-C', context.targetRoot, 'log', '--format=%an <%ae>', `${context.baseConfig.github.baseBranch}..origin/${branch}`], {
    timeoutMs: context.options.timeoutMs,
  });
  if (commits.stdout.trim() !== 'codex-orchestrator <codex-orchestrator@users.noreply.github.com>') {
    throw new Error(`${branch} was not published as exactly one runner-authored commit`);
  }
  context.createdPullRequests.push(pulls[0].number);
}

async function writeFakeCodex(context) {
  const path = join(context.root, 'fake-codex');
  await writeFile(path, fakeCodexSource(process.execPath));
  await chmod(path, 0o700);
  return path;
}

async function writeLiveCodex(context) {
  const path = join(context.root, 'live-codex');
  await writeFile(path, liveCodexSource(process.execPath, context.modelAuditPath));
  await chmod(path, 0o700);
  return path;
}

async function readModelAudit(context) {
  let content = '';
  try { content = await readFile(context.modelAuditPath, 'utf8'); } catch {}
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function assertScenarioModelUsage(scenario, calls) {
  const modelBacked = !['discovery-matrix', 'android-proof', 'ios-proof'].includes(scenario);
  if (modelBacked && calls.length === 0) throw new Error(`${scenario}: no real Codex model invocation was observed`);
  if (!modelBacked && calls.length !== 0) throw new Error(`${scenario}: model was invoked on a model-free gate`);
  if (calls.some((call) => call.model !== liveSmokeModel)) {
    throw new Error(`${scenario}: model audit did not prove ${liveSmokeModel}`);
  }
}

function liveCodexSource(nodePath, auditPath) {
  return `#!${nodePath}
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const expectedModel = ${JSON.stringify(liveSmokeModel)};
const auditPath = ${JSON.stringify(auditPath)};
if (args[0] === '--version') { forward(''); }
else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { prompt += chunk; });
  process.stdin.on('end', () => forward(prompt));
}

function forward(prompt) {
  if (args[0] !== '--version' && !args.includes('model="' + expectedModel + '"')) {
    process.stderr.write('live smoke model pin is missing\\n'); process.exitCode = 64; return;
  }
  const criteria = JSON.parse(prompt.match(/Frozen acceptance criteria: (\\[[^\\n]+\\])/u)?.[1] ?? '[]');
  const scenario = criteria.map((item) => item.text).join('\\n').match(/LIVE_SMOKE_SCENARIO=([^\\n]+)/u)?.[1] ?? 'unknown';
  const operation = prompt.includes('Independently prove issue') ? 'proof'
    : prompt.includes('/code-review/') || prompt.includes('"operation":"code-review"') ? 'code-review'
      : prompt.includes('/triage/') ? 'triage'
        : 'implementation';
  if (scenario === 'incomplete-progress-rework' && operation === 'implementation') {
    const marker = gitPath('v2-live-smoke-incomplete');
    try { readFileSync(marker); } catch {
      writeFileSync(marker, 'attempted\\n');
      process.stderr.write('stream disconnected before completion\\n'); process.exitCode = 1; return;
    }
  }
  launch(1);

  function launch(wrapperAttempt) {
    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.pipe(process.stdout);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
      process.stderr.write(chunk);
    });
    child.on('error', (error) => { stderr = (stderr + String(error)).slice(-4096); });
    child.on('close', (code, signal) => {
      if (args[0] !== '--version') {
        appendFileSync(auditPath, JSON.stringify({
          model: expectedModel, scenario, operation, wrapperAttempt, exitCode: code, signal,
          stderrTail: stderr.replaceAll(process.cwd(), '<worktree>'),
        }) + '\\n');
      }
      const retryProof = operation === 'proof' && code !== 0
        && stderr.includes('stream disconnected before completion') && wrapperAttempt < 3;
      if (retryProof) {
        const reportPath = args[args.indexOf('--output-last-message') + 1];
        if (reportPath) rmSync(reportPath, { force: true });
        launch(wrapperAttempt + 1); return;
      }
      if (code === 0 && args[0] !== '--version') {
        const reportPath = args[args.indexOf('--output-last-message') + 1];
        if (operation === 'code-review') normalizeClosureReview(reportPath, prompt);
        applyFault(scenario, operation, prompt);
      }
      process.exitCode = code ?? (signal ? 1 : 0);
    });
    child.stdin.end(prompt);
  }
}

function normalizeClosureReview(reportPath, prompt) {
  const facts = JSON.parse(prompt.match(/Runner-provided facts: (\\[[^\\n]+\\])/u)?.[1] ?? '[]');
  const capsule = JSON.parse(facts[0] ?? '{}');
  if (capsule.mode !== 'closure') return;
  const envelope = JSON.parse(readFileSync(reportPath, 'utf8'));
  const report = envelope.report;
  const canonical = new Map((capsule.defects ?? []).map((defect) => [defect.id, defect]));
  report.coverage = capsule.mandatoryCoverage ?? [];
  report.defects = (report.defects ?? []).map((defect) => {
    const owner = canonical.get(defect.id);
    return owner ? {
      ...defect,
      id: owner.id, class: owner.class, invariant: owner.invariant,
      failure: owner.failure, introducedTargetRevision: owner.introducedTargetRevision,
    } : defect;
  });
  report.repairFindingOutcomes = (capsule.fixedRepairFindings ?? []).map((finding) => ({ id: finding.id, status: 'verified' }));
  if (report.targetRevision === 5 && prompt.includes('quality-gates')) {
    report.verdict = 'needs-work';
    report.repairFindingOutcomes = (report.repairFindingOutcomes ?? []).map((finding) => ({ ...finding, status: 'reopened' }));
  }
  writeFileSync(reportPath, JSON.stringify(envelope));
}

function applyFault(scenario, operation, prompt) {
  const reportPath = args[args.indexOf('--output-last-message') + 1];
  if (!reportPath) throw new Error('missing report path');
  if (operation === 'implementation' && scenario === 'report-repair' && !prompt.includes('Report repair only')) {
    writeFileSync(reportPath, '{bad json'); return;
  }
  if (operation === 'implementation' && scenario === 'commit-policy') {
    runGit(['add', '-A']);
    runGit(['-c', 'user.name=fake-agent', '-c', 'user.email=fake@example.invalid', 'commit', '-m', 'forbidden agent commit']);
    return;
  }
  if (operation === 'implementation' && scenario === 'safety-negative') {
    writeFileSync('.env', 'blocked fixture\\n'); return;
  }
  if (operation !== 'proof') return;
  const criteria = JSON.parse(prompt.match(/Frozen acceptance criteria: (\\[[^\\n]+\\])/u)?.[1] ?? '[]');
  if (scenario === 'acceptance-proof-negative') {
    discardProofArtifacts(prompt);
    writeProofReport(reportPath, {
      version: 1, status: 'external-block', decision: { mode: 'non-visual', targets: [] },
      criteria: criteria.map((item) => ({ id: item.id, status: 'unknown', confidence: 'low', surfaces: ['non-visual'], evidenceRefs: [], analysis: 'External proof dependency is unavailable.' })),
      checks: [], artifacts: [], findings: [], residualRisks: [],
      blocker: { kind: 'service', summary: 'Synthetic proof dependency is unavailable.', attempted: ['bounded live-smoke proof'] },
    }); return;
  }
  if (scenario === 'acceptance-proof-rework') {
    const marker = gitPath('v2-live-smoke-proof-rework');
    try { readFileSync(marker); } catch {
      writeFileSync(marker, 'attempted\\n');
      discardProofArtifacts(prompt);
      writeProofReport(reportPath, {
        version: 1,
        status: 'needs-rework',
        decision: { mode: 'non-visual', targets: [] },
        criteria: criteria.map((item) => ({ id: item.id, status: 'failed', confidence: 'high', surfaces: ['non-visual'], evidenceRefs: [], analysis: 'One bounded rework cycle is required.' })),
        checks: [], artifacts: [],
        findings: ['Create src/live-smoke/acceptance-proof-rework-complete.txt containing exactly complete followed by one LF newline.'],
        residualRisks: [],
      }); return;
    }
  }
  if (scenario === 'browser-proof') writeBrowserProof(criteria, reportPath, prompt);
}

function discardProofArtifacts(prompt) {
  const artifactRoot = prompt.match(/Write evidence only below (.+)\\.\\n/u)?.[1];
  if (!artifactRoot) throw new Error('missing proof artifact root');
  rmSync(artifactRoot, { recursive: true, force: true });
}

function writeBrowserProof(criteria, reportPath, prompt) {
  const artifactRoot = prompt.match(/Write evidence only below (.+)\\.\\n/u)?.[1];
  if (!artifactRoot) throw new Error('missing browser artifact root');
  const root = join(artifactRoot, 'browser-live-smoke'); mkdirSync(root, { recursive: true });
  const definitions = [
    ['shot-wide', 'screenshot', 'wide.png', true], ['dom-wide', 'dom-snapshot', 'wide.json', false],
    ['shot-narrow', 'screenshot', 'narrow.png', true], ['dom-narrow', 'dom-snapshot', 'narrow.json', false],
    ['console', 'console-log', 'console.json', false], ['network', 'network-log', 'network.json', false],
  ];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const artifacts = definitions.map(([id, kind, name, publishable]) => {
    const relativePath = join(artifactRoot, 'browser-live-smoke', name);
    const bytes = kind === 'screenshot' ? png : Buffer.from(JSON.stringify({ scenario: 'browser-proof', id }));
    writeFileSync(relativePath, bytes);
    return { id, kind, relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), publishable, description: 'Current V2 browser live-smoke evidence.' };
  });
  const ids = criteria.map((item) => item.id);
  writeProofReport(reportPath, {
    version: 1, status: 'passed', decision: { mode: 'visual', targets: ['browser'] },
    criteria: criteria.map((item) => ({ id: item.id, status: 'passed', confidence: 'high', surfaces: ['browser'], evidenceRefs: ['shot-wide', 'dom-wide', 'shot-narrow', 'dom-narrow'], analysis: 'Both current responsive captures satisfy this criterion.' })),
    checks: [], artifacts,
    visualEvidence: {
      workflow: { entrypoint: 'http://127.0.0.1:4173/', steps: ['Open fixture', 'Inspect final state'], finalState: 'V2 browser proof ready' },
      captures: [
        { target: 'browser', name: 'wide', width: 1280, height: 720, criteriaRefs: ids, screenshotRef: 'shot-wide', stateRef: 'dom-wide' },
        { target: 'browser', name: 'narrow', width: 390, height: 844, criteriaRefs: ids, screenshotRef: 'shot-narrow', stateRef: 'dom-narrow' },
      ],
      diagnostics: { consoleRef: 'console', networkRef: 'network' }, freshness: { capturedAfterFinalInteraction: true },
      layoutReview: [{ summary: 'Spacing, clipping, overlap, and alignment are correct.', evidenceRefs: ['shot-wide', 'shot-narrow'] }],
      copyReview: [{ summary: 'Visible copy matches the frozen criteria.', evidenceRefs: ['dom-wide', 'dom-narrow'] }],
    }, findings: [], residualRisks: [],
  });
}

function writeProofReport(reportPath, report) {
  const generated = { ...report, visualEvidence: report.visualEvidence ?? null, blocker: report.blocker ?? null };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ report: generated }));
}

function gitPath(name) { return runGit(['rev-parse', '--git-path', name]).trim(); }
function runGit(argv) { return execFileSync('git', argv, { encoding: 'utf8' }); }
`;
}

function fakeCodexSource(nodePath) {
  return `#!${nodePath}
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.144.4\\n'); process.exit(0); }
const args = process.argv.slice(2);
const reportPath = args[args.indexOf('--output-last-message') + 1];
if (!reportPath) throw new Error('missing report path');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const criteria = JSON.parse(prompt.match(/Frozen acceptance criteria: (\\[[^\\n]+\\])/u)?.[1] ?? '[]');
  const marker = criteria.map((item) => item.text).join('\\n').match(/LIVE_SMOKE_SCENARIO=([^\\n]+)/u)?.[1] ?? 'acceptance-proof-positive';
  mkdirSync(dirname(reportPath), { recursive: true });
  if (prompt.includes('/triage/')) writeTriage(reportPath);
  else if (prompt.includes('/code-review/') || prompt.includes('"operation":"code-review"')) writeReview(reportPath, prompt);
  else if (prompt.includes('Independently prove issue')) writeProof(marker, criteria, reportPath, prompt);
  else writeImplementation(marker, reportPath, prompt);
});

function writeTriage(reportPath) {
  writeAgentReport(reportPath, {
    version: 1, status: 'direct',
    inspectedEvidence: [{ kind: 'issue', location: 'live-smoke issue', summary: 'Synthetic live-smoke delivery fixture.' }],
    assumptions: [],
    direct: { summary: 'Deliver the bounded live-smoke fixture.', behaviors: ['Create the scenario marker.'], verification: ['Run the scenario proof.'] },
    specRequired: null, awaitingUser: null, blocker: null,
  });
}

function writeReview(reportPath, prompt) {
  const facts = JSON.parse(prompt.match(/Runner-provided facts: (\\[[^\\n]+\\])/u)?.[1] ?? '[]');
  const capsule = JSON.parse(facts[0] ?? '{}');
  writeAgentReport(reportPath, {
    version: 1, operation: capsule.operation, targetRevision: capsule.targetRevision,
    targetFingerprint: capsule.targetFingerprint, verdict: 'approved', mode: capsule.mode,
    coverage: capsule.mandatoryCoverage ?? [], defects: capsule.defects ?? [], residualRisks: [],
    reviewerSessionId: capsule.reviewerSessionId, closureRequestSha256: capsule.closureRequestSha256,
    repairFindingOutcomes: (capsule.fixedRepairFindings ?? []).map((finding) => ({ id: finding.id, status: 'verified' })),
  });
}

function writeImplementation(scenario, reportPath, prompt) {
  if (scenario === 'report-repair' && !prompt.includes('Report repair only')) {
    writeChange(scenario); writeFileSync(reportPath, '{bad json'); return;
  }
  if (!prompt.includes('Report repair only')) {
    if (scenario === 'incomplete-progress-rework') {
      const marker = execFileSync('git', ['rev-parse', '--git-path', 'v2-live-smoke-incomplete'], { encoding: 'utf8' }).trim();
      try { readFileSync(marker); } catch {
        writeFileSync(marker, 'attempted\\n');
        process.stderr.write('stream disconnected before completion\\n');
        process.exitCode = 1;
        return;
      }
    }
    if (scenario === 'safety-negative') writeFileSync('.env', 'blocked fixture\\n');
    else writeChange(scenario);
    if (scenario === 'commit-policy') {
      execFileSync('git', ['add', '-A']);
      execFileSync('git', ['-c', 'user.name=fake-agent', '-c', 'user.email=fake@example.invalid', 'commit', '-m', 'forbidden agent commit']);
    }
  }
  const changedFiles = scenario === 'commit-policy'
    ? execFileSync('git', ['diff', '--name-only', 'HEAD^', 'HEAD'], { encoding: 'utf8' }).trim().split('\\n').filter(Boolean).sort()
    : execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8' }).split('\\0').filter(Boolean).map((row) => row.slice(3)).sort();
  writeAgentReport(reportPath, { version: 1, status: 'completed', summary: 'V2 live-smoke implementation complete.', changedFiles, residualRisks: [] });
}

function writeProof(scenario, criteria, reportPath, prompt) {
  if (scenario === 'acceptance-proof-negative') {
    writeAgentReport(reportPath, {
      version: 1, status: 'external-block', decision: { mode: 'non-visual', targets: [] },
      criteria: criteria.map((item) => ({ id: item.id, status: 'unknown', confidence: 'low', surfaces: ['non-visual'], evidenceRefs: [], analysis: 'External proof dependency is unavailable.' })),
      checks: [], artifacts: [], findings: [], residualRisks: [],
      blocker: { kind: 'service', summary: 'Synthetic proof dependency is unavailable.', attempted: ['bounded live-smoke proof'] },
    }); return;
  }
  if (scenario === 'acceptance-proof-rework') {
    const marker = execFileSync('git', ['rev-parse', '--git-path', 'v2-live-smoke-proof-rework'], { encoding: 'utf8' }).trim();
    try { readFileSync(marker); } catch {
      writeFileSync(marker, 'attempted\\n');
      writeAgentReport(reportPath, {
        version: 1, status: 'needs-rework', decision: { mode: 'non-visual', targets: [] },
        criteria: criteria.map((item) => ({ id: item.id, status: 'failed', confidence: 'high', surfaces: ['non-visual'], evidenceRefs: [], analysis: 'One bounded rework cycle is required.' })),
        checks: [], artifacts: [], findings: ['Add the rework completion marker.'], residualRisks: [],
      }); return;
    }
  }
  if (scenario === 'browser-proof') { writeBrowserProof(criteria, reportPath, prompt); return; }
  const output = Buffer.from('V2 live-smoke proof passed.');
  const check = { id: 'check-live-smoke', command: 'synthetic bounded proof', status: 'passed', summary: 'The frozen criteria were inspected.', outputSha256: createHash('sha256').update(output).digest('hex') };
  writeAgentReport(reportPath, {
    version: 1, status: 'passed', decision: { mode: 'non-visual', targets: [] },
    criteria: criteria.map((item) => ({ id: item.id, status: 'passed', confidence: 'high', surfaces: ['non-visual'], evidenceRefs: [check.id], analysis: 'Current checked change satisfies this criterion.' })),
    checks: [check], artifacts: [], findings: [], residualRisks: [],
  });
}

function writeBrowserProof(criteria, reportPath, prompt) {
  const artifactRoot = prompt.match(/Write evidence only below (.+)\\.\\n/u)?.[1];
  if (!artifactRoot) throw new Error('missing browser artifact root');
  const root = join(artifactRoot, 'browser-live-smoke');
  mkdirSync(root, { recursive: true });
  const definitions = [
    ['shot-wide', 'screenshot', 'wide.png', true], ['dom-wide', 'dom-snapshot', 'wide.json', false],
    ['shot-narrow', 'screenshot', 'narrow.png', true], ['dom-narrow', 'dom-snapshot', 'narrow.json', false],
    ['console', 'console-log', 'console.json', false], ['network', 'network-log', 'network.json', false],
  ];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const artifacts = definitions.map(([id, kind, name, publishable]) => {
    const relativePath = join(artifactRoot, 'browser-live-smoke', name);
    const bytes = kind === 'screenshot' ? png : Buffer.from(JSON.stringify({ scenario: 'browser-proof', id }));
    writeFileSync(relativePath, bytes);
    return { id, kind, relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), publishable, description: 'Current V2 browser live-smoke evidence.' };
  });
  const ids = criteria.map((item) => item.id);
  writeAgentReport(reportPath, {
    version: 1, status: 'passed', decision: { mode: 'visual', targets: ['browser'] },
    criteria: criteria.map((item) => ({ id: item.id, status: 'passed', confidence: 'high', surfaces: ['browser'], evidenceRefs: ['shot-wide', 'dom-wide', 'shot-narrow', 'dom-narrow'], analysis: 'Both current responsive captures satisfy this criterion.' })),
    checks: [], artifacts,
    visualEvidence: {
      workflow: { entrypoint: 'http://127.0.0.1:4173/', steps: ['Open fixture', 'Inspect final state'], finalState: 'V2 browser proof ready' },
      captures: [
        { target: 'browser', name: 'wide', width: 1280, height: 720, criteriaRefs: ids, screenshotRef: 'shot-wide', stateRef: 'dom-wide' },
        { target: 'browser', name: 'narrow', width: 390, height: 844, criteriaRefs: ids, screenshotRef: 'shot-narrow', stateRef: 'dom-narrow' },
      ],
      diagnostics: { consoleRef: 'console', networkRef: 'network' }, freshness: { capturedAfterFinalInteraction: true },
      layoutReview: [{ summary: 'Spacing, clipping, overlap, and alignment are correct.', evidenceRefs: ['shot-wide', 'shot-narrow'] }],
      copyReview: [{ summary: 'Visible copy matches the frozen criteria.', evidenceRefs: ['dom-wide', 'dom-narrow'] }],
    },
    findings: [], residualRisks: [],
  });
}

function writeAgentReport(reportPath, report) {
  const generated = report.decision
    ? { ...report, visualEvidence: report.visualEvidence ?? null, blocker: report.blocker ?? null }
    : report;
  writeFileSync(reportPath, JSON.stringify({ report: generated }));
}

function writeChange(scenario) {
  mkdirSync('src/live-smoke', { recursive: true });
  mkdirSync('test/live-smoke', { recursive: true });
  writeFileSync(join('src', 'live-smoke', scenario + '.txt'), scenario + '\\n');
  writeFileSync(join('test', 'live-smoke', scenario + '.txt'), 'proof for ' + scenario + '\\n');
}
`;
}

async function cleanup(context) {
  const failures = [];
  await discoverRunArtifacts(context, failures);
  for (const pr of [...new Set(context.createdPullRequests)].reverse()) {
    await bestEffort(failures, `PR #${pr}`, () => runCommand('gh', ['pr', 'close', String(pr), '--repo', context.repo, '--delete-branch'], { timeoutMs: context.options.timeoutMs }));
  }
  for (const branch of [...new Set(context.createdBranches)].reverse()) {
    await bestEffort(failures, `branch ${branch}`, async () => {
      const remote = await runCommand('git', ['-C', context.targetRoot, 'ls-remote', '--heads', 'origin', branch], { timeoutMs: context.options.timeoutMs });
      if (remote.stdout.trim()) await runCommand('git', ['-C', context.targetRoot, 'push', 'origin', '--delete', branch], { timeoutMs: context.options.timeoutMs });
    });
  }
  for (const issue of [...new Set(context.createdIssues)].reverse()) {
    const args = context.options.cleanupMode === 'delete'
      ? ['issue', 'delete', String(issue), '--repo', context.repo, '--yes']
      : ['issue', 'close', String(issue), '--repo', context.repo, '--comment', `[live-smoke:${context.runId}] cleanup`];
    await bestEffort(failures, `issue #${issue}`, () => runCommand('gh', args, { timeoutMs: context.options.timeoutMs }));
  }
  await verifyCleanup(context, failures);
  if (failures.length > 0) throw new Error(`strict cleanup failed:\n${failures.join('\n')}`);
  await appendReport(context, '\nStrict cleanup passed.\n');
}

async function discoverRunArtifacts(context, failures) {
  await bestEffort(failures, 'discover run issues', async () => {
    const result = await runCommand('gh', ['issue', 'list', '--repo', context.repo, '--state', 'all', '--limit', '1000', '--json', 'number,title,body'], {
      timeoutMs: context.options.timeoutMs,
    });
    for (const issue of JSON.parse(result.stdout)) {
      if (issue.title?.includes(`[live-smoke:${context.runId}]`) || issue.body?.includes(`LIVE_SMOKE_RUN_ID=${context.runId}`)) {
        context.createdIssues.push(issue.number);
      }
    }
  });
  await bestEffort(failures, 'discover run pull requests', async () => {
    const result = await runCommand('gh', ['pr', 'list', '--repo', context.repo, '--state', 'all', '--search', `live-smoke:${context.runId}`, '--limit', '1000', '--json', 'number,state,headRefName'], {
      timeoutMs: context.options.timeoutMs,
    });
    for (const pull of JSON.parse(result.stdout)) {
      if (pull.state === 'OPEN') context.createdPullRequests.push(pull.number);
      if (pull.headRefName) context.createdBranches.push(pull.headRefName);
    }
  });
}

async function verifyCleanup(context, failures) {
  await bestEffort(failures, 'verify no open run issues', () => retryCleanupObservation(async () => {
    const result = await runCommand('gh', ['issue', 'list', '--repo', context.repo, '--state', 'open', '--limit', '1000', '--json', 'number,title,body'], {
      timeoutMs: context.options.timeoutMs,
    });
    const remaining = JSON.parse(result.stdout).filter((issue) => issue.title?.includes(`[live-smoke:${context.runId}]`)
      || issue.body?.includes(`LIVE_SMOKE_RUN_ID=${context.runId}`));
    if (remaining.length > 0) throw new Error(`open issues remain: ${remaining.map((issue) => issue.number).join(', ')}`);
  }));
  await bestEffort(failures, 'verify no open run pull requests', () => retryCleanupObservation(async () => {
    const result = await runCommand('gh', ['pr', 'list', '--repo', context.repo, '--state', 'open', '--search', `live-smoke:${context.runId}`, '--limit', '1000', '--json', 'number'], {
      timeoutMs: context.options.timeoutMs,
    });
    const remaining = JSON.parse(result.stdout);
    if (remaining.length > 0) throw new Error(`open pull requests remain: ${remaining.map((pull) => pull.number).join(', ')}`);
  }));
  if (context.targetRoot) {
    for (const branch of [...new Set(context.createdBranches)]) {
      await bestEffort(failures, `verify branch ${branch}`, () => retryCleanupObservation(async () => {
        const result = await runCommand('git', ['-C', context.targetRoot, 'ls-remote', '--heads', 'origin', branch], { timeoutMs: context.options.timeoutMs });
        if (result.stdout.trim()) throw new Error('remote branch remains');
      }));
    }
  }
  if (context.options.cleanupMode === 'delete') {
    for (const issue of [...new Set(context.createdIssues)]) {
      const result = await runCommand('gh', ['issue', 'view', String(issue), '--repo', context.repo, '--json', 'number'], {
        timeoutMs: context.options.timeoutMs,
        allowedExitCodes: [0, 1],
      });
      if (result.status === 0) failures.push(`issue #${issue}: still exists after delete cleanup`);
    }
  }
}

export async function retryCleanupObservation(action, options = {}) {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 500;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
    }
  }
  throw lastError;
}

async function selfTestLiveCodex() {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-live-codex-'));
  try {
    const auditPath = join(root, 'model-audit.jsonl');
    const wrapperPath = join(root, 'live-codex');
    const stubPath = join(root, 'codex');
    await writeFile(wrapperPath, liveCodexSource(process.execPath, auditPath));
    await chmod(wrapperPath, 0o700);
    await writeFile(stubPath, `#!${process.execPath}
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
if (process.argv[2] === '--version') { process.stdout.write('codex-cli self-test\\n'); process.exit(0); }
const args = process.argv.slice(2);
const reportPath = args[args.indexOf('--output-last-message') + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ report: { version: 1, status: 'completed' } }));
});
`);
    await chmod(stubPath, 0o700);
    const reportPath = join(root, 'report.json');
    const env = { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` };
    const criteria = [{ id: 'ac-001', order: 1, source: 'explicit', text: 'LIVE_SMOKE_SCENARIO=report-repair' }];
    await runCommand(wrapperPath, ['exec', '--output-last-message', reportPath, '-c', `model="${liveSmokeModel}"`], {
      cwd: root, env, stdin: `Implement issue.\nFrozen acceptance criteria: ${JSON.stringify(criteria)}\n`,
    });
    if (await readFile(reportPath, 'utf8') !== '{bad json') throw new Error('live Codex fault injection did not run after the model');
    const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    if (audit.length !== 1 || audit[0].model !== liveSmokeModel || audit[0].scenario !== 'report-repair') {
      throw new Error('live Codex model audit contract failed');
    }
    const missingPin = await runCommand(wrapperPath, ['exec', '--output-last-message', join(root, 'missing.json')], {
      cwd: root, env, stdin: `Frozen acceptance criteria: ${JSON.stringify(criteria)}\n`, allowedExitCodes: [64],
    });
    if (missingPin.status !== 64) throw new Error('live Codex wrapper accepted a missing model pin');
    process.stdout.write('V2 live Codex wrapper self-test passed.\n');
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function selfTestFakeAgent() {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-fake-agent-'));
  try {
    await runCommand('git', ['init', '-q', root]);
    await writeFile(join(root, 'README.md'), 'fixture\n');
    await runCommand('git', ['-C', root, 'add', 'README.md']);
    await runCommand('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const fakePath = join(root, 'fake-codex');
    await writeFile(fakePath, fakeCodexSource(process.execPath));
    await chmod(fakePath, 0o700);
    await runCommand('git', ['-C', root, 'add', 'fake-codex']);
    await runCommand('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fake codex']);
    const version = await runCommand(fakePath, ['--version'], { cwd: root });
    if (version.stdout !== 'codex-cli 0.144.4\n') throw new Error('fake agent version contract failed');
    const criteria = [{ id: 'ac-001', order: 1, source: 'explicit', text: 'LIVE_SMOKE_SCENARIO=acceptance-proof-positive' }];
    const implementationPath = join(root, 'implementation.json');
    await runCommand(fakePath, ['exec', '--output-last-message', implementationPath], {
      cwd: root,
      stdin: `Implement issue #1.\nFrozen acceptance criteria: ${JSON.stringify(criteria)}\n`,
    });
    const implementation = JSON.parse(await readFile(implementationPath, 'utf8')).report;
    if (implementation.version !== 1 || implementation.status !== 'completed'
      || !Array.isArray(implementation.changedFiles) || implementation.changedFiles.length !== 2) {
      throw new Error(`fake implementation report contract failed: ${JSON.stringify(implementation)}`);
    }
    const triagePath = join(root, 'triage.json');
    await runCommand(fakePath, ['exec', '--output-last-message', triagePath], {
      cwd: root,
      stdin: 'Follow the exact operation at /operations/triage/SKILL.md.\n',
    });
    const triage = JSON.parse(await readFile(triagePath, 'utf8')).report;
    if (triage.version !== 1 || triage.status !== 'direct' || triage.direct?.behaviors?.length !== 1) {
      throw new Error(`fake triage report contract failed: ${JSON.stringify(triage)}`);
    }
    const reviewPath = join(root, 'review.json');
    const reviewCapsule = {
      operation: 'code-review', mode: 'full', reviewerSessionId: 'review-session-1', targetRevision: 1,
      targetFingerprint: 'a'.repeat(64), closureRequestSha256: null, mandatoryCoverage: ['correctness'],
      defects: [], fixedRepairFindings: [],
    };
    await runCommand(fakePath, ['exec', '--output-last-message', reviewPath], {
      cwd: root,
      stdin: `Follow the exact operation at /code-review/SKILL.md.\nRunner-provided facts: ${JSON.stringify([JSON.stringify(reviewCapsule)])}\n`,
    });
    const review = JSON.parse(await readFile(reviewPath, 'utf8')).report;
    if (review.operation !== 'code-review' || review.verdict !== 'approved'
      || review.targetFingerprint !== reviewCapsule.targetFingerprint || review.coverage?.[0] !== 'correctness') {
      throw new Error('fake code review report contract failed');
    }
    const proofPath = join(root, 'proof.json');
    await runCommand(fakePath, ['exec', '--output-last-message', proofPath], {
      cwd: root,
      stdin: `Independently prove issue #1.\nFrozen acceptance criteria: ${JSON.stringify(criteria)}\n`,
    });
    const proof = JSON.parse(await readFile(proofPath, 'utf8')).report;
    if (proof.version !== 1 || proof.status !== 'passed' || proof.criteria?.[0]?.id !== 'ac-001'
      || proof.decision?.mode !== 'non-visual') throw new Error('fake proof report contract failed');
    const browserPath = join(root, 'browser-proof.json');
    const browserCriteria = [{ id: 'ac-browser', order: 1, source: 'explicit', text: 'LIVE_SMOKE_SCENARIO=browser-proof' }];
    await runCommand(fakePath, ['exec', '--output-last-message', browserPath], {
      cwd: root,
      stdin: `Independently prove issue #2.\nFrozen acceptance criteria: ${JSON.stringify(browserCriteria)}\nWrite evidence only below .proofs.\n`,
    });
    const browser = JSON.parse(await readFile(browserPath, 'utf8')).report;
    if (browser.status !== 'passed' || browser.decision?.targets?.[0] !== 'browser'
      || browser.artifacts?.length !== 6 || browser.visualEvidence?.captures?.length !== 2) {
      throw new Error('fake browser proof report contract failed');
    }
    process.stdout.write('V2 fake agent self-test passed.\n');
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function bestEffort(failures, label, action) {
  try { await action(); }
  catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function defaultBranch(repo) {
  const result = await runCommand('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef'], { timeoutMs: defaultTimeoutMs });
  const branch = JSON.parse(result.stdout)?.defaultBranchRef?.name;
  if (typeof branch !== 'string' || !branch) throw new Error('default branch is unavailable');
  return branch;
}

function ownerOf(repo) { return repo.split('/')[0]; }
function repoOf(repo) { return repo.split('/')[1]; }

async function appendReport(context, value) {
  let existing = '';
  try { existing = await readFile(context.reportPath, 'utf8'); } catch {}
  await writeFile(context.reportPath, existing + value, 'utf8');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) child.kill('SIGTERM');
    }, options.timeoutMs ?? defaultTimeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timeout); settled = true; rejectCommand(error); });
    child.on('close', (status) => {
      clearTimeout(timeout); settled = true;
      const allowed = options.allowedExitCodes ?? [0];
      if (status !== null && allowed.includes(status)) resolveCommand({ status, stdout, stderr });
      else rejectCommand(new Error(`Command failed (${status}): ${command} ${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
