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
  'baseline', 'package-install', 'discovery-matrix', 'real-codex', 'remote-base-branch',
  'scoped-runner-commit', 'commit-policy', 'run-scoped', 'loop-policy', 'incomplete-progress-rework',
  'report-repair', 'diagnostics', 'browser-proof', 'acceptance-proof-positive',
  'proof-strategy-non-visual-smoke', 'acceptance-proof-rework', 'acceptance-proof-negative',
  'android-proof', 'ios-proof', 'quality-gates', 'safety-negative',
];

test('live smoke help pins the V2 scenario and profile matrix', async () => {
  const result = await runLiveSmoke(['--help']);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.deepEqual(listedValues(result.stdout, 'Scenarios'), retainedScenarios);
  assert.deepEqual(listedValues(result.stdout, 'Profiles'), ['core-release', 'extended-policy', 'proof-matrix', 'mobile-proof', 'full']);
  assert.match(result.stdout, /Default core-release/);
});

test('default core release keeps only external integration proofs', async () => {
  const text = await source();
  const coreProfile = text.slice(text.indexOf("['core-release'"), text.indexOf("['extended-policy'"));
  assert.deepEqual(
    [...coreProfile.matchAll(/'([^']+)'/gu)].map((match) => match[1]),
    ['core-release', 'package-install', 'real-codex', 'browser-proof', 'safety-negative'],
  );
});

test('live smoke rejects unknown profile before package or GitHub work', async () => {
  const result = await runLiveSmoke(['--profile', 'missing-profile']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Known profiles: core-release, extended-policy, proof-matrix, mobile-proof, full/);
  assert.doesNotMatch(result.stdout, /npm pack|scenario/u);
});

test('removed plan-tree-risk scenarios are absent from registry and profiles', async () => {
  const text = await source();
  const registry = text.slice(text.indexOf('const scenarioDefinitions'), text.indexOf('async function main'));
  for (const removed of ['risk-routing', 'plan-auto', 'run-plan-auto', 'plan-auto-blocking', 'tree-child-quality-rework', 'plan-auto-tree-recovery']) {
    assert.doesNotMatch(registry, new RegExp(removed, 'u'));
  }
  for (const legacyContract of ['allowAgentLocalCommits', 'freshContextReview', 'policySuggestions', 'plan-child', 'tree-child', 'run-plan-auto']) {
    assert.doesNotMatch(text, new RegExp(legacyContract, 'u'));
  }
});

test('generated fake agent emits exact V2 implementation, code-review, and proof reports without GitHub work', async () => {
  const result = await runLiveSmoke(['--self-test-fake-agent']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'V2 fake agent self-test passed.\n');
});

test('mobile-proof is explicit and non-skippable', async () => {
  const text = await source();
  assert.match(text, /\['mobile-proof',[\s\S]*'android-proof',[\s\S]*'ios-proof'/u);
  assert.match(text, /v2-android-real-gate\.js/u);
  assert.match(text, /v2-ios-real-gate\.js/u);
});

test('packed smoke resolves the public V2 CLI', async () => {
  const text = await source();
  assert.match(text, /dist['"], 'src', 'v2', 'candidate-cli\.js'/u);
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

test('real Codex smoke uses the normal Codex default without changing target defaults', async () => {
  const text = await source();
  assert.match(text, /overrides\.realCodex \? 'codex' : context\.fakeCodexPath/u);
  assert.doesNotMatch(text, /realCodexSmokeModel|model_reasoning_effort/u);
});

test('real Codex smoke budgets cover the complete multi-operation workflow', async () => {
  const text = await source();
  assert.match(text, /const defaultTimeoutMs = 1_800_000;/u);
  assert.match(text, /config\.codex\.timeoutMs = overrides\.realCodex \? 600_000 : 180_000;/u);
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
