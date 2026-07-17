import type { ProofReceipt } from './proof-report.js';
import { validateDirectReview, type DirectReviewStage, type DirectReviewV1 } from './direct-delivery.js';
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
import { AtomicStateFile, type AtomicStateFileOptions } from './atomic-store.js';

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
  | 'safe-halt'
  | 'review-ready'
  | 'blocked'
  | 'transport-failed'
  | 'cancelled'
  | 'internal-error';

export type PublicationIntent =
  | { kind: 'claim-labels'; issueNumber: number; expected: string[] }
  | { kind: 'commit'; parentSha: string; treeSha: string; message: string }
  | { kind: 'push'; branch: string; sha: string }
  | { kind: 'pr'; owner: string; repo: string; head: string; base: string; issueNumber: number; marker: string }
  | { kind: 'comment'; issueNumber: number; marker: string; bodySha256: string }
  | { kind: 'labels'; issueNumber: number; expected: string[] };

export type RunTerminalOutcome =
  | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string }
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
  comments?: Array<{ body: string; authorAssociation: string }>;
}

export interface PersistedFrozenCriterionV1 {
  id: string;
  order: number;
  text: string;
  source: 'explicit' | 'fallback';
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
  transportRetries: 0 | 1;
  issueSnapshot: PersistedIssueSnapshotV1;
  frozenCriteria: PersistedFrozenCriterionV1[];
  reworkFindings: string[];
  packageVersion: string;
  workflowGeneration: WorkflowGenerationReceipt;
  routeExecution?: RouteExecutionV1;
  routeReceipt?: RouteReceiptV1;
  waitingHuman?: WaitingHumanExecutionV1;
  directReview?: DirectReviewV1;
  skillHashes: Record<string, string>;
  process?: {
    pid: number;
    processGroupId: number;
    startedAt: string;
    baseline: {
      headSha: string;
      indexTreeSha: string;
      trackedContentSha256: string;
      untrackedContentSha256: string;
      worktreeIdentity: string;
    };
    purpose?: 'route' | 'implementation' | 'cleanup-review' | 'code-review' | 'proof';
    resumeLifecycle?: Lifecycle;
    resumeReviewStage?: DirectReviewStage | null;
  };
  checks: Array<{ id: string; command: string; status: 'passed' | 'failed'; outputSha256: string }>;
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
  version: 1;
  generation: number;
  runs: RunRecordV1[];
}

export type RunStateBodyV1 = Omit<RunStateFileV1, 'generation'>;

export interface RunRecordWriter {
  read(): Promise<RunStateFileV1>;
  compareAndSwap(expectedGeneration: number, next: RunStateBodyV1): Promise<RunStateFileV1>;
}

export class WorkflowGenerationUnrecoverableError extends Error {
  constructor() {
    super('workflow-generation-unrecoverable');
    this.name = 'WorkflowGenerationUnrecoverableError';
  }
}

export class RouteMigrationUnrecoverableError extends Error {
  constructor() {
    super('route-migration-unrecoverable');
    this.name = 'RouteMigrationUnrecoverableError';
  }
}

export class FileRunRecordWriter implements RunRecordWriter {
  private readonly file: AtomicStateFile<RunStateFileV1>;

  constructor(path: string, options: AtomicStateFileOptions = {}) {
    this.file = new AtomicStateFile(path, validateRunStateFile, options);
  }

  async read(): Promise<RunStateFileV1> {
    return await this.file.read() ?? emptyRunState();
  }

  async compareAndSwap(expectedGeneration: number, next: RunStateBodyV1): Promise<RunStateFileV1> {
    validateRunStateBody(next);
    return this.file.compareAndSwap(expectedGeneration, { ...structuredClone(next), generation: expectedGeneration + 1 });
  }
}

export class InMemoryRunRecordWriter implements RunRecordWriter {
  private state = emptyRunState();

  async read(): Promise<RunStateFileV1> {
    return structuredClone(this.state);
  }

  async compareAndSwap(expectedGeneration: number, next: RunStateBodyV1): Promise<RunStateFileV1> {
    if (this.state.generation !== expectedGeneration) throw new Error('run state generation conflict');
    const value = validateRunStateFile({ ...structuredClone(next), generation: expectedGeneration + 1 });
    this.state = value;
    return structuredClone(value);
  }
}

export function validateRunStateFile(value: unknown): RunStateFileV1 {
  assertExactObject(value, ['schema', 'version', 'generation', 'runs'], 'run state');
  if (value.schema !== 'codex-orchestrator.agent-auto-state' || value.version !== 1) throw new Error('run state schema/version is invalid');
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) throw new Error('run state generation is invalid');
  validateRuns(value.runs);
  return value as unknown as RunStateFileV1;
}

function validateRunStateBody(value: unknown): asserts value is RunStateBodyV1 {
  assertExactObject(value, ['schema', 'version', 'runs'], 'run state body');
  if (value.schema !== 'codex-orchestrator.agent-auto-state' || value.version !== 1) throw new Error('run state schema/version is invalid');
  validateRuns(value.runs);
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
    'process',
    'checkedChangeSha256',
    'proofId',
    'proofReceipt',
    'intent',
    'outcomeEvidenceId',
    'terminalOutcome',
    'workflowGeneration',
    'routeExecution',
    'routeReceipt',
    'waitingHuman',
    'directReview',
  ].filter((key) => hasOwn(value, key));
  assertExactObject(value, [
    'runId', 'issueNumber', 'canonicalRepository', 'baseSha', 'branchName', 'worktreePath', 'lifecycle', 'cycle',
    'reportRepairs', 'transportRetries', 'issueSnapshot', 'frozenCriteria', 'reworkFindings',
    'packageVersion', 'skillHashes', 'checks', 'createdAt', 'updatedAt', ...optional,
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
  if (hasOwn(value, 'workflowGeneration')) {
    const workflowGeneration = value.workflowGeneration;
    validateWorkflowGeneration(workflowGeneration, `${field}.workflowGeneration`);
    if (workflowGeneration.packageVersion !== value.packageVersion) {
      throw new Error(`${field}.workflowGeneration package version mismatch`);
    }
  }
  const routeGenerationHash = hasOwn(value, 'workflowGeneration')
    ? (value.workflowGeneration as unknown as WorkflowGenerationReceipt).generationHash
    : undefined;
  if (hasOwn(value, 'routeExecution')) validateRouteExecution(value.routeExecution, routeGenerationHash);
  if (hasOwn(value, 'routeReceipt')) validateRouteReceipt(value.routeReceipt, routeGenerationHash);
  validateStringShaRecord(value.skillHashes, `${field}.skillHashes`);
  validateChecks(value.checks, `${field}.checks`);
  if (hasOwn(value, 'process')) validateProcess(value.process, `${field}.process`);
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
    const process = hasOwn(value, 'process') && hasOwn(value.process, 'purpose')
      ? value.process as RunRecordV1['process'] & Required<Pick<NonNullable<RunRecordV1['process']>, 'purpose' | 'resumeLifecycle' | 'resumeReviewStage'>>
      : undefined;
    validateDirectReview(value.directReview, {
      lifecycle: value.lifecycle as string,
      ...(hasOwn(value, 'terminalOutcome') ? { terminalOutcome: directTerminalOutcome(value.terminalOutcome as RunTerminalOutcome) } : {}),
      ...(process ? { process: {
        purpose: process.purpose,
        resumeLifecycle: process.resumeLifecycle,
        resumeReviewStage: process.resumeReviewStage,
      } } : {}),
    });
  }
  assertTimestamp(value.createdAt, `${field}.createdAt`);
  assertTimestamp(value.updatedAt, `${field}.updatedAt`);

  const terminal = ['review-ready', 'blocked', 'transport-failed', 'cancelled', 'internal-error'].includes(value.lifecycle);
  if (!terminal && !hasOwn(value, 'workflowGeneration')) throw new WorkflowGenerationUnrecoverableError();
  if (terminal !== hasOwn(value, 'terminalOutcome')) throw new Error(`${field} terminal lifecycle requires terminalOutcome`);
  if (terminal && (value.terminalOutcome as RunTerminalOutcome).status !== value.lifecycle) throw new Error(`${field} terminalOutcome does not match lifecycle`);
  if (value.lifecycle === 'proving' && (!hasOwn(value, 'checkedChangeSha256') || !hasOwn(value, 'proofId') || value.checks.some((check) => check.status !== 'passed'))) {
    throw new Error(`${field} proving requires passed checks and checked change proof identity`);
  }
  if (value.lifecycle === 'publishing' && !hasOwn(value, 'proofReceipt')) throw new Error(`${field} publishing requires proofReceipt`);
  if (value.lifecycle === 'safe-halt' && !hasOwn(value, 'process')) throw new Error(`${field} safe-halt requires retained process evidence`);
  if (value.lifecycle === 'review-ready' && (!hasOwn(value, 'proofReceipt') || hasOwn(value, 'intent'))) {
    throw new Error(`${field} review-ready requires proofReceipt and no intent`);
  }
  if (terminal && hasOwn(value, 'process')) throw new Error(`${field} terminal lifecycle cannot retain process ownership`);
  if (terminal && hasOwn(value, 'intent') && value.lifecycle !== 'transport-failed') throw new Error(`${field} terminal lifecycle cannot retain intent`);
  if (value.lifecycle === 'transport-failed' && hasOwn(value, 'intent')
    && (value.terminalOutcome as Extract<RunTerminalOutcome, { status: 'transport-failed' }>).resumable) {
    throw new Error(`${field} resumable transport failure cannot retain intent`);
  }
  if (value.lifecycle === 'waiting-human' && !hasOwn(value, 'waitingHuman')) throw new Error(`${field} waiting-human lifecycle requires waitingHuman execution`);
  if (hasOwn(value, 'routeExecution') || hasOwn(value, 'routeReceipt') || value.lifecycle === 'triaging' || value.lifecycle === 'routed') {
    if (!routeGenerationHash) throw new WorkflowGenerationUnrecoverableError();
    validateRouteStateInvariant({
      lifecycle: value.lifecycle,
      routeExecution: value.routeExecution,
      routeReceipt: value.routeReceipt,
      generationHash: routeGenerationHash,
    });
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

function validateProcess(value: unknown, field: string): void {
  const extended = hasOwn(value, 'purpose') || hasOwn(value, 'resumeLifecycle') || hasOwn(value, 'resumeReviewStage');
  assertExactObject(value, [
    'pid', 'processGroupId', 'startedAt', 'baseline',
    ...(extended ? ['purpose', 'resumeLifecycle', 'resumeReviewStage'] : []),
  ], field);
  assertPositiveInteger(value.pid, `${field}.pid`);
  assertPositiveInteger(value.processGroupId, `${field}.processGroupId`);
  assertTimestamp(value.startedAt, `${field}.startedAt`);
  assertExactObject(value.baseline, [
    'headSha', 'indexTreeSha', 'trackedContentSha256', 'untrackedContentSha256', 'worktreeIdentity',
  ], `${field}.baseline`);
  assertGitSha(value.baseline.headSha, `${field}.baseline.headSha`);
  assertGitSha(value.baseline.indexTreeSha, `${field}.baseline.indexTreeSha`);
  assertSha256(value.baseline.trackedContentSha256, `${field}.baseline.trackedContentSha256`);
  assertSha256(value.baseline.untrackedContentSha256, `${field}.baseline.untrackedContentSha256`);
  assertNonEmptyString(value.baseline.worktreeIdentity, `${field}.baseline.worktreeIdentity`);
  if (extended) {
    if (!['route', 'implementation', 'cleanup-review', 'code-review', 'proof'].includes(value.purpose as string)) {
      throw new Error(`${field}.purpose is invalid`);
    }
    if (!isLifecycle(value.resumeLifecycle)) throw new Error(`${field}.resumeLifecycle is invalid`);
    if (value.resumeReviewStage !== null && ![
      'cleanup-full', 'cleanup-repair', 'cleanup-closure', 'review-full', 'review-repair', 'review-closure',
    ].includes(value.resumeReviewStage as string)) throw new Error(`${field}.resumeReviewStage is invalid`);
  }
}

function validateChecks(value: unknown, field: string): asserts value is RunRecordV1['checks'] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${field} is invalid`);
  const ids = new Set<string>();
  for (const [index, check] of value.entries()) {
    assertExactObject(check, ['id', 'command', 'status', 'outputSha256'], `${field}[${index}]`);
    assertNonEmptyString(check.id, `${field}[${index}].id`);
    assertNonEmptyString(check.command, `${field}[${index}].command`);
    if (check.status !== 'passed' && check.status !== 'failed') throw new Error(`${field}[${index}].status is invalid`);
    assertSha256(check.outputSha256, `${field}[${index}].outputSha256`);
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
      assertExactObject(comment, ['body', 'authorAssociation'], `${field}.comments[${index}]`);
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
    assertExactObject(value, ['kind', 'parentSha', 'treeSha', 'message'], field);
    assertGitSha(value.parentSha, `${field}.parentSha`);
    assertGitSha(value.treeSha, `${field}.treeSha`);
    assertNonEmptyString(value.message, `${field}.message`);
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
  } else {
    throw new Error(`${field}.kind is invalid`);
  }
}

function validateTerminalOutcome(value: unknown, field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} is invalid`);
  const status = (value as { status?: unknown }).status;
  if (status === 'review-ready') {
    assertExactObject(value, ['status', 'pullRequestUrl', 'evidencePath'], field);
    assertNonEmptyString(value.pullRequestUrl, `${field}.pullRequestUrl`);
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
  return { schema: 'codex-orchestrator.agent-auto-state', version: 1, generation: 0, runs: [] };
}

function isLifecycle(value: unknown): value is Lifecycle {
  return typeof value === 'string' && [
    'claimed', 'triaging', 'routed', 'waiting-human', 'spec-authoring', 'implementing', 'reworking', 'checking', 'proving', 'publishing', 'safe-halt',
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

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${field} is invalid`);
}
