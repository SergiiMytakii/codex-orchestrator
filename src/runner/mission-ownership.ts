export interface MissionMarker {
  missionId: string;
  issueNumber: number;
  repository: string;
  deploymentId: string;
}

export type MissionOwnershipMode = 'off' | 'shadow' | 'enabled';

export interface MissionOwnershipInput {
  mode: MissionOwnershipMode;
  markerLabelPresent: boolean;
  markerComments: string[];
  localMissionId?: string;
  legacyRunPresent: boolean;
  expectedIssueNumber: number;
  expectedRepository: string;
  expectedDeploymentId: string;
  claimResponseLost: boolean;
}

export type MissionOwnershipDecision =
  | { kind: 'legacy' }
  | { kind: 'legacy-ineligible'; reason: 'mission-marker-present' }
  | { kind: 'shadow' }
  | { kind: 'mission' }
  | { kind: 'resumable'; reason: 'mission-marker-claim-unconfirmed' | 'mission-marker-not-claimed' }
  | { kind: 'safety-stop'; reason: string };

const markerPrefix = '<!-- codex-orchestrator:mission:v1 ';
const markerSuffix = ' -->';

export function formatMissionMarker(marker: MissionMarker): string {
  assertMissionMarker(marker);
  const payload = JSON.stringify({
    missionId: marker.missionId,
    issueNumber: marker.issueNumber,
    repository: marker.repository,
    deploymentId: marker.deploymentId,
  });
  return `${markerPrefix}${payload}${markerSuffix}`;
}

export function parseMissionMarker(comment: string): MissionMarker | undefined {
  const firstLine = comment.split(/\r?\n/u, 1)[0] ?? '';
  if (!firstLine.startsWith(markerPrefix) || !firstLine.endsWith(markerSuffix)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(firstLine.slice(markerPrefix.length, -markerSuffix.length)) as unknown;
    assertMissionMarker(parsed);
    if (formatMissionMarker(parsed) !== firstLine) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function classifyMissionOwnership(input: MissionOwnershipInput): MissionOwnershipDecision {
  const hasRemoteMarker = input.markerLabelPresent || input.markerComments.length > 0;
  if (input.mode === 'off') {
    return hasRemoteMarker
      ? { kind: 'legacy-ineligible', reason: 'mission-marker-present' }
      : { kind: 'legacy' };
  }
  if (input.mode === 'shadow') {
    return hasRemoteMarker
      ? { kind: 'safety-stop', reason: 'shadow-mode-must-not-own-remote-marker' }
      : { kind: 'shadow' };
  }

  if (input.legacyRunPresent && hasRemoteMarker) {
    return { kind: 'safety-stop', reason: 'legacy-and-mission-ownership-conflict' };
  }
  if (!input.localMissionId) {
    return { kind: 'safety-stop', reason: 'mission-marker-has-no-local-mission' };
  }
  if (input.markerComments.length === 0) {
    return input.claimResponseLost
      ? { kind: 'resumable', reason: 'mission-marker-claim-unconfirmed' }
      : { kind: 'resumable', reason: 'mission-marker-not-claimed' };
  }
  if (!input.markerLabelPresent) {
    return { kind: 'safety-stop', reason: 'mission-marker-comment-without-label' };
  }
  if (input.markerComments.length !== 1) {
    return { kind: 'safety-stop', reason: 'multiple-mission-marker-comments' };
  }

  const marker = parseMissionMarker(input.markerComments[0]!);
  if (!marker) {
    return { kind: 'safety-stop', reason: 'invalid-mission-marker-comment' };
  }
  if (marker.missionId !== input.localMissionId
    || marker.issueNumber !== input.expectedIssueNumber
    || marker.repository !== input.expectedRepository
    || marker.deploymentId !== input.expectedDeploymentId) {
    return { kind: 'safety-stop', reason: 'mission-marker-identity-mismatch' };
  }
  return { kind: 'mission' };
}

function assertMissionMarker(value: unknown): asserts value is MissionMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Mission marker must be an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expectedKeys = ['missionId', 'issueNumber', 'repository', 'deploymentId'];
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    throw new Error('Mission marker has unexpected fields.');
  }
  if (typeof record.missionId !== 'string' || record.missionId.length === 0
    || typeof record.issueNumber !== 'number' || !Number.isInteger(record.issueNumber) || record.issueNumber <= 0
    || typeof record.repository !== 'string' || record.repository.length === 0
    || typeof record.deploymentId !== 'string' || record.deploymentId.length === 0) {
    throw new Error('Mission marker fields are invalid.');
  }
}
