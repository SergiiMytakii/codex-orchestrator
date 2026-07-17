import { createHash, randomUUID } from 'node:crypto';

import { canonicalJson, containsCredentialEvidence } from './containment.js';
import type { ContainedReportOperation, ContainedReportOperationResult, ReportOnlyWorktreeSnapshot } from './contained-report-operation.js';
import type { CodeReviewDefectV1, CodeReviewReportV1, ReviewMode, ReviewOperation } from './code-review-report.js';
import type { WorkflowGenerationReceipt } from './workflow-assets.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_CAPSULE_BYTES = 1024 * 1024;

export interface ImplementationReviewInvocation {
  attemptId: string;
  operation: ReviewOperation;
  mode: ReviewMode;
  reviewerSessionId: string;
  targetRevision: number;
  targetFingerprint: string;
  closureRequestSha256: string | null;
}

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
  mandatoryCoverage: string[];
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
  | { kind: 'safe-halt'; process: { pid: number; processGroupId: number; startedAt: string; baseline: ReportOnlyWorktreeSnapshot }; waitForAbsence(): Promise<void> }
  | { kind: 'cancelled' }
  | { kind: 'internal-error'; code: string };

export class ContainedImplementationReviewer {
  constructor(private readonly dependencies: { operation: ContainedReportOperation; createAttemptId?: () => string }) {}

  async run(input: ImplementationReviewerInput): Promise<ImplementationReviewerResult> {
    let attemptId: string;
    let promptFacts: string[];
    try {
      attemptId = (this.dependencies.createAttemptId ?? randomUUID)();
      assertText(attemptId, 'review attempt ID');
      assertText(input.reviewerSessionId, 'reviewer session ID');
      assertText(input.implementationAttemptId, 'implementation attempt ID');
      if (attemptId === input.implementationAttemptId || input.reviewerSessionId === input.implementationAttemptId) {
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

    const invocation: ImplementationReviewInvocation = {
      attemptId, operation: input.operation, mode: input.mode, reviewerSessionId: input.reviewerSessionId,
      targetRevision: input.targetRevision, targetFingerprint: input.targetFingerprint,
      closureRequestSha256: input.closureRequestSha256,
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
          operation: input.operation, mode: input.mode, targetRevision: input.targetRevision,
          targetFingerprint: input.targetFingerprint, reviewerSessionId: input.reviewerSessionId,
          closureRequestSha256: input.closureRequestSha256,
          fixedRepairFindingIds: input.fixedRepairFindings.map((finding) => finding.id).sort(),
          mandatoryCoverage: [...input.mandatoryCoverage].sort(),
        },
        onPrepared: () => input.onPrepared(structuredClone(invocation)),
        onLaunched: ({ pid, processGroupId }) => input.onLaunched({ ...structuredClone(invocation), pid, processGroupId }),
      });
    } catch {
      return { kind: 'internal-error', code: 'review-operation-threw' };
    }
    return mapResult(result);
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
    mandatoryCoverage: sortedUnique(input.mandatoryCoverage, 'mandatory coverage'),
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

function mapResult(result: ContainedReportOperationResult): ImplementationReviewerResult {
  if (result.status === 'completed') return {
    kind: 'completed', attemptId: result.attemptId, report: result.validatedPayload as CodeReviewReportV1,
    artifactSha256: result.artifactSha256,
  };
  if (result.status === 'retryable') return { kind: 'transport-failed', resumable: true };
  if (result.status === 'safe-halt') return { kind: 'safe-halt', process: result.process, waitForAbsence: result.waitForAbsence };
  if (result.status === 'cancelled') return { kind: 'cancelled' };
  if (result.status === 'invalid' && result.repairInput) return {
    kind: 'report-invalid',
    diagnostic: result.findings[0] ?? 'review report is invalid',
    originalReportSha256: result.repairInput.originalReportSha256,
    originalReportBytes: Buffer.from(result.repairInput.originalReportBytes),
  };
  return { kind: 'internal-error', code: result.status === 'invalid' ? 'review-report-invalid' : result.code };
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
