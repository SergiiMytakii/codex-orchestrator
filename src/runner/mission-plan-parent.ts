import { createHash } from 'node:crypto';

import { childMissionId } from './mission-identifiers.js';
import { validatePlanGraph, type PlanGraph } from './issue-tree.js';
import type { MissionCancellation, MissionClaim } from './mission-state-machine.js';

export const planParentStates = [
  'created', 'wave-running', 'wave-waiting', 'wave-prepared', 'integrating',
  'recovery-waiting', 'wave-validating', 'checkpointing', 'next-wave',
  'final-validating', 'publication-prepared', 'cancelling',
  'external-input-required', 'safety-stop', 'cancelled', 'completed',
] as const;

export type PlanParentState = (typeof planParentStates)[number];
export type PlanParentResumeTarget = Exclude<PlanParentState,
  'created' | 'wave-waiting' | 'cancelling' | 'external-input-required'
  | 'safety-stop' | 'cancelled' | 'completed'>;

export interface PlanParentCheckpoint {
  commitSha: string;
  treeSha: string;
}

export interface PlanParentChildDescriptor {
  stableId: string;
  childCommit: string;
  childTree: string;
  baseCheckpointCommit: string;
  configHash: string;
  executorVersion: string;
  changedPaths: string[];
  validationReceiptIds: string[];
  reservationFingerprint: string;
}

export interface PlanParentChild {
  stableId: string;
  missionId: string;
  wave: number;
  baseCheckpointCommit: string;
  baseCheckpointTree: string;
  descriptor?: PlanParentChildDescriptor;
}

export interface PlanParentIntegrationIntent {
  version: 1;
  actionKey: string;
  wave: number;
  cursor: number;
  stableId: string;
  expectedOldCommit: string;
  expectedNewCommit: string;
  expectedNewTree: string;
}

export interface PlanParentLabelTransition {
  stableId: string;
  from: string;
  to: string;
  receiptId: string;
}

export interface PlanParentRecord {
  id: string;
  revision: number;
  state: PlanParentState;
  repository: string;
  issueNumber: number;
  configHash: string;
  baseCommit: string;
  baseTree: string;
  graph: PlanGraph;
  graphHash: string;
  waves: string[][];
  currentWave: number;
  checkpoint: PlanParentCheckpoint;
  children: Record<string, PlanParentChild>;
  integrationCursor: number;
  integratedCommit: string;
  integratedTree: string;
  integrationIntent?: PlanParentIntegrationIntent;
  integrationHistory: PlanParentIntegrationIntent[];
  validationReceiptIds: string[];
  validationHistory: string[];
  labelTransitions: PlanParentLabelTransition[];
  recoveryMissionId?: string;
  recoveryTarget?: 'wave-validating' | 'final-validating';
  publicationId?: string;
  resumeTarget?: PlanParentResumeTarget;
  nextEligibleAt?: string;
  resumableReason?: string;
  requiredPredicate?: string;
  actionKey?: string;
  claim?: MissionClaim;
  cancellation?: MissionCancellation;
}

export type PlanParentEvent =
  | { type: 'wave-linked' }
  | { type: 'wave-prepared'; descriptors: PlanParentChildDescriptor[] }
  | { type: 'integration-started'; intent: PlanParentIntegrationIntent }
  | { type: 'integration-completed'; actionKey: string }
  | { type: 'integration-conflict'; recoveryMissionId: string }
  | { type: 'recovery-ready'; descriptor: PlanParentChildDescriptor }
  | {
      type: 'validation-failed';
      recoveryMissionId: string;
      recoveryTarget: 'wave-validating' | 'final-validating';
    }
  | { type: 'validation-recovery-ready' }
  | { type: 'validation-passed'; receiptIds: string[] }
  | { type: 'checkpoint-committed'; checkpoint: PlanParentCheckpoint }
  | { type: 'final-validation-passed'; receiptIds: string[]; publicationId: string }
  | { type: 'publication-review-ready' }
  | { type: 'publication-cancelled' }
  | { type: 'label-transition-recorded'; transition: PlanParentLabelTransition }
  | {
      type: 'transient-failure';
      resumeTarget: PlanParentResumeTarget;
      actionKey: string;
      nextEligibleAt: string;
      reason: string;
      requiredPredicate: string;
    }
  | { type: 'resume-eligible'; now: string }
  | { type: 'cancel-requested'; cancellation: MissionCancellation }
  | { type: 'cancellation-integration-reconciled'; applied: boolean }
  | { type: 'cancellation-reconciled' }
  | { type: 'external-input-required' }
  | { type: 'safety-stop' };

export const planParentEventTypes = [
  'wave-linked', 'wave-prepared', 'integration-started', 'integration-completed',
  'integration-conflict', 'recovery-ready', 'validation-failed',
  'validation-recovery-ready', 'validation-passed', 'checkpoint-committed',
  'final-validation-passed', 'publication-review-ready', 'publication-cancelled', 'label-transition-recorded',
  'transient-failure', 'resume-eligible', 'cancel-requested',
  'cancellation-integration-reconciled', 'cancellation-reconciled',
  'external-input-required', 'safety-stop',
] as const satisfies ReadonlyArray<PlanParentEvent['type']>;

type MissingPlanParentEvent = Exclude<PlanParentEvent['type'], (typeof planParentEventTypes)[number]>;
const planParentEventsAreExhaustive: MissingPlanParentEvent extends never ? true : false = true;
void planParentEventsAreExhaustive;

export function createPlanParent(input: {
  id: string;
  repository: string;
  issueNumber: number;
  configHash: string;
  baseCommit: string;
  baseTree: string;
  graph: PlanGraph;
}): PlanParentRecord {
  requireText(input.id, 'Plan Parent id');
  requireText(input.repository, 'Plan Parent repository');
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error('Plan Parent issueNumber must be a positive integer.');
  }
  digest(input.configHash, 'Plan Parent configHash');
  objectId(input.baseCommit, 'Plan Parent baseCommit');
  objectId(input.baseTree, 'Plan Parent baseTree');
  const validation = validatePlanGraph(input.graph);
  if (!validation.ok) throw new Error(`Plan Parent graph is invalid: ${validation.errors.join('; ')}`);
  const graph = structuredClone(input.graph);
  const waves = computeWaves(graph);
  return {
    id: input.id,
    revision: 1,
    state: 'created',
    repository: input.repository,
    issueNumber: input.issueNumber,
    configHash: input.configHash,
    baseCommit: input.baseCommit,
    baseTree: input.baseTree,
    graph,
    graphHash: sha256(canonicalJson(graph)),
    waves,
    currentWave: 0,
    checkpoint: { commitSha: input.baseCommit, treeSha: input.baseTree },
    children: {},
    integrationCursor: 0,
    integratedCommit: input.baseCommit,
    integratedTree: input.baseTree,
    integrationHistory: [],
    validationReceiptIds: [],
    validationHistory: [],
    labelTransitions: [],
  };
}

export function transitionPlanParent(
  record: PlanParentRecord,
  event: PlanParentEvent,
): PlanParentRecord {
  const next = structuredClone(record);
  if (event.type === 'label-transition-recorded' && !terminal(record.state)) {
    validateLabelTransition(event.transition);
    if (!next.labelTransitions.some((entry) => entry.receiptId === event.transition.receiptId)) {
      next.labelTransitions.push(structuredClone(event.transition));
      next.revision += 1;
    }
    return next;
  }
  if (event.type === 'cancel-requested' && !terminal(record.state) && record.state !== 'cancelling') {
    validateCancellation(event.cancellation);
    revokeTransient(next);
    next.state = 'cancelling';
    next.cancellation = structuredClone(event.cancellation);
    next.revision += 1;
    return next;
  }
  if (record.state === 'cancelling' && event.type === 'cancellation-reconciled') {
    revokeTransient(next);
    delete next.integrationIntent;
    delete next.claim;
    next.state = 'cancelled';
    next.revision += 1;
    return next;
  }
  if (record.state === 'cancelling' && event.type === 'cancellation-integration-reconciled') {
    if (!record.integrationIntent) throw new Error('Plan Parent cancellation has no integration intent.');
    if (event.applied) {
      if (!next.integrationHistory.some((entry) => entry.actionKey === record.integrationIntent!.actionKey)) {
        next.integrationHistory.push(structuredClone(record.integrationIntent));
      }
      next.integratedCommit = record.integrationIntent.expectedNewCommit;
      next.integratedTree = record.integrationIntent.expectedNewTree;
      next.integrationCursor = Math.max(next.integrationCursor, record.integrationIntent.cursor + 1);
    }
    delete next.integrationIntent;
    next.revision += 1;
    return next;
  }
  if ((event.type === 'external-input-required' || event.type === 'safety-stop')
    && !terminal(record.state)) {
    revokeTransient(next);
    delete next.claim;
    next.state = event.type;
    next.revision += 1;
    return next;
  }
  if (event.type === 'transient-failure' && transientAllowed(record.state, event.resumeTarget)) {
    exactTimestamp(event.nextEligibleAt, 'Plan Parent nextEligibleAt');
    requireText(event.actionKey, 'Plan Parent actionKey');
    requireText(event.reason, 'Plan Parent resumable reason');
    requireText(event.requiredPredicate, 'Plan Parent required predicate');
    revokeTransient(next);
    delete next.claim;
    next.state = 'wave-waiting';
    next.resumeTarget = event.resumeTarget;
    next.nextEligibleAt = event.nextEligibleAt;
    next.resumableReason = event.reason;
    next.requiredPredicate = event.requiredPredicate;
    next.actionKey = event.actionKey;
    next.revision += 1;
    return next;
  }
  if (record.state === 'wave-waiting' && event.type === 'resume-eligible') {
    exactTimestamp(event.now, 'Plan Parent resume time');
    if (!record.resumeTarget || !record.nextEligibleAt || event.now < record.nextEligibleAt) {
      throw new Error('Plan Parent is not eligible to resume.');
    }
    next.state = record.resumeTarget;
    revokeTransient(next);
    next.revision += 1;
    return next;
  }
  if ((record.state === 'created' || record.state === 'next-wave') && event.type === 'wave-linked') {
    next.state = 'wave-running';
    next.revision += 1;
    return next;
  }
  if (record.state === 'wave-running' && event.type === 'wave-prepared') {
    const expected = record.waves[record.currentWave] ?? [];
    if (event.descriptors.length !== expected.length) throw new Error('Plan Parent wave descriptors are incomplete.');
    for (const descriptor of event.descriptors) {
      validateDescriptor(descriptor, record);
      const child = next.children[descriptor.stableId];
      if (!child || child.wave !== record.currentWave
        || descriptor.baseCheckpointCommit !== child.baseCheckpointCommit) {
        throw new Error(`Plan Parent descriptor does not match child ${descriptor.stableId}.`);
      }
      child.descriptor = structuredClone(descriptor);
    }
    if (expected.some((stableId) => !next.children[stableId]?.descriptor)) {
      throw new Error('Plan Parent wave descriptors do not cover the deterministic wave.');
    }
    next.integrationCursor = 0;
    next.integratedCommit = record.checkpoint.commitSha;
    next.integratedTree = record.checkpoint.treeSha;
    next.state = 'wave-prepared';
    next.revision += 1;
    return next;
  }
  if (record.state === 'wave-prepared' && event.type === 'integration-started') {
    validateIntent(event.intent, record);
    next.integrationIntent = structuredClone(event.intent);
    next.state = 'integrating';
    next.actionKey = event.intent.actionKey;
    next.revision += 1;
    return next;
  }
  if (record.state === 'integrating' && event.type === 'integration-started') {
    validateIntent(event.intent, record);
    if (canonicalJson(record.integrationIntent) !== canonicalJson(event.intent)) {
      throw new Error('Plan Parent integration replay does not match durable intent.');
    }
    return record;
  }
  if (record.state === 'integrating' && event.type === 'integration-completed') {
    if (!record.integrationIntent || record.integrationIntent.actionKey !== event.actionKey) {
      throw new Error('Plan Parent integration intent does not match completion.');
    }
    next.integrationHistory.push(structuredClone(record.integrationIntent));
    next.integratedCommit = record.integrationIntent.expectedNewCommit;
    next.integratedTree = record.integrationIntent.expectedNewTree;
    next.integrationCursor += 1;
    delete next.integrationIntent;
    delete next.actionKey;
    next.state = next.integrationCursor === (record.waves[record.currentWave]?.length ?? 0)
      ? 'wave-validating' : 'wave-prepared';
    next.revision += 1;
    return next;
  }
  if ((record.state === 'wave-prepared' || record.state === 'integrating')
    && event.type === 'integration-conflict') {
    requireText(event.recoveryMissionId, 'Plan Parent recoveryMissionId');
    next.recoveryMissionId = event.recoveryMissionId;
    next.state = 'recovery-waiting';
    next.revision += 1;
    return next;
  }
  if (record.state === 'recovery-waiting' && event.type === 'recovery-ready') {
    validateDescriptor(event.descriptor, record);
    if (event.descriptor.stableId !== record.waves[record.currentWave]?.[record.integrationCursor]) {
      throw new Error('Plan Parent recovery descriptor does not match the integration cursor.');
    }
    const child = next.children[event.descriptor.stableId];
    if (!child) throw new Error('Plan Parent recovery descriptor child is missing.');
    child.descriptor = structuredClone(event.descriptor);
    delete next.recoveryMissionId;
    delete next.recoveryTarget;
    delete next.integrationIntent;
    next.state = 'wave-prepared';
    next.revision += 1;
    return next;
  }
  if ((record.state === 'wave-validating' || record.state === 'final-validating')
    && event.type === 'validation-failed' && event.recoveryTarget === record.state) {
    requireText(event.recoveryMissionId, 'Plan Parent validation recoveryMissionId');
    next.recoveryMissionId = event.recoveryMissionId;
    next.recoveryTarget = event.recoveryTarget;
    next.state = 'recovery-waiting';
    next.revision += 1;
    return next;
  }
  if (record.state === 'recovery-waiting' && event.type === 'validation-recovery-ready') {
    if (!record.recoveryMissionId || !record.recoveryTarget) {
      throw new Error('Plan Parent validation recovery context is missing.');
    }
    next.state = record.recoveryTarget;
    delete next.recoveryMissionId;
    delete next.recoveryTarget;
    next.revision += 1;
    return next;
  }
  if (record.state === 'wave-validating' && event.type === 'validation-passed') {
    validateStrings(event.receiptIds, 'Plan Parent validation receipts');
    next.validationReceiptIds = [...event.receiptIds];
    next.state = 'checkpointing';
    next.revision += 1;
    return next;
  }
  if (record.state === 'checkpointing' && event.type === 'checkpoint-committed') {
    validateCheckpoint(event.checkpoint);
    if (event.checkpoint.commitSha !== record.integratedCommit
      || event.checkpoint.treeSha !== record.integratedTree) {
      throw new Error('Plan Parent checkpoint does not match integrated identity.');
    }
    next.checkpoint = structuredClone(event.checkpoint);
    next.validationHistory.push(...record.validationReceiptIds);
    next.validationReceiptIds = [];
    next.integrationCursor = 0;
    if (record.currentWave + 1 < record.waves.length) {
      next.currentWave += 1;
      next.state = 'next-wave';
    } else {
      next.state = 'final-validating';
    }
    next.revision += 1;
    return next;
  }
  if (record.state === 'final-validating' && event.type === 'final-validation-passed') {
    validateStrings(event.receiptIds, 'Plan Parent final validation receipts');
    requireText(event.publicationId, 'Plan Parent publicationId');
    next.validationHistory.push(...event.receiptIds);
    next.publicationId = event.publicationId;
    next.state = 'publication-prepared';
    next.revision += 1;
    return next;
  }
  if (record.state === 'publication-prepared' && event.type === 'publication-review-ready') {
    delete next.claim;
    next.state = 'completed';
    next.revision += 1;
    return next;
  }
  if (record.state === 'publication-prepared' && event.type === 'publication-cancelled') {
    delete next.claim;
    next.state = 'cancelled';
    next.revision += 1;
    return next;
  }
  throw new Error(`Plan Parent transition is not allowed: ${record.state} + ${event.type}`);
}

export function planParentScheduleKey(id: string): string {
  requireText(id, 'Plan Parent schedule id');
  return `plan-parent:${id}`;
}

export function assertPlanParentRecord(value: unknown, path = 'Plan Parent'): asserts value is PlanParentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const record = value as unknown as PlanParentRecord;
  exactKeys(value as Record<string, unknown>, [
    'id', 'revision', 'state', 'repository', 'issueNumber', 'configHash', 'baseCommit',
    'baseTree', 'graph', 'graphHash', 'waves', 'currentWave', 'checkpoint', 'children',
    'integrationCursor', 'integratedCommit', 'integratedTree', 'integrationIntent',
    'integrationHistory', 'validationReceiptIds', 'validationHistory', 'labelTransitions',
    'recoveryMissionId', 'recoveryTarget', 'publicationId', 'resumeTarget', 'nextEligibleAt',
    'resumableReason', 'requiredPredicate', 'actionKey', 'claim', 'cancellation',
  ], path);
  requireText(record.id, `${path}.id`);
  requireText(record.repository, `${path}.repository`);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error(`${path}.revision is invalid.`);
  if (!planParentStates.includes(record.state)) throw new Error(`${path}.state is invalid.`);
  if (!Number.isSafeInteger(record.issueNumber) || record.issueNumber <= 0) throw new Error(`${path}.issueNumber is invalid.`);
  digest(record.configHash, `${path}.configHash`);
  objectId(record.baseCommit, `${path}.baseCommit`);
  objectId(record.baseTree, `${path}.baseTree`);
  const baseline = createPlanParent({
    id: record.id, repository: record.repository, issueNumber: record.issueNumber,
    configHash: record.configHash, baseCommit: record.baseCommit, baseTree: record.baseTree,
    graph: record.graph,
  });
  if (record.graphHash !== baseline.graphHash || canonicalJson(record.waves) !== canonicalJson(baseline.waves)) {
    throw new Error(`${path} graph hash or deterministic waves do not match.`);
  }
  if (!Number.isSafeInteger(record.currentWave) || record.currentWave < 0
    || record.currentWave >= record.waves.length) throw new Error(`${path}.currentWave is invalid.`);
  validateCheckpoint(record.checkpoint);
  objectId(record.integratedCommit, `${path}.integratedCommit`);
  objectId(record.integratedTree, `${path}.integratedTree`);
  if (!Number.isSafeInteger(record.integrationCursor) || record.integrationCursor < 0
    || record.integrationCursor > (record.waves[record.currentWave]?.length ?? 0)) {
    throw new Error(`${path}.integrationCursor is invalid.`);
  }
  if (!record.children || typeof record.children !== 'object' || Array.isArray(record.children)) {
    throw new Error(`${path}.children must be an object.`);
  }
  for (const [stableId, child] of Object.entries(record.children)) {
    exactKeys(child as unknown as Record<string, unknown>, [
      'stableId', 'missionId', 'wave', 'baseCheckpointCommit', 'baseCheckpointTree', 'descriptor',
    ], `${path}.children.${stableId}`);
    if (child.stableId !== stableId
      || child.missionId !== childMissionId({ parentId: record.id, nodeId: stableId })
      || !Number.isSafeInteger(child.wave) || child.wave < 0 || child.wave >= record.waves.length
      || !record.waves[child.wave]?.includes(stableId)) {
      throw new Error(`${path}.children.${stableId} identity is invalid.`);
    }
    objectId(child.baseCheckpointCommit, `${path}.children.${stableId}.baseCheckpointCommit`);
    objectId(child.baseCheckpointTree, `${path}.children.${stableId}.baseCheckpointTree`);
    if (child.descriptor) validateDescriptor(child.descriptor, record);
  }
  if (!Array.isArray(record.integrationHistory) || !Array.isArray(record.validationReceiptIds)
    || !Array.isArray(record.validationHistory) || !Array.isArray(record.labelTransitions)) {
    throw new Error(`${path} histories must be arrays.`);
  }
  record.integrationHistory.forEach((intent) => validateStoredIntent(intent, record));
  if (record.integrationIntent) validateStoredIntent(record.integrationIntent, record);
  if (new Set(record.integrationHistory.map((intent) => intent.actionKey)).size
    !== record.integrationHistory.length) throw new Error(`${path}.integrationHistory contains duplicates.`);
  if (record.state === 'integrating' && !record.integrationIntent) {
    throw new Error(`${path} integrating state requires an integration intent.`);
  }
  if (record.integrationIntent && ![
    'integrating', 'wave-waiting', 'recovery-waiting', 'cancelling',
    'external-input-required', 'safety-stop',
  ].includes(record.state)) throw new Error(`${path}.integrationIntent is invalid in ${record.state}.`);
  record.labelTransitions.forEach(validateLabelTransition);
  validateOptionalStrings(record.validationReceiptIds, `${path}.validationReceiptIds`);
  validateOptionalStrings(record.validationHistory, `${path}.validationHistory`);
  if (record.state === 'wave-waiting') {
    if (!record.resumeTarget || !record.nextEligibleAt || !record.resumableReason
      || !record.requiredPredicate || !record.actionKey) {
      throw new Error(`${path} wave-waiting requires complete resume metadata.`);
    }
    exactTimestamp(record.nextEligibleAt, `${path}.nextEligibleAt`);
    if (record.resumeTarget === 'integrating' && !record.integrationIntent) {
      throw new Error(`${path} integrating resume requires its durable intent.`);
    }
  } else if (record.resumeTarget || record.nextEligibleAt || record.resumableReason || record.requiredPredicate) {
    throw new Error(`${path} resume metadata is allowed only in wave-waiting.`);
  }
  if (record.cancellation) validateCancellation(record.cancellation);
  if (record.cancellation && record.state !== 'cancelling' && record.state !== 'cancelled'
    && record.state !== 'safety-stop') throw new Error(`${path}.cancellation state is invalid.`);
  if (record.claim) validateParentClaim(record.claim, path);
  if (record.claim && terminal(record.state)) throw new Error(`${path}.claim is forbidden in terminal state.`);
  if (record.state !== 'created' && record.state !== 'next-wave') {
    for (const stableId of record.waves[record.currentWave] ?? []) {
      if (!record.children[stableId]) throw new Error(`${path} current wave child ${stableId} is missing.`);
    }
  }
  if (record.state === 'publication-prepared' && !record.publicationId) {
    throw new Error(`${path} publication-prepared requires publicationId.`);
  }
  if (record.recoveryTarget && record.state !== 'recovery-waiting') {
    throw new Error(`${path}.recoveryTarget is allowed only in recovery-waiting.`);
  }
  if (record.state === 'recovery-waiting' && !record.recoveryMissionId) {
    throw new Error(`${path} recovery-waiting requires recoveryMissionId.`);
  }
}

export function linkWaveChildren(record: PlanParentRecord): PlanParentRecord {
  if (record.state !== 'created' && record.state !== 'next-wave') {
    throw new Error(`Plan Parent cannot link children from state ${record.state}.`);
  }
  const next = structuredClone(record);
  for (const stableId of record.waves[record.currentWave] ?? []) {
    if (next.children[stableId]) continue;
    next.children[stableId] = {
      stableId,
      missionId: childMissionId({ parentId: record.id, nodeId: stableId }),
      wave: record.currentWave,
      baseCheckpointCommit: record.checkpoint.commitSha,
      baseCheckpointTree: record.checkpoint.treeSha,
    };
  }
  return transitionPlanParent(next, { type: 'wave-linked' });
}

function computeWaves(graph: PlanGraph): string[][] {
  const dependencies = new Map(graph.nodes.map((node) => [node.stableId, new Set(node.dependsOn)]));
  for (const edge of graph.edges) dependencies.get(edge.to)?.add(edge.from);
  const waves: string[][] = [];
  while (dependencies.size > 0) {
    const ready = [...dependencies].filter(([, deps]) => deps.size === 0)
      .map(([id]) => id).sort();
    if (ready.length === 0) throw new Error('Plan Parent graph contains a dependency cycle.');
    waves.push(ready);
    for (const id of ready) dependencies.delete(id);
    for (const deps of dependencies.values()) ready.forEach((id) => deps.delete(id));
  }
  return waves;
}

function validateDescriptor(value: PlanParentChildDescriptor, parent: PlanParentRecord): void {
  requireText(value.stableId, 'Plan Parent descriptor stableId');
  objectId(value.childCommit, 'Plan Parent descriptor childCommit');
  objectId(value.childTree, 'Plan Parent descriptor childTree');
  objectId(value.baseCheckpointCommit, 'Plan Parent descriptor base checkpoint');
  digest(value.configHash, 'Plan Parent descriptor configHash');
  digest(value.reservationFingerprint, 'Plan Parent descriptor reservationFingerprint');
  requireText(value.executorVersion, 'Plan Parent descriptor executorVersion');
  validateStrings(value.changedPaths, 'Plan Parent descriptor changedPaths');
  validateStrings(value.validationReceiptIds, 'Plan Parent descriptor validation receipts');
  if (value.configHash !== parent.configHash) throw new Error('Plan Parent descriptor config hash mismatch.');
}

function validateIntent(value: PlanParentIntegrationIntent, parent: PlanParentRecord): void {
  if (value.version !== 1 || value.wave !== parent.currentWave
    || value.cursor !== parent.integrationCursor
    || value.stableId !== parent.waves[parent.currentWave]?.[parent.integrationCursor]) {
    throw new Error('Plan Parent integration intent cursor does not match deterministic order.');
  }
  requireText(value.actionKey, 'Plan Parent integration actionKey');
  objectId(value.expectedOldCommit, 'Plan Parent integration old commit');
  objectId(value.expectedNewCommit, 'Plan Parent integration new commit');
  objectId(value.expectedNewTree, 'Plan Parent integration new tree');
  if (value.expectedOldCommit !== parent.integratedCommit) {
    throw new Error('Plan Parent integration intent old identity mismatch.');
  }
}

function validateStoredIntent(value: PlanParentIntegrationIntent, parent: PlanParentRecord): void {
  if (value.version !== 1 || !Number.isSafeInteger(value.wave) || value.wave < 0
    || value.wave >= parent.waves.length || !Number.isSafeInteger(value.cursor) || value.cursor < 0
    || value.stableId !== parent.waves[value.wave]?.[value.cursor]) {
    throw new Error('Plan Parent stored integration intent is invalid.');
  }
  requireText(value.actionKey, 'Plan Parent stored integration actionKey');
  objectId(value.expectedOldCommit, 'Plan Parent stored integration old commit');
  objectId(value.expectedNewCommit, 'Plan Parent stored integration new commit');
  objectId(value.expectedNewTree, 'Plan Parent stored integration new tree');
}

function validateCheckpoint(value: PlanParentCheckpoint): void {
  objectId(value.commitSha, 'Plan Parent checkpoint commit');
  objectId(value.treeSha, 'Plan Parent checkpoint tree');
}

function validateLabelTransition(value: PlanParentLabelTransition): void {
  requireText(value.stableId, 'Plan Parent label stableId');
  requireText(value.from, 'Plan Parent label from');
  requireText(value.to, 'Plan Parent label to');
  requireText(value.receiptId, 'Plan Parent label receiptId');
}

function validateCancellation(value: MissionCancellation): void {
  exactTimestamp(value.requestedAt, 'Plan Parent cancellation requestedAt');
  requireText(value.requestedBy, 'Plan Parent cancellation requestedBy');
}

function transientAllowed(state: PlanParentState, target: PlanParentResumeTarget): boolean {
  return state === target || (state === 'integrating' && target === 'wave-prepared')
    || (state === 'publication-prepared' && target === 'publication-prepared')
    || (state === 'recovery-waiting' && target === 'recovery-waiting');
}

function revokeTransient(record: PlanParentRecord): void {
  delete record.resumeTarget;
  delete record.nextEligibleAt;
  delete record.resumableReason;
  delete record.requiredPredicate;
  delete record.actionKey;
}

function terminal(state: PlanParentState): boolean {
  return ['external-input-required', 'safety-stop', 'cancelled', 'completed'].includes(state);
}

function validateStrings(values: string[], field: string): void {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${field} must be non-empty.`);
  values.forEach((value) => requireText(value, field));
  if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates.`);
}

function validateOptionalStrings(values: string[], field: string): void {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  values.forEach((value) => requireText(value, field));
  if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates.`);
}

function validateParentClaim(claim: MissionClaim, path: string): void {
  if (claim.version !== 1 || !Number.isSafeInteger(claim.fencingEpoch) || claim.fencingEpoch <= 0) {
    throw new Error(`${path}.claim is invalid.`);
  }
  [claim.token, claim.daemonId, claim.hostId, claim.bootNonce].forEach((value) =>
    requireText(value, `${path}.claim identity`));
  exactTimestamp(claim.claimedAt, `${path}.claim.claimedAt`);
  exactTimestamp(claim.leaseUntil, `${path}.claim.leaseUntil`);
  if (claim.leaseUntil <= claim.claimedAt) throw new Error(`${path}.claim lease is invalid.`);
  if (!Array.isArray(claim.processes)) throw new Error(`${path}.claim.processes must be an array.`);
  const identities = new Set<string>();
  for (const process of claim.processes) {
    requireText(process.actionKey, `${path}.claim.process.actionKey`);
    if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
      throw new Error(`${path}.claim.process.pid is invalid.`);
    }
    if (process.hostId !== claim.hostId || process.bootNonce !== claim.bootNonce) {
      throw new Error(`${path}.claim process host or boot identity is invalid.`);
    }
    exactTimestamp(process.startedAt, `${path}.claim.process.startedAt`);
    const identity = `${process.hostId}:${process.bootNonce}:${process.pid}:${process.actionKey}`;
    if (identities.has(identity)) throw new Error(`${path}.claim contains duplicate process identity.`);
    identities.add(identity);
  }
}

function exactKeys(record: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) throw new Error(`${path} has unexpected field ${key}.`);
  }
}

function requireText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty.`);
}

function objectId(value: string, field: string): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) throw new Error(`${field} must be a Git object ID.`);
}

function digest(value: string, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${field} must be a SHA-256 digest.`);
}

function exactTimestamp(value: string, field: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${field} must be an exact UTC ISO timestamp.`);
  }
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
