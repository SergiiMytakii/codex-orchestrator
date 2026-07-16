import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AppServerRunSession } from '../src/codex/app-server-process.js';
import { loadPackageSkillBundle } from '../src/skills/package-skill-bundle.js';
import type { CodexExecutionRunInputV2 } from '../src/codex/execution-adapter.js';

test('app-server run probes terminals before turn and cleans them before completion', async () => {
  const calls: string[] = [];
  let resolveCompleted!: (value: unknown) => void;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  const notificationListeners: Array<(notification: { method: string; params?: unknown }) => void> = [];
  const client = {
    notify(method: string) { calls.push(method); },
    waitForNotification(method: string) { calls.push(`wait:${method}`); return completed; },
    onNotification(listener: (notification: { method: string; params?: unknown }) => void) {
      notificationListeners.push(listener);
      return () => notificationListeners.splice(notificationListeners.indexOf(listener), 1);
    },
    onActivity() { return () => {}; },
    async request(method: string, params: any) {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          for (const listener of notificationListeners) listener({
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              item: { type: 'agentMessage', text: '{"version":1,"nodeId":"scoped-classification","outcome":"route-small","artifactRefs":["artifact://report"],"result":{"ok":true}}' },
            },
          });
          resolveCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
        });
        return { turn: { id: 'turn-1' } };
      }
      if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
      return {};
    },
  };
  const session = new AppServerRunSession(client as any);
  const input = await runInput();
  const result = await session.run(input);
  assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(await readFile(input.reportPath, 'utf8')), { ok: true });
  assert.ok(calls.indexOf('thread/backgroundTerminals/list') < calls.indexOf('turn/start'));
  assert.ok(calls.lastIndexOf('thread/backgroundTerminals/clean') < calls.lastIndexOf('thread/backgroundTerminals/list'));
});

test('app-server rejects cleanup failure before accepting the final report', async () => {
  let resolveCompleted!: (value: unknown) => void;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  const notificationListeners: Array<(notification: { method: string; params?: unknown }) => void> = [];
  const client = {
    notify() {},
    waitForNotification() { return completed; },
    onNotification(listener: (notification: { method: string; params?: unknown }) => void) { notificationListeners.push(listener); return () => {}; },
    onActivity() { return () => {}; },
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          for (const listener of notificationListeners) listener({
            method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: '{"version":1,"nodeId":"scoped-classification","outcome":"route-small","artifactRefs":[],"result":{}}' } },
          });
          resolveCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
        });
        return { turn: { id: 'turn-1' } };
      }
      if (method === 'thread/backgroundTerminals/clean') throw new Error('clean failed');
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      return {};
    },
  };
  const session = new AppServerRunSession(client as any, 50);
  const input = await runInput();
  await assert.rejects(session.run(input), /turn-cleanup-unconfirmed/);
  await assert.rejects(access(input.reportPath));
});

test('app-server blocks when the background-terminal capability is missing before turn start', async () => {
  const calls: string[] = [];
  const client = {
    notify() {}, waitForNotification() { return new Promise(() => {}); }, onNotification() { return () => {}; }, onActivity() { return () => {}; },
    async request(method: string) {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'thread/backgroundTerminals/list') return {};
      return {};
    },
  };

  await assert.rejects(new AppServerRunSession(client as any).run(await runInput()), /background-terminal-capability-missing/);
  assert.equal(calls.includes('turn/start'), false);
});

test('app-server rejects a non-empty post-clean terminal list before report acceptance', async () => {
  let listCalls = 0;
  let resolveCompleted!: (value: unknown) => void;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  const listeners: Array<(notification: { method: string; params?: unknown }) => void> = [];
  const client = {
    notify() {}, waitForNotification() { return completed; },
    onNotification(listener: (notification: { method: string; params?: unknown }) => void) { listeners.push(listener); return () => {}; },
    onActivity() { return () => {}; },
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          for (const listener of listeners) listener({
            method: 'item/completed',
            params: { threadId: 'thread-1', item: { type: 'agentMessage', text: '{"version":1,"nodeId":"scoped-classification","outcome":"route-small","artifactRefs":["artifact://report"],"result":{"ok":true}}' } },
          });
          resolveCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
        });
        return { turn: { id: 'turn-1' } };
      }
      if (method === 'thread/backgroundTerminals/list') {
        listCalls += 1;
        return { data: listCalls === 1 ? [] : [{ id: 'still-running' }] };
      }
      return {};
    },
  };
  const input = await runInput();

  await assert.rejects(new AppServerRunSession(client as any).run(input), /turn-cleanup-unconfirmed/);
  await assert.rejects(access(input.reportPath));
});

test('app-server close interrupts and cleans active turns before returning', async () => {
  const notificationWaiters: Array<{ predicate: (params: any) => boolean; resolve: (params: any) => void }> = [];
  const calls: string[] = [];
  const client = {
    notify() {},
    waitForNotification(_method: string, predicate: (params: any) => boolean) {
      return new Promise((resolve) => notificationWaiters.push({ predicate, resolve }));
    },
    onNotification() { return () => {}; },
    onActivity() { return () => {}; },
    async request(method: string) {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'turn/interrupt') {
        queueMicrotask(() => {
          const params = { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } };
          for (const waiter of notificationWaiters.splice(0)) if (waiter.predicate(params)) waiter.resolve(params);
        });
        return {};
      }
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      return {};
    },
  };
  const session = new AppServerRunSession(client as any, 100);
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const running = session.run(await runInput(), undefined, { onTurnStarted: async () => { resolveStarted(); } });
  await started;
  await session.close();
  const result = await running;
  assert.equal(result.status, 'interrupted');
  assert.ok(calls.indexOf('turn/interrupt') < calls.indexOf('thread/backgroundTerminals/clean'));
});

test('app-server honors a signal aborted before turn startup and awaits interruption cleanup', async () => {
  const notificationWaiters: Array<{ predicate: (params: any) => boolean; resolve: (params: any) => void }> = [];
  const calls: string[] = [];
  const client = {
    notify() {},
    waitForNotification(_method: string, predicate: (params: any) => boolean) {
      return new Promise((resolve) => notificationWaiters.push({ predicate, resolve }));
    },
    onNotification() { return () => {}; },
    onActivity() { return () => {}; },
    async request(method: string) {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'turn/interrupt') {
        queueMicrotask(() => {
          const params = { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } };
          for (const waiter of notificationWaiters.splice(0)) if (waiter.predicate(params)) waiter.resolve(params);
        });
        return {};
      }
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      return {};
    },
  };
  const controller = new AbortController();
  controller.abort();

  const result = await new AppServerRunSession(client as any, 100).run(await runInput(), controller.signal);

  assert.equal(result.status, 'interrupted');
  assert.ok(calls.includes('turn/interrupt'));
  assert.ok(calls.indexOf('turn/interrupt') < calls.lastIndexOf('thread/backgroundTerminals/list'));
});

test('app-server does not report interrupted when cancellation cleanup fails', async () => {
  const client = {
    notify() {}, waitForNotification() { return new Promise(() => {}); }, onNotification() { return () => {}; }, onActivity() { return () => {}; },
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'turn/interrupt') throw new Error('interrupt-cleanup-failed');
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      return {};
    },
  };
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(new AppServerRunSession(client as any, 100).run(await runInput(), controller.signal), /interrupt-cleanup-failed/);
});

async function runInput(): Promise<CodexExecutionRunInputV2> {
  const { manifest } = await loadPackageSkillBundle();
  const root = await mkdtemp(join(tmpdir(), 'app-server-run-'));
  const contextArtifactPath = join(root, 'context.json');
  await writeFile(contextArtifactPath, '{}');
  const node = manifest.graphs['implementation-attempt']!.nodes.find((item) => item.id === 'scoped-classification')!;
  return {
    targetRoot: root, worktreePath: root, config: {} as any, runId: 'run-1', issueNumber: 1, sessionId: 'session-1', branchName: 'branch', phase: 'scoped-issue',
    operationId: 'implementation-attempt', nodeId: node.id, attemptId: 'attempt-1',
    skillRuntime: { packageVersion: manifest.package.version, bundleHash: manifest.bundleHash, bundleRoot: resolve('runtime-skills'), operationId: 'implementation-attempt', entrySkillPath: 'operations/scoped-classification/SKILL.md' },
    manifestNode: node, targetPolicy: { network: 'deny', networkHosts: [], writableRootClasses: ['target-state'], mcpServers: {} },
    contextArtifactPath, reportPath: join(root, 'report.json'), logPath: join(root, 'run.log'), phaseEnv: {},
  };
}
