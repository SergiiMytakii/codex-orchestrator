import { createHash, randomUUID } from 'node:crypto';
import { O_NOFOLLOW, O_RDONLY } from 'node:constants';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { publishImmutableWorkflow, type ImmutableWorkflowPublishStep } from './immutable-workflow-publisher.js';

const GENERATION_MAGIC = 'codex-orchestrator-workflow-generation-v2\0';
const SOURCE_MAGIC = 'codex-orchestrator-workflow-source-v2\0';
const CONTENT_MAGIC = 'codex-orchestrator-sealed-content-v1\0';
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXPECTED_OPERATION_BINDINGS: Record<string, {
  sourceSkill: string | null; dependencySkills: string[]; outputSchema: string; profile: string;
}> = {
  'acceptance-proof': { sourceSkill: 'acceptance-proof', dependencySkills: [], outputSchema: 'schemas/proof-report-v1.json', profile: 'proof_agent' },
  'ambiguity-review': { sourceSkill: null, dependencySkills: [], outputSchema: 'schemas/ambiguity-review-v1.json', profile: 'reviewer_deep' },
  'code-review': { sourceSkill: 'code-review', dependencySkills: [], outputSchema: 'schemas/code-review-v1.json', profile: 'reviewer_standard' },
  implementation: {
    sourceSkill: 'agent-auto', dependencySkills: ['code-debugger', 'diagnosing-bugs', 'small-task-implementer', 'tdd'],
    outputSchema: 'schemas/implementation-report-v1.json', profile: 'implementer_standard',
  },
  'spec-author': { sourceSkill: 'implementation-spec-maker', dependencySkills: [], outputSchema: 'schemas/spec-author-v1.json', profile: 'implementer_standard' },
  'spec-review': { sourceSkill: 'implementation-spec-review', dependencySkills: [], outputSchema: 'schemas/spec-review-v1.json', profile: 'reviewer_deep' },
  triage: { sourceSkill: 'triage', dependencySkills: [], outputSchema: 'schemas/triage-route-v1.json', profile: 'analyst_deep' },
};

export interface WorkflowFileRecord {
  path: string;
  mode: number;
  size: number;
  sha256: string;
}

export interface WorkflowOperationPolicy {
  sandboxMode: 'read-only' | 'workspace-write';
  cwdClass: 'worktree' | 'target-state';
  worktreeAccess: 'read-only' | 'write';
  writableRootClasses: Array<'worktree' | 'target-state'>;
  runnerPostcondition: 'report-only' | 'change-set' | 'proof-only' | 'spec-only';
  network: 'deny';
  networkHosts: string[];
  mcpTools: string[];
  approvalCeiling: 'never';
  externalWrite: false;
}

interface WorkflowOperation {
  id: string;
  entry: string;
  sourceSkill: string | null;
  outputSchema: string;
  profile: string;
  policy: WorkflowOperationPolicy;
  files: string[];
  dependencySkills: string[];
  resources: string[];
}

export interface WorkflowManifest {
  version: 2;
  sourceFingerprint: string;
  generationHash: string;
  files: WorkflowFileRecord[];
  skills: Record<string, { entry: string; metadata: string; files: string[] }>;
  profiles: Record<string, string>;
  operations: Record<string, WorkflowOperation>;
  evals: Record<string, { owner: string | null; path: string }>;
}

export interface LoadedPackageWorkflow {
  manifest: WorkflowManifest;
  manifestBytes: Buffer;
  bytesByPath: Map<string, Buffer>;
}

export interface WorkflowGenerationReceipt {
  generationHash: string;
  manifestSha256: string;
  packageVersion: string;
  generationRoot: string;
  contentSha256: string;
}

export type WorkflowGenerationPublishStep = ImmutableWorkflowPublishStep;

export interface WorkflowExecutionProfile {
  name: string;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  sandboxMode: 'read-only' | 'workspace-write';
  developerInstructions: string;
}

export function parseWorkflowExecutionProfile(text: string, policy: WorkflowOperationPolicy): WorkflowExecutionProfile {
  const scalar = (key: string): string | undefined => text.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'mu'))?.[1];
  const instructions = text.match(/^developer_instructions\s*=\s*"""([\s\S]*?)"""\s*$/mu)?.[1]?.trim();
  const name = scalar('name');
  const model = scalar('model');
  const reasoningEffort = scalar('model_reasoning_effort');
  const sandboxMode = scalar('sandbox_mode');
  if (!name || !model || !/^[a-z0-9._-]+$/u.test(model)
    || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort ?? '')
    || !['read-only', 'workspace-write'].includes(sandboxMode ?? '') || !instructions) {
    throw new Error('workflow execution profile is invalid');
  }
  if (sandboxMode !== policy.sandboxMode) throw new Error('workflow execution profile sandbox mismatch');
  return {
    name,
    model,
    reasoningEffort: reasoningEffort as WorkflowExecutionProfile['reasoningEffort'],
    sandboxMode: sandboxMode as WorkflowExecutionProfile['sandboxMode'],
    developerInstructions: instructions,
  };
}

export function sealedWorkflowMode(sourceMode: number): 0o444 | 0o555 {
  if (sourceMode === 0o644) return 0o444;
  if (sourceMode === 0o755) return 0o555;
  throw new Error('workflow source mode cannot be sealed');
}

export function sealedWorkflowContentSha256(
  files: Array<{ path: string; sealedMode: number; size: number; sha256: string }>,
): string {
  return sha(Buffer.from(`${CONTENT_MAGIC}${canonicalJson({ files })}`, 'utf8'));
}

export interface ResolvedWorkflowOperation {
  id: string;
  workflowRoot: string;
  entryPath: string;
  schemaPath: string;
  profilePath: string;
  sourceSkillPath?: string;
  policy: WorkflowOperationPolicy;
  files: WorkflowFileRecord[];
}

export async function resolveWorkflowOperation(
  receipt: WorkflowGenerationReceipt,
  operationId: string,
): Promise<ResolvedWorkflowOperation> {
  await verifyWorkflowGeneration(receipt);
  const manifest = parseManifest(JSON.parse((await readRegular(join(receipt.generationRoot, 'manifest.json'))).toString('utf8')));
  const operation = manifest.operations[operationId];
  if (!operation || operation.id !== operationId) throw new Error(`workflow operation is unavailable: ${operationId}`);
  const profile = manifest.profiles[operation.profile];
  if (!profile) throw new Error(`workflow operation profile is unavailable: ${operationId}`);
  const required = [operation.entry, operation.outputSchema, profile];
  if (!required.every((path) => operation.files.includes(path))) throw new Error(`workflow operation closure is invalid: ${operationId}`);
  const sourceSkillPath = operation.sourceSkill ? manifest.skills[operation.sourceSkill]?.entry : undefined;
  if (operation.sourceSkill && (!sourceSkillPath || !operation.files.includes(sourceSkillPath))) {
    throw new Error(`workflow operation source skill is unavailable: ${operationId}`);
  }
  return {
    id: operation.id,
    workflowRoot: receipt.generationRoot,
    entryPath: join(receipt.generationRoot, ...operation.entry.split('/')),
    schemaPath: join(receipt.generationRoot, ...operation.outputSchema.split('/')),
    profilePath: join(receipt.generationRoot, ...profile.split('/')),
    sourceSkillPath: sourceSkillPath ? join(receipt.generationRoot, ...sourceSkillPath.split('/')) : undefined,
    policy: structuredClone(operation.policy),
    files: operation.files.map((path) => structuredClone(manifest.files.find((file) => file.path === path)!)),
  };
}

export async function workflowSkillHashes(receipt: WorkflowGenerationReceipt): Promise<Record<string, string>> {
  await verifyWorkflowGeneration(receipt);
  const manifest = parseManifest(JSON.parse((await readRegular(join(receipt.generationRoot, 'manifest.json'))).toString('utf8')));
  return Object.fromEntries(Object.entries(manifest.skills).map(([id, skill]) => {
    const file = manifest.files.find((candidate) => candidate.path === skill.entry);
    if (!file) throw new Error(`workflow skill entry is unavailable: ${id}`);
    return [id, file.sha256];
  }));
}

interface OwnerRecord {
  version: 1;
  status: 'building';
  bootId: string;
  pid: number;
  token: string;
  parentToken: string | null;
  processStartIdentity: string;
  startedAt: string;
}

interface WorkflowReadyRecord {
  version: 1;
  status: 'ready';
  token: string;
  contentSha256: string;
}

export async function loadPackageWorkflow(packageRootInput: string): Promise<LoadedPackageWorkflow> {
  const packageRoot = await realpath(resolve(packageRootInput));
  const workflowRoot = join(packageRoot, 'internal-workflow');
  const workflowRootInfo = await lstat(workflowRoot);
  if (!workflowRootInfo.isDirectory() || workflowRootInfo.isSymbolicLink()) throw new Error('package workflow root is unsafe');
  const manifestPath = join(workflowRoot, 'manifest.json');
  const manifestBytes = await readRegular(manifestPath);
  const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
  verifyManifestIdentity(manifest, manifestBytes);
  const actual = await listFiles(workflowRoot);
  const expected = ['manifest.json', ...manifest.files.map((file) => file.path)].sort(compareUtf8);
  if (!same(actual, expected)) throw new Error('workflow file closure mismatch');
  const bytesByPath = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const path = join(workflowRoot, ...file.path.split('/'));
    const { bytes, mode } = await readRegularEvidence(path);
    if ((mode & 0o777) !== file.mode) throw new Error(`workflow mode drift: ${file.path}`);
    if (bytes.length !== file.size || sha(bytes) !== file.sha256) throw new Error(`workflow hash mismatch: ${file.path}`);
    bytesByPath.set(file.path, bytes);
  }
  verifyEvalBytes(manifest, bytesByPath);
  verifyOperationEntryBindings(manifest, bytesByPath);
  return { manifest, manifestBytes, bytesByPath };
}

export async function materializeWorkflowGeneration(input: {
  packageRoot: string;
  runtimeRoot: string;
  packageVersion: string;
  bootId: string;
  onStep?: (step: WorkflowGenerationPublishStep) => Promise<void> | void;
}): Promise<WorkflowGenerationReceipt> {
  const loaded = await loadPackageWorkflow(input.packageRoot);
  const requestedRuntimeRoot = resolve(input.runtimeRoot);
  await ensureManagedPath(requestedRuntimeRoot, join(requestedRuntimeRoot, 'workflow-generations'));
  const runtimeRoot = await realpath(requestedRuntimeRoot);
  const parent = join(runtimeRoot, 'workflow-generations');
  const identity = loaded.manifest.generationHash;
  return publishImmutableWorkflow<OwnerRecord, WorkflowReadyRecord, string, WorkflowGenerationReceipt>({
    parent,
    identity,
    bootId: input.bootId,
    createOwner: (parentToken, processStartIdentity) => newOwner(input.bootId, parentToken, processStartIdentity),
    parseOwner,
    createReady: (owner, contentSha256): WorkflowReadyRecord => ({
      version: 1, status: 'ready', token: owner.token, contentSha256,
    }),
    parseReady,
    serializeRecord: (value) => Buffer.from(`${canonicalJson(value)}\n`, 'utf8'),
    readControl: readRegular,
    writeContent: async (contentRoot, onStep) => {
      await writeContent(contentRoot, loaded, onStep);
      return sealedContentSha256(contentRoot);
    },
    resultFromReady: ({ ready, contentRoot }) => receiptFromReady(loaded, input.packageVersion, ready, contentRoot),
    resultFromPublished: async ({ contentRoot, content: contentSha256 }) => ({
      generationHash: identity,
      manifestSha256: sha(loaded.manifestBytes),
      packageVersion: input.packageVersion,
      generationRoot: await realpath(contentRoot),
      contentSha256,
    }),
    assertContentPathAvailable: async (contentRoot) => {
      if (await exists(contentRoot)) throw new Error('workflow generation content path already exists');
    },
    verifyReadyCollision: (existing, proposed) => {
      if (!existing.equals(proposed)) throw new Error('workflow ready receipt mismatch');
    },
    activePublisherError: 'workflow generation publisher is still active',
    recoveryChainError: 'workflow recovery chain is invalid',
    onStep: input.onStep,
  });
}

export async function verifyWorkflowGeneration(receipt: WorkflowGenerationReceipt): Promise<void> {
  if (!SHA256.test(receipt.generationHash) || !SHA256.test(receipt.manifestSha256) || !SHA256.test(receipt.contentSha256)) {
    throw new Error('workflow generation receipt identity is invalid');
  }
  const root = resolve(receipt.generationRoot);
  if (await realpath(root) !== root) throw new Error('workflow generation root contains a symbolic link');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== runnerUid() || (rootInfo.mode & 0o777) !== 0o555) {
    throw new Error('workflow generation root mode or owner drift');
  }
  const manifestBytes = await readRegular(join(root, 'manifest.json'));
  if (sha(manifestBytes) !== receipt.manifestSha256) throw new Error('workflow generation manifest mismatch');
  const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
  verifyManifestIdentity(manifest, manifestBytes);
  if (manifest.generationHash !== receipt.generationHash) throw new Error('workflow generation identity mismatch');
  const actual = await listFiles(root);
  const expected = ['manifest.json', ...manifest.files.map((file) => file.path)].sort(compareUtf8);
  if (!same(actual, expected)) throw new Error('workflow generation file closure drift');
  const bytesByPath = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const path = join(root, ...file.path.split('/'));
    const { bytes, mode: actualMode, uid } = await readRegularEvidence(path);
    const mode = file.mode === 0o755 ? 0o555 : 0o444;
    if (uid !== runnerUid() || (actualMode & 0o777) !== mode) throw new Error(`workflow generation mode drift: ${file.path}`);
    if (bytes.length !== file.size || sha(bytes) !== file.sha256) throw new Error(`workflow generation hash drift: ${file.path}`);
    bytesByPath.set(file.path, bytes);
  }
  verifyEvalBytes(manifest, bytesByPath);
  verifyOperationEntryBindings(manifest, bytesByPath);
  for (const directory of await listDirectories(root)) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== runnerUid() || (info.mode & 0o777) !== 0o555) {
      throw new Error('workflow generation directory mode or owner drift');
    }
  }
  if (await sealedContentSha256(root) !== receipt.contentSha256) throw new Error('workflow generation content hash mismatch');
}

function verifyManifestIdentity(manifest: WorkflowManifest, manifestBytes: Buffer): void {
  const canonicalBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
  if (!manifestBytes.equals(canonicalBytes)) throw new Error('workflow manifest bytes are not canonical');
  const sourceFingerprint = sha(Buffer.from(`${SOURCE_MAGIC}${canonicalJson({ files: manifest.files })}`, 'utf8'));
  if (sourceFingerprint !== manifest.sourceFingerprint) throw new Error('workflow source fingerprint mismatch');
  const generationHash = sha(Buffer.from(`${GENERATION_MAGIC}${canonicalJson({ ...manifest, generationHash: '' })}`, 'utf8'));
  if (generationHash !== manifest.generationHash) throw new Error('workflow generation hash mismatch');
}

async function writeContent(
  root: string,
  loaded: LoadedPackageWorkflow,
  onStep: (step: ImmutableWorkflowPublishStep) => Promise<void>,
): Promise<void> {
  await writeContentFile(root, 'manifest.json', loaded.manifestBytes, 0o444);
  await onStep('after-first-content-file');
  for (const file of loaded.manifest.files) {
    await writeContentFile(root, file.path, loaded.bytesByPath.get(file.path)!, sealedWorkflowMode(file.mode));
  }
  for (const directory of (await listDirectories(root)).sort((left, right) => right.length - left.length)) {
    await chmod(directory, 0o555);
    await syncDirectory(directory);
  }
}

async function writeContentFile(root: string, logical: string, bytes: Buffer, mode: number): Promise<void> {
  const path = join(root, ...logical.split('/'));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeSyncedFile(path, bytes, mode);
}

async function sealedContentSha256(root: string): Promise<string> {
  const files = [];
  for (const path of await listFiles(root)) {
    const absolute = join(root, ...path.split('/'));
    const { bytes, mode } = await readRegularEvidence(absolute);
    files.push({ path, sealedMode: mode & 0o777, size: bytes.length, sha256: sha(bytes) });
  }
  return sealedWorkflowContentSha256(files);
}

async function receiptFromReady(
  loaded: LoadedPackageWorkflow,
  packageVersion: string,
  ready: WorkflowReadyRecord,
  contentRoot: string,
): Promise<WorkflowGenerationReceipt> {
  const receipt = {
    generationHash: loaded.manifest.generationHash,
    manifestSha256: sha(loaded.manifestBytes),
    packageVersion,
    generationRoot: await realpath(contentRoot),
    contentSha256: ready.contentSha256,
  };
  await verifyWorkflowGeneration(receipt);
  return receipt;
}

function newOwner(bootId: string, parentToken: string | null, processStartIdentity: string): OwnerRecord {
  return {
    version: 1, status: 'building', bootId, pid: process.pid, token: randomUUID(), parentToken,
    processStartIdentity, startedAt: new Date().toISOString(),
  };
}

function parseOwner(value: unknown): OwnerRecord {
  assertExact(value, ['version', 'status', 'bootId', 'pid', 'token', 'parentToken', 'processStartIdentity', 'startedAt']);
  if (value.version !== 1 || value.status !== 'building' || typeof value.bootId !== 'string' || !value.bootId
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.token !== 'string' || !UUID.test(value.token)
    || !(value.parentToken === null || (typeof value.parentToken === 'string' && UUID.test(value.parentToken)))
    || typeof value.processStartIdentity !== 'string' || !value.processStartIdentity
    || typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt))) throw new Error('workflow owner record is invalid');
  return value as unknown as OwnerRecord;
}

function parseReady(value: unknown): WorkflowReadyRecord {
  assertExact(value, ['version', 'status', 'token', 'contentSha256']);
  if (value.version !== 1 || value.status !== 'ready' || typeof value.token !== 'string' || !UUID.test(value.token)
    || !SHA256.test(String(value.contentSha256))) throw new Error('workflow ready receipt is invalid');
  return value as unknown as WorkflowReadyRecord;
}

function parseManifest(value: unknown): WorkflowManifest {
  if (!isRecord(value) || value.version !== 2) throw new Error('workflow manifest version is invalid');
  assertExact(value, ['version', 'sourceFingerprint', 'generationHash', 'files', 'skills', 'profiles', 'operations', 'evals']);
  if (!SHA256.test(String(value.sourceFingerprint)) || !SHA256.test(String(value.generationHash))
    || !Array.isArray(value.files) || !isRecord(value.skills) || !isRecord(value.profiles) || !isRecord(value.operations)
    || !isRecord(value.evals)) throw new Error('workflow manifest is invalid');
  const skills = value.skills as Record<string, any>;
  const profiles = value.profiles as Record<string, any>;
  const operations = value.operations as Record<string, any>;
  const evals = value.evals as Record<string, any>;
  let previous = '';
  const physical = new Set<string>();
  for (const file of value.files) {
    assertExact(file, ['path', 'mode', 'size', 'sha256']);
    if (typeof file.path !== 'string' || normalizePath(file.path) !== file.path || (previous && compareUtf8(previous, file.path) >= 0)
      || ![0o644, 0o755].includes(file.mode as number) || !Number.isSafeInteger(file.size) || (file.size as number) < 0
      || !SHA256.test(String(file.sha256))) throw new Error('workflow manifest file record is invalid');
    previous = file.path;
    physical.add(file.path);
  }
  if (Object.keys(skills).length === 0) throw new Error('workflow skills inventory is invalid');
  for (const [id, skill] of Object.entries(skills)) {
    assertExact(skill, ['entry', 'metadata', 'files']);
    if (typeof skill.entry !== 'string' || typeof skill.metadata !== 'string' || !Array.isArray(skill.files)) {
      throw new Error(`workflow skill is invalid: ${id}`);
    }
    validatePathList(skill.files, physical, `workflow skill closure: ${id}`);
    if (!skill.files.includes(skill.entry) || !skill.files.includes(skill.metadata)
      || skill.entry !== `skills/${id}/SKILL.md` || skill.metadata !== `skills/${id}/agents/openai.yaml`) {
      throw new Error(`workflow skill authority is invalid: ${id}`);
    }
  }
  if (Object.keys(profiles).length === 0) throw new Error('workflow profiles inventory is invalid');
  for (const [id, path] of Object.entries(profiles)) {
    if (typeof path !== 'string' || normalizePath(path) !== path || path !== `profiles/${id}.toml` || !physical.has(path)) {
      throw new Error(`workflow profile is invalid: ${id}`);
    }
  }
  const bindings = EXPECTED_OPERATION_BINDINGS;
  assertRecordKeys(operations, Object.keys(bindings), 'workflow operations');
  for (const [id, operation] of Object.entries(operations)) {
    assertExact(operation, ['id', 'entry', 'sourceSkill', 'dependencySkills', 'resources', 'outputSchema', 'profile', 'policy', 'files']);
    if (operation.id !== id || typeof operation.entry !== 'string' || operation.entry !== `operations/${id}/SKILL.md`
      || !(operation.sourceSkill === null || typeof operation.sourceSkill === 'string')
      || typeof operation.outputSchema !== 'string' || typeof operation.profile !== 'string'
      || !Array.isArray(operation.files) || !isRecord(operation.policy)) {
      throw new Error(`workflow operation is invalid: ${id}`);
    }
    if (id === 'ambiguity-review' ? operation.sourceSkill !== null : operation.sourceSkill === null) {
      throw new Error(`workflow operation source skill is invalid: ${id}`);
    }
    const binding = bindings[id]!;
    validateSortedStrings(operation.dependencySkills, `workflow operation dependency skills: ${id}`);
    validateSortedStrings(operation.resources, `workflow operation resources: ${id}`);
    const dependencySkills = operation.dependencySkills;
    const resources = operation.resources;
    if (!same(dependencySkills, binding.dependencySkills)) {
      throw new Error(`workflow operation dependency binding is invalid: ${id}`);
    }
    if (operation.sourceSkill !== binding.sourceSkill || operation.outputSchema !== binding.outputSchema || operation.profile !== binding.profile) {
      throw new Error(`workflow operation binding is invalid: ${id}`);
    }
    const sourceSkill = operation.sourceSkill === null ? undefined : skills[operation.sourceSkill];
    if (operation.sourceSkill !== null && !sourceSkill) throw new Error(`workflow operation source skill is invalid: ${id}`);
    if (dependencySkills.some((skill) => skill === operation.sourceSkill || !(skill in skills))) {
      throw new Error(`workflow operation dependency skill is invalid: ${id}`);
    }
    if (resources.some((path) => typeof path !== 'string' || !physical.has(path))) throw new Error(`workflow operation resource is invalid: ${id}`);
    if (!(operation.profile in profiles)) throw new Error(`workflow operation profile is invalid: ${id}`);
    validatePathList(operation.files, physical, `workflow operation closure: ${id}`);
    const required = [
      operation.entry,
      operation.outputSchema,
      profiles[operation.profile],
      ...resources,
      ...(sourceSkill?.files ?? []),
      ...dependencySkills.flatMap((skill) => skills[skill]!.files),
    ].sort(compareUtf8);
    if (!same(operation.files, [...new Set(required)].sort(compareUtf8))) throw new Error(`workflow operation closure is invalid: ${id}`);
    if (operation.files.some((path) => path.includes('/evals/'))) {
      throw new Error(`workflow operation eval isolation is invalid: ${id}`);
    }
    validateOperationPolicy(id, operation.policy);
  }
  const evalPaths = new Set<string>();
  for (const [id, entry] of Object.entries(evals)) {
    assertExact(entry, ['owner', 'path']);
    if (!id || !(entry.owner === null || (typeof entry.owner === 'string' && entry.owner in skills))
      || typeof entry.path !== 'string' || !physical.has(entry.path) || evalPaths.has(entry.path)) {
      throw new Error(`workflow eval binding is invalid: ${id}`);
    }
    evalPaths.add(entry.path);
  }
  if (evalPaths.size === 0) throw new Error('workflow eval inventory is empty');
  return value as unknown as WorkflowManifest;
}

function verifyEvalBytes(manifest: WorkflowManifest, bytesByPath: Map<string, Buffer>): void {
  const caseIds = new Set<string>();
  for (const [id, entry] of Object.entries(manifest.evals)) {
    const bytes = bytesByPath.get(entry.path);
    if (!bytes) throw new Error(`workflow eval bytes are missing: ${id}`);
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(`workflow eval JSON is invalid: ${id}`); }
    if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.cases) || value.cases.length === 0
      || (entry.owner !== null && value.skill !== entry.owner)) throw new Error(`workflow eval contract is invalid: ${id}`);
    for (const item of value.cases) {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0 || caseIds.has(item.id)
        || typeof item.prompt !== 'string' || item.prompt.length === 0
        || !evalTextList(item.expected) || !evalTextList(item.forbidden)) throw new Error(`workflow eval case is invalid: ${id}`);
      caseIds.add(item.id);
    }
  }
}

function verifyOperationEntryBindings(manifest: WorkflowManifest, bytesByPath: Map<string, Buffer>): void {
  for (const [id, operation] of Object.entries(manifest.operations)) {
    const entryBytes = bytesByPath.get(operation.entry);
    if (!entryBytes) throw new Error(`workflow operation entry bytes are missing: ${id}`);
    const linked = new Set<string>();
    for (const match of entryBytes.toString('utf8').matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/gu)) {
      const target = match[1]!;
      if (/^[a-z]+:/iu.test(target) || target.startsWith('/')) continue;
      linked.add(normalizePath(relative('/', resolve('/', dirname(operation.entry), target)).split(sep).join('/')));
    }
    const required = [
      ...(operation.sourceSkill === null ? [] : [[operation.sourceSkill, manifest.skills[operation.sourceSkill]!.entry]]),
      ...operation.dependencySkills.map((skill) => [skill, manifest.skills[skill]!.entry]),
      ...operation.resources.map((path) => [path, path]),
    ];
    for (const [name, path] of required) {
      if (!linked.has(path)) throw new Error(`workflow operation ${id} does not reference declared dependency ${name}`);
    }
  }
}

function evalTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);
}

function validateSortedStrings(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
  let previous = '';
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || (previous && compareUtf8(previous, item) >= 0)) throw new Error(`${field} is invalid`);
    previous = item;
  }
}

function validateOperationPolicy(id: string, value: Record<string, unknown>): void {
  assertExact(value, [
    'sandboxMode', 'cwdClass', 'worktreeAccess', 'writableRootClasses', 'runnerPostcondition',
    'network', 'networkHosts', 'mcpTools', 'approvalCeiling', 'externalWrite',
  ]);
  if (value.network !== 'deny' || !Array.isArray(value.networkHosts) || value.networkHosts.length !== 0
    || !Array.isArray(value.mcpTools) || value.mcpTools.length !== 0 || value.approvalCeiling !== 'never'
    || value.externalWrite !== false) throw new Error(`workflow operation authority is invalid: ${id}`);
  const expected = id === 'implementation'
    ? ['workspace-write', 'worktree', 'write', 'worktree', 'change-set']
    : id === 'acceptance-proof'
      ? ['workspace-write', 'worktree', 'write', 'worktree', 'proof-only']
      : id === 'spec-author'
        ? ['workspace-write', 'target-state', 'write', 'target-state', 'spec-only']
        : ['read-only', 'worktree', 'read-only', '', 'report-only'];
  const roots = Array.isArray(value.writableRootClasses) ? value.writableRootClasses.join(',') : '<invalid>';
  const actual = [value.sandboxMode, value.cwdClass, value.worktreeAccess, roots, value.runnerPostcondition];
  if (!same(actual.map(String), expected)) throw new Error(`workflow operation policy is invalid: ${id}`);
}

function validatePathList(value: unknown[], physical: Set<string>, field: string): asserts value is string[] {
  let previous = '';
  for (const path of value) {
    if (typeof path !== 'string' || normalizePath(path) !== path || (previous && compareUtf8(previous, path) >= 0) || !physical.has(path)) {
      throw new Error(`${field} is invalid`);
    }
    previous = path;
  }
  if (value.length === 0) throw new Error(`${field} is empty`);
}

function assertRecordKeys(value: Record<string, unknown>, expected: string[], field: string): void {
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (!same(actual, wanted)) throw new Error(`${field} inventory is invalid`);
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const logical = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`workflow symlink rejected: ${logical}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(logical);
      else throw new Error(`workflow special entry rejected: ${logical}`);
    }
  };
  await visit(root);
  return result.sort(compareUtf8);
}

async function listDirectories(root: string): Promise<string[]> {
  const result = [root];
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) result.push(...await listDirectories(join(root, entry.name)));
  return result;
}

async function writeSyncedFile(path: string, bytes: Buffer, mode: number): Promise<void> {
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
    throw new Error(`workflow path is not a regular file: ${path}`, { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`workflow path is not a regular file: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.length) !== after.size) throw new Error(`workflow path changed while reading: ${path}`);
    return { bytes, mode: Number(after.mode), uid: Number(after.uid) };
  } finally {
    await handle.close();
  }
}

async function ensureManagedPath(root: string, target: string): Promise<void> {
  await createManagedRoot(root, 'workflow runtime root is unsafe');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== runnerUid()) throw new Error('workflow runtime root is unsafe');
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => { if (!isCode(error, 'EEXIST')) throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== runnerUid() || (info.mode & 0o777) !== 0o700) {
      throw new Error('workflow managed path is unsafe');
    }
  }
}

async function createManagedRoot(path: string, message: string): Promise<void> {
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
      if (info.uid === runnerUid() || !(await stat(segment)).isDirectory()) throw new Error(message);
    } else if (!info.isDirectory()) {
      throw new Error(message);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isCode(error, 'ENOENT')) return false; throw error; }
}

function assertExact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error('workflow object is invalid');
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (!same(actual, expected)) throw new Error('workflow object has unknown or missing keys');
}

function normalizePath(value: string): string {
  const path = value.normalize('NFC').replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('workflow path is invalid');
  return path;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('unsupported canonical workflow value');
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function same(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code; }
function runnerUid(): number { const uid = process.getuid?.(); if (uid === undefined) throw new Error('POSIX ownership is required'); return uid; }
