import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexOrchestratorConfig, CodexPhase } from '../config/schema.js';
import { resolveCodexProfile } from '../codex/command-adapter.js';
import type { GitHubIssue } from '../github/issues.js';
import type { RunnerMode } from './issue-state-machine.js';

export interface WriteContextSnapshotInput {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  mode: RunnerMode;
  phase: CodexPhase;
  decision: string;
  sessionId: string;
  worktreePath: string;
  promptPath: string;
  reportPath: string;
  logPath: string;
  branchName: string;
  baseBranch: string;
  headSha?: string;
  parentIssueNumber?: number;
  blockedBy?: number[];
  children?: number[];
  createdAt?: Date;
}

export interface ContextSnapshotEvidence {
  path: string;
}

export async function writeContextSnapshot(input: WriteContextSnapshotInput): Promise<ContextSnapshotEvidence> {
  const snapshotPath = contextSnapshotPath(input);
  const selectedProfile = resolveCodexProfile(input.config, input.phase);
  const snapshot = {
    version: 1,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    issue: {
      number: input.issue.number,
      title: input.issue.title,
      bodySummary: summarize(input.issue.body),
      labels: input.issue.labels.map((label) => label.name),
      commentSummaries: input.issue.comments.slice(0, 3).map((comment) => ({
        id: comment.id,
        author: comment.author.login,
        createdAt: comment.createdAt,
        summary: summarize(comment.body),
      })),
    },
    runner: {
      mode: input.mode,
      phase: input.phase,
      decision: input.decision,
      selectedProfile: {
        phase: selectedProfile.phase,
        command: selectedProfile.command,
        args: selectedProfile.args,
        timeoutMs: selectedProfile.timeoutMs,
        idleTimeoutMs: selectedProfile.idleTimeoutMs,
        envKeys: Object.keys(selectedProfile.env).sort(),
      },
      publicationBoundaries: [
        'Runner owns GitHub labels, pushes, pull requests, and publication gates.',
        'Codex may only work inside the runner-prepared workspace and write the configured report.',
      ],
    },
    repository: {
      targetRoot: input.targetRoot,
      baseBranch: input.baseBranch,
      branchName: input.branchName,
      headSha: input.headSha,
    },
    session: {
      sessionId: input.sessionId,
      worktreePath: input.worktreePath,
      promptPath: input.promptPath,
      reportPath: input.reportPath,
      logPath: input.logPath,
    },
    dependencies: {
      parentIssueNumber: input.parentIssueNumber,
      blockedBy: input.blockedBy ?? [],
      children: input.children ?? [],
    },
    config: {
      version: input.config.version,
      hash: createHash('sha256').update(JSON.stringify(input.config)).digest('hex').slice(0, 16),
    },
    artifacts: {
      promptPath: input.promptPath,
      reportPath: input.reportPath,
      logPath: input.logPath,
    },
  };
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return { path: snapshotPath };
}

function contextSnapshotPath(input: WriteContextSnapshotInput): string {
  return join(input.targetRoot, input.config.runner.stateDir, 'snapshots', `issue-${input.issue.number}-${input.sessionId}.json`);
}

function summarize(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 497)}...`;
}
