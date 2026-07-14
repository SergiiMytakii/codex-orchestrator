import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { globMatches, normalizePath } from '../path-policy.js';
import { missionPathDenied } from './mission-path-language.js';

export interface CanonicalFileIdentity {
  repositoryPath: string;
  canonicalPath: string;
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface CanonicalFileInspectionDependencies {
  beforeRead?: () => Promise<void>;
}

export async function readCanonicalText(input: {
  root: string;
  path: string;
  grantedPaths: string[];
  deniedPaths: string[];
  maxBytes: number;
}): Promise<{ text: string; identity: CanonicalFileIdentity }> {
  const normalized = assertRepositoryRelativePath(input.path);
  if (!input.grantedPaths.some((pattern) => globMatches(pattern, normalized))) {
    throw new Error(`Mission observation path is outside granted scope: ${input.path}.`);
  }
  const inspected = await inspectCanonicalFile({
    root: input.root,
    path: input.path,
    deniedPaths: input.deniedPaths,
    maxBytes: input.maxBytes,
    missing: 'reject',
  });
  if (!inspected) throw new Error(`Mission observation file is missing: ${input.path}.`);
  if (inspected.content.includes(0)) {
    throw new Error(`Mission observation refuses binary file: ${input.path}.`);
  }
  return { text: inspected.content.toString('utf8'), identity: inspected.identity };
}

export async function inspectCanonicalFile(input: {
  root: string;
  path: string;
  deniedPaths: string[];
  maxBytes?: number;
  missing?: 'allow' | 'reject';
}, dependencies: CanonicalFileInspectionDependencies = {}): Promise<{
  identity: CanonicalFileIdentity;
  content: Buffer;
} | undefined> {
  const normalized = assertRepositoryRelativePath(input.path);
  if (missionPathDenied(normalized, input.deniedPaths)) {
    throw new Error(`Mission canonical path is denied: ${normalized}.`);
  }
  const canonicalRoot = await realpath(input.root);
  let current = canonicalRoot;
  for (const segment of normalized.split('/')) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT'
        && input.missing !== 'reject') return undefined;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Mission canonical path refuses symbolic link: ${normalized}.`);
    }
  }
  const canonicalTarget = await realpath(current);
  const canonicalRelative = normalizePath(relative(canonicalRoot, canonicalTarget));
  if (canonicalRelative.startsWith('../') || canonicalRelative === '..' || isAbsolute(canonicalRelative)) {
    throw new Error(`Mission canonical path escapes repository root: ${normalized}.`);
  }
  if (missionPathDenied(canonicalRelative, input.deniedPaths)) {
    throw new Error(`Mission canonical path is denied: ${canonicalRelative}.`);
  }
  const expected = await stat(canonicalTarget, { bigint: true });
  assertRegularSingleLink(expected, normalized);
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSameIdentity(expected, opened, normalized);
    assertStableMetadata(expected, opened, normalized);
    assertRegularSingleLink(opened, normalized);
    const maxBytes = input.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || opened.size > BigInt(maxBytes)) {
      throw new Error(`Mission canonical path size limit exceeded: ${opened.size} > ${maxBytes}.`);
    }
    await dependencies.beforeRead?.();
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertSameIdentity(opened, after, normalized);
    assertStableMetadata(opened, after, normalized);
    assertRegularSingleLink(after, normalized);
    if (after.size !== BigInt(content.byteLength)) {
      throw new Error(`Mission canonical path changed length during read: ${normalized}.`);
    }
    return {
      content,
      identity: {
        repositoryPath: canonicalRelative,
        canonicalPath: canonicalTarget,
        dev: Number(after.dev),
        ino: Number(after.ino),
        mode: Number(after.mode),
        size: Number(after.size),
        mtimeMs: Number(after.mtimeNs) / 1_000_000,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    };
  } finally {
    await handle.close();
  }
}

function assertRepositoryRelativePath(path: string): string {
  const normalized = normalizePath(path);
  if (isAbsolute(path) || normalized.length === 0
    || normalized.split('/').some((segment) => segment.length === 0 || segment === '..')) {
    throw new Error('Mission canonical path must be repository-relative without empty segments.');
  }
  return normalized;
}

function assertRegularSingleLink(
  info: { isFile(): boolean; nlink: number | bigint },
  path: string,
): void {
  if (!info.isFile() || (typeof info.nlink === 'bigint' ? info.nlink !== 1n : info.nlink !== 1)) {
    throw new Error(`Mission canonical path refuses non-regular or hard-linked file: ${path}.`);
  }
}

function assertSameIdentity(
  expected: { dev: number | bigint; ino: number | bigint },
  actual: { dev: number | bigint; ino: number | bigint },
  path: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`Mission canonical path changed during authorization: ${path}.`);
  }
}

function assertStableMetadata(
  expected: {
    mode: bigint;
    nlink: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  actual: {
    mode: bigint;
    nlink: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  path: string,
): void {
  if (expected.mode !== actual.mode || expected.nlink !== actual.nlink
    || expected.size !== actual.size || expected.mtimeNs !== actual.mtimeNs
    || expected.ctimeNs !== actual.ctimeNs) {
    throw new Error(`Mission canonical path changed during read: ${path}.`);
  }
}
