import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { RunnerMode } from './issue-state-machine.js';

export interface RunnerProcessMetadata {
  issueNumber: number;
  mode: RunnerMode;
  workspacePath: string;
  sessionId: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  lastRecoveredAt?: string;
}

export interface RunnerStateFile {
  version: 1;
  runs: RunnerProcessMetadata[];
}

export class RunnerStateStore {
  public constructor(
    private readonly targetRoot: string,
    private readonly config: CodexOrchestratorConfig,
  ) {}

  public statePath(): string {
    return join(this.targetRoot, this.config.runner.stateDir, 'runner-state.json');
  }

  public async load(): Promise<RunnerStateFile> {
    try {
      const content = await readFile(this.statePath(), 'utf8');
      const parsed = JSON.parse(content) as unknown;
      assertValidStateFile(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, runs: [] };
      }
      throw error;
    }
  }

  public async save(state: RunnerStateFile): Promise<void> {
    assertValidStateFile(state);
    const path = this.statePath();
    await mkdir(dirname(path), { recursive: true });
    const tempPath = join(dirname(path), `.runner-state.json.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, path);
  }

  public async upsertRun(metadata: RunnerProcessMetadata): Promise<void> {
    assertValidRun(metadata);
    const state = await this.load();
    const existingIndex = state.runs.findIndex((run) => run.issueNumber === metadata.issueNumber);
    if (existingIndex >= 0) {
      state.runs[existingIndex] = metadata;
    } else {
      state.runs.push(metadata);
    }
    state.runs.sort((left, right) => left.issueNumber - right.issueNumber);
    await this.save(state);
  }

  public async removeRun(issueNumber: number): Promise<void> {
    const state = await this.load();
    await this.save({
      version: 1,
      runs: state.runs.filter((run) => run.issueNumber !== issueNumber),
    });
  }
}

const stateFileKeys = new Set(['version', 'runs']);
const runKeys = new Set([
  'issueNumber',
  'mode',
  'workspacePath',
  'sessionId',
  'retryCount',
  'createdAt',
  'updatedAt',
  'lastRecoveredAt',
]);

function assertValidStateFile(value: unknown): asserts value is RunnerStateFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('runner state must be an object');
  }
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, stateFileKeys, 'runner state');
  if (record.version !== 1) {
    throw new Error('runner state version must be 1');
  }
  if (!Array.isArray(record.runs)) {
    throw new Error('runner state runs must be an array');
  }
  for (const run of record.runs) {
    assertValidRun(run);
  }
}

function assertValidRun(value: unknown): asserts value is RunnerProcessMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('runner metadata must be an object');
  }
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, runKeys, 'runner metadata');
  if (!Number.isInteger(record.issueNumber)) {
    throw new Error('runner metadata issueNumber must be an integer');
  }
  if (record.mode !== 'scoped-issue' && record.mode !== 'plan-parent') {
    throw new Error('runner metadata mode must be scoped-issue or plan-parent');
  }
  for (const key of ['workspacePath', 'sessionId', 'createdAt', 'updatedAt']) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      throw new Error(`runner metadata ${key} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(record.retryCount)) {
    throw new Error('runner metadata retryCount must be an integer');
  }
  if ('lastRecoveredAt' in record && typeof record.lastRecoveredAt !== 'string') {
    throw new Error('runner metadata lastRecoveredAt must be a string');
  }
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: Set<string>, context: string): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${context} contains forbidden key ${unknownKeys[0]}`);
  }
}
