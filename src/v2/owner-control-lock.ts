import { defaultProcessExecutor, type UnresolvedCommandIdentity } from './adapters/command.js';
import { observeProcessGroup } from './process-identity.js';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';

import { canonicalJson, sha256 } from './containment.js';

const ZERO_OID = '0'.repeat(40);

type CommandFence = { kind: 'launching'; activeCommands: number }
  | { kind: 'unresolved'; identity: UnresolvedCommandIdentity; otherCommandsUnconfirmed: boolean };

interface OwnerControlRecordV1 {
  version: 1;
  token: string;
  canonicalRepository: string;
  host: string;
  bootId: string;
  pid: number;
  processStartIdentity: string;
  acquiredAt: string;
  unresolvedCommand?: CommandFence;
}

export async function inspectOwnerControlLock(input: {
  orchestratorHome: string;
  canonicalRepository: string;
  bootId: string;
  host: string;
  processAlive(pid: number): boolean;
  inspectProcessIdentity?(pid: number): Promise<ProcessIdentityInspection>;
}): Promise<{ status: 'absent' | 'inactive' | 'active' | 'ambiguous'; reason?: string }> {
  validateRepository(input.canonicalRepository);
  const controlGitDir = join(input.orchestratorHome, 'v2', 'owner-control.git');
  try {
    if (!(await lstat(controlGitDir)).isDirectory()) return { status: 'ambiguous', reason: 'Owner control store is not a directory.' };
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'ambiguous', reason: 'Owner control store cannot be inspected.' };
  }
  const ref = `refs/codex-orchestrator/owners/${sha256(input.canonicalRepository)}`;
  let oid: string | undefined;
  try { oid = await readRef(controlGitDir, ref); }
  catch { return { status: 'ambiguous', reason: 'Owner control ref is invalid.' }; }
  if (!oid) return { status: 'absent' };
  let owner: OwnerControlRecordV1;
  try { owner = await readOwner(controlGitDir, oid); }
  catch { return { status: 'ambiguous', reason: 'Owner control record is malformed.' }; }
  if (owner.canonicalRepository !== input.canonicalRepository || owner.host !== input.host || owner.bootId !== input.bootId) {
    return { status: 'ambiguous', reason: 'Owner control identity is foreign or stale.' };
  }
  let observation: ProcessIdentityInspection;
  try { observation = await (input.inspectProcessIdentity ?? inspectProcessIdentity)(owner.pid); }
  catch { return { status: 'ambiguous', reason: 'Owner control process identity is unavailable.' }; }
  if (observation.status === 'unknown') return { status: 'ambiguous', reason: 'Owner control process identity is unavailable.' };
  if (owner.unresolvedCommand && !await commandFenceAbsent(owner.unresolvedCommand, input.inspectProcessIdentity ?? inspectProcessIdentity)) {
    return { status: 'ambiguous', reason: 'Owned command group cleanup is unconfirmed.' };
  }
  return observation.status === 'present' && observation.processStartIdentity === owner.processStartIdentity
    ? { status: 'active' }
    : { status: 'inactive' };
}

export class OwnerControlLockBlockedError extends Error {
  constructor(message = 'owner control lock is held or ambiguous', readonly kind: 'live-contention' | 'safety' = 'safety') {
    super(message);
    this.name = 'OwnerControlLockBlockedError';
  }
}

export interface OwnerControlLockInput {
  orchestratorHome: string;
  canonicalRepository: string;
  bootId: string;
  host: string;
  pid: number;
  now(): string;
  createToken(): string;
  processAlive(pid: number): boolean;
  processStartIdentity?: string;
  inspectProcessIdentity?: (pid: number) => Promise<ProcessIdentityInspection>;
  waitMs?: number;
  pollMs?: number;
  afterObservedOwner?(owner: Readonly<OwnerControlRecordV1>): Promise<void>;
}

export interface OwnerControlLockHandle {
  release(): Promise<void>;
  beginCommand(): Promise<void>;
  completeCommand(): Promise<void>;
  fenceCommand(identity: UnresolvedCommandIdentity): Promise<void>;
}

export async function acquireOwnerControlLock(input: OwnerControlLockInput): Promise<OwnerControlLockHandle> {
  validateRepository(input.canonicalRepository);
  if (!input.bootId || !input.host || !Number.isSafeInteger(input.pid) || input.pid <= 0) throw new OwnerControlLockBlockedError('owner identity is invalid');
  const controlGitDir = join(input.orchestratorHome, 'v2', 'owner-control.git');
  await mkdir(join(input.orchestratorHome, 'v2'), { recursive: true, mode: 0o700 });
  const initialized = await runGit(['init', '--bare', '--quiet', '--object-format=sha1', controlGitDir]);
  if (initialized.code !== 0) throw new OwnerControlLockBlockedError('owner control store initialization failed');
  const ref = `refs/codex-orchestrator/owners/${sha256(input.canonicalRepository)}`;
  const processStartIdentity = input.processStartIdentity ?? await readProcessStartIdentity(input.pid);
  if (!processStartIdentity) throw new OwnerControlLockBlockedError('owner process identity is unavailable');
  const owner: OwnerControlRecordV1 = {
    version: 1,
    token: input.createToken(),
    canonicalRepository: input.canonicalRepository,
    host: input.host,
    bootId: input.bootId,
    pid: input.pid,
    processStartIdentity,
    acquiredAt: input.now(),
  };
  const blob = await writeBlob(controlGitDir, owner);
  const startedAt = Date.now();
  while (true) {
    const observedOid = await readRef(controlGitDir, ref);
    if (observedOid === undefined) {
      if (await updateRef(controlGitDir, ref, blob, ZERO_OID)) return handle(controlGitDir, ref, blob);
      continue;
    }
    const observed = await readOwner(controlGitDir, observedOid).catch(() => undefined);
    if (!observed
      || observed.canonicalRepository !== input.canonicalRepository
      || observed.host !== input.host
      || observed.bootId !== input.bootId) {
      throw new OwnerControlLockBlockedError();
    }
    let observation: ProcessIdentityInspection;
    try { observation = await (input.inspectProcessIdentity ?? inspectProcessIdentity)(observed.pid); }
    catch { throw new OwnerControlLockBlockedError('owner process identity is unavailable'); }
    if (observation.status === 'unknown') throw new OwnerControlLockBlockedError('owner process identity is unavailable');
    if (observed.unresolvedCommand && !await commandFenceAbsent(observed.unresolvedCommand, input.inspectProcessIdentity ?? inspectProcessIdentity)) {
      throw new OwnerControlLockBlockedError('owned command group cleanup is unconfirmed');
    }
    if (observation.status === 'present' && observation.processStartIdentity === observed.processStartIdentity) {
      if (Date.now() - startedAt >= (input.waitMs ?? 5_000)) throw new OwnerControlLockBlockedError('owner control lock wait timed out', 'live-contention');
      await delay(input.pollMs ?? 25);
      continue;
    }
    await input.afterObservedOwner?.(structuredClone(observed));
    if (await updateRef(controlGitDir, ref, blob, observedOid)) return handle(controlGitDir, ref, blob);
    if (Date.now() - startedAt >= (input.waitMs ?? 5_000)) throw new OwnerControlLockBlockedError('owner control lock reclaim lost');
  }
}

function handle(controlGitDir: string, ref: string, initialBlob: string): OwnerControlLockHandle {
  let ownBlob = initialBlob;
  let released = false;
  let fenced = false;
  let mutations = Promise.resolve();
  const mutate = (task: () => Promise<void>) => {
    const result = mutations.then(task);
    mutations = result.catch(() => undefined);
    return result;
  };
  const persist = async (owner: OwnerControlRecordV1) => {
    const next = await writeBlob(controlGitDir, owner);
    if (!await updateRef(controlGitDir, ref, next, ownBlob)) throw new OwnerControlLockBlockedError('owned command fence write was not confirmed');
    ownBlob = next;
  };
  return {
    beginCommand: () => mutate(async () => {
      if (released || fenced) throw new OwnerControlLockBlockedError('owner command launch is fenced');
      try {
        const owner = await readOwner(controlGitDir, ownBlob);
        if (owner.unresolvedCommand?.kind === 'unresolved') throw new OwnerControlLockBlockedError('owned command cleanup is unconfirmed');
        owner.unresolvedCommand = { kind: 'launching', activeCommands: (owner.unresolvedCommand?.activeCommands ?? 0) + 1 };
        await persist(owner);
      } catch (error) { fenced = true; throw error; }
    }),
    completeCommand: () => mutate(async () => {
      if (released || fenced) throw new OwnerControlLockBlockedError('owned command cleanup is unconfirmed');
      try {
        const owner = await readOwner(controlGitDir, ownBlob);
        if (owner.unresolvedCommand?.kind !== 'launching') throw new OwnerControlLockBlockedError('owned command launch receipt is missing');
        if (owner.unresolvedCommand.activeCommands === 1) delete owner.unresolvedCommand;
        else owner.unresolvedCommand.activeCommands -= 1;
        await persist(owner);
      } catch (error) { fenced = true; throw error; }
    }),
    fenceCommand: (identity) => {
      // Mark locally before I/O: a failed durable fence must never release ownership.
      fenced = true;
      return mutate(async () => {
        if (released) throw new OwnerControlLockBlockedError('cannot fence a released owner lock');
        const owner = await readOwner(controlGitDir, ownBlob);
        const previous = owner.unresolvedCommand;
        owner.unresolvedCommand = { kind: 'unresolved', identity: validateCommandIdentity(identity),
          otherCommandsUnconfirmed: previous?.kind === 'launching' ? previous.activeCommands > 1
            : previous?.kind === 'unresolved' ? true : false };
        await persist(owner);
      });
    },
    release: () => mutate(async () => {
      if (released) return;
      if (fenced || (await readOwner(controlGitDir, ownBlob)).unresolvedCommand) {
        throw new OwnerControlLockBlockedError('owned command cleanup is unconfirmed; owner lock retained');
      }
      const result = await runGit(['--git-dir', controlGitDir, 'update-ref', '-d', ref, ownBlob]);
      const observed = await readRef(controlGitDir, ref);
      if (result.code !== 0 && observed === ownBlob) throw new OwnerControlLockBlockedError('owner control lock release failed');
      if (observed === ownBlob) throw new OwnerControlLockBlockedError('owner control lock release was not confirmed');
      released = true;
    }),
  };
}

async function commandFenceAbsent(fence: CommandFence,
  inspect: (pid: number) => Promise<ProcessIdentityInspection>): Promise<boolean> {
  if (fence.kind === 'launching' || fence.otherCommandsUnconfirmed) return false;
  const identity = fence.identity;
  if (identity.streamsUnconfirmed || identity.processGroupId <= 0) return false;
  let leader: ProcessIdentityInspection;
  try { leader = await inspect(identity.pid); } catch { return false; }
  if (leader.status === 'unknown') return false;
  if (leader.status === 'present' && (!identity.processStartIdentity || leader.processStartIdentity === identity.processStartIdentity)) return false;
  return observeProcessGroup(identity.processGroupId) === 'absent';
}

function validateCommandFence(fence: CommandFence): void {
  if (typeof fence !== 'object' || fence === null || Array.isArray(fence)) throw new OwnerControlLockBlockedError('owned command fence is invalid');
  if (fence.kind === 'launching') {
    if (Object.keys(fence).sort().join(',') !== 'activeCommands,kind'
      || !Number.isSafeInteger(fence.activeCommands) || fence.activeCommands < 1) throw new OwnerControlLockBlockedError('owned command launch fence is invalid');
  } else if (fence.kind === 'unresolved') {
    if (Object.keys(fence).sort().join(',') !== 'identity,kind,otherCommandsUnconfirmed'
      || typeof fence.otherCommandsUnconfirmed !== 'boolean') throw new OwnerControlLockBlockedError('owned command fence is invalid');
    validateCommandIdentity(fence.identity);
  } else throw new OwnerControlLockBlockedError('owned command fence is invalid');
}

function validateCommandIdentity(identity: UnresolvedCommandIdentity): UnresolvedCommandIdentity {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)
    || Object.keys(identity).some((key) => !['pid', 'processGroupId', 'streamsUnconfirmed', 'processStartIdentity'].includes(key))
    || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
    || !Number.isSafeInteger(identity.processGroupId) || identity.processGroupId < 0
    || typeof identity.streamsUnconfirmed !== 'boolean'
    || (identity.processStartIdentity !== undefined && (typeof identity.processStartIdentity !== 'string' || !identity.processStartIdentity))) {
    throw new OwnerControlLockBlockedError('owned command identity is invalid');
  }
  return { pid: identity.pid, processGroupId: identity.processGroupId,
    streamsUnconfirmed: identity.streamsUnconfirmed,
    ...(identity.processStartIdentity ? { processStartIdentity: identity.processStartIdentity } : {}) };
}

async function writeBlob(controlGitDir: string, owner: OwnerControlRecordV1): Promise<string> {
  const result = await runGit(['--git-dir', controlGitDir, 'hash-object', '-w', '--stdin'], `${canonicalJson(owner)}\n`);
  const oid = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40}$/u.test(oid)) throw new OwnerControlLockBlockedError('owner control blob write failed');
  return oid;
}

async function readRef(controlGitDir: string, ref: string): Promise<string | undefined> {
  const result = await runGit(['--git-dir', controlGitDir, 'rev-parse', '--verify', '--quiet', ref]);
  if (result.code === 1) return undefined;
  const oid = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40}$/u.test(oid)) throw new OwnerControlLockBlockedError('owner control ref is invalid');
  return oid;
}

async function readOwner(controlGitDir: string, oid: string): Promise<OwnerControlRecordV1> {
  const result = await runGit(['--git-dir', controlGitDir, 'cat-file', 'blob', oid]);
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 16 * 1024) throw new Error('owner control blob is invalid');
  return parseOwner(JSON.parse(result.stdout));
}

async function updateRef(controlGitDir: string, ref: string, next: string, previous: string): Promise<boolean> {
  return (await runGit(['--git-dir', controlGitDir, 'update-ref', ref, next, previous])).code === 0;
}

function parseOwner(value: unknown): OwnerControlRecordV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('owner control record is invalid');
  const keys = Object.keys(value).sort();
  const expected = ['version', 'token', 'canonicalRepository', 'host', 'bootId', 'pid', 'processStartIdentity', 'acquiredAt', ...('unresolvedCommand' in value ? ['unresolvedCommand'] : [])].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('owner control record keys are invalid');
  const owner = value as unknown as OwnerControlRecordV1;
  validateRepository(owner.canonicalRepository);
  if (owner.version !== 1 || !owner.token || !owner.host || !owner.bootId
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.processStartIdentity
    || Number.isNaN(Date.parse(owner.acquiredAt)) || new Date(owner.acquiredAt).toISOString() !== owner.acquiredAt) {
    throw new Error('owner control record fields are invalid');
  }
  if ('unresolvedCommand' in owner) validateCommandFence(owner.unresolvedCommand!);
  return owner;
}

export type ProcessIdentityInspection =
  | { status: 'present'; processStartIdentity: string }
  | { status: 'absent' }
  | { status: 'unknown' };

export async function inspectProcessIdentity(pid: number): Promise<ProcessIdentityInspection> {
  const identity = await readProcessStartIdentity(pid);
  if (identity) return { status: 'present', processStartIdentity: identity };
  try { process.kill(pid, 0); return { status: 'unknown' }; }
  catch (error) { return isErrorCode(error, 'ESRCH') ? { status: 'absent' } : { status: 'unknown' }; }
}

export async function readProcessStartIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform() === 'linux') {
    try {
      const text = await readFile(`/proc/${pid}/stat`, 'utf8');
      const close = text.lastIndexOf(') ');
      const fields = close < 0 ? [] : text.slice(close + 2).trim().split(/\s+/u);
      return fields[19] ? `linux:${fields[19]}` : undefined;
    } catch { return undefined; }
  }
  const result = await defaultProcessExecutor('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5_000 });
  const value = result.exitCode !== 0 ? '' : result.stdout.trim().replace(/\s+/gu, ' ');
  return value ? `${platform()}:${value}` : undefined;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function validateRepository(value: string): void {
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(value)) throw new OwnerControlLockBlockedError('canonical repository is invalid');
}

async function runGit(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await defaultProcessExecutor('git', args, { stdin, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
