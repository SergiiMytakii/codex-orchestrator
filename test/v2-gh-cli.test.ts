import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandProcessQuiescenceError } from '../src/v2/adapters/command.js';
import { defaultGhExecutor, ghExecutorFromProcessExecutor, githubExecutor, githubCollectionExecutor, githubRestCollection } from '../src/v2/adapters/gh-cli.js';

test('GitHub issue reads recover from a temporary server failure', async () => {
  let calls = 0;
  const executor = githubExecutor(async () => {
    if (++calls === 1) throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 503: Service Unavailable' });
    return { stdout: 'issue', stderr: '' };
  });
  assert.equal((await executor('gh', ['issue', 'view', '42'])).stdout, 'issue');
  assert.equal(calls, 2);
});

test('GitHub reads stop after three temporary failures and retain the original error', async () => {
  let calls = 0;
  const failure = Object.assign(new Error('gh failed'), { stderr: 'HTTP 429: Too Many Requests' });
  const executor = githubExecutor(async () => { calls += 1; throw failure; });
  await assert.rejects(executor('gh', ['api', '--method', 'GET', 'repos/owner/repo/issues']), error => error === failure);
  assert.equal(calls, 3);
});

test('GitHub GraphQL mutations are not retried as reads', async () => {
  let calls = 0;
  const executor = githubExecutor(async () => {
    calls += 1;
    throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 503: Service Unavailable' });
  });
  await assert.rejects(executor('gh', ['api', 'graphql', '-f', 'query=mutation { updateIssue { issue { id } } }']));
  assert.equal(calls, 1);
});

test('explicit default-method REST GETs used by Setup participate in bounded retries', async () => {
  let calls = 0;
  const executor = githubExecutor(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 503: Service Unavailable' });
    return { stdout: '[]', stderr: '' };
  });
  const result = await executor('gh', ['api', '--method', 'GET', '--paginate', '--slurp', 'repos/owner/repo/labels?per_page=100']);
  assert.equal(result.stdout, '[]');
  assert.equal(calls, 2);
});

test('GitHub reads never retry unresolved process ownership even with a network diagnostic', async () => {
  let calls = 0;
  const failure = new CommandProcessQuiescenceError('ECONNRESET; owned group termination could not be proven', 123, 123, true);
  const executor = githubExecutor(ghExecutorFromProcessExecutor(async () => { calls += 1; throw failure; }));
  await assert.rejects(executor('gh', ['issue', 'view', '42']), error => error === failure);
  assert.equal(calls, 1);
});

test('explicit GitHub rate limits retry even when returned as HTTP 403', async () => {
  let calls = 0;
  const executor = githubExecutor(async () => {
    if (++calls === 1) throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 403: API rate limit exceeded' });
    return { stdout: '[]', stderr: '' };
  });
  await executor('gh', ['api', '--method', 'GET', 'repos/owner/repo/issues']);
  assert.equal(calls, 2);
});

test('GitHub writes and permanent read errors are never retried', async () => {
  for (const [args, detail] of [
    [['issue', 'edit', '42'], 'HTTP 503: Service Unavailable'],
    [['api', '--method', 'POST', 'repos/owner/repo/issues'], 'HTTP 503: Service Unavailable'],
    [['issue', 'view', '42'], 'HTTP 401: Bad credentials'],
    [['issue', 'view', '42'], 'HTTP 403: Resource not accessible'],
    [['issue', 'view', '42'], 'HTTP 404: Not Found'],
    [['issue', 'view', '42'], 'invalid JSON payload'],
    [['issue', 'view', '42'], 'owned group termination could not be proven'],
  ] as const) {
    let calls = 0;
    const failure = Object.assign(new Error('gh failed'), { stderr: detail });
    const executor = githubExecutor(async () => { calls += 1; throw failure; });
    await assert.rejects(executor('gh', [...args]), error => error === failure);
    assert.equal(calls, 1, detail);
  }
});

test('cancelling GitHub retry backoff prevents another command', async () => {
  const controller = new AbortController();
  let calls = 0;
  const failure = new Error('ECONNRESET');
  const executor = githubExecutor(async () => {
    calls += 1;
    setImmediate(() => controller.abort());
    throw failure;
  }, { signal: controller.signal });
  await assert.rejects(executor('gh', ['issue', 'view', '42']), error => error === failure);
  assert.equal(calls, 1);
});

test('GitHub retry delays share the command deadline', async () => {
  let calls = 0;
  const failure = new Error('ETIMEDOUT');
  const executor = githubExecutor(async () => { calls += 1; throw failure; }, { timeoutMs: 20 });
  await assert.rejects(executor('gh', ['issue', 'view', '42']), error => error === failure);
  assert.equal(calls, 1);
});

test('paged GitHub reads retry a failed page without duplicating previous pages', async () => {
  let calls = 0;
  const executor = githubCollectionExecutor(githubExecutor(async (_file, args) => {
    calls += 1;
    const page = args.find(arg => arg.startsWith('page='));
    if (page === 'page=1') return { stdout: JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id }))), stderr: '' };
    if (calls === 2) throw new Error('ECONNRESET');
    return { stdout: '[{"id":100}]', stderr: '' };
  }));
  const items = await githubRestCollection(executor, 'repos/owner/repo/issues');
  assert.equal(items.length, 101);
  assert.deepEqual(items[100], { id: 100 });
  assert.equal(calls, 3);
});

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
