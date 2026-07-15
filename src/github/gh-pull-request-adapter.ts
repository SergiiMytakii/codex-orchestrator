import type { CommandExecutor } from './gh-cli.js';
import { defaultGhExecutor } from './gh-cli.js';
import type {
  CreateDraftPullRequestInput,
  GitHubPullRequest,
  GitHubPullRequestAdapter,
  GitHubPullRequestDetails,
} from './pull-requests.js';

export class GhCliPullRequestAdapter implements GitHubPullRequestAdapter {
  private readonly owner: string;
  private readonly repo: string;
  private readonly executor: CommandExecutor;

  public constructor(owner: string, repo: string, executor: CommandExecutor = defaultGhExecutor) {
    this.owner = owner;
    this.repo = `${owner}/${repo}`;
    this.executor = executor;
  }

  public async listAllByHeadBranch(headBranch: string): Promise<GitHubPullRequestDetails[]> {
    const result = await this.executor('gh', [
      'api', '--paginate', '--slurp', '--method', 'GET',
      `repos/${this.repo}/pulls`,
      '-f', 'state=all',
      '-f', `head=${this.owner}:${headBranch}`,
      '-f', 'per_page=100',
    ]);
    const pages = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error('GitHub pull request pagination payload must be an array of pages');
    }
    return pages.flatMap((page) => (page as unknown[]).map(normalizeDetailedPullRequest));
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

function normalizeDetailedPullRequest(input: unknown): GitHubPullRequestDetails {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('GitHub pull request payload must be an object');
  }
  const record = input as Record<string, unknown>;
  const head = objectField(record, 'head');
  const base = objectField(record, 'base');
  const state = stringField(record, 'state').toUpperCase();
  const mergedAt = record.merged_at;
  if (mergedAt !== null && typeof mergedAt !== 'string') {
    throw new Error('GitHub pull request payload merged_at must be null or a string');
  }
  return {
    number: numberField(record, 'number'),
    nodeId: stringField(record, 'node_id'),
    url: stringField(record, 'html_url'),
    state: mergedAt === null
      ? state === 'OPEN' ? 'OPEN' : 'CLOSED'
      : 'MERGED',
    isDraft: booleanField(record, 'draft'),
    headRefName: stringField(head, 'ref'),
    baseRefName: stringField(base, 'ref'),
    title: stringField(record, 'title'),
    body: nullableStringField(record, 'body'),
    authorAssociation: stringField(record, 'author_association'),
  };
}

function objectField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GitHub pull request payload ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`GitHub pull request payload ${field} must be a string`);
  return value;
}

function nullableStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (value === null) return '';
  return stringField(record, field);
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value)) throw new Error(`GitHub pull request payload ${field} must be an integer`);
  return value as number;
}

function booleanField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') throw new Error(`GitHub pull request payload ${field} must be a boolean`);
  return value;
}
