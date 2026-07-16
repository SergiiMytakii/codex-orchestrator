import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexExecutionRunInputV2 } from '../codex/execution-adapter.js';
import type { CodexOrchestratorConfig, CodexOrchestratorConfigV2, CodexPhase } from '../config/schema.js';
import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';
import {
  loadPackageSkillBundle,
  materializePackageSkillBundle,
  verifyMaterializedSkillBundle,
  type RuntimeGraphNodeV1,
  type RuntimeSkillBundleManifestV1,
} from '../skills/package-skill-bundle.js';
import { requireConfigV2 } from '../setup/skill-runtime-v2-migration.js';
import {
  intersectExecutionPolicy,
  startOperationGraph,
  type GraphProgressRecordV2,
} from '../skills/package-skill-graph.js';
import { RunnerStateStore, type RunnerProcessMetadataV2 } from './local-state.js';

export interface PreparedSkillRuntimeExecution {
  input: CodexExecutionRunInputV2;
  manifest: RuntimeSkillBundleManifestV1;
  graph: GraphProgressRecordV2;
  contextArtifactPath: string;
}

export async function prepareSkillRuntimeExecution(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig | CodexOrchestratorConfigV2;
  worktreePath: string;
  runId: string;
  issueNumber: number;
  sessionId: string;
  branchName: string;
  phase: CodexPhase;
  operationId: string;
  nodeId?: string;
  attemptId: string;
  reportPath: string;
  logPath: string;
  context: unknown;
  phaseEnv?: Record<string, string>;
}): Promise<PreparedSkillRuntimeExecution> {
  const config = requireConfigV2(input.config);
  const state = await new RunnerStateStore(input.targetRoot, config as unknown as CodexOrchestratorConfig).load();
  const resumable = state.version === 2
    ? state.runs.find((run): run is RunnerProcessMetadataV2 => 'stateVersion' in run && run.issueNumber === input.issueNumber
      && run.skillRuntime.operationId === input.operationId && !run.graph.aggregateVerdict)
    : undefined;
  const current = resumable ? undefined : await materializePackageSkillBundle({
    targetRoot: input.targetRoot,
    stateDir: config.runner.stateDir,
  });
  const loaded = resumable
    ? { manifest: await verifyMaterializedSkillBundle(resumable.skillRuntime.bundleRoot, resumable.skillRuntime.bundleHash) }
    : await loadPackageSkillBundle();
  const manifest = loaded.manifest;
  const skillRuntime = resumable?.skillRuntime ?? {
    packageVersion: current!.packageVersion,
    bundleHash: current!.bundleHash,
    bundleRoot: current!.bundleRoot,
    operationId: input.operationId,
    entrySkillPath: '',
  };
  if (manifest.bundleHash !== skillRuntime.bundleHash || manifest.package.version !== skillRuntime.packageVersion) {
    throw new Error('orchestrator-skill-runtime-materialization-mismatch');
  }
  const operation = manifest.operations[input.operationId];
  if (!operation) throw new Error(`orchestrator-skill-operation-unknown:${input.operationId}`);
  const graph = manifest.graphs[operation.graph];
  if (!graph) throw new Error(`orchestrator-skill-graph-unknown:${operation.graph}`);
  const nodeId = resumable?.graph.currentNodeId ?? input.nodeId ?? operation.entryNode;
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`orchestrator-skill-node-unknown:${nodeId}`);
  const profile = config.codex.profiles[input.phase];
  const effectiveNode = {
    ...node,
    executionPolicy: intersectExecutionPolicy(node.executionPolicy, config.codex.targetPolicy, {
      model: profile?.model ?? null,
      effort: profile?.effort ?? null,
      timeoutMs: profile?.timeoutMs ?? config.codex.timeoutMs,
      idleTimeoutMs: profile?.idleTimeoutMs ?? config.codex.idleTimeoutMs,
    }),
  };
  const contextArtifactPath = join(
    input.targetRoot,
    config.runner.stateDir,
    'contexts',
    `issue-${input.issueNumber}-${input.sessionId}-${input.operationId}-${node.id}.json`,
  );
  await mkdir(dirname(contextArtifactPath), { recursive: true });
  await writeDurableAtomicFile(contextArtifactPath, `${JSON.stringify({
    version: 1,
    operationId: input.operationId,
    nodeId: node.id,
    issueNumber: input.issueNumber,
    sessionId: input.sessionId,
    phase: input.phase,
    reportPath: input.reportPath,
    context: input.context,
  }, null, 2)}\n`);
  const entrySkillPath = entryPathForNode(manifest, node);
  return {
    manifest,
    graph: resumable?.graph ?? startOperationGraph(manifest, input.operationId),
    contextArtifactPath,
    input: {
      targetRoot: input.targetRoot,
      worktreePath: input.worktreePath,
      config,
      runId: resumable?.runId ?? input.runId,
      issueNumber: input.issueNumber,
      sessionId: input.sessionId,
      branchName: input.branchName,
      phase: input.phase,
      operationId: input.operationId,
      nodeId: node.id,
      attemptId: input.attemptId,
      skillRuntime: {
        packageVersion: skillRuntime.packageVersion,
        bundleHash: skillRuntime.bundleHash,
        bundleRoot: skillRuntime.bundleRoot,
        operationId: input.operationId,
        entrySkillPath,
      },
      manifestNode: effectiveNode,
      targetPolicy: config.codex.targetPolicy,
      contextArtifactPath,
      reportPath: input.reportPath,
      logPath: input.logPath,
      phaseEnv: input.phaseEnv ?? {},
    },
  };
}

export function skillExecutionPolicyHash(node: RuntimeGraphNodeV1): string {
  return createHash('sha256').update(JSON.stringify(node.executionPolicy)).digest('hex');
}

function entryPathForNode(manifest: RuntimeSkillBundleManifestV1, node: RuntimeGraphNodeV1): string {
  if (node.skill.includes('/')) return node.skill;
  const skill = manifest.skills[node.skill];
  if (!skill) throw new Error(`orchestrator-skill-entry-unknown:${node.skill}`);
  return skill.entry;
}
