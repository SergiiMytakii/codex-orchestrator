import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { writeDurableAtomicFile } from './durable-atomic-file.js';
import { acquireMissionCoordinatorLock } from './mission-coordinator-lock.js';

const execFileAsync = promisify(execFile);

export type TargetActivityFenceMode = 'shared' | 'exclusive';
export type TargetActivityPurpose = 'daemon' | 'claim' | 'setup' | 'preparation' | 'migration';

export interface TargetActivityFenceInput {
  targetRoot: string;
  stateDir: string;
  mode: TargetActivityFenceMode;
  purpose: TargetActivityPurpose;
  hostId?: string;
  bootNonce?: string;
  pid?: number;
  now?: Date;
  isProcessAlive?: (pid: number) => boolean;
}

export interface TargetActivityFenceLease {
  canonicalTargetRoot: string;
  generation: number;
  metadataPath: string;
  release(): Promise<void>;
}

interface TargetActivityOwner {
  version: 1;
  token: string;
  mode: TargetActivityFenceMode;
  purpose: TargetActivityPurpose;
  canonicalTargetRoot: string;
  hostId: string;
  bootNonce: string;
  pid: number;
  acquiredAt: string;
}

interface FenceIdentity {
  canonicalTargetRoot: string;
  hostId: string;
  bootNonce: string;
  pid: number;
  isProcessAlive: (pid: number) => boolean;
}

export async function acquireTargetActivityFence(
  input: TargetActivityFenceInput,
): Promise<TargetActivityFenceLease> {
  const identity = await resolveIdentity(input);
  const token = randomUUID();
  const owner: TargetActivityOwner = {
    version: 1,
    token,
    mode: input.mode,
    purpose: input.purpose,
    canonicalTargetRoot: identity.canonicalTargetRoot,
    hostId: identity.hostId,
    bootNonce: identity.bootNonce,
    pid: identity.pid,
    acquiredAt: (input.now ?? new Date()).toISOString(),
  };
  assertOwner(owner);

  const paths = fencePaths(identity.canonicalTargetRoot, input.stateDir);
  await mkdir(paths.sharedDirectory, { recursive: true });
  const guard = await acquireGuard(identity, input.stateDir);
  let metadataPath = '';
  let generation = 0;
  try {
    const exclusive = await reconcileOwnerPath(paths.exclusivePath, identity);
    const shared = await reconcileSharedOwners(paths.sharedDirectory, identity);
    if (input.mode === 'shared' && exclusive) {
      throw new Error(`Target activity fence exclusive activity is owned by pid ${exclusive.pid}.`);
    }
    if (input.mode === 'exclusive' && shared.length > 0) {
      throw new Error(`Target activity fence shared activity is owned by pid ${shared[0]?.pid}.`);
    }
    if (input.mode === 'exclusive' && exclusive) {
      throw new Error(`Target activity fence exclusive activity is owned by pid ${exclusive.pid}.`);
    }

    metadataPath = input.mode === 'exclusive'
      ? paths.exclusivePath
      : join(paths.sharedDirectory, `${token}.json`);
    await writeFile(metadataPath, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    generation = (await readGenerationFile(paths.generationPath)) + 1;
    await writeDurableAtomicFile(paths.generationPath, `${JSON.stringify({ version: 1, generation })}\n`);
  } catch (error) {
    if (metadataPath) {
      await rm(metadataPath, { force: true });
    }
    throw error;
  } finally {
    await guard.release();
  }

  let released = false;
  return {
    canonicalTargetRoot: identity.canonicalTargetRoot,
    generation,
    metadataPath,
    release: async () => {
      if (released) return;
      const releaseGuard = await acquireGuard(identity, input.stateDir);
      try {
        const current = await readOwner(metadataPath, true);
        if (current?.token === token) {
          await rm(metadataPath, { force: true });
        }
        released = true;
      } finally {
        await releaseGuard.release();
      }
    },
  };
}

export async function readTargetActivityFenceGeneration(targetRoot: string, stateDir: string): Promise<number> {
  const canonicalTargetRoot = await canonicalizeTargetRoot(targetRoot);
  return readGenerationFile(fencePaths(canonicalTargetRoot, stateDir).generationPath);
}

export async function readCurrentBootNonce(platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform === 'linux') {
    const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!value) throw new Error('bridge-process-introspection-unsupported: Linux boot id is unavailable.');
    return value;
  }
  if (platform === 'darwin') {
    try {
      const result = await execFileAsync('sysctl', ['-n', 'kern.boottime']);
      const value = result.stdout.trim();
      if (!value) throw new Error('empty output');
      return value;
    } catch {
      throw new Error('bridge-process-introspection-unsupported: Darwin boot time is unavailable.');
    }
  }
  throw new Error(`bridge-process-introspection-unsupported: platform ${platform} is not supported.`);
}

async function resolveIdentity(input: TargetActivityFenceInput): Promise<FenceIdentity> {
  const canonicalTargetRoot = await canonicalizeTargetRoot(input.targetRoot);
  const hostId = requireText(input.hostId ?? hostname(), 'hostId');
  const bootNonce = requireText(input.bootNonce ?? await readCurrentBootNonce(), 'bootNonce');
  const pid = input.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Target activity fence pid must be a positive integer.');
  }
  return {
    canonicalTargetRoot,
    hostId,
    bootNonce,
    pid,
    isProcessAlive: input.isProcessAlive ?? defaultProcessAlive,
  };
}

async function canonicalizeTargetRoot(targetRoot: string): Promise<string> {
  return realpath(resolve(targetRoot));
}

function fencePaths(targetRoot: string, stateDir: string): {
  sharedDirectory: string;
  exclusivePath: string;
  generationPath: string;
} {
  const root = join(targetRoot, stateDir, 'target-activity-fence');
  return {
    sharedDirectory: join(root, 'shared'),
    exclusivePath: join(root, 'exclusive.json'),
    generationPath: join(root, 'generation.json'),
  };
}

async function acquireGuard(identity: FenceIdentity, stateDir: string) {
  return acquireMissionCoordinatorLock({
    targetRoot: identity.canonicalTargetRoot,
    stateDir,
    hostId: identity.hostId,
    bootNonce: identity.bootNonce,
    pid: identity.pid,
    isProcessAlive: identity.isProcessAlive,
    waitTimeoutMs: 5_000,
    lockName: 'target-activity-fence.guard.lock',
    description: 'Target activity fence guard',
    bootNonceSemantics: 'system-boot',
  });
}

async function reconcileSharedOwners(directory: string, identity: FenceIdentity): Promise<TargetActivityOwner[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const owners: TargetActivityOwner[] = [];
  for (const name of names) {
    const owner = await reconcileOwnerPath(join(directory, name), identity);
    if (owner) owners.push(owner);
  }
  return owners;
}

async function reconcileOwnerPath(path: string, identity: FenceIdentity): Promise<TargetActivityOwner | undefined> {
  const owner = await readOwner(path, true);
  if (!owner) return undefined;
  if (owner.canonicalTargetRoot !== identity.canonicalTargetRoot) {
    throw new Error('Target activity fence metadata belongs to a different canonical target.');
  }
  if (owner.hostId !== identity.hostId) {
    throw new Error(`Target activity fence owner belongs to a different host: ${owner.hostId}.`);
  }
  const alive = owner.bootNonce === identity.bootNonce
    && (owner.pid === identity.pid || identity.isProcessAlive(owner.pid));
  if (alive) return owner;
  await rm(path, { force: true });
  return undefined;
}

async function readOwner(path: string, allowMissing: boolean): Promise<TargetActivityOwner | undefined> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (allowMissing && isCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Target activity fence metadata is invalid and cannot be reclaimed safely.');
  }
  assertOwner(parsed);
  return parsed;
}

function assertOwner(value: unknown): asserts value is TargetActivityOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Target activity fence metadata is invalid and cannot be reclaimed safely.');
  }
  const record = value as Record<string, unknown>;
  const keys = ['version', 'token', 'mode', 'purpose', 'canonicalTargetRoot', 'hostId', 'bootNonce', 'pid', 'acquiredAt'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))
    || record.version !== 1
    || typeof record.token !== 'string' || record.token.length === 0
    || (record.mode !== 'shared' && record.mode !== 'exclusive')
    || !['daemon', 'claim', 'setup', 'preparation', 'migration'].includes(String(record.purpose))
    || typeof record.canonicalTargetRoot !== 'string' || record.canonicalTargetRoot.length === 0
    || typeof record.hostId !== 'string' || record.hostId.length === 0
    || typeof record.bootNonce !== 'string' || record.bootNonce.length === 0
    || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
    || typeof record.acquiredAt !== 'string' || !Number.isFinite(Date.parse(record.acquiredAt))) {
    throw new Error('Target activity fence metadata is invalid and cannot be reclaimed safely.');
  }
}

async function readGenerationFile(path: string): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isCode(error, 'ENOENT')) return 0;
    throw new Error('Target activity fence generation is invalid.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Target activity fence generation is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 1
    || !Number.isSafeInteger(record.generation) || (record.generation as number) < 0) {
    throw new Error('Target activity fence generation is invalid.');
  }
  return record.generation as number;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, 'EPERM');
  }
}

function requireText(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`Target activity fence ${field} must be non-empty.`);
  return value;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
