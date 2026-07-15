import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { mkdtemp } from './mission-test-temp.js';
import { validConfig } from './fixtures/config.js';
import { runDaemonCommand } from '../src/runner/daemon-command.js';
import { runPlanAutoCommand } from '../src/runner/plan-auto-command.js';
import { runScopedAutoCommand } from '../src/runner/scoped-auto-command.js';
import { recoverScopedRun } from '../src/runner/scoped-recovery.js';
import { runSetupCommand } from '../src/setup/setup-command.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { acquireMissionCoordinatorLock } from '../src/runner/mission-coordinator-lock.js';
import {
  acquireTargetActivityFence,
  readCurrentBootNonce,
  readTargetActivityFenceGeneration,
} from '../src/runner/target-activity-fence.js';

const stateDir = '.codex-orchestrator/state';

test('target activity fence allows shared owners and excludes preparation', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'target-activity-shared-'));
  const daemon = await acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'shared', purpose: 'daemon', hostId: 'host-a', bootNonce: 'boot-a', pid: 101,
    isProcessAlive: () => true,
  });
  const claim = await acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'shared', purpose: 'claim', hostId: 'host-a', bootNonce: 'boot-a', pid: 102,
    isProcessAlive: () => true,
  });

  await assert.rejects(acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'exclusive', purpose: 'preparation', hostId: 'host-a', bootNonce: 'boot-a', pid: 103,
    isProcessAlive: () => true,
  }), /shared activity is owned/);

  assert.equal(daemon.generation, 1);
  assert.equal(claim.generation, 2);
  await daemon.release();
  await claim.release();

  const preparation = await acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'exclusive', purpose: 'preparation', hostId: 'host-a', bootNonce: 'boot-a', pid: 103,
    isProcessAlive: () => true,
  });
  assert.equal(preparation.generation, 3);
  assert.equal(await readTargetActivityFenceGeneration(targetRoot, stateDir), 3);
  await assert.rejects(acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'shared', purpose: 'claim', hostId: 'host-a', bootNonce: 'boot-a', pid: 104,
    isProcessAlive: () => true,
  }), /exclusive activity is owned/);
  await preparation.release();
});

test('target activity fence reclaims only dead same-host owners', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'target-activity-stale-'));
  const canonicalTargetRoot = await realpath(targetRoot);
  const holders = join(targetRoot, stateDir, 'target-activity-fence', 'shared');
  await mkdir(holders, { recursive: true });
  await writeFile(join(holders, 'stale.json'), `${JSON.stringify({
    version: 1, token: 'stale', mode: 'shared', purpose: 'daemon', canonicalTargetRoot,
    hostId: 'host-a', bootNonce: 'new-boot', pid: 90, acquiredAt: '2026-07-15T10:00:00.000Z',
  })}\n`, 'utf8');

  const reclaimed = await acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'exclusive', purpose: 'preparation', hostId: 'host-a', bootNonce: 'new-boot', pid: 101,
    isProcessAlive: () => false,
  });
  await reclaimed.release();

  await writeFile(join(holders, 'foreign.json'), `${JSON.stringify({
    version: 1, token: 'foreign', mode: 'shared', purpose: 'daemon', canonicalTargetRoot,
    hostId: 'host-b', bootNonce: 'boot-b', pid: 91, acquiredAt: '2026-07-15T10:00:00.000Z',
  })}\n`, 'utf8');
  await assert.rejects(acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'exclusive', purpose: 'preparation', hostId: 'host-a', bootNonce: 'new-boot', pid: 101,
    isProcessAlive: () => false,
  }), /different host/);
});

test('target activity fence uses boot nonce to treat a reused PID as stale', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'target-activity-pid-reuse-'));
  const canonicalTargetRoot = await realpath(targetRoot);
  const holders = join(targetRoot, stateDir, 'target-activity-fence', 'shared');
  await mkdir(holders, { recursive: true });
  await writeFile(join(holders, 'reused.json'), `${JSON.stringify({
    version: 1, token: 'reused', mode: 'shared', purpose: 'daemon', canonicalTargetRoot,
    hostId: 'host-a', bootNonce: 'old-boot', pid: 101, acquiredAt: '2026-07-15T10:00:00.000Z',
  })}\n`, 'utf8');

  const lease = await acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'exclusive', purpose: 'preparation', hostId: 'host-a', bootNonce: 'new-boot', pid: 101,
    isProcessAlive: () => true,
  });
  await lease.release();
});

test('target activity fence treats a different live PID from a prior boot as stale', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'target-activity-prior-boot-'));
  const canonicalTargetRoot = await realpath(targetRoot);
  const holders = join(targetRoot, stateDir, 'target-activity-fence', 'shared');
  await mkdir(holders, { recursive: true });
  await writeFile(join(holders, 'prior-boot.json'), `${JSON.stringify({
    version: 1, token: 'prior-boot', mode: 'shared', purpose: 'daemon', canonicalTargetRoot,
    hostId: 'host-a', bootNonce: 'old-boot', pid: 90, acquiredAt: '2026-07-15T10:00:00.000Z',
  })}\n`, 'utf8');

  const lease = await acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'exclusive', purpose: 'preparation', hostId: 'host-a', bootNonce: 'new-boot', pid: 101,
    isProcessAlive: () => true,
  });
  await lease.release();
});

test('target activity guard treats a different live PID from a prior boot as stale', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'target-activity-prior-boot-guard-'));
  const guardDirectory = join(targetRoot, stateDir, 'target-activity-fence.guard.lock');
  await mkdir(guardDirectory, { recursive: true });
  await writeFile(join(guardDirectory, 'owner.json'), `${JSON.stringify({
    version: 1,
    token: 'prior-boot-guard',
    hostId: 'host-a',
    bootNonce: 'old-boot',
    pid: 90,
    acquiredAt: '2026-07-15T10:00:00.000Z',
  })}\n`, 'utf8');

  const lease = await acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'shared', purpose: 'claim', hostId: 'host-a', bootNonce: 'new-boot', pid: 101,
    isProcessAlive: () => true,
  });
  await lease.release();
});

test('target activity release is token-fenced', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'target-activity-token-'));
  const lease = await acquireTargetActivityFence({
    targetRoot, stateDir, mode: 'shared', purpose: 'claim', hostId: 'host-a', bootNonce: 'boot-a', pid: 101,
    isProcessAlive: () => true,
  });
  const metadata = JSON.parse(await readFile(lease.metadataPath, 'utf8')) as Record<string, unknown>;
  await writeFile(lease.metadataPath, `${JSON.stringify({ ...metadata, token: 'replacement' })}\n`, 'utf8');
  await lease.release();
  assert.equal((JSON.parse(await readFile(lease.metadataPath, 'utf8')) as Record<string, unknown>).token, 'replacement');
});

test('runtime entrypoints and setup honor the target activity fence before mutation', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'target-activity-entrypoints-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator/config.json'),
    `${JSON.stringify(validConfig, null, 2)}\n`,
    'utf8',
  );
  const exclusive = await acquireTargetActivityFence({
    targetRoot,
    stateDir: validConfig.runner.stateDir,
    mode: 'exclusive',
    purpose: 'preparation',
  });
  await assert.rejects(runDaemonCommand({ targetRoot, once: true }), /exclusive activity is owned/);
  await assert.rejects(runScopedAutoCommand({ targetRoot, issueNumber: 1 }), /exclusive activity is owned/);
  await assert.rejects(runPlanAutoCommand({ targetRoot, issueNumber: 1 }), /exclusive activity is owned/);
  let recoveryReadIssue = false;
  const recoveryAdapter = new InMemoryGitHubIssueAdapter();
  recoveryAdapter.getIssue = async () => {
    recoveryReadIssue = true;
    return undefined;
  };
  await assert.rejects(recoverScopedRun({
    targetRoot,
    issueNumber: 1,
    invocation: 'targeted',
    issueAdapter: recoveryAdapter,
  }), /exclusive activity is owned/);
  assert.equal(recoveryReadIssue, false);
  await exclusive.release();

  const shared = await acquireTargetActivityFence({
    targetRoot,
    stateDir: validConfig.runner.stateDir,
    mode: 'shared',
    purpose: 'daemon',
  });
  await assert.rejects(runSetupCommand({ targetRoot }), /shared activity is owned/);
  await shared.release();
});

test('targeted recovery rejects a config snapshot changed while waiting for the fence guard', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'target-activity-config-race-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  const configPath = join(targetRoot, '.codex-orchestrator/config.json');
  await writeFile(configPath, `${JSON.stringify(validConfig, null, 2)}\n`, 'utf8');
  const bootNonce = await readCurrentBootNonce();
  const guard = await acquireMissionCoordinatorLock({
    targetRoot,
    stateDir: validConfig.runner.stateDir,
    hostId: hostname(),
    bootNonce,
    pid: process.pid,
    waitTimeoutMs: 5_000,
    lockName: 'target-activity-fence.guard.lock',
    description: 'Target activity fence guard',
    bootNonceSemantics: 'system-boot',
  });
  let recoveryReadIssue = false;
  const recoveryAdapter = new InMemoryGitHubIssueAdapter();
  recoveryAdapter.getIssue = async () => {
    recoveryReadIssue = true;
    return undefined;
  };
  const recovery = assert.rejects(recoverScopedRun({
    targetRoot,
    issueNumber: 1,
    invocation: 'targeted',
    issueAdapter: recoveryAdapter,
  }), /target-activity-fence-config-changed/);

  await delay(50);
  await writeFile(configPath, `${JSON.stringify({
    ...validConfig,
    runner: { ...validConfig.runner, stateDir: '.codex-orchestrator/state-v2' },
  }, null, 2)}\n`, 'utf8');
  await guard.release();
  await recovery;
  assert.equal(recoveryReadIssue, false);
});
