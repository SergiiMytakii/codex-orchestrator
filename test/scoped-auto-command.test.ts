import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { CodexCommandRunInput, CodexCommandRunResult } from '../src/codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../src/config/schema.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { InMemoryGitHubPullRequestAdapter } from '../src/github/pull-requests.js';
import type { ShellCommandExecutor } from '../src/process/command.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import { runScopedAutoCommand } from '../src/runner/scoped-auto-command.js';
import { buildProjectConfig } from '../src/setup/project-config.js';
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

test('scoped auto command blocks UI work without visual proof artifacts', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: '[UI] Fix campaign layout', body: 'Requires screenshots at responsive viewports.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
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
          skippedChecks: ['BrowserUse visual verification was not run because no BrowserUse tool is available.'],
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
  assert.match(result.reportComment, /Visual proof gate requires a passed BrowserUse\/Playwright\/screenshot validation line/);
  assert.match(result.reportComment, /Visual proof gate requires at least 1 screenshot artifact/);
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 155, labels: [labels.blocked.name] });
});

test('scoped auto command rejects claimed screenshot artifacts that do not exist', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.auto.name], title: '[UI] Fix campaign layout', body: 'Requires screenshot proof.' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
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
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /Visual proof gate requires a passed BrowserUse\/Playwright\/screenshot validation line/);
  assert.match(result.reportComment, /Visual proof gate requires at least 1 screenshot artifact/);
});

test('scoped auto command can satisfy UI proof gate with runner-owned visual validation command', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    reviewGates: {
      ...config.reviewGates,
      visualProof: {
        ...config.reviewGates.visualProof,
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
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
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
    assert.equal(options?.env?.PLAYWRIGHT_BROWSERS_PATH, join(proofDir, 'ms-playwright'));
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
    assert.match(result.reportComment, /npm run visual-proof -- --issue 155: passed/);
    assert.match(result.reportComment, /!\[screenshot: runner visual proof 390.png\]/);
    assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  } finally {
    if (previousLoginEnv === undefined) {
      delete process.env.CODEX_ORCHESTRATOR_TEST_LOGIN;
    } else {
      process.env.CODEX_ORCHESTRATOR_TEST_LOGIN = previousLoginEnv;
    }
  }
});

test('scoped auto command includes screenshot proof artifacts in review report', async () => {
  const repo = await tempGitProject();
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
