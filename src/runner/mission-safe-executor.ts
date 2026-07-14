import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import { globMatches, normalizePath, uniqueSortedPaths } from '../path-policy.js';
import { inspectCanonicalFile } from './mission-canonical-path.js';
import {
  missionExecutorRequiredChecks,
  type MissionExecutorProbeResult,
} from './mission-executor-probe.js';
import {
  assertMissionPathPattern,
  missionDefaultDeniedRepositoryPaths,
  missionPathPatternsOverlap,
  scopePatternContainedBy,
} from './mission-path-language.js';
import {
  runMissionProcess,
  type MissionProcessInput,
  type MissionProcessResult,
} from './mission-process-executor.js';
import { buildMissionSandboxInvocation } from './mission-sandbox.js';
import type { MissionSandboxBackend } from './mission-capability-kernel.js';

export const missionSafeExecutorKinds = [
  'completion-report-repair',
  'review-evidence-repair',
  'acceptance-proof-repair',
  'configured-check',
] as const;

export type MissionSafeExecutorKind = (typeof missionSafeExecutorKinds)[number];

export interface MissionSafeExecutorDescriptor {
  id: string;
  kind: MissionSafeExecutorKind;
  executable: string;
  args: string[];
  readPaths: string[];
  writePaths: string[];
  network: 'deny';
  idempotency: 'repeat-safe' | 'reconcile';
}

export interface MissionSafeExecutorPermit extends MissionSafeExecutorDescriptor {
  missionId: string;
  actionKey: string;
  executorId: string;
  grantedPaths: string[];
  inputSnapshot: string;
  fencingEpoch: number;
  expiresAt: string;
  descriptorFingerprint: string;
}

export interface MissionSafeExecutorAuthorizationRequest {
  missionId: string;
  actionKey: string;
  executorId: string;
  grantedPaths: string[];
  inputSnapshot: string;
  fencingEpoch: number;
  expiresAt: string;
}

export type MissionSafeExecutorClassification =
  | { kind: 'safe-executor'; descriptor: MissionSafeExecutorDescriptor }
  | {
      kind: 'external-input-required';
      reason: 'legacy-shell-executor-unavailable-in-mission-mode';
      migration: 'register an exact argv Mission safe executor';
    };

export interface MissionSafeExecutorOptions {
  backend: MissionSandboxBackend;
  workspaceRoot: string;
  quarantineRoot: string;
  deniedReadPaths: string[];
  sourceEnv: NodeJS.ProcessEnv;
  allowedEnvKeys: string[];
  timeoutMs: number;
  capabilityProof: MissionExecutorProbeResult;
}

export interface MissionSafeExecutorReceipt {
  version: 1;
  missionId: string;
  actionKey: string;
  executorId: string;
  descriptorFingerprint: string;
  exitCode: number;
  termination: MissionProcessResult['termination'];
  stdoutSha256: string;
  stderrSha256: string;
  outputs: Array<{
    path: string;
    size: number;
    sha256: string;
  }>;
}

export interface MissionSafeExecutorResult {
  process: MissionProcessResult;
  receipt: MissionSafeExecutorReceipt;
}

export interface MissionSafeExecutorDependencies {
  runProcess?: (input: MissionProcessInput) => Promise<MissionProcessResult>;
  now?: () => Date;
}

export class MissionSafeExecutorRegistry {
  private readonly descriptors = new Map<string, MissionSafeExecutorDescriptor>();

  public constructor(descriptors: MissionSafeExecutorDescriptor[]) {
    for (const input of descriptors) {
      const descriptor = normalizeDescriptor(input);
      if (this.descriptors.has(descriptor.id)) {
        throw new Error(`Mission safe executor id is duplicated: ${descriptor.id}.`);
      }
      this.descriptors.set(descriptor.id, descriptor);
    }
  }

  public authorize(request: MissionSafeExecutorAuthorizationRequest): MissionSafeExecutorPermit {
    requireText(request.missionId, 'missionId');
    requireText(request.actionKey, 'actionKey');
    requireText(request.inputSnapshot, 'inputSnapshot');
    if (!Number.isSafeInteger(request.fencingEpoch) || request.fencingEpoch <= 0) {
      throw new Error('Mission safe executor fencingEpoch must be a positive integer.');
    }
    if (!Number.isFinite(Date.parse(request.expiresAt))) {
      throw new Error('Mission safe executor expiresAt must be an ISO timestamp.');
    }
    const descriptor = this.descriptors.get(request.executorId);
    if (!descriptor) {
      throw new Error(`Mission safe executor is not registered: ${request.executorId}.`);
    }
    const grantedPaths = uniqueSortedPaths(request.grantedPaths);
    if (grantedPaths.length === 0) {
      throw new Error('Mission safe executor granted scope must not be empty.');
    }
    for (const path of descriptor.readPaths) {
      if (!grantedPaths.some((grant) => scopePatternContainedBy(path, grant))) {
        throw new Error(`Mission safe executor path is outside granted scope: ${path}.`);
      }
    }
    return {
      ...structuredClone(descriptor),
      missionId: request.missionId,
      actionKey: request.actionKey,
      executorId: descriptor.id,
      grantedPaths,
      inputSnapshot: request.inputSnapshot,
      fencingEpoch: request.fencingEpoch,
      expiresAt: request.expiresAt,
      descriptorFingerprint: descriptorFingerprint(descriptor),
    };
  }

  public classify(input: string | { executorId: string }): MissionSafeExecutorClassification {
    if (typeof input === 'string') {
      return {
        kind: 'external-input-required',
        reason: 'legacy-shell-executor-unavailable-in-mission-mode',
        migration: 'register an exact argv Mission safe executor',
      };
    }
    const descriptor = this.descriptors.get(input.executorId);
    if (!descriptor) {
      throw new Error(`Mission safe executor is not registered: ${input.executorId}.`);
    }
    return { kind: 'safe-executor', descriptor: structuredClone(descriptor) };
  }

  public kinds(): MissionSafeExecutorKind[] {
    return Array.from(new Set([...this.descriptors.values()].map((descriptor) => descriptor.kind))).sort();
  }

  public validatePermit(
    permit: MissionSafeExecutorPermit,
    now: Date,
  ): MissionSafeExecutorPermit {
    const receivedDescriptor = normalizeDescriptor(permit);
    const registered = this.descriptors.get(permit.executorId);
    if (!registered
      || descriptorFingerprint(receivedDescriptor) !== permit.descriptorFingerprint
      || descriptorFingerprint(registered) !== permit.descriptorFingerprint) {
      throw new Error('Mission safe executor permit descriptor was modified or unregistered.');
    }
    if (Date.parse(permit.expiresAt) <= now.getTime()) {
      throw new Error('Mission safe executor permit has expired.');
    }
    const authorized = this.authorize({
      missionId: permit.missionId,
      actionKey: permit.actionKey,
      executorId: permit.executorId,
      grantedPaths: permit.grantedPaths,
      inputSnapshot: permit.inputSnapshot,
      fencingEpoch: permit.fencingEpoch,
      expiresAt: permit.expiresAt,
    });
    if (missionSafeExecutorPermitFingerprint(authorized)
      !== missionSafeExecutorPermitFingerprint(permit)) {
      throw new Error('Mission safe executor permit identity was modified.');
    }
    return authorized;
  }
}

export class MissionSafeExecutor {
  private readonly runProcess: (input: MissionProcessInput) => Promise<MissionProcessResult>;
  private readonly now: () => Date;

  public constructor(
    private readonly registry: MissionSafeExecutorRegistry,
    private readonly options: MissionSafeExecutorOptions,
    dependencies: MissionSafeExecutorDependencies = {},
  ) {
    const checks = new Set(options.capabilityProof.checks);
    if (!options.capabilityProof.supported
      || options.capabilityProof.backend !== options.backend
      || options.capabilityProof.failures.length > 0
      || missionExecutorRequiredChecks.some((check) => !checks.has(check))) {
      throw new Error('Mission safe executor requires a successful active capability proof.');
    }
    this.runProcess = dependencies.runProcess ?? runMissionProcess;
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(permit: MissionSafeExecutorPermit): Promise<MissionSafeExecutorResult> {
    const authorized = this.registry.validatePermit(permit, this.now());
    const existingOutputs = await inspectQuarantineOutputs(this.options.quarantineRoot);
    if (existingOutputs.length > 0) {
      throw new Error('Mission safe executor requires a fresh empty quarantine.');
    }
    const invocation = buildMissionSandboxInvocation({
      backend: this.options.backend,
      workspaceRoot: this.options.workspaceRoot,
      quarantineRoot: this.options.quarantineRoot,
      mode: authorized.writePaths.length > 0 ? 'quarantine-write' : 'read-only',
      command: authorized.executable,
      args: authorized.args,
      deniedReadPaths: this.options.deniedReadPaths,
    });
    const process = await this.runProcess({
      ...invocation,
      cwd: this.options.workspaceRoot,
      timeoutMs: this.options.timeoutMs,
      sourceEnv: this.options.sourceEnv,
      allowedEnvKeys: this.options.allowedEnvKeys,
    });
    const outputs = await inspectQuarantineOutputs(this.options.quarantineRoot);
    const undeclared = outputs.filter((output) =>
      !authorized.writePaths.some((pattern) => globMatches(pattern, output.path)));
    if (undeclared.length > 0) {
      throw new Error(`Mission safe executor produced undeclared quarantine output: ${undeclared[0]!.path}.`);
    }
    return {
      process,
      receipt: {
        version: 1,
        missionId: authorized.missionId,
        actionKey: authorized.actionKey,
        executorId: authorized.executorId,
        descriptorFingerprint: authorized.descriptorFingerprint,
        exitCode: process.exitCode,
        termination: process.termination,
        stdoutSha256: hash(process.stdout),
        stderrSha256: hash(process.stderr),
        outputs,
      },
    };
  }
}

export function missionSafeExecutorPermitFingerprint(permit: MissionSafeExecutorPermit): string {
  return hash(JSON.stringify([
    'mission-safe-executor-permit-v1',
    permit.missionId,
    permit.actionKey,
    permit.executorId,
    permit.descriptorFingerprint,
    permit.grantedPaths,
    permit.inputSnapshot,
    permit.fencingEpoch,
    permit.expiresAt,
  ]));
}

function normalizeDescriptor(input: MissionSafeExecutorDescriptor): MissionSafeExecutorDescriptor {
  const id = requireText(input.id, 'id');
  if (!missionSafeExecutorKinds.includes(input.kind)) {
    throw new Error(`Mission safe executor kind is invalid: ${String(input.kind)}.`);
  }
  if (!isAbsolute(input.executable)) {
    throw new Error('Mission safe executor executable must be absolute.');
  }
  if (['sh', 'bash', 'zsh', 'fish', 'dash', 'env'].includes(basename(input.executable))) {
    throw new Error('Mission safe executor forbids shell executables.');
  }
  if (input.args.some((arg) => arg.includes('\0') || /\$\(|`|\|\||&&|[<>;]/u.test(arg))) {
    throw new Error('Mission safe executor arguments contain shell-control syntax.');
  }
  if (input.network !== 'deny') {
    throw new Error('Mission safe executor network must be denied.');
  }
  if (input.idempotency !== 'repeat-safe' && input.idempotency !== 'reconcile') {
    throw new Error('Mission safe executor idempotency is invalid.');
  }
  const readPaths = uniqueSortedPaths(input.readPaths);
  const writePaths = uniqueSortedPaths(input.writePaths);
  if (readPaths.length === 0) {
    throw new Error('Mission safe executor requires finite read scope.');
  }
  for (const path of [...readPaths, ...writePaths]) {
    assertMissionPathPattern(path, 'Mission safe executor path');
    if (missionDefaultDeniedRepositoryPaths.some((denied) =>
      missionPathPatternsOverlap(path, denied))) {
      throw new Error(`Mission safe executor path overlaps a denied repository path: ${path}.`);
    }
  }
  return {
    id,
    kind: input.kind,
    executable: input.executable,
    args: [...input.args],
    readPaths,
    writePaths,
    network: 'deny',
    idempotency: input.idempotency,
  };
}

function descriptorFingerprint(descriptor: MissionSafeExecutorDescriptor): string {
  return hash(JSON.stringify([
    'mission-safe-executor-descriptor-v1',
    descriptor.id,
    descriptor.kind,
    descriptor.executable,
    descriptor.args,
    descriptor.readPaths,
    descriptor.writePaths,
    descriptor.network,
    descriptor.idempotency,
  ]));
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function inspectQuarantineOutputs(root: string): Promise<MissionSafeExecutorReceipt['outputs']> {
  const paths: string[] = [];
  await walk('');
  const outputs: MissionSafeExecutorReceipt['outputs'] = [];
  for (const path of paths.sort()) {
    const inspected = await inspectCanonicalFile({
      root,
      path,
      deniedPaths: [],
      missing: 'reject',
    });
    if (!inspected) throw new Error(`Mission safe executor quarantine output disappeared: ${path}.`);
    outputs.push({
      path,
      size: inspected.identity.size,
      sha256: `sha256:${inspected.identity.sha256}`,
    });
  }
  return outputs;

  async function walk(relativeDirectory: string): Promise<void> {
    const directory = relativeDirectory ? join(root, relativeDirectory) : root;
    const entries = await readdir(directory);
    for (const entry of entries) {
      const relativePath = normalizePath(relativeDirectory
        ? `${relativeDirectory}/${entry}` : entry);
      const info = await lstat(join(root, relativePath));
      if (info.isSymbolicLink()) {
        throw new Error(`Mission safe executor refuses symbolic quarantine output: ${relativePath}.`);
      }
      if (info.isDirectory()) {
        await walk(relativePath);
      } else if (info.isFile()) {
        paths.push(relativePath);
      } else {
        throw new Error(`Mission safe executor refuses non-regular quarantine output: ${relativePath}.`);
      }
    }
  }
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Mission safe executor ${field} must be non-empty.`);
  }
  return normalized;
}
