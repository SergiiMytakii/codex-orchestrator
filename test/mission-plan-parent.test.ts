import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkdtemp } from './mission-test-temp.js';
import {
  createPlanParent,
  planParentEventTypes,
  planParentStates,
  transitionPlanParent,
  type PlanParentEvent,
} from '../src/runner/mission-plan-parent.js';
import {
  MissionPlanParentCoordinator,
  listEligiblePlanParents,
} from '../src/runner/mission-plan-parent-coordinator.js';
import { MissionStateStore } from '../src/runner/mission-state-store.js';
import {
  createMissionPublication,
  MissionPublicationSaga,
} from '../src/runner/mission-publication.js';

test('plan parent pins deterministic waves and atomically links first-wave child missions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-plan-parent-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const coordinator = new MissionPlanParentCoordinator(store);
  const parent = createPlanParent({
    id: 'parent-227',
    repository: 'SergiiMytakii/codex-orchestrator',
    issueNumber: 227,
    configHash: `sha256:${'a'.repeat(64)}`,
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    graph: graph(),
  });
  const created = await coordinator.create({ expectedGeneration: 0, parent });
  const linked = await coordinator.linkNextWave({
    expectedGeneration: created.generation,
    parentId: parent.id,
    expectedRevision: 1,
  });

  const stored = linked.planParents[parent.id]!;
  assert.equal(stored.state, 'wave-running');
  assert.deepEqual(stored.waves, [['foundation', 'sibling'], ['dependent']]);
  assert.deepEqual(Object.keys(stored.children).sort(), ['foundation', 'sibling']);
  for (const child of Object.values(stored.children)) {
    assert.equal(linked.missions[child.missionId]?.state, 'created');
    assert.equal(child.baseCheckpointCommit, parent.checkpoint.commitSha);
    assert.equal(child.baseCheckpointTree, parent.checkpoint.treeSha);
  }

  await assert.rejects(coordinator.linkNextWave({
    expectedGeneration: linked.generation,
    parentId: parent.id,
    expectedRevision: stored.revision,
  }), /state wave-running/);
});

test('wave checkpoint makes later children observe prior-wave output without duplicating siblings', async () => {
  const { coordinator, store, snapshot, parentId } = await readyParent();
  let state = await coordinator.prepareWave({
    expectedGeneration: snapshot.generation,
    parentId,
    expectedRevision: snapshot.planParents[parentId]!.revision,
    descriptors: [descriptor('foundation'), descriptor('sibling')],
  });
  state = await coordinator.startIntegration({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    intent: integrationIntent('foundation', 0, '1'.repeat(40), '3'.repeat(40)),
  });
  state = await coordinator.completeIntegration({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    actionKey: 'integrate:0:foundation',
  });
  state = await coordinator.startIntegration({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    intent: integrationIntent('sibling', 1, '3'.repeat(40), '4'.repeat(40)),
  });
  state = await coordinator.completeIntegration({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    actionKey: 'integrate:0:sibling',
  });
  state = await coordinator.recordValidationFailure({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
  });
  const validationRecoveryId = state.planParents[parentId]!.recoveryMissionId!;
  assert.match(validationRecoveryId, /^mission-validation-recovery:v1:/);
  state = await store.mutate(state.generation, (draft) => {
    draft.missions[validationRecoveryId] = {
      ...draft.missions[validationRecoveryId]!, revision: 2, state: 'integration-ready',
    };
  });
  state = await coordinator.completeValidationRecovery({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
  });
  assert.equal(state.planParents[parentId]!.state, 'wave-validating');
  state = await coordinator.recordValidation({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    receiptIds: ['validation:wave-0'],
  });
  state = await coordinator.checkpoint({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    checkpoint: { commitSha: '4'.repeat(40), treeSha: '5'.repeat(40) },
  });
  state = await coordinator.linkNextWave({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
  });

  const parent = state.planParents[parentId]!;
  assert.equal(parent.state, 'wave-running');
  assert.equal(parent.currentWave, 1);
  assert.deepEqual(Object.keys(parent.children).sort(), ['dependent', 'foundation', 'sibling']);
  assert.equal(parent.children.dependent?.baseCheckpointCommit, '4'.repeat(40));
  assert.equal(parent.children.dependent?.baseCheckpointTree, '5'.repeat(40));
  assert.equal(parent.integrationHistory.length, 2);
});

test('integration intent replay is fenced by cursor and action key after a lost response', async () => {
  const { coordinator, snapshot, parentId } = await readyParent();
  let state = await coordinator.prepareWave({
    expectedGeneration: snapshot.generation,
    parentId,
    expectedRevision: snapshot.planParents[parentId]!.revision,
    descriptors: [descriptor('foundation'), descriptor('sibling')],
  });
  const intent = integrationIntent('foundation', 0, '1'.repeat(40), '3'.repeat(40));
  state = await coordinator.startIntegration({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    intent,
  });
  const replayed = await coordinator.startIntegration({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    intent,
  });
  assert.equal(replayed.generation, state.generation);
  assert.deepEqual(replayed.planParents[parentId]!.integrationIntent, intent);

  const completed = await coordinator.completeIntegration({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    actionKey: intent.actionKey,
  });
  const completionReplay = await coordinator.completeIntegration({
    expectedGeneration: completed.generation,
    parentId,
    expectedRevision: completed.planParents[parentId]!.revision,
    actionKey: intent.actionKey,
  });
  assert.equal(completionReplay.generation, completed.generation);
  assert.equal(completionReplay.planParents[parentId]!.integrationHistory.length, 1);
});

test('plan parent transient work resumes exact phase and no reducer path produces blocked', () => {
  const parent = createPlanParent({
    id: 'parent', repository: 'owner/repo', issueNumber: 1,
    configHash: `sha256:${'a'.repeat(64)}`, baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40), graph: graph(),
  });
  const running = transitionPlanParent(parent, { type: 'wave-linked' });
  const waiting = transitionPlanParent(running, {
    type: 'transient-failure',
    resumeTarget: 'wave-running',
    actionKey: 'child:foundation',
    nextEligibleAt: '2026-07-14T20:00:00.000Z',
    reason: 'child-resumable',
    requiredPredicate: 'child claim becomes eligible',
  });
  assert.equal(waiting.state, 'wave-waiting');
  assert.equal(transitionPlanParent(waiting, {
    type: 'resume-eligible', now: '2026-07-14T20:00:00.000Z',
  }).state, 'wave-running');
  assert.equal(planParentStates.includes('blocked' as never), false);
  assert.equal(JSON.stringify(waiting).includes('blocked'), false);
});

test('every Plan Parent state and public event pair transitions or rejects without mutation', () => {
  const base = createPlanParent({
    id: 'parent-model', repository: 'owner/repo', issueNumber: 1,
    configHash: `sha256:${'a'.repeat(64)}`, baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40), graph: graph(),
  });
  for (const state of planParentStates) {
    for (const type of planParentEventTypes) {
      const record = { ...structuredClone(base), state };
      const before = structuredClone(record);
      try {
        const result = transitionPlanParent(record, parentEvent(type));
        assert.equal(planParentStates.includes(result.state), true, `${state} + ${type}`);
        assert.equal(JSON.stringify(result).includes('blocked'), false);
      } catch {
        assert.deepEqual(record, before, `${state} + ${type}`);
      }
    }
  }
});

test('Plan Parent scheduling is indexed and expected-generation claim fenced', async () => {
  const { coordinator, snapshot, parentId } = await readyParent();
  const parent = snapshot.planParents[parentId]!;
  const waiting = await coordinator.defer({
    expectedGeneration: snapshot.generation,
    parentId,
    expectedRevision: parent.revision,
    resumeTarget: 'wave-running',
    actionKey: 'child:foundation',
    nextEligibleAt: '2026-07-14T20:00:00.000Z',
    reason: 'child-resumable',
    requiredPredicate: 'child becomes integration-ready',
  });
  assert.deepEqual(listEligiblePlanParents(waiting, '2026-07-14T19:59:59.999Z'), []);
  assert.deepEqual(listEligiblePlanParents(waiting, '2026-07-14T20:00:00.000Z'), [{
    parentId,
    revision: waiting.planParents[parentId]!.revision,
    state: 'wave-waiting',
    nextEligibleAt: '2026-07-14T20:00:00.000Z',
  }]);
  const claimed = await coordinator.claim({
    expectedGeneration: waiting.generation,
    parentId,
    expectedRevision: waiting.planParents[parentId]!.revision,
    now: '2026-07-14T20:00:00.000Z',
    claim: parentClaim(),
  });
  assert.equal(claimed.planParents[parentId]!.state, 'wave-running');
  assert.equal(claimed.planParents[parentId]!.claim?.token, 'parent-claim');
  assert.equal(claimed.nextEligibleAt[`plan-parent:${parentId}`], '2026-07-14T20:05:00.000Z');
  await assert.rejects(coordinator.claim({
    expectedGeneration: waiting.generation,
    parentId,
    expectedRevision: waiting.planParents[parentId]!.revision,
    now: '2026-07-14T20:00:00.000Z',
    claim: parentClaim(),
  }), /generation conflict/i);
});

test('integration conflict atomically links one deterministic recovery Mission', async () => {
  const { coordinator, store, snapshot, parentId } = await readyParent();
  let state = await coordinator.prepareWave({
    expectedGeneration: snapshot.generation,
    parentId,
    expectedRevision: snapshot.planParents[parentId]!.revision,
    descriptors: [descriptor('foundation'), descriptor('sibling')],
  });
  state = await coordinator.recordIntegrationConflict({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
  });
  const recoveryId = state.planParents[parentId]!.recoveryMissionId!;
  assert.match(recoveryId, /^mission-integration-recovery:v1:/);
  assert.equal(state.missions[recoveryId]?.state, 'created');
  assert.equal(Object.keys(state.missions).filter((id) => id === recoveryId).length, 1);
  state = await store.mutate(state.generation, (draft) => {
    draft.missions[recoveryId] = {
      ...draft.missions[recoveryId]!, revision: 2, state: 'integration-ready',
    };
  });
  const recoveredDescriptor = { ...descriptor('foundation'), childCommit: '9'.repeat(40) };
  state = await coordinator.completeIntegrationRecovery({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    descriptor: recoveredDescriptor,
  });
  assert.equal(state.planParents[parentId]!.state, 'wave-prepared');
  assert.deepEqual(state.planParents[parentId]!.children.foundation?.descriptor, recoveredDescriptor);
});

test('transient integration preserves its durable intent and resumes reconciliation', async () => {
  const { coordinator, snapshot, parentId } = await readyParent();
  let state = await coordinator.prepareWave({
    expectedGeneration: snapshot.generation,
    parentId,
    expectedRevision: snapshot.planParents[parentId]!.revision,
    descriptors: [descriptor('foundation'), descriptor('sibling')],
  });
  const intent = integrationIntent('foundation', 0, '1'.repeat(40), '3'.repeat(40));
  state = await coordinator.startIntegration({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    intent,
  });
  state = await coordinator.reconcileIntegration({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    execute: async (durableIntent) => {
      assert.deepEqual(durableIntent, intent);
      return {
        kind: 'transient-failure',
        nextEligibleAt: '2026-07-14T20:00:00.000Z',
        reason: 'ref lock contention',
      };
    },
  });
  assert.equal(state.planParents[parentId]!.state, 'wave-waiting');
  assert.deepEqual(state.planParents[parentId]!.integrationIntent, intent);

  const resumed = await coordinator.claim({
    expectedGeneration: state.generation,
    parentId,
    expectedRevision: state.planParents[parentId]!.revision,
    now: '2026-07-14T20:00:00.000Z',
    claim: parentClaim(),
  });
  assert.equal(resumed.planParents[parentId]!.state, 'integrating');
  assert.deepEqual(resumed.planParents[parentId]!.integrationIntent, intent);
});

test('parent cancellation atomically revokes every nonterminal child', async () => {
  const { coordinator, store, snapshot: initial, parentId } = await readyParent();
  const parent = initial.planParents[parentId]!;
  const publication = createMissionPublication({
    ownerId: parentId,
    repository: parent.repository,
    issueNumber: parent.issueNumber,
    fencingEpoch: 7,
    candidateCommit: '3'.repeat(40),
    candidateTree: '4'.repeat(40),
    baseSha: parent.baseCommit,
    validationSnapshot: '5'.repeat(40),
    validationReceiptIds: ['validation:cancel'],
    configHash: parent.configHash,
    branch: `codex/${parentId}`,
    baseBranch: 'main',
    marker: `<!-- codex-orchestrator:publication ${parentId} -->`,
    title: 'Cancel parent publication',
    body: `<!-- codex-orchestrator:publication ${parentId} -->\nCancel me`,
    managedLabels: ['agent:running', 'agent:review'],
    desiredLabels: ['agent:review'],
    terminalComment: `<!-- codex-orchestrator:publication-comment ${parentId} -->\nReady.`,
  });
  const snapshot = await store.mutate(initial.generation, (draft) => {
    draft.publications[publication.id] = {
      revision: publication.revision,
      value: publication as never,
    };
  });
  let cancelled = await coordinator.requestCancellation({
    expectedGeneration: snapshot.generation,
    parentId,
    expectedRevision: snapshot.planParents[parentId]!.revision,
    requestedAt: '2026-07-14T20:00:00.000Z',
    requestedBy: 'user',
  });
  assert.equal(cancelled.planParents[parentId]!.state, 'cancelling');
  assert.equal((cancelled.publications[publication.id]?.value as unknown as { state: string }).state, 'cancelled');
  for (const child of Object.values(cancelled.planParents[parentId]!.children)) {
    assert.equal(cancelled.missions[child.missionId]?.state, 'cancelling');
  }
  assert.equal(JSON.stringify(cancelled.planParents[parentId]).includes('blocked'), false);
  cancelled = await store.mutate(cancelled.generation, (draft) => {
    for (const child of Object.values(draft.planParents[parentId]!.children)) {
      draft.missions[child.missionId] = {
        ...draft.missions[child.missionId]!,
        revision: draft.missions[child.missionId]!.revision + 1,
        state: 'cancelled',
      };
    }
  });
  const completed = await coordinator.completeCancellation({
    expectedGeneration: cancelled.generation,
    parentId,
    expectedRevision: cancelled.planParents[parentId]!.revision,
  });
  assert.equal(completed.planParents[parentId]!.state, 'cancelled');
});

test('final checkpoint and Publication aggregate are linked in one generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-plan-parent-publication-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const coordinator = new MissionPlanParentCoordinator(store);
  const parent = createPlanParent({
    id: 'single-parent', repository: 'owner/repo', issueNumber: 7,
    configHash: `sha256:${'a'.repeat(64)}`, baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    graph: { specGate: 'wave-level', nodes: [node('foundation', [])], edges: [] },
  });
  let state = await coordinator.create({ expectedGeneration: 0, parent });
  state = await coordinator.linkNextWave({
    expectedGeneration: state.generation, parentId: parent.id, expectedRevision: 1,
  });
  const child = state.planParents[parent.id]!.children.foundation!;
  state = await store.mutate(state.generation, (draft) => {
    draft.missions[child.missionId] = {
      ...draft.missions[child.missionId]!, revision: 2, state: 'integration-ready',
    };
  });
  state = await coordinator.prepareWave({
    expectedGeneration: state.generation, parentId: parent.id,
    expectedRevision: state.planParents[parent.id]!.revision,
    descriptors: [descriptor('foundation')],
  });
  state = await coordinator.startIntegration({
    expectedGeneration: state.generation, parentId: parent.id,
    expectedRevision: state.planParents[parent.id]!.revision,
    intent: integrationIntent('foundation', 0, '1'.repeat(40), '3'.repeat(40)),
  });
  state = await coordinator.completeIntegration({
    expectedGeneration: state.generation, parentId: parent.id,
    expectedRevision: state.planParents[parent.id]!.revision,
    actionKey: 'integrate:0:foundation',
  });
  state = await coordinator.recordValidation({
    expectedGeneration: state.generation, parentId: parent.id,
    expectedRevision: state.planParents[parent.id]!.revision,
    receiptIds: ['validation:wave-0'],
  });
  state = await coordinator.checkpoint({
    expectedGeneration: state.generation, parentId: parent.id,
    expectedRevision: state.planParents[parent.id]!.revision,
    checkpoint: { commitSha: '3'.repeat(40), treeSha: '6'.repeat(40) },
  });
  assert.equal(state.planParents[parent.id]!.state, 'final-validating');
  const publication = createMissionPublication({
    ownerId: parent.id,
    repository: parent.repository,
    issueNumber: parent.issueNumber,
    fencingEpoch: 7,
    candidateCommit: '3'.repeat(40),
    candidateTree: '6'.repeat(40),
    baseSha: '1'.repeat(40),
    validationSnapshot: '7'.repeat(40),
    validationReceiptIds: ['validation:final'],
    configHash: `sha256:${'a'.repeat(64)}`,
    branch: 'codex/tree-single-parent',
    baseBranch: 'main',
    marker: '<!-- codex-orchestrator:publication single-parent -->',
    title: 'Plan parent 7',
    body: '<!-- codex-orchestrator:publication single-parent -->\nPlan parent review',
    managedLabels: ['agent:running', 'agent:review', 'agent:blocked'],
    desiredLabels: ['agent:review'],
    terminalComment: '<!-- codex-orchestrator:publication-comment single-parent -->\nReady.',
  });
  await assert.rejects(coordinator.preparePublication({
    expectedGeneration: state.generation, parentId: parent.id,
    expectedRevision: state.planParents[parent.id]!.revision,
    receiptIds: ['validation:final', 'validation:extra'],
    validationSnapshot: '7'.repeat(40),
    publication,
  }), /does not match final validation/);
  await assert.rejects(coordinator.preparePublication({
    expectedGeneration: state.generation, parentId: parent.id,
    expectedRevision: state.planParents[parent.id]!.revision,
    receiptIds: ['validation:final'],
    validationSnapshot: '8'.repeat(40),
    publication,
  }), /does not match final validation/);
  const published = await coordinator.preparePublication({
    expectedGeneration: state.generation, parentId: parent.id,
    expectedRevision: state.planParents[parent.id]!.revision,
    receiptIds: ['validation:final'],
    validationSnapshot: '7'.repeat(40),
    publication,
  });
  assert.equal(published.planParents[parent.id]!.state, 'publication-prepared');
  assert.equal(published.planParents[parent.id]!.publicationId, publication.id);
  assert.deepEqual(published.publications[publication.id]?.value, publication);

  const reviewed = await new MissionPublicationSaga(store, {
    branches: {
      observe: async () => ({ kind: 'present', commitSha: publication.candidateCommit }),
      push: async () => undefined,
      observeBase: async () => publication.baseSha,
    },
    pullRequests: {
      listAllByHeadBranch: async () => [{
        number: 77,
        nodeId: 'PR_parent',
        url: 'https://github.com/owner/repo/pull/77',
        state: 'OPEN',
        isDraft: true,
        headRefName: publication.branch,
        baseRefName: publication.baseBranch,
        title: publication.title,
        body: publication.body,
        authorAssociation: 'OWNER',
      }],
      createDraftPullRequest: async () => ({
        number: 77,
        url: 'https://github.com/owner/repo/pull/77',
        isDraft: true,
        headRefName: publication.branch,
        baseRefName: publication.baseBranch,
      }),
    },
    issues: {
      getLabels: async () => publication.desiredLabels,
      addLabels: async () => undefined,
      removeLabels: async () => undefined,
      listAllComments: async () => [{
        id: 'IC_parent',
        url: 'https://github.com/owner/repo/issues/227#issuecomment-parent',
        body: publication.terminalComment,
        createdAt: '2026-07-14T21:00:00.000Z',
        author: { login: 'runner' },
        authorAssociation: 'MEMBER',
      }],
      postComment: async () => undefined,
    },
    assertMutationFence: async () => undefined,
  }).run(publication.id);
  assert.equal(reviewed.publications[publication.id]?.revision, 6);
  assert.equal(reviewed.planParents[parent.id]!.state, 'completed');
});

async function readyParent() {
  const root = await mkdtemp(join(tmpdir(), 'mission-plan-parent-ready-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const coordinator = new MissionPlanParentCoordinator(store);
  const parent = createPlanParent({
    id: 'parent', repository: 'owner/repo', issueNumber: 1,
    configHash: `sha256:${'a'.repeat(64)}`, baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40), graph: graph(),
  });
  let snapshot = await coordinator.create({ expectedGeneration: 0, parent });
  snapshot = await coordinator.linkNextWave({
    expectedGeneration: snapshot.generation, parentId: parent.id, expectedRevision: 1,
  });
  for (const stableId of ['foundation', 'sibling']) {
    const child = snapshot.planParents[parent.id]!.children[stableId]!;
    snapshot = await store.mutate(snapshot.generation, (draft) => {
      draft.missions[child.missionId] = {
        ...draft.missions[child.missionId]!,
        revision: draft.missions[child.missionId]!.revision + 1,
        state: 'integration-ready',
      };
    });
  }
  return { coordinator, store, snapshot, parentId: parent.id };
}

function graph() {
  return {
    specGate: 'wave-level' as const,
    nodes: [
      node('foundation', []), node('sibling', []), node('dependent', ['foundation']),
    ],
    edges: [{ from: 'foundation', to: 'dependent', reason: 'uses foundation output' }],
  };
}

function node(stableId: string, dependsOn: string[]) {
  return {
    stableId, title: stableId, body: `${stableId} body`, afkHitl: 'afk' as const,
    ownershipScope: [`src/${stableId}.ts`], dependsOn, verification: [`test ${stableId}`],
  };
}

function descriptor(stableId: string) {
  return {
    stableId,
    childCommit: stableId === 'foundation' ? 'a'.repeat(40) : 'b'.repeat(40),
    childTree: stableId === 'foundation' ? 'c'.repeat(40) : 'd'.repeat(40),
    baseCheckpointCommit: '1'.repeat(40),
    configHash: `sha256:${'a'.repeat(64)}`,
    executorVersion: 'mission-v1',
    changedPaths: [`src/${stableId}.ts`],
    validationReceiptIds: [`validation:${stableId}`],
    reservationFingerprint: `sha256:${(stableId === 'foundation' ? 'e' : 'f').repeat(64)}`,
  };
}

function integrationIntent(stableId: string, cursor: number, oldCommit: string, newCommit: string) {
  return {
    version: 1 as const,
    actionKey: `integrate:0:${stableId}`,
    wave: 0,
    cursor,
    stableId,
    expectedOldCommit: oldCommit,
    expectedNewCommit: newCommit,
    expectedNewTree: stableId === 'foundation' ? '6'.repeat(40) : '5'.repeat(40),
  };
}

function parentClaim() {
  return {
    version: 1 as const,
    token: 'parent-claim',
    daemonId: 'daemon-main',
    hostId: 'host-a',
    bootNonce: 'boot-a',
    fencingEpoch: 9,
    claimedAt: '2026-07-14T20:00:00.000Z',
    leaseUntil: '2026-07-14T20:05:00.000Z',
    processes: [],
  };
}

function parentEvent(type: (typeof planParentEventTypes)[number]): PlanParentEvent {
  switch (type) {
    case 'wave-prepared': return { type, descriptors: [descriptor('foundation'), descriptor('sibling')] };
    case 'integration-started': return {
      type, intent: integrationIntent('foundation', 0, '1'.repeat(40), '3'.repeat(40)),
    };
    case 'integration-completed': return { type, actionKey: 'integrate:0:foundation' };
    case 'integration-conflict': return { type, recoveryMissionId: 'recovery' };
    case 'recovery-ready': return { type, descriptor: descriptor('foundation') };
    case 'validation-failed': return {
      type, recoveryMissionId: 'validation-recovery', recoveryTarget: 'wave-validating',
    };
    case 'validation-passed': return { type, receiptIds: ['validation'] };
    case 'checkpoint-committed': return {
      type, checkpoint: { commitSha: '1'.repeat(40), treeSha: '2'.repeat(40) },
    };
    case 'final-validation-passed': return {
      type, receiptIds: ['validation'], publicationId: 'publication',
    };
    case 'label-transition-recorded': return {
      type, transition: { stableId: 'foundation', from: 'running', to: 'review', receiptId: 'label-1' },
    };
    case 'transient-failure': return {
      type, resumeTarget: 'wave-running', actionKey: 'child:foundation',
      nextEligibleAt: '2026-07-14T20:00:00.000Z', reason: 'retry',
      requiredPredicate: 'child ready',
    };
    case 'resume-eligible': return { type, now: '2026-07-14T20:00:00.000Z' };
    case 'cancel-requested': return {
      type, cancellation: { requestedAt: '2026-07-14T20:00:00.000Z', requestedBy: 'user' },
    };
    case 'cancellation-integration-reconciled': return { type, applied: true };
    default: return { type };
  }
}
