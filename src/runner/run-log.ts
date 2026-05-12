import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';

export function sessionLogPath(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issueNumber: number;
  sessionId: string;
}): string {
  return join(
    input.targetRoot,
    input.config.runner.stateDir,
    'logs',
    `issue-${input.issueNumber}-${input.sessionId}.log`,
  );
}

export class RunLogWriter {
  public constructor(private readonly logPath: string) {}

  public async appendStdout(chunk: string): Promise<void> {
    await this.append(renderCodexStreamChunk(chunk, 'stdout').join(''));
  }

  public async appendStderr(chunk: string): Promise<void> {
    await this.append(renderCodexStreamChunk(chunk, 'stderr').join(''));
  }

  public async appendLifecycle(message: string): Promise<void> {
    await this.append(`[lifecycle] ${message}\n`);
  }

  public async close(): Promise<void> {
    await this.appendLifecycle('log closed');
  }

  private async append(content: string): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, content, 'utf8');
  }
}

export function renderCodexStreamChunk(chunk: string, stream: 'stdout' | 'stderr'): string[] {
  return chunk.split(/(?<=\n)/u).filter((line) => line.length > 0).map((line) => renderCodexStreamLine(line, stream));
}

function renderCodexStreamLine(line: string, stream: 'stdout' | 'stderr'): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return `[${stream}] ${line}`;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return `[${stream}] ${line}`;
    }
    const record = parsed as Record<string, unknown>;
    const eventType = readString(record.type) ?? readString(record.event) ?? 'codex-event';
    const text = readString(record.message) ?? readString(record.delta) ?? readString(record.text);
    return text ? `[${stream}] ${eventType}: ${text}\n` : `[${stream}] ${eventType}: ${trimmed}\n`;
  } catch {
    return `[${stream}] ${line}`;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
