import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { sha256 } from '../src/v2/containment.js';
import { managedLabelUpdate, observeAttemptReadViewCleanup, resolveCodexExecutable } from '../src/v2/runtime.js';
import { mkdtemp } from './mission-test-temp.js';

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

test('runtime cleanup removes only the exact canonical attempt read-view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-runtime-cleanup-'));
  const canonicalRepository = 'owner/repo';
  const identity = { runId: 'run-1', attemptId: 'attempt-1' };
  const attemptRoot = join(root, 'v2', sha256(canonicalRepository), 'runs', identity.runId, 'attempts', identity.attemptId);
  const readView = join(attemptRoot, 'read-view');
  await mkdir(readView, { recursive: true });
  await writeFile(join(readView, 'owned.txt'), 'owned\n');

  assert.equal(await observeAttemptReadViewCleanup({
    orchestratorHome: root,
    canonicalRepository,
    identity: { ...identity, resultPath: join(attemptRoot, 'report.json') },
  }), 'confirmed');
  await assert.rejects(realpath(readView));
});

test('runtime cleanup rejects forged and symlink-redirected attempt roots without deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-runtime-cleanup-forged-'));
  const canonicalRepository = 'owner/repo';
  const runtimeRoot = join(root, 'v2', sha256(canonicalRepository));
  const victimRoot = join(root, 'victim');
  const victimReadView = join(victimRoot, 'read-view');
  await mkdir(victimReadView, { recursive: true });
  await writeFile(join(victimReadView, 'keep.txt'), 'keep\n');

  assert.equal(await observeAttemptReadViewCleanup({
    orchestratorHome: root,
    canonicalRepository,
    identity: { runId: 'run-1', attemptId: 'attempt-1', resultPath: join(victimRoot, 'report.json') },
  }), 'pending');
  assert.equal(await readFile(join(victimReadView, 'keep.txt'), 'utf8'), 'keep\n');

  const linkedAttemptRoot = join(runtimeRoot, 'runs', 'run-1', 'attempts', 'attempt-1');
  await mkdir(dirname(linkedAttemptRoot), { recursive: true });
  await symlink(victimRoot, linkedAttemptRoot);
  assert.equal(await observeAttemptReadViewCleanup({
    orchestratorHome: root,
    canonicalRepository,
    identity: { runId: 'run-1', attemptId: 'attempt-1', resultPath: join(linkedAttemptRoot, 'report.json') },
  }), 'pending');
  assert.equal(await readFile(join(victimReadView, 'keep.txt'), 'utf8'), 'keep\n');
});

test('production issue composition mutates only lifecycle-managed labels', () => {
  const policy = {
    auto: { name: 'agent:auto', color: '000000', description: 'auto' },
    running: { name: 'agent:running', color: '000000', description: 'running' },
    blocked: { name: 'agent:blocked', color: '000000', description: 'blocked' },
    review: { name: 'agent:review', color: '000000', description: 'review' },
  };
  assert.deepEqual(
    managedLabelUpdate(['agent:auto', 'manual:keep'], ['agent:auto', 'agent:running'], policy),
    { addLabels: ['agent:running'], removeLabels: [] },
  );
  assert.deepEqual(
    managedLabelUpdate(['agent:auto', 'agent:running', 'manual:keep'], ['agent:review'], policy),
    { addLabels: ['agent:review'], removeLabels: ['agent:auto', 'agent:running'] },
  );
  assert.deepEqual(
    managedLabelUpdate(['manual:keep'], ['manual:keep', 'agent:blocked'], policy, true),
    { addLabels: [], removeLabels: [] },
  );
});
