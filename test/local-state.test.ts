import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  RunnerStateStore,
  type RunnerProcessMetadata,
  type RunnerProcessMetadataV2,
  type RunnerStateFileV2,
} from '../src/runner/local-state.js';
import { validConfig } from './fixtures/config.js';
import { loadPackageSkillBundle } from '../src/skills/package-skill-bundle.js';

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-orchestrator-state-'));
}

function metadataV2(issueNumber: number): RunnerProcessMetadataV2 {
  return {
    ...metadata(issueNumber),
    stateVersion: 2,
    runId: `run-${issueNumber}`,
    skillRuntime: {
      packageVersion: '0.1.51',
      bundleHash: 'a'.repeat(64),
      bundleRoot: `.codex-orchestrator/state/runtime-bundles/0.1.51-${'a'.repeat(64)}`,
      operationId: 'implementation-attempt',
      entrySkillPath: 'skills/spec-implementer/SKILL.md',
    },
    executionPolicyHash: 'b'.repeat(64),
    effectivePolicySummary: {
      network: 'deny', networkHosts: [], writableRootClasses: ['target-state'], mcpServers: {},
    },
    graph: {
      graphId: 'implementation-attempt', currentNodeId: 'spec-implementer', completedNodeIds: [], joinIds: [], artifactRefs: [],
      reviewBudget: { maximum: 6, consumed: 0 }, reviewers: [], findings: [], closureCount: 0, attempts: [],
    },
  };
}

function metadata(issueNumber: number): RunnerProcessMetadata {
  return {
    issueNumber,
    mode: 'scoped-issue',
    workspacePath: `.codex-orchestrator/workspaces/${issueNumber}`,
    sessionId: `session-${issueNumber}`,
    retryCount: 0,
    createdAt: '2026-05-08T10:00:00.000Z',
    updatedAt: '2026-05-08T10:00:00.000Z',
  };
}

test('local state loads missing file as empty state and writes under configured state dir', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);

  assert.equal(store.statePath(), join(targetRoot, validConfig.runner.stateDir, 'runner-state.json'));
  assert.deepEqual(await store.load(), { version: 1, runs: [] });
});

test('local state upserts, removes, and persists metadata-only shape', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);

  await store.upsertRun(metadata(2));
  await store.upsertRun(metadata(1));
  await store.upsertRun({ ...metadata(2), retryCount: 1, logPath: '.codex-orchestrator/state/logs/issue-2.log' });

  assert.deepEqual((await store.load()).runs.map((run) => [run.issueNumber, run.retryCount]), [
    [1, 0],
    [2, 1],
  ]);
  assert.equal((await store.load()).runs.find((run) => run.issueNumber === 2)?.logPath, '.codex-orchestrator/state/logs/issue-2.log');

  await store.removeRun(1);
  assert.deepEqual((await store.load()).runs.map((run) => run.issueNumber), [2]);

  const persisted = JSON.parse(await readFile(store.statePath(), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted).sort(), ['runs', 'version']);
});

test('local state accepts recovery lease/base metadata and preserves legacy metadata', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);
  const legacy = metadata(1);
  const recoveryReady: RunnerProcessMetadata = {
    ...metadata(2),
    ownerPid: 12345,
    host: 'runner-host',
    leaseUpdatedAt: '2026-05-08T10:01:00.000Z',
    attemptStartedAt: '2026-05-08T10:00:00.000Z',
    baseSha: 'abc123',
    snapshotPath: '.codex-orchestrator/state/snapshots/issue-2-session-2.json',
  };

  await store.save({ version: 1, runs: [legacy, recoveryReady] });

  assert.deepEqual(await store.load(), { version: 1, runs: [legacy, recoveryReady] });
  await assert.rejects(
    store.save({ version: 1, runs: [{ ...recoveryReady, ownerPid: 1.5 }] }),
    /runner metadata ownerPid must be an integer/,
  );
  await assert.rejects(
    store.save({ version: 1, runs: [{ ...recoveryReady, baseSha: '' }] }),
    /runner metadata baseSha must be a non-empty string/,
  );
});

test('local state concurrent saves do not collide on temp file names', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);

  await Promise.all([
    store.save({ version: 1, runs: [metadata(1)] }),
    store.save({ version: 1, runs: [metadata(2)] }),
  ]);

  const persisted = JSON.parse(await readFile(store.statePath(), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted).sort(), ['runs', 'version']);
  assert.ok(Array.isArray(persisted.runs));
});

test('local state serializes concurrent mutations without losing runs', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig, { hostId: 'host-a', bootNonce: 'boot-a', isProcessAlive: () => true });

  await Promise.all([store.upsertRun(metadata(1)), store.upsertRun(metadata(2)), store.upsertRun(metadata(3))]);

  assert.deepEqual((await store.load()).runs.map((run) => run.issueNumber), [1, 2, 3]);
});

test('local state rejects forbidden GitHub snapshot keys', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);

  await assert.rejects(
    store.save({
      version: 1,
      runs: [{ ...metadata(1), labels: ['agent:running'] } as unknown as RunnerProcessMetadata],
    }),
    /forbidden key labels/,
  );
  await assert.rejects(
    store.save({
      version: 1,
      runs: [{ ...metadata(1), comments: [] } as unknown as RunnerProcessMetadata],
    }),
    /forbidden key comments/,
  );
  await assert.rejects(
    store.save({
      version: 1,
      runs: [{ ...metadata(1), body: 'issue body' } as unknown as RunnerProcessMetadata],
    }),
    /forbidden key body/,
  );
  await assert.rejects(
    store.save({
      version: 1,
      runs: [{ ...metadata(1), questions: [] } as unknown as RunnerProcessMetadata],
    }),
    /forbidden key questions/,
  );
  await assert.rejects(
    store.save({
      version: 1,
      runs: [{ ...metadata(1), pullRequests: [] } as unknown as RunnerProcessMetadata],
    }),
    /forbidden key pullRequests/,
  );
});

test('bridge config v1 preserves the forward-compatible v2 envelope with legacy runs', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);
  const emptyV2: RunnerStateFileV2 = { version: 2, generation: 7, runs: [] };

  await store.save(emptyV2);
  assert.deepEqual(await store.load(), emptyV2);

  await store.upsertRun(metadata(2));
  assert.deepEqual(await store.load(), { version: 2, generation: 8, runs: [metadata(2)] });

  await store.removeRun(2);
  assert.deepEqual(await store.load(), { version: 2, generation: 9, runs: [] });
});

test('bridge state rejects invalid v2 generation and structural run metadata', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig);

  await assert.rejects(
    store.save({ version: 2, generation: -1, runs: [] } as RunnerStateFileV2),
    /generation must be a non-negative integer/,
  );
  await assert.rejects(
    store.save({
      version: 2,
      generation: 0,
      runs: [{ ...metadata(1), skillRuntime: {} } as unknown as RunnerProcessMetadata],
    }),
    /forbidden key skillRuntime/,
  );
});

test('state v2 requires exact structural run metadata and advances generation through CAS mutation', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig, { hostId: 'host-a', bootNonce: 'boot-a', isProcessAlive: () => true });
  await store.save({ version: 2, generation: 0, runs: [] });

  const updated = await store.mutateV2(0, (state) => ({ ...state, runs: [metadataV2(7)] }));

  assert.equal(updated.generation, 1);
  assert.deepEqual(updated.runs, [metadataV2(7)]);
  await assert.rejects(store.mutateV2(0, (state) => state), /stale generation/);
  const retried = await store.mutateV2(1, (state) => ({ ...state, runs: [...state.runs, metadataV2(8)] }));
  assert.equal(retried.generation, 2);
  assert.deepEqual(retried.runs.map((run) => run.issueNumber), [7, 8]);
  await assert.rejects(store.save({ version: 2, generation: 3, runs: [{ ...metadataV2(9), executionPolicyHash: 'bad' }] }), /executionPolicyHash/);
});

test('state v2 persists node artifacts and successor in one locked generation', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig, { hostId: 'host-a', bootNonce: 'boot-a', isProcessAlive: () => true });
  const { manifest } = await loadPackageSkillBundle();
  const run = metadataV2(7);
  run.graph.attempts = [{
    attemptId: 'attempt-7', nodeId: 'spec-implementer', ordinal: 1, status: 'terminal', cleanRetriesConsumed: 0, partialContinuationsConsumed: 0,
    baseline: { headSha: 'head', indexTreeSha: 'index', statusSha256: 'status', contentSha256: 'content', ownershipToken: 'owner' },
    executions: [{
      executionId: 'execution-7', kind: 'initial', status: 'terminal', intentPersistedAt: '2026-07-15T00:00:00.000Z',
      process: { pid: 10, processGroupId: 10, host: 'host-a', bootNonce: 'boot-a', startedAt: '2026-07-15T00:00:01.000Z' },
      appServer: { threadId: 'thread-7', turnId: 'turn-7' },
      report: { path: '/report.json', sha256: 'c'.repeat(64), atomicWriteComplete: true },
      terminal: { kind: 'completed', acknowledgedAt: '2026-07-15T00:00:02.000Z', sideEffectsQuiescedAt: '2026-07-15T00:00:03.000Z', quiescenceProof: 'thread-clean-empty' },
    }],
  }];
  await store.save({ version: 2, generation: 0, runs: [run] });

  const updated = await store.transitionGraphV2({
    expectedGeneration: 0,
    runId: 'run-7',
    manifest,
    envelope: { version: 1, nodeId: 'spec-implementer', outcome: 'succeeded', artifactRefs: ['artifact://implementation'], result: { status: 'complete' } },
  });

  const transitionedRun = updated.runs[0] as RunnerProcessMetadataV2;
  assert.equal(updated.generation, 1);
  assert.equal(transitionedRun.graph.currentNodeId, 'cleanup-review');
  assert.deepEqual(transitionedRun.graph.artifactRefs, ['artifact://implementation']);
  assert.equal(transitionedRun.graph.attempts[0]?.status, 'reconciled');
});

test('state v2 rejects successor publication without accepted attempt evidence and stale raw saves', async () => {
  const targetRoot = await tempRepo();
  const store = new RunnerStateStore(targetRoot, validConfig, { hostId: 'host-a', bootNonce: 'boot-a', isProcessAlive: () => true });
  const { manifest } = await loadPackageSkillBundle();
  await store.save({ version: 2, generation: 0, runs: [metadataV2(7)] });
  await assert.rejects(store.transitionGraphV2({
    expectedGeneration: 0, runId: 'run-7', manifest,
    envelope: { version: 1, nodeId: 'spec-implementer', outcome: 'succeeded', artifactRefs: ['artifact://bad'], result: {} },
  }), /accepted terminal attempt evidence/);
  await store.upsertRun(metadataV2(8));
  await assert.rejects(store.save({ version: 2, generation: 0, runs: [metadataV2(7)] }), /stale generation/);
  assert.deepEqual((await store.load()).runs.map((run) => run.issueNumber), [7, 8]);
});

test('runner state lock rejects foreign owners and reclaims proven dead same-host owners', async () => {
  const targetRoot = await tempRepo();
  const stateRoot = join(targetRoot, validConfig.runner.stateDir);
  const lockRoot = join(stateRoot, 'runner-state.lock');
  await mkdir(lockRoot, { recursive: true });
  await writeFile(join(lockRoot, 'owner.json'), `${JSON.stringify({ version: 1, token: 'foreign', hostId: 'host-b', bootNonce: 'boot-b', pid: 99, acquiredAt: '2026-07-15T00:00:00.000Z' })}\n`);
  const store = new RunnerStateStore(targetRoot, validConfig, { hostId: 'host-a', bootNonce: 'boot-a', pid: 101, isProcessAlive: () => false, waitTimeoutMs: 10 });
  await assert.rejects(store.upsertRun(metadata(1)), /different host/);

  await writeFile(join(lockRoot, 'owner.json'), `${JSON.stringify({ version: 1, token: 'dead', hostId: 'host-a', bootNonce: 'boot-a', pid: 99, acquiredAt: '2026-07-15T00:00:00.000Z' })}\n`);
  await store.upsertRun(metadata(1));
  assert.deepEqual((await store.load()).runs.map((run) => run.issueNumber), [1]);
});
