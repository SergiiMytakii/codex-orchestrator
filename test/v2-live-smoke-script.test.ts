import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface CommandResult { status: number | null; stdout: string; stderr: string }

function runLiveSmoke(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url));
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (status) => { resolve({ status, stdout, stderr }); });
  });
}

function listedValues(output: string, label: string): string[] {
  const match = output.match(new RegExp(`^${label}: (.+)$`, 'm'));
  assert.ok(match, `expected ${label} line in output:\n${output}`);
  return match[1].split(',').map((value) => value.trim());
}

async function source(): Promise<string> {
  return readFile(fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url)), 'utf8');
}

const retainedScenarios = [
  'package-install', 'spec-first', 'product-question', 'discovery-matrix', 'commit-policy',
  'incomplete-progress-rework', 'report-repair', 'diagnostics', 'browser-proof',
  'authoritative-candidate-publication', 'acceptance-proof-rework', 'acceptance-proof-negative',
  'review-feedback-continuation', 'quality-gates', 'safety-negative',
];

test('live smoke help pins the V2 scenario and profile matrix', async () => {
  const result = await runLiveSmoke(['--help']);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.deepEqual(listedValues(result.stdout, 'Scenarios'), retainedScenarios);
  assert.deepEqual(listedValues(result.stdout, 'Profiles'), ['core-release', 'v2-regression', 'full']);
  assert.match(result.stdout, /Default core-release/);
});

test('V2 regression profile covers each supplemental non-mobile behavior once', async () => {
  const text = await source();
  const profile = text.slice(text.indexOf("['v2-regression'"), text.indexOf("['full'"));
  assert.deepEqual(
    [...profile.matchAll(/'([^']+)'/gu)].map((match) => match[1]),
    [
      'v2-regression', 'discovery-matrix', 'commit-policy', 'incomplete-progress-rework',
      'report-repair', 'diagnostics', 'authoritative-candidate-publication', 'acceptance-proof-rework',
      'acceptance-proof-negative', 'review-feedback-continuation', 'quality-gates',
    ],
  );
});

test('live smoke omits legacy scenario aliases without distinct V2 behavior', async () => {
  const result = await runLiveSmoke(['--help']);
  for (const alias of [
    'baseline', 'remote-base-branch', 'scoped-runner-commit', 'run-scoped',
    'loop-policy', 'proof-strategy-non-visual-smoke',
    'acceptance-proof-positive',
  ]) {
    assert.doesNotMatch(result.stdout, new RegExp(`\\b${alias}\\b`, 'u'));
  }
});

test('authoritative candidate smoke proves mixed-index capture and exact publication cleanup', async () => {
  const text = await source();
  assert.match(text, /authoritative-candidate-publication/u);
  assert.match(text, /staged content must not become authoritative/u);
  assert.match(text, /git diff --cached --quiet/u);
  assert.match(text, /state\.schema !== 'codex-orchestrator\.run-state'/u);
  assert.match(text, /candidateTreeSha !== publishedTreeSha/u);
  assert.match(text, /candidate pin survived successful publication/u);
  assert.match(text, /candidate execution worktree survived successful publication/u);
  assert.match(text, /candidate execution directory survived successful publication/u);
});

test('default core release proves direct, spec-first, product-question, and post-PR flows', async () => {
  const text = await source();
  const coreProfile = text.slice(text.indexOf("['core-release'"), text.indexOf("['v2-regression'"));
  assert.deepEqual(
    [...coreProfile.matchAll(/'([^']+)'/gu)].map((match) => match[1]),
    ['core-release', 'package-install', 'spec-first', 'product-question', 'review-feedback-continuation'],
  );
});

test('live smoke rejects unknown profile before package or GitHub work', async () => {
  const result = await runLiveSmoke(['--profile', 'missing-profile']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Known profiles: core-release, v2-regression, full/);
  assert.doesNotMatch(result.stdout, /npm pack|scenario/u);
});

test('generated fake agent emits exact V2 implementation, code-review, and proof reports without GitHub work', async () => {
  const result = await runLiveSmoke(['--self-test-fake-agent']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'V2 fake agent self-test passed.\n');
});

test('generated live Codex wrapper pins Luna, records the invocation, and injects faults after it', async () => {
  const result = await runLiveSmoke(['--self-test-live-codex']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'V2 live Codex wrapper self-test passed.\n');
});

test('fixture-specific mobile gates are not misrepresented as GitHub live smoke scenarios', async () => {
  const text = await source();
  assert.doesNotMatch(text, /mobile-proof|android-proof|ios-proof/u);
  assert.doesNotMatch(text, /v2-(?:android|ios)-real-gate\.js/u);
});

test('packed smoke resolves the public V2 CLI', async () => {
  const text = await source();
  assert.match(text, /dist['"], 'src', 'v2', 'cli\.js'/u);
  assert.doesNotMatch(text, /const cliPath = join\(packageRoot, 'package', 'dist', 'src', 'cli\.js'\)/u);
});

test('packed smoke parses npm JSON after prepack lifecycle output', async () => {
  const moduleUrl = new URL('../../scripts/live-smoke.mjs', import.meta.url);
  const module = await import(moduleUrl.href) as {
    parseNpmPackOutput: (stdout: string) => Array<{ filename?: unknown }>;
  };
  assert.deepEqual(module.parseNpmPackOutput([
    'cde38bdb71f2b731c7fa050a06dd66f6b639ac879178079a2e4924440d4aed3c',
    '[',
    '  {"filename":"codex-orchestrator-0.1.51.tgz"}',
    ']',
    '',
  ].join('\n')), [{ filename: 'codex-orchestrator-0.1.51.tgz' }]);
});

test('live smoke documents scratch repo and strict cleanup defaults', async () => {
  const result = await runLiveSmoke(['--help']);
  assert.match(result.stdout, /SergiiMytakii\/codex-orchestrator-live-smoke/u);
  assert.match(result.stdout, /Clean up created issues, PRs, branches, labels, refs, worktrees, processes, and temporary data after the run by default/u);
  assert.match(result.stdout, /Cleanup mode: delete or close\. Default delete/u);
  const text = await source();
  const cleanup = text.slice(text.indexOf('async function cleanup'), text.indexOf('async function bestEffort'));
  assert.match(cleanup, /await discoverRunArtifacts\(context, failures\)/u);
  assert.match(cleanup, /--state', 'all'/u);
  assert.match(cleanup, /LIVE_SMOKE_RUN_ID=/u);
  assert.match(cleanup, /await verifyCleanup\(context, failures\)/u);
  assert.match(cleanup, /createdLabels/u);
  assert.match(cleanup, /candidate refs/u);
  assert.match(cleanup, /candidate worktrees/u);
  assert.match(cleanup, /live-smoke child processes/u);
});

test('live smoke preflight is authenticated, scratch-only, and exclusively locked', async () => {
  const text = await source();
  const preflight = text.slice(text.indexOf('async function preflight'), text.indexOf('async function prepareTarget'));
  assert.match(preflight, /productionRepo/u);
  assert.match(preflight, /approvedLiveSmokeRepo/u);
  assert.doesNotMatch(preflight, /CODEX_ORCHESTRATOR_LIVE_SMOKE_REPO/u);
  assert.match(preflight, /gh', \['auth', 'status'/u);
  assert.match(preflight, /codex', \['login', 'status'/u);
  assert.match(preflight, /scratchLockBranch/u);
  assert.match(preflight, /refs\/heads/u);
  assert.match(preflight, /status', '--porcelain', '--untracked-files=no/u);
  assert.match(preflight, /clean immutable HEAD/u);
  assert.match(text, /Source HEAD: \$\{sourceHead\}/u);
});

test('strict cleanup removes only run-created local resources and requires complete label setup', async () => {
  const text = await source();
  const parser = text.slice(text.indexOf('function parseArgs'), text.indexOf('function selectScenarios'));
  assert.doesNotMatch(parser, /--work-dir|--target/u);
  assert.match(text, /setup\.result\.status !== 'labels-prepared'/u);
  const cleanup = text.slice(text.indexOf('async function cleanupLocalSafetyResources'), text.indexOf('async function removeTemporaryArtifacts'));
  assert.match(cleanup, /baselineCandidateRefs/u);
  assert.match(cleanup, /baselineWorktrees/u);
  assert.match(cleanup, /!context\.lockAcquired/u);
  assert.match(cleanup, /worktree', 'remove', '--force'/u);
  assert.doesNotMatch(cleanup, /for \(const ref of refs\).*every/u);
  assert.match(text, /terminateRunProcesses/u);
  assert.match(text, /SIGTERM/u);
  assert.match(text, /SIGKILL/u);
  const removal = text.slice(text.indexOf('async function removeTemporaryArtifacts'), text.indexOf('async function discoverRunArtifacts'));
  assert.match(removal, /rm\(context\.root, \{ recursive: true, force: true \}\)/u);
  assert.doesNotMatch(removal, /for \(const name/u);
});

test('spec-first and product-question continue approved authority in the same Run', async () => {
  const text = await source();
  const scenarios = text.slice(text.indexOf('async function runSpecFirstScenario'), text.indexOf('async function runDiscoveryMatrixScenario'));
  assert.match(scenarios, /routeReceipt\?\.route !== 'spec-required'/u);
  assert.match(scenarios, /specDelivery\?\.stage !== 'frozen'/u);
  assert.match(scenarios, /status: 'spec-frozen'/u);
  assert.match(scenarios, /receipt\.answerPrefix/u);
  assert.match(scenarios, /acceptedAnswers\?\.length !== 1/u);
  const normalization = text.slice(text.indexOf('function normalizeSpecReview'), text.indexOf('function normalizeReviewFeedbackImplementation'));
  for (const coverage of ['approved-product-intent', 'deterministic-executability', 'safety', 'scope', 'validation']) {
    assert.match(normalization, new RegExp(coverage, 'u'));
  }
  assert.match(text, /'spec-frozen': 0/u);
  const runtime = await readFile(fileURLToPath(new URL('../../src/v2/runtime.ts', import.meta.url)), 'utf8');
  assert.match(runtime, /acceptedAnswers: state\.acceptedAnswers/u);
  assert.match(runtime, /trustedAnswer: state\.trustedAnswer \?\? null/u);
});

test('live smoke omits the redundant free-form real-codex scenario', async () => {
  const text = await source();
  assert.doesNotMatch(text, /real-codex|runRealCodexScenario/u);
});

test('every model-backed live smoke invocation pins GPT-5.6 Luna', async () => {
  const text = await source();
  assert.match(text, /const liveSmokeModel = 'gpt-5\.6-luna'/u);
  assert.match(text, /CODEX_ORCHESTRATOR_LIVE_SMOKE_MODEL: liveSmokeModel/u);
  assert.match(text, /context\.liveCodexPath/u);
  assert.doesNotMatch(text, /context\.fakeCodexPath/u);
  assert.match(text, /model_reasoning_effort="low"/u);
});

test('live smoke starts the packaged runtime without a certification step', async () => {
  const text = await source();
  assert.match(text, /orchestratorHome: join\(root, 'orchestrator-home'\)/u);
  assert.match(text, /CODEX_ORCHESTRATOR_HOME: context\.orchestratorHome/u);
  assert.doesNotMatch(text, /certifyLiveCodex|CODEX_ORCHESTRATOR_CONTAINMENT_CODEX|v2-containment\.canary/u);
});

test('real Codex smoke budgets cover the complete multi-operation workflow', async () => {
  const text = await source();
  assert.match(text, /const defaultTimeoutMs = 1_800_000;/u);
  assert.match(text, /config\.codex\.timeoutMs = 600_000;/u);
});

test('quality-gates consumes implementation cycles without a second review lifecycle', async () => {
  const text = await source();
  const normalization = text.slice(text.indexOf('function normalizeCodeReview'), text.indexOf('function applyFault'));
  assert.match(normalization, /coverage: capsule\.reviewFocus/u);
  assert.match(normalization, /capsule\.fixedRepairFindings/u);
  assert.match(normalization, /verdict: 'approved'/u);
  assert.match(normalization, /status: 'verified'/u);
  assert.doesNotMatch(normalization, /closure|mode|reopen/u);
});

test('every live code review is normalized from the runner-owned review capsule', async () => {
  const text = await source();
  const normalization = text.slice(text.indexOf('function normalizeCodeReview'), text.indexOf('function normalizeReviewFeedbackImplementation'));
  assert.match(normalization, /operation: capsule\.operation/u);
  assert.match(normalization, /targetFingerprint: capsule\.targetFingerprint/u);
  assert.match(normalization, /reviewerSessionId: capsule\.reviewerSessionId/u);
  assert.match(normalization, /writeFileSync\(reportPath, JSON\.stringify\(\{ report \}\)\)/u);
  assert.doesNotMatch(normalization, /readFileSync\(reportPath/u);
});

test('browser proof fixture uses an HTTP workflow entrypoint accepted by the proof contract', async () => {
  const text = await source();
  const fixture = text.slice(text.indexOf('function writeBrowserProof'), text.indexOf('function writeAgentReport'));
  assert.match(fixture, /entrypoint: 'http:\/\/127\.0\.0\.1:/u);
  const applyFault = text.slice(text.indexOf('function applyFault'), text.indexOf('function discardProofArtifacts'));
  assert.match(applyFault, /scenario === 'browser-proof'\) \{\s*discardProofArtifacts\(prompt\);/u);
});

test('incomplete-progress retry uses a deterministic clean transport failure before the retry', async () => {
  const text = await source();
  const fixture = text.slice(text.indexOf("scenario === 'incomplete-progress-rework'"), text.indexOf("if (scenario === 'safety-negative')"));
  assert.match(fixture, /stream disconnected before completion/u);
  assert.doesNotMatch(fixture, /setInterval/u);
  const scenarioRunner = text.slice(text.indexOf('async function runReviewReadyScenario'), text.indexOf('async function runPackageInstallScenario'));
  assert.doesNotMatch(scenarioRunner, /idleTimeoutMs/u);
});

test('proof rework fault discards transient proof evidence before a minimal needs-rework report', async () => {
  const text = await source();
  const applyFault = text.indexOf('function applyFault');
  const fixture = text.slice(text.indexOf("scenario === 'acceptance-proof-rework'", applyFault), text.indexOf("if (scenario === 'browser-proof')", applyFault));
  assert.match(fixture, /discardProofArtifacts\(prompt\)/u);
  assert.match(text, /rmSync\(artifactRoot, \{ recursive: true, force: true \}\)/u);
  assert.match(fixture, /src\/live-smoke\/acceptance-proof-rework-complete\.txt/u);
  assert.match(fixture, /evidenceRefs: \[\]/u);
  assert.match(fixture, /checks: \[\], artifacts: \[\]/u);
  assert.match(text, /acceptance-proof-rework: expected cycle=2/u);
});

test('negative proof fault discards transient evidence before the external blocker report', async () => {
  const text = await source();
  const applyFault = text.indexOf('function applyFault');
  const fixture = text.slice(text.indexOf("scenario === 'acceptance-proof-negative'", applyFault), text.indexOf("scenario === 'acceptance-proof-rework'", applyFault));
  assert.match(fixture, /discardProofArtifacts\(prompt\)/u);
});

test('review feedback continuation smoke proves same-PR update and effect-free replay', async () => {
  const text = await source();
  const scenario = text.slice(
    text.indexOf('async function runReviewFeedbackContinuationScenario'),
    text.indexOf('async function runPackageInstallScenario'),
  );
  assert.match(scenario, /review feedback baseline/u);
  assert.match(scenario, /postTrustedReviewThread/u);
  assert.match(scenario, /assertReviewFeedbackObservable/u);
  assert.match(scenario, /runDaemonOnce\(context, issue\.number\)/u);
  assert.match(scenario, /continuationEpoch/u);
  assert.match(scenario, /history\.length !== 1/u);
  assert.match(scenario, /checkedChangeSha256/u);
  assert.match(scenario, /proofId/u);
  assert.match(scenario, /summary marker/u);
  assert.match(scenario, /model calls during effect-free replay/u);
  assert.match(scenario, /rev-list/u);
  const normalization = text.slice(
    text.indexOf('function normalizeReviewFeedbackImplementation'),
    text.indexOf('function applyFault'),
  );
  assert.match(normalization, /Pull-request feedback repair round/u);
  assert.match(normalization, /review-feedback-continuation-addressed\.txt/u);
  assert.match(normalization, /changedFiles/u);
  const proofNormalization = text.slice(text.indexOf('function applyFault'), text.indexOf('function discardProofArtifacts'));
  assert.match(proofNormalization, /scenario === 'review-feedback-continuation'/u);
  assert.match(proofNormalization, /discardProofArtifacts\(prompt\)/u);
  assert.match(proofNormalization, /writePassingNonVisualProof\(criteria, reportPath, prompt\)/u);
});

test('daemon continuation reads the target issue result from authoritative run state', async () => {
  const text = await source();
  const runner = text.slice(text.indexOf('async function runDaemonOnce'), text.indexOf('async function readRunRecord'));
  assert.match(runner, /readRunRecord\(context, issueNumber\)/u);
  assert.match(runner, /record\.terminalOutcome/u);
  assert.doesNotMatch(runner, /parseExactEnvelope/u);
});

test('daemon continuation requires exclusive scratch-repository candidate ownership', async () => {
  const text = await source();
  const daemon = text.slice(text.indexOf('async function runDaemonOnce'), text.indexOf('async function readRunRecord'));
  assert.match(daemon, /await assertExclusiveDaemonCandidate\(context, issueNumber\)/u);
  assert.match(daemon, /'--once', '--issue', String\(issueNumber\)/u);
  assert.match(daemon, /'agent:auto', 'agent:review'/u);
  assert.match(daemon, /runOwnedIssues = new Set\(context\.createdIssues\)/u);
  assert.match(daemon, /!candidates\.has\(issueNumber\)/u);
  assert.match(daemon, /!runOwnedIssues\.has\(candidate\)/u);
});

test('scenario assertions bind live smoke outcomes to their current owner behavior', async () => {
  const text = await source();
  assert.match(text, /context\.cliPath = installedCliPath/u);
  assert.match(text, /expected one durable transport retry/u);
  assert.match(text, /expected one durable report repair/u);
  assert.match(text, /expected two publishable responsive screenshots/u);
  assert.match(text, /read-only diagnostics mutated the target/u);
  assert.match(text, /did not exhaust on the fifth configured-check failure/u);
  assert.match(text, /record\.terminalOutcome\.kind !== 'exhausted'/u);
  assert.match(text, /reworkFindings\[0\]\.startsWith\('Check smoke failed:'\)/u);
  assert.match(text, /denied-path-modified/u);
  assert.match(text, /negative scenario published a branch or PR/u);
  assert.match(text, /terminalCode=\$\{terminalCode\}/u);
});

test('fixture happy paths normalize proof semantics after real model invocation', async () => {
  const text = await source();
  const applyFault = text.slice(text.indexOf('function applyFault'), text.indexOf('function discardProofArtifacts'));
  for (const scenario of [
    'package-install', 'incomplete-progress-rework', 'report-repair', 'diagnostics',
    'authoritative-candidate-publication', 'acceptance-proof-rework',
  ]) assert.match(applyFault, new RegExp(`'${scenario}'`, 'u'));
  assert.match(applyFault, /writePassingNonVisualProof\(criteria, reportPath, prompt\)/u);
  assert.match(text, /Configured check receipts:/u);
  assert.match(text, /checks: \[\], artifacts: \[\], findings: \[\], residualRisks: \[\]/u);
});

test('implementation operation defines changedFiles as the cumulative run change set', async () => {
  const operation = await readFile(fileURLToPath(new URL('../../scripts/runtime-workflow-overlays/operations/implementation/SKILL.md', import.meta.url)), 'utf8');
  assert.match(operation, /changedFiles.*complete current product\s+change set across all implementation cycles/isu);
});

test('strict cleanup retries eventually consistent observations before failing', async () => {
  const module = await import(new URL('../../scripts/live-smoke.mjs', import.meta.url).href) as {
    retryCleanupObservation: (action: () => Promise<void>, options: { attempts: number; delayMs: number }) => Promise<void>;
  };
  let attempts = 0;
  await module.retryCleanupObservation(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('not settled');
  }, { attempts: 3, delayMs: 0 });
  assert.equal(attempts, 3);

  await assert.rejects(module.retryCleanupObservation(async () => {
    throw new Error('still present');
  }, { attempts: 2, delayMs: 0 }), /still present/u);
});

test('strict temporary cleanup removes the complete read-only run root', async () => {
  const module = await import(new URL('../../scripts/live-smoke.mjs', import.meta.url).href) as {
    removeTemporaryArtifacts: (context: { root: string; options: { timeoutMs: number } }) => Promise<void>;
  };
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cleanup-test-'));
  const nested = join(root, 'readonly');
  await mkdir(nested);
  await writeFile(join(nested, 'artifact.json'), '{}\n');
  await chmod(nested, 0o500);
  await module.removeTemporaryArtifacts({ root, options: { timeoutMs: 10_000 } });
  await assert.rejects(readFile(join(nested, 'artifact.json')), /ENOENT/u);
});
