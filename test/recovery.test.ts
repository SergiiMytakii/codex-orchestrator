import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { RunnerStateStore, type RunnerProcessMetadata } from '../src/runner/local-state.js';
import { reconcileRunnerState } from '../src/runner/recovery.js';
import { validConfig } from './fixtures/config.js';
import { commentFixture, issueFixture } from './fixtures/issues.js';

const labels = validConfig.github.labels;
const now = new Date('2026-05-08T12:00:00.000Z');

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-orchestrator-recovery-'));
}

function metadata(issueNumber: number): RunnerProcessMetadata {
  return {
    issueNumber,
    mode: issueNumber === 2 ? 'plan-parent' : 'scoped-issue',
    workspacePath: `.codex-orchestrator/workspaces/${issueNumber}`,
    sessionId: `session-${issueNumber}`,
    retryCount: issueNumber,
    createdAt: '2026-05-08T10:00:00.000Z',
    updatedAt: '2026-05-08T10:30:00.000Z',
  };
}

test('reconciles all recovery statuses without mutating local state in report-only mode', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);
  await store.save({
    version: 1,
    runs: [1, 2, 3, 4, 5, 6].map(metadata),
  });
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 1, labels: [labels.running.name] }),
    issueFixture({ number: 2, labels: [labels.review.name] }),
    issueFixture({ number: 3, labels: [labels.blocked.name] }),
    issueFixture({
      number: 4,
      labels: [labels.blocked.name],
      comments: [
        commentFixture({
          body: 'codex-orchestrator clarification questions for #4',
          createdAt: '2026-05-08T10:00:00.000Z',
        }),
        commentFixture({
          body: 'Answer',
          createdAt: '2026-05-08T11:00:00.000Z',
          authorAssociation: 'OWNER',
        }),
      ],
    }),
    issueFixture({ number: 5, labels: [] }),
  ]);

  const entries = await reconcileRunnerState({
    store,
    issueAdapter: adapter,
    config: validConfig,
    now,
    updateLocalState: false,
  });

  assert.deepEqual(
    entries.map((entry) => [entry.issueNumber, entry.status, entry.reason]),
    [
      [1, 'active', 'GitHub still marks the issue running'],
      [2, 'completed', 'GitHub marks the work completed'],
      [3, 'waiting-for-clarification', 'blocked clarification is waiting for maintainer response'],
      [4, 'clarification-resumable', 'maintainer clarification response detected'],
      [5, 'stale', 'local run exists but GitHub no longer marks it running'],
      [6, 'missing', 'local run has no matching GitHub issue'],
    ],
  );
  assert.equal((await store.load()).runs.some((run) => run.lastRecoveredAt), false);
  assert.deepEqual(adapter.addedLabels, []);
  assert.deepEqual(adapter.removedLabels, []);
});

test('recovery surfaces closed issues that have no completion evidence', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);
  await store.save({
    version: 1,
    runs: [metadata(1), metadata(2), metadata(3)],
  });
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 1, state: 'CLOSED', labels: [] }),
    issueFixture({
      number: 2,
      state: 'CLOSED',
      labels: [],
      comments: [
        commentFixture({
          body: [
            'codex-orchestrator completion evidence',
            '',
            'Implemented as part of: https://github.com/example/repo/issues/10',
            'Validation: parent integration checks passed',
          ].join('\n'),
          createdAt: '2026-05-08T11:00:00.000Z',
        }),
      ],
    }),
    issueFixture({
      number: 3,
      state: 'CLOSED',
      labels: [],
      pullRequests: [{ number: 12, url: 'https://github.com/example/repo/pull/12', state: 'MERGED' }],
    }),
  ]);

  const entries = await reconcileRunnerState({
    store,
    issueAdapter: adapter,
    config: validConfig,
    now,
    updateLocalState: false,
  });

  assert.deepEqual(
    entries.map((entry) => [entry.issueNumber, entry.status, entry.reason]),
    [
      [1, 'closed-missing-evidence', 'GitHub marks the issue closed without completion evidence'],
      [2, 'completed', 'GitHub marks the work completed'],
      [3, 'completed', 'GitHub marks the work completed'],
    ],
  );
});

test('recovery clears clarification only when resume is allowed', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);
  await store.save({ version: 1, runs: [metadata(1)] });
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({
      number: 1,
      labels: [labels.blocked.name],
      comments: [
        commentFixture({
          body: 'codex-orchestrator clarification questions for #1',
          createdAt: '2026-05-08T10:00:00.000Z',
        }),
        commentFixture({
          body: 'Answer',
          createdAt: '2026-05-08T11:00:00.000Z',
          authorAssociation: 'MEMBER',
        }),
      ],
    }),
  ]);

  await reconcileRunnerState({
    store,
    issueAdapter: adapter,
    config: validConfig,
    now,
    allowClarificationResume: true,
    updateLocalState: false,
  });

  assert.deepEqual(adapter.removedLabels, [{ issueNumber: 1, labels: [labels.blocked.name] }]);
  assert.deepEqual(adapter.addedLabels, [{ issueNumber: 1, labels: [labels.running.name] }]);
});

test('updateLocalState only sets lastRecoveredAt and retains completed missing stale runs', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);
  const originalRuns = [metadata(1), metadata(2), metadata(3)];
  await store.save({ version: 1, runs: originalRuns });
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 1, labels: [labels.review.name] }),
    issueFixture({ number: 2, labels: [] }),
  ]);

  await reconcileRunnerState({
    store,
    issueAdapter: adapter,
    config: validConfig,
    now,
    updateLocalState: true,
  });

  const savedRuns = (await store.load()).runs;
  assert.deepEqual(
    savedRuns.map(({ lastRecoveredAt, ...run }) => run),
    originalRuns,
  );
  assert.deepEqual(savedRuns.map((run) => run.lastRecoveredAt), [
    '2026-05-08T12:00:00.000Z',
    '2026-05-08T12:00:00.000Z',
    '2026-05-08T12:00:00.000Z',
  ]);
});
