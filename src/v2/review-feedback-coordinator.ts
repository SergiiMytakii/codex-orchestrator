import { canonicalJson } from './containment.js';
import {
  GitHubPermissionRetryableError,
  GitHubPermissionSafetyError,
  type GitHubIssueAdapter,
  type GitHubRepositoryPermissionObservation,
} from './adapters/issues.js';
import type {
  GitHubPullRequestAdapter,
  GitHubPullRequestReviewTarget,
  GitHubPullRequestReviewThread,
  GitHubSubmittedPullRequestReview,
} from './adapters/pull-requests.js';
import {
  createFrozenReviewFeedbackBatch,
  hashReviewFeedbackSnapshot,
  hashReviewFeedbackText,
  normalizeReviewFeedbackBody,
  type FrozenReviewFeedbackBatchV1,
  type FrozenReviewFeedbackSourceV1,
} from './review-feedback.js';

export interface ReviewFeedbackObservationInput {
  runId: string;
  canonicalRepository: string;
  pullRequestNumber: number;
  expectedHeadSha: string;
  expectedHeadRefName: string;
  expectedBaseRefName: string;
  marker: string;
  consumedSourceIds: string[];
}

export type ReviewFeedbackObservationResult =
  | { status: 'none'; observedHeadSha: string; eligibleSourceIds: string[] }
  | { status: 'frozen'; batch: FrozenReviewFeedbackBatchV1 }
  | { status: 'retryable'; reason: string }
  | { status: 'blocked'; reason: string };

export type ReviewFeedbackRevalidationResult =
  | { status: 'valid'; observedHeadSha: string }
  | { status: 'retryable'; reason: string }
  | { status: 'blocked'; reason: string };

interface CandidateSource {
  source: Omit<FrozenReviewFeedbackSourceV1, 'permission'>;
  login: string;
  userId: string;
}

export class ReviewFeedbackObserver {
  public constructor(private readonly dependencies: {
    pullRequests: GitHubPullRequestAdapter;
    issues: Pick<GitHubIssueAdapter, 'getRepositoryPermission'>;
    now?: () => string;
  }) {}

  public async observeAndFreeze(input: ReviewFeedbackObservationInput): Promise<ReviewFeedbackObservationResult> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const snapshot = await this.readSnapshot(input.pullRequestNumber);
        const targetError = validateObservationTarget(snapshot.before, input, input.expectedHeadSha);
        if (targetError) return { status: 'blocked', reason: targetError };
        if (!sameTarget(snapshot.before, snapshot.after)) {
          if (attempt === 1) continue;
          return { status: 'blocked', reason: 'GitHub pull request observation remained torn after one retry' };
        }
        const consumed = new Set(input.consumedSourceIds);
        const candidates = collectCandidates(snapshot.threads, snapshot.reviews, input.expectedHeadSha)
          .filter((candidate) => !consumed.has(candidate.source.sourceId))
          .sort((left, right) => left.source.sourceId.localeCompare(right.source.sourceId));
        const sources: FrozenReviewFeedbackSourceV1[] = [];
        for (const candidate of candidates) {
          const permission = await this.readTrustedPermission(candidate.login, candidate.userId);
          if (!permission) continue;
          sources.push({ ...candidate.source, permission });
        }
        if (sources.length === 0) return { status: 'none', observedHeadSha: input.expectedHeadSha, eligibleSourceIds: [] };
        return {
          status: 'frozen',
          batch: createFrozenReviewFeedbackBatch({
            runId: input.runId,
            canonicalRepository: input.canonicalRepository,
            pullRequest: {
              nodeId: snapshot.before.nodeId,
              number: snapshot.before.number,
              headSha: snapshot.before.headRefOid,
              headRefName: snapshot.before.headRefName,
              baseRefName: snapshot.before.baseRefName,
              marker: input.marker,
            },
            priorPublishedHeadSha: input.expectedHeadSha,
            sources,
            frozenAt: (this.dependencies.now ?? (() => new Date().toISOString()))(),
          }),
        };
      } catch (error) {
        const classified = classifyReadError(error);
        if (classified.status === 'retryable' && attempt === 1) continue;
        return classified;
      }
    }
    return { status: 'retryable', reason: 'GitHub review observation did not converge' };
  }

  public async revalidate(input: {
    batch: FrozenReviewFeedbackBatchV1;
    epoch: 'pre-update' | 'post-push';
    expectedHeadSha: string;
  }): Promise<ReviewFeedbackRevalidationResult> {
    try {
      const snapshot = await this.readSnapshot(input.batch.pullRequest.number);
      if (!sameTarget(snapshot.before, snapshot.after)) return { status: 'blocked', reason: 'GitHub pull request revalidation was torn' };
      const expected = {
        runId: input.batch.runId,
        canonicalRepository: input.batch.canonicalRepository,
        pullRequestNumber: input.batch.pullRequest.number,
        expectedHeadSha: input.expectedHeadSha,
        expectedHeadRefName: input.batch.pullRequest.headRefName,
        expectedBaseRefName: input.batch.pullRequest.baseRefName,
        marker: input.batch.pullRequest.marker,
        consumedSourceIds: [],
      };
      const targetError = validateObservationTarget(snapshot.before, expected, input.expectedHeadSha);
      if (targetError || snapshot.before.nodeId !== input.batch.pullRequest.nodeId) {
        return { status: 'blocked', reason: targetError ?? 'GitHub pull request node identity drifted' };
      }
      for (const frozen of input.batch.sources) {
        const current = findCandidate(snapshot.threads, snapshot.reviews, frozen);
        if (!current) return { status: 'blocked', reason: `Frozen review source ${frozen.sourceId} was deleted or became ineligible` };
        if (current.source.body !== frozen.body || current.source.bodySha256 !== frozen.bodySha256
          || current.source.snapshotSha256 !== frozen.snapshotSha256 || current.source.commitSha !== frozen.commitSha
          || canonicalJson(current.source.author) !== canonicalJson(frozen.author)
          || (input.epoch === 'pre-update' && canonicalJson(current.source.threadState) !== canonicalJson(frozen.threadState))) {
          return { status: 'blocked', reason: `Frozen review source ${frozen.sourceId} drifted` };
        }
        const permission = await this.readTrustedPermission(current.login, current.userId);
        if (!permission || permission.userId !== frozen.permission.userId) {
          return { status: 'blocked', reason: `Frozen review source ${frozen.sourceId} permission was revoked` };
        }
      }
      return { status: 'valid', observedHeadSha: input.expectedHeadSha };
    } catch (error) {
      return classifyReadError(error);
    }
  }

  private async readSnapshot(number: number): Promise<{
    before: GitHubPullRequestReviewTarget;
    after: GitHubPullRequestReviewTarget;
    threads: GitHubPullRequestReviewThread[];
    reviews: GitHubSubmittedPullRequestReview[];
  }> {
    const before = await this.dependencies.pullRequests.getReviewTarget(number);
    if (!before) throw new GitHubPermissionSafetyError('Marker-bound pull request was not found');
    const [threads, reviews] = await Promise.all([
      this.dependencies.pullRequests.listReviewThreads(number),
      this.dependencies.pullRequests.listSubmittedReviews(number),
    ]);
    const after = await this.dependencies.pullRequests.getReviewTarget(number);
    if (!after) throw new GitHubPermissionSafetyError('Marker-bound pull request disappeared during observation');
    return { before, after, threads, reviews };
  }

  private async readTrustedPermission(login: string, userId: string): Promise<FrozenReviewFeedbackSourceV1['permission'] | undefined> {
    const permission = await this.dependencies.issues.getRepositoryPermission(login, userId);
    if (permission.userId !== userId) throw new GitHubPermissionSafetyError('GitHub permission identity mismatch');
    if (permission.permission !== 'write' && permission.permission !== 'admin') return undefined;
    return permission as FrozenReviewFeedbackSourceV1['permission'];
  }
}

function collectCandidates(
  threads: GitHubPullRequestReviewThread[],
  reviews: GitHubSubmittedPullRequestReview[],
  expectedHeadSha: string,
): CandidateSource[] {
  const output: CandidateSource[] = [];
  for (const thread of threads) {
    const root = thread.comments[0];
    if (!root || thread.isResolved || thread.isOutdated || root.commitId !== expectedHeadSha
      || !root.author || root.author.isBot || !root.body.trim()) continue;
    output.push(candidateFromThread(thread));
  }
  for (const review of reviews) {
    if (review.state !== 'CHANGES_REQUESTED' || review.commitId !== expectedHeadSha || !review.submittedAt
      || !review.author || review.author.isBot || !review.body.trim()) continue;
    output.push(candidateFromReview(review));
  }
  return output;
}

function findCandidate(
  threads: GitHubPullRequestReviewThread[],
  reviews: GitHubSubmittedPullRequestReview[],
  frozen: FrozenReviewFeedbackSourceV1,
): CandidateSource | undefined {
  if (frozen.kind === 'thread') {
    const thread = threads.find((candidate) => `pr-thread:${candidate.nodeId}` === frozen.sourceId);
    const root = thread?.comments[0];
    if (!thread || !root || !root.author || root.author.isBot || !root.body.trim() || root.commitId !== frozen.commitSha) return undefined;
    return candidateFromThread(thread);
  }
  const review = reviews.find((candidate) => `pr-review:${candidate.nodeId}` === frozen.sourceId);
  if (!review || review.state !== 'CHANGES_REQUESTED' || !review.submittedAt || !review.author || review.author.isBot
    || !review.body.trim() || review.commitId !== frozen.commitSha) return undefined;
  return candidateFromReview(review);
}

function candidateFromThread(thread: GitHubPullRequestReviewThread): CandidateSource {
  const root = thread.comments[0]!;
  const author = root.author!;
  const body = normalizeReviewFeedbackBody(root.body);
  const sourceId = `pr-thread:${thread.nodeId}`;
  return {
    login: author.login,
    userId: author.id,
    source: {
      sourceId,
      kind: 'thread',
      sourceUrl: root.url,
      path: normalizePath(thread.path),
      line: thread.line,
      body,
      bodySha256: hashReviewFeedbackText(body),
      snapshotSha256: hashReviewFeedbackSnapshot({
        sourceId, path: normalizePath(thread.path), line: thread.line,
        comments: thread.comments.map((comment) => ({
          nodeId: comment.nodeId, databaseId: comment.databaseId, url: comment.url,
          bodySha256: hashReviewFeedbackText(comment.body), createdAt: comment.createdAt, updatedAt: comment.updatedAt,
          commitId: comment.commitId,
          author: comment.author && { id: comment.author.id, nodeId: comment.author.nodeId ?? null, login: comment.author.login, isBot: comment.author.isBot },
        })),
      }),
      threadState: { isResolved: thread.isResolved, isOutdated: thread.isOutdated },
      commitSha: root.commitId!,
      sourceCreatedAt: root.createdAt,
      sourceUpdatedAt: root.updatedAt,
      author: { login: author.login, userId: author.id },
    },
  };
}

function candidateFromReview(review: GitHubSubmittedPullRequestReview): CandidateSource {
  const author = review.author!;
  const body = normalizeReviewFeedbackBody(review.body);
  const sourceId = `pr-review:${review.nodeId}`;
  return {
    login: author.login,
    userId: author.id,
    source: {
      sourceId,
      kind: 'review',
      sourceUrl: review.url,
      path: null,
      line: null,
      body,
      bodySha256: hashReviewFeedbackText(body),
      snapshotSha256: hashReviewFeedbackSnapshot({
        sourceId, databaseId: review.databaseId, url: review.url, state: review.state,
        bodySha256: hashReviewFeedbackText(body), submittedAt: review.submittedAt,
        commitId: review.commitId, author: { id: author.id, login: author.login, isBot: author.isBot },
      }),
      threadState: null,
      commitSha: review.commitId,
      sourceCreatedAt: review.submittedAt!,
      sourceUpdatedAt: review.submittedAt!,
      author: { login: author.login, userId: author.id },
    },
  };
}

function validateObservationTarget(
  target: GitHubPullRequestReviewTarget,
  expected: ReviewFeedbackObservationInput,
  expectedHeadSha: string,
): string | undefined {
  const repository = `${target.repository.owner.login}/${target.repository.name}`.toLowerCase();
  if (repository !== expected.canonicalRepository.toLowerCase()) return 'GitHub pull request repository identity mismatch';
  if (target.number !== expected.pullRequestNumber || target.state !== 'OPEN' || !target.isDraft || target.isCrossRepository) return 'GitHub pull request is not the eligible same-repository draft';
  if (target.headRefName !== expected.expectedHeadRefName || target.baseRefName !== expected.expectedBaseRefName
    || target.headRefOid !== expectedHeadSha) return 'GitHub pull request refs or head drifted';
  if (!target.body.includes(expected.marker)) return 'GitHub pull request run marker is missing';
  return undefined;
}

function sameTarget(left: GitHubPullRequestReviewTarget, right: GitHubPullRequestReviewTarget): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new GitHubPermissionSafetyError('Review thread path is unsafe');
  return normalized;
}

function classifyReadError(error: unknown): Extract<ReviewFeedbackObservationResult, { status: 'retryable' | 'blocked' }> {
  const message = error instanceof Error ? error.message : 'Unknown GitHub review read failure';
  if (error instanceof GitHubPermissionRetryableError || /failed to run|timed out|temporar|transport/iu.test(message)) {
    return { status: 'retryable', reason: message };
  }
  return { status: 'blocked', reason: message };
}
