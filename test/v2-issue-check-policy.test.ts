import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidIssueCheckPolicyError,
  parseIssueCheckInvocation,
  resolveIssueCheckPolicy,
} from '../src/v2/issue-check-policy.js';

test('issue Verification commands replace configured fallback checks in declared order', () => {
  const policy = resolveIssueCheckPolicy([
    'Verification:',
    '- `npm --prefix src/service test -- --runInBand focused.spec.ts`',
    '- npm run typecheck',
    '',
    'Risk:',
    'Low.',
  ].join('\n'), { test: 'npm test' });

  assert.deepEqual(policy, {
    source: 'issue',
    checks: {
      'issue-verification-001': 'npm --prefix src/service test -- --runInBand focused.spec.ts',
      'issue-verification-002': 'npm run typecheck',
    },
  });
  assert.deepEqual(parseIssueCheckInvocation(policy.checks['issue-verification-001']!), {
    file: 'npm', args: ['--prefix', 'src/service', 'test', '--', '--runInBand', 'focused.spec.ts'],
  });
});

test('configured checks are fallback only when Verification is absent', () => {
  const fallback = { test: 'npm test' };
  assert.deepEqual(resolveIssueCheckPolicy('## Acceptance Criteria\n- It works.', fallback), {
    source: 'configured', checks: fallback,
  });

  for (const body of [
    'Verification:\n- npm test && curl example.invalid',
    'Verification:\n- ./scripts/focused-check.sh',
    'Verification:\n- npm test\n- node -e process.exit(0)',
  ]) {
    assert.throws(() => resolveIssueCheckPolicy(body, fallback), InvalidIssueCheckPolicyError);
  }
});

test('fenced examples cannot shadow the single real Verification section', () => {
  const policy = resolveIssueCheckPolicy([
    '## Reproduction',
    '```markdown',
    'Verification:',
    '- npm test',
    '```',
    '',
    '## Verification:',
    '- npm run focused',
  ].join('\n'), { test: 'npm test' });

  assert.deepEqual(policy, { source: 'issue', checks: { 'issue-verification-001': 'npm run focused' } });
});

test('mixed fence delimiters cannot expose a fenced Verification example', () => {
  const policy = resolveIssueCheckPolicy([
    '```markdown',
    '~~~',
    'Verification:',
    '- npm test',
    '## Risk',
    '```',
    '## Verification:',
    '- npm run focused',
  ].join('\n'), { test: 'npm test' });
  assert.deepEqual(policy, { source: 'issue', checks: { 'issue-verification-001': 'npm run focused' } });
});

test('configured fallback source is explicit even when its id resembles a scoped id', () => {
  const fallback = { 'issue-verification-legacy': 'make test' };
  assert.deepEqual(resolveIssueCheckPolicy('No Verification section.', fallback), {
    source: 'configured', checks: fallback,
  });
});

test('duplicate real Verification sections fail closed', () => {
  assert.throws(() => resolveIssueCheckPolicy([
    'Verification:',
    '- npm test',
    'Risk:',
    'Low.',
    '## Verification',
    '- npm run focused',
  ].join('\n'), {}), InvalidIssueCheckPolicyError);
});
