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
  launchSpecInvocation,
  prepareSpecInvocation,
  recoverSpecInvocation,
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
  assert.equal(approved.invocation, undefined);
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

  const authorPrepared = prepareSpecInvocation(repair, {
    mode: 'repair', attemptId: 'author-attempt-2', sessionId: 'author-session-1',
  });
  const authorLaunched = launchSpecInvocation(authorPrepared, { attemptId: 'author-attempt-2', pid: 43, processGroupId: 43 });
  const revision2 = createSpecRevision({
    revision: 2, path: 'docs/spec.md', content: '# Repaired spec\n', evidence: firstRevision().evidence,
    author: { attemptId: 'author-attempt-2', sessionId: 'author-session-1' }, previousRevision: firstRevision(),
  });
  const closure = acceptSpecRevision(authorLaunched, revision2);

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
  const author = launchSpecInvocation(prepareSpecInvocation(repair, {
    mode: 'repair', attemptId: 'author-attempt-2', sessionId: 'author-session-1',
  }), { attemptId: 'author-attempt-2', pid: 43, processGroupId: 43 });
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

test('author lifecycle and review semantic report-repair budgets are separate and durable', () => {
  const initial = createInitialSpecDelivery(identity());
  const authorRepair = consumeSpecReportRepair(initial, 'author');
  assert.deepEqual(authorRepair.budgets, {
    author: { reportRepairs: 1, transportRetries: 0 }, review: { reportRepairs: 0 },
    repairCycles: 0,
  });
  assert.throws(() => consumeSpecReportRepair(authorRepair, 'author'), /exhausted/u);

  const prepared = prepareSpecInvocation(authorRepair, {
    mode: 'author', attemptId: 'author-attempt-1', sessionId: 'author-session-1',
  });
  const recoveredPrepared = recoverSpecInvocation(prepared, { attemptId: 'author-attempt-1', processGroupAbsent: true });
  assert.equal(recoveredPrepared.invocation, undefined);
  assert.equal(recoveredPrepared.budgets.author.transportRetries, 1);

  const fresh = createInitialSpecDelivery(identity());
  const launched = launchSpecInvocation(prepareSpecInvocation(fresh, {
    mode: 'author', attemptId: 'author-attempt-2', sessionId: 'author-session-1',
  }), { attemptId: 'author-attempt-2', pid: 45, processGroupId: 45 });
  assert.throws(() => recoverSpecInvocation(launched, { attemptId: 'author-attempt-2', processGroupAbsent: false }), /still active/u);
  const recoveredLaunch = recoverSpecInvocation(launched, { attemptId: 'author-attempt-2', processGroupAbsent: true });
  assert.equal(recoveredLaunch.budgets.author.transportRetries, 1);
  assert.deepEqual(validateSpecDelivery(recoveredLaunch), recoveredLaunch);
});

test('strict state validation rejects unknown keys, impossible stages, stale invocations, and revision tampering', () => {
  const state = stateWithFirstRevision();
  assert.throws(() => validateSpecDelivery({ ...state, extra: true }), /unknown or missing keys/u);
  assert.throws(() => validateSpecDelivery({ ...state, stage: 'approved' }), /approved/u);
  assert.throws(() => validateSpecDelivery({
    ...state,
    invocation: {
      purpose: 'review', mode: 'full', attemptId: 'review-attempt-1', sessionId: 'review-session-1',
      targetRevision: 2, targetSha256: state.revisions[0]!.revisionSha256, closureRequestSha256: null,
      status: 'prepared', pid: null, processGroupId: null,
      reportPath: null, revisionPath: null,
    },
  }), /does not accept an invocation/u);
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
      settleReview: async (expected, next, attemptId) => {
        if (JSON.stringify(expected) !== JSON.stringify(persisted) || invocation?.attemptId !== attemptId) return false;
        persisted = structuredClone(next); invocation = undefined; return true;
      },
    },
    createReviewerSessionId: () => 'review-session-1',
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
      recover: async () => ({ status: 'blocked', kind: 'safety', code: 'unexpected' }),
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
    createReviewerSessionId: () => `review-session-${++sessionCreates}`,
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
      recover: async () => ({ status: 'blocked', kind: 'safety', code: 'unexpected' }),
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

function identity() {
  return { issueNumber: 1230, runId: 'run-1230', workflowGenerationSha256 };
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
  const launched = launchSpecInvocation(prepareSpecInvocation(initial, {
    mode: 'author', attemptId: 'author-attempt-1', sessionId: 'author-session-1',
  }), { attemptId: 'author-attempt-1', pid: 41, processGroupId: 41 });
  return acceptSpecRevision(launched, firstRevision());
}

function closureReady(): SpecDeliveryV1 {
  const repair = acceptSpecReview(stateWithFirstRevision(), reviewReport({
    verdict: 'needs-work', defects: [blocker({ status: 'open' })],
  }), reportSha256);
  const launched = launchSpecInvocation(prepareSpecInvocation(repair, {
    mode: 'repair', attemptId: 'author-attempt-2', sessionId: 'author-session-1',
  }), { attemptId: 'author-attempt-2', pid: 43, processGroupId: 43 });
  return acceptSpecRevision(launched, createSpecRevision({
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
