import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateConfigV1ToV2 } from '../src/setup/skill-runtime-v2-migration.js';
import { validConfig } from './fixtures/config.js';

test('v2 migration removes prompt workflow ownership and narrows authority', () => {
  const migrated = migrateConfigV1ToV2({ ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: false } } });
  assert.equal(migrated.version, 2);
  assert.equal('workflows' in migrated, false);
  assert.equal('promptsDir' in migrated.project, false);
  assert.deepEqual(migrated.codex.targetPolicy, { network: 'deny', networkHosts: [], writableRootClasses: ['proof-artifacts', 'target-state', 'worktree'], mcpServers: {} });
  assert.equal(migrated.codex.profiles['visual-proof']?.timeoutMs, validConfig.codex.mobileTimeoutMs);
});

test('v2 migration blocks legacy Figma MCP and custom exec ownership', () => {
  assert.throws(() => migrateConfigV1ToV2({ ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: true } } }), /config-v2-figma-tools-required/);
  assert.throws(() => migrateConfigV1ToV2({ ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: false }, command: 'custom-codex' } }), /config-v2-command-unsupported/);
});

test('v2 migration blocks every legacy prompt and profile authority override', () => {
  assert.throws(() => migrateConfigV1ToV2({
    ...validConfig,
    workflows: { ...validConfig.workflows, prd: { ...validConfig.workflows.prd, promptPath: 'custom.md' } },
  }), /config-v2-workflow-override/);
  assert.throws(() => migrateConfigV1ToV2({
    ...validConfig,
    codex: { ...validConfig.codex, profiles: { 'scoped-issue': { env: { CODEX_ORCHESTRATOR_PROMPT_FILE: 'override' } } } },
  }), /config-v2-profile-env-forbidden/);
  assert.throws(() => migrateConfigV1ToV2({
    ...validConfig,
    codex: { ...validConfig.codex, promptFileEnv: 'CUSTOM_PROMPT' as any },
  }), /config-v2-report-env-unsupported/);
});
