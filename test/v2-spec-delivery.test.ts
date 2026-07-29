import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  acceptSpecReview,
  acceptSpecRevision,
  consumeSpecReportRepair,
  createInitialSpecDelivery,
  createSpecRevision,
  freezeApprovedSpec,
  hashSpecClosureRequest,
  hashSpecRevision,
  reserveSpecAuthorSession,
  reserveSpecReviewerSession,
  validateFrozenSpecReceipt,
  validateSpecDelivery,
  validateSpecRevision,
  type SpecDeliveryV1,
  type SpecReviewReportV1,
} from '../src/v2/spec-delivery.js';
import { SpecCoordinator } from '../src/v2/spec-coordinator.js';
import { InjectedContainedReportOperation, type DurableReportInvocationV1 } from '../src/v2/contained-report-operation.js';
import { canonicalJson } from '../src/v2/containment.js';
import type { WorkflowGenerationReceipt, WorkflowOperationPolicy } from '../src/v2/workflow-assets.js';

const workflowGenerationSha256 = 'a'.repeat(64);
const reportSha256 = 'b'.repeat(64);

test('spec revisions have deterministic hashes and reject content, evidence, and chain tampering', () => {
  const revision = firstRevision();
  const canonicalPayload = '{"author":{"attemptId":"author-attempt-1","sessionId":"author-session-1"},"content":"# Exact spec\\n","contentSha256":"2049b76ed78250738c5d716e746bf251103ad398d660dc60afc23b74b78639d3","evidence":[{"description":"Approved issue intent","path":"issue:1230","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"path":"docs/spec.md","previousRevisionSha256":null,"revision":1,"version":1}';
  const expected = createHash('sha256')
    .update(`codex-orchestrator-spec-revision-v1\0${canonicalPayload}`, 'utf8').digest('hex');

  assert.equal(revision.revisionSha256, expected);
  assert.equal(hashSpecRevision(revision), expected);
  assert.deepEqual(validateSpecRevision(revision, null), revision);
  assert.throws(() => validateSpecRevision({ ...revision, content: '# changed\n' }, null), /content hash/u);
  assert.throws(() => validateSpecRevision({ ...revision, evidence: [] }, null), /evidence|revision hash/u);

  const second = createSpecRevision({
    revision: 2, path: revision.path, content: '# Repaired spec\n', evidence: revision.evidence,
    author: { attemptId: 'author-attempt-2', sessionId: 'author-session-1' }, previousRevision: revision,
  });
  assert.deepEqual(validateSpecRevision(second, revision), second);
  assert.throws(() => validateSpecRevision({ ...second, previousRevisionSha256: 'd'.repeat(64) }, revision), /chain/u);
});

test('author and reviewer are independent and Full is mandatory before approval', () => {
  const state = stateWithFirstRevision();
  assert.equal(state.stage, 'review-full');
  assert.throws(() => acceptSpecReview(state, reviewReport({
    reviewer: { attemptId: 'review-attempt-1', sessionId: 'author-session-1' },
  }), reportSha256), /correlation/u);
  assert.throws(() => acceptSpecReview(state, reviewReport({
    reviewer: { attemptId: 'author-attempt-1', sessionId: 'review-session-1' },
  }), reportSha256), /correlation/u);

  const approved = acceptSpecReview(state, reviewReport({ verdict: 'approved' }), reportSha256);
  assert.equal(approved.stage, 'approved');
  assert.equal(approved.review.mode, 'full');
  assert.deepEqual(validateSpecDelivery(approved), approved);
});

test('needs-work Full creates a canonical ledger and repair creates an immutable revision for affected Closure', () => {
  const full = stateWithFirstRevision();
  const defect = blocker({ status: 'open' });
  const needsWork = reviewReport({ verdict: 'needs-work', defects: [defect] });
  const repair = acceptSpecReview(full, needsWork, reportSha256);
  assert.equal(repair.stage, 'author-repair');
  assert.equal(repair.budgets.repairCycles, 1);
  assert.deepEqual(repair.review.defects.map((item) => item.id), ['SPEC-001']);
  assert.throws(() => acceptSpecReview(repair, needsWork, reportSha256), /correlation/u);
  assert.equal(repair.budgets.repairCycles, 1);

  const authorState = reserveSpecAuthorSession(repair, 'author-session-1');
  const revision2 = createSpecRevision({
    revision: 2, path: 'docs/spec.md', content: '# Repaired spec\n', evidence: firstRevision().evidence,
    author: { attemptId: 'author-attempt-2', sessionId: 'author-session-1' }, previousRevision: firstRevision(),
  });
  const closure = acceptSpecRevision(authorState, revision2);

  assert.equal(closure.stage, 'review-closure');
  assert.deepEqual(closure.revisions.map((item) => item.content), ['# Exact spec\n', '# Repaired spec\n']);
  assert.deepEqual(closure.review.affectedDefectIds, ['SPEC-001']);
  assert.equal(closure.review.defects[0]?.status, 'fixed');
  assert.equal(closure.review.closureRequestSha256, hashSpecClosureRequest(closure));
  assert.equal(closure.review.reviewer?.sessionId, 'review-session-1');
  assert.deepEqual(validateSpecDelivery(closure), closure);
});

test('Closure is correlated, affected-only, and cannot silently drop mandatory coverage', () => {
  const closure = closureReady();
  const verified = blocker({ status: 'verified', statusTargetRevision: 2 });
  const report = reviewReport({
    targetRevision: 2, targetSha256: closure.revisions[1]!.revisionSha256, mode: 'closure', verdict: 'approved',
    reviewer: { attemptId: 'closure-attempt-1', sessionId: 'review-session-1' },
    defects: [verified], affectedDefectIds: ['SPEC-001'], affectedContracts: closure.review.affectedContracts,
    closureRequestSha256: closure.review.closureRequestSha256,
  });
  assert.equal(acceptSpecReview(closure, report, 'd'.repeat(64)).stage, 'approved');
  assert.throws(() => acceptSpecReview(closure, { ...report, coverage: report.coverage.slice(1) }, 'd'.repeat(64)), /mandatory coverage/u);
  assert.throws(() => acceptSpecReview(closure, { ...report, defects: [] }, 'd'.repeat(64)), /affected defect IDs/u);
});

test('Closure preserves omitted canonical defects, invalidation returns to Full, and a second repair wave exhausts', () => {
  const second = blocker({ id: 'SPEC-002', status: 'fixed' });
  const repair = acceptSpecReview(stateWithFirstRevision(), reviewReport({
    verdict: 'needs-work', defects: [blocker({ status: 'open' }), second],
  }), reportSha256);
  const author = reserveSpecAuthorSession(repair, 'author-session-1');
  const closure = acceptSpecRevision(author, createSpecRevision({
    revision: 2, path: 'docs/spec.md', content: '# Repaired spec\n', evidence: firstRevision().evidence,
    author: { attemptId: 'author-attempt-2', sessionId: 'author-session-1' }, previousRevision: firstRevision(),
  }));
  const base = reviewReport({
    targetRevision: 2, targetSha256: closure.revisions[1]!.revisionSha256, mode: 'closure',
    reviewer: { attemptId: 'closure-attempt-1', sessionId: 'review-session-1' },
    affectedDefectIds: ['SPEC-001'], closureRequestSha256: closure.review.closureRequestSha256,
    defects: [blocker({ status: 'verified', statusTargetRevision: 2 })],
  });
  assert.throws(() => acceptSpecReview(closure, base, 'd'.repeat(64)), /unresolved/u);
  assert.equal(acceptSpecReview(closure, { ...base, coverageInvalidated: true }, 'd'.repeat(64)).stage, 'review-full');
  assert.equal(acceptSpecReview(closure, { ...base, verdict: 'needs-work', defects: [blocker({ status: 'reopened', statusTargetRevision: 2 })] }, 'd'.repeat(64)).stage, 'exhausted');
});

test('approval and freeze reject unresolved blockers or execution risks unless each has an explicit accepted risk', () => {
  const launched = stateWithFirstRevision();
  const risk = blocker({ id: 'RISK-001', class: 'execution-risk', status: 'open' });
  assert.throws(() => acceptSpecReview(launched, reviewReport({ verdict: 'approved', defects: [risk] }), reportSha256), /unresolved/u);

  assert.throws(() => acceptSpecReview(launched, reviewReport({
    verdict: 'approved', defects: [risk], acceptedRisks: [{
      defectId: 'RISK-001', rationale: 'Accepted local-read boundary', policy: 'approved-product-policy',
      acceptedBy: 'maintainer-1',
    }],
  }), reportSha256), /reviewer cannot authorize/u);
  const approved = acceptSpecReview(launched, reviewReport({
    verdict: 'approved', defects: [{ ...risk, status: 'verified' }],
  }), reportSha256);
  const frozen = freezeApprovedSpec(approved);
  assert.equal(frozen.stage, 'frozen');
  assert.equal(frozen.frozen?.issueNumber, 1230);
  assert.equal(frozen.frozen?.runId, 'run-1230');
  assert.equal(frozen.frozen?.workflowGenerationSha256, workflowGenerationSha256);
  assert.equal(frozen.frozen?.revisionSha256, approved.revisions[0]!.revisionSha256);
  assert.deepEqual(validateFrozenSpecReceipt(frozen.frozen, approved), frozen.frozen);
  assert.throws(() => validateFrozenSpecReceipt({ ...frozen.frozen!, revisionSha256: 'e'.repeat(64) }, approved), /binding|receipt hash/u);
});

test('author and review semantic report-repair budgets are separate and infrastructure has no phase budget', () => {
  const initial = createInitialSpecDelivery(identity());
  const authorRepair = consumeSpecReportRepair(initial, 'author');
  assert.deepEqual(authorRepair.budgets, {
    author: { reportRepairs: 1 }, review: { reportRepairs: 0 },
    repairCycles: 0,
  });
  assert.throws(() => consumeSpecReportRepair(authorRepair, 'author'), /exhausted/u);

  assert.equal('transportRetries' in authorRepair.budgets.author, false);
  assert.deepEqual(validateSpecDelivery(reserveSpecAuthorSession(createInitialSpecDelivery(identity()), 'author-session-1')).budgets,
    createInitialSpecDelivery(identity()).budgets);
});

test('strict state validation rejects unknown keys, impossible stages, stale invocations, and revision tampering', () => {
  const state = stateWithFirstRevision();
  assert.throws(() => validateSpecDelivery({ ...state, extra: true }), /unknown or missing keys/u);
  assert.throws(() => validateSpecDelivery({ ...state, stage: 'approved' }), /approved/u);
  assert.throws(() => validateSpecDelivery({ ...state, invocation: {} }), /unknown or missing keys/u);
  assert.throws(() => validateSpecDelivery({
    ...state, revisions: [{ ...state.revisions[0]!, content: '# tampered\n' }],
  }), /content hash/u);
});

test('coordinator settles canonical spec-review output without moving review mechanics into spec state', async () => {
  let persisted = stateWithFirstRevision();
  let invocation: any;
  let launches = 0;
  const coordinator = new SpecCoordinator({
    state: {
      read: async () => structuredClone(persisted),
      compareAndSwap: async (expected, next) => {
        if (JSON.stringify(expected) !== JSON.stringify(persisted)) return false;
        persisted = structuredClone(next);
        return true;
      },
      reviewInvocation: () => ({
        read: async () => structuredClone(invocation),
        compareAndSwap: async (_expected, next) => { invocation = structuredClone(next); return true; },
      }),
      authorInvocation: () => ({ read: async () => undefined, compareAndSwap: async () => false }),
      settleAuthor: async () => false,
      settleReview: async (expected, next, attemptId) => {
        if (JSON.stringify(expected) !== JSON.stringify(persisted) || invocation?.attemptId !== attemptId) return false;
        persisted = structuredClone(next); invocation = undefined; return true;
      },
    },
    createAuthorSessionId: () => 'author-session-1', createReviewerSessionId: () => 'review-session-1',
    operation: {
      author: async () => { launches += 1; return { status: 'blocked', kind: 'safety', code: 'unexpected' }; },
      review: async ({ state, invocationState }) => {
        launches += 1;
        const target = state.revisions.at(-1)!;
        const attemptId = launches === 1 ? 'review-malformed' : 'review-recovery';
        invocation = { attemptId };
        if (launches === 1) return { status: 'invalid', code: 'spec-review-report-invalid', attemptId };
        return { status: 'completed', reportSha256, value: reviewReport({
          targetRevision: target.revision, targetSha256: target.revisionSha256,
          reviewer: { attemptId, sessionId: 'review-session-1' },
        }) };
      },
    },
  });
  const result = await coordinator.run({ issue: { number: 1230 }, runId: 'run-1230', workflowGeneration: { generationHash: workflowGenerationSha256 } } as never, new AbortController().signal);
  assert.equal(result.status, 'completed');
  assert.equal(persisted.stage, 'frozen');
  assert.equal(persisted.budgets.review.reportRepairs, 1);
  assert.equal(launches, 2);
  assert.equal(invocation, undefined);
});

test('spec-review restart reconstructs identical projected facts and adopts the canonical attempt report', async () => {
  let persisted = stateWithFirstRevision();
  let invocation: DurableReportInvocationV1 | undefined;
  let sessionCreates = 0;
  let launches = 0;
  let report: Buffer | undefined;
  const observedPromptFacts: string[][] = [];
  const observedStateSessions: Array<string | null> = [];
  const workflowGeneration: WorkflowGenerationReceipt = {
    generationHash: workflowGenerationSha256, manifestSha256: 'b'.repeat(64), packageVersion: '2.0.10',
    generationRoot: '/sealed/workflow', contentSha256: 'c'.repeat(64),
  };
  const policy: WorkflowOperationPolicy = {
    sandboxMode: 'read-only', cwdClass: 'worktree', worktreeAccess: 'read-only', writableRootClasses: [],
    runnerPostcondition: 'report-only', network: 'deny', networkHosts: [], mcpTools: [], approvalCeiling: 'never', externalWrite: false,
  };
  const state = {
    read: async () => structuredClone(persisted),
    compareAndSwap: async (expected: SpecDeliveryV1 | undefined, next: SpecDeliveryV1) => {
      if (JSON.stringify(expected) !== JSON.stringify(persisted)) return false;
      persisted = structuredClone(next);
      return true;
    },
    reviewInvocation: (reviewerSessionId: string) => ({
      read: async () => structuredClone(invocation),
      compareAndSwap: async (expected: DurableReportInvocationV1 | undefined, next: DurableReportInvocationV1 | undefined) => {
        if (JSON.stringify(expected) !== JSON.stringify(invocation)) return false;
        if (expected === undefined && next?.phase === 'prepared') persisted = reserveSpecReviewerSession(persisted, reviewerSessionId);
        invocation = next ? structuredClone(next) : undefined;
        return true;
      },
    }),
    authorInvocation: () => ({ read: async () => undefined, compareAndSwap: async () => false }),
    settleAuthor: async () => false,
    settleReview: async (expected: SpecDeliveryV1, next: SpecDeliveryV1, attemptId: string) => {
      if (JSON.stringify(expected) !== JSON.stringify(persisted) || invocation?.attemptId !== attemptId) return false;
      persisted = structuredClone(next);
      invocation = undefined;
      return true;
    },
  };
  const mechanics = new InjectedContainedReportOperation({
    host: 'host-a', bootId: 'boot-a', now: () => '2026-07-29T00:00:00.000Z', createAttemptId: () => 'review-attempt-1',
    prepare: async () => ({ operation: 'spec-review', generationHash: workflowGenerationSha256, policy,
      reportPath: '/attempts/review-attempt-1/report.json' }),
    snapshot: async () => ({ headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
      untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'worktree-1' }),
    readReport: async () => report ? { status: 'available', bytes: report } : { status: 'absent' },
    settleAttempt: async () => undefined,
    processStartIdentity: async () => 'start-1',
    inspectProcess: async () => ({ status: 'absent', processGroupAlive: false }),
    launch: async ({ onSpawned }) => {
      launches += 1;
      await onSpawned({ pid: 4242, processGroupId: 4242 });
      report = Buffer.from('{"verdict":"approved"}');
      return { status: 'safe-halt' };
    },
  });
  const coordinator = new SpecCoordinator({
    state,
    createAuthorSessionId: () => 'author-session-1', createReviewerSessionId: () => `review-session-${++sessionCreates}`,
    operation: {
      author: async () => ({ status: 'blocked', kind: 'safety', code: 'unexpected' }),
      review: async ({ state: current, reviewerSessionId, invocationState }) => {
        observedStateSessions.push(current.review.reviewerSessionId);
        const promptFacts = [`Reviewer session ID: ${reviewerSessionId}.`, `Immutable spec delivery state: ${canonicalJson(current)}.`];
        observedPromptFacts.push(promptFacts);
        const result = await mechanics.run({ operation: 'spec-review', runId: 'run-1230', worktreePath: '/worktree',
          workflowGeneration, promptFacts, signal: new AbortController().signal, invocationState,
          forbiddenAttemptIds: current.revisions.map((revision) => revision.author.attemptId) });
        if (result.status !== 'completed') return { status: 'retryable', code: result.status === 'retryable' || result.status === 'safe-halt' ? result.code : result.status };
        const target = current.revisions.at(-1)!;
        return { status: 'completed', reportSha256: result.reportSha256, value: reviewReport({
          targetRevision: target.revision, targetSha256: target.revisionSha256,
          reviewer: { attemptId: result.attemptId, sessionId: reviewerSessionId },
        }) };
      },
    },
  });

  const context = { issue: { number: 1230 }, runId: 'run-1230', worktreePath: '/worktree', workflowGeneration } as never;
  assert.equal((await coordinator.run(context, new AbortController().signal)).status, 'retryable');
  assert.equal((await coordinator.run(context, new AbortController().signal)).status, 'completed');
  assert.deepEqual(observedPromptFacts[1], observedPromptFacts[0]);
  assert.deepEqual(observedStateSessions, ['review-session-1', 'review-session-1']);
  assert.equal(sessionCreates, 1);
  assert.equal(launches, 1);
  assert.equal(persisted.review.reviewer?.sessionId, 'review-session-1');
  assert.equal(persisted.budgets.review.reportRepairs, 0);
});

test('spec-author uses the canonical lifecycle with target-state authority and adopts an exact recovered report', async () => {
  let invocation: DurableReportInvocationV1 | undefined;
  let report: Buffer | undefined;
  let launches = 0;
  const workflowGeneration: WorkflowGenerationReceipt = {
    generationHash: workflowGenerationSha256, manifestSha256: 'b'.repeat(64), packageVersion: '2.0.10',
    generationRoot: '/sealed/workflow', contentSha256: 'c'.repeat(64),
  };
  const policy: WorkflowOperationPolicy = {
    sandboxMode: 'workspace-write', cwdClass: 'target-state', worktreeAccess: 'write', writableRootClasses: ['target-state'],
    runnerPostcondition: 'spec-only', network: 'deny', networkHosts: [], mcpTools: [], approvalCeiling: 'never', externalWrite: false,
  };
  const operation = new InjectedContainedReportOperation({
    host: 'host-a', bootId: 'boot-a', now: () => '2026-07-29T00:00:00.000Z', createAttemptId: () => 'author-attempt-1',
    prepare: async () => ({ operation: 'spec-author' as never, generationHash: workflowGenerationSha256, policy,
      reportPath: '/attempts/author-attempt-1/report.json' }),
    snapshot: async () => ({ headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
      untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'worktree-1' }),
    readReport: async () => report ? { status: 'available', bytes: report } : { status: 'absent' },
    settleAttempt: async () => undefined,
    processStartIdentity: async () => 'start-1',
    inspectProcess: async () => ({ status: 'absent', processGroupAlive: false }),
    launch: async ({ onSpawned }) => {
      launches += 1;
      await onSpawned({ pid: 4242, processGroupId: 4242 });
      report = Buffer.from('{"status":"ready"}');
      return { status: 'safe-halt' };
    },
  });
  const invocationState = {
    read: async () => structuredClone(invocation),
    compareAndSwap: async (expected: DurableReportInvocationV1 | undefined, next: DurableReportInvocationV1 | undefined) => {
      if (JSON.stringify(expected) !== JSON.stringify(invocation)) return false;
      invocation = next ? structuredClone(next) : undefined;
      return true;
    },
  };
  const input = { operation: 'spec-author' as never, runId: 'run-1230', worktreePath: '/worktree', workflowGeneration,
    promptFacts: ['author-session-1', 'author'], signal: new AbortController().signal, invocationState };

  assert.deepEqual(await operation.run(input), { status: 'safe-halt', code: 'report-operation-process-unresolved' });
  const recovered = await operation.run(input);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.status === 'completed' && recovered.attemptId, 'author-attempt-1');
  assert.equal(launches, 1);
});

test('recovered malformed spec-author output spends once and result-CAS replay adopts without relaunch', async () => {
  const fixture = canonicalAuthorFixture('malformed');
  assert.equal((await fixture.coordinator.run(fixture.context, new AbortController().signal)).status, 'retryable');
  fixture.failAuthorSettlementAttemptId = 'author-attempt-2';
  assert.deepEqual(await fixture.coordinator.run(fixture.context, new AbortController().signal), {
    status: 'retryable', code: 'spec-result-state-conflict',
  });
  assert.equal(fixture.launches, 2);
  assert.equal(fixture.persisted?.budgets.author.reportRepairs, 1);
  assert.equal(fixture.invocation?.attemptId, 'author-attempt-2');

  assert.equal((await fixture.coordinator.run(fixture.context, new AbortController().signal)).status, 'blocked');
  assert.equal(fixture.persisted?.stage, 'review-full');
  assert.equal(fixture.persisted?.budgets.author.reportRepairs, 1);
  assert.equal(fixture.invocation, undefined);
  assert.equal(fixture.launches, 2);
});

test('spec-author infrastructure failure clears only quiescent ownership and spends zero semantic budget', async () => {
  const fixture = canonicalAuthorFixture('infrastructure');
  assert.deepEqual(await fixture.coordinator.run(fixture.context, new AbortController().signal), {
    status: 'retryable', code: 'report-operation-launch-failed',
  });
  assert.equal(fixture.invocation, undefined);
  assert.equal(fixture.persisted?.budgets.author.reportRepairs, 0);

  assert.equal((await fixture.coordinator.run(fixture.context, new AbortController().signal)).status, 'blocked');
  assert.equal(fixture.persisted?.stage, 'review-full');
  assert.equal(fixture.persisted?.budgets.author.reportRepairs, 0);
  assert.equal(fixture.launches, 2);
});

test('malformed spec-author settlement persistence failure stays retryable with budget and invocation untouched', async () => {
  const fixture = canonicalAuthorFixture('malformed');
  assert.equal((await fixture.coordinator.run(fixture.context, new AbortController().signal)).status, 'retryable');
  fixture.throwAuthorSettlementAttemptId = 'author-attempt-1';

  assert.deepEqual(await fixture.coordinator.run(fixture.context, new AbortController().signal), {
    status: 'retryable', code: 'spec-recovery-state-conflict',
  });
  assert.equal(fixture.persisted?.stage, 'authoring');
  assert.equal(fixture.persisted?.budgets.author.reportRepairs, 0);
  assert.equal(fixture.invocation?.attemptId, 'author-attempt-1');
  assert.equal(fixture.launches, 1);
});

test('invalid spec-review settlement persistence failure keeps review budget and exact invocation', async () => {
  const fixture = completedInvalidPhaseFixture('review');
  fixture.throwSettlement = true;
  assert.deepEqual(await fixture.coordinator.run(fixture.context, new AbortController().signal), {
    status: 'retryable', code: 'spec-recovery-state-conflict',
  });
  assert.equal(fixture.persisted.budgets.review.reportRepairs, 0);
  assert.equal(fixture.invocation?.attemptId, 'review-attempt-1');
  assert.equal(fixture.reviewCalls, 1);
});

test('runtime-completed empty author revision is normalized into exact-once author report repair', async () => {
  const fixture = completedInvalidPhaseFixture('author');
  assert.equal((await fixture.coordinator.run(fixture.context, new AbortController().signal)).status, 'blocked');
  assert.equal(fixture.persisted.budgets.author.reportRepairs, 1);
  assert.equal(fixture.persisted.stage, 'authoring');
  assert.equal(fixture.invocation, undefined);
  assert.equal(fixture.authorCalls, 2);
  await fixture.coordinator.run(fixture.context, new AbortController().signal);
  assert.equal(fixture.persisted.budgets.author.reportRepairs, 1);
  assert.equal(fixture.authorCalls, 3);
});

test('runtime-completed review missing mandatory coverage is normalized into exact-once review report repair', async () => {
  const fixture = completedInvalidPhaseFixture('review');
  assert.equal((await fixture.coordinator.run(fixture.context, new AbortController().signal)).status, 'blocked');
  assert.equal(fixture.persisted.budgets.review.reportRepairs, 1);
  assert.equal(fixture.persisted.stage, 'review-full');
  assert.equal(fixture.invocation, undefined);
  assert.equal(fixture.reviewCalls, 2);
  await fixture.coordinator.run(fixture.context, new AbortController().signal);
  assert.equal(fixture.persisted.budgets.review.reportRepairs, 1);
  assert.equal(fixture.reviewCalls, 3);
});

function identity() {
  return { issueNumber: 1230, runId: 'run-1230', workflowGenerationSha256 };
}

function canonicalAuthorFixture(first: 'malformed' | 'infrastructure') {
  let persisted: SpecDeliveryV1 | undefined;
  let invocation: DurableReportInvocationV1 | undefined;
  let attempts = 0;
  const reports = new Map<string, Buffer>();
  const fixture = {
    launches: 0,
    failAuthorSettlementAttemptId: undefined as string | undefined,
    throwAuthorSettlementAttemptId: undefined as string | undefined,
    get persisted() { return persisted; },
    get invocation() { return invocation; },
  };
  const workflowGeneration: WorkflowGenerationReceipt = {
    generationHash: workflowGenerationSha256, manifestSha256: 'b'.repeat(64), packageVersion: '2.0.10',
    generationRoot: '/sealed/workflow', contentSha256: 'c'.repeat(64),
  };
  const mechanics = new InjectedContainedReportOperation({
    host: 'host-a', bootId: 'boot-a', now: () => '2026-07-29T00:00:00.000Z',
    createAttemptId: () => `author-attempt-${++attempts}`,
    prepare: async ({ attemptId }) => ({ operation: 'spec-author', generationHash: workflowGenerationSha256,
      policy: { sandboxMode: 'workspace-write', cwdClass: 'target-state', worktreeAccess: 'write', writableRootClasses: ['target-state'],
        runnerPostcondition: 'spec-only', network: 'deny', networkHosts: [], mcpTools: [], approvalCeiling: 'never', externalWrite: false },
      reportPath: `/attempts/${attemptId}/report.json` }),
    snapshot: async () => ({ headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
      untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'worktree-1' }),
    readReport: async (path) => reports.has(path) ? { status: 'available', bytes: reports.get(path)! } : { status: 'absent' },
    settleAttempt: async () => undefined,
    processStartIdentity: async () => 'start-1',
    inspectProcess: async () => ({ status: 'absent', processGroupAlive: false }),
    launch: async ({ attempt, onSpawned }) => {
      fixture.launches += 1;
      await onSpawned({ pid: 4200 + fixture.launches, processGroupId: 4200 + fixture.launches });
      if (fixture.launches === 1 && first === 'infrastructure') return { status: 'retryable', code: 'report-operation-launch-failed' };
      const bytes = Buffer.from(fixture.launches === 1 ? 'malformed' : 'valid');
      reports.set(attempt.reportPath, bytes);
      return fixture.launches === 1 ? { status: 'safe-halt' } : { status: 'completed', reportBytes: bytes };
    },
  });
  const authorInvocation = (sessionId: string) => ({
    read: async () => structuredClone(invocation),
    compareAndSwap: async (expected: DurableReportInvocationV1 | undefined, next: DurableReportInvocationV1 | undefined) => {
      if (JSON.stringify(expected) !== JSON.stringify(invocation)) return false;
      if (expected === undefined && next?.phase === 'prepared') persisted = reserveSpecAuthorSession(persisted!, sessionId);
      invocation = next ? structuredClone(next) : undefined;
      return true;
    },
  });
  const state = {
    read: async () => structuredClone(persisted),
    compareAndSwap: async (expected: SpecDeliveryV1 | undefined, next: SpecDeliveryV1) => {
      if (JSON.stringify(expected) !== JSON.stringify(persisted)) return false;
      persisted = structuredClone(next); return true;
    },
    authorInvocation,
    reviewInvocation: () => ({ read: async () => undefined, compareAndSwap: async () => false }),
    settleAuthor: async (expected: SpecDeliveryV1, next: SpecDeliveryV1, attemptId: string) => {
      if (fixture.throwAuthorSettlementAttemptId === attemptId) throw new Error('state persistence unavailable');
      if (fixture.failAuthorSettlementAttemptId === attemptId) { fixture.failAuthorSettlementAttemptId = undefined; return false; }
      if (JSON.stringify(expected) !== JSON.stringify(persisted) || invocation?.attemptId !== attemptId) return false;
      persisted = structuredClone(next); invocation = undefined; return true;
    },
    settleReview: async () => false,
  };
  const context = { issue: { number: 1230, url: 'issue:1230' }, runId: 'run-1230', worktreePath: '/worktree',
    frozenCriteria: [], workflowGeneration } as never;
  const coordinator = new SpecCoordinator({
    state, createAuthorSessionId: () => 'author-session-1', createReviewerSessionId: () => 'review-session-1',
    operation: {
      author: async ({ state: current, authorSessionId, invocationState, signal }) => {
        const result = await mechanics.run({ operation: 'spec-author', runId: 'run-1230', worktreePath: '/worktree', workflowGeneration,
          promptFacts: [authorSessionId, canonicalJson(current)], signal, invocationState });
        if (result.status === 'retryable' || result.status === 'safe-halt') return { status: 'retryable', code: result.code };
        if (result.status === 'blocked' || result.status === 'cancelled') return result;
        if (result.reportBytes.toString('utf8') !== 'valid') return { status: 'invalid', code: 'spec-author-report-invalid', attemptId: result.attemptId };
        return { status: 'completed', value: createSpecRevision({ revision: 1, path: '/attempts/revision-1.md', content: '# Spec\n',
          evidence: [{ path: 'issue:1230', sha256: 'c'.repeat(64), description: 'Issue authority' }],
          author: { attemptId: result.attemptId, sessionId: authorSessionId }, previousRevision: null }) };
      },
      review: async () => ({ status: 'blocked', kind: 'safety', code: 'review-stop' }),
    },
  });
  return Object.assign(fixture, { coordinator, context });
}

function completedInvalidPhaseFixture(phase: 'author' | 'review') {
  let persisted = phase === 'author'
    ? reserveSpecAuthorSession(createInitialSpecDelivery(identity()), 'author-session-1')
    : reserveSpecReviewerSession(stateWithFirstRevision(), 'review-session-1');
  let invocation: DurableReportInvocationV1 | undefined = {
    version: 1, operation: phase === 'author' ? 'spec-author' : 'spec-review', attemptId: `${phase}-attempt-1`,
    generationHash: workflowGenerationSha256, promptFactsSha256: 'd'.repeat(64),
    reportPath: `/attempts/${phase}-attempt-1/report.json`, phase: 'launched', host: 'host-a', bootId: 'boot-a',
    preparedAt: '2026-07-29T00:00:00.000Z', launchedAt: '2026-07-29T00:00:01.000Z', pid: 4242,
    processStartIdentity: 'start-1', processGroupId: 4242,
    baseline: { headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
      untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'worktree-1' },
  };
  const fixture = {
    authorCalls: 0, reviewCalls: 0,
    throwSettlement: false,
    get persisted() { return persisted; }, get invocation() { return invocation; },
  };
  const invocationState = {
    read: async () => structuredClone(invocation),
    compareAndSwap: async () => false,
  };
  const settle = async (expected: SpecDeliveryV1, next: SpecDeliveryV1, attemptId: string) => {
    if (fixture.throwSettlement) throw new Error('state persistence unavailable');
    if (JSON.stringify(expected) !== JSON.stringify(persisted) || invocation?.attemptId !== attemptId) return false;
    persisted = structuredClone(next); invocation = undefined; return true;
  };
  const context = { issue: { number: 1230, url: 'issue:1230' }, runId: 'run-1230', worktreePath: '/worktree',
    frozenCriteria: [], workflowGeneration: { generationHash: workflowGenerationSha256 } } as never;
  const coordinator = new SpecCoordinator({
    state: {
      read: async () => structuredClone(persisted), compareAndSwap: async () => false,
      authorInvocation: () => invocationState, reviewInvocation: () => invocationState,
      settleAuthor: settle, settleReview: settle,
    },
    createAuthorSessionId: () => 'author-session-1', createReviewerSessionId: () => 'review-session-1',
    operation: {
      author: async () => {
        fixture.authorCalls += 1;
        if (phase !== 'author' || fixture.authorCalls > 1) return { status: 'blocked', kind: 'safety', code: 'stop' };
        return { status: 'completed', value: createSpecRevision({ revision: 1, path: '/attempts/revision-1.md', content: '',
          evidence: [{ path: 'issue:1230', sha256: 'c'.repeat(64), description: 'Issue authority' }],
          author: { attemptId: 'author-attempt-1', sessionId: 'author-session-1' }, previousRevision: null }) };
      },
      review: async () => {
        fixture.reviewCalls += 1;
        if (phase !== 'review' || fixture.reviewCalls > 1) return { status: 'blocked', kind: 'safety', code: 'stop' };
        return { status: 'completed', reportSha256, value: reviewReport({ coverage: [],
          reviewer: { attemptId: 'review-attempt-1', sessionId: 'review-session-1' } }) };
      },
    },
  });
  return Object.assign(fixture, { coordinator, context });
}

function firstRevision() {
  return createSpecRevision({
    revision: 1, path: 'docs/spec.md', content: '# Exact spec\n',
    evidence: [{ path: 'issue:1230', sha256: 'c'.repeat(64), description: 'Approved issue intent' }],
    author: { attemptId: 'author-attempt-1', sessionId: 'author-session-1' }, previousRevision: null,
  });
}

function stateWithFirstRevision(): SpecDeliveryV1 {
  const initial = createInitialSpecDelivery(identity());
  return acceptSpecRevision(reserveSpecAuthorSession(initial, 'author-session-1'), firstRevision());
}

function closureReady(): SpecDeliveryV1 {
  const repair = acceptSpecReview(stateWithFirstRevision(), reviewReport({
    verdict: 'needs-work', defects: [blocker({ status: 'open' })],
  }), reportSha256);
  return acceptSpecRevision(reserveSpecAuthorSession(repair, 'author-session-1'), createSpecRevision({
    revision: 2, path: 'docs/spec.md', content: '# Repaired spec\n', evidence: firstRevision().evidence,
    author: { attemptId: 'author-attempt-2', sessionId: 'author-session-1' }, previousRevision: firstRevision(),
  }));
}

function reviewReport(overrides: Partial<SpecReviewReportV1> = {}): SpecReviewReportV1 {
  const revision = firstRevision();
  return {
    version: 1, targetRevision: 1, targetSha256: revision.revisionSha256, mode: 'full', verdict: 'approved',
    reviewer: { attemptId: 'review-attempt-1', sessionId: 'review-session-1' },
    coverage: ['approved-product-intent', 'deterministic-executability', 'safety', 'scope', 'validation'],
    defects: [], affectedDefectIds: [], affectedContracts: [], closureRequestSha256: null, acceptedRisks: [],
    coverageInvalidated: false, ...overrides,
  };
}

function blocker(overrides: Partial<SpecReviewReportV1['defects'][number]> = {}): SpecReviewReportV1['defects'][number] {
  return {
    id: 'SPEC-001', class: 'blocker', severity: 'high', confidence: 'high', status: 'open',
    invariant: 'Implementation is deterministic.', failure: 'A required command is missing.',
    evidence: ['docs/spec.md'], repair: 'Add the command.', affectedTargets: ['validation'],
    introducedTargetRevision: 1, statusTargetRevision: 1, supersededBy: null, ...overrides,
  };
}
