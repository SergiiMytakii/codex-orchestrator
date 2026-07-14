import assert from 'node:assert/strict';
import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';

import { MissionRepositoryObserver } from '../src/runner/mission-repository-observer.js';

test('repository observer reads regular in-scope files and rejects symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-observer-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/value.ts'), 'safe', 'utf8');
  await writeFile(join(root, '.ENV'), 'credential-canary', 'utf8');
  await symlink('/etc/hosts', join(root, 'src/escape'));
  const secret = join(root, 'outside-secret');
  await writeFile(secret, 'credential-canary', 'utf8');
  await link(secret, join(root, 'src/hardlink'));
  const observer = new MissionRepositoryObserver(root, ['src/**'], ['.env*']);

  assert.equal(await observer.readText('src/value.ts', 100), 'safe');
  await assert.rejects(observer.readText('src/escape', 100), /symbolic link/);
  await assert.rejects(observer.readText('src/hardlink', 100), /hard-linked file/);
  await assert.rejects(observer.readText('../outside', 100), /repository-relative/);
  const broadObserver = new MissionRepositoryObserver(root, ['**'], ['.env*']);
  await assert.rejects(broadObserver.readText('.ENV', 100), /denied/);
});
