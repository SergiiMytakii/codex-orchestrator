import { createHash } from 'node:crypto';

import { validateCandidateBinding, type CandidateBindingV2 } from './candidate.js';

import { canonicalJson } from './containment.js';
import { validateCodeReviewDefects, type CodeReviewDefectV1, type CodeReviewReportV1 } from './code-review-report.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_ITEMS = 256;
export const MAX_DIRECT_REVIEW_REPORT_REPAIRS = 4;

export type ReviewDataReportRepairCount = 0 | 1 | 2 | 3 | 4;

export interface ReviewReceiptV1 {
  verdict: 'approved' | 'needs-work';
  reportSha256: string;
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

export interface ReviewDataV1 {
  version: 1;
  targetRevision: number;
  targetFingerprint: string;
  reviewerSessionId: string;
  reportRepairs: ReviewDataReportRepairCount;
  transportRetries: 0 | 1;
  coverage: string[];
  defects: CodeReviewDefectV1[];
  receipt: ReviewReceiptV1 | null;
  repairFindings: DirectRepairFindingV1[];
}

export function reviewDataTargetFingerprint(input: {
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
  const changedFiles = sortedUniqueStrings(input.changedFiles, 'review data changed files');
  assertSha256(input.routeDecisionSha256, 'review data route decision hash');
  assertSha256(input.workflowGenerationHash, 'review data workflow generation hash');
  if (!Number.isSafeInteger(input.cycle) || input.cycle < 1) throw new Error('review data cycle is invalid');
  return createHash('sha256').update(`codex-orchestrator-direct-review-target-v1\0${canonicalJson({
    snapshot: input.snapshot,
    changedFiles,
    routeDecisionSha256: input.routeDecisionSha256,
    workflowGenerationHash: input.workflowGenerationHash,
    cycle: input.cycle,
    frozenCriteria: input.frozenCriteria,
  })}`).digest('hex');
}

export function reviewDataCandidateTargetFingerprint(input: {
  binding: CandidateBindingV2;
  routeDecisionSha256: string;
  workflowGenerationHash: string;
  cycle: number;
  frozenCriteria: unknown[];
}): string {
  const binding = validateCandidateBinding(input.binding, 'review data candidate binding');
  assertSha256(input.routeDecisionSha256, 'review data route decision hash');
  assertSha256(input.workflowGenerationHash, 'review data workflow generation hash');
  if (!Number.isSafeInteger(input.cycle) || input.cycle < 1) throw new Error('review data cycle is invalid');
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

export function acceptApprovedReviewData(
  state: ReviewDataV1,
  report: CodeReviewReportV1,
  artifactSha256: string,
): ReviewDataV1 {
  assertSha256(artifactSha256, 'review data accepted report hash');
  if (state.receipt !== null || report.verdict !== 'approved'
    || report.targetRevision !== state.targetRevision || report.targetFingerprint !== state.targetFingerprint
    || report.operation !== 'code-review' || report.reviewerSessionId !== state.reviewerSessionId) {
    throw new Error('accepted review data report correlation mismatch');
  }
  const defects = mergeDefectLedger(state, report);
  if (defects.some((defect) => (defect.class === 'blocker' || defect.class === 'execution-risk')
    && defect.status !== 'verified' && defect.status !== 'superseded')) {
    throw new Error('approved review data merge has unresolved defects');
  }
  const repairFindings = applyRepairFindingOutcomes(state, report);
  if (repairFindings.some((finding) => finding.status === 'open' || finding.status === 'fixed' || finding.status === 'reopened')) {
    throw new Error('approved review data merge has unresolved repair findings');
  }
  return {
    ...structuredClone(state),
    coverage: [...report.coverage],
    defects,
    receipt: { verdict: 'approved', reportSha256: artifactSha256 },
    repairFindings,
  };
}

export function acceptNeedsWorkReviewData(
  state: ReviewDataV1,
  report: CodeReviewReportV1,
  artifactSha256: string,
): ReviewDataV1 {
  assertSha256(artifactSha256, 'review data accepted report hash');
  const reopenedFinding = report.repairFindingOutcomes.some((outcome) => outcome.status === 'reopened');
  if (state.receipt !== null || report.verdict !== 'needs-work'
    || report.targetRevision !== state.targetRevision || report.targetFingerprint !== state.targetFingerprint
    || report.operation !== 'code-review' || report.reviewerSessionId !== state.reviewerSessionId
    || (!report.defects.some((defect) => defect.status === 'open' || defect.status === 'reopened') && !reopenedFinding)) {
    throw new Error('needs-work review data report correlation mismatch');
  }
  return {
    ...structuredClone(state),
    coverage: [...report.coverage],
    defects: mergeDefectLedger(state, report),
    receipt: { verdict: 'needs-work', reportSha256: artifactSha256 },
    repairFindings: applyRepairFindingOutcomes(state, report),
  };
}

function mergeDefectLedger(state: ReviewDataV1, report: CodeReviewReportV1): CodeReviewDefectV1[] {
  const current = state.defects;
  if (current.length === 0) return structuredClone(report.defects);
  const reported = new Map(report.defects.map((defect) => [defect.id, defect]));
  const merged = current.map((existing) => {
    const next = reported.get(existing.id);
    if (!next) throw new Error('full review omitted a previous defect ID');
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

function applyRepairFindingOutcomes(state: ReviewDataV1, report: CodeReviewReportV1): DirectRepairFindingV1[] {
  const expectedIds = state.repairFindings
    .filter((finding) => finding.status === 'fixed')
    .map((finding) => finding.id)
    .sort();
  const actualIds = report.repairFindingOutcomes.map((outcome) => outcome.id).sort();
  if (!sameStrings(expectedIds, actualIds)) throw new Error('full review omitted a previous repair finding ID');
  const outcomes = new Map(report.repairFindingOutcomes.map((outcome) => [outcome.id, outcome.status]));
  return state.repairFindings.map((finding) => {
    const outcome = outcomes.get(finding.id);
    return outcome ? { ...structuredClone(finding), status: outcome } : structuredClone(finding);
  });
}

export function beginReviewDataRepair(
  state: ReviewDataV1,
  findings: DirectRepairFindingV1[],
): ReviewDataV1 {
  if (!hasApprovedReviewReceipt(state) || findings.length === 0) {
    throw new Error('review data has no approved receipt for repair');
  }
  return {
    ...structuredClone(state),
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

export function prepareReviewData(
  state: ReviewDataV1,
  targetFingerprint: string,
  reviewerSessionId: string,
): ReviewDataV1 {
  assertSha256(targetFingerprint, 'review data target fingerprint');
  assertText(reviewerSessionId, 'review data reviewer session ID');
  if (state.receipt === null) {
    throw new Error('review data is not ready for another review');
  }
  if (reviewerSessionId === state.reviewerSessionId) throw new Error('review data requires an independent reviewer');
  const targetRevision = state.targetRevision + 1;
  const defects = state.defects.map((defect) =>
    defect.status === 'open' || defect.status === 'reopened'
      ? { ...structuredClone(defect), status: 'fixed' as const, statusTargetRevision: targetRevision }
      : structuredClone(defect));
  const repairFindings = state.repairFindings.map((finding) =>
    finding.status === 'open' || finding.status === 'reopened'
      ? { ...structuredClone(finding), status: 'fixed' as const }
      : structuredClone(finding));
  if (![...defects, ...repairFindings].some((item) => item.status === 'fixed')) throw new Error('review data has no fixed targets');
  const nextState: ReviewDataV1 = {
    ...structuredClone(state),
    targetRevision,
    targetFingerprint,
    reviewerSessionId,
    reportRepairs: 0,
    transportRetries: 0,
    defects,
    receipt: null,
    repairFindings,
  };
  return nextState;
}

export function canRecoverTerminalReviewDataReport(
  state: ReviewDataV1,
): boolean {
  return state.receipt === null
    && state.reportRepairs > 0 && state.reportRepairs < MAX_DIRECT_REVIEW_REPORT_REPAIRS;
}

export function recoverTerminalReviewDataReport(
  state: ReviewDataV1,
): ReviewDataV1 {
  if (!canRecoverTerminalReviewDataReport(state)) {
    throw new Error('review data terminal report is not recoverable');
  }
  return {
    ...structuredClone(state),
    transportRetries: 0,
  };
}

export function createInitialReviewData(input: {
  targetFingerprint: string;
  codeReviewerSessionId: string;
}): ReviewDataV1 {
  assertSha256(input.targetFingerprint, 'review data target fingerprint');
  assertText(input.codeReviewerSessionId, 'code reviewer session ID');
  return {
    version: 1,
    targetRevision: 1,
    targetFingerprint: input.targetFingerprint,
    reviewerSessionId: input.codeReviewerSessionId,
    reportRepairs: 0,
    transportRetries: 0,
    coverage: [],
    defects: [],
    receipt: null,
    repairFindings: [],
  };
}

export function hasApprovedReviewReceipt(value: Readonly<ReviewDataV1>): boolean {
  return value.receipt?.verdict === 'approved';
}

export function validateReviewData(value: unknown): ReviewDataV1 {
  assertExactObject(value, [
    'version', 'targetRevision', 'targetFingerprint', 'reviewerSessionId', 'reportRepairs', 'transportRetries',
    'coverage', 'defects', 'receipt', 'repairFindings',
  ], 'review data');
  if (value.version !== 1) throw new Error('review data version is invalid');
  if (!Number.isSafeInteger(value.targetRevision) || (value.targetRevision as number) < 1) throw new Error('review data target revision is invalid');
  assertSha256(value.targetFingerprint, 'review data target fingerprint');
  assertText(value.reviewerSessionId, 'review data reviewer session ID');
  if (!isReportRepairCount(value.reportRepairs) || !isBit(value.transportRetries)) throw new Error('review data repair counters are invalid');
  const coverage = sortedUniqueStrings(value.coverage, 'review data coverage');
  const defects = validateCodeReviewDefects(value.defects, value.targetRevision as number);
  const receipt = validateReceipt(value.receipt);
  const repairFindings = validateRepairFindings(value.repairFindings, value.targetRevision as number);
  validateReceiptData(receipt, defects, repairFindings);
  return {
    version: 1,
    targetRevision: value.targetRevision as number,
    targetFingerprint: value.targetFingerprint as string,
    reviewerSessionId: value.reviewerSessionId as string,
    reportRepairs: value.reportRepairs as ReviewDataReportRepairCount,
    transportRetries: value.transportRetries as 0 | 1,
    coverage,
    defects,
    receipt,
    repairFindings,
  };
}

function validateReceipt(value: unknown): ReviewReceiptV1 | null {
  if (value === null) return null;
  assertExactObject(value, ['verdict', 'reportSha256'], 'review data receipt');
  if (value.verdict !== 'approved' && value.verdict !== 'needs-work') throw new Error('review data receipt verdict is invalid');
  assertSha256(value.reportSha256, 'review data receipt report hash');
  return { verdict: value.verdict, reportSha256: value.reportSha256 };
}

function validateReceiptData(
  receipt: ReviewReceiptV1 | null,
  defects: CodeReviewDefectV1[],
  repairFindings: DirectRepairFindingV1[],
): void {
  // The receipt is immutable evidence for its target. Later Run-owned repair
  // transitions may add or reopen findings without rewriting that evidence.
  if (receipt?.verdict === 'needs-work'
    && !defects.some((defect) => defect.status === 'open' || defect.status === 'reopened')
    && !repairFindings.some((finding) => finding.status === 'reopened')) {
    throw new Error('needs-work review data receipt lacks findings');
  }
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

function isBit(value: unknown): value is 0 | 1 { return value === 0 || value === 1; }

function isReportRepairCount(value: unknown): value is ReviewDataReportRepairCount {
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

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
