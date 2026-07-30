#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultTimeoutMs = 1_800_000;
const liveSmokeModel = 'gpt-5.6-luna';
const defaultLiveSmokeRepo = process.env.CODEX_ORCHESTRATOR_LIVE_SMOKE_REPO
  ?? 'SergiiMytakii/codex-orchestrator-live-smoke';
const cleanupModes = new Set(['delete', 'close']);

const scenarioDefinitions = new Map([
  ['package-install', runPackageInstallScenario],
  ['discovery-matrix', runDiscoveryMatrixScenario],
  ['commit-policy', runCommitPolicyScenario],
  ['incomplete-progress-rework', runReviewReadyScenario],
  ['report-repair', runReviewReadyScenario],
  ['diagnostics', runDiagnosticsScenario],
  ['browser-proof', runReviewReadyScenario],
  ['authoritative-candidate-publication', runReviewReadyScenario],
  ['acceptance-proof-rework', runReviewReadyScenario],
  ['acceptance-proof-negative', runAcceptanceProofNegativeScenario],
  ['proof-interrupted-daemon', runInterruptedProofDaemonScenario],
  ['review-feedback-continuation', runReviewFeedbackContinuationScenario],
  ['quality-gates', runQualityGatesScenario],
  ['safety-negative', runSafetyNegativeScenario],
]);

const scenarioProfiles = new Map([
  ['core-release', [
    'package-install', 'browser-proof', 'safety-negative',
  ]],
  ['v2-regression', [
    'discovery-matrix', 'commit-policy', 'incomplete-progress-rework', 'report-repair',
    'diagnostics', 'authoritative-candidate-publication', 'acceptance-proof-rework',
    'acceptance-proof-negative', 'proof-interrupted-daemon', 'review-feedback-continuation', 'quality-gates',
  ]],
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
    harnessAuditPath: join(root, 'harness-audit.jsonl'),
    orchestratorHome: join(root, 'orchestrator-home'),
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
    : overrides.authoritativeCandidate
      ? { smoke: 'if [ -e src/live-smoke/authoritative-candidate-publication.txt ]; then [ "$(cat src/live-smoke/authoritative-candidate-publication.txt)" = "authoritative-candidate-publication" ] && git diff --cached --quiet; else git diff --cached --quiet; fi' }
      : { smoke: `${process.execPath} --version` };
  await writeFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function runReviewReadyScenario(context, scenario) {
  await configureTarget(context, { authoritativeCandidate: scenario === 'authoritative-candidate-publication' });
  const issue = await createIssue(context, scenario, true);
  const result = await runIssue(context, issue.number);
  assertResult(result, { status: 'review-ready' }, scenario);
  const record = await readRunRecord(context, issue.number);
  if (!record.checkedChangeSha256 || !record.proofId || record.checks.some((check) => check.status !== 'passed')) {
    throw new Error(`${scenario}: review-ready lacks passed check and proof bindings`);
  }
  if (scenario === 'acceptance-proof-rework') await assertReworkCycle(context, issue.number);
  if (scenario === 'incomplete-progress-rework' && record.transportRetries !== 1) {
    throw new Error(`${scenario}: expected one durable transport retry`);
  }
  if (scenario === 'report-repair' && record.reportRepairs !== 1) {
    throw new Error(`${scenario}: expected one durable report repair`);
  }
  if (scenario === 'browser-proof') {
    const screenshots = record.proofReceipt?.publishableEvidence?.filter((item) => item.kind === 'screenshot') ?? [];
    if (screenshots.length !== 2) throw new Error(`${scenario}: expected two publishable responsive screenshots`);
  }
  const publication = await recordPublication(context, issue.number);
  if (scenario === 'authoritative-candidate-publication') {
    await assertAuthoritativeCandidatePublication(context, record, publication.headSha);
  }
}

async function assertAuthoritativeCandidatePublication(context, record, publishedHeadSha) {
  const state = await readRunState(context);
  if (state.version !== 3) throw new Error('authoritative-candidate-publication: state.version !== 3');
  const receipts = record.checks.filter((check) => check.status === 'passed');
  const bindingIds = new Set(receipts.map((check) => check.bindingId));
  const candidateTrees = new Set(receipts.map((check) => check.candidateTreeSha));
  if (receipts.length === 0 || bindingIds.size !== 1 || bindingIds.has(undefined)
    || candidateTrees.size !== 1 || candidateTrees.has(undefined)) {
    throw new Error('authoritative-candidate-publication: final checks do not share one V2 candidate binding');
  }
  const [bindingId] = bindingIds;
  const [candidateTreeSha] = candidateTrees;
  const publishedTreeSha = (await runCommand('git', [
    '-C', context.targetRoot, 'rev-parse', `${publishedHeadSha}^{tree}`,
  ], { timeoutMs: context.options.timeoutMs })).stdout.trim();
  if (candidateTreeSha !== publishedTreeSha) {
    throw new Error('authoritative-candidate-publication: candidateTreeSha !== publishedTreeSha');
  }
  const publishedContent = (await runCommand('git', [
    '-C', context.targetRoot, 'show', `${publishedHeadSha}:src/live-smoke/authoritative-candidate-publication.txt`,
  ], { timeoutMs: context.options.timeoutMs })).stdout;
  if (publishedContent !== 'authoritative-candidate-publication\n') {
    throw new Error('authoritative-candidate-publication: staged content became authoritative');
  }
  const pin = `refs/codex-orchestrator/candidates/${record.runId}/${bindingId}`;
  const pinProbe = await runCommand('git', ['-C', context.targetRoot, 'show-ref', '--verify', '--quiet', pin], {
    timeoutMs: context.options.timeoutMs, allowedExitCodes: [0, 1],
  });
  if (pinProbe.status === 0) throw new Error('authoritative-candidate-publication: candidate pin survived successful publication');
  const worktrees = (await runCommand('git', ['-C', context.targetRoot, 'worktree', 'list', '--porcelain'], {
    timeoutMs: context.options.timeoutMs,
  })).stdout;
  if (worktrees.includes('/.candidate-executions/')) {
    throw new Error('authoritative-candidate-publication: candidate execution worktree survived successful publication');
  }
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
  const bindingRoot = join(context.targetRoot, config.runner.workspaceRoot, '.candidate-executions', record.runId, bindingId);
  let residualExecutionPaths = [];
  try { residualExecutionPaths = await readdir(bindingRoot); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (residualExecutionPaths.length > 0) {
    throw new Error('authoritative-candidate-publication: candidate execution directory survived successful publication');
  }
  if (record.candidateBinding !== undefined || record.executionLease !== undefined) {
    throw new Error('authoritative-candidate-publication: durable candidate ownership survived successful publication');
  }
}

async function assertReworkCycle(context, issueNumber) {
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
  const state = JSON.parse(await readFile(join(context.targetRoot, config.runner.stateDir, 'v2', 'run-state.json'), 'utf8'));
  const run = state.runs.find((candidate) => candidate.issueNumber === issueNumber);
  if (run?.cycle !== 2) throw new Error(`acceptance-proof-rework: expected cycle=2, received ${run?.cycle ?? 'missing'}`);
}

async function runReviewFeedbackContinuationScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true);
  const initial = await runIssue(context, issue.number);
  assertResult(initial, { status: 'review-ready' }, scenario);
  const publication = await recordPublication(context, issue.number);
  const initialRecord = await readRunRecord(context, issue.number);
  if (initialRecord.reviewFeedback?.phase !== 'idle'
    || initialRecord.reviewFeedback.previousPublishedHeadSha !== publication.headSha) {
    throw new Error(`${scenario}: initial publication did not bind the review feedback baseline`);
  }
  if (!initialRecord.checkedChangeSha256 || !initialRecord.proofId) {
    throw new Error(`${scenario}: initial check and proof receipts are missing`);
  }

  await postTrustedReviewThread(context, publication.number, publication.headSha, `src/live-smoke/${scenario}.txt`, [
    `Create src/live-smoke/${scenario}-addressed.txt as one line containing addressed review feedback,`,
    'followed by one LF newline.',
  ].join(' '));
  await assertReviewFeedbackObservable(context, issue.number, publication.number, publication.headSha, initialRecord);
  const updated = await runDaemonOnce(context, issue.number);
  assertResult(updated, { status: 'review-ready' }, scenario);

  const after = await readRunRecord(context, issue.number);
  const receipt = after.reviewFeedback?.history[0];
  if (after.reviewFeedback?.phase !== 'idle' || after.reviewFeedback.history.length !== 1
    || receipt?.kind !== 'published') {
    throw new Error(`${scenario}: one published review feedback receipt was not persisted`);
  }
  if (after.cycle !== initialRecord.cycle) throw new Error(`${scenario}: continuation changed the implementation cycle`);
  if (after.checkedChangeSha256 === initialRecord.checkedChangeSha256 || after.proofId === initialRecord.proofId) {
    throw new Error(`${scenario}: affected checks and proof were not refreshed`);
  }
  if (updated.continuationEpoch !== receipt.publishedHeadSha) {
    throw new Error(`${scenario}: continuationEpoch does not match the published head`);
  }

  const branch = `codex/issue-${issue.number}`;
  await runCommand('git', ['-C', context.targetRoot, 'fetch', 'origin', branch], { timeoutMs: context.options.timeoutMs });
  const commitCount = await runCommand('git', ['-C', context.targetRoot, 'rev-list', '--count', `${publication.headSha}..origin/${branch}`], {
    timeoutMs: context.options.timeoutMs,
  });
  const parent = await runCommand('git', ['-C', context.targetRoot, 'rev-parse', `origin/${branch}^`], { timeoutMs: context.options.timeoutMs });
  if (commitCount.stdout.trim() !== '1' || parent.stdout.trim() !== publication.headSha) {
    throw new Error(`${scenario}: review feedback was not published as one fast-forward commit`);
  }
  const pulls = JSON.parse((await runCommand('gh', [
    'pr', 'list', '--repo', context.repo, '--head', branch, '--state', 'open', '--json', 'number', '--limit', '2',
  ], { timeoutMs: context.options.timeoutMs })).stdout);
  if (pulls.length !== 1 || pulls[0]?.number !== publication.number) {
    throw new Error(`${scenario}: continuation did not preserve the one existing PR`);
  }
  const comments = await listConversationComments(context, publication.number);
  const summaryMarker = `<!-- codex-orchestrator:run:${after.runId}:review-feedback:${receipt.batchId} -->`;
  if (comments.filter((comment) => comment.body?.split('\n')[0] === summaryMarker).length !== 1) {
    throw new Error(`${scenario}: expected exactly one review feedback summary marker`);
  }
  const labels = JSON.parse((await runCommand('gh', [
    'issue', 'view', String(issue.number), '--repo', context.repo, '--json', 'labels',
  ], { timeoutMs: context.options.timeoutMs })).stdout).labels.map((label) => label.name).sort();
  if (labels.join(',') !== 'agent:review') throw new Error(`${scenario}: final label is not agent:review`);

  const callsBeforeReplay = (await readModelAudit(context)).length;
  const stateBeforeReplay = JSON.stringify(await readRunRecord(context, issue.number));
  const commentsBeforeReplay = JSON.stringify(comments);
  const remoteBeforeReplay = receipt.publishedHeadSha;
  assertResult(await runDaemonOnce(context, issue.number), { status: 'review-ready' }, scenario);
  const callsAfterReplay = (await readModelAudit(context)).length;
  const replayState = JSON.stringify(await readRunRecord(context, issue.number));
  const replayComments = JSON.stringify(await listConversationComments(context, publication.number));
  const replayRemote = (await runCommand('git', ['-C', context.targetRoot, 'ls-remote', 'origin', `refs/heads/${branch}`], {
    timeoutMs: context.options.timeoutMs,
  })).stdout.trim().split(/\s/u)[0];
  if (callsAfterReplay !== callsBeforeReplay) throw new Error(`${scenario}: model calls during effect-free replay`);
  if (replayState !== stateBeforeReplay || replayComments !== commentsBeforeReplay || replayRemote !== remoteBeforeReplay) {
    throw new Error(`${scenario}: replay produced a persisted or remote effect`);
  }
}

async function runPackageInstallScenario(context, scenario) {
  const external = join(context.root, 'consumer');
  await mkdir(external, { recursive: true });
  await writeFile(join(external, 'package.json'), '{"private":true,"type":"module"}\n');
  const packageRoot = resolve(dirname(context.cliPath), '../../..');
  await runCommand('npm', ['install', packageRoot, '--ignore-scripts'], { cwd: external, timeoutMs: context.options.timeoutMs });
  const installedCliPath = join(external, 'node_modules', 'codex-orchestrator', 'dist', 'src', 'v2', 'cli.js');
  await readFile(installedCliPath);
  const packedCliPath = context.cliPath;
  context.cliPath = installedCliPath;
  try { await runReviewReadyScenario(context, scenario); }
  finally { context.cliPath = packedCliPath; }
}

async function runDiscoveryMatrixScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, false);
  const result = await runIssue(context, issue.number);
  assertResult(result, { status: 'not-eligible' }, scenario);
  await assertEvidenceCode(context, result, 'not-eligible');
  await assertNoPublication(context, issue.number, scenario);
}

async function runCommitPolicyScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true);
  const result = await runIssue(context, issue.number);
  assertResult(result, { status: 'blocked', kind: 'safety' }, scenario);
  const record = await readRunRecord(context, issue.number);
  const author = (await runCommand('git', ['-C', record.worktreePath, 'show', '-s', '--format=%an', 'HEAD'], {
    timeoutMs: context.options.timeoutMs,
  })).stdout.trim();
  if (author !== 'fake-agent') throw new Error(`${scenario}: blocked for a reason other than the agent-authored commit`);
  await assertNoPublication(context, issue.number, scenario);
}

async function runDiagnosticsScenario(context, scenario) {
  await configureTarget(context);
  const configPath = join(context.targetRoot, '.codex-orchestrator', 'config.json');
  const configBefore = await readFile(configPath, 'utf8');
  const statusBefore = (await runCommand('git', ['-C', context.targetRoot, 'status', '--porcelain=v1'], {
    timeoutMs: context.options.timeoutMs,
  })).stdout;
  for (const command of ['doctor', 'status']) {
    const envelope = await requireTypedSetup(context, [command, '--target', context.targetRoot]);
    if (envelope.result.status !== 'inspected') throw new Error(`${command} did not return an inspected Setup result`);
  }
  const statusAfter = (await runCommand('git', ['-C', context.targetRoot, 'status', '--porcelain=v1'], {
    timeoutMs: context.options.timeoutMs,
  })).stdout;
  if (await readFile(configPath, 'utf8') !== configBefore || statusAfter !== statusBefore) {
    throw new Error(`${scenario}: read-only diagnostics mutated the target`);
  }
  await runReviewReadyScenario(context, scenario);
}

async function runAcceptanceProofNegativeScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true);
  const result = await runIssue(context, issue.number);
  assertResult(result, { status: 'blocked', kind: 'external' }, scenario);
  await assertNoPublication(context, issue.number, scenario);
}

async function runInterruptedProofDaemonScenario(context, scenario) {
  const owned = { timeoutMs: context.options.timeoutMs };
  await withInterruptedProofCleanup(owned, async () => {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true);
  const readLaunchedProof = async () => {
    const record = await readRunRecord(context, issue.number).catch(() => undefined);
    if (!record?.proofId) return undefined;
    const proof = await readProofState(context, record.proofId).catch(() => undefined);
    return proof?.invocation?.phase === 'launched' ? { record, proof, invocation: proof.invocation } : undefined;
  };
  owned.readProofInvocation = async () => (await readLaunchedProof())?.invocation;
  const daemon = await startDaemonOnce(context, issue.number);
  owned.daemon = { pid: daemon.pid, processStartIdentity: daemon.processStartIdentity };
  const launched = await waitForValue(readLaunchedProof,
    context.options.timeoutMs, `${scenario}: durable launched proof invocation was not observed`);
  owned.proof = {
    pid: launched.invocation.pid, processStartIdentity: launched.invocation.processStartIdentity,
    processGroupId: launched.invocation.processGroupId,
  };
  const attemptId = launched.invocation.attemptId;
  if (!daemon.kill('SIGKILL')) throw new Error(`${scenario}: daemon child was already absent before interruption`);
  const interrupted = await daemon.completion;
  if (interrupted.signal !== 'SIGKILL') throw new Error(`${scenario}: daemon child did not terminate at the injected crash boundary`);
  const afterCrash = await readProofState(context, launched.record.proofId);
  if (afterCrash.invocation?.attemptId !== attemptId || afterCrash.invocation.phase !== 'launched') {
    throw new Error(`${scenario}: exact launched proof attempt was not durable after daemon termination`);
  }
  const readinessMarkerPath = proofReadinessMarkerPath(launched.invocation.reportPath);
  const recoveryBoundary = await observeProofRecoveryBoundary(
    async () => readFile(readinessMarkerPath, 'utf8').then(() => true).catch((error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }),
    async () => processGroupIsAbsent(launched.invocation.processGroupId),
    { attempts: Math.max(1, Math.ceil(context.options.timeoutMs / 50)), delayMs: 50 },
  );
  if (recoveryBoundary === 'report-ready') {
    await waitForProcessGroupAbsent(launched.invocation.processGroupId, context.options.timeoutMs);
  }
  await appendFile(context.harnessAuditPath, `${JSON.stringify({ scenario, event: 'recovery-observation', attemptId })}\n`);
  let completed;
  if (recoveryBoundary === 'report-ready') {
    completed = await runDaemonTick(context, issue.number);
    if (completed.terminalOutcome?.status !== 'review-ready') throw new Error(`${scenario}: one bounded restart did not adopt the exact proof report`);
  } else {
    const publicationsBeforeAbsenceRecovery = context.createdPullRequests.length;
    await runDaemonTick(context, issue.number);
    const settledProof = await readProofState(context, launched.record.proofId);
    if (settledProof.status !== 'active' || settledProof.invocation) {
      throw new Error(`${scenario}: absent proof attempt was not settled without replacement`);
    }
    const proofCallsAfterAbsence = (await readModelAudit(context)).filter((call) => call.scenario === scenario && call.operation === 'proof');
    if (proofCallsAfterAbsence.length !== 0 || context.createdPullRequests.length !== publicationsBeforeAbsenceRecovery) {
      throw new Error(`${scenario}: absence recovery relaunched proof or published in the clearing tick`);
    }
    completed = await runDaemonTick(context, issue.number);
    if (completed.terminalOutcome?.status !== 'review-ready') throw new Error(`${scenario}: replacement did not reach review-ready`);
  }
  const adoptedProof = await readProofState(context, launched.record.proofId);
  if (adoptedProof.status !== 'passed' || adoptedProof.invocation) throw new Error(`${scenario}: proof recovery did not settle as passed`);
  const proofCalls = (await readModelAudit(context)).filter((call) => call.scenario === scenario && call.operation === 'proof');
  if (proofCalls.length !== 1) throw new Error(`${scenario}: duplicate real proof model launch during adoption`);
  const recoveryObservations = (await readHarnessAudit(context)).filter((entry) => entry.scenario === scenario
    && entry.event === 'recovery-observation' && entry.attemptId === attemptId);
  if (recoveryObservations.length !== 1) throw new Error(`${scenario}: expected one explicit recovery observation`);
  const publicationsBefore = context.createdPullRequests.length;
  await recordPublication(context, issue.number);
  const publicationCount = context.createdPullRequests.length - publicationsBefore;
  if (publicationCount !== 1) throw new Error(`${scenario}: expected exactly one publication`);
  });
}

async function runQualityGatesScenario(context, scenario) {
  await configureTarget(context, { failingCheck: true });
  const issue = await createIssue(context, scenario, true);
  const result = await runIssue(context, issue.number);
  assertResult(result, { status: 'blocked', kind: 'exhausted' }, scenario);
  const record = await readRunRecord(context, issue.number);
  if (record.cycle !== 5 || record.checks.length !== 0
    || record.directReview?.targetRevision !== 5
    || record.directReview.terminalOutcome?.status !== 'blocked'
    || record.directReview.terminalOutcome.kind !== 'exhausted'
    || record.reworkFindings.length !== 1
    || !record.reworkFindings[0].startsWith('Check smoke failed:')) {
    throw new Error(`${scenario}: did not exhaust on the fifth configured-check failure`);
  }
  await assertNoPublication(context, issue.number, scenario);
}

async function runSafetyNegativeScenario(context, scenario) {
  await configureTarget(context);
  const issue = await createIssue(context, scenario, true);
  const result = await runIssue(context, issue.number);
  assertResult(result, { status: 'blocked', kind: 'safety' }, scenario);
  await assertEvidenceCode(context, result, 'denied-path-modified');
  await assertNoPublication(context, issue.number, scenario);
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
    env: liveSmokeEnv(context),
  });
  const envelope = parseExactEnvelope(command.stdout, 'codex-orchestrator.agent-auto-run-result');
  const expectedExit = { 'review-ready': 0, blocked: 20, 'not-eligible': 21, 'transport-failed': 70, cancelled: 130, 'internal-error': 70 }[envelope.result.status];
  if (expectedExit === undefined || command.status !== expectedExit) throw new Error('typed run result and process exit disagree');
  return envelope.result;
}

async function runDaemonOnce(context, issueNumber) {
  const record = await runDaemonTick(context, issueNumber);
  if (!record.terminalOutcome) throw new Error(`daemon did not persist a terminal outcome for issue #${issueNumber}`);
  return record.terminalOutcome;
}

async function runDaemonTick(context, issueNumber) {
  await assertExclusiveDaemonCandidate(context, issueNumber);
  await runCommand(process.execPath, [
    context.cliPath, 'daemon', '--target', context.targetRoot, '--once', '--issue', String(issueNumber),
  ], {
    cwd: context.targetRoot, timeoutMs: context.options.timeoutMs, allowedExitCodes: [0, 20, 21, 70, 130],
    env: liveSmokeEnv(context),
  });
  await assertExclusiveDaemonCandidate(context, issueNumber);
  return readRunRecord(context, issueNumber);
}

async function startDaemonOnce(context, issueNumber) {
  await assertExclusiveDaemonCandidate(context, issueNumber);
  const daemon = spawn(process.execPath, [
    context.cliPath, 'daemon', '--target', context.targetRoot, '--once', '--issue', String(issueNumber),
  ], { cwd: context.targetRoot, env: liveSmokeEnv(context), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  daemon.stdout.setEncoding('utf8'); daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data', (chunk) => { stdout += chunk; });
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  daemon.completion = new Promise((resolveCompletion, rejectCompletion) => {
    daemon.once('error', rejectCompletion);
    daemon.once('close', (status, signal) => resolveCompletion({ status, signal, stdout, stderr }));
  });
  try {
    daemon.processStartIdentity = await readHarnessProcessStartIdentity(daemon.pid);
    if (!daemon.processStartIdentity) throw new Error('daemon child process identity is unavailable');
    await assertExclusiveDaemonCandidate(context, issueNumber);
  }
  catch (error) {
    daemon.kill('SIGKILL');
    await daemon.completion.catch(() => undefined);
    throw error;
  }
  return daemon;
}

async function waitForValue(read, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
}

function proofReadinessMarkerPath(reportPath) {
  if (!isAbsolute(reportPath)) throw new Error('proof readiness requires an absolute report path');
  return `${reportPath}.ready`;
}

export async function withInterruptedProofCleanup(owned, action, control = harnessProcessControl) {
  try { return await action(); }
  finally {
    if (owned.daemon) await settleOwnedPid(owned.daemon, owned.timeoutMs, control);
    if (!owned.proof && owned.readProofInvocation) {
      const invocation = await owned.readProofInvocation().catch(() => undefined);
      if (invocation?.phase === 'launched') owned.proof = invocation;
    }
    if (owned.proof) await settleOwnedProcessGroup(owned.proof, owned.timeoutMs, control);
  }
}

async function settleOwnedPid(identity, timeoutMs, control) {
  if (await control.readProcessStartIdentity(identity.pid) !== identity.processStartIdentity) return;
  control.terminatePid(identity.pid);
  await control.waitForPidAbsent(identity.pid, identity.processStartIdentity, timeoutMs);
}

async function settleOwnedProcessGroup(identity, timeoutMs, control) {
  if (await control.groupIsAbsent?.(identity.processGroupId)) return;
  if (await control.readProcessStartIdentity(identity.pid) !== identity.processStartIdentity) {
    throw new Error(`strict cleanup unresolved proof process-group ownership or PID reuse for PGID ${identity.processGroupId}`);
  }
  control.terminateGroup(identity.processGroupId);
  await control.waitForGroupAbsent(identity.processGroupId, timeoutMs);
}

const harnessProcessControl = {
  readProcessStartIdentity: readHarnessProcessStartIdentity,
  groupIsAbsent: async (processGroupId) => processGroupIsAbsent(processGroupId),
  terminatePid: (pid) => process.kill(pid, 'SIGKILL'),
  terminateGroup: (processGroupId) => process.kill(-processGroupId, 'SIGKILL'),
  waitForPidAbsent: async (pid, processStartIdentity, timeoutMs) => waitForValue(async () =>
    await readHarnessProcessStartIdentity(pid) !== processStartIdentity || undefined,
  timeoutMs, 'owned daemon child remained present after cleanup'),
  waitForGroupAbsent: waitForProcessGroupAbsent,
};

async function readHarnessProcessStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform() === 'linux') {
    try {
      const text = await readFile(`/proc/${pid}/stat`, 'utf8');
      const close = text.lastIndexOf(') ');
      const fields = close < 0 ? [] : text.slice(close + 2).trim().split(/\s+/u);
      return fields[19] ? `linux:${fields[19]}` : undefined;
    } catch { return undefined; }
  }
  const result = await runCommand('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { allowedExitCodes: [0, 1], timeoutMs: 5_000 });
  const value = result.status === 0 ? result.stdout.trim().replace(/\s+/gu, ' ') : '';
  return value ? `${platform()}:${value}` : undefined;
}

export async function observeProofRecoveryBoundary(reportReady, processAbsent, options) {
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (await reportReady()) return 'report-ready';
    if (await processAbsent()) return 'process-absent';
    if (attempt < options.attempts && options.delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs));
    }
  }
  throw new Error('proof worker produced neither a durable report nor positive process absence');
}

function processGroupIsAbsent(processGroupId) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) throw new Error('invalid proof process group');
  try { process.kill(-processGroupId, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function waitForProcessGroupAbsent(processGroupId, timeoutMs) {
  await waitForValue(async () => processGroupIsAbsent(processGroupId) || undefined,
    timeoutMs, 'original proof wrapper process group remained present');
}

async function assertExclusiveDaemonCandidate(context, issueNumber) {
  await observeExclusiveDaemonCandidate(issueNumber, async () => {
    const candidates = new Set();
    for (const label of ['agent:auto', 'agent:review']) {
      const result = await runCommand('gh', [
        'issue', 'list', '--repo', context.repo, '--state', 'open', '--label', label,
        '--json', 'number', '--limit', '100',
      ], { timeoutMs: context.options.timeoutMs });
      for (const issue of JSON.parse(result.stdout)) candidates.add(issue.number);
    }
    return candidates;
  });
}

export async function observeExclusiveDaemonCandidate(issueNumber, observe, options = {}) {
  await retryCleanupObservation(async () => {
    const candidates = await observe();
    const foreign = [...candidates].filter((candidate) => candidate !== issueNumber);
    if (foreign.length > 0) {
      const error = new Error(`daemon smoke observed foreign candidate issue(s): ${foreign.join(', ')}`);
      error.retryable = false;
      throw error;
    }
    if (candidates.size !== 1 || !candidates.has(issueNumber)) {
      throw new Error(`daemon smoke has not yet observed owned issue #${issueNumber}`);
    }
  }, { attempts: options.attempts ?? 5, delayMs: options.delayMs ?? 500, retryIf: (error) => error?.retryable !== false });
}

async function readRunRecord(context, issueNumber) {
  const state = await readRunState(context);
  const record = state.runs.find((candidate) => candidate.issueNumber === issueNumber);
  if (!record) throw new Error(`run state for issue #${issueNumber} is missing`);
  return record;
}

async function readRunState(context) {
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
  const state = JSON.parse(await readFile(join(context.targetRoot, config.runner.stateDir, 'v2', 'run-state.json'), 'utf8'));
  return state;
}

async function readProofState(context, proofId) {
  const repoKey = createHash('sha256').update(context.repo.toLowerCase()).digest('hex');
  return JSON.parse(await readFile(join(context.orchestratorHome, 'v2', repoKey, 'proofs', proofId, 'state.json'), 'utf8'));
}

async function assertEvidenceCode(context, result, expectedCode) {
  if (typeof result.evidencePath !== 'string') throw new Error(`missing evidence for ${expectedCode}`);
  const evidence = JSON.parse(await readFile(join(context.targetRoot, result.evidencePath), 'utf8'));
  if (evidence.code !== expectedCode) {
    throw new Error(`expected evidence code ${expectedCode}, received ${evidence.code ?? 'missing'}`);
  }
}

async function assertNoPublication(context, issueNumber, scenario) {
  const branch = `codex/issue-${issueNumber}`;
  const pulls = JSON.parse((await runCommand('gh', [
    'pr', 'list', '--repo', context.repo, '--head', branch, '--state', 'all', '--json', 'number', '--limit', '2',
  ], { timeoutMs: context.options.timeoutMs })).stdout);
  const remote = (await runCommand('git', ['-C', context.targetRoot, 'ls-remote', '--heads', 'origin', branch], {
    timeoutMs: context.options.timeoutMs,
  })).stdout.trim();
  if (pulls.length !== 0 || remote) throw new Error(`${scenario}: negative scenario published a branch or PR`);
}

async function postTrustedReviewThread(context, pullRequestNumber, commitSha, path, body) {
  const result = await runCommand('gh', [
    'api', '--method', 'POST', `repos/${context.repo}/pulls/${pullRequestNumber}/comments`,
    '-f', `body=${body}`, '-f', `commit_id=${commitSha}`, '-f', `path=${path}`, '-F', 'line=1', '-f', 'side=RIGHT',
  ], { timeoutMs: context.options.timeoutMs });
  const comment = JSON.parse(result.stdout);
  if (!comment.id || comment.body !== body) throw new Error('trusted review thread was not created');
}

async function assertReviewFeedbackObservable(context, issueNumber, pullRequestNumber, headSha, record) {
  const packageRoot = resolve(dirname(context.cliPath), '../../..');
  const [{ ReviewFeedbackCoordinator }, { GhCliPullRequestAdapter }, { GhCliIssueAdapter }] = await Promise.all([
    import(pathToFileURL(join(packageRoot, 'dist', 'src', 'v2', 'review-feedback-coordinator.js')).href),
    import(pathToFileURL(join(packageRoot, 'dist', 'src', 'v2', 'adapters', 'gh-pull-request-adapter.js')).href),
    import(pathToFileURL(join(packageRoot, 'dist', 'src', 'v2', 'adapters', 'gh-issue-adapter.js')).href),
  ]);
  const coordinator = new ReviewFeedbackCoordinator({
    pullRequests: new GhCliPullRequestAdapter(ownerOf(context.repo), repoOf(context.repo)),
    issues: new GhCliIssueAdapter(ownerOf(context.repo), repoOf(context.repo)),
  });
  const observed = await coordinator.observeAndFreeze({
    runId: record.runId,
    canonicalRepository: record.canonicalRepository,
    pullRequestNumber,
    expectedHeadSha: headSha,
    expectedHeadRefName: `codex/issue-${issueNumber}`,
    expectedBaseRefName: context.baseConfig.github.baseBranch,
    marker: `<!-- codex-orchestrator:run:${record.runId}:pr -->`,
    consumedSourceIds: record.reviewFeedback.consumedSourceIds,
  });
  if (observed.status !== 'frozen' || observed.batch.sources.length !== 1) {
    throw new Error(`review-feedback-continuation: production observation preflight was ${observed.status}${'reason' in observed ? `: ${observed.reason}` : ''}`);
  }
}

async function listConversationComments(context, pullRequestNumber) {
  const result = await runCommand('gh', [
    'api', '--paginate', `repos/${context.repo}/issues/${pullRequestNumber}/comments`,
  ], { timeoutMs: context.options.timeoutMs });
  return JSON.parse(result.stdout);
}

async function requireTypedSetup(context, args) {
  const command = await runCommand(process.execPath, [context.cliPath, ...args], {
    cwd: context.targetRoot || sourceRoot, timeoutMs: context.options.timeoutMs, allowedExitCodes: [0, 20, 70],
    env: liveSmokeEnv(context),
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
  const headSha = (await runCommand('git', ['-C', context.targetRoot, 'rev-parse', `origin/${branch}`], {
    timeoutMs: context.options.timeoutMs,
  })).stdout.trim();
  return { number: pulls[0].number, headSha };
}

async function writeFakeCodex(context) {
  const path = join(context.root, 'fake-codex');
  const installedVersion = (await runCommand('codex', ['--version'], { timeoutMs: context.options.timeoutMs })).stdout.trim();
  await writeFile(path, fakeCodexSource(process.execPath, installedVersion));
  await chmod(path, 0o700);
  return path;
}

async function writeLiveCodex(context) {
  const path = join(context.root, 'live-codex');
  await writeFile(path, liveCodexSource(process.execPath, context.modelAuditPath));
  await chmod(path, 0o700);
  return path;
}

function liveSmokeEnv(context) {
  return {
    ...process.env,
    CODEX_ORCHESTRATOR_HOME: context.orchestratorHome,
    CODEX_ORCHESTRATOR_LIVE_SMOKE_MODEL: liveSmokeModel,
  };
}

async function readModelAudit(context) {
  let content = '';
  try { content = await readFile(context.modelAuditPath, 'utf8'); } catch {}
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function readHarnessAudit(context) {
  let content = '';
  try { content = await readFile(context.harnessAuditPath, 'utf8'); } catch {}
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function assertScenarioModelUsage(scenario, calls) {
  const modelBacked = scenario !== 'discovery-matrix';
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
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

${proofReadinessMarkerPath}

const args = process.argv.slice(2);
const expectedModel = ${JSON.stringify(liveSmokeModel)};
const auditPath = ${JSON.stringify(auditPath)};
const administrative = args[0] === '--version' || (args[0] === 'login' && args[1] === 'status');
if (administrative) { forward(''); }
else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { prompt += chunk; });
  process.stdin.on('end', () => forward(prompt));
}

function forward(prompt) {
  if (!administrative && !args.includes('model="' + expectedModel + '"')) {
    process.stderr.write('live smoke model pin is missing\\n'); process.exitCode = 64; return;
  }
  const criteria = JSON.parse(prompt.match(/Frozen acceptance criteria: (\\[[^\\n]+\\])/u)?.[1] ?? '[]');
  const scenario = criteria.map((item) => item.text).join('\\n').match(/LIVE_SMOKE_SCENARIO=([^\\n]+)/u)?.[1] ?? 'unknown';
  const operation = prompt.includes('/acceptance-proof/') ? 'proof'
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
      if (!administrative) {
        appendFileSync(auditPath, JSON.stringify({
          model: expectedModel, scenario, operation, wrapperAttempt, exitCode: code, signal,
          stderrTail: stderr.replaceAll(process.cwd(), '<worktree>'),
        }) + '\\n');
      }
      const retryProof = operation === 'proof' && scenario !== 'proof-interrupted-daemon' && code !== 0
        && stderr.includes('stream disconnected before completion') && wrapperAttempt < 3;
      if (retryProof) {
        const reportPath = args[args.indexOf('--output-last-message') + 1];
        if (reportPath) rmSync(reportPath, { force: true });
        launch(wrapperAttempt + 1); return;
      }
      if (code === 0 && !administrative) {
        const reportPath = args[args.indexOf('--output-last-message') + 1];
        if (operation === 'code-review') normalizeCodeReview(reportPath, prompt);
        if (operation === 'implementation' && scenario === 'review-feedback-continuation') {
          normalizeReviewFeedbackImplementation(reportPath, prompt);
        }
        applyFault(scenario, operation, prompt);
        if (scenario === 'proof-interrupted-daemon' && operation === 'proof') durableReadinessMarker(reportPath);
      }
      process.exitCode = code ?? (signal ? 1 : 0);
    });
    child.stdin.end(prompt);
  }
}

function durableReadinessMarker(reportPath) {
  let handle = openSync(reportPath, 'r'); fsyncSync(handle); closeSync(handle);
  const marker = proofReadinessMarkerPath(reportPath);
  writeFileSync(marker, 'ready\\n');
  handle = openSync(marker, 'r'); fsyncSync(handle); closeSync(handle);
}

function normalizeCodeReview(reportPath, prompt) {
  const facts = JSON.parse(prompt.match(/Runner-provided facts: (\\[[^\\n]+\\])/u)?.[1] ?? '[]');
  const capsule = JSON.parse(facts[0] ?? '{}');
  const reopen = capsule.mode === 'closure' && capsule.targetRevision === 5 && prompt.includes('quality-gates');
  const report = {
    version: 1, operation: capsule.operation, targetRevision: capsule.targetRevision,
    targetFingerprint: capsule.targetFingerprint, verdict: reopen ? 'needs-work' : 'approved', mode: capsule.mode,
    coverage: capsule.reviewFocus ?? [], defects: capsule.defects ?? [], residualRisks: [],
    reviewerSessionId: capsule.reviewerSessionId, closureRequestSha256: capsule.closureRequestSha256,
    repairFindingOutcomes: (capsule.fixedRepairFindings ?? []).map((finding) => ({
      id: finding.id, status: reopen ? 'reopened' : 'verified',
    })),
  };
  writeFileSync(reportPath, JSON.stringify({ report }));
}

function normalizeReviewFeedbackImplementation(reportPath, prompt) {
  mkdirSync('src/live-smoke', { recursive: true });
  mkdirSync('test/live-smoke', { recursive: true });
  writeFileSync('src/live-smoke/review-feedback-continuation.txt', 'review-feedback-continuation\\n');
  writeFileSync('test/live-smoke/review-feedback-continuation.txt', 'proof for review-feedback-continuation\\n');
  if (prompt.includes('Pull-request feedback repair round')) {
    writeFileSync('src/live-smoke/review-feedback-continuation-addressed.txt', 'addressed review feedback\\n');
  }
  const changedFiles = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    .split('\\0').filter(Boolean).map((row) => row.slice(3)).sort();
  writeFileSync(reportPath, JSON.stringify({ report: {
    version: 1, status: 'completed', summary: 'Review feedback continuation fixture prepared.',
    changedFiles, residualRisks: [],
  } }));
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
  if (operation === 'implementation' && scenario === 'authoritative-candidate-publication') {
    const path = 'src/live-smoke/authoritative-candidate-publication.txt';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'staged content must not become authoritative\\n');
    runGit(['add', '--', path]);
    writeFileSync(path, 'authoritative-candidate-publication\\n');
    return;
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
  if (scenario === 'review-feedback-continuation') {
    discardProofArtifacts(prompt);
    writePassingNonVisualProof(criteria, reportPath);
    return;
  }
  if ([
    'package-install', 'incomplete-progress-rework', 'report-repair', 'diagnostics',
    'authoritative-candidate-publication', 'acceptance-proof-rework',
  ].includes(scenario)) {
    discardProofArtifacts(prompt);
    writePassingNonVisualProof(criteria, reportPath);
    return;
  }
  if (scenario === 'browser-proof') {
    discardProofArtifacts(prompt);
    writeBrowserProof(criteria, reportPath, prompt);
  }
}

function discardProofArtifacts(prompt) {
  const artifactRoot = prompt.match(/Write evidence only below (.+)\\.\\n/u)?.[1];
  if (!artifactRoot) throw new Error('missing proof artifact root');
  rmSync(artifactRoot, { recursive: true, force: true });
}

function writePassingNonVisualProof(criteria, reportPath) {
  writeProofReport(reportPath, {
    version: 1, status: 'passed', decision: { mode: 'non-visual', targets: [] },
    criteria: criteria.map((item) => ({
      id: item.id, status: 'passed', confidence: 'high', surfaces: ['non-visual'],
      evidenceRefs: ['smoke'], analysis: 'The Runner-owned checked command and current change satisfy this criterion.',
    })),
    checks: [], artifacts: [], findings: [], residualRisks: [],
  });
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

function fakeCodexSource(nodePath, codexVersion) {
  return `#!${nodePath}
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (process.argv[2] === '--version') { process.stdout.write(${JSON.stringify(`${codexVersion}\n`)}); process.exit(0); }
const args = process.argv.slice(2);
const reportPath = args[args.indexOf('--output-last-message') + 1];
if (!reportPath) throw new Error('missing report path');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const criteria = JSON.parse(prompt.match(/Frozen acceptance criteria: (\\[[^\\n]+\\])/u)?.[1] ?? '[]');
  const marker = criteria.map((item) => item.text).join('\\n').match(/LIVE_SMOKE_SCENARIO=([^\\n]+)/u)?.[1] ?? 'authoritative-candidate-publication';
  mkdirSync(dirname(reportPath), { recursive: true });
  if (prompt.includes('/triage/')) writeTriage(reportPath);
  else if (prompt.includes('/code-review/') || prompt.includes('"operation":"code-review"')) writeReview(reportPath, prompt);
  else if (prompt.includes('/acceptance-proof/')) writeProof(marker, criteria, reportPath, prompt);
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
    coverage: capsule.reviewFocus ?? [], defects: capsule.defects ?? [], residualRisks: [],
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
  writeAgentReport(reportPath, {
    version: 1, status: 'passed', decision: { mode: 'non-visual', targets: [] },
    criteria: criteria.map((item) => ({ id: item.id, status: 'passed', confidence: 'high', surfaces: ['non-visual'], evidenceRefs: ['smoke'], analysis: 'Runner-owned checked evidence satisfies this criterion.' })),
    checks: [], artifacts: [], findings: [], residualRisks: [],
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
      if (options.retryIf?.(error) === false) throw error;
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
    const installedVersion = 'codex-cli self-test';
    await writeFile(fakePath, fakeCodexSource(process.execPath, installedVersion));
    await chmod(fakePath, 0o700);
    await runCommand('git', ['-C', root, 'add', 'fake-codex']);
    await runCommand('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fake codex']);
    const version = await runCommand(fakePath, ['--version'], { cwd: root });
    if (version.stdout !== `${installedVersion}\n`) throw new Error('fake agent version contract failed');
    const criteria = [{ id: 'ac-001', order: 1, source: 'explicit', text: 'LIVE_SMOKE_SCENARIO=authoritative-candidate-publication' }];
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
      targetFingerprint: 'a'.repeat(64), closureRequestSha256: null, reviewFocus: ['correctness'],
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
      stdin: `Follow the exact operation at /acceptance-proof/SKILL.md.\nFrozen acceptance criteria: ${JSON.stringify(criteria)}\n`,
    });
    const proof = JSON.parse(await readFile(proofPath, 'utf8')).report;
    if (proof.version !== 1 || proof.status !== 'passed' || proof.criteria?.[0]?.id !== 'ac-001'
      || proof.decision?.mode !== 'non-visual') throw new Error('fake proof report contract failed');
    const browserPath = join(root, 'browser-proof.json');
    const browserCriteria = [{ id: 'ac-browser', order: 1, source: 'explicit', text: 'LIVE_SMOKE_SCENARIO=browser-proof' }];
    await runCommand(fakePath, ['exec', '--output-last-message', browserPath], {
      cwd: root,
      stdin: `Follow the exact operation at /acceptance-proof/SKILL.md.\nFrozen acceptance criteria: ${JSON.stringify(browserCriteria)}\nWrite evidence only below .proofs.\n`,
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
