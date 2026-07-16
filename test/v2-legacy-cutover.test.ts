import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  detectLegacyConfig,
  parseCutoverManifest,
  type CutoverManifestV1,
} from '../src/v2/legacy-cutover.js';

test('detect-only Legacy reader accepts only bounded recognized shapes', () => {
  const legacy = Buffer.from(JSON.stringify({
    version: 1,
    github: {
      owner: 'owner', repo: 'repo',
      labels: { running: { name: 'agent:running' } },
    },
    runner: {
      workspaceRoot: '.codex-orchestrator/workspaces',
      stateDir: '.codex-orchestrator/state',
    },
  }));
  assert.deepEqual(detectLegacyConfig(legacy), {
    status: 'recognized',
    record: {
      kind: 'legacy-v1',
      repository: { owner: 'owner', repo: 'repo' },
      workspaceRoot: '.codex-orchestrator/workspaces',
      stateDir: '.codex-orchestrator/state',
      runningLabel: 'agent:running',
      configSha256: createHash('sha256').update(legacy).digest('hex'),
    },
  });
  assert.equal(detectLegacyConfig(Buffer.from('{"version":2}')).status, 'unsupported');
  assert.equal(detectLegacyConfig(Buffer.from('{"version":1,"github":{}}')).status, 'unsupported');
  assert.equal(detectLegacyConfig(Buffer.from('{not-json')).status, 'unsupported');
});

test('cutover manifest parser is exact and bounded', () => {
  const manifest: CutoverManifestV1 = {
    schema: 'codex-orchestrator.agent-auto-fresh-cutover', version: 1,
    transactionId: 'a'.repeat(64),
    repository: { owner: 'owner', repo: 'repo' },
    source: {
      configPath: '.codex-orchestrator/config.json', configSha256: 'b'.repeat(64),
      statePath: '.codex-orchestrator/state', stateSha256: 'c'.repeat(64),
    },
    destination: {
      workspaceRoot: '.codex-orchestrator/workspaces-v2', stateDir: '.codex-orchestrator/v2/state',
      proofDir: '.codex-orchestrator/v2/proofs', configSha256: 'd'.repeat(64),
    },
    retained: { worktreePaths: [], localRefs: [], remoteRefs: [] },
    backup: {
      root: '.codex-orchestrator/v2/legacy-backups/a',
      configPath: '.codex-orchestrator/v2/legacy-backups/a/config.json',
      statePath: '.codex-orchestrator/v2/legacy-backups/a/state',
    },
  };
  assert.deepEqual(parseCutoverManifest(structuredClone(manifest)), manifest);
  assert.throws(() => parseCutoverManifest({ ...manifest, extra: true }));
  assert.throws(() => parseCutoverManifest({ ...manifest, transactionId: '../bad' }));
});
