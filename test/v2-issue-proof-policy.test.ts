import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readIssueProofRequirements } from '../src/v2/issue-proof-policy.js';

const tests = { version: 1, level: 'tests-only', reason: 'Public async behavior is established by tests.', authentication: 'none', steps: [] };
const body = (value: unknown) => `## Proof requirements\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

test('frozen issues select tests-only or a concrete authenticated Android workflow', () => {
  assert.deepEqual(readIssueProofRequirements(body(tests)), tests);
  const live = { ...tests, level: 'android-live', authentication: 'dev-account', steps: [{ action: 'tap', text: 'Profile' }, { action: 'expect', text: 'Edit Profile' }] };
  assert.deepEqual(readIssueProofRequirements(body(live)), live);
  assert.equal(readIssueProofRequirements('No explicit contract in legacy issue.'), undefined);
  assert.equal(readIssueProofRequirements('```markdown\n' + body(tests) + '\n```'), undefined);
});

test('ambiguous and downgraded proof contracts fail closed', () => {
  assert.throws(() => readIssueProofRequirements(body({ ...tests, authentication: 'dev-account' })), /Tests-only/);
  assert.throws(() => readIssueProofRequirements(body({ ...tests, level: 'android-live' })), /observable expectation/);
  assert.throws(() => readIssueProofRequirements(body(tests) + '\n' + body(tests)), /one Proof/);
  assert.throws(() => readIssueProofRequirements(body({ ...tests, steps: [], extra: true })), /invalid/);
});
