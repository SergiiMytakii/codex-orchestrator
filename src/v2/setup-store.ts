import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export type SetupStoreFaultPoint =
  | 'before-file-fsync' | 'before-rename' | 'after-rename' | 'before-parent-fsync';

export interface SetupStoreOptions {
  fault?: (input: { path: string; point: SetupStoreFaultPoint }) => void | Promise<void>;
}

export class SetupStore {
  constructor(private readonly options: SetupStoreOptions = {}) {}

  async readOptional(path: string, maxBytes = 1024 * 1024): Promise<Buffer | undefined> {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('setup file is not a bounded direct regular file');
    await assertDirectDirectoryPath(dirname(path));
    return readFile(path);
  }

  async writeAtomic(path: string, content: string | Buffer, mode = 0o600): Promise<void> {
    const parent = dirname(path);
    await ensureDirectDirectoryPath(parent);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    let renamed = false;
    try {
      handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
      await handle.writeFile(content);
      await this.options.fault?.({ path, point: 'before-file-fsync' });
      await handle.sync();
      await handle.close(); handle = undefined;
      await this.options.fault?.({ path, point: 'before-rename' });
      await rename(temp, path); renamed = true;
      await this.options.fault?.({ path, point: 'after-rename' });
      await this.options.fault?.({ path, point: 'before-parent-fsync' });
      await syncDirectory(parent);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

async function assertDirectDirectoryPath(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${current} must be a direct directory`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function ensureDirectDirectoryPath(path: string): Promise<void> {
  const missing: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${current} must be a direct directory`);
      break;
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current)); current = parent;
    }
  }
  await assertDirectDirectoryPath(current);
  for (const segment of missing.reverse()) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${current} must be a direct directory`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
