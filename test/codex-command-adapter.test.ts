import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { CodexCommandAdapter, type AppServerOwner } from '../src/codex/command-adapter.js';
import type { CodexExecutionRunInputV2, CodexExecutionRunResultV2 } from '../src/codex/execution-adapter.js';
import { migrateConfigV1ToV2 } from '../src/setup/skill-runtime-v2-migration.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import { skillExecutionPolicyHash } from '../src/runner/skill-runtime-execution.js';
import { loadPackageSkillBundle } from '../src/skills/package-skill-bundle.js';
import { startOperationGraph } from '../src/skills/package-skill-graph.js';
import { validConfig } from './fixtures/config.js';

const execFileAsync = promisify(execFile);

test('codex command adapter rejects legacy exec config', () => {
  assert.throws(() => new CodexCommandAdapter(validConfig as any), /orchestrator-codex-adapter-v2-required/);
});

test('codex command adapter verifies version and pinned catalog before starting app-server owner', async () => {
  const events: string[] = [];
  const input = await runInput();
  const adapter = new CodexCommandAdapter(input.config, {
    sourceEnv: { PATH: process.env.PATH ?? '' },
    versionChecker: async (command, version) => { events.push(`version:${command}:${version}`); },
    toolCatalogLoader: async (path) => { events.push(`catalog:${path.endsWith('codex-0.144.4.json')}`); },
    ownerFactory: async () => {
      events.push('owner');
      return fakeOwner();
    },
  });

  const result = await adapter.run(input);

  assert.equal(result.status, 'completed');
  assert.deepEqual(events, ['version:codex:0.144.4', 'catalog:true', 'owner']);
});

test('codex command adapter closes an incomplete graph owner before another run starts', async () => {
  const input = await runInput();
  let ownerCount = 0;
  let closeCount = 0;
  const adapter = new CodexCommandAdapter(input.config, {
    sourceEnv: { PATH: process.env.PATH ?? '' },
    versionChecker: async () => {},
    toolCatalogLoader: async () => {},
    ownerFactory: async () => {
      ownerCount += 1;
      return fakeOwner(() => { closeCount += 1; });
    },
  });

  await adapter.run(input);
  await adapter.run({ ...input, attemptId: 'attempt-2' });
  await adapter.closeRun({ runId: input.runId, reason: 'completed' });
  await adapter.closeRun({ runId: input.runId, reason: 'completed' });

  assert.equal(ownerCount, 2);
  assert.equal(closeCount, 2);
});

test('codex command adapter retains an owner until failed close cleanup can be retried', async () => {
  const input = await runInput();
  let closeAttempts = 0;
  const adapter = new CodexCommandAdapter(input.config, {
    sourceEnv: { PATH: process.env.PATH ?? '' }, versionChecker: async () => {}, toolCatalogLoader: async () => {},
    ownerFactory: async () => ({
      session: fakeOwner().session,
      async close() {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error('close-cleanup-failed-once');
      },
    }),
  });

  await assert.rejects(adapter.run(input), /close-cleanup-failed-once/);
  assert.equal(closeAttempts, 2);
  await adapter.closeRun({ runId: input.runId, reason: 'runner-shutdown' });
  assert.equal(closeAttempts, 2);
});

test('codex command adapter executes every signed plan-parent graph node in order', async () => {
  const input = await runInput('plan-parent');
  const visited: string[] = [];
  const outcomes: Record<string, 'succeeded' | 'approved'> = {
    'to-spec': 'succeeded',
    'to-tickets': 'succeeded',
    'tickets-breakdown-review': 'approved',
    triage: 'succeeded',
  };
  const adapter = new CodexCommandAdapter(input.config, {
    sourceEnv: { PATH: process.env.PATH ?? '' },
    versionChecker: async () => {},
    toolCatalogLoader: async () => {},
    ownerFactory: async () => ({
      session: {
        async run(nodeInput): Promise<CodexExecutionRunResultV2> {
          visited.push(nodeInput.nodeId);
          const outcome = outcomes[nodeInput.nodeId]!;
          return {
            exitCode: 0, stdout: '', stderr: '', status: 'completed', attemptId: nodeInput.attemptId,
            expectedToolCatalogHash: 'hash', recovery: 'none',
            controlEnvelope: { version: 1, nodeId: nodeInput.nodeId, outcome, artifactRefs: [`artifact://${nodeInput.nodeId}`], result: { nodeId: nodeInput.nodeId } },
          };
        },
        async interrupt() {},
      },
      async close() {},
    }),
  });
  const result = await adapter.run(input);
  assert.equal(result.status, 'completed');
  assert.deepEqual(visited, ['to-spec', 'to-tickets', 'tickets-breakdown-review', 'triage']);
});

test('codex command adapter expands mandatory code-review fan-out before final aggregation', async () => {
  const input = await runInput();
  const visited: string[] = [];
  const outcomes: Record<string, any> = {
    'scoped-classification': 'route-small',
    'small-task-implementer': 'succeeded',
    'cleanup-review': 'approved',
    'A-full': 'approved',
    'B-full': 'approved',
    'C-full': 'approved',
    'final-aggregation': 'approved',
  };
  const adapter = new CodexCommandAdapter(input.config, {
    sourceEnv: { PATH: process.env.PATH ?? '' }, versionChecker: async () => {}, toolCatalogLoader: async () => {},
    ownerFactory: async () => ({
      session: {
        async run(nodeInput): Promise<CodexExecutionRunResultV2> {
          visited.push(nodeInput.nodeId);
          return {
            exitCode: 0, stdout: '', stderr: '', status: 'completed', attemptId: nodeInput.attemptId,
            threadId: `thread-${nodeInput.nodeId}`, expectedToolCatalogHash: 'hash', recovery: 'none',
            controlEnvelope: {
              version: 1, nodeId: nodeInput.nodeId, outcome: outcomes[nodeInput.nodeId],
              artifactRefs: [`artifact://${nodeInput.nodeId}`],
              result: nodeInput.nodeId === 'final-aggregation' ? { verdict: 'Approved', findingIds: [] } : { findingIds: [] },
            },
          };
        },
        async interrupt() {},
      },
      async close() {},
    }),
  });
  const result = await adapter.run(input);
  assert.equal(result.status, 'completed');
  assert.deepEqual(visited.slice(0, 3), ['scoped-classification', 'small-task-implementer', 'cleanup-review']);
  assert.deepEqual([...visited.slice(3, 5)].sort(), ['A-full', 'B-full']);
  assert.deepEqual(visited.slice(5), ['C-full', 'final-aggregation']);
});

test('codex command adapter repairs full-review findings before same-thread closure', async () => {
  const input = await runInput();
  const visited: Array<{ nodeId: string; resumeThreadId?: string }> = [];
  const adapter = new CodexCommandAdapter(input.config, {
    sourceEnv: { PATH: process.env.PATH ?? '' }, versionChecker: async () => {}, toolCatalogLoader: async () => {},
    ownerFactory: async () => ({
      session: {
        async run(nodeInput): Promise<CodexExecutionRunResultV2> {
          visited.push({ nodeId: nodeInput.nodeId, resumeThreadId: nodeInput.resumeThreadId });
          const outcome = nodeInput.nodeId === 'scoped-classification' ? 'route-small'
            : nodeInput.nodeId === 'A-full' ? 'needs-work'
            : nodeInput.nodeId.startsWith('review-repair-') || nodeInput.nodeId === 'small-task-implementer' ? 'succeeded'
            : 'approved';
          const findingIds = nodeInput.nodeId === 'A-full' ? ['REV-001'] : [];
          const threadId = nodeInput.resumeThreadId ?? `thread-${nodeInput.nodeId}`;
          return {
            exitCode: 0, stdout: '', stderr: '', status: 'completed', attemptId: nodeInput.attemptId,
            threadId, expectedToolCatalogHash: 'hash', recovery: 'none',
            controlEnvelope: {
              version: 1, nodeId: nodeInput.nodeId, outcome, artifactRefs: [`artifact://${nodeInput.nodeId}`],
              result: nodeInput.nodeId === 'final-aggregation' ? { verdict: 'Approved', findingIds } : { findingIds },
            },
          };
        },
        async interrupt() {},
      },
      async close() {},
    }),
  });
  await adapter.run(input);
  const repairIndex = visited.findIndex((entry) => entry.nodeId === 'review-repair-1');
  const closureIndex = visited.findIndex((entry) => entry.nodeId === 'A-closure');
  assert.ok(repairIndex > visited.findIndex((entry) => entry.nodeId === 'A-full'));
  assert.ok(closureIndex > repairIndex);
  assert.equal(visited[closureIndex]?.resumeThreadId, 'thread-A-full');
});

test('review fan-out waits for healthy siblings before closing after one reviewer fails', async () => {
  const input = await runInput();
  const events: string[] = [];
  const adapter = new CodexCommandAdapter(input.config, {
    sourceEnv: { PATH: process.env.PATH ?? '' }, versionChecker: async () => {}, toolCatalogLoader: async () => {},
    ownerFactory: async () => ({
      session: {
        async run(nodeInput): Promise<CodexExecutionRunResultV2> {
          if (nodeInput.nodeId === 'A-full') {
            await delay(5);
            events.push('A-failed');
            throw new Error('reviewer-a-failed');
          }
          if (nodeInput.nodeId === 'B-full') {
            await delay(30);
            events.push('B-completed');
          }
          const outcome = nodeInput.nodeId === 'scoped-classification' ? 'route-small'
            : nodeInput.nodeId === 'small-task-implementer' ? 'succeeded'
            : 'approved';
          return {
            exitCode: 0, stdout: '', stderr: '', status: 'completed', attemptId: nodeInput.attemptId,
            threadId: `thread-${nodeInput.nodeId}`, expectedToolCatalogHash: 'hash', recovery: 'none',
            controlEnvelope: { version: 1, nodeId: nodeInput.nodeId, outcome, artifactRefs: [`artifact://${nodeInput.nodeId}`], result: { findingIds: [] } },
          };
        },
        async interrupt() {},
      },
      async close() { events.push('owner-closed'); },
    }),
  });

  await assert.rejects(adapter.run(input), /reviewer-a-failed/);
  assert.deepEqual(events, ['A-failed', 'B-completed', 'owner-closed']);
});

test('adapter persists protocol death only after the owned process group is closed', async () => {
  const input = await runInput();
  await execFileAsync('git', ['init', '-q', input.worktreePath]);
  await execFileAsync('git', ['-C', input.worktreePath, 'config', 'user.name', 'Test']);
  await execFileAsync('git', ['-C', input.worktreePath, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(input.worktreePath, 'tracked.txt'), 'base\n');
  await execFileAsync('git', ['-C', input.worktreePath, 'add', 'tracked.txt']);
  await execFileAsync('git', ['-C', input.worktreePath, 'commit', '-qm', 'base']);
  const { manifest } = await loadPackageSkillBundle();
  const stateDir = join(input.targetRoot, input.config.runner.stateDir);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'runner-state.json'), `${JSON.stringify({
    version: 2,
    generation: 0,
    runs: [{
      issueNumber: input.issueNumber, mode: 'scoped-issue', workspacePath: input.worktreePath, sessionId: input.sessionId,
      retryCount: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), stateVersion: 2,
      runId: input.runId, skillRuntime: input.skillRuntime, executionPolicyHash: skillExecutionPolicyHash(input.manifestNode),
      effectivePolicySummary: input.targetPolicy, graph: startOperationGraph(manifest, input.operationId),
    }],
  }, null, 2)}\n`);
  const events: string[] = [];
  const adapter = new CodexCommandAdapter(input.config, {
    sourceEnv: { PATH: process.env.PATH ?? '' }, versionChecker: async () => {}, toolCatalogLoader: async () => {},
    ownerFactory: async () => ({
      process: { pid: process.pid }, processGroupId: process.pid,
      session: {
        async run() { throw new Error('orchestrator-app-server-protocol-death: pipe closed'); },
        async interrupt() {},
      },
      async close() { events.push('process-group-closed'); },
    }),
  });

  const result = await adapter.run(input);
  const state = await new RunnerStateStore(input.targetRoot, input.config as any).load();
  const execution = (state.runs[0] as any).graph.attempts[0].executions[0];

  assert.equal(result.status, 'protocol-death');
  assert.deepEqual(events, ['process-group-closed']);
  assert.equal(execution.status, 'blocked');
  assert.equal(execution.terminal.kind, 'protocol-death');
  assert.equal(execution.terminal.quiescenceProof, 'process-group-absent');
});

async function runInput(operationId = 'implementation-attempt'): Promise<CodexExecutionRunInputV2> {
  const { manifest } = await loadPackageSkillBundle();
  const root = await mkdtemp(join(tmpdir(), 'codex-adapter-v2-'));
  const contextArtifactPath = join(root, 'context.json');
  await writeFile(contextArtifactPath, '{}');
  const operation = manifest.operations[operationId]!;
  const node = manifest.graphs[operation.graph]!.nodes.find((item) => item.id === operation.entryNode)!;
  const config = migrateConfigV1ToV2({ ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: false } } });
  return {
    targetRoot: root,
    worktreePath: root,
    config,
    runId: 'run-1',
    issueNumber: 155,
    sessionId: 'session-1',
    branchName: 'codex/issue-155',
    phase: 'scoped-issue',
    operationId,
    nodeId: node.id,
    attemptId: 'attempt-1',
    skillRuntime: {
      packageVersion: manifest.package.version,
      bundleHash: manifest.bundleHash,
      bundleRoot: resolve('runtime-skills'),
      operationId,
      entrySkillPath: node.skill,
    },
    manifestNode: node,
    targetPolicy: config.codex.targetPolicy,
    contextArtifactPath,
    reportPath: join(root, 'report.json'),
    logPath: join(root, 'run.log'),
    phaseEnv: {},
  };
}

function fakeOwner(onClose?: () => void): AppServerOwner {
  return {
    session: {
      async run(input): Promise<CodexExecutionRunResultV2> {
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          logPath: input.logPath,
          status: 'completed',
          attemptId: input.attemptId,
          expectedToolCatalogHash: 'd93bcca0743ca4e8431ed81e418c72b5cd09c5f83f68dbe9410f0d9a6a969478',
          recovery: 'none',
        };
      },
      async interrupt() {},
    },
    async close() { onClose?.(); },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
