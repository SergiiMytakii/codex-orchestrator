import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { hostname } from 'node:os';

import { acquireMissionCoordinatorLock } from './mission-coordinator-lock.js';
import { authorizeMissionCapability } from './mission-capability-kernel.js';
import {
  assertMissionApplyIntent,
  assertMissionApplyReceipt,
  missionApplyPermitFingerprint,
  validateMissionApplyPermit,
} from './mission-git-contracts.js';
import {
  missionStates,
  safeResumeTargets,
  type MissionRecord,
} from './mission-state-machine.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface StoredAggregate {
  revision: number;
  value: JsonValue;
}

export interface MissionTombstone {
  kind: 'mission' | 'plan-parent' | 'publication';
  terminalState: string;
  retainedAt: string;
}

export interface MissionBlobReference {
  sha256: string;
  size: number;
}

export interface MissionStateDraft {
  missions: Record<string, MissionRecord>;
  planParents: Record<string, StoredAggregate>;
  publications: Record<string, StoredAggregate>;
  reservations: Record<string, StoredAggregate>;
  nextEligibleAt: Record<string, string>;
  tombstones: Record<string, MissionTombstone>;
  blobs: Record<string, MissionBlobReference>;
}

export interface MissionStateSnapshot extends MissionStateDraft {
  version: 1;
  generation: number;
  checksum: string;
}

export interface MissionStateStoreOptions {
  maxStateBytes?: number;
  atomicOperations?: Partial<MissionStateAtomicOperations>;
}

export interface MissionStateAtomicOperations {
  syncFile(file: FileHandle, generation: number): Promise<void>;
  rename(source: string, destination: string, generation: number): Promise<void>;
  syncDirectory(directory: FileHandle, generation: number): Promise<void>;
}

export interface MissionStateExclusiveSession {
  load(): Promise<MissionStateSnapshot>;
  mutate(
    expectedGeneration: number,
    reducer: (draft: MissionStateDraft) => void,
  ): Promise<MissionStateSnapshot>;
}

const mutationTails = new Map<string, Promise<void>>();
const processBootNonce = randomUUID();

export class MissionStateStore {
  private readonly maxStateBytes: number;
  private readonly atomicOperations: MissionStateAtomicOperations;

  public constructor(
    private readonly targetRoot: string,
    private readonly stateDir: string,
    options: MissionStateStoreOptions = {},
  ) {
    const normalizedStateDir = normalize(stateDir);
    if (stateDir.length === 0 || isAbsolute(stateDir) || normalizedStateDir === '..'
      || normalizedStateDir.startsWith(`..${sep}`)) {
      throw new Error('Mission stateDir must stay inside the target root.');
    }
    this.maxStateBytes = options.maxStateBytes ?? 16 * 1024 * 1024;
    this.atomicOperations = {
      syncFile: options.atomicOperations?.syncFile ?? ((file) => file.sync()),
      rename: options.atomicOperations?.rename ?? ((source, destination) => rename(source, destination)),
      syncDirectory: options.atomicOperations?.syncDirectory ?? ((directory) => directory.sync()),
    };
    if (!Number.isInteger(this.maxStateBytes) || this.maxStateBytes <= 0) {
      throw new Error('Mission state maxStateBytes must be a positive integer.');
    }
  }

  public statePath(): string {
    return join(this.targetRoot, this.stateDir, 'mission-state-v1.json');
  }

  public stateDirectory(): string {
    return dirname(this.statePath());
  }

  public async temporaryDirectory(name: string): Promise<string> {
    if (!/^[a-z0-9-]+$/u.test(name)) throw new Error('Mission temporary directory name is invalid.');
    const directory = join(this.stateDirectory(), name);
    await this.ensureDurableDirectory(directory, 0);
    return directory;
  }

  public async load(): Promise<MissionStateSnapshot> {
    await this.assertExistingStatePathSafe();
    try {
      const content = await readFile(this.statePath(), 'utf8');
      const parsed = JSON.parse(content) as unknown;
      assertMissionStateSnapshot(parsed);
      const expectedChecksum = checksumFor(parsed);
      if (parsed.checksum !== expectedChecksum) {
        throw new Error(`Invalid Mission state checksum: expected ${expectedChecksum}, received ${parsed.checksum}`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return createSnapshot(0, emptyDraft());
      }
      throw error;
    }
  }

  public async mutate(
    expectedGeneration: number,
    reducer: (draft: MissionStateDraft) => void,
  ): Promise<MissionStateSnapshot> {
    return this.exclusive((session) => session.mutate(expectedGeneration, reducer));
  }

  public async exclusive<T>(
    operation: (session: MissionStateExclusiveSession) => Promise<T>,
  ): Promise<T> {
    return withMutationLock(this.statePath(), async () => {
      const coordinator = await this.acquireCoordinator();
      try {
        return await operation({
          load: () => this.load(),
          mutate: (expectedGeneration, reducer) => this.commitMutation(expectedGeneration, reducer),
        });
      } finally {
        await coordinator.release();
      }
    });
  }

  public async mutateWithBlobs(
    expectedGeneration: number,
    contents: Uint8Array[],
    reducer: (draft: MissionStateDraft, references: MissionBlobReference[]) => void,
  ): Promise<MissionStateSnapshot> {
    return withMutationLock(this.statePath(), async () => {
      const coordinator = await this.acquireCoordinator();
      try {
        const references: MissionBlobReference[] = [];
        for (const content of contents) {
          references.push(await this.putBlob(content, expectedGeneration + 1));
        }
        return await this.commitMutation(expectedGeneration, (draft) => reducer(draft, references));
      } finally {
        await coordinator.release();
      }
    });
  }

  private async putBlob(content: Uint8Array, generation: number): Promise<MissionBlobReference> {
    const bytes = Buffer.from(content);
    const reference = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    };
    const directory = join(this.targetRoot, this.stateDir, 'mission-blobs');
    const path = join(directory, reference.sha256);
    await this.ensureDurableDirectory(directory, generation);
    const tempPath = join(directory, `.${reference.sha256}.${process.pid}.${randomUUID()}.tmp`);
    const file = await open(tempPath, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(tempPath, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await this.readBlob(reference);
    return reference;
  }

  private async ensureDurableDirectory(directory: string, generation: number): Promise<void> {
    const root = resolve(this.targetRoot);
    const resolvedDirectory = resolve(directory);
    if (resolvedDirectory !== root && !resolvedDirectory.startsWith(`${root}${sep}`)) {
      throw new Error('Mission state directory is outside the target root.');
    }
    await this.ensureNoFollowDirectories(root, resolvedDirectory, true);
    for (let current = resolvedDirectory === root ? root : dirname(resolvedDirectory);; current = dirname(current)) {
      const handle = await open(current, 'r');
      try {
        await this.atomicOperations.syncDirectory(handle, generation);
      } finally {
        await handle.close();
      }
      if (current === root) break;
      if (current === dirname(current)) {
        throw new Error('Mission state directory is outside the target root.');
      }
    }
  }

  private async ensureNoFollowDirectories(
    root: string,
    directory: string,
    create: boolean,
  ): Promise<boolean> {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Mission target root must be a directory.');
    }
    const canonicalRoot = await realpath(root);
    let current = root;
    for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        const existing = await lstat(current);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new Error(`Mission state path component is not a direct directory: ${current}.`);
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        if (!create) return false;
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (!(mkdirError instanceof Error && 'code' in mkdirError && mkdirError.code === 'EEXIST')) {
            throw mkdirError;
          }
        }
        const created = await lstat(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new Error(`Mission state path component is not a direct directory: ${current}.`);
        }
      }
    }
    const expectedCanonicalDirectory = join(canonicalRoot, relative(root, directory));
    if (await realpath(directory) !== expectedCanonicalDirectory) {
      throw new Error('Mission state directory resolves through a symlink.');
    }
    return true;
  }

  private async assertExistingStatePathSafe(): Promise<void> {
    const root = resolve(this.targetRoot);
    const directory = this.stateDirectory();
    await this.ensureNoFollowDirectories(root, directory, false);
  }

  public async readBlob(reference: MissionBlobReference): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/u.test(reference.sha256)
      || !Number.isSafeInteger(reference.size) || reference.size < 0) {
      throw new Error('Invalid Mission blob reference.');
    }
    await this.assertExistingStatePathSafe();
    await this.ensureNoFollowDirectories(
      resolve(this.targetRoot),
      join(this.stateDirectory(), 'mission-blobs'),
      false,
    );
    const path = join(
      this.targetRoot,
      this.stateDir,
      'mission-blobs',
      reference.sha256,
    );
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: Buffer;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(reference.size)) {
        throw new Error(`Invalid Mission blob ${reference.sha256}: unsafe file identity.`);
      }
      content = await file.readFile();
      const after = await file.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || after.nlink !== 1n) {
        throw new Error(`Invalid Mission blob ${reference.sha256}: file changed during read.`);
      }
    } finally {
      await file.close();
    }
    const actualHash = createHash('sha256').update(content).digest('hex');
    if (content.byteLength !== reference.size || actualHash !== reference.sha256) {
      throw new Error(`Invalid Mission blob ${reference.sha256}: content does not match reference.`);
    }
    return content;
  }

  public async pruneUnreferencedBlobs(): Promise<string[]> {
    return withMutationLock(this.statePath(), async () => {
      const coordinator = await this.acquireCoordinator();
      try {
        const snapshot = await this.load();
        const directory = join(this.targetRoot, this.stateDir, 'mission-blobs');
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return [];
          }
          throw error;
        }
        const removed: string[] = [];
        for (const entry of entries.sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
          if (!entry.isFile() || !/^[a-f0-9]{64}$/u.test(entry.name) || snapshot.blobs[entry.name]) {
            continue;
          }
          await unlink(join(directory, entry.name));
          removed.push(entry.name);
        }
        if (removed.length > 0) {
          const directoryHandle = await open(directory, 'r');
          try {
            await directoryHandle.sync();
          } finally {
            await directoryHandle.close();
          }
        }
        return removed;
      } finally {
        await coordinator.release();
      }
    });
  }

  private async acquireCoordinator() {
    await this.ensureDurableDirectory(this.stateDirectory(), 0);
    return acquireMissionCoordinatorLock({
      targetRoot: this.targetRoot,
      stateDir: this.stateDir,
      hostId: hostname(),
      bootNonce: processBootNonce,
      waitTimeoutMs: 5_000,
    });
  }

  private async commitMutation(
    expectedGeneration: number,
    reducer: (draft: MissionStateDraft) => void,
  ): Promise<MissionStateSnapshot> {
    const current = await this.load();
    if (current.generation !== expectedGeneration) {
      throw new Error(
        `Mission state generation conflict: expected ${expectedGeneration}, current ${current.generation}`,
      );
    }
    const draft = cloneDraft(current);
    reducer(draft);
    const next = createSnapshot(current.generation + 1, draft);
    assertMissionStateSnapshot(next);
    for (const reference of Object.values(next.blobs)) {
      await this.readBlob(reference);
    }
    await this.atomicWrite(next);
    return next;
  }

  private async atomicWrite(snapshot: MissionStateSnapshot): Promise<void> {
    const path = this.statePath();
    const directory = dirname(path);
    const serialized = `${canonicalJson(snapshot)}\n`;
    const size = Buffer.byteLength(serialized, 'utf8');
    if (size > this.maxStateBytes) {
      throw new Error(`Mission state size limit exceeded: ${size} > ${this.maxStateBytes} bytes.`);
    }
    await this.ensureDurableDirectory(directory, snapshot.generation);
    const tempPath = join(directory, `.mission-state-v1.${process.pid}.${randomUUID()}.tmp`);
    let tempCreated = false;
    try {
      const file = await open(tempPath, 'wx', 0o600);
      tempCreated = true;
      try {
        await file.writeFile(serialized, 'utf8');
        await this.atomicOperations.syncFile(file, snapshot.generation);
      } finally {
        await file.close();
      }
      await this.atomicOperations.rename(tempPath, path, snapshot.generation);
      tempCreated = false;
      const directoryHandle = await open(directory, 'r');
      try {
        await this.atomicOperations.syncDirectory(directoryHandle, snapshot.generation);
      } finally {
        await directoryHandle.close();
      }
    } finally {
      if (tempCreated) {
        await unlink(tempPath).catch(() => undefined);
      }
    }
  }
}

async function withMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  mutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    void tail.finally(() => {
      if (mutationTails.get(key) === tail) {
        mutationTails.delete(key);
      }
    });
  }
}

function emptyDraft(): MissionStateDraft {
  return {
    missions: {},
    planParents: {},
    publications: {},
    reservations: {},
    nextEligibleAt: {},
    tombstones: {},
    blobs: {},
  };
}

function cloneDraft(snapshot: MissionStateSnapshot): MissionStateDraft {
  return structuredClone({
    missions: snapshot.missions,
    planParents: snapshot.planParents,
    publications: snapshot.publications,
    reservations: snapshot.reservations,
    nextEligibleAt: snapshot.nextEligibleAt,
    tombstones: snapshot.tombstones,
    blobs: snapshot.blobs,
  });
}

function createSnapshot(generation: number, draft: MissionStateDraft): MissionStateSnapshot {
  const withoutChecksum = {
    version: 1 as const,
    generation,
    ...draft,
  };
  return {
    ...withoutChecksum,
    checksum: checksumFor(withoutChecksum),
  };
}

function checksumFor(snapshot: Omit<MissionStateSnapshot, 'checksum'> | MissionStateSnapshot): string {
  const { checksum: _checksum, ...content } = snapshot as MissionStateSnapshot;
  return `sha256:${createHash('sha256').update(Buffer.from(canonicalJson(content), 'utf8')).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function assertMissionStateSnapshot(value: unknown): asserts value is MissionStateSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Mission state: root must be an object.');
  }
  const record = value as Record<string, unknown>;
  const allowedRootFields = new Set([
    'version',
    'generation',
    'checksum',
    'missions',
    'planParents',
    'publications',
    'reservations',
    'nextEligibleAt',
    'tombstones',
    'blobs',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedRootFields.has(key)) {
      throw new Error(`Invalid Mission state: unexpected field ${key}.`);
    }
  }
  if (record.version !== 1) {
    throw new Error('Invalid Mission state: version must be 1.');
  }
  if (!Number.isInteger(record.generation) || (record.generation as number) < 0) {
    throw new Error('Invalid Mission state: generation must be a non-negative integer.');
  }
  if (typeof record.checksum !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(record.checksum)) {
    throw new Error('Invalid Mission state: checksum must be sha256 hex.');
  }
  for (const key of [
    'missions',
    'planParents',
    'publications',
    'reservations',
    'nextEligibleAt',
    'tombstones',
    'blobs',
  ]) {
    const child = record[key];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      throw new Error(`Invalid Mission state: ${key} must be an object.`);
    }
  }

  for (const [id, mission] of Object.entries(record.missions as Record<string, unknown>)) {
    assertMissionRecord(mission, `missions.${id}`);
    if (mission.id !== id) {
      invalid(`missions.${id}.id must equal its map key`);
    }
    if (mission.authorizedPermit && (mission.authorizedPermit.missionId !== id
      || mission.authorizedPermit.actionKey !== mission.actionKey
      || mission.authorizedPermit.inputSnapshot !== mission.inputSnapshot
      || mission.authorizedPermit.fencingEpoch !== mission.fencingEpoch)) {
      invalid(`missions.${id}.authorizedPermit must match the aggregate identity`);
    }
  }
  for (const collection of ['planParents', 'publications', 'reservations'] as const) {
    for (const [id, aggregate] of Object.entries(record[collection] as Record<string, unknown>)) {
      assertStoredAggregate(aggregate, `${collection}.${id}`);
    }
  }
  for (const [id, nextEligibleAt] of Object.entries(record.nextEligibleAt as Record<string, unknown>)) {
    assertNonEmptyString(nextEligibleAt, `nextEligibleAt.${id}`);
  }
  for (const [id, tombstone] of Object.entries(record.tombstones as Record<string, unknown>)) {
    assertTombstone(tombstone, `tombstones.${id}`);
  }
  for (const [hash, blob] of Object.entries(record.blobs as Record<string, unknown>)) {
    assertBlobReference(blob, `blobs.${hash}`, hash);
  }
  for (const [id, mission] of Object.entries(record.missions as Record<string, MissionRecord>)) {
    for (const [actionKey, execution] of Object.entries(mission.actionExecutions ?? {})) {
      if (execution.status === 'completed'
        && !(record.blobs as Record<string, unknown>)[execution.receiptSha256!]) {
        invalid(`missions.${id}.actionExecutions.${actionKey} references a missing receipt blob`);
      }
    }
  }
}

const missionStateSet = new Set<string>(missionStates);
const resumeTargetSet = new Set<string>(safeResumeTargets);

function assertMissionRecord(value: unknown, path: string): asserts value is MissionRecord {
  const record = assertObject(value, path);
  assertExactFields(record, path, [
    'id',
    'revision',
    'state',
    'findingIds',
    'residualFindingIds',
    'resumeTarget',
    'nextEligibleAt',
    'actionKey',
    'inputSnapshot',
    'fencingEpoch',
    'authorizedPermit',
    'actionExecutions',
    'applyPermit',
    'applyIntent',
    'applyReceipt',
    'applyHistory',
  ]);
  assertNonEmptyString(record.id, `${path}.id`);
  assertNonNegativeInteger(record.revision, `${path}.revision`);
  if (typeof record.state !== 'string' || !missionStateSet.has(record.state)) {
    invalid(`${path}.state must be a known Mission state`);
  }
  assertOptionalStringArray(record.findingIds, `${path}.findingIds`);
  assertOptionalStringArray(record.residualFindingIds, `${path}.residualFindingIds`);
  if (record.resumeTarget !== undefined
    && (typeof record.resumeTarget !== 'string' || !resumeTargetSet.has(record.resumeTarget))) {
    invalid(`${path}.resumeTarget must be a safe resume target`);
  }
  assertOptionalNonEmptyString(record.nextEligibleAt, `${path}.nextEligibleAt`);
  assertOptionalNonEmptyString(record.actionKey, `${path}.actionKey`);
  assertOptionalNonEmptyString(record.inputSnapshot, `${path}.inputSnapshot`);
  if (record.fencingEpoch !== undefined) {
    assertPositiveInteger(record.fencingEpoch, `${path}.fencingEpoch`);
  }
  if (record.authorizedPermit !== undefined) {
    assertAuthorizedPermit(record.authorizedPermit, `${path}.authorizedPermit`);
  }
  if (record.actionExecutions !== undefined) {
    const executions = assertObject(record.actionExecutions, `${path}.actionExecutions`);
    for (const [actionKey, execution] of Object.entries(executions)) {
      assertNonEmptyString(actionKey, `${path}.actionExecutions key`);
      const entry = assertObject(execution, `${path}.actionExecutions.${actionKey}`);
      assertExactFields(entry, `${path}.actionExecutions.${actionKey}`, [
        'permitFingerprint', 'status', 'receiptSha256',
      ]);
      if (typeof entry.permitFingerprint !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(entry.permitFingerprint)) {
        invalid(`${path}.actionExecutions.${actionKey}.permitFingerprint must be sha256 hex`);
      }
      if (entry.status !== 'in-flight' && entry.status !== 'completed') {
        invalid(`${path}.actionExecutions.${actionKey}.status must be in-flight or completed`);
      }
      assertOptionalNonEmptyString(entry.receiptSha256, `${path}.actionExecutions.${actionKey}.receiptSha256`);
      if (entry.status === 'completed'
        && (typeof entry.receiptSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.receiptSha256))) {
        invalid(`${path}.actionExecutions.${actionKey}.receiptSha256 must be sha256 hex when completed`);
      }
      if (entry.status === 'in-flight' && entry.receiptSha256 !== undefined) {
        invalid(`${path}.actionExecutions.${actionKey}.receiptSha256 is forbidden while in flight`);
      }
    }
  }
  if (record.applyPermit !== undefined) {
    const permit = validateMissionApplyPermit(record.applyPermit);
    if (permit.missionId !== record.id || permit.actionKey !== record.actionKey
      || permit.fencingEpoch !== record.fencingEpoch) {
      invalid(`${path}.applyPermit must match the aggregate identity`);
    }
  }
  if (record.applyIntent !== undefined) {
    assertMissionApplyIntent(record.applyIntent);
    if (record.applyPermit === undefined
      || record.applyIntent.permitFingerprint
        !== missionApplyPermitFingerprint(validateMissionApplyPermit(record.applyPermit))) {
      invalid(`${path}.applyIntent must match applyPermit`);
    }
  }
  if (record.applyReceipt !== undefined) {
    assertMissionApplyReceipt(record.applyReceipt);
    if (record.applyIntent === undefined
      || record.applyReceipt.permitFingerprint !== record.applyIntent.permitFingerprint) {
      invalid(`${path}.applyReceipt must match applyIntent`);
    }
    const permit = record.applyPermit === undefined
      ? undefined
      : validateMissionApplyPermit(record.applyPermit);
    if (!permit
      || record.applyReceipt.targetRef !== permit.targetRef
      || record.applyReceipt.oldCommitSha !== permit.expectedOldCommit
      || record.applyReceipt.commitSha !== permit.expectedNewCommit
      || record.applyReceipt.treeSha !== permit.expectedNewTree) {
      invalid(`${path}.applyReceipt identity must match applyPermit`);
    }
  }
  if (record.applyHistory !== undefined) {
    if (!Array.isArray(record.applyHistory)) {
      invalid(`${path}.applyHistory must be an array`);
    }
    for (const [index, receipt] of record.applyHistory.entries()) {
      assertMissionApplyReceipt(receipt);
      if (record.applyHistory.findIndex((candidate) =>
        candidate.permitFingerprint === receipt.permitFingerprint) !== index) {
        invalid(`${path}.applyHistory contains duplicate permit fingerprints`);
      }
    }
  }
  const hasPermit = record.applyPermit !== undefined;
  const hasIntent = record.applyIntent !== undefined;
  const hasReceipt = record.applyReceipt !== undefined;
  if (record.state === 'apply-authorizing' && (hasPermit || hasIntent || hasReceipt)) {
    invalid(`${path} apply-authorizing state must not retain apply artifacts`);
  }
  if (record.state === 'apply-prepared' && (!hasPermit || hasIntent || hasReceipt)) {
    invalid(`${path} apply-prepared state requires only an apply permit`);
  }
  if (record.state === 'applying' && (!hasPermit || !hasIntent || hasReceipt)) {
    invalid(`${path} applying state requires permit and intent without receipt`);
  }
  if (record.state === 'reconciling' && (hasPermit || hasIntent || hasReceipt)
    && (!hasPermit || !hasIntent || !hasReceipt)) {
    invalid(`${path} apply reconciliation requires permit, intent, and receipt together`);
  }
}

function assertAuthorizedPermit(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertExactFields(record, path, [
    'missionId', 'actionKey', 'capability', 'argv', 'requestedPaths', 'grantedPaths',
    'inputSnapshot', 'fencingEpoch', 'expiresAt', 'network', 'workspace',
    'readPath', 'maxReadBytes',
  ]);
  if (record.network !== 'deny' || record.workspace !== 'read-only') {
    invalid(`${path} must deny network and keep the workspace read-only`);
  }
  try {
    authorizeMissionCapability(record as never);
  } catch (error) {
    invalid(`${path} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertStoredAggregate(value: unknown, path: string): asserts value is StoredAggregate {
  const record = assertObject(value, path);
  assertExactFields(record, path, ['revision', 'value']);
  assertNonNegativeInteger(record.revision, `${path}.revision`);
  assertJsonValue(record.value, `${path}.value`);
}

function assertTombstone(value: unknown, path: string): asserts value is MissionTombstone {
  const record = assertObject(value, path);
  assertExactFields(record, path, ['kind', 'terminalState', 'retainedAt']);
  if (record.kind !== 'mission' && record.kind !== 'plan-parent' && record.kind !== 'publication') {
    invalid(`${path}.kind must be a known aggregate kind`);
  }
  assertNonEmptyString(record.terminalState, `${path}.terminalState`);
  assertNonEmptyString(record.retainedAt, `${path}.retainedAt`);
}

function assertBlobReference(
  value: unknown,
  path: string,
  expectedHash?: string,
): asserts value is MissionBlobReference {
  const record = assertObject(value, path);
  assertExactFields(record, path, ['sha256', 'size']);
  if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
    invalid(`${path}.sha256 must be lowercase SHA-256 hex`);
  }
  if (expectedHash !== undefined && record.sha256 !== expectedHash) {
    invalid(`${path}.sha256 must match its map key`);
  }
  assertNonNegativeInteger(record.size, `${path}.size`);
}

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      invalid(`${path} must contain only finite JSON numbers`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  invalid(`${path} must be valid JSON`);
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactFields(record: Record<string, unknown>, path: string, fields: string[]): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      invalid(`${path} has unexpected field ${key}`);
    }
  }
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${path} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    invalid(`${path} must be a positive integer`);
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${path} must be a non-empty string`);
  }
}

function assertOptionalNonEmptyString(value: unknown, path: string): void {
  if (value !== undefined) {
    assertNonEmptyString(value, path);
  }
}

function assertOptionalStringArray(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    invalid(`${path} must be an array`);
  }
  value.forEach((item, index) => assertNonEmptyString(item, `${path}[${index}]`));
}

function invalid(reason: string): never {
  throw new Error(`Invalid Mission state: ${reason}.`);
}
