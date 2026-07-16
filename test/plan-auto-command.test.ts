import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { CodexCommandRunInput, CodexCommandRunResult } from '../src/codex/command-adapter.js';
import type { CodexOrchestratorConfig } from '../src/config/schema.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { InMemoryGitHubPullRequestAdapter } from '../src/github/pull-requests.js';
import { GitWorktreeManager } from '../src/git/worktree.js';
import type { CreateDraftPullRequestInput, GitHubPullRequest } from '../src/github/pull-requests.js';
import { renderAutonomousChildMarker } from '../src/runner/issue-tree.js';
import { RunnerLifecycleEventStore } from '../src/runner/lifecycle-events.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import { SCOPED_RECOVERY_LEASE_STALE_MS } from '../src/runner/scoped-recovery.js';
import { runPlanAutoCommand } from '../src/runner/plan-auto-command.js';
import type { PlanAutoCompletionReport } from '../src/runner/completion-report.js';
import { buildProjectConfig } from '../src/setup/project-config.js';
import { fallbackWorkflows, validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const execFileAsync = promisify(execFile);
const labels = validConfig.github.labels;
const now = new Date('2026-05-08T12:00:00.000Z');

test('plan auto command delegates handoff evidence rendering to runner evidence module', async () => {
  const source = await readFile('src/runner/plan-auto-command.ts', 'utf8');

  assert.doesNotMatch(source, /function buildChildReviewReport/);
  assert.doesNotMatch(source, /function buildIssueTreeReviewReport/);
  assert.doesNotMatch(source, /function buildIssueTreePullRequestBody/);
  assert.doesNotMatch(source, /function renderProofArtifacts/);
  assert.match(source, /from '\.\/handoff-evidence\.js'/);
});

async function tempGitProject(configOverride?: (config: CodexOrchestratorConfig) => CodexOrchestratorConfig): Promise<string> {
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
  await writeProjectConfig(repo, configOverride);
  await writeWorkflowPrompts(repo);
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
  await mkdir(join(repo, '.codex-orchestrator'), { recursive: true });
  const finalConfig = configOverride ? configOverride(config) : config;
  await writeFile(join(repo, '.codex-orchestrator', 'config.json'), `${JSON.stringify(finalConfig, null, 2)}\n`, 'utf8');
}

async function writeWorkflowPrompts(repo: string): Promise<void> {
  const dir = join(repo, '.codex-orchestrator', 'prompts', 'workflows');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'prd.md'), 'PRD workflow', 'utf8');
  await writeFile(join(dir, 'issue-breakdown.md'), 'Issue breakdown workflow', 'utf8');
  await writeFile(join(dir, 'breakdown-review.md'), 'Breakdown review workflow', 'utf8');
  await writeFile(join(dir, 'triage.md'), 'Triage workflow', 'utf8');
  await writeFile(join(dir, 'issue-tree-orchestration.md'), 'Issue tree workflow', 'utf8');
  await writeFile(join(dir, 'acceptance-proof.md'), 'Adaptive proof workflow', 'utf8');
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
          ownershipScope: ['child-a.txt'],
          dependsOn: [],
          verification: ['npm test'],
        },
        {
          stableId: 'child-b',
          title: 'Child B',
          body: 'Child B body',
          afkHitl: 'afk',
          ownershipScope: ['child-b.txt'],
          dependsOn: ['child-a'],
          verification: ['npm test'],
        },
      ],
      edges: [{ from: 'child-a', to: 'child-b', reason: 'B follows A' }],
      specGate: 'wave-level',
    },
    sizeRisk: {
      small: ['child-a'],
      medium: ['child-b'],
      high: [],
    },
    parentReviewHandoff: {
      risks: ['Child B depends on Child A integration ordering.'],
      proofStrategy: ['Run final configured checks after merging child branches.'],
      humanReviewFocus: ['Inspect parent integration diff and child dependency order.'],
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
        const changedPath = await writeChildOwnedChange(input);
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            changes: [changedPath],
            validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
            proofPlan: {
              mode: 'none',
              reason: 'Plan-auto child fixture does not claim acceptance proof.',
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
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
}

async function writeChildOwnedChange(input: CodexCommandRunInput, content = 'done\n'): Promise<string> {
  const changedPath = await childOwnedPath(input);
  await mkdir(dirname(join(input.worktreePath, changedPath)), { recursive: true });
  await writeFile(join(input.worktreePath, changedPath), content, 'utf8');
  return changedPath;
}

async function childOwnedPath(input: CodexCommandRunInput): Promise<string> {
  const artifact = JSON.parse(await readFile(input.contextArtifactPath, 'utf8')) as {
    context?: { childMetadata?: { ownershipScope?: string[] } };
  };
  const ownership = artifact.context?.childMetadata?.ownershipScope?.[0];
  if (!ownership) {
    return `child-${input.issueNumber}.txt`;
  }
  const normalized = ownership.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalized.endsWith('/**')) {
    return `${normalized.slice(0, -3)}/child-${input.issueNumber}.txt`;
  }
  if (normalized.includes('*')) {
    return normalized.replace(/\*+/gu, String(input.issueNumber));
  }
  return normalized;
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
  assert.equal(codexInput?.operationId, 'plan-parent');
  assert.equal(codexInput?.nodeId, 'to-spec');
  assert.match(await readFile(codexInput!.contextArtifactPath, 'utf8'), /"parentIssue"/);
  assert.deepEqual(issueAdapter.updatedIssues[0]?.issueNumber, 156);
  assert.equal((await issueAdapter.getIssue(156))?.title, 'Updated parent');
  assert.equal(issueAdapter.createdIssues.length, 2);
  assert.deepEqual(issueAdapter.createdIssues[0]?.labels, [labels.child.name]);
  assert.equal(
    issueAdapter.updatedIssues.some((entry) => (
      entry.issueNumber === result.childIssues[0]?.number && entry.input.addLabels?.includes(labels.auto.name)
    )),
    false,
  );
  assert.deepEqual(result.childIssues[0]?.labels.map((label) => label.name), [labels.child.name]);
  assert.deepEqual(result.childIssues[1]?.labels.map((label) => label.name), [labels.child.name]);
  assert.match(result.childIssues[0]?.body ?? '', /codex-orchestrator:autonomous-child parent=#156/);
  assert.match(result.childIssues[0]?.body ?? '', /Stable ID: child-a/);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Parent issue: #156/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Planning risk\/proof:/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Child B depends on Child A integration ordering/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /size\/risk: small=child-a; medium=child-b; high=none/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Proof artifacts:[\s\S]*#157 none/);
  assert.match(result.reportComment, /codex-orchestrator issue-tree review report for #156/);
  assert.match(result.reportComment, /Planning Risk\/Proof/);
  assert.match(result.reportComment, /Inspect parent integration diff and child dependency order/);
  assert.match(result.reportComment, /Proof Artifacts[\s\S]*#157 none/);
  assert.match(result.reportComment, /Child Loop Outcomes[\s\S]*#157: outcome: review-ready/);
  assert.match(
    [...issueAdapter.postedComments].reverse().find((entry) => entry.issueNumber === 157)?.body ?? '',
    /Durable Run Summary/,
  );
  const childSummary = JSON.parse(
    await readFile(
      join(repo, validConfig.runner.stateDir, 'summaries', 'issue-157-tree-156-issue-157-20260508120000.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal(childSummary.outcome, 'review-ready');
  assert.deepEqual(issueAdapter.removedLabels.at(-1), { issueNumber: 156, labels: [labels.running.name] });
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 156, labels: [labels.review.name] });
  assert.deepEqual((await new RunnerStateStore(repo, validConfig).load()).runs, []);
  const recentEvents = await new RunnerLifecycleEventStore(repo, validConfig).readRecent();
  assert.equal(recentEvents[0]?.summary, 'Issue-tree execution completed draft PR handoff.');
  assert.equal(recentEvents[0]?.artifacts?.some((artifact) => artifact.kind === 'pr'), true);
  assert.equal(recentEvents.some((event) => event.mode === 'tree-child' && event.artifacts?.some((artifact) => artifact.kind === 'snapshot')), true);

  const pushed = await execFileAsync('git', ['--git-dir', join(dirname(repo), 'remote.git'), 'log', '--oneline', 'codex/tree-156', '-1']);
  assert.match(pushed.stdout, /Codex: merge issue/);
});

test('plan-auto command resumes a clean stale parent worktree before creating a new one', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const parentWorktree = join(repo, '.codex-orchestrator', 'workspaces', 'tree-156');
  const baseSha = await git.getHead(repo);
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: parentWorktree,
    branchName: 'codex/tree-156',
    baseBranch: 'main',
  });
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [{
      issueNumber: 156,
      mode: 'plan-parent',
      workspacePath: parentWorktree,
      sessionId: 'plan-156-stale',
      retryCount: 0,
      createdAt: '2026-05-08T10:00:00.000Z',
      updatedAt: '2026-05-08T10:00:00.000Z',
      branchName: 'codex/tree-156',
      reportPath: join(repo, '.codex-orchestrator', 'state', 'reports', 'issue-156-plan-156-stale.json'),
      logPath: join(repo, '.codex-orchestrator', 'state', 'logs', 'issue-156-plan-156-stale.log'),
      host: 'local-host',
      ownerPid: 99999999,
      leaseUpdatedAt: new Date(now.getTime() - SCOPED_RECOVERY_LEASE_STALE_MS).toISOString(),
      baseSha,
    }],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name, labels.running.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [report.graph.nodes[0]!];
  report.graph.edges = [];

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter: codexAdapterForReport(report),
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
    hostname: () => 'local-host',
    processProbe: () => 'missing',
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(result.worktreePath, parentWorktree);
  assert.equal(
    issueAdapter.addedLabels.some((entry) => entry.issueNumber === 156 && entry.labels.includes(labels.blocked.name)),
    false,
  );
  const parentTreeWorktrees = (await git.listWorktrees(repo)).filter((worktree) => worktree.branch === 'refs/heads/codex/tree-156');
  assert.equal(parentTreeWorktrees.length, 1);
});

test('plan-auto parent recovery bypass does not override child-label eligibility', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name, labels.running.name, labels.child.name], body: 'Not a parent' }),
  ]);

  await assert.rejects(
    runPlanAutoCommand({
      targetRoot: repo,
      issueNumber: 156,
      issueAdapter,
      pullRequestAdapter: new InMemoryGitHubPullRequestAdapter('example', 'repo'),
      codexAdapter: codexAdapterForReport(completedReport()),
      shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      now,
    }),
    /not eligible for agent:plan-auto planning: running label is present/,
  );
  assert.equal(issueAdapter.addedLabels.some((entry) => entry.labels.includes(labels.blocked.name)), false);
});

test('plan-auto command recovers a closed successful child already merged into the parent tree', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const parentWorktree = join(repo, '.codex-orchestrator', 'workspaces', 'tree-156');
  const childWorktree = join(repo, '.codex-orchestrator', 'workspaces', 'tree-156-issue-157');
  const baseSha = await git.getHead(repo);
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: parentWorktree,
    branchName: 'codex/tree-156',
    baseBranch: 'main',
  });
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: childWorktree,
    branchName: 'codex/tree-156-issue-157',
    baseBranch: 'codex/tree-156',
  });
  await writeFile(join(childWorktree, 'child-a.txt'), 'already done\n', 'utf8');
  await git.commitAll({ worktreePath: childWorktree, message: 'Codex: implement issue #157 for parent #156' });
  await git.mergeBranch({
    worktreePath: parentWorktree,
    branchName: 'codex/tree-156-issue-157',
    message: 'Codex: merge issue #157 into parent #156',
  });
  const childSessionId = 'tree-156-issue-157-stale';
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [
      {
        issueNumber: 156,
        mode: 'plan-parent',
        workspacePath: parentWorktree,
        sessionId: 'plan-156-stale',
        retryCount: 0,
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z',
        branchName: 'codex/tree-156',
        reportPath: join(repo, '.codex-orchestrator', 'state', 'reports', 'issue-156-plan-156-stale.json'),
        logPath: join(repo, '.codex-orchestrator', 'state', 'logs', 'issue-156-plan-156-stale.log'),
        host: 'local-host',
        ownerPid: 99999999,
        leaseUpdatedAt: new Date(now.getTime() - SCOPED_RECOVERY_LEASE_STALE_MS).toISOString(),
        baseSha,
      },
      {
        issueNumber: 157,
        parentIssueNumber: 156,
        mode: 'tree-child',
        workspacePath: childWorktree,
        sessionId: childSessionId,
        retryCount: 0,
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z',
        branchName: 'codex/tree-156-issue-157',
      },
    ],
  });
  const summaryPath = join(repo, validConfig.runner.stateDir, 'summaries', `issue-157-${childSessionId}.json`);
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, JSON.stringify({
    issueNumber: 157,
    sessionId: childSessionId,
    outcome: 'review-ready',
    changedFiles: ['child-a.txt'],
    confirmedFacts: ['1 changed file(s) detected'],
    validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
            proofPlan: {
              mode: 'none',
              reason: 'Plan-auto child fixture does not claim acceptance proof.',
              validationCommands: [],
              requiredArtifacts: [],
            },
    blockers: [],
    skippedChecks: [],
    residualRisks: [],
    policySuggestions: [],
    nextAction: 'Parent issue-tree integration should merge this child branch.',
    evidence: {
      reportPath: join(repo, 'reports', 'child-157.json'),
      logPath: join(repo, 'logs', 'child-157.log'),
    },
  }), 'utf8');
  const report = completedReport();
  report.graph.nodes = [{ ...report.graph.nodes[0]!, issueNumber: 157 }];
  report.graph.edges = [];
  let childRuns = 0;
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.startsWith('plan-')) {
        await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      }
      childRuns += 1;
      throw new Error('recovered child should not execute');
    },
  };
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name, labels.running.name], body: 'Plan parent' }),
    issueFixture({
      number: 157,
      state: 'CLOSED',
      labels: [labels.child.name],
      body: `${renderAutonomousChildMarker(156)}\nChild A body\n\n## codex-orchestrator metadata\nStable ID: child-a\nAFK/HITL: afk\nDepends on: none\nOwnership:\n- child-a.txt\nSpec gate: wave-level\nVerification:\n- npm test`,
    }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
    hostname: () => 'local-host',
    processProbe: () => 'missing',
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(childRuns, 0);
  assert.match(result.reportComment, /#157 recovered/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /recovered from durable summary/);
  assert.deepEqual(issueAdapter.createdIssues, []);
});

test('plan-auto command resumes retryable blocked child rework from existing tree-child state', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const parentWorktree = join(repo, '.codex-orchestrator', 'workspaces', 'tree-156');
  const childWorktree = join(repo, '.codex-orchestrator', 'workspaces', 'tree-156-issue-157');
  const baseSha = await git.getHead(repo);
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: parentWorktree,
    branchName: 'codex/tree-156',
    baseBranch: 'main',
  });
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: childWorktree,
    branchName: 'codex/tree-156-issue-157',
    baseBranch: 'codex/tree-156',
  });
  const childSessionId = 'tree-156-issue-157-blocked';
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [
      {
        issueNumber: 156,
        mode: 'plan-parent',
        workspacePath: parentWorktree,
        sessionId: 'plan-156-stale',
        retryCount: 0,
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z',
        branchName: 'codex/tree-156',
        host: 'local-host',
        ownerPid: 99999999,
        leaseUpdatedAt: new Date(now.getTime() - SCOPED_RECOVERY_LEASE_STALE_MS).toISOString(),
        baseSha,
      },
      {
        issueNumber: 157,
        parentIssueNumber: 156,
        mode: 'tree-child',
        workspacePath: childWorktree,
        sessionId: childSessionId,
        retryCount: 0,
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z',
        branchName: 'codex/tree-156-issue-157',
      },
    ],
  });
  const summaryPath = join(repo, validConfig.runner.stateDir, 'summaries', `issue-157-${childSessionId}.json`);
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, JSON.stringify({
    issueNumber: 157,
    sessionId: childSessionId,
    outcome: 'blocked',
    changedFiles: [],
    confirmedFacts: ['1 blocker(s) recorded'],
    validation: [],
            proofPlan: {
              mode: 'none',
              reason: 'Plan-auto child fixture intentionally has no proof evidence.',
              validationCommands: [],
              requiredArtifacts: [],
            },
    blockers: ['Codex completed without file changes'],
    skippedChecks: [],
    residualRisks: [],
    policySuggestions: [],
    nextAction: 'Retry the child with runner rework.',
    evidence: {
      reportPath: join(repo, 'reports', 'child-157.json'),
      logPath: join(repo, 'logs', 'child-157.log'),
    },
  }), 'utf8');
  const report = completedReport();
  report.graph.nodes = [{ ...report.graph.nodes[0]!, issueNumber: 157 }];
  report.graph.edges = [];
  let reworkContext = '';
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.startsWith('plan-')) {
        await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      } else {
        reworkContext = await readFile(input.contextArtifactPath, 'utf8');
        const changedPath = await writeChildOwnedChange(input);
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            changes: [changedPath],
            validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
            proofPlan: {
              mode: 'none',
              reason: 'Plan-auto child fixture does not claim acceptance proof.',
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
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name, labels.running.name], body: 'Plan parent' }),
    issueFixture({
      number: 157,
      labels: [labels.child.name, labels.blocked.name],
      body: `${renderAutonomousChildMarker(156)}\nChild A body\n\n## codex-orchestrator metadata\nStable ID: child-a\nAFK/HITL: afk\nDepends on: none\nOwnership:\n- child-a.txt\nSpec gate: wave-level\nVerification:\n- npm test`,
    }),
  ]);

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter: new InMemoryGitHubPullRequestAdapter('example', 'repo'),
    codexAdapter,
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
    hostname: () => 'local-host',
    processProbe: () => 'missing',
  });

  assert.equal(result.status, 'review-ready');
  assert.match(reworkContext, /"attempt": 1/);
  assert.match(reworkContext, /Codex completed without file changes/);
  assert.deepEqual(issueAdapter.removedLabels.find((entry) => entry.issueNumber === 157)?.labels, [labels.blocked.name]);
});

test('plan-auto recovery hard-block uses stable parent marker without duplicate comments', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const parentWorktree = join(repo, '.codex-orchestrator', 'workspaces', 'tree-156');
  const baseSha = await git.getHead(repo);
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: parentWorktree,
    branchName: 'codex/tree-156',
    baseBranch: 'main',
  });
  await writeFile(join(parentWorktree, 'dirty.txt'), 'dirty\n', 'utf8');
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [{
      issueNumber: 156,
      mode: 'plan-parent',
      workspacePath: parentWorktree,
      sessionId: 'plan-156-stale',
      retryCount: 0,
      createdAt: '2026-05-08T10:00:00.000Z',
      updatedAt: '2026-05-08T10:00:00.000Z',
      branchName: 'codex/tree-156',
      host: 'local-host',
      ownerPid: 99999999,
      leaseUpdatedAt: new Date(now.getTime() - SCOPED_RECOVERY_LEASE_STALE_MS).toISOString(),
      baseSha,
    }],
  });
  const marker = 'plan-auto-recovery-blocked parent=156 reason=parent-worktree-is-not-clean';
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({
      number: 156,
      labels: [labels.planAuto.name, labels.running.name],
      body: 'Plan parent',
      comments: [{
        id: 'comment-1',
        url: 'https://github.com/example/repo/issues/156#issuecomment-1',
        body: `<!-- codex-orchestrator:${marker} -->\nexisting recovery block`,
        createdAt: '2026-05-08T11:00:00.000Z',
        author: { login: 'codex-orchestrator' },
        authorAssociation: 'MEMBER',
      }],
    }),
  ]);

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter: new InMemoryGitHubPullRequestAdapter('example', 'repo'),
    codexAdapter: codexAdapterForReport(completedReport()),
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
    hostname: () => 'local-host',
    processProbe: () => 'missing',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(issueAdapter.postedComments.length, 0);
  assert.equal((await git.listWorktrees(repo)).some((worktree) => worktree.branch === 'refs/heads/codex/tree-156'), true);
});

test('plan-auto command renders parent risk-routing warnings without stopping warn-mode execution', async () => {
  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  delete report.sizeRisk;
  delete report.parentReviewHandoff;
  report.graph.nodes = [report.graph.nodes[0]!];
  report.graph.edges = [];

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter: codexAdapterForReport(report),
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(result.childIssues.length, 1);
  assert.equal(issueAdapter.createdIssues.length, 1);
  assert.deepEqual(result.riskRoutingWarnings, [
    'Risk routing warning: parent sizeRisk is required.',
    'Risk routing warning: parentReviewHandoff is required.',
  ]);
  assert.match(result.reportComment, /Risk routing warnings/);
  assert.match(result.reportComment, /parent sizeRisk is required/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Risk routing warnings/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /parentReviewHandoff is required/);
});

test('plan-auto command blocks parent risk-routing findings before parent or child mutations in block mode', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    reviewGates: {
      ...config.reviewGates,
      riskRouting: {
        ...config.reviewGates.riskRouting,
        mode: 'block',
      },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  delete report.sizeRisk;
  delete report.parentReviewHandoff;
  let runCount = 0;
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      runCount += 1;
      await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(runCount, 1);
  assert.deepEqual(result.riskRoutingWarnings, []);
  assert.equal(issueAdapter.updatedIssues.some((entry) => entry.issueNumber === 156), false);
  assert.equal(issueAdapter.createdIssues.length, 0);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.equal(issueAdapter.addedLabels.some((entry) => entry.labels.includes(labels.review.name)), false);
  assert.match(result.reportComment, /Risk routing gate requires: parent sizeRisk is required/);
  assert.match(result.reportComment, /Risk routing gate requires: parentReviewHandoff is required/);
});

test('plan-auto command applies configured child rework loop before parent integration', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    loopPolicy: {
      ...config.loopPolicy,
      rework: {
        ...config.loopPolicy.rework,
        maxAttempts: 1,
      },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [report.graph.nodes[0]!];
  report.graph.edges = [];
  let childRuns = 0;
  let reworkContext = '';
  const childInputs: CodexCommandRunInput[] = [];
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.startsWith('plan-')) {
        await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      } else {
        childRuns += 1;
        childInputs.push(input);
        reworkContext = await readFile(input.contextArtifactPath, 'utf8');
        const changedPath = childRuns === 2 ? await writeChildOwnedChange(input) : undefined;
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            changes: changedPath ? [changedPath] : [],
            validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
            proofPlan: {
              mode: 'none',
              reason: 'Plan-auto child fixture does not claim acceptance proof.',
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
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

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
  assert.equal(childRuns, 2);
  assert.equal(new Set(childInputs.map((input) => input.contextArtifactPath)).size, 2);
  assert.equal(new Set(childInputs.map((input) => input.reportPath)).size, 2);
  assert.equal(new Set(childInputs.map((input) => input.logPath)).size, 2);
  assert.match(reworkContext, /"attempt": 1/);
  assert.match(reworkContext, /Codex completed without file changes/);
  const childReviewComment = [...issueAdapter.postedComments].reverse()
    .find((entry) => entry.issueNumber === 157 && entry.body.includes('codex-orchestrator child review report'))?.body ?? '';
  assert.match(childReviewComment, /rework attempts: 1/);
  assert.equal(
    issueAdapter.addedLabels.some((entry) =>
      entry.issueNumber === 156 && entry.labels.includes(labels.blocked.name)),
    false,
  );
  const recentEvents = await new RunnerLifecycleEventStore(repo, validConfig).readRecent();
  assert.equal(recentEvents.filter((event) => event.mode === 'tree-child' && event.status === 'started').length, 2);
});

test('plan-auto command blocks child publication on configured fresh-context review finding', async () => {
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
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [report.graph.nodes[0]!];
  report.graph.edges = [];
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.startsWith('plan-')) {
        await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      } else if (input.sessionId.endsWith('-fresh-review')) {
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            findings: [{
              severity: 'policy-violation',
              confidence: 'high',
              summary: 'Child violates the runner-owned publication boundary.',
              evidence: 'Review found publication evidence.',
            }],
            residualRisks: [],
          }),
          'utf8',
        );
      } else {
        const changedPath = await writeChildOwnedChange(input);
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            changes: [changedPath],
            validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
            proofPlan: {
              mode: 'none',
              reason: 'Plan-auto child fixture does not claim acceptance proof.',
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
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  const childBlocked = [...issueAdapter.postedComments].reverse().find((entry) => entry.issueNumber === 157)?.body ?? '';
  assert.match(childBlocked, /Fresh-Context Review blocked publication/);
  assert.match(childBlocked, /Durable Run Summary/);
  assert.match(childBlocked, /Non-mutating recommendation/);
});

test('plan-auto command integrates validated child local commits when policy allows', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    runner: {
      ...config.runner,
      allowAgentLocalCommits: true,
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [report.graph.nodes[0]!];
  report.graph.edges = [];
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.startsWith('plan-')) {
        await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      } else {
        const changedPath = await writeChildOwnedChange(input);
        await execFileAsync('git', ['-C', input.worktreePath, 'add', changedPath]);
        await execFileAsync('git', ['-C', input.worktreePath, 'commit', '-m', 'Agent child checkpoint']);
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            changes: [changedPath],
            validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
            proofPlan: {
              mode: 'none',
              reason: 'Plan-auto child fixture does not claim acceptance proof.',
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
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

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
  assert.match(result.reportComment, /Agent child checkpoint/);
  assert.match(pullRequestAdapter.createdPullRequests[0]?.body ?? '', /Agent child checkpoint/);
  const pushed = await execFileAsync('git', ['--git-dir', join(dirname(repo), 'remote.git'), 'log', '--oneline', 'codex/tree-156']);
  assert.match(pushed.stdout, /Agent child checkpoint/);
});

test('plan-auto command blocks child failed configured checks before merge or publication', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    checks: { tests: 'npm test' },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [report.graph.nodes[0]!];
  report.graph.edges = [];

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter: codexAdapterForReport(report),
    shellExecutor: async () => ({ stdout: '', stderr: 'test failed', exitCode: 1 }),
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /configured checks failed/i);
  assert.match(result.reportComment, /test failed/);
  assert.deepEqual(
    issueAdapter.addedLabels.filter((entry) => entry.labels.includes(labels.blocked.name)).map((entry) => entry.issueNumber),
    [157, 156],
  );
  await assert.rejects(
    execFileAsync('git', ['--git-dir', join(dirname(repo), 'remote.git'), 'rev-parse', 'codex/tree-156']),
    /unknown revision|ambiguous argument|Needed a single revision/,
  );
});

test('plan-auto command blocks parent publication when child acceptance proof fails', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    codex: {
      ...config.codex,
      profiles: {
        ...config.codex.profiles,
        'acceptance-proof': {},
      },
    },
    checks: {},
    loopPolicy: {
      ...config.loopPolicy,
      rework: {
        ...config.loopPolicy.rework,
        maxAttempts: 0,
      },
    },
    reviewGates: {
      ...config.reviewGates,
      quality: {
        ...config.reviewGates.quality,
        enabled: false,
      },
      acceptanceProof: {
        ...config.reviewGates.acceptanceProof,
        issueTextPatterns: ['acceptance proof'],
        changedPathGlobs: ['child-*.txt'],
        maxIterations: 1,
      },
    },
  }));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [report.graph.nodes[0]!];
  report.graph.edges = [];
  const proofInputs: CodexCommandRunInput[] = [];
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.startsWith('plan-')) {
        await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      } else if (input.phase === 'acceptance-proof') {
        proofInputs.push(input);
        await mkdir(join(input.worktreePath, '.codex-orchestrator', 'proofs', `issue-${input.issueNumber}`), { recursive: true });
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'needs-rework',
            criteria: [{
              id: 'ac-1',
              description: 'Child behavior is proven',
              status: 'failed',
              confidence: 'low',
              reasoningSummary: 'No smoke artifact proves the child behavior.',
              artifactRefs: [],
            }],
            artifacts: [],
            proofPhaseDiff: { allowedProofPaths: [], forbiddenProductPaths: [] },
            reworkRequest: {
              summary: 'Add observable child proof.',
              requiredChanges: ['Produce smoke-output artifact for child behavior.'],
              evidenceRefs: [],
            },
            residualRisks: ['No child proof artifact.'],
          }),
          'utf8',
        );
      } else {
        const changedPath = await writeChildOwnedChange(input);
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            changes: [changedPath],
            validation: [{ command: 'fake', status: 'passed', summary: 'ok' }],
            proofPlan: {
              mode: 'browser-visual',
              reason: 'Child acceptance-proof fixture delegates proof to the proof phase.',
              validationCommands: [],
              requiredArtifacts: [],
              visualTarget: 'browser',
            },
            artifacts: [],
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
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(proofInputs.length, 1);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /Acceptance proof needs-rework|Acceptance proof criterion ac-1/i);
  const childBlocked = [...issueAdapter.postedComments].reverse().find((entry) => entry.issueNumber === 157)?.body ?? '';
  assert.match(childBlocked, /Acceptance Proof/);
  assert.match(childBlocked, /Add observable child proof/);
  assert.match(childBlocked, /Durable Run Summary/);
  const childSummary = JSON.parse(
    await readFile(
      join(repo, validConfig.runner.stateDir, 'summaries', 'issue-157-tree-156-issue-157-20260508120000.json'),
      'utf8',
    ),
  ) as Record<string, any>;
  assert.equal(childSummary.acceptanceProof.status, 'needs-rework');
  const recentEvents = await new RunnerLifecycleEventStore(repo, validConfig).readRecent();
  assert.equal(recentEvents.some((event) => event.phase === 'acceptance-proof' && event.status === 'started'), true);
  assert.equal(recentEvents.some((event) => event.phase === 'acceptance-proof' && event.status === 'needs-rework'), true);
});

test('plan-auto command blocks failed parent integration checks before publication', async () => {
  const repo = await tempGitProject((config) => ({
    ...config,
    checks: { tests: 'npm test' },
  }));
  const parentWorktree = join(repo, '.codex-orchestrator', 'workspaces', 'tree-156');
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [report.graph.nodes[0]!];
  report.graph.edges = [];

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter: codexAdapterForReport(report),
    shellExecutor: async (_command, options) => (
      options?.cwd === parentWorktree
        ? { stdout: '', stderr: 'integration failed', exitCode: 1 }
        : { stdout: '', stderr: '', exitCode: 0 }
    ),
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.match(result.reportComment, /configured checks failed/i);
  assert.match(result.reportComment, /integration failed/);
  assert.equal(
    issueAdapter.addedLabels.some((entry) => entry.issueNumber === 157 && entry.labels.includes(labels.review.name)),
    false,
  );
  assert.equal(
    issueAdapter.addedLabels.some((entry) => entry.issueNumber === 157 && entry.labels.includes(labels.blocked.name)),
    true,
  );
  await assert.rejects(
    execFileAsync('git', ['--git-dir', join(dirname(repo), 'remote.git'), 'rev-parse', 'codex/tree-156']),
    /unknown revision|ambiguous argument|Needed a single revision/,
  );
});

test('plan-auto command blocks completed children when parent PR creation fails', async () => {
  class FailingPullRequestAdapter extends InMemoryGitHubPullRequestAdapter {
    public override async createDraftPullRequest(_input: CreateDraftPullRequestInput): Promise<GitHubPullRequest> {
      throw new Error('pr create failed');
    }
  }

  const repo = await tempGitProject();
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name], body: 'Plan parent' }),
  ]);
  const pullRequestAdapter = new FailingPullRequestAdapter('example', 'repo');
  const report = completedReport();
  report.graph.nodes = [report.graph.nodes[0]!];
  report.graph.edges = [];

  const result = await runPlanAutoCommand({
    targetRoot: repo,
    issueNumber: 156,
    issueAdapter,
    pullRequestAdapter,
    codexAdapter: codexAdapterForReport(report),
    shellExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.reportComment, /pr create failed/);
  assert.equal(
    issueAdapter.addedLabels.some((entry) => entry.issueNumber === 157 && entry.labels.includes(labels.review.name)),
    false,
  );
  assert.equal(
    issueAdapter.addedLabels.some((entry) => entry.issueNumber === 157 && entry.labels.includes(labels.blocked.name)),
    true,
  );
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
  const conflictPath = '.codex-orchestrator/proofs/conflict.txt';
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      if (input.sessionId.startsWith('plan-')) {
        await writeFile(input.reportPath, JSON.stringify(report), 'utf8');
      } else {
        await mkdir(dirname(join(input.worktreePath, conflictPath)), { recursive: true });
        await writeFile(join(input.worktreePath, conflictPath), `${input.issueNumber}\n`, 'utf8');
        await writeFile(
          input.reportPath,
          JSON.stringify({
            status: 'completed',
            changes: [conflictPath],
            validation: [],
            proofPlan: {
              mode: 'none',
              reason: 'Plan-auto child fixture intentionally has no proof evidence.',
              validationCommands: [],
              requiredArtifacts: [],
            },
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

test('plan-auto production path requires activated config v2 before claim', async () => {
  const repo = await tempGitProject();
  await unlink(join(repo, '.codex-orchestrator', 'prompts', 'workflows', 'triage.md'));
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 156, labels: [labels.planAuto.name] }),
  ]);

  await assert.rejects(
    runPlanAutoCommand({ targetRoot: repo, issueNumber: 156, issueAdapter, now }),
    /orchestrator-skill-runtime-v2-required/,
  );
  await assert.rejects(stat(join(repo, '.codex-orchestrator', 'workspaces')), /ENOENT/);
  assert.deepEqual(issueAdapter.addedLabels, []);
});
