import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { writeDurableAtomicFile } from './fs/durable-atomic-file.js';

const bridgeMagic = Buffer.from('codex-orchestrator-bridge-package-v1\0', 'utf8');

export interface BridgeRuntimeFileV1 {
  path: string;
  mode: number;
  size: number;
  sha256: string;
}

export interface BridgeRuntimeManifestV1 {
  version: 1;
  packageVersion: string;
  packageHash: string;
  files: BridgeRuntimeFileV1[];
}

interface ClosureFile extends BridgeRuntimeFileV1 {
  bytes: Buffer;
}

export async function buildBridgeRuntimeManifest(packageRoot: string): Promise<BridgeRuntimeManifestV1> {
  const root = resolve(packageRoot);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (packageJson.name !== 'codex-orchestrator' || typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Bridge package.json must identify codex-orchestrator with a string version.');
  }
  const paths = [
    'package.json',
    'README.md',
    'docs/deep-dive.md',
    'CHANGELOG.md',
    ...await listTree(root, 'dist/src'),
    ...await listTree(root, 'prompts'),
  ].map(normalizeManifestPath).sort(compareUtf8);
  if (new Set(paths).size !== paths.length) {
    throw new Error('Bridge publication closure contains duplicate normalized paths.');
  }

  const closure: ClosureFile[] = [];
  for (const path of paths) {
    const absolutePath = join(root, ...path.split('/'));
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Bridge publication path must be a regular file: ${path}`);
    }
    const bytes = await readFile(absolutePath);
    closure.push({
      path,
      mode: stats.mode & 0o777,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    });
  }

  const manifestWithoutHash: BridgeRuntimeManifestV1 = {
    version: 1,
    packageVersion: packageJson.version,
    packageHash: '',
    files: closure.map(({ bytes: _bytes, ...file }) => file),
  };
  const hash = createHash('sha256').update(bridgeMagic);
  const manifestBytes = Buffer.from(canonicalJson(manifestWithoutHash), 'utf8');
  hash.update(uint32(manifestBytes.length)).update(manifestBytes);
  for (const file of closure) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    hash.update(uint32(pathBytes.length)).update(pathBytes);
    hash.update(uint32(file.mode));
    hash.update(uint64(file.size));
    hash.update(file.bytes);
  }
  return { ...manifestWithoutHash, packageHash: hash.digest('hex') };
}

export async function writeBridgeRuntimeManifest(
  packageRoot: string,
  manifestPath = join(resolve(packageRoot), 'bridge-runtime.json'),
): Promise<BridgeRuntimeManifestV1> {
  const manifest = await buildBridgeRuntimeManifest(packageRoot);
  await writeDurableAtomicFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readBridgeRuntimeManifest(path: string): Promise<BridgeRuntimeManifestV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`bridge-runtime.json is missing or invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  assertBridgeRuntimeManifest(parsed);
  return parsed;
}

export async function verifyBridgeRuntimeManifest(
  packageRoot: string,
  manifestPath = join(resolve(packageRoot), 'bridge-runtime.json'),
): Promise<BridgeRuntimeManifestV1> {
  const [actual, expected] = await Promise.all([
    readBridgeRuntimeManifest(manifestPath),
    buildBridgeRuntimeManifest(packageRoot),
  ]);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('bridge-runtime.json does not match package bytes.');
  }
  return actual;
}

async function listTree(root: string, relativeDirectory: string): Promise<string[]> {
  const absoluteDirectory = join(root, ...relativeDirectory.split('/'));
  const directoryStats = await lstat(absoluteDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`Bridge publication directory is invalid: ${relativeDirectory}`);
  }
  const files: string[] = [];
  for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
    const absolutePath = join(absoluteDirectory, entry.name);
    const path = normalizeManifestPath(relative(root, absolutePath).split(sep).join('/'));
    if (entry.isSymbolicLink()) throw new Error(`Bridge publication closure rejects symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await listTree(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Bridge publication closure rejects non-file entry: ${path}`);
  }
  return files;
}

function assertBridgeRuntimeManifest(value: unknown): asserts value is BridgeRuntimeManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'packageVersion', 'packageHash', 'files'])
    || value.version !== 1
    || typeof value.packageVersion !== 'string' || value.packageVersion.length === 0
    || typeof value.packageHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.packageHash)
    || !Array.isArray(value.files)) {
    throw new Error('bridge-runtime.json has an invalid strict schema.');
  }
  let previous = '';
  for (const item of value.files) {
    if (!isRecord(item) || !hasExactKeys(item, ['path', 'mode', 'size', 'sha256'])
      || typeof item.path !== 'string' || normalizeManifestPath(item.path) !== item.path
      || (previous !== '' && compareUtf8(previous, item.path) >= 0)
      || !Number.isSafeInteger(item.mode) || (item.mode as number) < 0 || (item.mode as number) > 0o777
      || !Number.isSafeInteger(item.size) || (item.size as number) < 0
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) {
      throw new Error('bridge-runtime.json has an invalid strict schema.');
    }
    previous = item.path;
  }
}

function normalizeManifestPath(path: string): string {
  const normalized = path.normalize('NFC').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Bridge publication path is invalid: ${path}`);
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON rejects non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Canonical JSON rejects unsupported values.');
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function uint64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
