import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAuthLoginCommand } from '../src/codex/auth-command.js';
import type { PackageRuntimeHome } from '../src/codex/package-runtime-home.js';

const runtimeHome: PackageRuntimeHome = {
  root: '/package-home',
  sqliteHome: '/package-home/sqlite/auth',
  env: { PATH: '/bin', HOME: '/package-home', CODEX_HOME: '/package-home', CODEX_SQLITE_HOME: '/package-home/sqlite/auth' },
  authMode: 'persisted',
};

test('auth login uses package home and returns when an account already exists', async () => {
  const events: string[] = [];
  const result = await runAuthLoginCommand({
    dependencies: {
      prepareRuntimeHome: async () => { events.push('home'); return runtimeHome; },
      versionChecker: async (command, version) => { events.push(`version:${command}:${version}`); },
      ownerFactory: async (input) => {
        events.push(`owner:${input.requireAccount}`);
        return {
          client: {
            request: async (method: string) => {
              events.push(method);
              return { account: { type: 'chatgpt' } };
            },
            waitForNotification: async () => { throw new Error('unexpected wait'); },
          },
          close: async () => { events.push('close'); },
        };
      },
      supervisorPath: '/package/app-server-supervisor.js',
    },
  });

  assert.equal(result.status, 'already-authenticated');
  assert.deepEqual(events, ['home', 'version:codex:0.144.4', 'owner:false', 'account/read', 'close']);
});

test('auth login starts ChatGPT browser login and waits for its correlated completion', async () => {
  const events: string[] = [];
  let shownUrl = '';
  const result = await runAuthLoginCommand({
    onAuthUrl: (url) => { shownUrl = url; },
    dependencies: {
      prepareRuntimeHome: async () => runtimeHome,
      versionChecker: async () => {},
      ownerFactory: async () => ({
        client: {
          request: async (method: string, params?: unknown) => {
            events.push(`${method}:${JSON.stringify(params)}`);
            if (method === 'account/read') return { account: null };
            return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://example.test/login' };
          },
          waitForNotification: async (method: string, predicate: (params: unknown) => boolean) => {
            events.push(`wait:${method}`);
            const completion = { loginId: 'login-1', success: true };
            assert.equal(predicate(completion), true);
            return completion;
          },
        },
        close: async () => { events.push('close'); },
      }),
      supervisorPath: '/package/app-server-supervisor.js',
    },
  });

  assert.equal(result.status, 'authenticated');
  assert.equal(shownUrl, 'https://example.test/login');
  assert.deepEqual(events, [
    'account/read:{"refreshToken":false}',
    'account/login/start:{"type":"chatgpt"}',
    'wait:account/login/completed',
    'close',
  ]);
});

test('auth login closes the package process when completion fails', async () => {
  let closed = false;
  await assert.rejects(runAuthLoginCommand({
    dependencies: {
      prepareRuntimeHome: async () => runtimeHome,
      versionChecker: async () => {},
      ownerFactory: async () => ({
        client: {
          request: async (method: string) => method === 'account/read'
            ? { account: null }
            : { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://example.test/login' },
          waitForNotification: async () => ({ loginId: 'login-1', success: false, error: 'denied' }),
        },
        close: async () => { closed = true; },
      }),
      supervisorPath: '/package/app-server-supervisor.js',
    },
  }), /orchestrator-auth-login-failed:denied/);
  assert.equal(closed, true);
});
