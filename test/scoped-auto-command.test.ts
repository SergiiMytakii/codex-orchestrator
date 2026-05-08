import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { CodexCommandRunInput, CodexCommandRunResult } from '../src/codex/command-adapter.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { InMemoryGitHubPullRequestAdapter } from '../src/github/pull-requests.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import { runScopedAutoCommand } from '../src/runner/scoped-auto-command.js';
import { buildProjectConfig } from '../src/setup/project-config.js';
import { fallbackWorkflows, validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const execFileAsync = promisify(execFile);
const labels = validConfig.github.labels;
const now = new Date('2026-05-08T12:00:00.000Z');

async function tempGitProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-scoped-'));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  await execFileAsync('git', ['init', '--bare', remote]);
  await execFileAsync('git', ['init', '-b', 'main', repo]);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(repo, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'Initial']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  await execFileAsync('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
  await writeProjectConfig(repo);
  await mkdir(join(repo, '.codex-orchestrator', 'prompts', 'workflows'), { recursive: true });
  await writeFile(
    join(repo, '.codex-orchestrator', 'prompts', 'workflows', 'scoped-implementation.md'),
    'Scoped workflow',
    'utf8',
  );
  return repo;
}

async function writeProjectConfig(repo: string): Promise<void> {
  const config = buildProjectConfig({
    owner: 'example',
    repo: 'repo',
    prepareLabels: 'report-only',
    workflows: fallbackWorkflows,
  });
  await mkdir(join(repo, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(repo, '.codex-orchestrator', 'config.json'),
    `${JSON.stringify({ ...config, checks: { smoke: 'true' } }, null, 2)}\n`,
    'utf8',
  );
}

test('scoped auto command creates worktree, runner commit, draft PR, review report, and cleans state', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], body: 'Implement controlled change' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  let codexInput: CodexCommandRunInput | undefined;
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      codexInput = input;
      await writeFile(join(input.worktreePath, 'feature.txt'), 'done\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['feature.txt'],
          validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  await assert.rejects(stat(join(repo, '.codex-orchestrator', 'workspaces')), /ENOENT/);
  await assert.rejects(stat(join(repo, '.codex-orchestrator', 'state', 'reports')), /ENOENT/);
  await assert.rejects(stat(join(repo, '.codex-orchestrator', 'state', 'codex-home')), /ENOENT/);

  const result = await runScopedAutoCommand({
    targetRoot: repo,
    issueNumber: 155,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    now,
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(result.branchName, 'codex/issue-155');
  assert.equal(await readFile(join(result.worktreePath, 'feature.txt'), 'utf8'), 'done\n');
  assert.equal(codexInput?.promptPath, result.promptPath);
  assert.equal(codexInput?.reportPath, result.reportPath);
  assert.equal(codexInput?.isolatedHomePath, join(repo, '.codex-orchestrator', 'state', 'codex-home', 'issue-155-20260508120000'));
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Closes #155/);
  assert.deepEqual(issueAdapter.removedLabels.at(-1), { issueNumber: 155, labels: [labels.running.name] });
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 155, labels: [labels.review.name] });
  assert.match(issueAdapter.postedComments.at(-1)?.body ?? '', /codex-orchestrator review report for #155/);
  assert.deepEqual((await new RunnerStateStore(repo, validConfig).load()).runs, []);

  const pushed = await execFileAsync('git', ['--git-dir', join(dirname(repo), 'remote.git'), 'log', '--oneline', 'codex/issue-155', '-1']);
  assert.match(pushed.stdout, /Codex: implement issue #155/);
});

test('scoped auto command does not mark blocked after draft PR publication', async () => {
  const repo = await tempGitProject();
  class FailingReviewIssueAdapter extends InMemoryGitHubIssueAdapter {
    public override async addLabels(issueNumber: number, labelsToAdd: string[]): Promise<void> {
      if (labelsToAdd.includes(labels.review.name)) {
        throw new Error('review label failed');
      }
      await super.addLabels(issueNumber, labelsToAdd);
    }
  }
  const issueAdapter = new FailingReviewIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], body: 'Implement controlled change' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await writeFile(join(input.worktreePath, 'feature.txt'), 'done\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['feature.txt'],
          validation: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  await assert.rejects(
    runScopedAutoCommand({
      targetRoot: repo,
      issueNumber: 155,
      issueAdapter,
      pullRequestAdapter,
      codexAdapter,
      now,
    }),
    /failed after draft PR creation/,
  );

  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  assert.equal(issueAdapter.addedLabels.some((entry) => entry.labels.includes(labels.blocked.name)), false);
  assert.equal(issueAdapter.postedComments.some((entry) => entry.body.includes('blocked scoped execution')), false);
});

test('scoped auto command blocks when completion report is missing before PR publication', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([issueFixture({ number: 155, labels: [labels.auto.name] })]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await writeFile(join(input.worktreePath, 'feature.txt'), 'done\n', 'utf8');
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const result = await runScopedAutoCommand({
    targetRoot: repo,
    issueNumber: 155,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /runner cannot prove safety contract/);
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 155, labels: [labels.blocked.name] });
});

test('scoped auto command rejects ineligible manual issue before claim', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name, labels.manual.name] }),
  ]);

  await assert.rejects(
    runScopedAutoCommand({ targetRoot: repo, issueNumber: 155, issueAdapter, now }),
    /manual label is present/,
  );
  assert.deepEqual(issueAdapter.addedLabels, []);
  assert.deepEqual(issueAdapter.postedComments, []);
});
