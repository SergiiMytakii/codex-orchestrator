import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { activatePreparedSkillRuntimeV2 } from '../src/setup/skill-runtime-v2-activation.js';
import { validConfig } from './fixtures/config.js';

test('prepared v2 activation commits empty state before the atomic config rename', async () => {
  const fixture = await activationFixture();
  const result = await activatePreparedSkillRuntimeV2({
    targetRoot: fixture.root,
    dependencies: fixture.dependencies,
  });
  assert.equal(JSON.parse(await readFile(result.configPath, 'utf8')).version, 2);
  assert.deepEqual(JSON.parse(await readFile(result.statePath, 'utf8')), { version: 2, generation: 0, runs: [] });
  assert.equal(JSON.parse(await readFile(result.backupPath, 'utf8')).version, 1);
});

test('activation crash before config commit leaves bridge-compatible v1 config and empty state v2', async () => {
  const fixture = await activationFixture();
  await assert.rejects(activatePreparedSkillRuntimeV2({
    targetRoot: fixture.root,
    dependencies: { ...fixture.dependencies, beforeConfigCommit: async () => { throw new Error('injected-before-config-commit'); } },
  }), /injected-before-config-commit/);
  assert.equal(JSON.parse(await readFile(fixture.configPath, 'utf8')).version, 1);
  assert.deepEqual(JSON.parse(await readFile(fixture.statePath, 'utf8')), { version: 2, generation: 0, runs: [] });

  const recovered = await activatePreparedSkillRuntimeV2({
    targetRoot: fixture.root,
    dependencies: fixture.dependencies,
  });
  assert.equal(JSON.parse(await readFile(recovered.configPath, 'utf8')).version, 2);
});

test('activation candidate preflight failure leaves config and state bytes untouched', async () => {
  const fixture = await activationFixture();
  const configBefore = await readFile(fixture.configPath);
  const stateBefore = await readFile(fixture.statePath);
  await assert.rejects(activatePreparedSkillRuntimeV2({
    targetRoot: fixture.root,
    dependencies: { ...fixture.dependencies, candidatePreflight: async () => { throw new Error('orchestrator-auth-required'); } },
  }), /orchestrator-auth-required/);
  assert.deepEqual(await readFile(fixture.configPath), configBefore);
  assert.deepEqual(await readFile(fixture.statePath), stateBefore);
  await assert.rejects(access(`${fixture.configPath}.v1.backup`));
});

test('activation crash after config rename leaves one authoritative v2 config and matching empty state', async () => {
  const fixture = await activationFixture();

  await assert.rejects(activatePreparedSkillRuntimeV2({
    targetRoot: fixture.root,
    dependencies: { ...fixture.dependencies, afterConfigCommit: async () => { throw new Error('injected-after-config-commit'); } },
  }), /injected-after-config-commit/);

  assert.equal(JSON.parse(await readFile(fixture.configPath, 'utf8')).version, 2);
  assert.deepEqual(JSON.parse(await readFile(fixture.statePath, 'utf8')), { version: 2, generation: 0, runs: [] });
  assert.equal(JSON.parse(await readFile(`${fixture.configPath}.v1.backup`, 'utf8')).version, 1);
});

async function activationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'skill-runtime-activation-')));
  const config = { ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: false } } };
  const configPath = join(root, '.codex-orchestrator', 'config.json');
  const statePath = join(root, config.runner.stateDir, 'runner-state.json');
  await mkdir(join(root, '.codex-orchestrator'), { recursive: true });
  await mkdir(join(root, config.runner.stateDir, 'skill-runtime-v2'), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const stateBytes = Buffer.from(`${JSON.stringify({ version: 1, runs: [] }, null, 2)}\n`);
  await writeFile(statePath, stateBytes);
  await writeFile(join(root, config.runner.stateDir, 'skill-runtime-v2', 'prepared-generation.json'), `${JSON.stringify({
    version: 1,
    canonicalTargetRoot: root,
    preparedAt: new Date(0).toISOString(),
    hostId: 'host',
    bootNonce: 'boot',
    bridgePackageVersion: '0.1.51',
    bridgePackageHash: 'accepted-bridge',
    activityFenceGeneration: 1,
    inspectedProcesses: [],
    runnerState: { path: statePath, sha256: createHash('sha256').update(stateBytes).digest('hex'), nonterminalV1RunIds: [] },
    githubDrain: { queriedAt: new Date(0).toISOString(), runningIssueNumbers: [] },
  }, null, 2)}\n`);
  return {
    root, configPath, statePath,
    dependencies: {
      loadBundle: async () => ({ manifest: { acceptedBridgePackageHashes: ['accepted-bridge'] } as any, packageRoot: '/package', bundleRoot: '/bundle' }),
      issueAdapter: { listOpenIssuesWithAnyLabel: async () => [] } as any,
      candidatePreflight: async ({ config }: any) => ({ config, packageVersion: '0.1.51', bundleHash: 'bundle', bundleRoot: '/bundle', toolCatalogPath: '/catalog' }),
    },
  };
}
