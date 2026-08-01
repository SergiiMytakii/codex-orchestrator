import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalJson, sha256 } from '../src/v2/containment.js';
import { createInitialReviewData } from '../src/v2/review-data.js';
import { createDirectDeliveryAuthority } from '../src/v2/delivery-authority.js';
import { hashRouteDecision, hashTriageArtifact, type RouteReceiptV1 } from '../src/v2/route-decision.js';
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

test('run state accepts bounded recovery counters and rejects values beyond the autonomous budgets', async () => {
  const root = await temporaryRoot();
  const writer = new FileRunRecordWriter(join(root, 'run-state.json'), deterministicAtomicOptions());
  const recoverable = {
    ...record(),
    cycle: 5,
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
  assert.equal((await writer.compareAndSwap(0, body([recoverable]))).runs[0]?.cycle, 5);

  for (const invalid of [
    { ...recoverable, cycle: 6 },
    { ...recoverable, reportRepairs: 2 },
    { ...recoverable, transportRetries: 2 },
  ]) {
    const next = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
    await assert.rejects(next.compareAndSwap(0, body([invalid as RunRecord])), /cycle|Repairs|Retries|status|launches/u);
  }
});

test('run state round-trips the durable blocked-label pending effect exactly', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const active = {
    ...record(),
    pendingEffect: createPendingEffect({
      kind: 'blocked-labels' as const,
      issueNumber: 42,
      expected: ['agent:auto', 'agent:blocked'],
      blockKind: 'external' as const,
      resumable: true,
      evidenceCode: 'proof-external-block',
    }),
  };
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
  await writer.compareAndSwap(0, body([active]));
  assert.deepEqual((await new FileRunRecordWriter(path, deterministicAtomicOptions()).read()).runs[0]?.pendingEffect, active.pendingEffect);

  const invalid = structuredClone(active) as RunRecord;
  (invalid.pendingEffect as { blockKind: string }).blockKind = 'unknown';
  const rejected = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  await assert.rejects(rejected.compareAndSwap(0, body([invalid])), /blockKind/u);
});


test('run store persists exact triaging and routed state', async () => {
  const generationHash = record().workflowGeneration.generationHash;
  const triage = {
    version: 1 as const,
    status: 'direct' as const,
    inspectedEvidence: [{ kind: 'issue' as const, location: '#42', summary: 'Read issue.' }],
    assumptions: [],
    direct: { summary: 'Direct.', behaviors: ['Deliver.'], verification: ['Test.'] },
    specRequired: null,
    blocker: null,
  };
  const triageRef = {
    operation: 'triage' as const,
    attemptId: 'triage-1',
    artifactSha256: hashTriageArtifact(triage),
    generationHash,
  };
  const receipt: RouteReceiptV1 = {
    version: 1,
    route: 'direct',
    triage: triageRef,
    review: null,
    artifact: triage,
    decisionSha256: '',
    decidedAt: timestamp(),
    assumptions: [],
  };
  receipt.decisionSha256 = hashRouteDecision(receipt);
  const budgets = {
    version: 1 as const,
    triageRepairs: 0 as const,
    triageTransportRetries: 0 as const,
  };
  const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  const triaging = { ...record(), lifecycle: 'triaging' as const, routeExecution: { ...budgets, phase: 'triage-ready' as const } };
  const routed = { ...record(), lifecycle: 'routed' as const, routeExecution: { ...budgets, phase: 'route-complete' as const, triage: triageRef }, routeReceipt: receipt };
  await writer.compareAndSwap(0, body([triaging]));
  const second = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  assert.equal((await second.compareAndSwap(0, body([routed]))).runs[0]?.lifecycle, 'routed');

  const malformed = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  await assert.rejects(malformed.compareAndSwap(0, body([{ ...routed, routeExecution: { ...routed.routeExecution, phase: 'triage-ready' } } as RunRecord])), /route-complete|keys/u);
});

test('run store persists review data composites and rejects them on non-direct routes', async () => {
  const routed = directRoutedRecord();
  const reviewData = createInitialReviewData({
    targetFingerprint: '7'.repeat(64), codeReviewerSessionId: 'review-session-1',
  });
  const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  const saved = await writer.compareAndSwap(0, body([{
    ...routed, lifecycle: 'implementing', reviewData,
    deliveryAuthority: createDirectDeliveryAuthority(routed.routeReceipt!),
  }]));
  assert.equal((saved.runs[0] as RunRecord & { reviewData: typeof reviewData }).reviewData.receipt, null);

  const invalid = { ...record(), lifecycle: 'implementing' as const, reviewData };
  const rejected = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  await assert.rejects(rejected.compareAndSwap(0, body([invalid])), /direct route|delivery.?authority/u);
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

function directRoutedRecord(): RunRecord {
  const base = record();
  const artifact = {
    version: 1 as const, status: 'direct' as const,
    inspectedEvidence: [{ kind: 'issue' as const, location: '#42', summary: 'Read issue.' }], assumptions: [],
    direct: { summary: 'Direct.', behaviors: ['Deliver.'], verification: ['Test.'] },
    specRequired: null, blocker: null,
  };
  const triage = {
    operation: 'triage' as const, attemptId: 'triage-direct-1', artifactSha256: hashTriageArtifact(artifact),
    generationHash: base.workflowGeneration.generationHash,
  };
  const routeReceipt: RouteReceiptV1 = {
    version: 1, route: 'direct', triage, review: null, artifact, decisionSha256: '', decidedAt: timestamp(), assumptions: [],
  };
  routeReceipt.decisionSha256 = hashRouteDecision(routeReceipt);
  return {
    ...base,
    lifecycle: 'routed',
    routeExecution: {
      version: 1, triageRepairs: 0, triageTransportRetries: 0, phase: 'route-complete', triage,
    },
    routeReceipt,
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
