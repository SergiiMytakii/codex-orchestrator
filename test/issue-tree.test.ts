import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ensureAutonomousChildBody,
  isAutonomousChildOfParent,
  renderAutonomousChildMarker,
  validatePlanGraph,
  type PlanGraph,
} from '../src/runner/issue-tree.js';
import { validConfig } from './fixtures/config.js';
import { commentFixture, issueFixture } from './fixtures/issues.js';

const labels = validConfig.github.labels;

function validGraph(overrides: Partial<PlanGraph> = {}): PlanGraph {
  return {
    nodes: [
      {
        stableId: 'a',
        title: 'A',
        body: 'A body',
        afkHitl: 'afk',
        ownershipScope: ['src/a.ts'],
        dependsOn: [],
        verification: ['npm test'],
      },
      {
        stableId: 'b',
        title: 'B',
        body: 'B body',
        afkHitl: 'hitl',
        ownershipScope: ['src/b.ts'],
        dependsOn: ['a'],
        verification: ['npm test'],
      },
    ],
    edges: [{ from: 'a', to: 'b', reason: 'B needs A' }],
    specGate: 'wave-level',
    ...overrides,
  };
}

test('autonomous child marker is exact and body normalization keeps it first', () => {
  assert.equal(
    renderAutonomousChildMarker(151),
    '<!-- codex-orchestrator:autonomous-child parent=#151 -->',
  );
  assert.equal(
    ensureAutonomousChildBody(
      [
        '<!-- codex-orchestrator:autonomous-child parent=#1 -->',
        'Body',
        '<!-- codex-orchestrator:autonomous-child parent=#2 -->',
      ].join('\n'),
      151,
    ),
    '<!-- codex-orchestrator:autonomous-child parent=#151 -->\nBody',
  );
});

test('autonomous child membership requires child label and exact parent marker', () => {
  const issue = issueFixture({
    number: 10,
    labels: [labels.child.name],
    body: `${renderAutonomousChildMarker(151)}\nParent issue: #999`,
    comments: [
      commentFixture({
        body: renderAutonomousChildMarker(999),
        createdAt: '2026-05-08T10:00:00.000Z',
      }),
    ],
  });

  assert.equal(isAutonomousChildOfParent(issue, validConfig, 151), true);
  assert.equal(isAutonomousChildOfParent(issue, validConfig, 999), false);
  assert.equal(
    isAutonomousChildOfParent(issueFixture({ number: 11, labels: [], body: renderAutonomousChildMarker(151) }), validConfig, 151),
    false,
  );
  assert.equal(
    isAutonomousChildOfParent(
      issueFixture({ number: 12, labels: [labels.child.name], body: 'Parent issue: #151' }),
      validConfig,
      151,
    ),
    false,
  );
});

test('plan graph validation accepts coherent DAGs', () => {
  assert.deepEqual(validatePlanGraph(validGraph()), { ok: true });
});

test('plan graph validation rejects unknown references and self dependencies', () => {
  const unknown = validatePlanGraph(validGraph({
    nodes: [validGraph().nodes[0]!, { ...validGraph().nodes[1]!, dependsOn: ['missing'] }],
    edges: [{ from: 'a', to: 'missing', reason: 'bad' }],
  }));
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? '' : unknown.errors.join('\n'), /unknown/);

  const self = validatePlanGraph(validGraph({
    nodes: [{ ...validGraph().nodes[0]!, dependsOn: ['a'] }],
    edges: [],
  }));
  assert.equal(self.ok, false);
  assert.match(self.ok ? '' : self.errors.join('\n'), /cannot depend on itself/);
});

test('plan graph validation rejects cycles and invalid node requirements', () => {
  const cycle = validatePlanGraph(validGraph({
    nodes: [
      { ...validGraph().nodes[0]!, dependsOn: ['b'] },
      { ...validGraph().nodes[1]!, dependsOn: ['a'] },
    ],
    edges: [],
  }));
  assert.equal(cycle.ok, false);
  assert.match(cycle.ok ? '' : cycle.errors.join('\n'), /cycle/);

  const invalidNode = validatePlanGraph(validGraph({
    nodes: [{ ...validGraph().nodes[0]!, ownershipScope: [], verification: [] }],
    edges: [],
  }));
  assert.equal(invalidNode.ok, false);
  assert.match(invalidNode.ok ? '' : invalidNode.errors.join('\n'), /ownershipScope/);
  assert.match(invalidNode.ok ? '' : invalidNode.errors.join('\n'), /verification/);
});

test('plan graph validation rejects wrong spec gate and same-wave ownership overlap', () => {
  const wrongGate = validatePlanGraph({ ...validGraph(), specGate: 'issue-level' as 'wave-level' });
  assert.equal(wrongGate.ok, false);
  assert.match(wrongGate.ok ? '' : wrongGate.errors.join('\n'), /specGate/);

  const overlap = validatePlanGraph(validGraph({
    nodes: [
      validGraph().nodes[0]!,
      { ...validGraph().nodes[1]!, dependsOn: [], ownershipScope: ['src/a.ts'] },
    ],
    edges: [],
  }));
  assert.equal(overlap.ok, false);
  assert.match(overlap.ok ? '' : overlap.errors.join('\n'), /same-wave ownership overlap/);
});
