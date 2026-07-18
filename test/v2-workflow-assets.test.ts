import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  loadPackageWorkflow,
  materializeWorkflowGeneration,
  verifyWorkflowGeneration,
} from '../src/v2/workflow-assets.js';

const packageRoot = join(import.meta.dirname, '..', '..');

test('workflow generation materializes one immutable concurrent winner and survives package source mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-'));
  const copiedPackage = join(root, 'package');
  const runtimeRoot = join(root, 'runtime');
  await cp(join(packageRoot, 'internal-workflow'), join(copiedPackage, 'internal-workflow'), { recursive: true });
  await cp(join(packageRoot, 'package.json'), join(copiedPackage, 'package.json'));

  const loaded = await loadPackageWorkflow(copiedPackage);
  const [left, right] = await Promise.all([
    materializeWorkflowGeneration({ packageRoot: copiedPackage, runtimeRoot, packageVersion: '2.0.1', bootId: 'boot-a' }),
    materializeWorkflowGeneration({ packageRoot: copiedPackage, runtimeRoot, packageVersion: '2.0.1', bootId: 'boot-a' }),
  ]);
  assert.equal(left.generationHash, loaded.manifest.generationHash);
  assert.equal(right.generationHash, left.generationHash);
  assert.equal(left.generationRoot, right.generationRoot);
  await verifyWorkflowGeneration(left);

  const sourceSkill = join(copiedPackage, 'internal-workflow', 'skills', 'agent-auto', 'SKILL.md');
  await chmod(sourceSkill, 0o644);
  await writeFile(sourceSkill, '# changed package source\n');
  await verifyWorkflowGeneration(left);
  assert.match(await readFile(join(left.generationRoot, 'skills', 'agent-auto', 'SKILL.md'), 'utf8'), /Implement/u);
});

test('workflow V2 exposes current operation dependencies and keeps evals out of attempt closures', async () => {
  const loaded = await loadPackageWorkflow(packageRoot);
  assert.equal(loaded.manifest.version, 2);
  if (loaded.manifest.version !== 2) return;
  assert.deepEqual(Object.keys(loaded.manifest.operations).sort(), [
    'acceptance-proof', 'ambiguity-review', 'code-review', 'implementation', 'spec-author', 'spec-review', 'triage',
  ]);
  assert.deepEqual(loaded.manifest.operations.implementation.dependencySkills, [
    'code-debugger', 'diagnosing-bugs', 'small-task-implementer', 'tdd',
  ]);
  assert.equal(loaded.manifest.operations.implementation.files.includes('skills/tdd/SKILL.md'), true);
  assert.equal(loaded.manifest.operations.implementation.files.some((path) => path.includes('/evals/')), false);
  assert.equal(Object.keys(loaded.manifest.evals).length >= 2, true);
});

test('workflow loader and generation preserve pinned V1 compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-v1-'));
  const packageV1 = join(root, 'package');
  await writeV1Package(packageV1);
  const loaded = await loadPackageWorkflow(packageV1);
  assert.equal(loaded.manifest.version, 1);
  const receipt = await materializeWorkflowGeneration({
    packageRoot: packageV1,
    runtimeRoot: join(root, 'runtime'),
    packageVersion: '2.0.2',
    bootId: 'v1-resume',
  });
  await verifyWorkflowGeneration(receipt);
});

test('workflow loader and generation verifier fail closed on tamper and invalid ready receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-negative-'));
  const runtimeRoot = join(root, 'runtime');
  const receipt = await materializeWorkflowGeneration({ packageRoot, runtimeRoot, packageVersion: '2.0.1', bootId: 'boot-a' });
  const path = join(receipt.generationRoot, 'operations', 'triage', 'SKILL.md');
  await chmod(path, 0o644);
  await writeFile(path, '# tampered\n');
  await chmod(path, 0o444);
  await assert.rejects(verifyWorkflowGeneration(receipt), /mismatch|drift|hash/iu);
});

test('workflow loader rejects a canonically rehashed manifest that widens operation authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-policy-'));
  const copiedPackage = join(root, 'package');
  await cp(join(packageRoot, 'internal-workflow'), join(copiedPackage, 'internal-workflow'), { recursive: true });
  const path = join(copiedPackage, 'internal-workflow', 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
  manifest.operations.implementation.policy.mcpTools = ['github'];
  manifest.generationHash = '';
  manifest.generationHash = createHash('sha256')
    .update(Buffer.from(`codex-orchestrator-workflow-generation-v1\0${canonicalJson(manifest)}`))
    .digest('hex');
  await writeFile(path, `${canonicalJson(manifest)}\n`);
  await assert.rejects(loadPackageWorkflow(copiedPackage), /authority/iu);
});

test('workflow loader rejects canonically rehashed V2 bytes whose adapter omits a declared dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-link-'));
  const copiedPackage = join(root, 'package');
  const workflowRoot = join(copiedPackage, 'internal-workflow');
  await cp(join(packageRoot, 'internal-workflow'), workflowRoot, { recursive: true });
  const manifestPath = join(workflowRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, any>;
  const operationPath = 'operations/implementation/SKILL.md';
  const absoluteOperationPath = join(workflowRoot, ...operationPath.split('/'));
  const operationBytes = Buffer.from((await readFile(absoluteOperationPath, 'utf8'))
    .replace('[TDD](../../skills/tdd/SKILL.md)', 'TDD'));
  await writeFile(absoluteOperationPath, operationBytes);
  rehashV2File(manifest, operationPath, operationBytes);
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);

  await assert.rejects(loadPackageWorkflow(copiedPackage), /does not reference declared dependency tdd/iu);
});

test('workflow loader binds exact operation mappings and canonical manifest bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-binding-'));
  const copiedPackage = join(root, 'package');
  await cp(join(packageRoot, 'internal-workflow'), join(copiedPackage, 'internal-workflow'), { recursive: true });
  const path = join(copiedPackage, 'internal-workflow', 'manifest.json');
  const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;

  const rebound = structuredClone(original);
  rebound.operations.implementation.profile = 'proof_agent';
  rebound.operations.implementation.files = rebound.operations.implementation.files
    .filter((entry: string) => entry !== 'profiles/implementer_standard.toml')
    .concat('profiles/proof_agent.toml')
    .sort();
  rehash(rebound);
  await writeFile(path, `${canonicalJson(rebound)}\n`);
  await assert.rejects(loadPackageWorkflow(copiedPackage), /binding/iu);

  await writeFile(path, `${JSON.stringify(original, null, 2)}\n`);
  await assert.rejects(loadPackageWorkflow(copiedPackage), /canonical/iu);
});

test('workflow generation converges after publisher process death at every ready boundary', { timeout: 180_000 }, async () => {
  const modulePath = join(packageRoot, 'dist', 'src', 'v2', 'workflow-assets.js');
  for (const step of [
    'before-claim-link', 'after-claim-link', 'after-content-mkdir', 'after-first-content-file',
    'before-content-parent-sync', 'after-content-parent-sync', 'before-ready-link',
    'after-ready-link', 'after-ready-parent-sync',
  ]) {
    const root = await mkdtemp(join(tmpdir(), `workflow-assets-kill-${step}-`));
    const runtimeRoot = join(root, 'runtime');
    const script = `
      import { materializeWorkflowGeneration } from ${JSON.stringify(new URL(`file://${modulePath}`).href)};
      await materializeWorkflowGeneration({
        packageRoot: ${JSON.stringify(packageRoot)}, runtimeRoot: ${JSON.stringify(runtimeRoot)},
        packageVersion: '2.0.1', bootId: 'killed-child',
        onStep(value) { if (value === ${JSON.stringify(step)}) process.kill(process.pid, 'SIGKILL'); }
      });
    `;
    const killed = await spawnResult(process.execPath, ['--input-type=module', '--eval', script]);
    assert.equal(killed.signal, 'SIGKILL', step);
    const receipt = await materializeWorkflowGeneration({ packageRoot, runtimeRoot, packageVersion: '2.0.1', bootId: 'recovery-parent' });
    await verifyWorkflowGeneration(receipt);
  }
});

test('workflow ready reuse validates its claim chain and an in-process sealed failure can retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-ready-chain-'));
  const runtimeRoot = join(root, 'runtime');
  const receipt = await materializeWorkflowGeneration({ packageRoot, runtimeRoot, packageVersion: '2.0.1', bootId: 'boot-a' });
  const claim = join(runtimeRoot, 'workflow-generations', `${receipt.generationHash}.claim`);
  await writeFile(claim, '{"invalid":true}\n');
  await assert.rejects(materializeWorkflowGeneration({
    packageRoot, runtimeRoot, packageVersion: '2.0.1', bootId: 'boot-a',
  }), /owner|recovery|unknown|missing/iu);

  const retryRoot = join(root, 'retry-runtime');
  await assert.rejects(materializeWorkflowGeneration({
    packageRoot, runtimeRoot: retryRoot, packageVersion: '2.0.1', bootId: 'boot-a',
    onStep(step) { if (step === 'before-ready-link') throw new Error('injected-before-ready'); },
  }), /injected-before-ready/iu);
  await verifyWorkflowGeneration(await materializeWorkflowGeneration({
    packageRoot, runtimeRoot: retryRoot, packageVersion: '2.0.1', bootId: 'boot-a',
  }));
});

test('workflow loader and publisher reject symlinked authority roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-symlink-'));
  const linkedPackage = join(root, 'package');
  await mkdir(linkedPackage);
  await symlink(join(packageRoot, 'internal-workflow'), join(linkedPackage, 'internal-workflow'), 'dir');
  await assert.rejects(loadPackageWorkflow(linkedPackage), /root is unsafe/iu);

  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'runtime'), 'dir');
  await assert.rejects(materializeWorkflowGeneration({
    packageRoot, runtimeRoot: join(root, 'runtime'), packageVersion: '2.0.1', bootId: 'boot-a',
  }), /root is unsafe/iu);

  const nestedOutside = join(root, 'nested-outside');
  await mkdir(nestedOutside);
  await symlink(nestedOutside, join(root, 'linked-parent'), 'dir');
  await assert.rejects(materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: join(root, 'linked-parent', 'runtime'),
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  }), /root is unsafe/iu);
  await assert.rejects(lstat(join(nestedOutside, 'runtime')), { code: 'ENOENT' });
});

async function spawnResult(file: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(file, args, { stdio: 'ignore' });
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

function rehash(manifest: Record<string, any>): void {
  manifest.generationHash = '';
  manifest.generationHash = createHash('sha256')
    .update(Buffer.from(`codex-orchestrator-workflow-generation-v1\0${canonicalJson(manifest)}`))
    .digest('hex');
}

function rehashV2File(manifest: Record<string, any>, path: string, bytes: Buffer): void {
  const file = manifest.files.find((entry: Record<string, unknown>) => entry.path === path);
  if (!file) throw new Error(`Missing fixture manifest file: ${path}`);
  file.size = bytes.length;
  file.sha256 = createHash('sha256').update(bytes).digest('hex');
  manifest.sourceFingerprint = createHash('sha256')
    .update(Buffer.from(`codex-orchestrator-workflow-source-v2\0${canonicalJson({ files: manifest.files })}`)).digest('hex');
  manifest.generationHash = '';
  manifest.generationHash = createHash('sha256')
    .update(Buffer.from(`codex-orchestrator-workflow-generation-v2\0${canonicalJson(manifest)}`)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('unsupported fixture value');
}

async function writeV1Package(root: string): Promise<void> {
  const workflowRoot = join(root, 'internal-workflow');
  const skills = [
    'acceptance-proof', 'agent-auto', 'cleanup-review', 'code-review', 'codebase-design', 'diagnosing-bugs',
    'implementation-spec-maker', 'implementation-spec-review', 'research', 'small-task-implementer',
    'spec-implementer', 'tdd', 'triage', 'ui-evidence-proof',
  ];
  const profiles = [
    'analyst_deep', 'implementer_deep', 'implementer_standard', 'proof_agent', 'researcher_standard',
    'reviewer_deep', 'reviewer_fast', 'reviewer_standard',
  ];
  const bindings: Record<string, [string | null, string, string]> = {
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
  const bytes = new Map<string, Buffer>();
  const skillInventory: Record<string, { entry: string; metadata: string; files: string[] }> = {};
  for (const skill of skills) {
    const entry = `skills/${skill}/SKILL.md`;
    const metadata = `skills/${skill}/agents/openai.yaml`;
    bytes.set(entry, Buffer.from(`# ${skill}\n`));
    bytes.set(metadata, Buffer.from(`interface:\n  display_name: ${skill}\n`));
    skillInventory[skill] = { entry, metadata, files: [metadata, entry].sort() };
  }
  const profileInventory: Record<string, string> = {};
  for (const profile of profiles) {
    const path = `profiles/${profile}.toml`;
    bytes.set(path, Buffer.from(`name = "${profile}"\nsandbox_mode = "${profile.startsWith('implementer') || profile === 'proof_agent' ? 'workspace-write' : 'read-only'}"\n`));
    profileInventory[profile] = path;
  }
  const operations: Record<string, any> = {};
  for (const [id, [sourceSkill, outputSchema, profile]] of Object.entries(bindings)) {
    const entry = `operations/${id}/SKILL.md`;
    bytes.set(entry, Buffer.from(`# ${id}\n`));
    if (!bytes.has(outputSchema)) bytes.set(outputSchema, Buffer.from('{}\n'));
    const files = [entry, outputSchema, profileInventory[profile]!, ...(sourceSkill ? skillInventory[sourceSkill]!.files : [])]
      .sort();
    operations[id] = { id, entry, sourceSkill, outputSchema, profile, policy: v1Policy(id), files };
  }
  const files = [...bytes.entries()].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([path, content]) => ({ path, mode: 0o644, size: content.length, sha256: createHash('sha256').update(content).digest('hex') }));
  const manifest: Record<string, any> = {
    version: 1,
    sourceFingerprint: createHash('sha256')
      .update(Buffer.from(`codex-orchestrator-workflow-source-v1\0${canonicalJson({ files })}`)).digest('hex'),
    generationHash: '', files, skills: skillInventory, profiles: profileInventory, operations,
  };
  manifest.generationHash = createHash('sha256')
    .update(Buffer.from(`codex-orchestrator-workflow-generation-v1\0${canonicalJson(manifest)}`)).digest('hex');
  for (const [path, content] of bytes) {
    const absolute = join(workflowRoot, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  await writeFile(join(workflowRoot, 'manifest.json'), `${canonicalJson(manifest)}\n`);
}

function v1Policy(id: string): Record<string, unknown> {
  const write = id === 'implementation' || id === 'spec-implementation' || id === 'acceptance-proof' || id === 'spec-author';
  const cwdClass = id === 'spec-author' ? 'target-state' : 'worktree';
  return {
    sandboxMode: write ? 'workspace-write' : 'read-only',
    cwdClass,
    worktreeAccess: write ? 'write' : 'read-only',
    writableRootClasses: write ? [cwdClass] : [],
    runnerPostcondition: id === 'acceptance-proof' ? 'proof-only' : id === 'spec-author' ? 'spec-only' : write ? 'change-set' : 'report-only',
    network: 'deny', networkHosts: [], mcpTools: [], approvalCeiling: 'never', externalWrite: false,
  };
}
