import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildBlockedHandoffEvidence,
  buildPromotionAsBlockedHandoffEvidence,
  buildPromotionRequestedHandoffEvidence,
  buildReviewReadyHandoffEvidence,
} from '../src/runner/runner-handoff-decision.js';
import type { ImplementationPublishabilityResult } from '../src/runner/local-execution-session.js';
import type { FreshContextReviewEvidence } from '../src/runner/handoff-evidence.js';

test('runner handoff decision builds blocked evidence with fresh-context findings', () => {
  const publishability = blockedPublishability({
    reasons: ['One or more configured checks failed.'],
    residualRisks: ['configured check risk'],
  });
  const freshContextReview: FreshContextReviewEvidence = {
    status: 'blocked',
    findings: ['policy-violation high: Runner-owned publication boundary was crossed.'],
    residualRisks: ['fresh review risk'],
    logPath: '/tmp/fresh-review.log',
    snapshotPath: '/tmp/fresh-review.json',
  };

  const evidence = buildBlockedHandoffEvidence({
    publishability,
    freshContextReview,
    nextAction: 'Review the Fresh-Context Review blocker before draft PR handoff.',
  });

  assert.deepEqual(evidence.blockers, [
    'Fresh-Context Review blocked publication',
    'policy-violation high: Runner-owned publication boundary was crossed.',
  ]);
  assert.deepEqual(evidence.residualRisks, ['configured check risk', 'fresh review risk']);
  assert.deepEqual(evidence.suggestionEvidence, freshContextReview.findings);
  assert.equal(evidence.nextAction, 'Review the Fresh-Context Review blocker before draft PR handoff.');
  assert.equal(evidence.acceptanceProof, publishability.acceptanceProofAttempt);
});

test('runner handoff decision preserves blocker keys and repair attempts alongside reasons', () => {
  const publishability = {
    ...blockedPublishability({
      reasons: ['Quality gate requires TDD red-to-green proof in validation.'],
      residualRisks: [],
    }),
    blockers: [{
      key: 'missing-quality-gate-evidence' as const,
      reason: 'Quality gate requires TDD red-to-green proof in validation.',
      source: 'review-gate' as const,
      repair: 'evidence' as const,
    }],
    repairAttempts: [{
      kind: 'evidence' as const,
      status: 'blocked' as const,
      reason: 'Evidence repair did not satisfy review gates.',
      sessionId: 'issue-155-session-evidence-repair',
      promptPath: '/tmp/evidence-prompt.md',
      reportPath: '/tmp/report.json',
      logPath: '/tmp/evidence.log',
      blockers: [{
        key: 'missing-quality-gate-evidence' as const,
        reason: 'Quality gate requires TDD red-to-green proof in validation.',
        source: 'review-gate' as const,
        repair: 'none' as const,
      }],
    }],
  };

  const evidence = buildBlockedHandoffEvidence({
    publishability,
    nextAction: 'Repair evidence before draft PR handoff.',
  });

  assert.deepEqual(evidence.blockers, [
    'Quality gate requires TDD red-to-green proof in validation.',
    'Blocker keys: missing-quality-gate-evidence',
  ]);
  assert.deepEqual(evidence.repairAttempts?.map((attempt) => attempt.kind), ['evidence']);
});

test('runner handoff decision keeps scoped promotion distinct from promotion-as-blocked', () => {
  const publishability = promotionPublishability('Touches multiple ownership scopes.');

  const scoped = buildPromotionRequestedHandoffEvidence({
    publishability,
    nextAction: 'Maintainer should review promotion evidence and decide whether to use parent issue-tree orchestration.',
  });
  const child = buildPromotionAsBlockedHandoffEvidence({
    publishability,
    fallbackReason: 'Child requested promotion instead of completing issue-tree work.',
    nextAction: 'Parent issue-tree execution is blocked until this child is resolved.',
  });

  assert.equal(scoped.outcome, 'promotion-requested');
  assert.deepEqual(scoped.blockers, ['Touches multiple ownership scopes.']);
  assert.equal(child.outcome, 'blocked');
  assert.deepEqual(child.blockers, ['Touches multiple ownership scopes.']);
  assert.equal(child.nextAction, 'Parent issue-tree execution is blocked until this child is resolved.');
});

test('runner handoff decision builds review-ready evidence without publication side effects', () => {
  const publishability = publishReady();
  const freshContextReview: FreshContextReviewEvidence = {
    status: 'passed',
    findings: ['fresh review checked publication boundary'],
    residualRisks: ['manual reviewer should inspect final PR body'],
    logPath: '/tmp/fresh-review.log',
  };

  const evidence = buildReviewReadyHandoffEvidence({
    publishability,
    freshContextReview,
    nextAction: 'Review the draft pull request before merge.',
  });

  assert.equal(evidence.outcome, 'review-ready');
  assert.deepEqual(evidence.blockers, []);
  assert.deepEqual(evidence.residualRisks, [
    'handoff risk',
    'manual reviewer should inspect final PR body',
  ]);
  assert.deepEqual(evidence.suggestionEvidence, freshContextReview.findings);
  assert.equal(evidence.nextAction, 'Review the draft pull request before merge.');
  assert.equal('pullRequest' in evidence, false);
});

test('runner handoff decision includes successful repair attempts in review-ready evidence', () => {
  const publishability = {
    ...publishReady(),
    repairAttempts: [{
      kind: 'completion-report' as const,
      status: 'passed' as const,
      reason: 'Completion report repair wrote a valid scoped report.',
      sessionId: 'issue-155-session-completion-report-repair',
      promptPath: '/tmp/report-repair-prompt.md',
      reportPath: '/tmp/report.json',
      logPath: '/tmp/report-repair.log',
    }],
  };

  const evidence = buildReviewReadyHandoffEvidence({
    publishability,
    nextAction: 'Review the draft pull request before merge.',
  });

  assert.deepEqual(evidence.repairAttempts?.map((attempt) => attempt.kind), ['completion-report']);
});

test('runner handoff decision drops skipped checks contradicted by passed runner validation', () => {
  const publishability = {
    ...publishReady(),
    skippedChecks: [
      'npm test not run; the focused test covered the changed contract.',
      'Live smoke not run because it mutates real GitHub state.',
    ],
  };

  const evidence = buildReviewReadyHandoffEvidence({
    publishability,
    nextAction: 'Review the draft pull request before merge.',
  });

  assert.deepEqual(evidence.skippedChecks, [
    'Live smoke not run because it mutates real GitHub state.',
  ]);
});

function blockedPublishability(input: {
  reasons: string[];
  residualRisks: string[];
}): Extract<ImplementationPublishabilityResult, { status: 'blocked' }> {
  return {
    status: 'blocked',
    reasons: input.reasons,
    changedFiles: ['src/runner/example.ts'],
    validation: [{ command: 'npm test', status: 'failed', summary: 'failed' }],
    skippedChecks: ['visual proof not required'],
    residualRisks: input.residualRisks,
    commits: [],
    acceptanceProofAttempt: {
      status: 'blocked',
      promptPath: '/tmp/proof.md',
      reportPath: '/tmp/proof.json',
      artifactDir: '/tmp/proofs',
      artifactPaths: [],
      validation: [],
      blockers: ['proof blocked'],
      residualRisks: [],
    },
  };
}

function promotionPublishability(
  reason: string,
): Extract<ImplementationPublishabilityResult, { status: 'promotion-requested' }> {
  return {
    status: 'promotion-requested',
    report: {
      status: 'needs-promotion',
      changes: [],
      validation: [{ command: 'promotion review', status: 'passed', summary: 'promotion recorded' }],
      artifacts: [],
      skippedChecks: [],
      residualRisks: ['promotion risk'],
      prohibitedActions: [],
      promotion: {
        reason,
        criteria: ['multi-scope'],
        evidence: ['issue spans multiple ownership scopes'],
      },
    },
  };
}

function publishReady(): Extract<ImplementationPublishabilityResult, { status: 'publish-ready' }> {
  return {
    status: 'publish-ready',
    report: {
      status: 'completed',
      changes: ['src/runner/example.ts'],
      validation: [{ command: 'npm test', status: 'passed', summary: 'ok' }],
      artifacts: [],
      skippedChecks: [],
      residualRisks: ['handoff risk'],
      prohibitedActions: [],
    },
    changedFiles: ['src/runner/example.ts'],
    validation: [{ command: 'npm test', status: 'passed', summary: 'ok' }],
    artifacts: [],
    skippedChecks: [],
    residualRisks: ['handoff risk'],
    commits: [{
      sha: 'abc123',
      subject: 'Codex: implement issue #1',
      authorName: 'Codex',
      authorEmail: 'codex@example.com',
      committedAt: '2026-07-02T13:19:35.000Z',
    }],
  };
}
