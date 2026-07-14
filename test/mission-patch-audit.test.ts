import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditMissionPatch } from '../src/runner/mission-patch-audit.js';

const safePatch = [
  'diff --git a/src/value.ts b/src/value.ts',
  'index 1111111..2222222 100644',
  '--- a/src/value.ts',
  '+++ b/src/value.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
].join('\n');

test('patch audit accepts text-only in-scope regular-file changes', () => {
  assert.deepEqual(auditMissionPatch({
    patch: safePatch,
    grantedPaths: ['src/**'],
    deniedPaths: ['.env*', '.git/**'],
    maxBytes: 10_000,
  }), {
    accepted: true,
    files: [{
      path: 'src/value.ts', operation: 'modify', oldMode: '100644', newMode: '100644',
    }],
  });
});

test('patch audit rejects traversal, git internals, symlinks, submodules, binary and out-of-scope paths', () => {
  for (const [name, patch] of [
    ['traversal', safePatch.replaceAll('src/value.ts', '../value.ts')],
    ['git internals', safePatch.replaceAll('src/value.ts', '.git/config')],
    ['symlink', safePatch.replace('index 1111111..2222222 100644', 'old mode 100644\nnew mode 120000')],
    ['submodule', safePatch.replace('index 1111111..2222222 100644', 'index 1111111..2222222 160000')],
    ['binary', safePatch.replace('@@ -1 +1 @@', 'Binary files a/src/value.ts and b/src/value.ts differ')],
    ['scope', safePatch.replaceAll('src/value.ts', 'docs/value.ts')],
    ['mismatched target', safePatch.replace('+++ b/src/value.ts', '+++ b/.git/config')],
    ['rename metadata', `${safePatch}rename from src/value.ts\nrename to .git/config\n`],
  ] as const) {
    const result = auditMissionPatch({
      patch,
      grantedPaths: ['src/**'],
      deniedPaths: ['.git/**'],
      maxBytes: 10_000,
    });
    assert.equal(result.accepted, false, name);
  }
});

test('patch audit rejects incomplete, duplicate, and case-colliding file records', () => {
  const headerOnly = 'diff --git a/src/value.ts b/src/value.ts\n';
  assert.equal(auditMissionPatch({
    patch: headerOnly,
    grantedPaths: ['src/**'],
    deniedPaths: [],
    maxBytes: 10_000,
  }).accepted, false);
  assert.equal(auditMissionPatch({
    patch: `${safePatch}${safePatch}`,
    grantedPaths: ['src/**'],
    deniedPaths: [],
    maxBytes: 20_000,
  }).accepted, false);
  assert.equal(auditMissionPatch({
    patch: `${safePatch}${safePatch.replaceAll('src/value.ts', 'src/VALUE.ts')}`,
    grantedPaths: ['src/**'],
    deniedPaths: [],
    maxBytes: 20_000,
  }).accepted, false);
  const repeatedHeaders = safePatch.replace(
    '@@ -1 +1 @@',
    '--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@',
  );
  assert.equal(auditMissionPatch({
    patch: repeatedHeaders,
    grantedPaths: ['src/**'],
    deniedPaths: [],
    maxBytes: 20_000,
  }).accepted, false);
  assert.deepEqual(auditMissionPatch({
    patch: safePatch.replaceAll('src/value.ts', '.ENV'),
    grantedPaths: ['**'],
    deniedPaths: ['.env*', '**/.env*'],
    maxBytes: 20_000,
  }), {
    accepted: false,
    reason: 'denied-path',
  });
  const quotedOutside = [
    'diff --git "a/docs/outside file.ts" "b/docs/outside file.ts"',
    '--- "a/docs/outside file.ts"',
    '+++ "b/docs/outside file.ts"',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    safePatch,
  ].join('\n');
  assert.deepEqual(auditMissionPatch({
    patch: quotedOutside,
    grantedPaths: ['src/**'],
    deniedPaths: [],
    maxBytes: 20_000,
  }), { accepted: false, reason: 'malformed-diff-header' });
  assert.deepEqual(auditMissionPatch({
    patch: safePatch.replace('@@ -1 +1 @@', '@@ not-a-hunk @@'),
    grantedPaths: ['src/**'], deniedPaths: [], maxBytes: 20_000,
  }), { accepted: false, reason: 'malformed-hunk-header' });
  assert.deepEqual(auditMissionPatch({
    patch: safePatch.replace('@@ -1 +1 @@', '@@ -1,2 +1 @@'),
    grantedPaths: ['src/**'], deniedPaths: [], maxBytes: 20_000,
  }), { accepted: false, reason: 'hunk-line-count-mismatch' });
  assert.deepEqual(auditMissionPatch({
    patch: safePatch.replace('+export const value = 2;', '+export const value = 2;\n+extra'),
    grantedPaths: ['src/**'], deniedPaths: [], maxBytes: 20_000,
  }), { accepted: false, reason: 'hunk-line-count-mismatch' });
});

test('patch audit represents additions and deletions with explicit absent sides', () => {
  const added = [
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    'index 0000000..2222222',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1 @@',
    '+export const value = 1;',
    '',
  ].join('\n');
  const deleted = [
    'diff --git a/src/old.ts b/src/old.ts',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-export const value = 1;',
    '',
  ].join('\n');
  assert.deepEqual(auditMissionPatch({
    patch: added, grantedPaths: ['src/**'], deniedPaths: [], maxBytes: 10_000,
  }), {
    accepted: true,
    files: [{ path: 'src/new.ts', operation: 'add', oldMode: null, newMode: '100644' }],
  });
  assert.deepEqual(auditMissionPatch({
    patch: deleted, grantedPaths: ['src/**'], deniedPaths: [], maxBytes: 10_000,
  }), {
    accepted: true,
    files: [{ path: 'src/old.ts', operation: 'delete', oldMode: '100644', newMode: null }],
  });
});
