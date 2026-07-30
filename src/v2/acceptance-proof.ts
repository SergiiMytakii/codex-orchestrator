import { posix } from 'node:path';

import {
  checkedChangeFreshnessMatches,
  type CheckedChange,
  type CheckedChangeFreshnessAny,
  type CheckedChangePayload,
  type CheckedChangePayloadV1,
  type CheckedChangeReadCapability,
} from './checked-change.js';
import type { CandidateExecutionLeaseV2 } from './candidate.js';
import { canonicalJson, containsCredentialEvidence, sha256 } from './containment.js';
import {
  createProofReceipt,
  proofReportRepairDiagnostic,
  validateProofReport,
  type ProofReceipt,
  type ProofReportV1,
} from './proof-report.js';
import { validateProofArtifactInventory, validateProofIosInputs, type ProofIosInputsV1, type ProofRecordWriter, type ProofStateBodyV1, type ProofStateV1, type ProofStatus } from './proof-store.js';
import type { AndroidLeaseVerifier, IosLeaseVerifier } from './mobile-lease.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';
import type { DurableReportInvocationState, DurableReportInvocationV1 } from './contained-report-operation.js';

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

export type IosProofInputsV1 = ProofIosInputsV1;

export type ProofAgentResult =
  | { kind: 'report'; report: unknown; proofPhaseChangedFiles: string[]; proofPhaseArtifactSha256?: Record<string, string> }
  | { kind: 'deferred'; code: string }
  | { kind: 'transport-failed'; resumable: boolean }
  | { kind: 'cancelled' }
  | { kind: 'internal-error'; code?: string };

export interface ProofAgent<TPayload extends CheckedChangePayload = CheckedChangePayloadV1> {
  run(input: {
    proofId: string;
    runId: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChangeSha256: string;
    changedFiles: string[];
    checks: TPayload['checks'];
    worktreePath?: string;
    runnerPreparedArtifactPaths: string[];
    runnerPreparedArtifactSha256: Record<string, string>;
    runnerPreparationWarnings: string[];
    repairOnly: boolean;
    repairFindings: string[];
    repairArtifactSha256?: Record<string, string>;
    iosProofInputs?: IosProofInputsV1;
    workflowGeneration?: WorkflowGenerationReceipt;
    signal: AbortSignal;
    invocationState?: DurableReportInvocationState; beforeLaunch?: () => Promise<void>;
  }): Promise<ProofAgentResult>;
}

export class ProofLaunchAuthorizationError extends Error {
  constructor(readonly outcome: unknown) {
    super('proof launch authorization failed');
  }
}

export class CandidateProofInspectionError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type ProveChangeResult =
  | { status: 'passed'; receipt: ProofReceipt }
  | { status: 'needs-rework'; findings: string[]; receipt: ProofReceipt }
  | { status: 'external-block'; blocker: ExternalBlocker; receipt: ProofReceipt }
  | { status: 'transport-failed'; resumable: boolean; receipt: ProofReceipt }
  | { status: 'cancelled'; receipt: ProofReceipt }
  | { status: 'internal-error'; receipt: ProofReceipt };

export class AcceptanceProof<TPayload extends CheckedChangePayload = CheckedChangePayloadV1> {
  constructor(private readonly dependencies: {
    checkedChangeReader: CheckedChangeReadCapability;
    proofRecords: ProofRecordWriter;
    proofAgent: ProofAgent<TPayload>;
    inspectFreshness: (payload: TPayload, executionLease?: CandidateExecutionLeaseV2) => Promise<CheckedChangeFreshnessAny>;
    readArtifact: (relativePath: string) => Promise<Buffer>;
    inspectArtifact?: (relativePath: string) => Promise<{ modifiedAt: string }>;
    androidLease?: AndroidLeaseVerifier;
    iosLease?: IosLeaseVerifier;
    proofArtifactDir: string;
    now: () => string;
    signal?: AbortSignal;
  }) {
    assertRelativePath(dependencies.proofArtifactDir, 'proofArtifactDir');
  }

  async proveChange(input: {
    proofId: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChange: CheckedChange<TPayload>;
    executionLease?: CandidateExecutionLeaseV2;
    workflowGeneration?: WorkflowGenerationReceipt;
    beforeAgentLaunch?: () => Promise<void>;
    runnerPreparedArtifactPaths?: string[];
    runnerPreparedArtifactSha256?: Record<string, string>;
    runnerPreparationWarnings?: string[];
    iosProofInputs?: IosProofInputsV1;
  }): Promise<ProveChangeResult> {
    let bindingSha256 = sha256(canonicalJson({ proofId: input.proofId, invalid: true }));
    try {
      assertNonEmptyString(input.proofId, 'proofId');
      validateIssue(input.issue);
      validateCriteria(input.frozenCriteria);
      const checked = this.dependencies.checkedChangeReader.verifyAndRead(input.checkedChange);
      if (checked.payload.issueNumber !== input.issue.number) throw new Error('CheckedChange issue does not match proof issue');
      if (checked.payload.version === 2 && (!input.executionLease
        || input.executionLease.bindingId !== checked.payload.binding.bindingId
        || input.executionLease.candidateCommitSha !== checked.payload.binding.candidateCommitSha)) {
        throw new Error('CheckedChange candidate execution lease does not match proof binding');
      }
      if (input.iosProofInputs) validateProofIosInputs(input.iosProofInputs, input.proofId);
      bindingSha256 = createBindingSha256({
        proofId: input.proofId,
        issue: input.issue,
        frozenCriteria: input.frozenCriteria,
        payload: checked.payload,
        checkedChangeSha256: checked.checkedChangeSha256,
        runnerPreparedArtifactPaths: input.runnerPreparedArtifactPaths ?? [],
        iosProofInputs: input.iosProofInputs,
      });
      const result = await this.execute({ ...input, ...checked, bindingSha256 });
      try { await this.releaseMobileLeasesIfSettled(input.proofId, bindingSha256); }
      catch { return { status: 'transport-failed', resumable: true, receipt: result.receipt }; }
      return result;
    } catch (error) {
      if (error instanceof ProofLaunchAuthorizationError) {
        const state = await this.dependencies.proofRecords.read(input.proofId).catch(() => false as const);
        if (state === false || state?.invocation) return { status: 'transport-failed', resumable: true,
          receipt: emptyReceipt(input.proofId, bindingSha256, 'Proof authorization settlement is unresolved.') };
        try { await this.releaseMobileLeases(input.proofId); }
        catch { return { status: 'transport-failed', resumable: true, receipt: emptyReceipt(input.proofId, bindingSha256, 'Proof lease release is unresolved.') }; }
        throw error;
      }
      if (error instanceof CandidateProofInspectionError) throw error;
      return { status: 'internal-error', receipt: emptyReceipt(input.proofId, bindingSha256, 'Acceptance proof failed internally.') };
    }
  }

  private async execute(input: {
    proofId: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChange: CheckedChange<TPayload>;
    payload: TPayload;
    executionLease?: CandidateExecutionLeaseV2;
    checkedChangeSha256: string;
    bindingSha256: string;
    workflowGeneration?: WorkflowGenerationReceipt;
    beforeAgentLaunch?: () => Promise<void>;
    runnerPreparedArtifactPaths?: string[];
    runnerPreparedArtifactSha256?: Record<string, string>;
    runnerPreparationWarnings?: string[];
    iosProofInputs?: IosProofInputsV1;
  }): Promise<ProveChangeResult> {
    let state = await this.dependencies.proofRecords.read(input.proofId);
    if (state && state.bindingSha256 !== input.bindingSha256) {
      return { status: 'internal-error', receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof binding mismatch.') };
    }
    if (state?.status === 'passed' && state.receipt) {
      if (!await this.isFresh(input.payload, input.executionLease)) {
        return { status: 'internal-error', receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Checked change is stale.') };
      }
      return { status: 'passed', receipt: state.receipt };
    }
    if (state && isTerminalStatus(state.status)) {
      return terminalStateFallback(state);
    }

    if (!state) {
      const startedAt = this.timestamp();
      state = await this.dependencies.proofRecords.compareAndSwap(input.proofId, input.bindingSha256, 0, {
        schema: 'codex-orchestrator.acceptance-proof-state',
        version: 1,
        proofId: input.proofId,
        bindingSha256: input.bindingSha256,
        status: 'active', reportRepairs: 0, repairFindings: [],
        ...(input.iosProofInputs ? { iosProofInputs: structuredClone(input.iosProofInputs) } : {}),
        startedAt,
        updatedAt: startedAt,
      });
    }

    const attemptIosProofInputs = state.invocation ? state.iosProofInputs : input.iosProofInputs;
    if (state.invocation && !attemptIosProofInputs) {
      return { status: 'internal-error', receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof invocation context is unavailable.') };
    }
    if (!state.invocation && canonicalJson(state.iosProofInputs ?? null) !== canonicalJson(input.iosProofInputs ?? null)) {
      try { state = await this.dependencies.proofRecords.compareAndSwap(state.proofId, state.bindingSha256, state.generation,
        bodyFrom(state, { iosProofInputs: input.iosProofInputs, updatedAt: this.timestamp() })); }
      catch { return { status: 'transport-failed', resumable: true,
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof invocation context refresh is unresolved.') }; }
    }
    const recoveringInvocation = state.invocation !== undefined;
    if (!recoveringInvocation && !await this.isFresh(input.payload, input.executionLease)) {
      return this.persistOperationalTerminal(state, 'internal-error', input, 'Checked change is stale.');
    }
    if (!recoveringInvocation && this.dependencies.signal?.aborted) {
      const outcome = await this.persistOperationalTerminal(state, 'cancelled', input, 'Proof was cancelled.');
      return { status: 'cancelled', receipt: outcome.receipt };
    }
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
          worktreePath: input.executionLease?.path,
          runnerPreparedArtifactPaths: [...(input.runnerPreparedArtifactPaths ?? [])],
          runnerPreparedArtifactSha256: { ...(input.runnerPreparedArtifactSha256 ?? {}) },
          runnerPreparationWarnings: [...(input.runnerPreparationWarnings ?? [])],
          iosProofInputs: attemptIosProofInputs ? structuredClone(attemptIosProofInputs) : undefined,
          repairOnly: state.reportRepairs === 1,
          repairFindings: [...state.repairFindings],
          repairArtifactSha256: state.repairArtifactSha256 ? { ...state.repairArtifactSha256 } : undefined,
          workflowGeneration: input.workflowGeneration ? structuredClone(input.workflowGeneration) : undefined,
          signal: this.dependencies.signal ?? new AbortController().signal,
          invocationState: this.invocationState(input.proofId, input.bindingSha256),
          beforeLaunch: input.beforeAgentLaunch,
      });
    } catch (error) {
      if (error instanceof ProofLaunchAuthorizationError) throw error;
      return { status: 'transport-failed', resumable: true, receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof infrastructure is unresolved.') };
    }
    if (agentResult.kind === 'cancelled') {
      const outcome = await this.persistOperationalTerminal(await this.requireState(input), 'cancelled', input, 'Proof was cancelled.');
      return { status: 'cancelled', receipt: outcome.receipt };
    }
    if (agentResult.kind === 'deferred' || (agentResult.kind === 'transport-failed' && agentResult.resumable)) {
      return { status: 'transport-failed', resumable: true, receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof infrastructure is unresolved.') };
    }
    state = await this.requireState(input);
    if (agentResult.kind === 'transport-failed' || agentResult.kind === 'internal-error') {
      return this.persistOperationalTerminal(state, 'internal-error', input, agentResult.kind === 'internal-error'
        && agentResult.code === 'proof-report-repair-artifact-drift'
        ? 'Proof report repair modified proof artifacts.' : 'Proof agent failed internally.');
    }
    if (state.reportRepairs === 1
      && canonicalJson(agentResult.proofPhaseArtifactSha256 ?? null) !== canonicalJson(state.repairArtifactSha256)) {
      return this.persistOperationalTerminal(state, 'internal-error', input, 'Proof report repair modified proof artifacts.');
    }
    let report: ProofReportV1;
    try {
        report = validateProofReport(agentResult.report, input.payload.checks.map((check) => check.id));
        validateReportAgainstFrozenCriteria(report, input.frozenCriteria);
        for (const warning of input.runnerPreparationWarnings ?? []) {
          if (!report.residualRisks.includes(warning) && report.residualRisks.length < 256) report.residualRisks.push(warning);
        }
    } catch (error) {
        if (state.reportRepairs === 0 && await this.isFresh(input.payload, input.executionLease)) {
          const repairArtifactSha256 = validateProofArtifactInventory(agentResult.proofPhaseArtifactSha256);
          await this.dependencies.proofRecords.compareAndSwap(state.proofId, state.bindingSha256, state.generation, bodyFrom(state, {
            reportRepairs: 1, repairFindings: [proofReportRepairDiagnostic(error)], repairArtifactSha256,
            invocation: undefined, updatedAt: this.timestamp(),
          }));
          return { status: 'transport-failed', resumable: true, receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof report repair is prepared.') };
        }
        return this.persistOperationalTerminal(state, 'internal-error', input, 'Proof report is invalid.');
    }
    try {
        await this.validateArtifactsAndDiff(
          input.proofId,
          report,
          agentResult.proofPhaseChangedFiles,
          state.startedAt,
          state.reportRepairs === 0,
          input.runnerPreparedArtifactPaths ?? [],
          input.runnerPreparedArtifactSha256 ?? {},
          input.checkedChangeSha256,
          input.payload.checks.map((check) => check.id),
        );
    } catch {
        return this.persistOperationalTerminal(state, 'internal-error', input, 'Proof artifacts are invalid.');
    }
    if (!await this.isFresh(input.payload, input.executionLease)) {
      return this.persistOperationalTerminal(state, 'internal-error', input, 'Checked change became stale during proof.');
    }

    const receipt = createProofReceipt({
      proofId: input.proofId,
      bindingSha256: input.bindingSha256,
      summary: report.status === 'passed'
        ? input.runnerPreparationWarnings?.length
          ? `Acceptance proof passed with warning: ${input.runnerPreparationWarnings.join(' ')}`
          : 'Acceptance proof passed.'
        : report.status === 'needs-rework'
          ? 'Acceptance proof needs rework.'
          : 'Acceptance proof is externally blocked.',
      localEvidenceId: `proof:${input.proofId}`,
      report,
      trustedCheckIds: input.payload.checks.map((check) => check.id),
    });
    const persisted = await this.persistTerminal(state, report.status, input.bindingSha256, receipt);
    if (report.status === 'passed') return { status: 'passed', receipt: persisted.receipt! };
    if (report.status === 'needs-rework') return { status: 'needs-rework', findings: [...report.findings], receipt: persisted.receipt! };
    return { status: 'external-block', blocker: structuredClone(report.blocker!), receipt: persisted.receipt! };
  }

  private async validateArtifactsAndDiff(
    proofId: string,
    report: ProofReportV1,
    changedFiles: string[],
    proofStartedAt: string,
    requireCurrentVisualWrites: boolean,
    runnerPreparedArtifactPaths: string[],
    runnerPreparedArtifactSha256: Record<string, string>,
    checkedChangeSha256: string,
    configuredCheckIds: string[],
  ): Promise<void> {
    if (!Array.isArray(changedFiles) || changedFiles.length > 256) throw new Error('proof phase diff is invalid');
    if (!Array.isArray(runnerPreparedArtifactPaths) || runnerPreparedArtifactPaths.length > 256) {
      throw new Error('Runner-prepared proof artifact set is invalid');
    }
    for (const path of runnerPreparedArtifactPaths) {
      assertRelativePath(path, 'Runner-prepared proof artifact');
      if (!isInsideRelativeRoot(this.dependencies.proofArtifactDir, path)) {
        throw new Error('Runner-prepared proof artifact escapes proof-owned directory');
      }
    }
    if (Object.keys(runnerPreparedArtifactSha256).length !== runnerPreparedArtifactPaths.length
      || runnerPreparedArtifactPaths.some((path) => !/^[0-9a-f]{64}$/u.test(runnerPreparedArtifactSha256[path] ?? ''))) {
      throw new Error('Runner-prepared proof artifact digest set is invalid');
    }
    const artifactPaths = new Set<string>();
    const mobileTarget = report.decision.mode === 'visual' && ['android', 'ios'].includes(report.decision.targets[0] ?? '')
      ? report.decision.targets[0] as 'android' | 'ios'
      : undefined;
    const mobileLeaseRef = mobileTarget
      && report.visualEvidence
      && 'lease' in report.visualEvidence
      ? report.visualEvidence.lease.leaseRef
      : undefined;
    let mobileLeaseArtifact: { relativePath: string; bytes: Buffer } | undefined;
    let androidRunnerReceiptArtifact: { relativePath: string; bytes: Buffer } | undefined;
    const androidReceiptPaths = runnerPreparedArtifactPaths.filter((path) => path.endsWith(`/${proofId}/android-runner-receipt.json`));
    if (androidReceiptPaths.length > 1) throw new Error('Android Runner receipt set is ambiguous');
    const expectedAndroidReceiptPath = androidReceiptPaths[0];
    for (const artifact of report.artifacts) {
      if (!isInsideRelativeRoot(this.dependencies.proofArtifactDir, artifact.relativePath)) {
        throw new Error('proof artifact escapes proof-owned directory');
      }
      const bytes = await this.dependencies.readArtifact(artifact.relativePath);
      if (runnerPreparedArtifactPaths.includes(artifact.relativePath)
        && sha256(bytes) !== runnerPreparedArtifactSha256[artifact.relativePath]) {
        throw new Error('Runner-prepared proof artifact changed after capture');
      }
      if (sha256(bytes) !== artifact.sha256) throw new Error('proof artifact hash mismatch');
      validateArtifactBytes(artifact, bytes);
      if (report.decision.mode === 'visual') {
        if (!this.dependencies.inspectArtifact) throw new Error('visual artifact metadata inspection is unavailable');
        const metadata = await this.dependencies.inspectArtifact(artifact.relativePath);
        if (Number.isNaN(Date.parse(metadata.modifiedAt)) || new Date(metadata.modifiedAt).toISOString() !== metadata.modifiedAt) {
          throw new Error('visual artifact timestamp is invalid');
        }
        if (Date.parse(metadata.modifiedAt) < Date.parse(proofStartedAt)) throw new Error('visual artifact is stale');
      }
      artifactPaths.add(artifact.relativePath);
      if (artifact.id === mobileLeaseRef) mobileLeaseArtifact = { relativePath: artifact.relativePath, bytes };
      if (artifact.relativePath === expectedAndroidReceiptPath) {
        if (artifact.kind !== 'generated-file' || artifact.publishable) throw new Error('Android Runner receipt classification is invalid');
        androidRunnerReceiptArtifact = { relativePath: artifact.relativePath, bytes };
      }
    }
    for (const path of changedFiles) {
      assertRelativePath(path, 'proof phase changed file');
      if (!artifactPaths.has(path)) throw new Error('proof phase changed a non-artifact path');
    }
    if (report.decision.mode === 'visual' && requireCurrentVisualWrites) {
      const changed = new Set([...changedFiles, ...runnerPreparedArtifactPaths]);
      if (report.artifacts.some((artifact) => !changed.has(artifact.relativePath))) {
        throw new Error('visual proof reused an unchanged artifact');
      }
    }
    if (androidReceiptPaths.length === 1
      && (report.decision.mode !== 'visual' || report.decision.targets[0] !== 'android' || !mobileLeaseRef)) {
      throw new Error('Runner-prepared Android proof requires Android visual evidence and lease custody');
    }
    if (mobileLeaseRef && mobileTarget) {
      if (mobileTarget === 'android' && expectedAndroidReceiptPath) {
        if (!androidRunnerReceiptArtifact) throw new Error('Android Runner receipt artifact is required');
        validateAndroidRunnerReceipt({
          bytes: androidRunnerReceiptArtifact.bytes,
          proofId,
          checkedChangeSha256,
          configuredCheckIds,
          runnerPreparedArtifactPaths,
          reportArtifactPaths: artifactPaths,
        });
      }
      const verifier = mobileTarget === 'android' ? this.dependencies.androidLease : this.dependencies.iosLease;
      if (!verifier || !mobileLeaseArtifact) throw new Error(`${mobileTarget} lease verification is unavailable`);
      await verifier.verify({
        proofId,
        artifactRelativePath: mobileLeaseArtifact.relativePath,
        artifactBytes: mobileLeaseArtifact.bytes,
      });
    }
  }

  private async releaseMobileLeasesIfSettled(proofId: string, bindingSha256: string): Promise<void> {
    if (!this.dependencies.androidLease && !this.dependencies.iosLease) return;
    const state = await this.dependencies.proofRecords.read(proofId);
    if (!state || state.bindingSha256 !== bindingSha256 || !isTerminalStatus(state.status)) return;
    await this.releaseMobileLeases(proofId);
  }

  private async releaseMobileLeases(proofId: string): Promise<void> {
    await this.dependencies.androidLease?.release(proofId);
    await this.dependencies.iosLease?.release(proofId);
  }

  private invocationState(proofId: string, bindingSha256: string): DurableReportInvocationState {
    return {
      read: async () => (await this.dependencies.proofRecords.read(proofId))?.invocation,
      compareAndSwap: async (expected, next) => {
        const state = await this.dependencies.proofRecords.read(proofId);
        const same = expected === undefined ? state?.invocation === undefined
          : state?.invocation !== undefined && canonicalJson(state.invocation) === canonicalJson(expected);
        if (!state || state.bindingSha256 !== bindingSha256 || !same) return false;
        try {
          await this.dependencies.proofRecords.compareAndSwap(proofId, bindingSha256, state.generation,
            bodyFrom(state, { invocation: next, updatedAt: this.timestamp() }));
          return true;
        } catch { return false; }
      },
    };
  }

  private async requireState(input: { proofId: string; bindingSha256: string }): Promise<ProofStateV1> {
    const state = await this.dependencies.proofRecords.read(input.proofId);
    if (!state || state.bindingSha256 !== input.bindingSha256) throw new Error('proof state ownership drift');
    return state;
  }

  private async isFresh(payload: TPayload, executionLease?: CandidateExecutionLeaseV2): Promise<boolean> {
    return checkedChangeFreshnessMatches(payload, await this.dependencies.inspectFreshness(structuredClone(payload), executionLease));
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
  ): Promise<ProofStateV1> {
    return this.dependencies.proofRecords.compareAndSwap(
      state.proofId,
      bindingSha256,
      state.generation,
      bodyFrom(state, {
        status,
        invocation: undefined, receipt,
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
  payload: CheckedChangePayload;
  checkedChangeSha256: string;
  runnerPreparedArtifactPaths: string[];
  iosProofInputs?: IosProofInputsV1;
}): string {
  const iosProofInputs = input.iosProofInputs && (({ ownerPid: _ownerPid, ...stable }) => stable)(input.iosProofInputs);
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
    runnerPreparedArtifactPathsSha256: sha256(canonicalJson(input.runnerPreparedArtifactPaths)),
    iosProofInputsSha256: sha256(canonicalJson(iosProofInputs ?? null)),
  }));
}

function validateReportAgainstFrozenCriteria(report: ProofReportV1, criteria: FrozenCriterion[]): void {
  const expectedIds = criteria.map((criterion) => criterion.id);
  const actualIds = report.criteria.map((criterion) => criterion.id);
  if (expectedIds.length !== actualIds.length || expectedIds.some((id, index) => id !== actualIds[index])) {
    throw new Error('proof report criterion coverage mismatch');
  }
}

function validateArtifactBytes(artifact: ProofReportV1['artifacts'][number], bytes: Buffer): void {
  const maxBytes = artifact.kind === 'screenshot' ? 5 * 1024 * 1024 : 1024 * 1024;
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error('proof artifact size is invalid');
  if (artifact.kind === 'screenshot') {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const validPng = bytes.length >= 24
      && bytes.subarray(0, 8).equals(pngSignature)
      && bytes.subarray(12, 16).toString('ascii') === 'IHDR'
      && bytes.readUInt32BE(16) > 0
      && bytes.readUInt32BE(20) > 0;
    if (!validPng) throw new Error('proof screenshot PNG is invalid');
    return;
  }
  if (artifact.publishable && artifact.kind !== 'generated-file') {
    throw new Error('only screenshots or sanitized generated summaries may be publishable');
  }
  if (artifact.publishable && bytes.length > 64 * 1024) throw new Error('publishable proof summary is too large');
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(bytes) === false) throw new Error('proof text artifact is not UTF-8');
  if (containsCredentialEvidence(text)) throw new Error('proof text artifact contains credential material');
  const isLocalDiagnostic = !artifact.publishable && ['command-output', 'static-inspection'].includes(artifact.kind);
  if (!isLocalDiagnostic && containsHostIdentityEvidence(text)) throw new Error('proof text artifact contains host identity material');
}

function containsHostIdentityEvidence(value: string): boolean {
  return /(?:^|[\s"'])(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/mu.test(value);
}

function validateAndroidRunnerReceipt(input: {
  bytes: Buffer;
  proofId: string;
  checkedChangeSha256: string;
  configuredCheckIds: string[];
  runnerPreparedArtifactPaths: string[];
  reportArtifactPaths: Set<string>;
}): void {
  if (input.bytes.length === 0 || input.bytes.length > 64 * 1024) throw new Error('Android Runner receipt bytes are invalid');
  const value = JSON.parse(input.bytes.toString('utf8')) as unknown;
  assertExactObject(value, [
    'schema', 'version', 'status', 'proofId', 'configuredCheckIds', 'buildOutputSha256',
    'checkedChangeSha256', 'apkSha256', 'artifactRefs', 'navigation', 'capturedAt',
  ], 'Android Runner receipt');
  if (value.schema !== 'codex-orchestrator.runner-android-proof' || value.version !== 1
    || value.status !== 'prepared' || value.proofId !== input.proofId) {
    throw new Error('Android Runner receipt identity is invalid');
  }
  const shaPattern = /^[0-9a-f]{64}$/u;
  for (const field of ['buildOutputSha256', 'checkedChangeSha256', 'apkSha256'] as const) {
    if (typeof value[field] !== 'string' || !shaPattern.test(value[field])) throw new Error(`Android Runner receipt ${field} is invalid`);
  }
  if (value.checkedChangeSha256 !== input.checkedChangeSha256) throw new Error('Android Runner receipt checked change is stale');
  if (!Array.isArray(value.configuredCheckIds)
    || value.configuredCheckIds.length !== input.configuredCheckIds.length
    || value.configuredCheckIds.some((id, index) => id !== input.configuredCheckIds[index])) {
    throw new Error('Android Runner receipt check policy is invalid');
  }
  if (!Array.isArray(value.artifactRefs) || value.artifactRefs.length !== 4
    || new Set(value.artifactRefs).size !== value.artifactRefs.length
    || value.artifactRefs.some((path) => typeof path !== 'string'
      || !input.runnerPreparedArtifactPaths.includes(path)
      || !input.reportArtifactPaths.has(path))) {
    throw new Error('Android Runner receipt artifact binding is invalid');
  }
  assertExactObject(value.navigation, ['launchUriConfigured', 'tapText'], 'Android Runner receipt navigation');
  if (typeof value.navigation.launchUriConfigured !== 'boolean' || !Array.isArray(value.navigation.tapText)
    || value.navigation.tapText.some((text) => typeof text !== 'string' || text.length === 0)) {
    throw new Error('Android Runner receipt navigation is invalid');
  }
  if (typeof value.capturedAt !== 'string' || Number.isNaN(Date.parse(value.capturedAt))
    || new Date(value.capturedAt).toISOString() !== value.capturedAt) {
    throw new Error('Android Runner receipt timestamp is invalid');
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
  const next = { ...body, ...changes };
  for (const key of Object.keys(next) as Array<keyof typeof next>) if (next[key] === undefined) delete next[key];
  return next;
}

function isTerminalStatus(status: ProofStatus): boolean {
  return status !== 'active';
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
