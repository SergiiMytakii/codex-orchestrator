export interface GitHubPullRequest {
  number: number;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
}

export interface GitHubPullRequestDetails extends GitHubPullRequest {
  nodeId: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string;
  body: string;
  authorAssociation: string;
}

export interface GitHubRepositoryIdentity {
  nodeId: string;
  name: string;
  owner: {
    nodeId: string;
    login: string;
  };
}

export interface GitHubPullRequestReviewTarget extends GitHubPullRequestDetails {
  repository: GitHubRepositoryIdentity;
  isCrossRepository: boolean;
  headRefOid: string;
}

export interface GitHubReviewActor {
  id: string;
  login: string;
  isBot: boolean;
  nodeId?: string;
}

export interface GitHubPullRequestReviewComment {
  nodeId: string;
  databaseId: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  commitId: string | null;
  author: GitHubReviewActor | null;
}

export interface GitHubPullRequestReviewThread {
  nodeId: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: GitHubPullRequestReviewComment[];
}

export interface GitHubSubmittedPullRequestReview {
  nodeId: string;
  databaseId: string;
  url: string;
  body: string;
  state: 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED';
  commitId: string;
  submittedAt: string | null;
  author: GitHubReviewActor | null;
}

export interface GitHubPullRequestConversationComment {
  id: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: GitHubReviewActor | null;
}

export interface CreateDraftPullRequestInput {
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}

export interface GitHubPullRequestAdapter {
  listAllByHeadBranch(headBranch: string): Promise<GitHubPullRequestDetails[]>;
  createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<GitHubPullRequest>;
  getPullRequest(number: number): Promise<GitHubPullRequest | undefined>;
  findMergedPullRequestByHeadBranch(headBranch: string): Promise<GitHubPullRequest | undefined>;
  findOpenPullRequestByHeadAndBase(headBranch: string, baseBranch: string): Promise<GitHubPullRequest | undefined>;
  getReviewTarget(number: number): Promise<GitHubPullRequestReviewTarget | undefined>;
  listReviewThreads(number: number): Promise<GitHubPullRequestReviewThread[]>;
  listSubmittedReviews(number: number): Promise<GitHubSubmittedPullRequestReview[]>;
  listConversationComments(number: number): Promise<GitHubPullRequestConversationComment[]>;
  postConversationComment(number: number, body: string): Promise<GitHubPullRequestConversationComment>;
}

export class InMemoryGitHubPullRequestAdapter implements GitHubPullRequestAdapter {
  public createdPullRequests: CreateDraftPullRequestInput[] = [];
  public mergedPullRequests: GitHubPullRequest[] = [];
  public reviewTargets = new Map<number, GitHubPullRequestReviewTarget>();
  public reviewThreads = new Map<number, GitHubPullRequestReviewThread[]>();
  public submittedReviews = new Map<number, GitHubSubmittedPullRequestReview[]>();
  public conversationComments = new Map<number, GitHubPullRequestConversationComment[]>();

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

  public async listAllByHeadBranch(headBranch: string): Promise<GitHubPullRequestDetails[]> {
    const open = await Promise.all(this.createdPullRequests.map(async (_input, index) => this.getPullRequest(index + 1)));
    return [...open.filter((pullRequest): pullRequest is GitHubPullRequest =>
      pullRequest?.headRefName === headBranch),
    ...this.mergedPullRequests.filter((pullRequest) => pullRequest.headRefName === headBranch)]
      .map((pullRequest) => ({
        ...pullRequest,
        nodeId: `PR_${pullRequest.number}`,
        state: this.mergedPullRequests.includes(pullRequest) ? 'MERGED' as const : 'OPEN' as const,
        title: this.createdPullRequests[pullRequest.number - 1]?.title ?? '',
        body: this.createdPullRequests[pullRequest.number - 1]?.body ?? '',
        authorAssociation: 'MEMBER',
      }));
  }

  public async getReviewTarget(number: number): Promise<GitHubPullRequestReviewTarget | undefined> {
    const fixture = this.reviewTargets.get(number);
    if (fixture) return clone(fixture);
    const pullRequest = (await this.listAllByHeadBranch(
      this.createdPullRequests[number - 1]?.headBranch ?? '',
    )).find((candidate) => candidate.number === number);
    if (!pullRequest) return undefined;
    return {
      ...pullRequest,
      repository: {
        nodeId: `R_${this.owner}_${this.repo}`,
        name: this.repo,
        owner: { nodeId: `O_${this.owner}`, login: this.owner },
      },
      isCrossRepository: false,
      headRefOid: '',
    };
  }

  public async listReviewThreads(number: number): Promise<GitHubPullRequestReviewThread[]> {
    return clone(this.reviewThreads.get(number) ?? []);
  }

  public async listSubmittedReviews(number: number): Promise<GitHubSubmittedPullRequestReview[]> {
    return clone(this.submittedReviews.get(number) ?? []);
  }

  public async listConversationComments(number: number): Promise<GitHubPullRequestConversationComment[]> {
    return clone(this.conversationComments.get(number) ?? []);
  }

  public async postConversationComment(number: number, body: string): Promise<GitHubPullRequestConversationComment> {
    const comments = this.conversationComments.get(number) ?? [];
    const comment: GitHubPullRequestConversationComment = {
      id: String(comments.length + 1),
      url: `https://github.com/${this.owner}/${this.repo}/pull/${number}#issuecomment-${comments.length + 1}`,
      body,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      author: { id: 'runner', login: this.owner, isBot: false },
    };
    comments.push(comment);
    this.conversationComments.set(number, comments);
    return clone(comment);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
