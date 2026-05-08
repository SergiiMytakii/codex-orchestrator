import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { runDaemonCommand } from '../src/runner/daemon-command.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const labels = validConfig.github.labels;

async function tempRepo(): Promise<string> {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-daemon-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(join(targetRoot, '.codex-orchestrator', 'config.json'), `${JSON.stringify(validConfig, null, 2)}\n`, 'utf8');
  return targetRoot;
}

test('daemon once reports no eligible issues without executing work', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 2, labels: [labels.manual.name, labels.auto.name] }),
  ]);
  const executed: number[] = [];

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: adapter,
    once: true,
    executeIssue: async (issueNumber) => {
      executed.push(issueNumber);
      return { reportComment: 'ok' };
    },
    now: () => new Date('2026-05-08T10:00:00.000Z'),
  });

  assert.deepEqual(executed, []);
  assert.deepEqual(result.executed, []);
  assert.equal(result.scanned, 1);
  assert.equal(
    result.output,
    [
      'codex-orchestrator daemon',
      `repo: ${validConfig.github.owner}/${validConfig.github.repo}`,
      `target: ${resolve(targetRoot)}`,
      'intervalMs: 300000',
      '[2026-05-08T10:00:00.000Z] no eligible issues',
    ].join('\n'),
  );
});

test('daemon once executes the first eligible issue by discovery order', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 3, labels: [labels.planAuto.name] }),
    issueFixture({ number: 1, labels: [labels.auto.name] }),
  ]);
  const executed: number[] = [];

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: adapter,
    once: true,
    executeIssue: async (issueNumber) => {
      executed.push(issueNumber);
      return { reportComment: 'ok' };
    },
    now: () => new Date('2026-05-08T10:00:00.000Z'),
  });

  assert.deepEqual(executed, [1]);
  assert.deepEqual(result.executed, [1]);
  assert.match(result.output, /running #1 scoped-issue/);
  assert.match(result.output, /completed #1/);
});

test('daemon keeps polling until maxRuns is reached', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 1, labels: [labels.auto.name] }),
    issueFixture({ number: 2, labels: [labels.planAuto.name] }),
  ]);
  const sleeps: number[] = [];

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: adapter,
    intervalMs: 1000,
    maxRuns: 2,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    executeIssue: async (issueNumber) => {
      await adapter.updateIssue(issueNumber, {
        removeLabels: [labels.auto.name, labels.planAuto.name],
        addLabels: [labels.review.name],
      });
      return { reportComment: 'ok' };
    },
    now: () => new Date('2026-05-08T10:00:00.000Z'),
  });

  assert.deepEqual(result.executed, [1, 2]);
  assert.deepEqual(sleeps, [1000]);
  assert.match(result.output, /running #1 scoped-issue/);
  assert.match(result.output, /running #2 plan-parent/);
});
