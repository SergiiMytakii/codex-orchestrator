import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppServerProcessOwner } from '../codex/app-server-process.js';
import { assertCodexVersion, preparePackageRuntimeHome } from '../codex/package-runtime-home.js';
import { loadToolCatalogFixture } from '../codex/tool-catalog.js';
import type { CodexOrchestratorConfig, CodexOrchestratorConfigV2 } from '../config/schema.js';
import { loadPackageSkillBundle, materializePackageSkillBundle } from '../skills/package-skill-bundle.js';
import { requireConfigV2 } from '../setup/skill-runtime-v2-migration.js';
import { RunnerStateStore, type RunnerStateFile } from './local-state.js';

export interface SkillRuntimePreflightDependencies {
  materialize?: typeof materializePackageSkillBundle;
  loadBundle?: typeof loadPackageSkillBundle;
  loadToolCatalog?: typeof loadToolCatalogFixture;
  prepareRuntimeHome?: typeof preparePackageRuntimeHome;
  assertVersion?: typeof assertCodexVersion;
  probeAppServer?: (input: {
    runId: string;
    runtimeHome: Awaited<ReturnType<typeof preparePackageRuntimeHome>>;
    command: string;
    serverArgs: string[];
  }) => Promise<AppServerProcessOwner | void>;
  loadState?: () => Promise<RunnerStateFile>;
}

export interface SkillRuntimePreflightResult {
  config: CodexOrchestratorConfigV2;
  packageVersion: string;
  bundleHash: string;
  bundleRoot: string;
  toolCatalogPath: string;
  retainedOwner?: AppServerProcessOwner;
}

export async function runSkillRuntimePreflight(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig | CodexOrchestratorConfigV2;
  runId: string;
  sourceEnv?: NodeJS.ProcessEnv;
  dependencies?: SkillRuntimePreflightDependencies;
  retainAppServer?: boolean;
}): Promise<SkillRuntimePreflightResult> {
  if (input.config.version !== 2) throw new Error('orchestrator-skill-runtime-v2-required');
  const config = requireConfigV2(input.config);
  const result = await runSkillRuntimeCandidatePreflight({
    targetRoot: input.targetRoot,
    config,
    runId: input.runId,
    sourceEnv: input.sourceEnv,
    dependencies: input.dependencies,
    retainAppServer: input.retainAppServer,
  });
  const dependencies = input.dependencies ?? {};
  const state = await (dependencies.loadState ?? (() => new RunnerStateStore(input.targetRoot, config as unknown as CodexOrchestratorConfig).load()))();
  if (state.version !== 2) throw new Error('orchestrator-runner-state-v2-required');
  if (state.runs.some((run) => !('stateVersion' in run))) throw new Error('orchestrator-runner-state-v1-record-present');
  return result;
}

export async function runSkillRuntimeCandidatePreflight(input: {
  targetRoot: string;
  config: CodexOrchestratorConfigV2;
  runId: string;
  sourceEnv?: NodeJS.ProcessEnv;
  dependencies?: SkillRuntimePreflightDependencies;
  retainAppServer?: boolean;
}): Promise<SkillRuntimePreflightResult> {
  const config = requireConfigV2(input.config);
  const dependencies = input.dependencies ?? {};
  const { manifest } = await (dependencies.loadBundle ?? loadPackageSkillBundle)();
  const materialized = await (dependencies.materialize ?? materializePackageSkillBundle)({
    targetRoot: input.targetRoot,
    stateDir: config.runner.stateDir,
  });
  if (manifest.bundleHash !== materialized.bundleHash || manifest.package.version !== materialized.packageVersion) {
    throw new Error('orchestrator-skill-runtime-materialization-mismatch');
  }
  const toolCatalogPath = join(materialized.bundleRoot, 'tool-catalogs', `codex-${config.codex.requiredVersion}.json`);
  await (dependencies.loadToolCatalog ?? loadToolCatalogFixture)(toolCatalogPath);
  const runtimeHome = await (dependencies.prepareRuntimeHome ?? preparePackageRuntimeHome)({
    runId: input.runId,
    sourceEnv: input.sourceEnv,
    phaseEnv: {},
    allowAccessToken: false,
  });
  await (dependencies.assertVersion ?? assertCodexVersion)(config.codex.command, config.codex.requiredVersion, runtimeHome.env);
  let retainedOwner: AppServerProcessOwner | undefined;
  if (dependencies.probeAppServer) {
    const probed = await dependencies.probeAppServer({
      runId: input.runId, runtimeHome, command: config.codex.command, serverArgs: config.codex.serverArgs,
    });
    if (probed && input.retainAppServer) retainedOwner = probed;
    else await probed?.close('preflight-complete');
  } else {
    retainedOwner = await probeAppServer({
      runId: input.runId,
      runtimeHome,
      command: config.codex.command,
      serverArgs: config.codex.serverArgs,
      retain: input.retainAppServer === true,
    });
  }
  return {
    config,
    packageVersion: materialized.packageVersion,
    bundleHash: materialized.bundleHash,
    bundleRoot: materialized.bundleRoot,
    toolCatalogPath,
    ...(retainedOwner ? { retainedOwner } : {}),
  };
}

async function probeAppServer(input: {
  runId: string;
  runtimeHome: Awaited<ReturnType<typeof preparePackageRuntimeHome>>;
  command: string;
  serverArgs: string[];
  retain?: boolean;
}): Promise<AppServerProcessOwner | undefined> {
  const owner = await AppServerProcessOwner.start({
    runId: input.runId,
    runtimeHome: input.runtimeHome,
    command: input.command,
    args: ['app-server', ...input.serverArgs],
    cwd: input.runtimeHome.root,
    supervisorPath: join(dirname(fileURLToPath(import.meta.url)), '../codex/app-server-supervisor.js'),
  });
  if (input.retain) return owner;
  await owner.close('preflight-complete');
  return undefined;
}
