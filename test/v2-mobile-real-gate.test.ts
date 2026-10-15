import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

for (const platform of ['android', 'ios'] as const) {
  test(`${platform} real gate rejects evidence older than --started-at and accepts fresh offline evidence`, { timeout: 70_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-gate-freshness-'));
    try {
      // No SDK or device access: iOS cleanup sees only this isolated fake inventory.
      const xcrun = join(root, 'fake-xcrun');
      await writeFile(xcrun, '#!/bin/sh\nprintf \'{"devices":{}}\\n\'\n');
      await chmod(xcrun, 0o700);
      for (const stale of [true, false]) {
        const worktree = join(root, stale ? 'stale' : 'fresh');
        const leaseRoot = join(worktree, 'leases');
        const proofId = `proof-${platform}`;
        const proofRoot = `proofs/${proofId}`;
        await mkdir(join(worktree, proofRoot), { recursive: true });
        await mkdir(leaseRoot);
        const startedAt = new Date(Date.now() - 60_000);
        const lease = {
          schema: `codex-orchestrator.${platform}-lease`, version: 1, status: 'active', proofId,
          token: 'offline-token', ownerPid: process.pid, appPid: 4242,
          acquiredAt: startedAt.toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
          updatedAt: startedAt.toISOString(),
          ...(platform === 'android' ? { serial: 'emulator-5580', appId: 'dev.codex.proof' } : {
            udid: '11111111-2222-4333-8444-555555555555', deviceName: 'Offline proof', bundleId: 'dev.codex.proof',
            runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
            deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', runnerCreated: true,
          }),
        };
        const paths = { screenshot: `${proofRoot}/final.png`, hierarchy: `${proofRoot}/final.xml`, log: `${proofRoot}/device.log`, lease: `${proofRoot}/lease.json` };
        const artifacts = [
          [paths.screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')],
          [paths.hierarchy, Buffer.from('<hierarchy><node text="proof ready" /></hierarchy>')],
          [paths.log, Buffer.from('fixture ready\n')],
          [paths.lease, Buffer.from(JSON.stringify(lease))],
        ] as const;
        await writeFile(join(leaseRoot, `${platform}.json`), JSON.stringify(lease));
        for (const [relativePath, bytes] of artifacts) {
          const path = join(worktree, relativePath);
          await writeFile(path, bytes);
          // Both timestamps are later than the old hard-coded July start.
          const modifiedAt = new Date(startedAt.getTime() + (stale ? -30_000 : 30_000));
          await utimes(path, modifiedAt, modifiedAt);
        }
        const args = [
          new URL(`./v2-${platform}-real-gate.js`, import.meta.url).pathname,
          '--root', worktree, '--proof-root', 'proofs', '--proof-id', proofId,
          '--started-at', startedAt.toISOString(), '--width', '100', '--height', '100', '--lease-root', leaseRoot,
          ...Object.entries(paths).flatMap(([name, path]) => [`--${name}`, path]),
          ...(platform === 'ios' ? ['--xcrun', xcrun] : []),
        ];
        let stdout: string;
        let exitCode = 0;
        try { stdout = (await execute(process.execPath, args, { timeout: 30_000, killSignal: 'SIGKILL' })).stdout; }
        catch (error) { const failure = error as { code: number; stdout: string }; exitCode = failure.code; stdout = failure.stdout; }
        const result = JSON.parse(stdout);
        assert.equal(exitCode, stale ? 1 : 0);
        assert.equal(result.status, stale ? (platform === 'android' ? 'cleanup-pending' : 'internal-error') : 'passed');
        if (stale && platform === 'android') assert.equal(result.outcome.status, 'internal-error');
        if (stale) assert.match(JSON.stringify(result), /visual artifact is stale/u);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
