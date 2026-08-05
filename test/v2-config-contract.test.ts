import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { parseAgentAutoConfig, type AgentAutoConfig } from '../src/v2/config.js';
import { PUBLIC_COMMANDS, RUN_ISSUE_STATUSES, renderRunResultJson, runIssueExitCode } from '../src/v2/cli-contract.js';
import type { RunIssueResult } from '../src/v2/run-issue.js';

function validConfig(): AgentAutoConfig {
  return {
    schema: 'codex-orchestrator.agent-auto',
    version: 2,
    github: {
      owner: 'SergiiMytakii',
      repo: 'codex-orchestrator',
      baseBranch: 'main',
      labels: {
        auto: { name: 'agent:auto', color: '1d76db', description: 'Ready for the agent.' },
        running: { name: 'agent:running', color: 'fbca04', description: 'Agent is running.' },
        blocked: { name: 'agent:blocked', color: 'd93f0b', description: 'Agent needs help.' },
        review: { name: 'agent:review', color: '0e8a16', description: 'Ready for review.' },
      },
    },
    runner: {
      workspaceRoot: '.codex-orchestrator/workspaces',
      stateDir: '.codex-orchestrator/v2/state',
      branchTemplate: 'codex/issue-${issueNumber}',
      pollIntervalSeconds: 60,
    },
    codex: {
      command: 'codex',
      timeoutMs: 900_000,
      idleTimeoutMs: 300_000,
      toolNetwork: 'deny',
    },
    checks: {
      typecheck: 'npm run typecheck',
      test: 'npm test',
    },
    proof: { artifactDir: '.codex-orchestrator/v2/proofs' },
    deny: {
      readPaths: ['.env', '/Users/example/.ssh'],
      commands: ['/usr/bin/git'],
    },
  };
}

test('V2 accepts the exact clean config and snapshots the only command, status, and label vocabulary', () => {
  const parsed = parseAgentAutoConfig(validConfig());

  assert.deepEqual(parsed, validConfig());
  assert.deepEqual(PUBLIC_COMMANDS, ['setup', 'doctor', 'status', 'run', 'daemon']);
  assert.deepEqual(RUN_ISSUE_STATUSES, [
    'review-ready',
    'repair-ready',
    'not-eligible',
    'blocked',
    'transport-failed',
    'cancelled',
    'internal-error',
    'requeued',
    'state-schema-unsupported',
  ]);
  assert.deepEqual(Object.values(parsed.github.labels).map((label) => label.name), [
    'agent:auto',
    'agent:running',
    'agent:blocked',
    'agent:review',
  ]);
});

test('the checked-in package config parses through the real V2 parser', async () => {
  const checkedIn = JSON.parse(await readFile(
    path.join(process.cwd(), '.codex-orchestrator/config.json'),
    'utf8',
  ));

  assert.deepEqual(parseAgentAutoConfig(checkedIn), checkedIn);
});

test('V2 rejects unknown configuration surfaces', () => {
  const rejected = [
    { ...validConfig(), schema: 'codex-orchestrator.invalid' },
    { ...validConfig(), unknown: {} },
    { ...validConfig(), runner: { ...validConfig().runner, profile: 'deep' } },
    { ...validConfig(), runner: { ...validConfig().runner, maxCycles: 5 } },
    { ...validConfig(), codex: { ...validConfig().codex, requiredVersion: '0.144.4' } },
  ];

  for (const value of rejected) assert.throws(() => parseAgentAutoConfig(value));
});

test('V2 rejects invalid integers, non-canonical paths, commands, and empty policy strings', () => {
  const rejected = [
    { ...validConfig(), runner: { ...validConfig().runner, pollIntervalSeconds: 0 } },
    { ...validConfig(), runner: { ...validConfig().runner, workspaceRoot: '../workspaces' } },
    { ...validConfig(), proof: { artifactDir: '/absolute/proofs' } },
    { ...validConfig(), deny: { ...validConfig().deny, readPaths: ['/tmp/../secret'] } },
    { ...validConfig(), deny: { ...validConfig().deny, commands: ['git'] } },
    { ...validConfig(), checks: { '': 'npm test' } },
    { ...validConfig(), checks: { test: '' } },
  ];

  for (const value of rejected) assert.throws(() => parseAgentAutoConfig(value));
});

test('V2 accepts a strict optional Runner-owned Android proof recipe and rejects unsafe recipes', () => {
  const android = {
    applicationId: 'ai.levantem.sirbro',
    avdName: 'Pixel_9_API_Baklava',
    flutterCommand: '/Users/example/fvm/flutter',
    buildArgs: ['build', 'apk', '--debug', '--flavor', 'sirbro'],
    apkPath: 'build/app/outputs/flutter-apk/app-sirbro-debug.apk',
    tapText: ['Live'],
    bootTimeoutMs: 180_000,
    navigationTimeoutMs: 60_000,
    settleMs: 5_000,
  };
  assert.deepEqual(parseAgentAutoConfig({
    ...validConfig(), proof: { ...validConfig().proof, android },
  }).proof.android, android);
  for (const invalid of [
    { ...android, applicationId: 'not-an-app-id' },
    { ...android, avdName: '../foreign' },
    { ...android, flutterCommand: 'flutter' },
    { ...android, buildArgs: [] },
    { ...android, buildArgs: ['doctor'] },
    { ...android, buildArgs: ['build', 'appbundle'] },
    { ...android, buildArgs: [...android.buildArgs, '--dart-define=TOKEN=secret'] },
    { ...android, apkPath: '../app.apk' },
    { ...android, launchUri: 'https://user:password@example.com/trades' },
    { ...android, launchUri: 'sirbro://trades?code=magic-link-secret' },
    { ...android, tapText: [] },
    { ...android, tapText: [''] },
    { ...android, navigationTimeoutMs: 120_001 },
    { ...android, unknown: true },
  ]) {
    assert.throws(() => parseAgentAutoConfig({
      ...validConfig(), proof: { ...validConfig().proof, android: invalid },
    }));
  }
});

test('CLI JSON and exit mapping are total over every public runIssue outcome', () => {
  const cases: Array<{ result: RunIssueResult; exit: number }> = [
    { result: { status: 'review-ready', pullRequestUrl: 'https://example.invalid/pr/1', evidencePath: 'evidence/1.json' }, exit: 0 },
    { result: { status: 'not-eligible', reason: 'missing label', evidencePath: 'evidence/2.json' }, exit: 21 },
    { result: { status: 'blocked', kind: 'external', resumable: true, evidencePath: 'evidence/3.json' }, exit: 20 },
    { result: { status: 'blocked', kind: 'safety', resumable: true, evidencePath: 'evidence/4.json' }, exit: 20 },
    { result: { status: 'transport-failed', resumable: true, evidencePath: 'evidence/6.json' }, exit: 70 },
    { result: { status: 'internal-error', evidencePath: 'evidence/7.json' }, exit: 70 },
    { result: { status: 'cancelled', evidencePath: 'evidence/8.json' }, exit: 130 },
    { result: { status: 'requeued', reason: 'owner-contention', evidencePath: 'evidence/requeue.json' }, exit: 0 },
  ];
  for (const entry of cases) {
    assert.equal(runIssueExitCode(entry.result), entry.exit);
    assert.deepEqual(JSON.parse(renderRunResultJson(entry.result)), {
      schema: 'codex-orchestrator.agent-auto-run-result',
      version: 1,
      result: entry.result,
    });
  }
});
