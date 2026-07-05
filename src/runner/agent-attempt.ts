import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CodexCommandRunInput, CodexCommandRunResult } from '../codex/command-adapter.js';
import type { CodexPhase, CodexOrchestratorConfig } from '../config/schema.js';
import type { ResolvedBaseBranch } from '../git/base-branch.js';
import type { GitWorktreeManager } from '../git/worktree.js';
import type { GitHubIssue } from '../github/issues.js';
import type { ShellCommandExecutor } from '../process/command.js';
import { formatSessionTimestamp } from './command-utils.js';
import { writeContextSnapshot } from './context-snapshot.js';
import type { ReworkAttemptEvidence } from './durable-run-summary.js';
import type { RunnerMode } from './issue-state-machine.js';
import {
  runImplementationPublishabilityCheck,
  type ImplementationPublishabilityInput,
  type ImplementationPublishabilityResult,
  type LocalExecutionPhaseExecutor,
} from './local-execution-session.js';
import { RunnerLifecycleEventStore, type LifecycleArtifact } from './lifecycle-events.js';
import { RunnerStateStore, type RunnerProcessMetadata } from './local-state.js';
import { sessionPromptPath, sessionReportPath, writeDurablePrompt } from './prompt.js';
import { decideImplementationRework } from './rework-policy.js';
import { sessionLogPath } from './run-log.js';
import { cleanupSessionCodexHome, sessionCodexHomePath } from './session-home.js';

export interface AgentAttemptPromptInput {
  attempt: number;
  attemptNow: Date;
  sessionId: string;
  promptPath: string;
  reportPath: string;
  logPath: string;
  rework?: AgentAttemptRework;
}

export interface AgentAttemptRework {
  attempt: number;
  blockedReasons: string[];
  disableOptionalFigmaMcp?: boolean;
}

export interface AgentAttemptLoopInput {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  issueNumber: number;
  parentIssueNumber?: number;
  mode: Extract<RunnerMode, 'scoped-issue' | 'tree-child'>;
  phase: Extract<CodexPhase, 'scoped-issue' | 'tree-child'>;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
  base?: ResolvedBaseBranch | { branch: string; sha?: string };
  createdAt: Date;
  firstAttempt?: number;
  initialRework?: AgentAttemptRework;
  buildSessionId: (input: { attempt: number; attemptNow: Date }) => string;
  buildPrompt: (input: AgentAttemptPromptInput) => string;
  buildSnapshotDecision: (input: { rework?: AgentAttemptRework }) => string;
  startedSummary: (input: { rework?: AgentAttemptRework }) => string;
  reworkScheduledSummary: (input: { nextAttempt: number }) => string;
  reworkEventPhase?: CodexPhase;
  missingPublishabilityMessage?: string;
  codexAdapter: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> };
  codexTimeoutMs?: number;
  git: Pick<GitWorktreeManager, 'getHead'> & ImplementationPublishabilityInput['git'];
  shellExecutor: ShellCommandExecutor;
  commitMessage: string;
  events: RunnerLifecycleEventStore;
  localPhases?: string[];
  localPhaseExecutor?: LocalExecutionPhaseExecutor;
  acceptanceProof?: Omit<NonNullable<ImplementationPublishabilityInput['acceptanceProof']>, 'sessionId' | 'branchName' | 'onAttemptEvent'>;
  onAcceptanceProofAttemptEvent?: (input: {
    sessionId: string;
    event: AcceptanceProofAttemptEvent;
  }) => Promise<void>;
  runMetadata?: (input: { attempt: number; attemptNow: Date; sessionId: string; promptPath: string; reportPath: string; logPath: string; snapshotPath: string }) => Partial<RunnerProcessMetadata>;
  publishabilityEvent?: (input: { publishability: ImplementationPublishabilityResult }) => {
    phase: CodexPhase;
    status: 'completed' | 'blocked';
    summary: string;
  };
}

type AcceptanceProofAttemptEvent =
  Parameters<NonNullable<NonNullable<ImplementationPublishabilityInput['acceptanceProof']>['onAttemptEvent']>>[0];

export interface AgentAttemptLoopResult {
  publishability: ImplementationPublishabilityResult;
  sessionId: string;
  promptPath: string;
  reportPath: string;
  logPath: string;
  snapshotPath: string;
  reworkAttempts: ReworkAttemptEvidence[];
  lastAttemptStartedAt: Date;
}

export async function runAgentAttemptLoop(input: AgentAttemptLoopInput): Promise<AgentAttemptLoopResult> {
  const store = new RunnerStateStore(input.targetRoot, input.config);
  const maxReworkAttempts = Math.max(
    input.config.loopPolicy.rework.maxAttempts,
    input.config.reviewGates.acceptanceProof.maxIterations - 1,
  );
  const reworkAttempts: ReworkAttemptEvidence[] = [];
  const reworkEventPhase = input.reworkEventPhase ?? input.phase;
  let rework = input.initialRework;
  let publishability: ImplementationPublishabilityResult | undefined;
  let sessionId = '';
  let promptPath = '';
  let reportPath = '';
  let logPath = '';
  let snapshotPath = '';
  let lastAttemptStartedAt = input.createdAt;

  for (let attempt = input.firstAttempt ?? 0; attempt <= maxReworkAttempts; attempt++) {
    const attemptNow = new Date(input.createdAt.getTime() + attempt);
    lastAttemptStartedAt = attemptNow;
    sessionId = input.buildSessionId({ attempt, attemptNow });
    promptPath = sessionPromptPath({ targetRoot: input.targetRoot, config: input.config, issueNumber: input.issueNumber, sessionId });
    reportPath = sessionReportPath({ targetRoot: input.targetRoot, config: input.config, issueNumber: input.issueNumber, sessionId });
    logPath = sessionLogPath({ targetRoot: input.targetRoot, config: input.config, issueNumber: input.issueNumber, sessionId });
    const isolatedHomePath = sessionCodexHomePath({ targetRoot: input.targetRoot, sessionId });
    await mkdir(dirname(reportPath), { recursive: true });
    await mkdir(isolatedHomePath, { recursive: true });
    const promptText = input.buildPrompt({
      attempt,
      attemptNow,
      sessionId,
      promptPath,
      reportPath,
      logPath,
      rework,
    });
    await writeDurablePrompt({
      targetRoot: input.targetRoot,
      config: input.config,
      issueNumber: input.issueNumber,
      sessionId,
      promptText,
    });
    const snapshot = await writeContextSnapshot({
      targetRoot: input.targetRoot,
      config: input.config,
      issue: input.issue,
      mode: input.mode,
      phase: input.phase,
      decision: input.buildSnapshotDecision({ rework }),
      sessionId,
      worktreePath: input.worktreePath,
      promptPath,
      reportPath,
      logPath,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      base: input.base,
      parentIssueNumber: input.parentIssueNumber,
      blockedBy: input.parentIssueNumber ? [] : undefined,
      createdAt: attemptNow,
    });
    snapshotPath = snapshot.path;
    await store.upsertRun({
      issueNumber: input.issueNumber,
      mode: input.mode,
      workspacePath: input.worktreePath,
      sessionId,
      branchName: input.branchName,
      promptPath,
      reportPath,
      logPath,
      retryCount: attempt,
      createdAt: input.createdAt.toISOString(),
      updatedAt: attemptNow.toISOString(),
      attemptStartedAt: attemptNow.toISOString(),
      snapshotPath,
      ...(input.parentIssueNumber ? { parentIssueNumber: input.parentIssueNumber } : {}),
      ...input.runMetadata?.({ attempt, attemptNow, sessionId, promptPath, reportPath, logPath, snapshotPath }),
    });
    await safeAppendEvent(input.events, {
      timestamp: attemptNow,
      issueNumber: input.issueNumber,
      parentIssueNumber: input.parentIssueNumber,
      mode: input.mode,
      sessionId,
      phase: input.phase,
      status: 'started',
      summary: input.startedSummary({ rework }),
      artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshotPath),
    });

    const beforeHead = await input.git.getHead(input.worktreePath);
    let codexResult: CodexCommandRunResult;
    try {
      codexResult = await input.codexAdapter.run({
        targetRoot: input.targetRoot,
        config: input.config,
        worktreePath: input.worktreePath,
        promptPath,
        promptText,
        reportPath,
        isolatedHomePath,
        issueNumber: input.issueNumber,
        sessionId,
        branchName: input.branchName,
        phase: input.phase,
        timeoutMs: input.codexTimeoutMs,
        logPath,
        disableOptionalFigmaMcp: rework?.disableOptionalFigmaMcp,
      });
    } finally {
      await cleanupSessionCodexHome(isolatedHomePath);
    }
    const afterHead = await input.git.getHead(input.worktreePath);
    publishability = await runImplementationPublishabilityCheck({
      config: input.config,
      issue: input.issue,
      targetRoot: input.targetRoot,
      worktreePath: input.worktreePath,
      reportPath,
      beforeHead,
      afterHead,
      codexResult,
      git: input.git,
      shellExecutor: input.shellExecutor,
      commitMessage: input.commitMessage,
      localPhases: input.localPhases,
      localPhaseExecutor: input.localPhaseExecutor,
      acceptanceProof: input.acceptanceProof
        ? {
            ...input.acceptanceProof,
            sessionId,
            branchName: input.branchName,
            onAttemptEvent: input.onAcceptanceProofAttemptEvent
              ? (event) => input.onAcceptanceProofAttemptEvent!({ sessionId, event })
              : undefined,
          }
        : undefined,
    });

    const publishabilityEvent = input.publishabilityEvent?.({ publishability });
    if (publishabilityEvent) {
      await safeAppendEvent(input.events, {
        issueNumber: input.issueNumber,
        parentIssueNumber: input.parentIssueNumber,
        mode: input.mode,
        sessionId,
        phase: publishabilityEvent.phase,
        status: publishabilityEvent.status,
        summary: publishabilityEvent.summary,
        artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshotPath),
      });
    }

    if (publishability.status === 'blocked') {
      const reworkDecision = decideImplementationRework({
        reasons: publishability.reasons,
        config: input.config,
        attempt,
      });
      reworkAttempts.push({
        attempt,
        maxAttempts: 'maxAttempts' in reworkDecision ? reworkDecision.maxAttempts : undefined,
        decisionKind: reworkDecision.kind,
        reasons: publishability.reasons,
        promptPath,
        reportPath,
        logPath,
        snapshotPath,
      });
      if (reworkDecision.kind === 'retry') {
        rework = reworkDecision.rework;
        await safeAppendEvent(input.events, {
          timestamp: attemptNow,
          issueNumber: input.issueNumber,
          parentIssueNumber: input.parentIssueNumber,
          mode: input.mode,
          sessionId,
          phase: reworkEventPhase,
          status: 'needs-rework',
          summary: input.reworkScheduledSummary({ nextAttempt: reworkDecision.nextAttempt }),
          artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshotPath),
        });
        continue;
      }
      await safeAppendEvent(input.events, {
        timestamp: attemptNow,
        issueNumber: input.issueNumber,
        parentIssueNumber: input.parentIssueNumber,
        mode: input.mode,
        sessionId,
        phase: reworkEventPhase,
        status: 'blocked',
        summary: `Runner rework decision: ${reworkDecision.kind}.`,
        artifacts: sessionArtifacts(promptPath, reportPath, logPath, snapshotPath),
      });
    }
    break;
  }

  if (!publishability) {
    throw new Error(input.missingPublishabilityMessage ?? 'Runner internal error: missing agent attempt publishability result');
  }

  return {
    publishability,
    sessionId,
    promptPath,
    reportPath,
    logPath,
    snapshotPath,
    reworkAttempts,
    lastAttemptStartedAt,
  };
}

function sessionArtifacts(
  promptPath: string,
  reportPath: string,
  logPath: string,
  snapshotPath?: string,
): LifecycleArtifact[] {
  const artifacts: Array<LifecycleArtifact | undefined> = [
    snapshotPath ? { kind: 'snapshot', path: snapshotPath, description: 'Context snapshot' } : undefined,
    promptPath ? { kind: 'prompt', path: promptPath, description: 'Session prompt path' } : undefined,
    reportPath ? { kind: 'report', path: reportPath, description: 'Session report path' } : undefined,
    logPath ? { kind: 'log', path: logPath, description: 'Session log path' } : undefined,
  ];
  return artifacts.filter((artifact): artifact is LifecycleArtifact => Boolean(artifact));
}

async function safeAppendEvent(
  store: RunnerLifecycleEventStore,
  input: Parameters<RunnerLifecycleEventStore['append']>[0],
): Promise<void> {
  try {
    await store.append(input);
  } catch {
    // Lifecycle evidence must not create a new publication blocker after runner gates pass.
  }
}
