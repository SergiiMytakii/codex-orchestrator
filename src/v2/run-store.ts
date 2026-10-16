import { validateImplementationChecks, validateImplementationReview, type ImplementationCheck, type ImplementationReviewV1 } from './implementation-report.js';
import { validateProofReport, type ProofReceipt, type ProofReportV1 } from './proof-report.js';
import type { SettledProveChangeResult } from './acceptance-proof.js';
import { validateActiveAttempt, type ActiveAttempt } from './active-attempt.js';
import { validateDirectReview, type DirectReviewV1 } from './direct-delivery.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import { validateDeliveryAuthority, type DeliveryAuthority } from './delivery-authority.js';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { link, lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { AtomicStateFile, type AtomicStateFileOptions } from './atomic-store.js';
import { canonicalJson, sha256 } from './containment.js';
import { validateCandidateBinding, validateCandidateMaterialization, type CandidateBindingV2, type CandidateMaterializationV2 } from './candidate.js';
import {
  validateReviewFeedbackRunData,
  validateFrozenReviewFeedbackBatch,
  type FrozenReviewFeedbackBatchV1,
  type ReviewFeedbackRunDataV1,
} from './review-feedback.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Lifecycle =
  | 'claimed'
  | 'implementing'
  | 'checking'
  | 'proving'
  | 'reviewing'
  | 'publishing'
  | 'safe-halt'
  | 'review-ready'
  | 'blocked'
  | 'transport-failed'
  | 'cancelled'
  | 'internal-error';

type EffectIdentity = { effectId: string };

export type PendingEffect = EffectIdentity & (
  | { kind: 'claim-labels'; issueNumber: number; expected: string[] }
  | { kind: 'claim-comment'; issueNumber: number; marker: string; bodySha256: string }
  | { kind: 'initial-commit'; parentSha: string; treeSha: string; message: string; candidateRef?: string }
  | { kind: 'initial-push'; branch: string; sha: string }
  | { kind: 'draft-pr'; owner: string; repo: string; head: string; base: string; issueNumber: number; marker: string }
  | {
    kind: 'terminal-comment'; issueNumber: number; marker: string; bodySha256: string;
    outcome: 'review-ready' | 'blocked' | 'internal-error' | 'cancelled'; attempt: number;
  }
  | {
    kind: 'terminal-labels'; issueNumber: number; add: string[]; remove: string[];
    outcome: 'review-ready' | 'blocked' | 'internal-error' | 'cancelled'; attempt: number;
  }
  | { kind: 'review-activation-labels'; issueNumber: number; batchId: string; expected: string[] }
  | { kind: 'review-update-commit'; batchId: string; parentSha: string; treeSha: string; message: string; candidateRef?: string }
  | { kind: 'review-update-push'; batchId: string; branch: string; priorRemoteSha: string; sha: string; treeSha: string }
  | { kind: 'issue-feedback-comment'; issueNumber: number; batchId: string; batch: FrozenReviewFeedbackBatchV1; marker: string; body: string; bodySha256: string }
  | { kind: 'review-summary'; batchId: string; pullRequestNumber: number; pullRequestNodeId: string; marker: string; bodySha256: string; epochHeadSha: string }
  | { kind: 'review-final-labels'; issueNumber: number; batchId: string; pullRequestNumber: number; pullRequestNodeId: string; epochHeadSha: string; expected: string[] }
  | { kind: 'worktree-create'; worktreePath: string; branchName: string; baseBranch: string; baseSha: string }
  | { kind: 'continuation-worktree-create'; worktreePath: string; branchName: string; baseBranch: string; publishedHeadSha: string }
  | { kind: 'candidate-pin-release'; bindingId: string; expectedPinnedCommitSha: string }
  | { kind: 'outcome-evidence'; path: string; runId: string; code: string; summary: string; recordedAt: string; bytesSha256: string; authorizationGrantId?: string }
);

export type PendingEffectInput = PendingEffect extends infer T
  ? T extends EffectIdentity ? Omit<T, 'effectId'> : never
  : never;

export function createPendingEffect<T extends PendingEffectInput>(effect: T): T & EffectIdentity {
  return { ...structuredClone(effect), effectId: sha256(canonicalJson(effect)) };
}

export type RunTerminalOutcome =
  | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string; continuationEpoch?: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'decision-delta' | 'out-of-scope' | 'authority-boundary'; resumable: boolean; evidencePath: string; blocker?: { kind: string; summary: string; attempted: string[]; resumable: boolean; reviewerRejectionDetail?: string } }
  | { status: 'transport-failed'; resumable: boolean; evidencePath: string }
  | { status: 'cancelled'; evidencePath: string }
  | { status: 'internal-error'; code: string; evidencePath: string };

export interface TerminalReportSnapshotV1 {
  version: 1;
  outcome: 'review-ready' | 'blocked' | 'internal-error' | 'cancelled';
  summary: string;
  pullRequestUrl?: string;
  retainedWork?: string[];
  passedChecks: string[];
  publishableProof: string[];
  unverified: string[];
  risks: string[];
  reviewFocus: string[];
  nextAction: string;
  blocker?: { kind: string; resumable: boolean; attempted: string[] };
}

export interface TerminalNotificationStateV1 {
  version: 1;
  commentCutoff: { commentId: string | null; observedAt: string };
  report: TerminalReportSnapshotV1;
  comment: { status: 'pending' | 'delivered' | 'exhausted'; attempts: number; diagnostic?: string };
  labels: { status: 'pending' | 'delivered' | 'exhausted'; attempts: number; diagnostic?: string };
}

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
  cycle: number;
  reportRepairs: number;
  transportRetries: number;
  issueSnapshot: PersistedIssueSnapshotV1;
  frozenCriteria: PersistedFrozenCriterionV1[];
  reworkFindings: string[];
  packageVersion: string;
  workflowGeneration: WorkflowGenerationReceipt;
  deliveryAuthority?: DeliveryAuthority;
  directReview?: DirectReviewV1;
  reviewFeedback?: ReviewFeedbackRunDataV1;
  changeBindingVersion?: 2;
  candidateBinding?: CandidateBindingV2;
  candidateMaterialization?: CandidateMaterializationV2;
  skillHashes: Record<string, string>;
  activeAttempt?: ActiveAttempt;
  androidProofPreparation?: { status: 'pending' | 'prepared' | 'blocked'; checkedChangeSha256: string; runnerPreparedArtifactPaths: string[]; runnerPreparedArtifactSha256: Record<string, string>; runnerPreparationWarnings: string[] };
  codexSession?: { id: string; startedAt: string };
  checks: Array<
    | { id: string; command: string; status: 'passed' | 'failed'; outputSha256: string }
    | CandidateCheckReceiptV2
  >;
  failedCheckRepair?: { id: string; command: string; candidateTreeSha: string };
  checkedChangeSha256?: string;
  proofId?: string;
  proofExecution?: {
    startedAt: string;
    transportRetryCount: number;
    reportRepairCount: number;
    reportRepairFindings: string[];
    cleanupOutcome?: SettledProveChangeResult;
    reportCorrection?: { path: string; sha256: string; diagnostic: string };
  };
  proofReceipt?: ProofReceipt;
  implementationResult?: { summary: string; residualRisks: string[]; checks?: ImplementationCheck[]; proof?: ProofReportV1; review?: ImplementationReviewV1 };
  implementationReportCorrection?: { path: string; sha256: string; diagnostic: string };
  terminalNotifications?: TerminalNotificationStateV1;
  pendingEffect?: PendingEffect;
  outcomeEvidenceId?: string;
  terminalOutcome?: RunTerminalOutcome;
  terminalAuthorizationGrantId?: string;
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
  | { status: 'unsupported'; rawSha256: string; reason?: string };

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

export class IssueInitializationUnrecoverableError extends Error {
  constructor() {
    super('issue-initialization-unrecoverable');
    this.name = 'IssueInitializationUnrecoverableError';
  }
}

export class FileRunRecordWriter implements RunRecordWriter {
  private readonly file: AtomicStateFile<StoredRunState>;
  private readonly maxBytes: number;
  private repository?: { legacyPath: string; canonicalRepository: string; directory: string };
  private issueNumber?: number;
  private readonly options: AtomicStateFileOptions;

  constructor(path: string, options: AtomicStateFileOptions = {}) {
    this.file = new AtomicStateFile(path, validateStoredRunState, options);
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.options = options;
  }

  /** Repository mode never persists aggregate inventory: CAS belongs to forIssue(). */
  static forRepository(legacyPath: string, canonicalRepository: string, options: AtomicStateFileOptions = {}): FileRunRecordWriter {
    if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(canonicalRepository)) throw new Error('canonical repository is invalid');
    const writer = new FileRunRecordWriter(legacyPath, options);
    writer.repository = { legacyPath, canonicalRepository, directory: join(dirname(legacyPath), 'runs', sha256(canonicalRepository)) };
    return writer;
  }

  forIssue(issueNumber: number): FileRunRecordWriter {
    if (!this.repository) throw new Error('per-issue storage requires repository mode');
    assertPositiveInteger(issueNumber, 'issueNumber');
    const writer = new FileRunRecordWriter(join(this.repository.directory, `${issueNumber}.json`), this.options);
    writer.repository = this.repository;
    writer.issueNumber = issueNumber;
    return writer;
  }

  /** Called only while the current Runner owns the repository owner-control lock. */
  async migrateLegacy(): Promise<void> {
    if (!this.repository || this.issueNumber !== undefined) throw new Error('migration requires repository inventory writer');
    if (!this.options.exclusiveRepositoryOwnership) throw new Error('migration requires exclusive repository ownership');
    await this.file.withExclusiveLock(async () => {
      const bytes = await readOptionalStateFile(this.repository!.legacyPath);
      if (!bytes) return;
      // Validate every record, including records belonging to another repository, before any write.
      const state = await hydrateStoredRunState(validateStoredRunState(JSON.parse(bytes.toString('utf8'))), dirname(this.repository!.legacyPath));
      if (state.runs.some((run) => run.canonicalRepository !== this.repository!.canonicalRepository)) throw new Error('legacy migration contains a foreign repository; original journal preserved');
      const grouped = new Map<string, { repository: string; issueNumber: number; runs: RunRecord[] }>();
      for (const run of state.runs) {
        const key = `${run.canonicalRepository}:${run.issueNumber}`;
        const group = grouped.get(key) ?? { repository: run.canonicalRepository, issueNumber: run.issueNumber, runs: [] };
        group.runs.push(run);
        grouped.set(key, group);
      }
      for (const group of grouped.values()) {
        const writer = FileRunRecordWriter.forRepository(this.repository!.legacyPath, group.repository, this.options).forIssue(group.issueNumber);
        const expected = { schema: state.schema, generation: 1, runs: group.runs };
        const inspection = await writer.inspect();
        if (inspection.status === 'absent') await writer.compareAndSwap(0, { schema: state.schema, runs: group.runs });
        else if (inspection.status !== 'supported' || canonicalJson(inspection.state) !== canonicalJson(expected)
          || inspection.rawSha256 !== sha256(`${canonicalJson(await archiveRunHistory(expected, dirname(writer.file.path), this.maxBytes))}\n`)) {
          throw new Error('legacy migration destination diverged; original journal preserved');
        }
        if (canonicalJson(await writer.read()) !== canonicalJson(expected)) throw new Error('legacy migration verification failed');
      }
      const observed = await readOptionalStateFile(this.repository!.legacyPath);
      if (!observed?.equals(bytes)) throw new Error('legacy migration source diverged');
      const backupPath = `${this.repository!.legacyPath}.backup`;
      const backup = await readOptionalStateFile(backupPath);
      if (backup && !backup.equals(bytes)) throw new Error('legacy migration backup diverged');
      if (backup) throw new Error('legacy migration source unexpectedly reappeared beside backup');
      await rename(this.repository!.legacyPath, backupPath);
      const parent = await open(dirname(backupPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    });
  }

  async inventory(): Promise<RunStateFile> {
    if (!this.repository) return this.read();
    // Legacy bytes stay authoritative until migration has completed.
    const legacy = await readOptionalStateFile(this.repository.legacyPath);
    if (legacy) return { schema: 'codex-orchestrator.run-state', generation: 0,
      runs: (await hydrateStoredRunState(validateStoredRunState(JSON.parse(legacy.toString('utf8'))), dirname(this.repository.legacyPath))).runs.filter((run) => run.canonicalRepository === this.repository!.canonicalRepository) };
    let entries;
    try {
      const stat = await lstat(this.repository.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('run inventory directory is unsafe');
      entries = await readdir(this.repository.directory, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        const backup = await readOptionalStateFile(`${this.repository.legacyPath}.backup`);
        if (backup && (await hydrateStoredRunState(validateStoredRunState(JSON.parse(backup.toString('utf8'))), dirname(this.repository.legacyPath))).runs.some((run) => run.canonicalRepository === this.repository!.canonicalRepository)) throw new Error('migrated run inventory directory is missing');
        return emptyRunState();
      }
      throw error;
    }
    const runs: RunRecord[] = [];
    for (const entry of entries) {
      if (entry.name === 'evidence' && entry.isDirectory()) continue;
      if (entry.name.endsWith('.lock') || entry.name.endsWith('.tmp')) continue;
      if (!entry.isFile() || !/^[1-9][0-9]*\.json$/u.test(entry.name)) throw new Error('run inventory contains unsupported entry');
      const issue = Number(entry.name.slice(0, -5));
      const inspection = await this.forIssue(issue).inspect();
      if (inspection.status !== 'supported') throw new Error('run inventory is incomplete or unsupported');
      runs.push(...inspection.state.runs);
    }
    validateRuns(runs);
    const backup = await readOptionalStateFile(`${this.repository.legacyPath}.backup`);
    if (backup) {
      for (const previous of (await hydrateStoredRunState(validateStoredRunState(JSON.parse(backup.toString('utf8'))), dirname(this.repository.legacyPath))).runs.filter((run) => run.canonicalRepository === this.repository!.canonicalRepository)) {
        if (!runs.some((run) => run.runId === previous.runId && run.issueNumber === previous.issueNumber)) throw new Error('migrated run inventory is incomplete');
      }
    }
    return { schema: 'codex-orchestrator.run-state', generation: 0, runs };
  }

  async inspect(): Promise<RunStateInspection> {
    if (this.repository && this.issueNumber === undefined) {
      try {
        const state = await this.inventory();
        return state.runs.length ? { status: 'supported', rawSha256: sha256(canonicalJson(state)), state } : { status: 'absent', rawSha256: null };
      } catch (error) { return { status: 'unsupported', rawSha256: sha256(String(error)), reason: String(error) }; }
    }
    const bytes = await readOptionalStateFile(this.file.path);
    if (!bytes) {
      if (this.repository && this.issueNumber !== undefined) {
        const backup = await readOptionalStateFile(`${this.repository.legacyPath}.backup`);
        if (backup && (await hydrateStoredRunState(validateStoredRunState(JSON.parse(backup.toString('utf8'))), dirname(this.repository.legacyPath))).runs.some((run) => run.canonicalRepository === this.repository!.canonicalRepository && run.issueNumber === this.issueNumber)) {
          return { status: 'unsupported', rawSha256: sha256(backup), reason: 'Migrated issue journal is missing; refusing to create a replacement Run.' };
        }
      }
      return { status: 'absent', rawSha256: null };
    }
    const rawSha256 = sha256(bytes);
    if (bytes.length > this.maxBytes) return { status: 'unsupported', rawSha256, reason: 'Run state exceeds the supported size limit; inspect and archive it before starting a new journal.' };
    try {
      const state = await hydrateStoredRunState(validateStoredRunState(JSON.parse(bytes.toString('utf8'))), dirname(this.file.path));
      this.assertIssueIdentity(state.runs);
      return { status: 'supported', rawSha256, state };
    } catch {
      return { status: 'unsupported', rawSha256, reason: unsupportedStateReason(bytes) };
    }
  }

  async read(): Promise<RunStateFile> {
    const inspection = await this.inspect();
    if (inspection.status === 'absent') return emptyRunState();
    if (inspection.status === 'supported') return inspection.state;
    throw new Error(`run state schema is unsupported: ${inspection.reason ?? 'inspect the saved journal'}`);
  }

  async compareAndSwap(expectedGeneration: number, next: RunStateBody): Promise<RunStateFile> {
    if (this.repository && this.issueNumber === undefined) throw new Error('aggregate inventory cannot be persisted');
    validateRunStateBody(next);
    this.assertIssueIdentity(next.runs);
    const inspection = await this.inspect();
    if (inspection.status === 'unsupported') throw new Error('existing run state evidence is unsupported');
    if ((inspection.status === 'supported' ? inspection.state.generation : 0) !== expectedGeneration) throw new Error('run state generation conflict');
    const candidate = { ...structuredClone(next), generation: expectedGeneration + 1 };
    const stored = await archiveRunHistory(candidate, dirname(this.file.path), this.maxBytes);
    await this.file.compareAndSwap(expectedGeneration, stored);
    return candidate;
  }
  private assertIssueIdentity(runs: RunRecord[]): void {
    if (this.repository && this.issueNumber !== undefined && runs.some((run) => run.issueNumber !== this.issueNumber || run.canonicalRepository !== this.repository!.canonicalRepository)) {
      throw new Error('per-issue run state identity mismatch');
    }
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
  // Older envelopes are harmless only when every record meets today's contract.
  // Never discard execution, authority, or publication fields to make a record fit.
  if (hasOwn(value, 'schema') && (value as Record<string, unknown>).schema === 'codex-orchestrator.agent-auto-state') {
    assertExactObject(value, ['schema', 'version', 'generation', 'runs'], 'legacy run state');
    if (value.version !== 2 && value.version !== 3) throw new Error('legacy run state version is invalid');
    return validateRunStateFile({ schema: 'codex-orchestrator.run-state', generation: value.generation, runs: value.runs });
  }
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
  if (!Array.isArray(value)) throw new Error('run state runs are invalid');
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
    'codexSession',
    'androidProofPreparation',
    'checkedChangeSha256',
    'proofId',
    'proofExecution',
    'proofReceipt',
    'implementationResult',
    'implementationReportCorrection',
    'terminalNotifications',
    'terminalAuthorizationGrantId',
    'pendingEffect',
    'outcomeEvidenceId',
    'terminalOutcome',
    'deliveryAuthority',
    'directReview',
    'reviewFeedback',
    'changeBindingVersion',
    'candidateBinding',
    'candidateMaterialization',
    'failedCheckRepair',
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
  if (!Number.isSafeInteger(value.cycle) || (value.cycle as number) < 1) throw new Error(`${field}.cycle is invalid`);
  if (!Number.isSafeInteger(value.reportRepairs) || (value.reportRepairs as number) < 0) throw new Error(`${field}.reportRepairs is invalid`);
  if (!Number.isSafeInteger(value.transportRetries) || (value.transportRetries as number) < 0) throw new Error(`${field}.transportRetries is invalid`);
  if (hasOwn(value, 'terminalAuthorizationGrantId') && (typeof value.terminalAuthorizationGrantId !== 'string'
    || !/^[1-9][0-9]*$/u.test(value.terminalAuthorizationGrantId))) throw new Error(`${field}.terminalAuthorizationGrantId is invalid`);
  validateIssueSnapshot(value.issueSnapshot, `${field}.issueSnapshot`);
  validateFrozenCriteria(value.frozenCriteria, `${field}.frozenCriteria`);
  validateStringList(value.reworkFindings, `${field}.reworkFindings`);
  assertNonEmptyString(value.packageVersion, `${field}.packageVersion`);
  const workflowGeneration = value.workflowGeneration;
  validateWorkflowGeneration(workflowGeneration, `${field}.workflowGeneration`);
  if (workflowGeneration.packageVersion !== value.packageVersion) {
    throw new Error(`${field}.workflowGeneration package version mismatch`);
  }
  if (hasOwn(value, 'deliveryAuthority')) {
    validateDeliveryAuthority(
      value.deliveryAuthority,
      {
        issueNumber: value.issueSnapshot.number as number,
        issueUrl: value.issueSnapshot.url as string,
        title: value.issueSnapshot.title as string,
        body: value.issueSnapshot.body as string,
        authorizationLabel: (value.deliveryAuthority as DeliveryAuthority).authorizationLabel,
      },
    );
  }
  if (['implementing', 'checking', 'proving', 'reviewing', 'publishing', 'review-ready'].includes(value.lifecycle as string)
    && !hasOwn(value, 'deliveryAuthority')) {
    throw new Error(`${field}.deliveryAuthority is required for delivery progression`);
  }
  validateStringShaRecord(value.skillHashes, `${field}.skillHashes`);
  validateChecks(value.checks, `${field}.checks`);
  if (hasOwn(value, 'failedCheckRepair')) {
    const repair = value.failedCheckRepair;
    assertExactObject(repair, ['id', 'command', 'candidateTreeSha'], `${field}.failedCheckRepair`);
    assertNonEmptyString(repair.id, `${field}.failedCheckRepair.id`);
    assertNonEmptyString(repair.command, `${field}.failedCheckRepair.command`);
    assertGitSha(repair.candidateTreeSha, `${field}.failedCheckRepair.candidateTreeSha`);
  }
  if (hasOwn(value, 'activeAttempt')) {
    const attempt = validateActiveAttempt(value.activeAttempt);
    if (attempt.runId !== value.runId) throw new Error(`${field}.activeAttempt run identity is invalid`);
  }
  if (hasOwn(value, 'checkedChangeSha256')) assertSha256(value.checkedChangeSha256, `${field}.checkedChangeSha256`);
  if (hasOwn(value, 'proofId')) assertNonEmptyString(value.proofId, `${field}.proofId`);
  if (hasOwn(value, 'proofExecution')) validateProofExecution(value.proofExecution, `${field}.proofExecution`);
  const cleanupOutcome = (value.proofExecution as RunRecord['proofExecution'])?.cleanupOutcome;
  if (cleanupOutcome && (cleanupOutcome.receipt.proofId !== value.proofId || !hasOwn(value, 'candidateMaterialization'))) {
    throw new Error(`${field}.proofExecution cleanup identity is invalid`);
  }
  if (hasOwn(value, 'proofReceipt')) validateReceipt(value.proofReceipt, `${field}.proofReceipt`);
  if (hasOwn(value, 'androidProofPreparation')) {
    const prepared = value.androidProofPreparation;
    assertExactObject(prepared, ['status', 'checkedChangeSha256', 'runnerPreparedArtifactPaths', 'runnerPreparedArtifactSha256', 'runnerPreparationWarnings'], `${field}.androidProofPreparation`);
    if (!['pending', 'prepared', 'blocked'].includes(prepared.status as string)) throw new Error(`${field}.androidProofPreparation.status is invalid`);
    assertSha256(prepared.checkedChangeSha256, `${field}.androidProofPreparation.checkedChangeSha256`);
    for (const key of ['runnerPreparedArtifactPaths', 'runnerPreparationWarnings']) {
      if (!Array.isArray(prepared[key]) || prepared[key].some((entry: unknown) => typeof entry !== 'string')) throw new Error(`${field}.androidProofPreparation.${key} is invalid`);
    }
    const hashes = prepared.runnerPreparedArtifactSha256;
    if (typeof hashes !== 'object' || hashes === null || Array.isArray(hashes)) throw new Error(`${field}.androidProofPreparation.hashes is invalid`);
    for (const hash of Object.values(hashes)) assertSha256(hash, `${field}.androidProofPreparation.hash`);
  }
  if (hasOwn(value, 'codexSession')) {
    assertExactObject(value.codexSession, ['id', 'startedAt'], `${field}.codexSession`);
    if (typeof value.codexSession.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value.codexSession.id)) throw new Error(`${field}.codexSession.id is invalid`);
    assertTimestamp(value.codexSession.startedAt, `${field}.codexSession.startedAt`);
  }
  if (hasOwn(value, 'implementationResult')) validateImplementationResult(value.implementationResult, `${field}.implementationResult`);
  if (hasOwn(value, 'implementationReportCorrection')) validateReportCorrection(value.implementationReportCorrection, `${field}.implementationReportCorrection`);
  if (hasOwn(value, 'terminalNotifications')) validateTerminalNotifications(value.terminalNotifications, `${field}.terminalNotifications`);
  if (hasOwn(value, 'pendingEffect')) validatePendingEffect(value.pendingEffect, `${field}.pendingEffect`);
  if (hasOwn(value, 'outcomeEvidenceId')) assertNonEmptyString(value.outcomeEvidenceId, `${field}.outcomeEvidenceId`);
  if (hasOwn(value, 'terminalOutcome')) validateTerminalOutcome(value.terminalOutcome, `${field}.terminalOutcome`);
  if (hasOwn(value, 'directReview')) {
    if (!hasOwn(value, 'deliveryAuthority')) throw new Error(`${field}.directReview requires delivery authority`);
    validateDirectReview(value.directReview, {
      lifecycle: value.lifecycle as string,
      ...(hasOwn(value, 'terminalOutcome') ? { terminalOutcome: directTerminalOutcome(value.terminalOutcome as RunTerminalOutcome) } : {}),
      ...(hasOwn(value, 'terminalOutcome') && (value.terminalOutcome as RunTerminalOutcome).status === 'internal-error'
        ? { terminalCode: (value.terminalOutcome as Extract<RunTerminalOutcome, { status: 'internal-error' }>).code }
        : {}),
    });
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
  if (hasOwn(value, 'terminalNotifications')) {
    if (!terminal || value.lifecycle === 'transport-failed'
      || (value.terminalNotifications as TerminalNotificationStateV1).report.outcome !== value.lifecycle) {
      throw new Error(`${field} terminal notification outcome does not match lifecycle`);
    }
  }
  const terminalDeliveryEffect = value.pendingEffect as PendingEffect | undefined;
  if (terminalDeliveryEffect?.kind === 'terminal-comment' || terminalDeliveryEffect?.kind === 'terminal-labels') {
    if (!hasOwn(value, 'terminalNotifications')) throw new Error(`${field} terminal delivery effect requires notifications`);
    const notifications = value.terminalNotifications as TerminalNotificationStateV1;
    const delivery = terminalDeliveryEffect.kind === 'terminal-comment' ? notifications.comment : notifications.labels;
    if (terminalDeliveryEffect.issueNumber !== value.issueNumber
      || terminalDeliveryEffect.outcome !== notifications.report.outcome
      || delivery.status !== 'pending'
      || terminalDeliveryEffect.attempt !== delivery.attempts + 1) {
      throw new Error(`${field} terminal delivery effect does not match pending notification state`);
    }
  }
  if (value.lifecycle === 'proving' && (!hasOwn(value, 'checkedChangeSha256') || !hasOwn(value, 'proofId')
    || value.checks.some((check) => check.status === 'failed'))) {
    throw new Error(`${field} proving requires passed checks and checked change proof identity`);
  }
  if ((value.lifecycle === 'reviewing' || value.lifecycle === 'publishing') && !hasOwn(value, 'proofReceipt')) {
    throw new Error(`${field} review and publication require proofReceipt`);
  }
  if (value.lifecycle === 'safe-halt' && !hasOwn(value, 'activeAttempt')) throw new Error(`${field} safe-halt requires an active attempt`);
  const reviewReadyEffect = (value.pendingEffect as PendingEffect | undefined)?.kind;
  const reviewReadyEffectAllowed = reviewReadyEffect === undefined
    || ['review-activation-labels', 'continuation-worktree-create', 'outcome-evidence',
      'terminal-comment', 'terminal-labels', 'issue-feedback-comment'].includes(reviewReadyEffect);
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
  const settlingTerminalNotification = reviewReadyEffect === 'terminal-comment' || reviewReadyEffect === 'terminal-labels';
  if (terminal && hasOwn(value, 'pendingEffect') && value.lifecycle !== 'transport-failed'
    && !(value.lifecycle === 'review-ready' && reviewReadyEffectAllowed)
    && !retainedCandidateEffect && !settlingOutcomeEvidence && !settlingTerminalNotification) throw new Error(`${field} terminal lifecycle cannot retain pending effect`);
  if (value.lifecycle === 'transport-failed' && hasOwn(value, 'pendingEffect')
    && !settlingOutcomeEvidence
    && (value.terminalOutcome as Extract<RunTerminalOutcome, { status: 'transport-failed' }>).resumable) {
    throw new Error(`${field} resumable transport failure cannot retain pending effect`);
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

function validateChecks(value: unknown, field: string): asserts value is RunRecord['checks'] {
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
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
    if (!Array.isArray(value.comments)) throw new Error(`${field}.comments is invalid`);
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
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} is invalid`);
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
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
  for (const item of value) assertNonEmptyString(item, field);
}

function validatePendingEffect(value: unknown, field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} is invalid`);
  const kind = (value as { kind?: unknown }).kind;
  const identity = ['effectId', 'kind'];
  if (kind === 'claim-labels') {
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
  } else if (kind === 'claim-comment') {
    assertExactObject(value, [...identity, 'issueNumber', 'marker', 'bodySha256'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertNonEmptyString(value.marker, `${field}.marker`);
    assertSha256(value.bodySha256, `${field}.bodySha256`);
  } else if (kind === 'issue-feedback-comment') {
    assertExactObject(value, [...identity, 'issueNumber', 'batchId', 'batch', 'marker', 'body', 'bodySha256'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertSha256(value.batchId, `${field}.batchId`);
    validateFrozenReviewFeedbackBatch(value.batch);
    assertNonEmptyString(value.marker, `${field}.marker`);
    assertNonEmptyString(value.body, `${field}.body`);
    assertSha256(value.bodySha256, `${field}.bodySha256`);
    if (value.batch.batchId !== value.batchId || !value.body.startsWith(`${value.marker}\n`)
      || sha256(value.body) !== value.bodySha256) throw new Error(`${field} feedback comment binding is invalid`);
  } else if (kind === 'terminal-comment') {
    assertExactObject(value, [...identity, 'issueNumber', 'marker', 'bodySha256', 'outcome', 'attempt'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    assertNonEmptyString(value.marker, `${field}.marker`);
    assertSha256(value.bodySha256, `${field}.bodySha256`);
    assertTerminalNotificationOutcome(value.outcome, `${field}.outcome`);
    assertPositiveInteger(value.attempt, `${field}.attempt`);
  } else if (kind === 'terminal-labels') {
    assertExactObject(value, [...identity, 'issueNumber', 'add', 'remove', 'outcome', 'attempt'], field);
    assertPositiveInteger(value.issueNumber, `${field}.issueNumber`);
    validateStringArray(value.add, `${field}.add`);
    validateStringArray(value.remove, `${field}.remove`);
    assertTerminalNotificationOutcome(value.outcome, `${field}.outcome`);
    assertPositiveInteger(value.attempt, `${field}.attempt`);
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
    assertExactObject(value, [...identity, 'path', 'runId', 'code', 'summary', 'recordedAt', 'bytesSha256',
      ...(hasOwn(value, 'authorizationGrantId') ? ['authorizationGrantId'] : [])], field);
    assertNonEmptyString(value.path, `${field}.path`);
    if (typeof value.runId !== 'string' || !UUID_V4_PATTERN.test(value.runId)) throw new Error(`${field}.runId is invalid`);
    assertNonEmptyString(value.code, `${field}.code`);
    assertNonEmptyString(value.summary, `${field}.summary`);
    assertTimestamp(value.recordedAt, `${field}.recordedAt`);
    assertSha256(value.bytesSha256, `${field}.bytesSha256`);
    if (hasOwn(value, 'authorizationGrantId') && (typeof value.authorizationGrantId !== 'string'
      || !/^[1-9][0-9]*$/u.test(value.authorizationGrantId))) throw new Error(`${field}.authorizationGrantId is invalid`);
  } else {
    throw new Error(`${field}.kind is invalid`);
  }
  assertSha256(value.effectId, `${field}.effectId`);
  const { effectId, ...payload } = value;
  if (effectId !== sha256(canonicalJson(payload))) throw new Error(`${field}.effectId does not match its payload`);
}

function validateImplementationResult(value: unknown, field: string): void {
  assertExactObject(value, ['summary', 'residualRisks', ...['checks', 'proof', 'review'].filter(key => hasOwn(value, key))], field);
  if (hasOwn(value, 'checks')) validateImplementationChecks(value.checks);
  if (hasOwn(value, 'proof')) validateProofReport(value.proof, (value.checks as ImplementationCheck[] | undefined)?.map(check => check.id) ?? []);
  if (hasOwn(value, 'review')) validateImplementationReview(value.review);
  assertNonEmptyString(value.summary, `${field}.summary`);
  validateStringList(value.residualRisks, `${field}.residualRisks`);
}

function validateTerminalNotifications(value: unknown, field: string): void {
  assertExactObject(value, ['version', 'commentCutoff', 'report', 'comment', 'labels'], field);
  if (value.version !== 1) throw new Error(`${field}.version is invalid`);
  assertExactObject(value.commentCutoff, ['commentId', 'observedAt'], `${field}.commentCutoff`);
  if (value.commentCutoff.commentId !== null) assertNonEmptyString(value.commentCutoff.commentId, `${field}.commentCutoff.commentId`);
  assertTimestamp(value.commentCutoff.observedAt, `${field}.commentCutoff.observedAt`);
  validateTerminalReport(value.report, `${field}.report`);
  validateTerminalDelivery(value.comment, `${field}.comment`);
  validateTerminalDelivery(value.labels, `${field}.labels`);
}

function validateTerminalReport(value: unknown, field: string): void {
  const pullRequestUrl = hasOwn(value, 'pullRequestUrl') ? ['pullRequestUrl'] : [];
  const retainedWork = hasOwn(value, 'retainedWork') ? ['retainedWork'] : [];
  const blocker = hasOwn(value, 'blocker') ? ['blocker'] : [];
  assertExactObject(value, [
    'version', 'outcome', 'summary', ...pullRequestUrl, 'passedChecks', 'publishableProof', 'unverified',
    'risks', 'reviewFocus', 'nextAction', ...blocker, ...retainedWork,
  ], field);
  if (value.version !== 1) throw new Error(`${field}.version is invalid`);
  assertTerminalNotificationOutcome(value.outcome, `${field}.outcome`);
  assertNonEmptyString(value.summary, `${field}.summary`);
  if (hasOwn(value, 'pullRequestUrl')) assertNonEmptyString(value.pullRequestUrl, `${field}.pullRequestUrl`);
  for (const key of ['passedChecks', 'publishableProof', 'unverified', 'risks', 'reviewFocus'] as const) {
    validateStringList(value[key], `${field}.${key}`);
  }
  if (hasOwn(value, 'retainedWork')) validateStringList(value.retainedWork, `${field}.retainedWork`);
  assertNonEmptyString(value.nextAction, `${field}.nextAction`);
  if (hasOwn(value, 'blocker')) {
    assertExactObject(value.blocker, ['kind', 'resumable', 'attempted'], `${field}.blocker`);
    assertNonEmptyString(value.blocker.kind, `${field}.blocker.kind`);
    if (typeof value.blocker.resumable !== 'boolean') throw new Error(`${field}.blocker.resumable is invalid`);
    validateStringList(value.blocker.attempted, `${field}.blocker.attempted`);
  }
}

function validateTerminalDelivery(value: unknown, field: string): void {
  const diagnostic = hasOwn(value, 'diagnostic') ? ['diagnostic'] : [];
  assertExactObject(value, ['status', 'attempts', ...diagnostic], field);
  if (!['pending', 'delivered', 'exhausted'].includes(value.status as string)) throw new Error(`${field}.status is invalid`);
  if (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0) {
    throw new Error(`${field}.attempts is invalid`);
  }
  if (hasOwn(value, 'diagnostic')) assertNonEmptyString(value.diagnostic, `${field}.diagnostic`);
  if (value.status === 'delivered' && hasOwn(value, 'diagnostic')) throw new Error(`${field}.diagnostic is invalid`);
}

function assertTerminalNotificationOutcome(value: unknown, field: string): void {
  if (!['review-ready', 'blocked', 'internal-error', 'cancelled'].includes(value as string)) {
    throw new Error(`${field} is invalid`);
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
    assertExactObject(value, ['status', 'kind', 'resumable', 'evidencePath', ...(hasOwn(value, 'blocker') ? ['blocker'] : [])], field);
    if (!['external', 'safety', 'decision-delta', 'out-of-scope', 'authority-boundary'].includes(value.kind as string)) throw new Error(`${field}.kind is invalid`);
    if (typeof value.resumable !== 'boolean') throw new Error(`${field}.resumable is invalid`);
    if (hasOwn(value, 'blocker')) validateBlockerDetail(value.blocker, `${field}.blocker`);
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

function validateBlockerDetail(value: unknown, field: string): void {
  assertExactObject(value, ['kind', 'summary', 'attempted', 'resumable', ...(hasOwn(value, 'reviewerRejectionDetail') ? ['reviewerRejectionDetail'] : [])], field);
  assertNonEmptyString(value.kind, `${field}.kind`);
  assertNonEmptyString(value.summary, `${field}.summary`);
  if (!Array.isArray(value.attempted)) throw new Error(`${field}.attempted is invalid`);
  for (const attempted of value.attempted) assertNonEmptyString(attempted, `${field}.attempted`);
  if (typeof value.resumable !== 'boolean') throw new Error(`${field}.resumable is invalid`);
  if (hasOwn(value, 'reviewerRejectionDetail')) assertNonEmptyString(value.reviewerRejectionDetail, `${field}.reviewerRejectionDetail`);
}

function validateReceipt(value: unknown, field: string): void {
  assertExactObject(value, ['proofId', 'bindingSha256', 'summary', 'publishableEvidence', 'localEvidenceId'], field);
  assertNonEmptyString(value.proofId, `${field}.proofId`);
  assertSha256(value.bindingSha256, `${field}.bindingSha256`);
  assertNonEmptyString(value.summary, `${field}.summary`);
  assertNonEmptyString(value.localEvidenceId, `${field}.localEvidenceId`);
  if (!Array.isArray(value.publishableEvidence)) throw new Error(`${field}.publishableEvidence is invalid`);
  for (const evidence of value.publishableEvidence) {
    assertExactObject(evidence, ['ref', 'kind', 'sha256', 'description'], `${field}.publishableEvidence`);
    assertNonEmptyString(evidence.ref, `${field}.publishableEvidence.ref`);
    if (evidence.kind !== 'screenshot' && evidence.kind !== 'summary') throw new Error(`${field}.publishableEvidence.kind is invalid`);
    assertSha256(evidence.sha256, `${field}.publishableEvidence.sha256`);
    assertNonEmptyString(evidence.description, `${field}.publishableEvidence.description`);
  }
}

function validateProofExecution(value: unknown, field: string): void {
  assertExactObject(value, ['startedAt', 'transportRetryCount', 'reportRepairCount', 'reportRepairFindings', ...(hasOwn(value, 'cleanupOutcome') ? ['cleanupOutcome'] : []), ...(hasOwn(value, 'reportCorrection') ? ['reportCorrection'] : [])], field);
  assertTimestamp(value.startedAt, `${field}.startedAt`);
  if (!Number.isSafeInteger(value.transportRetryCount) || (value.transportRetryCount as number) < 0) throw new Error(`${field}.transportRetryCount is invalid`);
  if (!Number.isSafeInteger(value.reportRepairCount) || (value.reportRepairCount as number) < 0) throw new Error(`${field}.reportRepairCount is invalid`);
  validateStringList(value.reportRepairFindings, `${field}.reportRepairFindings`);
  if ((value.reportRepairCount === 0) !== (value.reportRepairFindings.length === 0)) {
    throw new Error(`${field} report repair state is invalid`);
  }
  if (hasOwn(value, 'reportCorrection')) validateReportCorrection(value.reportCorrection, `${field}.reportCorrection`);
  if (hasOwn(value, 'cleanupOutcome')) {
    const outcome = value.cleanupOutcome;
    if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) throw new Error(`${field}.cleanupOutcome is invalid`);
    const status = (outcome as { status?: unknown }).status;
    if (!['passed', 'needs-rework', 'external-block', 'transport-failed', 'cancelled', 'internal-error'].includes(String(status))) {
      throw new Error(`${field}.cleanupOutcome.status is invalid`);
    }
    const extras = status === 'needs-rework' ? ['findings'] : status === 'external-block' ? ['blocker'] : status === 'transport-failed' ? ['resumable'] : [];
    assertExactObject(outcome, ['status', 'receipt', ...extras], `${field}.cleanupOutcome`);
    validateReceipt(outcome.receipt, `${field}.cleanupOutcome.receipt`);
    if (status === 'needs-rework') validateStringList(outcome.findings, `${field}.cleanupOutcome.findings`);
    if (status === 'external-block') validateBlockerDetail(outcome.blocker, `${field}.cleanupOutcome.blocker`);
    if (status === 'transport-failed' && outcome.resumable !== false) throw new Error(`${field}.cleanupOutcome.resumable is invalid`);
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
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
  for (const item of value) assertNonEmptyString(item, field);
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || value.some((item, index) => item !== sorted[index])) throw new Error(`${field} must be sorted and unique`);
}

function emptyRunState(): RunStateFile {
  return { schema: 'codex-orchestrator.run-state', generation: 0, runs: [] };
}

function unsupportedStateReason(bytes: Buffer): string {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return 'Run state contains malformed JSON; preserve the file and repair it or archive it before starting a new journal.'; }
  if (hasOwn(value, 'schema') && (value as Record<string, unknown>).schema === 'codex-orchestrator.agent-auto-state') {
    return 'Legacy run records are incompatible with the current execution contract. The old envelope is accepted only with fully valid current records; migrate the records or archive the journal before starting a new one.';
  }
  return 'Run state has an unknown format or invalid records. Inspect the journal; required lifecycle, authority, process, and publication fields cannot be ignored. Repair it or archive it before starting a new one.';
}

async function readOptionalStateFile(path: string, maxBytes?: number): Promise<Buffer | undefined> {
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
    if (maxBytes !== undefined && stat.size > maxBytes) throw new Error(`${path} exceeds maximum size`);
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
  const retainedQuiescentHistory = !batch && (
    ['review-ready', 'blocked', 'cancelled', 'internal-error'].includes(run.lifecycle)
    || run.pendingEffect?.kind === 'outcome-evidence'
  );
  if (!batch && run.lifecycle !== 'review-ready' && !retainedQuiescentHistory) {
    throw new Error(`${field}.reviewFeedback quiescent data requires review-ready lifecycle`);
  }
  if (batch && !feedback.verifiedReceipt
    && !['implementing', 'checking', 'proving', 'reviewing', 'safe-halt'].includes(run.lifecycle)) {
    throw new Error(`${field}.reviewFeedback active batch has invalid lifecycle`);
  }
  if (feedback.verifiedReceipt) {
    if (run.lifecycle !== 'reviewing' && run.lifecycle !== 'publishing') {
      throw new Error(`${field}.reviewFeedback verified batch requires review or publication lifecycle`);
    }
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
    'claimed', 'implementing', 'checking', 'proving', 'reviewing', 'publishing', 'safe-halt',
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


interface RunHistoryRef { sha256: string; bytes: number; chunks: string[] }
interface ArchivedRunState {
  schema: 'codex-orchestrator.run-state-evidence';
  generation: number;
  runs: Array<{ current: Record<string, unknown>; history: Record<string, RunHistoryRef> }>;
}
type StoredRunState = RunStateFile | ArchivedRunState;
const HISTORY_CHUNK_BYTES = 128 * 1024;

function validateStoredRunState(value: unknown): StoredRunState {
  if (!hasOwn(value, 'schema') || (value as Record<string, unknown>).schema !== 'codex-orchestrator.run-state-evidence') return validateRunStateFile(value);
  assertExactObject(value, ['schema', 'generation', 'runs'], 'archived run state');
  assertPositiveInteger(value.generation, 'archived run generation');
  if (!Array.isArray(value.runs)) throw new Error('archived runs are invalid');
  for (const run of value.runs) {
    assertExactObject(run, ['current', 'history'], 'archived run');
    if (typeof run.current !== 'object' || run.current === null || Array.isArray(run.current)
      || typeof run.history !== 'object' || run.history === null || Array.isArray(run.history)) throw new Error('archived run fields are invalid');
    for (const [path, ref] of Object.entries(run.history)) {
      if (!path || path.split('.').some((part) => !/^[a-zA-Z][a-zA-Z0-9]*$/u.test(part))) throw new Error('run evidence field path is invalid');
      assertExactObject(ref, ['sha256', 'bytes', 'chunks'], 'run evidence reference');
      assertSha256(ref.sha256, 'run evidence hash');
      assertPositiveInteger(ref.bytes, 'run evidence byte count');
      if (!Array.isArray(ref.chunks) || ref.chunks.length === 0) throw new Error('run evidence chunks are invalid');
      ref.chunks.forEach((hash) => assertSha256(hash, 'run evidence chunk hash'));
      if (ref.chunks.length !== Math.ceil((ref.bytes as number) / HISTORY_CHUNK_BYTES)) throw new Error('run evidence chunk count is invalid');
    }
  }
  return value as unknown as ArchivedRunState;
}

async function hydrateStoredRunState(state: StoredRunState, directory: string): Promise<RunStateFile> {
  if (state.schema === 'codex-orchestrator.run-state') return state;
  const runs: unknown[] = [];
  for (const archived of state.runs) {
    const current = structuredClone(archived.current);
    for (const [path, ref] of Object.entries(archived.history)) {
      const parts: Buffer[] = [];
      for (const hash of ref.chunks) {
        const bytes = await readOptionalStateFile(join(directory, 'evidence', `${hash}.json`), HISTORY_CHUNK_BYTES);
        if (!bytes || sha256(bytes) !== hash) throw new Error('run evidence chunk missing or hash mismatch');
        parts.push(bytes);
      }
      const bytes = Buffer.concat(parts);
      if (bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256) throw new Error('run evidence content hash mismatch');
      let parent = current;
      const segments = path.split('.');
      const last = segments.pop()!;
      for (const segment of segments) {
        const child = parent[segment];
        if (typeof child !== 'object' || child === null || Array.isArray(child)) throw new Error('run evidence parent is invalid');
        parent = child as Record<string, unknown>;
      }
      if (hasOwn(parent, last)) throw new Error('run evidence overlaps inline field');
      parent[last] = JSON.parse(bytes.toString('utf8'));
    }
    runs.push(current);
  }
  return validateRunStateFile({ schema: 'codex-orchestrator.run-state', generation: state.generation, runs });
}

async function archiveRunHistory(state: RunStateFile, directory: string, maxBytes: number): Promise<StoredRunState> {
  if (Buffer.byteLength(canonicalJson(state)) + 1 <= maxBytes) return state;
  const result: ArchivedRunState = { schema: 'codex-orchestrator.run-state-evidence', generation: state.generation, runs: [] };
  for (const run of state.runs) {
    const current = structuredClone(run) as unknown as Record<string, unknown>;
    const history: Record<string, RunHistoryRef> = {};
    async function visit(object: Record<string, unknown>, prefix: string): Promise<void> {
      for (const [key, value] of Object.entries(object)) {
        const path = prefix ? `${prefix}.${key}` : key;
        // Immutable snapshots and histories can be rehydrated exactly. Execution and
        // authority receipts remain in the state file so recovery stays inspectable.
        if ((Array.isArray(value) || typeof value === 'string') && Buffer.byteLength(canonicalJson(value)) > 64 * 1024) {
          const bytes = Buffer.from(canonicalJson(value));
          const chunks: string[] = [];
          for (let offset = 0; offset < bytes.length; offset += HISTORY_CHUNK_BYTES) {
            const part = bytes.subarray(offset, offset + HISTORY_CHUNK_BYTES);
            const hash = sha256(part);
            await writeImmutableRunEvidence(directory, hash, part);
            chunks.push(hash);
          }
          history[path] = { sha256: sha256(bytes), bytes: bytes.length, chunks };
          delete object[key];
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          await visit(value as Record<string, unknown>, path);
        }
      }
    }
    await visit(current, '');
    result.runs.push({ current, history });
  }
  validateStoredRunState(result);
  if (Buffer.byteLength(canonicalJson(result)) + 1 > maxBytes) throw new Error('current run receipts exceed maximum state size');
  return result;
}

async function writeImmutableRunEvidence(directory: string, hash: string, bytes: Buffer): Promise<void> {
  // AtomicStateFile already rejects symlinked ancestors; apply the same rule
  // before writing evidence, which is published before its reference.
  let parent = dirname(join(directory, 'evidence'));
  const missing: string[] = [];
  while (true) {
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('run evidence directory is unsafe');
      break;
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      missing.push(parent);
      parent = dirname(parent);
    }
  }
  for (const path of missing.reverse()) await mkdir(path, { mode: 0o700 });
  const evidenceDirectory = join(directory, 'evidence');
  await mkdir(evidenceDirectory, { mode: 0o700 }).catch((error: unknown) => { if (!isErrorCode(error, 'EEXIST')) throw error; });
  const stat = await lstat(evidenceDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('run evidence directory is unsafe');
  const path = join(evidenceDirectory, `${hash}.json`);
  const existing = await readOptionalStateFile(path, HISTORY_CHUNK_BYTES);
  if (existing) {
    if (!existing.equals(bytes)) throw new Error('run evidence immutable content diverged');
    return;
  }
  const temporary = join(evidenceDirectory, `${hash}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Publish immutable bytes without overwriting a concurrent writer. A crash
    // before this link leaves only an unreferenced temporary file.
    try { await link(temporary, path); }
    catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
      const observed = await readOptionalStateFile(path, HISTORY_CHUNK_BYTES);
      if (!observed?.equals(bytes)) throw new Error('run evidence immutable content diverged');
    }
    const folder = await open(evidenceDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await folder.sync(); } finally { await folder.close(); }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: unknown) => { if (!isErrorCode(error, 'ENOENT')) throw error; });
  }
}


function validateReportCorrection(value: unknown, field: string): void {
  assertExactObject(value, ['path', 'sha256', 'diagnostic'], field);
  assertNonEmptyString(value.path, `${field}.path`);
  if (!posix.isAbsolute(value.path) || posix.normalize(value.path) !== value.path) throw new Error(`${field}.path is invalid`);
  assertSha256(value.sha256, `${field}.sha256`);
  assertNonEmptyString(value.diagnostic, `${field}.diagnostic`);
}
