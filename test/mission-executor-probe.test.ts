import assert from 'node:assert/strict';
import { test } from 'node:test';

import { probeMissionExecutorCapabilities } from '../src/runner/mission-executor-probe.js';

test('active executor probe proves every v1 isolation canary before support', async (context) => {
  if (process.platform !== 'darwin') {
    context.skip('Current CI host proves the macOS backend; Linux fails closed unless its active probe is implemented.');
    return;
  }
  const result = await probeMissionExecutorCapabilities({
    platform: process.platform,
    commands: new Set(['/usr/bin/sandbox-exec', '/usr/bin/git']),
  });
  assert.deepEqual(result, {
    supported: true,
    backend: 'macos-sandbox',
    checks: [
      'canonical-write-denied',
      'credential-env-stripped',
      'denied-read-path-blocked',
      'descendant-process-terminated',
      'network-denied',
      'quarantine-write-allowed',
    ],
    failures: [],
  });
});
