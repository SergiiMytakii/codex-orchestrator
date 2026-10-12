import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishImmutableWorkflow, type ImmutableWorkflowOwner } from '../src/v2/immutable-workflow-publisher.js';

test('publisher preserves exact claim when prior process identity cannot be confirmed', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'codex-publisher-unknown-'));
  const unobservablePid = 2_147_483_647;
  const claim = Buffer.from(JSON.stringify({ bootId: 'same-boot', pid: unobservablePid,
    token: 'prior-owner', parentToken: null, processStartIdentity: 'unconfirmed' }));
  const originalKill = process.kill;
  try {
    await writeFile(join(parent, 'generation.claim'), claim);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === unobservablePid && signal === 0) throw Object.assign(new Error('inspection denied'), { code: 'EPERM' });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    await assert.rejects(publishImmutableWorkflow({
      parent, identity: 'generation', bootId: 'same-boot',
      createOwner: (parentToken, processStartIdentity) => ({ bootId: 'same-boot', pid: process.pid,
        token: 'replacement', parentToken, processStartIdentity }),
      parseOwner: (value) => value as ImmutableWorkflowOwner,
      createReady: (owner) => ({ token: owner.token }), parseReady: (value) => value as { token: string },
      serializeRecord: (value) => Buffer.from(JSON.stringify(value)), readControl: readFile,
      writeContent: async () => { assert.fail('unknown owner cannot authorize replacement content'); },
      resultFromReady: async () => 'ready', activePublisherError: 'active', recoveryChainError: 'bad chain',
    }), /publisher process identity is unavailable/u);
    assert.deepEqual(await readFile(join(parent, 'generation.claim')), claim);
    assert.deepEqual(await readdir(parent), ['generation.claim']);
  } finally { process.kill = originalKill; await rm(parent, { recursive: true, force: true }); }
});
