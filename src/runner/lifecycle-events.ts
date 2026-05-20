import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexPhase } from '../config/schema.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { RunnerMode } from './issue-state-machine.js';

export type LifecycleEventStatus = 'started' | 'completed' | 'needs-rework' | 'blocked' | 'failed' | 'skipped';
export type LifecycleArtifactKind =
  | 'prompt'
  | 'report'
  | 'log'
  | 'snapshot'
  | 'pr'
  | 'durable-summary'
  | 'other';

export interface LifecycleArtifact {
  kind: LifecycleArtifactKind;
  path?: string;
  url?: string;
  description?: string;
}

export interface RunnerLifecycleEvent {
  version: 1;
  id: string;
  timestamp: string;
  issueNumber: number;
  parentIssueNumber?: number;
  mode: RunnerMode;
  sessionId?: string;
  phase: CodexPhase;
  status: LifecycleEventStatus;
  summary: string;
  artifacts?: LifecycleArtifact[];
}

export interface AppendLifecycleEventInput {
  timestamp?: Date;
  issueNumber: number;
  parentIssueNumber?: number;
  mode: RunnerMode;
  sessionId?: string;
  phase: CodexPhase;
  status: LifecycleEventStatus;
  summary: string;
  artifacts?: LifecycleArtifact[];
}

export class RunnerLifecycleEventStore {
  public constructor(
    private readonly targetRoot: string,
    private readonly config: CodexOrchestratorConfig,
  ) {}

  public eventsPath(): string {
    return join(this.targetRoot, this.config.runner.stateDir, 'events', 'runner-events.jsonl');
  }

  public async append(input: AppendLifecycleEventInput): Promise<RunnerLifecycleEvent> {
    const event: RunnerLifecycleEvent = {
      version: 1,
      id: randomUUID(),
      timestamp: (input.timestamp ?? new Date()).toISOString(),
      issueNumber: input.issueNumber,
      parentIssueNumber: input.parentIssueNumber,
      mode: input.mode,
      sessionId: input.sessionId,
      phase: input.phase,
      status: input.status,
      summary: input.summary,
      artifacts: sanitizeArtifacts(input.artifacts),
    };
    const path = this.eventsPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  public async readRecent(limit = 20): Promise<RunnerLifecycleEvent[]> {
    let content = '';
    try {
      content = await readFile(this.eventsPath(), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line, index) => parseEventLine(line).map((event) => ({ event, index })))
      .sort((left, right) => {
        const timestampOrder = right.event.timestamp.localeCompare(left.event.timestamp);
        return timestampOrder === 0 ? right.index - left.index : timestampOrder;
      })
      .map((entry) => entry.event)
      .slice(0, limit);
  }
}

function parseEventLine(line: string): RunnerLifecycleEvent[] {
  try {
    const parsed = JSON.parse(line) as unknown;
    assertLifecycleEvent(parsed);
    return [normalizeEvent(parsed)];
  } catch {
    return [];
  }
}

function assertLifecycleEvent(value: unknown): asserts value is RunnerLifecycleEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('event must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.id !== 'string'
    || typeof record.timestamp !== 'string'
    || !Number.isInteger(record.issueNumber)
    || typeof record.mode !== 'string'
    || typeof record.phase !== 'string'
    || typeof record.status !== 'string'
    || typeof record.summary !== 'string'
  ) {
    throw new Error('event is malformed');
  }
}

function normalizeEvent(event: RunnerLifecycleEvent): RunnerLifecycleEvent {
  return {
    version: 1,
    id: event.id,
    timestamp: event.timestamp,
    issueNumber: event.issueNumber,
    parentIssueNumber: event.parentIssueNumber,
    mode: event.mode,
    sessionId: event.sessionId,
    phase: event.phase,
    status: event.status,
    summary: event.summary,
    artifacts: sanitizeArtifacts(event.artifacts),
  };
}

function sanitizeArtifacts(artifacts: LifecycleArtifact[] | undefined): LifecycleArtifact[] | undefined {
  if (!artifacts || artifacts.length === 0) {
    return undefined;
  }
  return artifacts.map((artifact) => ({
    kind: artifact.kind,
    path: artifact.path,
    url: artifact.url,
    description: artifact.description,
  }));
}
