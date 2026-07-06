import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexOrchestratorConfig } from '../src/config/schema.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { InMemoryGitHubPullRequestAdapter, type GitHubPullRequestAdapter } from '../src/github/pull-requests.js';
import {
  finishBlockedTerminalOutcome,
  finishReviewReadyCommentTerminalOutcome,
  finishPromotionRequestedTerminalOutcome,
  finishReviewReadyTerminalOutcome,
} from '../src/runner/terminal-outcome.js';
import { validConfig } from './fixtures/config.js';
import { commentFixture, issueFixture } from './fixtures/issues.js';

const labels = validConfig.github.labels;

test('review-ready terminal outcome pushes and verifies draft PR before issue labels and comment', async () => {
  const operations: string[] = [];
  const issueAdapter = recordingIssueAdapter(operations);
  const pullRequestAdapter = recordingPullRequestAdapter(operations);
  const git = {
    async pushBranch(): Promise<void> {
      operations.push('git.pushBranch');
    },
  };

  const outcome = await finishReviewReadyTerminalOutcome({
    issueNumber: 155,
    config: validConfig,
    branchName: 'codex/issue-155',
    baseBranch: 'main',
    worktreePath: '/tmp/worktree',
    git,
    pullRequestAdapter,
    issueAdapter,
    pullRequest: {
      title: 'Draft for #155',
      body: 'PR body',
    },
    reportComment: 'Review report with Durable Run Summary',
  });

  assert.equal(outcome.pullRequest.url, 'https://github.com/example/repo/pull/1');
  assert.equal(outcome.reportComment, 'Review report with Durable Run Summary');
  assert.deepEqual(operations, [
    'git.pushBranch',
    'pr.findOpen',
    'pr.createDraft',
    'pr.get',
    'issue.removeLabels:agent:running',
    'issue.addLabels:agent:review',
    'issue.postComment',
  ]);
});

test('blocked terminal outcome preserves marker idempotency and does not post duplicate comments', async () => {
  const operations: string[] = [];
  const marker = '<!-- codex-orchestrator:recovery-blocked issue=155 session=abc -->';
  const issueAdapter = recordingIssueAdapter(operations, [
    issueFixture({
      number: 155,
      labels: [labels.running.name],
      comments: [commentFixture({ body: `${marker}\nPrevious blocked report`, createdAt: '2026-05-08T12:00:00.000Z' })],
    }),
  ]);

  const outcome = await finishBlockedTerminalOutcome({
    issueNumber: 155,
    config: validConfig,
    issueAdapter,
    reportComment: `${marker}\nBlocked report with Durable Run Summary`,
    skipCommentIfIncludes: marker,
  });

  assert.equal(outcome.postedComment, false);
  assert.deepEqual(operations, [
    'issue.removeLabels:agent:running',
    'issue.addLabels:agent:blocked',
    'issue.getIssue',
  ]);
});

test('promotion-requested terminal outcome uses blocked label and posts promotion report', async () => {
  const operations: string[] = [];
  const issueAdapter = recordingIssueAdapter(operations);

  const outcome = await finishPromotionRequestedTerminalOutcome({
    issueNumber: 155,
    config: validConfig,
    issueAdapter,
    reportComment: 'Promotion requested with Durable Run Summary',
  });

  assert.equal(outcome.reportComment, 'Promotion requested with Durable Run Summary');
  assert.deepEqual(operations, [
    'issue.removeLabels:agent:running',
    'issue.addLabels:agent:blocked',
    'issue.postComment',
  ]);
});

test('comment-only review-ready terminal outcome supports child handoff cleanup after comment', async () => {
  const operations: string[] = [];
  const issueAdapter = recordingIssueAdapter(operations);

  await finishReviewReadyCommentTerminalOutcome({
    issueNumber: 155,
    config: validConfig,
    issueAdapter,
    reportComment: 'Child review report with Durable Run Summary',
    afterTerminalMutation: () => {
      operations.push('store.removeRun');
    },
  });

  assert.deepEqual(operations, [
    'issue.removeLabels:agent:running',
    'issue.addLabels:agent:review',
    'issue.postComment',
    'store.removeRun',
  ]);
});

function recordingIssueAdapter(
  operations: string[],
  issues = [issueFixture({ number: 155, labels: [labels.running.name] })],
): InMemoryGitHubIssueAdapter {
  class RecordingIssueAdapter extends InMemoryGitHubIssueAdapter {
    public override async getIssue(number: number) {
      operations.push('issue.getIssue');
      return super.getIssue(number);
    }

    public override async removeLabels(issueNumber: number, removeLabels: string[]): Promise<void> {
      operations.push(`issue.removeLabels:${removeLabels.join(',')}`);
      await super.removeLabels(issueNumber, removeLabels);
    }

    public override async addLabels(issueNumber: number, addLabels: string[]): Promise<void> {
      operations.push(`issue.addLabels:${addLabels.join(',')}`);
      await super.addLabels(issueNumber, addLabels);
    }

    public override async postComment(issueNumber: number, body: string): Promise<void> {
      operations.push('issue.postComment');
      await super.postComment(issueNumber, body);
    }
  }

  return new RecordingIssueAdapter(issues);
}

function recordingPullRequestAdapter(operations: string[]): GitHubPullRequestAdapter {
  class RecordingPullRequestAdapter extends InMemoryGitHubPullRequestAdapter {
    public override async findOpenPullRequestByHeadAndBase(headBranch: string, baseBranch: string) {
      operations.push('pr.findOpen');
      return super.findOpenPullRequestByHeadAndBase(headBranch, baseBranch);
    }

    public override async createDraftPullRequest(input: Parameters<GitHubPullRequestAdapter['createDraftPullRequest']>[0]) {
      operations.push('pr.createDraft');
      return super.createDraftPullRequest(input);
    }

    public override async getPullRequest(number: number) {
      operations.push('pr.get');
      return super.getPullRequest(number);
    }
  }

  return new RecordingPullRequestAdapter('example', 'repo');
}
