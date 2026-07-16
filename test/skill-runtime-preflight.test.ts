import assert from 'node:assert/strict';
import { test } from 'node:test';

import { migrateConfigV1ToV2 } from '../src/setup/skill-runtime-v2-migration.js';
import { runSkillRuntimePreflight } from '../src/runner/skill-runtime-preflight.js';
import { validConfig } from './fixtures/config.js';

const v1WithoutFigma = { ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: false } } };

test('skill runtime preflight rejects config v1 before loading runtime dependencies', async () => {
  let touched = false;
  await assert.rejects(runSkillRuntimePreflight({
    targetRoot: '/unused',
    config: v1WithoutFigma,
    runId: 'preflight',
    dependencies: { loadBundle: async () => { touched = true; throw new Error('unexpected'); } },
  }), /skill-runtime-v2-required/);
  assert.equal(touched, false);
});

test('skill runtime preflight proves bundle, catalog, version, private home, and empty state v2', async () => {
  const config = migrateConfigV1ToV2(v1WithoutFigma);
  const order: string[] = [];
  const result = await runSkillRuntimePreflight({
    targetRoot: '/target', config, runId: 'preflight',
    dependencies: {
      loadBundle: async () => {
        order.push('bundle');
        return { manifest: { bundleHash: 'hash', package: { version: '0.1.51' } } as any, packageRoot: '/package', bundleRoot: '/bundle' };
      },
      materialize: async () => { order.push('materialize'); return { bundleHash: 'hash', packageVersion: '0.1.51', bundleRoot: '/materialized' }; },
      loadToolCatalog: async (path) => { order.push('catalog'); assert.equal(path, '/materialized/tool-catalogs/codex-0.144.4.json'); return {} as any; },
      prepareRuntimeHome: async () => { order.push('home'); return { root: '/home', sqliteHome: '/home/sqlite/preflight', env: { PATH: '/bin' }, authMode: 'persisted' }; },
      assertVersion: async () => { order.push('version'); },
      loadState: async () => { order.push('state'); return { version: 2, generation: 0, runs: [] }; },
      probeAppServer: async () => { order.push('app-server'); },
    },
  });
  assert.deepEqual(order, ['bundle', 'materialize', 'catalog', 'home', 'version', 'app-server', 'state']);
  assert.equal(result.bundleRoot, '/materialized');
});

test('skill runtime preflight rejects legacy records in state v2', async () => {
  const config = migrateConfigV1ToV2(v1WithoutFigma);
  await assert.rejects(runSkillRuntimePreflight({
    targetRoot: '/target', config, runId: 'preflight',
    dependencies: {
      loadBundle: async () => ({ manifest: { bundleHash: 'hash', package: { version: '0.1.51' } } as any, packageRoot: '/package', bundleRoot: '/bundle' }),
      materialize: async () => ({ bundleHash: 'hash', packageVersion: '0.1.51', bundleRoot: '/materialized' }),
      loadToolCatalog: async () => ({} as any),
      prepareRuntimeHome: async () => ({ root: '/home', sqliteHome: '/home/sqlite/preflight', env: {}, authMode: 'persisted' }),
      assertVersion: async () => {},
      probeAppServer: async () => {},
      loadState: async () => ({ version: 2, generation: 1, runs: [{ issueNumber: 1 } as any] }),
    },
  }), /state-v1-record-present/);
});

test('persisted-auth preflight retains the proven owner until the claim path transfers or closes it', async () => {
  const config = migrateConfigV1ToV2(v1WithoutFigma);
  const events: string[] = [];
  const owner = { close: async () => { events.push('closed'); } } as any;
  const result = await runSkillRuntimePreflight({
    targetRoot: '/target', config, runId: 'preflight', retainAppServer: true,
    dependencies: {
      loadBundle: async () => ({ manifest: { bundleHash: 'hash', package: { version: '0.1.51' } } as any, packageRoot: '/package', bundleRoot: '/bundle' }),
      materialize: async () => ({ bundleHash: 'hash', packageVersion: '0.1.51', bundleRoot: '/materialized' }),
      loadToolCatalog: async () => ({} as any),
      prepareRuntimeHome: async () => ({ root: '/home', sqliteHome: '/home/sqlite/preflight', env: {}, authMode: 'persisted' }),
      assertVersion: async () => {},
      probeAppServer: async () => { events.push('proven'); return owner; },
      loadState: async () => ({ version: 2, generation: 0, runs: [] }),
    },
  });

  assert.equal(result.retainedOwner, owner);
  assert.deepEqual(events, ['proven']);
  await result.retainedOwner!.close('preclaim-failed');
  assert.deepEqual(events, ['proven', 'closed']);
});
