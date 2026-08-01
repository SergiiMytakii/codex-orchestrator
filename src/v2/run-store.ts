import type { ProofReceipt } from './proof-report.js';
import { validateActiveAttempt, type ActiveAttempt } from './active-attempt.js';
import { validateReviewData, type ReviewDataV1 } from './review-data.js';
import { validateSpecDelivery, type SpecDeliveryV1 } from './spec-delivery.js';
import {
  validateRouteExecution,
  validateRouteReceipt,
  validateRouteStateInvariant,
  type RouteExecutionV1,
  type RouteReceiptV1,
} from './route-decision.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import { validateDeliveryAuthority, type DeliveryAuthorityV1 } from './delivery-authority.js';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { open, type FileHandle } from 'node:fs/promises';
import { AtomicStateFile, type AtomicStateFileOptions } from './atomic-store.js';
import { canonicalJson, sha256 } from './containment.js';
import { validateCandidateBinding, validateCandidateMaterialization, type CandidateBindingV2, type CandidateMaterializationV2 } from './candidate.js';
import {
  validateReviewFeedbackRunData,
  type ReviewFeedbackRunDataV1,
} from './review-feedback.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Lifecycle =
  | 'claimed'
  | 'triaging'
  | 'routed'
  | 'spec-authoring'
  | 'implementing'
  | 'checking'
  | 'proving'
  | 'publishing'
  | 'review-ready'
  | 'blocked'
  | 'transport-failed'
  | 'cancelled'
  | 'internal-error';

type EffectIdentity = { effectId: string };

export type PendingEffect = EffectIdentity & (
  | { kind: 'claim-labels'; issueNumber: number; expected: string[] }
  | { kind: 'claim-comment' | 'handoff-comment' | 'spec-question-comment'; issueNumber: number; marker: string; bodySha256: string }
  | { kind: 'initial-commit'; parentSha: string; treeSha: string; message: string; candidateRef?: string }
  | { kind: 'initial-push'; branch: string; sha: string }
  | { kind: 'draft-pr'; owner: string; repo: string; head: string; base: string; issueNumber: number; marker: string }
  | { kind: 'final-labels'; issueNumber: number; expected: string[] }
  | { kind: 'spec-waiting-labels'; issueNumber: number; expected: string[] }
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
  }
  | { kind: 'worktree-create'; worktreePath: string; branchName: string; baseBranch: string; baseSha: string }
  | { kind: 'continuation-worktree-create'; worktreePath: string; branchName: string; baseBranch: string; publishedHeadSha: string }
  | { kind: 'candidate-pin-release'; bindingId: string; expectedPinnedCommitSha: string }
  | { kind: 'outcome-evidence'; path: string; runId: string; code: string; summary: string; recordedAt: string; bytesSha256: string }
);

export type PendingEffectInput = PendingEffect extends infer T
  ? T extends EffectIdentity ? Omit<T, 'effectId'> : never
  : never;

export function createPendingEffect<T extends PendingEffectInput>(effect: T): T & EffectIdentity {
  return { ...structuredClone(effect), effectId: sha256(canonicalJson(effect)) };
}

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

export interface RunRecord {
  runId: string;
  issueNumber: number;
  canonicalRepository: string;
  baseSha: string;
  branchName: string;
  worktreePath: string;
  lifecycle: Lifecycle;
  cycle: 1 | 2 | 3 | 4 | 5;
  reportRepairs: 0 | 1;
  transportRetries: 0 | 1;
  issueSnapshot: PersistedIssueSnapshotV1;
  frozenCriteria: PersistedFrozenCriterionV1[];
  reworkFindings: string[];
  packageVersion: string;
  workflowGeneration: WorkflowGenerationReceipt;
  routeExecution?: RouteExecutionV1;
  routeReceipt?: RouteReceiptV1;
  deliveryAuthority?: DeliveryAuthorityV1;
  reviewData?: ReviewDataV1;
  specDelivery?: SpecDeliveryV1;
  reviewFeedback?: ReviewFeedbackRunDataV1;
  changeBindingVersion?: 2;
  candidateBinding?: CandidateBindingV2;
  candidateMaterialization?: CandidateMaterializationV2;
  skillHashes: Record<string, string>;
  activeAttempt?: ActiveAttempt;
  checks: Array<
    | { id: string; command: string; status: 'passed' | 'failed'; outputSha256: string }
    | CandidateCheckReceiptV2
  >;
  checkedChangeSha256?: string;
  proofId?: string;
  proofExecution?: {
    startedAt: string;
    transportRetryCount: 0 | 1;
    reportRepairCount: 0 | 1;
    reportRepairFindings: string[];
  };
  proofReceipt?: ProofReceipt;
  pendingEffect?: PendingEffect;
  outcomeEvidenceId?: string;
  terminalOutcome?: RunTerminalOutcome;
  createdAt: string;
  updatedAt: string;
}

export interface RunStateFile {
  schema: 'codex-orchestrator.run-state';
  generation: number;
  runs: RunRecord[];
}

export type RunStateBody = Omit<RunStateFile, 'generation'>;

export type RunStateInspection =
  | { status: 'absent'; rawSha256: null }
  | { status: 'supported'; rawSha256: string; state: RunStateFile }
  | { status: 'unsupported'; rawSha256: string };

export interface RunRecordWriter {
  inspect(): Promise<RunStateInspection>;
  read(): Promise<RunStateFile>;
  compareAndSwap(expectedGeneration: number, next: RunStateBody): Promise<RunStateFile>;
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
  private readonly file: AtomicStateFile<RunStateFile>;
  private readonly maxBytes: number;

  constructor(path: string, options: AtomicStateFileOptions = {}) {
    this.file = new AtomicStateFile(path, validateRunStateFile, options);
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
  }

  async inspect(): Promise<RunStateInspection> {
    const bytes = await readOptionalStateFile(this.file.path);
    if (!bytes) return { status: 'absent', rawSha256: null };
    const rawSha256 = sha256(bytes);
    if (bytes.length > this.maxBytes) return { status: 'unsupported', rawSha256 };
    try {
      return { status: 'supported', rawSha256, state: parseRawState(bytes) };
    } catch {
      return { status: 'unsupported', rawSha256 };
    }
  }

  async read(): Promise<RunStateFile> {
    const inspection = await this.inspect();
    if (inspection.status === 'absent') return emptyRunState();
    if (inspection.status === 'supported') return inspection.state;
    throw new Error('run state schema is unsupported');
  }

  async compareAndSwap(expectedGeneration: number, next: RunStateBody): Promise<RunStateFile> {
    validateRunStateBody(next);
    const candidate = { ...structuredClone(next), generation: expectedGeneration + 1 };
    return this.file.compareAndSwap(expectedGeneration, candidate);
  }
}

export class InMemoryRunRecordWriter implements RunRecordWriter {
  private state: RunStateFile | undefined;

  async inspect(): Promise<RunStateInspection> {
    if (!this.state) return { status: 'absent', rawSha256: null };
    const state = structuredClone(this.state);
    return {
      status: 'supported',
      rawSha256: sha256(`${canonicalJson(state)}\n`),
      state,
    };
  }

  async read(): Promise<RunStateFile> {
    return structuredClone(this.state ?? emptyRunState());
  }

  async compareAndSwap(expectedGeneration: number, next: RunStateBody): Promise<RunStateFile> {
    if ((this.state?.generation ?? 0) !== expectedGeneration) throw new Error('run state generation conflict');
    validateRunStateBody(next);
    const value = validateRunStateFile({ ...structuredClone(next), generation: expectedGeneration + 1 });
    this.state = value;
    return structuredClone(value);
  }
}

export function validateRunStateFile(value: unknown): RunStateFile {
  assertExactObject(value, ['schema', 'generation', 'runs'], 'run state');
  if (value.schema !== 'codex-orchestrator.run-state') throw new Error('run state schema is invalid');
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) throw new Error('run state generation is invalid');
  validateRuns(value.runs);
  return value as unknown as RunStateFile;
}

function validateRunStateBody(value: unknown): asserts value is RunStateBody {
  assertExactObject(value, ['schema', 'runs'], 'run state body');
  if (value.schema !== 'codex-orchestrator.run-state') throw new Error('run state schema is invalid');
  validateRuns(value.runs);
}

function validateRuns(value: unknown): asserts value is RunRecord[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('run state runs are invalid');
  const ids = new Set<string>();
  for (const [index, run] of value.entries()) {
    validateRunRecord(run, `run state.runs[${index}]`);
    if (ids.has(run.runId)) throw new Error('run IDs must be unique');
    ids.add(run.runId);
  }
}

function validateRunRecord(value: unknown, field: string): asserts value is RunRecord {
  const optional = [
    'activeAttempt',
    'checkedChangeSha256',
    'proofId',
    'proofExecution',
    'proofReceipt',
    'pendingEffect',
    'outcomeEvidenceId',
    'terminalOutcome',
    'routeExecution',
    'routeReceipt',
    'deliveryAuthority',
    'reviewData',
    'specDelivery',
    'reviewFeedback',
    'changeBindingVersion',
    'candidateBinding',
    'candidateMaterialization',
  ].filter((key) => hasOwn(value, key));
  assertExactObject(value, [
    'runId', 'issueNumber', 'canonicalRepository', 'baseSha', 'branchName', 'worktreePath', 'lifecycle', 'cycle',
    'reportRepairs', 'transportRetries', 'issueSnapshot', 'frozenCriteria', 'reworkFindings',
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
  if (value.transportRetries !== 0 && value.transportRetries !== 1) throw new Error(`${field}.transportRetries is invalid`);
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
  if (hasOwn(value, 'deliveryAuthority')) {
    if (!hasOwn(value, 'routeReceipt')) throw new Error(`${field}.deliveryAuthority requires route receipt`);
    validateDeliveryAuthority(
      value.deliveryAuthority,
      value.routeReceipt as RouteReceiptV1,
      hasOwn(value, 'specDelivery') ? value.specDelivery as SpecDeliveryV1 : undefined,
    );
  }
  if (['implementing', 'checking', 'proving', 'publishing', 'review-ready'].includes(value.lifecycle as string)
    && hasOwn(value, 'routeReceipt') && !hasOwn(value, 'deliveryAuthority')) {
    throw new Error(`${field}.deliveryAuthority is required for delivery progression`);
  }
  validateStringShaRecord(value.skillHashes, `${field}.skillHashes`);
  validateChecks(value.checks, `${field}.checks`);
  if (hasOwn(value, 'activeAttempt')) {
    const attempt = validateActiveAttempt(value.activeAttempt);
    if (attempt.runId !== value.runId) throw new Error(`${field}.activeAttempt run identity is invalid`);
  }
  if (hasOwn(value, 'checkedChangeSha256')) assertSha256(value.checkedChangeSha256, `${field}.checkedChangeSha256`);
  if (hasOwn(value, 'proofId')) assertNonEmptyString(value.proofId, `${field}.proofId`);
  if (hasOwn(value, 'proofExecution')) validateProofExecution(value.proofExecution, `${field}.proofExecution`);
  if (hasOwn(value, 'proofReceipt')) validateReceipt(value.proofReceipt, `${field}.proofReceipt`);
  if (hasOwn(value, 'pendingEffect')) validatePendingEffect(value.pendingEffect, `${field}.pendingEffect`);
  if (hasOwn(value, 'outcomeEvidenceId')) assertNonEmptyString(value.outcomeEvidenceId, `${field}.outcomeEvidenceId`);
  if (hasOwn(value, 'terminalOutcome')) validateTerminalOutcome(value.terminalOutcome, `${field}.terminalOutcome`);
  if (hasOwn(value, 'reviewData')) {
    if (!hasOwn(value, 'routeReceipt') || !['direct', 'spec-required'].includes((value.routeReceipt as RouteReceiptV1).route)) {
      throw new Error(`${field}.reviewData requires a delivery authority route`);
    }
    validateReviewData(value.reviewData);
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
    if (value.lifecycle === 'implementing' && spec.stage !== 'frozen') {
      throw new Error(`${field}.specDelivery must be frozen before implementation`);
    }
  }
  if (hasOwn(value, 'reviewFeedback')) {
    validateReviewFeedbackRunData(value.reviewFeedback);
    validateReviewFeedbackRunInvariant(value as unknown as RunRecord, field);
  }
  if (hasOwn(value, 'changeBindingVersion') && value.changeBindingVersion !== 2) throw new Error(`${field}.changeBindingVersion is invalid`);
  if (hasOwn(value, 'candidateBinding')) validateCandidateBinding(value.candidateBinding, `${field}.candidateBinding`, value.runId as string);
  if (hasOwn(value, 'candidateMaterialization')) validateCandidateMaterialization(value.candidateMaterialization, `${field}.candidateMaterialization`);
  if (hasOwn(value, 'candidateBinding') !== hasOwn(value, 'changeBindingVersion')) throw new Error(`${field} candidate binding version is incomplete`);
  if (hasOwn(value, 'candidateMaterialization')) {
    if (!hasOwn(value, 'candidateBinding')) throw new Error(`${field}.candidateMaterialization requires candidate binding`);
    const binding = value.candidateBinding as unknown as CandidateBindingV2;
    const materialization = value.candidateMaterialization as unknown as CandidateMaterializationV2;
    if (materialization.bindingId !== binding.bindingId || materialization.candidateCommitSha !== binding.candidateCommitSha) {
      throw new Error(`${field}.candidateMaterialization binding is invalid`);
    }
  }
  if (hasOwn(value, 'pendingEffect') && hasOwn(value.pendingEffect, 'candidateRef')) {
    if (!hasOwn(value, 'candidateBinding')) throw new Error(`${field}.pendingEffect candidate ref requires candidate binding`);
    const binding = value.candidateBinding as unknown as CandidateBindingV2;
    const pendingEffect = value.pendingEffect as Extract<PendingEffect, { kind: 'initial-commit' | 'review-update-commit' }>;
    if (pendingEffect.candidateRef !== binding.candidateRef || pendingEffect.treeSha !== binding.candidateTreeSha) {
      throw new Error(`${field}.pendingEffect candidate binding is invalid`);
    }
  }
  if ((value.pendingEffect as PendingEffect | undefined)?.kind === 'candidate-pin-release') {
    if (!hasOwn(value, 'candidateBinding')) throw new Error(`${field}.candidate pin cleanup requires candidate binding`);
    const binding = value.candidateBinding as unknown as CandidateBindingV2;
    const pendingEffect = value.pendingEffect as Extract<PendingEffect, { kind: 'candidate-pin-release' }>;
    if (pendingEffect.bindingId !== binding.bindingId
      || pendingEffect.expectedPinnedCommitSha !== binding.candidateCommitSha) {
      throw new Error(`${field}.candidate pin cleanup binding is invalid`);
    }
  }
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
  const reviewReadyEffect = (value.pendingEffect as PendingEffect | undefined)?.kind;
  const reviewReadyEffectAllowed = reviewReadyEffect === undefined
    || ['review-activation-labels', 'blocked-labels', 'continuation-worktree-create', 'outcome-evidence'].includes(reviewReadyEffect);
  if (value.lifecycle === 'review-ready' && (!hasOwn(value, 'proofReceipt') || !reviewReadyEffectAllowed)) {
    throw new Error(`${field} review-ready requires proofReceipt and only a review continuation or terminal effect`);
  }
  const retainedCandidateEffect = value.lifecycle === 'blocked'
    && (value.terminalOutcome as RunTerminalOutcome | undefined)?.status === 'blocked'
    && (value.terminalOutcome as Extract<RunTerminalOutcome, { status: 'blocked' }>).kind === 'safety'
    && !(value.terminalOutcome as Extract<RunTerminalOutcome, { status: 'blocked' }>).resumable
    && hasOwn(value, 'candidateBinding')
    && ((value.pendingEffect as PendingEffect | undefined)?.kind === 'initial-commit' || (value.pendingEffect as PendingEffect | undefined)?.kind === 'review-update-commit');
  const settlingOutcomeEvidence = (value.pendingEffect as PendingEffect | undefined)?.kind === 'outcome-evidence';
  if (terminal && hasOwn(value, 'pendingEffect') && value.lifecycle !== 'transport-failed'
    && !retainedCandidateEffect && !settlingOutcomeEvidence) throw new Error(`${field} terminal lifecycle cannot retain pending effect`);
  if (value.lifecycle === 'transport-failed' && hasOwn(value, 'pendingEffect')
    && !settlingOutcomeEvidence
    && (value.terminalOutcome as Extract<RunTerminalOutcome, { status: 'transport-failed' }>).resumable) {
    throw new Error(`${field} resumable transport failure cannot retain pending effect`);
  }
  validateRouteStateInvariant({
    lifecycle: value.lifecycle,
    routeExecution: value.routeExecution,
    routeReceipt: value.routeReceipt,
    generationHash: routeGenerationHash,
  });
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

function validateChecks(value: unknown, field: string): asserts value is RunRecord['checks'] {
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
    if (check.status !== 'passed' && check.status !== 'failed') throw new Error(`${field}[${index}].status is invalid`);
    assertSha256(check.outputSha256, `${field}[${index}].outputSha256`);
    if (candidate) {
      assertSha256(check.bindingId, `${field}[${index}].bindingId`);
      assertGitSha(check.candidateTreeSha, `${field}[${index}].candidateTreeSha`);
      assertSha256(check.checkPolicySha256, `${field}[${index}].checkPolicySha256`);
    }
    if (ids.has(check.id)) throw new Error(`${field} IDs must be unique`);
    ids.add(check.id);
  }
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

function validatePendingEffect(value: unknown, field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} is invalid`);
  const kind = (value as { kind?: unknown }).kind;
  const identity = ['effectId', 'kind'];
  if (kind === 'claim-labels' || kind === 'final-labels' || kind === 'spec-waiting-labels'
    ) {
    assertExactObject(value, [...identity, 'issueNumber', 'expected'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    validateStringArray(value.expected, `${field}.expected`);
  } else if (kind === 'initial-commit') {
    assertExactObject(value, [...identity, 'parentSha', 'treeSha', 'message', ...(hasOwn(value, 'candidateRef') ? ['candidateRef'] : [])], field);
    assertGitSha(value.parentSha, `${field}.parentSha`);
    assertGitSha(value.treeSha, `${field}.treeSha`);
    assertNonEmptyString(value.message, `${field}.message`);
    if (hasOwn(value, 'candidateRef')) assertCandidateRef(value.candidateRef, `${field}.candidateRef`);
  } else if (kind === 'initial-push') {
    assertExactObject(value, [...identity, 'branch', 'sha'], field);
    assertNonEmptyString(value.branch, `${field}.branch`);
    assertGitSha(value.sha, `${field}.sha`);
  } else if (kind === 'draft-pr') {
    assertExactObject(value, [...identity, 'owner', 'repo', 'head', 'base', 'issueNumber', 'marker'], field);
    for (const key of ['owner', 'repo', 'head', 'base', 'marker'] as const) assertNonEmptyString(value[key], `${field}.${key}`);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
  } else if (kind === 'claim-comment' || kind === 'handoff-comment' || kind === 'spec-question-comment') {
    assertExactObject(value, [...identity, 'issueNumber', 'marker', 'bodySha256'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertNonEmptyString(value.marker, `${field}.marker`);
    assertSha256(value.bodySha256, `${field}.bodySha256`);
  } else if (kind === 'review-activation-labels') {
    assertExactObject(value, [...identity, 'issueNumber', 'batchId', 'expected'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertSha256(value.batchId, `${field}.batchId`);
    validateStringArray(value.expected, `${field}.expected`);
  } else if (kind === 'review-update-commit') {
    assertExactObject(value, [...identity, 'batchId', 'parentSha', 'treeSha', 'message', ...(hasOwn(value, 'candidateRef') ? ['candidateRef'] : [])], field);
    assertSha256(value.batchId, `${field}.batchId`);
    assertGitSha(value.parentSha, `${field}.parentSha`);
    assertGitSha(value.treeSha, `${field}.treeSha`);
    assertNonEmptyString(value.message, `${field}.message`);
    if (hasOwn(value, 'candidateRef')) assertCandidateRef(value.candidateRef, `${field}.candidateRef`);
  } else if (kind === 'review-update-push') {
    assertExactObject(value, [...identity, 'batchId', 'branch', 'priorRemoteSha', 'sha', 'treeSha'], field);
    assertSha256(value.batchId, `${field}.batchId`);
    assertNonEmptyString(value.branch, `${field}.branch`);
    assertGitSha(value.priorRemoteSha, `${field}.priorRemoteSha`);
    assertGitSha(value.sha, `${field}.sha`);
    assertGitSha(value.treeSha, `${field}.treeSha`);
  } else if (kind === 'review-summary') {
    assertExactObject(value, [...identity, 'batchId', 'pullRequestNumber', 'pullRequestNodeId', 'marker', 'bodySha256', 'epochHeadSha'], field);
    assertSha256(value.batchId, `${field}.batchId`);
    assertPositiveInteger(value.pullRequestNumber, `${field}.pullRequestNumber`);
    assertNonEmptyString(value.pullRequestNodeId, `${field}.pullRequestNodeId`);
    assertNonEmptyString(value.marker, `${field}.marker`);
    assertSha256(value.bodySha256, `${field}.bodySha256`);
    assertGitSha(value.epochHeadSha, `${field}.epochHeadSha`);
  } else if (kind === 'review-final-labels') {
    assertExactObject(value, [...identity, 'issueNumber', 'batchId', 'pullRequestNumber', 'pullRequestNodeId', 'epochHeadSha', 'expected'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertSha256(value.batchId, `${field}.batchId`);
    assertPositiveInteger(value.pullRequestNumber, `${field}.pullRequestNumber`);
    assertNonEmptyString(value.pullRequestNodeId, `${field}.pullRequestNodeId`);
    assertGitSha(value.epochHeadSha, `${field}.epochHeadSha`);
    validateStringArray(value.expected, `${field}.expected`);
  } else if (kind === 'review-blocked-labels') {
    assertExactObject(value, [...identity, 'issueNumber', 'batchId', 'expected', 'blockKind', 'evidenceCode'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertSha256(value.batchId, `${field}.batchId`);
    validateStringArray(value.expected, `${field}.expected`);
    if (value.blockKind !== 'safety' && value.blockKind !== 'exhausted') throw new Error(`${field}.blockKind is invalid`);
    assertNonEmptyString(value.evidenceCode, `${field}.evidenceCode`);
  } else if (kind === 'blocked-labels') {
    assertExactObject(value, [...identity, 'issueNumber', 'expected', 'blockKind', 'resumable', 'evidenceCode'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    validateStringArray(value.expected, `${field}.expected`);
    if (!['external', 'safety', 'exhausted'].includes(value.blockKind as string)) throw new Error(`${field}.blockKind is invalid`);
    if (typeof value.resumable !== 'boolean') throw new Error(`${field}.resumable is invalid`);
    assertNonEmptyString(value.evidenceCode, `${field}.evidenceCode`);
  } else if (kind === 'worktree-create') {
    assertExactObject(value, [...identity, 'worktreePath', 'branchName', 'baseBranch', 'baseSha'], field);
    assertAbsolutePath(value.worktreePath, `${field}.worktreePath`);
    assertNonEmptyString(value.branchName, `${field}.branchName`);
    assertNonEmptyString(value.baseBranch, `${field}.baseBranch`);
    assertGitSha(value.baseSha, `${field}.baseSha`);
  } else if (kind === 'continuation-worktree-create') {
    assertExactObject(value, [...identity, 'worktreePath', 'branchName', 'baseBranch', 'publishedHeadSha'], field);
    assertAbsolutePath(value.worktreePath, `${field}.worktreePath`);
    assertNonEmptyString(value.branchName, `${field}.branchName`);
    assertNonEmptyString(value.baseBranch, `${field}.baseBranch`);
    assertGitSha(value.publishedHeadSha, `${field}.publishedHeadSha`);
  } else if (kind === 'candidate-pin-release') {
    assertExactObject(value, [...identity, 'bindingId', 'expectedPinnedCommitSha'], field);
    assertSha256(value.bindingId, `${field}.bindingId`);
    assertGitSha(value.expectedPinnedCommitSha, `${field}.expectedPinnedCommitSha`);
  } else if (kind === 'outcome-evidence') {
    assertExactObject(value, [...identity, 'path', 'runId', 'code', 'summary', 'recordedAt', 'bytesSha256'], field);
    assertNonEmptyString(value.path, `${field}.path`);
    if (typeof value.runId !== 'string' || !UUID_V4_PATTERN.test(value.runId)) throw new Error(`${field}.runId is invalid`);
    assertNonEmptyString(value.code, `${field}.code`);
    assertNonEmptyString(value.summary, `${field}.summary`);
    assertTimestamp(value.recordedAt, `${field}.recordedAt`);
    assertSha256(value.bytesSha256, `${field}.bytesSha256`);
  } else {
    throw new Error(`${field}.kind is invalid`);
  }
  assertSha256(value.effectId, `${field}.effectId`);
  const { effectId, ...payload } = value;
  if (effectId !== sha256(canonicalJson(payload))) throw new Error(`${field}.effectId does not match its payload`);
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

function validateProofExecution(value: unknown, field: string): void {
  assertExactObject(value, ['startedAt', 'transportRetryCount', 'reportRepairCount', 'reportRepairFindings'], field);
  assertTimestamp(value.startedAt, `${field}.startedAt`);
  if (value.transportRetryCount !== 0 && value.transportRetryCount !== 1) throw new Error(`${field}.transportRetryCount is invalid`);
  if (value.reportRepairCount !== 0 && value.reportRepairCount !== 1) throw new Error(`${field}.reportRepairCount is invalid`);
  validateStringList(value.reportRepairFindings, `${field}.reportRepairFindings`);
  if ((value.reportRepairCount === 0) !== (value.reportRepairFindings.length === 0)) {
    throw new Error(`${field} report repair state is invalid`);
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

function emptyRunState(): RunStateFile {
  return { schema: 'codex-orchestrator.run-state', generation: 0, runs: [] };
}

function parseRawState(bytes: Buffer): RunStateFile {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('run state JSON is malformed'); }
  return validateRunStateFile(value);
}

async function readOptionalStateFile(path: string): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function validateReviewFeedbackRunInvariant(run: RunRecord, field: string): void {
  const feedback = run.reviewFeedback!;
  const batch = feedback.activeBatch;
  if (batch && (batch.runId !== run.runId || batch.canonicalRepository !== run.canonicalRepository
    || batch.pullRequest.headRefName !== run.branchName
    || batch.priorPublishedHeadSha !== feedback.previousPublishedHeadSha)) {
    throw new Error(`${field}.reviewFeedback active batch identity binding is invalid`);
  }
  const retainedQuiescentHistory = !batch && run.lifecycle === 'blocked' && run.terminalOutcome?.status === 'blocked';
  if (!batch && run.lifecycle !== 'review-ready' && !retainedQuiescentHistory) {
    throw new Error(`${field}.reviewFeedback quiescent data requires review-ready lifecycle`);
  }
  if (batch && !feedback.verifiedReceipt
    && !['implementing', 'checking', 'proving'].includes(run.lifecycle)) {
    throw new Error(`${field}.reviewFeedback active batch has invalid lifecycle`);
  }
  if (feedback.verifiedReceipt) {
    if (run.lifecycle !== 'publishing') throw new Error(`${field}.reviewFeedback verified batch requires publishing lifecycle`);
    const verified = feedback.verifiedReceipt;
    if (!verified || verified.batchId !== batch?.batchId
      || verified.checkedChangeSha256 !== run.checkedChangeSha256
      || verified.proofId !== run.proofId
      || verified.proofId !== run.proofReceipt?.proofId) {
      throw new Error(`${field}.reviewFeedback verification receipt binding is invalid`);
    }
  }
}

function isLifecycle(value: unknown): value is Lifecycle {
  return typeof value === 'string' && [
    'claimed', 'triaging', 'routed', 'spec-authoring', 'implementing', 'checking', 'proving', 'publishing',
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

function assertAbsolutePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || posix.normalize(value) !== value) throw new Error(`${field} is invalid`);
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
