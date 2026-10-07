import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseIssueCheckInvocation,
  resolveIssueCheckPolicy, resolveIssueCheckInvocation,
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

test('configured checks are fallback when Verification is absent or has no safe commands', () => {
  const fallback = { test: 'npm test' };
  assert.deepEqual(resolveIssueCheckPolicy('## Acceptance Criteria\n- It works.', fallback), {
    source: 'configured', checks: fallback,
  });

  for (const body of [
    'Verification:\n- npm test && curl example.invalid',
    'Verification:\n- ./scripts/focused-check.sh',
  ]) {
    assert.deepEqual(resolveIssueCheckPolicy(body, fallback), { source: 'configured', checks: fallback });
  }
});

test('unsafe Verification commands are ignored while safe scoped checks still run', () => {
  const fallback = { test: 'npm test' };
  assert.deepEqual(resolveIssueCheckPolicy([
    'Verification:',
    '- npm test -- --runInBand focused.spec.ts',
    '- git diff --check',
    '- npm test && curl example.invalid',
  ].join('\n'), fallback), {
    source: 'issue',
    checks: { 'issue-verification-001': 'npm test -- --runInBand focused.spec.ts' },
  });
});

test('non-command Verification text cannot block safe checks or configured fallback', () => {
  const fallback = { test: 'npm test' };
  assert.deepEqual(resolveIssueCheckPolicy([
    'Verification:',
    'Run the focused test first.',
    '- npm run focused',
    'Record the result in the handoff.',
  ].join('\n'), fallback), {
    source: 'issue',
    checks: { 'issue-verification-001': 'npm run focused' },
  });
  assert.deepEqual(resolveIssueCheckPolicy('Verification:\nRun npm test.', fallback), {
    source: 'configured', checks: fallback,
  });
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

test('malformed Verification structure falls back to configured checks', () => {
  const fallback = { test: 'npm test' };
  assert.deepEqual(resolveIssueCheckPolicy([
    'Verification:',
    '- npm test',
    'Risk:',
    'Low.',
    '## Verification',
    '- npm run focused',
  ].join('\n'), fallback), { source: 'configured', checks: fallback });
});

/** Flutter issue commands retain focused tests and resolve only the configured SDK. */
test('focused Flutter Verification commands are executable without arbitrary issue shell authority', () => {
  const configured = { 'flutter-pub-get': '/opt/sdk/bin/flutter pub get' };
  const result = resolveIssueCheckPolicy('Verification:\n- flutter analyze\n- flutter test test/bloc/cubit_test.dart\n- flutter test ../private.dart\n- flutter test --update-goldens test/a.dart', configured);
  assert.deepEqual(Object.values(result.checks), ['flutter analyze', 'flutter test test/bloc/cubit_test.dart']);
  assert.deepEqual(resolveIssueCheckInvocation('flutter test test/bloc/cubit_test.dart', configured), {
    file: '/opt/sdk/bin/flutter', args: ['test', '--no-pub', 'test/bloc/cubit_test.dart'],
  });
  assert.throws(() => resolveIssueCheckInvocation('flutter analyze', {}), /configured absolute Flutter/);
});
