import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { CodexOrchestratorConfig, TargetExecutionPolicyV2 } from '../config/schema.js';
import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';
import type { RuntimeSkillBundleManifestV1 } from '../skills/package-skill-bundle.js';
import { applyNodeControlEnvelope, type GraphProgressRecordV2, type NodeControlEnvelopeV1 } from '../skills/package-skill-graph.js';
import type { RunnerMode } from './issue-state-machine.js';
import { acquireMissionCoordinatorLock } from './mission-coordinator-lock.js';

const execFileAsync = promisify(execFile);

export interface RunnerProcessMetadata {
  issueNumber: number;
  mode: RunnerMode;
  parentIssueNumber?: number;
  workspacePath: string;
  sessionId: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  lastRecoveredAt?: string;
  branchName?: string;
  promptPath?: string;
  reportPath?: string;
  logPath?: string;
  ownerPid?: number;
  host?: string;
  leaseUpdatedAt?: string;
  attemptStartedAt?: string;
  baseSha?: string;
  snapshotPath?: string;
}

export interface SkillRuntimeRecordV2 {
  packageVersion: string;
  bundleHash: string;
  bundleRoot: string;
  operationId: string;
  entrySkillPath: string;
}

export interface RunnerProcessMetadataV2 extends RunnerProcessMetadata {
  stateVersion: 2;
  runId: string;
  skillRuntime: SkillRuntimeRecordV2;
  executionPolicyHash: string;
  effectivePolicySummary: TargetExecutionPolicyV2;
  graph: GraphProgressRecordV2;
}

export interface RunnerStateFileV1 {
  version: 1;
  runs: RunnerProcessMetadata[];
}

export interface RunnerStateFileV2 {
  version: 2;
  generation: number;
  runs: Array<RunnerProcessMetadata | RunnerProcessMetadataV2>;
}

export type RunnerStateFile = RunnerStateFileV1 | RunnerStateFileV2;

interface RunnerStateLockDependencies {
  hostId?: string;
  bootNonce?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  waitTimeoutMs?: number;
}

export class RunnerStateStore {
  public constructor(
    private readonly targetRoot: string,
    private readonly config: CodexOrchestratorConfig,
    private readonly lockDependencies: RunnerStateLockDependencies = {},
  ) {}

  public statePath(): string {
    return join(this.targetRoot, this.config.runner.stateDir, 'runner-state.json');
  }

  public lockPath(): string {
    return join(this.targetRoot, this.config.runner.stateDir, 'runner-state.lock');
  }

  public async load(): Promise<RunnerStateFile> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath(), 'utf8')) as unknown;
      assertValidStateFile(parsed);
      return parsed;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return { version: 1, runs: [] };
      throw error;
    }
  }

  public async save(state: RunnerStateFile): Promise<void> {
    assertValidStateFile(state);
    await this.withLock(async () => {
      const current = await this.load();
      if (state.version === 2 && current.version === 2) {
        if (state.generation !== current.generation) throw new Error(`runner state stale generation: expected ${current.generation}, received ${state.generation}`);
        await this.saveUnlocked({ ...state, generation: current.generation + 1 });
        return;
      }
      await this.saveUnlocked(state);
    });
  }

  public async upsertRun(metadata: RunnerProcessMetadata | RunnerProcessMetadataV2): Promise<void> {
    assertValidRun(metadata);
    await this.withLock(async () => {
      const state = await this.load();
      const runs = [...state.runs];
      const existingIndex = runs.findIndex((run) => run.issueNumber === metadata.issueNumber);
      if (existingIndex >= 0) runs[existingIndex] = metadata;
      else runs.push(metadata);
      runs.sort((left, right) => left.issueNumber - right.issueNumber);
      await this.saveUnlocked(state.version === 2 ? { ...state, generation: state.generation + 1, runs } : { ...state, runs: runs as RunnerProcessMetadata[] });
    });
  }

  public async removeRun(issueNumber: number): Promise<void> {
    await this.withLock(async () => {
      const state = await this.load();
      const runs = state.runs.filter((run) => run.issueNumber !== issueNumber);
      await this.saveUnlocked(state.version === 2 ? { ...state, generation: state.generation + 1, runs } : { ...state, runs: runs as RunnerProcessMetadata[] });
    });
  }

  public async mutateV2(
    expectedGeneration: number,
    mutation: (state: RunnerStateFileV2) => Omit<RunnerStateFileV2, 'generation'> | RunnerStateFileV2,
  ): Promise<RunnerStateFileV2> {
    return this.withLock(async () => {
      const current = await this.load();
      if (current.version !== 2) throw new Error('runner state v2 mutation requires a v2 envelope');
      if (current.generation !== expectedGeneration) {
        throw new Error(`runner state stale generation: expected ${current.generation}, received ${expectedGeneration}`);
      }
      const proposed = mutation(structuredClone(current));
      const next: RunnerStateFileV2 = { ...proposed, version: 2, generation: current.generation + 1 };
      assertValidStateFile(next);
      await this.saveUnlocked(next);
      return next;
    });
  }

  public async mutateLatestV2(
    mutation: (state: RunnerStateFileV2) => Omit<RunnerStateFileV2, 'generation'> | RunnerStateFileV2,
  ): Promise<RunnerStateFileV2> {
    return this.withLock(async () => {
      const current = await this.load();
      if (current.version !== 2) throw new Error('runner state v2 mutation requires a v2 envelope');
      const proposed = mutation(structuredClone(current));
      const next: RunnerStateFileV2 = { ...proposed, version: 2, generation: current.generation + 1 };
      assertValidStateFile(next);
      await this.saveUnlocked(next);
      return next;
    });
  }

  public async transitionGraphV2(input: {
    expectedGeneration: number;
    runId: string;
    manifest: RuntimeSkillBundleManifestV1;
    envelope: NodeControlEnvelopeV1;
  }): Promise<RunnerStateFileV2> {
    return this.mutateV2(input.expectedGeneration, (state) => {
      let matched = false;
      const runs = state.runs.map((run) => {
        if (!('stateVersion' in run) || run.runId !== input.runId) return run;
        matched = true;
        let attemptIndex = -1;
        for (let index = run.graph.attempts.length - 1; index >= 0; index -= 1) {
          if (run.graph.attempts[index]?.nodeId === run.graph.currentNodeId) { attemptIndex = index; break; }
        }
        const attempt = run.graph.attempts[attemptIndex];
        const execution = attempt?.executions.at(-1);
        if (!attempt || !execution || execution.status !== 'terminal' || !execution.terminal || !execution.report.atomicWriteComplete || !execution.report.sha256) {
          throw new Error('runner graph transition requires accepted terminal attempt evidence');
        }
        const attempts = run.graph.attempts.map((candidate, index) => index === attemptIndex ? {
          ...candidate,
          status: 'reconciled' as const,
          executions: candidate.executions.map((item, executionIndex) => executionIndex === candidate.executions.length - 1 ? { ...item, status: 'reconciled' as const } : item),
        } : candidate);
        return { ...run, graph: applyNodeControlEnvelope(input.manifest, { ...run.graph, attempts }, input.envelope) };
      });
      if (!matched) throw new Error(`runner state v2 run ${input.runId} is unavailable`);
      return { ...state, runs };
    });
  }

  private async saveUnlocked(state: RunnerStateFile): Promise<void> {
    assertValidStateFile(state);
    await writeDurableAtomicFile(this.statePath(), `${JSON.stringify(state, null, 2)}\n`);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await acquireMissionCoordinatorLock({
      targetRoot: this.targetRoot,
      stateDir: this.config.runner.stateDir,
      lockName: 'runner-state.lock',
      description: 'Runner state',
      hostId: this.lockDependencies.hostId ?? hostname(),
      bootNonce: this.lockDependencies.bootNonce ?? await readSystemBootNonce(),
      pid: this.lockDependencies.pid,
      isProcessAlive: this.lockDependencies.isProcessAlive,
      waitTimeoutMs: this.lockDependencies.waitTimeoutMs ?? 5_000,
      pollIntervalMs: 25,
      bootNonceSemantics: 'system-boot',
    });
    try { return await operation(); } finally { await lock.release(); }
  }
}

const stateFileV1Keys = new Set(['version', 'runs']);
const stateFileV2Keys = new Set(['version', 'generation', 'runs']);
const legacyRunKeys = [
  'issueNumber', 'mode', 'parentIssueNumber', 'workspacePath', 'sessionId', 'retryCount', 'createdAt', 'updatedAt',
  'lastRecoveredAt', 'branchName', 'promptPath', 'reportPath', 'logPath', 'ownerPid', 'host', 'leaseUpdatedAt',
  'attemptStartedAt', 'baseSha', 'snapshotPath',
];
const runKeys = new Set(legacyRunKeys);
const runV2Keys = new Set([...legacyRunKeys, 'stateVersion', 'runId', 'skillRuntime', 'executionPolicyHash', 'effectivePolicySummary', 'graph']);

function assertValidStateFile(value: unknown): asserts value is RunnerStateFile {
  const record = requireRecord(value, 'runner state');
  if (record.version === 1) assertOnlyKeys(record, stateFileV1Keys, 'runner state');
  else if (record.version === 2) {
    assertOnlyKeys(record, stateFileV2Keys, 'runner state');
    if (!nonNegativeInteger(record.generation)) throw new Error('runner state generation must be a non-negative integer');
  } else throw new Error('runner state version must be 1 or 2');
  if (!Array.isArray(record.runs)) throw new Error('runner state runs must be an array');
  for (const run of record.runs) {
    assertValidRun(run);
    if (record.version === 1 && 'stateVersion' in (run as unknown as Record<string, unknown>)) throw new Error('runner state v1 cannot contain structural v2 metadata');
  }
}

function assertValidRun(value: unknown): asserts value is RunnerProcessMetadata | RunnerProcessMetadataV2 {
  const record = requireRecord(value, 'runner metadata');
  const structural = record.stateVersion === 2;
  assertOnlyKeys(record, structural ? runV2Keys : runKeys, 'runner metadata');
  assertLegacyFields(record);
  if (!structural) return;
  if (!isText(record.runId)) throw new Error('runner metadata runId must be a non-empty string');
  if (!isHash(record.executionPolicyHash)) throw new Error('runner metadata executionPolicyHash must be a SHA-256 hash');
  assertSkillRuntime(record.skillRuntime);
  assertTargetPolicy(record.effectivePolicySummary);
  assertGraph(record.graph);
}

function assertLegacyFields(record: Record<string, unknown>): void {
  if (!Number.isInteger(record.issueNumber)) throw new Error('runner metadata issueNumber must be an integer');
  if (record.mode !== 'scoped-issue' && record.mode !== 'plan-parent' && record.mode !== 'tree-child') throw new Error('runner metadata mode must be scoped-issue, plan-parent, or tree-child');
  if ('parentIssueNumber' in record && !Number.isInteger(record.parentIssueNumber)) throw new Error('runner metadata parentIssueNumber must be an integer');
  for (const key of ['workspacePath', 'sessionId', 'createdAt', 'updatedAt']) if (!isText(record[key])) throw new Error(`runner metadata ${key} must be a non-empty string`);
  if (!Number.isInteger(record.retryCount)) throw new Error('runner metadata retryCount must be an integer');
  if ('lastRecoveredAt' in record && typeof record.lastRecoveredAt !== 'string') throw new Error('runner metadata lastRecoveredAt must be a string');
  if ('ownerPid' in record && !Number.isInteger(record.ownerPid)) throw new Error('runner metadata ownerPid must be an integer');
  for (const key of ['branchName', 'promptPath', 'reportPath', 'logPath']) if (key in record && typeof record[key] !== 'string') throw new Error(`runner metadata ${key} must be a string`);
  for (const key of ['host', 'leaseUpdatedAt', 'attemptStartedAt', 'baseSha', 'snapshotPath']) if (key in record && !isText(record[key])) throw new Error(`runner metadata ${key} must be a non-empty string`);
}

function assertSkillRuntime(value: unknown): void {
  const record = requireExactRecord(value, ['packageVersion', 'bundleHash', 'bundleRoot', 'operationId', 'entrySkillPath'], 'runner skillRuntime');
  if (!isText(record.packageVersion) || !isHash(record.bundleHash) || !isText(record.bundleRoot) || !isText(record.operationId) || !isText(record.entrySkillPath)) throw new Error('runner skillRuntime fields are invalid');
}

function assertTargetPolicy(value: unknown): void {
  const record = requireExactRecord(value, ['network', 'networkHosts', 'writableRootClasses', 'mcpServers'], 'runner effectivePolicySummary');
  if (!['deny', 'allow-listed'].includes(String(record.network)) || !stringArray(record.networkHosts) || !stringArray(record.writableRootClasses)
    || typeof record.mcpServers !== 'object' || record.mcpServers === null || Array.isArray(record.mcpServers)
    || Object.keys(record.mcpServers).length !== 0) throw new Error('runner effectivePolicySummary fields are invalid');
}

function assertGraph(value: unknown): void {
  const record = requireRecord(value, 'runner graph');
  const required = ['graphId', 'currentNodeId', 'completedNodeIds', 'joinIds', 'artifactRefs', 'reviewBudget', 'reviewers', 'findings', 'closureCount', 'attempts'];
  const optional = ['templateId', 'reviewProfile', 'aggregateVerdict'];
  assertOnlyKeys(record, new Set([...required, ...optional]), 'runner graph');
  for (const key of required) if (!(key in record)) throw new Error(`runner graph missing ${key}`);
  if (!isText(record.graphId) || !isText(record.currentNodeId) || !stringArray(record.completedNodeIds) || !stringArray(record.joinIds) || !stringArray(record.artifactRefs) || !stringArray(record.findings) || !nonNegativeInteger(record.closureCount)) throw new Error('runner graph fields are invalid');
  if ('templateId' in record && !isText(record.templateId)) throw new Error('runner graph templateId is invalid');
  if ('reviewProfile' in record && !['simple', 'medium', 'high'].includes(String(record.reviewProfile))) throw new Error('runner graph reviewProfile is invalid');
  if ('aggregateVerdict' in record && !['Approved', 'Needs Work', 'Rejected'].includes(String(record.aggregateVerdict))) throw new Error('runner graph aggregateVerdict is invalid');
  const budget = requireExactRecord(record.reviewBudget, ['maximum', 'consumed'], 'runner graph reviewBudget');
  if (!nonNegativeInteger(budget.maximum) || !nonNegativeInteger(budget.consumed) || (budget.consumed as number) > (budget.maximum as number)) throw new Error('runner graph reviewBudget is invalid');
  if (!Array.isArray(record.reviewers) || !Array.isArray(record.attempts)) throw new Error('runner graph reviewers and attempts must be arrays');
  for (const reviewer of record.reviewers) {
    const item = requireExactRecord(reviewer, ['nodeId', 'reviewerSlot', 'reviewerId', 'threadId', 'mode', 'verdict', 'findingIds'], 'runner graph reviewer');
    if (!isText(item.nodeId) || !isText(item.reviewerSlot) || !isText(item.reviewerId) || !isText(item.threadId)
      || !['full', 'closure'].includes(String(item.mode)) || !['Approved', 'Needs Work', 'Rejected'].includes(String(item.verdict))
      || !stringArray(item.findingIds)) throw new Error('runner graph reviewer is invalid');
  }
  for (const attempt of record.attempts) assertAttempt(attempt);
}

function assertAttempt(value: unknown): void {
  const record = requireExactRecord(value, ['attemptId', 'nodeId', 'ordinal', 'status', 'cleanRetriesConsumed', 'partialContinuationsConsumed', 'baseline', 'executions'], 'runner graph attempt');
  if (!isText(record.attemptId) || !isText(record.nodeId) || !positiveInteger(record.ordinal) || !['prepared', 'running', 'terminal', 'reconciled', 'blocked'].includes(String(record.status))
    || ![0, 1].includes(record.cleanRetriesConsumed as number) || ![0, 1].includes(record.partialContinuationsConsumed as number) || !Array.isArray(record.executions)) throw new Error('runner graph attempt is invalid');
  const baseline = requireExactRecord(record.baseline, ['headSha', 'indexTreeSha', 'statusSha256', 'contentSha256', 'ownershipToken'], 'runner graph baseline');
  if (![baseline.headSha, baseline.indexTreeSha, baseline.statusSha256, baseline.contentSha256, baseline.ownershipToken].every(isText)) throw new Error('runner graph baseline is invalid');
  for (const execution of record.executions) assertExecution(execution);
}

function assertExecution(value: unknown): void {
  const record = requireRecord(value, 'runner transport execution');
  assertOnlyKeys(record, new Set(['executionId', 'kind', 'status', 'intentPersistedAt', 'process', 'appServer', 'report', 'terminal', 'recovery']), 'runner transport execution');
  for (const key of ['executionId', 'kind', 'status', 'intentPersistedAt', 'report']) if (!(key in record)) throw new Error(`runner transport execution missing ${key}`);
  if (!isText(record.executionId) || !['initial', 'clean-retry', 'partial-continuation'].includes(String(record.kind)) || !['prepared', 'running', 'terminal', 'reconciled', 'blocked'].includes(String(record.status)) || !isText(record.intentPersistedAt)) throw new Error('runner transport execution is invalid');
  const report = requireRecord(record.report, 'runner transport report');
  assertOnlyKeys(report, new Set(['path', 'sha256', 'atomicWriteComplete']), 'runner transport report');
  if (!isText(report.path) || typeof report.atomicWriteComplete !== 'boolean' || ('sha256' in report && !isHash(report.sha256))) throw new Error('runner transport report is invalid');
  if ('process' in record) {
    const process = requireExactRecord(record.process, ['pid', 'processGroupId', 'host', 'bootNonce', 'startedAt'], 'runner transport process');
    if (!positiveInteger(process.pid) || !positiveInteger(process.processGroupId) || !isText(process.host) || !isText(process.bootNonce) || !isText(process.startedAt)) throw new Error('runner transport process is invalid');
  }
  if ('appServer' in record) {
    const appServer = requireRecord(record.appServer, 'runner appServer identity');
    assertOnlyKeys(appServer, new Set(['threadId', 'turnId']), 'runner appServer identity');
    if (!isText(appServer.threadId) || ('turnId' in appServer && !isText(appServer.turnId))) throw new Error('runner appServer identity is invalid');
  }
  if ('terminal' in record) {
    const terminal = requireExactRecord(record.terminal, ['kind', 'acknowledgedAt', 'sideEffectsQuiescedAt', 'quiescenceProof'], 'runner transport terminal');
    if (!['completed', 'failed', 'interrupted', 'timeout', 'idle-timeout', 'protocol-death', 'blocked'].includes(String(terminal.kind))
      || !isText(terminal.acknowledgedAt) || !isText(terminal.sideEffectsQuiescedAt)
      || !['thread-clean-empty', 'process-group-absent'].includes(String(terminal.quiescenceProof))) throw new Error('runner transport terminal is invalid');
    if (terminal.kind === 'protocol-death') {
      if (terminal.quiescenceProof !== 'process-group-absent') throw new Error('runner protocol death requires process-group absence proof');
    } else if (!report.atomicWriteComplete || !isHash(report.sha256)) {
      throw new Error('runner terminal execution requires an accepted report');
    }
  }
  if ('recovery' in record) {
    const recovery = requireRecord(record.recovery, 'runner transport recovery');
    assertOnlyKeys(recovery, new Set(['kind', 'artifactPath', 'reason']), 'runner transport recovery');
    if (!['none', 'clean-retry', 'partial-continuation', 'partial-node-mutation'].includes(String(recovery.kind))
      || ('artifactPath' in recovery && !isText(recovery.artifactPath)) || ('reason' in recovery && !isText(recovery.reason))) throw new Error('runner transport recovery is invalid');
  }
}

async function readSystemBootNonce(): Promise<string> {
  if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (process.platform === 'darwin') return (await execFileAsync('sysctl', ['-n', 'kern.boottime'])).stdout.trim();
  throw new Error(`Runner state lock does not support platform ${process.platform}.`);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`); return value as Record<string, unknown>; }
function requireExactRecord(value: unknown, keys: string[], context: string): Record<string, unknown> { const record = requireRecord(value, context); assertOnlyKeys(record, new Set(keys), context); for (const key of keys) if (!(key in record)) throw new Error(`${context} missing ${key}`); return record; }
function assertOnlyKeys(record: Record<string, unknown>, allowed: Set<string>, context: string): void { const unknown = Object.keys(record).find((key) => !allowed.has(key)); if (unknown) throw new Error(`${context} contains forbidden key ${unknown}`); }
function isText(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isText) && new Set(value).size === value.length; }
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonNegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code; }
