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
  validateFrozenSpecReceipt,
  validateSpecDelivery,
  validateSpecRevision,
  type SpecDeliveryV1,
  type SpecReviewReportV1,
} from '../src/v2/spec-delivery.js';
import { SpecCoordinator } from '../src/v2/spec-coordinator.js';

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
  assert.throws(() => prepareSpecInvocation(state, {
    purpose: 'review', mode: 'full', attemptId: 'review-attempt-1', sessionId: 'author-session-1',
  }), /independent/u);

  const prepared = prepareSpecInvocation(state, {
    purpose: 'review', mode: 'full', attemptId: 'review-attempt-1', sessionId: 'review-session-1',
  });
  assert.equal(prepared.invocation?.status, 'prepared');
  const launched = launchSpecInvocation(prepared, { attemptId: 'review-attempt-1', pid: 42, processGroupId: 42 });
  assert.equal(launched.invocation?.status, 'launched');

  const approved = acceptSpecReview(launched, reviewReport({ verdict: 'approved' }), reportSha256);
  assert.equal(approved.stage, 'approved');
  assert.equal(approved.review.mode, 'full');
  assert.equal(approved.invocation, undefined);
  assert.deepEqual(validateSpecDelivery(approved), approved);
});

test('needs-work Full creates a canonical ledger and repair creates an immutable revision for affected Closure', () => {
  const full = launchedFullReview();
  const defect = blocker({ status: 'open' });
  const repair = acceptSpecReview(full, reviewReport({ verdict: 'needs-work', defects: [defect] }), reportSha256);
  assert.equal(repair.stage, 'author-repair');
  assert.deepEqual(repair.review.defects.map((item) => item.id), ['SPEC-001']);

  const authorPrepared = prepareSpecInvocation(repair, {
    purpose: 'author', mode: 'repair', attemptId: 'author-attempt-2', sessionId: 'author-session-1',
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
  const launched = launchSpecInvocation(prepareSpecInvocation(closure, {
    purpose: 'review', mode: 'closure', attemptId: 'closure-attempt-1', sessionId: 'review-session-1',
  }), { attemptId: 'closure-attempt-1', pid: 44, processGroupId: 44 });
  const verified = blocker({ status: 'verified', statusTargetRevision: 2 });
  const report = reviewReport({
    targetRevision: 2, targetSha256: closure.revisions[1]!.revisionSha256, mode: 'closure', verdict: 'approved',
    reviewer: { attemptId: 'closure-attempt-1', sessionId: 'review-session-1' },
    defects: [verified], affectedDefectIds: ['SPEC-001'], affectedContracts: closure.review.affectedContracts,
    closureRequestSha256: closure.review.closureRequestSha256,
  });
  assert.equal(acceptSpecReview(launched, report, 'd'.repeat(64)).stage, 'approved');
  assert.throws(() => acceptSpecReview(launched, { ...report, coverage: report.coverage.slice(1) }, 'd'.repeat(64)), /mandatory coverage/u);
  assert.throws(() => acceptSpecReview(launched, { ...report, defects: [] }, 'd'.repeat(64)), /affected defect IDs/u);
});

test('Closure preserves omitted canonical defects, invalidation returns to Full, and a second repair wave exhausts', () => {
  const second = blocker({ id: 'SPEC-002', status: 'fixed' });
  const repair = acceptSpecReview(launchedFullReview(), reviewReport({
    verdict: 'needs-work', defects: [blocker({ status: 'open' }), second],
  }), reportSha256);
  const author = launchSpecInvocation(prepareSpecInvocation(repair, {
    purpose: 'author', mode: 'repair', attemptId: 'author-attempt-2', sessionId: 'author-session-1',
  }), { attemptId: 'author-attempt-2', pid: 43, processGroupId: 43 });
  const closure = acceptSpecRevision(author, createSpecRevision({
    revision: 2, path: 'docs/spec.md', content: '# Repaired spec\n', evidence: firstRevision().evidence,
    author: { attemptId: 'author-attempt-2', sessionId: 'author-session-1' }, previousRevision: firstRevision(),
  }));
  const launched = launchSpecInvocation(prepareSpecInvocation(closure, {
    purpose: 'review', mode: 'closure', attemptId: 'closure-attempt-1', sessionId: 'review-session-1',
  }), { attemptId: 'closure-attempt-1', pid: 44, processGroupId: 44 });
  const base = reviewReport({
    targetRevision: 2, targetSha256: closure.revisions[1]!.revisionSha256, mode: 'closure',
    reviewer: { attemptId: 'closure-attempt-1', sessionId: 'review-session-1' },
    affectedDefectIds: ['SPEC-001'], closureRequestSha256: closure.review.closureRequestSha256,
    defects: [blocker({ status: 'verified', statusTargetRevision: 2 })],
  });
  assert.throws(() => acceptSpecReview(launched, base, 'd'.repeat(64)), /unresolved/u);
  assert.equal(acceptSpecReview(launched, { ...base, coverageInvalidated: true }, 'd'.repeat(64)).stage, 'review-full');
  assert.equal(acceptSpecReview(launched, { ...base, verdict: 'needs-work', defects: [blocker({ status: 'reopened', statusTargetRevision: 2 })] }, 'd'.repeat(64)).stage, 'exhausted');
});

test('approval and freeze reject unresolved blockers or execution risks unless each has an explicit accepted risk', () => {
  const launched = launchedFullReview();
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

test('author and review report-repair and transport budgets are separate and durable', () => {
  const initial = createInitialSpecDelivery(identity());
  const authorRepair = consumeSpecReportRepair(initial, 'author');
  assert.deepEqual(authorRepair.budgets, {
    author: { reportRepairs: 1, transportRetries: 0 }, review: { reportRepairs: 0, transportRetries: 0 },
    repairCycles: 0,
  });
  assert.throws(() => consumeSpecReportRepair(authorRepair, 'author'), /exhausted/u);

  const prepared = prepareSpecInvocation(authorRepair, {
    purpose: 'author', mode: 'author', attemptId: 'author-attempt-1', sessionId: 'author-session-1',
  });
  const recoveredPrepared = recoverSpecInvocation(prepared, { attemptId: 'author-attempt-1', processGroupAbsent: true });
  assert.equal(recoveredPrepared.invocation, undefined);
  assert.equal(recoveredPrepared.budgets.author.transportRetries, 1);

  const fresh = createInitialSpecDelivery(identity());
  const launched = launchSpecInvocation(prepareSpecInvocation(fresh, {
    purpose: 'author', mode: 'author', attemptId: 'author-attempt-2', sessionId: 'author-session-1',
  }), { attemptId: 'author-attempt-2', pid: 45, processGroupId: 45 });
  assert.throws(() => recoverSpecInvocation(launched, { attemptId: 'author-attempt-2', processGroupAbsent: false }), /still active/u);
  const recoveredLaunch = recoverSpecInvocation(launched, { attemptId: 'author-attempt-2', processGroupAbsent: true });
  assert.equal(recoveredLaunch.budgets.author.transportRetries, 1);
  assert.equal(recoveredLaunch.budgets.review.transportRetries, 0);
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
  }), /target mismatch/u);
  assert.throws(() => validateSpecDelivery({
    ...state, revisions: [{ ...state.revisions[0]!, content: '# tampered\n' }],
  }), /content hash/u);
});

test('coordinator reconciles a persisted completed review report without relaunching the reviewer', async () => {
  let persisted = launchSpecInvocation(prepareSpecInvocation(stateWithFirstRevision(), {
    purpose: 'review', mode: 'full', attemptId: 'review-recovery', sessionId: 'review-session-1',
    reportPath: '/state/review.json',
  }), { attemptId: 'review-recovery', pid: 50, processGroupId: 50 });
  let launches = 0;
  const coordinator = new SpecCoordinator({
    state: {
      read: async () => structuredClone(persisted),
      compareAndSwap: async (expected, next) => {
        if (JSON.stringify(expected) !== JSON.stringify(persisted)) return false;
        persisted = structuredClone(next);
        return true;
      },
    },
    operation: {
      author: async () => { launches += 1; return { status: 'blocked', kind: 'safety', code: 'unexpected' }; },
      review: async () => { launches += 1; return { status: 'blocked', kind: 'safety', code: 'unexpected' }; },
      recover: async ({ state }) => {
        const target = state.revisions.at(-1)!;
        return { status: 'completed', reportSha256, value: reviewReport({
          targetRevision: target.revision, targetSha256: target.revisionSha256,
          reviewer: { attemptId: 'review-recovery', sessionId: 'review-session-1' },
        }) };
      },
    },
  });
  const result = await coordinator.run({ issue: { number: 1230 }, runId: 'run-1230', workflowGeneration: { generationHash: workflowGenerationSha256 } } as never, new AbortController().signal);
  assert.equal(result.status, 'completed');
  assert.equal(persisted.stage, 'frozen');
  assert.equal(launches, 0);
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
    purpose: 'author', mode: 'author', attemptId: 'author-attempt-1', sessionId: 'author-session-1',
  }), { attemptId: 'author-attempt-1', pid: 41, processGroupId: 41 });
  return acceptSpecRevision(launched, firstRevision());
}

function launchedFullReview(): SpecDeliveryV1 {
  return launchSpecInvocation(prepareSpecInvocation(stateWithFirstRevision(), {
    purpose: 'review', mode: 'full', attemptId: 'review-attempt-1', sessionId: 'review-session-1',
  }), { attemptId: 'review-attempt-1', pid: 42, processGroupId: 42 });
}

function closureReady(): SpecDeliveryV1 {
  const repair = acceptSpecReview(launchedFullReview(), reviewReport({
    verdict: 'needs-work', defects: [blocker({ status: 'open' })],
  }), reportSha256);
  const launched = launchSpecInvocation(prepareSpecInvocation(repair, {
    purpose: 'author', mode: 'repair', attemptId: 'author-attempt-2', sessionId: 'author-session-1',
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
