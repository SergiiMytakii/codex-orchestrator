import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertContainmentCertificateMatchesRuntime,
  createContainmentCertificate,
} from '../src/v2/containment.js';

const probe = {
  parentAuthReadable: true,
  parentAuthUsable: true,
  externalCredentialsUsable: false,
  deniedSecretReadable: true,
  productionSentinelExecuted: false,
} as const;
const darwinOnly = { skip: process.platform !== 'darwin' };

test('runtime accepts a certificate from an older package when Codex and containment policy are unchanged', darwinOnly, () => {
  const policySha256 = 'a'.repeat(64);
  const certificate = createContainmentCertificate({
    packageVersion: '0.1.51',
    argvPolicySha256: policySha256,
    root: probe,
    nativeChild: probe,
    completedAt: '2026-07-16T23:17:40.987Z',
  });

  assert.doesNotThrow(() => assertContainmentCertificateMatchesRuntime(certificate, {
    codexVersion: 'codex-cli 0.144.4',
    argvPolicySha256: policySha256,
  }));
});

test('runtime still rejects a certificate when the containment policy changes', darwinOnly, () => {
  const certificate = createContainmentCertificate({
    packageVersion: '0.1.51',
    argvPolicySha256: 'a'.repeat(64),
    root: probe,
    nativeChild: probe,
    completedAt: '2026-07-16T23:17:40.987Z',
  });

  assert.throws(() => assertContainmentCertificateMatchesRuntime(certificate, {
    codexVersion: 'codex-cli 0.144.4',
    argvPolicySha256: 'b'.repeat(64),
  }), /containment argv policy mismatch/u);
});

test('runtime still rejects a certificate when the Codex version changes', darwinOnly, () => {
  const policySha256 = 'a'.repeat(64);
  const certificate = createContainmentCertificate({
    packageVersion: '0.1.51',
    argvPolicySha256: policySha256,
    root: probe,
    nativeChild: probe,
    completedAt: '2026-07-16T23:17:40.987Z',
  });

  assert.throws(() => assertContainmentCertificateMatchesRuntime(certificate, {
    codexVersion: 'codex-cli 0.145.0',
    argvPolicySha256: policySha256,
  }), /Codex version does not match the containment certificate/u);
});
