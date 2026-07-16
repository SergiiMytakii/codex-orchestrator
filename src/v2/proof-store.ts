import type { ProofReceipt } from './proof-report.js';
import { join } from 'node:path';

import { AtomicStateFile, type AtomicStateFileOptions } from './atomic-store.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_STATUSES = [
  'passed',
  'needs-rework',
  'external-block',
  'transport-failed',
  'cancelled',
  'internal-error',
] as const;

export type ProofStatus = 'prepared' | 'running' | typeof TERMINAL_STATUSES[number];

export interface ProofStateV1 {
  schema: 'codex-orchestrator.acceptance-proof-state';
  version: 1;
  generation: number;
  proofId: string;
  bindingSha256: string;
  status: ProofStatus;
  attempts: Array<{
    attemptId: string;
    purpose: 'proof' | 'transport-retry' | 'report-repair';
    status: 'prepared' | 'running' | 'terminal';
    reportSha256?: string;
  }>;
  receipt?: ProofReceipt;
  startedAt: string;
  updatedAt: string;
}

export type ProofStateBodyV1 = Omit<ProofStateV1, 'generation'>;

export interface ProofRecordWriter {
  read(proofId: string): Promise<ProofStateV1 | undefined>;
  compareAndSwap(
    proofId: string,
    expectedBinding: string,
    expectedGeneration: number,
    next: ProofStateBodyV1,
  ): Promise<ProofStateV1>;
}

export class InMemoryProofRecordWriter implements ProofRecordWriter {
  private readonly states = new Map<string, ProofStateV1>();

  async read(proofId: string): Promise<ProofStateV1 | undefined> {
    const state = this.states.get(proofId);
    return state ? structuredClone(state) : undefined;
  }

  async compareAndSwap(
    proofId: string,
    expectedBinding: string,
    expectedGeneration: number,
    next: ProofStateBodyV1,
  ): Promise<ProofStateV1> {
    const current = this.states.get(proofId);
    if (!current) {
      if (expectedGeneration !== 0) throw new Error('proof state generation is stale');
    } else {
      if (current.bindingSha256 !== expectedBinding) throw new Error('proof binding mismatch');
      if (current.generation !== expectedGeneration) throw new Error('proof state generation is stale');
    }
    if (next.proofId !== proofId || next.bindingSha256 !== expectedBinding) throw new Error('proof state identity mismatch');
    const state: ProofStateV1 = { ...structuredClone(next), generation: expectedGeneration + 1 };
    validateProofState(state);
    this.states.set(proofId, state);
    return structuredClone(state);
  }
}

export class FileProofRecordWriter implements ProofRecordWriter {
  constructor(
    private readonly proofsRoot: string,
    private readonly options: AtomicStateFileOptions = {},
  ) {}

  async read(proofId: string): Promise<ProofStateV1 | undefined> {
    return this.file(proofId).read();
  }

  async compareAndSwap(
    proofId: string,
    expectedBinding: string,
    expectedGeneration: number,
    next: ProofStateBodyV1,
  ): Promise<ProofStateV1> {
    assertProofId(proofId);
    assertSha256(expectedBinding, 'expected proof binding');
    if (next.proofId !== proofId || next.bindingSha256 !== expectedBinding) throw new Error('proof state identity mismatch');
    const current = await this.read(proofId);
    if (current && current.bindingSha256 !== expectedBinding) throw new Error('proof binding mismatch');
    return this.file(proofId).compareAndSwap(expectedGeneration, {
      ...structuredClone(next),
      generation: expectedGeneration + 1,
    });
  }

  private file(proofId: string): AtomicStateFile<ProofStateV1> {
    assertProofId(proofId);
    return new AtomicStateFile(join(this.proofsRoot, proofId, 'state.json'), validateProofState, this.options);
  }
}

export function validateProofState(value: unknown): ProofStateV1 {
  assertExactObject(value, [
    'schema',
    'version',
    'generation',
    'proofId',
    'bindingSha256',
    'status',
    'attempts',
    ...(hasReceipt(value) ? ['receipt'] : []),
    'startedAt',
    'updatedAt',
  ], 'proof state');
  if (value.schema !== 'codex-orchestrator.acceptance-proof-state' || value.version !== 1) {
    throw new Error('proof state schema/version is invalid');
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) throw new Error('proof state generation is invalid');
  assertNonEmptyString(value.proofId, 'proof state.proofId');
  assertSha256(value.bindingSha256, 'proof state.bindingSha256');
  if (!['prepared', 'running', ...TERMINAL_STATUSES].includes(value.status as ProofStatus)) throw new Error('proof state status is invalid');
  if (!Array.isArray(value.attempts) || value.attempts.length === 0 || value.attempts.length > 256) {
    throw new Error('proof state attempts are invalid');
  }
  const attemptIds = new Set<string>();
  const purposeCounts = new Map<string, number>();
  for (const [index, attempt] of value.attempts.entries()) {
    const keys = hasReportSha(attempt) ? ['attemptId', 'purpose', 'status', 'reportSha256'] : ['attemptId', 'purpose', 'status'];
    assertExactObject(attempt, keys, `proof state.attempts[${index}]`);
    assertNonEmptyString(attempt.attemptId, `proof state.attempts[${index}].attemptId`);
    if (!['proof', 'transport-retry', 'report-repair'].includes(attempt.purpose as string)) throw new Error('proof attempt purpose is invalid');
    const purpose = attempt.purpose as 'proof' | 'transport-retry' | 'report-repair';
    if (!['prepared', 'running', 'terminal'].includes(attempt.status as string)) throw new Error('proof attempt status is invalid');
    if (hasReportSha(attempt)) assertSha256(attempt.reportSha256, 'proof attempt reportSha256');
    if (attemptIds.has(attempt.attemptId)) throw new Error('proof attempt IDs must be unique');
    attemptIds.add(attempt.attemptId);
    purposeCounts.set(purpose, (purposeCounts.get(purpose) ?? 0) + 1);
    if (index === 0 && purpose !== 'proof') throw new Error('first proof attempt purpose is invalid');
    if (index > 0 && purpose === 'proof') throw new Error('proof purpose cannot repeat');
    if (index < value.attempts.length - 1 && attempt.status !== 'terminal') throw new Error('prior proof attempts must be terminal');
  }
  if ((purposeCounts.get('transport-retry') ?? 0) > 1 || (purposeCounts.get('report-repair') ?? 0) > 1) {
    throw new Error('proof retry budget is exceeded');
  }
  const terminal = TERMINAL_STATUSES.includes(value.status as typeof TERMINAL_STATUSES[number]);
  if (terminal !== hasReceipt(value)) throw new Error('proof terminal state and receipt must appear together');
  if (hasReceipt(value)) validateReceipt(value.receipt);
  assertIsoTimestamp(value.startedAt);
  assertIsoTimestamp(value.updatedAt);
  if (Date.parse(value.updatedAt as string) < Date.parse(value.startedAt as string)) throw new Error('proof state timestamps are reversed');
  return value as unknown as ProofStateV1;
}

function validateReceipt(value: unknown): asserts value is ProofReceipt {
  assertExactObject(value, ['proofId', 'bindingSha256', 'summary', 'publishableEvidence', 'localEvidenceId'], 'proof receipt');
  assertNonEmptyString(value.proofId, 'proof receipt.proofId');
  assertSha256(value.bindingSha256, 'proof receipt.bindingSha256');
  assertNonEmptyString(value.summary, 'proof receipt.summary');
  assertNonEmptyString(value.localEvidenceId, 'proof receipt.localEvidenceId');
  if (!Array.isArray(value.publishableEvidence) || value.publishableEvidence.length > 256) {
    throw new Error('proof receipt publishableEvidence is invalid');
  }
  for (const evidence of value.publishableEvidence) {
    assertExactObject(evidence, ['ref', 'kind', 'sha256', 'description'], 'proof receipt evidence');
    assertNonEmptyString(evidence.ref, 'proof receipt evidence.ref');
    if (evidence.kind !== 'screenshot' && evidence.kind !== 'summary') throw new Error('proof receipt evidence.kind is invalid');
    assertSha256(evidence.sha256, 'proof receipt evidence.sha256');
    assertNonEmptyString(evidence.description, 'proof receipt evidence.description');
  }
}

function hasReceipt(value: unknown): value is Record<string, unknown> & { receipt: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, 'receipt');
}

function hasReportSha(value: unknown): value is Record<string, unknown> & { reportSha256: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, 'reportSha256');
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) throw new Error(`${field} is invalid`);
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
}

function assertProofId(value: unknown): asserts value is string {
  assertNonEmptyString(value, 'proofId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value === '.' || value === '..') throw new Error('proofId is unsafe');
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('proof state updatedAt is invalid');
  }
}
