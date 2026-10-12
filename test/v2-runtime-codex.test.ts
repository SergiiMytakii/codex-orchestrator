import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { CommandProcessQuiescenceError } from '../src/v2/adapters/command.js';
import { sha256 } from '../src/v2/containment.js';
import { executeOwnedCommand, readRuntimeIssue, managedLabelUpdate, observeAttemptReadViewCleanup, resolveCodexExecutable, materializeRunnerFacts, hasTechnicalLegacyProofFailure } from '../src/v2/runtime.js';
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


test('Runner review files retain exact large facts and reject altered hashes and path escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-review-facts-'));
  const bytes = Buffer.from(JSON.stringify({ patch: '+'.repeat(2 * 1024 * 1024) }));
  const fact = { path: 'review-facts/attempt-1.json', bytes, sha256: sha256(bytes) };
  await materializeRunnerFacts(root, [fact]);
  assert.deepEqual(await readFile(join(root, fact.path)), bytes);
  await assert.rejects(materializeRunnerFacts(root, [fact]), /EEXIST/u);
  await assert.rejects(materializeRunnerFacts(root, [{ ...fact, path: 'review-facts/attempt-2.json', sha256: '0'.repeat(64) }]), /binding/u);
  await assert.rejects(materializeRunnerFacts(root, [{ ...fact, path: '../escape.json' }]), /binding/u);
});


test('legacy proof recovery admits only bound host evidence proving a technical failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-proof-diagnostic-'));
  const record = {
    runId: '00000000-0000-4000-8000-000000000001', packageVersion: '2.0.1',
    terminalOutcome: { status: 'internal-error', code: 'acceptance-proof-internal-failure' },
    candidateBinding: { candidateCommitSha: 'a'.repeat(40) },
    workflowGeneration: { generationHash: 'b'.repeat(64), manifestSha256: 'c'.repeat(64) },
  } as Parameters<typeof hasTechnicalLegacyProofFailure>[0]['record'];
  const config = { runner: { stateDir: '.codex-orchestrator/state' } } as Parameters<typeof hasTechnicalLegacyProofFailure>[0]['config'];
  const directory = join(root, config.runner.stateDir, 'v2/evidence');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${record.runId}.json`);
  const diagnostic = { summary: 'Proof agent failed: EIO: i/o error, read', packageVersion: record.packageVersion,
    workflowGenerationHash: record.workflowGeneration.generationHash, workflowManifestSha256: record.workflowGeneration.manifestSha256,
    candidateCommitSha: record.candidateBinding!.candidateCommitSha };
  const evidence = { version: 1, runId: record.runId, code: 'acceptance-proof-diagnostic', summary: JSON.stringify(diagnostic) };
  const admitted = () => hasTechnicalLegacyProofFailure({ targetRoot: root, config, record });
  assert.equal(await admitted(), false);
  await writeFile(path, JSON.stringify(evidence));
  assert.equal(await admitted(), true);
  for (const summary of ['Proof agent failed internally.', 'Proof artifacts are invalid: EIO', 'Proof agent failed: [redacted]', 'Checked change became stale.']) {
    await writeFile(path, JSON.stringify({ ...evidence, summary: JSON.stringify({ ...diagnostic, summary }) }));
    assert.equal(await admitted(), false);
  }
  for (const mismatch of [{ packageVersion: 'other' }, { candidateCommitSha: 'f'.repeat(40) }, { workflowGenerationHash: 'e'.repeat(64) }, { workflowManifestSha256: 'd'.repeat(64) }]) {
    await writeFile(path, JSON.stringify({ ...evidence, summary: JSON.stringify({ ...diagnostic, ...mismatch }) }));
    assert.equal(await admitted(), false);
  }
  await writeFile(path, JSON.stringify({ ...evidence, summary: 'null' }));
  assert.equal(await admitted(), false);
});


test('runtime reads complete comments on closed issues to observe already published effects', async () => {
  let commentReads = 0;
  const comment = {
    id: 'comment-1', url: 'https://github.com/owner/repo/issues/1#comment-1',
    body: '<!-- durable effect -->\nExact answer',
    author: { login: 'runner', id: 'runner-1' }, authorAssociation: 'OWNER',
    createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
  };
  const snapshot = await readRuntimeIssue({
    getIssue: async () => ({ number: 1, title: 'Issue', body: 'Body', url: 'https://github.com/owner/repo/issues/1',
      state: 'CLOSED', labels: [], comments: [], closedByPullRequestsReferences: [] }),
    listAllComments: async () => { commentReads += 1; return [comment]; },
  }, 1);
  assert.equal(snapshot?.state, 'CLOSED');
  assert.equal(commentReads, 1);
  assert.equal(snapshot?.comments[0]?.body, comment.body);
  assert.equal(snapshot?.comments[0]?.id, comment.id);
});


test('runtime fences command ownership before launch and retains unconfirmed cleanup', async () => {
  const events: string[] = [];
  const owner = {
    beginCommand: async () => { events.push('begin'); },
    completeCommand: async () => { events.push('complete'); },
    fenceCommand: async (identity: { pid: number }) => { events.push(`fence:${identity.pid}`); },
    release: async () => {},
  };
  const unsafe = new CommandProcessQuiescenceError('group remains', 123, 123, false);
  await assert.rejects(executeOwnedCommand({ owner, file: 'git', args: [], executor: async () => {
    events.push('invoke'); throw unsafe;
  } }), (error) => error === unsafe);
  assert.deepEqual(events, ['begin', 'invoke', 'fence:123']);
  events.length = 0;
  await executeOwnedCommand({ owner, file: 'git', args: [], executor: async () => {
    events.push('invoke'); return { exitCode: 124, stdout: '', stderr: 'timeout after confirmed cleanup' };
  } });
  assert.deepEqual(events, ['begin', 'invoke', 'complete']);
  events.length = 0;
  await assert.rejects(executeOwnedCommand({ owner: { ...owner, beginCommand: async () => { throw new Error('receipt unavailable'); } },
    file: 'git', args: [], executor: async () => { events.push('invoke'); return { exitCode: 0, stdout: '', stderr: '' }; },
  }), /receipt unavailable/);
  assert.deepEqual(events, []);
});
