import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { CodexCommandRunInput, CodexCommandRunResult } from '../src/codex/command-adapter.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { InMemoryGitHubPullRequestAdapter } from '../src/github/pull-requests.js';
import { renderAutonomousChildMarker } from '../src/runner/issue-tree.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import { runPlanAutoCommand } from '../src/runner/plan-auto-command.js';
import type { PlanAutoCompletionReport } from '../src/runner/prompt.js';
import { buildProjectConfig } from '../src/setup/project-config.js';
import { fallbackWorkflows, validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const execFileAsync = promisify(execFile);
const labels = validConfig.github.labels;
const now = new Date('2026-05-08T12:00:00.000Z');

async function tempGitProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-plan-'));
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
  await writeWorkflowPrompts(repo);
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
  await writeFile(join(repo, '.codex-orchestrator', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function writeWorkflowPrompts(repo: string): Promise<void> {
  const dir = join(repo, '.codex-orchestrator', 'prompts', 'workflows');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'prd.md'), 'PRD workflow', 'utf8');
  await writeFile(join(dir, 'issue-breakdown.md'), 'Issue breakdown workflow', 'utf8');
  await writeFile(join(dir, 'breakdown-review.md'), 'Breakdown review workflow', 'utf8');
  await writeFile(join(dir, 'triage.md'), 'Triage workflow', 'utf8');
  await writeFile(join(dir, 'issue-tree-orchestration.md'), 'Issue tree workflow', 'utf8');
}

function completedReport(): PlanAutoCompletionReport {
  return {
    status: 'completed',
    parent: { title: 'Updated parent', body: 'Updated parent body' },
    graph: {
      nodes: [
        {
          stableId: 'child-a',
          title: 'Child A',
          body: 'Child A body',
          afkHitl: 'afk',
          ownershipScope: ['src/a.ts'],
          dependsOn: [],
          verification: ['npm test'],
        },
        {
          stableId: 'child-b',
          title: 'Child B',
          body: 'Child B body',
          afkHitl: 'afk',
          ownershipScope: ['src/b.ts'],
          dependsOn: ['child-a'],
          verification: ['npm test'],
        },
      ],
      edges: [{ from: 'child-a', to: 'child-b', reason: 'B follows A' }],
      specGate: 'wave-level',
    },
    residualRisks: [],
  };
}

function codexAdapterForReport(
  report: PlanAutoCompletionReport,
  onInput?: (input: CodexCommandRunInput) => void,
): { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> } {
  return {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      onInput?.(input);
      if (input.sessionId.startsWith('plan-')) {
        await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      } else {
        await writeFile(join(input.worktreePath, `child-${input.issueNumber}.txt`), 'done\n', 'utf8');
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            changes: [`child-${input.issueNumber}.txt`],
            validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
            skippedChecks: [],
            residualRisks: [],
            prohibitedActions: [],
          }),
          'utf8',
        );
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
}

test('plan-auto command plans parent, executes marked children, and opens one integration draft PR', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  let codexInput: CodexCommandRunInput | undefined;
  const codexAdapter = codexAdapterForReport(completedReport(), (input) => {
    if (input.sessionId.startsWith('plan-')) {
      codexInput = input;
    }
  });

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(result.branchName, 'codex/tree-156');
  assert.equal(result.childIssues.length, 2);
  assert.match(codexInput?.promptText ?? '', /PRD workflow/);
  assert.match(codexInput?.promptText ?? '', /Issue breakdown workflow/);
  assert.match(codexInput?.promptText ?? '', /Breakdown review workflow/);
  assert.match(codexInput?.promptText ?? '', /Triage workflow/);
  assert.deepEqual(issueAdapter.updatedIssues[0]?.issueNumber, 156);
  assert.equal((await issueAdapter.getIssue(156))?.title, 'Updated parent');
  assert.equal(issueAdapter.createdIssues.length, 2);
  assert.deepEqual(issueAdapter.createdIssues[0]?.labels, [labels.child.name]);
  assert.equal(
    issueAdapter.updatedIssues.some((entry) => (
      entry.issueNumber === result.childIssues[0]?.number && entry.input.addLabels?.includes(labels.auto.name)
    )),
    true,
  );
  assert.deepEqual(result.childIssues[0]?.labels.map((label) => label.name), [labels.child.name, labels.auto.name]);
  assert.deepEqual(result.childIssues[1]?.labels.map((label) => label.name), [labels.child.name, labels.auto.name]);
  assert.match(result.childIssues[0]?.body ?? '', /codex-orchestrator:autonomous-child parent=#156/);
  assert.match(result.childIssues[0]?.body ?? '', /Stable ID: child-a/);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Parent issue: #156/);
  assert.match(result.reportComment, /codex-orchestrator issue-tree review report for #156/);
  assert.deepEqual(issueAdapter.removedLabels.at(-1), { issueNumber: 156, labels: [labels.running.name] });
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 156, labels: [labels.review.name] });
  assert.deepEqual((await new RunnerStateStore(repo, validConfig).load()).runs, []);

  const pushed = await execFileAsync('git', ['--git-dir', join(dirname(repo), 'remote.git'), 'log', '--oneline', 'codex/tree-156', '-1']);
  assert.match(pushed.stdout, /Codex: merge issue/);
});

test('plan-auto command updates only existing marked autonomous children', async () => {
  const repo = await tempGitProject();
  const existingChild = issueFixture({
    number: 10,
    labels: [labels.child.name],
    body: `${renderAutonomousChildMarker(156)}\nExisting child`,
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name] }),
    existingChild,
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [{ ...report.graph.nodes[0], issueNumber: 10 }];
  report.graph.edges = [];
  const codexAdapter = codexAdapterForReport(report);

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(issueAdapter.createdIssues.length, 0);
  assert.equal(issueAdapter.updatedIssues.some((entry) => entry.issueNumber === 10), true);
});

test('plan-auto report maps issue numbers by stable id when graph order differs from execution order', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 200, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [report.graph.nodes[1]!, report.graph.nodes[0]!];
  report.graph.edges = [{ from: 'child-a', to: 'child-b', reason: 'B follows A' }];
  const codexAdapter = codexAdapterForReport(report);

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 200,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
  });

  assert.equal(result.status, 'review-ready');
  assert.match(result.reportComment, /#201/);
  assert.match(result.reportComment, /#202/);
  assert.match(result.reportComment, /codex-orchestrator issue-tree review report for #200/);
  assert.doesNotMatch(result.reportComment, /out of scope for #156/);
});

test('plan-auto command blocks before updating arbitrary existing issues', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name] }),
    issueFixture({ number: 10, labels: [], body: 'Parent issue: #156' }),
  ]);
  const report = completedReport();
  report.graph.nodes = [{ ...report.graph.nodes[0], issueNumber: 10 }];
  report.graph.edges = [];
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const result = await runPlanAutoCommand({ targetRoot: repo, issueNumber: 156, issueAdapter, codexAdapter, now });

  assert.equal(result.status, 'blocked');
  assert.equal(issueAdapter.updatedIssues.some((entry) => entry.issueNumber === 10), false);
  assert.match(result.reportComment, /refusing to update arbitrary issue/);
});

test('plan-auto command blocks malformed graphs and worktree file changes before child mutations', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name] }),
  ]);
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await writeFile(
        input.reportPath,
        JSON.stringify({
          ...completedReport(),
          graph: { ...completedReport().graph, nodes: [] },
        }),
        'utf8',
      );
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const result = await runPlanAutoCommand({ targetRoot: repo, issueNumber: 156, issueAdapter, codexAdapter, now });

  assert.equal(result.status, 'blocked');
  assert.equal(issueAdapter.createdIssues.length, 0);
  assert.match(result.reportComment, /graph.nodes must contain at least one child node/);

  const secondRepo = await tempGitProject();
  const secondAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name] }),
  ]);
  const changingCodex = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      await writeFile(join(input.worktreePath, 'changed.txt'), 'change\n', 'utf8');
      await writeFile(input.reportPath, JSON.stringify(completedReport()), 'utf8');
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const changed = await runPlanAutoCommand({
    targetRoot: secondRepo,
    issueNumber: 156,
    issueAdapter: secondAdapter,
    codexAdapter: changingCodex,
    now,
  });

  assert.equal(changed.status, 'blocked');
  assert.equal(secondAdapter.createdIssues.length, 0);
  assert.match(changed.reportComment, /Planning session changed repository files/);
});

test('plan-auto command blocks on child merge conflict without pushing or opening a PR', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 300, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [
    { ...report.graph.nodes[0]!, stableId: 'left', ownershipScope: ['src/left.ts'], dependsOn: [] },
    { ...report.graph.nodes[1]!, stableId: 'right', ownershipScope: ['src/right.ts'], dependsOn: [] },
  ];
  report.graph.edges = [];
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.startsWith('plan-')) {
        await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      } else {
        await writeFile(join(input.worktreePath, 'conflict.txt'), `${input.issueNumber}\n`, 'utf8');
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            changes: ['conflict.txt'],
            validation: [],
            skippedChecks: [],
            residualRisks: [],
            prohibitedActions: [],
          }),
          'utf8',
        );
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 300,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /Merge conflict/);
  assert.equal(
    issueAdapter.addedLabels.some((entry) => entry.issueNumber !== 300 && entry.labels.includes(labels.blocked.name)),
    true,
  );
  assert.deepEqual(
    issueAdapter.addedLabels
      .filter((entry) => entry.issueNumber !== 300 && entry.labels.includes(labels.blocked.name))
      .map((entry) => entry.issueNumber)
      .sort((left, right) => left - right),
    [301, 302],
  );
  assert.equal(
    issueAdapter.addedLabels.some((entry) => entry.issueNumber !== 300 && entry.labels.includes(labels.review.name)),
    false,
  );
  await assert.rejects(
    execFileAsync('git', ['--git-dir', join(dirname(repo), 'remote.git'), 'rev-parse', 'codex/tree-300']),
    /unknown revision|ambiguous argument|Needed a single revision/,
  );
});

test('plan-auto command throws before claim when workflow prompts are missing', async () => {
  const repo = await tempGitProject();
  await unlink(join(repo, '.codex-orchestrator', 'prompts', 'workflows', 'triage.md'));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name] }),
  ]);

  await assert.rejects(
    runPlanAutoCommand({ targetRoot: repo, issueNumber: 156, issueAdapter, now }),
    /Plan-auto workflow prompt not found/,
  );
  await assert.rejects(stat(join(repo, '.codex-orchestrator', 'workspaces')), /ENOENT/);
  assert.deepEqual(issueAdapter.addedLabels, []);
});
