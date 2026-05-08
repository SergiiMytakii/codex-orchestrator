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
}
