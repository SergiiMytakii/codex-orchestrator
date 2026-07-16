import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { InMemoryGitHubPullRequestAdapter } from '../src/github/pull-requests.js';
import { GitWorktreeManager } from '../src/git/worktree.js';
import { runDaemonCommand } from '../src/runner/daemon-command.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const labels = validConfig.github.labels;
const execFileAsync = promisify(execFile);

async function tempRepo(): Promise<string> {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-daemon-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(join(targetRoot, '.codex-orchestrator', 'config.json'), `${JSON.stringify(validConfig, null, 2)}\n`, 'utf8');
  return targetRoot;
}

async function tempGitRepo(): Promise<string> {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-daemon-git-'));
  await execFileAsync('git', ['init', '-b', 'main', targetRoot]);
  await execFileAsync('git', ['-C', targetRoot, 'config', 'user.name', 'Test User']);
  await execFileAsync('git', ['-C', targetRoot, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(targetRoot, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['-C', targetRoot, 'add', 'README.md']);
  await execFileAsync('git', ['-C', targetRoot, 'commit', '-m', 'Initial']);
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
      'concurrency: 3',
      '[2026-05-08T10:00:00.000Z] no eligible issues',
    ].join('\n'),
  );
});

test('daemon once executes the first eligible issue by policy order', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 3, labels: [labels.planAuto.name, 'priority:high'] }),
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

  assert.deepEqual(executed, [3]);
  assert.deepEqual(result.executed, [3]);
  assert.match(result.output, /running #3 plan-parent/);
  assert.match(result.output, /selection: priority priority:high, tie-breaker issue-number-asc/);
  assert.match(result.output, /completed #3/);
});

test('daemon runs recovery before selection without counting max-runs', async () => {
  const targetRoot = await tempRepo();
  await new RunnerStateStore(targetRoot, validConfig).save({
    version: 1,
    runs: [
      {
        issueNumber: 155,
        mode: 'scoped-issue',
        workspacePath: '.codex-orchestrator/workspaces/issue-155',
        sessionId: 'issue-155-session',
        retryCount: 0,
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z',
        branchName: 'codex/issue-155',
        reportPath: join(targetRoot, 'missing-report.json'),
        host: hostname(),
        ownerPid: 99999999,
        leaseUpdatedAt: '2026-05-08T10:00:00.000Z',
        baseSha: 'base-sha',
      },
    ],
  });
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
    issueFixture({ number: 1, labels: [labels.auto.name] }),
  ]);
  const executed: number[] = [];

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: adapter,
    once: true,
    maxRuns: 1,
    executeIssue: async (issueNumber) => {
      executed.push(issueNumber);
      return { reportComment: 'ok' };
    },
    now: () => new Date('2026-05-08T12:00:00.000Z'),
  });

  assert.deepEqual(executed, [1]);
  assert.deepEqual(result.executed, [1]);
  assert.match(result.output, /recovered #155 blocked/);
  assert.ok(result.output.indexOf('recovered #155 blocked') < result.output.indexOf('running #1 scoped-issue'));
  assert.equal(adapter.postedComments.length, 1);
});

test('daemon selection keeps issue-number ascending as the priority tie-breaker', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 8, labels: [labels.auto.name, 'priority:medium'] }),
    issueFixture({ number: 2, labels: [labels.auto.name, 'priority:medium'] }),
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

  assert.deepEqual(executed, [2]);
  assert.deepEqual(result.executed, [2]);
  assert.match(result.output, /running #2 scoped-issue/);
});

test('daemon rejects invalid direct concurrency options', async () => {
  const targetRoot = await tempRepo();

  await assert.rejects(
    runDaemonCommand({
      targetRoot,
      issueAdapter: new InMemoryGitHubIssueAdapter([]),
      concurrency: 0,
      once: true,
    }),
    /daemon concurrency must be an integer between 1 and 3/,
  );
});

test('daemon can execute disjoint scoped issues concurrently', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 1, labels: [labels.auto.name], body: scopedIssueBody(['src/a.ts']) }),
    issueFixture({ number: 2, labels: [labels.auto.name], body: scopedIssueBody(['src/b.ts']) }),
    issueFixture({ number: 3, labels: [labels.auto.name], body: scopedIssueBody(['src/c.ts']) }),
  ]);
  const started: number[] = [];
  let active = 0;
  let maxActive = 0;

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: adapter,
    concurrency: 3,
    once: true,
    executeIssue: async (issueNumber) => {
      started.push(issueNumber);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const deadline = Date.now() + 100;
      while (started.length < 3 && Date.now() < deadline) {
        await sleep(1);
      }
      active -= 1;
      return { reportComment: 'ok' };
    },
    now: () => new Date('2026-05-08T10:00:00.000Z'),
  });

  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(maxActive, 3);
  assert.deepEqual(result.executed, [1, 2, 3]);
  assert.match(result.output, /running #1 scoped-issue/);
  assert.match(result.output, /running #2 scoped-issue/);
  assert.match(result.output, /running #3 scoped-issue/);
});

test('daemon excludes scoped issues with overlapping ownership from the same concurrent batch', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 1, labels: [labels.auto.name], body: scopedIssueBody(['src/shared.ts']) }),
    issueFixture({ number: 2, labels: [labels.auto.name], body: scopedIssueBody(['src/shared.ts']) }),
    issueFixture({ number: 3, labels: [labels.auto.name], body: scopedIssueBody(['src/other.ts']) }),
  ]);
  const started: number[] = [];

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: adapter,
    concurrency: 3,
    once: true,
    executeIssue: async (issueNumber) => {
      started.push(issueNumber);
      return { reportComment: 'ok' };
    },
    now: () => new Date('2026-05-08T10:00:00.000Z'),
  });

  assert.deepEqual(started, [1, 3]);
  assert.deepEqual(result.executed, [1, 3]);
  assert.doesNotMatch(result.output, /running #2 scoped-issue/);
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

test('daemon removes clean merged worktrees after polling', async () => {
  const targetRoot = await tempGitRepo();
  const worktreePath = join(targetRoot, validConfig.runner.workspaceRoot, 'issue-155');
  const git = new GitWorktreeManager();
  await git.createIssueWorktree({
    targetRoot,
    workspacePath: worktreePath,
    branchName: 'codex/issue-155',
    baseBranch: 'main',
  });
  await writeFile(join(worktreePath, 'feature.txt'), 'done\n', 'utf8');
  await git.commitAll({ worktreePath, message: 'Codex: implement issue #155' });
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  pullRequestAdapter.mergedPullRequests.push({
    number: 7,
    url: 'https://github.com/example/repo/pull/7',
    isDraft: false,
    headRefName: 'codex/issue-155',
    baseRefName: 'main',
  });

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: new InMemoryGitHubIssueAdapter([]),
    pullRequestAdapter,
    once: true,
    executeIssue: async () => ({ reportComment: 'unused' }),
    now: () => new Date('2026-05-08T10:00:00.000Z'),
  });

  await assert.rejects(stat(worktreePath), /ENOENT/);
  assert.match(result.output, /cleaned worktree .*issue-155 for PR #7/);
});

test('daemon removes stale review labels from closed issues with completion evidence', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({
      number: 1132,
      state: 'CLOSED',
      labels: [labels.review.name, labels.auto.name],
      pullRequests: [{ number: 1134, url: 'https://github.com/example/repo/pull/1134', state: 'MERGED' }],
    }),
  ]);

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: adapter,
    once: true,
    executeIssue: async () => ({ reportComment: 'unused' }),
    now: () => new Date('2026-05-08T10:00:00.000Z'),
  });

  assert.deepEqual(adapter.removedLabels, [{ issueNumber: 1132, labels: [labels.review.name] }]);
  assert.match(result.output, /removed stale review label from closed #1132/);
});

test('daemon preserves active and dirty merged worktrees', async () => {
  const targetRoot = await tempGitRepo();
  const activeWorktreePath = join(targetRoot, validConfig.runner.workspaceRoot, 'issue-155');
  const dirtyWorktreePath = join(targetRoot, validConfig.runner.workspaceRoot, 'issue-156');
  const git = new GitWorktreeManager();
  await git.createIssueWorktree({
    targetRoot,
    workspacePath: activeWorktreePath,
    branchName: 'codex/issue-155',
    baseBranch: 'main',
  });
  await git.createIssueWorktree({
    targetRoot,
    workspacePath: dirtyWorktreePath,
    branchName: 'codex/issue-156',
    baseBranch: 'main',
  });
  await writeFile(join(activeWorktreePath, 'feature.txt'), 'done\n', 'utf8');
  await git.commitAll({ worktreePath: activeWorktreePath, message: 'Codex: implement issue #155' });
  await writeFile(join(dirtyWorktreePath, 'dirty.txt'), 'dirty\n', 'utf8');
  await new RunnerStateStore(targetRoot, validConfig).upsertRun({
    issueNumber: 155,
    mode: 'scoped-issue',
    workspacePath: activeWorktreePath,
    sessionId: 'session-155',
    retryCount: 0,
    createdAt: '2026-05-08T10:00:00.000Z',
    updatedAt: '2026-05-08T10:00:00.000Z',
    branchName: 'codex/issue-155',
  });
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  pullRequestAdapter.mergedPullRequests.push(
    {
      number: 7,
      url: 'https://github.com/example/repo/pull/7',
      isDraft: false,
      headRefName: 'codex/issue-155',
      baseRefName: 'main',
    },
    {
      number: 8,
      url: 'https://github.com/example/repo/pull/8',
      isDraft: false,
      headRefName: 'codex/issue-156',
      baseRefName: 'main',
    },
  );

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: new InMemoryGitHubIssueAdapter([]),
    pullRequestAdapter,
    once: true,
    executeIssue: async () => ({ reportComment: 'unused' }),
    now: () => new Date('2026-05-08T10:00:00.000Z'),
  });

  assert.equal((await stat(activeWorktreePath)).isDirectory(), true);
  assert.equal((await stat(dirtyWorktreePath)).isDirectory(), true);
  assert.doesNotMatch(result.output, /cleaned worktree .*issue-155/);
  assert.match(result.output, /skipped dirty worktree .*issue-156/);
});

test('daemon automatically prunes stale runner state for missing workspaces', async () => {
  const targetRoot = await tempGitRepo();
  const existingWorktreePath = join(targetRoot, validConfig.runner.workspaceRoot, 'issue-156');
  const missingWorktreePath = join(targetRoot, validConfig.runner.workspaceRoot, 'issue-155');
  const git = new GitWorktreeManager();
  await git.createIssueWorktree({
    targetRoot,
    workspacePath: existingWorktreePath,
    branchName: 'codex/issue-156',
    baseBranch: 'main',
  });
  await new RunnerStateStore(targetRoot, validConfig).save({
    version: 1,
    runs: [
      {
        issueNumber: 155,
        mode: 'scoped-issue',
        workspacePath: missingWorktreePath,
        sessionId: 'session-155',
        retryCount: 0,
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z',
        branchName: 'codex/issue-155',
      },
      {
        issueNumber: 156,
        mode: 'scoped-issue',
        workspacePath: existingWorktreePath,
        sessionId: 'session-156',
        retryCount: 0,
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z',
        branchName: 'codex/issue-156',
      },
    ],
  });

  const result = await runDaemonCommand({
    targetRoot,
    issueAdapter: new InMemoryGitHubIssueAdapter([]),
    once: true,
    executeIssue: async () => ({ reportComment: 'unused' }),
    now: () => new Date('2026-05-08T10:00:00.000Z'),
  });

  assert.deepEqual(
    (await new RunnerStateStore(targetRoot, validConfig).load()).runs.map((run) => run.issueNumber),
    [156],
  );
  assert.match(result.output, /hygiene pruned 1 stale runner-state run/);
  assert.equal((await stat(existingWorktreePath)).isDirectory(), true);
});

function scopedIssueBody(ownershipScope: string[]): string {
  return [
    'Implement scoped work.',
    '',
    '## codex-orchestrator metadata',
    'Ownership:',
    ...ownershipScope.map((scope) => `- ${scope}`),
  ].join('\n');
}
