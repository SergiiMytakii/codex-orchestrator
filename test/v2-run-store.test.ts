import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileProofRecordWriter } from '../src/v2/proof-store.js';
import { createInitialDirectReview } from '../src/v2/direct-delivery.js';
import { hashRouteDecision, hashTriageArtifact, type RouteReceiptV1 } from '../src/v2/route-decision.js';
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
  } as unknown as RunRecordV1;
  assert.equal((await writer.compareAndSwap(0, body([recoverable]))).runs[0]?.cycle, 5);

  for (const invalid of [
    { ...recoverable, cycle: 6 },
    { ...recoverable, reportRepairs: 2 },
    { ...recoverable, transportRetries: 2 },
  ]) {
    const next = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
    await assert.rejects(next.compareAndSwap(0, body([invalid as RunRecordV1])), /cycle|Repairs|Retries/u);
  }
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
    triageTransportRetries: 0 as const,
    ambiguityTransportRetries: 0 as const,
    candidateReviews: 0 as const,
  };
  const writer = new FileRunRecordWriter(join(await temporaryRoot(), 'run-state.json'), deterministicAtomicOptions());
  const triaging = { ...record(), lifecycle: 'triaging' as const, routeExecution: { ...budgets, phase: 'triage-ready' as const, previousAttemptId: null } };
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
        version: 1, triageRepairs: 0, triageTransportRetries: 0, ambiguityTransportRetries: 0,
        candidateReviews: 0, phase: 'triage-ready', previousAttemptId: null,
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
      version: 1, triageRepairs: 0, triageTransportRetries: 0, ambiguityTransportRetries: 0,
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
      version: 1, triageRepairs: 0, triageTransportRetries: 0, ambiguityTransportRetries: 0,
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
      version: 1, triageRepairs: 0, triageTransportRetries: 0, ambiguityTransportRetries: 0,
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
