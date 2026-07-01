import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  buildIssueTreeChildPrompt,
  buildPlanAutoPrompt,
  buildScopedImplementationPrompt,
  readPlanAutoCompletionReport,
  readScopedCompletionReport,
  sessionPromptPath,
  sessionReportPath,
  writeDurablePrompt,
} from '../src/runner/prompt.js';
import {
  buildQualityGatePromptLines,
  buildVisualProofPromptLines,
} from '../src/runner/review-gate-policy.js';
import { validConfig } from './fixtures/config.js';
import { commentFixture, issueFixture } from './fixtures/issues.js';

test('prompt builder includes issue context, workflow, publication, safety, and report contract', () => {
  const prompt = buildScopedImplementationPrompt({
    issue: issueFixture({
      number: 155,
      labels: ['agent:auto'],
      body: 'Implement this',
      comments: [commentFixture({ body: 'Maintainer note', createdAt: '2026-05-08T10:00:00.000Z' })],
    }),
    config: validConfig,
    workflowPromptText: 'Workflow text',
    promptPath: '/prompt.md',
    reportPath: '/report.json',
    branchName: 'codex/issue-155',
    worktreePath: '/worktree',
  });

  assert.match(prompt, /# Codex Orchestrator Scoped Implementation/);
  assert.match(prompt, /## Issue Context/);
  assert.match(prompt, /Implement this/);
  assert.match(prompt, /Maintainer note/);
  assert.match(prompt, /## Project Workflow\n\nWorkflow text/);
  assert.match(prompt, /Runner-Owned Publication Contract/);
  assert.match(prompt, /Safety Contract/);
  assert.match(prompt, /curl --max-time/);
  assert.match(prompt, /Completion Report Contract/);
  assert.match(prompt, /Quality Gate Contract/);
  assert.match(prompt, /TDD red-to-green/);
  assert.match(prompt, /cleanup-review/);
  assert.match(prompt, /code-review/);
  assert.match(prompt, /Flow Selection Contract/);
  assert.match(prompt, /\$small-task-implementer/);
  assert.match(prompt, /needs-promotion/);
  assert.match(prompt, /Review Handoff Contract/);
  assert.match(prompt, /reviewHandoff/);
});

test('prompt builder uses review-gate policy contract lines', async () => {
  const config = {
    ...validConfig,
    reviewGates: {
      ...validConfig.reviewGates,
      quality: {
        ...validConfig.reviewGates.quality,
        runtimeChangedPathGlobs: ['src/runtime/**/*.ts'],
        testChangedPathGlobs: ['test/runtime/**/*.test.ts'],
        cleanupReview: {
          ...validConfig.reviewGates.quality.cleanupReview,
          runtimeFileThreshold: 4,
        },
      },
      visualProof: {
        ...validConfig.reviewGates.visualProof,
        artifactDir: '.proofs',
        runnerValidationCommand: 'node .proofs/issue-${issueNumber}/visual-proof.mjs',
        envPassthrough: ['LOGIN_EMAIL'],
      },
    },
  };
  const prompt = buildScopedImplementationPrompt({
    issue: issueFixture({ number: 155, labels: ['agent:auto'], body: 'Fix UI overlap' }),
    config,
    workflowPromptText: 'Workflow text',
    promptPath: '/prompt.md',
    reportPath: '/report.json',
    branchName: 'codex/issue-155',
    worktreePath: '/worktree',
  });

  for (const line of buildQualityGatePromptLines(config)) {
    assert.match(prompt, new RegExp(escapeRegExp(line)));
  }
  for (const line of buildVisualProofPromptLines(config, 155)) {
    assert.match(prompt, new RegExp(escapeRegExp(line)));
  }

  const source = await readFile('src/runner/prompt.ts', 'utf8');
  assert.doesNotMatch(source, /function qualityGatePromptLines/);
  assert.doesNotMatch(source, /function visualProofPromptLines/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('prompt builder keeps shell-like issue text inert and literal', () => {
  const maliciousText = '$(touch /tmp/owned) `touch /tmp/owned` ${reportPath}; gh pr create';
  const prompt = buildScopedImplementationPrompt({
    issue: issueFixture({
      number: 155,
      labels: ['agent:auto'],
      title: maliciousText,
      body: maliciousText,
      comments: [commentFixture({ body: maliciousText, createdAt: '2026-05-08T10:00:00.000Z' })],
    }),
    config: validConfig,
    workflowPromptText: 'Workflow text',
    promptPath: '/prompt.md',
    reportPath: '/report.json',
    branchName: 'codex/issue-155',
    worktreePath: '/worktree',
  });

  assert.match(prompt, /\$\(touch \/tmp\/owned\)/);
  assert.match(prompt, /`touch \/tmp\/owned`/);
  assert.match(prompt, /\$\{reportPath\}/);
  assert.match(prompt, /; gh pr create/);
});

test('prompt builder tells child Codex to prepare runner-owned visual proof without running it', () => {
  const prompt = buildScopedImplementationPrompt({
    issue: issueFixture({
      number: 155,
      labels: ['agent:auto'],
      body: 'Fix UI overlap',
    }),
    config: {
      ...validConfig,
      reviewGates: {
        ...validConfig.reviewGates,
        visualProof: {
          ...validConfig.reviewGates.visualProof,
          runnerValidationCommand: 'node .codex-orchestrator/proofs/issue-${issueNumber}/visual-proof.mjs',
          envPassthrough: ['CODEX_ORCHESTRATOR_LOGIN_EMAIL', 'CODEX_ORCHESTRATOR_LOGIN_PASSWORD'],
        },
      },
    },
    workflowPromptText: 'Workflow text',
    promptPath: '/prompt.md',
    reportPath: '/report.json',
    branchName: 'codex/issue-155',
    worktreePath: '/worktree',
  });

  assert.match(prompt, /runner will execute this visual proof command outside the child Codex sandbox/);
  assert.match(prompt, /do not execute this runner-owned command yourself/);
  assert.match(prompt, /For browser\/web UI work, prefer Playwright-based screenshot proof via the runner-owned command/);
  assert.match(prompt, /primary visual proof path/);
  assert.match(prompt, /Do not report browser tool unavailability as a skipped check/);
  assert.match(prompt, /focused visual proof script with concrete assertions can be the TDD evidence/);
  assert.match(prompt, /Do not claim the runner-owned visual proof passed/);
  assert.match(prompt, /CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR/);
  assert.match(prompt, /CODEX_ORCHESTRATOR_LOGIN_EMAIL, CODEX_ORCHESTRATOR_LOGIN_PASSWORD/);
  assert.match(prompt, /never hardcode credentials/);
});

test('prompt builder directs Android mobile proof to Test Android Apps with non-blocking device fallback', () => {
  const prompt = buildScopedImplementationPrompt({
    issue: issueFixture({
      number: 155,
      labels: ['agent:auto'],
      title: 'Validate Android checkout screen',
      body: 'Fix the mobile app checkout UI and verify it on Android.',
    }),
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
    workflowPromptText: 'Workflow text',
    promptPath: '/prompt.md',
    reportPath: '/report.json',
    branchName: 'codex/issue-155',
    worktreePath: '/worktree',
  });

  assert.match(prompt, /For Android mobile app UI work, use runner-owned device-backed proof/);
  assert.match(prompt, /Do not start Android emulators from child Codex/);
  assert.match(prompt, /serializes shared adb\/emulator access/);
  assert.match(prompt, /document the desired `ANDROID_SERIAL` value/);
  assert.match(prompt, /leave device selection and emulator startup to the runner-owned proof command/);
  assert.match(prompt, /If Test Android Apps skills are unavailable/);
  assert.match(prompt, /try to enable or load that plugin/);
  assert.match(prompt, /When a target is already selected by the runner or provided through the environment/);
  assert.match(prompt, /For native Android projects/);
  assert.match(prompt, /use the project Gradle wrapper/);
  assert.match(prompt, /`\.\/gradlew`/);
  assert.match(prompt, /For Flutter Android projects only/);
  assert.match(prompt, /start Flutter rebuild\/install with the detected Flutter SDK/);
  assert.match(prompt, /If rebuild\/install fails because the SDK cache is read-only/);
  assert.match(prompt, /`CODEX_ORCHESTRATOR_FLUTTER_ROOT`/);
  assert.match(prompt, /`FLUTTER_ROOT`/);
  assert.match(prompt, /`PUB_CACHE`/);
  assert.match(prompt, /`GRADLE_USER_HOME`/);
  assert.match(prompt, /`flutter precache --android`/);
  assert.match(prompt, /copyReview/);
  assert.match(prompt, /Do not use Playwright as the primary proof path for Android mobile app verification/);
  assert.match(prompt, /If Test Android Apps cannot be enabled, or no usable Android device or emulator is available/);
  assert.match(prompt, /concrete plugin or adb\/emulator reason/);
});

test('prompt builder gives native iOS proof a separate Xcode path', () => {
  const prompt = buildScopedImplementationPrompt({
    issue: issueFixture({
      number: 156,
      labels: ['agent:auto'],
      title: 'Validate iOS checkout screen',
      body: 'Fix the native iOS checkout UI and verify it on a simulator.',
    }),
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
    workflowPromptText: 'Workflow text',
    promptPath: '/prompt.md',
    reportPath: '/report.json',
    branchName: 'codex/issue-156',
    worktreePath: '/worktree',
  });

  assert.match(prompt, /For native iOS app UI work/);
  assert.match(prompt, /`xcrun simctl list devices available`/);
  assert.match(prompt, /`xcodebuild`/);
  assert.match(prompt, /`-derivedDataPath`/);
  assert.match(prompt, /`xcrun simctl install`/);
  assert.match(prompt, /`xcrun simctl launch`/);
  assert.match(prompt, /Do not use Android or Flutter proof steps for native iOS projects/);
});

test('package scoped workflow prompt requires strict TDD and review gates', async () => {
  const prompt = await readFile('prompts/workflows/scoped-implementation.md', 'utf8');

  assert.match(prompt, /Small Task Implementer/);
  assert.match(prompt, /\$small-task-implementer/);
  assert.match(prompt, /Task Sizing/);
  assert.match(prompt, /TDD red-to-green/);
  assert.match(prompt, /test fails before implementation/);
  assert.match(prompt, /passes after implementation/);
  assert.match(prompt, /cleanup-review/);
  assert.match(prompt, /code-review/);
  assert.match(prompt, /Review Handoff/);
});

test('package workflow prompts are full bundled workflows, not fallback stubs', async () => {
  const prompts = {
    prd: await readFile('prompts/workflows/prd.md', 'utf8'),
    issueBreakdown: await readFile('prompts/workflows/issue-breakdown.md', 'utf8'),
    breakdownReview: await readFile('prompts/workflows/breakdown-review.md', 'utf8'),
    triage: await readFile('prompts/workflows/triage.md', 'utf8'),
    scopedImplementation: await readFile('prompts/workflows/scoped-implementation.md', 'utf8'),
    issueTreeOrchestration: await readFile('prompts/workflows/issue-tree-orchestration.md', 'utf8'),
  };

  for (const prompt of Object.values(prompts)) {
    assert.doesNotMatch(prompt, /Workflow Fallback/);
  }
  assert.match(prompts.prd, /Problem Statement/);
  assert.match(prompts.prd, /Testing Decisions/);
  assert.match(prompts.prd, /Risk And Proof/);
  assert.match(prompts.issueBreakdown, /Spec required: none \/ issue-level \/ wave-level/);
  assert.match(prompts.issueBreakdown, /Size \/ Risk/);
  assert.match(prompts.issueBreakdown, /small-task-implementer/);
  assert.match(prompts.issueBreakdown, /issue-breakdown-review/);
  assert.match(prompts.breakdownReview, /Risk\/proof routing/);
  assert.match(prompts.breakdownReview, /Tracer-bullet quality/);
  assert.match(prompts.triage, /This was generated by AI during triage/);
  assert.match(prompts.triage, /Agent Brief/);
  assert.match(prompts.scopedImplementation, /Spec Implementer/);
  assert.match(prompts.issueTreeOrchestration, /Issue Orchestrator/);
  assert.match(prompts.issueTreeOrchestration, /Parent Risk\/Proof Mini-Report/);
});

test('plan-auto prompt includes parent context and all planning workflows', () => {
  const prompt = buildPlanAutoPrompt({
    parentIssue: issueFixture({
      number: 156,
      labels: ['agent:plan-auto'],
      body: 'Plan this feature',
      comments: [commentFixture({ body: 'Maintainer context', createdAt: '2026-05-08T10:00:00.000Z' })],
    }),
    config: validConfig,
    prompts: {
      prd: 'PRD prompt',
      issueBreakdown: 'Breakdown prompt',
      breakdownReview: 'Review prompt',
      triage: 'Triage prompt',
    },
    promptPath: '/prompt.md',
    reportPath: '/report.json',
    branchName: 'codex/tree-156',
    worktreePath: '/worktree',
  });

  assert.match(prompt, /# Codex Orchestrator Parent Planning/);
  assert.match(prompt, /## Parent Issue Context/);
  assert.match(prompt, /Plan this feature/);
  assert.match(prompt, /Maintainer context/);
  assert.match(prompt, /## PRD Workflow\n\nPRD prompt/);
  assert.match(prompt, /## Issue Breakdown Workflow\n\nBreakdown prompt/);
  assert.match(prompt, /## Breakdown Review Workflow\n\nReview prompt/);
  assert.match(prompt, /## Triage Workflow\n\nTriage prompt/);
  assert.match(prompt, /Runner-Owned GitHub Contract/);
  assert.match(prompt, /Autonomous Child Contract/);
  assert.match(prompt, /Planning Risk\/Proof Contract/);
  assert.match(prompt, /sizeRisk/);
  assert.match(prompt, /parentReviewHandoff/);
  assert.match(prompt, /Arbitrary links, milestones, projects, and comments do not grant membership/);
  assert.match(prompt, /Schema: \{ "status": "completed"/);
  assert.match(prompt, /\/report\.json/);
});

test('issue-tree child prompt includes parent, child, dependencies, workflow, safety, and scoped report contract', () => {
  const prompt = buildIssueTreeChildPrompt({
    parentIssue: issueFixture({
      number: 151,
      labels: ['agent:plan-auto'],
      body: 'Parent feature',
    }),
    childIssue: issueFixture({
      number: 157,
      labels: ['agent:child'],
      body: 'Implement child',
      comments: [
        commentFixture({ body: 'Second note', createdAt: '2026-05-08T11:00:00.000Z' }),
        commentFixture({ body: 'First note', createdAt: '2026-05-08T10:00:00.000Z' }),
      ],
    }),
    config: validConfig,
    workflowPromptText: 'Issue tree workflow',
    childMetadata: {
      stableId: 'child-execution',
      afkHitl: 'afk',
      dependsOn: ['planning'],
      ownershipScope: ['src/runner/plan-auto-command.ts'],
      verification: ['npm test'],
    },
    dependencyIssues: [
      issueFixture({
        number: 156,
        labels: ['agent:review'],
        body: 'Dependency child',
      }),
    ],
    promptPath: '/prompt.md',
    reportPath: '/report.json',
    branchName: 'codex/tree-151-issue-157',
    worktreePath: '/worktree',
  });

  assert.match(prompt, /# Codex Orchestrator Issue-Tree Child Implementation/);
  assert.match(prompt, /## Parent Issue Context/);
  assert.match(prompt, /Parent feature/);
  assert.match(prompt, /## Child Issue Context/);
  assert.match(prompt, /Issue: #157/);
  assert.match(prompt, /Stable ID: child-execution/);
  assert.match(prompt, /src\/runner\/plan-auto-command\.ts/);
  assert.match(prompt, /First note[\s\S]*Second note/);
  assert.match(prompt, /## Dependency Context/);
  assert.match(prompt, /#156 Issue 156/);
  assert.match(prompt, /merged into the parent integration branch/);
  assert.match(prompt, /## Project Workflow\n\nIssue tree workflow/);
  assert.match(prompt, /Runner-Owned Publication Contract/);
  assert.match(prompt, /must not commit, push, merge, open pull requests/);
  assert.match(prompt, /Safety Contract/);
  assert.match(prompt, /Completion Report Contract/);
  assert.match(prompt, /\/report\.json/);
});

test('durable prompt and completion report helpers validate report shape', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-prompt-'));
  const promptPath = await writeDurablePrompt({
    targetRoot,
    config: validConfig,
    issueNumber: 155,
    sessionId: 'session',
    promptText: 'hello',
  });
  assert.equal(await readFile(promptPath, 'utf8'), 'hello');
  assert.equal(promptPath, sessionPromptPath({ targetRoot, config: validConfig, issueNumber: 155, sessionId: 'session' }));

  const reportPath = sessionReportPath({ targetRoot, config: validConfig, issueNumber: 155, sessionId: 'session' });
  assert.deepEqual(await readScopedCompletionReport(reportPath), { kind: 'missing' });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'needs-promotion',
      changes: [],
      validation: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    }),
    'utf8',
  );
  await assert.rejects(readScopedCompletionReport(reportPath), /promotion is required/);
});

test('plan-auto completion report helper validates graph shape', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-plan-report-'));
  const reportPath = join(targetRoot, 'report.json');

  assert.deepEqual(await readPlanAutoCompletionReport(reportPath), { kind: 'missing' });
  await writeFile(reportPath, JSON.stringify({ status: 'blocked' }), 'utf8');
  await assert.rejects(readPlanAutoCompletionReport(reportPath), /status must be completed/);

  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'completed',
      parent: { body: 'Updated parent' },
      graph: {
        nodes: [
          {
            stableId: 'child-a',
            title: 'Child A',
            body: 'Body',
            afkHitl: 'afk',
            ownershipScope: ['src/a.ts'],
            dependsOn: ['missing'],
            verification: ['npm test'],
          },
        ],
        edges: [],
        specGate: 'wave-level',
      },
      residualRisks: [],
    }),
    'utf8',
  );
  await assert.rejects(readPlanAutoCompletionReport(reportPath), /depends on unknown node/);

  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'completed',
      parent: { title: 'Updated', body: 'Updated parent' },
      graph: {
        nodes: [
          {
            stableId: 'child-a',
            title: 'Child A',
            body: 'Body',
            afkHitl: 'afk',
            ownershipScope: ['src/a.ts'],
            dependsOn: [],
            verification: ['npm test'],
          },
        ],
        edges: [],
        specGate: 'wave-level',
      },
      residualRisks: [],
    }),
    'utf8',
  );

  const read = await readPlanAutoCompletionReport(reportPath);
  assert.equal(read.kind, 'valid');
  if (read.kind === 'valid') {
    assert.equal(read.report.graph.nodes[0]?.stableId, 'child-a');
  }
});
