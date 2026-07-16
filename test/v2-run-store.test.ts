import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileProofRecordWriter } from '../src/v2/proof-store.js';
import {
  FileRunRecordWriter,
  type RunRecordV1,
  type RunStateBodyV1,
} from '../src/v2/run-store.js';
import { mkdtemp } from './mission-test-temp.js';

test('run state performs absent-state CAS and rejects stale or concurrent writers', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const left = new FileRunRecordWriter(path, deterministicAtomicOptions());
  const right = new FileRunRecordWriter(path, deterministicAtomicOptions({ token: 'token-b' }));
  assert.equal((await left.read()).generation, 0);

  const results = await Promise.allSettled([
    left.compareAndSwap(0, body([record()])),
    right.compareAndSwap(0, body([{ ...record(), runId: uuid(2) }])),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await left.read()).generation, 1);
  await assert.rejects(left.compareAndSwap(0, body([record()])), /generation/u);
});

test('run state rejects malformed and lifecycle-inconsistent records', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
  await mkdir(root, { recursive: true });
  await writeFile(path, '{"schema":"wrong"}\n');
  await assert.rejects(writer.read(), /schema|keys/u);

  await writeFile(path, `${JSON.stringify({
    schema: 'codex-orchestrator.agent-auto-state',
    version: 1,
    generation: 1,
    runs: [{ ...record(), lifecycle: 'review-ready' }],
  })}\n`);
  await assert.rejects(writer.read(), /terminalOutcome|review-ready/u);
});

test('pre-rename faults preserve prior generation and post-rename faults reconcile exact committed bytes', async () => {
  for (const point of ['before-file-fsync', 'before-rename'] as const) {
    const root = await temporaryRoot();
    const path = join(root, 'run-state.json');
    const writer = new FileRunRecordWriter(path, deterministicAtomicOptions({ faultAt: point }));
    await assert.rejects(writer.compareAndSwap(0, body([record()])), new RegExp(point));
    assert.equal((await new FileRunRecordWriter(path, deterministicAtomicOptions()).read()).generation, 0, point);
  }

  for (const point of ['after-rename', 'before-parent-fsync'] as const) {
    const root = await temporaryRoot();
    const path = join(root, 'run-state.json');
    const writer = new FileRunRecordWriter(path, deterministicAtomicOptions({ faultAt: point }));
    const saved = await writer.compareAndSwap(0, body([record()]));
    assert.equal(saved.generation, 1, point);
    assert.equal((await new FileRunRecordWriter(path, deterministicAtomicOptions()).read()).generation, 1, point);
  }
});

test('ambiguous post-rename third state fails closed without overwrite', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions({
    faultAt: 'after-rename',
    afterFault: async () => {
      const value = JSON.parse(await readFile(path, 'utf8')) as { generation: number };
      await writeFile(path, `${JSON.stringify({ ...value, generation: 99 })}\n`);
    },
  }));
  await assert.rejects(writer.compareAndSwap(0, body([record()])), /ambiguous/u);
  assert.match(await readFile(path, 'utf8'), /"generation":99/u);
});

test('file lock blocks stale, foreign, malformed, and live owners without reclaiming', async () => {
  const cases = [
    { version: 1, token: 'old', host: 'host-a', pid: 999, acquiredAt: timestamp() },
    { version: 1, token: 'foreign', host: 'host-b', pid: 123, acquiredAt: timestamp() },
    { version: 1, token: '', host: 'host-a', pid: 123, acquiredAt: timestamp() },
    { version: 1, token: 'live', host: 'host-a', pid: 123, acquiredAt: timestamp() },
  ];
  for (const [index, lock] of cases.entries()) {
    const root = await temporaryRoot();
    const path = join(root, 'run-state.json');
    await writeFile(`${path}.lock`, `${JSON.stringify(lock)}\n`);
    const writer = new FileRunRecordWriter(path, deterministicAtomicOptions({ processAlive: (pid) => pid === 123, lockWaitMs: 5 }));
    await assert.rejects(writer.compareAndSwap(0, body([record()])), /lock/u, `case ${index}`);
    assert.equal(JSON.parse(await readFile(`${path}.lock`, 'utf8')).token, lock.token);
  }
});

test('lock release is token-safe', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions({
    faultAt: 'before-rename',
    afterFault: async () => writeFile(`${path}.lock`, `${JSON.stringify({
      version: 1,
      token: 'replacement',
      host: 'host-a',
      pid: 123,
      acquiredAt: timestamp(),
    })}\n`),
  }));
  await assert.rejects(writer.compareAndSwap(0, body([record()])), /before-rename/u);
  assert.equal(JSON.parse(await readFile(`${path}.lock`, 'utf8')).token, 'replacement');
});

test('proof writer persists only proof schema and cannot encode run lifecycle fields', async () => {
  const root = await temporaryRoot();
  const writer = new FileProofRecordWriter(root, deterministicAtomicOptions());
  const state = await writer.compareAndSwap('proof-1', 'a'.repeat(64), 0, {
    schema: 'codex-orchestrator.acceptance-proof-state',
    version: 1,
    proofId: 'proof-1',
    bindingSha256: 'a'.repeat(64),
    status: 'prepared',
    attempts: [{ attemptId: 'attempt-1', status: 'prepared' }],
    updatedAt: timestamp(),
  });
  assert.equal(state.generation, 1);
  assert.equal('lifecycle' in state, false);

  await assert.rejects(writer.compareAndSwap('proof-2', 'b'.repeat(64), 0, {
    schema: 'codex-orchestrator.acceptance-proof-state',
    version: 1,
    proofId: 'proof-2',
    bindingSha256: 'b'.repeat(64),
    status: 'prepared',
    attempts: [{ attemptId: 'attempt-2', status: 'prepared' }],
    updatedAt: timestamp(),
    lifecycle: 'publishing',
  } as never), /keys/u);
});

test('state publication rejects symlinked parent directories before writing outside', async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  await symlink(outside, join(root, 'linked'), 'dir');
  const writer = new FileRunRecordWriter(join(root, 'linked', 'run-state.json'), deterministicAtomicOptions());
  await assert.rejects(writer.compareAndSwap(0, body([record()])), /direct directory/u);
  assert.deepEqual(await readdir(outside), []);
});

function body(runs: RunRecordV1[]): RunStateBodyV1 {
  return { schema: 'codex-orchestrator.agent-auto-state', version: 1, runs };
}

function record(): RunRecordV1 {
  return {
    runId: uuid(1),
    issueNumber: 42,
    canonicalRepository: 'owner/repo',
    baseSha: 'a'.repeat(40),
    branchName: 'codex/issue-42',
    worktreePath: '/tmp/worktrees/42',
    lifecycle: 'claimed',
    cycle: 1,
    reportRepairs: 0,
    packageVersion: '0.1.51',
    skillHashes: { 'agent-auto': 'b'.repeat(64), 'acceptance-proof': 'c'.repeat(64) },
    checks: [],
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
}

function deterministicAtomicOptions(overrides: {
  token?: string;
  faultAt?: 'before-file-fsync' | 'before-rename' | 'after-rename' | 'before-parent-fsync';
  afterFault?: () => Promise<void>;
  processAlive?: (pid: number) => boolean;
  lockWaitMs?: number;
} = {}) {
  return {
    host: 'host-a',
    pid: 123,
    now: () => timestamp(),
    createToken: () => overrides.token ?? 'token-a',
    isProcessAlive: overrides.processAlive ?? (() => false),
    lockWaitMs: overrides.lockWaitMs ?? 20,
    pollMs: 1,
    fault: overrides.faultAt ? async (point: string) => {
      if (point === overrides.faultAt) {
        await overrides.afterFault?.();
        throw new Error(point);
      }
    } : undefined,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-run-store-'));
  await mkdir(root, { recursive: true });
  return root;
}

function timestamp(): string {
  return '2026-07-16T12:00:00.000Z';
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
