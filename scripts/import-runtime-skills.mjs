#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceMagic = Buffer.from('codex-orchestrator-runtime-source-v1\0', 'utf8');
const bundleMagic = Buffer.from('codex-orchestrator-runtime-bundle-v1\0', 'utf8');
const config = JSON.parse(await readFile(join(scriptRoot, 'scripts/runtime-skill-adaptations.json'), 'utf8'));

const args = parseArgs(process.argv.slice(2));
const sourceRoot = await realpath(resolve(args.sourceRoot));
const outputRoot = resolve(args.outputRoot ?? join(scriptRoot, 'runtime-skills'));
const sourceSkillsRoot = join(sourceRoot, 'skills');
const sourceDocsRoot = join(sourceRoot, 'docs/agents');

const sourceEntries = [];
const outputEntries = new Map();
const skillMetadata = {};
const transformationCounts = Object.fromEntries(config.transformations.map((name) => [name, 0]));

for (const skill of config.skills) {
  const skillRoot = await requireAllowedDirectory(join(sourceSkillsRoot, skill), sourceSkillsRoot);
  const files = await listFiles(skillRoot, { rejectAgentsDirectory: true });
  if (!files.some((path) => basename(path) === 'SKILL.md')) throw new Error(`Skill ${skill} has no SKILL.md.`);
  const logicalFiles = [];
  for (const absolute of files) {
    const relativePath = posix(relative(skillRoot, absolute));
    const targetPath = `skills/${skill}/${relativePath}`;
    const sourceBytes = await readFile(absolute);
    recordSource(sourceEntries, {
      logicalPath: targetPath,
      origin: 'working-tree',
      sourcePath: posix(relative(sourceRoot, absolute)),
      sourceRevision: null,
      mode: (await lstat(absolute)).mode & 0o777,
      bytes: sourceBytes,
    });
    const adapted = isTextPath(relativePath) ? adaptText(sourceBytes.toString('utf8'), targetPath) : sourceBytes;
    outputEntries.set(targetPath, { bytes: Buffer.isBuffer(adapted) ? adapted : Buffer.from(adapted, 'utf8'), mode: 0o644 });
    logicalFiles.push(targetPath);
  }
  logicalFiles.sort(compareUtf8);
  skillMetadata[skill] = {
    entry: `skills/${skill}/SKILL.md`,
    files: logicalFiles,
    references: logicalFiles.filter((path) => !path.endsWith('/SKILL.md')),
  };
}

const sharedDocs = await collectSharedDocs([...outputEntries.values()].map((entry) => entry.bytes.toString('utf8')));
for (const absolute of sharedDocs) {
  const relativePath = posix(relative(sourceDocsRoot, absolute));
  const targetPath = `shared/docs/agents/${relativePath}`;
  const bytes = await readFile(absolute);
  recordSource(sourceEntries, {
    logicalPath: targetPath,
    origin: 'working-tree',
    sourcePath: posix(relative(sourceRoot, absolute)),
    sourceRevision: null,
    mode: (await lstat(absolute)).mode & 0o777,
    bytes,
  });
  outputEntries.set(targetPath, { bytes: Buffer.from(adaptText(bytes.toString('utf8'), targetPath), 'utf8'), mode: 0o644 });
}

for (const helper of config.helperBlobs) {
  const { stdout } = await execFileAsync('git', ['-C', sourceRoot, 'show', `${helper.revision}:${helper.path}`], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
  const bytes = Buffer.from(stdout);
  const sha256 = sha(bytes);
  if (sha256 !== helper.sha256) throw new Error(`Git helper blob hash mismatch: ${helper.path}`);
  recordSource(sourceEntries, {
    logicalPath: `git-blobs/${helper.path}`,
    origin: 'git-blob',
    sourcePath: helper.path,
    sourceRevision: helper.revision,
    mode: 0o755,
    bytes,
  });
}

for (const tool of ['artifact-review-fingerprint.mjs', 'detect-test-command.mjs', 'review-context.mjs']) {
  const bytes = await readFile(join(scriptRoot, 'scripts/runtime-skill-tools', tool));
  outputEntries.set(`tools/${tool}`, { bytes, mode: 0o755 });
}
for (const catalog of ['codex-0.144.4.json']) {
  const bytes = await readFile(join(scriptRoot, 'scripts/runtime-skill-tool-catalogs', catalog));
  outputEntries.set(`tool-catalogs/${catalog}`, { bytes, mode: 0o644 });
}

const operations = operationSkillBodies();
for (const [path, text] of Object.entries(operations)) outputEntries.set(path, { bytes: Buffer.from(text, 'utf8'), mode: 0o644 });

outputEntries.set('schemas/node-control-envelope.schema.json', {
  mode: 0o644,
  bytes: jsonBytes({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'nodeId', 'outcome', 'artifactRefs', 'result'],
    properties: {
      version: { const: 1 },
      nodeId: { type: 'string', minLength: 1 },
      outcome: { enum: ['succeeded', 'blocked', 'route-small', 'route-spec-required', 'approved', 'needs-work', 'rejected'] },
      artifactRefs: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
      result: { type: 'object' },
    },
  }),
});

const sourceFingerprint = computeSourceFingerprint(sourceEntries);
outputEntries.set('source-snapshot.json', {
  mode: 0o644,
  bytes: jsonBytes({
    version: 1,
    sourceFingerprint,
    records: sourceEntries.sort((left, right) => compareUtf8(left.record.logicalPath, right.record.logicalPath)).map((entry) => entry.record),
  }),
});
outputEntries.set('adaptation-map.json', { mode: 0o644, bytes: jsonBytes(config) });
outputEntries.set('adaptation-report.json', {
  mode: 0o644,
  bytes: jsonBytes({
    version: 1,
    sourceFingerprint,
    importedSkills: config.skills,
    importedSourceRecords: sourceEntries.length,
    generatedOperations: Object.keys(operations).sort(compareUtf8),
    transformations: Object.entries(transformationCounts).sort(([left], [right]) => compareUtf8(left, right)).map(([id, count]) => ({ id, count })),
    rejectedAmbientDependencies: ['personal auth', 'personal config', 'plugins', 'apps', 'native agents', 'target workflow prompts'],
    approvedPlanAdaptations: config.approvedPlanAdaptations,
  }),
});
outputEntries.set('fixtures/tools/artifact-review-fingerprint.json', {
  mode: 0o644,
  bytes: jsonBytes({
    input: '---\ntitle: "Example"\nstatus: "ready"\nreview_profile: "medium"\nreview_outcome: "Approved"\n---\n\n## Goal\nDeliver the behavior.\n',
    canonical: '---\ntitle: "Example"\nreview_profile: "medium"\n---\n\n## Goal\nDeliver the behavior.\n',
    sha256: 'daca7f118fa3037036108915ac764874813b2d51074da5e92c1ff76f0bd30056'
  }),
});

validateAdaptedEntries(outputEntries);
validateRelativeReferences(outputEntries);

const graphs = buildGraphs();
const files = [...outputEntries.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([path, entry]) => ({
  path,
  mode: entry.mode,
  size: entry.bytes.length,
  sha256: sha(entry.bytes),
}));
const packageJson = JSON.parse(await readFile(join(scriptRoot, 'package.json'), 'utf8'));
const manifest = {
  version: 1,
  package: { name: 'codex-orchestrator', version: packageJson.version },
  acceptedBridgePackageHashes: config.acceptedBridgePackageHashes,
  sourceSnapshot: 'source-snapshot.json',
  sourceFingerprint,
  adaptationMap: 'adaptation-map.json',
  adaptationReport: 'adaptation-report.json',
  bundleHash: '',
  files,
  skills: sortRecord(skillMetadata),
  operations: sortRecord(graphs.operations),
  graphTemplates: sortRecord(graphs.graphTemplates),
  graphs: sortRecord(graphs.graphs),
};
manifest.bundleHash = computeBundleHash(manifest, outputEntries);

await rm(outputRoot, { recursive: true, force: true });
for (const [path, entry] of outputEntries) await writeOutput(path, entry);
await writeOutput('bundle.json', { bytes: jsonBytes(manifest), mode: 0o644 });
process.stdout.write(`${manifest.bundleHash}\n`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--source-root') parsed.sourceRoot = values[++index];
    else if (values[index] === '--output-root') parsed.outputRoot = values[++index];
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  if (!parsed.sourceRoot) throw new Error('--source-root is required.');
  return parsed;
}

async function listFiles(root, options = {}) {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) => compareUtf8(left.name, right.name))) {
    if (entry.name.startsWith('.env')) throw new Error(`Protected source path rejected: ${join(root, entry.name)}`);
    if (options.rejectAgentsDirectory && entry.name === 'agents') continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink source rejected: ${path}`);
    if (entry.isDirectory()) files.push(...await listFiles(path, options));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Non-file source rejected: ${path}`);
  }
  return files;
}

async function requireAllowedDirectory(path, allowedRoot) {
  const canonical = await realpath(path);
  const canonicalRoot = await realpath(allowedRoot);
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error(`Source path escape: ${path}`);
  if (!(await lstat(canonical)).isDirectory()) throw new Error(`Source directory missing: ${path}`);
  return canonical;
}

async function collectSharedDocs(seedTexts) {
  const queue = [];
  const queued = new Set();
  const enqueueFrom = (text, currentDirectory = sourceDocsRoot) => {
    for (const match of text.matchAll(/docs\/agents\/([A-Za-z0-9._/-]+\.md)/gu)) enqueue(join(sourceDocsRoot, match[1]));
    for (const match of text.matchAll(/\(([^)]+\.md)(?:#[^)]+)?\)/gu)) {
      const reference = match[1];
      if (reference.startsWith('http') || reference.startsWith('/')) continue;
      const candidate = resolve(currentDirectory, reference);
      if ((candidate === sourceDocsRoot || candidate.startsWith(`${sourceDocsRoot}${sep}`)) && existsSync(candidate)) enqueue(candidate);
    }
  };
  const enqueue = (path) => {
    const normalized = resolve(path);
    if (!queued.has(normalized)) { queued.add(normalized); queue.push(normalized); }
  };
  for (const text of seedTexts) enqueueFrom(text);
  const result = [];
  while (queue.length > 0) {
    const path = queue.shift();
    let canonical;
    try { canonical = await realpath(path); } catch { throw new Error(`Referenced shared policy is missing: ${path}`); }
    const canonicalRoot = await realpath(sourceDocsRoot);
    if (!canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error(`Shared policy path escape: ${path}`);
    if (!(await lstat(canonical)).isFile()) throw new Error(`Shared policy is not a file: ${path}`);
    result.push(canonical);
    enqueueFrom(await readFile(canonical, 'utf8'), dirname(canonical));
  }
  return [...new Set(result)].sort(compareUtf8);
}

function adaptText(input, logicalPath) {
  let text = input;
  const linkTargets = [];
  text = text.replace(/\]\(([^)]+)\)/gu, (_match, target) => {
    const token = `@@CODEX_ORCHESTRATOR_LINK_${linkTargets.length}@@`;
    linkTargets.push(target);
    return `](${token})`;
  });
  const replace = (pattern, replacement, id) => {
    const matches = text.match(pattern)?.length ?? 0;
    if (matches > 0) { transformationCounts[id] += matches; text = text.replace(pattern, replacement); }
  };
  replaceAllLiteral(sourceRoot, '$CODEX_ORCHESTRATOR_BUNDLE_ROOT', 'personal-root-to-bundle-root');
  replace(/\$\{CODEX_HOME:-\$HOME\/\.codex\}|\$CODEX_HOME/gu, '$CODEX_ORCHESTRATOR_BUNDLE_ROOT', 'personal-root-to-bundle-root');
  replace(/\.\.\/\.\.\/docs\/agents\//gu, '../../shared/docs/agents/', 'shared-docs-to-bundle-shared');
  replace(/\$([a-z][a-z0-9-]*)/gu, '`$1`', 'automatic-skill-markers-to-plain-names');
  replace(/reviewer_deep agents?/giu, 'independent reviewer nodes', 'native-delegation-to-runner-graph');
  replace(/sub-?agents?/giu, 'Runner-owned nodes', 'native-delegation-to-runner-graph');
  replace(/multi-agent/giu, 'multi-node', 'native-delegation-to-runner-graph');
  replace(/Agent tool/gu, 'Runner graph', 'native-delegation-to-runner-graph');
  replace(/spawn(?:ing|ed)?/giu, 'route', 'native-delegation-to-runner-graph');
  replace(/delegat(?:e|ed|es|ing|ion)(?!-integrate\.md)/giu, 'Runner-route', 'native-delegation-to-runner-graph');
  replace(/git commit/giu, 'Runner checkpoint request', 'publication-and-commit-ownership-to-runner');
  replace(/git push/giu, 'Runner publication request', 'publication-and-commit-ownership-to-runner');
  replace(/review_context\.py/gu, 'review-context.mjs', 'python-helper-references-to-node-tools');
  replace(/detect_test_command\.py/gu, 'detect-test-command.mjs', 'python-helper-references-to-node-tools');
  replace(/artifact_review_fingerprint\.py/gu, 'artifact-review-fingerprint.mjs', 'python-helper-references-to-node-tools');
  if (logicalPath.startsWith('skills/') && logicalPath.endsWith('/SKILL.md')) {
    const marker = '\n## Package Runtime Authority\n\nThis node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.\n';
    const frontmatterEnd = text.startsWith('---\n') ? text.indexOf('\n---\n', 4) : -1;
    text = frontmatterEnd >= 0
      ? `${text.slice(0, frontmatterEnd + 5)}${marker}${text.slice(frontmatterEnd + 5)}`
      : `${marker}\n${text}`;
    transformationCounts['publication-and-commit-ownership-to-runner'] += 1;
  }
  return text.replace(/@@CODEX_ORCHESTRATOR_LINK_(\d+)@@/gu, (_match, index) => linkTargets[Number(index)]);

  function replaceAllLiteral(value, replacement, id) {
    const count = text.split(value).length - 1;
    if (count > 0) { transformationCounts[id] += count; text = text.split(value).join(replacement); }
  }
}

function validateRelativeReferences(entries) {
  for (const [path, entry] of entries) {
    if (!path.endsWith('/SKILL.md')) continue;
    const text = entry.bytes.toString('utf8');
    const references = [
      ...[...text.matchAll(/\]\(([^)#]+\.(?:md|mjs))(?:#[^)]+)?\)/giu)].map((match) => match[1]),
      ...[...text.matchAll(/`((?:\.{1,2}\/|references\/)[^`#]+\.(?:md|mjs))(?:#[^`]+)?`/giu)].map((match) => match[1]),
    ];
    for (const reference of references) {
      if (/^[a-z]+:/iu.test(reference) || reference.startsWith('/')) continue;
      if (!reference.includes('references/') && !reference.startsWith('./') && !reference.startsWith('../')) continue;
      const resolved = normalizePath(posix(join(dirname(path), reference)));
      if (!entries.has(resolved)) throw new Error(`Unresolved packaged reference in ${path}: ${reference}`);
    }
  }
}

function recordSource(entries, input) {
  entries.push({
    record: {
      logicalPath: normalizePath(input.logicalPath), origin: input.origin, sourcePath: normalizePath(input.sourcePath),
      sourceRevision: input.sourceRevision, mode: input.mode, size: input.bytes.length, sha256: sha(input.bytes),
    },
    bytes: input.bytes,
  });
}

function computeSourceFingerprint(entries) {
  const hash = createHash('sha256').update(sourceMagic);
  for (const entry of [...entries].sort((left, right) => compareUtf8(left.record.logicalPath, right.record.logicalPath))) {
    const recordBytes = Buffer.from(canonicalJson(entry.record), 'utf8');
    hash.update(uint32(recordBytes.length)).update(recordBytes).update(uint64(entry.bytes.length)).update(entry.bytes);
  }
  return hash.digest('hex');
}

function computeBundleHash(manifest, entries) {
  const hash = createHash('sha256').update(bundleMagic);
  const manifestBytes = Buffer.from(canonicalJson({ ...manifest, bundleHash: '' }), 'utf8');
  hash.update(uint32(manifestBytes.length)).update(manifestBytes);
  for (const file of manifest.files) {
    const entry = entries.get(file.path);
    const pathBytes = Buffer.from(file.path, 'utf8');
    hash.update(uint32(pathBytes.length)).update(pathBytes).update(uint32(file.mode)).update(uint64(file.size)).update(entry.bytes);
  }
  return hash.digest('hex');
}

function validateAdaptedEntries(entries) {
  for (const [path, entry] of entries) {
    normalizePath(path);
    if (!isTextPath(path)) continue;
    const text = entry.bytes.toString('utf8');
    if (text.includes(sourceRoot)) throw new Error(`Personal absolute path remained in ${path}.`);
    if (/\$(?!schema\b)[a-z][a-z0-9-]*/u.test(text)) throw new Error(`Automatic skill marker remained in ${path}.`);
    if (/spawn_agent|send_input|close_agent|subagent/iu.test(text)) throw new Error(`Native delegation marker remained in ${path}.`);
    if (/\bgit\s+(?:commit|push)\b/iu.test(text)) throw new Error(`Direct Git publication command remained in ${path}.`);
  }
}

function operationSkillBodies() {
  const body = (name, purpose, outcomes) => `---\nname: ${name}\ndescription: Package-owned operation node.\n---\n\n# ${name}\n\n${purpose}\n\nRead only the Runner-owned context JSON path supplied in the static turn. Never mutate GitHub or select another skill. Return one strict NodeControlEnvelopeV1 for nodeId from context with one of these outcomes: ${outcomes.join(', ')}.\n`;
  return {
    'operations/acceptance-proof/SKILL.md': body('acceptance-proof', 'Evaluate the supplied acceptance criteria and proof evidence without changing product code.', ['succeeded', 'blocked']),
    'operations/completion-report-repair/SKILL.md': body('completion-report-repair', 'Repair only the supplied completion report artifact while preserving implementation status.', ['succeeded', 'blocked']),
    'operations/fresh-context-review/SKILL.md': body('fresh-context-review', 'Review the supplied settled diff and evidence from a fresh context.', ['approved', 'needs-work', 'rejected']),
    'operations/proof-evidence-repair/SKILL.md': body('proof-evidence-repair', 'Repair only the supplied proof evidence artifact.', ['succeeded', 'blocked']),
    'operations/scoped-classification/SKILL.md': body('scoped-classification', 'Classify the implementation as small or spec-required without editing the worktree.', ['route-small', 'route-spec-required', 'blocked']),
    'operations/final-aggregation/SKILL.md': body('final-aggregation', 'Aggregate persisted node artifacts and review verdicts without performing new implementation.', ['approved', 'needs-work', 'rejected']),
  };
}

function buildGraphs() {
  const read = policy('read-only');
  const write = policy('write');
  const node = (id, skill, successors = [], executionPolicy = read, additionalSkills = []) => ({
    id, skill, additionalSkills, contextArtifactKinds: ['runner-context'], resultSchema: 'schemas/node-control-envelope.schema.json', successors, executionPolicy,
  });
  const edge = (when, target) => ({ when, node: target });
  const directGraph = (id, skill, terminal = 'succeeded') => ({ id, entryNode: id, nodes: [node(id, skill, terminal ? [] : [])] });
  const graphs = {
    'acceptance-proof': directGraph('acceptance-proof', 'operations/acceptance-proof/SKILL.md'),
    'completion-report-repair': directGraph('completion-report-repair', 'operations/completion-report-repair/SKILL.md'),
    'fresh-context-review': directGraph('fresh-context-review', 'operations/fresh-context-review/SKILL.md'),
    'proof-evidence-repair': directGraph('proof-evidence-repair', 'operations/proof-evidence-repair/SKILL.md'),
    'plan-parent': {
      id: 'plan-parent', entryNode: 'to-spec', nodes: [
        node('to-spec', 'to-spec', [edge('succeeded', 'to-tickets')]),
        node('to-tickets', 'to-tickets', [edge('succeeded', 'tickets-breakdown-review')]),
        node('tickets-breakdown-review', 'tickets-breakdown-review', [edge('approved', 'triage'), edge('needs-work', 'to-tickets')]),
        node('triage', 'triage'),
      ],
    },
    'implementation-attempt': {
      id: 'implementation-attempt', entryNode: 'scoped-classification', nodes: [
        node('scoped-classification', 'operations/scoped-classification/SKILL.md', [edge('route-small', 'small-task-implementer'), edge('route-spec-required', 'implementation-spec-maker')]),
        node('small-task-implementer', 'small-task-implementer', [edge('succeeded', 'cleanup-review')], write, ['tdd']),
        node('implementation-spec-maker', 'implementation-spec-maker', [edge('succeeded', 'implementation-spec-review')]),
        node('implementation-spec-review', 'implementation-spec-review', [edge('approved', 'spec-implementer'), edge('needs-work', 'implementation-spec-maker')]),
        node('spec-implementer', 'spec-implementer', [edge('succeeded', 'cleanup-review')], write, ['tdd']),
        node('cleanup-review', 'cleanup-review', [edge('approved', 'code-review'), edge('needs-work', 'spec-implementer')]),
        node('code-review', 'code-review', [edge('approved', 'final-aggregation'), edge('needs-work', 'spec-implementer')]),
        node('final-aggregation', 'operations/final-aggregation/SKILL.md'),
      ],
    },
  };
  for (const graph of Object.values(graphs)) graph.nodes.sort((left, right) => compareUtf8(left.id, right.id));
  return {
    operations: Object.fromEntries(Object.keys(graphs).sort(compareUtf8).map((id) => [id, { graph: id, entryNode: graphs[id].entryNode }])),
    graphTemplates: {
      'artifact-review-high': { id: 'artifact-review-high', kind: 'artifact-review', profile: 'high', maximumReviews: 6, requiredFreshReviewers: 3, expansionGraph: 'implementation-attempt' },
      'artifact-review-medium': { id: 'artifact-review-medium', kind: 'artifact-review', profile: 'medium', maximumReviews: 4, requiredFreshReviewers: 1, expansionGraph: 'implementation-attempt' },
      'artifact-review-simple': { id: 'artifact-review-simple', kind: 'artifact-review', profile: 'simple', maximumReviews: 3, requiredFreshReviewers: 1, expansionGraph: 'implementation-attempt' },
      'checkpoint-review': { id: 'checkpoint-review', kind: 'checkpoint-review', profile: null, maximumReviews: 2, requiredFreshReviewers: 1, expansionGraph: 'implementation-attempt' },
      'cleanup-review': { id: 'cleanup-review', kind: 'cleanup-review', profile: null, maximumReviews: 1, requiredFreshReviewers: 1, expansionGraph: 'implementation-attempt' },
      'code-review': { id: 'code-review', kind: 'code-review', profile: 'high', maximumReviews: 6, requiredFreshReviewers: 3, expansionGraph: 'implementation-attempt' },
      'tickets-breakdown-review': { id: 'tickets-breakdown-review', kind: 'tickets-breakdown-review', profile: null, maximumReviews: 1, requiredFreshReviewers: 1, expansionGraph: 'plan-parent' },
    },
    graphs,
  };
}

function policy(access) {
  const writable = access === 'write';
  return {
    worktreeAccess: access,
    sandboxMode: writable ? 'workspace-write' : 'read-only',
    writableRootClasses: writable ? ['target-state', 'worktree'] : ['target-state'],
    network: 'deny', networkHosts: [], mcpTools: [], approvalCeiling: 'never', externalWrite: false,
    model: null, effort: null, timeoutMs: 1_800_000, idleTimeoutMs: 300_000,
  };
}

async function writeOutput(path, entry) {
  const absolute = join(outputRoot, ...normalizePath(path).split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, entry.bytes);
  await chmod(absolute, entry.mode);
}

function sortRecord(record) { return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareUtf8(left, right))); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isTextPath(path) { return /\.(?:md|mdx|json|yaml|yml|txt|mjs)$/iu.test(path); }
function posix(path) { return path.split(sep).join('/'); }
function normalizePath(path) {
  const normalized = posix(path.normalize('NFC'));
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid manifest path: ${path}`);
  return normalized;
}
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function uint32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function uint64(value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes; }
function compareUtf8(left, right) { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
