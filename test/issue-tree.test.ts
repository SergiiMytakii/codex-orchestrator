import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectExecutableChildBatches,
  ensureAutonomousChildBody,
  isAutonomousChildOfParent,
  parseAutonomousChildMetadata,
  persistAutonomousChildNode,
  readAutonomousChildNodes,
  renderAutonomousChildBody,
  renderAutonomousChildMarker,
  validatePlanGraph,
  validatePlanGraphStructure,
  type PlanGraph,
} from '../src/runner/issue-tree.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
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

test('autonomous child lifecycle creates marked children and reads metadata', async () => {
  const adapter = new InMemoryGitHubIssueAdapter();
  const node = validGraph().nodes[0]!;

  const issue = await persistAutonomousChildNode(adapter, validConfig, 151, node);
  const readback = await readAutonomousChildNodes(adapter, validConfig, 151, [issue]);

  assert.equal(issue.title, 'A');
  assert.deepEqual(issue.labels.map((label) => label.name), [labels.child.name]);
  assert.match(issue.body, /codex-orchestrator:autonomous-child parent=#151/);
  assert.match(issue.body, /Stable ID: a/);
  assert.equal(readback.length, 1);
  assert.deepEqual(readback[0]?.metadata, {
    stableId: 'a',
    afkHitl: 'afk',
    dependsOn: [],
    ownershipScope: ['src/a.ts'],
    verification: ['npm test'],
  });
});

test('autonomous child lifecycle updates only existing children of parent and rejects arbitrary issue before mutation', async () => {
  const existing = issueFixture({
    number: 12,
    labels: [labels.child.name],
    body: renderAutonomousChildBody(validGraph().nodes[0]!, 151),
  });
  const arbitrary = issueFixture({
    number: 13,
    labels: [],
    body: 'Existing issue body',
  });
  const adapter = new InMemoryGitHubIssueAdapter([existing, arbitrary]);

  const updated = await persistAutonomousChildNode(adapter, validConfig, 151, {
    ...validGraph().nodes[1]!,
    issueNumber: 12,
    title: 'Updated child',
  });

  assert.equal(updated.number, 12);
  assert.equal(updated.title, 'Updated child');
  assert.match(updated.body, /Stable ID: b/);
  await assert.rejects(
    persistAutonomousChildNode(adapter, validConfig, 151, { ...validGraph().nodes[0]!, issueNumber: 13 }),
    /refusing to update arbitrary issue/,
  );
  assert.equal((await adapter.getIssue(13))?.body, 'Existing issue body');
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

function childBody(input: {
  parentIssueNumber?: number;
  stableId?: string;
  afkHitl?: 'afk' | 'hitl';
  dependsOn?: string[];
  ownershipScope?: string[];
  verification?: string[];
  specGate?: string;
} = {}): string {
  return [
    renderAutonomousChildMarker(input.parentIssueNumber ?? 151),
    'Child body',
    '',
    '## codex-orchestrator metadata',
    `Stable ID: ${input.stableId ?? 'a'}`,
    `AFK/HITL: ${input.afkHitl ?? 'afk'}`,
    `Depends on: ${(input.dependsOn ?? []).length > 0 ? (input.dependsOn ?? []).join(', ') : 'none'}`,
    'Ownership:',
    ...(input.ownershipScope ?? ['src/a.ts']).map((scope) => `- ${scope}`),
    `Spec gate: ${input.specGate ?? 'wave-level'}`,
    'Verification:',
    ...(input.verification ?? ['npm test']).map((check) => `- ${check}`),
  ].join('\n');
}

test('autonomous child metadata parses only marked children with required fields', () => {
  const issue = issueFixture({
    number: 20,
    labels: [labels.child.name],
    body: childBody({ stableId: 'child-a', dependsOn: ['base'], ownershipScope: ['src/a.ts', 'test/a.test.ts'] }),
  });

  const parsed = parseAutonomousChildMetadata(issue, validConfig, 151);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.node.metadata.stableId : '', 'child-a');
  assert.deepEqual(parsed.ok ? parsed.node.metadata.dependsOn : [], ['base']);
  assert.deepEqual(parsed.ok ? parsed.node.metadata.ownershipScope : [], ['src/a.ts', 'test/a.test.ts']);

  const unmarked = parseAutonomousChildMetadata(
    issueFixture({ number: 21, labels: [labels.auto.name], body: childBody() }),
    validConfig,
    151,
  );
  assert.equal(unmarked.ok, false);
  assert.match(unmarked.ok ? '' : unmarked.errors.join('\n'), /not an autonomous child/);

  const malformed = parseAutonomousChildMetadata(
    issueFixture({
      number: 22,
      labels: [labels.child.name],
      body: childBody({ stableId: '', ownershipScope: [], verification: [], specGate: 'issue-level' }),
    }),
    validConfig,
    151,
  );
  assert.equal(malformed.ok, false);
  assert.match(malformed.ok ? '' : malformed.errors.join('\n'), /Stable ID/);
  assert.match(malformed.ok ? '' : malformed.errors.join('\n'), /Ownership/);
  assert.match(malformed.ok ? '' : malformed.errors.join('\n'), /Verification/);
  assert.match(malformed.ok ? '' : malformed.errors.join('\n'), /Spec gate/);
});

test('structural plan validation allows serializable ownership overlap while strict validation rejects same-wave overlap', () => {
  const graph = validGraph({
    nodes: [
      validGraph().nodes[0]!,
      { ...validGraph().nodes[1]!, dependsOn: [], ownershipScope: ['src/a.ts'] },
    ],
    edges: [],
  });

  assert.deepEqual(validatePlanGraphStructure(graph), { ok: true });
  const strict = validatePlanGraph(graph);
  assert.equal(strict.ok, false);
  assert.match(strict.ok ? '' : strict.errors.join('\n'), /same-wave ownership overlap/);
});

test('executable child batches enforce state, dependencies, max concurrency, and ownership separation', () => {
  const nodes = [
    issueFixture({
      number: 31,
      labels: [labels.child.name],
      body: childBody({ stableId: 'a', ownershipScope: ['src/shared.ts'] }),
    }),
    issueFixture({
      number: 32,
      labels: [labels.child.name],
      body: childBody({ stableId: 'b', ownershipScope: ['src/shared.ts'] }),
    }),
    issueFixture({
      number: 33,
      labels: [labels.child.name],
      body: childBody({ stableId: 'c', ownershipScope: ['src/c.ts'] }),
    }),
    issueFixture({
      number: 34,
      labels: [labels.child.name],
      body: childBody({ stableId: 'd', dependsOn: ['a', 'b'], ownershipScope: ['src/d.ts'] }),
    }),
  ].map((issue) => {
    const parsed = parseAutonomousChildMetadata(issue, validConfig, 151);
    assert.equal(parsed.ok, true);
    return parsed.ok ? parsed.node : undefined;
  }).filter((node) => node !== undefined);

  const batches = collectExecutableChildBatches(nodes, validConfig);

  assert.equal(batches.ok, true);
  assert.deepEqual(
    batches.ok ? batches.batches.map((batch) => batch.map((node) => node.metadata.stableId)) : [],
    [['a', 'c'], ['b'], ['d']],
  );
  assert.equal((batches.ok ? batches.batches : []).every((batch) => batch.length <= 3), true);
});

test('executable child batches reject hitl, blocked state, malformed graph, and closed issues', () => {
  const issues = [
    issueFixture({
      number: 41,
      labels: [labels.child.name],
      body: childBody({ stableId: 'hitl', afkHitl: 'hitl' }),
    }),
    issueFixture({
      number: 42,
      labels: [labels.child.name, labels.blocked.name],
      body: childBody({ stableId: 'blocked' }),
    }),
    issueFixture({
      number: 43,
      labels: [labels.child.name],
      body: childBody({ stableId: 'malformed', dependsOn: ['missing'] }),
    }),
    issueFixture({
      number: 44,
      labels: [labels.child.name],
      body: childBody({ stableId: 'closed' }),
      state: 'CLOSED',
    }),
  ];
  const nodes = issues.map((issue) => {
    const parsed = parseAutonomousChildMetadata(issue, validConfig, 151);
    assert.equal(parsed.ok, true);
    return parsed.ok ? parsed.node : undefined;
  }).filter((node) => node !== undefined);

  const result = collectExecutableChildBatches(nodes, validConfig);

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.errors.join('\n'), /#41.*hitl/);
  assert.match(result.ok ? '' : result.errors.join('\n'), /#42.*blocked/);
  assert.match(result.ok ? '' : result.errors.join('\n'), /unknown node missing/);
  assert.match(result.ok ? '' : result.errors.join('\n'), /#44.*closed/);
});
