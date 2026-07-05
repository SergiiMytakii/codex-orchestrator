import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  planAcceptanceProofAttempt,
  runAcceptanceProofLoopAttempt,
  type AcceptanceProofAdapterResult,
  type AcceptanceProofPlan,
} from '../src/runner/acceptance-proof-loop.js';
import type { AcceptanceProofReport } from '../src/runner/acceptance-proof.js';
import { decideProofRouting } from '../src/runner/review-gate-policy.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

test('acceptance proof planning chooses adaptive proof when profile is available', () => {
  const plan = planAcceptanceProofAttempt({
    config: {
      ...validConfig,
      codex: {
        ...validConfig.codex,
        profiles: {
          'acceptance-proof': {},
        },
      },
    },
    issue: issueFixture({ number: 611, title: 'Acceptance proof for CLI', body: 'Needs acceptance proof.' }),
    changedFiles: ['src/cli.ts'],
    adaptiveAdapterAvailable: true,
  });

  assertPlan(plan, {
    kind: 'adaptive',
    applies: true,
    reason: 'adaptive acceptance proof is available',
  });
});

test('acceptance proof planning chooses adaptive proof when no runner command is configured', () => {
  const plan = planAcceptanceProofAttempt({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        acceptanceProof: {
          ...validConfig.reviewGates.acceptanceProof,
          runnerValidationCommand: undefined,
          issueTextPatterns: ['acceptance proof'],
        },
        visualProof: {
          ...validConfig.reviewGates.visualProof,
          runnerValidationCommand: undefined,
        },
      },
    },
    issue: issueFixture({ number: 612, title: 'Acceptance proof for API', body: 'Needs acceptance proof.' }),
    changedFiles: ['src/api/routes.ts'],
    adaptiveAdapterAvailable: true,
  });

  assertPlan(plan, {
    kind: 'adaptive',
    applies: true,
    reason: 'adaptive acceptance proof is available',
  });
});

test('acceptance proof planning chooses command proof when runner command is configured', () => {
  const plan = planAcceptanceProofAttempt({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        acceptanceProof: {
          ...validConfig.reviewGates.acceptanceProof,
          runnerValidationCommand: 'npm run acceptance-proof',
          issueTextPatterns: ['acceptance proof'],
        },
      },
    },
    issue: issueFixture({ number: 613, title: 'Acceptance proof for backend', body: 'Needs acceptance proof.' }),
    changedFiles: ['src/api/routes.ts'],
    adaptiveAdapterAvailable: false,
  });

  assertPlan(plan, {
    kind: 'command',
    applies: true,
    reason: 'runner-owned acceptance proof command is available',
    commandTemplate: 'npm run acceptance-proof',
  });
});

test('acceptance proof planning skips non-applicable and unavailable proof', () => {
  const nonApplicable = planAcceptanceProofAttempt({
    config: validConfig,
    issue: issueFixture({ number: 614, title: 'Docs cleanup', body: 'Update wording only.' }),
    changedFiles: ['docs/readme.md'],
    adaptiveAdapterAvailable: true,
  });
  const unavailable = planAcceptanceProofAttempt({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        acceptanceProof: {
          ...validConfig.reviewGates.acceptanceProof,
          runnerValidationCommand: undefined,
          issueTextPatterns: ['acceptance proof'],
        },
        visualProof: {
          ...validConfig.reviewGates.visualProof,
          runnerValidationCommand: undefined,
        },
      },
    },
    issue: issueFixture({ number: 615, title: 'Acceptance proof missing runner', body: 'Needs acceptance proof.' }),
    changedFiles: ['src/api/routes.ts'],
    adaptiveAdapterAvailable: false,
  });
  const nonVisual = planAcceptanceProofAttempt({
    config: validConfig,
    issue: issueFixture({
      number: 616,
      title: 'Analytics smoke proof',
      body: 'Proof Strategy: non-visual-smoke\nUse deterministic smoke output.',
    }),
    changedFiles: ['src/api/routes.ts'],
    adaptiveAdapterAvailable: true,
  });

  assertPlan(nonApplicable, {
    kind: 'skip',
    applies: false,
    reason: 'acceptance proof does not apply',
  });
  assertPlan(unavailable, {
    kind: 'skip',
    applies: true,
    reason: 'acceptance proof applies but no adaptive adapter or runner command is available',
  });
  assertPlan(nonVisual, {
    kind: 'skip',
    applies: false,
    reason: 'proof strategy disables browser/mobile visual proof',
  });
});

test('review-gate routing delegates to acceptance proof planning semantics', () => {
  assert.deepEqual(decideProofRouting({
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        acceptanceProof: {
          ...validConfig.reviewGates.acceptanceProof,
          runnerValidationCommand: 'npm run acceptance-proof',
          changedPathGlobs: ['src/api/**'],
        },
      },
    },
    issue: issueFixture({ number: 617, title: 'Backend API smoke proof', body: 'Acceptance proof by API smoke output.' }),
    changedFiles: ['src/api/routes.ts'],
  }), {
    applies: true,
    desirable: false,
    dispatchTarget: 'none',
    proofStrategy: 'auto',
    action: 'allow-non-visual',
    reason: 'acceptance proof applies without browser or mobile dispatch',
  });
});

test('acceptance proof loop passes command proof with a valid proof report', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-proof-loop-'));
  const proof = await proofPaths(worktreePath, 620);

  const result = await runAcceptanceProofLoopAttempt({
    config: commandProofConfig(),
    issue: issueFixture({ number: 620, title: 'Acceptance proof command', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: [],
    adaptiveAdapterAvailable: false,
    executeCommandProof: async () => {
      await writeFile(join(proof.artifactDir, 'smoke-output.txt'), 'ok\n', 'utf8');
      await writeFile(proof.reportPath, JSON.stringify(passingReport(proof.smokeArtifactPath)), 'utf8');
      return commandResult(proof, { artifactPaths: [proof.smokeArtifactPath] });
    },
    collectChangeSet: async () => ({
      changedPaths: [proof.smokeArtifactPath],
      commits: [],
      hasChanges: true,
    }),
    evaluateScope: () => ({ blockers: [] }),
    artifactExists: (path) => existsSync(join(worktreePath, path)),
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, [proof.smokeArtifactPath]);
  assert.equal(result.evidence?.status, 'passed');
  assert.equal(result.validation[0]?.status, 'passed');
  assert.deepEqual(result.scopeBlockers, []);
});

test('acceptance proof loop blocks screenshot-only command proof without a report', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-proof-loop-'));
  const proof = await proofPaths(worktreePath, 621);
  const screenshotPath = '.codex-orchestrator/proofs/issue-621/390.png';

  const result = await runAcceptanceProofLoopAttempt({
    config: commandProofConfig(),
    issue: issueFixture({ number: 621, title: 'Acceptance proof screenshot', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: [],
    adaptiveAdapterAvailable: false,
    executeCommandProof: async () => {
      await writeFile(join(worktreePath, screenshotPath), 'image\n', 'utf8');
      return commandResult(proof, {
        artifactPaths: [screenshotPath],
        preliminaryArtifacts: [{ type: 'screenshot', path: screenshotPath, description: 'runner visual proof 390.png' }],
      });
    },
    collectChangeSet: async () => ({
      changedPaths: [screenshotPath],
      commits: [],
      hasChanges: true,
    }),
    evaluateScope: () => ({ blockers: [] }),
    artifactExists: (path) => existsSync(join(worktreePath, path)),
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.blockers.join('\n'), /CODEX_ORCHESTRATOR_PROOF_REPORT_PATH/i);
  assert.equal(result.evidence?.status, 'blocked');
  assert.deepEqual(result.artifacts, [{ type: 'screenshot', path: screenshotPath, description: 'runner visual proof 390.png' }]);
});

test('acceptance proof loop keeps command failure blockers when no report is written', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-proof-loop-'));
  const proof = await proofPaths(worktreePath, 626);

  const result = await runAcceptanceProofLoopAttempt({
    config: commandProofConfig(),
    issue: issueFixture({ number: 626, title: 'Acceptance proof command missing', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: [],
    adaptiveAdapterAvailable: false,
    executeCommandProof: async () => commandResult(proof, {
      exitCode: 1,
      outputSummary: 'missing proof script',
    }),
    collectChangeSet: async () => ({
      changedPaths: [],
      commits: [],
      hasChanges: false,
    }),
    evaluateScope: () => ({ blockers: [] }),
    artifactExists: (path) => existsSync(join(worktreePath, path)),
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.blockers.join('\n'), /runner acceptance proof failed: missing proof script/);
  assert.match(result.validation[0]?.summary ?? '', /CODEX_ORCHESTRATOR_PROOF_REPORT_PATH/);
});

test('acceptance proof loop blocks nonzero command exit despite a passing report', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-proof-loop-'));
  const proof = await proofPaths(worktreePath, 622);

  const result = await runAcceptanceProofLoopAttempt({
    config: commandProofConfig(),
    issue: issueFixture({ number: 622, title: 'Acceptance proof command exit', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: [],
    adaptiveAdapterAvailable: false,
    executeCommandProof: async () => {
      await writeFile(join(proof.artifactDir, 'smoke-output.txt'), 'ok\n', 'utf8');
      await writeFile(proof.reportPath, JSON.stringify(passingReport(proof.smokeArtifactPath)), 'utf8');
      return commandResult(proof, {
        artifactPaths: [proof.smokeArtifactPath],
        exitCode: 1,
        outputSummary: 'proof command failed after writing report',
      });
    },
    collectChangeSet: async () => ({
      changedPaths: [proof.smokeArtifactPath],
      commits: [],
      hasChanges: true,
    }),
    evaluateScope: () => ({ blockers: [] }),
    artifactExists: (path) => existsSync(join(worktreePath, path)),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.evidence?.status, 'blocked');
  assert.match(result.validation[0]?.summary ?? '', /proof command failed/);
});

test('acceptance proof loop classifies proof-owned and forbidden proof-phase diffs', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-proof-loop-'));
  const proof = await proofPaths(worktreePath, 623);
  await mkdir(join(worktreePath, 'src'), { recursive: true });
  await writeFile(join(worktreePath, 'src/feature.ts'), 'export const feature = "before";\n', 'utf8');

  const result = await runAcceptanceProofLoopAttempt({
    config: commandProofConfig(),
    issue: issueFixture({ number: 623, title: 'Acceptance proof product diff', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: ['src/feature.ts'],
    adaptiveAdapterAvailable: false,
    executeCommandProof: async () => {
      await writeFile(join(worktreePath, 'src/feature.ts'), 'export const feature = "proof changed";\n', 'utf8');
      await writeFile(join(proof.artifactDir, 'smoke-output.txt'), 'ok\n', 'utf8');
      await writeFile(proof.reportPath, JSON.stringify(passingReport(proof.smokeArtifactPath)), 'utf8');
      return commandResult(proof, { artifactPaths: [proof.smokeArtifactPath] });
    },
    collectChangeSet: async () => ({
      changedPaths: ['src/feature.ts', proof.smokeArtifactPath],
      commits: [],
      hasChanges: true,
    }),
    evaluateScope: () => ({ blockers: [] }),
    artifactExists: (path) => existsSync(join(worktreePath, path)),
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.blockers.join('\n'), /product-code changes during acceptance proof/i);
  assert.match(result.blockers.join('\n'), /src\/feature\.ts/);
  assert.deepEqual(result.evidence?.artifactPaths, [proof.smokeArtifactPath, 'src/feature.ts']);
});

test('acceptance proof loop evaluates scope blockers against full final changed paths', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-proof-loop-'));
  const proof = await proofPaths(worktreePath, 624);
  await mkdir(join(worktreePath, 'docs'), { recursive: true });
  await writeFile(join(worktreePath, 'docs/other.md'), 'already changed before proof\n', 'utf8');

  const result = await runAcceptanceProofLoopAttempt({
    config: commandProofConfig(),
    issue: issueFixture({ number: 624, title: 'Acceptance proof scope', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: ['docs/other.md'],
    adaptiveAdapterAvailable: false,
    executeCommandProof: async () => {
      await writeFile(join(proof.artifactDir, 'smoke-output.txt'), 'ok\n', 'utf8');
      await writeFile(proof.reportPath, JSON.stringify(passingReport(proof.smokeArtifactPath)), 'utf8');
      return commandResult(proof, { artifactPaths: [proof.smokeArtifactPath] });
    },
    collectChangeSet: async () => ({
      changedPaths: ['docs/other.md', proof.smokeArtifactPath],
      commits: [],
      hasChanges: true,
    }),
    evaluateScope: ({ changedFiles }) => ({
      blockers: changedFiles.includes('docs/other.md') ? ['Changed file docs/other.md is outside issue ownership scope.'] : [],
    }),
    artifactExists: (path) => existsSync(join(worktreePath, path)),
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.scopeBlockers, ['Changed file docs/other.md is outside issue ownership scope.']);
  assert.match(result.blockers.join('\n'), /outside issue ownership scope/);
  assert.equal(result.evidence?.status, 'blocked');
  assert.match(result.evidence?.blockers.join('\n') ?? '', /outside issue ownership scope/);
});

test('acceptance proof loop gives adaptive proof the same evidence vocabulary as command proof', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-proof-loop-'));
  const proof = await proofPaths(worktreePath, 625);

  const missing = await runAcceptanceProofLoopAttempt({
    config: adaptiveProofConfig(),
    issue: issueFixture({ number: 625, title: 'Acceptance proof adaptive missing', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: [],
    adaptiveAdapterAvailable: true,
    executeAdaptiveProof: async () => adaptiveResult(proof),
    collectChangeSet: async () => ({ changedPaths: [], commits: [], hasChanges: false }),
    evaluateScope: () => ({ blockers: [] }),
  });

  assert.equal(missing.status, 'blocked');
  assert.equal(missing.evidence?.status, 'blocked');
  assert.match(missing.blockers.join('\n'), /CODEX_ORCHESTRATOR_PROOF_REPORT_PATH/);

  await writeFile(proof.reportPath, '{"status":"passed"}', 'utf8');
  const invalid = await runAcceptanceProofLoopAttempt({
    config: adaptiveProofConfig(),
    issue: issueFixture({ number: 625, title: 'Acceptance proof adaptive invalid', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: [],
    adaptiveAdapterAvailable: true,
    executeAdaptiveProof: async () => adaptiveResult(proof),
    collectChangeSet: async () => ({ changedPaths: [], commits: [], hasChanges: false }),
    evaluateScope: () => ({ blockers: [] }),
  });

  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.evidence?.status, 'blocked');
  assert.match(invalid.blockers.join('\n'), /criteria must be an array/);

  const needsReworkReport = {
    ...passingReport(proof.smokeArtifactPath),
    status: 'needs-rework' as const,
    criteria: [{
      ...passingReport(proof.smokeArtifactPath).criteria[0]!,
      status: 'failed' as const,
      reasoningSummary: 'The expected behavior is still missing.',
    }],
    reworkRequest: {
      summary: 'Behavior is still missing.',
      requiredChanges: ['Implement the missing behavior.'],
      evidenceRefs: [proof.smokeArtifactPath],
    },
  };
  await writeFile(join(proof.artifactDir, 'smoke-output.txt'), 'missing behavior\n', 'utf8');
  await writeFile(proof.reportPath, JSON.stringify(needsReworkReport), 'utf8');
  const needsRework = await runAcceptanceProofLoopAttempt({
    config: adaptiveProofConfig(),
    issue: issueFixture({ number: 625, title: 'Acceptance proof adaptive needs rework', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: [],
    adaptiveAdapterAvailable: true,
    executeAdaptiveProof: async () => adaptiveResult(proof, { artifactPaths: [proof.smokeArtifactPath] }),
    collectChangeSet: async () => ({ changedPaths: [proof.smokeArtifactPath], commits: [], hasChanges: true }),
    evaluateScope: () => ({ blockers: [] }),
    artifactExists: (path) => existsSync(join(worktreePath, path)),
  });

  assert.equal(needsRework.status, 'blocked');
  assert.equal(needsRework.evidence?.status, 'needs-rework');
  assert.deepEqual(needsRework.evidence?.reworkRequest?.requiredChanges, ['Implement the missing behavior.']);

  await writeFile(proof.reportPath, JSON.stringify(passingReport(proof.smokeArtifactPath)), 'utf8');
  const passed = await runAcceptanceProofLoopAttempt({
    config: adaptiveProofConfig(),
    issue: issueFixture({ number: 625, title: 'Acceptance proof adaptive passed', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: [],
    adaptiveAdapterAvailable: true,
    executeAdaptiveProof: async () => adaptiveResult(proof, { artifactPaths: [proof.smokeArtifactPath] }),
    collectChangeSet: async () => ({ changedPaths: [proof.smokeArtifactPath], commits: [], hasChanges: true }),
    evaluateScope: () => ({ blockers: [] }),
    artifactExists: (path) => existsSync(join(worktreePath, path)),
  });

  assert.equal(passed.status, 'passed');
  assert.equal(passed.evidence?.status, 'passed');
});

test('acceptance proof loop preserves legacy visual command without expanding proof-owned paths', async () => {
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-orchestrator-proof-loop-'));
  const proof = await proofPaths(worktreePath, 626);
  await mkdir(join(worktreePath, 'src'), { recursive: true });
  await writeFile(join(worktreePath, 'src/feature.ts'), 'export const feature = "before";\n', 'utf8');

  const result = await runAcceptanceProofLoopAttempt({
    config: {
      ...commandProofConfig(),
      reviewGates: {
        ...commandProofConfig().reviewGates,
        acceptanceProof: {
          ...commandProofConfig().reviewGates.acceptanceProof,
          runnerValidationCommand: 'codex-orchestrator visual-proof mobile --issue ${issueNumber}',
          proofOwnedPathGlobs: ['.codex-orchestrator/proofs/**'],
        },
        visualProof: {
          ...commandProofConfig().reviewGates.visualProof,
          runnerValidationCommand: 'node legacy-visual-proof.mjs',
        },
      },
    },
    issue: issueFixture({ number: 626, title: 'Acceptance proof legacy visual', body: 'Needs acceptance proof.' }),
    worktreePath,
    beforeHead: 'before',
    initialChangedFiles: ['src/feature.ts'],
    adaptiveAdapterAvailable: false,
    executeCommandProof: async () => {
      await writeFile(join(worktreePath, 'src/feature.ts'), 'export const feature = "legacy proof changed";\n', 'utf8');
      await writeFile(join(proof.artifactDir, 'smoke-output.txt'), 'ok\n', 'utf8');
      await writeFile(proof.reportPath, JSON.stringify(passingReport(proof.smokeArtifactPath)), 'utf8');
      return commandResult(proof, {
        command: 'node legacy-visual-proof.mjs',
        artifactPaths: [proof.smokeArtifactPath],
      });
    },
    collectChangeSet: async () => ({
      changedPaths: ['src/feature.ts', proof.smokeArtifactPath],
      commits: [],
      hasChanges: true,
    }),
    evaluateScope: () => ({ blockers: [] }),
    artifactExists: (path) => existsSync(join(worktreePath, path)),
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.blockers.join('\n'), /product-code changes during acceptance proof/);
  assert.match(result.evidence?.validation[0]?.command ?? '', /legacy-visual-proof/);
});

function assertPlan(actual: AcceptanceProofPlan, expected: AcceptanceProofPlan): void {
  assert.deepEqual(actual, expected);
}

function commandProofConfig() {
  return {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      acceptanceProof: {
        ...validConfig.reviewGates.acceptanceProof,
        runnerValidationCommand: 'node proof.mjs',
        issueTextPatterns: ['acceptance proof'],
        changedPathGlobs: ['src/**'],
        proofOwnedPathGlobs: ['.codex-orchestrator/proofs/**'],
      },
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        runnerValidationCommand: 'node proof.mjs',
        issueTextPatterns: ['acceptance proof'],
        changedPathGlobs: ['src/**'],
      },
    },
  };
}

function adaptiveProofConfig() {
  return {
    ...commandProofConfig(),
    codex: {
      ...validConfig.codex,
      profiles: {
        'acceptance-proof': {},
      },
    },
    reviewGates: {
      ...commandProofConfig().reviewGates,
      acceptanceProof: {
        ...commandProofConfig().reviewGates.acceptanceProof,
        runnerValidationCommand: undefined,
      },
      visualProof: {
        ...commandProofConfig().reviewGates.visualProof,
        runnerValidationCommand: undefined,
      },
    },
  };
}

async function proofPaths(worktreePath: string, issueNumber: number): Promise<{
  artifactDir: string;
  reportPath: string;
  smokeArtifactPath: string;
}> {
  const artifactDir = join(worktreePath, '.codex-orchestrator/proofs', `issue-${issueNumber}`);
  await mkdir(artifactDir, { recursive: true });
  return {
    artifactDir,
    reportPath: join(artifactDir, 'acceptance-proof-report.json'),
    smokeArtifactPath: `.codex-orchestrator/proofs/issue-${issueNumber}/smoke-output.txt`,
  };
}

function commandResult(
  proof: { artifactDir: string; reportPath: string },
  overrides: Partial<AcceptanceProofAdapterResult> = {},
): AcceptanceProofAdapterResult {
  return {
    adapterKind: 'command',
    command: 'node proof.mjs',
    exitCode: 0,
    outputSummary: 'proof ok',
    reportPath: proof.reportPath,
    artifactDir: proof.artifactDir,
    artifactPaths: [],
    preliminaryArtifacts: [],
    residualRisks: [],
    ...overrides,
  };
}

function adaptiveResult(
  proof: { artifactDir: string; reportPath: string },
  overrides: Partial<AcceptanceProofAdapterResult> = {},
): AcceptanceProofAdapterResult {
  return {
    ...commandResult(proof, overrides),
    adapterKind: 'adaptive',
    command: 'adaptive acceptance proof',
  };
}

function passingReport(artifactPath: string): AcceptanceProofReport {
  return {
    status: 'passed',
    criteria: [{
      id: 'ac-1',
      description: 'Smoke output proves behavior.',
      status: 'passed',
      confidence: 'high',
      reasoningSummary: 'The smoke output contains the expected value.',
      artifactRefs: [artifactPath],
    }],
    artifacts: [{
      type: 'smoke-output',
      path: artifactPath,
      description: 'CLI smoke output',
    }],
    proofPhaseDiff: {
      allowedProofPaths: [artifactPath],
      forbiddenProductPaths: [],
    },
    residualRisks: [],
  };
}
