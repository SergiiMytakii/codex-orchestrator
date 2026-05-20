import type { CommandExecutor } from './gh-cli.js';
import { defaultGhExecutor } from './gh-cli.js';
import type { CreateDraftPullRequestInput, GitHubPullRequest, GitHubPullRequestAdapter } from './pull-requests.js';

export class GhCliPullRequestAdapter implements GitHubPullRequestAdapter {
  private readonly repo: string;
  private readonly executor: CommandExecutor;

  public constructor(owner: string, repo: string, executor: CommandExecutor = defaultGhExecutor) {
    this.repo = `${owner}/${repo}`;
    this.executor = executor;
  }

  public async createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<GitHubPullRequest> {
    const result = await this.executor('gh', [
      'pr',
      'create',
      '--repo',
      this.repo,
      '--base',
      input.baseBranch,
      '--head',
      input.headBranch,
      '--title',
      input.title,
      '--body',
      input.body,
      '--draft',
    ]);
    const url = result.stdout.trim();
    const match = url.match(/\/pull\/(\d+)$/);
    if (!match) {
      throw new Error('gh pr create did not return a pull request URL');
    }

    return {
      number: Number(match[1]),
      url,
      isDraft: true,
      headRefName: input.headBranch,
      baseRefName: input.baseBranch,
    };
  }

  public async getPullRequest(number: number): Promise<GitHubPullRequest | undefined> {
    const result = await this.executor('gh', [
      'pr',
      'view',
      String(number),
      '--repo',
      this.repo,
      '--json',
      'number,url,isDraft,headRefName,baseRefName',
    ]);
    const pullRequest = JSON.parse(result.stdout) as GitHubPullRequest;
    return pullRequest;
  }

  public async findMergedPullRequestByHeadBranch(headBranch: string): Promise<GitHubPullRequest | undefined> {
    const result = await this.executor('gh', [
      'pr',
      'list',
      '--repo',
      this.repo,
      '--head',
      headBranch,
      '--state',
      'merged',
      '--json',
      'number,url,isDraft,headRefName,baseRefName',
      '--limit',
      '1',
    ]);
    const pullRequests = JSON.parse(result.stdout) as Array<{
      number: number;
      url: string;
      isDraft: boolean;
      headRefName: string;
      baseRefName: string;
    }>;
    const [pullRequest] = pullRequests;
    if (!pullRequest) {
      return undefined;
    }

    return pullRequest;
  }

  public async findOpenPullRequestByHeadAndBase(
    headBranch: string,
    baseBranch: string,
  ): Promise<GitHubPullRequest | undefined> {
    const result = await this.executor('gh', [
      'pr',
      'list',
      '--repo',
      this.repo,
      '--state',
      'open',
      '--head',
      headBranch,
      '--base',
      baseBranch,
      '--json',
      'number,url,isDraft,headRefName,baseRefName',
      '--limit',
      '1',
    ]);
    const pullRequests = JSON.parse(result.stdout) as GitHubPullRequest[];
    return pullRequests[0];
  }
}
