import type { GitHubIssue, GitHubIssueComment, GitHubPullRequestLink, IssueState } from '../../src/github/issues.js';

export function issueFixture(input: {
  number: number;
  labels?: string[];
  body?: string;
  state?: IssueState;
  comments?: GitHubIssueComment[];
  pullRequests?: GitHubPullRequestLink[];
}): GitHubIssue {
  return {
    number: input.number,
    title: `Issue ${input.number}`,
    body: input.body ?? `Body ${input.number}`,
    url: `https://github.com/example/repo/issues/${input.number}`,
    state: input.state ?? 'OPEN',
    labels: (input.labels ?? []).map((name) => ({ name })),
    comments: input.comments ?? [],
    closedByPullRequestsReferences: input.pullRequests ?? [],
  };
}

export function commentFixture(input: {
  body: string;
  createdAt: string;
  authorAssociation?: string;
}): GitHubIssueComment {
  return {
    id: input.createdAt,
    url: `https://github.com/example/repo/issues/1#${input.createdAt}`,
    body: input.body,
    createdAt: input.createdAt,
    author: { login: 'user' },
    authorAssociation: input.authorAssociation ?? 'NONE',
  };
}
