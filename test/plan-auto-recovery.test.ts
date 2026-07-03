import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { GitWorktreeManager } from '../src/git/worktree.js';
import { classifyPlanAutoCompletedChildRecovery, classifyPlanAutoParentRecovery } from '../src/runner/plan-auto-recovery.js';
import { renderAutonomousChildMarker, type AutonomousChildNode } from '../src/runner/issue-tree.js';
import { SCOPED_RECOVERY_LEASE_STALE_MS, type ProcessProbeResult } from '../src/runner/scoped-recovery.js';
import type { RunnerProcessMetadata } from '../src/runner/local-state.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const execFileAsync = promisify(execFile);
const now = new Date('2026-05-08T12:00:00.000Z');

async function tempGitProject(): Promise<{ repo: string; baseSha: string; worktreePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-plan-recovery-'));
  const repo = join(root, 'repo');
  await execFileAsync('git', ['init', '-b', 'main', repo]);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(repo, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'Initial']);
  await mkdir(join(repo, '.codex-orchestrator'), { recursive: true });
  await writeFile(join(repo, '.codex-orchestrator', 'config.json'), `${JSON.stringify(validConfig, null, 2)}\n`, 'utf8');
  const baseSha = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const worktreePath = join(repo, validConfig.runner.workspaceRoot, 'tree-156');
  await new GitWorktreeManager().createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/tree-156',
    baseBranch: 'main',
  });
  return { repo, baseSha, worktreePath };
}

function parentRun(input: Partial<RunnerProcessMetadata> = {}): RunnerProcessMetadata {
  const run: Record<string, unknown> = {
    issueNumber: 156,
    mode: 'plan-parent',
    workspacePath: '/repo/.codex-orchestrator/workspaces/tree-156',
    sessionId: 'plan-156-session',
    retryCount: 0,
    createdAt: '2026-05-08T10:00:00.000Z',
    updatedAt: '2026-05-08T10:00:00.000Z',
    branchName: 'codex/tree-156',
    reportPath: '/repo/.codex-orchestrator/state/reports/issue-156-plan-156-session.json',
    logPath: '/repo/.codex-orchestrator/state/logs/issue-156-plan-156-session.log',
    host: 'local-host',
    ownerPid: 12345,
    leaseUpdatedAt: new Date(now.getTime() - SCOPED_RECOVERY_LEASE_STALE_MS).toISOString(),
    baseSha: 'base-sha',
  };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      delete run[key];
    } else {
      run[key] = value;
    }
  }
  return run as unknown as RunnerProcessMetadata;
}

function probe(result: ProcessProbeResult): () => ProcessProbeResult {
  return () => result;
}

test('classifies a clean stale runner-owned parent tree as resume-parent', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  const result = await classifyPlanAutoParentRecovery({
    targetRoot: repo,
    config: validConfig,
    parentIssue: issueFixture({ number: 156 }),
    branchName: 'codex/tree-156',
    worktreePath,
    baseSha,
    state: { version: 1, runs: [parentRun({ workspacePath: worktreePath, baseSha })] },
    git: new GitWorktreeManager(),
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });

  assert.equal(result.kind, 'resume-parent');
  assert.deepEqual(result.evidence, {
    issueNumber: 156,
    branchName: 'codex/tree-156',
    worktreePath,
    sessionId: 'plan-156-session',
    baseSha,
  });
});

test('parent recovery hard-blocks unsafe parent metadata and git facts', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  await writeFile(join(worktreePath, 'dirty.txt'), 'dirty\n', 'utf8');
  const baseInput = {
    targetRoot: repo,
    config: validConfig,
    parentIssue: issueFixture({ number: 156 }),
    branchName: 'codex/tree-156',
    worktreePath,
    baseSha,
    git: new GitWorktreeManager(),
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  };

  assert.deepEqual(
    await classifyPlanAutoParentRecovery({
      ...baseInput,
      state: { version: 1, runs: [parentRun({ workspacePath: worktreePath, baseSha })] },
    }),
    {
      kind: 'hard-block',
      scope: 'parent',
      reason: 'parent worktree is not clean',
      marker: 'plan-auto-recovery-blocked parent=156 reason=parent-worktree-is-not-clean',
    },
  );

  assert.deepEqual(
    await classifyPlanAutoParentRecovery({
      ...baseInput,
      state: { version: 1, runs: [parentRun({ workspacePath: worktreePath, baseSha, branchName: 'codex/tree-999' })] },
    }),
    {
      kind: 'hard-block',
      scope: 'parent',
      reason: 'parent metadata branch does not match codex/tree-156',
      marker: 'plan-auto-recovery-blocked parent=156 reason=parent-metadata-branch-does-not-match-codex-tree-156',
    },
  );
});

test('parent ownership follows scoped recovery lease semantics', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  const baseInput = {
    targetRoot: repo,
    config: validConfig,
    parentIssue: issueFixture({ number: 156 }),
    branchName: 'codex/tree-156',
    worktreePath,
    baseSha,
    git: new GitWorktreeManager(),
    now,
  };

  const cases: Array<{
    name: string;
    run: RunnerProcessMetadata;
    hostname?: () => string;
    processProbe?: () => ProcessProbeResult;
    kind: 'resume-parent' | 'hard-block';
    reason?: string;
  }> = [
    {
      name: 'future lease',
      run: parentRun({ workspacePath: worktreePath, baseSha, leaseUpdatedAt: new Date(now.getTime() + 1).toISOString() }),
      hostname: () => 'local-host',
      processProbe: probe('missing'),
      kind: 'hard-block',
      reason: 'parent ownership evidence is invalid or from the future',
    },
    {
      name: 'partial lease',
      run: parentRun({ workspacePath: worktreePath, baseSha, ownerPid: undefined }),
      hostname: () => 'local-host',
      processProbe: probe('missing'),
      kind: 'hard-block',
      reason: 'parent ownership evidence is incomplete',
    },
    {
      name: 'cross host',
      run: parentRun({ workspacePath: worktreePath, baseSha, host: 'other-host' }),
      hostname: () => 'local-host',
      processProbe: probe('missing'),
      kind: 'hard-block',
      reason: 'parent metadata belongs to host other-host',
    },
    {
      name: 'same-host alive',
      run: parentRun({ workspacePath: worktreePath, baseSha }),
      hostname: () => 'local-host',
      processProbe: probe('alive'),
      kind: 'hard-block',
      reason: 'parent runner process is alive',
    },
    {
      name: 'same-host unknown',
      run: parentRun({ workspacePath: worktreePath, baseSha }),
      hostname: () => 'local-host',
      processProbe: probe('unknown'),
      kind: 'hard-block',
      reason: 'parent runner process is unknown',
    },
    {
      name: 'same-host fresh missing',
      run: parentRun({
        workspacePath: worktreePath,
        baseSha,
        leaseUpdatedAt: new Date(now.getTime() - SCOPED_RECOVERY_LEASE_STALE_MS + 1).toISOString(),
      }),
      hostname: () => 'local-host',
      processProbe: probe('missing'),
      kind: 'hard-block',
      reason: 'parent runner lease is still fresh',
    },
    {
      name: 'same-host stale missing',
      run: parentRun({ workspacePath: worktreePath, baseSha }),
      hostname: () => 'local-host',
      processProbe: probe('missing'),
      kind: 'resume-parent',
    },
    {
      name: 'legacy',
      run: parentRun({ workspacePath: worktreePath, baseSha, host: undefined, ownerPid: undefined, leaseUpdatedAt: undefined }),
      hostname: () => 'local-host',
      processProbe: probe('missing'),
      kind: 'hard-block',
      reason: 'legacy parent metadata cannot prove stale ownership',
    },
  ];

  for (const item of cases) {
    const result = await classifyPlanAutoParentRecovery({
      ...baseInput,
      state: { version: 1, runs: [item.run] },
      hostname: item.hostname,
      processProbe: item.processProbe,
    });
    assert.equal(result.kind, item.kind, item.name);
    if (item.reason && result.kind === 'hard-block') {
      assert.equal(result.reason, item.reason, item.name);
    }
  }
});

test('completed child recovery hard-blocks when the durable summary is missing', async () => {
  const { repo, worktreePath } = await tempGitProject();
  const git = new GitWorktreeManager();
  const childWorktreePath = join(repo, validConfig.runner.workspaceRoot, 'tree-156-issue-157');
  await git.createIssueWorktree({
    targetRoot: repo,
    workspacePath: childWorktreePath,
    branchName: 'codex/tree-156-issue-157',
    baseBranch: 'codex/tree-156',
  });
  await writeFile(join(childWorktreePath, 'child-a.txt'), 'done\n', 'utf8');
  await git.commitAll({ worktreePath: childWorktreePath, message: 'Codex: implement issue #157 for parent #156' });
  await git.mergeBranch({
    worktreePath,
    branchName: 'codex/tree-156-issue-157',
    message: 'Codex: merge issue #157 into parent #156',
  });
  const child: AutonomousChildNode = {
    issue: issueFixture({
      number: 157,
      state: 'CLOSED',
      labels: [validConfig.github.labels.child.name],
      body: `${renderAutonomousChildMarker(156)}\nChild A\n\n## codex-orchestrator metadata\nStable ID: child-a\nAFK/HITL: afk\nDepends on: none\nOwnership:\n- child-a.txt\nSpec gate: wave-level\nVerification:\n- npm test`,
    }),
    metadata: {
      stableId: 'child-a',
      afkHitl: 'afk',
      dependsOn: [],
      ownershipScope: ['child-a.txt'],
      verification: ['npm test'],
    },
  };

  const result = await classifyPlanAutoCompletedChildRecovery({
    targetRoot: repo,
    config: validConfig,
    parentIssueNumber: 156,
    parentBranchName: 'codex/tree-156',
    child,
    state: {
      version: 1,
      runs: [{
        issueNumber: 157,
        parentIssueNumber: 156,
        mode: 'tree-child',
        workspacePath: childWorktreePath,
        sessionId: 'missing-summary',
        retryCount: 0,
        createdAt: '2026-05-08T10:00:00.000Z',
        updatedAt: '2026-05-08T10:00:00.000Z',
        branchName: 'codex/tree-156-issue-157',
      }],
    },
    git,
  });

  assert.deepEqual(result, {
    kind: 'hard-block',
    scope: 'child',
    reason: 'child #157 durable run summary is missing',
    marker: 'plan-auto-recovery-blocked parent=156 child=157 reason=child-157-durable-run-summary-is-missing',
  });
});
