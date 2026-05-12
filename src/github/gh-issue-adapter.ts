import type { CommandExecutionError, CommandExecutor } from './gh-cli.js';
import { defaultGhExecutor } from './gh-cli.js';
import type {
  CreateIssueInput,
  GitHubIssue,
  GitHubIssueAdapter,
  GitHubIssueComment,
  GitHubIssueLabel,
  GitHubPullRequestLink,
  IssueState,
  PullRequestState,
  UpdateIssueInput,
} from './issues.js';

const issueJsonFields = 'number,title,body,url,state,labels,comments,closedByPullRequestsReferences';

export class GhCliIssueAdapter implements GitHubIssueAdapter {
  private readonly repo: string;
  private readonly executor: CommandExecutor;

  public constructor(owner: string, repo: string, executor: CommandExecutor = defaultGhExecutor) {
    this.repo = `${owner}/${repo}`;
    this.executor = executor;
  }

  public async listOpenIssuesWithAnyLabel(labels: string[]): Promise<GitHubIssue[]> {
    const wanted = new Set(labels);
    const result = await this.executor('gh', [
      'issue',
      'list',
      '--repo',
      this.repo,
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      issueJsonFields,
    ]);
    const parsed = JSON.parse(result.stdout) as unknown[];

    return parsed
      .map(normalizeIssue)
      .filter((issue) => issue.labels.some((label) => wanted.has(label.name)))
      .sort((left, right) => left.number - right.number);
  }

  public async getIssue(number: number): Promise<GitHubIssue | undefined> {
    try {
      const result = await this.executor('gh', [
        'issue',
        'view',
        String(number),
        '--repo',
        this.repo,
        '--json',
        issueJsonFields,
      ]);
      return normalizeIssue(JSON.parse(result.stdout) as unknown);
    } catch (error) {
      if (isIssueNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
    const args = ['issue', 'create', '--repo', this.repo, '--title', input.title, '--body', input.body];
    for (const label of input.labels) {
      args.push('--label', label);
    }
    const result = await this.executor('gh', args);
    const match = result.stdout.match(/\/issues\/(\d+)/);
    if (!match?.[1]) {
      throw new Error('gh issue create did not return an issue URL');
    }
    const issueNumber = Number(match[1]);
    const issue = await this.getIssue(issueNumber);
    if (!issue) {
      throw new Error(`Created issue #${issueNumber} was not found`);
    }
    return issue;
  }

  public async updateIssue(issueNumber: number, input: UpdateIssueInput): Promise<GitHubIssue> {
    const args = ['issue', 'edit', String(issueNumber), '--repo', this.repo];
    if (input.title !== undefined) {
      args.push('--title', input.title);
    }
    if (input.body !== undefined) {
      args.push('--body', input.body);
    }
    for (const label of input.addLabels ?? []) {
      args.push('--add-label', label);
    }
    for (const label of input.removeLabels ?? []) {
      args.push('--remove-label', label);
    }
    await this.executor('gh', args);
    const issue = await this.getIssue(issueNumber);
    if (!issue) {
      throw new Error(`Updated issue #${issueNumber} was not found`);
    }
    return issue;
  }

  public async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    for (const label of labels) {
      await this.executor('gh', ['issue', 'edit', String(issueNumber), '--repo', this.repo, '--add-label', label]);
    }
  }

  public async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
    for (const label of labels) {
      await this.executor('gh', ['issue', 'edit', String(issueNumber), '--repo', this.repo, '--remove-label', label]);
    }
  }

  public async postComment(issueNumber: number, body: string): Promise<void> {
    await this.executor('gh', ['issue', 'comment', String(issueNumber), '--repo', this.repo, '--body', truncateCommentBody(body)]);
  }
}

const maxGitHubCommentBodyLength = 60_000;

function truncateCommentBody(body: string): string {
  if (body.length <= maxGitHubCommentBodyLength) {
    return body;
  }

  const suffix = `\n\n[truncated by codex-orchestrator: original comment was ${body.length} characters]`;
  return `${body.slice(0, maxGitHubCommentBodyLength - suffix.length)}${suffix}`;
}

function isIssueNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const commandError = error as CommandExecutionError;
  return commandError.code === 1 && /(not found|could not resolve to an issue or pull request)/i.test(commandError.stderr ?? '');
}

function normalizeIssue(input: unknown): GitHubIssue {
  if (typeof input !== 'object' || input === null) {
    throw new Error('GitHub issue payload must be an object');
  }
  const record = input as Record<string, unknown>;
  const number = readNumber(record, 'number');
  const title = readString(record, 'title');
  const body = readString(record, 'body');
  const url = readString(record, 'url');
  const state = readIssueState(record.state);

  return {
    number,
    title,
    body,
    url,
    state,
    labels: readArray(record.labels).flatMap(normalizeLabel),
    comments: readArray(record.comments).flatMap(normalizeComment),
    closedByPullRequestsReferences: readArray(record.closedByPullRequestsReferences).flatMap(normalizePullRequestLink),
  };
}

function normalizeLabel(input: unknown): GitHubIssueLabel[] {
  if (typeof input !== 'object' || input === null) {
    return [];
  }
  const name = (input as Record<string, unknown>).name;
  return typeof name === 'string' ? [{ name }] : [];
}

function normalizeComment(input: unknown): GitHubIssueComment[] {
  if (typeof input !== 'object' || input === null) {
    return [];
  }
  const record = input as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const url = typeof record.url === 'string' ? record.url : '';
  const body = typeof record.body === 'string' ? record.body : '';
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : '';
  const author = typeof record.author === 'object' && record.author !== null ? record.author as Record<string, unknown> : {};
  const login = typeof author.login === 'string' ? author.login : '';
  const authorAssociation = typeof record.authorAssociation === 'string' ? record.authorAssociation : '';
  return [{ id, url, body, createdAt, author: { login }, authorAssociation }];
}

function normalizePullRequestLink(input: unknown): GitHubPullRequestLink[] {
  if (typeof input !== 'object' || input === null) {
    return [];
  }
  const record = input as Record<string, unknown>;
  return [
    {
      number: readNumber(record, 'number'),
      url: readString(record, 'url'),
      state: readPullRequestState(record.state),
    },
  ];
}

function readArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') {
    throw new Error(`GitHub issue payload ${key} must be a number`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`GitHub issue payload ${key} must be a string`);
  }
  return value;
}

function readIssueState(value: unknown): IssueState {
  if (value === 'OPEN' || value === 'CLOSED') {
    return value;
  }
  throw new Error('GitHub issue payload state must be OPEN or CLOSED');
}

function readPullRequestState(value: unknown): PullRequestState {
  if (typeof value === 'string') {
    const normalized = value.toUpperCase();
    if (normalized === 'OPEN' || normalized === 'CLOSED' || normalized === 'MERGED') {
      return normalized;
    }
  }
  return 'UNKNOWN';
}
