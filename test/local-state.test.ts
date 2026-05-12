import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunnerStateStore, type RunnerProcessMetadata } from '../src/runner/local-state.js';
import { validConfig } from './fixtures/config.js';

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-orchestrator-state-'));
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
