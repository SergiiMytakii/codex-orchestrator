import { createHash, randomUUID } from 'node:crypto';
import { O_NOFOLLOW, O_RDONLY } from 'node:constants';
import { chmod, lstat, mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import {
  resolveWorkflowOperation,
  sealedWorkflowContentSha256,
  sealedWorkflowMode,
  verifyWorkflowGeneration,
  type WorkflowFileRecord,
  type WorkflowGenerationReceipt,
  type WorkflowOperationPolicy,
} from './workflow-assets.js';
import { publishImmutableWorkflow, type ImmutableWorkflowPublishStep } from './immutable-workflow-publisher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface RuntimeAssetFileEvidence extends WorkflowFileRecord {
  sealedMode: number;
  ownerUid: number;
}

export interface RuntimeAssetSnapshot {
  packageVersion: string;
  generationHash: string;
  operation: string;
  runtimeRoot: string;
  snapshotRoot: string;
  operationPath: string;
  sourceSkillPath?: string;
  skillPaths: string[];
  referencedDocumentPaths: string[];
  schemaPath: string;
  profilePath: string;
  reviewerProfiles: Record<string, string>;
  policy: WorkflowOperationPolicy;
  ownerUid: number;
  files: RuntimeAssetFileEvidence[];
  contentSha256: string;
  reused: boolean;
}

export type RuntimeAssetPublishStep = ImmutableWorkflowPublishStep;

interface OwnerRecord {
  version: 1;
  status: 'building';
  bootId: string;
  pid: number;
  token: string;
  parentToken: string | null;
  processStartIdentity: string;
}

interface ReadyRecord {
  version: 1;
  status: 'ready';
  token: string;
  generationHash: string;
  operation: string;
  contentSha256: string;
}

export async function publishRuntimeAssetSnapshot(input: {
  workflowGeneration: WorkflowGenerationReceipt;
  runtimeRoot: string;
  snapshotRelativePath: string;
  operation: string;
  bootId: string;
  onStep?: (step: RuntimeAssetPublishStep) => Promise<void> | void;
}): Promise<RuntimeAssetSnapshot> {
  await verifyWorkflowGeneration(input.workflowGeneration);
  const operation = await resolveWorkflowOperation(input.workflowGeneration, input.operation);
  const requestedRuntimeRoot = resolve(input.runtimeRoot);
  const requested = validateRelativePath(input.snapshotRelativePath);
  const requestedLogicalRoot = resolve(requestedRuntimeRoot, ...requested.split('/'));
  assertContained(requestedRuntimeRoot, requestedLogicalRoot);
  await ensureManagedPath(requestedRuntimeRoot, dirname(requestedLogicalRoot));
  const runtimeRoot = await realpath(requestedRuntimeRoot);
  const logicalRoot = resolve(runtimeRoot, ...requested.split('/'));
  const parent = dirname(logicalRoot);
  const stem = basename(logicalRoot);
  return publishImmutableWorkflow<OwnerRecord, ReadyRecord, string, RuntimeAssetSnapshot>({
    parent,
    identity: stem,
    bootId: input.bootId,
    createOwner: (parentToken, processStartIdentity) => newOwner(input.bootId, parentToken, processStartIdentity),
    parseOwner,
    createReady: (owner, contentSha256): ReadyRecord => ({
      version: 1,
      status: 'ready',
      token: owner.token,
      generationHash: input.workflowGeneration.generationHash,
      operation: input.operation,
      contentSha256,
    }),
    parseReady,
    serializeRecord: (value) => Buffer.from(`${canonicalJson(value)}\n`),
    readControl: readRegular,
    writeContent: async (contentRoot, onStep) => {
      for (const [index, file] of operation.files.entries()) {
        const source = join(input.workflowGeneration.generationRoot, ...file.path.split('/'));
        const target = join(contentRoot, ...file.path.split('/'));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeSynced(target, await readRegular(source), sealedWorkflowMode(file.mode));
        if (index === 0) await onStep('after-first-content-file');
      }
      for (const directory of (await listDirectories(contentRoot)).sort((left, right) => right.length - left.length)) {
        await chmod(directory, 0o555);
        await syncDirectory(directory);
      }
      return contentDigest(await evidence(contentRoot, operation.files));
    },
    resultFromReady: ({ ready, contentRoot, reused }) => snapshotFromReady(
      input, operation, runtimeRoot, ready, contentRoot, reused,
    ),
    activePublisherError: 'runtime asset publisher is still active',
    recoveryChainError: 'runtime asset recovery chain is invalid',
    onStep: input.onStep,
  });
}

export async function verifyRuntimeAssetSnapshot(snapshot: RuntimeAssetSnapshot): Promise<void> {
  if (snapshot.ownerUid !== runnerUid()) throw new Error('runtime asset owner drift');
  const root = resolve(snapshot.snapshotRoot);
  assertContained(resolve(snapshot.runtimeRoot), root);
  if (await realpath(root) !== root) throw new Error('runtime asset snapshot contains a symbolic link');
  for (const directory of await listDirectories(root)) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== runnerUid() || (info.mode & 0o777) !== 0o555) {
      throw new Error('runtime asset directory mode or owner drift');
    }
  }
  const actual = await listFiles(root);
  const expected = snapshot.files.map((file) => file.path);
  if (!same(actual, expected)) throw new Error('runtime asset file closure drift');
  validateDerivedClosure(snapshot.skillPaths, expected, /^skills\/[a-z][a-z0-9-]*\/SKILL\.md$/u, 'dependency skill');
  validateDerivedClosure(snapshot.referencedDocumentPaths, expected, /^docs\/agents\/[A-Za-z0-9._/-]+\.md$/u, 'referenced document');
  const current = await evidence(root, snapshot.files);
  if (canonicalJson(current) !== canonicalJson(snapshot.files)) throw new Error('runtime asset evidence drift');
  if (contentDigest(current) !== snapshot.contentSha256) throw new Error('runtime asset content digest drift');
  await verifyContainedReferences(root, expected, snapshot.skillPaths);
  for (const [path, expectedPath] of [
    [snapshot.operationPath, `operations/${snapshot.operation}/SKILL.md`],
    [snapshot.schemaPath, snapshot.files.find((file) => resolve(root, ...file.path.split('/')) === resolve(snapshot.schemaPath))?.path],
    [snapshot.profilePath, snapshot.files.find((file) => resolve(root, ...file.path.split('/')) === resolve(snapshot.profilePath))?.path],
  ]) {
    if (typeof path !== 'string' || typeof expectedPath !== 'string'
      || resolve(path) !== resolve(root, ...expectedPath.split('/'))) throw new Error('runtime asset authority path drift');
  }
  for (const [id, path] of Object.entries(snapshot.reviewerProfiles)) {
    if (!/^[a-z0-9_]+$/u.test(id) || !snapshot.files.some((file) => resolve(root, ...file.path.split('/')) === resolve(path))) {
      throw new Error('runtime asset reviewer profiles drift');
    }
  }
}

async function snapshotFromReady(
  input: Parameters<typeof publishRuntimeAssetSnapshot>[0],
  operation: Awaited<ReturnType<typeof resolveWorkflowOperation>>,
  runtimeRoot: string,
  ready: ReadyRecord,
  contentRoot: string,
  reused: boolean,
): Promise<RuntimeAssetSnapshot> {
  if (ready.generationHash !== input.workflowGeneration.generationHash || ready.operation !== input.operation) {
    throw new Error('runtime asset ready identity mismatch');
  }
  const snapshotRoot = await realpath(contentRoot);
  const files = await evidence(snapshotRoot, operation.files);
  const remap = (path: string) => join(snapshotRoot, ...relative(operation.workflowRoot, path).split(sep));
  const snapshot: RuntimeAssetSnapshot = {
    packageVersion: input.workflowGeneration.packageVersion,
    generationHash: input.workflowGeneration.generationHash,
    operation: input.operation,
    runtimeRoot,
    snapshotRoot,
    operationPath: remap(operation.entryPath),
    sourceSkillPath: operation.sourceSkillPath ? remap(operation.sourceSkillPath) : undefined,
    skillPaths: [...operation.skillPaths],
    referencedDocumentPaths: [...operation.referencedDocumentPaths],
    schemaPath: remap(operation.schemaPath),
    profilePath: remap(operation.profilePath),
    reviewerProfiles: Object.fromEntries(Object.entries(operation.reviewerProfiles)
      .map(([id, path]) => [id, remap(path)])),
    policy: structuredClone(operation.policy),
    ownerUid: runnerUid(),
    files,
    contentSha256: ready.contentSha256,
    reused,
  };
  await verifyRuntimeAssetSnapshot(snapshot);
  return snapshot;
}

function validateDerivedClosure(paths: string[], files: string[], pattern: RegExp, field: string): void {
  if (!Array.isArray(paths) || paths.some((path, index) => typeof path !== 'string' || !pattern.test(path)
    || (index > 0 && Buffer.compare(Buffer.from(paths[index - 1]!), Buffer.from(path)) >= 0))) {
    throw new Error(`runtime asset ${field} closure is invalid`);
  }
  const derived = files.filter((path) => pattern.test(path));
  if (!same(paths, derived)) throw new Error(`runtime asset ${field} closure is invalid`);
}

async function verifyContainedReferences(root: string, files: string[], skillPaths: string[]): Promise<void> {
  const available = new Set(files);
  const skillIds = new Set(skillPaths.map((path) => path.split('/')[1]!));
  const knownSkillIds = new Set(files.flatMap((path) => {
    const skill = path.match(/^skills\/([a-z][a-z0-9-]*)\//u)?.[1];
    return skill ? [skill] : [];
  }));
  for (const path of files) {
    if (!/\.(?:md|json|yaml|yml|toml|mjs|txt)$/iu.test(path)) continue;
    const text = (await readRegular(join(root, ...path.split('/')))).toString('utf8');
    const semantics = extractRuntimeWorkflowReferenceSemantics(path, text);
    for (const referenced of semantics.paths) {
      if (!available.has(referenced)) throw new Error(`runtime asset referenced workflow path is missing: ${referenced}`);
      const referencedSkill = referenced.match(/^skills\/([a-z][a-z0-9-]*)\//u)?.[1];
      if (referencedSkill && !skillIds.has(referencedSkill)) {
        throw new Error(`runtime asset referenced skill closure is missing: ${referencedSkill}`);
      }
    }
    for (const referencedSkill of semantics.skillIds) {
      if (knownSkillIds.has(referencedSkill) && !skillIds.has(referencedSkill)) {
        throw new Error(`runtime asset referenced skill closure is missing: ${referencedSkill}`);
      }
    }
  }
}

function extractRuntimeWorkflowReferenceSemantics(source: string, text: string): { paths: string[]; skillIds: string[] } {
  const content = withoutFencedCode(text);
  const targets: string[] = [];
  const referenceContent = content.replace(
    /\]\(\s*(?:<([^<>\r\n]+)>|([^\s<>\r\n)]+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?[ \t]*\)/gu,
    (_link, angleDestination: string | undefined, plainDestination: string | undefined) => {
      const destination = withoutFragment(angleDestination ?? plainDestination!);
      if (destination) targets.push(destination);
      return ']()';
    },
  );
  for (const match of referenceContent.matchAll(/(?:^|[\s`"'(])((?:\.{1,2}\/)+(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:md|json|yaml|yml|toml|mjs|txt))(?=$|[\s`"'),.;:#])/gmu)) {
    targets.push(match[1]!);
  }
  for (const match of referenceContent.matchAll(/\$CODEX_ORCHESTRATOR_WORKFLOW_ROOT\/((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:md|json|yaml|yml|toml|mjs|txt))/gu)) {
    targets.push(`$CODEX_ORCHESTRATOR_WORKFLOW_ROOT/${match[1]!}`);
  }
  const references = new Set<string>();
  for (const target of targets) {
    const normalized = normalizeRuntimeWorkflowReference(source, target);
    if (normalized) references.add(normalized);
  }
  const skillIds = new Set<string>();
  for (const match of referenceContent.matchAll(/`([a-z][a-z0-9-]*)`|\$([a-z][a-z0-9-]*)/gu)) skillIds.add(match[1] ?? match[2]!);
  for (const path of references) {
    const skill = path.match(/^skills\/([a-z][a-z0-9-]*)\/SKILL\.md$/u)?.[1];
    if (skill) skillIds.add(skill);
  }
  return { paths: [...references].sort(compareUtf8), skillIds: [...skillIds].sort(compareUtf8) };
}

function withoutFencedCode(text: string): string {
  return text.replace(/```[^\n]*\n[\s\S]*?```/gu, '');
}

function withoutFragment(target: string): string {
  const index = target.indexOf('#');
  return index === -1 ? target : target.slice(0, index);
}

function normalizeRuntimeWorkflowReference(source: string, target: string): string | undefined {
  if (!target || target.includes('\\')) throw new Error(`invalid runtime workflow reference in ${source}: ${target}`);
  const workflowRoot = '$CODEX_ORCHESTRATOR_WORKFLOW_ROOT/';
  let path: string;
  if (target.startsWith(workflowRoot)) path = posix.normalize(target.slice(workflowRoot.length));
  else {
    if (/^[a-z]+:/iu.test(target) || target.startsWith('/')) return undefined;
    path = posix.normalize(posix.join(posix.dirname(source), target));
  }
  if (!path || posix.isAbsolute(path) || path === '..' || path.startsWith('../')
    || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`runtime workflow reference escapes root in ${source}: ${target}`);
  }
  return path.normalize('NFC').replaceAll('\\', '/');
}

async function evidence(root: string, records: Array<Pick<WorkflowFileRecord, 'path' | 'sha256' | 'size'>>): Promise<RuntimeAssetFileEvidence[]> {
  const output: RuntimeAssetFileEvidence[] = [];
  for (const record of records) {
    const path = join(root, ...record.path.split('/'));
    const { bytes, mode, uid } = await readRegularEvidence(path);
    const sealedMode = sealedWorkflowMode((record as WorkflowFileRecord).mode);
    if ((mode & 0o777) !== sealedMode || uid !== runnerUid()) {
      throw new Error(`runtime asset mode or owner drift: ${record.path}`);
    }
    if (bytes.length !== record.size || sha(bytes) !== record.sha256) throw new Error(`runtime asset hash drift: ${record.path}`);
    output.push({ ...record as WorkflowFileRecord, sealedMode, ownerUid: uid });
  }
  return output;
}

function contentDigest(files: RuntimeAssetFileEvidence[]): string {
  return sealedWorkflowContentSha256(files.map(({ path, sealedMode, size, sha256 }) => ({ path, sealedMode, size, sha256 })));
}

function newOwner(bootId: string, parentToken: string | null, processStartIdentity: string): OwnerRecord {
  if (!bootId) throw new Error('runtime asset boot identity is invalid');
  return { version: 1, status: 'building', bootId, pid: process.pid, token: randomUUID(), parentToken, processStartIdentity };
}

function parseOwner(value: unknown): OwnerRecord {
  exact(value, ['version', 'status', 'bootId', 'pid', 'token', 'parentToken', 'processStartIdentity']);
  if (value.version !== 1 || value.status !== 'building' || typeof value.bootId !== 'string' || !value.bootId
    || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== 'string' || !UUID.test(value.token)
    || !(value.parentToken === null || (typeof value.parentToken === 'string' && UUID.test(value.parentToken)))) throw new Error('runtime asset owner is invalid');
  if (typeof value.processStartIdentity !== 'string' || !value.processStartIdentity) throw new Error('runtime asset owner is invalid');
  return value as unknown as OwnerRecord;
}

function parseReady(value: unknown): ReadyRecord {
  exact(value, ['version', 'status', 'token', 'generationHash', 'operation', 'contentSha256']);
  if (value.version !== 1 || value.status !== 'ready' || typeof value.token !== 'string' || !UUID.test(value.token)
    || typeof value.generationHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.generationHash)
    || typeof value.operation !== 'string' || !value.operation || typeof value.contentSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.contentSha256)) throw new Error('runtime asset ready record is invalid');
  return value as unknown as ReadyRecord;
}

async function ensureManagedPath(root: string, target: string): Promise<void> {
  await createManagedRoot(root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== runnerUid() || (rootInfo.mode & 0o777) !== 0o700) {
    throw new Error('runtime asset root is unsafe');
  }
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => { if (!isCode(error, 'EEXIST')) throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== runnerUid() || (info.mode & 0o777) !== 0o700) throw new Error('runtime asset managed path is unsafe');
  }
}

async function createManagedRoot(path: string): Promise<void> {
  const chain: string[] = [];
  let current = resolve(path);
  while (dirname(current) !== current) {
    chain.push(current);
    current = dirname(current);
  }
  for (const segment of chain.reverse()) {
    let info;
    try {
      info = await lstat(segment);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
      try { await mkdir(segment, { mode: 0o700 }); }
      catch (mkdirError) { if (!isCode(mkdirError, 'EEXIST')) throw mkdirError; }
      info = await lstat(segment);
    }
    if (info.isSymbolicLink()) {
      if (info.uid === runnerUid() || !(await stat(segment)).isDirectory()) throw new Error('runtime asset root is unsafe');
    } else if (!info.isDirectory()) {
      throw new Error('runtime asset root is unsafe');
    }
  }
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('runtime asset symlink rejected');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(relative(root, path).split(sep).join('/'));
      else throw new Error('runtime asset special entry rejected');
    }
  };
  await visit(root);
  return output.sort(compareUtf8);
}

async function listDirectories(root: string): Promise<string[]> {
  const output = [root];
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) output.push(...await listDirectories(join(root, entry.name)));
  return output;
}

async function writeSynced(path: string, bytes: Buffer, mode: number): Promise<void> {
  await writeFile(path, bytes, { mode });
  await chmod(path, mode);
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readRegular(path: string): Promise<Buffer> {
  return (await readRegularEvidence(path)).bytes;
}

async function readRegularEvidence(path: string): Promise<{ bytes: Buffer; mode: number; uid: number }> {
  let handle;
  try {
    handle = await open(path, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    throw new Error('runtime asset control path is invalid', { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('runtime asset control path is invalid');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.length) !== after.size) throw new Error('runtime asset control path changed while reading');
    return { bytes, mode: Number(after.mode), uid: Number(after.uid) };
  } finally {
    await handle.close();
  }
}

function validateRelativePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes('\\') || posix.normalize(value) !== value
    || value.split('/').some((part) => !part || part === '.' || part === '..') || basename(value) !== 'snapshot') {
    throw new Error('snapshotRelativePath is invalid');
  }
  return value;
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('runtime asset path escapes root');
}

function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !same(Object.keys(value).sort(compareUtf8), [...keys].sort(compareUtf8))) throw new Error('runtime asset record shape is invalid');
}

function canonicalJson(value: unknown): string {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('runtime asset value is not canonicalizable');
}

function runnerUid(): number { const uid = process.getuid?.(); if (uid === undefined) throw new Error('POSIX ownership is required'); return uid; }
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function same(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code; }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (isCode(error, 'ENOENT')) return false; throw error; } }
