import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalJson, sha256 } from '../src/v2/containment.js';
import { createIssueDeliveryAuthority } from '../src/v2/delivery-authority.js';
import {
  FileRunRecordWriter,
  InMemoryRunRecordWriter,
  createPendingEffect,
  type RunRecord,
  type RunStateBody,
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
  await assert.rejects(left.compareAndSwap(1, {
    ...body([record()]),
    version: 1,
  } as never), /keys/u);
  assert.equal((await left.read()).generation, 1);
});

test('run state inspection reports absent without creating storage', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  assert.deepEqual(await new FileRunRecordWriter(path, deterministicAtomicOptions()).inspect(), {
    status: 'absent',
    rawSha256: null,
  });
  assert.deepEqual(await new InMemoryRunRecordWriter().inspect(), {
    status: 'absent',
    rawSha256: null,
  });
  assert.deepEqual(await readdir(root), []);
});

test('run state inspection reports supported exact-schema state with its raw SHA', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const fileWriter = new FileRunRecordWriter(path, deterministicAtomicOptions());
  const saved = await fileWriter.compareAndSwap(0, body([record()]));
  const rawBytes = await readFile(path);
  assert.deepEqual(await fileWriter.inspect(), {
    status: 'supported',
    rawSha256: sha256(rawBytes),
    state: saved,
  });
  assert.equal('version' in saved, false);

  const memoryWriter = new InMemoryRunRecordWriter();
  const memoryState = await memoryWriter.compareAndSwap(0, body([record()]));
  assert.deepEqual(await memoryWriter.inspect(), {
    status: 'supported',
    rawSha256: sha256(`${canonicalJson(memoryState)}\n`),
    state: memoryState,
  });
});

test('run state inspection reports malformed and unknown schemas as unsupported without effects', async () => {
  const { lifecycle: _missingDiscriminator, ...withoutLifecycle } = record();
  const unsupportedBytes = [
    Buffer.from('{malformed-json\n'),
    Buffer.from(`${JSON.stringify({ schema: 'codex-orchestrator.agent-auto-state', generation: 7, runs: [] })}\n`),
    Buffer.from(`${JSON.stringify({ schema: 'codex-orchestrator.run-state', version: 1, generation: 7, runs: [] })}\n`),
    Buffer.from(`${JSON.stringify({ schema: 'codex-orchestrator.run-state', generation: 7, runs: [], unknown: true })}\n`),
    Buffer.from(`${canonicalJson({ schema: 'codex-orchestrator.run-state', generation: 7, runs: [withoutLifecycle] })}\n`),
  ];

  for (const [index, bytes] of unsupportedBytes.entries()) {
    const root = await temporaryRoot();
    const path = join(root, `run-state-${index}.json`);
    await writeFile(path, bytes);
    const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
    assert.deepEqual(await writer.inspect(), {
      status: 'unsupported',
      rawSha256: sha256(bytes),
    });
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await readdir(root), [`run-state-${index}.json`]);
  }
});

test('run state rejects malformed and lifecycle-inconsistent records', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
  await mkdir(root, { recursive: true });
  await writeFile(path, '{"schema":"wrong"}\n');
  await assert.rejects(writer.read(), /unsupported/u);

  await writeFile(path, `${JSON.stringify({
    schema: 'codex-orchestrator.run-state',
    generation: 1,
    runs: [{ ...record(), lifecycle: 'review-ready' }],
  })}\n`);
  await assert.rejects(writer.read(), /unsupported/u);
});

test('run state accepts unbounded semantic revisions and resumable infrastructure recovery counters', async () => {
  const root = await temporaryRoot();
  const writer = new FileRunRecordWriter(join(root, 'run-state.json'), deterministicAtomicOptions());
  const recoverable = {
    ...record(),
    cycle: 100,
    reportRepairs: 1,
    transportRetries: 1,
    issueSnapshot: {
      number: 42,
      title: 'Implement behavior',
      body: 'Acceptance criteria',
      url: 'https://example.invalid/issues/42',
      state: 'OPEN',
      labels: ['agent:auto'],
    },
    frozenCriteria: [{ id: 'criterion-1', order: 1, text: 'The behavior works.', source: 'explicit' }],
    reworkFindings: ['typecheck failed'],
  } as unknown as RunRecord;
  assert.equal((await writer.compareAndSwap(0, body([recoverable]))).runs[0]?.cycle, 100);

  for (const resumed of [
    { ...recoverable, reportRepairs: 100 },
    { ...recoverable, transportRetries: 100 },
  ]) {
    const next = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
    assert.equal((await next.compareAndSwap(0, body([resumed as RunRecord]))).runs[0]?.cycle, 100);
  }
});

test('run state rejects retired legacy blocked terminal effects', async () => {
  for (const pendingEffect of [
    { kind: 'blocked-comment', issueNumber: 42, marker: '<!-- blocked -->', bodySha256: 'a'.repeat(64), blockKind: 'external', resumable: true, evidenceCode: 'proof-external-block' },
    { kind: 'blocked-labels', issueNumber: 42, expected: ['agent:auto', 'agent:blocked'], blockKind: 'external', resumable: true, evidenceCode: 'proof-external-block' },
  ]) {
    const effect = { ...pendingEffect, effectId: sha256(canonicalJson(pendingEffect)) };
    const active = { ...record(), pendingEffect: effect } as unknown as RunRecord;
    const rejected = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
    await assert.rejects(rejected.compareAndSwap(0, body([active])), /pendingEffect\.kind is invalid/u, pendingEffect.kind);
  }
});

test('run state round-trips bounded terminal notification diagnostics and cutoff', async () => {
  const root = await temporaryRoot();
  const active: RunRecord = {
    ...reviewReadyRecord(),
    terminalNotifications: {
      version: 1,
      commentCutoff: { commentId: '90071992547409931234', observedAt: timestamp() },
      report: {
        version: 1, outcome: 'review-ready', summary: 'Implemented behavior.',
        pullRequestUrl: 'https://github.com/owner/repo/pull/17',
        passedChecks: ['typecheck'], publishableProof: ['proof-1: screenshot'], unverified: [],
        risks: [], reviewFocus: ['correctness'], nextAction: 'Review the draft PR.',
      },
      comment: { status: 'pending', attempts: 2, diagnostic: 'terminal-comment-delivery-unknown' },
      labels: { status: 'delivered', attempts: 1 },
    },
    pendingEffect: createPendingEffect({
      kind: 'terminal-comment', issueNumber: 42, marker: '<!-- marker -->', bodySha256: '9'.repeat(64),
      outcome: 'review-ready', attempt: 3,
    }),
  };
  const path = join(root, 'run-state.json');
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
  await writer.compareAndSwap(0, body([active]));
  assert.deepEqual((await new FileRunRecordWriter(path, deterministicAtomicOptions()).read()).runs[0], active);

  const invalid = structuredClone(active);
  invalid.terminalNotifications!.comment.attempts = 4;
  await assert.rejects(
    new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions())
      .compareAndSwap(0, body([invalid])),
    /attempts/u,
  );
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

test('state publication rejects symlinked parent directories before writing outside', async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  await symlink(outside, join(root, 'linked'), 'dir');
  const writer = new FileRunRecordWriter(join(root, 'linked', 'run-state.json'), deterministicAtomicOptions());
  await assert.rejects(writer.compareAndSwap(0, body([record()])), /direct directory/u);
  assert.deepEqual(await readdir(outside), []);
});

function body(runs: RunRecord[]): RunStateBody {
  return { schema: 'codex-orchestrator.run-state', runs };
}

function reviewReadyRecord(): RunRecord {
  return {
    ...record(),
    lifecycle: 'review-ready',
    deliveryAuthority: createIssueDeliveryAuthority({
      issueNumber: 42,
      issueUrl: 'https://example.invalid/issues/42',
      title: 'Implement behavior',
      body: 'Acceptance criteria',
      authorizationLabel: 'agent:auto',
    }),
    proofReceipt: {
      proofId: 'proof-1', bindingSha256: '8'.repeat(64), summary: 'Passed.',
      publishableEvidence: [], localEvidenceId: 'evidence-1',
    },
    terminalOutcome: {
      status: 'review-ready', pullRequestUrl: 'https://github.com/owner/repo/pull/17', evidencePath: 'evidence/review-ready.json',
    },
  };
}

function record(): RunRecord {
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
    transportRetries: 0,
    issueSnapshot: {
      number: 42,
      title: 'Implement behavior',
      body: 'Acceptance criteria',
      url: 'https://example.invalid/issues/42',
      state: 'OPEN',
      labels: ['agent:auto'],
    },
    frozenCriteria: [{ id: 'criterion-1', order: 1, text: 'The behavior works.', source: 'explicit' }],
    reworkFindings: [],
    packageVersion: '0.1.51',
    workflowGeneration: {
      generationHash: 'd'.repeat(64),
      manifestSha256: 'e'.repeat(64),
      packageVersion: '0.1.51',
      generationRoot: '/tmp/workflow-generations/d.content.token',
      contentSha256: 'f'.repeat(64),
    },
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
