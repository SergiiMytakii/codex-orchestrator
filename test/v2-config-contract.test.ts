import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAgentAutoConfig, type AgentAutoConfigV1 } from '../src/v2/config.js';
import { CANDIDATE_COMMANDS, RUN_ISSUE_STATUSES, renderRunResultJson, runIssueExitCode } from '../src/v2/cli-contract.js';
import type { RunIssueResult } from '../src/v2/run-issue.js';

function validConfig(): AgentAutoConfigV1 {
  return {
    schema: 'codex-orchestrator.agent-auto',
    version: 1,
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
      maxCycles: 5,
    },
    codex: {
      command: 'codex',
      requiredVersion: '0.144.4',
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
  assert.deepEqual(CANDIDATE_COMMANDS, ['setup', 'doctor', 'status', 'run', 'daemon']);
  assert.deepEqual(RUN_ISSUE_STATUSES, [
    'review-ready',
    'not-eligible',
    'blocked',
    'transport-failed',
    'cancelled',
    'internal-error',
  ]);
  assert.deepEqual(Object.values(parsed.github.labels).map((label) => label.name), [
    'agent:auto',
    'agent:running',
    'agent:blocked',
    'agent:review',
  ]);
});

test('V2 rejects Legacy, experimental, removed label, and unknown nested surfaces', () => {
  const rejected = [
    { ...validConfig(), schema: 'codex-orchestrator' },
    { ...validConfig(), schema: 'codex-orchestrator.skill-runtime-v2' },
    { ...validConfig(), workflows: {} },
    { ...validConfig(), auth: { mode: 'package' } },
    { ...validConfig(), skillRuntime: { version: 2 } },
    {
      ...validConfig(),
      github: {
        ...validConfig().github,
        labels: { ...validConfig().github.labels, planAuto: { name: 'plan:auto', color: 'fff', description: 'removed' } },
      },
    },
    { ...validConfig(), runner: { ...validConfig().runner, profile: 'deep' } },
  ];

  for (const value of rejected) assert.throws(() => parseAgentAutoConfig(value));
});

test('V2 rejects invalid integers, non-canonical paths, commands, and empty policy strings', () => {
  const rejected = [
    { ...validConfig(), runner: { ...validConfig().runner, maxCycles: 4 } },
    { ...validConfig(), runner: { ...validConfig().runner, pollIntervalSeconds: 0 } },
    { ...validConfig(), runner: { ...validConfig().runner, workspaceRoot: '../workspaces' } },
    { ...validConfig(), proof: { artifactDir: '/absolute/proofs' } },
    { ...validConfig(), deny: { ...validConfig().deny, readPaths: ['/tmp/../secret'] } },
    { ...validConfig(), deny: { ...validConfig().deny, commands: ['git'] } },
    { ...validConfig(), checks: { '': 'npm test' } },
    { ...validConfig(), checks: { test: '' } },
    { ...validConfig(), codex: { ...validConfig().codex, requiredVersion: 'latest' } },
  ];

  for (const value of rejected) assert.throws(() => parseAgentAutoConfig(value));
});

test('candidate CLI JSON and exit mapping are total over every public runIssue outcome', () => {
  const cases: Array<{ result: RunIssueResult; exit: number }> = [
    { result: { status: 'review-ready', pullRequestUrl: 'https://example.invalid/pr/1', evidencePath: 'evidence/1.json' }, exit: 0 },
    { result: { status: 'not-eligible', reason: 'missing label', evidencePath: 'evidence/2.json' }, exit: 21 },
    { result: { status: 'blocked', kind: 'external', resumable: true, evidencePath: 'evidence/3.json' }, exit: 20 },
    { result: { status: 'blocked', kind: 'safety', resumable: true, evidencePath: 'evidence/4.json' }, exit: 20 },
    { result: { status: 'blocked', kind: 'exhausted', resumable: true, evidencePath: 'evidence/5.json' }, exit: 20 },
    { result: { status: 'transport-failed', resumable: true, evidencePath: 'evidence/6.json' }, exit: 70 },
    { result: { status: 'internal-error', evidencePath: 'evidence/7.json' }, exit: 70 },
    { result: { status: 'cancelled', evidencePath: 'evidence/8.json' }, exit: 130 },
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
