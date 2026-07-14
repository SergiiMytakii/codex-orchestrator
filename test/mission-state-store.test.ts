import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { mkdtemp } from './mission-test-temp.js';

import {
  MissionStateStore,
  type MissionBlobReference,
} from '../src/runner/mission-state-store.js';

const execFileAsync = promisify(execFile);

test('mission state store atomically persists one complete generation', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-state-'));
  const store = new MissionStateStore(targetRoot, '.codex-orchestrator/state');

  const empty = await store.load();
  assert.equal(empty.generation, 0);
  assert.deepEqual(empty.missions, {});

  const saved = await store.mutate(0, (draft) => {
    draft.missions['mission-227'] = {
      id: 'mission-227',
      revision: 1,
      state: 'created',
    };
  });

  assert.equal(saved.generation, 1);
  assert.match(saved.checksum, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual((await new MissionStateStore(
    targetRoot,
    '.codex-orchestrator/state',
  ).load()).missions['mission-227'], {
    id: 'mission-227',
    revision: 1,
    state: 'created',
  });
});

test('mission state store rejects traversal and symlinked state directories before IO', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-state-path-'));
  const outside = await mkdtemp(join(tmpdir(), 'mission-state-outside-'));
  assert.throws(() => new MissionStateStore(root, '../outside'), /inside the target root/);
  await mkdir(join(root, '.codex-orchestrator'));
  await symlink(outside, join(root, '.codex-orchestrator/state'), 'dir');
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  await assert.rejects(store.load(), /direct directory|symlink/);
  assert.deepEqual(await readdir(outside), []);
});

test('mission state store persists content-addressed blobs before references', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-blob-'));
  const store = new MissionStateStore(targetRoot, '.codex-orchestrator/state');

  const saved = await store.mutateWithBlobs(
    0,
    [Buffer.from('receipt evidence', 'utf8')],
    (draft, [reference]) => {
      assert.ok(reference);
      draft.blobs[reference.sha256] = reference;
    },
  );
  const reference = Object.values(saved.blobs)[0];
  assert.ok(reference);
  assert.deepEqual(reference, {
    sha256: 'f36be049ba5fcf410185c30f00bba14b109c964e3e8811f3f4cb22a3d408e990',
    size: 16,
  });
  assert.equal((await store.readBlob(reference)).toString('utf8'), 'receipt evidence');

  const blobPath = join(targetRoot, '.codex-orchestrator/state/mission-blobs', reference.sha256);
  const outside = join(targetRoot, 'outside-blob');
  await writeFile(outside, 'receipt evidence', 'utf8');
  await unlink(blobPath);
  await symlink(outside, blobPath);
  await assert.rejects(store.readBlob(reference), /ELOOP|symbolic link/);

  assert.deepEqual(saved.blobs[reference.sha256], reference);
});

test('mission state store rejects concurrent lost updates in one process', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-race-'));
  const left = new MissionStateStore(targetRoot, '.codex-orchestrator/state');
  const right = new MissionStateStore(targetRoot, '.codex-orchestrator/state');

  const results = await Promise.allSettled([
    left.mutate(0, (draft) => {
      draft.missions.left = { id: 'left', revision: 1, state: 'created' };
    }),
    right.mutate(0, (draft) => {
      draft.missions.right = { id: 'right', revision: 1, state: 'created' };
    }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const stored = await left.load();
  assert.equal(stored.generation, 1);
  assert.equal(Object.keys(stored.missions).length, 1);
});

test('mission state store rejects concurrent lost updates across processes', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-process-race-'));
  const moduleUrl = new URL('../src/runner/mission-state-store.js', import.meta.url).href;
  const script = [
    "const { MissionStateStore } = await import(process.argv[1]);",
    "const store = new MissionStateStore(process.argv[2], '.codex-orchestrator/state');",
    'try {',
    "  await store.mutate(0, (draft) => { draft.missions[process.argv[3]] = { id: process.argv[3], revision: 1, state: 'created' }; });",
    "  process.stdout.write('saved');",
    '} catch (error) {',
    "  process.stdout.write(error instanceof Error && /generation conflict/.test(error.message) ? 'conflict' : `error:${String(error)}`);",
    '}',
  ].join('\n');
  const outputs = await Promise.all(Array.from({ length: 8 }, async (_, index) =>
    (await execFileAsync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, targetRoot, `mission-${index}`])).stdout));
  assert.equal(outputs.filter((output) => output === 'saved').length, 1, outputs.join(','));
  assert.equal(outputs.filter((output) => output === 'conflict').length, 7, outputs.join(','));
});

test('mission state store rejects stale generation and corrupted snapshots', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-corrupt-'));
  const store = new MissionStateStore(targetRoot, '.codex-orchestrator/state');
  await store.mutate(0, (draft) => {
    draft.missions['mission-227'] = { id: 'mission-227', revision: 1, state: 'created' };
  });

  await assert.rejects(store.mutate(0, () => undefined), /generation conflict/);
  assert.equal((await store.load()).generation, 1);

  const path = store.statePath();
  const corrupted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  corrupted.generation = 2;
  await writeFile(path, `${JSON.stringify(corrupted)}\n`, 'utf8');
  await assert.rejects(store.load(), /Invalid Mission state checksum/);
});

test('mission state store ignores orphan temp files and never touches RunnerState v1', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-isolation-'));
  const stateDirectory = join(targetRoot, '.codex-orchestrator/state');
  await mkdir(stateDirectory, { recursive: true });
  const runnerStatePath = join(stateDirectory, 'runner-state.json');
  const runnerState = '{"version":1,"runs":[]}\n';
  await writeFile(runnerStatePath, runnerState, 'utf8');
  await writeFile(join(stateDirectory, '.mission-state-v1.crashed.tmp'), '{partial', 'utf8');

  const store = new MissionStateStore(targetRoot, '.codex-orchestrator/state');
  assert.equal((await store.load()).generation, 0);
  await store.mutate(0, (draft) => {
    draft.tombstones.old = {
      kind: 'mission',
      terminalState: 'completed',
      retainedAt: '2026-07-14T13:00:00.000Z',
    };
  });

  assert.equal(await readFile(runnerStatePath, 'utf8'), runnerState);
});

test('mission state store rejects an oversized generation before publication', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-size-'));
  const store = new MissionStateStore(
    targetRoot,
    '.codex-orchestrator/state',
    { maxStateBytes: 512 },
  );

  await assert.rejects(store.mutate(0, (draft) => {
    draft.planParents.large = {
      revision: 1,
      value: { payload: 'x'.repeat(1_024) },
    };
  }), /Mission state size limit exceeded/);
  assert.equal((await store.load()).generation, 0);
});

test('mission state store prunes only blobs absent from the latest generation', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-retention-'));
  const store = new MissionStateStore(targetRoot, '.codex-orchestrator/state');
  let retained: MissionBlobReference | undefined;
  let stale: MissionBlobReference | undefined;
  await store.mutateWithBlobs(0, [
    Buffer.from('retained', 'utf8'),
    Buffer.from('stale', 'utf8'),
  ], (draft, references) => {
    [retained, stale] = references;
    assert.ok(retained);
    draft.blobs[retained.sha256] = retained;
  });
  assert.ok(retained);
  assert.ok(stale);

  assert.deepEqual(await store.pruneUnreferencedBlobs(), [stale.sha256]);
  assert.equal((await store.readBlob(retained)).toString('utf8'), 'retained');
  await assert.rejects(store.readBlob(stale), /ENOENT/);
});

test('mission state store rejects malformed aggregate records before publication', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-invalid-record-'));
  const store = new MissionStateStore(targetRoot, '.codex-orchestrator/state');

  await assert.rejects(store.mutate(0, (draft) => {
    draft.missions.invalid = {
      id: '',
      revision: -1,
      state: 'created',
    };
  }), /Invalid Mission state: missions\.invalid/);
  assert.equal((await store.load()).generation, 0);

  await assert.rejects(store.mutate(0, (draft) => {
    draft.missions.lookup = {
      id: 'different-id',
      revision: 1,
      state: 'created',
    };
  }), /missions\.lookup\.id must equal its map key/);
  assert.equal((await store.load()).generation, 0);

  await assert.rejects(store.mutate(0, (draft) => {
    draft.missions.retry = {
      id: 'retry',
      revision: 1,
      state: 'resumable',
      resumeTarget: 'diagnosing',
      actionKey: 'diagnosis:retry',
      nextEligibleAt: '2026-07-14T18:05:00Z',
      resumableReason: 'transport retry',
      requiredPredicate: 'transport is reachable',
    };
    draft.nextEligibleAt.retry = '2026-07-14T18:05:00Z';
  }), /nextEligibleAt must be an exact UTC ISO timestamp/);
  assert.equal((await store.load()).generation, 0);
});

test('mission state store rejects unknown snapshot fields before publication', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-mission-unknown-field-'));
  const store = new MissionStateStore(targetRoot, '.codex-orchestrator/state');

  await assert.rejects(store.mutate(0, (draft) => {
    (draft as unknown as Record<string, unknown>).unexpected = true;
  }), /Invalid Mission state: unexpected field unexpected/);
  assert.equal((await store.load()).generation, 0);
});
