export interface GitHubPullRequest {
  number: number;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
}

export interface CreateDraftPullRequestInput {
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}

export interface GitHubPullRequestAdapter {
  createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<GitHubPullRequest>;
}

export class InMemoryGitHubPullRequestAdapter implements GitHubPullRequestAdapter {
  public createdPullRequests: CreateDraftPullRequestInput[] = [];

  public constructor(
    private readonly owner = 'SergiiMytakii',
    private readonly repo = 'IntelleReach',
  ) {}

  public async createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<GitHubPullRequest> {
    this.createdPullRequests.push({ ...input });
    const number = this.createdPullRequests.length;
    return {
      number,
      url: `https://github.com/${this.owner}/${this.repo}/pull/${number}`,
      isDraft: true,
      headRefName: input.headBranch,
      baseRefName: input.baseBranch,
    };
  }
}
