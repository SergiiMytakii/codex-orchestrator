import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MissionSafeExecutor,
  MissionSafeExecutorRegistry,
  type MissionSafeExecutorDescriptor,
} from '../src/runner/mission-safe-executor.js';
import { mkdtemp } from './mission-test-temp.js';

const descriptors: MissionSafeExecutorDescriptor[] = [{
  id: 'frontend-targeted-eslint',
  kind: 'configured-check',
  executable: '/usr/bin/npx',
  args: ['eslint', 'context/AuthContext.tsx', 'lib/errorUtils.ts'],
  readPaths: [
    'src/frontend/context/AuthContext.tsx',
    'src/frontend/lib/errorUtils.ts',
  ],
  writePaths: [],
  network: 'deny',
  idempotency: 'repeat-safe',
}, {
  id: 'repair-completion-report',
  kind: 'completion-report-repair',
  executable: '/usr/bin/node',
  args: ['runner-owned-report-repair.mjs'],
  readPaths: ['.codex-orchestrator/state/reports/issue-227.json'],
  writePaths: ['issue-227.json'],
  network: 'deny',
  idempotency: 'reconcile',
}];

test('safe executor authorization pins exact registered argv, scope, and action identity', () => {
  const registry = new MissionSafeExecutorRegistry(descriptors);
  const permit = registry.authorize({
    missionId: 'mission-227',
    actionKey: 'action-targeted-eslint',
    executorId: 'frontend-targeted-eslint',
    grantedPaths: ['src/frontend/**'],
    inputSnapshot: 'tree:abc',
    fencingEpoch: 7,
    expiresAt: '2026-07-14T18:00:00.000Z',
  });

  assert.deepEqual({
    executorId: permit.executorId,
    executable: permit.executable,
    args: permit.args,
    readPaths: permit.readPaths,
    writePaths: permit.writePaths,
    network: permit.network,
    idempotency: permit.idempotency,
  }, {
    executorId: 'frontend-targeted-eslint',
    executable: '/usr/bin/npx',
    args: ['eslint', 'context/AuthContext.tsx', 'lib/errorUtils.ts'],
    readPaths: [
      'src/frontend/context/AuthContext.tsx',
      'src/frontend/lib/errorUtils.ts',
    ],
    writePaths: [],
    network: 'deny',
    idempotency: 'repeat-safe',
  });
  assert.match(permit.descriptorFingerprint, /^sha256:[a-f0-9]{64}$/u);
});

test('safe executor rejects shells, command substitution, network, and scope widening', () => {
  assert.throws(() => new MissionSafeExecutorRegistry([{
    ...descriptors[0]!,
    executable: '/bin/sh',
    args: ['-c', 'npm test'],
  }]), /shell executables/);
  assert.throws(() => new MissionSafeExecutorRegistry([{
    ...descriptors[0]!,
    args: ['eslint', '$(curl attacker)'],
  }]), /shell-control syntax/);
  assert.throws(() => new MissionSafeExecutorRegistry([{
    ...descriptors[0]!,
    network: 'allow' as 'deny',
  }]), /network must be denied/);
  assert.throws(() => new MissionSafeExecutorRegistry([{
    ...descriptors[0]!,
    readPaths: ['.env.production'],
  }]), /denied repository path/);
  assert.throws(() => new MissionSafeExecutorRegistry([{
    ...descriptors[0]!,
    writePaths: ['.git/hooks/**'],
  }]), /denied repository path/);

  const registry = new MissionSafeExecutorRegistry(descriptors);
  assert.throws(() => registry.authorize({
    missionId: 'mission-227',
    actionKey: 'action-report',
    executorId: 'repair-completion-report',
    grantedPaths: ['src/**'],
    inputSnapshot: 'tree:abc',
    fencingEpoch: 7,
    expiresAt: '2026-07-14T18:00:00.000Z',
  }), /outside granted scope/);
});

test('safe executor classifies legacy shell checks as an external migration boundary', () => {
  const registry = new MissionSafeExecutorRegistry(descriptors);

  assert.deepEqual(registry.classify('npm --prefix src/frontend run lint'), {
    kind: 'external-input-required',
    reason: 'legacy-shell-executor-unavailable-in-mission-mode',
    migration: 'register an exact argv Mission safe executor',
  });
  assert.equal(registry.classify({ executorId: 'frontend-targeted-eslint' }).kind, 'safe-executor');
});

test('safe executor registry covers report, evidence, proof, and configured-check repair families', () => {
  const registry = new MissionSafeExecutorRegistry([
    ...descriptors,
    { ...descriptors[1]!, id: 'repair-review-evidence', kind: 'review-evidence-repair' },
    { ...descriptors[1]!, id: 'repair-acceptance-proof', kind: 'acceptance-proof-repair' },
  ]);

  assert.deepEqual(registry.kinds(), [
    'acceptance-proof-repair',
    'completion-report-repair',
    'configured-check',
    'review-evidence-repair',
  ]);
});

test('safe executor runs registered argv only inside the proven sandbox and returns a pinned receipt', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-safe-executor-workspace-'));
  const quarantineRoot = await mkdtemp(join(tmpdir(), 'mission-safe-executor-quarantine-'));
  const registry = new MissionSafeExecutorRegistry(descriptors);
  const permit = registry.authorize({
    missionId: 'mission-227',
    actionKey: 'action-targeted-eslint',
    executorId: 'frontend-targeted-eslint',
    grantedPaths: ['src/frontend/**'],
    inputSnapshot: 'tree:abc',
    fencingEpoch: 7,
    expiresAt: '2099-07-14T18:00:00.000Z',
  });
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  const executor = new MissionSafeExecutor(registry, {
    backend: 'macos-sandbox',
    workspaceRoot,
    quarantineRoot,
    deniedReadPaths: [],
    sourceEnv: { PATH: '/usr/bin', SECRET_CANARY: 'must-not-pass' },
    allowedEnvKeys: ['PATH', 'SECRET_CANARY'],
    timeoutMs: 30_000,
    capabilityProof: capabilityProof(),
  }, {
    runProcess: async (input) => {
      calls.push({ file: input.file, args: input.args, cwd: input.cwd });
      return {
        stdout: 'targeted lint passed\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        termination: 'exited',
      };
    },
  });

  const result = await executor.execute(permit);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, '/usr/bin/sandbox-exec');
  assert.deepEqual(calls[0]?.args.slice(-4), [
    '/usr/bin/npx', 'eslint', 'context/AuthContext.tsx', 'lib/errorUtils.ts',
  ]);
  assert.equal(calls[0]?.cwd, workspaceRoot);
  assert.deepEqual(result.receipt, {
    version: 1,
    missionId: 'mission-227',
    actionKey: 'action-targeted-eslint',
    executorId: 'frontend-targeted-eslint',
    descriptorFingerprint: permit.descriptorFingerprint,
    exitCode: 0,
    termination: 'exited',
    stdoutSha256: 'sha256:ccba81eba455efc4f64337203601d5e046467a6e269edc86a0f6788af16f878f',
    stderrSha256: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    outputs: [],
  });
});

test('safe executor audits quarantine outputs against the exact declared write scope', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-safe-executor-audit-workspace-'));
  const quarantineRoot = await mkdtemp(join(tmpdir(), 'mission-safe-executor-audit-quarantine-'));
  const registry = new MissionSafeExecutorRegistry(descriptors);
  const permit = registry.authorize({
    missionId: 'mission-227',
    actionKey: 'action-targeted-eslint',
    executorId: 'frontend-targeted-eslint',
    grantedPaths: ['src/frontend/**'],
    inputSnapshot: 'tree:abc',
    fencingEpoch: 7,
    expiresAt: '2099-07-14T18:00:00.000Z',
  });
  const executor = new MissionSafeExecutor(registry, {
    backend: 'macos-sandbox',
    workspaceRoot,
    quarantineRoot,
    deniedReadPaths: [],
    sourceEnv: {},
    allowedEnvKeys: [],
    timeoutMs: 30_000,
    capabilityProof: capabilityProof(),
  }, {
    runProcess: async () => {
      await writeFile(join(quarantineRoot, 'undeclared.txt'), 'unexpected', 'utf8');
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, termination: 'exited' };
    },
  });

  await assert.rejects(executor.execute(permit), /undeclared quarantine output/);
});

test('safe executor rejects a tampered or expired permit before process execution', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-safe-executor-tamper-workspace-'));
  const quarantineRoot = await mkdtemp(join(tmpdir(), 'mission-safe-executor-tamper-quarantine-'));
  const registry = new MissionSafeExecutorRegistry(descriptors);
  const permit = registry.authorize({
    missionId: 'mission-227',
    actionKey: 'action-targeted-eslint',
    executorId: 'frontend-targeted-eslint',
    grantedPaths: ['src/frontend/**'],
    inputSnapshot: 'tree:abc',
    fencingEpoch: 7,
    expiresAt: '2026-07-14T17:00:00.000Z',
  });
  let calls = 0;
  const executor = new MissionSafeExecutor(registry, {
    backend: 'macos-sandbox',
    workspaceRoot,
    quarantineRoot,
    deniedReadPaths: [],
    sourceEnv: {},
    allowedEnvKeys: [],
    timeoutMs: 30_000,
    capabilityProof: capabilityProof(),
  }, {
    now: () => new Date('2026-07-14T17:30:00.000Z'),
    runProcess: async () => {
      calls += 1;
      throw new Error('must not run');
    },
  });

  await assert.rejects(executor.execute({
    ...permit,
    args: ['eslint', '--fix', '.'],
  }), /permit descriptor was modified|expired/);
  assert.equal(calls, 0);
});

function capabilityProof() {
  return {
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
}
