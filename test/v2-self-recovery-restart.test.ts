import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { defaultProcessExecutor } from '../src/v2/adapters/command.js';
import { recoveryStore } from './self-recovery-runner.js';
import { mkdtemp } from './mission-test-temp.js';
import type { RunIssueResult } from '../src/v2/run-issue.js';

async function git(root: string, args: string[]) {
  const result = await defaultProcessExecutor('git', ['-C', root, ...args], { timeoutMs: 10_000, processGroup: true });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'v2-real-restart-')));
  await git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'base\n');
  await git(root, ['add', 'README.md']);
  await git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base']);
  const remote = join(root, 'remote.git');
  await git(root, ['init', '--bare', remote]);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '-u', 'origin', 'main']);
  await writeFile(join(root, 'github.json'), JSON.stringify({ labels: ['agent:auto'], comments: [] }));
  await writeFile(join(root, 'events.jsonl'), '');
  return root;
}

function worker(root: string, checkpoint?: string): { child: ChildProcess; reached: Promise<void>; result: Promise<RunIssueResult>; exited: Promise<void> } {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'self-recovery-runner.js');
  const child = spawn(process.execPath, [path, '--worker', root, checkpoint ?? ''], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  return observeWorker(child);
}

function observeWorker(child: ChildProcess): { child: ChildProcess; reached: Promise<void>; result: Promise<RunIssueResult>; exited: Promise<void> } {
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  let reach!: () => void;
  let rejectReach!: (error: Error) => void;
  let finish!: (result: RunIssueResult) => void;
  let rejectResult!: (error: Error) => void;
  const reached = new Promise<void>((resolve, reject) => { reach = resolve; rejectReach = reject; });
  const result = new Promise<RunIssueResult>((resolve, reject) => { finish = resolve; rejectResult = reject; });
  // A crashed worker intentionally has no result; keep its rejection observed.
  void result.catch(() => {});
  void reached.catch(() => {});
  let receivedResult = false;
  let receivedCheckpoint = false;
  child.on('message', (message: any) => {
    if (message.checkpoint) { receivedCheckpoint = true; reach(); }
    if (message.result) { receivedResult = true; finish(message.result); }
  });
  // Process exit can precede buffered IPC/stderr delivery; close confirms those channels drained.
  const exited = new Promise<void>((resolve) => child.once('close', (code, signal) => {
    const error = new Error(`worker exited ${code}/${signal}: ${stderr}`);
    if (!receivedCheckpoint) rejectReach(error);
    if (!receivedResult) rejectResult(error);
    resolve();
  }));
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
  child.once('exit', () => clearTimeout(timeout));
  return { child, reached, result, exited };
}

test('worker observation accepts a buffered IPC result delivered after process exit', async () => {
  const child = new ChildProcess();
  child.stderr = new PassThrough();
  const observed = observeWorker(child);
  let settled = false;
  void observed.result.then(() => { settled = true; }, () => { settled = true; });
  child.emit('exit', 0, null);
  await Promise.resolve();
  try {
    assert.equal(settled, false, 'process exit does not prove its IPC channel has drained');
    child.emit('message', { result: { status: 'not-eligible' } });
    child.emit('close', 0, null);
    assert.deepEqual(await observed.result, { status: 'not-eligible' });
    await observed.exited;
  } finally {
    child.emit('close', 0, null);
    child.stderr.destroy();
  }
});

test('worker observation rejects missing IPC only after close and retains raw stderr', async () => {
  const child = new ChildProcess();
  child.stderr = new PassThrough();
  const observed = observeWorker(child);
  let settled = false;
  void observed.result.then(() => { settled = true; }, () => { settled = true; });
  child.emit('exit', 0, null);
  await Promise.resolve();
  try {
    assert.equal(settled, false);
    child.stderr.emit('data', Buffer.from('worker diagnostic after process exit'));
    child.emit('close', 0, null);
    await assert.rejects(observed.result, /worker exited 0\/null: worker diagnostic after process exit/u);
    await assert.rejects(observed.reached, /worker exited 0\/null: worker diagnostic after process exit/u);
    await observed.exited;
  } finally {
    child.emit('close', 0, null);
    child.stderr.destroy();
  }
});

for (const checkpoint of ['implementation', 'checks', 'proof', 'review', 'publication', 'effect:claim-labels', 'effect:claim-comment', 'effect:commit', 'effect:push', 'effect:pr']) {
  test(`a real killed Runner resumes ${checkpoint} with durable identity and no duplicate successful work`, { timeout: 30_000 }, async () => {
    const root = await fixture();
    let first: ReturnType<typeof worker> | undefined;
    let second: ReturnType<typeof worker> | undefined;
    try {
      first = worker(root, checkpoint);
      await first.reached;
      const before = (await recoveryStore(root).read()).runs[0]!;
      first.child.kill('SIGKILL');
      await first.exited;
      second = worker(root);
      const result = await second.result;
      await second.exited;
      assert.equal(result.status, 'review-ready', JSON.stringify(result) + (result.status === 'transport-failed' ? await readFile(result.evidencePath, 'utf8') : ''));
      const after = (await recoveryStore(root).read()).runs[0]!;
      assert.equal(after.runId, before.runId);
      const events: string[] = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      for (const event of ['implementation', 'worker-check:first', 'worker-check:second', 'proof', 'review', 'claim-labels', 'claim-comment', 'commit', 'push', 'pr']) {
        assert.equal(events.filter((value) => value === event).length, 1, `${event}: ${events.join(',')}`);
      }
      const head = await git(after.worktreePath, ['rev-parse', 'HEAD']);
      const tree = await git(after.worktreePath, ['rev-parse', 'HEAD^{tree}']);
      const proof = JSON.parse(events.find((event) => event.startsWith('proof-target:'))!.slice('proof-target:'.length));
      assert.equal(tree, proof.binding.candidateTreeSha);
      assert.ok(after.implementationResult?.review?.reviewers.length === 2);
      if (before.candidateBinding) assert.deepEqual(proof.binding, before.candidateBinding);
      assert.equal(await git(root, ['rev-parse', `refs/remotes/origin/${after.branchName}`]), head);
      assert.equal(after.terminalOutcome!.status, 'review-ready');
      assert.equal(after.checks.length, 2);
      for (const check of after.checks) { assert.ok('candidateTreeSha' in check); if ('candidateTreeSha' in check) assert.equal(check.candidateTreeSha, tree); }
      assert.ok(after.proofReceipt);
      assert.ok(after.implementationResult?.review);
      assert.equal(after.codexSession?.id, '01000000-0000-4000-8000-000000000001');
      const remote = JSON.parse(await readFile(join(root, 'github.json'), 'utf8'));
      assert.equal(remote.comments.filter((comment: { body: string }) => comment.body.includes(`:run:${after.runId}:claim -->`)).length, 1);
    } finally {
      first?.child.kill('SIGKILL'); second?.child.kill('SIGKILL');
      if (first) await first.exited;
      if (second) await second.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const checkpoint of ['effect:terminal-comment', 'effect:terminal-labels']) {
  test(`a real killed Runner observes ${checkpoint} without redelivering or reopening its blocked outcome`, { timeout: 30_000 }, async () => {
    const root = await fixture();
    await writeFile(join(root, 'scenario.json'), JSON.stringify({ mode: 'blocked' }));
    let first: ReturnType<typeof worker> | undefined;
    let second: ReturnType<typeof worker> | undefined;
    try {
      first = worker(root, checkpoint);
      await first.reached;
      const before = (await recoveryStore(root).read()).runs[0]!;
      assert.equal(before.terminalOutcome?.status, 'blocked');
      assert.equal(before.pendingEffect?.kind, checkpoint === 'effect:terminal-comment' ? 'terminal-comment' : 'terminal-labels');
      first.child.kill('SIGKILL');
      await first.exited;
      second = worker(root);
      assert.equal((await second.result).status, 'blocked');
      await second.exited;
      const after = (await recoveryStore(root).read()).runs[0]!;
      assert.equal(after.runId, before.runId);
      assert.deepEqual(after.terminalOutcome, before.terminalOutcome);
      assert.equal(after.pendingEffect, undefined);
      assert.equal(after.terminalNotifications!.comment.status, 'delivered');
      assert.equal(after.terminalNotifications!.labels.status, 'delivered');
      const events: string[] = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      for (const event of ['implementation', 'worker-check:first', 'worker-check:second', 'terminal-comment', 'terminal-labels']) assert.equal(events.filter((value) => value === event).length, 1, events.join(','));
      assert.equal(events.some((event) => ['review', 'commit', 'push', 'pr'].includes(event)), false);
      const remote = JSON.parse(await readFile(join(root, 'github.json'), 'utf8'));
      assert.equal(remote.comments.filter((comment: { body: string }) => comment.body.split('\n')[0]!.endsWith(':blocked -->')).length, 1);
    } finally {
      first?.child.kill('SIGKILL'); second?.child.kill('SIGKILL');
      if (first) await first.exited; if (second) await second.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { checkpoint: 'before:answer-comment', revoke: false, close: false },
  { checkpoint: 'effect:answer-comment', revoke: false, close: false },
  { checkpoint: 'before:answer-comment', revoke: true, close: false },
  { checkpoint: 'effect:answer-comment', revoke: true, close: false },
  { checkpoint: 'before:answer-comment', revoke: false, close: true },
  { checkpoint: 'effect:answer-comment', revoke: false, close: true },
]) {
  test(`a real killed Runner resumes ${scenario.checkpoint} with revoked auto=${scenario.revoke}, closed=${scenario.close} and one durable answer`, { timeout: 30_000 }, async () => {
    const root = await fixture();
    let initial: ReturnType<typeof worker> | undefined;
    let first: ReturnType<typeof worker> | undefined;
    let second: ReturnType<typeof worker> | undefined;
    try {
      initial = worker(root);
      assert.equal((await initial.result).status, 'review-ready');
      await initial.exited;
      const original = (await recoveryStore(root).read()).runs[0]!;
      const remotePath = join(root, 'github.json');
      const remote = JSON.parse(await readFile(remotePath, 'utf8'));
      remote.comments.push({ id: '90071992547409939999', body: 'Why does this preserve the existing behavior?', authorAssociation: 'OWNER' });
      await writeFile(remotePath, JSON.stringify(remote));
      await writeFile(join(root, 'scenario.json'), JSON.stringify({ mode: 'answer' }));
      first = worker(root, scenario.checkpoint);
      await first.reached;
      const before = (await recoveryStore(root).read()).runs[0]!;
      assert.equal(before.runId, original.runId);
      assert.equal(before.pendingEffect?.kind, 'issue-feedback-comment');
      const marker = before.pendingEffect?.kind === 'issue-feedback-comment' ? before.pendingEffect.marker : '';
      first.child.kill('SIGKILL');
      await first.exited;
      if (scenario.revoke || scenario.close) {
        const observed = JSON.parse(await readFile(remotePath, 'utf8'));
        if (scenario.revoke) observed.labels = observed.labels.filter((label: string) => label !== 'agent:auto');
        if (scenario.close) observed.state = 'CLOSED';
        await writeFile(remotePath, JSON.stringify(observed));
      }
      second = worker(root);
      assert.equal((await second.result).status, 'review-ready');
      await second.exited;
      const after = (await recoveryStore(root).read()).runs[0]!;
      assert.equal(after.runId, original.runId);
      assert.deepEqual(after.terminalOutcome, original.terminalOutcome);
      assert.equal(await git(after.worktreePath, ['rev-parse', 'HEAD']), original.reviewFeedback!.previousPublishedHeadSha);
      assert.equal(after.reviewFeedback!.consumedSourceIds.filter((id) => id === 'issue-comment:90071992547409939999').length, 1);
      const events: string[] = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      for (const event of ['implementation', 'worker-check:first', 'worker-check:second', 'proof', 'review', 'commit', 'push', 'pr', 'answer-agent']) assert.equal(events.filter((value) => value === event).length, 1, `${event}: ${events.join(',')}`);
      const finalRemote = JSON.parse(await readFile(remotePath, 'utf8'));
      const expectedComments = (scenario.revoke || scenario.close) && scenario.checkpoint === 'before:answer-comment' ? 0 : 1;
      assert.equal(finalRemote.comments.filter((comment: { body: string }) => comment.body.split('\n')[0] === marker).length, expectedComments);
      assert.equal(events.filter((event) => event === 'answer-comment').length, expectedComments);
      const receipt = after.reviewFeedback!.history.at(-1)!;
      assert.equal(receipt.kind, 'responded');
      if (receipt.kind === 'responded') assert.equal(receipt.publication, expectedComments ? 'delivered' : 'suppressed');
    } finally {
      initial?.child.kill('SIGKILL'); first?.child.kill('SIGKILL'); second?.child.kill('SIGKILL');
      if (initial) await initial.exited; if (first) await first.exited; if (second) await second.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const checkpoint of ['owner:result-observed', 'owner:correction-persisted']) {
  test(`a real killed Runner resumes ${checkpoint} by correcting owner proof in the same native session`, { timeout: 30_000 }, async () => {
    const root = await fixture();
    await writeFile(join(root, 'scenario.json'), JSON.stringify({ mode: 'malformed-proof' }));
    const workers: Array<ReturnType<typeof worker>> = [];
    try {
      const first = worker(root, checkpoint); workers.push(first); await first.reached;
      const before = (await recoveryStore(root).read()).runs[0]!;
      assert.ok(before.codexSession);
      assert.equal(before.candidateMaterialization, undefined);
      first.child.kill('SIGKILL'); await first.exited;
      let final: RunIssueResult | undefined;
      for (let count = 0; count < 3; count += 1) {
        const resumed = worker(root); workers.push(resumed); final = await resumed.result; await resumed.exited;
        if (final.status === 'review-ready') break;
        assert.equal(final.status, 'transport-failed');
      }
      assert.equal(final?.status, 'review-ready');
      const after = (await recoveryStore(root).read()).runs[0]!;
      assert.equal(after.runId, before.runId);
      assert.deepEqual(after.codexSession, before.codexSession);
      assert.equal(after.implementationReportCorrection, undefined);
      const events: string[] = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      for (const event of ['implementation', 'owner-malformed-report', 'owner-correction', 'commit', 'push', 'pr']) assert.equal(events.filter(value => value === event).length, 1, events.join(','));
      assert.equal(after.implementationResult?.proof?.status, 'passed');
      assert.equal(after.implementationResult?.review?.reviewers.length, 2);
    } finally {
      for (const current of workers) current.child.kill('SIGKILL');
      await Promise.all(workers.map(current => current.exited));
      await rm(root, { recursive: true, force: true });
    }
  });
}
