import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir, readFile, readdir, rename, stat, symlink, writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { mkdtemp } from './mission-test-temp.js';

import {
  MissionGitSafetyStopError,
  MissionGitIntegrationConflictError,
  MissionGitReauthorizationRequiredError,
  MissionGitTransaction,
  applyMissionTreeIntegration,
  buildMissionPatchCandidate,
  buildMissionTreeIntegrationCandidate,
  createMissionApplyPermit,
  defaultMissionBinaryProcessExecutor,
  missionApplyPermitFingerprint,
  type MissionGitBoundary,
} from '../src/runner/mission-git-transaction.js';
import {
  MissionStateStore,
} from '../src/runner/mission-state-store.js';
import { transitionMission } from '../src/runner/mission-state-machine.js';

const execFileAsync = promisify(execFile);
const fixedDate = '2026-07-14T12:00:00.000Z';

test('builds an exact candidate through an isolated index without capturing unrelated staged files', async () => {
  const repository = await createRepository();
  await writeFile(join(repository.root, 'unrelated.txt'), 'staged but forbidden\n', 'utf8');
  await git(repository.root, ['add', 'unrelated.txt']);
  const sharedIndexBefore = await readFile(join(repository.root, '.git/index'));

  const candidate = await buildMissionPatchCandidate({
    targetRoot: repository.root,
    baseCommit: repository.baseCommit,
    patch: modifyTrackedPatch(),
    auditedFiles: [{
      path: 'tracked.txt',
      operation: 'modify',
      oldMode: '100644',
      newMode: '100644',
    }],
    commit: commitIdentity('mission patch'),
  });

  assert.equal(await gitText(repository.root, ['show', `${candidate.commitSha}:tracked.txt`]), 'after\n');
  assert.equal(await gitText(repository.root, ['show', `${candidate.commitSha}:unrelated.txt`]), 'original\n');
  assert.deepEqual(await readFile(join(repository.root, '.git/index')), sharedIndexBefore);
  assert.deepEqual(candidate.manifest.map(({ path, operation, oldMode, newMode }) => ({
    path, operation, oldMode, newMode,
  })), [{
    path: 'tracked.txt',
    operation: 'modify',
    oldMode: '100644',
    newMode: '100644',
  }]);
  assert.match(candidate.manifest[0]?.beforeSha256 ?? '', /^sha256:[a-f0-9]{64}$/u);
  assert.match(candidate.manifest[0]?.afterSha256 ?? '', /^sha256:[a-f0-9]{64}$/u);
  await assert.rejects(stat(join(repository.root, '.git/MERGE_HEAD')), /ENOENT/);
});

test('persists apply intent before compare-and-swap and a recoverable receipt after it', async () => {
  const fixture = await transactionFixture();
  const boundaries: MissionGitBoundary[] = [];
  const transaction = new MissionGitTransaction({
    targetRoot: fixture.repository.root,
    stateStore: fixture.store,
    assertOwnership: async (epoch) => assert.equal(epoch, 7),
    onBoundary: async (boundary) => { boundaries.push(boundary); },
  });

  const receipt = await transaction.apply(fixture.permit, modifyTrackedPatch());

  assert.equal(receipt.recovered, false);
  assert.equal((await gitText(fixture.repository.root, ['rev-parse', fixture.permit.targetRef])).trim(), fixture.permit.expectedNewCommit);
  assert.ok(boundaries.indexOf('intent-persisted') < boundaries.indexOf('ref-updated'));
  assert.ok(boundaries.indexOf('ref-updated') < boundaries.indexOf('receipt-persisted'));
  const mission = (await fixture.store.load()).missions[fixture.permit.missionId];
  assert.equal(mission?.state, 'reconciling');
  assert.equal(mission?.applyIntent?.permitFingerprint, missionApplyPermitFingerprint(fixture.permit));
  assert.deepEqual(mission?.applyReceipt, receipt);
});

test('state storage rejects apply phases that are missing their required durable artifacts', async () => {
  const fixture = await transactionFixture();
  await assert.rejects(fixture.store.mutate(1, (draft) => {
    draft.missions[fixture.permit.missionId]!.state = 'applying';
  }), /applying state requires permit and intent/);
  await assert.rejects(fixture.store.mutate(1, (draft) => {
    draft.missions[fixture.permit.missionId]!.state = 'reconciling';
  }), /apply reconciliation requires permit, intent, and receipt/);
  assert.equal((await fixture.store.load()).missions[fixture.permit.missionId]?.state, 'apply-prepared');
});

test('rejects a symlinked state directory before candidate temporary IO', async () => {
  const fixture = await transactionFixture();
  const stateDirectory = join(fixture.repository.root, '.codex-orchestrator/state');
  await rename(stateDirectory, `${stateDirectory}.saved`);
  const outside = await mkdtemp(join(tmpdir(), 'mission-state-escape-'));
  await symlink(outside, stateDirectory, 'dir');
  await assert.rejects(new MissionGitTransaction({
    targetRoot: fixture.repository.root,
    stateStore: fixture.store,
    assertOwnership: async () => undefined,
  }).apply(fixture.permit, modifyTrackedPatch()), /direct directory|symlink/);
  assert.deepEqual(await readdir(outside), []);
});

test('retires a successful receipt into history and persists a second apply cycle', async () => {
  const fixture = await transactionFixture();
  await new MissionGitTransaction({
    targetRoot: fixture.repository.root,
    stateStore: fixture.store,
    assertOwnership: async () => undefined,
  }).apply(fixture.permit, modifyTrackedPatch());
  const completed = await fixture.store.load();
  const secondPermit = createMissionApplyPermit({
    missionId: fixture.permit.missionId,
    actionKey: 'apply-2',
    fencingEpoch: fixture.permit.fencingEpoch,
    expiresAt: fixture.permit.expiresAt,
    targetRef: fixture.permit.targetRef,
    auditReceiptSha256: `sha256:${'f'.repeat(64)}`,
    candidate: fixture.candidate,
    commit: commitIdentity('mission patch'),
  });
  await fixture.store.mutate(completed.generation, (draft) => {
    let mission = draft.missions[fixture.permit.missionId]!;
    mission = transitionMission(mission, { type: 'reconciliation-satisfied' });
    mission = transitionMission(mission, {
      type: 'evaluation-completed',
      result: { findings: [], blockingDisposition: 'diagnose' },
    });
    mission = transitionMission(mission, { type: 'diagnosis-valid' });
    mission = transitionMission(mission, {
      type: 'capability-authorized',
      actionKey: 'patch-2',
      permit: readCapabilityPermit(fixture.permit.missionId, 'patch-2'),
    });
    mission = transitionMission(mission, { type: 'patch-received' });
    mission = transitionMission(mission, { type: 'audit-accepted' });
    mission = transitionMission(mission, {
      type: 'apply-authorized', actionKey: 'apply-2', permit: secondPermit,
    });
    draft.missions[fixture.permit.missionId] = mission;
  });
  const second = (await fixture.store.load()).missions[fixture.permit.missionId];
  assert.equal(second?.state, 'apply-prepared');
  assert.equal(second?.applyHistory?.length, 1);
  assert.equal(second?.applyHistory?.[0]?.commitSha, fixture.permit.expectedNewCommit);
  assert.equal(second?.applyPermit?.actionKey, 'apply-2');
  assert.equal(second?.applyIntent, undefined);
  assert.equal(second?.applyReceipt, undefined);
});

test('replays every injected boundary exception without duplicate ref mutation or lost receipt', async () => {
  const boundaries: MissionGitBoundary[] = [
    'intent-persisted',
    'base-verified',
    'isolated-index-created',
    'patch-applied',
    'tree-written',
    'manifest-proved',
    'commit-created',
    'ref-updated',
    'receipt-persisted',
  ];
  for (const crashAt of boundaries) {
    const fixture = await transactionFixture();
    let crashed = false;
    const first = new MissionGitTransaction({
      targetRoot: fixture.repository.root,
      stateStore: fixture.store,
      assertOwnership: async () => undefined,
      onBoundary: async (boundary) => {
        if (!crashed && boundary === crashAt) {
          crashed = true;
          throw new Error(`injected:${boundary}`);
        }
      },
    });
    await assert.rejects(first.apply(fixture.permit, modifyTrackedPatch()), new RegExp(`injected:${crashAt}`));
    const durablePermit = (await fixture.store.load()).missions[fixture.permit.missionId]?.applyPermit;
    assert.ok(durablePermit, crashAt);

    const recovered = await new MissionGitTransaction({
      targetRoot: fixture.repository.root,
      stateStore: fixture.store,
      assertOwnership: async () => undefined,
    }).apply(durablePermit, modifyTrackedPatch());

    assert.equal(recovered.commitSha, fixture.permit.expectedNewCommit, crashAt);
    assert.equal((await fixture.store.load()).missions[fixture.permit.missionId]?.state, 'reconciling', crashAt);
    assert.equal((await gitText(fixture.repository.root, ['rev-parse', fixture.permit.targetRef])).trim(), fixture.permit.expectedNewCommit, crashAt);
    assert.equal(await gitText(fixture.repository.root, ['rev-list', '--count', fixture.permit.targetRef]), '2\n', crashAt);
  }
});

test('recovers after real process death between ref update and receipt persistence', async () => {
  const fixture = await transactionFixture();
  const transactionUrl = new URL('../src/runner/mission-git-transaction.js', import.meta.url).href;
  const stateStoreUrl = new URL('../src/runner/mission-state-store.js', import.meta.url).href;
  const script = [
    'const [{ MissionGitTransaction }, { MissionStateStore }] = await Promise.all([import(process.argv[1]), import(process.argv[2])]);',
    "const store = new MissionStateStore(process.argv[4], '.codex-orchestrator/state');",
    'const transaction = new MissionGitTransaction({',
    '  targetRoot: process.argv[4],',
    '  stateStore: store,',
    '  assertOwnership: async () => undefined,',
    "  onBoundary: async (boundary) => { if (boundary === 'ref-updated') process.exit(91); },",
    '});',
    "await transaction.apply(JSON.parse(process.argv[3]), Buffer.from(process.argv[5], 'base64').toString('utf8'));",
  ].join('\n');
  await assert.rejects(execFileAsync(process.execPath, [
    '--input-type=module', '-e', script,
    transactionUrl,
    stateStoreUrl,
    JSON.stringify(fixture.permit),
    fixture.repository.root,
    Buffer.from(modifyTrackedPatch(), 'utf8').toString('base64'),
  ]), (error: unknown) => error instanceof Error && 'code' in error && error.code === 91);

  const beforeRecovery = (await fixture.store.load()).missions[fixture.permit.missionId];
  assert.equal(beforeRecovery?.state, 'applying');
  assert.equal(beforeRecovery?.applyReceipt, undefined);
  assert.equal((await gitText(fixture.repository.root, ['rev-parse', fixture.permit.targetRef])).trim(), fixture.permit.expectedNewCommit);
  const receipt = await new MissionGitTransaction({
    targetRoot: fixture.repository.root,
    stateStore: fixture.store,
    assertOwnership: async () => undefined,
  }).recover(fixture.permit);
  assert.equal(receipt.recovered, true);
  assert.equal((await fixture.store.load()).missions[fixture.permit.missionId]?.state, 'reconciling');
});

test('reclaims a dead process isolated-index directory before retrying candidate construction', async () => {
  const fixture = await transactionFixture();
  const transactionUrl = new URL('../src/runner/mission-git-transaction.js', import.meta.url).href;
  const stateStoreUrl = new URL('../src/runner/mission-state-store.js', import.meta.url).href;
  const script = [
    'const [{ MissionGitTransaction }, { MissionStateStore }] = await Promise.all([import(process.argv[1]), import(process.argv[2])]);',
    "const store = new MissionStateStore(process.argv[4], '.codex-orchestrator/state');",
    'await new MissionGitTransaction({',
    '  targetRoot: process.argv[4], stateStore: store, assertOwnership: async () => undefined,',
    "  onBoundary: async (boundary) => { if (boundary === 'isolated-index-created') process.exit(92); },",
    "}).apply(JSON.parse(process.argv[3]), Buffer.from(process.argv[5], 'base64').toString('utf8'));",
  ].join('\n');
  await assert.rejects(execFileAsync(process.execPath, [
    '--input-type=module', '-e', script,
    transactionUrl, stateStoreUrl, JSON.stringify(fixture.permit), fixture.repository.root,
    Buffer.from(modifyTrackedPatch(), 'utf8').toString('base64'),
  ]), (error: unknown) => error instanceof Error && 'code' in error && error.code === 92);
  const temporaryRoot = join(fixture.repository.root, '.codex-orchestrator/state/mission-git-tmp');
  const staleNonce = '0'.repeat(32);
  const reusedPidDirectory = join(temporaryRoot, `candidate-${process.pid}-${staleNonce}-00000000-0000-0000-0000-000000000000`);
  await mkdir(reusedPidDirectory);
  await writeFile(join(reusedPidDirectory, 'owner.json'), `${JSON.stringify({
    version: 1, pid: process.pid, bootNonce: 'stale-process-boot',
  })}\n`, 'utf8');
  await mkdir(join(
    temporaryRoot,
    `candidate-${process.pid}-${staleNonce}-00000000-0000-0000-0000-000000000001`,
  ));
  assert.equal((await readdir(temporaryRoot)).length, 3);

  await new MissionGitTransaction({
    targetRoot: fixture.repository.root,
    stateStore: fixture.store,
    assertOwnership: async () => undefined,
  }).apply(fixture.permit, modifyTrackedPatch());
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('recovers from every atomic state publication boundary and receipt-write failure', async () => {
  for (const faultAt of ['file-fsync', 'rename', 'directory-fsync'] as const) {
    const fixture = await transactionFixture();
    let injected = false;
    const faultStore = new MissionStateStore(fixture.repository.root, '.codex-orchestrator/state', {
      atomicOperations: {
        ...(faultAt === 'file-fsync' ? {
          syncFile: async (file: FileHandle, generation: number) => {
            if (!injected && generation === 2) {
              injected = true;
              throw new Error(`atomic-fault:${faultAt}`);
            }
            await file.sync();
          },
        } : {}),
        ...(faultAt === 'rename' ? {
          rename: async (source: string, destination: string, generation: number) => {
            if (!injected && generation === 2) {
              injected = true;
              throw new Error(`atomic-fault:${faultAt}`);
            }
            await rename(source, destination);
          },
        } : {}),
        ...(faultAt === 'directory-fsync' ? {
          syncDirectory: async (directory: FileHandle, generation: number) => {
            if (!injected && generation === 2) {
              injected = true;
              throw new Error(`atomic-fault:${faultAt}`);
            }
            await directory.sync();
          },
        } : {}),
      },
    });
    await assert.rejects(new MissionGitTransaction({
      targetRoot: fixture.repository.root,
      stateStore: faultStore,
      assertOwnership: async () => undefined,
    }).apply(fixture.permit, modifyTrackedPatch()), new RegExp(`atomic-fault:${faultAt}`));
    assert.equal((await gitText(fixture.repository.root, ['rev-parse', fixture.permit.targetRef])).trim(), fixture.permit.expectedOldCommit, faultAt);
    const receipt = await new MissionGitTransaction({
      targetRoot: fixture.repository.root,
      stateStore: fixture.store,
      assertOwnership: async () => undefined,
    }).apply(fixture.permit, modifyTrackedPatch());
    assert.equal(receipt.commitSha, fixture.permit.expectedNewCommit, faultAt);
  }

  const receiptFault = await transactionFixture();
  const faultStore = new MissionStateStore(receiptFault.repository.root, '.codex-orchestrator/state', {
    atomicOperations: {
      syncFile: async (file, generation) => {
        if (generation === 3) throw new Error('receipt-write-fault');
        await file.sync();
      },
    },
  });
  await assert.rejects(new MissionGitTransaction({
    targetRoot: receiptFault.repository.root,
    stateStore: faultStore,
    assertOwnership: async () => undefined,
  }).apply(receiptFault.permit, modifyTrackedPatch()), /receipt-write-fault/);
  assert.equal((await gitText(receiptFault.repository.root, ['rev-parse', receiptFault.permit.targetRef])).trim(), receiptFault.permit.expectedNewCommit);
  assert.equal((await receiptFault.store.load()).missions[receiptFault.permit.missionId]?.state, 'applying');
  const recovered = await new MissionGitTransaction({
    targetRoot: receiptFault.repository.root,
    stateStore: receiptFault.store,
    assertOwnership: async () => undefined,
  }).recover(receiptFault.permit);
  assert.equal(recovered.recovered, true);
});

test('recovers an already-updated ref even after permit expiry, but refuses a third identity', async () => {
  const applied = await transactionFixture();
  const crashing = new MissionGitTransaction({
    targetRoot: applied.repository.root,
    stateStore: applied.store,
    now: () => new Date('2026-07-14T12:01:00.000Z'),
    assertOwnership: async () => undefined,
    onBoundary: async (boundary) => {
      if (boundary === 'ref-updated') throw new Error('crash-after-ref');
    },
  });
  await assert.rejects(crashing.apply(applied.permit, modifyTrackedPatch()), /crash-after-ref/);
  const recovered = await new MissionGitTransaction({
    targetRoot: applied.repository.root,
    stateStore: applied.store,
    now: () => new Date('2100-07-14T12:03:00.000Z'),
    assertOwnership: async () => undefined,
  }).recover(applied.permit);
  assert.equal(recovered.recovered, true);

  const divergent = await transactionFixture();
  await git(divergent.repository.root, ['update-ref', divergent.permit.targetRef, divergent.repository.otherCommit, divergent.permit.expectedOldCommit]);
  await assert.rejects(
    new MissionGitTransaction({
      targetRoot: divergent.repository.root,
      stateStore: divergent.store,
      assertOwnership: async () => undefined,
    }).apply(divergent.permit, modifyTrackedPatch()),
    (error: unknown) => error instanceof MissionGitSafetyStopError && error.code === 'target-ref-third-identity',
  );
  assert.equal((await divergent.store.load()).missions[divergent.permit.missionId]?.state, 'safety-stop');
});

test('moves an old expired apply back to authorization instead of leaving it stuck applying', async () => {
  const fixture = await transactionFixture();
  await assert.rejects(
    new MissionGitTransaction({
      targetRoot: fixture.repository.root,
      stateStore: fixture.store,
      now: () => new Date('2100-07-14T12:00:00.000Z'),
      assertOwnership: async () => undefined,
    }).apply(fixture.permit, modifyTrackedPatch()),
    (error: unknown) => error instanceof MissionGitReauthorizationRequiredError
      && error.code === 'permit-expired',
  );
  const mission = (await fixture.store.load()).missions[fixture.permit.missionId];
  assert.equal(mission?.state, 'apply-authorizing');
  assert.equal(mission?.applyPermit, undefined);
  assert.equal(mission?.applyIntent, undefined);
  assert.equal((await gitText(fixture.repository.root, ['rev-parse', fixture.permit.targetRef])).trim(), fixture.permit.expectedOldCommit);
});

test('durably safety-stops when the target ref is missing or a stored receipt no longer matches it', async () => {
  const missing = await transactionFixture();
  await git(missing.repository.root, ['update-ref', '-d', missing.permit.targetRef]);
  await assert.rejects(new MissionGitTransaction({
    targetRoot: missing.repository.root,
    stateStore: missing.store,
    assertOwnership: async () => undefined,
  }).apply(missing.permit, modifyTrackedPatch()), (error: unknown) =>
    error instanceof MissionGitSafetyStopError && error.code === 'target-ref-third-identity');
  assert.equal((await missing.store.load()).missions[missing.permit.missionId]?.state, 'safety-stop');

  const moved = await transactionFixture();
  await new MissionGitTransaction({
    targetRoot: moved.repository.root,
    stateStore: moved.store,
    assertOwnership: async () => undefined,
  }).apply(moved.permit, modifyTrackedPatch());
  await git(moved.repository.root, ['update-ref', moved.permit.targetRef, moved.permit.expectedOldCommit, moved.permit.expectedNewCommit]);
  await assert.rejects(new MissionGitTransaction({
    targetRoot: moved.repository.root,
    stateStore: moved.store,
    assertOwnership: async () => undefined,
  }).recover(moved.permit), (error: unknown) =>
    error instanceof MissionGitSafetyStopError && error.code === 'receipt-ref-mismatch');
  assert.equal((await moved.store.load()).missions[moved.permit.missionId]?.state, 'safety-stop');

  const replayed = await transactionFixture();
  const replayTransaction = new MissionGitTransaction({
    targetRoot: replayed.repository.root,
    stateStore: replayed.store,
    assertOwnership: async () => undefined,
  });
  await replayTransaction.apply(replayed.permit, modifyTrackedPatch());
  await git(replayed.repository.root, [
    'update-ref', replayed.permit.targetRef,
    replayed.permit.expectedOldCommit, replayed.permit.expectedNewCommit,
  ]);
  await assert.rejects(
    replayTransaction.apply(replayed.permit, modifyTrackedPatch()),
    (error: unknown) => error instanceof MissionGitSafetyStopError
      && error.code === 'receipt-ref-mismatch',
  );
  assert.equal(
    (await gitText(replayed.repository.root, ['rev-parse', replayed.permit.targetRef])).trim(),
    replayed.permit.expectedOldCommit,
  );
});

test('rejects symbolic apply refs without mutating their referent', async () => {
  const fixture = await transactionFixture();
  const referent = 'refs/heads/real-target';
  await git(fixture.repository.root, ['update-ref', referent, fixture.permit.expectedOldCommit]);
  await git(fixture.repository.root, ['update-ref', '-d', fixture.permit.targetRef]);
  await git(fixture.repository.root, ['symbolic-ref', fixture.permit.targetRef, referent]);
  await assert.rejects(new MissionGitTransaction({
    targetRoot: fixture.repository.root,
    stateStore: fixture.store,
    assertOwnership: async () => undefined,
  }).apply(fixture.permit, modifyTrackedPatch()), (error: unknown) =>
    error instanceof MissionGitSafetyStopError && error.code === 'symbolic-target-ref-forbidden');
  assert.equal((await gitText(fixture.repository.root, ['rev-parse', referent])).trim(), fixture.permit.expectedOldCommit);
  assert.equal((await fixture.store.load()).missions[fixture.permit.missionId]?.state, 'safety-stop');
});

test('guards ref CAS from repository hooks and a direct-to-symbolic race', async () => {
  const hooked = await transactionFixture();
  const hookCanary = join(hooked.repository.root, 'repository-hook-ran');
  await mkdir(join(hooked.repository.root, '.git/hooks'), { recursive: true });
  await writeFile(join(hooked.repository.root, '.git/hooks/reference-transaction'), [
    '#!/bin/sh',
    `/usr/bin/touch ${hookCanary}`,
    'exit 1',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o700 });
  await new MissionGitTransaction({
    targetRoot: hooked.repository.root,
    stateStore: hooked.store,
    assertOwnership: async () => undefined,
  }).apply(hooked.permit, modifyTrackedPatch());
  await assert.rejects(stat(hookCanary), /ENOENT/);

  const raced = await transactionFixture();
  const referent = 'refs/heads/raced-referent';
  let injected = false;
  await assert.rejects(new MissionGitTransaction({
    targetRoot: raced.repository.root,
    stateStore: raced.store,
    assertOwnership: async () => {
      if (!injected) {
        injected = true;
        await git(raced.repository.root, ['update-ref', referent, raced.permit.expectedOldCommit]);
        await git(raced.repository.root, ['update-ref', '-d', raced.permit.targetRef]);
        await git(raced.repository.root, ['symbolic-ref', raced.permit.targetRef, referent]);
      }
    },
  }).apply(raced.permit, modifyTrackedPatch()), (error: unknown) =>
    error instanceof MissionGitSafetyStopError && error.code === 'symbolic-target-ref-forbidden');
  assert.equal((await gitText(raced.repository.root, ['rev-parse', referent])).trim(), raced.permit.expectedOldCommit);
});

test('rejects patch or permit manifest drift before ref mutation', async () => {
  const fixture = await transactionFixture();
  const transaction = new MissionGitTransaction({
    targetRoot: fixture.repository.root,
    stateStore: fixture.store,
    assertOwnership: async () => undefined,
  });
  await assert.rejects(transaction.apply(fixture.permit, modifyTrackedPatch().replace('+after', '+tampered')), /patch digest/i);
  assert.equal((await gitText(fixture.repository.root, ['rev-parse', fixture.permit.targetRef])).trim(), fixture.permit.expectedOldCommit);

  const tamperedPermit = {
    ...fixture.permit,
    manifest: fixture.permit.manifest.map((entry) => ({ ...entry, afterSha256: `sha256:${'0'.repeat(64)}` })),
  };
  await assert.rejects(transaction.apply(tamperedPermit, modifyTrackedPatch()), /candidate manifest/i);
  assert.equal((await gitText(fixture.repository.root, ['rev-parse', fixture.permit.targetRef])).trim(), fixture.permit.expectedOldCommit);
});

test('keeps the old ref when ownership is lost immediately before compare-and-swap', async () => {
  const fixture = await transactionFixture();
  let checks = 0;
  await assert.rejects(new MissionGitTransaction({
    targetRoot: fixture.repository.root,
    stateStore: fixture.store,
    assertOwnership: async () => {
      checks += 1;
      throw new Error('ownership-lost');
    },
  }).apply(fixture.permit, modifyTrackedPatch()), /ownership-lost/);
  assert.equal(checks, 1);
  assert.equal((await gitText(fixture.repository.root, ['rev-parse', fixture.permit.targetRef])).trim(), fixture.permit.expectedOldCommit);
  const mission = (await fixture.store.load()).missions[fixture.permit.missionId];
  assert.equal(mission?.state, 'applying');
  assert.ok(mission?.applyIntent);
  assert.equal(mission?.applyReceipt, undefined);
});

test('classifies external ref-lock contention as reauthorization while preserving the old ref', async () => {
  const fixture = await transactionFixture();
  const lockPath = join(fixture.repository.root, '.git/refs/heads/mission-target.lock');
  await writeFile(lockPath, 'external git lock\n', 'utf8');
  await assert.rejects(new MissionGitTransaction({
    targetRoot: fixture.repository.root,
    stateStore: fixture.store,
    assertOwnership: async () => undefined,
  }).apply(fixture.permit, modifyTrackedPatch()), (error: unknown) =>
    error instanceof MissionGitReauthorizationRequiredError && error.code === 'cas-retry-required');
  assert.equal((await gitText(fixture.repository.root, ['rev-parse', fixture.permit.targetRef])).trim(), fixture.permit.expectedOldCommit);
  assert.equal((await fixture.store.load()).missions[fixture.permit.missionId]?.state, 'apply-authorizing');
  assert.equal(await readFile(lockPath, 'utf8'), 'external git lock\n');
});

test('integrates pinned parent and child trees without MERGE_HEAD or shared-index mutation', async () => {
  const repository = await createIntegrationRepository(false);
  const sharedIndexBefore = await readFile(join(repository.root, '.git/index'));
  const candidate = await buildMissionTreeIntegrationCandidate({
    targetRoot: repository.root,
    baseCommit: repository.baseCommit,
    parentCommit: repository.parentCommit,
    childCommit: repository.childCommit,
    commit: commitIdentity('integrate child'),
  });

  assert.equal(await gitText(repository.root, ['show', `${candidate.commitSha}:tracked.txt`]), 'child\n');
  assert.equal(await gitText(repository.root, ['show', `${candidate.commitSha}:parent.txt`]), 'parent\n');
  assert.equal((await gitText(repository.root, ['show', '-s', '--format=%P', candidate.commitSha])).trim(), `${repository.parentCommit} ${repository.childCommit}`);
  const applied = await applyMissionTreeIntegration({
    targetRoot: repository.root,
    targetRef: repository.targetRef,
    baseCommit: repository.baseCommit,
    parentCommit: repository.parentCommit,
    childCommit: repository.childCommit,
    commit: commitIdentity('integrate child'),
    fencingEpoch: 9,
    assertOwnership: async (epoch) => assert.equal(epoch, 9),
  });
  assert.deepEqual(applied, candidate);
  assert.equal((await gitText(repository.root, ['rev-parse', repository.targetRef])).trim(), candidate.commitSha);
  assert.deepEqual(await readFile(join(repository.root, '.git/index')), sharedIndexBefore);
  await assert.rejects(stat(join(repository.root, '.git/MERGE_HEAD')), /ENOENT/);
});

test('surfaces tree integration conflicts without mutating the target ref', async () => {
  const repository = await createIntegrationRepository(true);
  await assert.rejects(
    buildMissionTreeIntegrationCandidate({
      targetRoot: repository.root,
      baseCommit: repository.baseCommit,
      parentCommit: repository.parentCommit,
      childCommit: repository.childCommit,
      commit: commitIdentity('conflicting child'),
    }),
    (error: unknown) => error instanceof MissionGitIntegrationConflictError
      && error.paths.includes('tracked.txt'),
  );
  assert.equal((await gitText(repository.root, ['rev-parse', repository.targetRef])).trim(), repository.parentCommit);
  await assert.rejects(stat(join(repository.root, '.git/MERGE_HEAD')), /ENOENT/);
});

test('isolates tree integration from repository-configured merge driver commands', async () => {
  const repository = await createIntegrationRepository(false);
  const canary = join(repository.root, 'merge-driver-ran');
  await git(repository.root, ['config', 'extensions.worktreeConfig', 'true']);
  await git(repository.root, ['config', '--worktree', 'merge.evil.driver', `/usr/bin/touch ${canary}`]);
  await buildMissionTreeIntegrationCandidate({
    targetRoot: repository.root,
    baseCommit: repository.baseCommit,
    parentCommit: repository.parentCommit,
    childCommit: repository.childCommit,
    commit: commitIdentity('forbidden driver'),
  });
  await assert.rejects(stat(canary), /ENOENT/);
});

test('rejects symbolic integration refs without mutating their referent', async () => {
  const repository = await createIntegrationRepository(false);
  const referent = 'refs/heads/real-integration-target';
  await git(repository.root, ['update-ref', referent, repository.parentCommit]);
  await git(repository.root, ['update-ref', '-d', repository.targetRef]);
  await git(repository.root, ['symbolic-ref', repository.targetRef, referent]);
  await assert.rejects(applyMissionTreeIntegration({
    targetRoot: repository.root,
    targetRef: repository.targetRef,
    baseCommit: repository.baseCommit,
    parentCommit: repository.parentCommit,
    childCommit: repository.childCommit,
    commit: commitIdentity('symref integration'),
    fencingEpoch: 9,
    assertOwnership: async () => undefined,
  }), (error: unknown) => error instanceof MissionGitSafetyStopError
    && error.code === 'symbolic-target-ref-forbidden');
  assert.equal((await gitText(repository.root, ['rev-parse', referent])).trim(), repository.parentCommit);
});

test('hashes integration manifest blobs from raw bytes instead of decoded stdout', async () => {
  const repository = await createIntegrationRepository(false);
  await git(repository.root, ['checkout', '-q', 'child']);
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x0a]);
  await writeFile(join(repository.root, 'invalid.bin'), invalidUtf8);
  await git(repository.root, ['add', 'invalid.bin']);
  await git(repository.root, ['commit', '--amend', '-q', '--no-edit']);
  const childCommit = (await gitText(repository.root, ['rev-parse', 'HEAD'])).trim();
  let binaryCalls = 0;
  const candidate = await buildMissionTreeIntegrationCandidate({
    targetRoot: repository.root,
    baseCommit: repository.baseCommit,
    parentCommit: repository.parentCommit,
    childCommit,
    commit: commitIdentity('raw blob hash'),
    executeBinary: async (...args) => {
      binaryCalls += 1;
      return defaultMissionBinaryProcessExecutor(...args);
    },
  });
  const entry = candidate.manifest.find((item) => item.path === 'invalid.bin');
  assert.equal(entry?.afterSha256, `sha256:${createHash('sha256').update(invalidUtf8).digest('hex')}`);
  assert.ok(binaryCalls > 0);
});

async function transactionFixture() {
  const repository = await createRepository();
  const candidate = await buildMissionPatchCandidate({
    targetRoot: repository.root,
    baseCommit: repository.baseCommit,
    patch: modifyTrackedPatch(),
    auditedFiles: [{
      path: 'tracked.txt', operation: 'modify', oldMode: '100644', newMode: '100644',
    }],
    commit: commitIdentity('mission patch'),
  });
  const permit = createMissionApplyPermit({
    missionId: 'mission-227',
    actionKey: 'apply-1',
    fencingEpoch: 7,
    expiresAt: '2099-07-14T13:00:00.000Z',
    targetRef: 'refs/heads/mission-target',
    auditReceiptSha256: `sha256:${'a'.repeat(64)}`,
    candidate,
    commit: commitIdentity('mission patch'),
  });
  await git(repository.root, ['update-ref', permit.targetRef, repository.baseCommit]);
  const store = new MissionStateStore(repository.root, '.codex-orchestrator/state');
  await store.mutate(0, (draft) => {
    draft.missions[permit.missionId] = {
      id: permit.missionId,
      revision: 1,
      state: 'apply-prepared',
      actionKey: permit.actionKey,
      fencingEpoch: permit.fencingEpoch,
      applyPermit: permit,
    };
  });
  return { repository, candidate, permit, store };
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'codex-mission-git-'));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await writeFile(join(root, 'tracked.txt'), 'before\n', 'utf8');
  await writeFile(join(root, 'unrelated.txt'), 'original\n', 'utf8');
  await git(root, ['add', 'tracked.txt', 'unrelated.txt']);
  await git(root, ['commit', '-q', '-m', 'base']);
  const baseCommit = (await gitText(root, ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(root, 'other.txt'), 'other\n', 'utf8');
  await git(root, ['add', 'other.txt']);
  await git(root, ['commit', '-q', '-m', 'other']);
  const otherCommit = (await gitText(root, ['rev-parse', 'HEAD'])).trim();
  await git(root, ['reset', '--hard', '-q', baseCommit]);
  return { root, baseCommit, otherCommit };
}

async function createIntegrationRepository(conflicting: boolean) {
  const repository = await createRepository();
  await git(repository.root, ['checkout', '-q', '-b', 'parent', repository.baseCommit]);
  if (conflicting) {
    await writeFile(join(repository.root, 'tracked.txt'), 'parent\n', 'utf8');
  } else {
    await writeFile(join(repository.root, 'parent.txt'), 'parent\n', 'utf8');
  }
  await git(repository.root, ['add', conflicting ? 'tracked.txt' : 'parent.txt']);
  await git(repository.root, ['commit', '-q', '-m', 'parent']);
  const parentCommit = (await gitText(repository.root, ['rev-parse', 'HEAD'])).trim();
  await git(repository.root, ['checkout', '-q', '-b', 'child', repository.baseCommit]);
  await writeFile(join(repository.root, 'tracked.txt'), 'child\n', 'utf8');
  await git(repository.root, ['add', 'tracked.txt']);
  await git(repository.root, ['commit', '-q', '-m', 'child']);
  const childCommit = (await gitText(repository.root, ['rev-parse', 'HEAD'])).trim();
  await git(repository.root, ['checkout', '-q', 'parent']);
  await writeFile(join(repository.root, 'unrelated.txt'), 'staged parent noise\n', 'utf8');
  await git(repository.root, ['add', 'unrelated.txt']);
  const targetRef = 'refs/heads/integration-target';
  await git(repository.root, ['update-ref', targetRef, parentCommit]);
  return {
    root: repository.root,
    baseCommit: repository.baseCommit,
    parentCommit,
    childCommit,
    targetRef,
  };
}

function modifyTrackedPatch(): string {
  return [
    'diff --git a/tracked.txt b/tracked.txt',
    'index 90be1bd..3d099ac 100644',
    '--- a/tracked.txt',
    '+++ b/tracked.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    '',
  ].join('\n');
}

function commitIdentity(message: string) {
  return {
    message,
    authorName: 'codex-orchestrator',
    authorEmail: 'codex-orchestrator@localhost',
    authoredAt: fixedDate,
    committerName: 'codex-orchestrator',
    committerEmail: 'codex-orchestrator@localhost',
    committedAt: fixedDate,
  };
}

function readCapabilityPermit(missionId: string, actionKey: string) {
  return {
    missionId,
    actionKey,
    capability: 'validate-patch' as const,
    argv: [],
    requestedPaths: ['tracked.txt'],
    grantedPaths: ['tracked.txt'],
    inputSnapshot: 'tree:second-cycle',
    fencingEpoch: 7,
    expiresAt: '2099-07-14T13:00:00.000Z',
    network: 'deny' as const,
    workspace: 'read-only' as const,
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout;
}
