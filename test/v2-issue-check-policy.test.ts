import assert from 'node:assert/strict';
import test from 'node:test';
import * as packageApi from '../src/index.js';

import {
  parseIssueCheckInvocation,
  resolveIssueCheckPolicy, resolveIssueCheckInvocation,
} from '../src/v2/issue-check-policy.js';

test('package publicly exports the existing issue check invocation parser', () => {
  const parse = Reflect.get(packageApi, 'parseIssueCheckInvocation');
  assert.equal(typeof parse, 'function');
  assert.deepEqual(parse('npm --prefix src/service test -- focused.spec.ts'), {
    file: 'npm', args: ['--prefix', 'src/service', 'test', '--', 'focused.spec.ts'],
  });
  assert.throws(() => parse('npm test && echo unsafe'), /unsupported shell syntax/u);
});

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
  for (const body of ['Verification:\n- npm test && curl example.invalid', 'Verification:\n- ./scripts/focused-check.sh', 'Verification:\nRun npm test.']) {
    assert.throws(() => resolveIssueCheckPolicy(body, fallback), /Issue Verification/u);
  }
});

test('one invalid command cannot silently reduce the declared verification set', () => {
  assert.throws(() => resolveIssueCheckPolicy('Verification:\n- npm run focused\n- npm test && curl example.invalid', { all: 'npm test' }), /invalid command bullet/u);
  assert.throws(() => resolveIssueCheckPolicy('Verification:\n- npm run focused\n- git diff --check', {}), /invalid command bullet/u);
});

test('unbulleted explanation remains separate from executable commands', () => {
  assert.deepEqual(resolveIssueCheckPolicy('Verification:\nRun the focused test first.\n- npm run focused\nRecord the result.', {}), {
    source: 'issue', checks: { 'issue-verification-001': 'npm run focused' },
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

test('malformed Verification structure is rejected', () => {
  const fallback = { test: 'npm test' };
  assert.throws(() => resolveIssueCheckPolicy([
    'Verification:', '- npm test', 'Risk:', 'Low.', '## Verification', '- npm run focused',
  ].join('\n'), fallback), /multiple Verification/u);
});

/** Flutter issue commands retain focused tests and resolve only the configured SDK. */
test('focused Flutter Verification commands are executable without arbitrary issue shell authority', () => {
  const configured = { 'flutter-pub-get': '/opt/sdk/bin/flutter pub get' };
  const result = resolveIssueCheckPolicy('Verification:\n- flutter analyze\n- flutter test test/bloc/cubit_test.dart', configured);
  assert.deepEqual(Object.values(result.checks), ['flutter analyze', 'flutter test test/bloc/cubit_test.dart']);
  assert.deepEqual(resolveIssueCheckInvocation('flutter test test/bloc/cubit_test.dart', configured), {
    file: '/opt/sdk/bin/flutter', args: ['test', '--no-pub', 'test/bloc/cubit_test.dart'],
  });
  assert.throws(() => resolveIssueCheckInvocation('flutter analyze', {}), /configured absolute Flutter/);
});

/** Malformed declared verification cannot silently select unrelated checks. */
test('declared Verification with no executable command is an actionable error', () => {
  for (const body of ['Verification:\n- flutter analyze --no-pub — baseline info', 'Verification:\nRun tests.', 'Verification:\n- npm test && curl example.invalid']) {
    assert.throws(() => resolveIssueCheckPolicy(body, { all: 'npm test' }), /Issue Verification/u);
  }
});

test('Flutter analyzer ignores infos while preserving fatal warnings and errors', () => {
  const config = { pub: '/opt/sdk/bin/flutter pub get' };
  assert.deepEqual(resolveIssueCheckInvocation('flutter analyze --no-pub --no-fatal-infos', config), {
    file: '/opt/sdk/bin/flutter', args: ['analyze', '--no-pub', '--no-fatal-infos'],
  });
});

/** Explicit legacy commands retain the configured repository severity policy. */
test('plain issue analyzer inherits the pinned SDK info policy without changing strict repositories', () => {
  const pub = '/opt/sdk/bin/flutter pub get';
  assert.deepEqual(resolveIssueCheckInvocation('flutter analyze', { pub, analyze: '/opt/sdk/bin/flutter analyze --no-pub --no-fatal-infos' }).args,
    ['analyze', '--no-pub', '--no-fatal-infos']);
  assert.deepEqual(resolveIssueCheckInvocation('flutter analyze', { pub, analyze: '/opt/sdk/bin/flutter analyze --no-pub' }).args,
    ['analyze', '--no-pub']);
});
