import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DeliveryAuthorityV1 } from '../src/v2/delivery-authority.js';
import type { ReviewDataV1 } from '../src/v2/review-data.js';
import type { ReviewFeedbackRunDataV1 } from '../src/v2/review-feedback.js';
import { InMemoryRunRecordWriter, type RunRecord } from '../src/v2/run-store.js';
import {
  applyValidationTransition,
  consumeValidationTransition,
  nextValidationTransition,
  projectValidationRepair,
  projectValidationReviewStart,
  validationRepairBudgetExhausted,
} from '../src/v2/validation-progression.js';

test('direct and spec authority dispatch through the same fixed validation progression', () => {
  for (const kind of ['direct', 'spec'] as const) {
    const authority = deliveryAuthority(kind);
    const implementing = run('implementing', authority);
    assert.equal(nextValidationTransition(implementing, authority).phase, 'implementation');

    implementing.reviewData = reviewData(null);
    assert.equal(nextValidationTransition(implementing, authority).phase, 'full-review');

    implementing.lifecycle = 'checking';
    implementing.reviewData = reviewData('approved');
    assert.equal(nextValidationTransition(implementing, authority).phase, 'checks');

    implementing.lifecycle = 'proving';
    assert.equal(nextValidationTransition(implementing, authority).phase, 'acceptance-proof');

    implementing.lifecycle = 'publishing';
    implementing.proofReceipt = { proofId: 'proof-1' } as RunRecord['proofReceipt'];
    assert.equal(nextValidationTransition(implementing, authority).phase, 'publication');
  }
});

test('post-PR feedback changes context but not validation progression ownership', () => {
  const authority = deliveryAuthority('direct');
  const record = run('implementing', authority);
  record.reviewData = reviewData('approved');
  record.reviewFeedback = reviewFeedback();

  assert.deepEqual(nextValidationTransition(record, authority), {
    kind: 'dispatch',
    phase: 'implementation',
    expected: {
      runId: record.runId,
      lifecycle: 'implementing',
      cycle: 1,
      authoritySha256: authority.authoritySha256,
      activeAttemptId: null,
      pendingEffectId: null,
    },
    feedback: { batchId: 'batch-1', repairRound: 1 },
  });
});

test('Run lifecycle and durable receipt select progression without a nested review state', () => {
  const authority = deliveryAuthority('direct');
  const record = run('implementing', authority);
  record.reviewData = reviewData('needs-work');
  assert.equal(nextValidationTransition(record, authority).phase, 'implementation');

  record.lifecycle = 'checking';
  assert.throws(() => nextValidationTransition(record, authority), /approved review receipt/u);
  record.reviewData = reviewData('approved');
  assert.equal(nextValidationTransition(record, authority).phase, 'checks');

  record.reviewData = reviewData(null);
  assert.throws(() => nextValidationTransition(record, authority), /approved review receipt/u);
});

test('validation progression rejects mismatched authority, pending effects, and non-validation phases', () => {
  const authority = deliveryAuthority('direct');
  const record = run('implementing', authority);
  assert.throws(
    () => nextValidationTransition(record, { ...authority, authoritySha256: 'f'.repeat(64) }),
    /authority mismatch/u,
  );
  record.pendingEffect = { kind: 'claim-labels', effectId: 'effect-1', issueNumber: 42, expected: [] };
  assert.throws(() => nextValidationTransition(record, authority), /pending effect/u);
  delete record.pendingEffect;
  record.lifecycle = 'triaging';
  assert.throws(() => nextValidationTransition(record, authority), /outside validation progression/u);
});

test('semantic repair returns one CAS transition without a reworking lifecycle', () => {
  const authority = deliveryAuthority('direct');
  const record = run('checking', authority);
  record.cycle = 2;
  record.candidateBinding = { bindingId: 'binding-1' } as RunRecord['candidateBinding'];
  record.checks = [{ id: 'typecheck' }] as RunRecord['checks'];

  const transition = projectValidationRepair(record, ['typecheck failed']);
  assert.equal(transition.kind, 'cas');
  assert.equal(transition.expected.lifecycle, 'checking');
  assert.deepEqual(transition.changes, {
    lifecycle: 'implementing',
    changeBindingVersion: undefined,
    candidateBinding: undefined,
    cycle: 3,
    reworkFindings: ['typecheck failed'],
    checks: [],
    checkedChangeSha256: undefined,
    proofId: undefined,
    proofExecution: undefined,
    proofReceipt: undefined,
  });
});

test('Run-owned validation budgets remain route-independent and bounded', () => {
  const authority = deliveryAuthority('direct');
  const initial = run('implementing', authority);
  assert.equal(validationRepairBudgetExhausted(initial, 5), false);
  initial.cycle = 5;
  assert.equal(validationRepairBudgetExhausted(initial, 5), true);
  initial.reviewFeedback = reviewFeedback();
  initial.reviewFeedback.repairRound = 2;
  assert.equal(validationRepairBudgetExhausted(initial, 5), false);
  initial.reviewFeedback.repairRound = 3;
  assert.equal(validationRepairBudgetExhausted(initial, 5), true);
});

test('CAS consumption rejects stale authority context before any write', () => {
  const authority = deliveryAuthority('direct');
  const record = run('implementing', authority);
  const transition = projectValidationReviewStart(record, {
    targetFingerprint: 'e'.repeat(64),
    reviewerSessionId: 'review-session',
  });
  record.cycle = 2;
  let writes = 0;
  assert.throws(() => {
    consumeValidationTransition(record, transition);
    writes += 1;
  }, /expected state mismatch/u);
  assert.equal(writes, 0);
});

test('production transition adapter rejects every stale expected field before RunRecordWriter CAS', () => {
  const authority = deliveryAuthority('direct');
  const original = run('implementing', authority);
  const transition = projectValidationReviewStart(original, {
    targetFingerprint: 'e'.repeat(64),
    reviewerSessionId: 'review-session',
  });
  const writer = new InMemoryRunRecordWriter();
  let writes = 0;
  const cases: RunRecord[] = [
    { ...original, runId: '00000000-0000-4000-8000-000000000002' },
    { ...original, lifecycle: 'checking' },
    { ...original, cycle: 2 },
    { ...original, deliveryAuthority: { ...authority, authoritySha256: 'f'.repeat(64) } },
    { ...original, activeAttempt: { attemptId: 'attempt-2' } as RunRecord['activeAttempt'] },
    { ...original, pendingEffect: { effectId: 'effect-2' } as RunRecord['pendingEffect'] },
  ];
  for (const stale of cases) {
    assert.throws(() => applyValidationTransition(stale, transition, (changes) => {
      writes += 1;
      const { pendingEffect, ...recordChanges } = changes;
      assert.equal(pendingEffect, undefined);
      return writer.compareAndSwap(0, {
        schema: 'codex-orchestrator.run-state',
        runs: [{ ...stale, ...recordChanges }],
      });
    }), /expected state mismatch/u);
  }
  assert.equal(writes, 0);
});

function run(lifecycle: RunRecord['lifecycle'], authority: DeliveryAuthorityV1): RunRecord {
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    lifecycle,
    cycle: 1,
    deliveryAuthority: structuredClone(authority),
    pendingEffect: undefined,
    activeAttempt: undefined,
  } as unknown as RunRecord;
}

function deliveryAuthority(kind: 'direct' | 'spec'): DeliveryAuthorityV1 {
  const base = {
    version: 1 as const,
    routeDecisionSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64),
    authoritySha256: (kind === 'direct' ? 'c' : 'd').repeat(64),
  };
  return kind === 'direct'
    ? { ...base, kind }
    : { ...base, kind, frozenSpec: {} as Extract<DeliveryAuthorityV1, { kind: 'spec' }>['frozenSpec'] };
}

function reviewData(receipt: 'approved' | 'needs-work' | null): ReviewDataV1 {
  return {
    version: 1,
    targetRevision: 1,
    targetFingerprint: 'e'.repeat(64),
    reviewerSessionId: 'review-session',
    reportRepairs: 0,
    transportRetries: 0,
    coverage: receipt === null ? [] : ['all'],
    defects: receipt === 'needs-work' ? [{
      id: 'finding-1', class: 'blocker', severity: 'high', confidence: 'high', status: 'open',
      invariant: 'works', failure: 'broken', evidence: ['test'], repair: 'fix', affectedTargets: ['src/a.ts'],
      introducedTargetRevision: 1, statusTargetRevision: 1, supersededBy: null,
    }] : [],
    receipt: receipt === null ? null : { verdict: receipt, reportSha256: 'f'.repeat(64) },
    repairFindings: [],
  } as unknown as ReviewDataV1;
}

function reviewFeedback(): ReviewFeedbackRunDataV1 {
  return {
    version: 1,
    updateEpoch: 1,
    consumedSourceIds: [],
    previousPublishedHeadSha: 'a'.repeat(40),
    repairRound: 1,
    activeBatch: { batchId: 'batch-1' } as ReviewFeedbackRunDataV1['activeBatch'],
    history: [],
    verifiedReceipt: null,
  };
}
