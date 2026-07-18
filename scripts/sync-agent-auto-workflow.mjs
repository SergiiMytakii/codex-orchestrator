#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SOURCE_MAGIC = 'codex-orchestrator-workflow-source-v1\0';
const GENERATION_MAGIC = 'codex-orchestrator-workflow-generation-v1\0';
const PRODUCTION_OPERATION_BINDINGS = {
  'acceptance-proof': ['acceptance-proof', 'schemas/proof-report-v1.json', 'proof_agent'],
  'ambiguity-review': [null, 'schemas/ambiguity-review-v1.json', 'reviewer_deep'],
  'cleanup-review': ['cleanup-review', 'schemas/code-review-v1.json', 'reviewer_standard'],
  'code-review': ['code-review', 'schemas/code-review-v1.json', 'reviewer_deep'],
  implementation: ['agent-auto', 'schemas/implementation-report-v1.json', 'implementer_standard'],
  'spec-author': ['implementation-spec-maker', 'schemas/spec-author-v1.json', 'implementer_standard'],
  'spec-implementation': ['spec-implementer', 'schemas/implementation-report-v1.json', 'implementer_standard'],
  'spec-review': ['implementation-spec-review', 'schemas/spec-review-v1.json', 'reviewer_deep'],
  triage: ['triage', 'schemas/triage-route-v1.json', 'analyst_deep'],
};

const options = parseArgs(process.argv.slice(2));
if (options.command === 'verify') {
  await verifyGenerated(resolve(options.outputRoot));
  process.stdout.write('workflow verified\n');
  process.exit(0);
}

const expected = await buildExpected(options);
await recheckExpectedSources(expected);
if (options.command === 'check') {
  await assertTreeMatches(resolve(options.outputRoot), expected);
  process.stdout.write(`${expected.manifest.generationHash}\n`);
  process.exit(0);
}

await recheckExpectedSources(expected);
await publishTree(resolve(options.outputRoot), expected);
process.stdout.write(`${expected.manifest.generationHash}\n`);

function parseArgs(values) {
  const command = values.shift();
  if (!['sync', 'check', 'verify'].includes(command)) throw new Error('Expected sync, check, or verify command.');
  const parsed = { command };
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    const value = values[++index];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--codex-home') parsed.codexHome = value;
    else if (flag === '--repo-root') parsed.repoRoot = value;
    else if (flag === '--config') parsed.config = value;
    else if (flag === '--output-root') parsed.outputRoot = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!parsed.outputRoot) throw new Error('--output-root is required.');
  if (command !== 'verify' && (!parsed.codexHome || !parsed.repoRoot || !parsed.config)) {
    throw new Error('--codex-home, --repo-root, and --config are required.');
  }
  return parsed;
}

async function buildExpected(input) {
  const codexHome = await realpath(resolve(input.codexHome));
  const repoRoot = await realpath(resolve(input.repoRoot));
  const configPath = await requireContainedFile(resolve(input.config), repoRoot);
  const { info: configInfo, bytes: configBytes } = await readSourceFile(configPath);
  const config = JSON.parse(configBytes.toString('utf8'));
  await runAfterConfigReadTestHook();
  validateConfig(config);
  const entries = new Map();
  const sourceRecords = [{
    source: configPath,
    mode: configInfo.mode & 0o777,
    size: configBytes.length,
    sha256: sha(configBytes),
    dev: configInfo.dev,
    ino: configInfo.ino,
  }];
  const sourceInventories = [];

  for (const skill of config.personalSkills) {
    const sourceRoot = await requireContainedDirectory(join(codexHome, 'skills', skill), join(codexHome, 'skills'));
    sourceInventories.push({ root: sourceRoot, inventory: await snapshotSourceTree(sourceRoot) });
    await copyTree({
      sourceRoot,
      targetRoot: `skills/${skill}`,
      entries,
      sourceRecords,
      sourceBase: codexHome,
      adapt: true,
      codexHome,
      adaptations: config.adaptations,
    });
  }
  for (const skill of config.repositorySkills) {
    const sourceRoot = await requireContainedDirectory(join(repoRoot, 'internal-skills', skill), join(repoRoot, 'internal-skills'));
    sourceInventories.push({ root: sourceRoot, inventory: await snapshotSourceTree(sourceRoot) });
    await copyTree({
      sourceRoot,
      targetRoot: `skills/${skill}`,
      entries,
      sourceRecords,
      sourceBase: repoRoot,
      adapt: true,
      codexHome,
      adaptations: config.adaptations,
    });
  }

  const docsRoot = await requireContainedDirectory(join(codexHome, 'docs', 'agents'), join(codexHome, 'docs'));
  sourceInventories.push({ root: docsRoot, inventory: await snapshotSourceTree(docsRoot) });
  const docs = await collectSharedDocs(config.sharedDocs, codexHome, entries);
  for (const relativePath of docs) {
    await copyFileEntry({
      source: join(codexHome, 'docs', 'agents', ...relativePath.split('/')),
      target: `docs/agents/${relativePath}`,
      entries,
      sourceRecords,
      sourceBase: codexHome,
      adapt: true,
      codexHome,
      adaptations: config.adaptations,
    });
  }

  const overlayRoot = await requireContainedDirectory(join(repoRoot, config.overlayRoot), repoRoot);
  sourceInventories.push({ root: overlayRoot, inventory: await snapshotSourceTree(overlayRoot) });
  await copyTree({
    sourceRoot: overlayRoot,
    targetRoot: '',
    entries,
    sourceRecords,
    sourceBase: repoRoot,
    adapt: false,
    codexHome,
    adaptations: config.adaptations,
  });

  for (const [profile, sourceName] of Object.entries(config.profiles)) {
    await copyFileEntry({
      source: join(codexHome, 'agents', sourceName),
      target: `profiles/${profile}.toml`,
      entries,
      sourceRecords,
      sourceBase: codexHome,
      adapt: false,
      codexHome,
      adaptations: config.adaptations,
    });
  }

  await recheckSources(sourceRecords);
  await recheckSourceInventories(sourceInventories);
  validateReferences(entries);
  validateNoAmbientPaths(entries, codexHome);

  const skills = {};
  const sharedDocFiles = [...entries.keys()].filter((path) => path.startsWith('docs/agents/')).sort(compareUtf8);
  for (const skill of [...config.repositorySkills, ...config.personalSkills].sort(compareUtf8)) {
    const prefix = `skills/${skill}/`;
    const files = [...entries.keys()].filter((path) => path.startsWith(prefix)).concat(sharedDocFiles).sort(compareUtf8);
    const entry = `${prefix}SKILL.md`;
    const metadata = `${prefix}agents/openai.yaml`;
    if (!entries.has(entry) || !entries.has(metadata)) throw new Error(`Skill ${skill} is missing SKILL.md or agents/openai.yaml.`);
    skills[skill] = { entry, metadata, files };
  }

  const profiles = {};
  for (const profile of Object.keys(config.profiles).sort(compareUtf8)) profiles[profile] = `profiles/${profile}.toml`;
  for (const [path] of entries) {
    const match = path.match(/^profiles\/([a-z0-9_]+)\.toml$/u);
    if (match && !(match[1] in profiles)) profiles[match[1]] = path;
  }

  const operations = {};
  for (const id of Object.keys(config.operations).sort(compareUtf8)) {
    const operation = structuredClone(config.operations[id]);
    if (!entries.has(operation.entry) || !entries.has(operation.outputSchema) || !(operation.profile in profiles)) {
      throw new Error(`Operation ${id} references an undeclared entry, schema, or profile.`);
    }
    if (operation.sourceSkill !== null && !(operation.sourceSkill in skills)) throw new Error(`Operation ${id} source skill is invalid.`);
    const files = [operation.entry, operation.outputSchema, profiles[operation.profile],
      ...(operation.sourceSkill === null ? [] : skills[operation.sourceSkill].files)].sort(compareUtf8);
    operations[id] = { id, ...operation, files: [...new Set(files)].sort(compareUtf8) };
  }

  const files = [...entries.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([path, entry]) => ({
    path, mode: entry.mode, size: entry.bytes.length, sha256: sha(entry.bytes),
  }));
  const sourceFingerprint = sha(Buffer.from(`${SOURCE_MAGIC}${canonicalJson({ files })}`, 'utf8'));
  const manifest = { version: 1, sourceFingerprint, generationHash: '', files, skills, profiles, operations };
  manifest.generationHash = sha(Buffer.from(`${GENERATION_MAGIC}${canonicalJson(manifest)}`, 'utf8'));
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
  return { entries, manifest, manifestBytes, sourceRecords, sourceInventories };
}

async function runAfterConfigReadTestHook() {
  const marker = process.env.CODEX_ORCHESTRATOR_TEST_CONFIG_READ_MARKER;
  const release = process.env.CODEX_ORCHESTRATOR_TEST_CONFIG_READ_RELEASE;
  if (!marker && !release) return;
  if (!marker || !release) throw new Error('Config read test hook requires marker and release paths.');
  await writeFile(marker, 'config-read\n');
  for (;;) {
    try {
      await lstat(release);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await delay(5);
    }
  }
}

async function copyTree(input) {
  for (const entry of await sortedEntries(input.sourceRoot)) {
    if (entry.name.startsWith('.env')) throw new Error(`Protected source path rejected: ${entry.name}`);
    const source = join(input.sourceRoot, entry.name);
    const target = input.targetRoot ? `${input.targetRoot}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink source rejected: ${source}`);
    if (entry.isDirectory()) await copyTree({ ...input, sourceRoot: source, targetRoot: target });
    else if (entry.isFile()) await copyFileEntry({ ...input, source, target });
    else throw new Error(`Special source entry rejected: ${source}`);
  }
}

async function copyFileEntry(input) {
  const source = await requireContainedFile(input.source, input.sourceBase);
  const { info, bytes: original } = await readSourceFile(source);
  const mode = info.mode & 0o777;
  if (![0o644, 0o755].includes(mode)) throw new Error(`Unsupported source mode ${mode.toString(8)}: ${source}`);
  const target = normalizePath(input.target);
  const bytes = input.adapt && isText(target)
    ? Buffer.from(adaptText(original.toString('utf8'), input.codexHome, input.adaptations), 'utf8')
    : original;
  if (input.entries.has(target)) {
    const existing = input.entries.get(target);
    if (!existing.bytes.equals(bytes) || existing.mode !== mode) throw new Error(`Conflicting generated path: ${target}`);
    return;
  }
  input.entries.set(target, { bytes, mode });
  input.sourceRecords.push({ source, mode, size: original.length, sha256: sha(original), dev: info.dev, ino: info.ino });
}

async function collectSharedDocs(initial, codexHome, entries) {
  const root = join(codexHome, 'docs', 'agents');
  const queued = new Set(initial.map(normalizePath));
  const queue = [...queued];
  const seedTexts = [...entries.values()].filter((entry) => isText('x.md')).map((entry) => entry.bytes.toString('utf8'));
  for (const text of seedTexts) for (const path of referencedAgentDocs(text)) enqueue(path);
  while (queue.length > 0) {
    const current = queue.shift();
    const path = await requireContainedFile(join(root, ...current.split('/')), root);
    const text = await readFile(path, 'utf8');
    for (const match of text.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/gu)) {
      const target = match[1];
      if (/^[a-z]+:/iu.test(target) || target.startsWith('/')) continue;
      const resolved = normalizePath(relative(root, resolve(dirname(path), target)).split(sep).join('/'));
      enqueue(resolved);
    }
  }
  return [...queued].sort(compareUtf8);

  function enqueue(path) {
    const normalized = normalizePath(path);
    if (!queued.has(normalized)) { queued.add(normalized); queue.push(normalized); }
  }
}

function referencedAgentDocs(text) {
  const result = [];
  for (const match of text.matchAll(/(?:docs\/agents\/|\.\.\/(?:\.\.\/)*docs\/agents\/)([A-Za-z0-9._/-]+\.md)/gu)) result.push(match[1]);
  return result;
}

function adaptText(text, codexHome, adaptations) {
  let output = text;
  for (const adaptation of adaptations) {
    const from = adaptation.from === '<resolved-codex-home>' ? codexHome : adaptation.from;
    output = output.split(from).join(adaptation.to);
  }
  return output;
}

async function recheckSources(records) {
  for (const record of records) {
    const { info, bytes } = await readSourceFile(record.source);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== record.mode
      || info.dev !== record.dev || info.ino !== record.ino || bytes.length !== record.size || sha(bytes) !== record.sha256) {
      throw new Error(`Source changed during workflow import: ${record.source}`);
    }
  }
}

async function readSourceFile(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Source file is invalid: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    if (!opened.isFile() || opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size
      || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`Source identity changed during read: ${path}`);
    }
    return { info: after, bytes };
  } finally {
    await handle.close();
  }
}

async function snapshotSourceTree(root) {
  const rows = [];
  const visit = async (directory, prefix = '') => {
    for (const entry of await sortedEntries(directory)) {
      const path = join(directory, entry.name);
      const logical = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink source rejected: ${path}`);
      if (entry.isDirectory()) {
        rows.push([logical, 'directory', (await lstat(path)).mode & 0o777]);
        await visit(path, logical);
      } else if (entry.isFile()) {
        const { info, bytes } = await readSourceFile(path);
        rows.push([logical, 'file', info.mode & 0o777, bytes.length, sha(bytes), info.dev, info.ino]);
      } else throw new Error(`Special source entry rejected: ${path}`);
    }
  };
  await visit(root);
  return canonicalJson(rows);
}

async function recheckSourceInventories(inventories) {
  for (const source of inventories) {
    if (await snapshotSourceTree(source.root) !== source.inventory) throw new Error(`Source tree changed during workflow import: ${source.root}`);
  }
}

async function recheckExpectedSources(expected) {
  await recheckSources(expected.sourceRecords);
  await recheckSourceInventories(expected.sourceInventories);
}

function validateReferences(entries) {
  for (const [path, entry] of entries) {
    if (!/\.(?:md|yaml|yml)$/iu.test(path)) continue;
    const text = entry.bytes.toString('utf8');
    for (const match of text.matchAll(/\]\(([^)#]+\.(?:md|mjs|yaml|yml))(?:#[^)]+)?\)/gu)) {
      const target = match[1];
      if (/^[a-z]+:/iu.test(target) || target.startsWith('/')) continue;
      const resolved = normalizePath(relative('/', resolve('/', dirname(path), target)).split(sep).join('/'));
      if (!entries.has(resolved)) throw new Error(`Broken packaged reference in ${path}: ${target}`);
    }
  }
}

function validateNoAmbientPaths(entries, codexHome) {
  for (const [path, entry] of entries) {
    if (!isText(path)) continue;
    const text = entry.bytes.toString('utf8');
    if (text.includes(codexHome) || /\/Users\/[^/]+\/\.codex|\/home\/[^/]+\/\.codex/u.test(text)
      || /\$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills|\$CODEX_HOME\/skills/u.test(text)) {
      throw new Error(`Personal absolute path remained in ${path}`);
    }
  }
}

async function publishTree(outputRoot, expected) {
  const parent = dirname(outputRoot);
  const temporary = join(parent, `.${outputRoot.split(sep).at(-1)}.tmp-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: false });
  try {
    for (const [path, entry] of expected.entries) await writeEntry(temporary, path, entry);
    await writeEntry(temporary, 'manifest.json', { bytes: expected.manifestBytes, mode: 0o644 });
    await verifyGenerated(temporary);
    await rm(outputRoot, { recursive: true, force: true });
    await rename(temporary, outputRoot);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function assertTreeMatches(outputRoot, expected) {
  const actual = await readTree(outputRoot);
  const wanted = new Map(expected.entries);
  wanted.set('manifest.json', { bytes: expected.manifestBytes, mode: 0o644 });
  if (actual.size !== wanted.size) throw new Error('Generated workflow is stale: file count mismatch.');
  for (const [path, entry] of wanted) {
    const found = actual.get(path);
    if (!found || found.mode !== entry.mode || !found.bytes.equals(entry.bytes)) {
      throw new Error(`Generated workflow is stale: mismatch at ${path}.`);
    }
  }
}

async function verifyGenerated(root) {
  const tree = await readTree(root);
  const manifestEntry = tree.get('manifest.json');
  if (!manifestEntry || manifestEntry.mode !== 0o644) throw new Error('Workflow manifest is missing or has invalid mode.');
  const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
  assertExactKeys(manifest, ['version', 'sourceFingerprint', 'generationHash', 'files', 'skills', 'profiles', 'operations']);
  if (manifest.version !== 1 || !isHash(manifest.sourceFingerprint) || !isHash(manifest.generationHash)) throw new Error('Workflow manifest identity is invalid.');
  if (!manifestEntry.bytes.equals(Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8'))) throw new Error('Workflow manifest bytes are not canonical.');
  const expectedSource = sha(Buffer.from(`${SOURCE_MAGIC}${canonicalJson({ files: manifest.files })}`, 'utf8'));
  if (expectedSource !== manifest.sourceFingerprint) throw new Error('Workflow source fingerprint mismatch.');
  const expectedGeneration = sha(Buffer.from(`${GENERATION_MAGIC}${canonicalJson({ ...manifest, generationHash: '' })}`, 'utf8'));
  if (expectedGeneration !== manifest.generationHash) throw new Error('Workflow generation hash mismatch.');
  const names = [...tree.keys()].filter((path) => path !== 'manifest.json').sort(compareUtf8);
  if (!Array.isArray(manifest.files) || names.length !== manifest.files.length) throw new Error('Workflow file closure mismatch.');
  for (const [index, file] of manifest.files.entries()) {
    assertExactKeys(file, ['path', 'mode', 'size', 'sha256']);
    if (file.path !== names[index]) throw new Error('Workflow file order mismatch.');
    const entry = tree.get(file.path);
    if (!entry || entry.mode !== file.mode || entry.bytes.length !== file.size || sha(entry.bytes) !== file.sha256) {
      throw new Error(`Workflow file mismatch: ${file.path}`);
    }
  }
  validateGeneratedAuthority(manifest, new Set(names));
}

function validateGeneratedAuthority(manifest, physical) {
  if (!isRecord(manifest.skills) || !isRecord(manifest.profiles) || !isRecord(manifest.operations)) throw new Error('Workflow authority inventory is invalid.');
  for (const [id, skill] of Object.entries(manifest.skills)) {
    assertExactKeys(skill, ['entry', 'metadata', 'files']);
    if (skill.entry !== `skills/${id}/SKILL.md` || skill.metadata !== `skills/${id}/agents/openai.yaml`) throw new Error(`Workflow skill binding is invalid: ${id}`);
    validateClosure(skill.files, physical, `skill ${id}`);
    if (!skill.files.includes(skill.entry) || !skill.files.includes(skill.metadata)) throw new Error(`Workflow skill closure is invalid: ${id}`);
  }
  for (const [id, path] of Object.entries(manifest.profiles)) {
    if (path !== `profiles/${id}.toml` || !physical.has(path)) throw new Error(`Workflow profile binding is invalid: ${id}`);
  }
  for (const [id, operation] of Object.entries(manifest.operations)) {
    assertExactKeys(operation, ['id', 'entry', 'sourceSkill', 'outputSchema', 'profile', 'policy', 'files']);
    if (operation.id !== id || operation.entry !== `operations/${id}/SKILL.md`
      || !(operation.sourceSkill === null || operation.sourceSkill in manifest.skills)
      || !(operation.profile in manifest.profiles) || !physical.has(operation.outputSchema)) throw new Error(`Workflow operation binding is invalid: ${id}`);
    validateClosure(operation.files, physical, `operation ${id}`);
    const expected = [operation.entry, operation.outputSchema, manifest.profiles[operation.profile],
      ...(operation.sourceSkill === null ? [] : manifest.skills[operation.sourceSkill].files)];
    if (canonicalJson(operation.files) !== canonicalJson([...new Set(expected)].sort(compareUtf8))) throw new Error(`Workflow operation closure is invalid: ${id}`);
    validateGeneratedPolicy(operation.policy, id);
  }
  if ('implementation' in manifest.operations) {
    const actualIds = Object.keys(manifest.operations).sort(compareUtf8);
    const expectedIds = Object.keys(PRODUCTION_OPERATION_BINDINGS).sort(compareUtf8);
    if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) throw new Error('Production workflow operation inventory is invalid.');
    for (const id of expectedIds) {
      const operation = manifest.operations[id];
      const [sourceSkill, outputSchema, profile] = PRODUCTION_OPERATION_BINDINGS[id];
      if (operation.sourceSkill !== sourceSkill || operation.outputSchema !== outputSchema || operation.profile !== profile) {
        throw new Error(`Production workflow operation binding is invalid: ${id}`);
      }
    }
  }
}

function validateClosure(files, physical, field) {
  if (!Array.isArray(files) || files.length === 0 || files.some((path, index) => typeof path !== 'string'
    || normalizePath(path) !== path || !physical.has(path) || (index > 0 && compareUtf8(files[index - 1], path) >= 0))) {
    throw new Error(`Workflow ${field} file closure is invalid.`);
  }
}

function validateGeneratedPolicy(policy, id) {
  assertExactKeys(policy, ['sandboxMode', 'cwdClass', 'worktreeAccess', 'writableRootClasses', 'runnerPostcondition', 'network', 'networkHosts', 'mcpTools', 'approvalCeiling', 'externalWrite']);
  if (!['read-only', 'workspace-write'].includes(policy.sandboxMode) || !['worktree', 'target-state'].includes(policy.cwdClass)
    || !['read-only', 'write'].includes(policy.worktreeAccess) || !Array.isArray(policy.writableRootClasses)
    || policy.network !== 'deny' || !Array.isArray(policy.networkHosts) || policy.networkHosts.length !== 0
    || !Array.isArray(policy.mcpTools) || policy.mcpTools.length !== 0 || policy.approvalCeiling !== 'never' || policy.externalWrite !== false) {
    throw new Error(`Workflow operation authority is invalid: ${id}`);
  }
  if (policy.sandboxMode === 'read-only'
    ? policy.worktreeAccess !== 'read-only' || policy.writableRootClasses.length !== 0 || policy.runnerPostcondition !== 'report-only'
    : policy.worktreeAccess !== 'write' || policy.writableRootClasses.length !== 1 || policy.writableRootClasses[0] !== policy.cwdClass
      || !['change-set', 'proof-only', 'spec-only'].includes(policy.runnerPostcondition)) {
    throw new Error(`Workflow operation policy is inconsistent: ${id}`);
  }
}

async function readTree(root) {
  const result = new Map();
  const visit = async (directory, prefix = '') => {
    for (const entry of await sortedEntries(directory)) {
      const path = join(directory, entry.name);
      const logical = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink generated entry rejected: ${logical}`);
      if (entry.isDirectory()) await visit(path, logical);
      else if (entry.isFile()) {
        const info = await stat(path);
        result.set(logical, { bytes: await readFile(path), mode: info.mode & 0o777 });
      } else throw new Error(`Special generated entry rejected: ${logical}`);
    }
  };
  await visit(root);
  return result;
}

async function writeEntry(root, path, entry) {
  const absolute = join(root, ...normalizePath(path).split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, entry.bytes);
  await chmod(absolute, entry.mode);
}

async function sortedEntries(root) {
  return (await readdir(root, { withFileTypes: true })).sort((left, right) => compareUtf8(left.name, right.name));
}

async function requireContainedDirectory(path, root) {
  const canonicalRoot = await realpath(root);
  const direct = await lstat(path);
  if (direct.isSymbolicLink()) throw new Error(`Source directory symlink rejected: ${path}`);
  const canonical = await realpath(path);
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error(`Source path escape: ${path}`);
  if (!(await lstat(canonical)).isDirectory()) throw new Error(`Source directory missing: ${path}`);
  return canonical;
}

async function requireContainedFile(path, root) {
  const canonicalRoot = await realpath(root);
  const direct = await lstat(path);
  if (direct.isSymbolicLink()) throw new Error(`Source file symlink rejected: ${path}`);
  const canonical = await realpath(path);
  if (canonical === canonicalRoot || !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error(`Source path escape: ${path}`);
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source file is invalid: ${path}`);
  return canonical;
}

function validateConfig(value) {
  assertExactKeys(value, ['version', 'personalSkills', 'repositorySkills', 'sharedDocs', 'profiles', 'overlayRoot', 'adaptations', 'operations']);
  if (value.version !== 1 || !Array.isArray(value.personalSkills) || !Array.isArray(value.repositorySkills)
    || !Array.isArray(value.sharedDocs) || !isRecord(value.profiles) || !isRecord(value.operations)
    || typeof value.overlayRoot !== 'string' || !Array.isArray(value.adaptations)) throw new Error('Workflow source config is invalid.');
  const expected = [
    ['resolved-codex-home', '<resolved-codex-home>', '$CODEX_ORCHESTRATOR_WORKFLOW_ROOT'],
    ['default-codex-skills', '${CODEX_HOME:-$HOME/.codex}/skills', '../../skills'],
    ['codex-home-skills', '$CODEX_HOME/skills', '../../skills'],
    ['default-codex-docs', '${CODEX_HOME:-$HOME/.codex}/docs/agents/', '../../docs/agents/'],
    ['codex-home-docs', '$CODEX_HOME/docs/agents/', '../../docs/agents/'],
  ];
  if (value.adaptations.length !== expected.length || value.adaptations.some((entry, index) => {
    assertExactKeys(entry, ['id', 'from', 'to']);
    return entry.id !== expected[index][0] || entry.from !== expected[index][1] || entry.to !== expected[index][2];
  })) throw new Error('Workflow adaptations are invalid.');
}

function assertExactKeys(value, keys) {
  if (!isRecord(value)) throw new Error('Expected object.');
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error('Object has unknown or missing keys.');
}

function normalizePath(value) {
  const path = value.normalize('NFC').replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid workflow path: ${value}`);
  return path;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('Unsupported canonical value.');
}

function compareUtf8(left, right) { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isText(path) { return /\.(?:md|json|yaml|yml|toml|mjs|txt)$/iu.test(path); }
