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

test('implementation publishability accepts structured TDD red evidence without treating it as a failed check', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');

  await writeFile(join(repo, 'README.md'), '# fixture\nupdated\n', 'utf8');
  await mkdir(join(reportPath, '..'), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'completed',
      changes: ['README.md'],
      validation: [
        {
          command: 'git cat-file -e HEAD~1:test/example.test.ts',
          status: 'failed',
          summary: 'Red baseline confirmed: test file did not exist before implementation.',
          evidence: {
            kind: 'tdd-red-green',
            red: {
              command: 'git cat-file -e HEAD~1:test/example.test.ts',
              status: 'failed',
              summary: 'Exited 128 because the targeted test file was absent at HEAD~1.',
            },
            green: {
              command: 'npm test -- example.test.ts',
              status: 'passed',
              summary: 'Focused tests passed on HEAD.',
            },
          },
        },
      ],
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    }),
    'utf8',
  );

  const result = await runImplementationPublishabilityCheck({
    config: config(),
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
});

test('implementation publishability skips child checks outside scoped check policy', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');

  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'docs', 'example.md'), '# fixture\nupdated\n', 'utf8');
  await writeScopedReport(reportPath, { changes: ['docs/example.md'] });

  const calls: string[] = [];
  const result = await runImplementationPublishabilityCheck({
    config: config({
      checks: { test: 'npm test' },
      checksPolicy: {
        missingNpmScript: 'skip',
        scope: {
          test: { phases: ['parent-integration'] },
        },
      },
    } as Partial<CodexOrchestratorConfig>),
    issue: issueFixture({ number: 155, title: 'Update docs', body: 'Documentation update.' }),
    worktreePath: repo,
    reportPath,
    beforeHead,
    afterHead: beforeHead,
    codexResult: { stdout: 'ok', stderr: '', exitCode: 0 },
    git,
    shellExecutor: async (command) => {
      calls.push(command);
      return { stdout: '', stderr: 'test failed', exitCode: 1 };
    },
    commitMessage: 'Codex: implement issue #155',
  });

  assert.equal(result.status, 'publish-ready');
  assert.deepEqual(calls, []);
  assert.deepEqual(
    result.status === 'publish-ready'
      ? result.validation.filter((line) => line.command === 'npm test').map((line) => line.status)
      : [],
    ['skipped'],
  );
});

test('implementation publishability blocks changed files outside issue ownership scope', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');

  await mkdir(join(repo, 'docs', 'other'), { recursive: true });
  await writeFile(join(repo, 'docs', 'other', 'feature.md'), 'out of scope\n', 'utf8');
  await writeScopedReport(reportPath);

  const result = await runImplementationPublishabilityCheck({
    config: config({ checks: { tests: 'npm test' } }),
    issue: issueFixture({
      number: 155,
      title: 'Update owned feature',
      body: [
        'Implement scoped work.',
        '',
        '## codex-orchestrator metadata',
        'Ownership:',
        '- docs/owned/**',
      ].join('\n'),
    }),
    worktreePath: repo,
    reportPath,
    beforeHead,
    afterHead: beforeHead,
    codexResult: { stdout: 'ok', stderr: '', exitCode: 0 },
    git,
    shellExecutor: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    commitMessage: 'Codex: implement issue #155',
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.status === 'blocked' ? result.reasons.join('\n') : '', /outside issue ownership scope/);
  assert.match(result.status === 'blocked' ? result.reasons.join('\n') : '', /docs\/other\/feature\.md/);
  assert.equal(await git.isWorktreeClean(repo), false);
});

test('implementation publishability keeps validation evidence when quality gate blocks publication', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');
  const validation = [
    {
      command: 'TDD red evidence observed',
      status: 'passed' as const,
      summary: 'Baseline run failed as expected before implementation.',
    },
    {
      command: '$code-review',
      status: 'passed' as const,
      summary: 'No blocking findings.',
    },
  ];

  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'feature.ts'), 'export const feature = true;\n', 'utf8');
  await writeScopedReport(reportPath, { changes: ['src/feature.ts'], validation });

  const result = await runImplementationPublishabilityCheck({
    config: config({
      checks: {},
      reviewGates: {
        quality: {
          tdd: { requireTestChange: false },
          cleanupReview: { enabled: false },
        },
      },
    } as Partial<CodexOrchestratorConfig>),
    issue: issueFixture({ number: 155, title: 'Fix runtime behavior', body: 'Runtime behavior fix.' }),
    worktreePath: repo,
    reportPath,
    beforeHead,
    afterHead: beforeHead,
    codexResult: { stdout: 'ok', stderr: '', exitCode: 0 },
    git,
    shellExecutor: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    commitMessage: 'Codex: implement issue #155',
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.status === 'blocked' ? result.reasons.join('\n') : '', /TDD red-to-green proof/);
  assert.deepEqual(result.status === 'blocked' ? result.validation : [], validation);
});

test('implementation publishability does not fail when an npm script check is missing (skips with warning)', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');

  await writeFile(join(repo, 'README.md'), '# fixture\nupdated\n', 'utf8');
  await writeScopedReport(reportPath);

  const result = await runImplementationPublishabilityCheck({
    config: config({ checks: { typecheck: 'npm run typecheck' } }),
    issue: issueFixture({ number: 155, title: 'Update docs', body: 'Documentation update.' }),
    worktreePath: repo,
    reportPath,
    beforeHead,
    afterHead: beforeHead,
    codexResult: { stdout: 'ok', stderr: '', exitCode: 0 },
    git,
    shellExecutor: async () => ({ stdout: '', stderr: 'npm error Missing script: \"typecheck\"', exitCode: 1 }),
    commitMessage: 'Codex: implement issue #155',
  });

  assert.equal(result.status, 'publish-ready');
  assert.match(result.status === 'publish-ready' ? result.residualRisks.join('\n') : '', /missing script/i);
  assert.match(result.status === 'publish-ready' ? result.validation.map((l) => l.status).join(',') : '', /skipped/);
});

test('implementation publishability blocks product-code changes created during acceptance proof', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');

  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'feature.ts'), 'export const feature = true;\n', 'utf8');
  await writeScopedReport(reportPath, {
    changes: ['src/feature.ts'],
    validation: [
      {
        command: 'TDD red-to-green',
        status: 'passed',
        summary: 'Focused behavior test failed before implementation and passed after implementation.',
      },
      { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
    ],
  });

  const result = await runImplementationPublishabilityCheck({
    config: config({
      checks: {},
      reviewGates: {
        quality: { tdd: { requireTestChange: false }, cleanupReview: { enabled: false } },
        acceptanceProof: {
          runnerValidationCommand: 'node proof.mjs',
          issueTextPatterns: ['acceptance proof'],
          changedPathGlobs: ['src/**'],
          proofOwnedPathGlobs: ['.codex-orchestrator/proofs/**'],
        },
        visualProof: {
          runnerValidationCommand: 'node proof.mjs',
          issueTextPatterns: ['acceptance proof'],
          changedPathGlobs: ['src/**'],
        },
      } as any,
    } as Partial<CodexOrchestratorConfig>),
    issue: issueFixture({ number: 155, title: 'Acceptance proof for API change', body: 'Needs acceptance proof.' }),
    worktreePath: repo,
    reportPath,
    beforeHead,
    afterHead: beforeHead,
    codexResult: { stdout: 'ok', stderr: '', exitCode: 0 },
    git,
    shellExecutor: async () => {
      await writeFile(join(repo, 'src', 'feature.ts'), 'export const feature = "proof changed product code";\n', 'utf8');
      await writeFile(join(repo, 'src', 'proof-side-effect.ts'), 'export const leaked = true;\n', 'utf8');
      return { stdout: 'proof edited product code', stderr: '', exitCode: 0 };
    },
    commitMessage: 'Codex: implement issue #155',
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.status === 'blocked' ? result.reasons.join('\n') : '', /product-code changes during acceptance proof/i);
  assert.match(result.status === 'blocked' ? result.reasons.join('\n') : '', /src\/feature\.ts/);
  assert.match(result.status === 'blocked' ? result.reasons.join('\n') : '', /src\/proof-side-effect\.ts/);
  assert.equal(result.status === 'blocked' ? result.acceptanceProofAttempt?.status : undefined, 'blocked');
  assert.match(
    result.status === 'blocked' ? result.acceptanceProofAttempt?.blockers.join('\n') ?? '' : '',
    /product-code changes during acceptance proof/i,
  );
  assert.match(result.status === 'blocked' ? result.acceptanceProofAttempt?.reportPath ?? '' : '', /acceptance-proof-report\.json$/);
  assert.match(result.status === 'blocked' ? result.acceptanceProofAttempt?.artifactDir ?? '' : '', /\.codex-orchestrator\/proofs\/issue-155$/);
  assert.equal(result.status === 'blocked' ? result.acceptanceProofAttempt?.validation[0]?.command : undefined, 'node proof.mjs');
});

test('implementation publishability drops non-applicable runner visual proof skips for internal proof-runner changes', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');
  const skippedRunnerProof = 'Runner-owned codex-orchestrator visual-proof mobile --issue 773 was not executed by child Codex per the proof contract.';

  await mkdir(join(repo, 'src', 'runner'), { recursive: true });
  await mkdir(join(repo, 'test'), { recursive: true });
  await writeFile(join(repo, 'src', 'runner', 'acceptance-proof.ts'), 'export const proof = true;\n', 'utf8');
  await writeFile(join(repo, 'src', 'runner', 'visual-proof-runner.ts'), 'export const runner = true;\n', 'utf8');
  await writeFile(join(repo, 'test', 'acceptance-proof.test.ts'), 'export const tested = true;\n', 'utf8');
  await writeFile(join(repo, 'test', 'visual-proof-runner.test.ts'), 'export const runnerTested = true;\n', 'utf8');
  await writeScopedReport(reportPath, {
    changes: [
      'src/runner/acceptance-proof.ts',
      'src/runner/visual-proof-runner.ts',
      'test/acceptance-proof.test.ts',
      'test/visual-proof-runner.test.ts',
    ],
    validation: [
      {
        command: 'TDD red/green: proof report loading',
        status: 'passed',
        summary: 'Focused acceptance-proof test failed before implementation and passed after implementation.',
      },
      { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
    ],
    skippedChecks: [skippedRunnerProof, 'Optional benchmark not run.'],
  });

  const result = await runImplementationPublishabilityCheck({
    config: config({ checks: {} }),
    issue: issueFixture({
      number: 773,
      title: 'Self-improvement: Deepen Acceptance Proof report loading',
      body: 'Acceptance Proof report loading lives in the internal visual proof runner.',
    }),
    worktreePath: repo,
    reportPath,
    beforeHead,
    afterHead: beforeHead,
    codexResult: { stdout: 'ok', stderr: '', exitCode: 0 },
    git,
    shellExecutor: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    commitMessage: 'Codex: implement issue #773',
  });

  assert.equal(result.status, 'publish-ready');
  assert.deepEqual(result.status === 'publish-ready' ? result.skippedChecks : [], ['Optional benchmark not run.']);
});

test('implementation publishability can allow repo-wide lint failures when touched-files lint passes (policy touched-only)', async () => {
  const repo = await tempGitProject();
  const git = new GitWorktreeManager();
  const beforeHead = await git.getHead(repo);
  const reportPath = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-report-')), 'report.json');

  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'feature.ts'), 'export const x = 1;\n', 'utf8');
  await writeScopedReport(reportPath, { changes: ['src/feature.ts'] });

  let calls = 0;
  const shellExecutor = async (command: string) => {
    calls += 1;
    if (command.includes('npm run lint:touched')) {
      return { stdout: 'touched lint ok', stderr: '', exitCode: 0 };
    }
    if (command.includes('npm run lint')) {
      return { stdout: '', stderr: 'lint baseline failure in untouched file', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  const result = await runImplementationPublishabilityCheck({
    config: config({
      checks: { lint: 'npm run lint' },
      checksPolicy: {
        missingNpmScript: 'skip',
        lintBaseline: { mode: 'touched-only', touchedFilesCommand: 'npm run lint:touched' },
      },
      reviewGates: {
        quality: { enabled: false },
        acceptanceProof: { enabled: false },
        visualProof: { enabled: false },
      } as any,
    } as Partial<CodexOrchestratorConfig>),
    issue: issueFixture({ number: 155, title: '[UI] Lint baseline', body: 'Fix only touched files.' }),
    worktreePath: repo,
    reportPath,
    beforeHead,
    afterHead: beforeHead,
    codexResult: { stdout: 'ok', stderr: '', exitCode: 0 },
    git,
    shellExecutor: shellExecutor as any,
    commitMessage: 'Codex: implement issue #155',
  });

  assert.equal(calls >= 2, true);
  assert.equal(result.status, 'publish-ready');
  assert.match(result.status === 'publish-ready' ? result.residualRisks.join('\\n') : '', /lint baseline/i);
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
      acceptanceProof: { ...base.reviewGates.acceptanceProof, ...overrides.reviewGates?.acceptanceProof },
      visualProof: { ...base.reviewGates.visualProof, ...overrides.reviewGates?.visualProof },
    },
  };
}

async function writeScopedReport(
  reportPath: string,
  overrides: Partial<{
    changes: string[];
    validation: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; summary: string }>;
    skippedChecks: string[];
  }> = {},
): Promise<void> {
  await mkdir(join(reportPath, '..'), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'completed',
      changes: overrides.changes ?? ['README.md'],
      validation: overrides.validation ?? [{ command: 'tdd', status: 'passed', summary: 'red and green complete' }],
      artifacts: [],
      skippedChecks: overrides.skippedChecks ?? [],
      residualRisks: [],
      prohibitedActions: [],
    }),
    'utf8',
  );
}
