import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadPackageSkillBundle } from '../src/skills/package-skill-bundle.js';
import {
  appendRecoveryExecution,
  applyNodeControlEnvelope,
  assertNodeResult,
  expandReviewTemplate,
  intersectExecutionPolicy,
  prepareNodeAttempt,
  recordReviewNodeResult,
  runnableReviewNodes,
  startReviewTemplate,
  startOperationGraph,
  updateAttemptExecution,
  type NodeControlEnvelopeV1,
} from '../src/skills/package-skill-graph.js';

test('plan-parent operation advances only through the signed node sequence', async () => {
  const { manifest } = await loadPackageSkillBundle();
  let progress = startOperationGraph(manifest, 'plan-parent');
  assert.equal(progress.currentNodeId, 'to-spec');

  for (const [nodeId, outcome, next] of [
    ['to-spec', 'succeeded', 'to-tickets'],
    ['to-tickets', 'succeeded', 'tickets-breakdown-review'],
    ['tickets-breakdown-review', 'approved', 'triage'],
  ] as const) {
    progress = applyNodeControlEnvelope(manifest, progress, envelope(nodeId, outcome));
    assert.equal(progress.currentNodeId, next);
  }
  progress = applyNodeControlEnvelope(manifest, progress, envelope('triage', 'succeeded'));
  assert.equal(progress.aggregateVerdict, 'Approved');
  assert.deepEqual(progress.completedNodeIds, ['tickets-breakdown-review', 'to-spec', 'to-tickets', 'triage']);
});

test('graph transition rejects model-selected invalid edges and artifactless success', async () => {
  const { manifest } = await loadPackageSkillBundle();
  const progress = startOperationGraph(manifest, 'implementation-attempt');

  assert.throws(() => applyNodeControlEnvelope(manifest, progress, envelope('scoped-classification', 'approved')), /undeclared outcome/);
  assert.throws(() => applyNodeControlEnvelope(manifest, progress, { ...envelope('scoped-classification', 'route-small'), artifactRefs: [] }), /artifact reference/);
  assert.throws(() => applyNodeControlEnvelope(manifest, progress, envelope('different-node', 'route-small')), /current node/);
  const terminal = { ...progress, currentNodeId: 'final-aggregation' };
  assert.throws(() => applyNodeControlEnvelope(manifest, terminal, envelope('final-aggregation', 'route-small')), /undeclared outcome/);
  const review = { ...progress, currentNodeId: 'code-review' };
  assert.throws(() => applyNodeControlEnvelope(manifest, review, envelope('code-review', 'approved')), /mandatory review joins/);
});

test('node-specific result contracts reject empty terminal and malformed review approvals', async () => {
  const { manifest } = await loadPackageSkillBundle();
  const terminal = { ...startOperationGraph(manifest, 'implementation-attempt'), currentNodeId: 'final-aggregation' };

  assert.throws(() => applyNodeControlEnvelope(manifest, terminal, {
    ...envelope('final-aggregation', 'approved'),
    result: {},
  }), /invalid verdict result/);
  assert.throws(() => assertNodeResult('A-full', 'approved', { findingIds: ['REV-2', 'REV-1'] }), /invalid findingIds/);
  assert.throws(() => assertNodeResult('B-closure', 'approved', { findingIds: ['REV-1', 'REV-1'] }), /invalid findingIds/);
  assert.doesNotThrow(() => assertNodeResult('final-aggregation', 'approved', { verdict: 'Approved', findingIds: [] }));
});

test('approved review templates preserve bounded fresh-review topology', async () => {
  const { manifest } = await loadPackageSkillBundle();
  assert.deepEqual(expandReviewTemplate(manifest, 'artifact-review-simple').map((node) => node.id), ['A-full', 'A-closure-1', 'A-closure-2']);
  assert.deepEqual(expandReviewTemplate(manifest, 'artifact-review-medium').map((node) => node.id), ['A-full', 'A-closure-1', 'A-closure-2', 'A-closure-3']);
  assert.deepEqual(expandReviewTemplate(manifest, 'artifact-review-high').map((node) => node.id), ['A-full', 'B-full', 'A-closure', 'B-closure', 'C-full', 'C-closure']);
  assert.equal(new Set(expandReviewTemplate(manifest, 'artifact-review-high').filter((node) => node.mode === 'full').map((node) => node.reviewerSlot)).size, 3);
});

test('review templates enforce fan-out joins, reviewer independence, and reserved budgets', async () => {
  const { manifest } = await loadPackageSkillBundle();
  const expanded = expandReviewTemplate(manifest, 'artifact-review-high');
  let progress = startReviewTemplate(manifest, startOperationGraph(manifest, 'implementation-attempt'), 'artifact-review-high');
  assert.deepEqual(runnableReviewNodes(expanded, progress).map((node) => node.id), ['A-full', 'B-full']);
  progress = recordReviewNodeResult(expanded, progress, { nodeId: 'A-full', reviewerId: 'reviewer-a', threadId: 'thread-a', verdict: 'Needs Work', findingIds: ['A-1'] });
  assert.deepEqual(runnableReviewNodes(expanded, progress).map((node) => node.id), ['B-full']);
  assert.throws(() => recordReviewNodeResult(expanded, progress, { nodeId: 'B-full', reviewerId: 'reviewer-a', threadId: 'thread-b', verdict: 'Approved', findingIds: [] }), /independent reviewers/);
  progress = recordReviewNodeResult(expanded, progress, { nodeId: 'B-full', reviewerId: 'reviewer-b', threadId: 'thread-b', verdict: 'Approved', findingIds: [] });
  assert.deepEqual(runnableReviewNodes(expanded, progress).map((node) => node.id), ['A-closure']);
  assert.equal(progress.reviewBudget.maximum, 6);
  assert.equal(progress.reviewBudget.consumed, 2);
  assert.throws(() => recordReviewNodeResult(expanded, progress, { nodeId: 'A-closure', reviewerId: 'reviewer-c', threadId: 'thread-c', verdict: 'Approved', findingIds: [] }), /exact reviewer/);
  assert.throws(() => recordReviewNodeResult(expanded, progress, { nodeId: 'A-closure', reviewerId: 'reviewer-a', threadId: 'thread-new', verdict: 'Approved', findingIds: [] }), /exact reviewer/);
  assert.throws(() => recordReviewNodeResult(expanded, progress, { nodeId: 'A-closure', reviewerId: 'reviewer-a', threadId: 'thread-a', verdict: 'Needs Work', findingIds: ['A-2'] }), /cannot join/);
  progress = recordReviewNodeResult(expanded, progress, { nodeId: 'A-closure', reviewerId: 'reviewer-a', threadId: 'thread-a', verdict: 'Approved', findingIds: [] });
  assert.deepEqual(runnableReviewNodes(expanded, progress).map((node) => node.id), ['C-full']);
});

test('node attempt history follows prepared, running, terminal, reconciled order and bounded recovery', async () => {
  const { manifest } = await loadPackageSkillBundle();
  const baseline = { headSha: 'head', indexTreeSha: 'index', statusSha256: 'status', contentSha256: 'content', ownershipToken: 'owner' };
  let progress = prepareNodeAttempt(startOperationGraph(manifest, 'implementation-attempt'), {
    attemptId: 'attempt-1', executionId: 'execution-1', nodeId: 'scoped-classification', baseline,
    reportPath: '/report.json', intentPersistedAt: '2026-07-15T00:00:00.000Z',
  });
  progress = updateAttemptExecution(progress, {
    attemptId: 'attempt-1', executionId: 'execution-1', status: 'running',
    process: { pid: 10, processGroupId: 10, host: 'host', bootNonce: 'boot', startedAt: '2026-07-15T00:00:01.000Z' },
  });
  assert.throws(() => updateAttemptExecution(prepareNodeAttempt(startOperationGraph(manifest, 'implementation-attempt'), {
    attemptId: 'attempt-x', executionId: 'execution-x', nodeId: 'scoped-classification', baseline,
    reportPath: '/x.json', intentPersistedAt: '2026-07-15T00:00:00.000Z',
  }), { attemptId: 'attempt-x', executionId: 'execution-x', status: 'running', appServer: { threadId: 'thread-x' } }), /process identity/);
  progress = updateAttemptExecution(progress, {
    attemptId: 'attempt-1', executionId: 'execution-1', status: 'running', appServer: { threadId: 'thread-1', turnId: 'turn-1' },
  });
  assert.throws(() => updateAttemptExecution(progress, {
    attemptId: 'attempt-1', executionId: 'execution-1', status: 'terminal',
  }), /accepted hashed report/);
  progress = updateAttemptExecution(progress, {
    attemptId: 'attempt-1', executionId: 'execution-1', status: 'terminal',
    report: { path: '/report.json', sha256: 'a'.repeat(64), atomicWriteComplete: true },
    terminal: { kind: 'failed', acknowledgedAt: '2026-07-15T00:00:02.000Z', sideEffectsQuiescedAt: '2026-07-15T00:00:03.000Z', quiescenceProof: 'thread-clean-empty' },
  });
  progress = appendRecoveryExecution(progress, {
    attemptId: 'attempt-1', executionId: 'execution-2', kind: 'clean-retry', reportPath: '/report-2.json',
    intentPersistedAt: '2026-07-15T00:00:04.000Z', baselineUnchanged: true, partialContinuationAllowed: false,
  });
  assert.equal(progress.attempts[0]?.cleanRetriesConsumed, 1);
  assert.equal(progress.attempts[0]?.executions.length, 2);
  assert.throws(() => appendRecoveryExecution(progress, {
    attemptId: 'attempt-1', executionId: 'execution-3', kind: 'clean-retry', reportPath: '/report-3.json',
    intentPersistedAt: '2026-07-15T00:00:05.000Z', baselineUnchanged: true, partialContinuationAllowed: false,
  }), /terminal prior execution|unavailable/);
});

test('execution policy intersection only narrows signed authority', async () => {
  const { manifest } = await loadPackageSkillBundle();
  const node = manifest.graphs['implementation-attempt']!.nodes.find((item) => item.id === 'spec-implementer')!;
  const effective = intersectExecutionPolicy(node.executionPolicy, {
    network: 'deny',
    networkHosts: [],
    writableRootClasses: ['proof-artifacts', 'target-state', 'worktree'],
    mcpServers: {},
  }, {
    model: null, effort: 'low', timeoutMs: 600_000, idleTimeoutMs: 120_000,
  });

  assert.equal(effective.network, 'deny');
  assert.equal(effective.effort, 'low');
  assert.equal(effective.timeoutMs, 600_000);
  assert.deepEqual(effective.writableRootClasses, ['target-state', 'worktree']);
  assert.throws(() => intersectExecutionPolicy(node.executionPolicy, {
    network: 'deny', networkHosts: [], writableRootClasses: ['target-state'], mcpServers: { figma: { url: 'https://example.test', httpHeaders: {}, enabledTools: ['read'], approvals: { read: 'never' } } },
  }), /MCP catalog fixture/);
});

function envelope(nodeId: string, outcome: NodeControlEnvelopeV1['outcome']): NodeControlEnvelopeV1 {
  return { version: 1, nodeId, outcome, artifactRefs: [`artifact://${nodeId}`], result: { ok: true } };
}
