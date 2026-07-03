import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runLiveSmoke(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url));
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function runLiveSmokeHelp(): Promise<CommandResult> {
  return runLiveSmoke(['--help']);
}

async function extractFakeAgentSource(): Promise<string> {
  const scriptPath = fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url));
  const script = await readFile(scriptPath, 'utf8');
  const match = script.match(/function fakeAgentSource\(\) {\n\s+return String\.raw`([\s\S]*?)`;\n}/);
  assert.ok(match, 'expected live smoke script to contain fakeAgentSource raw template');
  return match[1];
}

async function liveSmokeScriptSource(): Promise<string> {
  const scriptPath = fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url));
  return readFile(scriptPath, 'utf8');
}

function runNodeScript(scriptPath: string, env: Record<string, string>, cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function listedValues(output: string, label: string): string[] {
  const match = output.match(new RegExp(`^${label}: (.+)$`, 'm'));
  assert.ok(match, `expected ${label} line in output:\n${output}`);
  return match[1].split(',').map((value) => value.trim());
}

test('live smoke help lists publish-gate coverage scenarios', async () => {
  const result = await runLiveSmokeHelp();

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const scenarios = listedValues(result.stdout, 'Scenarios');
  assert.deepEqual(scenarios, [
    'baseline',
    'package-install',
    'discovery-matrix',
    'real-codex',
    'remote-base-branch',
    'scoped-runner-commit',
    'commit-policy',
    'run-scoped',
    'loop-policy',
    'diagnostics',
    'browser-proof',
    'acceptance-proof-positive',
    'proof-strategy-non-visual-smoke',
    'acceptance-proof-rework',
    'acceptance-proof-negative',
    'quality-gates',
    'risk-routing',
    'safety-negative',
    'plan-auto',
    'run-plan-auto',
    'plan-auto-blocking',
    'tree-child-quality-rework',
  ]);
  assert.equal(scenarios.includes('visual-proof'), false);
  assert.equal(scenarios.includes('scoped-local-commit'), false);
  assert.equal(scenarios.includes('local-commit-blocked'), false);
  assert.equal(scenarios.includes('denied-secret'), false);
  assert.equal(scenarios.includes('invalid-report'), false);
});

test('live smoke help documents run profiles and default core release profile', async () => {
  const result = await runLiveSmokeHelp();

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--profile <name>\s+Run a scenario profile\. Default core-release/);
  assert.deepEqual(listedValues(result.stdout, 'Profiles'), [
    'core-release',
    'extended-policy',
    'proof-matrix',
    'full',
  ]);
});

test('live smoke rejects unknown profiles before running smoke setup', async () => {
  const result = await runLiveSmoke(['--profile', 'missing-profile']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown profile "missing-profile"/);
  assert.match(result.stderr, /Known profiles: core-release, extended-policy, proof-matrix, full/);
});

test('live smoke extended policy profile includes tree-child quality rework scenario', async () => {
  const source = await liveSmokeScriptSource();

  assert.match(source, /'extended-policy'[\s\S]*'tree-child-quality-rework'/);
  assert.match(source, /runTreeChildQualityReworkScenario/);
});

test('live smoke help documents scratch repo and strict cleanup defaults', async () => {
  const result = await runLiveSmokeHelp();

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Defaults to SergiiMytakii\/codex-orchestrator-live-smoke/);
  assert.match(result.stdout, /Clean up created issues, PRs, and branches after the run by default/);
  assert.match(result.stdout, /--cleanup-mode <mode>\s+Cleanup mode: delete or close\. Default delete/);
  assert.match(result.stdout, /--keep-artifacts\s+Keep created GitHub artifacts for inspection/);
});

test('live smoke fake plan child writes only graph-owned paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-fake-plan-child-'));
  const promptPath = join(root, 'prompt.md');
  const reportPath = join(root, 'issue-123-tree-24-issue-123.json');
  const fakeAgentPath = join(root, 'fake-agent.mjs');
  await writeFile(promptPath, [
    'Live smoke child a.',
    '',
    'LIVE_SMOKE_RUN_ID: 20260702141645',
    'LIVE_SMOKE_SCENARIO: plan-child',
    'LIVE_SMOKE_CHILD_ID: a',
  ].join('\n'), 'utf8');
  await writeFile(fakeAgentPath, await extractFakeAgentSource(), 'utf8');

  const result = await runNodeScript(fakeAgentPath, {
    CODEX_ORCHESTRATOR_PROMPT_FILE: promptPath,
    CODEX_ORCHESTRATOR_REPORT_FILE: reportPath,
  }, root);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.deepEqual(report.changes, [
    'src/live-smoke/issue-owned-by-child-a.ts',
    'test/live-smoke/issue-owned-by-child-a.test.ts',
  ]);
  assert.match(await readFile(join(root, 'src/live-smoke/issue-owned-by-child-a.ts'), 'utf8'), /plan-child/);
  assert.match(await readFile(join(root, 'test/live-smoke/issue-owned-by-child-a.test.ts'), 'utf8'), /20260702141645/);
});

test('live smoke fake agent supports tree-child quality rework markers', async () => {
  const source = await extractFakeAgentSource();

  assert.match(source, /plan-quality-rework/);
  assert.match(source, /plan-child-quality-rework/);
  assert.match(source, /automatic rework attempt \(#1\)/);
  assert.match(source, /tree-child quality rework structured TDD/);
});

test('live smoke fake agent uses the child scenario marker for tree-child prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-fake-quality-rework-child-'));
  const promptPath = join(root, 'prompt.md');
  const reportPath = join(root, 'issue-134-tree-133-issue-134.json');
  const fakeAgentPath = join(root, 'fake-agent.mjs');
  await writeFile(promptPath, [
    'Parent issue context.',
    '',
    'LIVE_SMOKE_RUN_ID: 20260703082546',
    'LIVE_SMOKE_SCENARIO: plan-quality-rework',
    '',
    'Child issue context.',
    '',
    'LIVE_SMOKE_RUN_ID: 20260703082546',
    'LIVE_SMOKE_SCENARIO: plan-child-quality-rework',
    'LIVE_SMOKE_CHILD_ID: quality-rework',
  ].join('\n'), 'utf8');
  await writeFile(fakeAgentPath, await extractFakeAgentSource(), 'utf8');

  const result = await runNodeScript(fakeAgentPath, {
    CODEX_ORCHESTRATOR_PROMPT_FILE: promptPath,
    CODEX_ORCHESTRATOR_REPORT_FILE: reportPath,
  }, root);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.deepEqual(report.validation, [
    { command: 'npm test', status: 'passed', summary: 'all tests passed without red-green proof' },
  ]);
});

test('browser proof live smoke helper runs visual proof against target root', async () => {
  const source = await liveSmokeScriptSource();

  assert.match(source, /CODEX_ORCHESTRATOR_TARGET_ROOT/);
  assert.match(source, /'visual-proof', 'auto', '--issue', String\(issueNumber\)/);
  assert.match(source, /cwd: targetRoot/);
});
