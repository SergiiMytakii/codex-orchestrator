import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

    const protectedBefore = await snapshotFiles([
      join(consumer, 'package.json'),
      join(consumer, '.gitignore'),
      consumerConfig,
      consumerState,
      localAgentSkill,
      localProofSkill,
    ]);

    const packed = await packProject(packDir);
    const packedPaths = packed.files.map((file) => file.path).sort();
    assert.equal(packedPaths.includes('internal-skills/agent-auto/SKILL.md'), true);
    assert.equal(packedPaths.includes('internal-skills/acceptance-proof/SKILL.md'), true);
    assert.equal(packedPaths.includes('dist/src/v2/implementation-report.js'), true);
    assert.equal(packedPaths.includes('dist/src/v2/proof-report.js'), true);

    await installTarball(consumer, join(packDir, packed.filename));
    const installed = join(consumer, 'node_modules', 'codex-orchestrator');
    await assertInstalledContract(installed, 'Implement one issue');
    assert.deepEqual(await snapshotFiles([...protectedBefore.keys()]), protectedBefore);

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
  assert.equal(Array.isArray(implementation.implementationReportOutputSchema().oneOf), true);
  assert.equal(Array.isArray(proof.proofReportOutputSchema().oneOf), true);
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
