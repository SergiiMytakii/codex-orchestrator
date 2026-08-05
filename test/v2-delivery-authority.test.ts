import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIssueDeliveryAuthority, validateDeliveryAuthority } from '../src/v2/delivery-authority.js';

const issue = {
  issueNumber: 1262,
  issueUrl: 'https://github.com/owner/repo/issues/1262',
  title: 'Implement authorized behavior',
  body: 'Acceptance Criteria:\n- works',
  authorizationLabel: 'agent:auto',
};

test('explicit Issue authority binds the immutable issue content and authorization label', () => {
  const authority = createIssueDeliveryAuthority(issue);
  assert.equal(authority.version, 2);
  assert.equal(authority.kind, 'issue');
  assert.deepEqual(validateDeliveryAuthority(authority, issue), authority);
  assert.throws(() => validateDeliveryAuthority(authority, { ...issue, body: 'changed' }), /binding mismatch/u);
  assert.throws(() => validateDeliveryAuthority(authority, { ...issue, authorizationLabel: 'agent:review' }), /binding mismatch/u);
});

test('planning artifacts cannot be represented as package delivery authority', () => {
  const authority = createIssueDeliveryAuthority(issue);
  assert.deepEqual(Object.keys(authority).sort(), [
    'authoritySha256', 'authorizationLabel', 'issueNumber', 'issueSnapshotSha256', 'issueUrl', 'kind', 'sourceSha256', 'version',
  ]);
  assert.throws(() => validateDeliveryAuthority({ ...authority, kind: 'spec' }, issue), /invalid/u);
});
