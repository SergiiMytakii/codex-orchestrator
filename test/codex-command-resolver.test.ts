import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveCodexCommand, resolveExecutableCommand } from '../src/setup/codex-command-resolver.js';

test('codex command resolver finds codex on Unix PATH without shelling out', async () => {
  const result = await resolveCodexCommand({
    platform: 'linux',
    env: {
      PATH: '/usr/local/bin:/opt/codex/bin',
    },
    canExecute: async (path) => path === '/opt/codex/bin/codex',
  });

  assert.equal(result, '/opt/codex/bin/codex');
});

test('codex command resolver finds codex on Windows PATH using PATHEXT', async () => {
  const result = await resolveCodexCommand({
    platform: 'win32',
    env: {
      PATH: 'C:\\Program Files\\Codex;D:\\Tools',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    canExecute: async (path) => path === 'C:\\Program Files\\Codex\\codex.exe',
  });

  assert.equal(result, 'C:\\Program Files\\Codex\\codex.exe');
});

test('codex command resolver checks macOS app fallback after PATH', async () => {
  const result = await resolveCodexCommand({
    platform: 'darwin',
    env: {
      PATH: '/usr/local/bin',
    },
    canExecute: async (path) => path === '/Applications/Codex.app/Contents/Resources/codex',
  });

  assert.equal(result, '/Applications/Codex.app/Contents/Resources/codex');
});

test('codex command resolver returns undefined when codex is unavailable', async () => {
  const result = await resolveCodexCommand({
    platform: 'linux',
    env: {
      PATH: '/usr/local/bin',
    },
    canExecute: async () => false,
  });

  assert.equal(result, undefined);
});

test('executable command resolver checks absolute commands directly', async () => {
  const result = await resolveExecutableCommand('/opt/codex/bin/codex', {
    platform: 'linux',
    env: {
      PATH: '/usr/local/bin',
    },
    canExecute: async (path) => path === '/opt/codex/bin/codex',
  });

  assert.equal(result, '/opt/codex/bin/codex');
});

test('executable command resolver finds generic Windows commands using PATHEXT', async () => {
  const result = await resolveExecutableCommand('git', {
    platform: 'win32',
    env: {
      Path: 'C:\\Git\\cmd',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    canExecute: async (path) => path === 'C:\\Git\\cmd\\git.exe',
  });

  assert.equal(result, 'C:\\Git\\cmd\\git.exe');
});
