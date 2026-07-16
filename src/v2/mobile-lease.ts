import { constants } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';
import { canonicalJson } from './containment.js';

export interface AndroidLeaseRecordV1 {
  schema: 'codex-orchestrator.android-lease';
  version: 1;
  status: 'active' | 'released';
  proofId: string;
  token: string;
  serial: string;
  appId: string;
  ownerPid: number;
  appPid: number | null;
  acquiredAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface AndroidLeaseVerifier {
  verify(input: { proofId: string; artifactRelativePath: string; artifactBytes: Buffer }): Promise<void>;
  release(proofId: string): Promise<void>;
}

export class FileAndroidLeaseVerifier implements AndroidLeaseVerifier {
  private readonly leasePath: string;
  private readonly worktreeRoot: string;
  private readonly now: () => Date;
  private readonly artifactRelativePathForProof?: (proofId: string) => string;
  private readonly verified = new Map<string, { lease: AndroidLeaseRecordV1; artifactPath: string }>();

  constructor(input: {
    leaseRoot: string;
    worktreeRoot: string;
    now?: () => Date;
    artifactRelativePathForProof?: (proofId: string) => string;
  }) {
    this.leasePath = join(resolve(input.leaseRoot), 'android.json');
    this.worktreeRoot = resolve(input.worktreeRoot);
    this.now = input.now ?? (() => new Date());
    this.artifactRelativePathForProof = input.artifactRelativePathForProof;
  }

  async verify(input: { proofId: string; artifactRelativePath: string; artifactBytes: Buffer }): Promise<void> {
    const external = parseAndroidLease(await readBoundedRegularFile(this.leasePath));
    const artifact = parseAndroidLease(input.artifactBytes);
    if (external.status !== 'active' || artifact.status !== 'active' || external.proofId !== input.proofId || artifact.proofId !== input.proofId) {
      throw new Error('Android lease proof identity is invalid');
    }
    for (const field of ['token', 'serial', 'appId', 'ownerPid', 'appPid', 'acquiredAt', 'expiresAt'] as const) {
      if (external[field] !== artifact[field]) throw new Error('Android lease artifact does not match active ownership');
    }
    if (!Number.isSafeInteger(external.appPid) || (external.appPid as number) < 1 || Date.parse(external.expiresAt) < this.now().getTime()) {
      throw new Error('Android lease is not bound and active');
    }
    const artifactPath = resolve(this.worktreeRoot, input.artifactRelativePath);
    if (artifactPath === this.worktreeRoot || !artifactPath.startsWith(`${this.worktreeRoot}/`)) throw new Error('Android lease artifact path is invalid');
    this.verified.set(input.proofId, { lease: external, artifactPath });
  }

  async release(proofId: string): Promise<void> {
    let external: AndroidLeaseRecordV1;
    try {
      external = parseAndroidLease(await readBoundedRegularFile(this.leasePath));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (external.proofId !== proofId) throw new Error('Android lease release identity is invalid');
    const verified = this.verified.get(proofId) ?? await this.resolveReleaseArtifact(proofId, external);
    if (verified.lease.token !== external.token) throw new Error('Android lease release token changed');
    const released: AndroidLeaseRecordV1 = { ...external, status: 'released', updatedAt: this.now().toISOString() };
    await writeDurableAtomicFile(verified.artifactPath, `${canonicalJson(released)}\n`, 0o600);
    const reread = parseAndroidLease(await readBoundedRegularFile(this.leasePath));
    if (reread.proofId !== proofId || reread.token !== external.token) throw new Error('Android lease changed before release');
    await rm(this.leasePath);
    await syncDirectory(dirname(this.leasePath));
    this.verified.delete(proofId);
  }

  private async resolveReleaseArtifact(
    proofId: string,
    external: AndroidLeaseRecordV1,
  ): Promise<{ lease: AndroidLeaseRecordV1; artifactPath: string }> {
    if (!this.artifactRelativePathForProof) throw new Error('Android lease release artifact is unavailable');
    const relativePath = this.artifactRelativePathForProof(proofId);
    const artifactPath = resolve(this.worktreeRoot, relativePath);
    if (artifactPath === this.worktreeRoot || !artifactPath.startsWith(`${this.worktreeRoot}/`)) {
      throw new Error('Android lease release artifact path is invalid');
    }
    const artifact = parseAndroidLease(await readBoundedRegularFile(artifactPath));
    if (!['active', 'released'].includes(artifact.status) || artifact.proofId !== proofId || artifact.token !== external.token) {
      throw new Error('Android lease release artifact does not match active ownership');
    }
    for (const field of ['serial', 'appId', 'ownerPid', 'appPid', 'acquiredAt', 'expiresAt'] as const) {
      if (artifact[field] !== external[field]) throw new Error('Android lease release artifact identity changed');
    }
    return { lease: artifact, artifactPath };
  }
}

export function parseAndroidLease(bytes: Buffer): AndroidLeaseRecordV1 {
  if (bytes.length === 0 || bytes.length > 64 * 1024) throw new Error('Android lease bytes are invalid');
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Android lease must be an object');
  const record = value as Record<string, unknown>;
  const expected = ['schema', 'version', 'status', 'proofId', 'token', 'serial', 'appId', 'ownerPid', 'appPid', 'acquiredAt', 'expiresAt', 'updatedAt'].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error('Android lease fields are invalid');
  if (record.schema !== 'codex-orchestrator.android-lease' || record.version !== 1
    || (record.status !== 'active' && record.status !== 'released')) throw new Error('Android lease schema is invalid');
  if (!isBoundedString(record.proofId) || !isBoundedString(record.token) || !/^emulator-[0-9]+$/u.test(String(record.serial))
    || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(String(record.appId))) {
    throw new Error('Android lease identity is invalid');
  }
  if (!Number.isSafeInteger(record.ownerPid) || (record.ownerPid as number) < 1
    || (record.appPid !== null && (!Number.isSafeInteger(record.appPid) || (record.appPid as number) < 1))) {
    throw new Error('Android lease process identity is invalid');
  }
  for (const field of ['acquiredAt', 'expiresAt', 'updatedAt'] as const) {
    const timestamp = record[field];
    if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
      throw new Error('Android lease timestamp is invalid');
    }
  }
  return record as unknown as AndroidLeaseRecordV1;
}

async function readBoundedRegularFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('Android lease file is invalid');
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
