import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { CodexCommandAdapter, type CodexCommandRunInput, type CodexCommandRunResult } from '../src/codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../src/config/schema.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { InMemoryGitHubPullRequestAdapter } from '../src/github/pull-requests.js';
import { GitWorktreeManager } from '../src/git/worktree.js';
import type { ProcessExecutor, ShellCommandExecutor } from '../src/process/command.js';
import { buildScopedPullRequestBody, buildScopedReviewReport } from '../src/runner/handoff-evidence.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import { RunnerLifecycleEventStore } from '../src/runner/lifecycle-events.js';
import { runDoctorCommand } from '../src/runner/doctor-command.js';
import { runScopedAutoCommand } from '../src/runner/scoped-auto-command.js';
import { runStatusCommand } from '../src/runner/status-command.js';
import { sessionCodexHomePath } from '../src/runner/session-home.js';
import { buildProjectConfig } from '../src/setup/project-config.js';
import { InMemoryGitHubLabelAdapter } from '../src/setup/labels.js';
import { fallbackWorkflows, validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const execFileAsync = promisify(execFile);
const labels = validConfig.github.labels;
const now = new Date('2026-05-08T12:00:00.000Z');

async function tempGitProject(configOverride?: (config: CodexOrchestratorConfig) => CodexOrchestratorConfig): Promise<string> {
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
  await writeProjectConfig(repo, configOverride);
  await mkdir(join(repo, '.codex-orchestrator', 'prompts', 'workflows'), { recursive: true });
  await writeFile(
    join(repo, '.codex-orchestrator', 'prompts', 'workflows', 'scoped-implementation.md'),
    'Scoped workflow',
    'utf8',
  );
  return repo;
}

async function writeProjectConfig(
  repo: string,
  configOverride?: (config: CodexOrchestratorConfig) => CodexOrchestratorConfig,
): Promise<void> {
  const config = buildProjectConfig({
    owner: 'example',
    repo: 'repo',
    prepareLabels: 'report-only',
    workflows: fallbackWorkflows,
  });
  const finalConfig = configOverride ? configOverride(config) : config;
  await mkdir(join(repo, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(repo, '.codex-orchestrator', 'config.json'),
    `${JSON.stringify({ ...finalConfig, checks: { smoke: 'true' } }, null, 2)}\n`,
    'utf8',
  );
}

test('scoped handoff evidence renders review report and PR body proof artifacts', () => {
  const evidence = {
    config: { ...validConfig, github: { ...validConfig.github, owner: 'example', repo: 'repo' } },
    branchName: 'codex/issue-155',
    issueNumber: 155,
    changedFiles: ['src/frontend/CampaignList.tsx'],
    validation: [{ command: 'Playwright screenshots', status: 'passed' as const, summary: '390px viewport passed' }],
    artifacts: [{ type: 'screenshot' as const, path: '.codex-orchestrator/proofs/issue-155/390.png', description: '390px layout' }],
    skippedChecks: ['BrowserUse unavailable; runner proof used.'],
    residualRisks: ['None beyond normal review.'],
    logPath: '/tmp/issue-155.log',
    commits: [{ sha: '1234567890abcdef', subject: 'Agent checkpoint' }],
  };

  const report = buildScopedReviewReport({
    ...evidence,
    pullRequestUrl: 'https://github.com/example/repo/pull/155',
  });
  const body = buildScopedPullRequestBody(evidence);

  assert.match(report, /codex-orchestrator review report for #155/);
  assert.match(report, /Pull Request\n- https:\/\/github\.com\/example\/repo\/pull\/155/);
  assert.match(report, /Playwright screenshots: passed - 390px viewport passed/);
  assert.match(report, /!\[screenshot: 390px layout\]\(https:\/\/raw\.githubusercontent\.com\/example\/repo\/codex%2Fissue-155\/\.codex-orchestrator\/proofs\/issue-155\/390\.png\)/);
  assert.match(report, /1234567890ab Agent checkpoint/);
  assert.match(body, /Closes #155/);
  assert.match(body, /Proof artifacts:\n- !\[screenshot: 390px layout\]/);
});

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
      await writeFile(join(input.isolatedHomePath, 'cache-fixture.txt'), 'cache\n', 'utf8');
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
  assert.equal(codexInput?.phase, 'scoped-issue');
  assert.equal(codexInput?.reportPath, result.reportPath);
  assert.equal(codexInput?.isolatedHomePath, sessionCodexHomePath({
    targetRoot: repo,
    sessionId: 'issue-155-20260508120000',
  }));
  assert.ok(codexInput?.isolatedHomePath);
  assert.equal(codexInput.isolatedHomePath.startsWith(repo), false);
  await assert.rejects(stat(codexInput.isolatedHomePath), /ENOENT/);
  await assert.rejects(stat(join(repo, '.codex-orchestrator', 'state', 'codex-home')), /ENOENT/);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Closes #155/);
  assert.deepEqual(issueAdapter.removedLabels.at(-1), { issueNumber: 155, labels: [labels.running.name] });
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 155, labels: [labels.review.name] });
  assert.match(issueAdapter.postedComments.at(-1)?.body ?? '', /codex-orchestrator review report for #155/);
  assert.match(issueAdapter.postedComments.at(-1)?.body ?? '', /Durable Run Summary/);
  const summary = JSON.parse(
    await readFile(
      join(repo, validConfig.runner.stateDir, 'summaries', 'issue-155-issue-155-20260508120000.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal(summary.outcome, 'review-ready');
  assert.deepEqual(summary.policySuggestions, []);
  assert.deepEqual((await new RunnerStateStore(repo, validConfig).load()).runs, []);
  const recentEvents = await new RunnerLifecycleEventStore(repo, validConfig).readRecent();
  assert.equal(recentEvents[0]?.summary, 'Scoped implementation passed runner gates and completed draft PR handoff.');
  assert.equal(recentEvents[0]?.artifacts?.some((artifact) => artifact.kind === 'pr'), true);
  assert.equal(recentEvents.some((event) => event.summary.includes('Starting scoped Codex')), true);
  const snapshotArtifact = recentEvents.flatMap((event) => event.artifacts ?? []).find((artifact) => artifact.kind === 'snapshot');
  assert.ok(snapshotArtifact?.path);
  const snapshot = JSON.parse(await readFile(snapshotArtifact.path, 'utf8')) as Record<string, unknown>;
  assert.equal((snapshot.runner as Record<string, unknown>).phase, 'scoped-issue');
  assert.doesNotMatch(JSON.stringify(snapshot), /GH_TOKEN|raw transcript/);

  const pushed = await execFileAsync('git', ['--git-dir', join(dirname(repo), 'remote.git'), 'log', '--oneline', 'codex/issue-155', '-1']);
  assert.match(pushed.stdout, /Codex: implement issue #155/);
});

test('scoped auto command starts from the resolved remote base instead of stale local main', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    branches: {
      ...config.branches,
      base: { mode: 'explicit', remote: 'origin', branch: 'sirbro-dev' },
    },
  }));
  await writeFile(join(repo, 'local-main-only.txt'), 'wrong base\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'local-main-only.txt']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'Local main only']);
  await execFileAsync('git', ['-C', repo, 'switch', '-c', 'sirbro-dev', 'origin/main']);
  await writeFile(join(repo, 'sirbro-dev.txt'), 'remote base\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'sirbro-dev.txt']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'Remote sirbro dev base']);
  await execFileAsync('git', ['-C', repo, 'push', '-u', 'origin', 'sirbro-dev']);
  await execFileAsync('git', ['-C', repo, 'switch', 'main']);
  const remoteBaseSha = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'origin/sirbro-dev'])).stdout.trim();

  const issueAdapter = new InMemoryGitHubIssueAdapter([
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

  const result = await runScopedAutoCommand({
    targetRoot: repo,
    issueNumber: 155,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    now,
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(pullRequestAdapter.createdPullRequests[0]?.baseBranch, 'sirbro-dev');
  assert.equal(await readFile(join(result.worktreePath, 'sirbro-dev.txt'), 'utf8'), 'remote base\n');
  await assert.rejects(readFile(join(result.worktreePath, 'local-main-only.txt'), 'utf8'), /ENOENT/);
  const isAncestor = await execFileAsync('git', ['-C', repo, 'merge-base', '--is-ancestor', remoteBaseSha, 'codex/issue-155']);
  assert.equal(isAncestor.stdout, '');
  const snapshot = JSON.parse(
    await readFile(join(repo, validConfig.runner.stateDir, 'snapshots', 'issue-155-issue-155-20260508120000.json'), 'utf8'),
  ) as { repository?: { base?: { branch?: string; remote?: string; sha?: string } } };
  assert.deepEqual(snapshot.repository?.base, {
    remote: 'origin',
    branch: 'sirbro-dev',
    ref: 'refs/remotes/origin/sirbro-dev',
    sha: remoteBaseSha,
  });
});

test('diagnostics wave regression covers profile, snapshot, events, status JSON, and doctor', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    codex: {
      ...config.codex,
      profiles: {
        'scoped-issue': {
          command: 'codex-scoped',
          args: ['exec-scoped', '${issueNumber}'],
          timeoutMs: 22_000,
        },
      },
    },
  }));
  const config = JSON.parse(await readFile(join(repo, '.codex-orchestrator', 'config.json'), 'utf8')) as CodexOrchestratorConfig;
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], body: 'Implement diagnostics-backed change' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const executorCalls: Parameters<ProcessExecutor>[] = [];
  const executor: ProcessExecutor = async (...args) => {
    executorCalls.push(args);
    const [, , options] = args;
    assert.equal(options?.cwd?.endsWith('issue-155'), true);
    await writeFile(join(options?.cwd ?? '', 'diagnostics.txt'), 'done\n', 'utf8');
    const reportPath = options?.env?.CODEX_ORCHESTRATOR_REPORT_FILE;
    assert.ok(reportPath);
    await writeFile(
      reportPath,
      JSON.stringify({
        status: 'completed',
        changes: ['diagnostics.txt'],
        validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
        skippedChecks: [],
        residualRisks: [],
        prohibitedActions: [],
      }),
      'utf8',
    );
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  const result = await runScopedAutoCommand({
    targetRoot: repo,
    issueNumber: 155,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter: new CodexCommandAdapter(config, executor),
    now,
  });
  const status = await runStatusCommand({ targetRoot: repo, issueAdapter, json: true });
  const doctor = await runDoctorCommand({
    targetRoot: repo,
    labelAdapter: new InMemoryGitHubLabelAdapter(Object.values(config.github.labels).map((label) => ({ name: label.name }))),
    shellExecutor: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    commandResolver: async () => '/usr/local/bin/tool',
    json: true,
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(executorCalls[0]?.[0], 'codex-scoped');
  assert.deepEqual(executorCalls[0]?.[1], ['exec-scoped', '155']);
  assert.equal(executorCalls[0]?.[2]?.timeoutMs, 22_000);
  const recentEvents = JSON.parse(status.output) as { recentEvents: Array<{ artifacts?: Array<{ kind: string; path?: string }> }> };
  const snapshotPath = recentEvents.recentEvents.flatMap((event) => event.artifacts ?? []).find((artifact) => artifact.kind === 'snapshot')?.path;
  assert.ok(snapshotPath);
  assert.equal(doctor.json.summary.fail, 0);
});

test('scoped auto command publishes validated agent local commits when policy allows', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    runner: {
      ...config.runner,
      allowAgentLocalCommits: true,
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], body: 'Implement controlled committed change' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await writeFile(join(input.worktreePath, 'feature.txt'), 'done\n', 'utf8');
      await execFileAsync('git', ['-C', input.worktreePath, 'add', 'feature.txt']);
      await execFileAsync('git', ['-C', input.worktreePath, 'commit', '-m', 'Agent checkpoint']);
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['feature.txt'],
          validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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

  assert.equal(result.status, 'review-ready');
  assert.match(result.reportComment, /Local Commits/);
  assert.match(result.reportComment, /Agent checkpoint/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Agent checkpoint/);
  const pushed = await execFileAsync('git', ['--git-dir', join(dirname(repo), 'remote.git'), 'log', '--oneline', 'codex/issue-155', '-1']);
  assert.match(pushed.stdout, /Agent checkpoint/);
});

test('scoped auto command resumes an existing dirty same-issue worktree', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const worktreePath = join(repo, validConfig.runner.workspaceRoot, 'issue-155');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-155',
    baseBranch: 'main',
  });
  await writeFile(join(worktreePath, 'existing-proof.txt'), 'already captured\n', 'utf8');
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], body: 'Continue controlled change' }),
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
          changes: ['existing-proof.txt', 'feature.txt'],
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

  const result = await runScopedAutoCommand({
    targetRoot: repo,
    issueNumber: 155,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    now,
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(result.worktreePath, worktreePath);
  assert.equal(codexInput?.worktreePath, worktreePath);
  assert.equal(await readFile(join(worktreePath, 'existing-proof.txt'), 'utf8'), 'already captured\n');
  assert.equal(issueAdapter.postedComments.some((entry) => entry.body.includes('blocked scoped execution')), false);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
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
  assert.match(result.reportComment, /Durable Run Summary/);
  const summary = JSON.parse(
    await readFile(
      join(repo, validConfig.runner.stateDir, 'summaries', 'issue-155-issue-155-20260508120000.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal(summary.outcome, 'blocked');
  assert.match(String((summary.blockers as string[])[0]), /CODEX_ORCHESTRATOR_REPORT_FILE/);
  assert.match(String((summary.policySuggestions as string[])[0]), /Non-mutating recommendation/);
  assert.match(result.reportComment, /policy suggestions: Non-mutating recommendation/);
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 155, labels: [labels.blocked.name] });
});

test('scoped auto command writes durable summary for promotion requests', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([issueFixture({ number: 155, labels: [labels.auto.name] })]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'needs-promotion',
          changes: [],
          validation: [],
          artifacts: [],
          skippedChecks: [],
          residualRisks: ['Needs parent planning.'],
          prohibitedActions: [],
          promotion: {
            reason: 'Touches multiple ownership scopes.',
            criteria: ['multi-service'],
            evidence: ['Issue body names two services.'],
          },
        }),
        'utf8',
      );
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

  assert.equal(result.status, 'promotion-requested');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /Durable Run Summary/);
  const summary = JSON.parse(
    await readFile(
      join(repo, validConfig.runner.stateDir, 'summaries', 'issue-155-issue-155-20260508120000.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal(summary.outcome, 'promotion-requested');
});

test('scoped auto command uses mobile codex timeout for Flutter and Android issues', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    reviewGates: {
      ...config.reviewGates,
      acceptanceProof: { ...config.reviewGates.acceptanceProof, enabled: false },
      visualProof: { ...config.reviewGates.visualProof, enabled: false },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({
      number: 155,
      labels: [labels.auto.name],
      title: 'Flutter refresh after resume',
      body: 'Requires Android emulator proof.',
    }),
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
          validation: [],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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

  assert.equal(result.status, 'review-ready');
  assert.equal(codexInput?.timeoutMs, 3_600_000);
});

test('scoped auto command keeps timeout blocked comments concise', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: 'Fix runtime behavior', body: 'Bug fix.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const hugeTranscript = `${'prompt transcript '.repeat(500)}\nCommand timed out after 1800000ms.\n${'extra output '.repeat(500)}`;
  const codexAdapter = {
    async run(): Promise<CodexCommandRunResult> {
      return { stdout: hugeTranscript, stderr: '', exitCode: 124 };
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
  assert.match(result.reportComment, /Codex exited with code 124: Command timed out after 1800000ms\./);
  assert.equal(result.reportComment.includes('prompt transcript prompt transcript prompt transcript'), false);
  assert.ok(result.reportComment.length < 1_000);
});

test('scoped auto command blocks invalid structured completion output before PR publication', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([issueFixture({ number: 155, labels: [labels.auto.name] })]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await writeFile(join(input.worktreePath, 'feature.txt'), 'done\n', 'utf8');
      await writeFile(input.reportPath, '{not-json', 'utf8');
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
  assert.match(result.reportComment, /Invalid scoped completion report: report must be valid JSON/);
  assert.match(result.reportComment, /Log/);
});

test('scoped auto command blocks publication when a local follow-up phase fails', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([issueFixture({ number: 155, labels: [labels.auto.name] })]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await writeFile(join(input.worktreePath, 'feature.txt'), 'done\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['feature.txt'],
          validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const result = await runScopedAutoCommand({
    targetRoot: repo,
    issueNumber: 155,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    localPhases: ['cleanup-review'],
    localPhaseExecutor: async ({ phaseId }) => ({
      phaseId,
      status: 'failed',
      validation: [{ command: '$cleanup-review', status: 'failed', summary: 'cleanup follow-up needed' }],
      artifacts: [{ type: 'log', path: '/tmp/cleanup-review.log', description: 'cleanup-review log' }],
      residualRisks: ['cleanup follow-up needed'],
    }),
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /Local phase cleanup-review failed/);
  assert.match(result.reportComment, /cleanup follow-up needed/);
  assert.match(result.reportComment, /feature\.txt/);
});

test('scoped auto command blocks runtime changes without strict TDD red-to-green proof', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: 'Fix runtime behavior', body: 'Bug fix.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await mkdir(join(input.worktreePath, 'src'), { recursive: true });
      await writeFile(join(input.worktreePath, 'src', 'feature.ts'), 'export const fixed = true;\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['src/feature.ts'],
          validation: [{ command: 'npm test', status: 'passed', summary: 'all tests passed' }],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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
  assert.match(result.reportComment, /Quality gate requires TDD red-to-green proof/);
});

test('scoped auto command blocks runtime changes without code-review proof', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: 'Fix runtime behavior', body: 'Bug fix.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await mkdir(join(input.worktreePath, 'src'), { recursive: true });
      await mkdir(join(input.worktreePath, 'test'), { recursive: true });
      await writeFile(join(input.worktreePath, 'src', 'feature.ts'), 'export const fixed = true;\n', 'utf8');
      await writeFile(join(input.worktreePath, 'test', 'feature.test.ts'), 'assert.equal(fixed, true);\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['src/feature.ts', 'test/feature.test.ts'],
          validation: [{
            command: 'TDD red-to-green',
            status: 'passed',
            summary: 'Focused behavior test failed before implementation and passed after implementation.',
          }],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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
  assert.match(result.reportComment, /Quality gate requires passed code-review validation/);
});

test('scoped auto command blocks medium runtime changes without cleanup-review proof', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: 'Implement runtime feature', body: 'Feature.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await mkdir(join(input.worktreePath, 'src'), { recursive: true });
      await mkdir(join(input.worktreePath, 'test'), { recursive: true });
      await writeFile(join(input.worktreePath, 'src', 'feature-a.ts'), 'export const a = true;\n', 'utf8');
      await writeFile(join(input.worktreePath, 'src', 'feature-b.ts'), 'export const b = true;\n', 'utf8');
      await writeFile(join(input.worktreePath, 'src', 'feature-c.ts'), 'export const c = true;\n', 'utf8');
      await writeFile(join(input.worktreePath, 'test', 'feature.test.ts'), 'assert.equal(a && b && c, true);\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['src/feature-a.ts', 'src/feature-b.ts', 'src/feature-c.ts', 'test/feature.test.ts'],
          validation: [
            {
              command: 'TDD red-to-green',
              status: 'passed',
              summary: 'Focused behavior test failed before implementation and passed after implementation.',
            },
            { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
          ],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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
  assert.match(result.reportComment, /Quality gate requires passed cleanup-review validation/);
});

test('scoped auto command retries once on retryable blockers and can recover to review-ready', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: 'Fix runtime behavior', body: 'Bug fix.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  let runCount = 0;
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      runCount += 1;
      await mkdir(join(input.worktreePath, 'src'), { recursive: true });
      await mkdir(join(input.worktreePath, 'test'), { recursive: true });
      await writeFile(join(input.worktreePath, 'src', 'feature.ts'), `export const attempt = ${runCount};\n`, 'utf8');
      await writeFile(join(input.worktreePath, 'test', 'feature.test.ts'), 'assert.equal(1, 1);\n', 'utf8');
      const validation = runCount === 1
        ? []
        : [
          {
            command: 'TDD red-to-green',
            status: 'passed',
            summary: 'Focused behavior test failed before implementation and passed after implementation.',
          },
          { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
        ];
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['src/feature.ts', 'test/feature.test.ts'],
          validation,
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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

  assert.equal(runCount, 2);
  assert.equal(result.status, 'review-ready');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 155, labels: [labels.review.name] });
});

test('scoped auto command uses configured rework limit and includes exact blockers in rework prompts', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    loopPolicy: {
      ...config.loopPolicy,
      rework: {
        ...config.loopPolicy.rework,
        maxAttempts: 2,
      },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: 'Fix runtime behavior', body: 'Bug fix.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const promptTexts: string[] = [];
  let runCount = 0;
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      runCount += 1;
      promptTexts.push(input.promptText);
      if (runCount === 3) {
        await mkdir(join(input.worktreePath, 'src'), { recursive: true });
        await mkdir(join(input.worktreePath, 'test'), { recursive: true });
        await writeFile(join(input.worktreePath, 'src', 'feature.ts'), 'export const fixed = true;\n', 'utf8');
        await writeFile(join(input.worktreePath, 'test', 'feature.test.ts'), 'assert.equal(fixed, true);\n', 'utf8');
      }
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: runCount === 3 ? ['src/feature.ts', 'test/feature.test.ts'] : [],
          validation: runCount === 3
            ? [
              {
                command: 'TDD red-to-green',
                status: 'passed',
                summary: 'Focused behavior test failed before implementation and passed after implementation.',
              },
              { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
            ]
            : [],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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

  assert.equal(runCount, 3);
  assert.equal(result.status, 'review-ready');
  assert.match(promptTexts[1] ?? '', /This is an automatic rework attempt \(#1\)/);
  assert.match(promptTexts[1] ?? '', /- Codex completed without file changes/);
  assert.match(promptTexts[2] ?? '', /This is an automatic rework attempt \(#2\)/);
  assert.match(promptTexts[2] ?? '', /- Codex completed without file changes/);
});

test('scoped auto command respects zero configured rework attempts', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    loopPolicy: {
      ...config.loopPolicy,
      rework: {
        ...config.loopPolicy.rework,
        maxAttempts: 0,
      },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: 'Fix runtime behavior', body: 'Bug fix.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  let runCount = 0;
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      runCount += 1;
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: [],
          validation: [],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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

  assert.equal(runCount, 1);
  assert.equal(result.status, 'blocked');
  assert.match(result.reportComment, /Codex completed without file changes/);
});

test('scoped auto command includes advisory fresh-context review evidence before handoff', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    loopPolicy: {
      ...config.loopPolicy,
      freshContextReview: {
        ...config.loopPolicy.freshContextReview,
        enabled: true,
      },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], body: 'Implement controlled change' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const prompts: string[] = [];
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      prompts.push(input.promptText);
      if (input.sessionId.endsWith('-fresh-review')) {
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            findings: [{
              severity: 'advisory',
              confidence: 'medium',
              summary: 'Consider adding one more edge-case test.',
              evidence: 'Changed files include feature.txt only.',
            }],
            residualRisks: ['Review was advisory only.'],
          }),
          'utf8',
        );
        return { stdout: 'review ok', stderr: '', exitCode: 0 };
      }
      await writeFile(join(input.worktreePath, 'feature.txt'), 'done\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['feature.txt'],
          validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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

  assert.equal(result.status, 'review-ready');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? '', /# Fresh-Context Review/);
  assert.doesNotMatch(prompts[1] ?? '', /# Codex Orchestrator Scoped Implementation/);
  assert.match(result.reportComment, /Fresh-Context Review/);
  assert.match(result.reportComment, /advisory medium: Consider adding one more edge-case test\./);
  assert.match(result.reportComment, /Non-mutating recommendation: review Fresh-Context Review evidence/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Fresh-Context Review/);
});

test('scoped auto command blocks draft PR on high-confidence fresh-context policy violation', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    loopPolicy: {
      ...config.loopPolicy,
      freshContextReview: {
        ...config.loopPolicy.freshContextReview,
        enabled: true,
        blockOnHighConfidencePolicyViolations: true,
      },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], body: 'Implement controlled change' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.endsWith('-fresh-review')) {
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            findings: [{
              severity: 'policy-violation',
              confidence: 'high',
              summary: 'Runner-owned publication boundary was crossed.',
              evidence: 'Review found a push command in validation evidence.',
            }],
            residualRisks: [],
          }),
          'utf8',
        );
        return { stdout: 'review found blocker', stderr: '', exitCode: 0 };
      }
      await writeFile(join(input.worktreePath, 'feature.txt'), 'done\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['feature.txt'],
          validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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
  assert.match(result.reportComment, /Fresh-Context Review blocked publication/);
  assert.match(result.reportComment, /policy-violation high: Runner-owned publication boundary was crossed\./);
});

test('scoped auto command records durable evidence when fresh-context review report is invalid', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    loopPolicy: {
      ...config.loopPolicy,
      freshContextReview: {
        ...config.loopPolicy.freshContextReview,
        enabled: true,
      },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], body: 'Implement controlled change' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.endsWith('-fresh-review')) {
        await writeFile(input.reportPath, '{not-json', 'utf8');
        return { stdout: 'review invalid', stderr: '', exitCode: 0 };
      }
      await writeFile(join(input.worktreePath, 'feature.txt'), 'done\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['feature.txt'],
          validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
          artifacts: [],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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
  assert.match(result.reportComment, /Invalid Fresh-Context Review report: report must be valid JSON/);
  assert.match(result.reportComment, /Durable Run Summary/);
  assert.match(result.reportComment, /Non-mutating recommendation/);
});

test('scoped auto command proves configured loop path end to end without live services', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    loopPolicy: {
      ...config.loopPolicy,
      rework: { ...config.loopPolicy.rework, maxAttempts: 1 },
      freshContextReview: { ...config.loopPolicy.freshContextReview, enabled: true },
      durableRunSummaries: { enabled: true },
      policySuggestions: { enabled: true, maxSuggestions: 3 },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: 'Fix runtime behavior', body: 'Bug fix.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  let implementationRuns = 0;
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.endsWith('-fresh-review')) {
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            findings: [{
              severity: 'advisory',
              confidence: 'medium',
              summary: 'Review evidence is sufficient with a small follow-up suggestion.',
              evidence: 'Validation and changed files were present.',
            }],
            residualRisks: [],
          }),
          'utf8',
        );
        return { stdout: 'review ok', stderr: '', exitCode: 0 };
      }
      implementationRuns += 1;
      await mkdir(join(input.worktreePath, 'src'), { recursive: true });
      await mkdir(join(input.worktreePath, 'test'), { recursive: true });
      if (implementationRuns === 2) {
        await writeFile(join(input.worktreePath, 'src', 'feature.ts'), 'export const fixed = true;\n', 'utf8');
        await writeFile(join(input.worktreePath, 'test', 'feature.test.ts'), 'assert.equal(fixed, true);\n', 'utf8');
      }
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: implementationRuns === 2 ? ['src/feature.ts', 'test/feature.test.ts'] : [],
          validation: implementationRuns === 2
            ? [
              {
                command: 'TDD red-to-green',
                status: 'passed',
                summary: 'Focused behavior test failed before implementation and passed after implementation.',
              },
              { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
            ]
            : [],
          artifacts: [],
          skippedChecks: ['Optional benchmark not run.'],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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

  assert.equal(result.status, 'review-ready');
  assert.equal(implementationRuns, 2);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  assert.match(result.reportComment, /Fresh-Context Review/);
  assert.match(result.reportComment, /Durable Run Summary/);
  assert.match(result.reportComment, /Non-mutating recommendation/);
});

test('scoped auto command no longer blocks on missing UI visual proof (but can still block on quality gate)', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: '[UI] Fix campaign layout', body: 'Requires screenshots at responsive viewports.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const shellExecutor: ShellCommandExecutor = async (command) => {
    if (command === 'true') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'missing proof script', exitCode: 1 };
  };
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await mkdir(join(input.worktreePath, 'src', 'frontend'), { recursive: true });
      await writeFile(join(input.worktreePath, 'src', 'frontend', 'CampaignList.tsx'), 'export const x = 1;\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['src/frontend/CampaignList.tsx'],
          validation: [{ command: 'Playwright screenshots', status: 'skipped', summary: 'browser launch failed' }],
          artifacts: [],
          skippedChecks: ['Visual proof was not produced in the child session.'],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const result = await runScopedAutoCommand({
    targetRoot: repo,
    issueNumber: 155,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor,
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /runner acceptance proof failed: missing proof script/);
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 155, labels: [labels.blocked.name] });
});

test('scoped auto command does not add visual proof gate blockers for missing screenshot artifacts', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: '[UI] Fix campaign layout', body: 'Requires screenshot proof.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const shellExecutor: ShellCommandExecutor = async (command) => {
    if (command === 'true') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'missing proof script', exitCode: 1 };
  };
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await mkdir(join(input.worktreePath, 'src', 'frontend'), { recursive: true });
      await mkdir(join(input.worktreePath, '.codex-orchestrator', 'proofs', 'issue-155'), { recursive: true });
      await writeFile(join(input.worktreePath, 'src', 'frontend', 'CampaignList.tsx'), 'export const x = 1;\n', 'utf8');
      await writeFile(join(input.worktreePath, '.codex-orchestrator', 'proofs', 'issue-155', 'visual-proof.mjs'), 'console.log("syntax only");\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['src/frontend/CampaignList.tsx'],
          validation: [{ command: 'node --check .codex-orchestrator/proofs/issue-155/visual-proof.mjs', status: 'passed', summary: 'Visual proof script syntax is valid.' }],
          artifacts: [{ type: 'screenshot', path: '.codex-orchestrator/proofs/issue-155/missing.png', description: 'Expected screenshot output' }],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const result = await runScopedAutoCommand({
    targetRoot: repo,
    issueNumber: 155,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor,
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /runner acceptance proof failed: missing proof script/);
});

test('scoped auto command can satisfy UI proof gate with runner-owned visual validation command', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    reviewGates: {
      ...config.reviewGates,
      quality: {
        ...config.reviewGates.quality,
        runtimeChangedPathGlobs: ['src/frontend/**/*.tsx'],
        testChangedPathGlobs: ['test/**/*.test.ts'],
        cleanupReview: {
          ...config.reviewGates.quality.cleanupReview,
          runtimeFileThreshold: 5,
        },
      },
      visualProof: {
        ...config.reviewGates.visualProof,
        artifactDir: '.proofs',
        runnerValidationCommand: 'npm run visual-proof -- --issue ${issueNumber}',
        runnerTimeoutMs: 1_234,
        envPassthrough: ['CODEX_ORCHESTRATOR_TEST_LOGIN'],
      },
    },
  }));
  const previousLoginEnv = process.env.CODEX_ORCHESTRATOR_TEST_LOGIN;
  process.env.CODEX_ORCHESTRATOR_TEST_LOGIN = 'login-fixture';
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: '[UI] Fix campaign layout', body: 'Requires responsive screenshots.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  let promptText = '';
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      promptText = input.promptText;
      await mkdir(join(input.worktreePath, 'src', 'frontend'), { recursive: true });
      await mkdir(join(input.worktreePath, 'test'), { recursive: true });
      await writeFile(join(input.worktreePath, 'src', 'frontend', 'CampaignList.tsx'), 'export const x = 1;\n', 'utf8');
      await writeFile(join(input.worktreePath, 'test', 'CampaignList.test.ts'), 'assert.equal(x, 1);\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['src/frontend/CampaignList.tsx', 'test/CampaignList.test.ts'],
          validation: [
            {
              command: 'TDD red-to-green',
              status: 'passed',
              summary: 'Focused behavior test failed before implementation and passed after implementation.',
            },
            { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
            { command: 'BrowserUse visual verification', status: 'skipped', summary: 'tool unavailable' },
          ],
          artifacts: [],
          skippedChecks: ['BrowserUse visual verification was not run because no BrowserUse tool is available.'],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const shellExecutor: ShellCommandExecutor = async (command, options) => {
    if (command === 'true') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    assert.equal(command, 'npm run visual-proof -- --issue 155');
    assert.equal(options?.cwd, join(repo, '.codex-orchestrator', 'workspaces', 'issue-155'));
    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_ISSUE_NUMBER, '155');
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_TEST_LOGIN, 'login-fixture');
    assert.equal(options?.timeoutMs, 1_234);
    assert.ok(proofDir);
    const profileDir = options?.env?.CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR;
    const browsersDir = options?.env?.PLAYWRIGHT_BROWSERS_PATH;
    assert.ok(profileDir);
    assert.ok(browsersDir);
    assert.equal(profileDir.startsWith(proofDir), false);
    assert.equal(browsersDir.startsWith(proofDir), false);
    await writeFile(join(proofDir, '390.png'), 'png-fixture\n', 'utf8');
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  try {
    const result = await runScopedAutoCommand({
      targetRoot: repo,
      issueNumber: 155,
      issueAdapter,
      pullRequestAdapter,
      codexAdapter,
      shellExecutor,
      now,
    });

    assert.equal(result.status, 'review-ready');
    assert.match(promptText, /Runtime files are detected with these globs: src\/frontend\/\*\*\/\*\.tsx\./);
    assert.match(promptText, /Test files are detected with these globs: test\/\*\*\/\*\.test\.ts\./);
    assert.match(promptText, /touches at least 5 runtime files/);
    assert.match(promptText, /npm run visual-proof -- --issue \$\{issueNumber\}/);
    assert.match(promptText, /CODEX_ORCHESTRATOR_TEST_LOGIN/);
    assert.match(result.reportComment, /npm run visual-proof -- --issue 155: passed/);
    assert.match(result.reportComment, /!\[screenshot: runner visual proof 390.png\]/);
    assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
    assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Proof artifacts:\n- !\[screenshot: runner visual proof 390\.png\]/);
  } finally {
    if (previousLoginEnv === undefined) {
      delete process.env.CODEX_ORCHESTRATOR_TEST_LOGIN;
    } else {
      process.env.CODEX_ORCHESTRATOR_TEST_LOGIN = previousLoginEnv;
    }
  }
});

test('scoped auto command includes screenshot proof artifacts in review report', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    reviewGates: {
      ...config.reviewGates,
      acceptanceProof: { ...config.reviewGates.acceptanceProof, enabled: false },
      visualProof: { ...config.reviewGates.visualProof, enabled: false },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: '[UI] Fix campaign layout', body: 'Requires screenshot proof.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const proofPath = '.codex-orchestrator/proofs/issue-155/390.png';
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await mkdir(join(input.worktreePath, 'src', 'frontend'), { recursive: true });
      await mkdir(join(input.worktreePath, 'test'), { recursive: true });
      await mkdir(join(input.worktreePath, '.codex-orchestrator', 'proofs', 'issue-155'), { recursive: true });
      await writeFile(join(input.worktreePath, 'src', 'frontend', 'CampaignList.tsx'), 'export const x = 1;\n', 'utf8');
      await writeFile(join(input.worktreePath, 'test', 'CampaignList.test.ts'), 'assert.equal(x, 1);\n', 'utf8');
      await writeFile(join(input.worktreePath, proofPath), 'png-fixture\n', 'utf8');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          changes: ['src/frontend/CampaignList.tsx', 'test/CampaignList.test.ts'],
          validation: [
            {
              command: 'TDD red-to-green',
              status: 'passed',
              summary: 'Focused behavior test failed before implementation and passed after implementation.',
            },
            { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
            { command: 'Playwright screenshots', status: 'passed', summary: '390px viewport has no overlap' },
          ],
          artifacts: [{ type: 'screenshot', path: proofPath, description: '390px campaign layout' }],
          skippedChecks: [],
          residualRisks: [],
          prohibitedActions: [],
        }),
        'utf8',
      );
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

  assert.equal(result.status, 'review-ready');
  assert.match(result.reportComment, /Proof Artifacts/);
  assert.match(result.reportComment, /!\[screenshot: 390px campaign layout\]/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Proof artifacts/);
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
