import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  missionStates,
  missionEventTypes,
  terminalMissionStates,
  transitionMission,
  type MissionEvent,
  type MissionRecord,
  type MissionState,
} from '../src/runner/mission-state-machine.js';
import type { EvaluationResult } from '../src/runner/mission-evaluation.js';
import {
  createMissionApplyPermit,
  missionApplyPermitFingerprint,
} from '../src/runner/mission-git-contracts.js';

test('evaluation dispositions route without blocked outcome', () => {
  const evaluating: MissionRecord = {
    id: 'mission-227',
    revision: 4,
    state: 'evaluating',
  };

  assert.equal(transitionMission(evaluating, {
    type: 'evaluation-completed',
    result: evaluationResult('none'),
  }).state, 'candidate-ready');
  assert.equal(transitionMission(evaluating, {
    type: 'evaluation-completed',
    result: evaluationResult('diagnose'),
  }).state, 'diagnosing');
  assert.equal(transitionMission(evaluating, {
    type: 'evaluation-completed',
    result: evaluationResult('external-input'),
  }).state, 'external-input-required');
  assert.equal(transitionMission(evaluating, {
    type: 'evaluation-completed',
    result: evaluationResult('safety-stop'),
  }).state, 'safety-stop');
});

test('execution and apply recovery use safe resume states', () => {
  const transient = transitionMission({
    id: 'mission-227',
    revision: 8,
    state: 'executing',
  }, {
    type: 'execution-transient-failure',
    actionKey: 'action-1',
    nextEligibleAt: '2026-07-14T13:00:00.000Z',
  });

  assert.deepEqual({
    state: transient.state,
    resumeTarget: transient.resumeTarget,
    actionKey: transient.actionKey,
  }, {
    state: 'resumable',
    resumeTarget: 'authorizing',
    actionKey: 'action-1',
  });
  assert.equal(transitionMission(transient, {
    type: 'resume-eligible',
    now: '2026-07-14T13:00:00.000Z',
  }).state, 'authorizing');

  assert.equal(transitionMission({
    id: 'mission-227',
    revision: 10,
    state: 'apply-prepared',
  }, {
    type: 'apply-reconciled-old-identity',
  }).state, 'apply-authorizing');
  assert.equal(transitionMission({
    id: 'mission-227',
    revision: 11,
    state: 'applying',
  }, {
    type: 'apply-reconciled-old-identity',
  }).state, 'apply-authorizing');
});

test('apply authorization persists the exact permit and old-identity recovery revokes it', () => {
  const permit = applyPermit('mission-227', 'apply-1');
  const prepared = transitionMission({
    id: 'mission-227',
    revision: 3,
    state: 'apply-authorizing',
  }, {
    type: 'apply-authorized',
    actionKey: 'apply-1',
    permit,
  });
  assert.equal(prepared.state, 'apply-prepared');
  assert.deepEqual(prepared.applyPermit, permit);
  assert.equal(prepared.fencingEpoch, 3);

  const reauthorizing = transitionMission({
    ...prepared,
    state: 'applying',
    applyIntent: {
      version: 1,
      permitFingerprint: `sha256:${'e'.repeat(64)}`,
      permit,
      preparedAt: '2026-07-14T12:00:00.000Z',
    },
  }, { type: 'apply-reconciled-old-identity' });
  assert.equal(reauthorizing.state, 'apply-authorizing');
  assert.equal(reauthorizing.applyPermit, undefined);
  assert.equal(reauthorizing.applyIntent, undefined);
});

test('transition table rejects undefined pairs without mutation', () => {
  const record: MissionRecord = {
    id: 'mission-227',
    revision: 3,
    state: 'created',
  };
  const before = structuredClone(record);

  assert.throws(() => transitionMission(record, {
    type: 'evaluation-completed',
    result: evaluationResult('none'),
  }), /created \+ evaluation-completed/);
  assert.deepEqual(record, before);
});

test('declared mission transition table is executable', () => {
  const cases: Array<{
    state: MissionState;
    event: MissionEvent;
    expected: MissionState;
  }> = [
    { state: 'created', event: { type: 'claim-requested' }, expected: 'claiming' },
    { state: 'claiming', event: { type: 'claim-observed' }, expected: 'evaluating' },
    { state: 'claiming', event: transient('claim-transient-failure'), expected: 'resumable' },
    { state: 'diagnosing', event: { type: 'diagnosis-valid' }, expected: 'authorizing' },
    { state: 'diagnosing', event: { type: 'diagnosis-invalid' }, expected: 'diagnosing' },
    { state: 'diagnosing', event: transient('diagnosis-transient-failure'), expected: 'resumable' },
    { state: 'authorizing', event: {
      type: 'capability-authorized',
      actionKey: 'action-1',
      permit: capabilityPermit('action-1'),
    }, expected: 'executing' },
    { state: 'authorizing', event: { type: 'authorization-rejected' }, expected: 'diagnosing' },
    { state: 'authorizing', event: transient('authorization-temporary'), expected: 'resumable' },
    { state: 'authorizing', event: { type: 'authorization-external' }, expected: 'external-input-required' },
    { state: 'authorizing', event: { type: 'authorization-safety' }, expected: 'safety-stop' },
    { state: 'executing', event: { type: 'patch-received' }, expected: 'auditing' },
    { state: 'executing', event: { type: 'observation-received' }, expected: 'reconciling' },
    { state: 'executing', event: { type: 'execution-deterministic-failure' }, expected: 'diagnosing' },
    { state: 'auditing', event: { type: 'audit-rejected' }, expected: 'diagnosing' },
    { state: 'auditing', event: { type: 'audit-safety' }, expected: 'safety-stop' },
    { state: 'auditing', event: { type: 'audit-accepted' }, expected: 'apply-authorizing' },
    { state: 'apply-authorizing', event: {
      type: 'apply-authorized',
      actionKey: 'apply-action',
      permit: applyPermit('mission-placeholder', 'apply-action'),
    }, expected: 'apply-prepared' },
    { state: 'apply-authorizing', event: { type: 'apply-authorization-rejected' }, expected: 'diagnosing' },
    { state: 'apply-authorizing', event: transient('apply-authorization-temporary'), expected: 'resumable' },
    { state: 'apply-prepared', event: {
      type: 'apply-started',
      intent: applyArtifacts('mission-placeholder', 'apply-action').intent,
    }, expected: 'applying' },
    { state: 'apply-prepared', event: {
      type: 'apply-reconciled-new-identity',
      ...applyArtifacts('mission-placeholder', 'apply-action'),
    }, expected: 'reconciling' },
    { state: 'apply-prepared', event: { type: 'apply-reconciled-third-identity' }, expected: 'safety-stop' },
    { state: 'applying', event: {
      type: 'apply-reconciled-new-identity',
      ...applyArtifacts('mission-placeholder', 'apply-action'),
    }, expected: 'reconciling' },
    { state: 'applying', event: { type: 'apply-reconciled-third-identity' }, expected: 'safety-stop' },
    { state: 'reconciling', event: { type: 'reconciliation-satisfied' }, expected: 'evaluating' },
    { state: 'reconciling', event: transient('reconciliation-transient-failure'), expected: 'resumable' },
    { state: 'candidate-ready', event: { type: 'adapt-to-publication' }, expected: 'publication-prepared' },
    { state: 'candidate-ready', event: { type: 'adapt-to-integration' }, expected: 'integration-ready' },
    { state: 'publication-prepared', event: { type: 'publication-review-ready' }, expected: 'completed' },
    { state: 'publication-prepared', event: transient('publication-transient-failure'), expected: 'resumable' },
    { state: 'publication-prepared', event: { type: 'publication-external' }, expected: 'external-input-required' },
    { state: 'publication-prepared', event: { type: 'publication-safety' }, expected: 'safety-stop' },
    { state: 'publication-prepared', event: { type: 'publication-cancelled' }, expected: 'cancelled' },
    { state: 'integration-ready', event: { type: 'integration-accepted' }, expected: 'completed' },
    { state: 'cancelling', event: { type: 'cancellation-reconciled' }, expected: 'cancelled' },
  ];

  for (const [index, item] of cases.entries()) {
    const missionId = `mission-${index}`;
    let event: MissionEvent = item.event;
    if (item.event.type === 'capability-authorized') {
      event = { ...item.event, permit: { ...item.event.permit, missionId } };
    } else if (item.event.type === 'apply-authorized') {
      event = { ...item.event, permit: { ...item.event.permit, missionId } };
    }
    const artifacts = item.event.type === 'apply-started'
      || item.event.type === 'apply-reconciled-new-identity'
      ? applyArtifacts(missionId, 'apply-action')
      : undefined;
    if (item.event.type === 'apply-started') {
      event = { type: item.event.type, intent: artifacts!.intent };
    } else if (item.event.type === 'apply-reconciled-new-identity') {
      event = { type: item.event.type, intent: artifacts!.intent, receipt: artifacts!.receipt };
    }
    const result = transitionMission({
      id: missionId,
      revision: 1,
      state: item.state,
      ...(artifacts ? {
        applyPermit: artifacts.permit,
        ...(item.state === 'applying' ? { applyIntent: artifacts.intent } : {}),
      } : {}),
    }, event);
    assert.equal(result.state, item.expected, `${item.state} + ${item.event.type}`);
    assert.equal(result.revision, 2, `${item.state} revision`);
  }
});

test('every nonterminal mission state accepts explicit cancellation', () => {
  for (const state of missionStates.filter((candidate) => !terminalMissionStates.has(candidate)
    && candidate !== 'cancelling')) {
    assert.equal(transitionMission({
      id: `mission-${state}`,
      revision: 1,
      state,
    }, { type: 'cancel-requested' }).state, 'cancelling', state);
  }
});

test('every state and public event pair either transitions or rejects without mutation', () => {
  const successfulPairs: string[] = [];
  for (const state of missionStates) {
    for (const type of missionEventTypes) {
      const record: MissionRecord = {
        id: `mission-${state}-${type}`,
        revision: 1,
        state,
        ...(state === 'resumable' ? {
          resumeTarget: 'diagnosing' as const,
          nextEligibleAt: '2026-07-14T12:00:00.000Z',
        } : {}),
      };
      const event = eventForType(type, record.id);
      if (event.type === 'apply-started' || event.type === 'apply-reconciled-new-identity') {
        record.applyPermit = event.intent.permit;
        if (state === 'applying') record.applyIntent = event.intent;
      }
      const before = structuredClone(record);
      try {
        const result = transitionMission(record, event);
        successfulPairs.push(`${state}::${type}`);
        assert.equal(result.revision, 2, `${state} + ${type}`);
        assert.equal(missionStates.includes(result.state), true, `${state} + ${type}`);
      } catch (error) {
        assert.match(String(error), /Mission transition is not allowed|not eligible to resume/);
        assert.deepEqual(record, before, `${state} + ${type}`);
      }
    }
  }
  assert.deepEqual(successfulPairs.sort(), expectedSuccessfulMissionPairs.sort());
});

const expectedSuccessfulMissionPairs = [
  'created::claim-requested',
  'claiming::claim-observed',
  'claiming::claim-transient-failure',
  'evaluating::evaluation-completed',
  'diagnosing::diagnosis-valid',
  'diagnosing::diagnosis-invalid',
  'diagnosing::diagnosis-transient-failure',
  'authorizing::capability-authorized',
  'authorizing::authorization-rejected',
  'authorizing::authorization-external',
  'authorizing::authorization-safety',
  'authorizing::authorization-temporary',
  'executing::patch-received',
  'executing::observation-received',
  'executing::execution-deterministic-failure',
  'executing::execution-transient-failure',
  'auditing::audit-rejected',
  'auditing::audit-safety',
  'auditing::audit-accepted',
  'apply-authorizing::apply-authorized',
  'apply-authorizing::apply-authorization-rejected',
  'apply-authorizing::apply-authorization-temporary',
  'apply-prepared::apply-started',
  'apply-prepared::apply-reconciled-new-identity',
  'apply-prepared::apply-reconciled-third-identity',
  'apply-prepared::apply-reconciled-old-identity',
  'applying::apply-reconciled-new-identity',
  'applying::apply-reconciled-third-identity',
  'applying::apply-reconciled-old-identity',
  'reconciling::reconciliation-satisfied',
  'reconciling::apply-reconciled-third-identity',
  'reconciling::reconciliation-transient-failure',
  'candidate-ready::adapt-to-publication',
  'candidate-ready::adapt-to-integration',
  'publication-prepared::publication-review-ready',
  'publication-prepared::publication-external',
  'publication-prepared::publication-safety',
  'publication-prepared::publication-cancelled',
  'publication-prepared::publication-transient-failure',
  'integration-ready::integration-accepted',
  'resumable::resume-eligible',
  'cancelling::cancellation-reconciled',
  'created::cancel-requested',
  'claiming::cancel-requested',
  'evaluating::cancel-requested',
  'diagnosing::cancel-requested',
  'authorizing::cancel-requested',
  'executing::cancel-requested',
  'auditing::cancel-requested',
  'apply-authorizing::cancel-requested',
  'apply-prepared::cancel-requested',
  'applying::cancel-requested',
  'reconciling::cancel-requested',
  'candidate-ready::cancel-requested',
  'publication-prepared::cancel-requested',
  'integration-ready::cancel-requested',
  'resumable::cancel-requested',
];

function evaluationResult(
  blockingDisposition: EvaluationResult['blockingDisposition'],
): EvaluationResult {
  return {
    findings: [],
    blockingDisposition,
  };
}

function transient(
  type:
    | 'claim-transient-failure'
    | 'diagnosis-transient-failure'
    | 'authorization-temporary'
    | 'apply-authorization-temporary'
    | 'reconciliation-transient-failure'
    | 'publication-transient-failure',
): MissionEvent {
  return {
    type,
    actionKey: `${type}-action`,
    nextEligibleAt: '2026-07-14T13:00:00.000Z',
  };
}

function eventForType(type: (typeof missionEventTypes)[number], missionId: string): MissionEvent {
  switch (type) {
    case 'evaluation-completed':
      return { type, result: evaluationResult('none') };
    case 'execution-transient-failure':
    case 'claim-transient-failure':
    case 'diagnosis-transient-failure':
    case 'authorization-temporary':
    case 'apply-authorization-temporary':
    case 'reconciliation-transient-failure':
    case 'publication-transient-failure':
      return {
        type,
        actionKey: `${type}-action`,
        nextEligibleAt: '2026-07-14T13:00:00.000Z',
      };
    case 'resume-eligible':
      return { type, now: '2026-07-14T13:00:00.000Z' };
    case 'capability-authorized':
      return {
        type,
        actionKey: 'authorized-action',
        permit: { ...capabilityPermit('authorized-action'), missionId },
      };
    case 'apply-authorized':
      return {
        type,
        actionKey: 'authorized-apply',
        permit: applyPermit(missionId, 'authorized-apply'),
      };
    case 'apply-started': {
      const { intent } = applyArtifacts(missionId, 'authorized-apply');
      return { type, intent };
    }
    case 'apply-reconciled-new-identity': {
      const { intent, receipt } = applyArtifacts(missionId, 'authorized-apply');
      return { type, intent, receipt };
    }
    case 'apply-reconciled-old-identity':
      return { type };
    default:
      return { type };
  }
}

function capabilityPermit(actionKey: string) {
  return {
    missionId: 'mission-transition',
    actionKey,
    capability: 'read-file' as const,
    argv: [],
    requestedPaths: ['src/value.ts'],
    grantedPaths: ['src/**'],
    readPath: 'src/value.ts',
    maxReadBytes: 4096,
    inputSnapshot: 'tree:abc',
    fencingEpoch: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
    network: 'deny' as const,
    workspace: 'read-only' as const,
  };
}

function applyPermit(missionId: string, actionKey: string) {
  return createMissionApplyPermit({
    missionId,
    actionKey,
    fencingEpoch: 3,
    expiresAt: '2099-07-14T13:00:00.000Z',
    targetRef: 'refs/heads/mission-test',
    auditReceiptSha256: `sha256:${'a'.repeat(64)}`,
    candidate: {
      baseCommit: '1'.repeat(40),
      baseTree: '2'.repeat(40),
      patchSha256: `sha256:${'b'.repeat(64)}`,
      treeSha: '3'.repeat(40),
      commitSha: '4'.repeat(40),
      manifest: [{
        path: 'src/value.ts',
        operation: 'modify',
        oldMode: '100644',
        newMode: '100644',
        beforeBlob: '5'.repeat(40),
        afterBlob: '6'.repeat(40),
        beforeSha256: `sha256:${'c'.repeat(64)}`,
        afterSha256: `sha256:${'d'.repeat(64)}`,
      }],
    },
    commit: {
      message: 'mission apply',
      authorName: 'codex-orchestrator',
      authorEmail: 'codex-orchestrator@localhost',
      authoredAt: '2026-07-14T12:00:00.000Z',
      committerName: 'codex-orchestrator',
      committerEmail: 'codex-orchestrator@localhost',
      committedAt: '2026-07-14T12:00:00.000Z',
    },
  });
}

function applyArtifacts(missionId: string, actionKey: string) {
  const permit = applyPermit(missionId, actionKey);
  const permitFingerprint = `sha256:${'e'.repeat(64)}`;
  const intent = {
    version: 1 as const,
    permitFingerprint,
    permit,
    preparedAt: '2026-07-14T12:00:00.000Z',
  };
  const actualFingerprint = missionApplyPermitFingerprint(permit);
  intent.permitFingerprint = actualFingerprint;
  return {
    permit,
    intent,
    receipt: {
      version: 1 as const,
      permitFingerprint: actualFingerprint,
      targetRef: permit.targetRef,
      oldCommitSha: permit.expectedOldCommit,
      commitSha: permit.expectedNewCommit,
      treeSha: permit.expectedNewTree,
      recovered: false,
      appliedAt: '2026-07-14T12:01:00.000Z',
    },
  };
}
