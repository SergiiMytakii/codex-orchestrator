import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundleMagic = Buffer.from('codex-orchestrator-runtime-bundle-v1\0', 'utf8');

export type ReviewProfile = 'simple' | 'medium' | 'high';
export type WorktreeAccess = 'read-only' | 'write';
export type WritableRootClass = 'worktree' | 'target-state' | 'proof-artifacts';

export interface RuntimeMcpToolPolicyV1 {
  server: string;
  tool: string;
  approval: 'never';
}

export interface RuntimeExecutionPolicyV1 {
  worktreeAccess: WorktreeAccess;
  sandboxMode: 'read-only' | 'workspace-write';
  writableRootClasses: WritableRootClass[];
  network: 'deny' | 'allow-listed';
  networkHosts: string[];
  mcpTools: RuntimeMcpToolPolicyV1[];
  approvalCeiling: 'never';
  externalWrite: false;
  model: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  timeoutMs: number;
  idleTimeoutMs: number;
}

export type RuntimeNodeOutcomeV1 = 'succeeded' | 'blocked' | 'route-small' | 'route-spec-required' | 'approved' | 'needs-work' | 'rejected';

export interface RuntimeGraphNodeV1 {
  id: string;
  skill: string;
  additionalSkills: string[];
  contextArtifactKinds: string[];
  resultSchema: string;
  successors: Array<{ when: RuntimeNodeOutcomeV1; node: string }>;
  executionPolicy: RuntimeExecutionPolicyV1;
}

export interface RuntimeGraphV1 {
  id: string;
  entryNode: string;
  nodes: RuntimeGraphNodeV1[];
}

export interface RuntimeGraphTemplateV1 {
  id: string;
  kind: 'artifact-review' | 'tickets-breakdown-review' | 'checkpoint-review' | 'cleanup-review' | 'code-review';
  profile: ReviewProfile | null;
  maximumReviews: number;
  requiredFreshReviewers: number;
  expansionGraph: string;
}

export interface RuntimeSkillBundleManifestV1 {
  version: 1;
  package: { name: 'codex-orchestrator'; version: string };
  acceptedBridgePackageHashes: string[];
  sourceSnapshot: 'source-snapshot.json';
  sourceFingerprint: string;
  adaptationMap: 'adaptation-map.json';
  adaptationReport: 'adaptation-report.json';
  bundleHash: string;
  files: Array<{ path: string; mode: number; size: number; sha256: string }>;
  skills: Record<string, { entry: string; files: string[]; references: string[] }>;
  operations: Record<string, { graph: string; entryNode: string }>;
  graphTemplates: Record<string, RuntimeGraphTemplateV1>;
  graphs: Record<string, RuntimeGraphV1>;
}

export interface LoadedPackageSkillBundle {
  packageRoot: string;
  bundleRoot: string;
  manifest: RuntimeSkillBundleManifestV1;
}

export interface MaterializedPackageSkillBundle {
  packageVersion: string;
  bundleHash: string;
  bundleRoot: string;
}

export async function loadPackageSkillBundle(packageRoot = defaultPackageRoot()): Promise<LoadedPackageSkillBundle> {
  const root = resolve(packageRoot);
  const bundleRoot = join(root, 'runtime-skills');
  const manifest = await readManifest(join(bundleRoot, 'bundle.json'));
  await verifyBundleTree(bundleRoot, manifest, 'source');
  return { packageRoot: root, bundleRoot, manifest };
}

export async function materializePackageSkillBundle(input: {
  targetRoot: string;
  stateDir: string;
  packageRoot?: string;
  dependencies?: {
    beforePublish?: (temporary: string, destination: string) => Promise<void>;
    afterPublish?: (destination: string) => Promise<void>;
  };
}): Promise<MaterializedPackageSkillBundle> {
  const loaded = await loadPackageSkillBundle(input.packageRoot);
  const targetRoot = resolve(input.targetRoot);
  const parent = join(targetRoot, input.stateDir, 'runtime-bundles');
  const destination = join(parent, `${loaded.manifest.package.version}-${loaded.manifest.bundleHash}`);
  await assertNoSymlinkPath(targetRoot, parent, true);
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkPath(targetRoot, parent, false);
  try {
    await verifyBundleTree(destination, loaded.manifest, 'sealed');
    return record(destination, loaded.manifest);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) {
      if (await pathExists(destination)) throw error;
    }
  }

  const temporary = join(parent, `.runtime-bundle-tmp-${process.pid}-${randomUUID()}`);
  await mkdir(temporary, { recursive: false });
  try {
    for (const file of [...loaded.manifest.files, { path: 'bundle.json', mode: 0o644, size: 0, sha256: '' }]) {
      const source = join(loaded.bundleRoot, ...file.path.split('/'));
      const target = join(temporary, ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    await sealAndSyncTree(temporary, loaded.manifest);
    await verifyBundleTree(temporary, loaded.manifest, 'sealed');
    await input.dependencies?.beforePublish?.(temporary, destination);
    try {
      await rename(temporary, destination);
      await syncDirectory(parent);
    } catch (error) {
      const destinationWon = await pathExists(destination);
      if (!destinationWon || (!isCode(error, 'EEXIST') && !isCode(error, 'ENOTEMPTY') && !isCode(error, 'EACCES') && !isCode(error, 'EPERM'))) throw error;
      await verifyBundleTree(destination, loaded.manifest, 'sealed');
    }
    await input.dependencies?.afterPublish?.(destination);
  } finally {
    await removeOwnedTemporaryTree(temporary);
  }
  await verifyBundleTree(destination, loaded.manifest, 'sealed');
  return record(destination, loaded.manifest);
}

async function removeOwnedTemporaryTree(root: string): Promise<void> {
  try {
    await makeDirectoriesWritable(root);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
  await rm(root, { recursive: true, force: true });
}

async function makeDirectoriesWritable(root: string): Promise<void> {
  await chmod(root, 0o700);
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => makeDirectoriesWritable(join(root, entry.name))));
}

export async function verifyMaterializedSkillBundle(bundleRoot: string, expectedBundleHash: string): Promise<RuntimeSkillBundleManifestV1> {
  const manifest = await readManifest(join(resolve(bundleRoot), 'bundle.json'));
  if (manifest.bundleHash !== expectedBundleHash) throw new Error('skill-bundle-unavailable: materialized bundle hash mismatch.');
  await verifyBundleTree(resolve(bundleRoot), manifest, 'sealed');
  return manifest;
}

async function verifyBundleTree(
  root: string,
  manifest: RuntimeSkillBundleManifestV1,
  modePolicy: 'source' | 'sealed',
): Promise<void> {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('skill-bundle-unavailable: bundle root must be a real directory.');
  const actualFiles = (await listTree(root)).filter((path) => path !== 'bundle.json').sort(compareUtf8);
  const expectedFiles = manifest.files.map((file) => file.path);
  if (!sameArray(actualFiles, expectedFiles)) throw new Error('skill-bundle-unavailable: bundle file closure mismatch.');
  for (const file of manifest.files) {
    const absolute = join(root, ...file.path.split('/'));
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`skill-bundle-unavailable: invalid file ${file.path}.`);
    const bytes = await readFile(absolute);
    const expectedMode = modePolicy === 'source' ? file.mode : sealedFileMode(file.mode);
    if ((stats.mode & 0o777) !== expectedMode || bytes.length !== file.size || sha(bytes) !== file.sha256) {
      throw new Error(`skill-bundle-unavailable: file drift ${file.path}.`);
    }
  }
  const computed = computeBundleHash(manifest, new Map(await Promise.all(manifest.files.map(async (file) => [file.path, await readFile(join(root, ...file.path.split('/')))] as const))));
  if (computed !== manifest.bundleHash) throw new Error('skill-bundle-unavailable: bundle hash mismatch.');
  const sourceSnapshot = JSON.parse(await readFile(join(root, manifest.sourceSnapshot), 'utf8')) as Record<string, unknown>;
  if (sourceSnapshot.sourceFingerprint !== manifest.sourceFingerprint) throw new Error('skill-bundle-unavailable: source fingerprint mismatch.');
  const adaptation = JSON.parse(await readFile(join(root, manifest.adaptationReport), 'utf8')) as Record<string, unknown>;
  if (adaptation.sourceFingerprint !== manifest.sourceFingerprint) throw new Error('skill-bundle-unavailable: adaptation fingerprint mismatch.');
}

async function readManifest(path: string): Promise<RuntimeSkillBundleManifestV1> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    throw new Error(`skill-bundle-unavailable: bundle.json missing or invalid: ${errorMessage(error)}`);
  }
  assertManifest(value);
  return value;
}

function assertManifest(value: unknown): asserts value is RuntimeSkillBundleManifestV1 {
  if (!isRecord(value) || !exactKeys(value, ['version', 'package', 'acceptedBridgePackageHashes', 'sourceSnapshot', 'sourceFingerprint', 'adaptationMap', 'adaptationReport', 'bundleHash', 'files', 'skills', 'operations', 'graphTemplates', 'graphs']) || value.version !== 1) {
    throw new Error('skill-bundle-unavailable: invalid bundle manifest schema.');
  }
  if (!isRecord(value.package) || !exactKeys(value.package, ['name', 'version']) || value.package.name !== 'codex-orchestrator' || !isText(value.package.version)
    || value.sourceSnapshot !== 'source-snapshot.json' || value.adaptationMap !== 'adaptation-map.json' || value.adaptationReport !== 'adaptation-report.json'
    || !isHash(value.sourceFingerprint) || !isHash(value.bundleHash)
    || !Array.isArray(value.acceptedBridgePackageHashes) || !isSortedUnique(value.acceptedBridgePackageHashes, isHash)
    || !Array.isArray(value.files) || !isRecord(value.skills) || !isRecord(value.operations) || !isRecord(value.graphTemplates) || !isRecord(value.graphs)) {
    throw new Error('skill-bundle-unavailable: invalid bundle manifest fields.');
  }
  let prior = '';
  for (const file of value.files) {
    if (!isRecord(file) || !exactKeys(file, ['path', 'mode', 'size', 'sha256']) || !isText(file.path) || normalizePath(file.path) !== file.path
      || (prior && compareUtf8(prior, file.path) >= 0) || !Number.isSafeInteger(file.mode) || (file.mode as number) < 0 || (file.mode as number) > 0o777
      || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || !isHash(file.sha256)) throw new Error('skill-bundle-unavailable: invalid bundle file record.');
    prior = file.path;
  }
  const manifest = value as unknown as RuntimeSkillBundleManifestV1;
  const fileSet = new Set(value.files.map((file) => file.path));
  assertSortedRecord(value.skills, (name, skill) => {
    if (!isRecord(skill) || !exactKeys(skill, ['entry', 'files', 'references']) || !isText(skill.entry) || !Array.isArray(skill.files) || !Array.isArray(skill.references)
      || !isSortedUnique(skill.files, (item) => typeof item === 'string' && fileSet.has(item)) || !isSortedUnique(skill.references, (item) => typeof item === 'string' && fileSet.has(item))
      || !fileSet.has(skill.entry) || !skill.files.includes(skill.entry)) throw new Error(`skill-bundle-unavailable: invalid skill ${name}.`);
  });
  assertSortedRecord(value.operations, (name, operation) => {
    if (!isRecord(operation) || !exactKeys(operation, ['graph', 'entryNode']) || !isText(operation.graph) || !isText(operation.entryNode)) throw new Error(`skill-bundle-unavailable: invalid operation ${name}.`);
  });
  assertSortedRecord(value.graphs, (name, graph) => assertGraph(name, graph, fileSet, manifest.skills));
  assertSortedRecord(value.graphTemplates, (name, template) => {
    if (!isRecord(template) || !exactKeys(template, ['id', 'kind', 'profile', 'maximumReviews', 'requiredFreshReviewers', 'expansionGraph']) || template.id !== name
      || !['artifact-review', 'tickets-breakdown-review', 'checkpoint-review', 'cleanup-review', 'code-review'].includes(String(template.kind))
      || ![null, 'simple', 'medium', 'high'].includes(template.profile as null | string) || !positiveInteger(template.maximumReviews)
      || !positiveInteger(template.requiredFreshReviewers) || !isText(template.expansionGraph) || !(template.expansionGraph in manifest.graphs)) throw new Error(`skill-bundle-unavailable: invalid graph template ${name}.`);
  });
  for (const [name, operation] of Object.entries(manifest.operations)) {
    const graph = manifest.graphs[operation.graph];
    if (!graph || graph.entryNode !== operation.entryNode) throw new Error(`skill-bundle-unavailable: operation ${name} graph mismatch.`);
  }
}

function assertGraph(name: string, value: unknown, fileSet: Set<string>, skills: Record<string, { entry: string; files: string[]; references: string[] }>): void {
  if (!isRecord(value) || !exactKeys(value, ['id', 'entryNode', 'nodes']) || value.id !== name || !isText(value.entryNode) || !Array.isArray(value.nodes)) throw new Error(`skill-bundle-unavailable: invalid graph ${name}.`);
  const nodeIds: string[] = [];
  for (const node of value.nodes) {
    if (!isRecord(node) || !exactKeys(node, ['id', 'skill', 'additionalSkills', 'contextArtifactKinds', 'resultSchema', 'successors', 'executionPolicy']) || !isText(node.id)
      || !isText(node.skill) || !(node.skill in skills || fileSet.has(node.skill)) || !Array.isArray(node.additionalSkills) || !isSortedUnique(node.additionalSkills, (item) => typeof item === 'string' && item in skills)
      || !Array.isArray(node.contextArtifactKinds) || !isSortedUnique(node.contextArtifactKinds, isText) || !isText(node.resultSchema) || !fileSet.has(node.resultSchema)
      || !Array.isArray(node.successors)) throw new Error(`skill-bundle-unavailable: invalid node in ${name}.`);
    assertExecutionPolicy(node.skill, node.executionPolicy);
    nodeIds.push(node.id);
  }
  if (!isSortedUnique(nodeIds, isText) || !nodeIds.includes(value.entryNode)) throw new Error(`skill-bundle-unavailable: graph ${name} node ordering mismatch.`);
  for (const node of value.nodes as Array<Record<string, unknown>>) {
    let previous = '';
    for (const successor of node.successors as unknown[]) {
      if (!isRecord(successor) || !exactKeys(successor, ['when', 'node']) || !isText(successor.when) || !isText(successor.node) || !nodeIds.includes(successor.node)
        || (previous && compareUtf8(previous, `${successor.when}\0${successor.node}`) >= 0)) throw new Error(`skill-bundle-unavailable: invalid successor in ${name}.`);
      previous = `${successor.when}\0${successor.node}`;
    }
  }
}

function assertExecutionPolicy(skill: string, value: unknown): void {
  if (!isRecord(value) || !exactKeys(value, ['worktreeAccess', 'sandboxMode', 'writableRootClasses', 'network', 'networkHosts', 'mcpTools', 'approvalCeiling', 'externalWrite', 'model', 'effort', 'timeoutMs', 'idleTimeoutMs'])
    || !['read-only', 'write'].includes(String(value.worktreeAccess)) || !['read-only', 'workspace-write'].includes(String(value.sandboxMode))
    || !Array.isArray(value.writableRootClasses) || !isSortedUnique(value.writableRootClasses, (item) => ['proof-artifacts', 'target-state', 'worktree'].includes(String(item)))
    || !['deny', 'allow-listed'].includes(String(value.network)) || !Array.isArray(value.networkHosts) || !isSortedUnique(value.networkHosts, isText)
    || !Array.isArray(value.mcpTools) || value.mcpTools.length !== 0 || value.approvalCeiling !== 'never' || value.externalWrite !== false
    || !(value.model === null || isText(value.model)) || ![null, 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value.effort as null | string)
    || !positiveInteger(value.timeoutMs) || !positiveInteger(value.idleTimeoutMs)) throw new Error(`skill-bundle-unavailable: invalid execution policy for ${skill}.`);
  const writable = value.worktreeAccess === 'write' || value.sandboxMode === 'workspace-write' || value.writableRootClasses.includes('worktree');
  if (writable && skill !== 'small-task-implementer' && skill !== 'spec-implementer') throw new Error(`skill-bundle-unavailable: unauthorized writable skill ${skill}.`);
}

function computeBundleHash(manifest: RuntimeSkillBundleManifestV1, bytesByPath: Map<string, Buffer>): string {
  const hash = createHash('sha256').update(bundleMagic);
  const manifestBytes = Buffer.from(canonicalJson({ ...manifest, bundleHash: '' }), 'utf8');
  hash.update(uint32(manifestBytes.length)).update(manifestBytes);
  for (const file of manifest.files) {
    const bytes = bytesByPath.get(file.path);
    if (!bytes) throw new Error(`skill-bundle-unavailable: missing bytes ${file.path}.`);
    const pathBytes = Buffer.from(file.path, 'utf8');
    hash.update(uint32(pathBytes.length)).update(pathBytes).update(uint32(file.mode)).update(uint64(file.size)).update(bytes);
  }
  return hash.digest('hex');
}

async function sealAndSyncTree(root: string, manifest: RuntimeSkillBundleManifestV1): Promise<void> {
  for (const file of manifest.files) {
    const path = join(root, ...file.path.split('/'));
    await chmod(path, sealedFileMode(file.mode));
    await syncFile(path);
  }
  const manifestPath = join(root, 'bundle.json');
  await chmod(manifestPath, 0o444);
  await syncFile(manifestPath);
  const directories = await listDirectories(root);
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    await chmod(directory, 0o555);
    await syncDirectory(directory);
  }
}

async function listTree(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    const path = normalizePath(relative(root, absolute).split(sep).join('/'));
    if (entry.isSymbolicLink()) throw new Error(`skill-bundle-unavailable: symlink ${path}.`);
    if (entry.isDirectory()) files.push(...(await listTree(absolute)).map((child) => `${path}/${child}`));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`skill-bundle-unavailable: non-file ${path}.`);
  }
  return files;
}

async function listDirectories(root: string): Promise<string[]> {
  const result = [root];
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) result.push(...await listDirectories(join(root, entry.name)));
  return result;
}

async function syncFile(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (isCode(error, 'ENOENT')) return false; throw error; } }
async function assertNoSymlinkPath(root: string, target: string, allowMissing: boolean): Promise<void> {
  const relativePath = relative(root, target);
  if (relativePath.startsWith('..') || resolve(root, relativePath) !== resolve(target)) throw new Error('skill-bundle-unavailable: materialization path escapes target root.');
  let current = root;
  for (const segment of ['', ...relativePath.split(sep).filter(Boolean)]) {
    if (segment) current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`skill-bundle-unavailable: unsafe materialization ancestor ${current}.`);
    } catch (error) {
      if (allowMissing && isCode(error, 'ENOENT')) return;
      throw error;
    }
  }
}
function record(root: string, manifest: RuntimeSkillBundleManifestV1): MaterializedPackageSkillBundle { return { packageVersion: manifest.package.version, bundleHash: manifest.bundleHash, bundleRoot: root }; }
function defaultPackageRoot(): string { return fileURLToPath(new URL('../../../', import.meta.url)); }
function sealedFileMode(mode: number): number { return mode & 0o111 ? 0o555 : 0o444; }
function normalizePath(path: string): string { const value = path.normalize('NFC').replaceAll('\\', '/'); if (!value || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`skill-bundle-unavailable: invalid path ${path}.`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { const actual = Object.keys(value).sort(compareUtf8); const expected = [...keys].sort(compareUtf8); return sameArray(actual, expected); }
function assertSortedRecord(value: Record<string, unknown>, validate: (name: string, item: unknown) => void): void { const keys = Object.keys(value); if (!sameArray(keys, [...keys].sort(compareUtf8))) throw new Error('skill-bundle-unavailable: manifest record keys are not sorted.'); for (const [name, item] of Object.entries(value)) validate(name, item); }
function isSortedUnique(values: unknown[], predicate: (value: any) => boolean): boolean { return values.every(predicate) && sameArray(values as string[], [...values as string[]].sort(compareUtf8)) && new Set(values).size === values.length; }
function isText(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }
function sameArray(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function canonicalJson(value: unknown): string { if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (isRecord(value)) return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; throw new Error('skill-bundle-unavailable: unsupported canonical value.'); }
function uint32(value: number): Buffer { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function uint64(value: number): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes; }
function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
function isCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'unknown error'; }
