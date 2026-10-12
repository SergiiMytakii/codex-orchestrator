import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

test('legacy envelopes preserve current records and normalize only on the next CAS', async () => {
  for (const version of [2, 3]) {
    const root = await temporaryRoot();
    const path = join(root, 'run-state.json');
    const bytes = Buffer.from(`${canonicalJson({ schema: 'codex-orchestrator.agent-auto-state', version, generation: 7, runs: [record()] })}\n`);
    await writeFile(path, bytes);
    const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
    const current = await writer.read();
    assert.deepEqual(current, { schema: 'codex-orchestrator.run-state', generation: 7, runs: [record()] });
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await writer.compareAndSwap(7, body(current.runs))).generation, 8);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schema, 'codex-orchestrator.run-state');
    assert.equal('version' in JSON.parse(await readFile(path, 'utf8')), false);
  }
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
    const inspection = await writer.inspect();
    assert.equal(inspection.status, 'unsupported');
    assert.equal(inspection.rawSha256, sha256(bytes));
    assert.ok('reason' in inspection && inspection.reason);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await readdir(root), [`run-state-${index}.json`]);
  }
});

test('legacy compatibility never accepts future versions, removed execution fields, or missing authority', async () => {
  const { deliveryAuthority: _authority, ...withoutAuthority } = record();
  const cases = [
    { version: 4, runs: [] },
    { version: 2, runs: [{ ...record(), routeReceipt: {} }] },
    { version: 3, runs: [{ ...withoutAuthority, lifecycle: 'implementing' }] },
    { version: 2, runs: [{ ...record(), pendingEffect: { kind: 'unknown' } }] },
  ];
  for (const sample of cases) {
    const root = await temporaryRoot();
    const path = join(root, 'run-state.json');
    const bytes = Buffer.from(`${canonicalJson({ schema: 'codex-orchestrator.agent-auto-state', generation: 7, ...sample })}\n`);
    await writeFile(path, bytes);
    const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
    assert.equal((await writer.inspect()).status, 'unsupported');
    await assert.rejects(writer.compareAndSwap(7, body([record()])));
    assert.deepEqual(await readFile(path), bytes);
  }
});

test('incompatible legacy records explain the blocker without leaking their contents', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const bytes = Buffer.from(`${canonicalJson({ schema: 'codex-orchestrator.agent-auto-state', version: 2, generation: 7, runs: [{ ...record(), routeExecution: { privateText: 'do-not-print' } }] })}\n`);
  await writeFile(path, bytes);
  const result = await new FileRunRecordWriter(path, deterministicAtomicOptions()).inspect();
  assert.equal(result.status, 'unsupported');
  assert.match('reason' in result ? String(result.reason) : '', /Legacy run records.*archive/u);
  assert.equal(JSON.stringify(result).includes('do-not-print'), false);
  assert.deepEqual(await readFile(path), bytes);
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

test('failed check repair identity is optional, durable, and strictly validated', async () => {
  const path = join(await temporaryRoot(), 'run-state.json');
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
  const original = record();
  await writer.compareAndSwap(0, body([original]));
  assert.deepEqual((await writer.read()).runs[0], original);
  const identity = { id: 'typecheck', command: 'npm run typecheck', candidateTreeSha: 'a'.repeat(40) };
  await writer.compareAndSwap(1, body([{ ...original, failedCheckRepair: identity }]));
  assert.deepEqual((await new FileRunRecordWriter(path).read()).runs[0]?.failedCheckRepair, identity);
  for (const malformed of [
    null,
    { ...identity, id: '' },
    { ...identity, command: '' },
    { ...identity, candidateTreeSha: 'not-a-tree' },
    { id: identity.id, command: identity.command },
    { ...identity, stderrHash: 'b'.repeat(64) },
  ]) {
    await assert.rejects(writer.compareAndSwap(2, body([
      { ...original, failedCheckRepair: malformed } as unknown as RunRecord,
    ])), /failedCheckRepair/u);
  }
  assert.equal((await writer.read()).generation, 2);
});

test('run state rejects retired legacy blocked terminal effects', async () => {
  for (const pendingEffect of [
    { kind: 'blocked-comment', issueNumber: 42, marker: '<!-- blocked -->', bodySha256: 'a'.repeat(64), blockKind: 'external', resumable: true, evidenceCode: 'proof-external-block' },
    { kind: 'blocked-labels', issueNumber: 42, expected: ['agent:auto', 'agent:blocked'], blockKind: 'external', resumable: true, evidenceCode: 'proof-external-block' },
    { kind: 'handoff-comment', issueNumber: 42, marker: '<!-- handoff -->', bodySha256: 'b'.repeat(64) },
    { kind: 'final-labels', issueNumber: 42, expected: ['agent:review'] },
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
  invalid.terminalNotifications!.comment.attempts = -1;
  await assert.rejects(
    new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions())
      .compareAndSwap(0, body([invalid])),
    /attempts/u,
  );
});

test('run state binds terminal notifications and pending delivery effects to the terminal outcome', async () => {
  const terminal = {
    ...reviewReadyRecord(),
    terminalNotifications: {
      version: 1 as const,
      commentCutoff: { commentId: '10', observedAt: timestamp() },
      report: {
        version: 1 as const, outcome: 'review-ready' as const, summary: 'Implemented behavior.',
        pullRequestUrl: 'https://github.com/owner/repo/pull/17', passedChecks: [], publishableProof: [],
        unverified: [], risks: [], reviewFocus: [], nextAction: 'Review the draft PR.',
      },
      comment: { status: 'pending' as const, attempts: 1 },
      labels: { status: 'pending' as const, attempts: 0 },
    },
  };
  const malformed: RunRecord[] = [
    { ...terminal, terminalNotifications: {
      ...terminal.terminalNotifications,
      report: { ...terminal.terminalNotifications.report, outcome: 'blocked' },
    } } as RunRecord,
    { ...terminal, pendingEffect: createPendingEffect({
      kind: 'terminal-comment', issueNumber: 42, marker: '<!-- marker -->', bodySha256: '9'.repeat(64),
      outcome: 'blocked', attempt: 2,
    }) } as RunRecord,
    { ...terminal, pendingEffect: createPendingEffect({
      kind: 'terminal-comment', issueNumber: 42, marker: '<!-- marker -->', bodySha256: '9'.repeat(64),
      outcome: 'review-ready', attempt: 3,
    }) } as RunRecord,
    { ...terminal, terminalNotifications: {
      ...terminal.terminalNotifications,
      labels: { status: 'delivered' as const, attempts: 1 },
    }, pendingEffect: createPendingEffect({
      kind: 'terminal-labels', issueNumber: 42, add: ['agent:review'], remove: ['agent:auto'],
      outcome: 'review-ready', attempt: 2,
    }) } as RunRecord,
  ];

  for (const [index, invalid] of malformed.entries()) {
    const writer = new FileRunRecordWriter(join(await temporaryRoot(), `run-state-${index}.json`), deterministicAtomicOptions());
    await assert.rejects(writer.compareAndSwap(0, body([invalid])), /terminal notification|terminal delivery/u, `${index}`);
  }
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
  await assert.rejects(writer.compareAndSwap(0, body([record()])), /release could not verify/u);
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


test('per-issue journals preserve more than 256 issues without cumulative file limits', async () => {
  const root = await temporaryRoot();
  const repository = FileRunRecordWriter.forRepository(join(root, 'run-state.json'), 'owner/repo', {
    ...deterministicAtomicOptions(), exclusiveRepositoryOwnership: true,
  });
  for (let issue = 1; issue <= 257; issue++) {
    const next = { ...record(), runId: uuid(issue), issueNumber: issue,
      issueSnapshot: { ...record().issueSnapshot, number: issue }, reworkFindings: ['x'.repeat(8000)] };
    await repository.forIssue(issue).compareAndSwap(0, body([next]));
  }
  assert.equal((await repository.inventory()).runs.length, 257);
  assert.equal((await repository.forIssue(257).read()).generation, 1);
  assert.equal((await repository.forIssue(1).read()).runs[0]?.issueNumber, 1);
});


test('large run histories are lossless hashed evidence and stay bounded per state file', async () => {
  const root = await temporaryRoot();
  const writer = FileRunRecordWriter.forRepository(join(root, 'run-state.json'), 'owner/repo', deterministicAtomicOptions()).forIssue(42);
  const original = { ...record(), reworkFindings: Array.from({ length: 1500 }, (_, i) => `${i}:` + 'я'.repeat(500)) };
  await writer.compareAndSwap(0, body([original]));
  const fresh = FileRunRecordWriter.forRepository(join(root, 'run-state.json'), 'owner/repo').forIssue(42);
  assert.deepEqual((await fresh.read()).runs, [original]);
  const directory = join(root, 'runs', sha256('owner/repo'));
  assert.ok((await readFile(join(directory, '42.json'))).length < 1024 * 1024);
  const evidence = join(directory, 'evidence');
  const chunks = await readdir(evidence);
  assert.ok(chunks.length > 1);
  await writeFile(join(evidence, chunks[0]!), 'corrupt');
  assert.equal((await fresh.inspect()).status, 'unsupported');
  await assert.rejects(fresh.compareAndSwap(1, body([record()])), /evidence|unsupported/u);
});


test('migration resumes after a killed writer and preserves the original journal', async () => {
  for (const crashPoint of ['before-file-fsync', 'before-rename', 'after-rename', 'before-parent-fsync']) {
  const root = await temporaryRoot();
  const legacyPath = join(root, 'run-state.json');
  const old = { schema: 'codex-orchestrator.run-state', generation: 9, runs: [record(),
    { ...record(), runId: uuid(2), issueNumber: 43, issueSnapshot: { ...record().issueSnapshot, number: 43 } }] };
  const bytes = `${canonicalJson(old)}\n`;
  await writeFile(legacyPath, bytes);
  const moduleUrl = new URL('../src/v2/run-store.js', import.meta.url).href;
  const optionsCode = `({ host:'same-host', bootId:'same-boot', pid:process.pid, processStartIdentity:'pid:'+process.pid,
    exclusiveRepositoryOwnership:true, inspectProcessIdentity:async (pid)=>{
      try {process.kill(pid,0);return 'unknown'} catch(error){return error.code==='ESRCH'?'absent':'unknown'}
    } })`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {FileRunRecordWriter} from ${JSON.stringify(moduleUrl)};
    const options=${optionsCode};
    options.fault=async(point)=>{if(point===${JSON.stringify(crashPoint)}){process.send('persisted');await new Promise(()=>{});}};
    setInterval(()=>{},1000);
    await FileRunRecordWriter.forRepository(${JSON.stringify(legacyPath)},'owner/repo',options).migrateLegacy();
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    await once(child, 'message');
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
    assert.equal(await readFile(legacyPath, 'utf8'), bytes);
    const fresh = spawn(process.execPath, ['--input-type=module', '-e', `
      import {FileRunRecordWriter} from ${JSON.stringify(moduleUrl)};
      const writer=FileRunRecordWriter.forRepository(${JSON.stringify(legacyPath)},'owner/repo',${optionsCode});
      await writer.migrateLegacy();
      const inventory=await writer.inventory();
      if(inventory.runs.length!==2)throw Error('lost run');
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    fresh.stderr.on('data', (chunk) => { error += chunk.toString(); });
    const [code] = await once(fresh, 'close');
    assert.equal(code, 0, error);
    assert.equal(await readFile(`${legacyPath}.backup`, 'utf8'), bytes);
    const writer = FileRunRecordWriter.forRepository(legacyPath, 'owner/repo', { ...deterministicAtomicOptions(), exclusiveRepositoryOwnership: true });
    assert.deepEqual((await writer.inventory()).runs.map((run) => run.runId).sort(), old.runs.map((run) => run.runId).sort());
  } finally { child.kill('SIGKILL'); }
  }
});

test('migration divergence preserves both destination and original bytes', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const original = `${canonicalJson({ schema: 'codex-orchestrator.run-state', generation: 4, runs: [record()] })}\n`;
  await writeFile(path, original);
  const repository = FileRunRecordWriter.forRepository(path, 'owner/repo', { ...deterministicAtomicOptions(), exclusiveRepositoryOwnership: true });
  await repository.forIssue(42).compareAndSwap(0, body([{ ...record(), cycle: 2 }]));
  await assert.rejects(repository.migrateLegacy(), /diverged/u);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal((await repository.forIssue(42).read()).runs[0]?.cycle, 2);
});

test('large legacy migration archives each Run and missing migrated state blocks replacement', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const large = { ...record(), reworkFindings: Array.from({ length: 8000 }, (_, i) => `${i}:` + 'x'.repeat(200)) };
  const original = `${canonicalJson({ schema: 'codex-orchestrator.run-state', generation: 3, runs: [large] })}\n`;
  assert.ok(Buffer.byteLength(original) > 1024 * 1024);
  await writeFile(path, original);
  const writer = FileRunRecordWriter.forRepository(path, 'owner/repo', { ...deterministicAtomicOptions(), exclusiveRepositoryOwnership: true });
  await writer.migrateLegacy();
  assert.deepEqual((await writer.forIssue(42).read()).runs, [large]);
  assert.equal(await readFile(`${path}.backup`, 'utf8'), original);
  const { unlink } = await import('node:fs/promises');
  await unlink(join(root, 'runs', sha256('owner/repo'), '42.json'));
  assert.equal((await writer.forIssue(42).inspect()).status, 'unsupported');
  await assert.rejects(writer.inventory(), /incomplete/u);
  await assert.rejects(writer.forIssue(42).compareAndSwap(0, body([record()])), /unsupported/u);
});

test('foreign-repository legacy migration is blocked before any destination mutation', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const foreign = { ...record(), runId: uuid(2), canonicalRepository: 'another/repo' };
  const original = `${canonicalJson({ schema: 'codex-orchestrator.run-state', generation: 3, runs: [record(), foreign] })}\n`;
  await writeFile(path, original);
  const writer = FileRunRecordWriter.forRepository(path, 'owner/repo', { ...deterministicAtomicOptions(), exclusiveRepositoryOwnership: true });
  await assert.rejects(writer.migrateLegacy(), /foreign repository/u);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(root), ['run-state.json']);
});
