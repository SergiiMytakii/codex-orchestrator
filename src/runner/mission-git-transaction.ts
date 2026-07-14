import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { ProcessExecutor } from '../process/command.js';
import { defaultProcessExecutor } from '../process/command.js';
import type { MissionPatchFile } from './mission-patch-audit.js';
import { auditMissionPatch } from './mission-patch-audit.js';
import {
  createMissionApplyPermit,
  missionApplyPermitFingerprint,
  validateMissionGitCommitIdentity,
  validateMissionApplyPermit,
  type MissionApplyPermit,
  type MissionApplyReceipt,
  type MissionGitCommitIdentity,
  type MissionGitManifestEntry,
  type MissionPatchCandidate,
} from './mission-git-contracts.js';
import type { MissionStateExclusiveSession } from './mission-state-store.js';
import { MissionStateStore } from './mission-state-store.js';
import { transitionMission } from './mission-state-machine.js';
import { acquireMissionCoordinatorLock } from './mission-coordinator-lock.js';

export {
  createMissionApplyPermit,
  missionApplyPermitFingerprint,
  type MissionApplyPermit,
  type MissionApplyReceipt,
  type MissionGitCommitIdentity,
  type MissionGitManifestEntry,
  type MissionPatchCandidate,
} from './mission-git-contracts.js';

export const missionGitBoundaries = [
  'base-verified',
  'isolated-index-created',
  'patch-applied',
  'tree-written',
  'manifest-proved',
  'commit-created',
  'intent-persisted',
  'ref-updated',
  'receipt-persisted',
] as const;

export type MissionGitBoundary = (typeof missionGitBoundaries)[number];
const missionGitProcessBootNonce = randomUUID();
const missionDurableGitConfig = [
  '-c', 'core.fsync=all',
  '-c', 'core.fsyncMethod=fsync',
] as const;

export interface MissionBinaryProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export type MissionBinaryProcessExecutor = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
  },
) => Promise<MissionBinaryProcessResult>;

export const defaultMissionBinaryProcessExecutor: MissionBinaryProcessExecutor = (
  file,
  args,
  options,
) => new Promise((resolve, reject) => {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let terminationError: Error | undefined;
  let settled = false;
  const timeout = setTimeout(() => {
    terminationError ??= new Error('Mission binary process timed out.');
    child.kill('SIGKILL');
  }, options.timeoutMs);
  timeout.unref();
  const collect = (target: Buffer[], chunk: Buffer) => {
    if (terminationError) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > options.maxOutputBytes) {
      terminationError = new Error('Mission binary process exceeded its output limit.');
      child.kill('SIGKILL');
      return;
    }
    target.push(chunk);
  };
  child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reject(error);
  });
  child.on('close', (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (terminationError) {
      reject(terminationError);
      return;
    }
    resolve({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode: exitCode ?? 1,
    });
  });
});

export class MissionGitSafetyStopError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MissionGitSafetyStopError';
  }
}

export class MissionGitIntegrationConflictError extends Error {
  public constructor(public readonly paths: string[]) {
    super(`Mission tree integration has conflicts: ${paths.join(', ') || 'unknown paths'}.`);
    this.name = 'MissionGitIntegrationConflictError';
  }
}

export class MissionGitReauthorizationRequiredError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MissionGitReauthorizationRequiredError';
  }
}

export interface MissionTreeIntegrationCandidate {
  baseCommit: string;
  parentCommit: string;
  childCommit: string;
  parentTree: string;
  treeSha: string;
  commitSha: string;
  manifest: MissionGitManifestEntry[];
}

export interface BuildMissionPatchCandidateInput {
  targetRoot: string;
  baseCommit: string;
  patch: string;
  auditedFiles: MissionPatchFile[];
  commit: MissionGitCommitIdentity;
  execute?: ProcessExecutor;
  executeBinary?: MissionBinaryProcessExecutor;
  onBoundary?: (boundary: MissionGitBoundary) => void | Promise<void>;
  temporaryRoot?: string;
}

export async function buildMissionPatchCandidate(
  input: BuildMissionPatchCandidateInput,
): Promise<MissionPatchCandidate> {
  const execute = input.execute ?? defaultProcessExecutor;
  const commit = validateMissionGitCommitIdentity(input.commit);
  assertAuditedPatch(input.patch, input.auditedFiles);
  const baseCommit = await resolveObject(
    execute,
    input.targetRoot,
    `${input.baseCommit}^{commit}`,
    'base commit',
  );
  if (baseCommit !== input.baseCommit) {
    throw new Error('Mission Git base commit must be the full canonical object ID.');
  }
  const baseTree = await resolveObject(execute, input.targetRoot, `${baseCommit}^{tree}`, 'base tree');
  await emit(input.onBoundary, 'base-verified');
  const transactionRoot = input.temporaryRoot
    ? await createMissionGitTemporaryDirectory(input.temporaryRoot)
    : await mkdtemp(join(tmpdir(), 'codex-mission-git-index-'));
  try {
    const indexPath = join(transactionRoot, 'index');
    const worktreePath = join(transactionRoot, 'worktree');
    await mkdir(worktreePath);
    const environment = gitEnvironment(indexPath, worktreePath, transactionRoot, commit);
    await git(execute, input.targetRoot, ['read-tree', baseTree], { environment });
    await emit(input.onBoundary, 'isolated-index-created');
    await git(execute, input.targetRoot, [
      'apply', '--cached', '--whitespace=nowarn', '-p1', '-',
    ], { environment, stdin: input.patch });
    await emit(input.onBoundary, 'patch-applied');
    const treeSha = objectId((await git(
      execute,
      input.targetRoot,
      ['write-tree'],
      { environment },
    )).stdout, 'candidate tree');
    await emit(input.onBoundary, 'tree-written');
    const manifest = await readManifest(
      execute,
      input.executeBinary ?? defaultMissionBinaryProcessExecutor,
      input.targetRoot,
      baseTree,
      treeSha,
      environment,
    );
    assertExactManifestShape(manifest, input.auditedFiles);
    await emit(input.onBoundary, 'manifest-proved');
    const commitSha = objectId((await git(execute, input.targetRoot, [
      'commit-tree', treeSha, '-p', baseCommit, '-F', '-',
    ], { environment, stdin: commit.message })).stdout, 'candidate commit');
    await emit(input.onBoundary, 'commit-created');
    const committedTree = await resolveObject(execute, input.targetRoot, `${commitSha}^{tree}`, 'committed tree');
    if (committedTree !== treeSha) {
      throw new MissionGitSafetyStopError('candidate-tree-mismatch', 'Candidate commit tree differs from the proved tree.');
    }
    return {
      baseCommit,
      baseTree,
      patchSha256: sha256(input.patch),
      treeSha,
      commitSha,
      manifest,
    };
  } finally {
    await rm(transactionRoot, { recursive: true, force: true });
  }
}

export async function buildMissionTreeIntegrationCandidate(input: {
  targetRoot: string;
  baseCommit: string;
  parentCommit: string;
  childCommit: string;
  commit: MissionGitCommitIdentity;
  execute?: ProcessExecutor;
  executeBinary?: MissionBinaryProcessExecutor;
}): Promise<MissionTreeIntegrationCandidate> {
  const execute = input.execute ?? defaultProcessExecutor;
  const commit = validateMissionGitCommitIdentity(input.commit);
  const baseCommit = await resolveObject(execute, input.targetRoot, `${input.baseCommit}^{commit}`, 'integration base commit');
  const parentCommit = await resolveObject(execute, input.targetRoot, `${input.parentCommit}^{commit}`, 'integration parent commit');
  const childCommit = await resolveObject(execute, input.targetRoot, `${input.childCommit}^{commit}`, 'integration child commit');
  if (baseCommit !== input.baseCommit || parentCommit !== input.parentCommit || childCommit !== input.childCommit) {
    throw new Error('Mission integration commits must be full canonical object IDs.');
  }
  const parentTree = await resolveObject(execute, input.targetRoot, `${parentCommit}^{tree}`, 'integration parent tree');
  const environment = gitEnvironment('', '', tmpdir(), commit);
  delete environment.GIT_INDEX_FILE;
  delete environment.GIT_WORK_TREE;
  const objectPathValue = (await git(execute, input.targetRoot, [
    'rev-parse', '--git-path', 'objects',
  ], { environment })).stdout.trim();
  const objectDirectory = isAbsolute(objectPathValue)
    ? objectPathValue
    : join(input.targetRoot, objectPathValue);
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'codex-mission-integration-'));
  try {
    await git(execute, input.targetRoot, ['init', '--bare', isolatedRoot], { environment });
    await writeFile(join(isolatedRoot, 'objects', 'info', 'alternates'), `${objectDirectory}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const isolatedEnvironment = {
      ...environment,
      GIT_DIR: isolatedRoot,
      GIT_OBJECT_DIRECTORY: join(isolatedRoot, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory,
    };
    await assertNoExternalMergeDrivers(execute, input.targetRoot, [
      baseCommit, parentCommit, childCommit,
    ], isolatedEnvironment);
    const merged = await execute('git', durableGitArguments([
      '-c', 'core.attributesFile=/dev/null',
      'merge-tree', '--write-tree', '--name-only', '--no-messages',
      '--merge-base', baseCommit, parentCommit, childCommit,
    ]), { cwd: input.targetRoot, env: isolatedEnvironment, timeoutMs: 60_000 });
    const lines = merged.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
    if (merged.exitCode !== 0) {
      if (merged.exitCode === 1 && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(lines[0] ?? '')) {
        throw new MissionGitIntegrationConflictError(lines.slice(1));
      }
      throw new Error(`Mission merge-tree command failed: ${merged.stderr.trim() || `exit ${merged.exitCode}`}`);
    }
    const treeSha = objectId(lines[0] ?? '', 'integration tree');
    if (lines.length !== 1) {
      throw new MissionGitSafetyStopError('integration-output-mismatch', 'Mission merge-tree returned unexpected non-conflict output.');
    }
    const commitSha = objectId((await git(execute, input.targetRoot, [
      'commit-tree', treeSha, '-p', parentCommit, '-p', childCommit, '-F', '-',
    ], { environment: isolatedEnvironment, stdin: commit.message })).stdout, 'integration commit');
    await git(execute, input.targetRoot, [
      'fetch', '--no-tags', '--no-write-fetch-head', isolatedRoot, commitSha,
    ], { environment });
    const manifest = await readManifest(
      execute,
      input.executeBinary ?? defaultMissionBinaryProcessExecutor,
      input.targetRoot,
      parentTree,
      treeSha,
      environment,
    );
    return {
      baseCommit,
      parentCommit,
      childCommit,
      parentTree,
      treeSha,
      commitSha,
      manifest,
    };
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

export async function applyMissionTreeIntegration(input: {
  targetRoot: string;
  targetRef: string;
  baseCommit: string;
  parentCommit: string;
  childCommit: string;
  commit: MissionGitCommitIdentity;
  fencingEpoch: number;
  assertOwnership: (fencingEpoch: number) => void | Promise<void>;
  execute?: ProcessExecutor;
  executeBinary?: MissionBinaryProcessExecutor;
}): Promise<MissionTreeIntegrationCandidate> {
  if (!/^refs\/(?:heads|codex-orchestrator)\/[A-Za-z0-9._\/-]+$/u.test(input.targetRef)) {
    throw new Error('Mission integration target ref is invalid.');
  }
  const execute = input.execute ?? defaultProcessExecutor;
  const candidate = await buildMissionTreeIntegrationCandidate(input);
  if (await isSymbolicRef(execute, input.targetRoot, input.targetRef)) {
    throw new MissionGitSafetyStopError(
      'symbolic-target-ref-forbidden',
      'Mission integration target ref must be a direct ref.',
    );
  }
  const current = await resolveObject(execute, input.targetRoot, input.targetRef, 'integration target ref');
  const committedTree = await resolveObject(execute, input.targetRoot, `${candidate.commitSha}^{tree}`, 'integration committed tree');
  if (committedTree !== candidate.treeSha) {
    throw new MissionGitSafetyStopError('integration-tree-mismatch', 'Mission integration candidate exposes an unexpected tree.');
  }
  const parentLine = (await git(execute, input.targetRoot, [
    'rev-list', '--parents', '-n', '1', candidate.commitSha,
  ], { environment: readOnlyGitEnvironment() })).stdout.trim();
  if (parentLine !== `${candidate.commitSha} ${candidate.parentCommit} ${candidate.childCommit}`) {
    throw new MissionGitSafetyStopError('integration-parent-mismatch', 'Mission integration candidate has unexpected parents.');
  }
  if (current === candidate.commitSha) {
    return withConfirmedDirectRefDurability(
      execute, input.targetRoot, input.targetRef, candidate.commitSha, async () => candidate,
    );
  }
  if (current !== candidate.parentCommit) {
    throw new MissionGitSafetyStopError('integration-target-third-identity', 'Mission integration target ref moved away from its parent commit.');
  }
  await input.assertOwnership(input.fencingEpoch);
  const result = await executeGuardedRefUpdate(
    execute,
    input.targetRoot,
    input.targetRef,
    candidate.commitSha,
    candidate.parentCommit,
  );
  if (result.exitCode !== 0) {
    if (await isSymbolicRef(execute, input.targetRoot, input.targetRef)) {
      throw new MissionGitSafetyStopError('symbolic-target-ref-forbidden', 'Mission integration target became symbolic during apply.');
    }
    const reconciled = await resolveObject(execute, input.targetRoot, input.targetRef, 'integration target ref');
    if (reconciled === candidate.parentCommit) {
      throw new MissionGitReauthorizationRequiredError(
        'integration-cas-retry-required',
        'Mission integration ref remains at the old identity after CAS contention.',
      );
    }
    if (reconciled !== candidate.commitSha) {
      throw new MissionGitSafetyStopError('integration-ref-compare-and-swap-failed', 'Mission integration ref compare-and-swap failed.');
    }
  }
  if (await isSymbolicRef(execute, input.targetRoot, input.targetRef)) {
    throw new MissionGitSafetyStopError('symbolic-target-ref-forbidden', 'Mission integration target became symbolic during apply.');
  }
  const exposedTree = await resolveObject(execute, input.targetRoot, `${input.targetRef}^{tree}`, 'integration exposed tree');
  if (exposedTree !== candidate.treeSha) {
    throw new MissionGitSafetyStopError('integration-tree-mismatch', 'Mission integration ref exposes an unexpected tree.');
  }
  return withConfirmedDirectRefDurability(
    execute, input.targetRoot, input.targetRef, candidate.commitSha, async () => candidate,
  );
}

export interface MissionGitTransactionOptions {
  targetRoot: string;
  stateStore: MissionStateStore;
  assertOwnership: (fencingEpoch: number) => void | Promise<void>;
  execute?: ProcessExecutor;
  executeBinary?: MissionBinaryProcessExecutor;
  now?: () => Date;
  onBoundary?: (boundary: MissionGitBoundary) => void | Promise<void>;
}

export class MissionGitTransaction {
  private readonly execute: ProcessExecutor;
  private readonly now: () => Date;

  public constructor(private readonly options: MissionGitTransactionOptions) {
    this.execute = options.execute ?? defaultProcessExecutor;
    this.now = options.now ?? (() => new Date());
  }

  public async apply(permitValue: MissionApplyPermit, patch: string): Promise<MissionApplyReceipt> {
    const permit = validateMissionApplyPermit(permitValue);
    if (sha256(patch) !== permit.patchSha256) {
      throw new MissionGitSafetyStopError('patch-digest-mismatch', 'Mission apply patch digest does not match the permit.');
    }
    const temporaryRoot = await this.options.stateStore.temporaryDirectory('mission-git-tmp');
    const candidate = await buildMissionPatchCandidate({
      targetRoot: this.options.targetRoot,
      baseCommit: permit.expectedOldCommit,
      patch,
      auditedFiles: permit.manifest.map(({ path, operation, oldMode, newMode }) => ({
        path, operation, oldMode, newMode,
      })),
      commit: permit.commit,
      execute: this.execute,
      executeBinary: this.options.executeBinary,
      onBoundary: this.options.onBoundary,
      temporaryRoot,
    });
    assertCandidateMatchesPermit(candidate, permit);
    return this.options.stateStore.exclusive(async (session) => {
      const prepared = await this.prepareIntent(session, permit);
      if (await isSymbolicRef(this.execute, this.options.targetRoot, permit.targetRef)) {
        return this.persistSafetyStop(session, permit, 'symbolic-target-ref-forbidden',
          'Mission apply target ref must be a direct ref.');
      }
      const current = await this.readTargetIdentity(permit);
      if (prepared.receipt) {
        if (current?.commit === permit.expectedNewCommit && current.tree === permit.expectedNewTree) {
          return prepared.receipt;
        }
        return this.persistSafetyStop(session, permit, 'receipt-ref-mismatch',
          'Mission stored receipt no longer matches the target ref and tree.');
      }
      if (current?.commit === permit.expectedNewCommit && current.tree === permit.expectedNewTree) {
        return withConfirmedDirectRefDurability(
          this.execute, this.options.targetRoot, permit.targetRef, permit.expectedNewCommit,
          () => this.persistReceipt(session, permit, prepared.generation, true),
        );
      }
      if (!current || !this.isOldIdentity(current, permit)) {
        return this.persistSafetyStop(session, permit, 'target-ref-third-identity',
          'Mission target ref is neither the permitted old identity nor the expected new identity.');
      }
      if (this.now().getTime() >= Date.parse(permit.expiresAt)) {
        return this.persistReauthorization(session, permit, 'permit-expired',
          'Mission apply permit expired before ref mutation.');
      }
      await this.options.assertOwnership(permit.fencingEpoch);
      const updated = await executeGuardedRefUpdate(
        this.execute,
        this.options.targetRoot,
        permit.targetRef,
        permit.expectedNewCommit,
        permit.expectedOldCommit,
      );
      if (updated.exitCode !== 0) {
        if (await isSymbolicRef(this.execute, this.options.targetRoot, permit.targetRef)) {
          return this.persistSafetyStop(session, permit, 'symbolic-target-ref-forbidden',
            'Mission apply target became symbolic during compare-and-swap.');
        }
        const reconciled = await this.readTargetIdentity(permit);
        if (reconciled && this.isOldIdentity(reconciled, permit)) {
          return this.persistReauthorization(session, permit, 'cas-retry-required',
            'Mission target ref remains at the old identity after CAS contention.');
        }
        if (reconciled?.commit !== permit.expectedNewCommit || reconciled.tree !== permit.expectedNewTree) {
          return this.persistSafetyStop(
            session,
            permit,
            'target-ref-compare-and-swap-failed',
            `Mission target ref compare-and-swap failed: ${updated.stderr.trim()}`,
          );
        }
      }
      await emit(this.options.onBoundary, 'ref-updated');
      if (await isSymbolicRef(this.execute, this.options.targetRoot, permit.targetRef)) {
        return this.persistSafetyStop(session, permit, 'symbolic-target-ref-forbidden',
          'Mission apply target became symbolic after compare-and-swap.');
      }
      const verified = await this.readTargetIdentity(permit);
      if (verified?.commit !== permit.expectedNewCommit || verified.tree !== permit.expectedNewTree) {
        return this.persistSafetyStop(session, permit, 'post-update-ref-mismatch',
          'Mission target ref does not expose the permitted commit and tree.');
      }
      return withConfirmedDirectRefDurability(
        this.execute, this.options.targetRoot, permit.targetRef, permit.expectedNewCommit,
        () => this.persistReceipt(session, permit, prepared.generation, false),
      );
    });
  }

  public async recover(permitValue: MissionApplyPermit): Promise<MissionApplyReceipt> {
    const permit = validateMissionApplyPermit(permitValue);
    return this.options.stateStore.exclusive(async (session) => {
      const snapshot = await session.load();
      const mission = snapshot.missions[permit.missionId];
      const fingerprint = missionApplyPermitFingerprint(permit);
      if (!mission?.applyIntent || mission.applyIntent.permitFingerprint !== fingerprint) {
        throw new MissionGitSafetyStopError('apply-intent-mismatch', 'Mission recovery requires the exact durable apply intent.');
      }
      if (await isSymbolicRef(this.execute, this.options.targetRoot, permit.targetRef)) {
        return this.persistSafetyStop(session, permit, 'symbolic-target-ref-forbidden',
          'Mission apply target ref must be a direct ref.');
      }
      const current = await this.readTargetIdentity(permit);
      if (mission.applyReceipt) {
        if (current?.commit === permit.expectedNewCommit && current.tree === permit.expectedNewTree) {
          return mission.applyReceipt;
        }
        return this.persistSafetyStop(session, permit, 'receipt-ref-mismatch',
          'Mission stored receipt no longer matches the target ref and tree.');
      }
      if (current?.commit === permit.expectedNewCommit && current.tree === permit.expectedNewTree) {
        return withConfirmedDirectRefDurability(
          this.execute, this.options.targetRoot, permit.targetRef, permit.expectedNewCommit,
          () => this.persistReceipt(session, permit, snapshot.generation, true),
        );
      }
      if (current && this.isOldIdentity(current, permit)) {
        return this.persistReauthorization(session, permit, 'old-identity',
          'Mission apply ref remains at the old identity; a fresh apply authorization is required.');
      }
      return this.persistSafetyStop(session, permit, 'target-ref-third-identity',
        'Mission target ref is neither the permitted old identity nor the expected new identity.');
    });
  }

  private async prepareIntent(
    session: MissionStateExclusiveSession,
    permit: MissionApplyPermit,
  ): Promise<{ generation: number; receipt?: MissionApplyReceipt }> {
    let snapshot = await session.load();
    const mission = snapshot.missions[permit.missionId];
    const fingerprint = missionApplyPermitFingerprint(permit);
    if (!mission || !['apply-prepared', 'applying', 'reconciling'].includes(mission.state)) {
      throw new MissionGitSafetyStopError('mission-state-mismatch', 'Mission is not in an apply state.');
    }
    if (!mission.applyPermit
      || missionApplyPermitFingerprint(mission.applyPermit) !== fingerprint
      || mission.actionKey !== permit.actionKey
      || mission.fencingEpoch !== permit.fencingEpoch) {
      throw new MissionGitSafetyStopError(
        'apply-permit-mismatch',
        'Mission candidate manifest or durable apply permit does not match.',
      );
    }
    if (mission.applyReceipt) return { generation: snapshot.generation, receipt: mission.applyReceipt };
    if (mission.applyIntent) {
      if (mission.applyIntent.permitFingerprint !== fingerprint) {
        throw new MissionGitSafetyStopError('apply-intent-mismatch', 'Mission has a different durable apply intent.');
      }
      return { generation: snapshot.generation };
    }
    snapshot = await session.mutate(snapshot.generation, (draft) => {
      const current = draft.missions[permit.missionId];
      if (!current) throw new Error('Mission disappeared while persisting apply intent.');
      const intent = {
        version: 1,
        permitFingerprint: fingerprint,
        permit,
        preparedAt: this.now().toISOString(),
      } as const;
      draft.missions[permit.missionId] = transitionMission(current, {
        type: 'apply-started',
        intent,
      });
    });
    await emit(this.options.onBoundary, 'intent-persisted');
    return { generation: snapshot.generation };
  }

  private async persistReceipt(
    session: MissionStateExclusiveSession,
    permit: MissionApplyPermit,
    expectedGeneration: number,
    recovered: boolean,
  ): Promise<MissionApplyReceipt> {
    const current = await session.load();
    const mission = current.missions[permit.missionId];
    if (mission?.applyReceipt) return mission.applyReceipt;
    if (current.generation !== expectedGeneration) {
      throw new MissionGitSafetyStopError('state-generation-moved', 'Mission state generation moved while the apply lock was held.');
    }
    const receipt: MissionApplyReceipt = {
      version: 1,
      permitFingerprint: missionApplyPermitFingerprint(permit),
      targetRef: permit.targetRef,
      oldCommitSha: permit.expectedOldCommit,
      commitSha: permit.expectedNewCommit,
      treeSha: permit.expectedNewTree,
      recovered,
      appliedAt: this.now().toISOString(),
    };
    await session.mutate(expectedGeneration, (draft) => {
      const aggregate = draft.missions[permit.missionId];
      if (!aggregate?.applyIntent
        || aggregate.applyIntent.permitFingerprint !== receipt.permitFingerprint) {
        throw new MissionGitSafetyStopError('apply-intent-mismatch', 'Mission apply intent changed before receipt persistence.');
      }
      draft.missions[permit.missionId] = transitionMission(aggregate, {
        type: 'apply-reconciled-new-identity',
        intent: aggregate.applyIntent,
        receipt,
      });
    });
    await emit(this.options.onBoundary, 'receipt-persisted');
    return receipt;
  }

  private async readTargetIdentity(permit: MissionApplyPermit): Promise<{ commit: string; tree: string } | undefined> {
    const observed = await this.execute('git', ['rev-parse', '--verify', '--quiet', permit.targetRef], {
      cwd: this.options.targetRoot,
      env: readOnlyGitEnvironment(),
      timeoutMs: 60_000,
    });
    if (observed.exitCode === 1) return undefined;
    if (observed.exitCode !== 0) {
      throw new Error(`Mission Git target ref lookup failed: ${observed.stderr.trim()}`);
    }
    const commit = objectId(observed.stdout, 'target ref');
    if (commit !== permit.expectedOldCommit && commit !== permit.expectedNewCommit) {
      return { commit, tree: '' };
    }
    const observedTree = await this.execute('git', ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], {
      cwd: this.options.targetRoot,
      env: readOnlyGitEnvironment(),
      timeoutMs: 60_000,
    });
    if (observedTree.exitCode !== 0) return { commit, tree: '' };
    const tree = objectId(observedTree.stdout, 'target tree');
    return { commit, tree };
  }

  private isOldIdentity(
    current: { commit: string; tree: string },
    permit: MissionApplyPermit,
  ): boolean {
    return current.commit === permit.expectedOldCommit && current.tree === permit.expectedOldTree;
  }

  private async persistReauthorization(
    session: MissionStateExclusiveSession,
    permit: MissionApplyPermit,
    code: string,
    message: string,
  ): Promise<never> {
    const snapshot = await session.load();
    await session.mutate(snapshot.generation, (draft) => {
      const mission = draft.missions[permit.missionId];
      if (!mission) throw new Error('Mission disappeared during apply reconciliation.');
      draft.missions[permit.missionId] = transitionMission(mission, {
        type: 'apply-reconciled-old-identity',
      });
    });
    throw new MissionGitReauthorizationRequiredError(code, message);
  }

  private async persistSafetyStop(
    session: MissionStateExclusiveSession,
    permit: MissionApplyPermit,
    code: string,
    message: string,
  ): Promise<never> {
    const snapshot = await session.load();
    await session.mutate(snapshot.generation, (draft) => {
      const mission = draft.missions[permit.missionId];
      if (!mission) throw new Error('Mission disappeared during apply safety reconciliation.');
      draft.missions[permit.missionId] = transitionMission(mission, {
        type: 'apply-reconciled-third-identity',
      });
    });
    throw new MissionGitSafetyStopError(code, message);
  }
}

async function isSymbolicRef(
  execute: ProcessExecutor,
  targetRoot: string,
  targetRef: string,
): Promise<boolean> {
  const result = await execute('git', ['symbolic-ref', '--quiet', targetRef], {
    cwd: targetRoot,
    env: readOnlyGitEnvironment(),
    timeoutMs: 60_000,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(`Mission Git symbolic-ref inspection failed: ${result.stderr.trim()}`);
}

async function readManifest(
  execute: ProcessExecutor,
  executeBinary: MissionBinaryProcessExecutor,
  targetRoot: string,
  baseTree: string,
  treeSha: string,
  environment: Record<string, string>,
): Promise<MissionGitManifestEntry[]> {
  const raw = (await git(execute, targetRoot, [
    'diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-renames', baseTree, treeSha,
  ], { environment })).stdout;
  const fields = raw.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) throw new Error('Mission Git raw diff output is malformed.');
  const manifest: MissionGitManifestEntry[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const metadata = fields[index] ?? '';
    const path = fields[index + 1] ?? '';
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([AMD])$/u.exec(metadata);
    if (!match || path.length === 0) throw new Error('Mission Git raw diff record is malformed.');
    const operation = match[5] === 'A' ? 'add' : match[5] === 'D' ? 'delete' : 'modify';
    const beforeBlob = operation === 'add' ? null : match[3]!;
    const afterBlob = operation === 'delete' ? null : match[4]!;
    manifest.push({
      path,
      operation,
      oldMode: operation === 'add' ? null : match[1]!,
      newMode: operation === 'delete' ? null : match[2]!,
      beforeBlob,
      afterBlob,
      beforeSha256: beforeBlob ? await hashGitBlob(executeBinary, targetRoot, beforeBlob, environment) : null,
      afterSha256: afterBlob ? await hashGitBlob(executeBinary, targetRoot, afterBlob, environment) : null,
    });
  }
  return manifest.sort((left, right) => left.path.localeCompare(right.path));
}

function hashGitBlob(
  executeBinary: MissionBinaryProcessExecutor,
  targetRoot: string,
  object: string,
  environment: Record<string, string>,
): Promise<string> {
  return executeBinary('git', ['cat-file', 'blob', object], {
    cwd: targetRoot,
    env: environment,
    timeoutMs: 60_000,
    maxOutputBytes: 256 * 1024 * 1024,
  }).then((result) => {
    if (result.exitCode !== 0) {
      throw new Error(`Mission Git blob hashing failed: ${result.stderr.toString('utf8').trim()}`);
    }
    return `sha256:${createHash('sha256').update(result.stdout).digest('hex')}`;
  });
}

async function createMissionGitTemporaryDirectory(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  const currentBootNonce = missionGitProcessBootNonce.replaceAll('-', '');
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^candidate-(\d+)-([a-f0-9]{32})-[a-f0-9-]{36}$/u.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[1]);
    const bootNonce = match[2]!;
    const ownedByThisProcess = pid === process.pid && bootNonce === currentBootNonce;
    if (ownedByThisProcess || (pid !== process.pid && processAlive(pid))) continue;
    await rm(join(parent, entry.name), { recursive: true, force: true });
  }
  const path = join(parent, `candidate-${process.pid}-${currentBootNonce}-${randomUUID()}`);
  await mkdir(path);
  await writeFile(join(path, 'owner.json'), `${JSON.stringify({
    version: 1,
    pid: process.pid,
    bootNonce: missionGitProcessBootNonce,
  })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function assertNoExternalMergeDrivers(
  execute: ProcessExecutor,
  targetRoot: string,
  commits: string[],
  environment: Record<string, string>,
): Promise<void> {
  for (const commit of commits) {
    const listing = (await git(execute, targetRoot, [
      'ls-tree', '-r', '-z', '--full-tree', commit,
    ], { environment })).stdout;
    for (const record of listing.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) blob ([a-f0-9]+)\t(.+)$/u.exec(record);
      if (!match || (match[3] !== '.gitattributes' && !match[3]!.endsWith('/.gitattributes'))) continue;
      const attributes = (await git(execute, targetRoot, ['cat-file', 'blob', match[2]!], { environment })).stdout;
      assertNoCustomMergeAttribute(attributes, `${commit}:${match[3]}`);
    }
  }
}

function assertNoCustomMergeAttribute(content: string, source: string): void {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/(^|[^\\])#.*/u, '$1').trim();
    if (line.length === 0) continue;
    for (const token of line.split(/\s+/u).slice(1)) {
      const match = /^merge=(.+)$/u.exec(token);
      if (match && !new Set(['text', 'binary', 'union']).has(match[1]!)) {
        throw new MissionGitSafetyStopError(
          'external-merge-driver-forbidden',
          `Mission tree integration forbids custom merge attribute ${token} from ${source}.`,
        );
      }
    }
  }
}

function assertAuditedPatch(patch: string, auditedFiles: MissionPatchFile[]): void {
  const audit = auditMissionPatch({
    patch,
    grantedPaths: auditedFiles.map((file) => file.path),
    deniedPaths: [],
    maxBytes: Math.max(1, Buffer.byteLength(patch, 'utf8')),
  });
  if (!audit.accepted) throw new Error(`Mission Git patch is not auditable: ${audit.reason}.`);
  const expected = canonicalManifestShape(auditedFiles);
  const actual = canonicalManifestShape(audit.files);
  if (actual !== expected) throw new Error('Mission Git patch audit does not match the supplied audited files.');
}

function assertExactManifestShape(manifest: MissionGitManifestEntry[], auditedFiles: MissionPatchFile[]): void {
  const actual = canonicalManifestShape(manifest);
  const expected = canonicalManifestShape(auditedFiles);
  if (actual !== expected) {
    throw new MissionGitSafetyStopError('candidate-manifest-mismatch', 'Mission candidate manifest differs from the audited patch manifest.');
  }
}

function assertCandidateMatchesPermit(candidate: MissionPatchCandidate, permit: MissionApplyPermit): void {
  const candidateIdentity = canonicalJson({
    baseCommit: candidate.baseCommit,
    baseTree: candidate.baseTree,
    patchSha256: candidate.patchSha256,
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    manifest: candidate.manifest,
  });
  const permitIdentity = canonicalJson({
    baseCommit: permit.expectedOldCommit,
    baseTree: permit.expectedOldTree,
    patchSha256: permit.patchSha256,
    commitSha: permit.expectedNewCommit,
    treeSha: permit.expectedNewTree,
    manifest: permit.manifest,
  });
  if (candidateIdentity !== permitIdentity) {
    throw new MissionGitSafetyStopError('candidate-permit-mismatch', 'Mission candidate manifest or object identity differs from the apply permit.');
  }
}

function canonicalManifestShape(files: Array<Pick<MissionPatchFile, 'path' | 'operation' | 'oldMode' | 'newMode'>>): string {
  return JSON.stringify(files.map(({ path, operation, oldMode, newMode }) => ({
    path, operation, oldMode, newMode,
  })).sort((left, right) => left.path.localeCompare(right.path)));
}

async function resolveObject(
  execute: ProcessExecutor,
  targetRoot: string,
  expression: string,
  label: string,
): Promise<string> {
  return objectId((await git(execute, targetRoot, ['rev-parse', '--verify', expression], {
    environment: readOnlyGitEnvironment(),
  })).stdout, label);
}

function objectId(stdout: string, label: string): string {
  const value = stdout.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) throw new Error(`Mission Git ${label} is not an object ID.`);
  return value;
}

async function git(
  execute: ProcessExecutor,
  targetRoot: string,
  args: string[],
  options: { environment: Record<string, string>; stdin?: string },
) {
  const result = await execute('git', durableGitArguments(args), {
    cwd: targetRoot,
    env: options.environment,
    timeoutMs: 60_000,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Mission Git command failed: git ${args.join(' ')}: ${result.stderr.trim()}`);
  }
  return result;
}

function durableGitArguments(args: string[], hooksPath = '/dev/null'): string[] {
  return [...missionDurableGitConfig, '-c', `core.hooksPath=${hooksPath}`, ...args];
}

async function executeGuardedRefUpdate(
  execute: ProcessExecutor,
  targetRoot: string,
  targetRef: string,
  newCommit: string,
  oldCommit: string,
) {
  const rawPathValue = (await git(execute, targetRoot, [
    'rev-parse', '--git-path', targetRef,
  ], { environment: readOnlyGitEnvironment() })).stdout.trim();
  const rawPath = isAbsolute(rawPathValue) ? rawPathValue : join(targetRoot, rawPathValue);
  const recoveryGuard = await acquireMissionRefRecoveryGuard(rawPath);
  try {
    return await executeGuardedRefUpdateUnderGuard(rawPath, newCommit, oldCommit);
  } finally {
    await recoveryGuard.release();
  }
}

async function executeGuardedRefUpdateUnderGuard(
  rawPath: string,
  newCommit: string,
  oldCommit: string,
) {
  const lockPath = `${rawPath}.lock`;
  const ownerPath = `${rawPath}.mission-owner`;
  await reclaimMissionRefLock(rawPath, lockPath, ownerPath);
  const token = randomUUID();
  const provisionalOwner = {
    version: 1,
    pid: process.pid,
    bootNonce: missionGitProcessBootNonce,
    token,
  } as const;
  const temporaryLockPath = `${lockPath}.mission.${token}.tmp`;
  let lock: Awaited<ReturnType<typeof open>> | undefined = await open(temporaryLockPath, 'wx', 0o600);
  await lock.writeFile(`${JSON.stringify(provisionalOwner)}\n`, 'utf8');
  await lock.sync();
  const identity = await lock.stat();
  let published = false;
  try {
    await link(temporaryLockPath, lockPath);
    await unlink(temporaryLockPath);
    const owner = { ...provisionalOwner, dev: identity.dev, ino: identity.ino };
    await writeDurableRefOwner(ownerPath, owner);
    const current = await open(rawPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await current.stat();
      const content = await current.readFile('utf8');
      if (!metadata.isFile() || metadata.nlink !== 1 || content !== `${oldCommit}\n`) {
        return { stdout: '', stderr: 'Mission target ref is not the expected loose direct ref.', exitCode: 1 };
      }
    } finally {
      await current.close();
    }
    await lock.close();
    lock = await open(lockPath, 'r+');
    await lock.truncate(0);
    await lock.writeFile(`${newCommit}\n`, 'utf8');
    const written = await readFile(lockPath, 'utf8');
    if (written !== `${newCommit}\n`) throw new Error('Mission ref lock write was incomplete.');
    await lock.sync();
    await lock.close();
    lock = undefined;
    await rename(lockPath, rawPath);
    published = true;
    const parent = await open(dirname(rawPath), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  } finally {
    if (lock) await lock.close().catch(() => undefined);
    await unlink(temporaryLockPath).catch(() => undefined);
    if (!published) await unlinkRefIfIdentity(lockPath, identity.dev, identity.ino);
    await unlinkRefOwnerIfToken(ownerPath, token);
  }
}

function acquireMissionRefRecoveryGuard(rawPath: string) {
  const key = createHash('sha256').update(rawPath, 'utf8').digest('hex');
  return acquireMissionCoordinatorLock({
    targetRoot: tmpdir(),
    stateDir: join('codex-mission-ref-recovery', key),
    hostId: hostname(),
    bootNonce: missionGitProcessBootNonce,
    waitTimeoutMs: 5_000,
  });
}

async function withConfirmedDirectRefDurability<T>(
  execute: ProcessExecutor,
  targetRoot: string,
  targetRef: string,
  expectedCommit: string,
  operation: () => Promise<T>,
): Promise<T> {
  const rawPathValue = (await git(execute, targetRoot, [
    'rev-parse', '--git-path', targetRef,
  ], { environment: readOnlyGitEnvironment() })).stdout.trim();
  const rawPath = isAbsolute(rawPathValue) ? rawPathValue : join(targetRoot, rawPathValue);
  const recoveryGuard = await acquireMissionRefRecoveryGuard(rawPath);
  const lockPath = `${rawPath}.lock`;
  const ownerPath = `${rawPath}.mission-owner`;
  const token = randomUUID();
  const temporary = `${lockPath}.confirm.${token}.tmp`;
  let identity: { dev: number; ino: number } | undefined;
  try {
    await reclaimMissionRefLock(rawPath, lockPath, ownerPath);
    const owner = {
      version: 1, pid: process.pid, bootNonce: missionGitProcessBootNonce, token,
    } as const;
    const guard = await open(temporary, 'wx', 0o600);
    try {
      await guard.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await guard.sync();
      identity = await guard.stat();
    } finally {
      await guard.close();
    }
    try { await link(temporary, lockPath); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new MissionGitReauthorizationRequiredError(
          'ref-confirmation-lock-contended',
          'Mission ref durability confirmation is contended by another writer.',
        );
      }
      throw error;
    }
    const ref = await open(rawPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await ref.stat();
      const content = await ref.readFile('utf8');
      const after = await ref.stat();
      if (!before.isFile() || before.nlink !== 1 || content !== `${expectedCommit}\n`
        || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
        throw new MissionGitSafetyStopError(
          'target-ref-not-loose-direct',
          'Mission target ref is not the expected loose direct ref.',
        );
      }
      await ref.sync();
    } finally {
      await ref.close();
    }
    await syncDirectory(dirname(rawPath));
    return await operation();
  } finally {
    await unlink(temporary).catch(() => undefined);
    if (identity) await unlinkRefIfIdentity(lockPath, identity.dev, identity.ino);
    await recoveryGuard.release();
  }
}

interface MissionRefOwner {
  version: 1;
  pid: number;
  bootNonce: string;
  token: string;
  dev?: number;
  ino?: number;
}

async function reclaimMissionRefLock(rawPath: string, lockPath: string, ownerPath: string): Promise<void> {
  const owner = await readMissionRefOwner(ownerPath);
  if (owner?.dev !== undefined && owner.ino !== undefined) {
    const alive = owner.pid === process.pid
      ? owner.bootNonce === missionGitProcessBootNonce
      : processAlive(owner.pid);
    if (await pathHasIdentity(lockPath, owner.dev, owner.ino)) {
      if (alive) throw new Error('Mission ref lock is owned by a live process.');
      await unlinkRefIfIdentity(lockPath, owner.dev, owner.ino);
      await unlinkRefOwnerIfToken(ownerPath, owner.token);
      return;
    }
    if (await pathHasIdentity(rawPath, owner.dev, owner.ino)) {
      await syncDirectory(dirname(rawPath));
    }
    if (alive) throw new Error('Mission ref owner is live but its lock identity moved.');
    await unlinkRefOwnerIfToken(ownerPath, owner.token);
    return;
  }
  if (owner) {
    const alive = owner.pid === process.pid
      ? owner.bootNonce === missionGitProcessBootNonce
      : processAlive(owner.pid);
    if (alive) throw new Error('Mission ref owner is live before lock publication.');
    await unlinkRefOwnerIfToken(ownerPath, owner.token);
  }
  let embedded: MissionRefOwner | undefined;
  try {
    const content = await readFile(lockPath, 'utf8');
    try { embedded = parseMissionRefOwner(content); } catch { embedded = undefined; }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (embedded) {
    const alive = embedded.pid === process.pid
      ? embedded.bootNonce === missionGitProcessBootNonce
      : processAlive(embedded.pid);
    if (alive) throw new Error('Mission ref lock is owned by a live process.');
    await unlink(lockPath);
  }
}

async function writeDurableRefOwner(path: string, owner: MissionRefOwner): Promise<void> {
  const temporary = `${path}.${owner.token}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(owner)}\n`, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  try { await link(temporary, path); } finally { await unlink(temporary).catch(() => undefined); }
  await syncDirectory(dirname(path));
}

async function readMissionRefOwner(path: string): Promise<MissionRefOwner | undefined> {
  try { return parseMissionRefOwner(await readFile(path, 'utf8')); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseMissionRefOwner(content: string): MissionRefOwner {
  const value = JSON.parse(content) as Record<string, unknown>;
  if (value.version !== 1 || !Number.isSafeInteger(value.pid)
    || typeof value.bootNonce !== 'string' || typeof value.token !== 'string'
    || (value.dev !== undefined && !Number.isSafeInteger(value.dev))
    || (value.ino !== undefined && !Number.isSafeInteger(value.ino))) {
    throw new Error('Mission ref lock owner metadata is invalid.');
  }
  return value as unknown as MissionRefOwner;
}

async function pathHasIdentity(path: string, dev: number, ino: number): Promise<boolean> {
  try { const value = await lstat(path); return value.dev === dev && value.ino === ino; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function unlinkRefIfIdentity(path: string, dev: number, ino: number): Promise<void> {
  if (await pathHasIdentity(path, dev, ino)) await unlink(path);
}

async function unlinkRefOwnerIfToken(path: string, token: string): Promise<void> {
  const owner = await readMissionRefOwner(path);
  if (owner?.token === token) await unlink(path);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function gitEnvironment(
  indexPath: string,
  worktreePath: string,
  home: string,
  identity: MissionGitCommitIdentity,
): Record<string, string> {
  return {
    ...readOnlyGitEnvironment(),
    HOME: home,
    GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: worktreePath,
    GIT_AUTHOR_NAME: identity.authorName,
    GIT_AUTHOR_EMAIL: identity.authorEmail,
    GIT_AUTHOR_DATE: identity.authoredAt,
    GIT_COMMITTER_NAME: identity.committerName,
    GIT_COMMITTER_EMAIL: identity.committerEmail,
    GIT_COMMITTER_DATE: identity.committedAt,
  };
}

function readOnlyGitEnvironment(): Record<string, string> {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

async function emit(
  callback: ((boundary: MissionGitBoundary) => void | Promise<void>) | undefined,
  boundary: MissionGitBoundary,
): Promise<void> {
  await callback?.(boundary);
}
