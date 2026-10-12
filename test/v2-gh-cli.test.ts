import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultGhExecutor, ghExecutorFromProcessExecutor, githubCollectionExecutor, githubRestCollection } from '../src/v2/adapters/gh-cli.js';

test('an interrupted paged read rejects instead of returning partial authority', async () => {
  const controller = new AbortController();
  let calls = 0;
  const executor = githubCollectionExecutor(async () => {
    calls += 1;
    if (calls === 1) return { stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i }))), stderr: '' };
    controller.abort();
    return new Promise(() => {});
  }, { signal: controller.signal });
  await assert.rejects(githubRestCollection(executor, 'repos/owner/repo/issues'), /deadline or cancellation/);
  assert.equal(calls, 2);
});

test('the collection deadline covers all pages rather than restarting per page', async () => {
  let calls = 0;
  const executor = githubCollectionExecutor(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i }))), stderr: '' };
  }, { timeoutMs: 35 });
  await assert.rejects(githubRestCollection(executor, 'repos/owner/repo/issues'), /deadline or cancellation/);
  assert.ok(calls >= 1 && calls <= 2, 'a delayed scheduler must not reset the collection deadline');
});

test('default GitHub transport bounds an owned command that never exits', async () => {
  const started = Date.now();
  await assert.rejects(defaultGhExecutor(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 40 }), /exit/);
  assert.ok(Date.now() - started < 4000);
});


test('owned GitHub cancellation waits for cleanup and preserves an unresolved ownership error', async () => {
  const controller = new AbortController();
  const unsafe = new Error('owned group termination could not be proven');
  let started!: () => void;
  const launched = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => { finish = resolve; });
  const executor = ghExecutorFromProcessExecutor(async (_file, _args, options) => {
    started();
    await new Promise<void>((resolve) => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    await cleanup;
    throw unsafe;
  });
  let settled = false;
  const result = githubRestCollection(githubCollectionExecutor(executor, { signal: controller.signal }), 'repos/owner/repo/issues');
  void result.then(() => { settled = true; }, () => { settled = true; });
  await launched;
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'owned cleanup must finish before returning cancellation');
  finish();
  await assert.rejects(result, (error: unknown) => error === unsafe);
});
