import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertContainmentCertificateMatchesRuntime,
  containmentCertificatePath,
  createContainmentCertificate,
} from '../src/v2/containment.js';
import { resolveCodexExecutable } from '../src/v2/runtime.js';
import { mkdtemp } from './mission-test-temp.js';

const probe = {
  parentAuthReadable: true,
  parentAuthUsable: true,
  externalCredentialsUsable: false,
  deniedSecretReadable: true,
  productionSentinelExecuted: false,
} as const;
const executablePath = '/usr/local/bin/codex';
const executableSha256 = 'e'.repeat(64);
const darwinOnly = { skip: process.platform !== 'darwin' };

test('runtime resolves the installed Codex executable only from its safe path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-runtime-path-'));
  const parentBin = join(root, 'parent-bin');
  const safeBin = join(root, 'safe-bin');
  await Promise.all([mkdir(parentBin), mkdir(safeBin)]);
  const parentCodex = join(parentBin, 'codex');
  const safeCodex = join(safeBin, 'codex');
  await Promise.all([
    writeFile(parentCodex, '#!/bin/sh\necho codex-cli parent\n'),
    writeFile(safeCodex, '#!/bin/sh\necho codex-cli safe\n'),
  ]);
  await Promise.all([chmod(parentCodex, 0o700), chmod(safeCodex, 0o700)]);

  const previousPath = process.env.PATH;
  process.env.PATH = parentBin;
  try {
    assert.equal(await resolveCodexExecutable('codex', safeBin), await realpath(safeCodex));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('runtime accepts a certificate for the installed Codex version without a configured version pin', darwinOnly, () => {
  const policySha256 = 'a'.repeat(64);
  const certificate = createContainmentCertificate({
    codexVersion: 'codex-cli 0.145.0',
    codexExecutablePath: executablePath,
    codexExecutableSha256: executableSha256,
    packageVersion: '0.1.51',
    argvPolicySha256: policySha256,
    root: probe,
    nativeChild: probe,
    completedAt: '2026-07-16T23:17:40.987Z',
  });

  assert.doesNotThrow(() => assertContainmentCertificateMatchesRuntime(certificate, {
    codexVersion: 'codex-cli 0.145.0',
    codexExecutablePath: executablePath,
    codexExecutableSha256: executableSha256,
    packageVersion: '0.1.51',
    argvPolicySha256: policySha256,
  }));
  assert.equal(containmentCertificatePath('/tmp/orchestrator'), '/tmp/orchestrator/v2/certifications/containment.json');
});

test('runtime still rejects a certificate when the containment policy changes', darwinOnly, () => {
  const certificate = createContainmentCertificate({
    codexVersion: 'codex-cli 0.145.0',
    codexExecutablePath: executablePath,
    codexExecutableSha256: executableSha256,
    packageVersion: '0.1.51',
    argvPolicySha256: 'a'.repeat(64),
    root: probe,
    nativeChild: probe,
    completedAt: '2026-07-16T23:17:40.987Z',
  });

  assert.throws(() => assertContainmentCertificateMatchesRuntime(certificate, {
    codexVersion: 'codex-cli 0.145.0',
    codexExecutablePath: executablePath,
    codexExecutableSha256: executableSha256,
    packageVersion: '0.1.51',
    argvPolicySha256: 'b'.repeat(64),
  }), /containment argv policy mismatch/u);
});

test('runtime still rejects a certificate when the Codex version changes', darwinOnly, () => {
  const policySha256 = 'a'.repeat(64);
  const certificate = createContainmentCertificate({
    codexVersion: 'codex-cli 0.145.0',
    codexExecutablePath: executablePath,
    codexExecutableSha256: executableSha256,
    packageVersion: '0.1.51',
    argvPolicySha256: policySha256,
    root: probe,
    nativeChild: probe,
    completedAt: '2026-07-16T23:17:40.987Z',
  });

  assert.throws(() => assertContainmentCertificateMatchesRuntime(certificate, {
    codexVersion: 'codex-cli 0.146.0',
    codexExecutablePath: executablePath,
    codexExecutableSha256: executableSha256,
    packageVersion: '0.1.51',
    argvPolicySha256: policySha256,
  }), /Codex version does not match the containment certificate/u);
});

test('runtime rejects same-version executable replacement and package drift', darwinOnly, () => {
  const policySha256 = 'a'.repeat(64);
  const certificate = createContainmentCertificate({
    codexVersion: 'codex-cli 0.145.0', codexExecutablePath: executablePath,
    codexExecutableSha256: executableSha256, packageVersion: '0.1.51',
    argvPolicySha256: policySha256, root: probe, nativeChild: probe,
    completedAt: '2026-07-16T23:17:40.987Z',
  });
  assert.throws(() => assertContainmentCertificateMatchesRuntime(certificate, {
    codexVersion: certificate.codexVersion, codexExecutablePath: executablePath,
    codexExecutableSha256: 'f'.repeat(64), packageVersion: certificate.packageVersion,
    argvPolicySha256: policySha256,
  }), /Codex executable does not match/u);
  assert.throws(() => assertContainmentCertificateMatchesRuntime(certificate, {
    codexVersion: certificate.codexVersion, codexExecutablePath: executablePath,
    codexExecutableSha256: executableSha256, packageVersion: '0.1.52',
    argvPolicySha256: policySha256,
  }), /package version does not match/u);
});
