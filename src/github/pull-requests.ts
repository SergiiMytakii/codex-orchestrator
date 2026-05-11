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
  findMergedPullRequestByHeadBranch(headBranch: string): Promise<GitHubPullRequest | undefined>;
}

export class InMemoryGitHubPullRequestAdapter implements GitHubPullRequestAdapter {
  public createdPullRequests: CreateDraftPullRequestInput[] = [];
  public mergedPullRequests: GitHubPullRequest[] = [];

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

  public async findMergedPullRequestByHeadBranch(headBranch: string): Promise<GitHubPullRequest | undefined> {
    return this.mergedPullRequests.find((pullRequest) => pullRequest.headRefName === headBranch);
  }
}
