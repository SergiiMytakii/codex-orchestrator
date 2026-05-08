import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  buildScopedImplementationPrompt,
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
