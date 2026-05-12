import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { CodexOrchestratorConfig } from '../src/config/schema.js';
import { GitWorktreeManager } from '../src/git/worktree.js';
import {
  runImplementationPublishabilityCheck,
  runLocalExecutionSession,
} from '../src/runner/local-execution-session.js';
import { buildProjectConfig } from '../src/setup/project-config.js';
import { fallbackWorkflows } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const execFileAsync = promisify(execFile);

test('local execution session runs multiple phases against one worktree and aggregates evidence', async () => {
  const seen: Array<[string, string]> = [];

  const result = await runLocalExecutionSession({
    worktreePath: '/repo/.codex-orchestrator/workspaces/issue-17',
    phases: ['implementation', 'code-review'],
    async executePhase(input) {
      seen.push([input.phaseId, input.worktreePath]);
      return {
        phaseId: input.phaseId,
        status: 'passed',
        validation: [{ command: input.phaseId, status: 'passed', summary: 'ok' }],
        artifacts: [{ type: 'log', path: `/logs/${input.phaseId}.log`, description: `${input.phaseId} log` }],
        residualRisks: [],
      };
    },
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.publishReady, true);
  assert.deepEqual(seen, [
    ['implementation', '/repo/.codex-orchestrator/workspaces/issue-17'],
    ['code-review', '/repo/.codex-orchestrator/workspaces/issue-17'],
  ]);
  assert.deepEqual(result.phaseResults.map((phase) => phase.validation[0]?.command), ['implementation', 'code-review']);
  assert.deepEqual(result.phaseResults.map((phase) => phase.artifacts[0]?.path), ['/logs/implementation.log', '/logs/code-review.log']);
});

test('local execution session stops on a failing phase and blocks publication', async () => {
  const seen: string[] = [];

  const result = await runLocalExecutionSession({
    worktreePath: '/repo/.codex-orchestrator/workspaces/issue-17',
    phases: ['implementation', 'cleanup-review', 'code-review'],
    async executePhase(input) {
      seen.push(input.phaseId);
      return {
        phaseId: input.phaseId,
        status: input.phaseId === 'cleanup-review' ? 'failed' : 'passed',
        validation: [{ command: input.phaseId, status: input.phaseId === 'cleanup-review' ? 'failed' : 'passed', summary: 'result' }],
        artifacts: [{ type: 'log', path: `/logs/${input.phaseId}.log`, description: `${input.phaseId} log` }],
        residualRisks: input.phaseId === 'cleanup-review' ? ['cleanup finding remains'] : [],
      };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.publishReady, false);
  assert.deepEqual(seen, ['implementation', 'cleanup-review']);
  assert.deepEqual(result.phaseResults.at(-1)?.residualRisks, ['cleanup finding remains']);
});

test('implementation publishability returns publish-ready evidence and commits only local runner work', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');

  await writeFile(join(repo, 'README.md'), '# fixture\nupdated\n', 'utf8');
  await writeScopedReport(reportPath);

  const result = await runImplementationPublishabilityCheck({
    config: config({ checks: { tests: 'npm test' } }),
    issue: issueFixture({ number: 155, title: 'Update docs', body: 'Documentation update.' }),
    worktreePath: repo,
    reportPath,
    beforeHead,
    afterHead: beforeHead,
    codexResult: { stdout: 'ok', stderr: '', exitCode: 0 },
    git,
    shellExecutor: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    commitMessage: 'Codex: implement issue #155',
  });

  assert.equal(result.status, 'publish-ready');
  assert.deepEqual(result.status === 'publish-ready' ? result.changedFiles : [], ['README.md']);
  assert.equal(result.status === 'publish-ready' ? result.commits.length : 0, 1);
  assert.match(result.status === 'publish-ready' ? result.commits[0]?.subject ?? '' : '', /Codex: implement issue #155/);
});

test('implementation publishability blocks failed configured checks before publication', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');

  await writeFile(join(repo, 'README.md'), '# fixture\nupdated\n', 'utf8');
  await writeScopedReport(reportPath);

  const result = await runImplementationPublishabilityCheck({
    config: config({ checks: { tests: 'npm test' } }),
    issue: issueFixture({ number: 155, title: 'Update docs', body: 'Documentation update.' }),
    worktreePath: repo,
    reportPath,
    beforeHead,
    afterHead: beforeHead,
    codexResult: { stdout: 'ok', stderr: '', exitCode: 0 },
    git,
    shellExecutor: async () => ({ stdout: '', stderr: 'test failed', exitCode: 1 }),
    commitMessage: 'Codex: implement issue #155',
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.status === 'blocked' ? result.reasons.join('\n') : '', /One or more configured checks failed/);
  assert.match(result.status === 'blocked' ? result.reasons.join('\n') : '', /test failed/);
  assert.equal(await git.isWorktreeClean(repo), false);
});

async function tempGitProject(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'codex-orchestrator-local-session-'));
  await execFileAsync('git', ['init', '-b', 'main', repo]);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(repo, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'Initial']);
  return repo;
}

function config(overrides: Partial<CodexOrchestratorConfig> = {}): CodexOrchestratorConfig {
  const base = buildProjectConfig({
    owner: 'example',
    repo: 'repo',
    prepareLabels: 'report-only',
    workflows: fallbackWorkflows,
  });
  return {
    ...base,
    ...overrides,
    runner: { ...base.runner, ...overrides.runner },
    reviewGates: {
      ...base.reviewGates,
      ...overrides.reviewGates,
      quality: {
        ...base.reviewGates.quality,
        ...overrides.reviewGates?.quality,
        tdd: { ...base.reviewGates.quality.tdd, ...overrides.reviewGates?.quality?.tdd },
        cleanupReview: {
          ...base.reviewGates.quality.cleanupReview,
          ...overrides.reviewGates?.quality?.cleanupReview,
        },
        codeReview: { ...base.reviewGates.quality.codeReview, ...overrides.reviewGates?.quality?.codeReview },
      },
      visualProof: { ...base.reviewGates.visualProof, ...overrides.reviewGates?.visualProof },
    },
  };
}

async function writeScopedReport(reportPath: string): Promise<void> {
  await mkdir(join(reportPath, '..'), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'completed',
      changes: ['README.md'],
      validation: [{ command: 'tdd', status: 'passed', summary: 'red and green complete' }],
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    }),
    'utf8',
  );
}
