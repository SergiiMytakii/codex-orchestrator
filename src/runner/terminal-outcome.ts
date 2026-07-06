import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import type { CreateDraftPullRequestInput, GitHubPullRequest, GitHubPullRequestAdapter } from '../github/pull-requests.js';
import { verifyPullRequestRefs } from '../github/pull-requests.js';
import type { GitWorktreeManager } from '../git/worktree.js';

export interface FinishReviewReadyTerminalOutcomeInput {
  issueNumber: number;
  config: CodexOrchestratorConfig;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  git: Pick<GitWorktreeManager, 'pushBranch'>;
  pullRequestAdapter: GitHubPullRequestAdapter;
  issueAdapter: GitHubIssueAdapter;
  pullRequest: Pick<CreateDraftPullRequestInput, 'title' | 'body'>;
  reportComment: string | ((pullRequest: GitHubPullRequest) => string);
  findExistingPullRequest?: boolean;
  onPullRequestReady?: (pullRequest: GitHubPullRequest) => void;
  beforeIssueMutation?: (pullRequest: GitHubPullRequest, reportComment: string) => Promise<void> | void;
  afterComment?: () => Promise<void> | void;
}

export interface FinishBlockedTerminalOutcomeInput {
  issueNumber: number;
  config: CodexOrchestratorConfig;
  issueAdapter: GitHubIssueAdapter;
  reportComment: string;
  skipCommentIfIncludes?: string;
  afterTerminalMutation?: (postedComment: boolean) => Promise<void> | void;
}

export interface FinishReviewReadyCommentTerminalOutcomeInput {
  issueNumber: number;
  config: CodexOrchestratorConfig;
  issueAdapter: GitHubIssueAdapter;
  reportComment: string;
  afterTerminalMutation?: () => Promise<void> | void;
}

export interface FinishPromotionRequestedTerminalOutcomeInput {
  issueNumber: number;
  config: CodexOrchestratorConfig;
  issueAdapter: GitHubIssueAdapter;
  reportComment: string;
}

export async function finishReviewReadyTerminalOutcome(
  input: FinishReviewReadyTerminalOutcomeInput,
): Promise<{ pullRequest: GitHubPullRequest; reportComment: string }> {
  await input.git.pushBranch({ worktreePath: input.worktreePath, branchName: input.branchName });
  let pullRequest = input.findExistingPullRequest === false
    ? undefined
    : await input.pullRequestAdapter.findOpenPullRequestByHeadAndBase(input.branchName, input.baseBranch);
  if (!pullRequest) {
    pullRequest = await input.pullRequestAdapter.createDraftPullRequest({
      title: input.pullRequest.title,
      body: input.pullRequest.body,
      headBranch: input.branchName,
      baseBranch: input.baseBranch,
    });
  }
  pullRequest = await verifyPullRequestRefs(input.pullRequestAdapter, pullRequest, input.branchName, input.baseBranch);
  input.onPullRequestReady?.(pullRequest);
  const reportComment = typeof input.reportComment === 'function'
    ? input.reportComment(pullRequest)
    : input.reportComment;
  await input.beforeIssueMutation?.(pullRequest, reportComment);
  await finishIssueTerminalComment({
    issueNumber: input.issueNumber,
    config: input.config,
    issueAdapter: input.issueAdapter,
    terminalLabel: input.config.github.labels.review.name,
    reportComment,
  });
  await input.afterComment?.();
  return { pullRequest, reportComment };
}

export async function finishBlockedTerminalOutcome(
  input: FinishBlockedTerminalOutcomeInput,
): Promise<{ reportComment: string; postedComment: boolean }> {
  const result = await finishIssueTerminalComment({
    issueNumber: input.issueNumber,
    config: input.config,
    issueAdapter: input.issueAdapter,
    terminalLabel: input.config.github.labels.blocked.name,
    reportComment: input.reportComment,
    skipCommentIfIncludes: input.skipCommentIfIncludes,
  });
  await input.afterTerminalMutation?.(result.postedComment);
  return result;
}

export async function finishReviewReadyCommentTerminalOutcome(
  input: FinishReviewReadyCommentTerminalOutcomeInput,
): Promise<{ reportComment: string; postedComment: boolean }> {
  const result = await finishIssueTerminalComment({
    issueNumber: input.issueNumber,
    config: input.config,
    issueAdapter: input.issueAdapter,
    terminalLabel: input.config.github.labels.review.name,
    reportComment: input.reportComment,
  });
  await input.afterTerminalMutation?.();
  return result;
}

export async function finishPromotionRequestedTerminalOutcome(
  input: FinishPromotionRequestedTerminalOutcomeInput,
): Promise<{ reportComment: string; postedComment: boolean }> {
  return finishIssueTerminalComment({
    issueNumber: input.issueNumber,
    config: input.config,
    issueAdapter: input.issueAdapter,
    terminalLabel: input.config.github.labels.blocked.name,
    reportComment: input.reportComment,
  });
}

async function finishIssueTerminalComment(input: {
  issueNumber: number;
  config: CodexOrchestratorConfig;
  issueAdapter: GitHubIssueAdapter;
  terminalLabel: string;
  reportComment: string;
  skipCommentIfIncludes?: string;
}): Promise<{ reportComment: string; postedComment: boolean }> {
  await input.issueAdapter.removeLabels(input.issueNumber, [input.config.github.labels.running.name]);
  await input.issueAdapter.addLabels(input.issueNumber, [input.terminalLabel]);
  const issue = input.skipCommentIfIncludes ? await input.issueAdapter.getIssue(input.issueNumber) : undefined;
  const alreadyPosted = Boolean(input.skipCommentIfIncludes && issue?.comments.some((comment) => comment.body.includes(input.skipCommentIfIncludes ?? '')));
  if (!alreadyPosted) {
    await input.issueAdapter.postComment(input.issueNumber, input.reportComment);
  }
  return { reportComment: input.reportComment, postedComment: !alreadyPosted };
}
