import { createHash } from 'node:crypto';

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

function stableIdentifier(prefix: string, payload: Readonly<Record<string, unknown>>): string {
  const digest = createHash('sha256')
    .update(Buffer.from(JSON.stringify(payload), 'utf8'))
    .digest('hex');
  return `${prefix}:v1:${digest}`;
}

export function missionId(input: Readonly<{
  repository: string;
  issueNumber: number;
  attempt: number;
}>): string {
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error('issueNumber must be a positive integer');
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
    throw new Error('attempt must be a non-negative integer');
  }
  return stableIdentifier('mission', {
    kind: 'mission',
    version: 1,
    repository: requireText(input.repository, 'repository'),
    issueNumber: input.issueNumber,
    attempt: input.attempt,
  });
}

export function childMissionId(input: Readonly<{
  parentId: string;
  nodeId: string;
}>): string {
  return stableIdentifier('mission-child', {
    kind: 'mission-child',
    version: 1,
    parentId: requireText(input.parentId, 'parentId'),
    nodeId: requireText(input.nodeId, 'nodeId'),
  });
}

export function publicationAttemptId(input: Readonly<{
  ownerId: string;
  candidateCommit: string;
  baseSha: string;
  configHash: string;
}>): string {
  return stableIdentifier('publication', {
    kind: 'publication-attempt',
    version: 1,
    ownerId: requireText(input.ownerId, 'ownerId'),
    candidateCommit: requireText(input.candidateCommit, 'candidateCommit'),
    baseSha: requireText(input.baseSha, 'baseSha'),
    configHash: requireText(input.configHash, 'configHash'),
  });
}

export function integrationRecoveryMissionId(input: Readonly<{
  parentId: string;
  wave: number;
  checkpointCommit: string;
  integratedTree: string;
  cursor: number;
  childCommit: string;
  configHash: string;
}>): string {
  if (!Number.isSafeInteger(input.wave) || input.wave < 0
    || !Number.isSafeInteger(input.cursor) || input.cursor < 0) {
    throw new Error('integration recovery wave and cursor must be non-negative integers');
  }
  return stableIdentifier('mission-integration-recovery', {
    kind: 'mission-integration-recovery',
    version: 1,
    parentId: requireText(input.parentId, 'parentId'),
    wave: input.wave,
    checkpointCommit: requireText(input.checkpointCommit, 'checkpointCommit'),
    integratedTree: requireText(input.integratedTree, 'integratedTree'),
    cursor: input.cursor,
    childCommit: requireText(input.childCommit, 'childCommit'),
    configHash: requireText(input.configHash, 'configHash'),
  });
}

export function validationRecoveryMissionId(input: Readonly<{
  parentId: string;
  phase: string;
  candidateTree: string;
  configHash: string;
}>): string {
  return stableIdentifier('mission-validation-recovery', {
    kind: 'mission-validation-recovery',
    version: 1,
    parentId: requireText(input.parentId, 'parentId'),
    phase: requireText(input.phase, 'phase'),
    candidateTree: requireText(input.candidateTree, 'candidateTree'),
    configHash: requireText(input.configHash, 'configHash'),
  });
}
