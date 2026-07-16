import { posix } from 'node:path';

import {
  checkedChangeFreshnessMatches,
  type CheckedChange,
  type CheckedChangeFreshness,
  type CheckedChangePayloadV1,
  type CheckedChangeReadCapability,
} from './checked-change.js';
import { canonicalJson, sha256 } from './containment.js';
import {
  createProofReceipt,
  validateProofReport,
  type ProofReceipt,
  type ProofReportV1,
} from './proof-report.js';
import type { ProofRecordWriter, ProofStateBodyV1, ProofStateV1, ProofStatus } from './proof-store.js';

export interface IssueSnapshot {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN';
  labels: string[];
}

export interface FrozenCriterion {
  id: string;
  order: number;
  source: 'explicit' | 'fallback';
  text: string;
}

export interface ExternalBlocker {
  kind: 'credential' | 'tool' | 'service' | 'product-decision';
  summary: string;
  attempted: string[];
}

export type ProofAgentResult =
  | { kind: 'report'; report: unknown; proofPhaseChangedFiles: string[] }
  | { kind: 'transport-failed'; resumable: boolean }
  | { kind: 'cancelled' }
  | { kind: 'internal-error' };

export interface ProofAgent {
  run(input: {
    proofId: string;
    runId: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChangeSha256: string;
    changedFiles: string[];
    checks: CheckedChangePayloadV1['checks'];
    repairOnly: boolean;
    repairFindings: string[];
    signal: AbortSignal;
  }): Promise<ProofAgentResult>;
}

export class ProofQuiescenceError extends Error {
  constructor(
    readonly pid: number,
    readonly processGroupId: number,
    readonly waitForAbsence: () => Promise<void>,
  ) {
    super('proof process quiescence is not yet confirmed');
  }
}

export type ProveChangeResult =
  | { status: 'passed'; receipt: ProofReceipt }
  | { status: 'needs-rework'; findings: string[]; receipt: ProofReceipt }
  | { status: 'external-block'; blocker: ExternalBlocker; receipt: ProofReceipt }
  | { status: 'transport-failed'; resumable: boolean; receipt: ProofReceipt }
  | { status: 'cancelled'; receipt: ProofReceipt }
  | { status: 'internal-error'; receipt: ProofReceipt };

export class AcceptanceProof {
  constructor(private readonly dependencies: {
    checkedChangeReader: CheckedChangeReadCapability;
    proofRecords: ProofRecordWriter;
    proofAgent: ProofAgent;
    inspectFreshness: (payload: CheckedChangePayloadV1) => Promise<CheckedChangeFreshness>;
    readArtifact: (relativePath: string) => Promise<Buffer>;
    proofArtifactDir: string;
    createAttemptId: () => string;
    now: () => string;
    signal?: AbortSignal;
  }) {
    assertRelativePath(dependencies.proofArtifactDir, 'proofArtifactDir');
  }

  async proveChange(input: {
    proofId: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChange: CheckedChange;
  }): Promise<ProveChangeResult> {
    let bindingSha256 = sha256(canonicalJson({ proofId: input.proofId, invalid: true }));
    try {
      assertNonEmptyString(input.proofId, 'proofId');
      validateIssue(input.issue);
      validateCriteria(input.frozenCriteria);
      const checked = this.dependencies.checkedChangeReader.verifyAndRead(input.checkedChange);
      if (checked.payload.issueNumber !== input.issue.number) throw new Error('CheckedChange issue does not match proof issue');
      bindingSha256 = createBindingSha256({
        proofId: input.proofId,
        issue: input.issue,
        frozenCriteria: input.frozenCriteria,
        payload: checked.payload,
        checkedChangeSha256: checked.checkedChangeSha256,
      });
      return await this.execute({ ...input, ...checked, bindingSha256 });
    } catch (error) {
      if (error instanceof ProofQuiescenceError) throw error;
      return { status: 'internal-error', receipt: emptyReceipt(input.proofId, bindingSha256, 'Acceptance proof failed internally.') };
    }
  }

  private async execute(input: {
    proofId: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChange: CheckedChange;
    payload: CheckedChangePayloadV1;
    checkedChangeSha256: string;
    bindingSha256: string;
  }): Promise<ProveChangeResult> {
    let state = await this.dependencies.proofRecords.read(input.proofId);
    if (state && state.bindingSha256 !== input.bindingSha256) {
      return { status: 'internal-error', receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof binding mismatch.') };
    }
    if (state?.status === 'passed' && state.receipt) {
      if (!await this.isFresh(input.payload)) {
        return { status: 'internal-error', receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Checked change is stale.') };
      }
      return { status: 'passed', receipt: state.receipt };
    }
    if (state && isTerminalStatus(state.status)) {
      return terminalStateFallback(state);
    }

    if (!state) {
      const attemptId = this.dependencies.createAttemptId();
      assertNonEmptyString(attemptId, 'attemptId');
      state = await this.dependencies.proofRecords.compareAndSwap(input.proofId, input.bindingSha256, 0, {
        schema: 'codex-orchestrator.acceptance-proof-state',
        version: 1,
        proofId: input.proofId,
        bindingSha256: input.bindingSha256,
        status: 'prepared',
        attempts: [{ attemptId, purpose: 'proof', status: 'prepared' }],
        updatedAt: this.timestamp(),
      });
    }

    if (!await this.isFresh(input.payload)) {
      return this.persistOperationalTerminal(state, 'internal-error', input, 'Checked change is stale.');
    }
    if (this.dependencies.signal?.aborted) {
      const outcome = await this.persistOperationalTerminal(state, 'cancelled', input, 'Proof was cancelled.');
      return { status: 'cancelled', receipt: outcome.receipt };
    }
    if (state.status === 'prepared') {
      const preparedState = state;
      state = await this.dependencies.proofRecords.compareAndSwap(
        input.proofId,
        input.bindingSha256,
        preparedState.generation,
        bodyFrom(preparedState, {
          status: 'running',
          attempts: preparedState.attempts.map((attempt, index) => index === preparedState.attempts.length - 1
            ? { ...attempt, status: 'running' as const }
            : attempt),
          updatedAt: this.timestamp(),
        }),
      );
    }

    let report: ProofReportV1;
    while (true) {
      const purpose = state.attempts.at(-1)!.purpose;
      let agentResult: ProofAgentResult;
      try {
        agentResult = await this.dependencies.proofAgent.run({
          proofId: input.proofId,
          runId: input.payload.runId,
          issue: structuredClone(input.issue),
          frozenCriteria: structuredClone(input.frozenCriteria),
          checkedChangeSha256: input.checkedChangeSha256,
          changedFiles: [...input.payload.changedFiles],
          checks: structuredClone(input.payload.checks),
          repairOnly: purpose === 'report-repair',
          repairFindings: purpose === 'report-repair' ? ['The previous Proof Report did not match the generated schema or evidence contract.'] : [],
          signal: this.dependencies.signal ?? new AbortController().signal,
        });
      } catch (error) {
        if (error instanceof ProofQuiescenceError) throw error;
        return this.persistOperationalTerminal(state, 'internal-error', input, 'Proof agent failed internally.');
      }

      if (this.dependencies.signal?.aborted) {
        const outcome = await this.persistOperationalTerminal(state, 'cancelled', input, 'Proof was cancelled.');
        return { status: 'cancelled', receipt: outcome.receipt };
      }
      if (agentResult.kind === 'transport-failed') {
        const alreadyRetried = state.attempts.some((attempt) => attempt.purpose === 'transport-retry');
        if (agentResult.resumable && !alreadyRetried && await this.isFresh(input.payload)) {
          state = await this.startProofRetry(state, input.bindingSha256, 'transport-retry');
          continue;
        }
        const outcome = await this.persistOperationalTerminal(state, 'transport-failed', input, 'Proof transport failed.');
        return { status: 'transport-failed', resumable: false, receipt: outcome.receipt };
      }
      if (agentResult.kind === 'cancelled') {
        const outcome = await this.persistOperationalTerminal(state, 'cancelled', input, 'Proof was cancelled.');
        return { status: 'cancelled', receipt: outcome.receipt };
      }
      if (agentResult.kind === 'internal-error') {
        return this.persistOperationalTerminal(state, 'internal-error', input, 'Proof agent failed internally.');
      }

      try {
        report = validateProofReport(agentResult.report);
        validateSpecOneReport(report, input.frozenCriteria);
        await this.validateArtifactsAndDiff(report, agentResult.proofPhaseChangedFiles);
        break;
      } catch {
        const alreadyRepaired = state.attempts.some((attempt) => attempt.purpose === 'report-repair');
        if (!alreadyRepaired && await this.isFresh(input.payload)) {
          state = await this.startProofRetry(state, input.bindingSha256, 'report-repair');
          continue;
        }
        return this.persistOperationalTerminal(state, 'internal-error', input, 'Proof report or artifacts are invalid.');
      }
    }
    if (!await this.isFresh(input.payload)) {
      return this.persistOperationalTerminal(state, 'internal-error', input, 'Checked change became stale during proof.');
    }

    const receipt = createProofReceipt({
      proofId: input.proofId,
      bindingSha256: input.bindingSha256,
      summary: report.status === 'passed'
        ? 'Acceptance proof passed.'
        : report.status === 'needs-rework'
          ? 'Acceptance proof needs rework.'
          : 'Acceptance proof is externally blocked.',
      localEvidenceId: `proof:${input.proofId}`,
      report,
    });
    const persisted = await this.persistTerminal(state, report.status, input.bindingSha256, receipt, sha256(canonicalJson(report)));
    if (report.status === 'passed') return { status: 'passed', receipt: persisted.receipt! };
    if (report.status === 'needs-rework') return { status: 'needs-rework', findings: [...report.findings], receipt: persisted.receipt! };
    return { status: 'external-block', blocker: structuredClone(report.blocker!), receipt: persisted.receipt! };
  }

  private async validateArtifactsAndDiff(report: ProofReportV1, changedFiles: string[]): Promise<void> {
    if (!Array.isArray(changedFiles) || changedFiles.length > 256) throw new Error('proof phase diff is invalid');
    const artifactPaths = new Set<string>();
    for (const artifact of report.artifacts) {
      if (!isInsideRelativeRoot(this.dependencies.proofArtifactDir, artifact.relativePath)) {
        throw new Error('proof artifact escapes proof-owned directory');
      }
      const bytes = await this.dependencies.readArtifact(artifact.relativePath);
      if (sha256(bytes) !== artifact.sha256) throw new Error('proof artifact hash mismatch');
      artifactPaths.add(artifact.relativePath);
    }
    for (const path of changedFiles) {
      assertRelativePath(path, 'proof phase changed file');
      if (!artifactPaths.has(path)) throw new Error('proof phase changed a non-artifact path');
    }
  }

  private async startProofRetry(
    state: ProofStateV1,
    bindingSha256: string,
    purpose: 'transport-retry' | 'report-repair',
  ): Promise<ProofStateV1> {
    const attemptId = this.dependencies.createAttemptId();
    assertNonEmptyString(attemptId, 'attemptId');
    return this.dependencies.proofRecords.compareAndSwap(
      state.proofId,
      bindingSha256,
      state.generation,
      bodyFrom(state, {
        status: 'running',
        attempts: [
          ...state.attempts.map((attempt, index) => index === state.attempts.length - 1
            ? { ...attempt, status: 'terminal' as const }
            : attempt),
          { attemptId, purpose, status: 'running' },
        ],
        updatedAt: this.timestamp(),
      }),
    );
  }

  private async isFresh(payload: CheckedChangePayloadV1): Promise<boolean> {
    return checkedChangeFreshnessMatches(payload, await this.dependencies.inspectFreshness(structuredClone(payload)));
  }

  private async persistOperationalTerminal(
    state: ProofStateV1,
    status: Extract<ProofStatus, 'transport-failed' | 'cancelled' | 'internal-error'>,
    input: { proofId: string; bindingSha256: string },
    summary: string,
  ): Promise<Extract<ProveChangeResult, { status: 'internal-error' }>> {
    const receipt = emptyReceipt(input.proofId, input.bindingSha256, summary);
    const persisted = await this.persistTerminal(state, status, input.bindingSha256, receipt);
    return { status: 'internal-error', receipt: persisted.receipt! };
  }

  private async persistTerminal(
    state: ProofStateV1,
    status: Extract<ProofStatus, 'passed' | 'needs-rework' | 'external-block' | 'transport-failed' | 'cancelled' | 'internal-error'>,
    bindingSha256: string,
    receipt: ProofReceipt,
    reportSha256?: string,
  ): Promise<ProofStateV1> {
    return this.dependencies.proofRecords.compareAndSwap(
      state.proofId,
      bindingSha256,
      state.generation,
      bodyFrom(state, {
        status,
        attempts: state.attempts.map((attempt, index) => index === state.attempts.length - 1
          ? { ...attempt, status: 'terminal' as const, ...(reportSha256 ? { reportSha256 } : {}) }
          : attempt),
        receipt,
        updatedAt: this.timestamp(),
      }),
    );
  }

  private timestamp(): string {
    const value = this.dependencies.now();
    if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('proof clock returned an invalid timestamp');
    return value;
  }
}

function createBindingSha256(input: {
  proofId: string;
  issue: IssueSnapshot;
  frozenCriteria: FrozenCriterion[];
  payload: CheckedChangePayloadV1;
  checkedChangeSha256: string;
}): string {
  return sha256(canonicalJson({
    proofId: input.proofId,
    canonicalRepository: input.payload.canonicalRepository,
    runId: input.payload.runId,
    issueNumber: input.payload.issueNumber,
    cycle: input.payload.cycle,
    frozenCriteriaSha256: sha256(canonicalJson(input.frozenCriteria)),
    issueSnapshotSha256: sha256(canonicalJson(input.issue)),
    checkedChangeSha256: input.checkedChangeSha256,
    packageVersion: input.payload.packageVersion,
    proofSchemaVersion: input.payload.proofSchemaVersion,
    checkPolicySha256: input.payload.checkPolicySha256,
  }));
}

function validateSpecOneReport(report: ProofReportV1, criteria: FrozenCriterion[]): void {
  if (report.decision.mode !== 'non-visual' || report.decision.targets.length !== 0) {
    throw new Error('Spec 1 accepts non-visual proof only');
  }
  const expectedIds = criteria.map((criterion) => criterion.id);
  const actualIds = report.criteria.map((criterion) => criterion.id);
  if (expectedIds.length !== actualIds.length || expectedIds.some((id, index) => id !== actualIds[index])) {
    throw new Error('proof report criterion coverage mismatch');
  }
  if (report.criteria.some((criterion) => criterion.surfaces.length !== 1 || criterion.surfaces[0] !== 'non-visual')) {
    throw new Error('Spec 1 criterion surfaces must be non-visual');
  }
}

function validateIssue(value: unknown): asserts value is IssueSnapshot {
  assertExactObject(value, ['number', 'title', 'body', 'url', 'state', 'labels'], 'issue snapshot');
  if (!Number.isSafeInteger(value.number) || (value.number as number) <= 0) throw new Error('issue number is invalid');
  for (const field of ['title', 'body', 'url'] as const) assertNonEmptyString(value[field], `issue.${field}`);
  if (value.state !== 'OPEN') throw new Error('issue must be OPEN');
  if (!Array.isArray(value.labels) || value.labels.some((label) => typeof label !== 'string' || label.length === 0)) {
    throw new Error('issue labels are invalid');
  }
  const sorted = [...value.labels].sort();
  if (new Set(value.labels).size !== value.labels.length || value.labels.some((label, index) => label !== sorted[index])) {
    throw new Error('issue labels must be sorted and unique');
  }
}

function validateCriteria(value: unknown): asserts value is FrozenCriterion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) throw new Error('frozen criteria are invalid');
  const ids: string[] = [];
  for (const [index, criterion] of value.entries()) {
    assertExactObject(criterion, ['id', 'order', 'source', 'text'], `criterion[${index}]`);
    assertNonEmptyString(criterion.id, `criterion[${index}].id`);
    assertNonEmptyString(criterion.text, `criterion[${index}].text`);
    if (criterion.order !== index + 1) throw new Error('criterion order is invalid');
    if (criterion.source !== 'explicit' && criterion.source !== 'fallback') throw new Error('criterion source is invalid');
    ids.push(criterion.id);
  }
  if (new Set(ids).size !== ids.length) throw new Error('criterion IDs must be unique');
}

function bodyFrom(state: ProofStateV1, changes: Partial<ProofStateBodyV1>): ProofStateBodyV1 {
  const { generation: _generation, ...body } = state;
  void _generation;
  return { ...body, ...changes };
}

function isTerminalStatus(status: ProofStatus): boolean {
  return !['prepared', 'running'].includes(status);
}

function terminalStateFallback(state: ProofStateV1): ProveChangeResult {
  const receipt = state.receipt!;
  if (state.status === 'transport-failed') return { status: 'transport-failed', resumable: false, receipt };
  if (state.status === 'cancelled') return { status: 'cancelled', receipt };
  return { status: 'internal-error', receipt };
}

function emptyReceipt(proofId: string, bindingSha256: string, summary: string): ProofReceipt {
  return {
    proofId: proofId || 'invalid-proof',
    bindingSha256,
    summary,
    publishableEvidence: [],
    localEvidenceId: `proof:${proofId || 'invalid-proof'}`,
  };
}

function isInsideRelativeRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function assertRelativePath(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (value.startsWith('/') || value.includes('\\') || posix.normalize(value) !== value) throw new Error(`${field} is not normalized`);
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) throw new Error(`${field} is unsafe`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) throw new Error(`${field} is invalid`);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}
