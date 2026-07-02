import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';

import type { ShellCommandExecutor } from '../src/process/command.js';
import { runAutoVisualProofCommand } from '../src/runner/auto-visual-proof-command.js';
import { runRunnerVisualProof, type RunnerVisualProofResult } from '../src/runner/visual-proof-runner.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

test('runner visual proof fails screenshot-only output without acceptance proof report', async () => {
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
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_BROWSER_CACHE_DIR, browsersDir);
    assert.equal(
      options?.env?.CODEX_ORCHESTRATOR_BROWSER_PROOF_SCENARIO_PATH,
      join(proofDir, 'browser-proof-scenario.json'),
    );
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_BROWSER_STRICT_CONSOLE, 'false');
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_BROWSER_STRICT_NETWORK, 'false');
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

  assert.equal(result.validation[0]?.status, 'failed');
  assert.match(result.validation[0]?.summary ?? '', /acceptance proof report/i);
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
    await writeUiProofReport(
      join(proofDir, 'acceptance-proof-report.json'),
      '.codex-orchestrator/proofs/issue-155/390.png',
    );
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
    assert.equal(command, 'codex-orchestrator visual-proof auto --issue 155');
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

test('runner visual proof exposes needs-rework acceptance proof evidence', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-acceptance-proof-'));

  const shellExecutor: ShellCommandExecutor = async (_command, options) => {
    const proofReportPath = options?.env?.CODEX_ORCHESTRATOR_PROOF_REPORT_PATH;
    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    assert.ok(proofReportPath);
    assert.ok(proofDir);
    await writeFile(join(proofDir, 'smoke-output.txt'), 'missing expected behavior\n', 'utf8');
    await writeFile(proofReportPath, JSON.stringify({
      status: 'needs-rework',
      criteria: [{
        id: 'ac-1',
        description: 'CLI smoke proves behavior.',
        status: 'failed',
        confidence: 'high',
        reasoningSummary: 'Smoke output shows the behavior is still missing.',
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
      reworkRequest: {
        summary: 'CLI behavior is still missing.',
        requiredChanges: ['Make the command print the expected value.'],
        evidenceRefs: ['.codex-orchestrator/proofs/issue-155/smoke-output.txt'],
      },
      residualRisks: ['proof is based on a local smoke fixture'],
    }), 'utf8');
    return { stdout: 'needs rework', stderr: '', exitCode: 0 };
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
  assert.equal(result.acceptanceProofAttempt?.status, 'needs-rework');
  assert.deepEqual(result.acceptanceProofAttempt?.artifactPaths, [
    '.codex-orchestrator/proofs/issue-155/smoke-output.txt',
  ]);
  assert.match(result.acceptanceProofAttempt?.blockers.join('\n') ?? '', /CLI behavior is still missing/);
  assert.deepEqual(result.acceptanceProofAttempt?.reworkRequest?.requiredChanges, [
    'Make the command print the expected value.',
  ]);
  assert.deepEqual(result.acceptanceProofAttempt?.residualRisks, ['proof is based on a local smoke fixture']);
});

test('runner visual proof accepts backend-only package-owned auto proof with an existing non-visual report', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-backend-proof-'));
  const proofDir = join(worktreePath, '.codex-orchestrator', 'proofs', 'issue-263');
  const proofReportPath = join(proofDir, 'acceptance-proof-report.json');
  await mkdir(proofDir, { recursive: true });
  await writeFile(join(proofDir, 'timing-smoke.txt'), 'scheduledCloseAt - openedAt = 3 minutes\n', 'utf8');
  await writeNonVisualProofReport(
    proofReportPath,
    '.codex-orchestrator/proofs/issue-263/timing-smoke.txt',
  );

  const shellExecutor: ShellCommandExecutor = async (command, options) => {
    assert.equal(command, 'codex-orchestrator visual-proof auto --issue 263');
    const result = await runAutoVisualProofCommand({
      args: ['--issue', '263'],
      config: validConfig,
      env: options?.env,
      browserRunner: async () => {
        throw new Error('browser proof should not run for backend-only acceptance proof');
      },
      mobileRunner: async () => {
        throw new Error('mobile proof should not run for backend-only acceptance proof');
      },
    });
    assert.equal(result.target, 'none');
    return { stdout: 'non-visual acceptance proof selected', stderr: '', exitCode: 0 };
  };

  const result = await runRunnerVisualProof({
    config: validConfig,
    issue: issueFixture({
      number: 263,
      title: 'Live match challenges: round 60 min - closing too fast',
      body: [
        'Final proof includes deterministic test evidence or a live/manual timing fixture.',
        'The backend API timing behavior is proven by smoke-output artifacts.',
      ].join('\n'),
    }),
    issueNumber: 263,
    worktreePath,
    changedFiles: [
      'src/live-challenges/live-challenges.service.ts',
      'src/live-challenges/live-challenges.service.spec.ts',
      'docs/agents/contract-test-ledger.md',
    ],
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
    path: '.codex-orchestrator/proofs/issue-263/timing-smoke.txt',
    description: 'backend timing smoke output',
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

test('runner visual proof blocks product-code changes reported by browser proof', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-browser-proof-'));

  const shellExecutor: ShellCommandExecutor = async (_command, options) => {
    const proofReportPath = options?.env?.CODEX_ORCHESTRATOR_PROOF_REPORT_PATH;
    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    assert.ok(proofReportPath);
    assert.ok(proofDir);
    await writeFile(join(proofDir, 'browser-summary.json'), 'summary\n', 'utf8');
    await writeFile(proofReportPath, JSON.stringify({
      status: 'passed',
      criteria: [{
        id: 'ac-1',
        description: 'Browser proof reached the expected page.',
        status: 'passed',
        confidence: 'high',
        reasoningSummary: 'Browser summary says the flow completed.',
        artifactRefs: ['.codex-orchestrator/proofs/issue-886/browser-summary.json'],
      }],
      artifacts: [{
        type: 'other',
        path: '.codex-orchestrator/proofs/issue-886/browser-summary.json',
        description: 'Browser proof run summary',
      }],
      proofPhaseDiff: {
        allowedProofPaths: ['.codex-orchestrator/proofs/issue-886/browser-summary.json'],
        forbiddenProductPaths: ['src/frontend/App.tsx'],
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
          runnerValidationCommand: 'codex-orchestrator visual-proof browser --issue ${issueNumber}',
          issueTextPatterns: ['browser proof'],
        },
      },
    },
    issue: issueFixture({ number: 886, title: 'Browser proof', body: 'Needs browser proof.' }),
    issueNumber: 886,
    worktreePath,
    changedFiles: ['src/frontend/App.tsx'],
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
  assert.match(result.validation[0]?.summary ?? '', /product-code changes during acceptance proof/);
  assert.match(result.validation[0]?.summary ?? '', /src\/frontend\/App\.tsx/);
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
    await writeUiProofReport(
      join(proofDir, 'acceptance-proof-report.json'),
      '.codex-orchestrator/proofs/issue-155/390.png',
    );
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
    assert.equal(command, 'codex-orchestrator visual-proof auto --issue 155');
    const pathEntries = String(options?.env?.PATH ?? '').split(delimiter);
    assert.match(pathEntries[0] ?? '', /codex-orchestrator-visual-proof-runtime/);
    assert.equal(pathEntries[1], '/opt/homebrew/bin');
    assert.equal((await stat(join(pathEntries[0] ?? '', 'codex-orchestrator'))).isFile(), true);
    assert.equal((await stat(join(pathEntries[0] ?? '', 'codex-orchestrator.cmd'))).isFile(), true);

    const proofDir = options?.env?.CODEX_ORCHESTRATOR_PROOF_DIR;
    assert.ok(proofDir);
    await writeFile(join(proofDir, '390.png'), 'png-fixture\n', 'utf8');
    await writeUiProofReport(
      join(proofDir, 'acceptance-proof-report.json'),
      '.codex-orchestrator/proofs/issue-155/390.png',
    );
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

async function writeNonVisualProofReport(reportPath: string, artifactRef: string): Promise<void> {
  await writeFile(reportPath, JSON.stringify({
    status: 'passed',
    criteria: [{
      id: 'ac-backend',
      description: 'Backend smoke proves the requested behavior.',
      status: 'passed',
      confidence: 'high',
      reasoningSummary: 'The deterministic smoke artifact records the observable backend result.',
      artifactRefs: [artifactRef],
    }],
    artifacts: [{
      type: 'smoke-output',
      path: artifactRef,
      description: 'backend timing smoke output',
    }],
    proofPhaseDiff: {
      allowedProofPaths: [artifactRef],
      forbiddenProductPaths: [],
    },
    residualRisks: [],
  }), 'utf8');
}

async function writeUiProofReport(reportPath: string, screenshotRef: string): Promise<void> {
  await writeFile(reportPath, JSON.stringify({
    status: 'passed',
    criteria: [{
      id: 'ac-ui',
      description: 'UI proof maps the requested screen to final screenshot evidence.',
      status: 'passed',
      confidence: 'high',
      reasoningSummary: 'The final screenshot shows the requested UI state with reviewed layout and copy.',
      artifactRefs: [screenshotRef],
    }],
    artifacts: [{
      type: 'screenshot',
      path: screenshotRef,
      description: 'final UI screenshot',
    }],
    uiEvidence: {
      workflowScope: {
        entrypoint: 'App launch',
        path: ['Open app', 'Navigate to target screen'],
        screenState: 'Target UI screen is visible',
        authPath: 'not-required',
      },
      viewportCoverage: [{
        name: 'wide desktop',
        width: 1440,
        height: 900,
        artifactRefs: [screenshotRef],
        requiredBy: 'desktop-web-layout',
      }],
      artifactFreshness: {
        currentArtifactRefs: [screenshotRef],
        checkedAfterFinalRun: true,
      },
      layoutReview: {
        checked: true,
        findings: [{ summary: 'Spacing, clipping, overlap, and alignment reviewed.', artifactRefs: [screenshotRef] }],
      },
      copyReview: {
        checked: true,
        findings: [{ summary: 'Visible copy is user-facing.', artifactRefs: [screenshotRef] }],
      },
      sourceInputs: {
        acceptanceCriteriaRefs: ['issue-ui-proof'],
        implementationEvidenceRefs: ['implementation-validation'],
      },
    },
    proofPhaseDiff: {
      allowedProofPaths: [screenshotRef],
      forbiddenProductPaths: [],
    },
    residualRisks: [],
  }), 'utf8');
}
