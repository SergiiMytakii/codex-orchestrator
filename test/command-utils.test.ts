import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readRunnerConfig, runConfiguredChecks } from '../src/runner/command-utils.js';
import { buildProjectConfig } from '../src/setup/project-config.js';
import { fallbackWorkflows } from './fixtures/config.js';

test('runner config reader backfills package-owned proof command and drops unsupported default npm checks', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-config-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, 'package.json'),
    JSON.stringify({
      scripts: {
        test: 'node --test',
      },
    }),
    'utf8',
  );
  const staleConfig = buildProjectConfig({
    owner: 'SergiiMytakii',
    repo: 'IntelleReach',
    prepareLabels: 'report-only',
    workflows: fallbackWorkflows,
  });
  delete staleConfig.reviewGates.visualProof.runnerValidationCommand;
  delete (staleConfig.reviewGates.acceptanceProof as Partial<typeof staleConfig.reviewGates.acceptanceProof>).proofStrategy;
  delete (staleConfig.reviewGates as Partial<typeof staleConfig.reviewGates>).riskRouting;
  staleConfig.loopPolicy.rework.retryableBlockers = staleConfig.loopPolicy.rework.retryableBlockers
    .filter((blocker) => blocker !== 'failed-acceptance-proof');
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify(staleConfig),
    'utf8',
  );

  const config = await readRunnerConfig(targetRoot);

  assert.deepEqual(config.checks, { test: 'npm test' });
  assert.equal(
    config.reviewGates.visualProof.runnerValidationCommand,
    'codex-orchestrator visual-proof auto --issue ${issueNumber}',
  );
  assert.equal(config.reviewGates.acceptanceProof.proofStrategy, 'auto');
  assert.deepEqual(config.reviewGates.riskRouting, {
    enabled: true,
    mode: 'warn',
    requireScopedReviewHandoff: true,
    requireParentSizeRisk: true,
    requireParentReviewHandoff: true,
    riskyChangedPathGlobs: [],
    highRiskRequiresCodeReview: true,
    allowedLowRiskFlows: ['small-task-implementer', 'scoped-implementation'],
  });
  assert.equal(config.loopPolicy.rework.retryableBlockers.includes('failed-acceptance-proof'), true);
});

test('runner config reader does not migrate legacy visual proof command into acceptance proof', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-config-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, 'package.json'),
    JSON.stringify({
      scripts: {
        test: 'node --test',
      },
    }),
    'utf8',
  );
  const staleConfig = buildProjectConfig({
    owner: 'SergiiMytakii',
    repo: 'IntelleReach',
    prepareLabels: 'report-only',
    workflows: fallbackWorkflows,
  });
  staleConfig.reviewGates.visualProof.runnerValidationCommand = 'npm run legacy-visual-proof';
  delete staleConfig.reviewGates.acceptanceProof.runnerValidationCommand;
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify(staleConfig),
    'utf8',
  );

  const config = await readRunnerConfig(targetRoot);

  assert.equal(config.reviewGates.visualProof.runnerValidationCommand, 'npm run legacy-visual-proof');
  assert.equal(
    config.reviewGates.acceptanceProof.runnerValidationCommand,
    'codex-orchestrator visual-proof auto --issue ${issueNumber}',
  );
});

test('configured checks still run during parent integration when scoped to parent phase', async () => {
  const config = buildProjectConfig({
    owner: 'SergiiMytakii',
    repo: 'IntelleReach',
    prepareLabels: 'report-only',
    workflows: fallbackWorkflows,
  });
  config.checks = { test: 'npm test' };
  config.checksPolicy = {
    missingNpmScript: 'skip',
    scope: {
      test: { phases: ['parent-integration'] },
    },
  };

  const calls: string[] = [];
  const validation = await runConfiguredChecks(
    config,
    '/tmp/worktree',
    async (command) => {
      calls.push(command);
      return { stdout: '', stderr: 'parent test failed', exitCode: 1 };
    },
    [],
    { phase: 'parent-integration' },
  );

  assert.deepEqual(calls, ['npm test']);
  assert.deepEqual(validation, [{
    command: 'npm test',
    status: 'failed',
    summary: 'test: parent test failed',
  }]);
});
