import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertMissionPublicationRecord,
  createMissionPublication,
  listEligiblePublications,
  MissionPublicationCoordinator,
  MissionPublicationSaga,
  publicationScheduleKey,
  publicationStates,
  transitionMissionPublication,
  type MissionPublicationRecord,
  type MissionPublicationSagaDependencies,
} from '../src/runner/mission-publication.js';
import { MissionStateStore } from '../src/runner/mission-state-store.js';
import type { JsonValue } from '../src/runner/mission-state-store.js';
import {
  createMissionApplyPermit,
  missionApplyPermitFingerprint,
} from '../src/runner/mission-git-contracts.js';
import { mkdtemp } from './mission-test-temp.js';

test('Scoped Mission and Publication are linked in one atomic generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-scoped-link-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication = publicationFixture();
  const apply = scopedApplyArtifacts(publication);
  let snapshot = await store.mutate(0, (draft) => {
    draft.missions[publication.ownerId] = {
      id: publication.ownerId,
      revision: 3,
      state: 'candidate-ready',
      actionKey: apply.permit.actionKey,
      fencingEpoch: publication.fencingEpoch,
      applyPermit: apply.permit,
      applyIntent: apply.intent,
      applyReceipt: apply.receipt,
    };
  });

  snapshot = await new MissionPublicationCoordinator(store).prepare({
    expectedGeneration: snapshot.generation,
    missionId: publication.ownerId,
    expectedRevision: 3,
    fencingEpoch: publication.fencingEpoch,
    publication,
  });

  assert.equal(snapshot.missions[publication.ownerId]?.state, 'publication-prepared');
  assert.deepEqual(snapshot.publications[publication.id]?.value, publication);
});

test('Publication persists push intent before mutation and reconciles a lost push response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-push-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication = publicationFixture();
  let remoteCommit: string | undefined;
  let pushCalls = 0;
  const dependencies: MissionPublicationSagaDependencies = {
    branches: {
      observe: async () => remoteCommit === undefined
        ? { kind: 'absent' as const }
        : { kind: 'present' as const, commitSha: remoteCommit },
      push: async (input) => {
        pushCalls += 1;
        remoteCommit = input.candidateCommit;
        throw new Error('lost push response');
      },
      observeBase: async () => publication.baseSha,
    },
    pullRequests: {
      listAllByHeadBranch: async () => [],
      createDraftPullRequest: async () => expectedPullRequest(),
    },
    issues: {
      getLabels: async () => [],
      addLabels: async () => undefined,
      removeLabels: async () => undefined,
      listAllComments: async () => [],
      postComment: async () => undefined,
    },
    assertMutationFence: async () => undefined,
    now: () => '2026-07-14T21:00:00.000Z',
  };
  const saga = new MissionPublicationSaga(store, dependencies);
  await store.mutate(0, (draft) => {
    draft.missions[publication.ownerId] = {
      id: publication.ownerId, revision: 1, state: 'publication-prepared',
    };
    draft.publications[publication.id] = {
      revision: publication.revision,
      value: publication as unknown as JsonValue,
    };
  });

  const interrupted = await saga.run(publication.id);
  assert.equal((interrupted.publications[publication.id]?.value as unknown as MissionPublicationRecord).state, 'resumable');
  assert.equal(pushCalls, 1);

  const recoveredSaga = new MissionPublicationSaga(store, {
    ...dependencies,
    branches: {
      ...dependencies.branches,
      push: async () => { pushCalls += 1; },
    },
  });
  await recoveredSaga.resume({ publicationId: publication.id, now: '2026-07-14T21:00:01.000Z' });
  await recoveredSaga.reconcileBranch(publication.id);
  const recovered = await store.load();
  assert.equal((recovered.publications[publication.id]?.value as unknown as MissionPublicationRecord).state, 'pushed');
  assert.equal(pushCalls, 1);
});

test('Publication reconciles a lost draft PR response without creating a duplicate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-pr-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication = publicationFixture();
  const pullRequests: ReturnType<typeof expectedPullRequest>[] = [];
  let createCalls = 0;
  const dependencies: MissionPublicationSagaDependencies = {
    branches: {
      observe: async () => ({ kind: 'present', commitSha: publication.candidateCommit }),
      push: async () => { throw new Error('push must not run'); },
      observeBase: async () => publication.baseSha,
    },
    pullRequests: {
      listAllByHeadBranch: async () => structuredClone(pullRequests),
      createDraftPullRequest: async () => {
        createCalls += 1;
        pullRequests.push(expectedPullRequest());
        throw new Error('lost draft PR response');
      },
    },
    issues: {
      getLabels: async () => publication.desiredLabels,
      addLabels: async () => undefined,
      removeLabels: async () => undefined,
      listAllComments: async () => [],
      postComment: async () => undefined,
    },
    assertMutationFence: async () => undefined,
    now: () => '2026-07-14T21:00:00.000Z',
  };
  await storePublication(store, publication);

  let snapshot = await new MissionPublicationSaga(store, dependencies).run(publication.id);
  assert.equal(publicationRecord(snapshot, publication.id).state, 'resumable');
  assert.equal(createCalls, 1);

  const recovered = new MissionPublicationSaga(store, {
    ...dependencies,
    pullRequests: {
      ...dependencies.pullRequests,
      createDraftPullRequest: async () => { createCalls += 1; return expectedPullRequest(); },
    },
  });
  await recovered.resume({ publicationId: publication.id, now: '2026-07-14T21:00:01.000Z' });
  await recovered.reconcilePullRequest(publication.id);
  snapshot = await store.load();
  assert.equal(publicationRecord(snapshot, publication.id).state, 'pr-confirmed');
  assert.equal(publicationRecord(snapshot, publication.id).pullRequest?.nodeId, 'PR_expected');
  assert.equal(createCalls, 1);
});

test('Publication reconciles lost label responses and preserves unmanaged labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-labels-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication: MissionPublicationRecord = {
    ...publicationFixture(),
    revision: 5,
    state: 'pr-confirmed',
    baseObservedSha: '1'.repeat(40),
    pullRequest: expectedPullRequest(),
  };
  const labels = new Set(['human:keep', 'agent:running']);
  let addCalls = 0;
  let removeCalls = 0;
  const fenceInputs: Array<{ publicationId: string; ownerId: string; repository: string; fencingEpoch: number; actionKey: string }> = [];
  let loseAddResponse = true;
  let loseRemoveResponse = true;
  const dependencies: MissionPublicationSagaDependencies = {
    branches: {
      observe: async () => ({ kind: 'present', commitSha: publication.candidateCommit }),
      push: async () => undefined,
      observeBase: async () => publication.baseSha,
    },
    pullRequests: {
      listAllByHeadBranch: async () => [expectedPullRequest()],
      createDraftPullRequest: async () => expectedPullRequest(),
    },
    issues: {
      getLabels: async () => [...labels],
      addLabels: async (_issueNumber, added) => {
        addCalls += 1;
        added.forEach((label) => labels.add(label));
        if (loseAddResponse) {
          loseAddResponse = false;
          throw new Error('lost add-label response');
        }
      },
      removeLabels: async (_issueNumber, removed) => {
        removeCalls += 1;
        removed.forEach((label) => labels.delete(label));
        if (loseRemoveResponse) {
          loseRemoveResponse = false;
          throw new Error('lost remove-label response');
        }
      },
      listAllComments: async () => [],
      postComment: async () => undefined,
    },
    assertMutationFence: async (input) => { fenceInputs.push(input); },
    now: () => '2026-07-14T21:00:00.000Z',
  };
  await storePublication(store, publication);
  const saga = new MissionPublicationSaga(store, dependencies);

  await saga.run(publication.id);
  assert.equal(publicationRecord(await store.load(), publication.id).state, 'resumable');

  await saga.resume({ publicationId: publication.id, now: '2026-07-14T21:00:01.000Z' });
  await saga.reconcileLabels(publication.id);
  assert.equal(publicationRecord(await store.load(), publication.id).state, 'resumable');

  await saga.resume({ publicationId: publication.id, now: '2026-07-14T21:00:01.000Z' });
  await saga.reconcileLabels(publication.id);
  assert.equal(publicationRecord(await store.load(), publication.id).state, 'labels-confirmed');
  assert.deepEqual([...labels].sort(), ['agent:review', 'human:keep']);
  assert.equal(addCalls, 1);
  assert.equal(removeCalls, 1);
  assert.deepEqual(fenceInputs.map((input) => ({
    publicationId: input.publicationId,
    ownerId: input.ownerId,
    repository: input.repository,
    fencingEpoch: input.fencingEpoch,
    actionKey: input.actionKey.split(':').at(-1),
  })), [
    { publicationId: publication.id, ownerId: publication.ownerId, repository: publication.repository, fencingEpoch: 7, actionKey: 'add-labels' },
    { publicationId: publication.id, ownerId: publication.ownerId, repository: publication.repository, fencingEpoch: 7, actionKey: 'remove-labels' },
  ]);
});

test('Publication reconciles a lost terminal comment response and completes its owner atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-comment-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication: MissionPublicationRecord = {
    ...publicationFixture(),
    revision: 7,
    state: 'labels-confirmed',
    baseObservedSha: '1'.repeat(40),
    pullRequest: expectedPullRequest(),
  };
  const comments: ReturnType<typeof expectedComment>[] = [];
  let postCalls = 0;
  const dependencies: MissionPublicationSagaDependencies = {
    branches: {
      observe: async () => ({ kind: 'present', commitSha: publication.candidateCommit }),
      push: async () => undefined,
      observeBase: async () => publication.baseSha,
    },
    pullRequests: {
      listAllByHeadBranch: async () => [expectedPullRequest()],
      createDraftPullRequest: async () => expectedPullRequest(),
    },
    issues: {
      getLabels: async () => publication.desiredLabels,
      addLabels: async () => undefined,
      removeLabels: async () => undefined,
      listAllComments: async () => structuredClone(comments),
      postComment: async (_issueNumber, body) => {
        postCalls += 1;
        comments.push(expectedComment(body));
        throw new Error('lost comment response');
      },
    },
    assertMutationFence: async () => undefined,
    now: () => '2026-07-14T21:00:00.000Z',
  };
  await storePublication(store, publication);
  const saga = new MissionPublicationSaga(store, dependencies);

  let snapshot = await saga.run(publication.id);
  assert.equal(publicationRecord(snapshot, publication.id).state, 'resumable');
  assert.equal(snapshot.missions[publication.ownerId]?.state, 'resumable');

  await new MissionPublicationSaga(store, {
    ...dependencies,
    issues: {
      ...dependencies.issues,
      postComment: async () => { postCalls += 1; },
    },
  }).resume({ publicationId: publication.id, now: '2026-07-14T21:00:01.000Z' });
  await new MissionPublicationSaga(store, {
    ...dependencies,
    issues: {
      ...dependencies.issues,
      postComment: async () => { postCalls += 1; },
    },
  }).reconcileComment(publication.id);
  snapshot = await store.load();
  assert.equal(publicationRecord(snapshot, publication.id).state, 'review-ready');
  assert.equal(snapshot.missions[publication.ownerId]?.state, 'completed');
  assert.equal(postCalls, 1);
  assert.equal(comments.length, 1);
});

test('Publication transient failures persist an exact indexed resume target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-resume-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication: MissionPublicationRecord = {
    ...publicationFixture(), revision: 2, state: 'push-intent',
  };
  await storePublication(store, publication);
  const saga = new MissionPublicationSaga(store, inertDependencies(publication));

  let snapshot = await saga.defer({
    publicationId: publication.id,
    nextEligibleAt: '2026-07-14T21:00:00.000Z',
    actionKey: 'publication:push',
  });
  assert.equal(publicationRecord(snapshot, publication.id).state, 'resumable');
  assert.equal(snapshot.nextEligibleAt[publicationScheduleKey(publication.id)], '2026-07-14T21:00:00.000Z');
  assert.deepEqual(listEligiblePublications(snapshot, '2026-07-14T21:00:00.000Z'), [{
    publicationId: publication.id,
    revision: 3,
    nextEligibleAt: '2026-07-14T21:00:00.000Z',
    actionKey: 'publication:push',
  }]);

  await assert.rejects(saga.resume({
    publicationId: publication.id,
    now: '2026-07-14T20:59:59.000Z',
  }), /not eligible/);
  snapshot = await saga.resume({
    publicationId: publication.id,
    now: '2026-07-14T21:00:00.000Z',
  });
  assert.equal(publicationRecord(snapshot, publication.id).state, 'push-intent');
  assert.equal(snapshot.nextEligibleAt[publicationScheduleKey(publication.id)], '2026-07-14T21:00:00.000Z');
  assert.deepEqual(listEligiblePublications(snapshot, '2026-07-14T21:00:00.000Z'), [{
    publicationId: publication.id,
    revision: 4,
    nextEligibleAt: '2026-07-14T21:00:00.000Z',
    actionKey: 'publication:push',
  }]);

  const restarted = new MissionPublicationSaga(store, inertDependencies(publication));
  snapshot = await restarted.resume({
    publicationId: publication.id,
    now: '2026-07-14T21:00:00.000Z',
  });
  assert.equal(publicationRecord(snapshot, publication.id).revision, 4);
  await assert.rejects(restarted.defer({
    publicationId: publication.id,
    nextEligibleAt: '2026-07-14T21:00:01.000Z',
    actionKey: 'publication:replacement',
  }), /already has scheduled recovery/);
  snapshot = await restarted.reconcileBranch(publication.id);
  assert.equal(publicationRecord(snapshot, publication.id).state, 'pushed');
  assert.equal(snapshot.nextEligibleAt[publicationScheduleKey(publication.id)], undefined);
});

test('Publication rejects re-deferral without changing its scheduled owner recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-redefer-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication = publicationFixture();
  const saga = new MissionPublicationSaga(store, inertDependencies(publication));
  await storePublication(store, publication);
  const deferred = await saga.defer({
    publicationId: publication.id,
    nextEligibleAt: '2026-07-14T21:00:00.000Z',
    actionKey: 'publication:first',
  });

  await assert.rejects(saga.defer({
    publicationId: publication.id,
    nextEligibleAt: '2026-07-14T21:00:01.000Z',
    actionKey: 'publication:second',
  }), /already resumable/);

  const unchanged = await store.load();
  assert.deepEqual(unchanged, deferred);
});

test('Publication treats base advancement as warning and missing base as external input', () => {
  const pushed: MissionPublicationRecord = {
    ...publicationFixture(), revision: 2, state: 'pushed',
  };
  const advanced = transitionMissionPublication(pushed, {
    type: 'base-observed', observation: { kind: 'present', commitSha: '9'.repeat(40) },
  });
  assert.equal(advanced.state, 'pushed');
  assert.equal(advanced.baseObservedSha, '9'.repeat(40));
  assert.deepEqual(advanced.warnings, [
    `Base branch advanced from ${'1'.repeat(40)} to ${'9'.repeat(40)} after validation.`,
  ]);
  assert.equal(transitionMissionPublication(pushed, {
    type: 'base-observed', observation: { kind: 'absent' },
  }).state, 'external-input-required');
});

test('Publication cancellation atomically cancels its owning Mission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-cancel-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication = publicationFixture();
  await storePublication(store, publication);

  const snapshot = await new MissionPublicationSaga(
    store,
    inertDependencies(publication),
  ).cancel(publication.id);

  assert.equal(publicationRecord(snapshot, publication.id).state, 'cancelled');
  assert.equal(snapshot.missions[publication.ownerId]?.state, 'cancelled');
});

test('Publication safety-stops branch drift before creating a draft PR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-branch-drift-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication: MissionPublicationRecord = {
    ...publicationFixture(),
    revision: 4,
    state: 'pr-create-intent',
    baseObservedSha: '1'.repeat(40),
  };
  let createCalls = 0;
  const dependencies = inertDependencies(publication);
  dependencies.branches.observe = async () => ({ kind: 'present', commitSha: '8'.repeat(40) });
  dependencies.pullRequests.createDraftPullRequest = async () => { createCalls += 1; return expectedPullRequest(); };
  await storePublication(store, publication);

  const snapshot = await new MissionPublicationSaga(store, dependencies)
    .reconcilePullRequest(publication.id);

  assert.equal(publicationRecord(snapshot, publication.id).state, 'safety-stop');
  assert.equal(snapshot.missions[publication.ownerId]?.state, 'safety-stop');
  assert.equal(createCalls, 0);
});

test('Publication safety-stops a recreated marker PR before mutating labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-pr-drift-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication: MissionPublicationRecord = {
    ...publicationFixture(),
    revision: 5,
    state: 'pr-confirmed',
    baseObservedSha: '1'.repeat(40),
    pullRequest: expectedPullRequest(),
  };
  let labelMutations = 0;
  const dependencies = inertDependencies(publication);
  dependencies.pullRequests.listAllByHeadBranch = async () => [{
    ...expectedPullRequest(), number: 88, nodeId: 'PR_recreated', authorAssociation: 'NONE',
  }];
  dependencies.issues.addLabels = async () => { labelMutations += 1; };
  dependencies.issues.removeLabels = async () => { labelMutations += 1; };
  await storePublication(store, publication);

  const snapshot = await new MissionPublicationSaga(store, dependencies)
    .reconcileLabels(publication.id);

  assert.equal(publicationRecord(snapshot, publication.id).state, 'safety-stop');
  assert.equal(snapshot.missions[publication.ownerId]?.state, 'safety-stop');
  assert.equal(labelMutations, 0);
});

test('Publication precedence safety-stops immutable conflicts before mutable PR mismatches', () => {
  const pushed = {
    ...publicationFixture(),
    revision: 2,
    state: 'pushed' as const,
  };
  const duplicate = transitionMissionPublication(pushed, {
    type: 'pull-requests-observed',
    pullRequests: [expectedPullRequest(), { ...expectedPullRequest(), number: 78, nodeId: 'PR_other' }],
  });
  assert.equal(duplicate.state, 'safety-stop');

  const edited = transitionMissionPublication(pushed, {
    type: 'pull-requests-observed',
    pullRequests: [{ ...expectedPullRequest(), title: 'Maintainer title' }],
  });
  assert.equal(edited.state, 'external-input-required');
});

test('Publication preserves human labels and reaches one exact terminal comment', () => {
  let record: MissionPublicationRecord = {
    ...publicationFixture(), revision: 4, state: 'pr-confirmed',
    baseObservedSha: '1'.repeat(40),
    pullRequest: expectedPullRequest(),
  };
  assert.doesNotThrow(() => assertMissionPublicationRecord(record));
  record = transitionMissionPublication(record, {
    type: 'labels-observed', labels: ['human:keep', 'agent:running'],
  });
  assert.equal(record.state, 'labels-intent');
  assert.deepEqual(record.labelMutation, {
    add: ['agent:review'],
    remove: ['agent:running'],
    preserve: ['human:keep'],
  });
  record = transitionMissionPublication(record, {
    type: 'labels-observed', labels: ['human:keep', 'agent:review'],
  });
  assert.equal(record.state, 'labels-confirmed');
  record = transitionMissionPublication(record, {
    type: 'comments-observed', comments: [],
  });
  assert.equal(record.state, 'comment-intent');
  record = transitionMissionPublication(record, {
    type: 'comments-observed',
    comments: [{ id: 'comment-1', body: record.terminalComment }],
  });
  assert.equal(record.state, 'review-ready');
  assert.equal(publicationStates.includes('blocked' as never), false);
});

test('Publication aggregate validation rejects impossible phase artifacts', () => {
  assert.throws(() => assertMissionPublicationRecord({
    ...publicationFixture(), revision: 7, state: 'labels-confirmed',
  }), /labels-confirmed requires a pinned pull request/);
  assert.throws(() => assertMissionPublicationRecord({
    ...publicationFixture(),
    revision: 6,
    state: 'labels-intent',
    baseObservedSha: '1'.repeat(40),
    pullRequest: expectedPullRequest(),
  }), /labels-intent requires labelMutation/);
});

test('Publication never reissues an ambiguous PR or comment while visibility is delayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-eventual-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication: MissionPublicationRecord = {
    ...publicationFixture(), revision: 4, state: 'pr-create-intent',
    baseObservedSha: '1'.repeat(40),
  };
  let visible = false;
  let createCalls = 0;
  const dependencies = inertDependencies(publication);
  dependencies.pullRequests.listAllByHeadBranch = async () => visible ? [expectedPullRequest()] : [];
  dependencies.pullRequests.createDraftPullRequest = async () => { createCalls += 1; return expectedPullRequest(); };
  dependencies.now = () => '2026-07-14T21:00:00.000Z';
  await storePublication(store, publication);

  let snapshot = await new MissionPublicationSaga(store, dependencies).reconcilePullRequest(publication.id);
  assert.equal(publicationRecord(snapshot, publication.id).state, 'resumable');
  assert.equal(createCalls, 1);
  visible = true;
  snapshot = await new MissionPublicationSaga(store, dependencies).resume({
    publicationId: publication.id, now: '2026-07-14T21:00:01.000Z',
  });
  snapshot = await new MissionPublicationSaga(store, dependencies).reconcilePullRequest(publication.id);
  assert.equal(publicationRecord(snapshot, publication.id).state, 'pr-confirmed');
  assert.equal(createCalls, 1);

  const commentRoot = await mkdtemp(join(tmpdir(), 'mission-publication-eventual-comment-'));
  const commentStore = new MissionStateStore(commentRoot, '.codex-orchestrator/state');
  const commentPublication: MissionPublicationRecord = {
    ...publicationFixture(), revision: 7, state: 'comment-intent', baseObservedSha: '1'.repeat(40),
    pullRequest: expectedPullRequest(),
  };
  let commentVisible = false;
  let commentCalls = 0;
  const commentDependencies = inertDependencies(commentPublication);
  commentDependencies.pullRequests.listAllByHeadBranch = async () => [expectedPullRequest()];
  commentDependencies.issues.listAllComments = async () => commentVisible
    ? [expectedComment(commentPublication.terminalComment)] : [];
  commentDependencies.issues.postComment = async () => { commentCalls += 1; };
  commentDependencies.now = () => '2026-07-14T21:00:00.000Z';
  await storePublication(commentStore, commentPublication);
  snapshot = await new MissionPublicationSaga(commentStore, commentDependencies)
    .reconcileComment(commentPublication.id);
  assert.equal(publicationRecord(snapshot, commentPublication.id).state, 'resumable');
  commentVisible = true;
  const commentSaga = new MissionPublicationSaga(commentStore, commentDependencies);
  await commentSaga.resume({ publicationId: commentPublication.id, now: '2026-07-14T21:00:01.000Z' });
  snapshot = await commentSaga.reconcileComment(commentPublication.id);
  assert.equal(publicationRecord(snapshot, commentPublication.id).state, 'review-ready');
  assert.equal(commentCalls, 1);
});

test('Publication counts only full postcondition enumerations after an ambiguous request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-observation-count-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication: MissionPublicationRecord = {
    ...publicationFixture(), revision: 4, state: 'pr-create-intent',
    baseObservedSha: '1'.repeat(40),
  };
  let createCalls = 0;
  const dependencies = inertDependencies(publication);
  dependencies.pullRequests.listAllByHeadBranch = async () => [];
  dependencies.pullRequests.createDraftPullRequest = async () => {
    createCalls += 1;
    throw new Error('lost draft PR response');
  };
  dependencies.now = () => '2026-07-14T21:00:00.000Z';
  await storePublication(store, publication);
  const saga = new MissionPublicationSaga(store, dependencies);

  let snapshot = await saga.reconcilePullRequest(publication.id);
  assert.equal(publicationRecord(snapshot, publication.id).mutationAttempt?.observationAttempts, 0);
  for (let observation = 1; observation <= 3; observation += 1) {
    const scheduled = publicationRecord(snapshot, publication.id);
    snapshot = await saga.resume({ publicationId: publication.id, now: scheduled.nextEligibleAt! });
    snapshot = await saga.reconcilePullRequest(publication.id);
    const current = publicationRecord(snapshot, publication.id);
    if (observation < 3) {
      assert.equal(current.state, 'resumable');
      assert.equal(current.mutationAttempt?.observationAttempts, observation);
    } else {
      assert.equal(current.state, 'external-input-required');
    }
  }
  assert.equal(createCalls, 1);
});

test('Publication serializes concurrent non-idempotent PR creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-concurrent-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication: MissionPublicationRecord = {
    ...publicationFixture(), revision: 4, state: 'pr-create-intent',
    baseObservedSha: '1'.repeat(40),
  };
  let createCalls = 0;
  const dependencies = inertDependencies(publication);
  dependencies.pullRequests.listAllByHeadBranch = async () => [];
  dependencies.pullRequests.createDraftPullRequest = async () => {
    createCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return expectedPullRequest();
  };
  dependencies.now = () => '2026-07-14T21:00:00.000Z';
  await storePublication(store, publication);

  await Promise.all([
    new MissionPublicationSaga(store, dependencies).reconcilePullRequest(publication.id),
    new MissionPublicationSaga(store, dependencies).reconcilePullRequest(publication.id),
  ]);
  assert.equal(createCalls, 1);
});

test('Publication adapter failures atomically schedule Publication and owner recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-auto-resume-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication = publicationFixture();
  const dependencies = inertDependencies(publication);
  dependencies.branches.observe = async () => { throw new Error('temporary GitHub outage'); };
  dependencies.now = () => '2026-07-14T21:00:00.000Z';
  await storePublication(store, publication);

  const snapshot = await new MissionPublicationSaga(store, dependencies).reconcileBranch(publication.id);
  const stored = publicationRecord(snapshot, publication.id);
  assert.equal(stored.state, 'resumable');
  assert.equal(stored.resumeTarget, 'prepared');
  assert.equal(snapshot.nextEligibleAt[publicationScheduleKey(publication.id)], stored.nextEligibleAt);
  assert.equal(snapshot.missions[publication.ownerId]?.state, 'resumable');
  assert.equal(snapshot.missions[publication.ownerId]?.resumeTarget, 'publication-prepared');
});

test('Publication fails closed when recovery scheduling exhausts CAS retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-cas-exhaustion-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication = publicationFixture();
  await storePublication(store, publication);
  const dependencies = inertDependencies(publication);
  dependencies.branches.observe = async () => { throw new Error('temporary GitHub outage'); };
  let conflicts = 0;
  Object.defineProperty(store, 'mutate', {
    value: async () => {
      conflicts += 1;
      throw new Error('Mission state generation conflict.');
    },
  });

  await assert.rejects(
    new MissionPublicationSaga(store, dependencies).reconcileBranch(publication.id),
    /could not persist recovery after 4 conflicts/,
  );
  assert.equal(conflicts, 4);
});

test('Publication classifies permanent authority failures without retrying the mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-publication-authority-'));
  const store = new MissionStateStore(root, '.codex-orchestrator/state');
  const publication = publicationFixture();
  const dependencies = inertDependencies(publication);
  dependencies.branches.observe = async () => { throw new Error('403 Forbidden'); };
  await storePublication(store, publication);
  const snapshot = await new MissionPublicationSaga(store, dependencies).reconcileBranch(publication.id);
  assert.equal(publicationRecord(snapshot, publication.id).state, 'external-input-required');
  assert.equal(snapshot.nextEligibleAt[publicationScheduleKey(publication.id)], undefined);
});

test('Publication defer and cancellation remain persistable from every active phase', () => {
  const phases: MissionPublicationRecord[] = [
    publicationFixture(),
    { ...publicationFixture(), revision: 2, state: 'push-intent' },
    { ...publicationFixture(), revision: 2, state: 'pushed', baseObservedSha: '1'.repeat(40) },
    { ...publicationFixture(), revision: 3, state: 'pr-create-intent', baseObservedSha: '1'.repeat(40) },
    { ...publicationFixture(), revision: 4, state: 'pr-confirmed', baseObservedSha: '1'.repeat(40), pullRequest: expectedPullRequest() },
    { ...publicationFixture(), revision: 5, state: 'labels-intent', baseObservedSha: '1'.repeat(40), pullRequest: expectedPullRequest(), labelMutation: { add: ['agent:review'], remove: [], preserve: [] } },
    { ...publicationFixture(), revision: 6, state: 'labels-confirmed', baseObservedSha: '1'.repeat(40), pullRequest: expectedPullRequest() },
    { ...publicationFixture(), revision: 7, state: 'comment-intent', baseObservedSha: '1'.repeat(40), pullRequest: expectedPullRequest() },
  ];
  for (const phase of phases) {
    const deferred = transitionMissionPublication(phase, {
      type: 'transient-failure', nextEligibleAt: '2026-07-14T21:00:00.000Z', actionKey: `publication:${phase.state}`,
    });
    assert.doesNotThrow(() => assertMissionPublicationRecord(deferred), phase.state);
    const cancelled = transitionMissionPublication(deferred, { type: 'cancel-requested' });
    assert.doesNotThrow(() => assertMissionPublicationRecord(cancelled), `${phase.state}:cancel`);
  }
});

test('Publication distinguishes safe pre-dispatch retry from ambiguous dispatched observation', () => {
  const cases: Array<{ record: MissionPublicationRecord; kind: 'push' | 'create-pr' | 'add-labels' | 'remove-labels' | 'post-comment'; labels?: string[] }> = [
    { record: { ...publicationFixture(), revision: 2, state: 'push-intent' }, kind: 'push' },
    { record: { ...publicationFixture(), revision: 3, state: 'pr-create-intent', baseObservedSha: '1'.repeat(40) }, kind: 'create-pr' },
    { record: { ...publicationFixture(), revision: 5, state: 'labels-intent', baseObservedSha: '1'.repeat(40), pullRequest: expectedPullRequest(), labelMutation: { add: ['agent:review'], remove: [], preserve: [] } }, kind: 'add-labels', labels: ['agent:review'] },
    { record: { ...publicationFixture(), revision: 5, state: 'labels-intent', baseObservedSha: '1'.repeat(40), pullRequest: expectedPullRequest(), labelMutation: { add: [], remove: ['agent:running'], preserve: [] } }, kind: 'remove-labels', labels: ['agent:running'] },
    { record: { ...publicationFixture(), revision: 7, state: 'comment-intent', baseObservedSha: '1'.repeat(40), pullRequest: expectedPullRequest() }, kind: 'post-comment' },
  ];
  for (const item of cases) {
    const actionKey = `publication:${item.record.id}:${item.kind}`;
    const prepared = transitionMissionPublication(item.record, {
      type: 'mutation-attempted', attempt: { kind: item.kind, actionKey, ...(item.labels ? { labels: item.labels } : {}) },
    });
    const safeRetry = transitionMissionPublication(prepared, {
      type: 'transient-failure', nextEligibleAt: '2026-07-14T21:00:00.000Z', actionKey,
    });
    assert.equal(safeRetry.mutationAttempt, undefined, `${item.kind}:pre-dispatch`);
    const dispatched = transitionMissionPublication(prepared, { type: 'mutation-dispatched', actionKey });
    const ambiguous = transitionMissionPublication(dispatched, {
      type: 'transient-failure', nextEligibleAt: '2026-07-14T21:00:00.000Z', actionKey,
      postconditionObserved: true,
    });
    assert.equal(ambiguous.mutationAttempt?.stage, 'dispatched', `${item.kind}:dispatched`);
    const cancelled = transitionMissionPublication(ambiguous, { type: 'cancel-requested' });
    assert.equal(cancelled.mutationAttempt, undefined, `${item.kind}:cancelled`);
    assert.doesNotThrow(() => assertMissionPublicationRecord(cancelled));
    let bounded = dispatched;
    for (let observation = 0; observation < 3; observation += 1) {
      bounded = transitionMissionPublication(bounded, {
        type: 'transient-failure',
        nextEligibleAt: `2026-07-14T21:00:0${observation}.000Z`,
        actionKey,
        postconditionObserved: true,
      });
    }
    assert.equal(bounded.state, 'external-input-required', `${item.kind}:bounded`);
    assert.equal(bounded.mutationAttempt, undefined, `${item.kind}:bounded-attempt`);
    assert.doesNotThrow(() => assertMissionPublicationRecord(bounded));
  }
});

test('Publication clears dispatched attempts on every phase-owned terminal observation', () => {
  const push = transitionMissionPublication(
    transitionMissionPublication({ ...publicationFixture(), revision: 2, state: 'push-intent' }, {
      type: 'mutation-attempted', attempt: { kind: 'push', actionKey: `publication:${publicationFixture().id}:push` },
    }), { type: 'mutation-dispatched', actionKey: `publication:${publicationFixture().id}:push` },
  );
  const pushStopped = transitionMissionPublication(push, {
    type: 'branch-observed', observation: { kind: 'other', commitSha: '8'.repeat(40) },
  });
  assert.equal(pushStopped.state, 'safety-stop');
  assert.equal(pushStopped.mutationAttempt, undefined);

  const prBase: MissionPublicationRecord = {
    ...publicationFixture(), revision: 3, state: 'pr-create-intent', baseObservedSha: '1'.repeat(40),
  };
  const prAction = `publication:${prBase.id}:create-pr`;
  const pr = transitionMissionPublication(transitionMissionPublication(prBase, {
    type: 'mutation-attempted', attempt: { kind: 'create-pr', actionKey: prAction },
  }), { type: 'mutation-dispatched', actionKey: prAction });
  const prStopped = transitionMissionPublication(pr, {
    type: 'pull-requests-observed', pullRequests: [expectedPullRequest(), { ...expectedPullRequest(), nodeId: 'PR_duplicate', number: 78 }],
  });
  assert.equal(prStopped.state, 'safety-stop');
  assert.equal(prStopped.mutationAttempt, undefined);

  const commentBase: MissionPublicationRecord = {
    ...publicationFixture(), revision: 7, state: 'comment-intent', baseObservedSha: '1'.repeat(40), pullRequest: expectedPullRequest(),
  };
  const commentAction = `publication:${commentBase.id}:post-comment`;
  const comment = transitionMissionPublication(transitionMissionPublication(commentBase, {
    type: 'mutation-attempted', attempt: { kind: 'post-comment', actionKey: commentAction },
  }), { type: 'mutation-dispatched', actionKey: commentAction });
  const commentStopped = transitionMissionPublication(comment, {
    type: 'comments-observed', comments: [{ id: 'other', body: '<!-- codex-orchestrator:publication-comment mission-227 -->\nDifferent.' }],
  });
  assert.equal(commentStopped.state, 'external-input-required');
  assert.equal(commentStopped.mutationAttempt, undefined);
});

test('Publication retries a transient pre-dispatch fence but terminalizes fence and request authority failures', async () => {
  const retryRoot = await mkdtemp(join(tmpdir(), 'mission-publication-fence-retry-'));
  const retryStore = new MissionStateStore(retryRoot, '.codex-orchestrator/state');
  const publication: MissionPublicationRecord = {
    ...publicationFixture(), revision: 3, state: 'pr-create-intent', baseObservedSha: '1'.repeat(40),
  };
  const pullRequests: ReturnType<typeof expectedPullRequest>[] = [];
  let fenceCalls = 0;
  let createCalls = 0;
  const dependencies = inertDependencies(publication);
  dependencies.now = () => '2026-07-14T21:00:00.000Z';
  dependencies.pullRequests.listAllByHeadBranch = async () => structuredClone(pullRequests);
  dependencies.assertMutationFence = async () => {
    fenceCalls += 1;
    if (fenceCalls === 1) throw new Error('temporary fence outage');
  };
  dependencies.pullRequests.createDraftPullRequest = async () => {
    createCalls += 1;
    pullRequests.push(expectedPullRequest());
    return expectedPullRequest();
  };
  await storePublication(retryStore, publication);
  let snapshot = await new MissionPublicationSaga(retryStore, dependencies).reconcilePullRequest(publication.id);
  assert.equal(publicationRecord(snapshot, publication.id).state, 'resumable');
  assert.equal(publicationRecord(snapshot, publication.id).mutationAttempt, undefined);
  const retrySaga = new MissionPublicationSaga(retryStore, dependencies);
  await retrySaga.resume({ publicationId: publication.id, now: '2026-07-14T21:00:01.000Z' });
  snapshot = await retrySaga.reconcilePullRequest(publication.id);
  assert.equal(publicationRecord(snapshot, publication.id).state, 'pr-confirmed');
  assert.equal(createCalls, 1);

  for (const boundary of ['fence', 'request'] as const) {
    const root = await mkdtemp(join(tmpdir(), `mission-publication-authority-${boundary}-`));
    const store = new MissionStateStore(root, '.codex-orchestrator/state');
    const authDependencies = inertDependencies(publication);
    authDependencies.pullRequests.listAllByHeadBranch = async () => [];
    if (boundary === 'fence') authDependencies.assertMutationFence = async () => { throw new Error('403 Forbidden'); };
    else authDependencies.pullRequests.createDraftPullRequest = async () => { throw new Error('403 Forbidden'); };
    await storePublication(store, publication);
    snapshot = await new MissionPublicationSaga(store, authDependencies).reconcilePullRequest(publication.id);
    const terminal = publicationRecord(snapshot, publication.id);
    assert.equal(terminal.state, 'external-input-required', boundary);
    assert.equal(terminal.mutationAttempt, undefined, boundary);
    assert.doesNotThrow(() => assertMissionPublicationRecord(terminal));
  }
});

test('Publication base advancement preserves every later publication phase', () => {
  const phases = ['pr-create-intent', 'pr-confirmed', 'labels-intent', 'labels-confirmed', 'comment-intent'] as const;
  for (const state of phases) {
    const record: MissionPublicationRecord = {
      ...publicationFixture(), revision: 8, state, baseObservedSha: '1'.repeat(40),
      ...(state !== 'pr-create-intent' ? { pullRequest: expectedPullRequest() } : {}),
      ...(state === 'labels-intent' ? { labelMutation: { add: ['agent:review'], remove: [], preserve: [] } } : {}),
    };
    const advanced = transitionMissionPublication(record, {
      type: 'base-observed', observation: { kind: 'present', commitSha: '9'.repeat(40) },
    });
    assert.equal(advanced.state, state);
    assert.doesNotThrow(() => assertMissionPublicationRecord(advanced));
  }
});

test('Publication classifies proven maintainer PR recreation as external and ambiguous recreation as safety', async () => {
  for (const [association, expected] of [['MEMBER', 'external-input-required'], ['NONE', 'safety-stop']] as const) {
    const root = await mkdtemp(join(tmpdir(), `mission-publication-recreated-${association}-`));
    const store = new MissionStateStore(root, '.codex-orchestrator/state');
    const publication: MissionPublicationRecord = {
      ...publicationFixture(), revision: 5, state: 'pr-confirmed', baseObservedSha: '1'.repeat(40), pullRequest: expectedPullRequest(),
    };
    const dependencies = inertDependencies(publication);
    dependencies.pullRequests.listAllByHeadBranch = async () => [{
      ...expectedPullRequest(), nodeId: 'PR_recreated', authorAssociation: association,
    }];
    await storePublication(store, publication);
    const snapshot = await new MissionPublicationSaga(store, dependencies).reconcileLabels(publication.id);
    assert.equal(publicationRecord(snapshot, publication.id).state, expected);
  }
});

function publicationFixture() {
  return createMissionPublication({
    ownerId: 'mission-227',
    repository: 'owner/repo',
    issueNumber: 227,
    fencingEpoch: 7,
    candidateCommit: '3'.repeat(40),
    candidateTree: '4'.repeat(40),
    baseSha: '1'.repeat(40),
    validationSnapshot: '2'.repeat(40),
    validationReceiptIds: ['validation:1'],
    configHash: `sha256:${'a'.repeat(64)}`,
    branch: 'codex/mission-227',
    baseBranch: 'main',
    marker: '<!-- codex-orchestrator:publication mission-227 -->',
    title: 'Fix issue 227',
    body: '<!-- codex-orchestrator:publication mission-227 -->\nRunner-owned publication body',
    managedLabels: ['agent:running', 'agent:review', 'agent:blocked'],
    desiredLabels: ['agent:review'],
    terminalComment: '<!-- codex-orchestrator:publication-comment mission-227 -->\nReady.',
  });
}

async function storePublication(
  store: MissionStateStore,
  publication: MissionPublicationRecord,
): Promise<void> {
  await store.mutate(0, (draft) => {
    draft.missions[publication.ownerId] = {
      id: publication.ownerId, revision: 1, state: 'publication-prepared',
    };
    draft.publications[publication.id] = {
      revision: publication.revision,
      value: publication as unknown as JsonValue,
    };
  });
}

function publicationRecord(
  snapshot: Awaited<ReturnType<MissionStateStore['load']>>,
  publicationId: string,
): MissionPublicationRecord {
  return snapshot.publications[publicationId]?.value as unknown as MissionPublicationRecord;
}

function inertDependencies(
  publication: MissionPublicationRecord,
): MissionPublicationSagaDependencies {
  return {
    branches: {
      observe: async () => ({ kind: 'present', commitSha: publication.candidateCommit }),
      push: async () => undefined,
      observeBase: async () => publication.baseSha,
    },
    pullRequests: {
      listAllByHeadBranch: async () => [],
      createDraftPullRequest: async () => expectedPullRequest(),
    },
    issues: {
      getLabels: async () => [],
      addLabels: async () => undefined,
      removeLabels: async () => undefined,
      listAllComments: async () => [],
      postComment: async () => undefined,
    },
    assertMutationFence: async () => undefined,
  };
}

function expectedPullRequest() {
  return {
    number: 77,
    nodeId: 'PR_expected',
    url: 'https://github.com/owner/repo/pull/77',
    state: 'OPEN' as const,
    isDraft: true,
    headRefName: 'codex/mission-227',
    baseRefName: 'main',
    title: 'Fix issue 227',
    body: '<!-- codex-orchestrator:publication mission-227 -->\nRunner-owned publication body',
    authorAssociation: 'MEMBER',
  };
}

function expectedComment(body: string, id = 'comment-1') {
  return {
    id,
    url: `https://github.com/owner/repo/issues/227#issuecomment-${id}`,
    body,
    createdAt: '2026-07-14T21:00:00.000Z',
    author: { login: 'runner' },
    authorAssociation: 'MEMBER',
  };
}

function scopedApplyArtifacts(publication: MissionPublicationRecord) {
  const permit = createMissionApplyPermit({
    missionId: publication.ownerId,
    actionKey: 'apply:publication-candidate',
    fencingEpoch: publication.fencingEpoch,
    expiresAt: '2099-07-14T21:00:00.000Z',
    targetRef: `refs/heads/${publication.branch}`,
    auditReceiptSha256: `sha256:${'c'.repeat(64)}`,
    candidate: {
      baseCommit: publication.baseSha,
      baseTree: '2'.repeat(40),
      patchSha256: `sha256:${'d'.repeat(64)}`,
      treeSha: publication.candidateTree,
      commitSha: publication.candidateCommit,
      manifest: [{
        path: 'src/publication.ts',
        operation: 'modify',
        oldMode: '100644',
        newMode: '100644',
        beforeBlob: '5'.repeat(40),
        afterBlob: '6'.repeat(40),
        beforeSha256: `sha256:${'e'.repeat(64)}`,
        afterSha256: `sha256:${'f'.repeat(64)}`,
      }],
    },
    commit: {
      message: 'prepare publication',
      authorName: 'codex-orchestrator',
      authorEmail: 'codex-orchestrator@localhost',
      authoredAt: '2026-07-14T20:00:00.000Z',
      committerName: 'codex-orchestrator',
      committerEmail: 'codex-orchestrator@localhost',
      committedAt: '2026-07-14T20:00:00.000Z',
    },
  });
  const permitFingerprint = missionApplyPermitFingerprint(permit);
  return {
    permit,
    intent: {
      version: 1 as const,
      permitFingerprint,
      permit,
      preparedAt: '2026-07-14T20:00:00.000Z',
    },
    receipt: {
      version: 1 as const,
      permitFingerprint,
      targetRef: permit.targetRef,
      oldCommitSha: permit.expectedOldCommit,
      commitSha: permit.expectedNewCommit,
      treeSha: permit.expectedNewTree,
      recovered: false,
      appliedAt: '2026-07-14T20:01:00.000Z',
    },
  };
}
