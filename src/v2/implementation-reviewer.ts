import { createHash } from 'node:crypto';

import { canonicalJson, containsCredentialEvidence } from './containment.js';
import type { ContainedReportOperation, ContainedReportOperationResult, DurableReportInvocationState } from './contained-report-operation.js';
import { hashCodeReviewReport, validateCodeReviewReport, type CodeReviewDefectV1, type CodeReviewReportV1, type ReviewMode, type ReviewOperation } from './code-review-report.js';
import { decodeAgentReportForValidation } from './report-envelope.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_CAPSULE_BYTES = 1024 * 1024;

export interface ImplementationReviewerInput {
  runId: string;
  worktreePath: string;
  operation: ReviewOperation;
  mode: ReviewMode;
  reviewerSessionId: string;
  implementationAttemptId: string;
  targetRevision: number;
  targetFingerprint: string;
  closureRequestSha256: string | null;
  issue: unknown;
  frozenCriteria: unknown[];
  routeReceipt: unknown;
  defects: CodeReviewDefectV1[];
  affectedDefectIds: string[];
  fixedRepairFindings: Array<{ id: string; affectedContracts: string[] }>;
  reviewFocus: string[];
  workflowGeneration: WorkflowGenerationReceipt;
  repairOnly: boolean;
  originalReportSha256: string | null;
  validationDiagnostic: string | null;
  originalReportBytes: Buffer | null;
  signal: AbortSignal;
  invocationState: DurableReportInvocationState;
}

export type ImplementationReviewerResult =
  | { kind: 'completed'; attemptId: string; report: CodeReviewReportV1; artifactSha256: string }
  | { kind: 'transport-failed'; resumable: true }
  | { kind: 'report-invalid'; diagnostic: string; originalReportSha256: string; originalReportBytes: Buffer }
  | { kind: 'safe-halt'; code: string }
  | { kind: 'cancelled' }
  | { kind: 'internal-error'; code: string };

export class ContainedImplementationReviewer {
  constructor(private readonly dependencies: { operation: ContainedReportOperation }) {}

  async run(input: ImplementationReviewerInput): Promise<ImplementationReviewerResult> {
    let promptFacts: string[];
    try {
      assertText(input.reviewerSessionId, 'reviewer session ID');
      assertText(input.implementationAttemptId, 'implementation attempt ID');
      if (input.reviewerSessionId === input.implementationAttemptId) {
        throw new Error('reviewer identity is not independent');
      }
      assertPositiveInteger(input.targetRevision, 'target revision');
      assertSha256(input.targetFingerprint, 'target fingerprint');
      if (input.closureRequestSha256 !== null) assertSha256(input.closureRequestSha256, 'Closure request hash');
      if ((input.mode === 'full') !== (input.closureRequestSha256 === null)) throw new Error('review mode/Closure hash mismatch');
      promptFacts = [buildCapsule(input)];
    } catch (error) {
      return {
        kind: 'internal-error',
        code: safeCode(error, input.repairOnly ? 'review-report-repair-input-invalid' : 'review-input-invalid'),
      };
    }

    let result: ContainedReportOperationResult;
    try {
      result = await this.dependencies.operation.run({
        operation: input.operation,
        runId: input.runId,
        worktreePath: input.worktreePath,
        workflowGeneration: structuredClone(input.workflowGeneration),
        promptFacts,
        signal: input.signal,
        invocationState: input.invocationState,
        forbiddenAttemptIds: [input.implementationAttemptId, input.reviewerSessionId],
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
  const text = canonicalJson({
    version: 1, operation: input.operation, mode: input.mode, reviewerSessionId: input.reviewerSessionId,
    targetRevision: input.targetRevision, targetFingerprint: input.targetFingerprint,
    closureRequestSha256: input.closureRequestSha256, issue: input.issue, frozenCriteria: input.frozenCriteria,
    routeReceipt: input.routeReceipt, defects: input.defects,
    affectedDefectIds: sortedUnique(input.affectedDefectIds, 'affected defect IDs'),
    fixedRepairFindings: input.fixedRepairFindings.map((finding) => ({
      id: finding.id,
      affectedContracts: sortedUnique(finding.affectedContracts, 'fixed repair finding contracts'),
    })).sort((left, right) => left.id.localeCompare(right.id)),
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
  if (bytes.length > MAX_CAPSULE_BYTES || createHash('sha256').update(bytes).digest('hex') !== hash) {
    throw new Error('original report bytes do not match repair hash');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || containsCredentialEvidence(text)) throw new Error('original report bytes are unsafe');
  return { originalReportSha256: hash, validationDiagnostic: diagnostic, originalReport: text };
}

function rejectUnexpectedRepairInput(hash: string | null, diagnostic: string | null, bytes: Buffer | null): null {
  if (hash !== null || diagnostic !== null || bytes !== null) throw new Error('Full/Closure review cannot carry report repair bytes');
  return null;
}

function mapResult(result: ContainedReportOperationResult, input: ImplementationReviewerInput): ImplementationReviewerResult {
  if (result.status === 'completed') {
    try {
      const report = validateCodeReviewReport(decodeAgentReportForValidation(result.reportBytes), {
        operation: input.operation, mode: input.mode, targetRevision: input.targetRevision,
        targetFingerprint: input.targetFingerprint, reviewerSessionId: input.reviewerSessionId,
        closureRequestSha256: input.closureRequestSha256,
        fixedRepairFindingIds: input.fixedRepairFindings.map((finding) => finding.id).sort(),
      });
      return { kind: 'completed', attemptId: result.attemptId, report, artifactSha256: hashCodeReviewReport(report) };
    } catch (error) {
      const text = result.reportBytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(result.reportBytes) || containsCredentialEvidence(text)) {
        return { kind: 'internal-error', code: 'review-report-invalid' };
      }
      return { kind: 'report-invalid', diagnostic: error instanceof Error ? error.message : 'review report invalid',
        originalReportSha256: result.reportSha256, originalReportBytes: Buffer.from(result.reportBytes) };
    }
  }
  if (result.status === 'retryable') return { kind: 'transport-failed', resumable: true };
  if (result.status === 'safe-halt') return { kind: 'safe-halt', code: result.code };
  if (result.status === 'cancelled') return { kind: 'cancelled' };
  return { kind: 'internal-error', code: result.code };
}

function sortedUnique(value: string[], field: string): string[] {
  if (!Array.isArray(value) || value.length > 256 || value.some((item) => typeof item !== 'string' || item.length === 0)) throw new Error(`${field} is invalid`);
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

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} is invalid`);
}

function safeCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (/independent/u.test(error.message)) return 'reviewer-identity-not-independent';
  if (/repair/u.test(error.message)) return 'review-report-repair-input-invalid';
  return fallback;
}
