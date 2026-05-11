import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ShellCommandExecutor } from '../src/process/command.js';
import { runRunnerVisualProof } from '../src/runner/visual-proof-runner.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

test('runner visual proof reports screenshots that were already present before the command reran', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));
  const proofDir = join(worktreePath, '.codex-orchestrator', 'proofs', 'issue-155');
  await mkdir(proofDir, { recursive: true });
  await writeFile(join(proofDir, '390.png'), 'previous screenshot\n', 'utf8');

  const shellExecutor: ShellCommandExecutor = async (_command, options) => {
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR, proofDir);
    await writeFile(join(proofDir, '390.png'), 'fresh screenshot\n', 'utf8');
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  const result = await runRunnerVisualProof({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        visualProof: {
          ...validConfig.reviewGates.visualProof,
          runnerValidationCommand: 'node .codex-orchestrator/proofs/issue-${issueNumber}/visual-proof.mjs',
        },
      },
    },
    issue: issueFixture({ number: 155, title: '[UI] Fix responsive layout', body: 'Requires screenshots.' }),
    issueNumber: 155,
    worktreePath,
    changedFiles: ['src/frontend/CampaignList.tsx'],
    report: {
      status: 'completed',
      changes: [],
      validation: [],
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    },
    shellExecutor,
  });

  assert.equal(result.validation[0]?.status, 'passed');
  assert.match(result.validation[0]?.summary ?? '', /1 screenshot artifact/);
  assert.deepEqual(result.artifacts, [{
    type: 'screenshot',
    path: '.codex-orchestrator/proofs/issue-155/390.png',
    description: 'runner visual proof 390.png',
  }]);
});
