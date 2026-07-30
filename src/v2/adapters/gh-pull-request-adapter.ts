import type { CommandExecutor } from './gh-cli.js';
import { defaultGhExecutor } from './gh-cli.js';
import type {
  CreateDraftPullRequestInput,
  GitHubPullRequest,
  GitHubPullRequestAdapter,
  GitHubPullRequestConversationComment,
  GitHubPullRequestDetails,
  GitHubPullRequestReviewComment,
  GitHubPullRequestReviewTarget,
  GitHubPullRequestReviewThread,
  GitHubReviewActor,
  GitHubSubmittedPullRequestReview,
} from './pull-requests.js';

const MAX_PAGES = 20;
const MAX_ITEMS = 2_000;
const MAX_TEXT_LENGTH = 131_072;

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

  public async getReviewTarget(number: number): Promise<GitHubPullRequestReviewTarget | undefined> {
    const result = await this.executor('gh', [
      'api', 'graphql',
      '-f', `owner=${this.owner}`,
      '-f', `repo=${this.repo.slice(this.owner.length + 1)}`,
      '-F', `number=${number}`,
      '-f', 'query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){id name owner{id login} pullRequest(number:$number){id databaseId number url state isDraft isCrossRepository headRefName headRefOid baseRefName title body authorAssociation}}}',
    ]);
    const root = objectField(objectValue(JSON.parse(result.stdout) as unknown, 'GitHub GraphQL response'), 'data');
    const repositoryValue = root.repository;
    if (repositoryValue === null) return undefined;
    const repository = objectValue(repositoryValue, 'GitHub GraphQL repository');
    const pullRequestValue = repository.pullRequest;
    if (pullRequestValue === null) return undefined;
    const pullRequest = objectValue(pullRequestValue, 'GitHub GraphQL pullRequest');
    const owner = objectField(repository, 'owner');
    const state = stringField(pullRequest, 'state');
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) {
      throw new Error('GitHub GraphQL pullRequest state is invalid');
    }
    return {
      repository: {
        nodeId: stringField(repository, 'id'),
        name: stringField(repository, 'name'),
        owner: { nodeId: stringField(owner, 'id'), login: stringField(owner, 'login') },
      },
      number: numberField(pullRequest, 'number'),
      nodeId: stringField(pullRequest, 'id'),
      url: stringField(pullRequest, 'url'),
      state: state as GitHubPullRequestDetails['state'],
      isDraft: booleanField(pullRequest, 'isDraft'),
      isCrossRepository: booleanField(pullRequest, 'isCrossRepository'),
      headRefName: stringField(pullRequest, 'headRefName'),
      headRefOid: stringField(pullRequest, 'headRefOid'),
      baseRefName: stringField(pullRequest, 'baseRefName'),
      title: stringField(pullRequest, 'title'),
      body: stringField(pullRequest, 'body'),
      authorAssociation: stringField(pullRequest, 'authorAssociation'),
    };
  }

  public async listReviewThreads(number: number): Promise<GitHubPullRequestReviewThread[]> {
    const threads: GitHubPullRequestReviewThread[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.executor('gh', [
        'api', 'graphql',
        '-f', `owner=${this.owner}`,
        '-f', `repo=${this.repo.slice(this.owner.length + 1)}`,
        '-F', `number=${number}`,
        ...(cursor ? ['-f', `cursor=${cursor}`] : []),
        '-f', 'query=query ReviewThreads($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path line comments(first:100){nodes{id databaseId url body createdAt updatedAt author{__typename ... on User{id databaseId login} ... on Bot{id login}} commit{oid} originalCommit{oid}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}',
      ]);
      const connection = reviewThreadsConnection(result.stdout);
      for (const rawThread of arrayField(connection, 'nodes')) {
        const thread = normalizeReviewThread(rawThread);
        const raw = objectValue(rawThread, 'GitHub review thread');
        const commentsConnection = objectField(raw, 'comments');
        let comments = thread.comments;
        let commentsPageInfo = pageInfo(commentsConnection, 'review thread comments');
        let commentsCursor = commentsPageInfo.endCursor;
        for (let commentPage = 1; commentsPageInfo.hasNextPage; commentPage += 1) {
          if (commentPage >= MAX_PAGES || !commentsCursor) {
            throw new Error('GitHub review thread comments pagination exceeded its bound or omitted endCursor');
          }
          const commentsResult = await this.executor('gh', [
            'api', 'graphql', '-f', `threadId=${thread.nodeId}`, '-f', `cursor=${commentsCursor}`,
            '-f', 'query=query ReviewThreadComments($threadId:ID!,$cursor:String!){node(id:$threadId){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{id databaseId url body createdAt updatedAt author{__typename ... on User{id databaseId login} ... on Bot{id login}} commit{oid} originalCommit{oid}} pageInfo{hasNextPage endCursor}}}}}',
          ]);
          const commentsRoot = objectField(graphqlData(commentsResult.stdout), 'node');
          const nextConnection = objectField(commentsRoot, 'comments');
          comments = comments.concat(arrayField(nextConnection, 'nodes').map(normalizeReviewComment));
          requireItemBound(comments.length, 'review thread comments');
          commentsPageInfo = pageInfo(nextConnection, 'review thread comments');
          commentsCursor = commentsPageInfo.endCursor;
        }
        threads.push({ ...thread, comments });
        requireItemBound(threads.length, 'review threads');
      }
      const info = pageInfo(connection, 'review threads');
      if (!info.hasNextPage) return threads;
      if (!info.endCursor) throw new Error('GitHub review threads pagination omitted endCursor');
      cursor = info.endCursor;
    }
    throw new Error('GitHub review threads pagination exceeded its page bound');
  }

  public async listSubmittedReviews(number: number): Promise<GitHubSubmittedPullRequestReview[]> {
    return (await this.listBoundedRestCollection(
      `repos/${this.repo}/pulls/${number}/reviews`,
      'GitHub pull request reviews',
    )).map(normalizeSubmittedReview);
  }

  public async listConversationComments(number: number): Promise<GitHubPullRequestConversationComment[]> {
    return (await this.listBoundedRestCollection(
      `repos/${this.repo}/issues/${number}/comments`,
      'GitHub pull request conversation comments',
    )).map(normalizeConversationComment);
  }

  public async postConversationComment(number: number, body: string): Promise<GitHubPullRequestConversationComment> {
    boundedText(body, 'pull request conversation comment body');
    await this.executor('gh', [
      'api', '--method', 'POST', `repos/${this.repo}/issues/${number}/comments`, '-f', `body=${body}`,
    ]);
    const matches = (await this.listConversationComments(number)).filter((comment) => comment.body === body);
    if (matches.length !== 1) {
      throw new Error(`Posted pull request conversation comment read-back was ${matches.length === 0 ? 'missing' : 'ambiguous'}`);
    }
    return matches[0]!;
  }

  private async listBoundedRestCollection(endpoint: string, description: string): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.executor('gh', [
        'api', '--method', 'GET', endpoint,
        '-f', 'per_page=100', '-f', `page=${page}`,
        '--jq', '.[] | .id = (.id | tostring) | if .user then .user.id = (.user.id | tostring) else . end',
      ]);
      const next = parseJsonLines(result.stdout, description);
      items.push(...next);
      requireItemBound(items.length, description);
      if (next.length < 100) return items;
    }
    throw new Error(`${description} pagination exceeded its page bound`);
  }
}

function reviewThreadsConnection(stdout: string): Record<string, unknown> {
  const repository = objectField(graphqlData(stdout), 'repository');
  const pullRequest = objectField(repository, 'pullRequest');
  return objectField(pullRequest, 'reviewThreads');
}

function graphqlData(stdout: string): Record<string, unknown> {
  return objectField(objectValue(JSON.parse(stdout) as unknown, 'GitHub GraphQL response'), 'data');
}

function normalizeReviewThread(input: unknown): GitHubPullRequestReviewThread {
  const value = objectValue(input, 'GitHub review thread');
  const comments = objectField(value, 'comments');
  return {
    nodeId: stringField(value, 'id'),
    isResolved: booleanField(value, 'isResolved'),
    isOutdated: booleanField(value, 'isOutdated'),
    path: boundedText(stringField(value, 'path'), 'review thread path'),
    line: nullableIntegerField(value, 'line'),
    comments: arrayField(comments, 'nodes').map(normalizeReviewComment),
  };
}

function normalizeReviewComment(input: unknown): GitHubPullRequestReviewComment {
  const value = objectValue(input, 'GitHub review comment');
  const commitValue = value.originalCommit;
  return {
    nodeId: stringField(value, 'id'),
    databaseId: decimalIdField(value, 'databaseId'),
    url: stringField(value, 'url'),
    body: boundedText(stringField(value, 'body'), 'review comment body'),
    createdAt: timestampField(value, 'createdAt'),
    updatedAt: timestampField(value, 'updatedAt'),
    commitId: commitValue === null ? null : stringField(objectValue(commitValue, 'GitHub review comment commit'), 'oid'),
    author: normalizeGraphqlActor(value.author),
  };
}

function normalizeSubmittedReview(input: unknown): GitHubSubmittedPullRequestReview {
  const value = objectValue(input, 'GitHub submitted pull request review');
  const state = stringField(value, 'state').toUpperCase();
  if (!['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) {
    throw new Error('GitHub pull request review state is invalid');
  }
  return {
    nodeId: stringField(value, 'node_id'),
    databaseId: decimalIdField(value, 'id'),
    url: stringField(value, 'html_url'),
    body: boundedText(nullableStringField(value, 'body'), 'pull request review body'),
    state: state as GitHubSubmittedPullRequestReview['state'],
    commitId: stringField(value, 'commit_id'),
    submittedAt: nullableTimestampField(value, 'submitted_at'),
    author: normalizeRestActor(value.user),
  };
}

function normalizeConversationComment(input: unknown): GitHubPullRequestConversationComment {
  const value = objectValue(input, 'GitHub pull request conversation comment');
  return {
    id: decimalIdField(value, 'id'),
    url: stringField(value, 'html_url'),
    body: boundedText(nullableStringField(value, 'body'), 'pull request conversation comment body'),
    createdAt: timestampField(value, 'created_at'),
    updatedAt: timestampField(value, 'updated_at'),
    author: normalizeRestActor(value.user),
  };
}

function normalizeGraphqlActor(input: unknown): GitHubReviewActor | null {
  if (input === null) return null;
  const value = objectValue(input, 'GitHub GraphQL actor');
  const type = stringField(value, '__typename');
  const login = stringField(value, 'login');
  const nodeId = stringField(value, 'id');
  return {
    id: type === 'User' ? decimalIdField(value, 'databaseId') : nodeId,
    nodeId,
    login,
    isBot: type === 'Bot' || login.endsWith('[bot]'),
  };
}

function normalizeRestActor(input: unknown): GitHubReviewActor | null {
  if (input === null) return null;
  const value = objectValue(input, 'GitHub REST actor');
  const login = stringField(value, 'login');
  const type = stringField(value, 'type');
  if (type !== 'User' && type !== 'Bot') throw new Error('GitHub REST actor type is invalid');
  return {
    id: decimalIdField(value, 'id'),
    login,
    isBot: type === 'Bot' || login.endsWith('[bot]'),
  };
}

function parseJsonLines(stdout: string, description: string): unknown[] {
  if (!stdout.trim()) return [];
  return stdout.trim().split(/\r?\n/u).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`${description} line ${index + 1} is not valid JSON`);
    }
  });
}

function pageInfo(connection: Record<string, unknown>, description: string): { hasNextPage: boolean; endCursor: string | null } {
  const value = objectField(connection, 'pageInfo');
  const hasNextPage = booleanField(value, 'hasNextPage');
  const endCursor = value.endCursor;
  if (endCursor !== null && typeof endCursor !== 'string') {
    throw new Error(`${description} pageInfo endCursor must be null or a string`);
  }
  if (hasNextPage && !endCursor) throw new Error(`${description} pagination omitted endCursor`);
  return { hasNextPage, endCursor };
}

function arrayField(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`GitHub payload ${field} must be an array`);
  return value;
}

function nullableIntegerField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error(`GitHub payload ${field} must be null or an integer`);
  return value as number;
}

function nullableTimestampField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null) return null;
  return timestampField(record, field);
}

function timestampField(record: Record<string, unknown>, field: string): string {
  const value = stringField(record, field);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`GitHub pull request payload ${field} must be a timestamp`);
  return new Date(parsed).toISOString();
}

function decimalIdField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value === 'string' && /^\d+$/u.test(value)) return value;
  if (Number.isSafeInteger(value) && (value as number) >= 0) return String(value);
  throw new Error(`GitHub payload ${field} must be a decimal ID`);
}

function boundedText(value: string, description: string): string {
  if (value.length > MAX_TEXT_LENGTH) throw new Error(`${description} exceeds the text bound`);
  return value;
}

function requireItemBound(length: number, description: string): void {
  if (length > MAX_ITEMS) throw new Error(`${description} exceeds the item bound`);
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
    headSha: stringField(head, 'sha'),
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

function objectValue(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
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
