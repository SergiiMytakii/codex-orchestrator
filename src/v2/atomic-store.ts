import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson } from './containment.js';

const MAX_STATE_BYTES = 1024 * 1024;

export type AtomicStoreFaultPoint =
  | 'before-file-fsync'
  | 'before-rename'
  | 'after-rename'
  | 'before-parent-fsync';

export interface AtomicStateFileOptions {
  host?: string;
  pid?: number;
  now?: () => string;
  createToken?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  lockWaitMs?: number;
  pollMs?: number;
  maxBytes?: number;
  fault?: (point: AtomicStoreFaultPoint) => void | Promise<void>;
}

export async function acquireExclusiveJsonFileLock<T>(input: {
  path: string;
  record: T;
  token: string;
  parse: (value: unknown) => T;
  tokenOf: (value: T) => string;
  classifyExisting: (value: T) => 'wait' | 'block';
  waitMs?: number;
  pollMs?: number;
}): Promise<{ release(): Promise<void> }> {
  const bytes = Buffer.from(`${canonicalJson(input.record)}\n`);
  if (bytes.length > 16 * 1024) throw new Error('exclusive lock record is too large');
  await ensureDirectDirectoryPath(dirname(input.path));
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(input.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
      const currentBytes = await readOptionalRegularFile(input.path, 16 * 1024);
      if (!currentBytes) continue;
      let current: T;
      try {
        current = input.parse(JSON.parse(currentBytes.toString('utf8')));
      } catch {
        throw new Error('exclusive lock record is malformed');
      }
      if (input.classifyExisting(current) === 'block') throw new Error('exclusive lock owner blocks acquisition');
      if (Date.now() - startedAt >= (input.waitMs ?? 5_000)) throw new Error('exclusive lock wait timed out');
      await delay(input.pollMs ?? 25);
    }
  }
  return {
    release: async () => {
      const currentBytes = await readOptionalRegularFile(input.path, 16 * 1024).catch(() => undefined);
      if (!currentBytes) return;
      let current: T;
      try {
        current = input.parse(JSON.parse(currentBytes.toString('utf8')));
      } catch {
        return;
      }
      if (input.tokenOf(current) !== input.token) return;
      await unlink(input.path).catch((error: unknown) => {
        if (!isErrorCode(error, 'ENOENT')) throw error;
      });
      await syncDirectory(dirname(input.path));
    },
  };
}

interface LockRecordV1 {
  version: 1;
  token: string;
  host: string;
  pid: number;
  acquiredAt: string;
}

export class AtomicStateFile<T extends { generation: number }> {
  private readonly options: Required<Omit<AtomicStateFileOptions, 'fault'>> & Pick<AtomicStateFileOptions, 'fault'>;

  constructor(
    readonly path: string,
    private readonly parse: (value: unknown) => T,
    options: AtomicStateFileOptions = {},
  ) {
    this.options = {
      host: options.host ?? hostname(),
      pid: options.pid ?? process.pid,
      now: options.now ?? (() => new Date().toISOString()),
      createToken: options.createToken ?? randomUUID,
      isProcessAlive: options.isProcessAlive ?? processIsAlive,
      lockWaitMs: options.lockWaitMs ?? 5_000,
      pollMs: options.pollMs ?? 25,
      maxBytes: options.maxBytes ?? MAX_STATE_BYTES,
      fault: options.fault,
    };
  }

  async read(): Promise<T | undefined> {
    const bytes = await readOptionalRegularFile(this.path, this.options.maxBytes);
    return bytes === undefined ? undefined : parseBytes(bytes, this.parse);
  }

  async compareAndSwap(expectedGeneration: number, next: T): Promise<T> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('expected generation is invalid');
    const validated = this.parse(structuredClone(next));
    if (validated.generation !== expectedGeneration + 1) throw new Error('next generation is invalid');
    const nextBytes = Buffer.from(`${canonicalJson(validated)}\n`);
    if (nextBytes.length > this.options.maxBytes) throw new Error('state exceeds maximum size');

    await ensureDirectDirectoryPath(dirname(this.path));
    const release = await acquireAdjacentLock(`${this.path}.lock`, this.options);
    try {
      const priorBytes = await readOptionalRegularFile(this.path, this.options.maxBytes);
      const prior = priorBytes === undefined ? undefined : parseBytes(priorBytes, this.parse);
      const actualGeneration = prior?.generation ?? 0;
      if (actualGeneration !== expectedGeneration) throw new Error(`state generation conflict: expected ${expectedGeneration}, found ${actualGeneration}`);
      await this.publishWithReconciliation(priorBytes, nextBytes);
      return structuredClone(validated);
    } finally {
      await release();
    }
  }

  private async publishWithReconciliation(priorBytes: Buffer | undefined, nextBytes: Buffer): Promise<void> {
    const tempPath = `${this.path}.${this.options.pid}.${this.options.createToken()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(nextBytes);
      await this.options.fault?.('before-file-fsync');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.options.fault?.('before-rename');
      await rename(tempPath, this.path);
      await this.options.fault?.('after-rename');
      await this.options.fault?.('before-parent-fsync');
      const parent = await open(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const observed = await readOptionalRegularFile(this.path, this.options.maxBytes).catch(() => undefined);
      if (observed && observed.equals(nextBytes)) return;
      if ((observed === undefined && priorBytes === undefined) || (observed && priorBytes && observed.equals(priorBytes))) throw error;
      throw new Error('atomic state publication is ambiguous; refusing to overwrite third state', { cause: error });
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

async function acquireAdjacentLock(
  path: string,
  options: Required<Omit<AtomicStateFileOptions, 'fault'>> & Pick<AtomicStateFileOptions, 'fault'>,
): Promise<() => Promise<void>> {
  const token = options.createToken();
  const record: LockRecordV1 = {
    version: 1,
    token,
    host: options.host,
    pid: options.pid,
    acquiredAt: options.now(),
  };
  validateLockRecord(record);
  const bytes = Buffer.from(`${canonicalJson(record)}\n`);
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
      const owner = await readLockRecord(path);
      if (owner.host !== options.host) throw new Error('state lock is owned by a foreign host');
      if (!options.isProcessAlive(owner.pid)) throw new Error('state lock has a stale or ambiguous owner');
      if (Date.now() - startedAt >= options.lockWaitMs) throw new Error('state lock wait timed out');
      await delay(options.pollMs);
    }
  }
  return async () => {
    let current: LockRecordV1;
    try {
      current = await readLockRecord(path);
    } catch {
      return;
    }
    if (current.token !== token) return;
    await unlink(path).catch((error: unknown) => {
      if (!isErrorCode(error, 'ENOENT')) throw error;
    });
    await syncDirectory(dirname(path));
  };
}

async function readLockRecord(path: string): Promise<LockRecordV1> {
  const bytes = await readOptionalRegularFile(path, 16 * 1024);
  if (!bytes) throw new Error('state lock disappeared');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('state lock is malformed');
  }
  return validateLockRecord(value);
}

function validateLockRecord(value: unknown): LockRecordV1 {
  assertExactObject(value, ['version', 'token', 'host', 'pid', 'acquiredAt'], 'state lock');
  if (value.version !== 1) throw new Error('state lock version is invalid');
  assertNonEmptyString(value.token, 'state lock token');
  assertNonEmptyString(value.host, 'state lock host');
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) throw new Error('state lock pid is invalid');
  if (typeof value.acquiredAt !== 'string' || Number.isNaN(Date.parse(value.acquiredAt)) || new Date(value.acquiredAt).toISOString() !== value.acquiredAt) {
    throw new Error('state lock acquiredAt is invalid');
  }
  return value as unknown as LockRecordV1;
}

async function readOptionalRegularFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (stat.size > maxBytes) throw new Error(`${path} exceeds maximum size`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseBytes<T>(bytes: Buffer, parse: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('state JSON is malformed');
  }
  return parse(value);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, 'EPERM');
  }
}

async function ensureDirectDirectoryPath(path: string): Promise<void> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${current} must be a direct directory`);
      break;
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
  for (const segment of missing.reverse()) {
    current = `${current}/${segment}`;
    await mkdir(current, { mode: 0o700 });
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${current} must be a direct directory`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${field} has unknown or missing keys`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) throw new Error(`${field} is invalid`);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
