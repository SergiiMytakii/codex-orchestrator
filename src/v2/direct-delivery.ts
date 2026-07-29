import { createHash } from 'node:crypto';

import { validateCandidateBinding, type CandidateBindingV2 } from './candidate.js';

import { canonicalJson } from './containment.js';
import { hashClosureRequest, validateCodeReviewDefects, type CodeReviewDefectV1, type CodeReviewReportV1, type ReviewMode } from './code-review-report.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_ITEMS = 256;
export const MAX_DIRECT_REVIEW_REPORT_REPAIRS = 4;

export type DirectReviewReportRepairCount = 0 | 1 | 2 | 3 | 4;

export type DirectReviewStage =
  | 'review-full' | 'review-repair' | 'review-closure';

export interface ReviewTrackV1 {
  version: 1;
  disposition: 'active' | 'clear';
  profile: 'simple' | 'medium' | 'high';
  reviewerSessionId: string | null;
  mode: ReviewMode | null;
  reportRepairs: DirectReviewReportRepairCount;
  coverage: string[];
  defects: CodeReviewDefectV1[];
  affectedDefectIds: string[];
  acceptedReportSha256: string | null;
}

export interface DirectRepairFindingV1 {
  id: string;
  provenance: 'code-review' | 'check' | 'proof' | 'pr-review';
  sourceId: string;
  targetRevision: number;
  summary: string;
  affectedContracts: string[];
  status: 'open' | 'fixed' | 'verified' | 'reopened';
}

export interface DirectReviewV1 {
  version: 1;
  status: 'active' | 'clear' | 'terminal';
  stage: DirectReviewStage | null;
  targetRevision: number;
  targetFingerprint: string;
  review: ReviewTrackV1;
  repairFindings: DirectRepairFindingV1[];
  terminalCode?: string;
  terminalOutcome?:
    | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted' }
    | { status: 'transport-failed' | 'cancelled' | 'internal-error' };
}

export interface DirectReviewValidationContext {
  lifecycle: string;
  terminalOutcome?: DirectReviewV1['terminalOutcome'];
  process?: {
    purpose: 'proof';
    resumeLifecycle: string;
    resumeReviewStage: DirectReviewStage | null;
  };
}

export function directReviewTargetFingerprint(input: {
  snapshot: {
    headSha: string;
    indexTreeSha: string;
    trackedContentSha256: string;
    untrackedContentSha256: string;
    worktreeIdentity: string;
  };
  changedFiles: string[];
  routeDecisionSha256: string;
  workflowGenerationHash: string;
  cycle: number;
  frozenCriteria: unknown[];
}): string {
  const changedFiles = sortedUniqueStrings(input.changedFiles, 'direct review changed files');
  assertSha256(input.routeDecisionSha256, 'direct review route decision hash');
  assertSha256(input.workflowGenerationHash, 'direct review workflow generation hash');
  if (!Number.isSafeInteger(input.cycle) || input.cycle < 1) throw new Error('direct review cycle is invalid');
  return createHash('sha256').update(`codex-orchestrator-direct-review-target-v1\0${canonicalJson({
    snapshot: input.snapshot,
    changedFiles,
    routeDecisionSha256: input.routeDecisionSha256,
    workflowGenerationHash: input.workflowGenerationHash,
    cycle: input.cycle,
    frozenCriteria: input.frozenCriteria,
  })}`).digest('hex');
}

export function directReviewCandidateTargetFingerprint(input: {
  binding: CandidateBindingV2;
  routeDecisionSha256: string;
  workflowGenerationHash: string;
  cycle: number;
  frozenCriteria: unknown[];
}): string {
  const binding = validateCandidateBinding(input.binding, 'direct review candidate binding');
  assertSha256(input.routeDecisionSha256, 'direct review route decision hash');
  assertSha256(input.workflowGenerationHash, 'direct review workflow generation hash');
  if (!Number.isSafeInteger(input.cycle) || input.cycle < 1) throw new Error('direct review cycle is invalid');
  return createHash('sha256').update(`codex-orchestrator-direct-review-target-v2\0${canonicalJson({
    bindingId: binding.bindingId,
    expectedHeadSha: binding.expectedHeadSha,
    candidateCommitSha: binding.candidateCommitSha,
    candidateTreeSha: binding.candidateTreeSha,
    canonicalChangedFiles: binding.canonicalChangedFiles,
    sourceWorktreeIdentity: binding.sourceWorktreeIdentity,
    routeDecisionSha256: input.routeDecisionSha256,
    workflowGenerationHash: input.workflowGenerationHash,
    cycle: input.cycle,
    frozenCriteria: input.frozenCriteria,
  })}`).digest('hex');
}

export function acceptApprovedDirectReview(
  state: DirectReviewV1,
  report: CodeReviewReportV1,
  artifactSha256: string,
): DirectReviewV1 {
  assertSha256(artifactSha256, 'direct review accepted report hash');
  if (state.status !== 'active' || state.stage === null || report.verdict !== 'approved'
    || report.targetRevision !== state.targetRevision || report.targetFingerprint !== state.targetFingerprint
    || report.operation !== 'code-review' || report.mode !== state.review.mode
    || report.reviewerSessionId !== state.review.reviewerSessionId
    || report.closureRequestSha256 !== expectedClosureRequest(state)) {
    throw new Error('accepted direct review report correlation mismatch');
  }
  const defects = mergeDefectLedger(state, report);
  if (defects.some((defect) => (defect.class === 'blocker' || defect.class === 'execution-risk')
    && defect.status !== 'verified' && defect.status !== 'superseded')) {
    throw new Error('approved direct review merge has unresolved defects');
  }
  const clearTrack: ReviewTrackV1 = {
    ...structuredClone(state.review),
    disposition: 'clear',
    coverage: [...report.coverage],
    defects,
    affectedDefectIds: [],
    acceptedReportSha256: artifactSha256,
  };
  const outcomes = new Map(report.repairFindingOutcomes.map((outcome) => [outcome.id, outcome.status]));
  return {
    ...structuredClone(state),
    status: 'clear',
    review: clearTrack,
    repairFindings: state.repairFindings.map((finding) => {
      const outcome = outcomes.get(finding.id);
      return outcome ? { ...structuredClone(finding), status: outcome } : structuredClone(finding);
    }),
  };
}

export function acceptNeedsWorkDirectReview(
  state: DirectReviewV1,
  report: CodeReviewReportV1,
  artifactSha256: string,
): DirectReviewV1 {
  assertSha256(artifactSha256, 'direct review accepted report hash');
  const reopenedFinding = report.repairFindingOutcomes.some((outcome) => outcome.status === 'reopened');
  if (state.status !== 'active' || state.stage === null || report.verdict !== 'needs-work'
    || report.targetRevision !== state.targetRevision || report.targetFingerprint !== state.targetFingerprint
    || report.operation !== 'code-review' || report.mode !== state.review.mode
    || report.reviewerSessionId !== state.review.reviewerSessionId
    || report.closureRequestSha256 !== expectedClosureRequest(state)
    || (!report.defects.some((defect) => defect.status === 'open' || defect.status === 'reopened') && !reopenedFinding)) {
    throw new Error('needs-work direct review report correlation mismatch');
  }
  const outcomes = new Map(report.repairFindingOutcomes.map((outcome) => [outcome.id, outcome.status]));
  return {
    ...structuredClone(state),
    status: 'active',
    stage: 'review-repair',
    review: {
      ...structuredClone(state.review),
      disposition: 'active',
      coverage: [...report.coverage],
      defects: mergeDefectLedger(state, report),
      affectedDefectIds: [],
      acceptedReportSha256: artifactSha256,
    },
    repairFindings: state.repairFindings.map((finding) => {
      const outcome = outcomes.get(finding.id);
      return outcome ? { ...structuredClone(finding), status: outcome } : structuredClone(finding);
    }),
  };
}

function mergeDefectLedger(state: DirectReviewV1, report: CodeReviewReportV1): CodeReviewDefectV1[] {
  const current = state.review.defects;
  if (report.mode === 'full') {
    if (current.length !== 0) throw new Error('Full review cannot replace an existing defect ledger');
    return structuredClone(report.defects);
  }
  const reported = new Map(report.defects.map((defect) => [defect.id, defect]));
  const affected = new Set(state.review.affectedDefectIds);
  const merged = current.map((existing) => {
    const next = reported.get(existing.id);
    if (!next) {
      if (!affected.has(existing.id)) return structuredClone(existing);
      return { ...structuredClone(existing), status: 'reopened' as const, statusTargetRevision: state.targetRevision, supersededBy: null };
    }
    reported.delete(existing.id);
    if (!affected.has(existing.id)) return structuredClone(existing);
    if (affected.has(existing.id) && existing.status === 'fixed'
      && !['verified', 'reopened', 'superseded'].includes(next.status)) {
      throw new Error('Closure defect transition is invalid');
    }
    return {
      ...structuredClone(next),
      id: existing.id,
      class: existing.class,
      invariant: existing.invariant,
      failure: existing.failure,
      introducedTargetRevision: existing.introducedTargetRevision,
    };
  });
  for (const added of reported.values()) {
    if (added.status !== 'open' || added.introducedTargetRevision !== state.targetRevision
      || added.statusTargetRevision !== state.targetRevision) throw new Error('Closure introduced defect is invalid');
    merged.push(structuredClone(added));
  }
  return merged.sort((left, right) => left.id.localeCompare(right.id));
}

export function beginDirectReviewRepair(
  state: DirectReviewV1,
  findings: DirectRepairFindingV1[],
): DirectReviewV1 {
  if (state.status !== 'clear' || state.review.disposition !== 'clear' || findings.length === 0) {
    throw new Error('direct review is not clear for repair');
  }
  return {
    ...structuredClone(state),
    status: 'active',
    stage: 'review-repair',
    review: { ...structuredClone(state.review), disposition: 'active' },
    repairFindings: mergeRepairFindings(state.repairFindings, findings),
  };
}

function mergeRepairFindings(current: DirectRepairFindingV1[], incoming: DirectRepairFindingV1[]): DirectRepairFindingV1[] {
  const merged = new Map(current.map((finding) => [finding.id, structuredClone(finding)]));
  for (const finding of incoming) {
    const prior = merged.get(finding.id);
    if (prior) {
      if (prior.sourceId !== finding.sourceId || prior.provenance !== finding.provenance || prior.summary !== finding.summary) {
        throw new Error('repair finding identity collision');
      }
      merged.set(finding.id, { ...prior, status: 'reopened' });
    } else {
      merged.set(finding.id, structuredClone(finding));
    }
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function prepareDirectReviewClosure(
  state: DirectReviewV1,
  targetFingerprint: string,
): { state: DirectReviewV1; closureRequestSha256: string } {
  assertSha256(targetFingerprint, 'direct review Closure target fingerprint');
  if (state.status !== 'active' || state.stage !== 'review-repair') {
    throw new Error('direct review is not ready for Closure');
  }
  const targetRevision = state.targetRevision + 1;
  const defects = state.review.defects.map((defect) =>
    defect.status === 'open' || defect.status === 'reopened'
      ? { ...structuredClone(defect), status: 'fixed' as const, statusTargetRevision: targetRevision }
      : structuredClone(defect));
  const repairFindings = state.repairFindings.map((finding) =>
    finding.status === 'open' || finding.status === 'reopened'
      ? { ...structuredClone(finding), status: 'fixed' as const }
      : structuredClone(finding));
  const affectedIds = [
    ...defects.filter((defect) => defect.status === 'fixed').map((defect) => defect.id),
    ...repairFindings.filter((finding) => finding.status === 'fixed').map((finding) => finding.id),
  ].sort();
  if (affectedIds.length === 0) throw new Error('direct review Closure has no fixed targets');
  const nextState: DirectReviewV1 = {
    ...structuredClone(state),
    stage: 'review-closure',
    targetRevision,
    targetFingerprint,
    review: {
      ...structuredClone(state.review),
      mode: 'closure',
      reportRepairs: 0,
      defects,
      affectedDefectIds: affectedIds,
    },
    repairFindings,
  };
  const closureRequestSha256 = directReviewClosureRequestSha256(nextState);
  return {
    state: nextState,
    closureRequestSha256,
  };
}

export function directReviewClosureRequestSha256(state: DirectReviewV1): string {
  if (state.status !== 'active' || state.stage !== 'review-closure' || state.review.mode !== 'closure') {
    throw new Error('direct review state is not a code-review Closure');
  }
  return hashClosureRequest({
    operation: 'code-review',
    targetRevision: state.targetRevision,
    targetFingerprint: state.targetFingerprint,
    affectedDefectIds: state.review.affectedDefectIds,
    fixedRepairFindings: state.repairFindings.filter((finding) => finding.status === 'fixed')
      .map((finding) => ({ id: finding.id, affectedContracts: finding.affectedContracts })),
    reviewFocus: ['acceptance-criteria', 'correctness', 'test-quality'],
  });
}

function expectedClosureRequest(state: DirectReviewV1): string | null {
  return state.stage === 'review-closure' ? directReviewClosureRequestSha256(state) : null;
}

export function projectTerminalDirectReview(
  state: DirectReviewV1,
  terminalOutcome: NonNullable<DirectReviewV1['terminalOutcome']>,
  terminalCode?: string,
): DirectReviewV1 {
  if (state.status === 'terminal') throw new Error('direct review terminal projection is immutable');
  if (terminalCode !== undefined) assertText(terminalCode, 'direct review terminal code');
  const {
    terminalCode: _priorCode,
    terminalOutcome: _priorOutcome,
    ...preserved
  } = structuredClone(state);
  return {
    ...preserved,
    status: 'terminal',
    ...(terminalCode ? { terminalCode } : {}),
    terminalOutcome: structuredClone(terminalOutcome),
  };
}

export function createInitialDirectReview(input: {
  targetFingerprint: string;
  codeReviewerSessionId: string;
}): DirectReviewV1 {
  assertSha256(input.targetFingerprint, 'direct review target fingerprint');
  assertText(input.codeReviewerSessionId, 'code reviewer session ID');
  return {
    version: 1,
    status: 'active',
    stage: 'review-full',
    targetRevision: 1,
    targetFingerprint: input.targetFingerprint,
    review: activeTrack(input.codeReviewerSessionId, 'full'),
    repairFindings: [],
  };
}

export function validateDirectReview(value: unknown, context: DirectReviewValidationContext): DirectReviewV1 {
  const optional = [
    ...(hasOwn(value, 'terminalCode') ? ['terminalCode'] : []),
    ...(hasOwn(value, 'terminalOutcome') ? ['terminalOutcome'] : []),
  ];
  assertExactObject(value, [
    'version', 'status', 'stage', 'targetRevision', 'targetFingerprint', 'review', 'repairFindings', ...optional,
  ], 'direct review');
  if (value.version !== 1 || !['active', 'clear', 'terminal'].includes(value.status as string)) {
    throw new Error('direct review version/status is invalid');
  }
  if (value.stage !== null && !isStage(value.stage)) throw new Error('direct review stage is invalid');
  if (!Number.isSafeInteger(value.targetRevision) || (value.targetRevision as number) < 0) throw new Error('direct review target revision is invalid');
  assertSha256(value.targetFingerprint, 'direct review target fingerprint');
  const review = validateTrack(value.review, 'review', value.targetRevision as number);
  const repairFindings = validateRepairFindings(value.repairFindings, value.targetRevision as number);
  const terminalCode = hasOwn(value, 'terminalCode') ? value.terminalCode : undefined;
  if (terminalCode !== undefined) assertText(terminalCode, 'direct review terminal code');
  const terminalOutcome = hasOwn(value, 'terminalOutcome') ? validateTerminalProjection(value.terminalOutcome, context.lifecycle) : undefined;
  if (terminalOutcome && context.terminalOutcome && canonicalJson(terminalOutcome) !== canonicalJson(context.terminalOutcome)) {
    throw new Error('direct review terminal outcome does not match run terminal outcome');
  }
  validateComposite({
    status: value.status as DirectReviewV1['status'],
    stage: value.stage as DirectReviewStage | null,
    targetRevision: value.targetRevision as number,
    review,
    repairFindings,
    terminalCode: terminalCode as string | undefined,
    terminalOutcome,
  }, context);
  return {
    version: 1,
    status: value.status as DirectReviewV1['status'],
    stage: value.stage as DirectReviewStage | null,
    targetRevision: value.targetRevision as number,
    targetFingerprint: value.targetFingerprint as string,
    review,
    repairFindings,
    ...(terminalCode ? { terminalCode: terminalCode as string } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
  };
}

function validateComposite(value: Omit<DirectReviewV1, 'version' | 'targetFingerprint'>, context: DirectReviewValidationContext): void {
  if (value.status === 'terminal') {
    if (value.stage === null || value.targetRevision < 1 || !value.terminalOutcome
      || !['blocked', 'transport-failed', 'cancelled', 'internal-error'].includes(context.lifecycle)) {
      throw new Error('terminal direct review composite is invalid');
    }
    return;
  }
  if (value.terminalOutcome || value.terminalCode) throw new Error('non-terminal direct review has terminal projection');
  if (value.stage === null || value.targetRevision < 1) throw new Error('active direct review requires a stage and revision');
  if (value.status === 'active') {
    if (context.lifecycle !== 'implementing') throw new Error('active direct review lifecycle is invalid');
    if (value.review.disposition !== 'active') throw new Error('active direct review stage has no active track');
    validateStageFields(value.stage, value.review, value.repairFindings);
  } else {
    const proofSafeHalt = context.lifecycle === 'safe-halt' && context.process?.purpose === 'proof'
      && context.process.resumeLifecycle === 'proving' && context.process.resumeReviewStage === null;
    if ((!['checking', 'proving', 'publishing', 'review-ready'].includes(context.lifecycle) && !proofSafeHalt)
      || value.review.disposition !== 'clear') {
      throw new Error('clear direct review composite is invalid');
    }
  }
}

function validateTerminalProjection(value: unknown, lifecycle: string): DirectReviewV1['terminalOutcome'] {
  if (lifecycle === 'blocked') {
    assertExactObject(value, ['status', 'kind'], 'direct review terminal outcome');
    if (value.status !== 'blocked' || !['external', 'safety', 'exhausted'].includes(value.kind as string)) {
      throw new Error('direct review blocked projection is invalid');
    }
  } else {
    assertExactObject(value, ['status'], 'direct review terminal outcome');
    if (value.status !== lifecycle || !['transport-failed', 'cancelled', 'internal-error'].includes(value.status as string)) {
      throw new Error('direct review terminal projection is invalid');
    }
  }
  return structuredClone(value) as DirectReviewV1['terminalOutcome'];
}

function validateStageFields(
  stage: DirectReviewStage,
  track: ReviewTrackV1,
  findings: DirectRepairFindingV1[],
): void {
  const suffix = stage.split('-').at(-1)!;
  if (suffix === 'full') {
    if (track.mode !== 'full' || track.acceptedReportSha256 !== null || track.affectedDefectIds.length !== 0) {
      throw new Error('Full review stage fields are invalid');
    }
  } else if (suffix === 'repair') {
    if (track.acceptedReportSha256 === null || (track.defects.every((defect) => defect.status !== 'open' && defect.status !== 'reopened')
      && findings.every((finding) => finding.status !== 'open' && finding.status !== 'reopened'))) {
      throw new Error('review repair stage fields are invalid');
    }
  } else if (track.mode !== 'closure' || track.acceptedReportSha256 === null || track.affectedDefectIds.length === 0
    || !track.affectedDefectIds.every((id) => track.defects.some((defect) => defect.id === id && defect.status === 'fixed')
      || findings.some((finding) => finding.id === id && finding.status === 'fixed'))) {
    throw new Error('Closure review stage fields are invalid');
  }
}

function validateTrack(value: unknown, field: string, targetRevision: number): ReviewTrackV1 {
  assertExactObject(value, [
    'version', 'disposition', 'profile', 'reviewerSessionId', 'mode', 'reportRepairs',
    'coverage', 'defects', 'affectedDefectIds', 'acceptedReportSha256',
  ], `direct review ${field} track`);
  if (value.version !== 1 || !['active', 'clear'].includes(value.disposition as string)
    || !['simple', 'medium', 'high'].includes(value.profile as string)
    || !isReportRepairCount(value.reportRepairs)) throw new Error(`direct review ${field} track is invalid`);
  if (value.reviewerSessionId !== null) assertText(value.reviewerSessionId, `${field} reviewer session ID`);
  if (value.mode !== null && value.mode !== 'full' && value.mode !== 'closure') throw new Error(`${field} review mode is invalid`);
  const coverage = sortedUniqueStrings(value.coverage, `${field} coverage`);
  const affectedDefectIds = sortedUniqueStrings(value.affectedDefectIds, `${field} affected defect IDs`);
  const defects = validateCodeReviewDefects(value.defects, targetRevision);
  if (value.acceptedReportSha256 !== null) assertSha256(value.acceptedReportSha256, `${field} accepted report hash`);
  if (value.disposition === 'active' && (value.reviewerSessionId === null || value.mode === null)) throw new Error(`${field} active track lacks identity`);
  if (value.disposition === 'clear' && (value.reviewerSessionId === null || value.mode === null || value.acceptedReportSha256 === null
    || affectedDefectIds.length !== 0 || defects.some((defect) => (defect.class === 'blocker' || defect.class === 'execution-risk')
      && defect.status !== 'verified' && defect.status !== 'superseded'))) throw new Error(`${field} clear track is invalid`);
  return {
    version: 1,
    disposition: value.disposition as ReviewTrackV1['disposition'],
    profile: value.profile as ReviewTrackV1['profile'],
    reviewerSessionId: value.reviewerSessionId as string | null,
    mode: value.mode as ReviewMode | null,
    reportRepairs: value.reportRepairs as DirectReviewReportRepairCount,
    coverage,
    defects,
    affectedDefectIds,
    acceptedReportSha256: value.acceptedReportSha256 as string | null,
  };
}

function validateRepairFindings(value: unknown, targetRevision: number): DirectRepairFindingV1[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('direct repair findings are invalid');
  const findings = value.map((finding, index) => {
    assertExactObject(finding, ['id', 'provenance', 'sourceId', 'targetRevision', 'summary', 'affectedContracts', 'status'], `repair finding[${index}]`);
    for (const field of ['id', 'sourceId', 'summary'] as const) assertText(finding[field], `repair finding.${field}`);
    if (!['code-review', 'check', 'proof', 'pr-review'].includes(finding.provenance as string)
      || !['open', 'fixed', 'verified', 'reopened'].includes(finding.status as string)
      || !Number.isSafeInteger(finding.targetRevision) || (finding.targetRevision as number) < 1
      || (finding.targetRevision as number) > targetRevision) throw new Error('repair finding fields are invalid');
    return {
      ...(structuredClone(finding) as unknown as DirectRepairFindingV1),
      affectedContracts: sortedUniqueStrings(finding.affectedContracts, 'repair finding affected contracts'),
    };
  });
  assertUnique(findings.map((finding) => finding.id), 'repair finding IDs');
  return findings;
}

function activeTrack(reviewerSessionId: string, mode: ReviewMode): ReviewTrackV1 {
  return {
    version: 1, disposition: 'active', profile: 'high', reviewerSessionId, mode,
    reportRepairs: 0, coverage: [], defects: [], affectedDefectIds: [], acceptedReportSha256: null,
  };
}

function isStage(value: unknown): value is DirectReviewStage {
  return ['review-full', 'review-repair', 'review-closure'].includes(value as string);
}

function isReportRepairCount(value: unknown): value is DirectReviewReportRepairCount {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DIRECT_REVIEW_REPORT_REPAIRS;
}

function sortedUniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`${field} is invalid`);
  for (const item of value) assertText(item, `${field} entry`);
  const output = [...value as string[]].sort();
  assertUnique(output, field);
  return output;
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${field} is invalid`);
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) throw new Error(`${field} is invalid`);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${field} has unknown or missing keys`);
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}
