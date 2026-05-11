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
  assert.match(prompt, /Completion Report Contract/);
  assert.match(prompt, /Quality Gate Contract/);
  assert.match(prompt, /TDD red-to-green/);
  assert.match(prompt, /cleanup-review/);
  assert.match(prompt, /code-review/);
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
  assert.match(prompt, /Do not claim the runner-owned visual proof passed/);
  assert.match(prompt, /CODEX_ORCHESTRATOR_LOGIN_EMAIL, CODEX_ORCHESTRATOR_LOGIN_PASSWORD/);
  assert.match(prompt, /never hardcode credentials/);
});

test('package scoped workflow prompt requires strict TDD and review gates', async () => {
  const prompt = await readFile('prompts/workflows/scoped-implementation.md', 'utf8');

  assert.match(prompt, /TDD red-to-green/);
  assert.match(prompt, /test fails before implementation/);
  assert.match(prompt, /passes after implementation/);
  assert.match(prompt, /cleanup-review/);
  assert.match(prompt, /code-review/);
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
      labels: ['agent:auto', 'agent:child'],
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
