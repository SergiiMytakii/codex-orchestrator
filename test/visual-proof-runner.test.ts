import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';

import type { ShellCommandExecutor } from '../src/process/command.js';
import { runRunnerVisualProof, type RunnerVisualProofResult } from '../src/runner/visual-proof-runner.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

test('runner visual proof reports screenshots that are updated by the command', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));
  const proofDir = join(worktreePath, '.codex-orchestrator', 'proofs', 'issue-155');
  await mkdir(proofDir, { recursive: true });
  await writeFile(join(proofDir, '390.png'), 'previous screenshot\n', 'utf8');
  const previousFlutterBin = process.env.CODEX_ORCHESTRATOR_FLUTTER_BIN;
  process.env.CODEX_ORCHESTRATOR_FLUTTER_BIN = '/opt/flutter/bin/flutter';

  const shellExecutor: ShellCommandExecutor = async (_command, options) => {
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR, proofDir);
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_FLUTTER_BIN, '/opt/flutter/bin/flutter');
    const profileDir = options?.env?.CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR;
    const browsersDir = options?.env?.PLAYWRIGHT_BROWSERS_PATH;
    assert.ok(profileDir);
    assert.ok(browsersDir);
    assert.equal(isPathInside(worktreePath, profileDir), false);
    assert.equal(isPathInside(worktreePath, browsersDir), false);
    await writeFile(join(proofDir, '390.png'), 'fresh screenshot\n', 'utf8');
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  let result: RunnerVisualProofResult;
  try {
    result = await runRunnerVisualProof({
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
  } finally {
    if (previousFlutterBin === undefined) {
      delete process.env.CODEX_ORCHESTRATOR_FLUTTER_BIN;
    } else {
      process.env.CODEX_ORCHESTRATOR_FLUTTER_BIN = previousFlutterBin;
    }
  }

  assert.equal(result.validation[0]?.status, 'passed');
  assert.match(result.validation[0]?.summary ?? '', /1 screenshot artifact/);
  assert.deepEqual(result.artifacts, [{
    type: 'screenshot',
    path: '.codex-orchestrator/proofs/issue-155/390.png',
    description: 'runner visual proof 390.png',
  }]);
});

test('runner visual proof ignores preexisting screenshots that the command did not update', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));
  const proofDir = join(worktreePath, '.codex-orchestrator', 'proofs', 'issue-155');
  await mkdir(proofDir, { recursive: true });
  await writeFile(join(proofDir, '390.png'), 'previous screenshot\n', 'utf8');
  const shellExecutor: ShellCommandExecutor = async () => ({ stdout: 'skipped', stderr: '', exitCode: 0 });

  const result = await runRunnerVisualProof({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        visualProof: {
          ...validConfig.reviewGates.visualProof,
          runnerValidationCommand: 'node visual-proof.mjs',
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

  assert.equal(result.validation[0]?.status, 'skipped');
  assert.match(result.validation[0]?.summary ?? '', /did not produce a screenshot artifact/);
  assert.deepEqual(result.artifacts, []);
});

test('runner visual proof reports same-size screenshots when file content changes', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));
  const proofDir = join(worktreePath, '.codex-orchestrator', 'proofs', 'issue-155');
  const screenshotPath = join(proofDir, '390.png');
  await mkdir(proofDir, { recursive: true });
  await writeFile(screenshotPath, 'before-image\n', 'utf8');
  const fixedTime = new Date('2026-05-12T12:00:00.000Z');
  await utimes(screenshotPath, fixedTime, fixedTime);
  const originalStat = await stat(screenshotPath);

  const shellExecutor: ShellCommandExecutor = async () => {
    await writeFile(screenshotPath, 'after--image\n', 'utf8');
    await utimes(screenshotPath, originalStat.atime, originalStat.mtime);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  const result = await runRunnerVisualProof({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        visualProof: {
          ...validConfig.reviewGates.visualProof,
          runnerValidationCommand: 'node visual-proof.mjs',
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
  assert.deepEqual(result.artifacts, [{
    type: 'screenshot',
    path: '.codex-orchestrator/proofs/issue-155/390.png',
    description: 'runner visual proof 390.png',
  }]);
});

test('runner visual proof warns when the command succeeds without producing a screenshot artifact', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));
  const shellExecutor: ShellCommandExecutor = async () => ({ stdout: 'skipped', stderr: '', exitCode: 0 });

  const result = await runRunnerVisualProof({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        visualProof: {
          ...validConfig.reviewGates.visualProof,
          runnerValidationCommand: 'node visual-proof.mjs',
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

  assert.equal(result.validation[0]?.status, 'skipped');
  assert.match(result.validation[0]?.summary ?? '', /did not produce a screenshot artifact/);
  assert.deepEqual(result.artifacts, []);
});

test('runner visual proof ignores screenshots inside runner-owned browser internals', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));

  const shellExecutor: ShellCommandExecutor = async (_command, options) => {
    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    const profileDir = options?.env?.CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR;
    const browsersDir = options?.env?.PLAYWRIGHT_BROWSERS_PATH;
    assert.ok(proofDir);
    assert.ok(profileDir);
    assert.ok(browsersDir);
    assert.equal(isPathInside(worktreePath, profileDir), false);
    assert.equal(isPathInside(worktreePath, browsersDir), false);
    await mkdir(profileDir, { recursive: true });
    await mkdir(browsersDir, { recursive: true });
    await mkdir(join(proofDir, 'playwright-profile'), { recursive: true });
    await mkdir(join(proofDir, 'ms-playwright'), { recursive: true });
    await writeFile(join(proofDir, 'playwright-profile', 'cached-avatar.png'), 'cache\n', 'utf8');
    await writeFile(join(proofDir, 'ms-playwright', 'browser-icon.png'), 'cache\n', 'utf8');
    await writeFile(join(profileDir, 'cached-avatar.png'), 'cache\n', 'utf8');
    await writeFile(join(browsersDir, 'browser-icon.png'), 'cache\n', 'utf8');
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  const result = await runRunnerVisualProof({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        visualProof: {
          ...validConfig.reviewGates.visualProof,
          runnerValidationCommand: 'node visual-proof.mjs',
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

  assert.equal(result.validation[0]?.status, 'skipped');
  assert.match(result.validation[0]?.summary ?? '', /did not produce a screenshot artifact/);
  assert.deepEqual(result.artifacts, []);
});

test('runner visual proof keeps browser runtime directories outside the worktree when TMPDIR points inside it', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));
  const worktreeTmpDir = join(worktreePath, 'tmp');
  await mkdir(worktreeTmpDir, { recursive: true });
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = worktreeTmpDir;

  const shellExecutor: ShellCommandExecutor = async (_command, options) => {
    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    const profileDir = options?.env?.CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR;
    const browsersDir = options?.env?.PLAYWRIGHT_BROWSERS_PATH;
    assert.ok(proofDir);
    assert.ok(profileDir);
    assert.ok(browsersDir);
    assert.equal(isPathInside(worktreePath, profileDir), false);
    assert.equal(isPathInside(worktreePath, browsersDir), false);
    await writeFile(join(proofDir, '390.png'), 'png-fixture\n', 'utf8');
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  try {
    const result = await runRunnerVisualProof({
      config: {
        ...validConfig,
        reviewGates: {
          ...validConfig.reviewGates,
          visualProof: {
            ...validConfig.reviewGates.visualProof,
            runnerValidationCommand: 'node visual-proof.mjs',
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
  } finally {
    if (previousTmpDir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpDir;
    }
  }
});

function isPathInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length === 0 || (!path.startsWith('..') && !isAbsolute(path));
}
