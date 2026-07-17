import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);

test('packed install and update keep V2 skills/schema package-owned without mutating consumer policy', { timeout: 120_000 }, async () => {
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
    assert.equal(packedPaths.includes('internal-skills/agent-auto/SKILL.md'), true);
    assert.equal(packedPaths.includes('internal-skills/acceptance-proof/SKILL.md'), true);
    assert.equal(packedPaths.includes('dist/src/v2/implementation-report.js'), true);
    assert.equal(packedPaths.includes('dist/src/v2/proof-report.js'), true);
    for (const module of [
      'acceptance-proof', 'atomic-store', 'candidate-cli', 'checked-change', 'cli-contract', 'codex-process', 'config', 'containment',
      'implementation-report', 'legacy-cutover', 'proof-report', 'proof-store', 'run-issue', 'run-store', 'runtime', 'runtime-assets',
      'setup', 'setup-cli', 'setup-runtime', 'setup-store',
    ]) {
      assert.equal(packedPaths.includes(`dist/src/v2/${module}.js`), true, module);
    }

    await installTarball(consumer, join(packDir, packed.filename));
    const installed = join(consumer, 'node_modules', 'codex-orchestrator');
    await assertInstalledContract(installed, 'Implement one issue');
    assert.deepEqual(await snapshotFiles([...protectedBefore.keys()]), protectedBefore);
    assert.deepEqual(await snapshotUnmanagedTree(consumer), unmanagedBefore);

    const runtimeRoot = join(root, 'runtime');
    await mkdir(runtimeRoot, { mode: 0o700 });
    const versionASnapshot = await publishSnapshot(installed, runtimeRoot, 'runs/run-a/attempts/attempt-a/snapshot');
    const versionABytes = await snapshotFiles([versionASnapshot.skillPath, versionASnapshot.schemaPath]);

    const updateDir = join(root, 'update-source');
    const updatePackDir = join(root, 'update-pack');
    await mkdir(updateDir, { recursive: true });
    await mkdir(updatePackDir, { recursive: true });
    await execFileAsync('tar', ['-xzf', join(packDir, packed.filename), '--strip-components=1', '-C', updateDir]);
    const updatePackage = JSON.parse(await readFile(join(updateDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    updatePackage.version = '0.1.52-fixture.0';
    await writeFile(join(updateDir, 'package.json'), `${JSON.stringify(updatePackage, null, 2)}\n`);
    await writeFile(join(updateDir, 'internal-skills', 'agent-auto', 'SKILL.md'), '# Agent Auto\n\nUPDATED PACKAGE SKILL\n');
    const updatePacked = await packProject(updatePackDir, updateDir);
    await installTarball(consumer, join(updatePackDir, updatePacked.filename));

    assert.match(await readFile(join(installed, 'internal-skills', 'agent-auto', 'SKILL.md'), 'utf8'), /UPDATED PACKAGE SKILL/u);
    assert.deepEqual(await snapshotFiles([...protectedBefore.keys()]), protectedBefore);
    assert.deepEqual(await snapshotUnmanagedTree(consumer), unmanagedBefore);
    assert.deepEqual(await snapshotFiles([...versionABytes.keys()]), versionABytes);
    const versionBSnapshot = await publishSnapshot(installed, runtimeRoot, 'runs/run-b/attempts/attempt-b/snapshot', 'b');
    assert.equal(versionBSnapshot.packageVersion, '0.1.52-fixture.0');
    assert.notEqual(versionBSnapshot.files[0]?.sha256, versionASnapshot.files[0]?.sha256);
    assert.match(await readFile(versionBSnapshot.skillPath, 'utf8'), /UPDATED PACKAGE SKILL/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function assertInstalledContract(installed: string, agentText: string): Promise<void> {
  const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(installedPackage.bin, { 'codex-orchestrator': 'dist/src/cli.js' });
  assert.equal(installedPackage.scripts?.postinstall, undefined);
  assert.match(await readFile(join(installed, 'internal-skills', 'agent-auto', 'SKILL.md'), 'utf8'), new RegExp(agentText, 'u'));
  assert.match(await readFile(join(installed, 'internal-skills', 'acceptance-proof', 'SKILL.md'), 'utf8'), /Independently prove/u);
  assert.doesNotMatch(await readFile(join(installed, 'internal-skills', 'agent-auto', 'SKILL.md'), 'utf8'), /CONFLICTING LOCAL/u);

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

async function publishSnapshot(installed: string, runtimeRoot: string, snapshotRelativePath: string, cacheKey = 'a') {
  const runtimeAssets = await import(`${pathToFileURL(join(installed, 'dist', 'src', 'v2', 'runtime-assets.js')).href}?fixture=${cacheKey}`) as {
    publishRuntimeAssetSnapshot(input: {
      packageRoot: string;
      runtimeRoot: string;
      snapshotRelativePath: string;
      skill: 'agent-auto';
    }): Promise<{
      packageVersion: string;
      skillPath: string;
      schemaPath: string;
      files: Array<{ sha256: string }>;
    }>;
  };
  return runtimeAssets.publishRuntimeAssetSnapshot({
    packageRoot: installed,
    runtimeRoot,
    snapshotRelativePath,
    skill: 'agent-auto',
  });
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
