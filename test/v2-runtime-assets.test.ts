import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  publishRuntimeAssetSnapshot,
  verifyRuntimeAssetSnapshot,
  type RuntimeAssetPublishStep,
} from '../src/v2/runtime-assets.js';

test('publishes exact private skill/schema bytes and records package, hashes, modes, owner, and paths', async () => {
  await withFixture(async ({ packageRoot, runtimeRoot }) => {
    const snapshot = await publishRuntimeAssetSnapshot({
      packageRoot,
      runtimeRoot,
      snapshotRelativePath: 'v2/repo/runs/run-1/attempts/attempt-1/snapshot',
      skill: 'agent-auto',
    });

    assert.equal(snapshot.packageVersion, '1.0.0');
    assert.equal(snapshot.skill, 'agent-auto');
    assert.equal(snapshot.reused, false);
    assert.equal(snapshot.ownerUid, process.getuid?.());
    assert.equal(snapshot.rootMode, 0o700);
    assert.deepEqual(snapshot.files.map((file) => [file.relativePath, file.mode]), [
      ['SKILL.md', 0o400],
      ['output-schema.json', 0o400],
    ]);
    assert.equal(snapshot.generatedSchemaSha256, snapshot.files[1]?.sha256);
    await verifyRuntimeAssetSnapshot(snapshot);
    assert.match(await readFile(snapshot.skillPath, 'utf8'), /PACKAGE AGENT A/u);
    assert.equal((await readFile(snapshot.schemaPath, 'utf8')).endsWith('\n'), true);
  });
});

test('fails closed when package bytes change during resolution and publishes no snapshot', async () => {
  await withFixture(async ({ packageRoot, runtimeRoot }) => {
    const snapshotRelativePath = 'v2/repo/runs/run-1/attempts/attempt-race/snapshot';
    await assert.rejects(publishRuntimeAssetSnapshot({
      packageRoot,
      runtimeRoot,
      snapshotRelativePath,
      skill: 'agent-auto',
      onStep: async (step) => {
        if (step === 'after-source-resolve') {
          await writeFile(join(packageRoot, 'internal-skills', 'agent-auto', 'SKILL.md'), 'PACKAGE AGENT B\n');
        }
      },
    }), /package assets changed during resolution/u);
    await assert.rejects(lstat(join(runtimeRoot, snapshotRelativePath)), /ENOENT/u);
  });
});

test('fails closed when acceptance-proof procedure bytes change during resolution', async () => {
  await withFixture(async ({ packageRoot, runtimeRoot }) => {
    await assert.rejects(publishRuntimeAssetSnapshot({
      packageRoot,
      runtimeRoot,
      snapshotRelativePath: 'v2/repo/runs/run-1/attempts/procedure-race/snapshot',
      skill: 'acceptance-proof',
      onStep: async (step) => {
        if (step === 'after-source-resolve') {
          await writeFile(join(packageRoot, 'internal-skills', 'acceptance-proof', 'references', 'browser.md'), 'BROWSER PROCEDURE B\n');
        }
      },
    }), /package assets changed during resolution/u);
  });
});

test('keeps version-A attempt bytes immutable while a new attempt snapshots version B', async () => {
  await withFixture(async ({ packageRoot, runtimeRoot }) => {
    const first = await publishRuntimeAssetSnapshot({
      packageRoot,
      runtimeRoot,
      snapshotRelativePath: 'v2/repo/runs/run-1/attempts/attempt-a/snapshot',
      skill: 'agent-auto',
    });
    const firstBytes = await readFile(first.skillPath);
    await writeFile(join(packageRoot, 'internal-skills', 'agent-auto', 'SKILL.md'), 'PACKAGE AGENT B\n');
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
    packageJson.version = '2.0.0';
    await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(packageJson)}\n`);

    const second = await publishRuntimeAssetSnapshot({
      packageRoot,
      runtimeRoot,
      snapshotRelativePath: 'v2/repo/runs/run-1/attempts/attempt-b/snapshot',
      skill: 'agent-auto',
    });

    assert.deepEqual(await readFile(first.skillPath), firstBytes);
    assert.match(await readFile(second.skillPath, 'utf8'), /PACKAGE AGENT B/u);
    assert.equal(second.packageVersion, '2.0.0');
    await verifyRuntimeAssetSnapshot(first);
    await verifyRuntimeAssetSnapshot(second);
  });
});

test('never publishes a partial tree when temp write or pre-rename fsync fails', async () => {
  for (const failureStep of ['after-first-file-sync', 'before-temp-directory-sync'] as RuntimeAssetPublishStep[]) {
    await withFixture(async ({ packageRoot, runtimeRoot }) => {
      const snapshotRelativePath = `v2/repo/runs/run-1/attempts/${failureStep}/snapshot`;
      await assert.rejects(publishRuntimeAssetSnapshot({
        packageRoot,
        runtimeRoot,
        snapshotRelativePath,
        skill: 'agent-auto',
        onStep: async (step) => {
          if (step === failureStep) throw new Error(`injected ${failureStep}`);
        },
      }), new RegExp(`injected ${failureStep}`, 'u'));
      const attemptRoot = dirname(join(runtimeRoot, snapshotRelativePath));
      await assert.rejects(lstat(join(runtimeRoot, snapshotRelativePath)), /ENOENT/u);
      assert.deepEqual((await readdir(attemptRoot)).filter((name) => name.includes('.snapshot.tmp-')), []);
    });
  }
});

test('reuses a fully verified destination after rename-before-return failure', async () => {
  await withFixture(async ({ packageRoot, runtimeRoot }) => {
    const input = {
      packageRoot,
      runtimeRoot,
      snapshotRelativePath: 'v2/repo/runs/run-1/attempts/after-rename/snapshot',
      skill: 'agent-auto' as const,
    };
    await assert.rejects(publishRuntimeAssetSnapshot({
      ...input,
      onStep: async (step) => {
        if (step === 'after-rename') throw new Error('injected after rename');
      },
    }), /injected after rename/u);

    const recovered = await publishRuntimeAssetSnapshot(input);
    assert.equal(recovered.reused, true);
    await verifyRuntimeAssetSnapshot(recovered);
  });
});

test('rejects partial, corrupt, extra-file, mode, owner-evidence, and symlink destinations', async () => {
  for (const corruption of ['partial', 'content', 'extra', 'mode', 'owner', 'file-symlink', 'root-symlink'] as const) {
    await withFixture(async ({ packageRoot, runtimeRoot }) => {
      const relative = `v2/repo/runs/run-1/attempts/corrupt-${corruption}/snapshot`;
      const snapshot = await publishRuntimeAssetSnapshot({ packageRoot, runtimeRoot, snapshotRelativePath: relative, skill: 'agent-auto' });
      if (corruption === 'partial') await rm(snapshot.schemaPath);
      if (corruption === 'content') {
        await chmod(snapshot.skillPath, 0o600);
        await writeFile(snapshot.skillPath, 'CORRUPT\n');
        await chmod(snapshot.skillPath, 0o400);
      }
      if (corruption === 'extra') {
        const extra = join(snapshot.snapshotRoot, 'extra.txt');
        await writeFile(extra, 'extra\n', { mode: 0o400 });
      }
      if (corruption === 'mode') await chmod(snapshot.skillPath, 0o600);
      if (corruption === 'owner') snapshot.ownerUid += 1;
      if (corruption === 'file-symlink') {
        await rm(snapshot.skillPath);
        await symlink('/dev/null', snapshot.skillPath);
      }
      if (corruption === 'root-symlink') {
        await rm(snapshot.snapshotRoot, { recursive: true });
        await symlink('/tmp', snapshot.snapshotRoot);
      }
      await assert.rejects(verifyRuntimeAssetSnapshot(snapshot));
      if (corruption === 'owner') {
        const reread = await publishRuntimeAssetSnapshot({ packageRoot, runtimeRoot, snapshotRelativePath: relative, skill: 'agent-auto' });
        assert.equal(reread.reused, true);
      } else {
        await assert.rejects(publishRuntimeAssetSnapshot({ packageRoot, runtimeRoot, snapshotRelativePath: relative, skill: 'agent-auto' }));
      }
    });
  }
});

test('rejects symlink substitution in package assets and managed runtime parents', async () => {
  await withFixture(async ({ packageRoot, runtimeRoot }) => {
    const source = join(packageRoot, 'internal-skills', 'agent-auto', 'SKILL.md');
    const target = join(packageRoot, 'agent-target.md');
    await writeFile(target, 'SYMLINK TARGET\n');
    await rm(source);
    await symlink(target, source);
    await assert.rejects(publishRuntimeAssetSnapshot({
      packageRoot,
      runtimeRoot,
      snapshotRelativePath: 'v2/repo/runs/run-1/attempts/source-link/snapshot',
      skill: 'agent-auto',
    }), /symbolic link/u);
  });

  await withFixture(async ({ packageRoot, runtimeRoot }) => {
    const outside = await mkdtemp(join(tmpdir(), 'runtime-assets-outside-'));
    try {
      await mkdir(join(runtimeRoot, 'v2'));
      await symlink(outside, join(runtimeRoot, 'v2', 'repo'));
      await assert.rejects(publishRuntimeAssetSnapshot({
        packageRoot,
        runtimeRoot,
        snapshotRelativePath: 'v2/repo/runs/run-1/attempts/parent-link/snapshot',
        skill: 'agent-auto',
      }), /symbolic link/u);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('serializes concurrent publishers and reuses the one exact committed snapshot', async () => {
  await withFixture(async ({ packageRoot, runtimeRoot }) => {
    const input = {
      packageRoot,
      runtimeRoot,
      snapshotRelativePath: 'v2/repo/runs/run-1/attempts/concurrent/snapshot',
      skill: 'acceptance-proof' as const,
    };
    const [left, right] = await Promise.all([
      publishRuntimeAssetSnapshot(input),
      publishRuntimeAssetSnapshot(input),
    ]);
    assert.equal([left.reused, right.reused].filter(Boolean).length, 1);
    assert.deepEqual(left.files, right.files);
    assert.deepEqual(left.files.map((file) => file.relativePath), ['SKILL.md', 'output-schema.json', 'references/browser.md']);
    assert.match(await readFile(join(left.snapshotRoot, 'references', 'browser.md'), 'utf8'), /BROWSER PROCEDURE/u);
    await verifyRuntimeAssetSnapshot(left);
  });
});

async function withFixture(
  run: (fixture: { packageRoot: string; runtimeRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-assets-'));
  try {
    const packageRoot = join(root, 'package');
    const runtimeRoot = join(root, 'runtime');
    await Promise.all([
      mkdir(join(packageRoot, 'internal-skills', 'agent-auto'), { recursive: true }),
      mkdir(join(packageRoot, 'internal-skills', 'acceptance-proof'), { recursive: true }),
      mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(join(packageRoot, 'package.json'), '{"name":"codex-orchestrator","version":"1.0.0"}\n');
    await writeFile(join(packageRoot, 'internal-skills', 'agent-auto', 'SKILL.md'), 'PACKAGE AGENT A\n');
    await writeFile(join(packageRoot, 'internal-skills', 'acceptance-proof', 'SKILL.md'), 'PACKAGE PROOF A\n');
    await mkdir(join(packageRoot, 'internal-skills', 'acceptance-proof', 'references'), { recursive: true });
    await writeFile(join(packageRoot, 'internal-skills', 'acceptance-proof', 'references', 'browser.md'), 'BROWSER PROCEDURE A\n');
    await run({ packageRoot, runtimeRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
