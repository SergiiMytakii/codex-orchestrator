import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  extractContainedWorkflowReferences,
  loadPackageWorkflow,
  materializeWorkflowGeneration,
  verifyWorkflowGeneration,
} from '../src/v2/workflow-assets.js';

const packageRoot = join(import.meta.dirname, '..', '..');

test('workflow reference extraction recognizes supported forms and rejects root escape', () => {
  const source = 'skills/alpha/SKILL.md';
  assert.deepEqual(extractContainedWorkflowReferences(source, [
    '[markdown](../../docs/agents/markdown.md#details)',
    '[angle](<../../docs/agents/angle.md#details> "Angle title")',
    '[titled](../../docs/agents/titled.md#details "../../docs/agents/title-is-not-a-destination.md")',
    '[fragment only](#details "Local section")',
    'Apply `../../docs/agents/inline.md`.',
    'Use `$CODEX_ORCHESTRATOR_WORKFLOW_ROOT/docs/agents/root.md`.',
    '[external](https://example.invalid/external.md)',
    '```md',
    '`../../../ignored-fenced.md`',
    '```',
  ].join('\n')), [
    'docs/agents/angle.md',
    'docs/agents/inline.md',
    'docs/agents/markdown.md',
    'docs/agents/root.md',
    'docs/agents/titled.md',
  ]);
  assert.throws(
    () => extractContainedWorkflowReferences(source, '`../../../outside.md`'),
    /escapes root/iu,
  );
  assert.throws(
    () => extractContainedWorkflowReferences(source, '$CODEX_ORCHESTRATOR_WORKFLOW_ROOT/../outside.md'),
    /escapes root/iu,
  );
});

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

  const sourceSkill = join(copiedPackage, 'internal-workflow', 'skills', 'implement', 'SKILL.md');
  await chmod(sourceSkill, 0o644);
  await writeFile(sourceSkill, '# changed package source\n');
  await verifyWorkflowGeneration(left);
  assert.match(await readFile(join(left.generationRoot, 'skills', 'implement', 'SKILL.md'), 'utf8'), /Implement/u);
});

test('workflow V2 binds the minimal coding flow and keeps static scenarios out of attempt closures', async () => {
  const loaded = await loadPackageWorkflow(packageRoot);
  assert.equal(loaded.manifest.version, 2);
  if (loaded.manifest.version !== 2) return;
  assert.deepEqual(Object.keys(loaded.manifest.operations).sort(), [
    'acceptance-proof', 'code-review', 'implementation', 'spec-author', 'spec-review', 'triage',
  ]);
  assert.deepEqual(loaded.manifest.operations.implementation.dependencySkills, [
    'diagnosing-bugs', 'tdd',
  ]);
  assert.equal(loaded.manifest.operations.implementation.sourceSkill, 'implement');
  for (const path of [
    'docs/agents/bug-workflow-routing.md',
    'docs/agents/bugfix-quality-gate.md',
    'docs/agents/confidence-rubric.md',
  ]) assert.equal(loaded.manifest.operations.implementation.files.includes(path), true, path);
  assert.equal(loaded.manifest.operations.triage.sourceSkill, 'plan');
  assert.deepEqual(loaded.manifest.skills['bug-root-cause-explainer'].dependencySkills, ['diagnosing-bugs']);
  for (const path of [
    'docs/agents/bug-workflow-routing.md',
    'docs/agents/bugfix-quality-gate.md',
    'docs/agents/confidence-rubric.md',
  ]) assert.equal(loaded.manifest.operations.triage.files.includes(path), true, path);
  for (const path of [
    'docs/agents/tool-usage.md',
    'skills/diagnosing-bugs/SKILL.md',
  ]) assert.equal(loaded.manifest.operations.triage.files.includes(path), true, path);
  assert.equal(loaded.manifest.operations['code-review'].sourceSkill, 'code-review');
  assert.equal(loaded.manifest.operations.implementation.files.includes('skills/tdd/SKILL.md'), true);
  assert.equal(loaded.manifest.operations.implementation.files.some((path) => path.includes('/evals/')), false);
  assert.deepEqual(Object.keys(loaded.manifest.profiles).sort(), [
    'explorer', 'implementer', 'spec_reviewer', 'standards_reviewer',
  ]);
});

test('workflow loader accepts all skill and resource binding reference forms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-reference-bindings-'));
  const copiedPackage = join(root, 'package');
  await cp(join(packageRoot, 'internal-workflow'), join(copiedPackage, 'internal-workflow'), { recursive: true });
  const manifestPath = join(copiedPackage, 'internal-workflow', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, any>;
  const operationPath = 'operations/implementation/SKILL.md';
  const operationBytes = Buffer.from([
    '# Implementation operation fixture',
    '',
    'Use `$implement`.',
    'Use [TDD](<../../skills/tdd/SKILL.md#fit> "TDD title").',
    'Use `../../skills/diagnosing-bugs/SKILL.md#workflow`.',
    'Apply `$CODEX_ORCHESTRATOR_WORKFLOW_ROOT/docs/agents/bug-workflow-routing.md#fixes`.',
    'Apply [coding routing](<../../docs/agents/coding-skill-routing.md#flow> "Routing title").',
    'Apply `../../docs/agents/tool-usage.md#tools`.',
    '',
  ].join('\n'));
  await writeFile(join(copiedPackage, 'internal-workflow', ...operationPath.split('/')), operationBytes);
  rehashV2File(manifest, operationPath, operationBytes);
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);

  const loaded = await loadPackageWorkflow(copiedPackage);
  assert.equal(loaded.manifest.operations.implementation.files.includes('skills/tdd/SKILL.md'), true);
});

test('workflow packages only static target scenarios with no live execution metadata', async () => {
  const loaded = await loadPackageWorkflow(packageRoot);
  assert.equal('shared/coding-skill-evals' in loaded.manifest.evals, false);
  assert.deepEqual(Object.keys(loaded.manifest.evals).sort(), [
    'skill/bug-root-cause-explainer',
    'skill/implement',
    'skill/plan',
    'skill/tdd',
    'skill/tickets-orchestrator',
    'skill/to-tickets',
  ]);
  for (const entry of Object.values(loaded.manifest.evals)) {
    const value = JSON.parse(await readFile(join(packageRoot, 'internal-workflow', ...entry.path.split('/')), 'utf8')) as {
      cases: Array<Record<string, unknown>>;
    };
    for (const item of value.cases) {
      assert.equal(Object.keys(item).every((key) => ['expected', 'forbidden', 'id', 'prompt'].includes(key)), true);
      assert.equal(['expected', 'id', 'prompt'].every((key) => key in item), true);
    }
  }
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

test('workflow loader rejects canonically rehashed production closures missing bug workflow documents', async () => {
  const affected = {
    implementation: [
      'docs/agents/bug-workflow-routing.md',
      'docs/agents/bugfix-quality-gate.md',
      'docs/agents/confidence-rubric.md',
    ],
    triage: [
      'docs/agents/bug-workflow-routing.md',
      'docs/agents/bugfix-quality-gate.md',
      'docs/agents/confidence-rubric.md',
    ],
  } as const;
  for (const [operation, paths] of Object.entries(affected)) {
    for (const missing of paths) {
      const root = await mkdtemp(join(tmpdir(), `workflow-assets-${operation}-closure-`));
      const copiedPackage = join(root, 'package');
      const workflowRoot = join(copiedPackage, 'internal-workflow');
      await cp(join(packageRoot, 'internal-workflow'), workflowRoot, { recursive: true });
      await loadPackageWorkflow(copiedPackage);
      const manifestPath = join(workflowRoot, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, any>;
      manifest.operations[operation].files = manifest.operations[operation].files
        .filter((path: string) => path !== missing);
      rehashV2Manifest(manifest);
      await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);

      await assert.rejects(
        loadPackageWorkflow(copiedPackage),
        new RegExp(`workflow operation closure is invalid: ${operation}`, 'iu'),
        `${operation}: ${missing}`,
      );
    }
  }
});

test('workflow loader binds exact operation mappings and canonical manifest bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-assets-binding-'));
  const copiedPackage = join(root, 'package');
  await cp(join(packageRoot, 'internal-workflow'), join(copiedPackage, 'internal-workflow'), { recursive: true });
  const path = join(copiedPackage, 'internal-workflow', 'manifest.json');
  const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;

  const rebound = structuredClone(original);
  rebound.operations.implementation.profile = 'standards_reviewer';
  rebound.operations.implementation.files = rebound.operations.implementation.files
    .filter((entry: string) => entry !== 'profiles/implementer.toml')
    .concat('profiles/standards_reviewer.toml')
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
  rehashV2Manifest(manifest);
}

function rehashV2Manifest(manifest: Record<string, any>): void {
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
