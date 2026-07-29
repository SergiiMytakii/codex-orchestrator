import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileProofRecordWriter } from '../src/v2/proof-store.js';
import { createInitialDirectReview } from '../src/v2/direct-delivery.js';
import { acceptSpecRevision, createInitialSpecDelivery, createSpecRevision, launchSpecInvocation, prepareSpecInvocation } from '../src/v2/spec-delivery.js';
import { hashRouteDecision, hashTriageArtifact, type RouteReceiptV1 } from '../src/v2/route-decision.js';
import {
  activateReviewFeedback, bootstrapReviewFeedback, createFrozenReviewFeedbackBatch, createReviewFeedbackBootstrap,
  hashReviewFeedbackSnapshot, hashReviewFeedbackText,
} from '../src/v2/review-feedback.js';
import {
  createWaitingQuestion,
  hashNormalizedAnswer,
  type TrustedAnswerReceiptV1,
  type WaitingHumanExecutionV1,
  type WaitingQuestionReceiptV1,
} from '../src/v2/waiting-human.js';
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

test('migrates V1 run state to V2 on the next atomic write', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const prior = reviewReadyRecord();
  await writeFile(path, `${JSON.stringify({
    schema: 'codex-orchestrator.agent-auto-state', version: 1, generation: 7, runs: [prior],
  })}\n`);

  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
  const migrated = await writer.read();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.generation, 7);
  assert.deepEqual(migrated.runs[0]!.terminalOutcome, prior.terminalOutcome);
  assert.equal(migrated.runs[0]!.reviewFeedback?.phase, 'bootstrap-required');

  const saved = await writer.compareAndSwap(7, {
    schema: migrated.schema, version: 2, runs: migrated.runs,
  });
  assert.equal(saved.version, 2);
  assert.equal(saved.generation, 8);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
});

test('V2 to V3 cutover preserves exact raw backup and rollback closes permanently at the publication watermark', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const legacyBytes = Buffer.from(`${JSON.stringify({
    schema: 'codex-orchestrator.agent-auto-state', version: 2, generation: 7, runs: [record()],
  }, null, 2)}\n`);
  await writeFile(path, legacyBytes);
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
  assert.equal((await writer.read()).version, 2);

  const migrated = await writer.compareAndSwap(7, {
    schema: 'codex-orchestrator.agent-auto-state', version: 3, runs: [record()],
  });
  assert.equal(migrated.version, 3);
  assert.deepEqual(await readFile(`${path}.pre-candidate-v3`), legacyBytes);
  const metadata = JSON.parse(await readFile(`${path}.pre-candidate-v3.metadata.json`, 'utf8')) as {
    sourceGeneration: number; sourceBytesSha256: string; publicationEffectPossible: boolean;
  };
  assert.equal(metadata.sourceGeneration, 7);
  assert.equal(metadata.publicationEffectPossible, false);

  let cleaned = false;
  const restored = await writer.rollbackCandidateMigration({
    assertNoActiveProcesses: async () => undefined,
    cleanupCandidateState: async () => { cleaned = true; },
  });
  assert.equal(cleaned, true);
  assert.equal(restored.version, 2);
  assert.deepEqual(await readFile(path), legacyBytes);

  const second = new FileRunRecordWriter(path, deterministicAtomicOptions({ token: 'token-b' }));
  await second.compareAndSwap(7, {
    schema: 'codex-orchestrator.agent-auto-state', version: 3, runs: [record()],
  });
  await second.markPublicationEffectPossible();
  await assert.rejects(second.rollbackCandidateMigration({
    assertNoActiveProcesses: async () => undefined,
    cleanupCandidateState: async () => undefined,
  }), /forbidden/u);
});

test('one-shot report lifecycle migration rewrites safe route, direct-review, and spec-review states without legacy fields', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const route = legacySafeRouteRecord(uuid(21), 121);
  const direct = legacySafeDirectRecord(uuid(22), 122);
  const spec = legacySafeSpecRecord(uuid(23), 123);
  const legacyBytes = Buffer.from(`${JSON.stringify({
    schema: 'codex-orchestrator.agent-auto-state', version: 2, generation: 7, runs: [route, direct, spec],
  }, null, 2)}\n`);
  await writeFile(path, legacyBytes);

  const migrated = await new FileRunRecordWriter(path, deterministicAtomicOptions()).read();
  assert.equal(migrated.generation, 8);
  assert.deepEqual(await readFile(`${path}.pre-report-lifecycle-v1`), legacyBytes);
  const persisted = await readFile(path, 'utf8');
  for (const removed of ['triageTransportRetries', 'ambiguityTransportRetries', 'previousAttemptId', 'invocation']) {
    assert.equal(persisted.includes(`"${removed}"`), false, removed);
  }
  assert.equal('transportRetries' in (migrated.runs[1]!.directReview!.review as any), false);
  assert.equal('transportRetries' in (migrated.runs[2]!.specDelivery!.budgets.review as any), false);
  assert.equal(migrated.runs[0]?.routeExecution?.phase, 'route-complete');
  assert.equal(migrated.runs[1]?.directReview?.stage, 'review-full');
  assert.equal(migrated.runs[2]?.specDelivery?.stage, 'review-full');
});

test('one-shot report lifecycle migration fail-closes launched legacy owners without relaunch authority', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const route = legacyLaunchedRouteRecord(uuid(31), 131);
  const direct = legacyLaunchedDirectRecord(uuid(32), 132);
  const spec = legacyLaunchedSpecRecord(uuid(33), 133);
  const legacyBytes = Buffer.from(`${JSON.stringify({
    schema: 'codex-orchestrator.agent-auto-state', version: 2, generation: 11, runs: [route, direct, spec],
  })}\n`);
  await writeFile(path, legacyBytes);

  const migrated = await new FileRunRecordWriter(path, deterministicAtomicOptions()).read();
  assert.equal(migrated.generation, 12);
  assert.deepEqual(await readFile(`${path}.pre-report-lifecycle-v1`), legacyBytes);
  for (const run of migrated.runs) {
    assert.equal(run.lifecycle, 'blocked');
    assert.deepEqual(run.terminalOutcome && {
      status: run.terminalOutcome.status,
      kind: run.terminalOutcome.status === 'blocked' ? run.terminalOutcome.kind : undefined,
      resumable: run.terminalOutcome.status === 'blocked' ? run.terminalOutcome.resumable : undefined,
    }, { status: 'blocked', kind: 'safety', resumable: false });
    assert.match(run.outcomeEvidenceId ?? '', /report-lifecycle-migration/u);
    assert.equal(run.process, undefined);
    assert.equal(run.reportInvocation, undefined);
  }
  const persisted = await readFile(path, 'utf8');
  for (const removed of ['triageTransportRetries', 'ambiguityTransportRetries', '"purpose":"route"', '"purpose":"code-review"', '"purpose":"spec-review"', '"invocation"']) {
    assert.equal(persisted.includes(removed), false, removed);
  }
});

test('one-shot mutable lifecycle migration rewrites prepared owners and fail-closes launched owners with a raw backup', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const qualification = legacySafeDirectRecord(uuid(41), 141);
  qualification.transportRetries = 1;
  qualification.checkQualification = {
    version: 1, checkPolicySha256: 'a'.repeat(64), repairAttempts: 0, checks: [],
    implementationStarted: false, deniedPathsBaseline: 'b'.repeat(64), repairInvocation: legacyMutableInvocation('prepared'),
  };
  const feedback = legacySafeDirectRecord(uuid(42), 142);
  feedback.reviewFeedback = activateReviewFeedback(
    bootstrapReviewFeedback(createReviewFeedbackBootstrap(), feedback.baseSha, []),
    feedbackBatch(feedback),
  );
  feedback.reviewFeedback.phase = 'repairing';
  feedback.reviewFeedback.implementationInvocation = legacyMutableInvocation('prepared');
  const launched = legacySafeDirectRecord(uuid(43), 143);
  launched.process = { ...legacyReportProcess('code-review'), purpose: 'implementation' };
  const legacyBytes = Buffer.from(`${JSON.stringify({
    schema: 'codex-orchestrator.agent-auto-state', version: 2, generation: 15, runs: [qualification, feedback, launched],
  })}\n`);
  await writeFile(path, legacyBytes);

  const migrated = await new FileRunRecordWriter(path, deterministicAtomicOptions()).read();
  assert.equal(migrated.generation, 16);
  assert.deepEqual(await readFile(`${path}.pre-mutable-lifecycle-v1`), legacyBytes);
  assert.equal(migrated.runs[0]?.lifecycle, 'implementing');
  assert.equal(migrated.runs[1]?.lifecycle, 'implementing');
  assert.equal(migrated.runs[2]?.lifecycle, 'blocked');
  const persisted = await readFile(path, 'utf8');
  for (const removed of ['transportRetries', 'implementationStarted', 'repairInvocation', 'deniedPathsBaseline', 'implementationInvocation', '"purpose":"implementation"']) {
    assert.equal(persisted.includes(removed), false, removed);
  }
});

test('candidate rollback holds the state lock and cannot overwrite an interleaved CAS', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const legacyBytes = Buffer.from(`${JSON.stringify({
    schema: 'codex-orchestrator.agent-auto-state', version: 2, generation: 7, runs: [record()],
  })}\n`);
  await writeFile(path, legacyBytes);
  const rollbackWriter = new FileRunRecordWriter(path, deterministicAtomicOptions({ token: 'rollback', processAlive: () => true, lockWaitMs: 1_000 }));
  const casWriter = new FileRunRecordWriter(path, deterministicAtomicOptions({ token: 'cas', processAlive: () => true, lockWaitMs: 1_000 }));
  const migrated = await rollbackWriter.compareAndSwap(7, {
    schema: 'codex-orchestrator.agent-auto-state', version: 3, runs: [record()],
  });
  let cleanupEntered!: () => void;
  let releaseCleanup!: () => void;
  const entered = new Promise<void>((resolve) => { cleanupEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const rollback = rollbackWriter.rollbackCandidateMigration({
    assertNoActiveProcesses: async () => undefined,
    cleanupCandidateState: async () => { cleanupEntered(); await release; },
  });
  await entered;
  const concurrentCas = casWriter.compareAndSwap(migrated.generation, {
    schema: migrated.schema, version: 3, runs: [{ ...record(), cycle: 2 }],
  });
  const casRejected = assert.rejects(concurrentCas, /generation|state lock disappeared/u);
  releaseCleanup();
  assert.equal((await rollback).version, 2);
  await casRejected;
  assert.deepEqual(await readFile(path), legacyBytes);
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

test('run state accepts bounded semantic budgets and rejects values beyond them', async () => {
  const root = await temporaryRoot();
  const writer = new FileRunRecordWriter(join(root, 'run-state.json'), deterministicAtomicOptions());
  const recoverable = {
    ...record(),
    cycle: 5,
    reportRepairs: 1,
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
    checkQualification: {
      version: 1,
      checkPolicySha256: 'a'.repeat(64),
      repairAttempts: 5,
      checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'failed', outputSha256: 'b'.repeat(64) }],
    },
  } as unknown as RunRecordV1;
  assert.equal((await writer.compareAndSwap(0, body([recoverable]))).runs[0]?.cycle, 5);

  for (const invalid of [
    { ...recoverable, cycle: 6 },
    { ...recoverable, reportRepairs: 2 },
    { ...recoverable, checkQualification: { ...recoverable.checkQualification, repairAttempts: 6 } },
    { ...recoverable, checkQualification: { ...recoverable.checkQualification!, checks: [{ ...recoverable.checkQualification!.checks[0], status: 'unchanged-failure' }] } },
  ]) {
    const next = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
    await assert.rejects(next.compareAndSwap(0, body([invalid as RunRecordV1])), /cycle|Repairs|repairAttempts|status/u);
  }
});

test('run state round-trips the durable blocked-label publication intent exactly', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const active = {
    ...record(),
    intent: {
      kind: 'blocked-labels' as const,
      issueNumber: 42,
      expected: ['agent:auto', 'agent:blocked'],
      blockKind: 'external' as const,
      resumable: true,
      evidenceCode: 'proof-external-block',
    },
  };
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions());
  await writer.compareAndSwap(0, body([active]));
  assert.deepEqual((await new FileRunRecordWriter(path, deterministicAtomicOptions()).read()).runs[0]?.intent, active.intent);

  const invalid = structuredClone(active) as RunRecordV1;
  (invalid.intent as { blockKind: string }).blockKind = 'unknown';
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
    awaitingUser: null,
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
    candidateReviews: 0 as const,
  };
  const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  const triaging = { ...record(), lifecycle: 'triaging' as const, routeExecution: { ...budgets, phase: 'triage-ready' as const } };
  const routed = { ...record(), lifecycle: 'routed' as const, routeExecution: { ...budgets, phase: 'route-complete' as const, triage: triageRef, review: null }, routeReceipt: receipt };
  await writer.compareAndSwap(0, body([triaging]));
  const second = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  assert.equal((await second.compareAndSwap(0, body([routed]))).runs[0]?.lifecycle, 'routed');

  const malformed = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  await assert.rejects(malformed.compareAndSwap(0, body([{ ...routed, routeExecution: { ...routed.routeExecution, phase: 'triage-ready', previousAttemptId: null } } as RunRecordV1])), /route-complete|keys/u);
});

test('run store persists direct review composites and rejects them on non-direct routes', async () => {
  const routed = directRoutedRecord();
  const directReview = createInitialDirectReview({
    targetFingerprint: '7'.repeat(64), codeReviewerSessionId: 'review-session-1',
  });
  const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  const saved = await writer.compareAndSwap(0, body([{ ...routed, lifecycle: 'implementing', directReview }]));
  assert.equal((saved.runs[0] as RunRecordV1 & { directReview: typeof directReview }).directReview.stage, 'review-full');

  const invalid = { ...record(), lifecycle: 'implementing' as const, directReview };
  const rejected = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  await assert.rejects(rejected.compareAndSwap(0, body([invalid])), /direct route/u);
});

test('run store strictly persists active waiting execution bound to the run route and workflow generation', async () => {
  const active = waitingRecord('awaiting-answer');
  const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  const saved = await writer.compareAndSwap(0, body([active]));
  assert.equal(saved.runs[0]?.waitingHuman?.phase, 'awaiting-answer');

  for (const mutate of [
    (run: RunRecordV1) => { (run.waitingHuman as any).effectRetries.questionComment = 2; },
    (run: RunRecordV1) => { (run.waitingHuman as any).questionReceipt.question.workflowGenerationHash = 'a'.repeat(64); },
    (run: RunRecordV1) => { (run.waitingHuman as any).questionReceipt.question.routeDecisionSha256 = '0'.repeat(64); },
    (run: RunRecordV1) => { (run.waitingHuman as any).extra = true; },
  ]) {
    const invalid = structuredClone(active);
    mutate(invalid);
    const next = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
    await assert.rejects(next.compareAndSwap(0, body([invalid])), /waiting|question|route|generation|keys|Retries/u);
  }
});

test('waiting lifecycle rejects phase drift, missing awaiting route, and duplicate or oversized history', async () => {
  const cases = [
    (() => { const run = waitingRecord('awaiting-answer'); run.lifecycle = 'implementing'; return run; })(),
    (() => { const run = waitingRecord('awaiting-answer'); delete run.routeReceipt; return run; })(),
    (() => {
      const run = waitingRecord('awaiting-answer');
      const receipt = questionReceipt(run.routeReceipt);
      (run.waitingHuman as any).history.push({ routeReceipt: run.routeReceipt, question: receipt.question, questionReceipt: receipt, answerReceipt: null, conflictHashes: [] });
      return run;
    })(),
    (() => {
      const run = waitingRecord('awaiting-answer');
      const receipt = questionReceipt(run.routeReceipt);
      const entry = { routeReceipt: run.routeReceipt, question: receipt.question, questionReceipt: receipt, answerReceipt: null, conflictHashes: [] };
      (run.waitingHuman as any).history.push(structuredClone(entry), structuredClone(entry), structuredClone(entry));
      return run;
    })(),
  ];
  for (const invalid of cases) {
    const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
    await assert.rejects(writer.compareAndSwap(0, body([invalid])), /waiting|route|history|lifecycle|question/u);
  }
});

test('resumed waiting history is retained through ordinary non-waiting delivery lifecycles', async () => {
  for (const lifecycle of ['triaging', 'routed', 'implementing', 'spec-authoring', 'reworking', 'checking'] as const) {
    const waitingHuman = waitingRecord('resumed').waitingHuman;
    const run = lifecycle === 'spec-authoring' ? specRoutedRecord() : directRoutedRecord();
    run.waitingHuman = waitingHuman;
    run.lifecycle = lifecycle;
    if (lifecycle === 'triaging') {
      delete run.routeExecution;
      delete run.routeReceipt;
      run.routeExecution = {
        version: 1, triageRepairs: 0,
        candidateReviews: 0, phase: 'triage-ready',
      };
    }
    const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
    assert.equal((await writer.compareAndSwap(0, body([run]))).runs[0]?.waitingHuman?.phase, 'resumed');
  }

  const invalid = waitingRecord('resumed');
  invalid.lifecycle = 'waiting-human';
  delete invalid.routeExecution;
  delete invalid.routeReceipt;
  const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  await assert.rejects(writer.compareAndSwap(0, body([invalid])), /resumed|lifecycle/u);
});

test('terminal waiting history must use history-only and exactly project the terminal outcome', async () => {
  const blocked = waitingRecord('history-only');
  blocked.lifecycle = 'blocked';
  blocked.terminalOutcome = { status: 'blocked', kind: 'safety', resumable: false, evidencePath: 'waiting-evidence.json' };
  delete blocked.routeExecution;
  delete blocked.routeReceipt;
  const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  assert.equal((await writer.compareAndSwap(0, body([blocked]))).runs[0]?.waitingHuman?.phase, 'history-only');

  for (const invalid of [
    (() => { const run = structuredClone(blocked); (run.waitingHuman as any).terminalOutcome.kind = 'external'; return run; })(),
    (() => { const run = structuredClone(blocked); (run.waitingHuman as any).phase = 'resumed'; delete (run.waitingHuman as any).terminalOutcome; (run.waitingHuman as any).trustedAnswer = answerReceipt(questionReceipt().question); return run; })(),
    (() => { const run = structuredClone(blocked); run.lifecycle = 'cancelled'; run.terminalOutcome = { status: 'cancelled', evidencePath: 'waiting-evidence.json' }; return run; })(),
  ]) {
    const next = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
    await assert.rejects(next.compareAndSwap(0, body([invalid as RunRecordV1])), /history-only|terminal|outcome|lifecycle|keys/u);
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

test('atomic state lock reclaims only a positively dead fenced owner under exclusive repository ownership', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'run-state.json');
  const lock = { version: 2, token: 'dead', host: 'host-a', bootId: 'boot-a', pid: 999,
    processStartIdentity: 'old-start', acquiredAt: timestamp() };
  await writeFile(`${path}.lock`, `${JSON.stringify(lock)}\n`);
  const writer = new FileRunRecordWriter(path, deterministicAtomicOptions({
    exclusiveRepositoryOwnership: true,
    inspectProcessIdentity: async () => 'absent',
  }));
  assert.equal((await writer.compareAndSwap(0, body([record()]))).generation, 1);

  for (const inspection of ['unknown', { processStartIdentity: 'old-start' }] as const) {
    const blockedPath = join(await temporaryRoot(), 'run-state.json');
    await writeFile(`${blockedPath}.lock`, `${JSON.stringify(lock)}\n`);
    const blocked = new FileRunRecordWriter(blockedPath, deterministicAtomicOptions({
      exclusiveRepositoryOwnership: true,
      inspectProcessIdentity: async () => inspection,
      lockWaitMs: 5,
    }));
    await assert.rejects(blocked.compareAndSwap(0, body([record()])), /lock/u);
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
    attempts: [{ attemptId: 'attempt-1', purpose: 'proof', status: 'prepared' }],
    startedAt: timestamp(),
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
    attempts: [{ attemptId: 'attempt-2', purpose: 'proof', status: 'prepared' }],
    startedAt: timestamp(),
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
  return { schema: 'codex-orchestrator.agent-auto-state', version: 2, runs };
}

function legacySafeRouteRecord(runId: string, issueNumber: number): any {
  const run = reidentify(directRoutedRecord(), runId, issueNumber);
  run.routeExecution = {
    ...run.routeExecution,
    triageTransportRetries: 1,
    ambiguityTransportRetries: 0,
  };
  return run;
}

function legacySafeDirectRecord(runId: string, issueNumber: number): any {
  const run = reidentify(directRoutedRecord(), runId, issueNumber);
  run.lifecycle = 'implementing';
  run.directReview = createInitialDirectReview({
    targetFingerprint: '7'.repeat(64), codeReviewerSessionId: 'review-session-1',
  });
  run.directReview.review.transportRetries = 1;
  return run;
}

function legacySafeSpecRecord(runId: string, issueNumber: number): any {
  const run = reidentify(specRoutedRecord(), runId, issueNumber);
  run.lifecycle = 'spec-authoring';
  const initial = createInitialSpecDelivery({
    issueNumber, runId, workflowGenerationSha256: run.workflowGeneration.generationHash,
  });
  const launched = launchSpecInvocation(prepareSpecInvocation(initial, {
    mode: 'author', attemptId: 'author-attempt-1', sessionId: 'author-session-1',
  }), { attemptId: 'author-attempt-1', pid: 41, processGroupId: 41 });
  run.specDelivery = acceptSpecRevision(launched, createSpecRevision({
    revision: 1, path: '/state/spec.md', content: '# Spec\n',
    evidence: [{ path: `issue:${issueNumber}`, sha256: 'c'.repeat(64), description: 'Issue authority' }],
    author: { attemptId: 'author-attempt-1', sessionId: 'author-session-1' }, previousRevision: null,
  }));
  run.specDelivery.budgets.review.transportRetries = 1;
  delete run.specDelivery.review.reviewerSessionId;
  return run;
}

function legacyLaunchedRouteRecord(runId: string, issueNumber: number): any {
  const run = reidentify(record(), runId, issueNumber);
  run.lifecycle = 'triaging';
  run.routeExecution = {
    version: 1, triageRepairs: 0, triageTransportRetries: 0, ambiguityTransportRetries: 0,
    candidateReviews: 0, phase: 'triage-in-flight', attemptId: 'triage-attempt-1', startedAt: timestamp(),
  };
  run.process = legacyReportProcess('route');
  return run;
}

function legacyLaunchedDirectRecord(runId: string, issueNumber: number): any {
  const run = legacySafeDirectRecord(runId, issueNumber);
  run.directReview.invocation = {
    attemptId: 'review-attempt-1', operation: 'code-review', mode: 'full', reviewerSessionId: 'review-session-1',
    targetRevision: 1, targetFingerprint: run.directReview.targetFingerprint, closureRequestSha256: null,
    status: 'launched', pid: 51, processGroupId: 51,
  };
  run.process = legacyReportProcess('code-review');
  return run;
}

function legacyLaunchedSpecRecord(runId: string, issueNumber: number): any {
  const run = legacySafeSpecRecord(runId, issueNumber);
  const target = run.specDelivery.revisions.at(-1);
  run.specDelivery.invocation = {
    purpose: 'review', mode: 'full', attemptId: 'spec-review-attempt-1', sessionId: 'spec-review-session-1',
    targetRevision: target.revision, targetSha256: target.revisionSha256, closureRequestSha256: null,
    status: 'launched', pid: 61, processGroupId: 61, reportPath: '/attempts/spec-review/report.json', revisionPath: null,
  };
  run.process = legacyReportProcess('spec-review');
  return run;
}

function legacyReportProcess(purpose: 'route' | 'code-review' | 'spec-review') {
  return {
    pid: 51, processGroupId: 51, startedAt: timestamp(), purpose,
    resumeLifecycle: purpose === 'route' ? 'triaging' : purpose === 'spec-review' ? 'spec-authoring' : 'implementing',
    resumeReviewStage: purpose === 'code-review' ? 'review-full' : null,
    baseline: {
      headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
      untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'legacy-worktree',
    },
  };
}

function legacyMutableInvocation(phase: 'prepared' | 'launched') {
  return {
    phase, attemptId: 'mutable-attempt-1', reportPath: '/tmp/mutable-attempt-1/report.json', preparedAt: timestamp(),
    baseline: {
      headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
      untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'legacy-worktree',
    },
    pid: phase === 'launched' ? 71 : null, processGroupId: phase === 'launched' ? 71 : null,
    launchedAt: phase === 'launched' ? timestamp() : null,
  };
}

function feedbackBatch(run: any) {
  return createFrozenReviewFeedbackBatch({
    runId: run.runId, canonicalRepository: run.canonicalRepository,
    pullRequest: { nodeId: 'PR_1', number: 1, headSha: run.baseSha, headRefName: run.branchName,
      baseRefName: 'main', marker: `<!-- codex-orchestrator:run:${run.runId}:pr -->` },
    priorPublishedHeadSha: run.baseSha,
    sources: [{
      sourceId: 'pr-thread:T_1', kind: 'thread', sourceUrl: 'https://example.invalid/pull/1#discussion_r1',
      path: 'feature.txt', line: 1, body: 'Repair it.', bodySha256: hashReviewFeedbackText('Repair it.'),
      snapshotSha256: hashReviewFeedbackSnapshot({ id: 'T_1' }), threadState: { isResolved: false, isOutdated: false },
      commitSha: run.baseSha, sourceCreatedAt: timestamp(), sourceUpdatedAt: timestamp(),
      author: { login: 'writer', userId: '42' }, permission: { permission: 'write', userId: '42', checkedAt: timestamp() },
    }], frozenAt: timestamp(),
  });
}

function reidentify(run: RunRecordV1, runId: string, issueNumber: number): any {
  return {
    ...structuredClone(run), runId, issueNumber, branchName: `codex/issue-${issueNumber}`,
    worktreePath: `/tmp/worktrees/${issueNumber}`,
    issueSnapshot: { ...run.issueSnapshot, number: issueNumber },
  };
}

function reviewReadyRecord(): RunRecordV1 {
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

function waitingRecord(phase: 'awaiting-answer' | 'resumed' | 'history-only'): RunRecordV1 {
  const routeReceipt = awaitingUserReceipt();
  const receipt = questionReceipt(routeReceipt);
  const answer = answerReceipt(receipt.question);
  const budgets = {
    version: 1 as const,
    clarificationAttempts: 0 as const,
    permissionRetries: 0 as const,
    effectRetries: { questionComment: 0 as const, waitLabels: 0 as const, resumeLabels: 0 as const, revokeLabels: 0 as const },
    history: phase === 'awaiting-answer'
      ? []
      : [{ routeReceipt, question: receipt.question, questionReceipt: receipt, answerReceipt: answer, conflictHashes: [] }],
  };
  let waitingHuman: WaitingHumanExecutionV1;
  if (phase === 'awaiting-answer') waitingHuman = { ...budgets, phase, questionReceipt: receipt };
  else if (phase === 'resumed') waitingHuman = { ...budgets, phase, trustedAnswer: answer };
  else waitingHuman = { ...budgets, phase, terminalOutcome: { status: 'blocked', kind: 'safety' } };
  return {
    ...record(),
    lifecycle: 'waiting-human',
    routeExecution: {
      version: 1, triageRepairs: 0,
      candidateReviews: 1, phase: 'route-complete', triage: routeReceipt.triage, review: routeReceipt.review,
    },
    routeReceipt,
    waitingHuman,
  };
}

function awaitingUserReceipt(): RouteReceiptV1 {
  const generationHash = 'd'.repeat(64);
  const artifact = {
    version: 1 as const,
    status: 'awaiting-user' as const,
    inspectedEvidence: [{ kind: 'issue' as const, location: '#42', summary: 'Read issue.' }],
    assumptions: [],
    direct: null,
    specRequired: null,
    awaitingUser: {
      outcomes: [
        { id: 'a', title: 'Choose A', behaviorDelta: 'Implement A.', evidence: ['Issue does not choose.'] },
        { id: 'b', title: 'Choose B', behaviorDelta: 'Implement B.', evidence: ['Issue allows B.'] },
      ],
      absenceOfAuthorizedChoiceEvidence: ['No maintainer choice exists.'],
      question: 'A or B?',
      recommendation: 'Choose A.',
    },
    blocker: null,
  };
  const artifactSha256 = hashTriageArtifact(artifact);
  const receipt: RouteReceiptV1 = {
    version: 1,
    route: 'awaiting-user',
    triage: { operation: 'triage', attemptId: 'triage-waiting-1', artifactSha256, generationHash },
    review: {
      operation: 'ambiguity-review', attemptId: 'review-waiting-1', candidateSha256: artifactSha256,
      artifactSha256: '9'.repeat(64), verdict: 'approved', generationHash,
    },
    artifact,
    decisionSha256: '',
    decidedAt: timestamp(),
    assumptions: [],
  };
  receipt.decisionSha256 = hashRouteDecision(receipt);
  return receipt;
}

function directRoutedRecord(): RunRecordV1 {
  const base = record();
  const artifact = {
    version: 1 as const, status: 'direct' as const,
    inspectedEvidence: [{ kind: 'issue' as const, location: '#42', summary: 'Read issue.' }], assumptions: [],
    direct: { summary: 'Direct.', behaviors: ['Deliver.'], verification: ['Test.'] },
    specRequired: null, awaitingUser: null, blocker: null,
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
      version: 1, triageRepairs: 0,
      candidateReviews: 0, phase: 'route-complete', triage, review: null,
    },
    routeReceipt,
  };
}

function specRoutedRecord(): RunRecordV1 {
  const base = record();
  const artifact = {
    version: 1 as const, status: 'spec-required' as const,
    inspectedEvidence: [{ kind: 'issue' as const, location: '#42', summary: 'Read issue.' }], assumptions: [],
    direct: null,
    specRequired: {
      summary: 'Specification required.', complexityReasons: ['Shared contract changes.'],
      specMode: 'compact' as const, reviewFocus: ['Contract compatibility.'],
    },
    awaitingUser: null, blocker: null,
  };
  const triage = {
    operation: 'triage' as const, attemptId: 'triage-spec-1', artifactSha256: hashTriageArtifact(artifact),
    generationHash: base.workflowGeneration.generationHash,
  };
  const routeReceipt: RouteReceiptV1 = {
    version: 1, route: 'spec-required', triage, review: null, artifact,
    decisionSha256: '', decidedAt: timestamp(), assumptions: [],
  };
  routeReceipt.decisionSha256 = hashRouteDecision(routeReceipt);
  return {
    ...base,
    lifecycle: 'routed',
    routeExecution: {
      version: 1, triageRepairs: 0,
      candidateReviews: 0, phase: 'route-complete', triage, review: null,
    },
    routeReceipt,
  };
}

function questionReceipt(route = awaitingUserReceipt()): WaitingQuestionReceiptV1 {
  const question = createWaitingQuestion({
    runId: uuid(1), generation: 1, routeDecisionSha256: route.decisionSha256,
    workflowGenerationHash: 'd'.repeat(64), priorQuestionSha256: null, conflictHashes: [],
    recommendation: 'Choose A.', question: 'A or B?',
  });
  return {
    question,
    commentId: '9007199254740993',
    commentUrl: 'https://example.invalid/comments/9007199254740993',
    authorId: '12345678901234567',
    author: 'runner',
    createdAt: timestamp(),
    observedAt: timestamp(),
  };
}

function answerReceipt(question: ReturnType<typeof createWaitingQuestion>): TrustedAnswerReceiptV1 {
  const normalizedAnswer = 'Choose A';
  return {
    version: 1,
    questionId: question.questionId,
    questionSha256: question.questionSha256,
    commentId: '9007199254740995',
    commentUrl: 'https://example.invalid/comments/9007199254740995',
    authorId: '12345678901234568',
    author: 'maintainer',
    permission: 'write',
    permissionCheckedAt: '2026-07-16T12:02:00.000Z',
    commentCreatedAt: '2026-07-16T12:01:00.000Z',
    commentUpdatedAt: '2026-07-16T12:01:00.000Z',
    observedAt: '2026-07-16T12:02:00.000Z',
    normalizedAnswer,
    normalizedSha256: hashNormalizedAnswer(normalizedAnswer),
    duplicateCommentIds: ['9007199254740997'],
  };
}

function deterministicAtomicOptions(overrides: {
  token?: string;
  faultAt?: 'before-file-fsync' | 'before-rename' | 'after-rename' | 'before-parent-fsync';
  afterFault?: () => Promise<void>;
  processAlive?: (pid: number) => boolean;
  lockWaitMs?: number;
  exclusiveRepositoryOwnership?: boolean;
  inspectProcessIdentity?: (pid: number) => Promise<'absent' | 'unknown' | { processStartIdentity: string }>;
} = {}) {
  return {
    host: 'host-a',
    bootId: 'boot-a',
    pid: 123,
    processStartIdentity: 'start-123',
    inspectProcessIdentity: overrides.inspectProcessIdentity ?? (async (pid: number) => overrides.processAlive?.(pid)
      ? { processStartIdentity: `start-${pid}` }
      : 'unknown' as const),
    exclusiveRepositoryOwnership: overrides.exclusiveRepositoryOwnership ?? false,
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
