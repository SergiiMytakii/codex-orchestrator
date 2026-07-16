import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import { codexRuntimeTurnText, type CodexExecutionRunInputV2, type CodexExecutionRunResultV2 } from './execution-adapter.js';
import { AppServerClient } from './app-server-client.js';
import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';
import { acquireMissionCoordinatorLock } from '../runner/mission-coordinator-lock.js';
import { readCurrentBootNonce } from '../runner/target-activity-fence.js';
import type { PackageRuntimeHome } from './package-runtime-home.js';
import { assertNodeResult, parseNodeControlEnvelope, type NodeControlEnvelopeV1 } from '../skills/package-skill-graph.js';

const EXPECTED_CATALOG_HASH = 'd93bcca0743ca4e8431ed81e418c72b5cd09c5f83f68dbe9410f0d9a6a969478';

export class AppServerRunSession {
  private readonly active = new Map<string, { threadId: string; turnId?: string }>();
  private readonly unexpected = new Map<string, string>();
  private initialized = false;

  public constructor(private readonly client: AppServerClient, private readonly cleanupTimeoutMs = 10_000) {}

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.client.request('initialize', { clientInfo: { name: 'codex-orchestrator', title: 'Codex Orchestrator', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.client.notify('initialized');
    this.initialized = true;
  }

  public async run(
    input: CodexExecutionRunInputV2,
    signal?: AbortSignal,
    observer?: { onTurnStarted(identity: { threadId: string; turnId: string }): Promise<void> },
  ): Promise<CodexExecutionRunResultV2> {
    await this.initialize();
    await this.client.request('skills/extraRoots/set', { extraRoots: [input.skillRuntime.bundleRoot] });
    let threadId = input.resumeThreadId;
    if (!threadId) {
      const thread: any = await this.client.request('thread/start', {
        ...(input.manifestNode.executionPolicy.model ? { model: input.manifestNode.executionPolicy.model } : {}),
        cwd: input.worktreePath,
        runtimeWorkspaceRoots: [input.worktreePath],
        approvalPolicy: 'never',
        sandbox: input.manifestNode.executionPolicy.sandboxMode,
        baseInstructions: 'Execute only the explicitly supplied package skill items. The Runner owns graph transitions and all external writes.',
        developerInstructions: 'Return only the manifest-selected NodeControlEnvelopeV1 JSON object.',
        ephemeral: true,
        environments: [],
        dynamicTools: [],
        config: { web_search: 'disabled', 'features.apps': false, 'features.multi_agent': false, 'features.multi_agent_v2': false, 'skills.include_instructions': false },
      });
      threadId = thread?.thread?.id;
    }
    if (typeof threadId !== 'string') throw new Error('orchestrator-app-server-thread-start-invalid');
    const terminals: any = await this.client.request('thread/backgroundTerminals/list', { threadId });
    if (!terminals || !Array.isArray(terminals.data) || terminals.data.length !== 0) throw new Error('orchestrator-background-terminal-capability-missing');
    const skills = [input.manifestNode.skill, ...input.manifestNode.additionalSkills].map((name) => {
      const skill = name.includes('/') ? { name, path: `${input.skillRuntime.bundleRoot}/${name}` } : { name, path: `${input.skillRuntime.bundleRoot}/skills/${name}/SKILL.md` };
      return { type: 'skill', ...skill };
    });
    let finalMessage = '';
    const removeListener = this.client.onNotification((notification) => {
      if (notification.method !== 'item/completed') return;
      const params: any = notification.params;
      if (params?.threadId !== threadId || params?.item?.type !== 'agentMessage') return;
      if (typeof params.item.text === 'string') finalMessage = params.item.text;
      else if (typeof params.item.content === 'string') finalMessage = params.item.content;
    });
    const terminal = this.client.waitForNotification<any>('turn/completed', (params) => params?.threadId === threadId);
    const started: any = await this.client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: codexRuntimeTurnText(input.contextArtifactPath), text_elements: [] }, ...skills],
      cwd: input.worktreePath,
      runtimeWorkspaceRoots: [input.worktreePath],
      approvalPolicy: 'never',
      effort: input.manifestNode.executionPolicy.effort,
      outputSchema: JSON.parse(await readFile(`${input.skillRuntime.bundleRoot}/${input.manifestNode.resultSchema}`, 'utf8')),
    });
    const turnId = started?.turn?.id;
    if (typeof turnId !== 'string') throw new Error('orchestrator-app-server-turn-start-invalid');
    this.active.set(input.attemptId, { threadId, turnId });
    try {
      await observer?.onTurnStarted({ threadId, turnId });
    } catch (error) {
      await this.interrupt({ runId: input.runId, attemptId: input.attemptId, threadId, turnId, reason: 'cancelled' });
      throw error;
    }
    let cancelled = false;
    let cancellationCleanupFailed = false;
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const abort = () => {
      if (cancelled) return;
      cancelled = true;
      void this.interrupt({ runId: input.runId, attemptId: input.attemptId, threadId, turnId, reason: 'cancelled' })
        .then(() => rejectCancellation(new Error('orchestrator-turn-cancelled')), (error) => {
          cancellationCleanupFailed = true;
          rejectCancellation(error instanceof Error ? error : new Error(String(error)));
        });
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let completed: any;
    let timeoutStatus: 'timeout' | 'idle-timeout' | undefined;
    const timeoutMs = input.manifestNode.executionPolicy.timeoutMs;
    let idleTimer: NodeJS.Timeout | undefined;
    let absoluteTimer: NodeJS.Timeout | undefined;
    let rejectIdle: ((error: Error) => void) | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutStatus = 'idle-timeout';
        rejectIdle?.(new Error('orchestrator-turn-idle-timeout'));
      }, input.manifestNode.executionPolicy.idleTimeoutMs);
    };
    const removeActivity = this.client.onNotification((notification) => {
      const params = notification.params as { threadId?: unknown } | undefined;
      if (params?.threadId === threadId) resetIdle();
    });
    const timeout = new Promise<never>((_, reject) => {
      absoluteTimer = setTimeout(() => { timeoutStatus = 'timeout'; reject(new Error('orchestrator-turn-timeout')); }, timeoutMs);
      rejectIdle = reject;
      resetIdle();
    });
    try {
      completed = await Promise.race([terminal, timeout, cancellation]);
    } catch (error) {
      if (cancelled) {
        if (cancellationCleanupFailed) throw error;
        return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), logPath: input.logPath, status: 'interrupted', attemptId: input.attemptId, threadId, turnId, expectedToolCatalogHash: EXPECTED_CATALOG_HASH, recovery: 'none' };
      }
      if (!timeoutStatus) throw error;
      await this.interrupt({ runId: input.runId, attemptId: input.attemptId, threadId, turnId, reason: timeoutStatus });
      return { exitCode: 124, stdout: '', stderr: error instanceof Error ? error.message : String(error), logPath: input.logPath, status: timeoutStatus, attemptId: input.attemptId, threadId, turnId, expectedToolCatalogHash: EXPECTED_CATALOG_HASH, recovery: 'clean-retry' };
    } finally {
      if (absoluteTimer) clearTimeout(absoluteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      removeActivity();
      signal?.removeEventListener('abort', abort);
      removeListener();
    }
    if (this.active.has(input.attemptId)) {
      await this.finalizeThread(threadId);
      this.active.delete(input.attemptId);
    }
    const status = completed?.turn?.status === 'completed' ? 'completed' : completed?.turn?.status === 'interrupted' ? 'interrupted' : 'failed';
    let finalMessageHash: string | undefined;
    let controlEnvelope: NodeControlEnvelopeV1 | undefined;
    if (status === 'completed') {
      let parsed: unknown;
      try { parsed = JSON.parse(finalMessage); } catch { throw new Error('orchestrator-node-control-envelope-invalid'); }
      try { controlEnvelope = parseNodeControlEnvelope(parsed); } catch { throw new Error('orchestrator-node-control-envelope-invalid'); }
      if (controlEnvelope.nodeId !== input.nodeId) throw new Error('orchestrator-node-control-envelope-node-mismatch');
      try { assertNodeResult(input.nodeId, controlEnvelope.outcome, controlEnvelope.result); } catch { throw new Error('orchestrator-node-result-invalid'); }
      await writeDurableAtomicFile(input.reportPath, `${JSON.stringify(controlEnvelope.result, null, 2)}\n`);
      finalMessageHash = createHash('sha256').update(finalMessage).digest('hex');
    }
    const unexpected = this.unexpected.get(input.attemptId);
    this.unexpected.delete(input.attemptId);
    return { exitCode: status === 'completed' ? 0 : 1, stdout: finalMessage, stderr: unexpected ?? '', logPath: input.logPath, status, attemptId: input.attemptId, threadId, turnId, expectedToolCatalogHash: EXPECTED_CATALOG_HASH, finalMessageHash, controlEnvelope, recovery: 'none' };
  }

  public async interrupt(input: { runId: string; attemptId: string; threadId: string; turnId: string; reason: 'cancelled' | 'timeout' | 'idle-timeout' }): Promise<void> {
    await this.withCleanupTimeout((async () => {
      const completed = this.client.waitForNotification<any>('turn/completed', (params) => params?.threadId === input.threadId && params?.turn?.id === input.turnId && params?.turn?.status === 'interrupted');
      await this.client.request('turn/interrupt', { threadId: input.threadId, turnId: input.turnId });
      await completed;
      await this.finalizeThread(input.threadId);
      this.active.delete(input.attemptId);
    })());
  }

  public async close(): Promise<void> {
    await Promise.all([...this.active.entries()].map(([attemptId, { threadId, turnId }]) => turnId
      ? this.interrupt({ runId: '', attemptId, threadId, turnId, reason: 'cancelled' })
      : this.withCleanupTimeout(this.finalizeThread(threadId))));
    this.active.clear();
  }

  public async interruptUnexpected(threadId: string, method: string): Promise<void> {
    const entry = [...this.active.entries()].find(([, active]) => active.threadId === threadId);
    if (!entry || !entry[1].turnId) throw new Error(`unexpected-process-server-request:${method}`);
    this.unexpected.set(entry[0], `unexpected-server-request:${method}`);
    await this.interrupt({ runId: '', attemptId: entry[0], threadId, turnId: entry[1].turnId, reason: 'cancelled' });
  }

  private async finalizeThread(threadId: string): Promise<void> {
    try {
      await this.client.request('thread/backgroundTerminals/clean', { threadId });
      const after: any = await this.client.request('thread/backgroundTerminals/list', { threadId });
      if (!after || !Array.isArray(after.data) || after.data.length !== 0) throw new Error('turn-cleanup-unconfirmed');
    } catch {
      throw new Error('turn-cleanup-unconfirmed');
    }
  }

  private async withCleanupTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('turn-cleanup-unconfirmed')), this.cleanupTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export interface PersistedAuthLeaseV1 {
  version: 1;
  token: string;
  runId: string;
  hostId: string;
  bootNonce: string;
  ownerPid: number;
  phase: 'reserved' | 'armed' | 'running' | 'closing';
  supervisorPid: number | null;
  processGroupId: number | null;
  appServerPid: number | null;
  acquiredAt: string;
  updatedAt: string;
}

export interface AppServerProcessStartInput {
  runId: string;
  runtimeHome: PackageRuntimeHome;
  command: string;
  args: string[];
  cwd: string;
  supervisorPath: string;
  requireAccount?: boolean;
}

export class AppServerProcessOwner {
  private closed = false;
  private closing: Promise<void> | undefined;
  private sessionClosed = false;
  private leaseClosing = false;
  private controlClosed = false;
  private processTerminated = false;
  private clientClosed = false;
  private leaseReleased = false;

  private constructor(
    public readonly process: ChildProcess,
    public readonly client: AppServerClient,
    public readonly session: AppServerRunSession,
    private readonly leasePath: string | undefined,
    private readonly leaseToken: string | undefined,
    public readonly processGroupId: number,
  ) {}

  public static async start(input: AppServerProcessStartInput): Promise<AppServerProcessOwner> {
    const hostId = hostname();
    const bootNonce = await readCurrentBootNonce();
    const token = randomUUID();
    const leasePath = input.runtimeHome.authMode === 'persisted'
      ? join(input.runtimeHome.root, 'app-server-persisted-auth.lock')
      : undefined;
    if (leasePath) {
      await reserveLease({ leasePath, packageHome: input.runtimeHome.root, runId: input.runId, token, hostId, bootNonce });
    }

    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, [input.supervisorPath], {
        cwd: input.cwd,
        env: input.runtimeHome.env,
        detached: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      await waitForSpawn(child);
      if (!child.pid) throw new Error('orchestrator-supervisor-pid-missing');
      const processGroupId = child.pid;
      if (leasePath) {
        await updateOwnedLease(leasePath, token, (lease) => ({ ...lease, phase: 'armed', supervisorPid: child!.pid!, processGroupId, updatedAt: new Date().toISOString() }));
      }
      const control = child.stdio[3] as Duplex;
      const running = waitForSupervisor(control, token);
      control.write(`${JSON.stringify({ op: 'start', token, command: input.command, args: input.args, cwd: input.cwd, env: input.runtimeHome.env })}\n`);
      const appServerPid = await running;
      if (leasePath) {
        await updateOwnedLease(leasePath, token, (lease) => ({ ...lease, phase: 'running', appServerPid, updatedAt: new Date().toISOString() }));
      }
      let owner: AppServerProcessOwner | undefined;
      const client = new AppServerClient(child.stdin!, child.stdout!, {
        onServerRequest: async (request) => {
          if (!owner) return;
          if (request.threadId) await owner.session.interruptUnexpected(request.threadId, request.method);
          else await owner.close(`unexpected-process-server-request:${request.method}`);
        },
      });
      const session = new AppServerRunSession(client);
      owner = new AppServerProcessOwner(child, client, session, leasePath, leasePath ? token : undefined, processGroupId);
      await session.initialize();
      const account: any = await client.request('account/read', { refreshToken: false });
      if (input.requireAccount !== false && input.runtimeHome.authMode === 'persisted' && !account?.account) {
        throw new Error('orchestrator-auth-required');
      }
      return owner;
    } catch (error) {
      if (child?.pid) await terminateProcessGroupAndWait(child.pid);
      if (leasePath) await releaseOwnedLease(leasePath, token, true);
      throw error;
    }
  }

  public async close(_reason = 'completed'): Promise<void> {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.closing = this.closeOwnedResources();
    try {
      await this.closing;
      this.closed = true;
    } finally {
      if (!this.closed) this.closing = undefined;
    }
  }

  private async closeOwnedResources(): Promise<void> {
    let cleanupError: unknown;
    let sessionCleanupFailed = false;
    if (!this.sessionClosed) {
      try { await this.session.close(); this.sessionClosed = true; } catch (error) { sessionCleanupFailed = true; cleanupError = error; }
    }
    try {
      if (this.leasePath && this.leaseToken && !this.leaseClosing && !this.leaseReleased) {
        await updateOwnedLease(this.leasePath, this.leaseToken, (lease) => ({ ...lease, phase: 'closing', updatedAt: new Date().toISOString() }));
        this.leaseClosing = true;
      }
    } catch (error) { cleanupError ??= error; }
    if (!this.controlClosed) {
      this.process.stdio[3]?.destroy();
      this.controlClosed = true;
    }
    if (!this.processTerminated) {
      try { await terminateProcessGroupAndWait(this.processGroupId); this.processTerminated = true; } catch (error) { cleanupError ??= error; }
    }
    if (sessionCleanupFailed && this.processTerminated) this.sessionClosed = true;
    if (!this.clientClosed) {
      try { this.client.close(); this.clientClosed = true; } catch (error) { cleanupError ??= error; }
    }
    try {
      if (this.leasePath && this.leaseToken && !this.leaseReleased) {
        await releaseOwnedLease(this.leasePath, this.leaseToken, false);
        this.leaseReleased = true;
      }
    } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
  }
}

async function reserveLease(input: { leasePath: string; packageHome: string; runId: string; token: string; hostId: string; bootNonce: string }): Promise<void> {
  const guard = await acquireMissionCoordinatorLock({
    targetRoot: input.packageHome, stateDir: '.', hostId: input.hostId, bootNonce: input.bootNonce,
    waitTimeoutMs: 5_000, pollIntervalMs: 25, lockName: 'app-server-auth.guard.lock', description: 'App-server auth runtime', bootNonceSemantics: 'system-boot',
  });
  try {
    const existing = await readLease(input.leasePath, true);
    if (existing) {
      if (existing.hostId !== input.hostId || existing.bootNonce !== input.bootNonce) throw new Error('orchestrator-auth-runtime-reconcile-required');
      if (isProcessAlive(existing.ownerPid)) throw new Error('orchestrator-auth-runtime-busy');
      if (existing.processGroupId) await terminateProcessGroupAndWait(existing.processGroupId);
      else if (existing.phase !== 'reserved') throw new Error('orchestrator-auth-runtime-reconcile-required');
      await rm(input.leasePath, { force: true });
    }
    const now = new Date().toISOString();
    await writeDurableAtomicFile(input.leasePath, `${JSON.stringify({
      version: 1, token: input.token, runId: input.runId, hostId: input.hostId, bootNonce: input.bootNonce,
      ownerPid: process.pid, phase: 'reserved', supervisorPid: null, processGroupId: null, appServerPid: null, acquiredAt: now, updatedAt: now,
    } satisfies PersistedAuthLeaseV1)}\n`);
  } finally {
    await guard.release();
  }
}

async function updateOwnedLease(path: string, token: string, mutate: (lease: PersistedAuthLeaseV1) => PersistedAuthLeaseV1): Promise<void> {
  const lease = await readLease(path, false);
  if (!lease || lease.token !== token) throw new Error('orchestrator-auth-runtime-reconcile-required');
  await writeDurableAtomicFile(path, `${JSON.stringify(mutate(lease))}\n`);
}

async function releaseOwnedLease(path: string, token: string, force: boolean): Promise<void> {
  const lease = await readLease(path, true);
  if (!lease || lease.token !== token) return;
  if (!force && lease.processGroupId && isProcessGroupAlive(lease.processGroupId)) throw new Error('orchestrator-auth-runtime-reconcile-required');
  await rm(path, { force: true });
}

async function readLease(path: string, allowMissing: boolean): Promise<PersistedAuthLeaseV1 | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as PersistedAuthLeaseV1;
    const keys = ['version', 'token', 'runId', 'hostId', 'bootNonce', 'ownerPid', 'phase', 'supervisorPid', 'processGroupId', 'appServerPid', 'acquiredAt', 'updatedAt'];
    if (!value || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))
      || value.version !== 1 || typeof value.token !== 'string' || typeof value.runId !== 'string'
      || typeof value.hostId !== 'string' || typeof value.bootNonce !== 'string' || !Number.isSafeInteger(value.ownerPid)
      || !['reserved', 'armed', 'running', 'closing'].includes(value.phase)) throw new Error('invalid');
    return value;
  } catch (error) {
    if (allowMissing && error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('orchestrator-auth-runtime-reconcile-required');
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
}

function waitForSupervisor(control: Duplex, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: control, crlfDelay: Infinity });
    const timer = setTimeout(() => { lines.close(); reject(new Error('orchestrator-supervisor-start-timeout')); }, 10_000);
    lines.on('line', (line) => {
      let value: any;
      try { value = JSON.parse(line); } catch { return; }
      if (value.token !== token) return;
      if (value.op === 'running' && Number.isSafeInteger(value.appServerPid) && value.appServerPid > 0) {
        clearTimeout(timer); lines.close(); resolve(value.appServerPid); return;
      }
      if (value.op === 'error') { clearTimeout(timer); lines.close(); reject(new Error(value.error)); }
    });
  });
}

async function terminateProcessGroupAndWait(processGroupId: number): Promise<void> {
  try { process.kill(-processGroupId, 'SIGTERM'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  const deadline = Date.now() + 2_000;
  while (isProcessGroupAlive(processGroupId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (isProcessGroupAlive(processGroupId)) {
    try { process.kill(-processGroupId, 'SIGKILL'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  }
  const killDeadline = Date.now() + 2_000;
  while (isProcessGroupAlive(processGroupId) && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (isProcessGroupAlive(processGroupId)) throw new Error('orchestrator-auth-runtime-reconcile-required');
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try { process.kill(-processGroupId, 0); return true; } catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}
