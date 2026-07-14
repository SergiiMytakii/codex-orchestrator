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
