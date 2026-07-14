import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { MissionSandboxBackend } from './mission-capability-kernel.js';
import type { MissionProcessInput, MissionProcessResult } from './mission-process-executor.js';
import { buildMissionSandboxInvocation } from './mission-sandbox.js';

export interface MissionPatchReceipt {
  version: 1;
  sha256: string;
  size: number;
  storage: 'mission-state-blob';
}

export interface MissionQuarantinePatchExecutorOptions {
  backend: MissionSandboxBackend;
  workspaceRoot: string;
  quarantineRoot: string;
  deniedReadPaths: string[];
  sourceEnv: NodeJS.ProcessEnv;
  allowedEnvKeys: string[];
  timeoutMs: number;
  maxPatchBytes: number;
}

export class MissionQuarantinePatchExecutor {
  public constructor(
    private readonly options: MissionQuarantinePatchExecutorOptions,
    private readonly runProcess: (input: MissionProcessInput) => Promise<MissionProcessResult>,
  ) {}

  public async materialize(patch: string): Promise<{
    receipt: MissionPatchReceipt;
    content: string;
    discard: () => Promise<void>;
  }> {
    const bytes = Buffer.from(patch, 'utf8');
    if (bytes.byteLength > this.options.maxPatchBytes) {
      throw new Error(`Mission quarantine patch size limit exceeded: ${bytes.byteLength}.`);
    }
    const quarantineRoot = await realpath(this.options.quarantineRoot);
    const receiptDirectory = join(quarantineRoot, 'patch-receipts');
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(receiptDirectory, `.incoming.${process.pid}.${randomUUID()}.patch`);
    const invocation = buildMissionSandboxInvocation({
      backend: this.options.backend,
      workspaceRoot: this.options.workspaceRoot,
      quarantineRoot,
      mode: 'quarantine-write',
      command: '/usr/bin/tee',
      args: [temporaryPath],
      deniedReadPaths: this.options.deniedReadPaths,
    });
    try {
      const result = await this.runProcess({
        ...invocation,
        cwd: this.options.workspaceRoot,
        timeoutMs: this.options.timeoutMs,
        sourceEnv: this.options.sourceEnv,
        allowedEnvKeys: this.options.allowedEnvKeys,
        stdin: patch,
      });
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`Mission quarantine patch producer failed with exit ${result.exitCode}.`);
      }
      const produced = await readRegularNoFollow(temporaryPath, true);
      if (!produced.equals(bytes)) {
        throw new Error('Mission quarantine patch producer output differs from the authorized proposal.');
      }
      const sha256 = createHash('sha256').update(produced).digest('hex');
      const receiptPath = join(receiptDirectory, `${sha256}.patch`);
      try {
        await link(temporaryPath, receiptPath);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      await unlink(temporaryPath);
      const immutable = await readRegularNoFollow(receiptPath);
      if (immutable.byteLength !== produced.byteLength
        || createHash('sha256').update(immutable).digest('hex') !== sha256) {
        throw new Error('Mission quarantine content-addressed receipt is corrupted.');
      }
      const directory = await open(receiptDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return {
        receipt: {
          version: 1,
          sha256,
          size: immutable.byteLength,
          storage: 'mission-state-blob',
        },
        content: immutable.toString('utf8'),
        discard: async () => {
          await unlink(receiptPath).catch((error: unknown) => {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          });
          const directory = await open(receiptDirectory, 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        },
      };
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function readRegularNoFollow(path: string, seal = false): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error('Mission quarantine receipt must be a single-link regular file.');
    }
    if (seal) await handle.chmod(0o400);
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || after.size !== BigInt(content.byteLength)
      || after.nlink !== 1n) {
      throw new Error('Mission quarantine receipt changed during read.');
    }
    if (seal) await handle.sync();
    return content;
  } finally {
    await handle.close();
  }
}
