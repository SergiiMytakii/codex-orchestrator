import { posix } from 'node:path';

import {
  checkedChangeFreshnessMatches,
  type CheckedChange,
  type CheckedChangeFreshnessAny,
  type CheckedChangePayload,
  type CheckedChangePayloadV1,
  type CheckedChangeReadCapability,
} from './checked-change.js';
import type { CandidateMaterializationV2 } from './candidate.js';
import { canonicalJson, containsCredentialEvidence, containsHostIdentityEvidence, sha256 } from './containment.js';
import {
  createProofReceipt,
  proofReportRepairDiagnostic,
  validateProofReport,
  type ProofReceipt,
  type ProofReportV1,
} from './proof-report.js';
import type { AndroidLeaseVerifier, IosLeaseVerifier } from './mobile-lease.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';

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
  kind: 'credential' | 'tool' | 'service' | 'decision-delta' | 'out-of-scope' | 'authority-boundary';
  summary: string;
  attempted: string[];
  resumable: boolean;
}

export type ProofAgentResult =
  | { kind: 'report'; report: unknown; proofPhaseChangedFiles: string[] }
  | { kind: 'safe-halt' }
  | { kind: 'transport-failed'; resumable: boolean }
  | { kind: 'cancelled' }
  | { kind: 'internal-error' };

export interface ProofAgent<TPayload extends CheckedChangePayload = CheckedChangePayloadV1> {
  run(input: {
    attemptId: string;
    recoverOnly?: boolean;
    proofId: string;
    runId: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChangeSha256: string;
    changedFiles: string[];
    checks: TPayload['checks'];
    worktreePath?: string;
    onLaunched?: (input: { pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
    runnerPreparedArtifactPaths: string[];
    runnerPreparedArtifactSha256: Record<string, string>;
    runnerPreparationWarnings: string[];
    repairOnly: boolean;
    repairFindings: string[];
    workflowGeneration?: WorkflowGenerationReceipt;
    signal: AbortSignal;
  }): Promise<ProofAgentResult>;
}

export class CandidateProofInspectionError extends Error {
  constructor(readonly code: string) { super(code); }
}

export class ProofLaunchAuthorizationError extends Error {
  constructor(readonly outcome: unknown) {
    super('proof launch authorization failed');
  }
}

export type SettledProveChangeResult =
  | { status: 'passed'; receipt: ProofReceipt }
  | { status: 'needs-rework'; findings: string[]; receipt: ProofReceipt }
  | { status: 'external-block'; blocker: ExternalBlocker; receipt: ProofReceipt }
  | { status: 'transport-failed'; resumable: false; receipt: ProofReceipt }
  | { status: 'cancelled'; receipt: ProofReceipt }
  | { status: 'internal-error'; receipt: ProofReceipt };

export type ProveChangeResult =
  | SettledProveChangeResult
  | { status: 'safe-halt' }
  | { status: 'transport-failed'; resumable: true }
  | { status: 'report-repair'; reportRepairCount: number; findings: string[] }
  | {
      status: 'cleanup-pending';
      outcome: SettledProveChangeResult;
    };

export class AcceptanceProof<TPayload extends CheckedChangePayload = CheckedChangePayloadV1> {
  constructor(private readonly dependencies: {
    checkedChangeReader: CheckedChangeReadCapability;
    proofAgent: ProofAgent<TPayload>;
    inspectFreshness: (payload: TPayload, materialization?: CandidateMaterializationV2) => Promise<CheckedChangeFreshnessAny>;
    readArtifact: (relativePath: string) => Promise<Buffer>;
    inspectArtifact?: (relativePath: string) => Promise<{ modifiedAt: string }>;
    androidLease?: AndroidLeaseVerifier;
    iosLease?: IosLeaseVerifier;
    proofArtifactDir: string;
    signal?: AbortSignal;
  }) {
    assertRelativePath(dependencies.proofArtifactDir, 'proofArtifactDir');
  }

  async cleanupMobileLeases(proofId: string): Promise<void> {
    assertNonEmptyString(proofId, 'proofId');
    await this.dependencies.androidLease?.release(proofId);
    await this.dependencies.iosLease?.release(proofId);
  }

  async proveChange(input: {
    proofId: string;
    attemptId: string;
    recoverOnly: boolean;
    proofStartedAt: string;
    transportRetryCount: number;
    reportRepairCount: number;
    reportRepairFindings: string[];
    passedReceipt?: ProofReceipt;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChange: CheckedChange<TPayload>;
    materialization?: CandidateMaterializationV2;
    workflowGeneration?: WorkflowGenerationReceipt;
    beforeAgentLaunch?: () => Promise<void>;
    onLaunched?: (input: { pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
    runnerPreparedArtifactPaths?: string[];
    runnerPreparedArtifactSha256?: Record<string, string>;
    runnerPreparationWarnings?: string[];
  }): Promise<ProveChangeResult> {
    let bindingSha256 = sha256(canonicalJson({ proofId: input.proofId, invalid: true }));
    try {
      assertNonEmptyString(input.proofId, 'proofId');
      assertNonEmptyString(input.attemptId, 'attemptId');
      assertBoolean(input.recoverOnly, 'recoverOnly');
      assertIsoTimestamp(input.proofStartedAt, 'proofStartedAt');
      validateSemanticState(input);
      validateIssue(input.issue);
      validateCriteria(input.frozenCriteria);
      const checked = this.dependencies.checkedChangeReader.verifyAndRead(input.checkedChange);
      if (checked.payload.issueNumber !== input.issue.number) throw new Error('CheckedChange issue does not match proof issue');
      if (checked.payload.version === 2 && (!input.materialization
        || input.materialization.bindingId !== checked.payload.binding.bindingId
        || input.materialization.candidateCommitSha !== checked.payload.binding.candidateCommitSha)) {
        throw new Error('CheckedChange candidate execution lease does not match proof binding');
      }
      bindingSha256 = createBindingSha256({
        proofId: input.proofId,
        issue: input.issue,
        frozenCriteria: input.frozenCriteria,
        payload: checked.payload,
        checkedChangeSha256: checked.checkedChangeSha256,
        runnerPreparedArtifactPaths: input.runnerPreparedArtifactPaths ?? [],
      });
      if (input.passedReceipt) {
        validateProofReceipt(input.passedReceipt);
        if (input.passedReceipt.proofId !== input.proofId || input.passedReceipt.bindingSha256 !== bindingSha256) {
          throw new Error('Passed proof receipt does not match proof binding');
        }
        if (!await this.isFresh(checked.payload, input.materialization)) {
          return this.settle(input.proofId, {
            status: 'internal-error',
            receipt: emptyReceipt(input.proofId, bindingSha256, 'Checked change is stale.'),
          });
        }
        return this.settle(input.proofId, { status: 'passed', receipt: structuredClone(input.passedReceipt) });
      }
      return await this.execute({ ...input, ...checked, bindingSha256 });
    } catch (error) {
      if (error instanceof CandidateProofInspectionError || error instanceof ProofLaunchAuthorizationError) throw error;
      return { status: 'internal-error', receipt: emptyReceipt(input.proofId, bindingSha256, 'Acceptance proof failed internally.') };
    }
  }

  private async execute(input: {
    proofId: string;
    attemptId: string;
    recoverOnly: boolean;
    proofStartedAt: string;
    transportRetryCount: number;
    reportRepairCount: number;
    reportRepairFindings: string[];
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChange: CheckedChange<TPayload>;
    payload: TPayload;
    materialization?: CandidateMaterializationV2;
    checkedChangeSha256: string;
    bindingSha256: string;
    workflowGeneration?: WorkflowGenerationReceipt;
    beforeAgentLaunch?: () => Promise<void>;
    onLaunched?: (input: { pid: number; processGroupId: number; launchedAt: string }) => Promise<void>;
    runnerPreparedArtifactPaths?: string[];
    runnerPreparedArtifactSha256?: Record<string, string>;
    runnerPreparationWarnings?: string[];
  }): Promise<ProveChangeResult> {
    if (!await this.isFresh(input.payload, input.materialization)) {
      return this.settle(input.proofId, {
        status: 'internal-error',
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Checked change is stale.'),
      });
    }
    if (this.dependencies.signal?.aborted) {
      return this.settle(input.proofId, {
        status: 'cancelled',
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof was cancelled.'),
      });
    }

    let report: ProofReportV1;
    let agentResult: ProofAgentResult;
    try {
      await input.beforeAgentLaunch?.();
      agentResult = await this.dependencies.proofAgent.run({
        attemptId: input.attemptId,
        recoverOnly: input.recoverOnly,
        proofId: input.proofId,
        runId: input.payload.runId,
        issue: structuredClone(input.issue),
        frozenCriteria: structuredClone(input.frozenCriteria),
        checkedChangeSha256: input.checkedChangeSha256,
        changedFiles: [...input.payload.changedFiles],
        checks: structuredClone(input.payload.checks),
        worktreePath: input.materialization?.path,
        onLaunched: input.onLaunched,
        runnerPreparedArtifactPaths: [...(input.runnerPreparedArtifactPaths ?? [])],
        runnerPreparedArtifactSha256: { ...(input.runnerPreparedArtifactSha256 ?? {}) },
        runnerPreparationWarnings: [...(input.runnerPreparationWarnings ?? [])],
        repairOnly: input.reportRepairCount > 0,
        repairFindings: [...input.reportRepairFindings],
        workflowGeneration: input.workflowGeneration ? structuredClone(input.workflowGeneration) : undefined,
        signal: this.dependencies.signal ?? new AbortController().signal,
      });
    } catch (error) {
      if (error instanceof CandidateProofInspectionError || error instanceof ProofLaunchAuthorizationError) throw error;
      return this.settle(input.proofId, {
        status: 'internal-error',
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof agent failed internally.'),
      });
    }

    if (this.dependencies.signal?.aborted) {
      return this.settle(input.proofId, {
        status: 'cancelled',
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof was cancelled.'),
      });
    }
    if (agentResult.kind === 'safe-halt') return { status: 'safe-halt' };
    if (agentResult.kind === 'transport-failed') {
      if (agentResult.resumable && await this.isFresh(input.payload, input.materialization)) {
        return { status: 'transport-failed', resumable: true };
      }
      return this.settle(input.proofId, {
        status: 'transport-failed',
        resumable: false,
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof transport failed.'),
      });
    }
    if (agentResult.kind === 'cancelled') {
      return this.settle(input.proofId, {
        status: 'cancelled',
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof was cancelled.'),
      });
    }
    if (agentResult.kind === 'internal-error') {
      return this.settle(input.proofId, {
        status: 'internal-error',
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof agent failed internally.'),
      });
    }

    try {
      report = validateProofReport(agentResult.report, input.payload.checks.map((check) => check.id));
      validateReportAgainstFrozenCriteria(report, input.frozenCriteria);
      for (const warning of input.runnerPreparationWarnings ?? []) {
        if (!report.residualRisks.includes(warning) && report.residualRisks.length < 256) report.residualRisks.push(warning);
      }
    } catch (error) {
      if (await this.isFresh(input.payload, input.materialization)) {
        return { status: 'report-repair', reportRepairCount: input.reportRepairCount + 1, findings: [proofReportRepairDiagnostic(error)] };
      }
      return this.settle(input.proofId, {
        status: 'internal-error',
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof report is invalid.'),
      });
    }
    try {
      await this.validateArtifactsAndDiff(
        input.proofId,
        report,
        agentResult.proofPhaseChangedFiles,
        input.proofStartedAt,
        input.reportRepairCount === 0,
        input.runnerPreparedArtifactPaths ?? [],
        input.runnerPreparedArtifactSha256 ?? {},
        input.checkedChangeSha256,
        input.payload.checks.map((check) => check.id),
      );
    } catch {
      return this.settle(input.proofId, {
        status: 'internal-error',
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Proof artifacts are invalid.'),
      });
    }
    if (!await this.isFresh(input.payload, input.materialization)) {
      return this.settle(input.proofId, {
        status: 'internal-error',
        receipt: emptyReceipt(input.proofId, input.bindingSha256, 'Checked change became stale during proof.'),
      });
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
    if (report.status === 'passed') return this.settle(input.proofId, { status: 'passed', receipt });
    if (report.status === 'needs-rework') {
      return this.settle(input.proofId, { status: 'needs-rework', findings: [...report.findings], receipt });
    }
    return this.settle(input.proofId, { status: 'external-block', blocker: structuredClone(report.blocker!), receipt });
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

  private async isFresh(payload: TPayload, materialization?: CandidateMaterializationV2): Promise<boolean> {
    return checkedChangeFreshnessMatches(payload, await this.dependencies.inspectFreshness(structuredClone(payload), materialization));
  }

  private async settle(proofId: string, outcome: SettledProveChangeResult): Promise<ProveChangeResult> {
    try {
      await this.cleanupMobileLeases(proofId);
      return outcome;
    } catch {
      return { status: 'cleanup-pending', outcome };
    }
  }
}

function createBindingSha256(input: {
  proofId: string;
  issue: IssueSnapshot;
  frozenCriteria: FrozenCriterion[];
  payload: CheckedChangePayload;
  checkedChangeSha256: string;
  runnerPreparedArtifactPaths: string[];
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
    runnerPreparedArtifactPathsSha256: sha256(canonicalJson(input.runnerPreparedArtifactPaths)),
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

function validateSemanticState(value: {
  transportRetryCount: number;
  reportRepairCount: number;
  reportRepairFindings: string[];
}): void {
  if (!Number.isSafeInteger(value.transportRetryCount) || value.transportRetryCount < 0) {
    throw new Error('transportRetryCount is invalid');
  }
  if (!Number.isSafeInteger(value.reportRepairCount) || value.reportRepairCount < 0) {
    throw new Error('reportRepairCount is invalid');
  }
  if (!Array.isArray(value.reportRepairFindings) || value.reportRepairFindings.length > 256) {
    throw new Error('reportRepairFindings are invalid');
  }
  for (const finding of value.reportRepairFindings) assertNonEmptyString(finding, 'reportRepairFindings[]');
  if ((value.reportRepairCount === 0) !== (value.reportRepairFindings.length === 0)) {
    throw new Error('report repair counter and findings do not match');
  }
}

function validateProofReceipt(value: unknown): asserts value is ProofReceipt {
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

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} is invalid`);
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} is invalid`);
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}
