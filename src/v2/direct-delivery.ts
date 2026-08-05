import { createHash } from 'node:crypto';

import { validateCandidateBinding, type CandidateBindingV2 } from './candidate.js';

import { canonicalJson } from './containment.js';
import { validateCodeReviewDefects, type CodeReviewDefectV1, type CodeReviewReportV1 } from './code-review-report.js';

const SHA256 = /^[0-9a-f]{64}$/u;
export type DirectReviewStage = 'review' | 'review-repair';

export interface ReviewTrackV1 {
  version: 1;
  disposition: 'active' | 'clear';
  profile: 'simple' | 'medium' | 'high';
  reviewerSessionId: string | null;
  reportRepairs: number;
  transportRetries: number;
  coverage: string[];
  defects: CodeReviewDefectV1[];
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
  previousTarget: {
    targetRevision: number;
    targetFingerprint: string;
    candidateTreeSha: string;
  } | null;
  review: ReviewTrackV1;
  repairFindings: DirectRepairFindingV1[];
  terminalCode?: string;
  terminalOutcome?:
    | { status: 'blocked'; kind: 'external' | 'safety' | 'decision-delta' | 'out-of-scope' | 'authority-boundary' }
    | { status: 'transport-failed' | 'cancelled' | 'internal-error' };
}

export interface DirectReviewValidationContext {
  lifecycle: string;
  terminalOutcome?: DirectReviewV1['terminalOutcome'];
  terminalCode?: string;
}

export function directReviewCandidateTargetFingerprint(input: {
  binding: CandidateBindingV2;
  deliveryAuthoritySha256: string;
  workflowGenerationHash: string;
  cycle: number;
  frozenCriteria: unknown[];
}): string {
  const binding = validateCandidateBinding(input.binding, 'direct review candidate binding');
  assertSha256(input.deliveryAuthoritySha256, 'direct review delivery authority hash');
  assertSha256(input.workflowGenerationHash, 'direct review workflow generation hash');
  if (!Number.isSafeInteger(input.cycle) || input.cycle < 1) throw new Error('direct review cycle is invalid');
  return createHash('sha256').update(`codex-orchestrator-direct-review-target-v2\0${canonicalJson({
    bindingId: binding.bindingId,
    expectedHeadSha: binding.expectedHeadSha,
    candidateCommitSha: binding.candidateCommitSha,
    candidateTreeSha: binding.candidateTreeSha,
    canonicalChangedFiles: binding.canonicalChangedFiles,
    sourceWorktreeIdentity: binding.sourceWorktreeIdentity,
    deliveryAuthoritySha256: input.deliveryAuthoritySha256,
    workflowGenerationHash: input.workflowGenerationHash,
    cycle: input.cycle,
    frozenCriteria: input.frozenCriteria,
  })}`).digest('hex');
}

export function acceptApprovedDirectReview(
  state: DirectReviewV1,
  report: CodeReviewReportV1,
  artifactSha256: string,
  candidateTreeSha: string,
  mode: 'complete' | 'targeted',
): DirectReviewV1 {
  assertSha256(artifactSha256, 'direct review accepted report hash');
  assertGitSha(candidateTreeSha, 'direct review approved candidate tree');
  if (state.status !== 'active' || state.stage === null || report.verdict !== 'approved'
    || report.targetRevision !== state.targetRevision || report.targetFingerprint !== state.targetFingerprint
    || report.operation !== 'code-review' || report.reviewerSessionId !== state.review.reviewerSessionId) {
    throw new Error('accepted direct review report correlation mismatch');
  }
  const defects = mergeDefectLedger(state, report);
  if (defects.some((defect) => (defect.class === 'blocker' || defect.class === 'execution-risk')
    && defect.status !== 'verified' && defect.status !== 'superseded')) {
    throw new Error('approved direct review merge has unresolved defects');
  }
  const impactedCoverage = new Set([
    ...state.review.defects
      .filter((defect) => defect.status === 'fixed' && defect.statusTargetRevision === state.targetRevision)
      .flatMap((defect) => defect.affectedTargets),
    ...state.repairFindings
      .filter((finding) => finding.status === 'fixed')
      .flatMap((finding) => finding.affectedContracts),
  ].filter((target) => target.startsWith('contract:')).map((target) => target.slice('contract:'.length)));
  const mergedCoverage = [...new Set([
    ...state.review.coverage.filter((coverage) => !impactedCoverage.has(coverage)),
    ...report.coverage,
  ])].sort();
  const clearTrack: ReviewTrackV1 = {
    ...structuredClone(state.review),
    disposition: 'clear',
    coverage: mergedCoverage,
    defects: defects.filter((defect) => defect.status !== 'verified' && defect.status !== 'superseded'),
    acceptedReportSha256: artifactSha256,
  };
  const outcomes = new Map(report.repairFindingOutcomes.map((outcome) => [outcome.id, outcome.status]));
  return {
    ...structuredClone(state),
    status: 'clear',
    previousTarget: mode === 'targeted' ? structuredClone(state.previousTarget) : null,
    review: clearTrack,
    repairFindings: state.repairFindings.map((finding) => {
      const outcome = outcomes.get(finding.id);
      return outcome ? { ...structuredClone(finding), status: outcome } : structuredClone(finding);
    }).filter((finding) => finding.status !== 'verified'),
  };
}

export function acceptNeedsWorkDirectReview(
  state: DirectReviewV1,
  report: CodeReviewReportV1,
  artifactSha256: string,
  candidateTreeSha: string,
): DirectReviewV1 {
  assertSha256(artifactSha256, 'direct review accepted report hash');
  assertGitSha(candidateTreeSha, 'direct review candidate tree');
  const reopenedFinding = report.repairFindingOutcomes.some((outcome) => outcome.status === 'reopened');
  if (state.status !== 'active' || state.stage === null || report.verdict !== 'needs-work'
    || report.targetRevision !== state.targetRevision || report.targetFingerprint !== state.targetFingerprint
    || report.operation !== 'code-review' || report.reviewerSessionId !== state.review.reviewerSessionId
    || (!report.defects.some((defect) => defect.status === 'open' || defect.status === 'reopened') && !reopenedFinding)) {
    throw new Error('needs-work direct review report correlation mismatch');
  }
  const outcomes = new Map(report.repairFindingOutcomes.map((outcome) => [outcome.id, outcome.status]));
  const blockedContracts = new Set([
    ...report.defects
      .filter((defect) => defect.status === 'open' || defect.status === 'reopened')
      .flatMap((defect) => defect.affectedTargets),
    ...state.repairFindings
      .filter((finding) => outcomes.get(finding.id) === 'reopened')
      .flatMap((finding) => finding.affectedContracts),
  ].filter((target) => target.startsWith('contract:')).map((target) => target.slice('contract:'.length)));
  const mergedCoverage = [...new Set([
    ...state.review.coverage,
    ...report.coverage,
  ])].filter((coverage) => !blockedContracts.has(coverage)).sort();
  return {
    ...structuredClone(state),
    status: 'active',
    stage: 'review-repair',
    previousTarget: {
      targetRevision: state.targetRevision,
      targetFingerprint: state.targetFingerprint,
      candidateTreeSha,
    },
    review: {
      ...structuredClone(state.review),
      disposition: 'active',
      coverage: mergedCoverage,
      defects: mergeDefectLedger(state, report),
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
  if (current.length === 0) return structuredClone(report.defects);
  const reported = new Map(report.defects.map((defect) => [defect.id, defect]));
  const merged = current.map((existing) => {
    const next = reported.get(existing.id);
    if (!next) {
      if (existing.status === 'fixed') throw new Error('review omitted an impacted defect ID');
      return structuredClone(existing);
    }
    reported.delete(existing.id);
    if (existing.status === 'fixed'
      && !['verified', 'reopened', 'superseded'].includes(next.status)) {
      throw new Error('full review defect transition is invalid');
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
      || added.statusTargetRevision !== state.targetRevision) throw new Error('full review introduced defect is invalid');
    merged.push(structuredClone(added));
  }
  return merged.sort((left, right) => left.id.localeCompare(right.id));
}

export function beginDirectReviewRepair(
  state: DirectReviewV1,
  findings: DirectRepairFindingV1[],
  candidateTreeSha?: string,
): DirectReviewV1 {
  if (findings.length === 0 || (state.status !== 'clear'
    && !(state.status === 'active' && state.stage === 'review-repair'))) {
    throw new Error('direct review is not clear for repair');
  }
  if (state.status === 'active') {
    return { ...structuredClone(state), repairFindings: mergeRepairFindings(state.repairFindings, findings) };
  }
  if (state.review.disposition !== 'clear') throw new Error('direct review is not clear for repair');
  return {
    ...structuredClone(state),
    status: 'active',
    stage: 'review-repair',
    previousTarget: candidateTreeSha ? {
      targetRevision: state.targetRevision,
      targetFingerprint: state.targetFingerprint,
      candidateTreeSha,
    } : structuredClone(state.previousTarget),
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

export function prepareDirectReview(
  state: DirectReviewV1,
  targetFingerprint: string,
  reviewerSessionId: string,
): DirectReviewV1 {
  assertSha256(targetFingerprint, 'direct review target fingerprint');
  assertText(reviewerSessionId, 'direct review reviewer session ID');
  if (state.status !== 'active' || state.stage !== 'review-repair') {
    throw new Error('direct review is not ready for another review');
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
  if (![...defects, ...repairFindings].some((item) => item.status === 'fixed')) throw new Error('direct review has no fixed targets');
  const nextState: DirectReviewV1 = {
    ...structuredClone(state),
    stage: 'review',
    targetRevision,
    targetFingerprint,
    previousTarget: structuredClone(state.previousTarget),
    review: {
      ...structuredClone(state.review),
      reviewerSessionId,
      reportRepairs: 0,
      transportRetries: 0,
      defects,
      acceptedReportSha256: null,
    },
    repairFindings,
  };
  return nextState;
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
    stage: 'review',
    targetRevision: 1,
    targetFingerprint: input.targetFingerprint,
    previousTarget: null,
    review: activeTrack(input.codeReviewerSessionId),
    repairFindings: [],
  };
}

export function validateDirectReview(value: unknown, context: DirectReviewValidationContext): DirectReviewV1 {
  const optional = [
    ...(hasOwn(value, 'terminalCode') ? ['terminalCode'] : []),
    ...(hasOwn(value, 'terminalOutcome') ? ['terminalOutcome'] : []),
  ];
  assertExactObject(value, [
    'version', 'status', 'stage', 'targetRevision', 'targetFingerprint', 'previousTarget', 'review', 'repairFindings', ...optional,
  ], 'direct review');
  if (value.version !== 1 || !['active', 'clear', 'terminal'].includes(value.status as string)) {
    throw new Error('direct review version/status is invalid');
  }
  if (value.stage !== null && !isStage(value.stage)) throw new Error('direct review stage is invalid');
  if (!Number.isSafeInteger(value.targetRevision) || (value.targetRevision as number) < 0) throw new Error('direct review target revision is invalid');
  assertSha256(value.targetFingerprint, 'direct review target fingerprint');
  const previousTarget = validatePreviousTarget(value.previousTarget, value.targetRevision as number);
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
    previousTarget,
    review,
    repairFindings,
    ...(terminalCode ? { terminalCode: terminalCode as string } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
  };
}

function validatePreviousTarget(value: unknown, targetRevision: number): DirectReviewV1['previousTarget'] {
  if (value === null) return null;
  assertExactObject(value, ['targetRevision', 'targetFingerprint', 'candidateTreeSha'], 'direct review previous target');
  if (!Number.isSafeInteger(value.targetRevision)
    || (value.targetRevision !== targetRevision && value.targetRevision !== targetRevision - 1)) {
    throw new Error('direct review previous target revision is invalid');
  }
  assertSha256(value.targetFingerprint, 'direct review previous target fingerprint');
  assertGitSha(value.candidateTreeSha, 'direct review previous target tree');
  return {
    targetRevision: value.targetRevision as number,
    targetFingerprint: value.targetFingerprint as string,
    candidateTreeSha: value.candidateTreeSha as string,
  };
}

function validateComposite(value: Omit<DirectReviewV1, 'version' | 'targetFingerprint' | 'previousTarget'>, context: DirectReviewValidationContext): void {
  if (value.status === 'terminal') {
    if (value.stage === null || value.targetRevision < 1 || !value.terminalOutcome
      || !['blocked', 'transport-failed', 'cancelled', 'internal-error'].includes(context.lifecycle)) {
      throw new Error('terminal direct review composite is invalid');
    }
    if (value.terminalOutcome.status === 'internal-error') {
      if (value.terminalCode === undefined || value.terminalCode !== context.terminalCode) {
        throw new Error('terminal direct review code does not match run terminal outcome');
      }
    } else if (value.terminalCode !== undefined || context.terminalCode !== undefined) {
      throw new Error('non-internal terminal direct review has a terminal code');
    }
    return;
  }
  if (value.terminalOutcome || value.terminalCode) throw new Error('non-terminal direct review has terminal projection');
  if (value.stage === null || value.targetRevision < 1) throw new Error('active direct review requires a stage and revision');
  if (value.status === 'active') {
    const allowed = value.stage === 'review'
      ? ['checking', 'proving', 'reviewing', 'safe-halt']
      : ['implementing', 'checking', 'proving', 'safe-halt'];
    if (!allowed.includes(context.lifecycle)) throw new Error('active direct review lifecycle is invalid');
    if (value.review.disposition !== 'active') throw new Error('active direct review stage has no active track');
    validateStageFields(value.stage, value.review, value.repairFindings);
  } else {
    if (!['publishing', 'safe-halt', 'review-ready'].includes(context.lifecycle)
      || value.review.disposition !== 'clear') {
      throw new Error('clear direct review composite is invalid');
    }
  }
}

function validateTerminalProjection(value: unknown, lifecycle: string): DirectReviewV1['terminalOutcome'] {
  if (lifecycle === 'blocked') {
    assertExactObject(value, ['status', 'kind'], 'direct review terminal outcome');
    if (value.status !== 'blocked' || !['external', 'safety', 'decision-delta', 'out-of-scope', 'authority-boundary'].includes(value.kind as string)) {
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
  if (stage === 'review') {
    if (track.acceptedReportSha256 !== null) throw new Error('review stage fields are invalid');
  } else {
    if (track.acceptedReportSha256 === null || (track.defects.every((defect) => defect.status !== 'open' && defect.status !== 'reopened')
      && findings.every((finding) => finding.status !== 'open' && finding.status !== 'reopened'))) {
      throw new Error('review repair stage fields are invalid');
    }
  }
}

function validateTrack(value: unknown, field: string, targetRevision: number): ReviewTrackV1 {
  assertExactObject(value, [
    'version', 'disposition', 'profile', 'reviewerSessionId', 'reportRepairs', 'transportRetries',
    'coverage', 'defects', 'acceptedReportSha256',
  ], `direct review ${field} track`);
  if (value.version !== 1 || !['active', 'clear'].includes(value.disposition as string)
    || !['simple', 'medium', 'high'].includes(value.profile as string)
    || !isNonNegativeInteger(value.reportRepairs) || !isNonNegativeInteger(value.transportRetries)) throw new Error(`direct review ${field} track is invalid`);
  if (value.reviewerSessionId !== null) assertText(value.reviewerSessionId, `${field} reviewer session ID`);
  const coverage = sortedUniqueStrings(value.coverage, `${field} coverage`);
  const defects = validateCodeReviewDefects(value.defects, targetRevision);
  if (value.acceptedReportSha256 !== null) assertSha256(value.acceptedReportSha256, `${field} accepted report hash`);
  if (value.disposition === 'active' && value.reviewerSessionId === null) throw new Error(`${field} active track lacks identity`);
  if (value.disposition === 'clear' && (value.reviewerSessionId === null || value.acceptedReportSha256 === null
    || defects.some((defect) => (defect.class === 'blocker' || defect.class === 'execution-risk')
      && defect.status !== 'verified' && defect.status !== 'superseded'))) throw new Error(`${field} clear track is invalid`);
  return {
    version: 1,
    disposition: value.disposition as ReviewTrackV1['disposition'],
    profile: value.profile as ReviewTrackV1['profile'],
    reviewerSessionId: value.reviewerSessionId as string | null,
    reportRepairs: value.reportRepairs as number,
    transportRetries: value.transportRetries as number,
    coverage,
    defects,
    acceptedReportSha256: value.acceptedReportSha256 as string | null,
  };
}

function validateRepairFindings(value: unknown, targetRevision: number): DirectRepairFindingV1[] {
  if (!Array.isArray(value)) throw new Error('direct repair findings are invalid');
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

function activeTrack(reviewerSessionId: string): ReviewTrackV1 {
  return {
    version: 1, disposition: 'active', profile: 'high', reviewerSessionId,
    reportRepairs: 0, transportRetries: 0, coverage: [], defects: [], acceptedReportSha256: null,
  };
}

function isStage(value: unknown): value is DirectReviewStage {
  return value === 'review' || value === 'review-repair';
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sortedUniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
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

function assertGitSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw new Error(`${field} is invalid`);
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
