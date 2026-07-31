import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDirectDeliveryAuthority, createSpecDeliveryAuthority, validateDeliveryAuthority } from '../src/v2/delivery-authority.js';
import { hashRouteDecision, hashTriageArtifact, type RouteReceiptV1 } from '../src/v2/route-decision.js';
import {
  acceptSpecReview, acceptSpecRevision, createInitialSpecDelivery, createSpecRevision, freezeApprovedSpec,
  type SpecReviewReportV1,
} from '../src/v2/spec-delivery.js';

test('delivery authority is one exact hash and rejects route or source drift', () => {
  const artifact = {
    version: 1 as const, status: 'direct' as const,
    inspectedEvidence: [{ kind: 'issue' as const, location: '#1', summary: 'Read issue.' }], assumptions: [],
    direct: { summary: 'Direct.', behaviors: ['Deliver.'], verification: ['Test.'] }, specRequired: null, blocker: null,
  };
  const receipt: RouteReceiptV1 = {
    version: 1, route: 'direct',
    triage: { operation: 'triage', attemptId: 'triage-1', artifactSha256: hashTriageArtifact(artifact), generationHash: 'a'.repeat(64) },
    review: null, artifact, decisionSha256: '', decidedAt: '2026-07-30T00:00:00.000Z', assumptions: [],
  };
  receipt.decisionSha256 = hashRouteDecision(receipt);
  const authority = createDirectDeliveryAuthority(receipt);
  assert.deepEqual(validateDeliveryAuthority(authority, receipt), authority);
  assert.throws(() => validateDeliveryAuthority({ ...authority, sourceSha256: '0'.repeat(64) }, receipt), /binding mismatch/u);
  assert.throws(() => validateDeliveryAuthority(authority, { ...receipt, decisionSha256: '0'.repeat(64) }), /binding mismatch/u);
});

test('spec authority carries exact approved bytes and identity while downstream keeps one canonical hash', () => {
  const receipt = specRouteReceipt();
  const first = approvedSpec('# Approved spec\n', 'review-attempt', 'review-session');
  const authority = createSpecDeliveryAuthority(receipt, first);

  assert.equal(authority.kind, 'spec');
  if (authority.kind !== 'spec') return;
  assert.deepEqual(authority.frozenSpec, {
    content: '# Approved spec\n',
    contentSha256: first.revisions[0]!.contentSha256,
    revision: 1,
    revisionSha256: first.revisions[0]!.revisionSha256,
    approvalReceipt: first.frozen!,
  });
  assert.deepEqual(validateDeliveryAuthority(authority, receipt, first), authority);

  const changedContentSpec = approvedSpec('# Different spec\n', 'review-attempt', 'review-session');
  const changedContent = createSpecDeliveryAuthority(receipt, changedContentSpec);
  const changedApproval = createSpecDeliveryAuthority(receipt, approvedSpec('# Approved spec\n', 'review-attempt-2', 'review-session-2'));
  assert.notEqual(authority.authoritySha256, changedContent.authoritySha256);
  assert.notEqual(authority.authoritySha256, changedApproval.authoritySha256);
  assert.throws(() => validateDeliveryAuthority(authority, receipt, changedContentSpec), /binding mismatch/u);
  assert.equal('frozenSpec' in createDirectDeliveryAuthority({ ...receipt, route: 'direct' } as RouteReceiptV1), false);
});

function specRouteReceipt(): RouteReceiptV1 {
  return {
    version: 1, route: 'spec-required', triage: {
      operation: 'triage', attemptId: 'triage-1', artifactSha256: 'a'.repeat(64), generationHash: 'b'.repeat(64),
    }, review: null, artifact: {} as never, decisionSha256: 'c'.repeat(64), decidedAt: '2026-07-31T00:00:00.000Z', assumptions: [],
  };
}

function approvedSpec(content: string, reviewerAttemptId: string, reviewerSessionId: string) {
  const initial = createInitialSpecDelivery({ issueNumber: 1, runId: 'run-1', workflowGenerationSha256: 'b'.repeat(64) });
  const revision = createSpecRevision({
    revision: 1, path: 'docs/spec.md', content, previousRevision: null,
    evidence: [{ path: 'issue:1', sha256: 'd'.repeat(64), description: 'approved authority' }],
    author: { attemptId: 'author-attempt', sessionId: 'author-session' },
  });
  const report: SpecReviewReportV1 = {
    version: 1, targetRevision: 1, targetSha256: revision.revisionSha256, verdict: 'approved',
    reviewer: { attemptId: reviewerAttemptId, sessionId: reviewerSessionId },
    coverage: ['approved-product-intent', 'deterministic-executability', 'safety', 'scope', 'validation'],
    defects: [], acceptedRisks: [],
  };
  return freezeApprovedSpec(acceptSpecReview(acceptSpecRevision(initial, revision), report, 'e'.repeat(64)));
}
