import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import {
  applyClarificationGate,
  applyCodexSessionResult,
  claimIssue,
  clearClarificationGate,
  discoverIssueWork,
  hasMaintainerResponseAfterLatestClarification,
} from '../src/runner/issue-state-machine.js';
import { validConfig } from './fixtures/config.js';
import { commentFixture, issueFixture } from './fixtures/issues.js';

const labels = validConfig.github.labels;
const now = new Date('2026-05-08T12:00:00.000Z');

test('discovers eligible auto and plan-auto issues', () => {
  const decisions = discoverIssueWork(
    [
      issueFixture({ number: 2, labels: [labels.planAuto.name] }),
      issueFixture({ number: 1, labels: [labels.auto.name] }),
    ],
    validConfig,
  );

  assert.deepEqual(decisions, [
    {
      kind: 'eligible',
      issueNumber: 1,
      title: 'Issue 1',
      mode: 'scoped-issue',
      reason: 'has configured auto label and no blocking state labels',
    },
    {
      kind: 'eligible',
      issueNumber: 2,
      title: 'Issue 2',
      mode: 'plan-parent',
      reason: 'has configured plan-auto label and no blocking state labels',
    },
  ]);
});

test('skips issues by deterministic precedence and reason strings', () => {
  const decisions = discoverIssueWork(
    [
      issueFixture({ number: 1, labels: [labels.running.name, labels.review.name, labels.auto.name] }),
      issueFixture({ number: 2, labels: [labels.auto.name, labels.planAuto.name, labels.manual.name] }),
      issueFixture({ number: 3, labels: [labels.manual.name, labels.auto.name] }),
      issueFixture({ number: 4, labels: [labels.blocked.name, labels.auto.name] }),
      issueFixture({ number: 5, labels: [labels.running.name, labels.auto.name] }),
      issueFixture({ number: 6, labels: [labels.review.name, labels.auto.name] }),
      issueFixture({ number: 7, labels: [labels.auto.name], state: 'CLOSED' }),
      issueFixture({ number: 8, labels: [labels.child.name] }),
      issueFixture({ number: 9, labels: [labels.child.name, labels.auto.name] }),
    ],
    validConfig,
  );

  assert.deepEqual(
    decisions.map((decision) =>
      decision.kind === 'skipped' ? [decision.reasonCode, decision.reason] : [decision.kind, decision.reason],
    ),
    [
      ['conflicting-state-labels', 'multiple state labels are present'],
      ['conflicting-authorization-labels', 'auto and plan-auto labels are both present'],
      ['manual-label', 'manual label is present'],
      ['blocked-label', 'blocked label is present'],
      ['already-running', 'running label is present'],
      ['ready-for-review', 'review label is present'],
      ['closed', 'issue is closed'],
      ['child-label', 'child label is present; parent plan-auto owns child execution'],
      ['child-label', 'child label is present; parent plan-auto owns child execution'],
    ],
  );
});

test('claimIssue adds running label and posts deterministic claim comment', async () => {
  const adapter = new InMemoryGitHubIssueAdapter([issueFixture({ number: 1, labels: [labels.auto.name] })]);

  await claimIssue(adapter, validConfig, 1, 'scoped-issue', now);

  assert.deepEqual(adapter.addedLabels, [{ issueNumber: 1, labels: [labels.running.name] }]);
  assert.deepEqual(adapter.postedComments, [
    {
      issueNumber: 1,
      body: 'codex-orchestrator: claimed #1 for scoped-issue autonomous work at 2026-05-08T12:00:00.000Z.',
    },
  ]);
});

test('clarification gate blocks with concrete questions and rejects invalid payloads', async () => {
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 1, labels: [labels.auto.name, labels.running.name] }),
  ]);

  await applyClarificationGate(
    adapter,
    validConfig,
    1,
    [{ question: 'Which mode?', blocks: 'implementation branch choice' }],
    now,
  );

  assert.deepEqual(adapter.removedLabels, [{ issueNumber: 1, labels: [labels.running.name] }]);
  assert.deepEqual(adapter.addedLabels, [{ issueNumber: 1, labels: [labels.blocked.name] }]);
  assert.equal(
    adapter.postedComments[0]?.body,
    'codex-orchestrator clarification questions for #1\n1. Which mode? Blocks: implementation branch choice',
  );

  await assert.rejects(
    applyClarificationGate(adapter, validConfig, 1, [], now),
    /needs-clarification requires at least one question/,
  );
  await assert.rejects(
    applyClarificationGate(adapter, validConfig, 1, [{ question: ' ', blocks: 'decision' }], now),
    /needs-clarification requires at least one question/,
  );
  await assert.rejects(
    applyClarificationGate(adapter, validConfig, 1, [{ question: 'Question?', blocks: ' ' }], now),
    /needs-clarification requires at least one question/,
  );
});

test('codex session ready result is a no-op and needs-clarification delegates to gate', async () => {
  const adapter = new InMemoryGitHubIssueAdapter([
    issueFixture({ number: 1, labels: [labels.auto.name, labels.running.name] }),
  ]);

  assert.deepEqual(await applyCodexSessionResult(adapter, validConfig, 1, { status: 'ready' }, now), {
    action: 'none',
  });
  assert.deepEqual(adapter.postedComments, []);

  assert.deepEqual(
    await applyCodexSessionResult(
      adapter,
      validConfig,
      1,
      { status: 'needs-clarification', questions: [{ question: 'Which API?', blocks: 'adapter behavior' }] },
      now,
    ),
    { action: 'blocked-for-clarification' },
  );
  assert.equal(adapter.postedComments.length, 1);
});

test('maintainer response detection and clear clarification gate support resume', async () => {
  const issue = issueFixture({
    number: 1,
    labels: [labels.blocked.name],
    comments: [
      commentFixture({
        body: 'codex-orchestrator clarification questions for #1\n1. Which mode? Blocks: mode',
        createdAt: '2026-05-08T10:00:00.000Z',
      }),
      commentFixture({
        body: 'Use mode A',
        createdAt: '2026-05-08T11:00:00.000Z',
        authorAssociation: 'OWNER',
      }),
    ],
  });
  const adapter = new InMemoryGitHubIssueAdapter([issue]);

  assert.equal(hasMaintainerResponseAfterLatestClarification(issue), true);
  await clearClarificationGate(adapter, validConfig, 1, now);

  assert.deepEqual(adapter.removedLabels, [{ issueNumber: 1, labels: [labels.blocked.name] }]);
  assert.deepEqual(adapter.addedLabels, [{ issueNumber: 1, labels: [labels.running.name] }]);
  assert.equal(
    adapter.postedComments[0]?.body,
    'codex-orchestrator: maintainer clarification detected for #1; resuming at 2026-05-08T12:00:00.000Z.',
  );
});
