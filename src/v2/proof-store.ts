import type { ProofReceipt } from './proof-report.js';
import { validateDurableReportInvocation, type DurableReportInvocationV1 } from './contained-report-operation.js';
import { join, posix } from 'node:path';

import { AtomicStateFile, type AtomicStateFileOptions } from './atomic-store.js';
import { writeDurableAtomicFile } from './adapters/durable-atomic-file.js';
import { canonicalJson, sha256 } from './containment.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_STATUSES = [
  'passed',
  'needs-rework',
  'external-block',
  'transport-failed',
  'cancelled',
  'internal-error',
] as const;

export type ProofStatus = 'active' | typeof TERMINAL_STATUSES[number];

export interface ProofIosInputsV1 {
  helperPath: string; leaseRoot: string; leaseArtifactPath: string; proofId: string;
  ownerPid: number; xcrunPath: string; runtimeId: string | null; deviceTypeId: string | null;
}

export interface ProofStateV1 {
  schema: 'codex-orchestrator.acceptance-proof-state';
  version: 1;
  generation: number;
  proofId: string;
  bindingSha256: string;
  status: ProofStatus;
  reportRepairs: 0 | 1;
  repairFindings: string[];
  repairArtifactSha256?: Record<string, string>;
  iosProofInputs?: ProofIosInputsV1;
  invocation?: DurableReportInvocationV1;
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
    const file = this.file(proofId);
    try { return await file.read(); }
    catch (error) {
      return file.withExclusiveUnparsedRaw(async (priorBytes) => {
        if (!priorBytes) return { result: undefined };
        let raw: unknown;
        try { raw = JSON.parse(priorBytes.toString('utf8')); } catch { throw error; }
        try { return { result: validateProofState(raw) }; } catch {}
        const migrated = canonicalizeLegacyProofState(raw, proofId, priorBytes);
        if (!migrated) throw error;
        const backupPath = `${file.path}.pre-canonical-proof-v1.g${migrated.sourceGeneration}-${sha256(priorBytes).slice(0, 16)}`;
        await writeDurableAtomicFile(backupPath, priorBytes);
        const canonical = validateProofState(migrated.state(backupPath));
        return { result: canonical, replacementBytes: Buffer.from(`${canonicalJson(canonical)}\n`) };
      });
    }
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
    'reportRepairs',
    'repairFindings',
    ...(hasOwn(value, 'repairArtifactSha256') ? ['repairArtifactSha256'] : []),
    ...(hasOwn(value, 'iosProofInputs') ? ['iosProofInputs'] : []),
    ...(hasOwn(value, 'invocation') ? ['invocation'] : []),
    ...(hasOwn(value, 'receipt') ? ['receipt'] : []),
    'startedAt',
    'updatedAt',
  ], 'proof state');
  if (value.schema !== 'codex-orchestrator.acceptance-proof-state' || value.version !== 1) {
    throw new Error('proof state schema/version is invalid');
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) throw new Error('proof state generation is invalid');
  assertNonEmptyString(value.proofId, 'proof state.proofId');
  assertSha256(value.bindingSha256, 'proof state.bindingSha256');
  if (!['active', ...TERMINAL_STATUSES].includes(value.status as ProofStatus)) throw new Error('proof state status is invalid');
  if (value.reportRepairs !== 0 && value.reportRepairs !== 1) throw new Error('proof report repair budget is invalid');
  if (!Array.isArray(value.repairFindings) || value.repairFindings.length > 256
    || value.repairFindings.some((finding) => typeof finding !== 'string' || finding.length === 0 || finding.length > 16 * 1024)) {
    throw new Error('proof repair findings are invalid');
  }
  if ((value.reportRepairs === 1) !== hasOwn(value, 'repairArtifactSha256')) throw new Error('proof repair artifact ownership is invalid');
  if (hasOwn(value, 'repairArtifactSha256')) validateProofArtifactInventory(value.repairArtifactSha256);
  if (hasOwn(value, 'iosProofInputs')) validateProofIosInputs(value.iosProofInputs, value.proofId as string);
  if (hasOwn(value, 'invocation')) {
    const invocation = validateDurableReportInvocation(value.invocation);
    if (invocation.operation !== 'acceptance-proof') throw new Error('proof invocation operation is invalid');
  }
  const terminal = TERMINAL_STATUSES.includes(value.status as typeof TERMINAL_STATUSES[number]);
  if (terminal !== hasOwn(value, 'receipt') || (terminal && hasOwn(value, 'invocation'))) throw new Error('proof terminal ownership is invalid');
  if (hasOwn(value, 'receipt')) validateReceipt(value.receipt);
  assertIsoTimestamp(value.startedAt);
  assertIsoTimestamp(value.updatedAt);
  if (Date.parse(value.updatedAt as string) < Date.parse(value.startedAt as string)) throw new Error('proof state timestamps are reversed');
  return value as unknown as ProofStateV1;
}

export function validateProofIosInputs(value: unknown, proofId: string): asserts value is ProofIosInputsV1 {
  assertExactObject(value, ['helperPath', 'leaseRoot', 'leaseArtifactPath', 'proofId', 'ownerPid', 'xcrunPath', 'runtimeId', 'deviceTypeId'], 'iOS proof inputs');
  for (const path of [value.helperPath, value.leaseRoot, value.leaseArtifactPath, value.xcrunPath]) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\\') || posix.normalize(path) !== path) throw new Error('iOS proof path is invalid');
  }
  if (value.proofId !== proofId || !Number.isSafeInteger(value.ownerPid) || (value.ownerPid as number) <= 0) throw new Error('iOS proof owner identity is invalid');
  if (value.runtimeId !== null && (typeof value.runtimeId !== 'string' || !value.runtimeId.startsWith('com.apple.CoreSimulator.SimRuntime.'))) throw new Error('iOS proof runtime ID is invalid');
  if (value.deviceTypeId !== null && (typeof value.deviceTypeId !== 'string' || !value.deviceTypeId.startsWith('com.apple.CoreSimulator.SimDeviceType.'))) throw new Error('iOS proof device type ID is invalid');
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

function hasOwn<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, key);
}

export function validateProofArtifactInventory(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length > 256) {
    throw new Error('proof repair artifact inventory is invalid');
  }
  for (const [path, digest] of Object.entries(value)) {
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('proof repair artifact path is invalid');
    }
    assertSha256(digest, 'proof repair artifact digest');
  }
  return Object.fromEntries(Object.entries(value).sort()) as Record<string, string>;
}

function canonicalizeLegacyProofState(value: unknown, proofId: string, sourceBytes: Buffer): {
  sourceGeneration: number; state(backupPath: string): ProofStateV1;
} | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, any>;
  if (raw.schema !== 'codex-orchestrator.acceptance-proof-state' || raw.version !== 1) return undefined;
  const sourceGeneration = Number.isSafeInteger(raw.generation) && raw.generation > 0 ? raw.generation : 1;
  const bindingSha256 = typeof raw.bindingSha256 === 'string' && SHA256_PATTERN.test(raw.bindingSha256)
    ? raw.bindingSha256 : sha256(sourceBytes);
  const startedAt = validTimestamp(raw.startedAt) ? raw.startedAt : '1970-01-01T00:00:00.000Z';
  const updatedAt = validTimestamp(raw.updatedAt) && Date.parse(raw.updatedAt) >= Date.parse(startedAt) ? raw.updatedAt : startedAt;
  const common = {
    schema: 'codex-orchestrator.acceptance-proof-state' as const, version: 1 as const,
    generation: sourceGeneration + 1, proofId, bindingSha256, reportRepairs: 0 as const,
    repairFindings: [], startedAt, updatedAt,
  };
  if (decodeExactLegacyProof(raw, proofId)?.launchable) return {
    sourceGeneration, state: () => ({ ...common, status: 'active' }),
  };
  return {
    sourceGeneration,
    state: (backupPath) => ({
      ...common, status: 'internal-error',
      receipt: {
        proofId, bindingSha256, summary: 'Proof state migration blocked: launched attempt identity unavailable.',
        publishableEvidence: [], localEvidenceId: `proof-state-migration-safety:${backupPath}`,
      },
    }),
  };
}

function decodeExactLegacyProof(raw: Record<string, any>, proofId: string): { launchable: boolean } | undefined {
  try {
    const terminal = TERMINAL_STATUSES.includes(raw.status);
    assertExactObject(raw, ['schema', 'version', 'generation', 'proofId', 'bindingSha256', 'status', 'attempts',
      ...(Object.hasOwn(raw, 'receipt') ? ['receipt'] : []), 'startedAt', 'updatedAt'], 'legacy proof state');
    const legacy = raw as any;
    if (!Number.isSafeInteger(legacy.generation) || legacy.generation <= 0 || legacy.proofId !== proofId
      || !['prepared', 'running', ...TERMINAL_STATUSES].includes(legacy.status)) return undefined;
    assertSha256(legacy.bindingSha256, 'legacy proof binding');
    assertIsoTimestamp(legacy.startedAt); assertIsoTimestamp(legacy.updatedAt);
    if (Date.parse(legacy.updatedAt) < Date.parse(legacy.startedAt) || terminal !== Object.hasOwn(legacy, 'receipt')) return undefined;
    if (terminal) validateReceipt(legacy.receipt);
    if (!Array.isArray(legacy.attempts) || legacy.attempts.length === 0 || legacy.attempts.length > 256) return undefined;
    const ids = new Set<string>(); const budgets = new Map<string, number>();
    for (const [index, candidate] of legacy.attempts.entries()) {
      const attempt = candidate as any;
      assertExactObject(attempt, ['attemptId', 'purpose', 'status', ...(Object.hasOwn(attempt, 'reportSha256') ? ['reportSha256'] : [])], 'legacy proof attempt');
      const decoded = attempt as any;
      assertNonEmptyString(decoded.attemptId, 'legacy proof attempt ID');
      if (ids.has(decoded.attemptId) || !['proof', 'transport-retry', 'report-repair'].includes(decoded.purpose)
        || !['prepared', 'running', 'terminal'].includes(decoded.status) || (index === 0) !== (decoded.purpose === 'proof')
        || (index < legacy.attempts.length - 1 && decoded.status !== 'terminal')) return undefined;
      if (Object.hasOwn(decoded, 'reportSha256')) assertSha256(decoded.reportSha256, 'legacy proof report hash');
      ids.add(decoded.attemptId); budgets.set(decoded.purpose, (budgets.get(decoded.purpose) ?? 0) + 1);
    }
    if ((budgets.get('transport-retry') ?? 0) > 1 || (budgets.get('report-repair') ?? 0) > 1) return undefined;
    const only = legacy.attempts[0];
    return { launchable: legacy.status === 'prepared' && legacy.attempts.length === 1
      && only.purpose === 'proof' && only.status === 'prepared' && !Object.hasOwn(only, 'reportSha256') };
  } catch { return undefined; }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }

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
