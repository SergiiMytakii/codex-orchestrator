import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeDurableAtomicFile(
  path: string,
  content: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const parentPath = dirname(path);
  await mkdir(parentPath, { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const handle = await open(tempPath, 'wx', mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    published = true;
    const parent = await open(parentPath, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    if (!published) await rm(tempPath, { force: true });
  }
}
