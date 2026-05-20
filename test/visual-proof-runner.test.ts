import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';

import type { ShellCommandExecutor } from '../src/process/command.js';
import { runRunnerVisualProof, type RunnerVisualProofResult } from '../src/runner/visual-proof-runner.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

test('runner visual proof reports screenshots that are updated by the command', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-target-'));
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));
  const proofDir = join(worktreePath, '.codex-orchestrator', 'proofs', 'issue-155');
  await mkdir(proofDir, { recursive: true });
  await writeFile(join(proofDir, '390.png'), 'previous screenshot\n', 'utf8');
  const previousFlutterBin = process.env.CODEX_ORCHESTRATOR_FLUTTER_BIN;
  process.env.CODEX_ORCHESTRATOR_FLUTTER_BIN = '/opt/flutter/bin/flutter';

  const shellExecutor: ShellCommandExecutor = async (_command, options) => {
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR, proofDir);
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_FLUTTER_BIN, '/opt/flutter/bin/flutter');
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_TARGET_ROOT, targetRoot);
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_STATE_DIR, join(targetRoot, validConfig.runner.stateDir));
    assert.equal(
      options?.env?.CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_DIR,
      join(targetRoot, validConfig.runner.stateDir, 'mobile-device-locks'),
    );
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
      targetRoot,
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

test('runner visual proof resolves package-owned CLI before ambient PATH entries', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));
  const previousPath = process.env.PATH;
  process.env.PATH = '/opt/homebrew/bin';

  const shellExecutor: ShellCommandExecutor = async (command, options) => {
    assert.equal(command, 'codex-orchestrator visual-proof mobile --issue 155');
    const pathEntries = (options?.env?.PATH ?? '').split(delimiter);
    const packageBinDir = pathEntries[0];
    assert.ok(packageBinDir);
    assert.notEqual(packageBinDir, '/opt/homebrew/bin');
    const shim = await readFile(join(packageBinDir, 'codex-orchestrator'), 'utf8');
    assert.match(shim, /cli\.js/);
    const cmdShim = await readFile(join(packageBinDir, 'codex-orchestrator.cmd'), 'utf8');
    assert.match(cmdShim, /cli\.js/);

    const proofReportPath = options?.env?.CODEX_ORCHESTRATOR_PROOF_REPORT_PATH;
    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    assert.ok(proofReportPath);
    assert.ok(proofDir);
    await writeFile(join(proofDir, 'smoke-output.txt'), 'smoke ok\n', 'utf8');
    await writeFile(proofReportPath, JSON.stringify({
      status: 'passed',
      criteria: [{
        id: 'ac-1',
        description: 'CLI smoke proves behavior.',
        status: 'passed',
        confidence: 'high',
        reasoningSummary: 'Smoke output matched the expected observable contract.',
        artifactRefs: ['.codex-orchestrator/proofs/issue-155/smoke-output.txt'],
      }],
      artifacts: [{
        type: 'smoke-output',
        path: '.codex-orchestrator/proofs/issue-155/smoke-output.txt',
        description: 'CLI smoke output',
      }],
      proofPhaseDiff: {
        allowedProofPaths: ['.codex-orchestrator/proofs/issue-155/smoke-output.txt'],
        forbiddenProductPaths: [],
      },
      residualRisks: [],
    }), 'utf8');
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  try {
    const result = await runRunnerVisualProof({
      config: validConfig,
      issue: issueFixture({ number: 155, title: '[UI] Acceptance proof for CLI smoke', body: 'Needs mobile visual proof.' }),
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
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

test('runner visual proof evaluates machine-readable acceptance proof reports', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-acceptance-proof-'));

  const shellExecutor: ShellCommandExecutor = async (_command, options) => {
    const proofReportPath = options?.env?.CODEX_ORCHESTRATOR_PROOF_REPORT_PATH;
    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    assert.ok(proofReportPath);
    assert.ok(proofDir);
    await writeFile(join(proofDir, 'smoke-output.txt'), 'smoke ok\n', 'utf8');
    await writeFile(proofReportPath, JSON.stringify({
      status: 'passed',
      criteria: [{
        id: 'ac-1',
        description: 'CLI smoke proves behavior.',
        status: 'passed',
        confidence: 'high',
        reasoningSummary: 'Smoke output matched the expected observable contract.',
        artifactRefs: ['.codex-orchestrator/proofs/issue-155/smoke-output.txt'],
      }],
      artifacts: [{
        type: 'smoke-output',
        path: '.codex-orchestrator/proofs/issue-155/smoke-output.txt',
        description: 'CLI smoke output',
      }],
      proofPhaseDiff: {
        allowedProofPaths: ['.codex-orchestrator/proofs/issue-155/smoke-output.txt'],
        forbiddenProductPaths: [],
      },
      residualRisks: [],
    }), 'utf8');
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  const result = await runRunnerVisualProof({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        acceptanceProof: {
          ...validConfig.reviewGates.acceptanceProof,
          runnerValidationCommand: 'node proof.mjs',
          issueTextPatterns: ['acceptance proof'],
        },
        visualProof: {
          ...validConfig.reviewGates.visualProof,
          issueTextPatterns: ['visual-only'],
        },
      },
    },
    issue: issueFixture({ number: 155, title: 'Acceptance proof for CLI smoke', body: 'Needs acceptance proof.' }),
    issueNumber: 155,
    worktreePath,
    changedFiles: ['src/cli.ts'],
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
  assert.match(result.validation[0]?.summary ?? '', /runner acceptance proof passed/);
  assert.deepEqual(result.artifacts, [{
    type: 'smoke-output',
    path: '.codex-orchestrator/proofs/issue-155/smoke-output.txt',
    description: 'CLI smoke output',
  }]);
});

test('runner visual proof fails when the command exits nonzero despite a passing report', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-acceptance-proof-'));

  const shellExecutor: ShellCommandExecutor = async (_command, options) => {
    const proofReportPath = options?.env?.CODEX_ORCHESTRATOR_PROOF_REPORT_PATH;
    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    assert.ok(proofReportPath);
    assert.ok(proofDir);
    await writeFile(join(proofDir, 'smoke-output.txt'), 'smoke failed late\n', 'utf8');
    await writeFile(proofReportPath, JSON.stringify({
      status: 'passed',
      criteria: [{
        id: 'ac-1',
        description: 'CLI smoke proves behavior.',
        status: 'passed',
        confidence: 'high',
        reasoningSummary: 'Smoke output matched the expected observable contract.',
        artifactRefs: ['.codex-orchestrator/proofs/issue-155/smoke-output.txt'],
      }],
      artifacts: [{
        type: 'smoke-output',
        path: '.codex-orchestrator/proofs/issue-155/smoke-output.txt',
        description: 'CLI smoke output',
      }],
      proofPhaseDiff: {
        allowedProofPaths: ['.codex-orchestrator/proofs/issue-155/smoke-output.txt'],
        forbiddenProductPaths: [],
      },
      residualRisks: [],
    }), 'utf8');
    return { stdout: '', stderr: 'late smoke failure', exitCode: 1 };
  };

  const result = await runRunnerVisualProof({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        acceptanceProof: {
          ...validConfig.reviewGates.acceptanceProof,
          runnerValidationCommand: 'node proof.mjs',
          issueTextPatterns: ['acceptance proof'],
        },
      },
    },
    issue: issueFixture({ number: 155, title: 'Acceptance proof for CLI smoke', body: 'Needs acceptance proof.' }),
    issueNumber: 155,
    worktreePath,
    changedFiles: ['src/cli.ts'],
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

  assert.equal(result.validation[0]?.status, 'failed');
  assert.match(result.validation[0]?.summary ?? '', /late smoke failure/);
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

test('runner visual proof resolves package-owned CLI before ambient PATH entries', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-visual-proof-'));
  const previousPath = process.env.PATH;
  process.env.PATH = ['/opt/homebrew/bin', '/usr/bin'].join(delimiter);

  const shellExecutor: ShellCommandExecutor = async (command, options) => {
    assert.equal(command, 'codex-orchestrator visual-proof mobile --issue 155');
    const pathEntries = String(options?.env?.PATH ?? '').split(delimiter);
    assert.match(pathEntries[0] ?? '', /codex-orchestrator-visual-proof-runtime/);
    assert.equal(pathEntries[1], '/opt/homebrew/bin');
    assert.equal((await stat(join(pathEntries[0] ?? '', 'codex-orchestrator'))).isFile(), true);
    assert.equal((await stat(join(pathEntries[0] ?? '', 'codex-orchestrator.cmd'))).isFile(), true);

    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    assert.ok(proofDir);
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
            runnerValidationCommand: 'codex-orchestrator visual-proof mobile --issue ${issueNumber}',
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
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

function isPathInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length === 0 || (!path.startsWith('..') && !isAbsolute(path));
}
