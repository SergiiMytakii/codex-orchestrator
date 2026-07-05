export type IssueState = 'OPEN' | 'CLOSED';
export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED' | 'UNKNOWN';

export interface GitHubIssueLabel {
  name: string;
}

export interface GitHubIssueComment {
  id: string;
  url: string;
  body: string;
  createdAt: string;
  author: {
    login: string;
  };
  authorAssociation: string;
}

export interface GitHubPullRequestLink {
  number: number;
  url: string;
  state: PullRequestState;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: IssueState;
  labels: GitHubIssueLabel[];
  comments: GitHubIssueComment[];
  closedByPullRequestsReferences: GitHubPullRequestLink[];
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface UpdateIssueInput {
  title?: string;
  body?: string;
  addLabels?: string[];
  removeLabels?: string[];
}

export type CloseIssueEvidenceReason =
  | { type: 'implemented-in'; links: string[] }
  | { type: 'implemented-as-part-of'; links: string[]; summary?: string }
  | {
      type: 'closed-because';
      reason: 'duplicate' | 'invalid' | 'out-of-scope' | 'superseded' | 'manually-completed';
      details: string;
      links?: string[];
    };

export interface CloseIssueEvidenceInput {
  reason: CloseIssueEvidenceReason;
  validation: string;
}

export interface GitHubIssueAdapter {
  listOpenIssuesWithAnyLabel(labels: string[]): Promise<GitHubIssue[]>;
  listClosedIssuesWithAnyLabel(labels: string[]): Promise<GitHubIssue[]>;
  getIssue(number: number): Promise<GitHubIssue | undefined>;
  createIssue(input: CreateIssueInput): Promise<GitHubIssue>;
  updateIssue(issueNumber: number, input: UpdateIssueInput): Promise<GitHubIssue>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabels(issueNumber: number, labels: string[]): Promise<void>;
  postComment(issueNumber: number, body: string): Promise<void>;
  closeIssueWithEvidence(issueNumber: number, input: CloseIssueEvidenceInput): Promise<void>;
}

export class CloseIssueEvidenceError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export async function closeIssueWithEvidence(
  issueNumber: number,
  input: CloseIssueEvidenceInput,
  actions: {
    postComment(issueNumber: number, body: string): Promise<void>;
    closeIssue(issueNumber: number): Promise<void>;
  },
): Promise<void> {
  const body = formatIssueClosureEvidenceComment(input);
  await actions.postComment(issueNumber, body);
  await actions.closeIssue(issueNumber);
}

export function formatIssueClosureEvidenceComment(input: CloseIssueEvidenceInput): string {
  const validation = requireNonEmpty(input.validation, 'Closure evidence validation is required');
  const reason = input.reason;

  if (reason.type === 'implemented-in') {
    const links = requireLinks(reason.links, 'Implemented-in closure evidence requires at least one PR or commit link');
    return [
      'codex-orchestrator completion evidence',
      '',
      `Implemented in: ${links.join(', ')}`,
      `Validation: ${validation}`,
    ].join('\n');
  }

  if (reason.type === 'implemented-as-part-of') {
    const links = requireLinks(reason.links, 'Implemented-as-part-of closure evidence requires at least one parent, PRD, wave, or PR link');
    const summary = reason.summary?.trim();
    return [
      'codex-orchestrator completion evidence',
      '',
      `Implemented as part of: ${summary ? `${summary} - ` : ''}${links.join(', ')}`,
      `Validation: ${validation}`,
    ].join('\n');
  }

  const details = requireNonEmpty(reason.details, 'Closed-because closure evidence requires details');
  const links = (reason.links ?? []).map((link) => link.trim()).filter(Boolean);
  return [
    'codex-orchestrator completion evidence',
    '',
    `Closed because: ${reason.reason} - ${details}${links.length > 0 ? ` (${links.join(', ')})` : ''}`,
    `Validation: ${validation}`,
  ].join('\n');
}

export function hasIssueClosureEvidence(issue: GitHubIssue): boolean {
  return issue.closedByPullRequestsReferences.length > 0
    || issue.comments.some((comment) => isIssueClosureEvidenceComment(comment.body));
}

export function isIssueClosureEvidenceComment(body: string): boolean {
  return body.includes('codex-orchestrator completion evidence')
    && body.includes('Validation:')
    && (
      body.includes('Implemented in:')
      || body.includes('Implemented as part of:')
      || body.includes('Closed because:')
    );
}

function requireNonEmpty(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CloseIssueEvidenceError(message);
  }
  return trimmed;
}

function requireLinks(links: string[], message: string): string[] {
  const cleaned = links.map((link) => link.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new CloseIssueEvidenceError(message);
  }
  return cleaned;
}

export class InMemoryGitHubIssueAdapter implements GitHubIssueAdapter {
  private readonly issues = new Map<number, GitHubIssue>();

  public addedLabels: Array<{ issueNumber: number; labels: string[] }> = [];
  public removedLabels: Array<{ issueNumber: number; labels: string[] }> = [];
  public postedComments: Array<{ issueNumber: number; body: string }> = [];
  public createdIssues: CreateIssueInput[] = [];
  public updatedIssues: Array<{ issueNumber: number; input: UpdateIssueInput }> = [];

  public constructor(issues: GitHubIssue[] = []) {
    for (const issue of issues) {
      this.issues.set(issue.number, cloneIssue(issue));
    }
  }

  public async listOpenIssuesWithAnyLabel(labels: string[]): Promise<GitHubIssue[]> {
    return this.listIssuesWithAnyLabel(labels, 'OPEN');
  }

  public async listClosedIssuesWithAnyLabel(labels: string[]): Promise<GitHubIssue[]> {
    return this.listIssuesWithAnyLabel(labels, 'CLOSED');
  }

  private listIssuesWithAnyLabel(labels: string[], state: IssueState): GitHubIssue[] {
    const wanted = new Set(labels);
    return Array.from(this.issues.values())
      .filter((issue) => issue.state === state && issue.labels.some((label) => wanted.has(label.name)))
      .sort((left, right) => left.number - right.number)
      .map(cloneIssue);
  }

  public async getIssue(number: number): Promise<GitHubIssue | undefined> {
    const issue = this.issues.get(number);
    return issue ? cloneIssue(issue) : undefined;
  }

  public async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
    const nextNumber = Math.max(0, ...this.issues.keys()) + 1;
    const issue: GitHubIssue = {
      number: nextNumber,
      title: input.title,
      body: input.body,
      url: `https://github.com/example/repo/issues/${nextNumber}`,
      state: 'OPEN',
      labels: uniqueLabels(input.labels),
      comments: [],
      closedByPullRequestsReferences: [],
    };
    this.issues.set(nextNumber, issue);
    this.createdIssues.push({ title: input.title, body: input.body, labels: [...input.labels] });
    return cloneIssue(issue);
  }

  public async updateIssue(issueNumber: number, input: UpdateIssueInput): Promise<GitHubIssue> {
    const issue = this.requireIssue(issueNumber);
    if (input.title !== undefined) {
      issue.title = input.title;
    }
    if (input.body !== undefined) {
      issue.body = input.body;
    }
    if (input.addLabels) {
      const existing = new Set(issue.labels.map((label) => label.name));
      for (const label of input.addLabels) {
        if (!existing.has(label)) {
          issue.labels.push({ name: label });
          existing.add(label);
        }
      }
    }
    if (input.removeLabels) {
      const remove = new Set(input.removeLabels);
      issue.labels = issue.labels.filter((label) => !remove.has(label.name));
    }
    this.updatedIssues.push({
      issueNumber,
      input: {
        ...input,
        addLabels: input.addLabels ? [...input.addLabels] : undefined,
        removeLabels: input.removeLabels ? [...input.removeLabels] : undefined,
      },
    });
    return cloneIssue(issue);
  }

  public async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const issue = this.requireIssue(issueNumber);
    const existing = new Set(issue.labels.map((label) => label.name));
    for (const label of labels) {
      if (!existing.has(label)) {
        issue.labels.push({ name: label });
      }
    }
    this.addedLabels.push({ issueNumber, labels: [...labels] });
  }

  public async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
    const issue = this.requireIssue(issueNumber);
    const remove = new Set(labels);
    issue.labels = issue.labels.filter((label) => !remove.has(label.name));
    this.removedLabels.push({ issueNumber, labels: [...labels] });
  }

  public async postComment(issueNumber: number, body: string): Promise<void> {
    const issue = this.requireIssue(issueNumber);
    const commentNumber = issue.comments.length + 1;
    issue.comments.push({
      id: `comment-${issueNumber}-${commentNumber}`,
      url: `${issue.url}#issuecomment-${commentNumber}`,
      body,
      createdAt: new Date(commentNumber * 1000).toISOString(),
      author: { login: 'codex-orchestrator' },
      authorAssociation: 'NONE',
    });
    this.postedComments.push({ issueNumber, body });
  }

  public async closeIssueWithEvidence(issueNumber: number, input: CloseIssueEvidenceInput): Promise<void> {
    await closeIssueWithEvidence(issueNumber, input, {
      postComment: (targetIssueNumber, body) => this.postComment(targetIssueNumber, body),
      closeIssue: async (targetIssueNumber) => {
        const issue = this.requireIssue(targetIssueNumber);
        issue.state = 'CLOSED';
      },
    });
  }

  private requireIssue(issueNumber: number): GitHubIssue {
    const issue = this.issues.get(issueNumber);
    if (!issue) {
      throw new Error(`Issue #${issueNumber} not found`);
    }
    return issue;
  }
}

function uniqueLabels(labels: string[]): GitHubIssueLabel[] {
  return Array.from(new Set(labels)).map((name) => ({ name }));
}

function cloneIssue(issue: GitHubIssue): GitHubIssue {
  return {
    ...issue,
    labels: issue.labels.map((label) => ({ ...label })),
    comments: issue.comments.map((comment) => ({
      ...comment,
      author: { ...comment.author },
    })),
    closedByPullRequestsReferences: issue.closedByPullRequestsReferences.map((pullRequest) => ({ ...pullRequest })),
  };
}
