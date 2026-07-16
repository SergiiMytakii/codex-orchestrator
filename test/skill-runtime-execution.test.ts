import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { prepareSkillRuntimeExecution } from '../src/runner/skill-runtime-execution.js';
import { materializePackageSkillBundle, verifyMaterializedSkillBundle } from '../src/skills/package-skill-bundle.js';
import { startOperationGraph } from '../src/skills/package-skill-graph.js';
import { migrateConfigV1ToV2 } from '../src/setup/skill-runtime-v2-migration.js';
import { validConfig } from './fixtures/config.js';

test('skill runtime restart resumes the persisted graph node and pinned materialized bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-runtime-resume-'));
  const config = migrateConfigV1ToV2({ ...validConfig, codex: { ...validConfig.codex, figmaMcp: { ...validConfig.codex.figmaMcp!, enabled: false } } });
  const materialized = await materializePackageSkillBundle({ targetRoot: root, stateDir: config.runner.stateDir });
  const manifest = await verifyMaterializedSkillBundle(materialized.bundleRoot, materialized.bundleHash);
  const graph = {
    ...startOperationGraph(manifest, 'implementation-attempt'),
    currentNodeId: 'small-task-implementer',
    completedNodeIds: ['scoped-classification'],
    artifactRefs: ['artifact://classification'],
  };
  const stateDir = join(root, config.runner.stateDir);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'runner-state.json'), `${JSON.stringify({
    version: 2,
    generation: 7,
    runs: [{
      issueNumber: 42,
      mode: 'scoped-issue',
      workspacePath: root,
      sessionId: 'old-session',
      retryCount: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      stateVersion: 2,
      runId: 'persisted-run',
      skillRuntime: {
        packageVersion: materialized.packageVersion,
        bundleHash: materialized.bundleHash,
        bundleRoot: materialized.bundleRoot,
        operationId: 'implementation-attempt',
        entrySkillPath: 'operations/scoped-classification/SKILL.md',
      },
      executionPolicyHash: 'a'.repeat(64),
      effectivePolicySummary: config.codex.targetPolicy,
      graph,
    }],
  }, null, 2)}\n`);

  const prepared = await prepareSkillRuntimeExecution({
    targetRoot: root,
    config,
    worktreePath: root,
    runId: 'new-run-that-must-not-replace-the-pin',
    issueNumber: 42,
    sessionId: 'new-session',
    branchName: 'codex/issue-42',
    phase: 'scoped-issue',
    operationId: 'implementation-attempt',
    attemptId: 'attempt-resume',
    reportPath: join(stateDir, 'report.json'),
    logPath: join(stateDir, 'run.log'),
    context: { resumed: true },
  });

  assert.equal(prepared.input.runId, 'persisted-run');
  assert.equal(prepared.input.nodeId, 'small-task-implementer');
  assert.equal(prepared.input.skillRuntime.bundleRoot, materialized.bundleRoot);
  assert.equal(prepared.input.skillRuntime.bundleHash, materialized.bundleHash);
  assert.equal(prepared.input.skillRuntime.entrySkillPath, manifest.skills['small-task-implementer']!.entry);
  assert.deepEqual(prepared.graph, graph);
});
