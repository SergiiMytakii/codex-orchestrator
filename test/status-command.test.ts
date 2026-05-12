import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
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
      '  - #3 active: GitHub still marks the issue running',
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
