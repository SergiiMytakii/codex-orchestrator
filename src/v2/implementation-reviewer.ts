import { createHash } from 'node:crypto';

import { canonicalJson, containsCredentialEvidence } from './containment.js';
import type { ContainedReportOperation, ContainedReportOperationResult, ReportOnlyWorktreeSnapshot } from './contained-report-operation.js';
import type { CodeReviewDefectV1, CodeReviewReportV1, ReviewOperation } from './code-review-report.js';
import type { DeliveryAuthority } from './delivery-authority.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_CAPSULE_BYTES = 1024 * 1024;

export interface ImplementationReviewInvocation {
  attemptId: string;
  operation: ReviewOperation;
  reviewerSessionId: string;
  targetRevision: number;
  targetFingerprint: string;
}

export interface ImplementationReviewerInput {
  attemptId: string;
  runId: string;
  worktreePath: string;
  operation: ReviewOperation;
  reviewerSessionId: string;
  implementationAttemptId: string;
  targetRevision: number;
  targetFingerprint: string;
  currentTreeSha: string;
  previousTarget: {
    targetRevision: number;
    targetFingerprint: string;
    candidateTreeSha: string;
  } | null;
  repairPatch: string | null;
  targetPatch: string;
  changedFiles: string[];
  repairFindings: Array<{ id: string; sourceId: string; summary: string; affectedContracts: string[] }>;
  checkedChangeSha256: string;
  checks: unknown[];
  proofReceipt: unknown;
  issue: unknown;
  frozenCriteria: unknown[];
  deliveryAuthority: DeliveryAuthority;
  defects: CodeReviewDefectV1[];
  reviewFocus: string[];
  workflowGeneration: WorkflowGenerationReceipt;
  repairOnly: boolean;
  originalReportSha256: string | null;
  validationDiagnostic: string | null;
  originalReportBytes: Buffer | null;
  signal: AbortSignal;
  onPrepared(invocation: ImplementationReviewInvocation): Promise<void>;
  onLaunched(invocation: ImplementationReviewInvocation & { pid: number; processGroupId: number }): Promise<void>;
}

export type ImplementationReviewerResult =
  | { kind: 'completed'; attemptId: string; report: CodeReviewReportV1; artifactSha256: string }
  | { kind: 'transport-failed'; resumable: true }
  | { kind: 'report-invalid'; diagnostic: string; originalReportSha256: string; originalReportBytes: Buffer }
  | { kind: 'safe-halt'; process: { pid: number; processGroupId: number; startedAt: string; baseline: ReportOnlyWorktreeSnapshot } }
  | { kind: 'cancelled' }
  | { kind: 'internal-error'; code: string };

export class ContainedImplementationReviewer {
  constructor(private readonly dependencies: { operation: ContainedReportOperation }) {}

  async run(input: ImplementationReviewerInput): Promise<ImplementationReviewerResult> {
    let attemptId: string;
    let promptFacts: string[];
    try {
      attemptId = input.attemptId;
      assertText(attemptId, 'review attempt ID');
      assertText(input.reviewerSessionId, 'reviewer session ID');
      assertText(input.implementationAttemptId, 'implementation attempt ID');
      if (attemptId === input.implementationAttemptId || input.reviewerSessionId === input.implementationAttemptId) {
        throw new Error('reviewer identity is not independent');
      }
      assertPositiveInteger(input.targetRevision, 'target revision');
      assertSha256(input.targetFingerprint, 'target fingerprint');
      assertGitSha(input.currentTreeSha, 'current target tree');
      const targeted = input.repairPatch !== null;
      assertText(input.targetPatch, 'review target patch');
      const changedFiles = sortedUnique(input.changedFiles, 'review changed files');
      if (changedFiles.length === 0) throw new Error('review changed files are empty');
      if (!targeted) {
        if (input.previousTarget === null && input.repairFindings.length !== 0) throw new Error('initial complete review target is invalid');
      } else {
        if (!input.previousTarget || (input.repairFindings.length === 0 && !input.defects.some((defect) => defect.status === 'fixed'))) {
          throw new Error('targeted review target is invalid');
        }
        assertText(input.repairPatch, 'repair patch');
      }
      assertSha256(input.checkedChangeSha256, 'review checked change');
      promptFacts = [buildCapsule({ ...input, changedFiles })];
    } catch (error) {
      return {
        kind: 'internal-error',
        code: safeCode(error, input.repairOnly ? 'review-report-repair-input-invalid' : 'review-input-invalid'),
      };
    }

    const invocation: ImplementationReviewInvocation = {
      attemptId, operation: input.operation, reviewerSessionId: input.reviewerSessionId,
      targetRevision: input.targetRevision, targetFingerprint: input.targetFingerprint,
    };
    let result: ContainedReportOperationResult;
    try {
      result = await this.dependencies.operation.run({
        operation: input.operation,
        attemptId,
        runId: input.runId,
        worktreePath: input.worktreePath,
        workflowGeneration: structuredClone(input.workflowGeneration),
        promptFacts,
        signal: input.signal,
        reviewContext: {
          operation: input.operation, targetRevision: input.targetRevision,
          targetFingerprint: input.targetFingerprint, reviewerSessionId: input.reviewerSessionId,
          previousFindingIds: (input.repairPatch !== null
            ? [...input.defects.filter((defect) => defect.status === 'fixed').map((defect) => defect.id), ...input.repairFindings.map((finding) => finding.id)]
            : [...input.defects.map((defect) => defect.id), ...input.repairFindings.map((finding) => finding.id)]).sort(),
          requiredCoverage: input.repairPatch === null ? [...input.reviewFocus] : [],
          requireAllReviewers: input.repairPatch === null,
        },
        onPrepared: () => input.onPrepared(structuredClone(invocation)),
        onLaunched: ({ pid, processGroupId }) => input.onLaunched({ ...structuredClone(invocation), pid, processGroupId }),
      });
    } catch {
      return { kind: 'internal-error', code: 'review-operation-threw' };
    }
    return mapResult(result, input);
  }
}

function buildCapsule(input: ImplementationReviewerInput): string {
  const repair = input.repairOnly
    ? validateRepairInput(input.originalReportSha256, input.validationDiagnostic, input.originalReportBytes)
    : rejectUnexpectedRepairInput(input.originalReportSha256, input.validationDiagnostic, input.originalReportBytes);
  const repairFindings = input.repairFindings.map((finding) => {
    assertText(finding.id, 'repair finding ID');
    assertText(finding.sourceId, 'repair finding source ID');
    assertText(finding.summary, 'repair finding summary');
    return {
      id: finding.id,
      sourceId: finding.sourceId,
      summary: finding.summary,
      affectedContracts: sortedUnique(finding.affectedContracts, 'repair finding affected contracts'),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (repairFindings.some((finding, index) => index > 0 && finding.id === repairFindings[index - 1]!.id)) {
    throw new Error('repair finding IDs have duplicates');
  }
  const text = canonicalJson({
    version: 1, operation: input.operation, reviewerSessionId: input.reviewerSessionId,
    target: {
      current: {
        targetRevision: input.targetRevision,
        targetFingerprint: input.targetFingerprint,
        candidateTreeSha: input.currentTreeSha,
      },
      previous: input.previousTarget,
      repairPatch: input.repairPatch,
      patch: input.targetPatch,
      changedFiles: input.changedFiles,
    },
    repairFindings,
    proof: {
      checkedChangeSha256: input.checkedChangeSha256,
      checks: input.checks,
      receipt: input.proofReceipt,
    },
    issue: input.issue, frozenCriteria: input.frozenCriteria,
    deliveryAuthority: input.deliveryAuthority, defects: input.defects,
    reviewFocus: sortedUnique(input.reviewFocus, 'review focus'),
    repairOnly: input.repairOnly, repair,
  });
  if (Buffer.byteLength(text, 'utf8') > MAX_CAPSULE_BYTES || containsCredentialEvidence(text)) {
    throw new Error('review capsule is unsafe or oversized');
  }
  return text;
}

function validateRepairInput(hash: string | null, diagnostic: string | null, bytes: Buffer | null) {
  if (hash === null || diagnostic === null || bytes === null) throw new Error('report repair input is incomplete');
  assertSha256(hash, 'original report hash');
  assertText(diagnostic, 'validation diagnostic');
  if (createHash('sha256').update(bytes).digest('hex') !== hash) {
    throw new Error('original report bytes do not match repair hash');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || containsCredentialEvidence(text)) throw new Error('original report bytes are unsafe');
  return { originalReportSha256: hash, validationDiagnostic: diagnostic, originalReport: text };
}

function rejectUnexpectedRepairInput(hash: string | null, diagnostic: string | null, bytes: Buffer | null): null {
  if (hash !== null || diagnostic !== null || bytes !== null) throw new Error('semantic review cannot carry report repair bytes');
  return null;
}

function mapResult(result: ContainedReportOperationResult, input: ImplementationReviewerInput): ImplementationReviewerResult {
  if (result.status === 'completed') return {
    kind: 'completed', attemptId: result.attemptId, report: result.validatedPayload as CodeReviewReportV1,
    artifactSha256: result.artifactSha256,
  };
  if (result.status === 'retryable') return { kind: 'transport-failed', resumable: true };
  if (result.status === 'safe-halt') return { kind: 'safe-halt', process: result.process };
  if (result.status === 'cancelled') return { kind: 'cancelled' };
  if (result.status === 'invalid' && result.repairInput) {
    const repair = {
      diagnostic: result.findings[0] ?? 'review report is invalid',
      originalReportSha256: result.repairInput.originalReportSha256,
      originalReportBytes: Buffer.from(result.repairInput.originalReportBytes),
    };
    try {
      buildCapsule({
        ...input,
        repairOnly: true,
        originalReportSha256: repair.originalReportSha256,
        validationDiagnostic: repair.diagnostic,
        originalReportBytes: repair.originalReportBytes,
      });
    } catch {
      return { kind: 'internal-error', code: 'review-report-repair-input-invalid' };
    }
    return { kind: 'report-invalid', ...repair };
  }
  if (result.status === 'blocked' && [
    'report-operation-prepare-failed',
    'report-operation-launch-failed',
    'report-operation-attempt-incomplete',
    'report-operation-result-read-failed',
    'report-operation-read-view-failed',
    'report-operation-report-unavailable',
  ].includes(result.code)) return { kind: 'transport-failed', resumable: true };
  return { kind: 'internal-error', code: result.status === 'invalid' ? 'review-report-invalid' : result.code };
}

function sortedUnique(value: string[], field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) throw new Error(`${field} is invalid`);
  const sorted = [...value].sort();
  if (sorted.some((item, index) => index > 0 && item === sorted[index - 1])) throw new Error(`${field} has duplicates`);
  return sorted;
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) throw new Error(`${field} is invalid`);
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${field} is invalid`);
}

function assertGitSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw new Error(`${field} is invalid`);
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} is invalid`);
}

function safeCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (/independent/u.test(error.message)) return 'reviewer-identity-not-independent';
  if (/repair/u.test(error.message)) return 'review-report-repair-input-invalid';
  return fallback;
}
