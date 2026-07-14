import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  authorizeMissionScopeExpansion,
  type MissionScopeExpansionContext,
  type MissionScopeExpansionProposal,
} from '../src/runner/mission-scope-expansion.js';

const context: MissionScopeExpansionContext = {
  repository: 'SergiiMytakii/IntelleReach',
  repositoryPaths: [
    'src/frontend/context/AuthContext.tsx',
    'src/frontend/lib/errorUtils.ts',
    'src/frontend/lib/errorUtils.spec.ts',
    'src/frontend/package.json',
    'src/frontend/eslint.config.mjs',
    '.env.example',
  ],
  grantedPaths: [
    'src/frontend/context/AuthContext.tsx',
    'src/frontend/lib/errorUtils.ts',
    'src/frontend/lib/errorUtils.spec.ts',
  ],
  evidenceIds: ['finding:failed-frontend-lint', 'proof:targeted-eslint-passed'],
  relationships: [{
    kind: 'config-consumer',
    from: 'src/frontend/context/AuthContext.tsx',
    to: 'src/frontend/package.json',
    evidenceId: 'finding:failed-frontend-lint',
  }, {
    kind: 'test-for',
    from: 'src/frontend/lib/errorUtils.ts',
    to: 'src/frontend/lib/errorUtils.spec.ts',
    evidenceId: 'proof:targeted-eslint-passed',
  }],
  allowlistedGeneratorIds: [],
  deniedPaths: ['.env*', '**/.env*', '.git', '.git/**'],
  maxExpandedPaths: 16,
};

test('scope expansion allows a finite related config path backed by pinned evidence', () => {
  const result = authorizeMissionScopeExpansion(context, proposal());

  assert.deepEqual(result, {
    kind: 'allowed',
    repository: 'SergiiMytakii/IntelleReach',
    paths: ['src/frontend/package.json'],
    relationship: 'config-consumer',
    evidenceIds: ['finding:failed-frontend-lint'],
  });
});

test('scope expansion resolves bounded globs to a finite exact set', () => {
  const result = authorizeMissionScopeExpansion(context, proposal({
    paths: ['src/frontend/package.*'],
  }));

  assert.equal(result.kind, 'allowed');
  assert.deepEqual(result.kind === 'allowed' ? result.paths : [], ['src/frontend/package.json']);
});

test('scope expansion rejection is recoverable and returns machine-usable alternatives', () => {
  const result = authorizeMissionScopeExpansion(context, proposal({
    relationship: {
      kind: 'imports',
      from: 'src/frontend/context/AuthContext.tsx',
    },
  }));

  assert.deepEqual(result, {
    kind: 'rejected-recoverable',
    reason: 'relationship-not-proven',
    alternatives: [
      'request a path linked by config-consumer',
      'collect new pinned relationship evidence',
    ],
  });
});

test('scope expansion relationship source must exist in the pinned tree', () => {
  const result = authorizeMissionScopeExpansion({
    ...context,
    grantedPaths: [...context.grantedPaths, 'src/frontend/missing.ts'],
    relationships: [...context.relationships, {
      kind: 'config-consumer',
      from: 'src/frontend/missing.ts',
      to: 'src/frontend/package.json',
      evidenceId: 'finding:failed-frontend-lint',
    }],
  }, proposal({
    relationship: {
      kind: 'config-consumer',
      from: 'src/frontend/missing.ts',
    },
  }));

  assert.deepEqual(result, {
    kind: 'rejected-recoverable',
    reason: 'relationship-source-not-in-pinned-tree',
    alternatives: ['anchor the relationship in a path from the pinned tree'],
  });
});

test('scope expansion fails closed for repository mismatch, denied paths, and missing evidence', () => {
  assert.deepEqual(authorizeMissionScopeExpansion(context, proposal({
    repository: 'attacker/other-repo',
  })), {
    kind: 'safety-stop',
    reason: 'repository-identity-mismatch',
    evidence: ['expected:SergiiMytakii/IntelleReach', 'received:attacker/other-repo'],
  });

  assert.deepEqual(authorizeMissionScopeExpansion({
    ...context,
    relationships: [...context.relationships, {
      kind: 'config-consumer',
      from: 'src/frontend/context/AuthContext.tsx',
      to: '.env.example',
      evidenceId: 'finding:failed-frontend-lint',
    }],
  }, proposal({ paths: ['.env.example'] })), {
    kind: 'safety-stop',
    reason: 'scope-expansion-denied-path',
    evidence: ['.env.example'],
  });

  assert.equal(authorizeMissionScopeExpansion(context, proposal({
    evidenceIds: ['finding:not-pinned'],
  })).kind, 'rejected-recoverable');
});

test('generated scope requires an allowlisted deterministic generator', () => {
  const generatedContext: MissionScopeExpansionContext = {
    ...context,
    repositoryPaths: [...context.repositoryPaths, 'src/generated/client.ts'],
    grantedPaths: [...context.grantedPaths, 'src/frontend/package.json'],
    relationships: [...context.relationships, {
      kind: 'generated-from',
      from: 'src/frontend/package.json',
      to: 'src/generated/client.ts',
      evidenceId: 'finding:failed-frontend-lint',
      generatorId: 'generate-client',
    }],
  };
  const generatedProposal = proposal({
    paths: ['src/generated/client.ts'],
    relationship: {
      kind: 'generated-from',
      from: 'src/frontend/package.json',
      generatorId: 'generate-client',
    },
  });

  assert.equal(authorizeMissionScopeExpansion(generatedContext, generatedProposal).kind,
    'rejected-recoverable');
  assert.equal(authorizeMissionScopeExpansion({
    ...generatedContext,
    allowlistedGeneratorIds: ['generate-client'],
  }, generatedProposal).kind, 'allowed');
});

function proposal(
  overrides: Partial<MissionScopeExpansionProposal> = {},
): MissionScopeExpansionProposal {
  return {
    version: 1,
    repository: 'SergiiMytakii/IntelleReach',
    paths: ['src/frontend/package.json'],
    evidenceIds: ['finding:failed-frontend-lint'],
    relationship: {
      kind: 'config-consumer',
      from: 'src/frontend/context/AuthContext.tsx',
    },
    ...overrides,
  };
}
