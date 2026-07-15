import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MissionCoordinatorLockInput {
  targetRoot: string;
  stateDir: string;
  hostId: string;
  bootNonce: string;
  pid?: number;
  now?: Date;
  isProcessAlive?: (pid: number) => boolean;
  waitTimeoutMs?: number;
  lockName?: string;
  description?: string;
  bootNonceSemantics?: 'process' | 'system-boot';
}

export interface MissionCoordinatorLock {
  metadataPath: string;
  release(): Promise<void>;
}

interface LockOwner {
  version: 1;
  token: string;
  hostId: string;
  bootNonce: string;
  pid: number;
  acquiredAt: string;
}

export async function acquireMissionCoordinatorLock(
  input: MissionCoordinatorLockInput,
): Promise<MissionCoordinatorLock> {
  const description = input.description ?? 'Mission coordinator';
  const lockName = input.lockName ?? 'mission-coordinator.lock';
  const bootNonceSemantics = input.bootNonceSemantics ?? 'process';
  if (lockName.length === 0 || lockName.includes('/') || lockName.includes('\\')) {
    throw new Error(`${description} lockName must be one path segment.`);
  }
  if (bootNonceSemantics !== 'process' && bootNonceSemantics !== 'system-boot') {
    throw new Error(`${description} bootNonceSemantics must be process or system-boot.`);
  }
  const lockDirectory = join(input.targetRoot, input.stateDir, lockName);
  const metadataPath = join(lockDirectory, 'owner.json');
  const token = randomUUID();
  const owner: LockOwner = {
    version: 1,
    token,
    hostId: requireText(input.hostId, 'hostId', description),
    bootNonce: requireText(input.bootNonce, 'bootNonce', description),
    pid: input.pid ?? process.pid,
    acquiredAt: (input.now ?? new Date()).toISOString(),
  };
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new Error(`${description} pid must be a positive integer.`);
  }
  const alive = input.isProcessAlive ?? defaultProcessAlive;
  let reclaimGuardPath: string | undefined;
  const waitTimeoutMs = input.waitTimeoutMs ?? 0;
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new Error(`${description} waitTimeoutMs must be a non-negative integer.`);
  }
  const deadline = Date.now() + waitTimeoutMs;
  await mkdir(join(input.targetRoot, input.stateDir), { recursive: true });

  while (true) {
    const candidateDirectory = `${lockDirectory}.candidate.${token}.${randomUUID()}`;
    try {
      await mkdir(candidateDirectory);
      try {
        await writeFile(join(candidateDirectory, 'owner.json'), `${JSON.stringify(owner)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        await rename(candidateDirectory, lockDirectory);
      } catch (error) {
        await rm(candidateDirectory, { recursive: true, force: true });
        throw error;
      }
      if (reclaimGuardPath) {
        await rm(reclaimGuardPath, { recursive: true, force: true });
      }
      return {
        metadataPath,
        release: () => releaseLock(lockDirectory, metadataPath, token, description),
      };
    } catch (error) {
      if (!isCode(error, 'EEXIST') && !isCode(error, 'ENOTEMPTY')) {
        throw error;
      }
      let existing: LockOwner;
      try {
        existing = await readLockOwner(metadataPath, description);
      } catch (readError) {
        if (isCode(readError, 'ENOENT')) {
          await delay(5);
          continue;
        }
        throw readError;
      }
      if (existing.hostId !== owner.hostId) {
        throw new Error(`${description} lock belongs to a different host: ${existing.hostId}.`);
      }
      const ownerStillAlive = bootNonceSemantics === 'system-boot'
        ? existing.bootNonce === owner.bootNonce && (existing.pid === owner.pid || alive(existing.pid))
        : existing.pid === owner.pid
          ? existing.bootNonce === owner.bootNonce
          : alive(existing.pid);
      if (ownerStillAlive) {
        if (Date.now() < deadline) {
          await delay(10);
          continue;
        }
        throw new Error(`${description} lock is already owned by pid ${existing.pid}.`);
      }
      const stalePath = `${lockDirectory}.stale.${existing.token}`;
      try {
        await rename(lockDirectory, stalePath);
      } catch (renameError) {
        if (isCode(renameError, 'ENOENT')) {
          continue;
        }
        if (isCode(renameError, 'EEXIST') || isCode(renameError, 'ENOTEMPTY')) {
          throw new Error(`${description} stale reclaim guard already exists for token ${existing.token}.`);
        }
        throw renameError;
      }
      reclaimGuardPath = stalePath;
    }
  }
}

async function releaseLock(lockDirectory: string, metadataPath: string, token: string, description: string): Promise<void> {
  let current: LockOwner;
  try {
    current = await readLockOwner(metadataPath, description);
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  if (current.token !== token) {
    return;
  }
  const releasePath = `${lockDirectory}.release.${token}`;
  try {
    await rename(lockDirectory, releasePath);
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  await rm(releasePath, { recursive: true, force: true });
}

async function readLockOwner(path: string, description: string): Promise<LockOwner> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      throw error;
    }
    throw new Error(`${description} lock metadata is invalid and cannot be reclaimed safely.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${description} lock metadata is invalid and cannot be reclaimed safely.`);
  }
  const record = parsed as Record<string, unknown>;
  const exact = ['version', 'token', 'hostId', 'bootNonce', 'pid', 'acquiredAt'];
  if (Object.keys(record).length !== exact.length || exact.some((key) => !(key in record))
    || record.version !== 1
    || typeof record.token !== 'string' || record.token.length === 0
    || typeof record.hostId !== 'string' || record.hostId.length === 0
    || typeof record.bootNonce !== 'string' || record.bootNonce.length === 0
    || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
    || typeof record.acquiredAt !== 'string' || !Number.isFinite(Date.parse(record.acquiredAt))) {
    throw new Error(`${description} lock metadata is invalid and cannot be reclaimed safely.`);
  }
  return record as unknown as LockOwner;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function requireText(value: string, field: string, description: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${description} ${field} must be non-empty.`);
  }
  return value;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
