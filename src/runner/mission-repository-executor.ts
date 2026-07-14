import { globMatches } from '../path-policy.js';
import {
  authorizeMissionCapability,
  missionGitStatusArgv,
  type MissionCapability,
  type MissionCapabilityPermit,
  type MissionCapabilityRequest,
  type MissionSandboxBackend,
} from './mission-capability-kernel.js';
import {
  inspectCanonicalFile,
  type CanonicalFileIdentity,
} from './mission-canonical-path.js';
import { auditMissionPatch, type MissionPatchAuditResult } from './mission-patch-audit.js';
import {
  missionExecutorRequiredChecks,
  type MissionExecutorProbeResult,
} from './mission-executor-probe.js';
import {
  runMissionProcess,
  type MissionProcessInput,
  type MissionProcessResult,
} from './mission-process-executor.js';
import { MissionRepositoryObserver } from './mission-repository-observer.js';
import type { MissionPermitAuthority } from './mission-permit-authority.js';
import type { MissionInputSnapshotVerifier } from './mission-input-snapshot.js';
import {
  MissionQuarantinePatchExecutor,
  type MissionPatchReceipt,
} from './mission-quarantine-patch-executor.js';
import { buildMissionSandboxInvocation } from './mission-sandbox.js';
import {
  missionDefaultDeniedRepositoryPaths,
  missionPathDenied,
} from './mission-path-language.js';

export type MissionRepositoryPatchAuditResult =
  | Extract<MissionPatchAuditResult, { accepted: false }>
  | {
      accepted: true;
      files: Extract<MissionPatchAuditResult, { accepted: true }>['files'];
      preconditions: Record<string, CanonicalFileIdentity | null>;
    };

export type MissionPatchExecutionResult = MissionRepositoryPatchAuditResult & {
  receipt: MissionPatchReceipt;
};

export interface MissionRepositoryExecutorOptions {
  backend: MissionSandboxBackend;
  workspaceRoot: string;
  quarantineRoot: string;
  deniedReadPaths: string[];
  sourceEnv: NodeJS.ProcessEnv;
  allowedEnvKeys: string[];
  timeoutMs: number;
  deniedRepositoryPaths?: string[];
  maxPatchBytes?: number;
  capabilityProof: MissionExecutorProbeResult;
}

export interface MissionRepositoryExecutorDependencies {
  runProcess?: (input: MissionProcessInput) => Promise<MissionProcessResult>;
  permitAuthority: MissionPermitAuthority;
  snapshotVerifier: MissionInputSnapshotVerifier;
}

export class MissionRepositoryExecutor {
  private readonly runProcess: (input: MissionProcessInput) => Promise<MissionProcessResult>;
  private readonly permitAuthority: MissionPermitAuthority;
  private readonly snapshotVerifier: MissionInputSnapshotVerifier;
  private readonly quarantinePatchExecutor: MissionQuarantinePatchExecutor;

  public constructor(
    private readonly options: MissionRepositoryExecutorOptions,
    dependencies: MissionRepositoryExecutorDependencies,
  ) {
    const proofChecks = new Set(options.capabilityProof.checks);
    if (!options.capabilityProof.supported
      || options.capabilityProof.backend !== options.backend
      || options.capabilityProof.failures.length > 0
      || missionExecutorRequiredChecks.some((check) => !proofChecks.has(check))) {
      throw new Error('Mission repository executor requires a successful active capability proof.');
    }
    this.runProcess = dependencies.runProcess ?? runMissionProcess;
    this.permitAuthority = dependencies.permitAuthority;
    this.snapshotVerifier = dependencies.snapshotVerifier;
    this.quarantinePatchExecutor = new MissionQuarantinePatchExecutor({
      backend: options.backend,
      workspaceRoot: options.workspaceRoot,
      quarantineRoot: options.quarantineRoot,
      deniedReadPaths: options.deniedReadPaths,
      sourceEnv: options.sourceEnv,
      allowedEnvKeys: options.allowedEnvKeys,
      timeoutMs: options.timeoutMs,
      maxPatchBytes: options.maxPatchBytes ?? 4 * 1024 * 1024,
    }, this.runProcess);
  }

  public authorize(request: MissionCapabilityRequest): MissionCapabilityPermit {
    return authorizeMissionCapability(request);
  }

  public async observeGitStatus(permit: MissionCapabilityPermit): Promise<MissionProcessResult> {
    const authorized = this.validatePermit(permit, 'git-status');
    const replay = await this.beginPermit(authorized);
    if (replay) return decodeActionReceipt<MissionProcessResult>(replay, 'process-result');
    const [command, ...args] = missionGitStatusArgv;
    const invocation = buildMissionSandboxInvocation({
      backend: this.options.backend,
      workspaceRoot: this.options.workspaceRoot,
      quarantineRoot: this.options.quarantineRoot,
      mode: 'read-only',
      command,
      args,
      deniedReadPaths: this.options.deniedReadPaths,
    });
    const result = await this.runProcess({
      ...invocation,
      cwd: this.options.workspaceRoot,
      timeoutMs: this.options.timeoutMs,
      sourceEnv: this.options.sourceEnv,
      allowedEnvKeys: this.options.allowedEnvKeys,
    });
    await this.completePermit(authorized, 'process-result', result);
    return result;
  }

  public async readText(
    permit: MissionCapabilityPermit,
  ): Promise<string> {
    const authorized = this.validatePermit(permit, 'read-file');
    const path = authorized.readPath!;
    const maxBytes = authorized.maxReadBytes!;
    if (!authorized.requestedPaths.some((pattern) => globMatches(pattern, path))) {
      throw new Error(`Mission repository read is outside permitted scope: ${path}.`);
    }
    const deniedPaths = this.deniedRepositoryPaths();
    if (missionPathDenied(path, deniedPaths)) {
      throw new Error(`Mission repository read path is denied: ${path}.`);
    }
    const replay = await this.beginPermit(authorized);
    if (replay) return decodeActionReceipt<string>(replay, 'text-result');
    const observer = new MissionRepositoryObserver(
      this.options.workspaceRoot,
      authorized.requestedPaths,
      deniedPaths,
    );
    const text = await observer.readText(path, maxBytes);
    await this.completePermit(authorized, 'text-result', text);
    return text;
  }

  public async executePatch(
    permit: MissionCapabilityPermit,
    patch: string,
  ): Promise<MissionPatchExecutionResult> {
    const authorized = this.validatePermit(permit, 'validate-patch');
    const preliminary = auditMissionPatch({
      patch,
      grantedPaths: authorized.requestedPaths,
      deniedPaths: this.deniedRepositoryPaths(),
      maxBytes: this.options.maxPatchBytes ?? 4 * 1024 * 1024,
    });
    if (!preliminary.accepted) {
      throw new Error(`Mission patch proposal rejected before execution: ${preliminary.reason}.`);
    }
    const replay = await this.beginPermit(authorized);
    if (replay) return decodeActionReceipt<MissionPatchExecutionResult>(replay, 'patch-result');
    const produced = await this.quarantinePatchExecutor.materialize(patch);
    let durablyCompleted = false;
    try {
      const audited = auditMissionPatch({
        patch: produced.content,
        grantedPaths: authorized.requestedPaths,
        deniedPaths: this.deniedRepositoryPaths(),
        maxBytes: this.options.maxPatchBytes ?? 4 * 1024 * 1024,
      });
      if (!audited.accepted) {
        const result = { ...audited, receipt: produced.receipt };
        await this.completePermit(authorized, 'patch-result', result, [Buffer.from(produced.content, 'utf8')]);
        durablyCompleted = true;
        return result;
      }
      const preconditions: Record<string, CanonicalFileIdentity | null> = {};
      for (const file of audited.files) {
        try {
          const inspected = await inspectCanonicalFile({
            root: this.options.workspaceRoot,
            path: file.path,
            deniedPaths: this.deniedRepositoryPaths(),
          });
          preconditions[file.path] = inspected?.identity ?? null;
        } catch (error) {
          const result = {
            accepted: false,
            reason: error instanceof Error && /hard-linked|non-regular/u.test(error.message)
              ? 'canonical-non-regular-or-hard-linked-file-forbidden'
              : 'canonical-path-precondition-rejected',
            receipt: produced.receipt,
          } as const;
          await this.completePermit(authorized, 'patch-result', result, [Buffer.from(produced.content, 'utf8')]);
          durablyCompleted = true;
          return result;
        }
      }
      const result = { ...audited, preconditions, receipt: produced.receipt };
      await this.completePermit(
        authorized,
        'patch-result',
        result,
        [Buffer.from(produced.content, 'utf8')],
      );
      durablyCompleted = true;
      return result;
    } finally {
      if (durablyCompleted) await produced.discard();
    }
  }

  private validatePermit(
    permit: MissionCapabilityPermit,
    capability: MissionCapabilityPermit['capability'],
  ): MissionCapabilityPermit {
    if (permit.capability !== capability || permit.network !== 'deny'
      || permit.workspace !== 'read-only') {
      throw new Error(`Mission repository executor received an invalid ${capability} permit.`);
    }
    return authorizeMissionCapability(permit);
  }

  private async beginPermit(authorized: MissionCapabilityPermit): Promise<Buffer | undefined> {
    await this.snapshotVerifier.verify(authorized.inputSnapshot);
    const result = await this.permitAuthority.begin(authorized);
    if (result.kind === 'completed') {
      return this.permitAuthority.readReceipt(result.receiptSha256);
    }
    return undefined;
  }

  private deniedRepositoryPaths(): string[] {
    return [...missionDefaultDeniedRepositoryPaths, ...(this.options.deniedRepositoryPaths ?? [])];
  }

  private async completePermit(
    permit: MissionCapabilityPermit,
    kind: string,
    value: unknown,
    artifacts: Uint8Array[] = [],
  ): Promise<void> {
    await this.snapshotVerifier.verify(permit.inputSnapshot);
    await this.permitAuthority.complete(permit, encodeActionReceipt(kind, value), artifacts);
  }

}

function encodeActionReceipt(kind: string, value: unknown): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, kind, value }), 'utf8');
}

function decodeActionReceipt<T>(payload: Buffer, expectedKind: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(payload.toString('utf8')); } catch { parsed = undefined; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Mission action receipt payload is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || record.kind !== expectedKind || !('value' in record)) {
    throw new Error(`Mission action receipt kind does not match ${expectedKind}.`);
  }
  return record.value as T;
}
