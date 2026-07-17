import { spawn } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson, sha256 } from './containment.js';

const ZERO_OID = '0'.repeat(40);

interface OwnerControlRecordV1 {
  version: 1;
  token: string;
  canonicalRepository: string;
  host: string;
  bootId: string;
  pid: number;
  acquiredAt: string;
}

export async function inspectOwnerControlLock(input: {
  orchestratorHome: string;
  canonicalRepository: string;
  bootId: string;
  host: string;
  processAlive(pid: number): boolean;
}): Promise<{ status: 'absent' | 'active' | 'ambiguous'; reason?: string }> {
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
  return input.processAlive(owner.pid)
    ? { status: 'active' }
    : { status: 'ambiguous', reason: 'Owner control record has ambiguous liveness.' };
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
  waitMs?: number;
  pollMs?: number;
  afterObservedOwner?(owner: Readonly<OwnerControlRecordV1>): Promise<void>;
}

export async function acquireOwnerControlLock(input: OwnerControlLockInput): Promise<{ release(): Promise<void> }> {
  validateRepository(input.canonicalRepository);
  if (!input.bootId || !input.host || !Number.isSafeInteger(input.pid) || input.pid <= 0) throw new OwnerControlLockBlockedError('owner identity is invalid');
  const controlGitDir = join(input.orchestratorHome, 'v2', 'owner-control.git');
  await mkdir(join(input.orchestratorHome, 'v2'), { recursive: true, mode: 0o700 });
  const initialized = await runGit(['init', '--bare', '--quiet', '--object-format=sha1', controlGitDir]);
  if (initialized.code !== 0) throw new OwnerControlLockBlockedError('owner control store initialization failed');
  const ref = `refs/codex-orchestrator/owners/${sha256(input.canonicalRepository)}`;
  const owner: OwnerControlRecordV1 = {
    version: 1,
    token: input.createToken(),
    canonicalRepository: input.canonicalRepository,
    host: input.host,
    bootId: input.bootId,
    pid: input.pid,
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
    if (input.processAlive(observed.pid)) {
      if (Date.now() - startedAt >= (input.waitMs ?? 5_000)) throw new OwnerControlLockBlockedError('owner control lock wait timed out', 'live-contention');
      await delay(input.pollMs ?? 25);
      continue;
    }
    await input.afterObservedOwner?.(structuredClone(observed));
    if (await updateRef(controlGitDir, ref, blob, observedOid)) return handle(controlGitDir, ref, blob);
    if (Date.now() - startedAt >= (input.waitMs ?? 5_000)) throw new OwnerControlLockBlockedError('owner control lock reclaim lost');
  }
}

function handle(controlGitDir: string, ref: string, ownBlob: string): { release(): Promise<void> } {
  let released = false;
  return {
    async release() {
      if (released) return;
      const result = await runGit(['--git-dir', controlGitDir, 'update-ref', '-d', ref, ownBlob]);
      const observed = await readRef(controlGitDir, ref);
      if (result.code !== 0 && observed === ownBlob) throw new OwnerControlLockBlockedError('owner control lock release failed');
      if (observed === ownBlob) throw new OwnerControlLockBlockedError('owner control lock release was not confirmed');
      released = true;
    },
  };
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
  const expected = ['version', 'token', 'canonicalRepository', 'host', 'bootId', 'pid', 'acquiredAt'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('owner control record keys are invalid');
  const owner = value as unknown as OwnerControlRecordV1;
  validateRepository(owner.canonicalRepository);
  if (owner.version !== 1 || !owner.token || !owner.host || !owner.bootId
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || Number.isNaN(Date.parse(owner.acquiredAt)) || new Date(owner.acquiredAt).toISOString() !== owner.acquiredAt) {
    throw new Error('owner control record fields are invalid');
  }
  return owner;
}

function validateRepository(value: string): void {
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(value)) throw new OwnerControlLockBlockedError('canonical repository is invalid');
}

function runGit(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.end(stdin);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
