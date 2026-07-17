import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { publishRuntimeAssetSnapshot, verifyRuntimeAssetSnapshot } from '../src/v2/runtime-assets.js';
import { materializeWorkflowGeneration, parseWorkflowExecutionProfile } from '../src/v2/workflow-assets.js';

const packageRoot = join(import.meta.dirname, '..', '..');

test('operation snapshot copies one pinned generation closure and concurrent publishers reuse it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assets-generation-'));
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: join(root, 'orchestrator'),
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  });
  const input = {
    workflowGeneration,
    runtimeRoot: join(root, 'runtime'),
    snapshotRelativePath: 'runs/run-a/attempts/attempt-a/snapshot',
    operation: 'acceptance-proof',
    bootId: 'boot-a',
  };
  const snapshots = await Promise.all(Array.from({ length: 16 }, async () => publishRuntimeAssetSnapshot(input)));
  const [left, right] = snapshots;
  assert.ok(left && right);
  assert.equal(left.snapshotRoot, right.snapshotRoot);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.snapshotRoot)).size, 1);
  assert.equal(left.generationHash, workflowGeneration.generationHash);
  assert.equal(left.operation, 'acceptance-proof');
  assert.equal(left.policy.runnerPostcondition, 'proof-only');
  assert.match(left.operationPath, /operations\/acceptance-proof\/SKILL\.md$/u);
  assert.match(left.schemaPath, /schemas\/proof-report-v1\.json$/u);
  assert.ok(left.files.some((file) => file.path.endsWith('tools/android-lease.mjs')));
  const profile = parseWorkflowExecutionProfile(await readFile(left.profilePath, 'utf8'), left.policy);
  assert.equal(profile.name, 'proof_agent');
  assert.equal(profile.model, 'gpt-5.6-sol');
  assert.equal(profile.reasoningEffort, 'high');
  await verifyRuntimeAssetSnapshot(left);
});

test('operation snapshot fails closed on tamper, path escape, and undeclared operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assets-negative-'));
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: join(root, 'orchestrator'),
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  });
  const common = { workflowGeneration, runtimeRoot: join(root, 'runtime'), bootId: 'boot-a' };
  await assert.rejects(publishRuntimeAssetSnapshot({
    ...common, snapshotRelativePath: '../snapshot', operation: 'implementation',
  }), /snapshotRelativePath|invalid/iu);
  await assert.rejects(publishRuntimeAssetSnapshot({
    ...common, snapshotRelativePath: 'runs/a/attempts/a/snapshot', operation: 'unknown',
  }), /unavailable/iu);
  const snapshot = await publishRuntimeAssetSnapshot({
    ...common, snapshotRelativePath: 'runs/b/attempts/b/snapshot', operation: 'implementation',
  });
  const entry = snapshot.operationPath;
  await chmod(entry, 0o600);
  await writeFile(entry, '# tampered\n');
  await chmod(entry, 0o400);
  await assert.rejects(verifyRuntimeAssetSnapshot(snapshot), /hash|evidence|drift/iu);
});

test('operation snapshot rejects a runtime root below a symlinked ancestor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assets-ancestor-symlink-'));
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: join(root, 'orchestrator'),
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'linked-parent'), 'dir');
  await assert.rejects(publishRuntimeAssetSnapshot({
    workflowGeneration,
    runtimeRoot: join(root, 'linked-parent', 'runtime'),
    snapshotRelativePath: 'runs/run-a/attempts/attempt-a/snapshot',
    operation: 'implementation',
    bootId: 'boot-a',
  }), /root is unsafe/iu);
  await assert.rejects(lstat(join(outside, 'runtime')), { code: 'ENOENT' });
});

test('operation snapshot converges after publisher process death at every ready boundary', { timeout: 180_000 }, async () => {
  const modulePath = join(packageRoot, 'dist', 'src', 'v2', 'runtime-assets.js');
  for (const step of [
    'before-claim-link', 'after-claim-link', 'after-content-mkdir', 'after-first-content-file',
    'before-content-parent-sync', 'after-content-parent-sync', 'before-ready-link',
    'after-ready-link', 'after-ready-parent-sync',
  ]) {
    const root = await mkdtemp(join(tmpdir(), `runtime-assets-kill-${step}-`));
    const workflowGeneration = await materializeWorkflowGeneration({
      packageRoot, runtimeRoot: join(root, 'orchestrator'), packageVersion: '2.0.1', bootId: 'parent',
    });
    const input = {
      workflowGeneration,
      runtimeRoot: join(root, 'runtime'),
      snapshotRelativePath: 'runs/run-a/attempts/attempt-a/snapshot',
      operation: 'implementation',
      bootId: 'killed-child',
    };
    const script = `
      import { publishRuntimeAssetSnapshot } from ${JSON.stringify(new URL(`file://${modulePath}`).href)};
      await publishRuntimeAssetSnapshot({ ...${JSON.stringify(input)},
        onStep(value) { if (value === ${JSON.stringify(step)}) process.kill(process.pid, 'SIGKILL'); }
      });
    `;
    const killed = await spawnResult(process.execPath, ['--input-type=module', '--eval', script]);
    assert.equal(killed.signal, 'SIGKILL', step);
    const snapshot = await publishRuntimeAssetSnapshot({ ...input, bootId: 'recovery-parent' });
    await verifyRuntimeAssetSnapshot(snapshot);
  }
});

async function spawnResult(file: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(file, args, { stdio: 'ignore' });
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}
