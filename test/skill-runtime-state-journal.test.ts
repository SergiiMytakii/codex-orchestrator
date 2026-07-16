import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import type { CodexExecutionRunInputV2 } from '../src/codex/execution-adapter.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import { SkillRuntimeStateJournal } from '../src/runner/skill-runtime-state-journal.js';
import { startOperationGraph } from '../src/skills/package-skill-graph.js';
import { loadPackageSkillBundle } from '../src/skills/package-skill-bundle.js';
import { migrateConfigV1ToV2 } from '../src/setup/skill-runtime-v2-migration.js';
import { validConfig } from './fixtures/config.js';

const execFileAsync = promisify(execFile);

test('skill runtime journal persists prepared, running, terminal, reconciled, and protocol-death states', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-runtime-journal-'));
  await execFileAsync('git', ['init', '-q', root]);
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test']);
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(root, 'file.txt'), 'base\n');
  await writeFile(join(root, '.gitignore'), '.codex-orchestrator/\n');
  await execFileAsync('git', ['-C', root, 'add', 'file.txt', '.gitignore']);
  await execFileAsync('git', ['-C', root, 'commit', '-qm', 'base']);
  const { manifest } = await loadPackageSkillBundle();
  const config = migrateConfigV1ToV2({ ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: false } } });
  const stateDir = join(root, config.runner.stateDir);
  await mkdir(stateDir, { recursive: true });
  const reportPath = join(stateDir, 'report.json');
  await writeFile(join(stateDir, 'runner-state.json'), `${JSON.stringify({ version: 2, generation: 0, runs: [{
    issueNumber: 1, mode: 'scoped-issue', workspacePath: root, sessionId: 'session', retryCount: 0,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  }] }, null, 2)}\n`);
  const node = manifest.graphs['implementation-attempt']!.nodes.find((candidate) => candidate.id === 'scoped-classification')!;
  const input: CodexExecutionRunInputV2 = {
    targetRoot: root, worktreePath: root, config, runId: 'run-1', issueNumber: 1, sessionId: 'session', branchName: 'branch', phase: 'scoped-issue',
    operationId: 'implementation-attempt', nodeId: node.id, attemptId: 'attempt-1',
    skillRuntime: { packageVersion: manifest.package.version, bundleHash: manifest.bundleHash, bundleRoot: resolve('runtime-skills'), operationId: 'implementation-attempt', entrySkillPath: node.skill },
    manifestNode: node, targetPolicy: config.codex.targetPolicy, contextArtifactPath: join(stateDir, 'context.json'), reportPath, logPath: join(stateDir, 'run.log'), phaseEnv: {},
  };
  const journal = await SkillRuntimeStateJournal.open(input, manifest, startOperationGraph(manifest, input.operationId));
  assert.ok(journal);
  const executionId = await journal.prepare(input);
  await journal.running({ attemptId: input.attemptId, executionId, pid: process.pid, processGroupId: process.pid });
  await journal.appServer({ attemptId: input.attemptId, executionId, threadId: 'thread', turnId: 'turn' });
  await writeFile(reportPath, '{}\n');
  await journal.terminal({
    attemptId: input.attemptId, executionId,
    result: { exitCode: 0, stdout: '', stderr: '', status: 'completed', attemptId: input.attemptId, threadId: 'thread', turnId: 'turn', expectedToolCatalogHash: 'hash', recovery: 'none' },
  });
  await journal.transition({ version: 1, nodeId: node.id, outcome: 'route-small', artifactRefs: ['artifact://classification'], result: {} });
  const nextNode = manifest.graphs['implementation-attempt']!.nodes.find((candidate) => candidate.id === 'small-task-implementer')!;
  const nextInput = { ...input, nodeId: nextNode.id, attemptId: 'attempt-2', manifestNode: nextNode };
  const failedExecutionId = await journal.prepare(nextInput);
  await journal.running({ attemptId: nextInput.attemptId, executionId: failedExecutionId, pid: process.pid, processGroupId: process.pid });
  await journal.protocolDeath({ attemptId: nextInput.attemptId, executionId: failedExecutionId, reason: 'orchestrator-app-server-protocol-death' });
  const cleanRetry = await journal.prepareRecovery(nextInput);
  assert.equal(cleanRetry?.kind, 'clean-retry');
  await journal.running({ attemptId: nextInput.attemptId, executionId: cleanRetry!.executionId, pid: process.pid, processGroupId: process.pid });
  await journal.blocked({ attemptId: nextInput.attemptId, executionId: cleanRetry!.executionId, reason: 'retry interrupted', recovery: 'partial-node-mutation' });
  await writeFile(join(root, 'file.txt'), 'partial implementation\n');
  const partialContinuation = await journal.prepareRecovery(nextInput);
  assert.equal(partialContinuation?.kind, 'partial-continuation');
  const state = await new RunnerStateStore(root, config as any).load();
  assert.equal(state.version, 2);
  const run = state.runs[0] as any;
  assert.equal(run.graph.currentNodeId, 'small-task-implementer');
  assert.equal(run.graph.attempts[0].status, 'reconciled');
  assert.equal(run.graph.attempts[0].executions[0].report.atomicWriteComplete, true);
  assert.equal(run.graph.attempts[1].status, 'prepared');
  assert.equal(run.graph.attempts[1].executions[0].terminal.kind, 'protocol-death');
  assert.equal(run.graph.attempts[1].executions[0].terminal.quiescenceProof, 'process-group-absent');
  assert.equal(run.graph.attempts[1].cleanRetriesConsumed, 1);
  assert.equal(run.graph.attempts[1].partialContinuationsConsumed, 1);
});

test('read-only node mutation cannot enter partial continuation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-runtime-read-only-'));
  await execFileAsync('git', ['init', '-q', root]);
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test']);
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(root, 'file.txt'), 'base\n');
  await writeFile(join(root, '.gitignore'), '.codex-orchestrator/\n');
  await execFileAsync('git', ['-C', root, 'add', 'file.txt', '.gitignore']);
  await execFileAsync('git', ['-C', root, 'commit', '-qm', 'base']);
  const { manifest } = await loadPackageSkillBundle();
  const config = migrateConfigV1ToV2({ ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: false } } });
  const stateDir = join(root, config.runner.stateDir);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'runner-state.json'), `${JSON.stringify({ version: 2, generation: 0, runs: [{
    issueNumber: 1, mode: 'scoped-issue', workspacePath: root, sessionId: 'session', retryCount: 0,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  }] }, null, 2)}\n`);
  const node = manifest.graphs['implementation-attempt']!.nodes.find((candidate) => candidate.id === 'scoped-classification')!;
  const input: CodexExecutionRunInputV2 = {
    targetRoot: root, worktreePath: root, config, runId: 'run-read-only', issueNumber: 1, sessionId: 'session', branchName: 'branch', phase: 'scoped-issue',
    operationId: 'implementation-attempt', nodeId: node.id, attemptId: 'attempt-read-only',
    skillRuntime: { packageVersion: manifest.package.version, bundleHash: manifest.bundleHash, bundleRoot: resolve('runtime-skills'), operationId: 'implementation-attempt', entrySkillPath: node.skill },
    manifestNode: node, targetPolicy: config.codex.targetPolicy, contextArtifactPath: join(stateDir, 'context.json'), reportPath: join(stateDir, 'report.json'), logPath: join(stateDir, 'run.log'), phaseEnv: {},
  };
  const journal = await SkillRuntimeStateJournal.open(input, manifest, startOperationGraph(manifest, input.operationId));
  assert.ok(journal);
  const executionId = await journal.prepare(input);
  await journal.running({ attemptId: input.attemptId, executionId, pid: process.pid, processGroupId: process.pid });
  await journal.blocked({ attemptId: input.attemptId, executionId, reason: 'read-only node changed worktree', recovery: 'partial-node-mutation' });
  await writeFile(join(root, 'file.txt'), 'unauthorized mutation\n');

  assert.equal(await journal.prepareRecovery(input), undefined);
});

test('latest-state mutations serialize concurrent journals without rejecting a stale generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-runtime-cas-'));
  const config = migrateConfigV1ToV2({ ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: false } } });
  const stateDir = join(root, config.runner.stateDir);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'runner-state.json'), `${JSON.stringify({ version: 2, generation: 0, runs: [] }, null, 2)}\n`);
  const left = new RunnerStateStore(root, config as any);
  const right = new RunnerStateStore(root, config as any);
  const run = (issueNumber: number) => ({
    issueNumber, mode: 'scoped-issue' as const, workspacePath: root, sessionId: `session-${issueNumber}`,
    retryCount: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  });

  await Promise.all([
    left.mutateLatestV2((state) => ({ ...state, runs: [...state.runs, run(1)] })),
    right.mutateLatestV2((state) => ({ ...state, runs: [...state.runs, run(2)] })),
  ]);

  const state = await left.load();
  assert.equal(state.version, 2);
  assert.equal(state.generation, 2);
  assert.deepEqual(state.runs.map((candidate) => candidate.issueNumber).sort(), [1, 2]);
});
