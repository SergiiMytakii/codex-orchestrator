import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface MobileDeviceLeaseInput {
  worktreePath: string;
  env: NodeJS.ProcessEnv;
  issueNumber: number;
  resourceName?: string;
}

export interface MobileDeviceLease {
  release(): Promise<void>;
}

interface LeaseMetadata {
  token: string;
  issueNumber: number;
  pid: number;
  resourceName: string;
  acquiredAt: string;
}

const defaultLeaseTimeoutMs = 120_000;
const defaultLeaseStaleMs = 900_000;
const leasePollMs = 250;

export async function acquireMobileDeviceLease(input: MobileDeviceLeaseInput): Promise<MobileDeviceLease> {
  const resourceName = input.resourceName ?? 'android-device';
  const leaseRoot = mobileDeviceLeaseRoot(input);
  const lockDir = join(leaseRoot, `${sanitizeLockSegment(resourceName)}.lock`);
  const metadataPath = join(lockDir, 'lease.json');
  const token = randomUUID();
  const timeoutMs = numberFromEnv(input.env.CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_TIMEOUT_MS) ?? defaultLeaseTimeoutMs;
  const staleMs = numberFromEnv(input.env.CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_STALE_MS) ?? defaultLeaseStaleMs;
  const deadline = Date.now() + timeoutMs;

  await mkdir(leaseRoot, { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir);
      const metadata: LeaseMetadata = {
        token,
        issueNumber: input.issueNumber,
        pid: process.pid,
        resourceName,
        acquiredAt: new Date().toISOString(),
      };
      try {
        await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      return {
        release: async () => {
          await releaseLease(lockDir, metadataPath, token);
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await removeStaleLease(lockDir, staleMs);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for mobile device lease ${resourceName}. Another visual proof is using the shared device/emulator resource.`,
        );
      }
      await delay(leasePollMs);
    }
  }
}

function mobileDeviceLeaseRoot(input: MobileDeviceLeaseInput): string {
  if (input.env.CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_DIR) {
    return resolve(input.env.CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_DIR);
  }
  if (input.env.CODEX_ORCHESTRATOR_STATE_DIR) {
    return resolve(input.env.CODEX_ORCHESTRATOR_STATE_DIR, 'mobile-device-locks');
  }
  const inferred = inferTargetRootFromWorktree(input.worktreePath);
  if (inferred) {
    return join(inferred, '.codex-orchestrator', 'state', 'mobile-device-locks');
  }
  return join(input.worktreePath, '.codex-orchestrator', 'state', 'mobile-device-locks');
}

function inferTargetRootFromWorktree(worktreePath: string): string | undefined {
  const normalized = resolve(worktreePath).replaceAll('\\', '/');
  const marker = '/.codex-orchestrator/workspaces/';
  const index = normalized.indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  return normalized.slice(0, index);
}

async function releaseLease(lockDir: string, metadataPath: string, token: string): Promise<void> {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<LeaseMetadata>;
    if (metadata.token !== token) {
      return;
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }
  await rm(lockDir, { recursive: true, force: true });
}

async function removeStaleLease(lockDir: string, staleMs: number): Promise<void> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs <= staleMs) {
      return;
    }
    await rm(lockDir, { recursive: true, force: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function sanitizeLockSegment(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'mobile-device';
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
