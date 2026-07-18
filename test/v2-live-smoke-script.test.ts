import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  'package-install', 'discovery-matrix', 'real-codex', 'commit-policy',
  'incomplete-progress-rework', 'report-repair', 'diagnostics', 'browser-proof',
  'acceptance-proof-positive', 'acceptance-proof-rework', 'acceptance-proof-negative',
  'android-proof', 'ios-proof', 'quality-gates', 'safety-negative',
];

test('live smoke help pins the V2 scenario and profile matrix', async () => {
  const result = await runLiveSmoke(['--help']);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.deepEqual(listedValues(result.stdout, 'Scenarios'), retainedScenarios);
  assert.deepEqual(listedValues(result.stdout, 'Profiles'), ['core-release', 'v2-regression', 'mobile-proof', 'full']);
  assert.match(result.stdout, /Default core-release/);
});

test('V2 regression profile covers each supplemental non-mobile behavior once', async () => {
  const text = await source();
  const profile = text.slice(text.indexOf("['v2-regression'"), text.indexOf("['mobile-proof'"));
  assert.deepEqual(
    [...profile.matchAll(/'([^']+)'/gu)].map((match) => match[1]),
    [
      'v2-regression', 'discovery-matrix', 'commit-policy', 'incomplete-progress-rework',
      'report-repair', 'diagnostics', 'acceptance-proof-positive', 'acceptance-proof-rework',
      'acceptance-proof-negative', 'quality-gates',
    ],
  );
});

test('live smoke omits legacy scenario aliases without distinct V2 behavior', async () => {
  const result = await runLiveSmoke(['--help']);
  for (const alias of [
    'baseline', 'remote-base-branch', 'scoped-runner-commit', 'run-scoped',
    'loop-policy', 'proof-strategy-non-visual-smoke',
  ]) {
    assert.doesNotMatch(result.stdout, new RegExp(`\\b${alias}\\b`, 'u'));
  }
});

test('default core release keeps only external integration proofs', async () => {
  const text = await source();
  const coreProfile = text.slice(text.indexOf("['core-release'"), text.indexOf("['v2-regression'"));
  assert.deepEqual(
    [...coreProfile.matchAll(/'([^']+)'/gu)].map((match) => match[1]),
    ['core-release', 'package-install', 'real-codex', 'browser-proof', 'safety-negative'],
  );
});

test('live smoke rejects unknown profile before package or GitHub work', async () => {
  const result = await runLiveSmoke(['--profile', 'missing-profile']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Known profiles: core-release, v2-regression, mobile-proof, full/);
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

test('mobile-proof is explicit and non-skippable', async () => {
  const text = await source();
  assert.match(text, /\['mobile-proof',[\s\S]*'android-proof',[\s\S]*'ios-proof'/u);
  assert.match(text, /v2-android-real-gate\.js/u);
  assert.match(text, /v2-ios-real-gate\.js/u);
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
  assert.match(result.stdout, /Clean up created issues, PRs, and branches after the run by default/u);
  assert.match(result.stdout, /Cleanup mode: delete or close\. Default delete/u);
  const text = await source();
  const cleanup = text.slice(text.indexOf('async function cleanup'), text.indexOf('async function bestEffort'));
  assert.match(cleanup, /await discoverRunArtifacts\(context, failures\)/u);
  assert.match(cleanup, /--state', 'all'/u);
  assert.match(cleanup, /LIVE_SMOKE_RUN_ID=/u);
  assert.match(cleanup, /await verifyCleanup\(context, failures\)/u);
});

test('real Codex scenario keeps routing markers outside frozen acceptance criteria', async () => {
  const text = await source();
  assert.match(text, /runRealCodexScenario[\s\S]*?\], false\);/u);
  assert.match(text, /markersAsCriteria \? markers : \[\]/u);
});

test('every model-backed live smoke invocation pins GPT-5.6 Luna', async () => {
  const text = await source();
  assert.match(text, /const liveSmokeModel = 'gpt-5\.6-luna'/u);
  assert.match(text, /CODEX_ORCHESTRATOR_LIVE_SMOKE_MODEL: liveSmokeModel/u);
  assert.match(text, /context\.liveCodexPath/u);
  assert.doesNotMatch(text, /context\.fakeCodexPath/u);
});

test('real Codex smoke budgets cover the complete multi-operation workflow', async () => {
  const text = await source();
  assert.match(text, /const defaultTimeoutMs = 1_800_000;/u);
  assert.match(text, /config\.codex\.timeoutMs = 600_000;/u);
});

test('quality-gates deterministically reopens the failed check at the fifth closure', async () => {
  const text = await source();
  const normalization = text.slice(text.indexOf('function normalizeClosureReview'), text.indexOf('function applyFault'));
  assert.match(normalization, /report\.coverage = capsule\.mandatoryCoverage/u);
  assert.match(normalization, /capsule\.fixedRepairFindings/u);
  assert.match(normalization, /report\.targetRevision === 5/u);
  assert.match(normalization, /prompt\.includes\('quality-gates'\)/u);
  assert.match(normalization, /report\.verdict = 'needs-work'/u);
  assert.match(normalization, /status: 'reopened'/u);
});

test('browser proof fixture uses an HTTP workflow entrypoint accepted by the proof contract', async () => {
  const text = await source();
  const fixture = text.slice(text.indexOf('function writeBrowserProof'), text.indexOf('function writeAgentReport'));
  assert.match(fixture, /entrypoint: 'http:\/\/127\.0\.0\.1:/u);
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
