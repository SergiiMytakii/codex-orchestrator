import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp, mkdtempSync } from './mission-test-temp.js';

import { buildMissionSandboxInvocation } from '../src/runner/mission-sandbox.js';
import { runMissionProcess } from '../src/runner/mission-process-executor.js';

test('macOS sandbox denies network and canonical writes for read-only observation', () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-sandbox-static-'));
  const quarantine = mkdtempSync(join(tmpdir(), 'mission-sandbox-static-q-'));
  const invocation = buildMissionSandboxInvocation({
    backend: 'macos-sandbox',
    workspaceRoot: root,
    quarantineRoot: quarantine,
    mode: 'read-only',
    command: '/usr/bin/git',
    args: ['status', '--porcelain=v1'],
  });
  assert.equal(invocation.file, '/usr/bin/sandbox-exec');
  assert.match(invocation.args[1] ?? '', /\(deny network\*\)/);
  assert.doesNotMatch(invocation.args[1] ?? '', /allow process-fork/);
  assert.doesNotMatch(invocation.args[1] ?? '', /file-write.*\/repo"/);
});

test('patch sandbox grants writes only to quarantine and Linux uses bwrap network isolation', () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-sandbox-static-'));
  const quarantine = mkdtempSync(join(tmpdir(), 'mission-sandbox-static-q-'));
  const mac = buildMissionSandboxInvocation({
    backend: 'macos-sandbox',
    workspaceRoot: root,
    quarantineRoot: quarantine,
    mode: 'quarantine-write',
    command: '/usr/bin/git',
    args: ['apply', '--check', '/quarantine/change.patch'],
  });
  const canonicalQuarantine = realpathSync.native(quarantine);
  assert.match(mac.args[1] ?? '', new RegExp(`subpath "${canonicalQuarantine.replaceAll('/', '\\/')}"`));

  const linux = buildMissionSandboxInvocation({
    backend: 'linux-bwrap',
    workspaceRoot: root,
    quarantineRoot: quarantine,
    mode: 'read-only',
    command: '/usr/bin/git',
    args: ['status'],
  });
  assert.equal(linux.file, '/usr/bin/bwrap');
  assert.equal(linux.args.includes('--unshare-net'), true);
  assert.equal(linux.args.includes('--ro-bind'), true);

  assert.throws(() => buildMissionSandboxInvocation({
    backend: 'macos-sandbox',
    workspaceRoot: join(root, 'missing'),
    quarantineRoot: quarantine,
    mode: 'read-only',
    command: '/usr/bin/git',
    args: ['status'],
  }), /must resolve to an existing canonical path/);
});

test('macOS sandbox enforcement denies network and canonical writes but permits quarantine writes', async (context) => {
  if (process.platform !== 'darwin') {
    context.skip('Darwin enforcement contract; Linux requires bwrap on the target host.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'mission-sandbox-live-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-quarantine-live-'));
  const secretDirectory = await mkdtemp(join(tmpdir(), 'mission-secret-live-'));
  const secretPath = join(secretDirectory, '.env');
  await writeFile(secretPath, 'filesystem-credential-canary', 'utf8');
  const canonicalPath = join(root, 'blocked.txt');
  const quarantinePath = join(quarantine, 'allowed.txt');
  const invocation = buildMissionSandboxInvocation({
    backend: 'macos-sandbox',
    workspaceRoot: root,
    quarantineRoot: quarantine,
    mode: 'quarantine-write',
    command: '/bin/sh',
    args: ['-c', 'printf ok > "$1"; printf bad > "$2" || true', 'sh', quarantinePath, canonicalPath],
  });
  const result = await runMissionProcess({
    ...invocation,
    timeoutMs: 5_000,
    sourceEnv: { PATH: process.env.PATH },
    allowedEnvKeys: ['PATH'],
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(await readFile(quarantinePath, 'utf8'), 'ok');
  await assert.rejects(access(canonicalPath));

  const networkInvocation = buildMissionSandboxInvocation({
    backend: 'macos-sandbox',
    workspaceRoot: root,
    quarantineRoot: quarantine,
    mode: 'read-only',
    command: '/usr/bin/perl',
    args: [
      '-MSocket',
      '-MErrno=EPERM',
      '-e',
      'socket(my $s, PF_INET, SOCK_STREAM, 0) or die $!; connect($s, sockaddr_in(9, inet_aton("127.0.0.1"))); exit($! == EPERM ? 0 : 30)',
    ],
  });
  const network = await runMissionProcess({
    ...networkInvocation,
    timeoutMs: 5_000,
    sourceEnv: { PATH: process.env.PATH },
    allowedEnvKeys: ['PATH'],
  });
  assert.equal(network.exitCode, 0, network.stderr);

  const readSecretInvocation = buildMissionSandboxInvocation({
    backend: 'macos-sandbox',
    workspaceRoot: root,
    quarantineRoot: quarantine,
    mode: 'read-only',
    command: '/bin/cat',
    args: [secretPath],
  });
  const readSecret = await runMissionProcess({
    ...readSecretInvocation,
    timeoutMs: 5_000,
    sourceEnv: { PATH: process.env.PATH },
    allowedEnvKeys: ['PATH'],
  });
  assert.notEqual(readSecret.exitCode, 0);
  assert.doesNotMatch(readSecret.stdout, /filesystem-credential-canary/);
});
