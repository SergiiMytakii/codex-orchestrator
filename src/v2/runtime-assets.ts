import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { canonicalJson, sha256 } from './containment.js';
import { implementationReportOutputSchema } from './implementation-report.js';
import { proofReportOutputSchema } from './proof-report.js';

const SNAPSHOT_ROOT_MODE = 0o700;
const SNAPSHOT_FILE_MODE = 0o400;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;

export type InternalSkillName = 'agent-auto' | 'acceptance-proof';
export type RuntimeAssetPublishStep =
  | 'after-source-resolve'
  | 'after-first-file-sync'
  | 'before-temp-directory-sync'
  | 'after-temp-directory-sync'
  | 'before-rename'
  | 'after-rename'
  | 'after-parent-sync';

export interface RuntimeAssetFileEvidence {
  relativePath: string;
  sha256: string;
  size: number;
  mode: number;
  ownerUid: number;
}

export interface RuntimeAssetSnapshot {
  packageVersion: string;
  skill: InternalSkillName;
  runtimeRoot: string;
  snapshotRoot: string;
  skillPath: string;
  schemaPath: string;
  rootMode: number;
  ownerUid: number;
  files: RuntimeAssetFileEvidence[];
  generatedSchemaSha256: string;
  reused: boolean;
}

export async function publishRuntimeAssetSnapshot(input: {
  packageRoot: string;
  runtimeRoot: string;
  snapshotRelativePath: string;
  skill: InternalSkillName;
  onStep?: (step: RuntimeAssetPublishStep) => Promise<void> | void;
}): Promise<RuntimeAssetSnapshot> {
  const expectedUid = runnerUid();
  const packageRoot = resolve(input.packageRoot);
  const runtimeRoot = resolve(input.runtimeRoot);
  const snapshotRelativePath = validateRelativeSnapshotPath(input.snapshotRelativePath);
  const snapshotRoot = resolve(runtimeRoot, ...snapshotRelativePath.split('/'));
  assertContained(runtimeRoot, snapshotRoot, 'snapshot root');
  const attemptRoot = dirname(snapshotRoot);
  const source = await resolveSourceAssets(packageRoot, input.skill);
  await input.onStep?.('after-source-resolve');
  await assertSourceUnchanged(source);

  await ensureManagedDirectoryPath(runtimeRoot, attemptRoot, expectedUid);
  const attemptStat = await lstat(attemptRoot);
  assertDirectory(attemptStat, attemptRoot);
  assertOwner(attemptStat.uid, expectedUid, attemptRoot);
  assertMode(attemptStat.mode, SNAPSHOT_ROOT_MODE, attemptRoot);

  const lockPath = join(attemptRoot, '.snapshot.publish.lock');
  const lock = await acquirePublishLock(lockPath);
  let tempRoot: string | undefined;
  let published = false;
  try {
    await assertSourceUnchanged(source);
    if (await pathExists(snapshotRoot)) {
      const existing = expectedSnapshot({ source, runtimeRoot, snapshotRoot, expectedUid, reused: true });
      await verifyRuntimeAssetSnapshot(existing);
      await assertSourceUnchanged(source);
      return existing;
    }

    tempRoot = join(attemptRoot, `.snapshot.tmp-${process.pid}-${randomUUID()}`);
    await mkdir(tempRoot, { mode: SNAPSHOT_ROOT_MODE });
    const expectedFiles = sourceSnapshotFiles(source, expectedUid);
    for (const [index, file] of expectedFiles.entries()) {
      const bytes = sourceFileBytes(source, file.relativePath);
      if (file.relativePath.includes('/')) {
        await mkdir(dirname(join(tempRoot, file.relativePath)), { recursive: true, mode: SNAPSHOT_ROOT_MODE });
      }
      const handle = await open(join(tempRoot, file.relativePath), 'wx', SNAPSHOT_FILE_MODE);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(dirname(join(tempRoot, file.relativePath)));
      if (index === 0) await input.onStep?.('after-first-file-sync');
    }

    const tempEvidence = expectedSnapshot({
      source,
      runtimeRoot,
      snapshotRoot: tempRoot,
      expectedUid,
      reused: false,
    });
    await verifyRuntimeAssetSnapshot(tempEvidence);
    await input.onStep?.('before-temp-directory-sync');
    await syncDirectory(tempRoot);
    await input.onStep?.('after-temp-directory-sync');
    await assertSourceUnchanged(source);
    await input.onStep?.('before-rename');

    if (await pathExists(snapshotRoot)) {
      const raced = expectedSnapshot({ source, runtimeRoot, snapshotRoot, expectedUid, reused: true });
      await verifyRuntimeAssetSnapshot(raced);
      await assertSourceUnchanged(source);
      return raced;
    }

    await rename(tempRoot, snapshotRoot);
    published = true;
    await input.onStep?.('after-rename');
    await syncDirectory(attemptRoot);
    await input.onStep?.('after-parent-sync');
    const snapshot = expectedSnapshot({ source, runtimeRoot, snapshotRoot, expectedUid, reused: false });
    await verifyRuntimeAssetSnapshot(snapshot);
    await assertSourceUnchanged(source);
    return snapshot;
  } finally {
    if (tempRoot && !published) await rm(tempRoot, { recursive: true, force: true });
    await releasePublishLock(lockPath, lock.token);
  }
}

export async function verifyRuntimeAssetSnapshot(snapshot: RuntimeAssetSnapshot): Promise<void> {
  const expectedUid = runnerUid();
  if (snapshot.ownerUid !== expectedUid) throw new Error('snapshot evidence owner does not match the runner');
  if (snapshot.rootMode !== SNAPSHOT_ROOT_MODE) throw new Error('snapshot evidence root mode is invalid');
  const runtimeRoot = resolve(snapshot.runtimeRoot);
  const snapshotRoot = resolve(snapshot.snapshotRoot);
  assertContained(runtimeRoot, snapshotRoot, 'snapshot evidence root');
  await assertExistingManagedPath(runtimeRoot, snapshotRoot, expectedUid);

  const rootStat = await lstat(snapshotRoot);
  assertDirectory(rootStat, snapshotRoot);
  assertOwner(rootStat.uid, expectedUid, snapshotRoot);
  assertMode(rootStat.mode, SNAPSHOT_ROOT_MODE, snapshotRoot);

  const expectedNames = snapshot.skill === 'acceptance-proof'
    ? [
      'SKILL.md', 'output-schema.json', 'references/android.md', 'references/browser.md', 'references/ios.md',
      'tools/android-lease.mjs', 'tools/ios-lease.mjs',
    ]
    : ['SKILL.md', 'output-schema.json'];
  const actualNames = await snapshotFilePaths(snapshotRoot, expectedUid);
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error('snapshot has missing or extra entries');
  }
  if (snapshot.files.length !== expectedNames.length) throw new Error('snapshot evidence file list is invalid');
  const evidenceNames = snapshot.files.map((file) => file.relativePath);
  if (evidenceNames.some((name, index) => name !== expectedNames[index])) throw new Error('snapshot evidence file order is invalid');

  for (const file of snapshot.files) {
    if (file.ownerUid !== expectedUid) throw new Error(`snapshot evidence owner drift: ${file.relativePath}`);
    if (file.mode !== SNAPSHOT_FILE_MODE) throw new Error(`snapshot evidence mode drift: ${file.relativePath}`);
    const path = join(snapshotRoot, file.relativePath);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`snapshot contains a symbolic link: ${file.relativePath}`);
    if (!info.isFile()) throw new Error(`snapshot entry is not a regular file: ${file.relativePath}`);
    assertOwner(info.uid, expectedUid, path);
    assertMode(info.mode, SNAPSHOT_FILE_MODE, path);
    const bytes = await readFile(path);
    if (bytes.length !== file.size) throw new Error(`snapshot size mismatch: ${file.relativePath}`);
    if (sha256(bytes) !== file.sha256) throw new Error(`snapshot hash mismatch: ${file.relativePath}`);
  }
  const skillPath = join(snapshotRoot, 'SKILL.md');
  const schemaPath = join(snapshotRoot, 'output-schema.json');
  if (resolve(snapshot.skillPath) !== skillPath || resolve(snapshot.schemaPath) !== schemaPath) {
    throw new Error('snapshot evidence paths are invalid');
  }
  if (snapshot.generatedSchemaSha256 !== snapshot.files.find((file) => file.relativePath === 'output-schema.json')?.sha256) {
    throw new Error('generated schema hash does not match snapshot evidence');
  }
}

interface SourceAssets {
  packageRoot: string;
  packageJsonPath: string;
  packageJsonBytes: Buffer;
  packageVersion: string;
  skill: InternalSkillName;
  skillSourcePath: string;
  skillBytes: Buffer;
  schemaBytes: Buffer;
  supplementalAssets: Array<{ sourcePath: string; relativePath: string; bytes: Buffer }>;
}

async function resolveSourceAssets(packageRoot: string, skill: InternalSkillName): Promise<SourceAssets> {
  const packageJsonPath = join(packageRoot, 'package.json');
  const skillSourcePath = join(packageRoot, 'internal-skills', skill, 'SKILL.md');
  const supplementalPaths = skill === 'acceptance-proof'
    ? [
      { relativePath: 'references/android.md', sourcePath: join(packageRoot, 'internal-skills', skill, 'references', 'android.md') },
      { relativePath: 'references/browser.md', sourcePath: join(packageRoot, 'internal-skills', skill, 'references', 'browser.md') },
      { relativePath: 'references/ios.md', sourcePath: join(packageRoot, 'internal-skills', skill, 'references', 'ios.md') },
      { relativePath: 'tools/android-lease.mjs', sourcePath: join(packageRoot, 'internal-skills', skill, 'tools', 'android-lease.mjs') },
      { relativePath: 'tools/ios-lease.mjs', sourcePath: join(packageRoot, 'internal-skills', skill, 'tools', 'ios-lease.mjs') },
    ]
    : [];
  await assertSourcePath(packageRoot, packageJsonPath, true);
  await assertSourcePath(packageRoot, skillSourcePath, true);
  await Promise.all(supplementalPaths.map((asset) => assertSourcePath(packageRoot, asset.sourcePath, true)));
  const [packageJsonBytes, skillBytes, supplementalBytes] = await Promise.all([
    readFile(packageJsonPath),
    readFile(skillSourcePath),
    Promise.all(supplementalPaths.map((asset) => readFile(asset.sourcePath))),
  ]);
  const packageJson = JSON.parse(packageJsonBytes.toString('utf8')) as { name?: unknown; version?: unknown };
  if (packageJson.name !== 'codex-orchestrator' || typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('package.json does not identify a versioned codex-orchestrator package');
  }
  const schema = skill === 'agent-auto' ? implementationReportOutputSchema() : proofReportOutputSchema();
  return {
    packageRoot,
    packageJsonPath,
    packageJsonBytes,
    packageVersion: packageJson.version,
    skill,
    skillSourcePath,
    skillBytes,
    schemaBytes: Buffer.from(`${canonicalJson(schema)}\n`, 'utf8'),
    supplementalAssets: supplementalPaths.map((asset, index) => ({ ...asset, bytes: supplementalBytes[index] })),
  };
}

async function assertSourceUnchanged(source: SourceAssets): Promise<void> {
  await assertSourcePath(source.packageRoot, source.packageJsonPath, true);
  await assertSourcePath(source.packageRoot, source.skillSourcePath, true);
  await Promise.all(source.supplementalAssets.map((asset) => assertSourcePath(source.packageRoot, asset.sourcePath, true)));
  const [packageJsonBytes, skillBytes, supplementalBytes] = await Promise.all([
    readFile(source.packageJsonPath),
    readFile(source.skillSourcePath),
    Promise.all(source.supplementalAssets.map((asset) => readFile(asset.sourcePath))),
  ]);
  if (!packageJsonBytes.equals(source.packageJsonBytes) || !skillBytes.equals(source.skillBytes)) {
    throw new Error('package assets changed during resolution');
  }
  if (supplementalBytes.some((bytes, index) => !bytes.equals(source.supplementalAssets[index].bytes))) {
    throw new Error('package assets changed during resolution');
  }
}

function expectedSnapshot(input: {
  source: SourceAssets;
  runtimeRoot: string;
  snapshotRoot: string;
  expectedUid: number;
  reused: boolean;
}): RuntimeAssetSnapshot {
  const files = sourceSnapshotFiles(input.source, input.expectedUid);
  return {
    packageVersion: input.source.packageVersion,
    skill: input.source.skill,
    runtimeRoot: input.runtimeRoot,
    snapshotRoot: input.snapshotRoot,
    skillPath: join(input.snapshotRoot, 'SKILL.md'),
    schemaPath: join(input.snapshotRoot, 'output-schema.json'),
    rootMode: SNAPSHOT_ROOT_MODE,
    ownerUid: input.expectedUid,
    files,
    generatedSchemaSha256: files.find((file) => file.relativePath === 'output-schema.json')!.sha256,
    reused: input.reused,
  };
}

function sourceSnapshotFiles(source: SourceAssets, ownerUid: number): RuntimeAssetFileEvidence[] {
  const files: RuntimeAssetFileEvidence[] = [
    {
      relativePath: 'SKILL.md',
      sha256: sha256(source.skillBytes),
      size: source.skillBytes.length,
      mode: SNAPSHOT_FILE_MODE,
      ownerUid,
    },
    {
      relativePath: 'output-schema.json',
      sha256: sha256(source.schemaBytes),
      size: source.schemaBytes.length,
      mode: SNAPSHOT_FILE_MODE,
      ownerUid,
    },
  ];
  for (const asset of source.supplementalAssets) {
    files.push({
      relativePath: asset.relativePath,
      sha256: sha256(asset.bytes),
      size: asset.bytes.length,
      mode: SNAPSHOT_FILE_MODE,
      ownerUid,
    });
  }
  return files;
}

function sourceFileBytes(source: SourceAssets, relativePath: string): Buffer {
  if (relativePath === 'SKILL.md') return source.skillBytes;
  if (relativePath === 'output-schema.json') return source.schemaBytes;
  const supplemental = source.supplementalAssets.find((asset) => asset.relativePath === relativePath);
  if (supplemental) return supplemental.bytes;
  throw new Error(`unknown runtime asset: ${relativePath}`);
}

async function snapshotFilePaths(snapshotRoot: string, expectedUid: number): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error(`snapshot contains a symbolic link: ${relativePath}`);
      assertOwner(info.uid, expectedUid, path);
      if (entry.isDirectory()) {
        assertMode(info.mode, SNAPSHOT_ROOT_MODE, path);
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        paths.push(relativePath);
      } else {
        throw new Error(`snapshot contains a special entry: ${relativePath}`);
      }
    }
  };
  await visit(snapshotRoot, '');
  return paths.sort((left, right) => expectedAssetOrder(left) - expectedAssetOrder(right) || left.localeCompare(right));
}

function expectedAssetOrder(path: string): number {
  if (path === 'SKILL.md') return 0;
  if (path === 'output-schema.json') return 1;
  return 2;
}

async function ensureManagedDirectoryPath(runtimeRoot: string, target: string, expectedUid: number): Promise<void> {
  await assertSourcePath(runtimeRoot, runtimeRoot, false);
  assertContained(runtimeRoot, target, 'managed directory');
  const relativeTarget = relative(runtimeRoot, target);
  let current = runtimeRoot;
  for (const segment of relativeTarget.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`managed runtime path contains a symbolic link: ${current}`);
      assertDirectory(info, current);
      assertOwner(info.uid, expectedUid, current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await mkdir(current, { mode: SNAPSHOT_ROOT_MODE });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      const created = await lstat(current);
      if (created.isSymbolicLink()) throw new Error(`managed runtime path contains a symbolic link: ${current}`);
      assertDirectory(created, current);
      assertOwner(created.uid, expectedUid, current);
      assertMode(created.mode, SNAPSHOT_ROOT_MODE, current);
    }
  }
}

async function assertExistingManagedPath(runtimeRoot: string, target: string, expectedUid: number): Promise<void> {
  assertContained(runtimeRoot, target, 'managed snapshot');
  const paths = [runtimeRoot];
  let current = runtimeRoot;
  for (const segment of relative(runtimeRoot, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    paths.push(current);
  }
  for (const path of paths) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`managed runtime path contains a symbolic link: ${path}`);
    if (path !== target) assertDirectory(info, path);
    assertOwner(info.uid, expectedUid, path);
  }
}

async function assertSourcePath(root: string, target: string, finalMustBeFile: boolean): Promise<void> {
  assertContained(root, target, 'package asset');
  const paths = [root];
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    paths.push(current);
  }
  for (const [index, path] of paths.entries()) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`package asset path contains a symbolic link: ${path}`);
    const isFinal = index === paths.length - 1;
    if (isFinal && finalMustBeFile) {
      if (!info.isFile()) throw new Error(`package asset is not a regular file: ${path}`);
    } else {
      assertDirectory(info, path);
    }
  }
}

async function acquirePublishLock(path: string): Promise<{ token: string }> {
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${token}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('timed out waiting for runtime asset snapshot publisher');
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
    }
  }
}

async function releasePublishLock(path: string, token: string): Promise<void> {
  try {
    const current = await readFile(path, 'utf8');
    if (current === `${token}\n`) await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateRelativeSnapshotPath(value: string): string {
  if (value.length === 0 || isAbsolute(value) || value.includes('\\') || posix.normalize(value) !== value) {
    throw new Error('snapshotRelativePath must be a normalized relative POSIX path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('snapshotRelativePath contains an unsafe segment');
  }
  if (segments.at(-1) !== 'snapshot') throw new Error('snapshotRelativePath must end in snapshot');
  return value;
}

function assertContained(root: string, target: string, field: string): void {
  const relation = relative(resolve(root), resolve(target));
  if (relation === '' && resolve(root) === resolve(target)) return;
  if (relation.startsWith(`..${sep}`) || relation === '..' || isAbsolute(relation)) {
    throw new Error(`${field} escapes its trusted root`);
  }
}

function assertDirectory(info: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (info.isSymbolicLink()) throw new Error(`path is a symbolic link: ${path}`);
  if (!info.isDirectory()) throw new Error(`path is not a directory: ${path}`);
}

function assertOwner(actualUid: number, expectedUid: number, path: string): void {
  if (actualUid !== expectedUid) throw new Error(`path owner drift: ${path}`);
}

function assertMode(rawMode: number, expectedMode: number, path: string): void {
  const mode = rawMode & 0o777;
  if (mode !== expectedMode) throw new Error(`path mode drift at ${path}: expected ${expectedMode.toString(8)}, got ${mode.toString(8)}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function runnerUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('runtime asset snapshots require POSIX ownership checks');
  return uid;
}
