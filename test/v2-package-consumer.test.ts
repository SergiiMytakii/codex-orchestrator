import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);

test('packed install uses one package-owned workflow with empty or conflicting consumer skill state', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-consumer-'));
  try {
    const packDir = join(root, 'pack');
    const consumer = join(root, 'consumer');
    const consumerConfig = join(consumer, '.codex-orchestrator', 'config.json');
    const consumerState = join(consumer, '.codex-orchestrator', 'state', 'sentinel.json');
    const localPlanSkill = join(consumer, '.codex', 'skills', 'plan', 'SKILL.md');
    const localImplementSkill = join(consumer, '.codex', 'skills', 'implement', 'SKILL.md');
    const localReviewSkill = join(consumer, '.codex', 'skills', 'code-review', 'SKILL.md');
    const consumerGitHubMarker = join(consumer, '.github-state-marker.json');
    await Promise.all([
      mkdir(packDir, { recursive: true }),
      mkdir(dirname(consumerConfig), { recursive: true }),
      mkdir(dirname(consumerState), { recursive: true }),
      mkdir(dirname(localPlanSkill), { recursive: true }),
      mkdir(dirname(localImplementSkill), { recursive: true }),
      mkdir(dirname(localReviewSkill), { recursive: true }),
    ]);

    const consumerPackage = {
      name: 'v2-consumer-fixture',
      private: true,
      version: '1.0.0',
      scripts: { preserve: 'printf preserved' },
      dependencies: { 'playwright-core': `file:${join(process.cwd(), 'node_modules', 'playwright-core')}` },
    };
    await writeFile(join(consumer, 'package.json'), `${JSON.stringify(consumerPackage, null, 2)}\n`);
    await execFileAsync('npm', ['install', '--ignore-scripts', '--no-package-lock'], { cwd: consumer });
    await writeFile(join(consumer, '.gitignore'), 'consumer-owned\n');
    await writeFile(consumerConfig, '{"consumer":"config"}\n');
    await writeFile(consumerState, '{"consumer":"state"}\n');
    await writeFile(localPlanSkill, 'CONFLICTING LOCAL PLAN SKILL\n');
    await writeFile(localImplementSkill, 'CONFLICTING LOCAL IMPLEMENT SKILL\n');
    await writeFile(localReviewSkill, 'CONFLICTING LOCAL REVIEW SKILL\n');
    await writeFile(consumerGitHubMarker, '{"issues":"unchanged","pullRequests":"unchanged"}\n');

    const protectedBefore = await snapshotFiles([
      join(consumer, 'package.json'),
      join(consumer, '.gitignore'),
      consumerConfig,
      consumerState,
      localPlanSkill,
      localImplementSkill,
      localReviewSkill,
      consumerGitHubMarker,
    ]);
    const unmanagedBefore = await snapshotUnmanagedTree(consumer);

    const packed = await packProject(packDir);
    const packedPaths = packed.files.map((file) => file.path).sort();
    assert.equal(packedPaths.includes('internal-workflow/manifest.json'), true);
    for (const skill of [
      'bug-root-cause-explainer', 'code-review', 'diagnosing-bugs', 'grilling', 'implement', 'plan',
      'prototype', 'research', 'tdd', 'tickets-orchestrator', 'to-spec', 'to-tickets',
    ]) {
      assert.equal(packedPaths.includes(`internal-workflow/skills/${skill}/SKILL.md`), true, skill);
    }
    for (const removed of [
      'code-debugger', 'implementation-spec-maker', 'implementation-spec-review', 'small-task-implementer',
      'spec-implementer', 'spec-to-tickets', 'tickets-breakdown-review', 'triage',
    ]) {
      assert.equal(packedPaths.some((path) => path.startsWith(`internal-workflow/skills/${removed}/`)), false, removed);
    }
    assert.equal(packedPaths.some((path) => path.startsWith('internal-workflow/evals/')), false);
    assert.equal(packedPaths.some((path) => path.startsWith('internal-skills/')), false);
    assert.equal(packedPaths.includes('dist/src/v2/implementation-report.js'), true);
    assert.equal(packedPaths.includes('dist/src/v2/code-review-report.js'), true);
    assert.equal(packedPaths.includes('dist/src/v2/proof-report.js'), true);
    for (const module of [
      'acceptance-proof', 'atomic-store', 'candidate', 'cli', 'checked-change', 'cli-contract', 'codex-process', 'config', 'containment',
      'code-review-report', 'contained-report-operation', 'direct-delivery', 'implementation-report', 'implementation-reviewer',
      'proof-report', 'run-issue', 'run-store', 'runtime', 'runtime-assets',
      'setup', 'setup-cli', 'setup-runtime', 'setup-store', 'workflow-assets',
    ]) {
      assert.equal(packedPaths.includes(`dist/src/v2/${module}.js`), true, module);
    }

    await installTarball(consumer, join(packDir, packed.filename));
    const installed = join(consumer, 'node_modules', 'codex-orchestrator');
    await assertInstalledContract(installed);
    const compileFixture = join(consumer, 'candidate-contract.mts');
    await writeFile(compileFixture, `
import { AcceptanceProof, createCheckedChangeCapabilities } from 'codex-orchestrator';
import type { CandidateGitV2, CheckedChange, CheckedChangeFreshness, CheckedChangePayloadV1, ProofAgent } from 'codex-orchestrator';

const payload: CheckedChangePayloadV1 = {
  version: 1, canonicalRepository: 'owner/repo', runId: '00000000-0000-4000-8000-000000000001',
  issueNumber: 1, cycle: 1, baseSha: '${'1'.repeat(40)}', headSha: '${'2'.repeat(40)}',
  indexTreeSha: '${'3'.repeat(40)}', trackedContentSha256: '${'4'.repeat(64)}',
  untrackedContentSha256: '${'5'.repeat(64)}', worktreeIdentity: 'legacy-worktree', changedFiles: ['a.ts'],
  checks: [], checkPolicySha256: '${'6'.repeat(64)}', packageVersion: '1.0.0', proofSchemaVersion: 1,
};
const capabilities = createCheckedChangeCapabilities();
const legacy: CheckedChange = capabilities.mint(payload);
const reread: CheckedChangePayloadV1 = capabilities.verifyAndRead(legacy).payload;
const optionalAdapter: { candidateV2?: CandidateGitV2 } = {};
const exactApprovedCandidateAdapter: CandidateGitV2 = {
  captureAndPin: async () => { throw new Error('fixture'); },
  inspectPin: async () => { throw new Error('fixture'); },
  normalizeSharedIndex: async () => { throw new Error('fixture'); },
  prepareMaterialization: async () => { throw new Error('fixture'); },
  inspectMaterialization: async () => { throw new Error('fixture'); },
  removeMaterialization: async () => { throw new Error('fixture'); },
  copyProofArtifacts: async () => { throw new Error('fixture'); },
  createOrObserveCommit: async () => { throw new Error('fixture'); },
  releasePin: async () => { throw new Error('fixture'); },
};
const legacyAgent: ProofAgent = { run: async () => ({ kind: 'internal-error' }) };
const legacyFreshness = async (legacyPayload: CheckedChangePayloadV1): Promise<CheckedChangeFreshness> => ({
  headSha: legacyPayload.headSha, indexTreeSha: legacyPayload.indexTreeSha,
  trackedContentSha256: legacyPayload.trackedContentSha256, untrackedContentSha256: legacyPayload.untrackedContentSha256,
  worktreeIdentity: legacyPayload.worktreeIdentity, checkPolicySha256: legacyPayload.checkPolicySha256,
});
const legacyProof = new AcceptanceProof({
  checkedChangeReader: {} as never, proofAgent: legacyAgent,
  inspectFreshness: legacyFreshness, readArtifact: async () => ({} as never),
  proofArtifactDir: '.proof',
});
void reread; void optionalAdapter; void exactApprovedCandidateAdapter; void legacyProof;
`);
    await execFileAsync(join(process.cwd(), 'node_modules', '.bin', 'tsc'), [
      '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext', compileFixture,
    ], { cwd: consumer });
    await rm(compileFixture);
    assert.deepEqual(await snapshotFiles([...protectedBefore.keys()]), protectedBefore);
    assert.deepEqual(await snapshotUnmanagedTree(consumer), unmanagedBefore);

    const workflowAssets = await import(pathToFileURL(join(installed, 'dist', 'src', 'v2', 'workflow-assets.js')).href) as {
      materializeWorkflowGeneration(input: {
        packageRoot: string; runtimeRoot: string; packageVersion: string; bootId: string;
      }): Promise<{ generationHash: string; generationRoot: string }>;
      resolveWorkflowOperation(receipt: object, operationId: string): Promise<{ entryPath: string; schemaPath: string; workflowRoot: string }>;
    };
    const receipt = await workflowAssets.materializeWorkflowGeneration({
      packageRoot: installed,
      runtimeRoot: join(root, 'runtime'),
      packageVersion: '2.0.1',
      bootId: 'packed-consumer',
    });
    const implementation = await workflowAssets.resolveWorkflowOperation(receipt, 'implementation');
    const codeReview = await workflowAssets.resolveWorkflowOperation(receipt, 'code-review');
    assert.equal(implementation.workflowRoot, receipt.generationRoot);
    assert.match(await readFile(implementation.entryPath, 'utf8'), /Follow packaged \[Implement\]/u);
    assert.equal(JSON.parse(await readFile(implementation.schemaPath, 'utf8')).type, 'object');
    assert.match(await readFile(codeReview.entryPath, 'utf8'), /independent Standards reviewer/u);
    assert.equal(JSON.parse(await readFile(codeReview.schemaPath, 'utf8')).type, 'object');
    assert.deepEqual(await snapshotFiles([...protectedBefore.keys()]), protectedBefore);
    assert.deepEqual(await snapshotUnmanagedTree(consumer), unmanagedBefore);
  } finally {
    await makeTreeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function makeTreeRemovable(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700).catch(() => undefined);
    for (const name of await readdir(directory).catch(() => [])) {
      const path = join(directory, name);
      const info = await lstat(path).catch(() => undefined);
      if (!info) continue;
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(path);
      else await chmod(path, 0o600).catch(() => undefined);
    }
  };
  await visit(root);
}

async function assertInstalledContract(installed: string): Promise<void> {
  const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(installedPackage.bin, { 'codex-orchestrator': 'dist/src/v2/cli.js' });
  assert.equal(installedPackage.scripts?.postinstall, undefined);
  const routing = await readFile(join(installed, 'internal-workflow', 'docs', 'agents', 'coding-skill-routing.md'), 'utf8');
  assert.match(routing, /user-facing coding flow is Plan, Implement, Review/u);
  const main = new Map([
    ['plan', 'Plan'],
    ['implement', 'Implement'],
    ['code-review', 'Review'],
  ]);
  for (const [skill, display] of main) {
    const metadata = await readFile(join(installed, 'internal-workflow', 'skills', skill, 'agents', 'openai.yaml'), 'utf8');
    assert.match(metadata, new RegExp(`display_name: "${display}"`, 'u'));
    assert.match(metadata, /allow_implicit_invocation: true/u);
    assert.doesNotMatch(await readFile(join(installed, 'internal-workflow', 'skills', skill, 'SKILL.md'), 'utf8'), /CONFLICTING LOCAL/u);
  }
  const graph = await readFile(join(installed, 'internal-workflow', 'skills', 'tickets-orchestrator', 'SKILL.md'), 'utf8');
  const flatGraph = graph.replace(/\s+/gu, ' ');
  for (const contract of [
    'single deterministic ticket routes to `$implement`',
    'unique fresh `implementer`',
    'Workers perform no Git action',
    'clean isolated integration worktree and pinned baseline',
    'exactly two distinct fresh reviewer children in parallel',
  ]) assert.match(flatGraph, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));

  const manifest = JSON.parse(await readFile(join(installed, 'internal-workflow', 'manifest.json'), 'utf8')) as {
    profiles: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.profiles).sort(), [
    'explorer', 'implementer', 'spec_reviewer', 'standards_reviewer',
  ]);

  const implementation = await import(pathToFileURL(join(installed, 'dist', 'src', 'v2', 'implementation-report.js')).href) as {
    implementationReportOutputSchema: () => Record<string, unknown>;
  };
  const proof = await import(pathToFileURL(join(installed, 'dist', 'src', 'v2', 'proof-report.js')).href) as {
    proofReportOutputSchema: () => Record<string, unknown>;
  };
  assert.equal(implementation.implementationReportOutputSchema().type, 'object');
  assert.equal(proof.proofReportOutputSchema().type, 'object');
  assert.equal(Array.isArray(((implementation.implementationReportOutputSchema().properties as Record<string, any>).report as Record<string, unknown>).anyOf), true);
  assert.equal(Array.isArray(((proof.proofReportOutputSchema().properties as Record<string, any>).report as Record<string, unknown>).anyOf), true);
  const setup = await import(pathToFileURL(join(installed, 'dist', 'src', 'v2', 'setup.js')).href) as {
    Setup: new (...args: never[]) => unknown;
  };
  const setupCli = await import(pathToFileURL(join(installed, 'dist', 'src', 'v2', 'setup-cli.js')).href) as {
    parseSetupArgs: (argv: string[]) => { operation: string };
  };
  assert.equal(typeof setup.Setup, 'function');
  assert.equal(setupCli.parseSetupArgs(['setup', '--target', '/tmp/consumer']).operation, 'configure');
  const setupRuntime = await import(pathToFileURL(join(installed, 'dist', 'src', 'v2', 'setup-runtime.js')).href) as {
    createProductionSetup: (input: { orchestratorHome: string; bootId: string }) => unknown;
  };
  assert.equal(typeof setupRuntime.createProductionSetup, 'function');
}

async function packProject(destination: string, cwd = process.cwd()): Promise<{ filename: string; files: Array<{ path: string }> }> {
  const result = await execFileAsync('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    destination,
  ], { cwd, maxBuffer: 20 * 1024 * 1024 });
  const entry = (JSON.parse(result.stdout) as Array<{ filename?: string; files?: Array<{ path: string }> }>)[0];
  assert.ok(entry?.filename);
  assert.ok(entry.files);
  return { filename: entry.filename, files: entry.files };
}

async function installTarball(consumer: string, tarball: string): Promise<void> {
  await execFileAsync('npm', [
    'install',
    '--ignore-scripts',
    '--no-package-lock',
    '--no-save',
    tarball,
  ], { cwd: consumer, maxBuffer: 20 * 1024 * 1024 });
}

async function snapshotFiles(paths: string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await readFile(path, 'utf8')] as const)));
}

async function snapshotUnmanagedTree(root: string): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      if (childRelative === 'node_modules' || childRelative.startsWith('node_modules/') || childRelative === 'package-lock.json') continue;
      const child = join(directory, name);
      const stat = await lstat(child);
      if (stat.isDirectory()) await visit(child, childRelative);
      else if (stat.isFile()) output.set(childRelative, await readFile(child, 'utf8'));
      else output.set(childRelative, `special:${stat.mode}`);
    }
  };
  await visit(root, '');
  return output;
}
