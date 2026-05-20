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
  getPullRequest(number: number): Promise<GitHubPullRequest | undefined>;
  findMergedPullRequestByHeadBranch(headBranch: string): Promise<GitHubPullRequest | undefined>;
  findOpenPullRequestByHeadAndBase(headBranch: string, baseBranch: string): Promise<GitHubPullRequest | undefined>;
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

  public async getPullRequest(number: number): Promise<GitHubPullRequest | undefined> {
    const input = this.createdPullRequests[number - 1];
    if (!input) {
      return undefined;
    }
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

  public async findOpenPullRequestByHeadAndBase(
    headBranch: string,
    baseBranch: string,
  ): Promise<GitHubPullRequest | undefined> {
    for (let index = 0; index < this.createdPullRequests.length; index += 1) {
      const input = this.createdPullRequests[index];
      if (input?.headBranch === headBranch && input.baseBranch === baseBranch) {
        return this.getPullRequest(index + 1);
      }
    }
    return undefined;
  }
}

export async function verifyPullRequestRefs(
  pullRequestAdapter: GitHubPullRequestAdapter,
  pullRequest: GitHubPullRequest,
  expectedHeadBranch: string,
  expectedBaseBranch: string,
): Promise<GitHubPullRequest> {
  const refreshed = await pullRequestAdapter.getPullRequest(pullRequest.number);
  if (!refreshed) {
    throw new Error(`Created pull request #${pullRequest.number} could not be read back from GitHub`);
  }
  if (refreshed.headRefName !== expectedHeadBranch || refreshed.baseRefName !== expectedBaseBranch) {
    throw new Error(
      `Created pull request #${pullRequest.number} points to ${refreshed.headRefName} -> ${refreshed.baseRefName}; expected ${expectedHeadBranch} -> ${expectedBaseBranch}.`,
    );
  }
  return refreshed;
}
