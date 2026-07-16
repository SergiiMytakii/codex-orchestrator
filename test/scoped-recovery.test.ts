import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { InMemoryGitHubPullRequestAdapter } from '../src/github/pull-requests.js';
import { GitWorktreeManager } from '../src/git/worktree.js';
import type { CodexCommandRunInput, CodexCommandRunResult } from '../src/codex/command-adapter.js';
import {
  buildRecoveredCodexResult,
  classifyScopedRecoveryRun,
  recoverScopedRun,
  SCOPED_RECOVERY_LEASE_STALE_MS,
  type ProcessProbeResult,
} from '../src/runner/scoped-recovery.js';
import { RunnerStateStore, type RunnerProcessMetadata } from '../src/runner/local-state.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

const labels = validConfig.github.labels;
const now = new Date('2026-05-08T12:00:00.000Z');
const execFileAsync = promisify(execFile);

async function tempRepo(): Promise<string> {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-scoped-recovery-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(join(targetRoot, '.codex-orchestrator', 'config.json'), `${JSON.stringify(validConfig, null, 2)}\n`, 'utf8');
  return targetRoot;
}

async function tempGitProject(): Promise<{ repo: string; baseSha: string; worktreePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-scoped-recovery-git-'));
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
  await mkdir(join(repo, '.codex-orchestrator'), { recursive: true });
  await writeFile(join(repo, '.codex-orchestrator', 'config.json'), `${JSON.stringify(validConfig, null, 2)}\n`, 'utf8');
  await writeWorkflowPrompts(repo);
  const baseSha = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const worktreePath = join(repo, validConfig.runner.workspaceRoot, 'issue-155');
  await new GitWorktreeManager().createIssueWorktree({
    targetRoot: repo,
    workspacePath: worktreePath,
    branchName: 'codex/issue-155',
    baseBranch: 'main',
  });
  return { repo, baseSha, worktreePath };
}

async function writeWorkflowPrompts(repo: string): Promise<void> {
  const promptPaths = [
    validConfig.workflows.scopedImplementation.promptPath,
    validConfig.workflows.acceptanceProof.promptPath,
  ];
  for (const promptPath of promptPaths) {
    if (!promptPath) {
      throw new Error('workflow prompt path fixture is missing');
    }
    await mkdir(dirname(join(repo, promptPath)), { recursive: true });
    await writeFile(join(repo, promptPath), 'workflow prompt\n', 'utf8');
  }
}

function metadata(input: Partial<RunnerProcessMetadata> = {}): RunnerProcessMetadata {
  const value: Record<string, unknown> = {
    issueNumber: 155,
    mode: 'scoped-issue',
    workspacePath: '.codex-orchestrator/workspaces/issue-155',
    sessionId: 'issue-155-session',
    retryCount: 0,
    createdAt: '2026-05-08T10:00:00.000Z',
    updatedAt: '2026-05-08T10:00:00.000Z',
    branchName: 'codex/issue-155',
    reportPath: '/tmp/report.json',
    host: 'local-host',
    ownerPid: 12345,
    leaseUpdatedAt: new Date(now.getTime() - SCOPED_RECOVERY_LEASE_STALE_MS).toISOString(),
    baseSha: 'base-sha',
  };
  for (const [key, fieldValue] of Object.entries(input)) {
    if (fieldValue === undefined) {
      delete value[key];
    } else {
      value[key] = fieldValue;
    }
  }
  return value as unknown as RunnerProcessMetadata;
}

async function writeCompletedReport(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      status: 'completed',
      changes: ['feature.txt'],
      validation: [
        {
          command: 'TDD red-to-green',
          status: 'passed',
          summary: 'Focused behavior test failed before implementation and passed after implementation.',
        },
        { command: '$code-review', status: 'passed', summary: 'No blocking findings.' },
      ],
      proofPlan: {
        mode: 'none',
        reason: 'Recovery fixture does not claim acceptance proof.',
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

function probe(result: ProcessProbeResult): () => ProcessProbeResult {
  return () => result;
}

test('classifies stale completed scoped run as completed-pending-handoff', async () => {
  const targetRoot = await tempRepo();
  const reportPath = join(targetRoot, 'report.json');
  await writeCompletedReport(reportPath);
  const run = metadata({ reportPath });

  const result = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run,
    issue: issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
    invocation: 'daemon',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'completed-pending-handoff');
  assert.equal(result.canMutate, true);
  assert.equal(result.beforeHead, 'base-sha');
});

test('classifies fresh same-host missing PID completed scoped run as completed-pending-handoff', async () => {
  const targetRoot = await tempRepo();
  const reportPath = join(targetRoot, 'report.json');
  await writeCompletedReport(reportPath);
  const run = metadata({
    reportPath,
    leaseUpdatedAt: new Date(now.getTime() - SCOPED_RECOVERY_LEASE_STALE_MS + 1).toISOString(),
  });
  const issue = issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] });

  const daemon = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run,
    issue,
    invocation: 'daemon',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });
  const status = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run,
    issue,
    invocation: 'status',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });

  assert.equal(daemon.status, 'completed-pending-handoff');
  assert.equal(daemon.canMutate, true);
  assert.equal(status.status, 'completed-pending-handoff');
  assert.equal(status.canMutate, false);
});

test('daemon leaves legacy and cross-host completed runs read-only', async () => {
  const targetRoot = await tempRepo();
  const reportPath = join(targetRoot, 'report.json');
  await writeCompletedReport(reportPath);
  await mkdir(join(targetRoot, validConfig.runner.stateDir, 'snapshots'), { recursive: true });
  await writeFile(
    join(targetRoot, validConfig.runner.stateDir, 'snapshots', 'issue-155-issue-155-session.json'),
    JSON.stringify({ repository: { base: { sha: 'legacy-base' } } }),
    'utf8',
  );
  const issue = issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] });

  const legacy = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run: metadata({ reportPath, baseSha: undefined, host: undefined, ownerPid: undefined, leaseUpdatedAt: undefined }),
    issue,
    invocation: 'daemon',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });
  const crossHost = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run: metadata({ reportPath, host: 'other-host' }),
    issue,
    invocation: 'daemon',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });

  assert.deepEqual([legacy.status, legacy.canMutate, legacy.beforeHead], ['unknown-or-foreign', false, 'legacy-base']);
  assert.deepEqual([crossHost.status, crossHost.canMutate], ['unknown-or-foreign', false]);
});

test('does not publish when base evidence is missing', async () => {
  const targetRoot = await tempRepo();
  const reportPath = join(targetRoot, 'report.json');
  await writeCompletedReport(reportPath);

  const result = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run: metadata({ reportPath, baseSha: undefined }),
    issue: issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
    invocation: 'targeted',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'unknown-or-foreign');
  assert.equal(result.canMutate, false);
  assert.equal(result.beforeHead, undefined);
});

test('lease policy distinguishes fresh alive missing unknown and cross-host cases', async () => {
  const targetRoot = await tempRepo();
  const reportPath = join(targetRoot, 'report.json');
  await writeCompletedReport(reportPath);
  const issue = issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] });

  const fresh = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run: metadata({ reportPath, leaseUpdatedAt: new Date(now.getTime() - SCOPED_RECOVERY_LEASE_STALE_MS + 1).toISOString() }),
    issue,
    invocation: 'targeted',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });
  const alive = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run: metadata({ reportPath }),
    issue,
    invocation: 'targeted',
    now,
    hostname: () => 'local-host',
    processProbe: probe('alive'),
  });
  const unknown = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run: metadata({ reportPath }),
    issue,
    invocation: 'targeted',
    now,
    hostname: () => 'local-host',
    processProbe: probe('unknown'),
  });
  const missing = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run: metadata({ reportPath }),
    issue,
    invocation: 'targeted',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });
  const crossHostStale = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run: metadata({ reportPath, host: 'other-host' }),
    issue,
    invocation: 'targeted',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });

  assert.equal(fresh.status, 'completed-pending-handoff');
  assert.equal(alive.status, 'active');
  assert.equal(unknown.status, 'active');
  assert.equal(missing.status, 'completed-pending-handoff');
  assert.equal(crossHostStale.status, 'completed-pending-handoff');
});

test('targeted recovery accepts already-running legacy snapshot-backed completed run', async () => {
  const targetRoot = await tempRepo();
  const reportPath = join(targetRoot, 'report.json');
  await writeCompletedReport(reportPath);
  await mkdir(join(targetRoot, validConfig.runner.stateDir, 'snapshots'), { recursive: true });
  await writeFile(
    join(targetRoot, validConfig.runner.stateDir, 'snapshots', 'issue-155-issue-155-session.json'),
    JSON.stringify({ repository: { base: { sha: 'legacy-base' } } }),
    'utf8',
  );
  await new RunnerStateStore(targetRoot, validConfig).save({
    version: 1,
    runs: [metadata({ reportPath, baseSha: undefined, host: undefined, ownerPid: undefined, leaseUpdatedAt: undefined })],
  });
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  const issue = await adapter.getIssue(155);

  const result = await classifyScopedRecoveryRun({
    targetRoot,
    config: validConfig,
    run: (await new RunnerStateStore(targetRoot, validConfig).load()).runs[0]!,
    issue,
    invocation: 'targeted',
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'completed-pending-handoff');
  assert.equal(result.canMutate, true);
  assert.equal(result.beforeHead, 'legacy-base');
});

test('recovery passes completed-report codex result without invoking codex', () => {
  assert.deepEqual(buildRecoveredCodexResult('/tmp/report.json'), {
    stdout: 'codex-orchestrator recovery reused completed report /tmp/report.json',
    stderr: '',
    exitCode: 0,
  });
});

test('recovers completed pending handoff by creating one draft PR', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  const reportPath = join(repo, 'report.json');
  await writeFile(join(worktreePath, 'feature.txt'), 'done\n', 'utf8');
  await writeCompletedReport(reportPath);
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath,
      logPath: join(repo, 'run.log'),
      host: hostname(),
      ownerPid: 99999999,
      baseSha,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter,
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  assert.deepEqual(issueAdapter.removedLabels.at(-1), { issueNumber: 155, labels: [labels.running.name] });
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 155, labels: [labels.review.name] });
  assert.match(issueAdapter.postedComments.at(-1)?.body ?? '', /codex-orchestrator review report for #155/);
  assert.deepEqual((await new RunnerStateStore(repo, validConfig).load()).runs, []);
  assert.equal(await readFile(join(worktreePath, 'feature.txt'), 'utf8'), 'done\n');
});

test('reuses matching open PR during recovery', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  const reportPath = join(repo, 'report.json');
  await writeFile(join(worktreePath, 'feature.txt'), 'done\n', 'utf8');
  await writeCompletedReport(reportPath);
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath,
      host: hostname(),
      ownerPid: 99999999,
      baseSha,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  await pullRequestAdapter.createDraftPullRequest({
    title: 'Existing',
    body: 'Existing body',
    headBranch: 'codex/issue-155',
    baseBranch: 'main',
  });

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter,
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'review-ready');
  assert.equal(result.pullRequest?.number, 1);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
});

test('recovery blocks when fresh-context review reports high-confidence policy violation', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  const config = {
    ...validConfig,
    loopPolicy: {
      ...validConfig.loopPolicy,
      freshContextReview: {
        ...validConfig.loopPolicy.freshContextReview,
        enabled: true,
      },
    },
  };
  await writeFile(join(repo, '.codex-orchestrator', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const reportPath = join(repo, 'report.json');
  await writeFile(join(worktreePath, 'feature.txt'), 'done\n', 'utf8');
  await writeCompletedReport(reportPath);
  await new RunnerStateStore(repo, config).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath,
      logPath: join(repo, 'run.log'),
      host: hostname(),
      ownerPid: 99999999,
      baseSha,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const phases: string[] = [];
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      phases.push(input.phase ?? '');
      await writeFile(
        input.reportPath,
        JSON.stringify({
          status: 'completed',
          findings: [
            {
              severity: 'policy-violation',
              confidence: 'high',
              summary: 'Recovered result violates handoff policy',
              evidence: 'fixture',
            },
          ],
          residualRisks: ['fresh review risk'],
        }),
        'utf8',
      );
      return { stdout: 'fresh review done', stderr: '', exitCode: 0 };
    },
  };

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(phases, ['fresh-context-review']);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.deepEqual(issueAdapter.addedLabels.at(-1), { issueNumber: 155, labels: [labels.blocked.name] });
  assert.match(result.reportComment, /Fresh-Context Review blocked publication/);
  assert.match(result.reportComment, /Recovered result violates handoff policy/);
});

test('retries stale missing completion report as next scoped attempt before blocking', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath: join(repo, 'missing-report.json'),
      logPath: join(repo, 'missing-run.log'),
      host: hostname(),
      ownerPid: 99999999,
      baseSha,
      retryCount: 0,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  const phases: string[] = [];
  const contexts: string[] = [];
  const codexAdapter = {
    async run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> {
      phases.push(input.phase ?? '');
      contexts.push(await readFile(input.contextArtifactPath, 'utf8'));
      await writeFile(join(input.worktreePath, 'feature.txt'), 'retried\n', 'utf8');
      await writeCompletedReport(input.reportPath);
      return { stdout: 'retry completed', stderr: '', exitCode: 0 };
    },
  };

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter,
    codexAdapter,
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'review-ready');
  assert.deepEqual(phases, ['scoped-issue']);
  assert.match(contexts[0] ?? '', /"attempt": 1/);
  assert.match(contexts[0] ?? '', /Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE/);
  assert.equal(issueAdapter.postedComments.some((comment) => comment.body.includes('claimed #155')), false);
  assert.equal(issueAdapter.postedComments.some((comment) => comment.body.includes('recovery-blocked')), false);
  assert.equal(pullRequestAdapter.createdPullRequests.length, 1);
  assert.deepEqual((await new RunnerStateStore(repo, validConfig).load()).runs, []);
  assert.equal(await readFile(join(worktreePath, 'feature.txt'), 'utf8'), 'retried\n');
});

test('recovery missing completion report blocks when retry budget is exhausted', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath: join(repo, 'missing-report.json'),
      logPath: join(repo, 'missing-run.log'),
      host: hostname(),
      ownerPid: 99999999,
      baseSha,
      retryCount: validConfig.loopPolicy.rework.maxAttempts,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');
  let codexRuns = 0;

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter,
    codexAdapter: {
      async run(): Promise<CodexCommandRunResult> {
        codexRuns += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(codexRuns, 0);
  assert.equal(issueAdapter.postedComments.length, 1);
  assert.match(issueAdapter.postedComments[0]?.body ?? '', /recovery-blocked/);
  assert.equal((await new RunnerStateStore(repo, validConfig).load()).runs[0]?.lastRecoveredAt, now.toISOString());
});

test('recovery missing completion report blocks when policy disables retry', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  const config = {
    ...validConfig,
    loopPolicy: {
      ...validConfig.loopPolicy,
      rework: {
        ...validConfig.loopPolicy.rework,
        retryableBlockers: validConfig.loopPolicy.rework.retryableBlockers
          .filter((blocker) => blocker !== 'missing-completion-report'),
      },
    },
  };
  await writeFile(join(repo, '.codex-orchestrator', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await new RunnerStateStore(repo, config).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath: join(repo, 'missing-report.json'),
      logPath: join(repo, 'missing-run.log'),
      host: hostname(),
      ownerPid: 99999999,
      baseSha,
      retryCount: 0,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  let codexRuns = 0;

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter: new InMemoryGitHubPullRequestAdapter('example', 'repo'),
    codexAdapter: {
      async run(): Promise<CodexCommandRunResult> {
        codexRuns += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(codexRuns, 0);
  assert.match(result.reportComment, /Recovered scoped run is stale, but the completion report is missing/);
});

test('recovery missing completion report blocks when stale attempt left uncommitted changes', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  await writeFile(join(worktreePath, 'dirty.txt'), 'unreported\n', 'utf8');
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath: join(repo, 'missing-report.json'),
      logPath: join(repo, 'missing-run.log'),
      host: hostname(),
      ownerPid: 99999999,
      baseSha,
      retryCount: 0,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  let codexRuns = 0;

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter: new InMemoryGitHubPullRequestAdapter('example', 'repo'),
    codexAdapter: {
      async run(): Promise<CodexCommandRunResult> {
        codexRuns += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(codexRuns, 0);
  assert.match(result.reportComment, /Recovered scoped run is stale, but the completion report is missing/);
});

test('recovery missing completion report blocks when stale attempt left staged changes', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  await writeFile(join(worktreePath, 'staged.txt'), 'unreported staged\n', 'utf8');
  await execFileAsync('git', ['-C', worktreePath, 'add', 'staged.txt']);
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath: join(repo, 'missing-report.json'),
      logPath: join(repo, 'missing-run.log'),
      host: hostname(),
      ownerPid: 99999999,
      baseSha,
      retryCount: 0,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  let codexRuns = 0;

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter: new InMemoryGitHubPullRequestAdapter('example', 'repo'),
    codexAdapter: {
      async run(): Promise<CodexCommandRunResult> {
        codexRuns += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(codexRuns, 0);
});

test('recovery missing completion report blocks when stale attempt left tracked unstaged changes', async () => {
  const { repo, worktreePath } = await tempGitProject();
  await writeFile(join(worktreePath, 'tracked.txt'), 'tracked\n', 'utf8');
  await execFileAsync('git', ['-C', worktreePath, 'add', 'tracked.txt']);
  await execFileAsync('git', ['-C', worktreePath, 'commit', '-m', 'Add tracked fixture']);
  const trackedBaseSha = (await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(worktreePath, 'tracked.txt'), 'tracked changed without report\n', 'utf8');
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath: join(repo, 'missing-report.json'),
      logPath: join(repo, 'missing-run.log'),
      host: hostname(),
      ownerPid: 99999999,
      baseSha: trackedBaseSha,
      retryCount: 0,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  let codexRuns = 0;

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter: new InMemoryGitHubPullRequestAdapter('example', 'repo'),
    codexAdapter: {
      async run(): Promise<CodexCommandRunResult> {
        codexRuns += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(codexRuns, 0);
});

test('recovery missing completion report blocks when stale attempt left committed changes', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  await writeFile(join(worktreePath, 'committed.txt'), 'unreported commit\n', 'utf8');
  await execFileAsync('git', ['-C', worktreePath, 'add', 'committed.txt']);
  await execFileAsync('git', ['-C', worktreePath, 'commit', '-m', 'Unreported stale work']);
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath: join(repo, 'missing-report.json'),
      logPath: join(repo, 'missing-run.log'),
      host: hostname(),
      ownerPid: 99999999,
      baseSha,
      retryCount: 0,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  let codexRuns = 0;

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter: new InMemoryGitHubPullRequestAdapter('example', 'repo'),
    codexAdapter: {
      async run(): Promise<CodexCommandRunResult> {
        codexRuns += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    now,
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(codexRuns, 0);
  assert.match(result.reportComment, /Recovered scoped run is stale, but the completion report is missing/);
});

test('targeted recovery missing completion report does not retry cross-host stale runs', async () => {
  const { repo, baseSha, worktreePath } = await tempGitProject();
  await new RunnerStateStore(repo, validConfig).save({
    version: 1,
    runs: [metadata({
      workspacePath: worktreePath,
      reportPath: join(repo, 'missing-report.json'),
      logPath: join(repo, 'missing-run.log'),
      host: 'other-host',
      ownerPid: 99999999,
      baseSha,
      retryCount: 0,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  let codexRuns = 0;

  const result = await recoverScopedRun({
    targetRoot: repo,
    issueNumber: 155,
    invocation: 'targeted',
    issueAdapter,
    pullRequestAdapter: new InMemoryGitHubPullRequestAdapter('example', 'repo'),
    codexAdapter: {
      async run(): Promise<CodexCommandRunResult> {
        codexRuns += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    now,
    hostname: () => 'local-host',
    processProbe: probe('missing'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(codexRuns, 0);
  assert.match(result.reportComment, /Recovered scoped run is stale, but the completion report is missing/);
});

test('recovery blocked comment uses stable marker and is not duplicated', async () => {
  const targetRoot = await tempRepo();
  await new RunnerStateStore(targetRoot, validConfig).save({
    version: 1,
    runs: [metadata({
      reportPath: join(targetRoot, 'missing-report.json'),
      logPath: join(targetRoot, 'run.log'),
      host: hostname(),
      ownerPid: 99999999,
    })],
  });
  const issueAdapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 155, labels: [labels.running.name, labels.auto.name] }),
  ]);
  const pullRequestAdapter = new InMemoryGitHubPullRequestAdapter('example', 'repo');

  await recoverScopedRun({
    targetRoot,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter,
    now,
    processProbe: probe('missing'),
  });
  await recoverScopedRun({
    targetRoot,
    issueNumber: 155,
    invocation: 'daemon',
    issueAdapter,
    pullRequestAdapter,
    now: new Date(now.getTime() + 1),
    processProbe: probe('missing'),
  });

  assert.equal(pullRequestAdapter.createdPullRequests.length, 0);
  assert.equal(issueAdapter.postedComments.length, 1);
  assert.equal(issueAdapter.addedLabels.length, 1);
  assert.equal(issueAdapter.removedLabels.length, 1);
  assert.match(issueAdapter.postedComments[0]?.body ?? '', /<!-- codex-orchestrator:recovery-blocked issue=155 session=issue-155-session -->/);
  assert.equal((await new RunnerStateStore(targetRoot, validConfig).load()).runs[0]?.lastRecoveredAt, '2026-05-08T12:00:00.001Z');
});
