import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import { RunnerLifecycleEventStore } from '../src/runner/lifecycle-events.js';
import { runStatusCommand } from '../src/runner/status-command.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const labels = validConfig.github.labels;

async function tempRepo(): Promise<string> {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-status-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(join(targetRoot, '.codex-orchestrator', 'config.json'), `${JSON.stringify(validConfig, null, 2)}\n`, 'utf8');
  return targetRoot;
}

test('status command returns structured result and ordered output without mutations', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);
  const reportPath = join(targetRoot, 'report.json');
  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'completed',
      changes: ['feature.txt'],
      validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
      proofPlan: {
        mode: 'none',
        reason: 'Status fixture does not claim acceptance proof.',
        validationCommands: [],
        requiredArtifacts: [],
      },
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    }),
    'utf8',
  );
  await store.save({
    version: 1,
    runs: [
      {
        issueNumber: 3,
        mode: 'scoped-issue',
        workspacePath: '.codex-orchestrator/workspaces/3',
        sessionId: 'session-3',
        retryCount: 0,
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z',
        branchName: 'codex/issue-3',
        reportPath,
        host: hostname(),
        ownerPid: 99999999,
        leaseUpdatedAt: '2026-05-08T10:00:00.000Z',
        baseSha: 'base-sha',
      },
    ],
  });
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 1, labels: [labels.auto.name] }),
    issueFixture({ number: 2, labels: [labels.manual.name, labels.auto.name] }),
    issueFixture({ number: 3, labels: [labels.running.name, labels.auto.name] }),
  ]);

  const result = await runStatusCommand({ targetRoot, issueAdapter: adapter, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.eligible.length, 1);
  assert.equal(result.skipped.length, 2);
  assert.equal(result.recovery.length, 1);
  assert.equal(
    result.output,
    [
      'codex-orchestrator status',
      `repo: ${validConfig.github.owner}/${validConfig.github.repo}`,
      `target: ${resolve(targetRoot)}`,
      'mode: dry-run',
      'eligible:',
      '  - #1 scoped-issue: has configured auto label and no blocking state labels',
      'skipped:',
      '  - #2 manual-label: manual label is present',
      '  - #3 already-running: running label is present',
      'recovery:',
      '  - #3 completed-pending-handoff: same-host missing PID with completed report',
    ].join('\n'),
  );
  assert.deepEqual(adapter.addedLabels, []);
  assert.deepEqual(adapter.removedLabels, []);
  assert.deepEqual(adapter.postedComments, []);
  assert.equal((await store.load()).runs[0]?.lastRecoveredAt, undefined);
});

test('status command prints none for empty sections', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubIssueAdapter();

  const result = await runStatusCommand({ targetRoot, issueAdapter: adapter });

  assert.match(result.output, /mode: status/);
  assert.match(result.output, /eligible:\n  - none\nskipped:\n  - none\nrecovery:\n  - none/);
});

test('status command returns stable JSON with active runs and recent lifecycle events', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);
  await store.save({
    version: 1,
    runs: [
      {
        issueNumber: 10,
        mode: 'scoped-issue',
        workspacePath: '.codex-orchestrator/workspaces/10',
        sessionId: 'session-10',
        retryCount: 0,
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
        promptPath: '/repo/prompt.md',
        reportPath: '/repo/report.json',
        logPath: '/repo/run.log',
      },
    ],
  });
  const events = new RunnerLifecycleEventStore(targetRoot, validConfig);
  await events.append({
    timestamp: new Date('2026-05-15T10:00:00.000Z'),
    issueNumber: 10,
    mode: 'scoped-issue',
    sessionId: 'session-10',
    phase: 'scoped-issue',
    status: 'started',
    summary: 'started',
    artifacts: [{ kind: 'snapshot', path: '/repo/snapshot.json' }],
  });
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 10, labels: [labels.running.name, labels.auto.name] }),
    issueFixture({ number: 11, labels: [labels.auto.name] }),
  ]);

  const result = await runStatusCommand({ targetRoot, issueAdapter: adapter, json: true });
  const parsed = JSON.parse(result.output) as Record<string, unknown>;

  assert.equal(parsed.version, 1);
  assert.equal((parsed.repo as Record<string, unknown>).owner, validConfig.github.owner);
  assert.equal(Array.isArray(parsed.eligible), true);
  assert.equal((parsed.eligible as unknown[]).length, 1);
  assert.equal((parsed.activeRuns as Array<Record<string, unknown>>)[0]?.sessionId, 'session-10');
  assert.equal((parsed.recentEvents as Array<Record<string, unknown>>)[0]?.summary, 'started');
  assert.deepEqual(
    ((parsed.recentEvents as Array<Record<string, unknown>>)[0]?.artifacts as Array<Record<string, unknown>>)[0],
    { kind: 'snapshot', path: '/repo/snapshot.json' },
  );
  assert.doesNotMatch(result.output, /raw transcript|secret-token|full comment dump/);
});

test('status command preserves default behavior for configs without local commit policy', async () => {
  const targetRoot = await tempRepo();
  const legacyConfig = {
    ...validConfig,
    runner: {
      workspaceRoot: validConfig.runner.workspaceRoot,
      maxParallelChildren: validConfig.runner.maxParallelChildren,
      stateDir: validConfig.runner.stateDir,
      worktreeCleanup: validConfig.runner.worktreeCleanup,
    },
  };
  await writeFile(join(targetRoot, '.codex-orchestrator', 'config.json'), `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8');
  const adapter = new InMemoryGitHubIssueAdapter([issueFixture({ number: 1, labels: [labels.auto.name] })]);

  const result = await runStatusCommand({ targetRoot, issueAdapter: adapter });

  assert.equal(result.eligible.length, 1);
});

test('status command fails on invalid config', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-status-invalid-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(join(targetRoot, '.codex-orchestrator', 'config.json'), '{"version": 2}\n', 'utf8');

  await assert.rejects(runStatusCommand({ targetRoot, issueAdapter: new InMemoryGitHubIssueAdapter() }), /Invalid config/);
});
