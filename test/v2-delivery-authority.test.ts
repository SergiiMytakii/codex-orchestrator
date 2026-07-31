import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDirectDeliveryAuthority, validateDeliveryAuthority } from '../src/v2/delivery-authority.js';
import { hashRouteDecision, hashTriageArtifact, type RouteReceiptV1 } from '../src/v2/route-decision.js';

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
