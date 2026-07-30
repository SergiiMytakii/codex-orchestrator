import type { ProofReceipt } from './proof-report.js';
import {
  validateDurableMutableInvocation,
  validateDurableReportInvocation,
  type DurableMutableInvocationV1,
  type DurableReportInvocationV1,
} from './contained-report-operation.js';
import { projectTerminalDirectReview, validateDirectReview, type DirectReviewV1 } from './direct-delivery.js';
import { validateSpecDelivery, type SpecDeliveryV1 } from './spec-delivery.js';
import {
  validateRouteExecution,
  validateRouteReceipt,
  validateRouteStateInvariant,
  type RouteExecutionV1,
  type RouteReceiptV1,
} from './route-decision.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import { validateWaitingHumanExecution, type WaitingHumanExecutionV1 } from './waiting-human.js';
import { posix } from 'node:path';
import { readFile } from 'node:fs/promises';
import { AtomicStateFile, type AtomicStateFileOptions } from './atomic-store.js';
import { writeDurableAtomicFile } from './adapters/durable-atomic-file.js';
import { canonicalJson, sha256 } from './containment.js';
import { validateCandidateBinding, validateCandidateExecutionLease, type CandidateBindingV2, type CandidateExecutionLeaseV2 } from './candidate.js';
import {
  blockReviewFeedback,
  createReviewFeedbackBootstrap,
  validateReviewFeedbackExecution,
  type ReviewFeedbackExecutionV1,
} from './review-feedback.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Lifecycle =
  | 'claimed'
  | 'triaging'
  | 'routed'
  | 'waiting-human'
  | 'spec-authoring'
  | 'implementing'
  | 'reworking'
  | 'checking'
  | 'proving'
  | 'publishing'
  | 'review-ready'
  | 'blocked'
  | 'transport-failed'
  | 'cancelled'
  | 'internal-error';

export type PublicationIntent =
  | { kind: 'claim-labels'; issueNumber: number; expected: string[] }
  | { kind: 'commit'; parentSha: string; treeSha: string; message: string; candidateRef?: string }
  | { kind: 'push'; branch: string; sha: string }
  | { kind: 'pr'; owner: string; repo: string; head: string; base: string; issueNumber: number; marker: string }
  | { kind: 'comment'; issueNumber: number; marker: string; bodySha256: string }
  | { kind: 'labels'; issueNumber: number; expected: string[] }
  | {
    kind: 'blocked-labels';
    issueNumber: number;
    expected: string[];
    blockKind: 'external' | 'safety' | 'exhausted';
    resumable: boolean;
    evidenceCode: string;
  }
  | { kind: 'review-activation-labels'; issueNumber: number; batchId: string; expected: string[] }
  | { kind: 'review-update-commit'; batchId: string; parentSha: string; treeSha: string; message: string; candidateRef?: string }
  | { kind: 'review-update-push'; batchId: string; branch: string; priorRemoteSha: string; sha: string; treeSha: string }
  | { kind: 'review-summary'; batchId: string; pullRequestNumber: number; pullRequestNodeId: string; marker: string; bodySha256: string; epochHeadSha: string }
  | { kind: 'review-final-labels'; issueNumber: number; batchId: string; pullRequestNumber: number; pullRequestNodeId: string; epochHeadSha: string; expected: string[] }
  | {
    kind: 'review-blocked-labels';
    issueNumber: number;
    batchId: string;
    expected: string[];
    blockKind: 'safety' | 'exhausted';
    evidenceCode: string;
  };

export type RunTerminalOutcome =
  | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string; continuationEpoch?: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; resumable: boolean; evidencePath: string }
  | { status: 'transport-failed'; resumable: boolean; evidencePath: string }
  | { status: 'cancelled'; evidencePath: string }
  | { status: 'internal-error'; code: string; evidencePath: string };

export interface PersistedIssueSnapshotV1 {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN';
  labels: string[];
  comments?: Array<{
    id?: string;
    body: string;
    authorAssociation: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
}

export interface PersistedFrozenCriterionV1 {
  id: string;
  order: number;
  text: string;
  source: 'explicit' | 'fallback';
}

export interface CandidateCheckReceiptV2 {
  id: string;
  command: string;
  status: 'passed' | 'failed';
  outputSha256: string;
  bindingId: string;
  candidateTreeSha: string;
  checkPolicySha256: string;
}

export interface RunRecordV1 {
  runId: string;
  issueNumber: number;
  canonicalRepository: string;
  baseSha: string;
  branchName: string;
  worktreePath: string;
  lifecycle: Lifecycle;
  cycle: 1 | 2 | 3 | 4 | 5;
  reportRepairs: 0 | 1;
  issueSnapshot: PersistedIssueSnapshotV1;
  frozenCriteria: PersistedFrozenCriterionV1[];
  reworkFindings: string[];
  packageVersion: string;
  workflowGeneration: WorkflowGenerationReceipt;
  routeExecution?: RouteExecutionV1;
  routeReceipt?: RouteReceiptV1;
  waitingHuman?: WaitingHumanExecutionV1;
  directReview?: DirectReviewV1;
  specDelivery?: SpecDeliveryV1;
  reportInvocation?: DurableReportInvocationV1;
  mutableInvocation?: DurableMutableInvocationV1;
  reviewFeedback?: ReviewFeedbackExecutionV1;
  changeBindingVersion?: 2;
  candidateBinding?: CandidateBindingV2;
  executionLease?: CandidateExecutionLeaseV2;
  checkQualification?: {
    version: 1;
    checkPolicySha256: string;
    repairAttempts: 0 | 1 | 2 | 3 | 4 | 5;
    checks: Array<{ id: string; command: string; status: 'passed' | 'failed'; outputSha256: string } | CandidateCheckReceiptV2>;
    repairFindings?: string[];
  };
  skillHashes: Record<string, string>;
  /** Legacy read compatibility for runs created before check qualification. New runs never write this field. */
  baselineChecks?: Array<{ id: string; command: string; status: 'passed' | 'failed'; outputSha256: string }>;
  /** `unchanged-failure` is accepted only so historical terminal runs remain readable. */
  checks: Array<
    | { id: string; command: string; status: 'passed' | 'failed' | 'unchanged-failure'; outputSha256: string }
    | CandidateCheckReceiptV2
  >;
  checkedChangeSha256?: string;
  proofId?: string;
  proofReceipt?: ProofReceipt;
  intent?: PublicationIntent;
  outcomeEvidenceId?: string;
  terminalOutcome?: RunTerminalOutcome;
  createdAt: string;
  updatedAt: string;
}

export interface RunStateFileV1 {
  schema: 'codex-orchestrator.agent-auto-state';
  version: 2 | 3;
  generation: number;
  runs: RunRecordV1[];
}

export type RunStateBodyV1 = Omit<RunStateFileV1, 'generation'>;

export interface RunRecordWriter {
  read(): Promise<RunStateFileV1>;
  compareAndSwap(expectedGeneration: number, next: RunStateBodyV1): Promise<RunStateFileV1>;
  markPublicationEffectPossible?(): Promise<void>;
}

export class WorkflowGenerationUnrecoverableError extends Error {
  constructor() {
    super('workflow-generation-unrecoverable');
    this.name = 'WorkflowGenerationUnrecoverableError';
  }
}

export class RouteInitializationUnrecoverableError extends Error {
  constructor() {
    super('route-initialization-unrecoverable');
    this.name = 'RouteInitializationUnrecoverableError';
  }
}

export class FileRunRecordWriter implements RunRecordWriter {
  private readonly file: AtomicStateFile<RunStateFileV1>;
  private readonly backupPath: string;
  private readonly migrationMetadataPath: string;
  private readonly reportLifecycleBackupPath: string;
  private readonly mutableLifecycleBackupPath: string;
  private readonly now: () => string;

  constructor(path: string, options: AtomicStateFileOptions = {}) {
    this.file = new AtomicStateFile(path, validateRunStateFile, options);
    this.backupPath = `${path}.pre-candidate-v3`;
    this.migrationMetadataPath = `${this.backupPath}.metadata.json`;
    this.reportLifecycleBackupPath = `${path}.pre-report-lifecycle-v1`;
    this.mutableLifecycleBackupPath = `${path}.pre-mutable-lifecycle-v1`;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async read(): Promise<RunStateFileV1> {
    try { return await this.file.read() ?? emptyRunState(); }
    catch (error) { return this.migrateLegacyReportLifecycle(error); }
  }

  async compareAndSwap(expectedGeneration: number, next: RunStateBodyV1): Promise<RunStateFileV1> {
    validateRunStateBody(next);
    const candidate = { ...structuredClone(next), generation: expectedGeneration + 1 };
    return this.file.compareAndSwapWithRaw(expectedGeneration, candidate, async (priorBytes) => {
      if (!priorBytes) return;
      const raw = parseRawState(priorBytes);
      if (raw.version === 3 && next.version !== 3) throw new Error('run state V3 downgrade requires explicit rollback');
      if (raw.version === 2 && next.version === 3) await this.ensureCandidateMigrationBackup(priorBytes, raw.generation);
    });
  }

  async markPublicationEffectPossible(): Promise<void> {
    await this.file.withExclusiveRaw(async () => {
      const existing = await readMigrationMetadata(this.migrationMetadataPath);
      if (!existing?.publicationEffectPossible) {
        const now = this.now();
        await writeDurableAtomicFile(this.migrationMetadataPath, `${canonicalJson({
          version: 1,
          sourceGeneration: existing?.sourceGeneration ?? null,
          sourceBytesSha256: existing?.sourceBytesSha256 ?? null,
          publicationEffectPossible: true,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })}\n`);
      }
      return { result: undefined };
    });
  }

  async rollbackCandidateMigration(input: {
    assertNoActiveProcesses: () => Promise<void>;
    cleanupCandidateState: (state: RunStateFileV1) => Promise<void>;
  }): Promise<RunStateFileV1> {
    return this.file.withExclusiveRaw(async (_currentBytes, current) => {
      const metadata = await readMigrationMetadata(this.migrationMetadataPath);
      if (!metadata || metadata.sourceGeneration === null || metadata.sourceBytesSha256 === null) throw new Error('candidate V3 rollback backup is unavailable');
      if (metadata.publicationEffectPossible) throw new Error('candidate V3 rollback is forbidden after publication boundary');
      if (!current || current.version !== 3) throw new Error('candidate V3 rollback requires active V3 state');
      await input.assertNoActiveProcesses();
      await input.cleanupCandidateState(structuredClone(current));
      const backup = await readOptionalFile(this.backupPath);
      if (!backup || sha256(backup) !== metadata.sourceBytesSha256) throw new Error('candidate V3 rollback backup identity is invalid');
      const restored = parseRawState(backup);
      if (restored.version !== 2 || restored.generation !== metadata.sourceGeneration) throw new Error('candidate V3 rollback backup generation is invalid');
      return { result: restored, replacementBytes: backup };
    });
  }

  private async ensureCandidateMigrationBackup(rawV2Bytes: Buffer, generation: number): Promise<void> {
    const sourceBytesSha256 = sha256(rawV2Bytes);
    const existing = await readMigrationMetadata(this.migrationMetadataPath);
    const backup = await readOptionalFile(this.backupPath);
    if (existing?.publicationEffectPossible) throw new Error('candidate V3 migration backup cannot change after publication boundary');
    if (existing?.sourceGeneration === generation && existing.sourceBytesSha256 === sourceBytesSha256
      && backup?.equals(rawV2Bytes)) return;
    await writeDurableAtomicFile(this.backupPath, rawV2Bytes);
    const now = this.now();
    await writeDurableAtomicFile(this.migrationMetadataPath, `${canonicalJson({
      version: 1,
      sourceGeneration: generation,
      sourceBytesSha256,
      publicationEffectPossible: false,
      createdAt: now,
      updatedAt: now,
    })}\n`);
  }

  private async migrateLegacyReportLifecycle(originalError: unknown): Promise<RunStateFileV1> {
    return this.file.withExclusiveUnparsedRaw(async (priorBytes) => {
      if (!priorBytes) return { result: emptyRunState() };
      let raw: unknown;
      try { raw = JSON.parse(priorBytes.toString('utf8')); }
      catch { throw originalError; }
      try { return { result: validateRunStateFile(raw) }; }
      catch {
        const mutable = hasLegacyMutableLifecycle(raw);
        let backupPath = mutable ? this.mutableLifecycleBackupPath : this.reportLifecycleBackupPath;
        if (!mutable) {
          const priorReportBackup = await readOptionalFile(backupPath);
          if (priorReportBackup && !priorReportBackup.equals(priorBytes)) {
            const generation = (raw as { generation?: unknown }).generation;
            backupPath = `${backupPath}.g${String(generation)}-${sha256(priorBytes).slice(0, 16)}`;
          }
        }
        const migrated = canonicalizeLegacyReportLifecycle(raw, backupPath);
        if (!migrated) throw originalError;
        const existingBackup = await readOptionalFile(backupPath);
        if (existingBackup && !existingBackup.equals(priorBytes)) throw new Error('report lifecycle migration backup conflicts with current source bytes');
        if (!existingBackup) await writeDurableAtomicFile(backupPath, priorBytes);
        return { result: migrated, replacementBytes: Buffer.from(`${canonicalJson(migrated)}\n`) };
      }
    });
  }
}

export class InMemoryRunRecordWriter implements RunRecordWriter {
  private state = emptyRunState();

  async read(): Promise<RunStateFileV1> {
    return structuredClone(this.state);
  }

  async compareAndSwap(expectedGeneration: number, next: RunStateBodyV1): Promise<RunStateFileV1> {
    if (this.state.generation !== expectedGeneration) throw new Error('run state generation conflict');
    if (this.state.version === 3 && next.version !== 3) throw new Error('run state V3 downgrade requires explicit rollback');
    const value = validateRunStateFile({ ...structuredClone(next), generation: expectedGeneration + 1 });
    this.state = value;
    return structuredClone(value);
  }

  async markPublicationEffectPossible(): Promise<void> {}
}

export function validateRunStateFile(value: unknown): RunStateFileV1 {
  assertExactObject(value, ['schema', 'version', 'generation', 'runs'], 'run state');
  if (value.schema !== 'codex-orchestrator.agent-auto-state' || ![1, 2, 3].includes(value.version as number)) throw new Error('run state schema/version is invalid');
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) throw new Error('run state generation is invalid');
  validateRuns(value.runs);
  if (value.version === 1) {
    for (const run of value.runs as RunRecordV1[]) {
      if (hasOwn(run, 'reviewFeedback')) throw new Error('V1 run state cannot contain review feedback');
    }
    return {
      schema: 'codex-orchestrator.agent-auto-state',
      version: 2,
      generation: value.generation as number,
      runs: (value.runs as RunRecordV1[]).map((run) => run.lifecycle === 'review-ready'
        ? { ...structuredClone(run), reviewFeedback: createReviewFeedbackBootstrap() }
        : structuredClone(run)),
    };
  }
  if (value.version === 2) assertNoCandidateV3Fields(value.runs as RunRecordV1[]);
  return value as unknown as RunStateFileV1;
}

function validateRunStateBody(value: unknown): asserts value is RunStateBodyV1 {
  assertExactObject(value, ['schema', 'version', 'runs'], 'run state body');
  if (value.schema !== 'codex-orchestrator.agent-auto-state' || (value.version !== 2 && value.version !== 3)) throw new Error('run state schema/version is invalid');
  validateRuns(value.runs);
  if (value.version === 2) assertNoCandidateV3Fields(value.runs);
}

function validateRuns(value: unknown): asserts value is RunRecordV1[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('run state runs are invalid');
  const ids = new Set<string>();
  for (const [index, run] of value.entries()) {
    validateRunRecord(run, `run state.runs[${index}]`);
    if (ids.has(run.runId)) throw new Error('run IDs must be unique');
    ids.add(run.runId);
  }
}

function validateRunRecord(value: unknown, field: string): asserts value is RunRecordV1 {
  const optional = [
    'checkedChangeSha256',
    'proofId',
    'proofReceipt',
    'intent',
    'outcomeEvidenceId',
    'terminalOutcome',
    'routeExecution',
    'routeReceipt',
    'waitingHuman',
    'directReview',
    'specDelivery',
    'reviewFeedback',
    'checkQualification',
    'baselineChecks',
    'changeBindingVersion',
    'candidateBinding',
    'executionLease',
    'reportInvocation',
    'mutableInvocation',
  ].filter((key) => hasOwn(value, key));
  assertExactObject(value, [
    'runId', 'issueNumber', 'canonicalRepository', 'baseSha', 'branchName', 'worktreePath', 'lifecycle', 'cycle',
    'reportRepairs', 'issueSnapshot', 'frozenCriteria', 'reworkFindings',
    'packageVersion', 'workflowGeneration', 'skillHashes', 'checks', 'createdAt', 'updatedAt', ...optional,
  ], field);
  if (typeof value.runId !== 'string' || !UUID_V4_PATTERN.test(value.runId)) throw new Error(`${field}.runId is invalid`);
  assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
  if (typeof value.canonicalRepository !== 'string' || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(value.canonicalRepository)) {
    throw new Error(`${field}.canonicalRepository is invalid`);
  }
  assertGitSha(value.baseSha, `${field}.baseSha`);
  assertNonEmptyString(value.branchName, `${field}.branchName`);
  if (typeof value.worktreePath !== 'string' || !value.worktreePath.startsWith('/') || posix.normalize(value.worktreePath) !== value.worktreePath) {
    throw new Error(`${field}.worktreePath is invalid`);
  }
  if (!isLifecycle(value.lifecycle)) throw new Error(`${field}.lifecycle is invalid`);
  if (!Number.isSafeInteger(value.cycle) || (value.cycle as number) < 1 || (value.cycle as number) > 5) throw new Error(`${field}.cycle is invalid`);
  if (value.reportRepairs !== 0 && value.reportRepairs !== 1) throw new Error(`${field}.reportRepairs is invalid`);
  validateIssueSnapshot(value.issueSnapshot, `${field}.issueSnapshot`);
  validateFrozenCriteria(value.frozenCriteria, `${field}.frozenCriteria`);
  validateStringList(value.reworkFindings, `${field}.reworkFindings`);
  assertNonEmptyString(value.packageVersion, `${field}.packageVersion`);
  const workflowGeneration = value.workflowGeneration;
  validateWorkflowGeneration(workflowGeneration, `${field}.workflowGeneration`);
  if (workflowGeneration.packageVersion !== value.packageVersion) {
    throw new Error(`${field}.workflowGeneration package version mismatch`);
  }
  const routeGenerationHash = workflowGeneration.generationHash;
  if (hasOwn(value, 'routeExecution')) validateRouteExecution(value.routeExecution, routeGenerationHash);
  if (hasOwn(value, 'routeReceipt')) validateRouteReceipt(value.routeReceipt, routeGenerationHash);
  validateStringShaRecord(value.skillHashes, `${field}.skillHashes`);
  if (hasOwn(value, 'baselineChecks')) validateChecks(value.baselineChecks, `${field}.baselineChecks`, false);
  validateChecks(value.checks, `${field}.checks`);
  let reportInvocation: DurableReportInvocationV1 | undefined;
  if (hasOwn(value, 'reportInvocation')) {
    const invocation = validateDurableReportInvocation(value.reportInvocation);
    reportInvocation = invocation;
    const expectedLifecycle = invocation.operation === 'triage' || invocation.operation === 'ambiguity-review'
      ? 'triaging'
      : invocation.operation === 'code-review' ? 'implementing' : 'spec-authoring';
    if (value.lifecycle !== expectedLifecycle) throw new Error(`${field}.reportInvocation lifecycle is invalid`);
  }
  if (hasOwn(value, 'mutableInvocation')) {
    const invocation = validateDurableMutableInvocation(value.mutableInvocation);
    if (value.lifecycle !== 'implementing') throw new Error(`${field}.mutableInvocation lifecycle is invalid`);
    if (invocation.worktreePath !== value.worktreePath || invocation.generationHash !== routeGenerationHash) {
      throw new Error(`${field}.mutableInvocation binding is invalid`);
    }
    if (invocation.operation === 'qualification-repair' && !hasOwn(value, 'checkQualification')) {
      throw new Error(`${field}.qualification mutableInvocation requires check qualification`);
    }
    const feedbackActive = hasOwn(value, 'reviewFeedback')
      && (value.reviewFeedback as ReviewFeedbackExecutionV1).activeBatch !== null;
    if ((invocation.operation === 'review-feedback-implementation') !== feedbackActive) {
      throw new Error(`${field}.mutableInvocation feedback binding is invalid`);
    }
  }
  if (hasOwn(value, 'checkedChangeSha256')) assertSha256(value.checkedChangeSha256, `${field}.checkedChangeSha256`);
  if (hasOwn(value, 'proofId')) assertNonEmptyString(value.proofId, `${field}.proofId`);
  if (hasOwn(value, 'proofReceipt')) validateReceipt(value.proofReceipt, `${field}.proofReceipt`);
  if (hasOwn(value, 'intent')) validateIntent(value.intent, `${field}.intent`);
  if (hasOwn(value, 'outcomeEvidenceId')) assertNonEmptyString(value.outcomeEvidenceId, `${field}.outcomeEvidenceId`);
  if (hasOwn(value, 'terminalOutcome')) validateTerminalOutcome(value.terminalOutcome, `${field}.terminalOutcome`);
  if (hasOwn(value, 'waitingHuman')) {
    if (!routeGenerationHash) throw new WorkflowGenerationUnrecoverableError();
    validateWaitingHumanExecution(value.waitingHuman, {
      runId: value.runId,
      lifecycle: value.lifecycle,
      workflowGenerationHash: routeGenerationHash,
      routeReceipt: hasOwn(value, 'routeReceipt') ? value.routeReceipt as RouteReceiptV1 : undefined,
      terminalOutcome: hasOwn(value, 'terminalOutcome') ? value.terminalOutcome as RunTerminalOutcome : undefined,
    });
  }
  if (hasOwn(value, 'directReview')) {
    if (!hasOwn(value, 'routeReceipt') || (value.routeReceipt as RouteReceiptV1).route !== 'direct') {
      throw new Error(`${field}.directReview requires a direct route`);
    }
    validateDirectReview(value.directReview, {
      lifecycle: value.lifecycle as string,
      ...(hasOwn(value, 'terminalOutcome') ? { terminalOutcome: directTerminalOutcome(value.terminalOutcome as RunTerminalOutcome) } : {}),
    });
  }
  if (hasOwn(value, 'specDelivery')) {
    if (!hasOwn(value, 'routeReceipt') || (value.routeReceipt as RouteReceiptV1).route !== 'spec-required') {
      throw new Error(`${field}.specDelivery requires a spec-required route`);
    }
    const spec = validateSpecDelivery(value.specDelivery);
    if (spec.issueNumber !== value.issueNumber || spec.runId !== value.runId
      || spec.workflowGenerationSha256 !== routeGenerationHash) {
      throw new Error(`${field}.specDelivery identity binding is invalid`);
    }
  }
  if (hasOwn(value, 'reviewFeedback')) {
    validateReviewFeedbackExecution(value.reviewFeedback);
    validateReviewFeedbackRunInvariant(value as unknown as RunRecordV1, field);
  }
  if (hasOwn(value, 'changeBindingVersion') && value.changeBindingVersion !== 2) throw new Error(`${field}.changeBindingVersion is invalid`);
  if (hasOwn(value, 'candidateBinding')) validateCandidateBinding(value.candidateBinding, `${field}.candidateBinding`, value.runId as string);
  if (hasOwn(value, 'executionLease')) validateCandidateExecutionLease(value.executionLease, `${field}.executionLease`);
  if (hasOwn(value, 'candidateBinding') !== hasOwn(value, 'changeBindingVersion')) throw new Error(`${field} candidate binding version is incomplete`);
  if (hasOwn(value, 'executionLease')) {
    if (!hasOwn(value, 'candidateBinding')) throw new Error(`${field}.executionLease requires candidate binding`);
    const binding = value.candidateBinding as unknown as CandidateBindingV2;
    const lease = value.executionLease as unknown as CandidateExecutionLeaseV2;
    if (lease.bindingId !== binding.bindingId || lease.candidateCommitSha !== binding.candidateCommitSha) throw new Error(`${field}.executionLease binding is invalid`);
  }
  if (hasOwn(value, 'intent') && hasOwn(value.intent, 'candidateRef')) {
    if (!hasOwn(value, 'candidateBinding')) throw new Error(`${field}.intent candidate ref requires candidate binding`);
    const binding = value.candidateBinding as unknown as CandidateBindingV2;
    const intent = value.intent as Extract<PublicationIntent, { kind: 'commit' | 'review-update-commit' }>;
    if (intent.candidateRef !== binding.candidateRef || intent.treeSha !== binding.candidateTreeSha) {
      throw new Error(`${field}.intent candidate binding is invalid`);
    }
  }
  if (hasOwn(value, 'checkQualification')) validateCheckQualification(value.checkQualification, `${field}.checkQualification`);
  assertTimestamp(value.createdAt, `${field}.createdAt`);
  assertTimestamp(value.updatedAt, `${field}.updatedAt`);

  const terminal = ['review-ready', 'blocked', 'transport-failed', 'cancelled', 'internal-error'].includes(value.lifecycle);
  if (terminal !== hasOwn(value, 'terminalOutcome')) throw new Error(`${field} terminal lifecycle requires terminalOutcome`);
  if (terminal && (value.terminalOutcome as RunTerminalOutcome).status !== value.lifecycle) throw new Error(`${field} terminalOutcome does not match lifecycle`);
  if (value.lifecycle === 'proving' && (!hasOwn(value, 'checkedChangeSha256') || !hasOwn(value, 'proofId')
    || value.checks.some((check) => check.status === 'failed'))) {
    throw new Error(`${field} proving requires passed checks and checked change proof identity`);
  }
  if (value.lifecycle === 'publishing' && !hasOwn(value, 'proofReceipt')) throw new Error(`${field} publishing requires proofReceipt`);
  if (value.lifecycle === 'review-ready' && (!hasOwn(value, 'proofReceipt') || hasOwn(value, 'intent'))) {
    throw new Error(`${field} review-ready requires proofReceipt and no intent`);
  }
  const retainedCandidateIntent = value.lifecycle === 'blocked'
    && (value.terminalOutcome as RunTerminalOutcome | undefined)?.status === 'blocked'
    && (value.terminalOutcome as Extract<RunTerminalOutcome, { status: 'blocked' }>).kind === 'safety'
    && !(value.terminalOutcome as Extract<RunTerminalOutcome, { status: 'blocked' }>).resumable
    && hasOwn(value, 'candidateBinding')
    && ((value.intent as PublicationIntent | undefined)?.kind === 'commit' || (value.intent as PublicationIntent | undefined)?.kind === 'review-update-commit');
  if (terminal && hasOwn(value, 'intent') && value.lifecycle !== 'transport-failed' && !retainedCandidateIntent) throw new Error(`${field} terminal lifecycle cannot retain intent`);
  if (value.lifecycle === 'transport-failed' && hasOwn(value, 'intent')
    && (value.terminalOutcome as Extract<RunTerminalOutcome, { status: 'transport-failed' }>).resumable) {
    throw new Error(`${field} resumable transport failure cannot retain intent`);
  }
  if (value.lifecycle === 'waiting-human' && !hasOwn(value, 'waitingHuman')) throw new Error(`${field} waiting-human lifecycle requires waitingHuman execution`);
  if (reportInvocation) validateReportInvocationBinding(value as unknown as RunRecordV1, reportInvocation, routeGenerationHash, field);
  validateRouteStateInvariant({
    lifecycle: value.lifecycle,
    routeExecution: value.routeExecution,
    routeReceipt: value.routeReceipt,
    generationHash: routeGenerationHash,
  });
}

function validateReportInvocationBinding(
  record: RunRecordV1,
  invocation: DurableReportInvocationV1,
  generationHash: string,
  field: string,
): void {
  if (invocation.generationHash !== generationHash) throw new Error(`${field}.reportInvocation generation is invalid`);
  if (invocation.operation === 'triage') {
    if (!record.routeExecution || !['triage-in-flight', 'repair-in-flight'].includes(record.routeExecution.phase)) {
      throw new Error(`${field}.triage reportInvocation phase is invalid`);
    }
    return;
  }
  if (invocation.operation === 'ambiguity-review') {
    if (record.routeExecution?.phase !== 'review-in-flight') throw new Error(`${field}.ambiguity reportInvocation phase is invalid`);
    return;
  }
  if (invocation.operation === 'code-review') {
    if (record.directReview?.status !== 'active'
      || !['review-full', 'review-closure'].includes(record.directReview.stage ?? '')
      || record.executionLease?.operation !== 'direct-review') {
      throw new Error(`${field}.code-review reportInvocation binding is invalid`);
    }
    return;
  }
  if (invocation.operation === 'spec-author') {
    if (!record.specDelivery || !['authoring', 'author-repair'].includes(record.specDelivery.stage)
      || record.specDelivery.authorSessionId === null) {
      throw new Error(`${field}.spec-author reportInvocation binding is invalid`);
    }
    return;
  }
  if (!record.specDelivery || !['review-full', 'review-closure'].includes(record.specDelivery.stage)) {
    throw new Error(`${field}.spec-review reportInvocation binding is invalid`);
  }
}

function directTerminalOutcome(outcome: RunTerminalOutcome): DirectReviewV1['terminalOutcome'] | undefined {
  if (outcome.status === 'review-ready') return undefined;
  return outcome.status === 'blocked'
    ? { status: 'blocked', kind: outcome.kind }
    : { status: outcome.status };
}

function validateWorkflowGeneration(value: unknown, field: string): asserts value is WorkflowGenerationReceipt {
  assertExactObject(value, [
    'generationHash', 'manifestSha256', 'packageVersion', 'generationRoot', 'contentSha256',
  ], field);
  assertSha256(value.generationHash, `${field}.generationHash`);
  assertSha256(value.manifestSha256, `${field}.manifestSha256`);
  assertNonEmptyString(value.packageVersion, `${field}.packageVersion`);
  if (typeof value.generationRoot !== 'string' || !value.generationRoot.startsWith('/') || posix.normalize(value.generationRoot) !== value.generationRoot) {
    throw new Error(`${field}.generationRoot is invalid`);
  }
  assertSha256(value.contentSha256, `${field}.contentSha256`);
}

function validateChecks(value: unknown, field: string, allowUnchangedFailure = true): asserts value is RunRecordV1['checks'] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${field} is invalid`);
  const ids = new Set<string>();
  for (const [index, check] of value.entries()) {
    const candidate = hasOwn(check, 'bindingId') || hasOwn(check, 'candidateTreeSha') || hasOwn(check, 'checkPolicySha256');
    assertExactObject(check, [
      'id', 'command', 'status', 'outputSha256',
      ...(candidate ? ['bindingId', 'candidateTreeSha', 'checkPolicySha256'] : []),
    ], `${field}[${index}]`);
    assertNonEmptyString(check.id, `${field}[${index}].id`);
    assertNonEmptyString(check.command, `${field}[${index}].command`);
    if (check.status !== 'passed' && check.status !== 'failed'
      && (check.status !== 'unchanged-failure' || !allowUnchangedFailure)) throw new Error(`${field}[${index}].status is invalid`);
    assertSha256(check.outputSha256, `${field}[${index}].outputSha256`);
    if (candidate) {
      assertSha256(check.bindingId, `${field}[${index}].bindingId`);
      assertGitSha(check.candidateTreeSha, `${field}[${index}].candidateTreeSha`);
      assertSha256(check.checkPolicySha256, `${field}[${index}].checkPolicySha256`);
      if (check.status === 'unchanged-failure') throw new Error(`${field}[${index}] candidate status is invalid`);
    }
    if (ids.has(check.id)) throw new Error(`${field} IDs must be unique`);
    ids.add(check.id);
  }
}

function validateCheckQualification(value: unknown, field: string): asserts value is NonNullable<RunRecordV1['checkQualification']> {
  const optional = hasOwn(value, 'repairFindings') ? ['repairFindings'] : [];
  assertExactObject(value, ['version', 'checkPolicySha256', 'repairAttempts', 'checks', ...optional], field);
  if (value.version !== 1) throw new Error(`${field}.version is invalid`);
  assertSha256(value.checkPolicySha256, `${field}.checkPolicySha256`);
  if (!Number.isSafeInteger(value.repairAttempts) || (value.repairAttempts as number) < 0 || (value.repairAttempts as number) > 5) {
    throw new Error(`${field}.repairAttempts is invalid`);
  }
  validateChecks(value.checks, `${field}.checks`, false);
  if (hasOwn(value, 'repairFindings')) validateStringList(value.repairFindings, `${field}.repairFindings`);
}

function validateIssueSnapshot(value: unknown, field: string): asserts value is PersistedIssueSnapshotV1 {
  const optional = hasOwn(value, 'comments') ? ['comments'] : [];
  assertExactObject(value, ['number', 'title', 'body', 'url', 'state', 'labels', ...optional], field);
  assertPositiveInteger(value.number, `${field}.number`);
  assertNonEmptyString(value.title, `${field}.title`);
  if (typeof value.body !== 'string' || value.body.length > 16 * 1024) throw new Error(`${field}.body is invalid`);
  assertNonEmptyString(value.url, `${field}.url`);
  if (value.state !== 'OPEN') throw new Error(`${field}.state is invalid`);
  validateStringArray(value.labels, `${field}.labels`);
  if (hasOwn(value, 'comments')) {
    if (!Array.isArray(value.comments) || value.comments.length > 256) throw new Error(`${field}.comments is invalid`);
    for (const [index, comment] of value.comments.entries()) {
      const optionalCommentFields = [
        ...(hasOwn(comment, 'id') ? ['id'] : []),
        ...(hasOwn(comment, 'createdAt') ? ['createdAt'] : []),
        ...(hasOwn(comment, 'updatedAt') ? ['updatedAt'] : []),
      ];
      assertExactObject(comment, [...optionalCommentFields, 'body', 'authorAssociation'], `${field}.comments[${index}]`);
      if (hasOwn(comment, 'id')) assertNonEmptyString(comment.id, `${field}.comments[${index}].id`);
      if (hasOwn(comment, 'createdAt')) assertTimestamp(comment.createdAt, `${field}.comments[${index}].createdAt`);
      if (hasOwn(comment, 'updatedAt')) assertTimestamp(comment.updatedAt, `${field}.comments[${index}].updatedAt`);
      if (typeof comment.body !== 'string' || comment.body.length > 16 * 1024) throw new Error(`${field}.comments[${index}].body is invalid`);
      assertNonEmptyString(comment.authorAssociation, `${field}.comments[${index}].authorAssociation`);
    }
  }
}

function validateFrozenCriteria(value: unknown, field: string): asserts value is PersistedFrozenCriterionV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) throw new Error(`${field} is invalid`);
  const ids = new Set<string>();
  for (const [index, criterion] of value.entries()) {
    assertExactObject(criterion, ['id', 'order', 'text', 'source'], `${field}[${index}]`);
    assertNonEmptyString(criterion.id, `${field}[${index}].id`);
    if (criterion.order !== index + 1) throw new Error(`${field}[${index}].order is invalid`);
    assertNonEmptyString(criterion.text, `${field}[${index}].text`);
    if (criterion.source !== 'explicit' && criterion.source !== 'fallback') throw new Error(`${field}[${index}].source is invalid`);
    if (ids.has(criterion.id)) throw new Error(`${field} IDs must be unique`);
    ids.add(criterion.id);
  }
}

function validateStringList(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${field} is invalid`);
  for (const item of value) assertNonEmptyString(item, field);
}

function validateIntent(value: unknown, field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} is invalid`);
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'claim-labels' || kind === 'labels') {
    assertExactObject(value, ['kind', 'issueNumber', 'expected'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    validateStringArray(value.expected, `${field}.expected`);
  } else if (kind === 'commit') {
    assertExactObject(value, ['kind', 'parentSha', 'treeSha', 'message', ...(hasOwn(value, 'candidateRef') ? ['candidateRef'] : [])], field);
    assertGitSha(value.parentSha, `${field}.parentSha`);
    assertGitSha(value.treeSha, `${field}.treeSha`);
    assertNonEmptyString(value.message, `${field}.message`);
    if (hasOwn(value, 'candidateRef')) assertCandidateRef(value.candidateRef, `${field}.candidateRef`);
  } else if (kind === 'push') {
    assertExactObject(value, ['kind', 'branch', 'sha'], field);
    assertNonEmptyString(value.branch, `${field}.branch`);
    assertGitSha(value.sha, `${field}.sha`);
  } else if (kind === 'pr') {
    assertExactObject(value, ['kind', 'owner', 'repo', 'head', 'base', 'issueNumber', 'marker'], field);
    for (const key of ['owner', 'repo', 'head', 'base', 'marker'] as const) assertNonEmptyString(value[key], `${field}.${key}`);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
  } else if (kind === 'comment') {
    assertExactObject(value, ['kind', 'issueNumber', 'marker', 'bodySha256'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertNonEmptyString(value.marker, `${field}.marker`);
    assertSha256(value.bodySha256, `${field}.bodySha256`);
  } else if (kind === 'review-activation-labels') {
    assertExactObject(value, ['kind', 'issueNumber', 'batchId', 'expected'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertSha256(value.batchId, `${field}.batchId`);
    validateStringArray(value.expected, `${field}.expected`);
  } else if (kind === 'review-update-commit') {
    assertExactObject(value, ['kind', 'batchId', 'parentSha', 'treeSha', 'message', ...(hasOwn(value, 'candidateRef') ? ['candidateRef'] : [])], field);
    assertSha256(value.batchId, `${field}.batchId`);
    assertGitSha(value.parentSha, `${field}.parentSha`);
    assertGitSha(value.treeSha, `${field}.treeSha`);
    assertNonEmptyString(value.message, `${field}.message`);
    if (hasOwn(value, 'candidateRef')) assertCandidateRef(value.candidateRef, `${field}.candidateRef`);
  } else if (kind === 'review-update-push') {
    assertExactObject(value, ['kind', 'batchId', 'branch', 'priorRemoteSha', 'sha', 'treeSha'], field);
    assertSha256(value.batchId, `${field}.batchId`);
    assertNonEmptyString(value.branch, `${field}.branch`);
    assertGitSha(value.priorRemoteSha, `${field}.priorRemoteSha`);
    assertGitSha(value.sha, `${field}.sha`);
    assertGitSha(value.treeSha, `${field}.treeSha`);
  } else if (kind === 'review-summary') {
    assertExactObject(value, ['kind', 'batchId', 'pullRequestNumber', 'pullRequestNodeId', 'marker', 'bodySha256', 'epochHeadSha'], field);
    assertSha256(value.batchId, `${field}.batchId`);
    assertPositiveInteger(value.pullRequestNumber, `${field}.pullRequestNumber`);
    assertNonEmptyString(value.pullRequestNodeId, `${field}.pullRequestNodeId`);
    assertNonEmptyString(value.marker, `${field}.marker`);
    assertSha256(value.bodySha256, `${field}.bodySha256`);
    assertGitSha(value.epochHeadSha, `${field}.epochHeadSha`);
  } else if (kind === 'review-final-labels') {
    assertExactObject(value, ['kind', 'issueNumber', 'batchId', 'pullRequestNumber', 'pullRequestNodeId', 'epochHeadSha', 'expected'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertSha256(value.batchId, `${field}.batchId`);
    assertPositiveInteger(value.pullRequestNumber, `${field}.pullRequestNumber`);
    assertNonEmptyString(value.pullRequestNodeId, `${field}.pullRequestNodeId`);
    assertGitSha(value.epochHeadSha, `${field}.epochHeadSha`);
    validateStringArray(value.expected, `${field}.expected`);
  } else if (kind === 'review-blocked-labels') {
    assertExactObject(value, ['kind', 'issueNumber', 'batchId', 'expected', 'blockKind', 'evidenceCode'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertSha256(value.batchId, `${field}.batchId`);
    validateStringArray(value.expected, `${field}.expected`);
    if (value.blockKind !== 'safety' && value.blockKind !== 'exhausted') throw new Error(`${field}.blockKind is invalid`);
    assertNonEmptyString(value.evidenceCode, `${field}.evidenceCode`);
  } else if (kind === 'blocked-labels') {
    assertExactObject(value, ['kind', 'issueNumber', 'expected', 'blockKind', 'resumable', 'evidenceCode'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    validateStringArray(value.expected, `${field}.expected`);
    if (!['external', 'safety', 'exhausted'].includes(value.blockKind as string)) throw new Error(`${field}.blockKind is invalid`);
    if (typeof value.resumable !== 'boolean') throw new Error(`${field}.resumable is invalid`);
    assertNonEmptyString(value.evidenceCode, `${field}.evidenceCode`);
  } else {
    throw new Error(`${field}.kind is invalid`);
  }
}

function validateTerminalOutcome(value: unknown, field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} is invalid`);
  const status = (value as { status?: unknown }).status;
  if (status === 'review-ready') {
    assertExactObject(value, ['status', 'pullRequestUrl', 'evidencePath', ...(hasOwn(value, 'continuationEpoch') ? ['continuationEpoch'] : [])], field);
    assertNonEmptyString(value.pullRequestUrl, `${field}.pullRequestUrl`);
    if (hasOwn(value, 'continuationEpoch')) assertGitSha(value.continuationEpoch, `${field}.continuationEpoch`);
  } else if (status === 'blocked') {
    assertExactObject(value, ['status', 'kind', 'resumable', 'evidencePath'], field);
    if (!['external', 'safety', 'exhausted'].includes(value.kind as string)) throw new Error(`${field}.kind is invalid`);
    if (typeof value.resumable !== 'boolean') throw new Error(`${field}.resumable is invalid`);
  } else if (status === 'transport-failed') {
    assertExactObject(value, ['status', 'resumable', 'evidencePath'], field);
    if (typeof value.resumable !== 'boolean') throw new Error(`${field}.resumable is invalid`);
  } else if (status === 'cancelled') {
    assertExactObject(value, ['status', 'evidencePath'], field);
  } else if (status === 'internal-error') {
    assertExactObject(value, ['status', 'code', 'evidencePath'], field);
    assertNonEmptyString(value.code, `${field}.code`);
  } else {
    throw new Error(`${field}.status is invalid`);
  }
  assertNonEmptyString((value as { evidencePath?: unknown }).evidencePath, `${field}.evidencePath`);
}

function validateReceipt(value: unknown, field: string): void {
  assertExactObject(value, ['proofId', 'bindingSha256', 'summary', 'publishableEvidence', 'localEvidenceId'], field);
  assertNonEmptyString(value.proofId, `${field}.proofId`);
  assertSha256(value.bindingSha256, `${field}.bindingSha256`);
  assertNonEmptyString(value.summary, `${field}.summary`);
  assertNonEmptyString(value.localEvidenceId, `${field}.localEvidenceId`);
  if (!Array.isArray(value.publishableEvidence) || value.publishableEvidence.length > 256) throw new Error(`${field}.publishableEvidence is invalid`);
  for (const evidence of value.publishableEvidence) {
    assertExactObject(evidence, ['ref', 'kind', 'sha256', 'description'], `${field}.publishableEvidence`);
    assertNonEmptyString(evidence.ref, `${field}.publishableEvidence.ref`);
    if (evidence.kind !== 'screenshot' && evidence.kind !== 'summary') throw new Error(`${field}.publishableEvidence.kind is invalid`);
    assertSha256(evidence.sha256, `${field}.publishableEvidence.sha256`);
    assertNonEmptyString(evidence.description, `${field}.publishableEvidence.description`);
  }
}

function validateStringShaRecord(value: unknown, field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} is invalid`);
  if (Object.keys(value).length > 256) throw new Error(`${field} is too large`);
  for (const [key, sha] of Object.entries(value)) {
    assertNonEmptyString(key, `${field} key`);
    assertSha256(sha, `${field}.${key}`);
  }
}

function validateStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${field} is invalid`);
  for (const item of value) assertNonEmptyString(item, field);
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || value.some((item, index) => item !== sorted[index])) throw new Error(`${field} must be sorted and unique`);
}

function emptyRunState(): RunStateFileV1 {
  return { schema: 'codex-orchestrator.agent-auto-state', version: 3, generation: 0, runs: [] };
}

function canonicalizeLegacyReportLifecycle(value: unknown, backupPath: string): RunStateFileV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== 'codex-orchestrator.agent-auto-state' || (raw.version !== 2 && raw.version !== 3)
    || !Number.isSafeInteger(raw.generation) || (raw.generation as number) <= 0 || !Array.isArray(raw.runs)) return undefined;
  const runs = structuredClone(raw.runs) as Array<Record<string, any>>;
  const changed = runs.map((run) => canonicalizeLegacyReportRun(run, backupPath)).some(Boolean);
  if (!changed) return undefined;
  return validateRunStateFile({ schema: raw.schema, version: raw.version, generation: (raw.generation as number) + 1, runs });
}

function canonicalizeLegacyReportRun(run: Record<string, any>, backupPath: string): boolean {
  let changed = false, unsafe = false, routeInFlight = false;
  const mutable = canonicalizeLegacyMutableRun(run);
  changed ||= mutable.changed;
  unsafe ||= mutable.unsafe;
  const route = run.routeExecution as Record<string, any> | undefined;
  if (route) {
    const triageTransport = hasOwn(route, 'triageTransportRetries'), ambiguityTransport = hasOwn(route, 'ambiguityTransportRetries');
    if (triageTransport !== ambiguityTransport) throw new Error('legacy route transport budgets are incomplete');
    if (triageTransport) {
      legacyBits([route.triageTransportRetries, route.ambiguityTransportRetries], 'route');
      delete route.triageTransportRetries; delete route.ambiguityTransportRetries; changed = true;
    }
    if (hasOwn(route, 'previousAttemptId')) { delete route.previousAttemptId; changed = true; }
    routeInFlight = ['triage-in-flight', 'review-in-flight', 'repair-in-flight'].includes(route.phase);
    if (routeInFlight) { unsafe = true; delete route.attemptId; delete route.startedAt; }
  }
  const direct = run.directReview as Record<string, any> | undefined;
  if (direct?.review && hasOwn(direct.review, 'transportRetries')) {
    legacyBits([direct.review.transportRetries], 'direct review'); delete direct.review.transportRetries; changed = true; }
  if (direct && hasOwn(direct, 'invocation')) { delete direct.invocation; unsafe = changed = true; }
  const spec = run.specDelivery as Record<string, any> | undefined;
  if (spec?.budgets?.author && hasOwn(spec.budgets.author, 'transportRetries')) {
    legacyBits([spec.budgets.author.transportRetries], 'spec author'); delete spec.budgets.author.transportRetries; changed = true; }
  if (spec?.budgets?.review && hasOwn(spec.budgets.review, 'transportRetries')) {
    legacyBits([spec.budgets.review.transportRetries], 'spec review'); delete spec.budgets.review.transportRetries; changed = true; }
  if (spec?.review && !hasOwn(spec.review, 'reviewerSessionId')) {
    spec.review.reviewerSessionId = spec.review.reviewer?.sessionId ?? (spec.invocation?.purpose === 'review' ? spec.invocation.sessionId : null); changed = true;
  }
  if (spec?.invocation?.purpose === 'review') { delete spec.invocation; unsafe = changed = true; }
  if (spec?.invocation?.purpose === 'author') {
    if (spec.invocation.status === 'launched') unsafe = true;
    if (spec.authorSessionId === null) spec.authorSessionId = spec.invocation.sessionId;
    else if (spec.authorSessionId !== spec.invocation.sessionId) unsafe = true;
    delete spec.invocation; changed = true;
  }
  if (run.reportInvocation && !hasOwn(run.reportInvocation, 'promptFactsSha256')) { delete run.reportInvocation; unsafe = changed = true; }
  if (run.process && ['route', 'code-review', 'spec-author', 'spec-review', 'proof'].includes(run.process.purpose)) {
    delete run.process; unsafe = changed = true;
  }
  if (!unsafe) return changed;
  if (routeInFlight) delete run.routeExecution;
  delete run.reportInvocation; delete run.process; delete run.intent;
  if (direct) run.directReview = projectTerminalDirectReview(direct as unknown as DirectReviewV1,
    { status: 'blocked', kind: 'safety' }, 'report-lifecycle-migration-identity-unavailable');
  run.lifecycle = 'blocked';
  run.outcomeEvidenceId = `report-lifecycle-migration:${String(run.runId)}`;
  run.terminalOutcome = { status: 'blocked', kind: 'safety', resumable: false, evidencePath: backupPath };
  return true;
}

function hasLegacyMutableLifecycle(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { runs?: unknown }).runs)) return false;
  return ((value as { runs: Array<Record<string, any>> }).runs).some((run) =>
    hasOwn(run, 'transportRetries') || run.process?.purpose === 'implementation'
    || hasOwn(run.checkQualification, 'implementationStarted') || hasOwn(run.checkQualification, 'repairInvocation')
    || hasOwn(run.checkQualification, 'deniedPathsBaseline') || hasOwn(run.reviewFeedback, 'implementationInvocation'));
}

function canonicalizeLegacyMutableRun(run: Record<string, any>): { changed: boolean; unsafe: boolean } {
  let changed = false, unsafe = false;
  if (hasOwn(run, 'transportRetries')) {
    legacyBits([run.transportRetries], 'mutable invocation'); delete run.transportRetries; changed = true;
  }
  const qualification = run.checkQualification as Record<string, any> | undefined;
  if (qualification) {
    if (qualification.repairInvocation?.phase === 'launched') unsafe = true;
    for (const field of ['implementationStarted', 'repairInvocation', 'deniedPathsBaseline'])
      if (hasOwn(qualification, field)) { delete qualification[field]; changed = true; }
  }
  const feedback = run.reviewFeedback as Record<string, any> | undefined;
  if (feedback && hasOwn(feedback, 'implementationInvocation')) {
    if (feedback.implementationInvocation?.phase === 'launched') unsafe = true;
    delete feedback.implementationInvocation; changed = true;
  }
  if (run.process?.purpose === 'implementation') { delete run.process; changed = unsafe = true; }
  if (!unsafe) return { changed, unsafe };
  delete run.mutableInvocation;
  if (feedback?.activeBatch) run.reviewFeedback = blockReviewFeedback(feedback as unknown as ReviewFeedbackExecutionV1, 'safety', String(run.updatedAt));
  return { changed: true, unsafe: true };
}

function legacyBits(values: unknown[], owner: string): void {
  if (values.some((value) => value !== 0 && value !== 1)) throw new Error(`legacy ${owner} transport budget is invalid`);
}

interface CandidateMigrationMetadataV1 {
  version: 1;
  sourceGeneration: number | null;
  sourceBytesSha256: string | null;
  publicationEffectPossible: boolean;
  createdAt: string;
  updatedAt: string;
}

function parseRawState(bytes: Buffer): RunStateFileV1 {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('run state JSON is malformed'); }
  return validateRunStateFile(value);
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) { if (isErrorCode(error, 'ENOENT')) return undefined; throw error; }
}

async function readMigrationMetadata(path: string): Promise<CandidateMigrationMetadataV1 | undefined> {
  const bytes = await readOptionalFile(path);
  if (!bytes) return undefined;
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('candidate migration metadata is malformed'); }
  assertExactObject(value, [
    'version', 'sourceGeneration', 'sourceBytesSha256', 'publicationEffectPossible', 'createdAt', 'updatedAt',
  ], 'candidate migration metadata');
  if (value.version !== 1) throw new Error('candidate migration metadata version is invalid');
  if (value.sourceGeneration !== null && (!Number.isSafeInteger(value.sourceGeneration) || (value.sourceGeneration as number) <= 0)) {
    throw new Error('candidate migration source generation is invalid');
  }
  if (value.sourceBytesSha256 !== null) assertSha256(value.sourceBytesSha256, 'candidate migration source hash');
  if ((value.sourceGeneration === null) !== (value.sourceBytesSha256 === null)) throw new Error('candidate migration source identity is incomplete');
  if (typeof value.publicationEffectPossible !== 'boolean') throw new Error('candidate migration publication watermark is invalid');
  assertTimestamp(value.createdAt, 'candidate migration createdAt');
  assertTimestamp(value.updatedAt, 'candidate migration updatedAt');
  return value as unknown as CandidateMigrationMetadataV1;
}

function assertNoCandidateV3Fields(runs: RunRecordV1[]): void {
  for (const run of runs) {
    if (run.changeBindingVersion !== undefined || run.candidateBinding !== undefined || run.executionLease !== undefined) {
      throw new Error('V2 run state cannot contain candidate V3 fields');
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function validateReviewFeedbackRunInvariant(run: RunRecordV1, field: string): void {
  const feedback = run.reviewFeedback!;
  const batch = feedback.activeBatch;
  if (batch && (batch.runId !== run.runId || batch.canonicalRepository !== run.canonicalRepository
    || batch.pullRequest.headRefName !== run.branchName
    || batch.priorPublishedHeadSha !== feedback.previousPublishedHeadSha)) {
    throw new Error(`${field}.reviewFeedback active batch identity binding is invalid`);
  }
  const retainedQuiescentHistory = (feedback.phase === 'idle' || feedback.phase === 'bootstrap-required') && !batch
    && run.lifecycle === 'blocked' && run.terminalOutcome?.status === 'blocked';
  if ((feedback.phase === 'bootstrap-required' || feedback.phase === 'idle')
    && run.lifecycle !== 'review-ready' && !retainedQuiescentHistory) {
    throw new Error(`${field}.reviewFeedback quiescent phase requires review-ready lifecycle`);
  }
  if (['frozen', 'repairing'].includes(feedback.phase) && !['implementing', 'reworking', 'checking', 'proving'].includes(run.lifecycle)) {
    throw new Error(`${field}.reviewFeedback active repair phase has invalid lifecycle`);
  }
  if (feedback.phase === 'verified' && run.lifecycle !== 'publishing') {
    throw new Error(`${field}.reviewFeedback verified phase requires publishing lifecycle`);
  }
  if (feedback.phase === 'publishing' && run.lifecycle !== 'publishing') {
    throw new Error(`${field}.reviewFeedback publishing phase requires publishing lifecycle`);
  }
  if (feedback.phase === 'verified' || feedback.phase === 'publishing') {
    const verified = feedback.verifiedReceipt;
    if (!verified || verified.batchId !== batch?.batchId
      || verified.checkedChangeSha256 !== run.checkedChangeSha256
      || verified.proofId !== run.proofId
      || verified.proofId !== run.proofReceipt?.proofId) {
      throw new Error(`${field}.reviewFeedback verification receipt binding is invalid`);
    }
  }
  if (feedback.phase === 'blocked-safety' || feedback.phase === 'blocked-exhausted') {
    if (run.lifecycle !== 'blocked' || run.terminalOutcome?.status !== 'blocked' || run.terminalOutcome.resumable
      || run.terminalOutcome.kind !== (feedback.phase === 'blocked-safety' ? 'safety' : 'exhausted')) {
      throw new Error(`${field}.reviewFeedback terminal projection mismatch`);
    }
  }
}

function isLifecycle(value: unknown): value is Lifecycle {
  return typeof value === 'string' && [
    'claimed', 'triaging', 'routed', 'waiting-human', 'spec-authoring', 'implementing', 'reworking', 'checking', 'proving', 'publishing',
    'review-ready', 'blocked', 'transport-failed', 'cancelled', 'internal-error',
  ].includes(value);
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, key);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${field} has unknown or missing keys`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) throw new Error(`${field} is invalid`);
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${field} is invalid`);
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
}

function assertGitSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_SHA_PATTERN.test(value)) throw new Error(`${field} must be a Git object ID`);
}

function assertCandidateRef(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^refs\/codex-orchestrator\/candidates\/[0-9a-f-]{36}\/[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${field} is invalid`);
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${field} is invalid`);
}
