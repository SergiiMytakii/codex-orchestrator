import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CodexOrchestratorConfig, CodexOrchestratorConfigV2 } from '../config/schema.js';
import { validateConfig, validateConfigV2 } from '../config/schema.js';
import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';
import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import { RunnerStateStore } from '../runner/local-state.js';
import { runSkillRuntimeCandidatePreflight } from '../runner/skill-runtime-preflight.js';
import { acquireTargetActivityFence } from '../runner/target-activity-fence.js';
import { loadPackageSkillBundle } from '../skills/package-skill-bundle.js';
import { projectConfigPath } from './project-config.js';
import type { PreparedSkillRuntimeGenerationV1 } from './skill-runtime-v2-preparation.js';
import { migrateConfigV1ToV2 } from './skill-runtime-v2-migration.js';

interface ActivationDependencies {
  issueAdapter?: GitHubIssueAdapter;
  loadBundle?: typeof loadPackageSkillBundle;
  beforeStateWrite?: () => Promise<void>;
  beforeConfigCommit?: () => Promise<void>;
  afterConfigCommit?: () => Promise<void>;
  candidatePreflight?: typeof runSkillRuntimeCandidatePreflight;
}

export interface ActivateSkillRuntimeV2Result {
  configPath: string;
  backupPath: string;
  statePath: string;
  config: CodexOrchestratorConfigV2;
  preparedGenerationPath: string;
}

export async function activatePreparedSkillRuntimeV2(input: {
  targetRoot: string;
  dependencies?: ActivationDependencies;
}): Promise<ActivateSkillRuntimeV2Result> {
  const targetRoot = await realpath(resolve(input.targetRoot));
  const configPath = projectConfigPath(targetRoot);
  const configBytes = await readFile(configPath);
  const parsed = JSON.parse(configBytes.toString('utf8')) as unknown;
  const v1 = validateConfig(parsed);
  if (!v1.ok) {
    const alreadyV2 = validateConfigV2(parsed);
    if (alreadyV2.ok) throw new Error('orchestrator-skill-runtime-v2-already-active');
    throw new Error(`config-v2-source-invalid: ${v1.errors.join('; ')}`);
  }
  const config = v1.value;
  const lease = await acquireTargetActivityFence({
    targetRoot,
    stateDir: config.runner.stateDir,
    mode: 'exclusive',
    purpose: 'setup',
  });
  try {
    const currentBytes = await readFile(configPath);
    if (!currentBytes.equals(configBytes)) throw new Error('target-activity-fence-config-changed');
    const generationPath = join(targetRoot, config.runner.stateDir, 'skill-runtime-v2', 'prepared-generation.json');
    const generation = parsePreparedGeneration(JSON.parse(await readFile(generationPath, 'utf8')) as unknown);
    if (generation.canonicalTargetRoot !== targetRoot) throw new Error('orchestrator-prepared-generation-target-mismatch');
    if (generation.inspectedProcesses.length !== 0 || generation.runnerState.nonterminalV1RunIds.length !== 0 || generation.githubDrain.runningIssueNumbers.length !== 0) {
      throw new Error('orchestrator-prepared-generation-drain-invalid');
    }
    const { manifest } = await (input.dependencies?.loadBundle ?? loadPackageSkillBundle)();
    if (!manifest.acceptedBridgePackageHashes.includes(generation.bridgePackageHash)) {
      throw new Error('orchestrator-prepared-generation-bridge-unaccepted');
    }
    const store = new RunnerStateStore(targetRoot, config);
    const state = await store.load();
    if (state.runs.length !== 0) throw new Error('orchestrator-v1-drain-required');
    const stateBytes = await readFile(store.statePath());
    const stateMatchesPreparedGeneration = createHash('sha256').update(stateBytes).digest('hex') === generation.runnerState.sha256;
    const stateIsInterruptedActivationCommit = state.version === 2 && state.generation === 0 && state.runs.length === 0;
    if (!stateMatchesPreparedGeneration && !stateIsInterruptedActivationCommit) {
      throw new Error('orchestrator-prepared-generation-state-changed');
    }
    const issueAdapter = input.dependencies?.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
    const runningIssues = await issueAdapter.listOpenIssuesWithAnyLabel([config.github.labels.running.name]);
    if (runningIssues.length > 0) throw new Error(`orchestrator-v1-github-drain-required:${runningIssues.map((issue) => issue.number).sort((a, b) => a - b).join(',')}`);
    const candidate = migrateConfigV1ToV2(config);
    const candidateValidation = validateConfigV2(candidate);
    if (!candidateValidation.ok) throw new Error(`config-v2-candidate-invalid: ${candidateValidation.errors.join('; ')}`);
    await (input.dependencies?.candidatePreflight ?? runSkillRuntimeCandidatePreflight)({
      targetRoot,
      config: candidateValidation.value,
      runId: 'skill-runtime-v2-activation',
    });
    const backupPath = `${configPath}.v1.backup`;
    await writeDurableAtomicFile(backupPath, configBytes);
    await input.dependencies?.beforeStateWrite?.();
    await writeDurableAtomicFile(store.statePath(), `${JSON.stringify({ version: 2, generation: 0, runs: [] }, null, 2)}\n`);
    await input.dependencies?.beforeConfigCommit?.();
    await writeDurableAtomicFile(configPath, `${JSON.stringify(candidateValidation.value, null, 2)}\n`);
    await input.dependencies?.afterConfigCommit?.();
    return {
      configPath,
      backupPath,
      statePath: store.statePath(),
      config: candidateValidation.value,
      preparedGenerationPath: generationPath,
    };
  } finally {
    await lease.release();
  }
}

function parsePreparedGeneration(value: unknown): PreparedSkillRuntimeGenerationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('orchestrator-prepared-generation-invalid');
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.canonicalTargetRoot !== 'string' || typeof candidate.bridgePackageHash !== 'string'
    || !Array.isArray(candidate.inspectedProcesses) || !candidate.runnerState || typeof candidate.runnerState !== 'object'
    || !candidate.githubDrain || typeof candidate.githubDrain !== 'object') throw new Error('orchestrator-prepared-generation-invalid');
  const runnerState = candidate.runnerState as Record<string, unknown>;
  const githubDrain = candidate.githubDrain as Record<string, unknown>;
  if (typeof runnerState.sha256 !== 'string' || !Array.isArray(runnerState.nonterminalV1RunIds)
    || !Array.isArray(githubDrain.runningIssueNumbers)) throw new Error('orchestrator-prepared-generation-invalid');
  return value as PreparedSkillRuntimeGenerationV1;
}
