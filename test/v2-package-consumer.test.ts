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
    const localAgentSkill = join(consumer, '.codex', 'skills', 'agent-auto', 'SKILL.md');
    const localProofSkill = join(consumer, '.codex', 'skills', 'acceptance-proof', 'SKILL.md');
    const consumerGitHubMarker = join(consumer, '.github-state-marker.json');
    await Promise.all([
      mkdir(packDir, { recursive: true }),
      mkdir(dirname(consumerConfig), { recursive: true }),
      mkdir(dirname(consumerState), { recursive: true }),
      mkdir(dirname(localAgentSkill), { recursive: true }),
      mkdir(dirname(localProofSkill), { recursive: true }),
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
    await writeFile(localAgentSkill, 'CONFLICTING LOCAL AGENT SKILL\n');
    await writeFile(localProofSkill, 'CONFLICTING LOCAL PROOF SKILL\n');
    await writeFile(consumerGitHubMarker, '{"issues":"unchanged","pullRequests":"unchanged"}\n');

    const protectedBefore = await snapshotFiles([
      join(consumer, 'package.json'),
      join(consumer, '.gitignore'),
      consumerConfig,
      consumerState,
      localAgentSkill,
      localProofSkill,
      consumerGitHubMarker,
    ]);
    const unmanagedBefore = await snapshotUnmanagedTree(consumer);

    const packed = await packProject(packDir);
    const packedPaths = packed.files.map((file) => file.path).sort();
    assert.equal(packedPaths.includes('internal-workflow/manifest.json'), true);
    assert.equal(packedPaths.includes('internal-workflow/skills/agent-auto/SKILL.md'), true);
    assert.equal(packedPaths.includes('internal-workflow/skills/acceptance-proof/SKILL.md'), true);
    assert.equal(packedPaths.some((path) => path.startsWith('internal-skills/')), false);
    assert.equal(packedPaths.includes('dist/src/v2/implementation-report.js'), true);
    assert.equal(packedPaths.includes('dist/src/v2/proof-report.js'), true);
    for (const module of [
      'acceptance-proof', 'atomic-store', 'candidate-cli', 'checked-change', 'cli-contract', 'codex-process', 'config', 'containment',
      'implementation-report', 'legacy-cutover', 'proof-report', 'proof-store', 'run-issue', 'run-store', 'runtime', 'runtime-assets',
      'setup', 'setup-cli', 'setup-runtime', 'setup-store', 'waiting-human', 'waiting-human-coordinator', 'workflow-assets',
    ]) {
      assert.equal(packedPaths.includes(`dist/src/v2/${module}.js`), true, module);
    }

    await installTarball(consumer, join(packDir, packed.filename));
    const installed = join(consumer, 'node_modules', 'codex-orchestrator');
    await assertInstalledContract(installed, 'Implement one issue');
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
    assert.equal(implementation.workflowRoot, receipt.generationRoot);
    assert.match(await readFile(implementation.entryPath, 'utf8'), /Implementation Operation/u);
    assert.equal(JSON.parse(await readFile(implementation.schemaPath, 'utf8')).type, 'object');
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

async function assertInstalledContract(installed: string, agentText: string): Promise<void> {
  const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(installedPackage.bin, { 'codex-orchestrator': 'dist/src/v2/candidate-cli.js' });
  assert.equal(installedPackage.scripts?.postinstall, undefined);
  assert.match(await readFile(join(installed, 'internal-workflow', 'skills', 'agent-auto', 'SKILL.md'), 'utf8'), new RegExp(agentText, 'u'));
  assert.match(await readFile(join(installed, 'internal-workflow', 'skills', 'acceptance-proof', 'SKILL.md'), 'utf8'), /Independently prove/u);
  assert.doesNotMatch(await readFile(join(installed, 'internal-workflow', 'skills', 'agent-auto', 'SKILL.md'), 'utf8'), /CONFLICTING LOCAL/u);

  const implementation = await import(pathToFileURL(join(installed, 'dist', 'src', 'v2', 'implementation-report.js')).href) as {
    implementationReportOutputSchema: () => Record<string, unknown>;
  };
  const proof = await import(pathToFileURL(join(installed, 'dist', 'src', 'v2', 'proof-report.js')).href) as {
    proofReportOutputSchema: () => Record<string, unknown>;
  };
  assert.equal(implementation.implementationReportOutputSchema().type, 'object');
  assert.equal(proof.proofReportOutputSchema().type, 'object');
  assert.equal(Array.isArray(((implementation.implementationReportOutputSchema().properties as Record<string, any>).report as Record<string, unknown>).anyOf), true);
  assert.equal(((proof.proofReportOutputSchema().properties as Record<string, any>).report as Record<string, unknown>).type, 'object');
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
