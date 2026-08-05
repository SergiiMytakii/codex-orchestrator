import { canonicalJson, containsCredentialEvidence, sha256 } from './containment.js';
import { decodeAgentReportForValidation } from './report-envelope.js';
import {
  hashCodeReviewReport,
  validateCodeReviewReport,
  type CodeReviewValidationContext,
} from './code-review-report.js';
import type {
  WorkflowExecutionProfile,
  WorkflowGenerationReceipt,
  WorkflowOperationPolicy,
} from './workflow-assets.js';

const MAX_STRING_LENGTH = 16 * 1024;
const POLICY_KEYS = [
  'sandboxMode', 'cwdClass', 'worktreeAccess', 'writableRootClasses', 'runnerPostcondition',
  'network', 'networkHosts', 'mcpTools', 'approvalCeiling', 'externalWrite',
] as const;

export type ContainedReportOperationId = 'code-review';

export interface ContainedReportOperationInput {
  operation: ContainedReportOperationId;
  attemptId: string;
  runId: string;
  worktreePath: string;
  workflowGeneration: WorkflowGenerationReceipt;
  promptFacts: string[];
  signal: AbortSignal;
  reviewContext?: CodeReviewValidationContext;
  onPrepared?: () => Promise<void>;
  onLaunched?: (identity: { pid: number; processGroupId: number }) => Promise<void>;
}

export type ContainedReportOperationResult =
  | { status: 'completed'; attemptId: string; validatedPayload: unknown; artifactSha256: string }
  | { status: 'invalid'; attemptId: string; findings: string[]; repairInput?: { originalReportSha256: string; originalReportBytes: Buffer } }
  | { status: 'retryable'; code: string }
  | {
    status: 'safe-halt';
    process: { pid: number; processGroupId: number; startedAt: string; baseline: ReportOnlyWorktreeSnapshot };
  }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety'; code: string };

export interface ContainedReportOperation {
  run(input: ContainedReportOperationInput): Promise<ContainedReportOperationResult>;
}

export interface ReportOnlyWorktreeSnapshot {
  headSha: string;
  indexTreeSha: string;
  trackedContentSha256: string;
  untrackedContentSha256: string;
  worktreeIdentity: string;
}

export interface PreparedContainedReportAttempt {
  operation: ContainedReportOperationId;
  generationHash: string;
  policy: WorkflowOperationPolicy;
  workflowRoot?: string;
  operationPath?: string;
  schemaPath?: string;
  reportPath?: string;
  toolHome?: string;
  tmpDir?: string;
  profile?: WorkflowExecutionProfile;
}

export type ContainedReportLaunchResult =
  | { status: 'completed'; reportBytes: Buffer }
  | { status: 'retryable'; code: string }
  | { status: 'safe-halt'; pid: number; processGroupId: number; startedAt: string }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety'; code: string };

export interface ContainedReportOperationDependencies {
  prepare(input: {
    operation: ContainedReportOperationId;
    attemptId: string;
    runId: string;
    workflowGeneration: WorkflowGenerationReceipt;
  }): Promise<PreparedContainedReportAttempt>;
  snapshot(worktreePath: string): Promise<unknown>;
  launch(input: ContainedReportOperationInput & {
    attempt: PreparedContainedReportAttempt;
  }): Promise<ContainedReportLaunchResult>;
}

export class InjectedContainedReportOperation implements ContainedReportOperation {
  constructor(private readonly dependencies: ContainedReportOperationDependencies) {}

  async run(input: ContainedReportOperationInput): Promise<ContainedReportOperationResult> {
    let before: ReportOnlyWorktreeSnapshot;
    try {
      before = requireReportSnapshot(await this.dependencies.snapshot(input.worktreePath));
    } catch {
      return { status: 'blocked', kind: 'safety', code: 'report-operation-snapshot-failed' };
    }

    let attempt: PreparedContainedReportAttempt;
    try {
      attempt = await this.dependencies.prepare({
        operation: input.operation,
        attemptId: input.attemptId,
        runId: input.runId,
        workflowGeneration: input.workflowGeneration,
      });
    } catch {
      return this.finishWithSnapshot(input.worktreePath, before, {
        status: 'blocked', kind: 'external', code: 'report-operation-prepare-failed',
      });
    }

    let launchResult: ContainedReportLaunchResult;
    if (!hasExactReadOnlyAuthority(attempt, input)) {
      launchResult = { status: 'blocked', kind: 'safety', code: 'report-operation-authority-drift' };
    } else {
      if (isImplementationReview(input.operation)) {
        if (!input.reviewContext || !input.onPrepared || !input.onLaunched) {
          return this.finishWithSnapshot(input.worktreePath, before, {
            status: 'blocked', kind: 'safety', code: 'review-operation-launch-gate-missing',
          });
        }
        try {
          await input.onPrepared();
        } catch {
          return this.finishWithSnapshot(input.worktreePath, before, {
            status: 'blocked', kind: 'safety', code: 'review-operation-prepare-persistence-failed',
          });
        }
      }
      try {
        launchResult = await this.dependencies.launch({ ...input, attempt });
      } catch {
        launchResult = { status: 'blocked', kind: 'external', code: 'report-operation-launch-failed' };
      }
    }

    if (launchResult.status === 'safe-halt') {
      return {
        status: 'safe-halt',
        process: {
          pid: launchResult.pid,
          processGroupId: launchResult.processGroupId,
          startedAt: launchResult.startedAt,
          baseline: structuredClone(before),
        },
      };
    }
    return this.finishWithSnapshot(input.worktreePath, before, launchResult, input);
  }

  private async finishWithSnapshot(
    worktreePath: string,
    before: ReportOnlyWorktreeSnapshot,
    launchResult: Exclude<ContainedReportLaunchResult, { status: 'safe-halt' }>,
    input?: ContainedReportOperationInput,
  ): Promise<ContainedReportOperationResult> {
    let after: ReportOnlyWorktreeSnapshot;
    try {
      after = requireReportSnapshot(await this.dependencies.snapshot(worktreePath));
    } catch {
      return { status: 'blocked', kind: 'safety', code: 'report-operation-snapshot-failed' };
    }
    if (!sameSnapshot(before, after)) {
      return { status: 'blocked', kind: 'safety', code: 'report-operation-worktree-mutated' };
    }

    if (launchResult.status !== 'completed') return launchResult;
    if (!input) return { status: 'blocked', kind: 'external', code: 'report-operation-prepare-failed' };
    return validateCompletedReport(input.operation, input.attemptId, launchResult.reportBytes, input.reviewContext);
  }
}

function hasExactReadOnlyAuthority(
  attempt: PreparedContainedReportAttempt,
  input: ContainedReportOperationInput,
): boolean {
  const policy = attempt.policy;
  return attempt.operation === input.operation
    && attempt.generationHash === input.workflowGeneration.generationHash
    && hasExactKeys(policy, POLICY_KEYS)
    && policy.sandboxMode === 'read-only'
    && policy.cwdClass === 'worktree'
    && policy.worktreeAccess === 'read-only'
    && Array.isArray(policy.writableRootClasses)
    && policy.writableRootClasses.length === 0
    && policy.runnerPostcondition === 'report-only'
    && policy.network === 'deny'
    && Array.isArray(policy.networkHosts)
    && policy.networkHosts.length === 0
    && Array.isArray(policy.mcpTools)
    && policy.mcpTools.length === 0
    && policy.approvalCeiling === 'never'
    && policy.externalWrite === false;
}

export function validateCompletedReport(
  operation: ContainedReportOperationId,
  attemptId: string,
  reportBytes: Buffer,
  reviewContext?: CodeReviewValidationContext,
): ContainedReportOperationResult {
  const rawText = reportBytes.toString('utf8');
  const repairable = Buffer.from(rawText, 'utf8').equals(reportBytes)
    && !containsCredentialEvidence(rawText);
  try {
    if (!Buffer.from(rawText, 'utf8').equals(reportBytes) || containsCredentialEvidence(rawText)) {
      throw new Error('report payload contains forbidden credential material');
    }
    const decoded = decodeAgentReportForValidation(reportBytes);
    const reviewReport = inputReview(operation, inputReviewContext(reviewContext), decoded);
    const validatedPayload: unknown = reviewReport;
    const artifactSha256 = hashCodeReviewReport(reviewReport);
    return {
      status: 'completed',
      attemptId,
      validatedPayload,
      artifactSha256,
    };
  } catch (error) {
    return {
      status: 'invalid',
      attemptId,
      findings: [safeFinding(error)],
      ...(repairable ? { repairInput: { originalReportSha256: sha256(reportBytes), originalReportBytes: Buffer.from(reportBytes) } } : {}),
    };
  }
}

function isImplementationReview(operation: ContainedReportOperationId): operation is 'code-review' {
  return operation === 'code-review';
}

function inputReviewContext(context: CodeReviewValidationContext | undefined): CodeReviewValidationContext {
  if (!context) throw new Error('implementation review validation context is missing');
  return context;
}

function inputReview(
  operation: 'code-review',
  context: CodeReviewValidationContext,
  decoded: unknown,
) {
  if (context.operation !== operation) throw new Error('implementation review operation context mismatch');
  return validateCodeReviewReport(decoded, context);
}

function safeFinding(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, MAX_STRING_LENGTH)
    : 'report payload validation failed';
}

function sameSnapshot(left: ReportOnlyWorktreeSnapshot, right: ReportOnlyWorktreeSnapshot): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireReportSnapshot(value: unknown): ReportOnlyWorktreeSnapshot {
  const keys = ['headSha', 'indexTreeSha', 'trackedContentSha256', 'untrackedContentSha256', 'worktreeIdentity'] as const;
  if (!hasExactKeys(value, keys)) throw new Error('report-operation snapshot is invalid');
  for (const key of keys) {
    if (typeof (value as Record<string, unknown>)[key] !== 'string') throw new Error('report-operation snapshot is invalid');
  }
  return value as ReportOnlyWorktreeSnapshot;
}
