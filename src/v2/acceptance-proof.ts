import { readIssueProofRequirements, type IssueProofRequirements } from './issue-proof-policy.js';
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
  validateProofReport,
  type ProofReceipt,
  type ProofReportV1,
} from './proof-report.js';
import type { AndroidLeaseVerifier, IosLeaseVerifier } from './mobile-lease.js';

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

/** Retains the bounded, sanitized process cause without storing raw agent output. */
export interface ProofProcessFailure {
  kind: 'spawn-failed' | 'transport-failed' | 'timeout' | 'idle-timeout' | 'launch-gate-failed';
  exitCode: number | null;
  signal: string | null;
  reportStatus: 'available' | 'missing' | 'invalid';
  detail: string;
}

export class CandidateProofInspectionError extends Error {
  constructor(readonly code: string) { super(code); }
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
  | { status: 'transport-failed'; resumable: true; failure?: ProofProcessFailure }
  | { status: 'report-repair'; reportRepairCount: number; findings: string[]; reportCorrection?: { bytes: Buffer; sha256: string; diagnostic: string } }
  | {
      status: 'cleanup-pending';
      outcome: SettledProveChangeResult;
    };

export class AcceptanceProof<TPayload extends CheckedChangePayload = CheckedChangePayloadV1> {
  constructor(private readonly dependencies: {
    checkedChangeReader: CheckedChangeReadCapability;
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

  /** Admit the implementation owner's evidence without launching or retrying an agent. */
  async admitReport(input: {
    proofId: string;
    proofStartedAt: string;
    issue: IssueSnapshot;
    frozenCriteria: FrozenCriterion[];
    checkedChange: CheckedChange<TPayload>;
    materialization?: CandidateMaterializationV2;
    report: ProofReportV1;
    changedArtifactPaths?: string[];
    runnerPreparedArtifactPaths?: string[];
    runnerPreparedArtifactSha256?: Record<string, string>;
    runnerPreparationWarnings?: string[];
  }): Promise<ProveChangeResult> {
    let bindingSha256 = sha256(canonicalJson({ proofId: input.proofId, invalid: true }));
    let stage = 'input';
    try {
      assertNonEmptyString(input.proofId, 'proofId');
      assertRelativePath(input.proofId, 'proofId');
      if (input.proofId.includes('/')) throw new Error('proofId must be one path segment');
      assertIsoTimestamp(input.proofStartedAt, 'proofStartedAt');
      validateIssue(input.issue);
      const requirements = readIssueProofRequirements(input.issue.body);
      validateCriteria(input.frozenCriteria);
      stage = 'binding';
      const checked = this.dependencies.checkedChangeReader.verifyAndRead(input.checkedChange);
      if (checked.payload.issueNumber !== input.issue.number) throw new Error('CheckedChange issue does not match proof issue');
      if (checked.payload.version === 2 && input.materialization
        && (input.materialization.bindingId !== checked.payload.binding.bindingId
          || input.materialization.candidateCommitSha !== checked.payload.binding.candidateCommitSha)) {
        throw new Error('CheckedChange candidate execution lease does not match proof binding');
      }
      bindingSha256 = createBindingSha256({ ...input, payload: checked.payload,
        checkedChangeSha256: checked.checkedChangeSha256,
        runnerPreparedArtifactPaths: input.runnerPreparedArtifactPaths ?? [] });
      stage = 'freshness';
      if (!await this.isFresh(checked.payload, input.materialization)) {
        return this.settle(input.proofId, { status: 'internal-error',
          receipt: emptyReceipt(input.proofId, bindingSha256, 'Checked change is stale.') });
      }
      if (this.dependencies.signal?.aborted) {
        return this.settle(input.proofId, { status: 'cancelled',
          receipt: emptyReceipt(input.proofId, bindingSha256, 'Proof was cancelled.') });
      }
      if (requirements?.level === 'android-live' && (!(input.runnerPreparedArtifactPaths?.length)
        || input.runnerPreparationWarnings?.length)) {
        return this.settle(input.proofId, {
          status: 'external-block',
          blocker: { kind: 'tool', summary: 'Required live Android proof could not be prepared.',
            attempted: ['Required Runner-owned Android evidence is unavailable.'], resumable: true },
          receipt: emptyReceipt(input.proofId, bindingSha256, 'Required live Android proof is unavailable.'),
        });
      }
      stage = 'report';
      const report = validateProofReport(input.report, checked.payload.checks.map((check) => check.id));
      validateReportAgainstFrozenCriteria(report, input.frozenCriteria);
      if (report.status === 'passed' && requirements) {
        const requiredMode = requirements.level === 'tests-only' ? 'non-visual' : 'visual';
        if (report.decision.mode !== requiredMode
          || (requiredMode === 'visual' && report.decision.targets.join(',') !== 'android')) {
          throw new Error('Proof report does not satisfy the issue proof level.');
        }
      }
      for (const warning of input.runnerPreparationWarnings ?? []) {
        assertNonEmptyString(warning, 'Runner preparation warning');
        if (containsCredentialEvidence(warning) || containsHostIdentityEvidence(warning)) throw new Error('Runner preparation warning is unsafe');
        if (!report.residualRisks.includes(warning) && report.residualRisks.length < 256) report.residualRisks.push(warning);
      }
      stage = 'artifacts';
      await this.validateArtifactsAndDiff(input.proofId, report, input.changedArtifactPaths,
        input.proofStartedAt, input.runnerPreparedArtifactPaths ?? [], input.runnerPreparedArtifactSha256 ?? {},
        checked.checkedChangeSha256, checked.payload.checks.map((check) => check.id), requirements);
      stage = 'freshness';
      if (!await this.isFresh(checked.payload, input.materialization)) {
        return this.settle(input.proofId, { status: 'internal-error',
          receipt: emptyReceipt(input.proofId, bindingSha256, 'Checked change became stale during proof.') });
      }
      if (this.dependencies.signal?.aborted) {
        return this.settle(input.proofId, { status: 'cancelled',
          receipt: emptyReceipt(input.proofId, bindingSha256, 'Proof was cancelled.') });
      }
      const receipt = createProofReceipt({
        proofId: input.proofId,
        bindingSha256,
        summary: report.status === 'passed'
          ? input.runnerPreparationWarnings?.length
            ? `Acceptance proof passed with warning: ${input.runnerPreparationWarnings.join(' ')}`
            : 'Acceptance proof passed.'
          : report.status === 'needs-rework'
            ? 'Acceptance proof needs rework.'
            : 'Acceptance proof is externally blocked.',
        localEvidenceId: `proof:${input.proofId}`,
        report,
        trustedCheckIds: checked.payload.checks.map((check) => check.id),
      });
      if (report.status === 'passed') return this.settle(input.proofId, { status: 'passed', receipt });
      if (report.status === 'needs-rework') {
        return this.settle(input.proofId, { status: 'needs-rework', findings: [...report.findings], receipt });
      }
      return this.settle(input.proofId, { status: 'external-block', blocker: structuredClone(report.blocker!), receipt });
    } catch (error) {
      if (error instanceof CandidateProofInspectionError) throw error;
      return this.settle(input.proofId, { status: 'internal-error', receipt: emptyReceipt(input.proofId, bindingSha256,
        proofFailureSummary(`Acceptance proof ${stage} failed`, error)) });
    }
  }

  private async validateArtifactsAndDiff(
    proofId: string,
    report: ProofReportV1,
    changedFiles: string[] | undefined,
    proofStartedAt: string,
    runnerPreparedArtifactPaths: string[],
    runnerPreparedArtifactSha256: Record<string, string>,
    checkedChangeSha256: string,
    configuredCheckIds: string[],
    requirements?: IssueProofRequirements,
  ): Promise<void> {
    if (changedFiles !== undefined && (!Array.isArray(changedFiles) || changedFiles.length > 256)) throw new Error('proof phase diff is invalid');
    if (!Array.isArray(runnerPreparedArtifactPaths) || runnerPreparedArtifactPaths.length > 256) {
      throw new Error('Runner-prepared proof artifact set is invalid');
    }
    for (const path of runnerPreparedArtifactPaths) {
      assertRelativePath(path, 'Runner-prepared proof artifact');
      if (!isInsideRelativeRoot(`${this.dependencies.proofArtifactDir}/${proofId}`, path)) {
        throw new Error('Runner-prepared proof artifact escapes proof-owned directory');
      }
    }
    if (new Set(runnerPreparedArtifactPaths).size !== runnerPreparedArtifactPaths.length
      || Object.keys(runnerPreparedArtifactSha256).length !== runnerPreparedArtifactPaths.length
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
      if (!isInsideRelativeRoot(`${this.dependencies.proofArtifactDir}/${proofId}`, artifact.relativePath)) {
        throw new Error('proof artifact escapes proof-owned directory');
      }
      const bytes = await this.dependencies.readArtifact(artifact.relativePath);
      if (runnerPreparedArtifactPaths.includes(artifact.relativePath)
        && sha256(bytes) !== runnerPreparedArtifactSha256[artifact.relativePath]) {
        throw new Error('Runner-prepared proof artifact changed after capture');
      }
      if (sha256(bytes) !== artifact.sha256) throw new Error('proof artifact hash mismatch');
      validateArtifactBytes(artifact, bytes);
      {
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
    for (const path of changedFiles ?? []) {
      assertRelativePath(path, 'proof phase changed file');
      if (!artifactPaths.has(path)) throw new Error('proof phase changed a non-artifact path');
    }
    if (report.decision.mode === 'visual' && changedFiles !== undefined) {
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
          requirements,
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
  requirements?: IssueProofRequirements;
}): void {
  if (input.bytes.length === 0 || input.bytes.length > 64 * 1024) throw new Error('Android Runner receipt bytes are invalid');
  const value = JSON.parse(input.bytes.toString('utf8')) as unknown;
  assertExactObject(value, [
    'schema', 'version', 'status', 'proofId', 'configuredCheckIds', 'buildOutputSha256',
    'checkedChangeSha256', 'apkSha256', 'artifactRefs', 'navigation', 'capturedAt',
    ...(input.requirements ? ['scenario'] : []),
    ...(input.requirements?.authentication === 'dev-account' ? ['authentication'] : []),
  ], 'Android Runner receipt');
  if (input.requirements && canonicalJson(value.scenario) !== canonicalJson(input.requirements.steps)) throw new Error('Android Runner scenario does not match the issue.');
  if (input.requirements?.authentication === 'dev-account') {
    assertExactObject(value.authentication, ['status', 'userIdSha256'], 'Android Runner authentication');
    if (value.authentication.status !== 'authenticated' || typeof value.authentication.userIdSha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(value.authentication.userIdSha256)) throw new Error('Required account identity is unverified.');
  }
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

/** Removes sensitive evidence before bounding a proof failure diagnostic. */
export function proofFailureSummary(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : 'Unknown failure';
  if (containsCredentialEvidence(detail) || containsHostIdentityEvidence(detail)
    || /["']?token["']?\s*[:=]\s*["']?[^\s"']{8,}/iu.test(detail)) return `${prefix}: [redacted].`;
  return `${prefix}: ${detail.replace(/[\x00-\x1f\x7f]/gu, ' ').trim() || 'Unknown failure'}`.slice(0, 1024);
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
