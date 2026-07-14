import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  authorizeMissionCapability,
  discoverMissionExecutorPrerequisites,
  scrubMissionExecutorEnv,
} from '../src/runner/mission-capability-kernel.js';

test('capability probe enables only a platform with every required enforcement primitive', () => {
  assert.deepEqual(discoverMissionExecutorPrerequisites({
    platform: 'darwin',
    commands: new Set(['/usr/bin/sandbox-exec', '/usr/bin/git']),
  }), {
    prerequisitesAvailable: true,
    backend: 'macos-sandbox',
    missing: [],
  });
  assert.deepEqual(discoverMissionExecutorPrerequisites({
    platform: 'linux',
    commands: new Set(['/usr/bin/git']),
  }), {
    prerequisitesAvailable: false,
    backend: undefined,
    missing: ['bwrap'],
  });
  assert.equal(discoverMissionExecutorPrerequisites({
    platform: 'win32',
    commands: new Set(),
  }).prerequisitesAvailable, false);
});

test('capability authorization is finite, argv-only, scope-bound, and fencing-bound', () => {
  const permit = authorizeMissionCapability({
    missionId: 'mission-a',
    actionKey: 'observe-status-1',
    capability: 'validate-patch',
    argv: [],
    requestedPaths: ['src/**'],
    grantedPaths: ['src/**', 'test/**'],
    inputSnapshot: 'tree:abc',
    fencingEpoch: 2,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  assert.equal(permit.network, 'deny');
  assert.equal(permit.workspace, 'read-only');
  assert.equal(authorizeMissionCapability({
    ...permit,
    capability: 'read-file',
    requestedPaths: ['src/value.ts'],
    readPath: 'src/value.ts',
    maxReadBytes: 4096,
  }).readPath, 'src/value.ts');
  assert.equal(authorizeMissionCapability({
    ...permit,
    capability: 'git-status',
    requestedPaths: ['**'],
    grantedPaths: ['**'],
  }).capability, 'git-status');

  assert.throws(() => authorizeMissionCapability({
    ...permit,
    requestedPaths: ['.env'],
    grantedPaths: ['**'],
  }), /secret path/);
  assert.throws(() => authorizeMissionCapability({
    ...permit,
    argv: ['/bin/sh', '-c', 'git status'],
  }), /allowlisted argv/);
  assert.throws(() => authorizeMissionCapability({
    ...permit,
    requestedPaths: ['docs/**'],
    grantedPaths: ['src/**'],
  }), /outside granted scope/);
  assert.throws(() => authorizeMissionCapability({
    ...permit,
    requestedPaths: ['src/*'],
    grantedPaths: ['src/mission*'],
  }), /outside granted scope/);
  assert.throws(() => authorizeMissionCapability({
    ...permit,
    capability: 'git-status',
    requestedPaths: ['src/**'],
    grantedPaths: ['src/**'],
  }), /git-status requires explicit whole-repository scope/);
  assert.throws(() => authorizeMissionCapability({
    ...permit,
    capability: 'read-file',
    requestedPaths: ['src/value.ts'],
    readPath: 'src/value.ts',
    maxReadBytes: 1024 * 1024 + 1,
  }), /maxReadBytes/);
});

test('executor environment drops credentials and keeps only explicit non-secret values', () => {
  assert.deepEqual(scrubMissionExecutorEnv({
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    GH_TOKEN: 'secret-canary',
    OPENAI_API_KEY: 'secret-canary',
    SSH_AUTH_SOCK: '/tmp/agent',
    AWS_ACCESS_KEY_ID: 'secret-canary',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/secret-canary',
    GITHUB_PAT: 'secret-canary',
    DATABASE_URL: 'postgres://secret-canary',
    SAFE_FLAG: 'yes',
  }, [
    'PATH', 'LANG', 'SAFE_FLAG', 'GH_TOKEN', 'AWS_ACCESS_KEY_ID',
    'GOOGLE_APPLICATION_CREDENTIALS', 'GITHUB_PAT', 'DATABASE_URL',
  ]), {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
  });
});
