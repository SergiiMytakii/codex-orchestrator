import assert from 'node:assert/strict';
import test from 'node:test';
import * as packageApi from '../src/index.js';

import { parseIssueCheckInvocation } from '../src/v2/issue-check-policy.js';

test('package publicly exports the existing issue check invocation parser', () => {
  const parse = Reflect.get(packageApi, 'parseIssueCheckInvocation');
  assert.equal(typeof parse, 'function');
  assert.deepEqual(parse('npm --prefix src/service test -- focused.spec.ts'), {
    file: 'npm', args: ['--prefix', 'src/service', 'test', '--', 'focused.spec.ts'],
  });
  assert.throws(() => parse('npm test && echo unsafe'), /unsupported shell syntax/u);
});
