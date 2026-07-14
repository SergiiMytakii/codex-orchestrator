import { mkdtempSync as fsMkdtempSync, rmSync } from 'node:fs';
import { mkdtemp as fsMkdtemp } from 'node:fs/promises';

const roots = new Set<string>();
let cleanupRegistered = false;

function track(path: string): string {
  roots.add(path);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once('exit', () => {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    });
  }
  return path;
}

export async function mkdtemp(prefix: string): Promise<string> {
  return track(await fsMkdtemp(prefix));
}

export function mkdtempSync(prefix: string): string {
  return track(fsMkdtempSync(prefix));
}
