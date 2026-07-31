import { randomUUID } from 'node:crypto';

import { canonicalJson, sha256 } from './containment.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export type ProcessStartIdentity =
  | { kind: 'linux-start-ticks'; value: string }
  | { kind: 'unavailable'; platform: 'darwin' };

export interface AttemptProcessIdentity {
  host: string;
  bootId: string;
  pid: number;
  processGroupId: number;
  processStartIdentity: ProcessStartIdentity;
  launchedAt: string;
}

interface AttemptBase {
  attemptId: string;
  runId: string;
  operationId: string;
  operationSourceId: string;
  incarnationId: string;
  resultPath: string;
  preparedAt: string;
  cleanup: 'pending' | 'confirmed';
  cleanupConfirmedAt: string | null;
}

export type ActiveAttempt =
  | (AttemptBase & { stage: 'prepared' })
  | (AttemptBase & { stage: 'launched'; process: AttemptProcessIdentity })
  | (AttemptBase & {
      stage: 'observed';
      process: AttemptProcessIdentity;
      observation: { leader: 'absent' | 'reused'; group: 'absent'; observedAt: string };
      result: { path: string; sha256: string } | null;
    })
  | (AttemptBase & {
      stage: 'adopted';
      process: AttemptProcessIdentity;
      observation: { leader: 'absent' | 'reused'; group: 'absent'; observedAt: string };
      result: { path: string; sha256: string };
      adoptedAt: string;
    });

export function createActiveAttempt(input: {
  runId: string;
  operationId: string;
  operationSourceId: string;
  resultPath: string;
  preparedAt: string;
}, createIncarnationId: () => string = randomUUID): Extract<ActiveAttempt, { stage: 'prepared' }> {
  const incarnationId = createIncarnationId();
  uuid(input.runId, 'runId');
  uuid(incarnationId, 'incarnationId');
  text(input.operationId, 'operationId');
  text(input.operationSourceId, 'operationSourceId');
  absolutePath(input.resultPath);
  timestamp(input.preparedAt, 'preparedAt');
  return {
    ...structuredClone(input),
    incarnationId,
    attemptId: sha256(canonicalJson({
      runId: input.runId,
      operationId: input.operationId,
      operationSourceId: input.operationSourceId,
      incarnationId,
    })),
    stage: 'prepared',
    cleanup: 'pending',
    cleanupConfirmedAt: null,
  };
}

export function launchActiveAttempt(
  attempt: Extract<ActiveAttempt, { stage: 'prepared' }>,
  process: AttemptProcessIdentity,
): Extract<ActiveAttempt, { stage: 'launched' }> {
  requireStage(validateActiveAttempt(attempt), 'prepared');
  validateProcess(process);
  return { ...structuredClone(attempt), stage: 'launched', process: structuredClone(process) };
}

export function observeActiveAttempt(
  attempt: Extract<ActiveAttempt, { stage: 'launched' }>,
  observation: {
    leader: 'same' | 'reused' | 'absent' | 'unknown';
    group: 'live' | 'absent' | 'unknown';
    result: { path: string; sha256: string } | null;
    observedAt: string;
  },
): Extract<ActiveAttempt, { stage: 'observed' }> {
  requireStage(validateActiveAttempt(attempt), 'launched');
  if (!['absent', 'reused'].includes(observation.leader) || observation.group !== 'absent') {
    throw new Error('active attempt process absence is not confirmed');
  }
  const leader = observation.leader as 'absent' | 'reused';
  timestamp(observation.observedAt, 'observedAt');
  if (observation.result) {
    if (observation.result.path !== attempt.resultPath) throw new Error('active attempt result path mismatch');
    if (!SHA256.test(observation.result.sha256)) throw new Error('active attempt result hash is invalid');
  }
  return {
    ...structuredClone(attempt),
    stage: 'observed',
    observation: { leader, group: 'absent', observedAt: observation.observedAt },
    result: structuredClone(observation.result),
  };
}

export function adoptActiveAttempt(
  attempt: Extract<ActiveAttempt, { stage: 'observed' }>,
  adoptedAt: string,
): Extract<ActiveAttempt, { stage: 'adopted' }> {
  requireStage(validateActiveAttempt(attempt), 'observed');
  if (!attempt.result) throw new Error('active attempt has no result to adopt');
  timestamp(adoptedAt, 'adoptedAt');
  return { ...structuredClone(attempt), stage: 'adopted', result: structuredClone(attempt.result), adoptedAt };
}

export function confirmActiveAttemptCleanup<T extends ActiveAttempt>(attempt: T, confirmedAt: string): T {
  validateActiveAttempt(attempt);
  timestamp(confirmedAt, 'cleanupConfirmedAt');
  if (attempt.cleanup === 'confirmed') {
    if (attempt.cleanupConfirmedAt !== confirmedAt) throw new Error('active attempt cleanup is already confirmed');
    return structuredClone(attempt);
  }
  return { ...structuredClone(attempt), cleanup: 'confirmed', cleanupConfirmedAt: confirmedAt };
}

export function clearActiveAttempt(attempt: ActiveAttempt): undefined {
  validateActiveAttempt(attempt);
  if (attempt.cleanup !== 'confirmed') throw new Error('active attempt cleanup is not confirmed');
  return undefined;
}

export function validateActiveAttempt(value: unknown): ActiveAttempt {
  record(value, 'active attempt');
  const stage = value.stage;
  const keys = [
    'attemptId', 'runId', 'operationId', 'operationSourceId', 'incarnationId', 'resultPath',
    'preparedAt', 'cleanup', 'cleanupConfirmedAt', 'stage',
    ...(stage === 'launched' ? ['process'] : []),
    ...(stage === 'observed' ? ['process', 'observation', 'result'] : []),
    ...(stage === 'adopted' ? ['process', 'observation', 'result', 'adoptedAt'] : []),
  ];
  if (!['prepared', 'launched', 'observed', 'adopted'].includes(String(stage))) {
    throw new Error('active attempt stage is invalid');
  }
  exactKeys(value, keys, 'active attempt');
  uuid(value.runId, 'runId');
  uuid(value.incarnationId, 'incarnationId');
  text(value.operationId, 'operationId');
  text(value.operationSourceId, 'operationSourceId');
  absolutePath(value.resultPath);
  timestamp(value.preparedAt, 'preparedAt');
  const expectedAttemptId = sha256(canonicalJson({
    runId: value.runId,
    operationId: value.operationId,
    operationSourceId: value.operationSourceId,
    incarnationId: value.incarnationId,
  }));
  if (value.attemptId !== expectedAttemptId) throw new Error('active attempt attemptId is invalid');
  if (value.cleanup === 'pending') {
    if (value.cleanupConfirmedAt !== null) throw new Error('pending active attempt has cleanup confirmation');
  } else if (value.cleanup === 'confirmed') {
    timestamp(value.cleanupConfirmedAt, 'cleanupConfirmedAt');
  } else {
    throw new Error('active attempt cleanup status is invalid');
  }
  if (stage !== 'prepared') validateProcess(value.process);
  if (stage === 'observed' || stage === 'adopted') {
    validateObservation(value.observation);
    validateResult(value.result, value.resultPath, stage === 'adopted');
  }
  if (stage === 'adopted') timestamp(value.adoptedAt, 'adoptedAt');
  return structuredClone(value as unknown as ActiveAttempt);
}

function validateProcess(value: unknown): void {
  record(value, 'active attempt process');
  exactKeys(value, ['host', 'bootId', 'pid', 'processGroupId', 'processStartIdentity', 'launchedAt'], 'active attempt process');
  text(value.host, 'process host');
  text(value.bootId, 'process bootId');
  positive(value.pid, 'process pid');
  positive(value.processGroupId, 'process group id');
  timestamp(value.launchedAt, 'launchedAt');
  record(value.processStartIdentity, 'process start identity');
  if (value.processStartIdentity.kind === 'linux-start-ticks') {
    exactKeys(value.processStartIdentity, ['kind', 'value'], 'Linux process start identity');
    text(value.processStartIdentity.value, 'process start ticks');
    if (!/^[0-9]+$/u.test(value.processStartIdentity.value)) throw new Error('process start ticks is invalid');
  } else if (value.processStartIdentity.kind === 'unavailable' && value.processStartIdentity.platform === 'darwin') {
    exactKeys(value.processStartIdentity, ['kind', 'platform'], 'Darwin process start identity');
  } else {
    throw new Error('process start identity is invalid');
  }
}

function validateObservation(value: unknown): void {
  record(value, 'active attempt observation');
  exactKeys(value, ['leader', 'group', 'observedAt'], 'active attempt observation');
  if (!['absent', 'reused'].includes(String(value.leader)) || value.group !== 'absent') {
    throw new Error('active attempt observation is invalid');
  }
  timestamp(value.observedAt, 'observedAt');
}

function validateResult(value: unknown, resultPath: string, required: boolean): void {
  if (value === null && !required) return;
  record(value, 'active attempt result');
  exactKeys(value, ['path', 'sha256'], 'active attempt result');
  if (value.path !== resultPath) throw new Error('active attempt result path mismatch');
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) throw new Error('active attempt result hash is invalid');
}

function requireStage(value: ActiveAttempt, stage: ActiveAttempt['stage']): void {
  if (value.stage !== stage) throw new Error(`active attempt must be ${stage}`);
}

function record(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is invalid`);
}

function exactKeys(value: Record<string, unknown>, expected: string[], field: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${field} must contain exact keys`);
  }
}

function uuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new Error(`${field} is invalid`);
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 16 * 1024) throw new Error(`${field} is invalid`);
}
function positive(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${field} is invalid`);
}
function absolutePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) throw new Error('resultPath is invalid');
}
function timestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${field} is invalid`);
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${field} is invalid`);
}
