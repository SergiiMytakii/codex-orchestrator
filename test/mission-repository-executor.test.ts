import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';

import { MissionRepositoryExecutor } from '../src/runner/mission-repository-executor.js';
import type { MissionProcessInput, MissionProcessResult } from '../src/runner/mission-process-executor.js';

const capabilityProof = {
  supported: true,
  backend: 'macos-sandbox' as const,
  checks: [
    'canonical-write-denied',
    'credential-env-stripped',
    'denied-read-path-blocked',
    'descendant-process-terminated',
    'network-denied',
    'quarantine-write-allowed',
  ],
  failures: [],
};
const permitAuthority = {
  begin: async () => ({ kind: 'execute' as const }),
  complete: async () => 'a'.repeat(64),
  readReceipt: async () => { throw new Error('No completed receipt in this test.'); },
};
const snapshotVerifier = { verify: async () => undefined };

test('repository executor owns permit validation, sandbox mode, command, and environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-owned-executor-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-owned-quarantine-'));
  const calls: MissionProcessInput[] = [];
  const runProcess = async (input: MissionProcessInput): Promise<MissionProcessResult> => {
    calls.push(input);
    return { stdout: ' M src/value.ts\n', stderr: '', exitCode: 0, timedOut: false, termination: 'exited' };
  };
  const executor = new MissionRepositoryExecutor({
    backend: 'macos-sandbox',
    workspaceRoot: root,
    quarantineRoot: quarantine,
    deniedReadPaths: [],
    sourceEnv: { PATH: '/usr/bin', GH_TOKEN: 'credential-canary' },
    allowedEnvKeys: ['PATH', 'GH_TOKEN'],
    timeoutMs: 1_000,
    capabilityProof,
  }, { runProcess, permitAuthority, snapshotVerifier });
  const permit = executor.authorize({
    missionId: 'mission-a',
    actionKey: 'status-1',
    capability: 'git-status',
    argv: [],
    requestedPaths: ['**'],
    grantedPaths: ['**'],
    inputSnapshot: 'tree:abc',
    fencingEpoch: 2,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });

  assert.equal((await executor.observeGitStatus(permit)).stdout, ' M src/value.ts\n');
  assert.equal(calls[0]?.file, '/usr/bin/sandbox-exec');
  assert.equal(calls[0]?.args.includes('/usr/bin/git'), true);
  assert.equal(calls[0]?.args.includes('core.fsmonitor=false'), true);
  assert.equal(calls[0]?.sourceEnv.GH_TOKEN, 'credential-canary');
  assert.deepEqual(calls[0]?.allowedEnvKeys, ['PATH', 'GH_TOKEN']);
});

test('repository executor binds file reads and patch audit to the authorized scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-owned-read-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-owned-read-q-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/value.ts'), 'safe', 'utf8');
  const runProcess = async (input: MissionProcessInput): Promise<MissionProcessResult> => {
    const outputPath = input.args.at(-1);
    assert.ok(outputPath);
    await writeFile(outputPath, input.stdin ?? '', 'utf8');
    return {
      stdout: input.stdin ?? '', stderr: '', exitCode: 0, timedOut: false, termination: 'exited',
    };
  };
  const completedArtifacts: Uint8Array[][] = [];
  const executor = new MissionRepositoryExecutor({
    backend: 'macos-sandbox',
    workspaceRoot: root,
    quarantineRoot: quarantine,
    deniedReadPaths: [],
    sourceEnv: { PATH: '/usr/bin' },
    allowedEnvKeys: ['PATH'],
    timeoutMs: 1_000,
    capabilityProof,
  }, {
    permitAuthority: {
      ...permitAuthority,
      complete: async (_permit, _payload, artifacts = []) => {
        completedArtifacts.push(artifacts);
        return 'a'.repeat(64);
      },
    },
    snapshotVerifier,
    runProcess,
  });
  const readPermit = executor.authorize({
    missionId: 'mission-a', actionKey: 'read-1', capability: 'read-file', argv: [],
    requestedPaths: ['src/value.ts'], grantedPaths: ['src/**'], inputSnapshot: 'tree:abc', fencingEpoch: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
    readPath: 'src/value.ts', maxReadBytes: 100,
  });
  assert.equal(await executor.readText(readPermit), 'safe');
  await assert.rejects(executor.readText({
    ...readPermit, requestedPaths: ['docs/value.ts'], readPath: 'docs/value.ts',
  }), /outside granted scope/);

  const patchPermit = executor.authorize({
    missionId: 'mission-a', actionKey: 'patch-1', capability: 'validate-patch', argv: [],
    requestedPaths: ['src/**'], grantedPaths: ['src/**'], inputSnapshot: 'tree:abc', fencingEpoch: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const acceptedPatch = [
    'diff --git a/src/value.ts b/src/value.ts',
    'index 1111111..2222222 100644',
    '--- a/src/value.ts',
    '+++ b/src/value.ts',
    '@@ -1 +1 @@',
    '-safe',
    '+changed',
    '',
  ].join('\n');
  const accepted = await executor.executePatch(patchPermit, acceptedPatch);
  assert.equal(accepted.accepted, true);
  if (accepted.accepted) {
    const identity = accepted.preconditions['src/value.ts'];
    assert.equal(identity?.repositoryPath, 'src/value.ts');
    assert.equal(identity?.canonicalPath, await realpath(join(root, 'src/value.ts')));
    assert.equal(identity?.size, 4);
    assert.match(identity?.sha256 ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(Number.isSafeInteger(identity?.dev), true);
    assert.equal(Number.isSafeInteger(identity?.ino), true);
    assert.equal(accepted.receipt.storage, 'mission-state-blob');
    assert.equal(accepted.receipt.sha256, createHash('sha256').update(acceptedPatch).digest('hex'));
  }

  await link(join(root, 'src/value.ts'), join(root, 'src/hardlink.ts'));
  const patch = [
    'diff --git a/src/hardlink.ts b/src/hardlink.ts',
    'index 1111111..2222222 100644',
    '--- a/src/hardlink.ts',
    '+++ b/src/hardlink.ts',
    '@@ -1 +1 @@',
    '-safe',
    '+changed',
    '',
  ].join('\n');
  const rejected = await executor.executePatch({ ...patchPermit, actionKey: 'patch-2' }, patch);
  assert.equal(rejected.accepted, false);
  if (!rejected.accepted) {
    assert.equal(rejected.reason, 'canonical-non-regular-or-hard-linked-file-forbidden');
  }
  assert.equal(completedArtifacts.some(([artifact]) =>
    artifact && Buffer.from(artifact).equals(Buffer.from(acceptedPatch, 'utf8'))), true);
  assert.equal(completedArtifacts.some(([artifact]) =>
    artifact && Buffer.from(artifact).equals(Buffer.from(patch, 'utf8'))), true);
  assert.deepEqual(await readdir(join(quarantine, 'patch-receipts')), []);
});

test('quarantine receipt rejects a hardlink without changing the outside inode mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-hardlink-receipt-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-hardlink-receipt-q-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/value.ts'), 'safe', 'utf8');
  const patch = [
    'diff --git a/src/value.ts b/src/value.ts',
    'index 1111111..2222222 100644',
    '--- a/src/value.ts',
    '+++ b/src/value.ts',
    '@@ -1 +1 @@',
    '-safe',
    '+changed',
    '',
  ].join('\n');
  const outside = join(root, 'outside.patch');
  await writeFile(outside, patch, { encoding: 'utf8', mode: 0o600 });
  const runProcess = async (input: MissionProcessInput): Promise<MissionProcessResult> => {
    const outputPath = input.args.at(-1);
    assert.ok(outputPath);
    await link(outside, outputPath);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, termination: 'exited' };
  };
  const executor = new MissionRepositoryExecutor({
    backend: 'macos-sandbox', workspaceRoot: root, quarantineRoot: quarantine,
    deniedReadPaths: [], sourceEnv: { PATH: '/usr/bin' }, allowedEnvKeys: ['PATH'],
    timeoutMs: 1_000, capabilityProof,
  }, { permitAuthority, snapshotVerifier, runProcess });
  const permit = executor.authorize({
    missionId: 'mission-a', actionKey: 'patch-hardlink', capability: 'validate-patch', argv: [],
    requestedPaths: ['src/**'], grantedPaths: ['src/**'], inputSnapshot: 'tree:abc',
    fencingEpoch: 1, expiresAt: '2099-01-01T00:00:00.000Z',
  });

  await assert.rejects(executor.executePatch(permit, patch), /single-link regular file/);
  assert.equal((await stat(outside)).mode & 0o777, 0o600);
});

test('retains a content-addressed quarantine patch when durable completion fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-retained-patch-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-retained-patch-q-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/value.ts'), 'safe\n', 'utf8');
  const patch = [
    'diff --git a/src/value.ts b/src/value.ts',
    'index 1111111..2222222 100644',
    '--- a/src/value.ts',
    '+++ b/src/value.ts',
    '@@ -1 +1 @@',
    '-safe',
    '+changed',
    '',
  ].join('\n');
  const executor = new MissionRepositoryExecutor({
    backend: 'macos-sandbox', workspaceRoot: root, quarantineRoot: quarantine,
    deniedReadPaths: [], sourceEnv: { PATH: '/usr/bin' }, allowedEnvKeys: ['PATH'],
    timeoutMs: 1_000, capabilityProof,
  }, {
    snapshotVerifier,
    permitAuthority: {
      ...permitAuthority,
      complete: async () => { throw new Error('durable-completion-failed'); },
    },
    runProcess: async (input) => {
      await writeFile(input.args.at(-1)!, input.stdin ?? '', 'utf8');
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, termination: 'exited' };
    },
  });
  const permit = executor.authorize({
    missionId: 'mission-a', actionKey: 'retain-patch', capability: 'validate-patch', argv: [],
    requestedPaths: ['src/**'], grantedPaths: ['src/**'], inputSnapshot: 'tree:abc',
    fencingEpoch: 1, expiresAt: '2099-01-01T00:00:00.000Z',
  });
  await assert.rejects(executor.executePatch(permit, patch), /durable-completion-failed/);
  assert.deepEqual(
    await readdir(join(quarantine, 'patch-receipts')),
    [`${createHash('sha256').update(patch).digest('hex')}.patch`],
  );
});

test('repository executor validates proposals before begin and reconciles completed actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-action-protocol-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-action-protocol-q-'));
  let begins = 0;
  let runs = 0;
  const authority = {
    begin: async () => {
      begins += 1;
      return { kind: 'completed' as const, receiptSha256: 'b'.repeat(64) };
    },
    complete: async () => 'b'.repeat(64),
    readReceipt: async () => Buffer.from(JSON.stringify({
      version: 1,
      kind: 'process-result',
      value: { stdout: 'cached', stderr: '', exitCode: 0, timedOut: false, termination: 'exited' },
    }), 'utf8'),
  };
  const executor = new MissionRepositoryExecutor({
    backend: 'macos-sandbox', workspaceRoot: root, quarantineRoot: quarantine,
    deniedReadPaths: [], sourceEnv: { PATH: '/usr/bin' }, allowedEnvKeys: ['PATH'],
    timeoutMs: 1_000, capabilityProof,
  }, {
    permitAuthority: authority,
    snapshotVerifier,
    runProcess: async () => {
      runs += 1;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, termination: 'exited' };
    },
  });
  const readPermit = executor.authorize({
    missionId: 'mission-a', actionKey: 'read-invalid', capability: 'read-file', argv: [],
    requestedPaths: ['src/value.ts'], grantedPaths: ['src/**'], inputSnapshot: 'tree:abc',
    fencingEpoch: 1, expiresAt: '2099-01-01T00:00:00.000Z',
    readPath: 'src/value.ts', maxReadBytes: 100,
  });
  await assert.rejects(executor.readText({
    ...readPermit, requestedPaths: ['docs/outside.ts'], readPath: 'docs/outside.ts',
  }), /outside granted scope/);
  assert.equal(begins, 0);
  await assert.rejects(executor.readText({
    ...readPermit, requestedPaths: ['src/id_rsa'], readPath: 'src/id_rsa',
  }), /secret path/);
  assert.equal(begins, 0);
  await assert.rejects(executor.readText({ ...readPermit, maxReadBytes: 0 }), /maxReadBytes/);
  assert.equal(begins, 0);
  const patchPermit = executor.authorize({
    missionId: 'mission-a', actionKey: 'patch-invalid', capability: 'validate-patch', argv: [],
    requestedPaths: ['src/**'], grantedPaths: ['src/**'], inputSnapshot: 'tree:abc',
    fencingEpoch: 1, expiresAt: '2099-01-01T00:00:00.000Z',
  });
  await assert.rejects(executor.executePatch(patchPermit, 'not a patch'), /rejected before execution/);
  assert.equal(begins, 0);
  const secretPatch = [
    'diff --git a/src/id_rsa b/src/id_rsa',
    'index 1111111..2222222 100644',
    '--- a/src/id_rsa',
    '+++ b/src/id_rsa',
    '@@ -1 +1 @@',
    '-secret',
    '+changed',
    '',
  ].join('\n');
  await assert.rejects(executor.executePatch(patchPermit, secretPatch), /denied-path/);
  assert.equal(begins, 0);

  const statusPermit = executor.authorize({
    missionId: 'mission-a', actionKey: 'status-completed', capability: 'git-status', argv: [],
    requestedPaths: ['**'], grantedPaths: ['**'], inputSnapshot: 'tree:abc',
    fencingEpoch: 1, expiresAt: '2099-01-01T00:00:00.000Z',
  });
  assert.equal((await executor.observeGitStatus(statusPermit)).stdout, 'cached');
  assert.equal(begins, 1);
  assert.equal(runs, 0);
});

test('repository executor refuses completion when the workspace moves during execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-snapshot-race-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-snapshot-race-q-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/value.ts'), 'safe', 'utf8');
  let verifications = 0;
  let completions = 0;
  const executor = new MissionRepositoryExecutor({
    backend: 'macos-sandbox', workspaceRoot: root, quarantineRoot: quarantine,
    deniedReadPaths: [], sourceEnv: { PATH: '/usr/bin' }, allowedEnvKeys: ['PATH'],
    timeoutMs: 1_000, capabilityProof,
  }, {
    snapshotVerifier: {
      verify: async () => {
        verifications += 1;
        if (verifications === 2) throw new Error('workspace moved during execution');
      },
    },
    permitAuthority: {
      begin: async () => ({ kind: 'execute' }),
      complete: async () => { completions += 1; return 'c'.repeat(64); },
      readReceipt: async () => Buffer.alloc(0),
    },
  });
  const permit = executor.authorize({
    missionId: 'mission-a', actionKey: 'read-race', capability: 'read-file', argv: [],
    requestedPaths: ['src/value.ts'], grantedPaths: ['src/**'], inputSnapshot: 'tree:abc',
    fencingEpoch: 1, expiresAt: '2099-01-01T00:00:00.000Z',
    readPath: 'src/value.ts', maxReadBytes: 100,
  });

  await assert.rejects(executor.readText(permit), /workspace moved/);
  assert.equal(completions, 0);
});
