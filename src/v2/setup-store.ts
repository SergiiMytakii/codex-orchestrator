import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

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

  async isAbsentOrEmptyDirectory(path: string): Promise<boolean> {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (isCode(error, 'ENOENT')) return true;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    await assertDirectDirectoryPath(dirname(path));
    return (await readdir(path)).length === 0;
  }

  async listJsonFiles(path: string): Promise<string[]> {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (isCode(error, 'ENOENT')) return [];
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('setup manifest path is not a direct directory');
    await assertDirectDirectoryPath(dirname(path));
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if (isCode(error, 'ENOENT')) return [];
      throw error;
    }
    return entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .map((entry) => join(path, entry.name)).sort();
  }

  async hashPath(path: string): Promise<string> {
    const top = await lstat(path).catch((error: unknown) => isCode(error, 'ENOENT') ? undefined : Promise.reject(error));
    if (top) await assertDirectDirectoryPath(dirname(path));
    const hash = createHash('sha256');
    const walk = async (current: string, base: string): Promise<void> => {
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (isCode(error, 'ENOENT')) { hash.update('absent\0'); return; }
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('setup source contains a symbolic link');
      const name = relative(base, current);
      if (info.isFile()) {
        if (info.size > 16 * 1024 * 1024) throw new Error('setup source file exceeds bound');
        hash.update(`file\0${name}\0`); hash.update(await readFile(current)); return;
      }
      if (!info.isDirectory()) throw new Error('setup source contains an unsupported entry');
      hash.update(`dir\0${name}\0`);
      const entries = (await readdir(current)).sort();
      if (entries.length > 4096) throw new Error('setup source directory exceeds entry bound');
      for (const entry of entries) await walk(join(current, entry), base);
    };
    await walk(path, path);
    return hash.digest('hex');
  }

  async copyTree(source: string, destination: string): Promise<void> {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error('setup source is a symbolic link');
    if (info.isFile()) {
      await this.writeAtomic(destination, await readFile(source), 0o600);
      return;
    }
    if (!info.isDirectory()) throw new Error('setup source is unsupported');
    await ensureDirectDirectoryPath(destination);
    for (const entry of (await readdir(source)).sort()) await this.copyTree(join(source, entry), join(destination, entry));
    await syncDirectory(destination);
  }

  async copyTreeIfPresent(source: string, destination: string): Promise<void> {
    try { await this.copyTree(source, destination); }
    catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
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
