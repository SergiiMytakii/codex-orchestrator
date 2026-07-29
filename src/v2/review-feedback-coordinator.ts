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
  restPullRequest: { number: number; nodeId: string; headSha: string; body: string };
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

export class ReviewFeedbackCoordinator {
  public constructor(private readonly dependencies: {
    pullRequests: GitHubPullRequestAdapter;
    issues: Pick<GitHubIssueAdapter, 'getRepositoryPermission'>;
    now?: () => string;
  }) {}

  public async observeAndFreeze(input: ReviewFeedbackObservationInput): Promise<ReviewFeedbackObservationResult> {
    try {
      const snapshot = await this.readBoundedSnapshot(input.pullRequestNumber, input.marker, input.restPullRequest, async ({ threads, reviews }) => {
        const consumed = new Set(input.consumedSourceIds);
        const candidates = collectCandidates(threads, reviews, input.expectedHeadSha)
          .filter((candidate) => !consumed.has(candidate.source.sourceId))
          .sort((left, right) => left.source.sourceId.localeCompare(right.source.sourceId));
        const sources: FrozenReviewFeedbackSourceV1[] = [];
        for (const candidate of candidates) {
          const permission = await this.readTrustedPermission(candidate.login, candidate.userId);
          if (permission) sources.push({ ...candidate.source, permission });
        }
        return sources;
      });
      const targetError = validateObservationTarget(snapshot.target, input, input.expectedHeadSha);
      if (targetError) return { status: 'blocked', reason: targetError };
      if (snapshot.value.length === 0) return { status: 'none', observedHeadSha: input.expectedHeadSha, eligibleSourceIds: [] };
      return {
        status: 'frozen',
        batch: createFrozenReviewFeedbackBatch({
          runId: input.runId,
          canonicalRepository: input.canonicalRepository,
          pullRequest: {
            nodeId: snapshot.target.nodeId,
            number: snapshot.target.number,
            headSha: snapshot.target.headRefOid,
            headRefName: snapshot.target.headRefName,
            baseRefName: snapshot.target.baseRefName,
            marker: input.marker,
          },
          priorPublishedHeadSha: input.expectedHeadSha,
          sources: snapshot.value,
          frozenAt: (this.dependencies.now ?? (() => new Date().toISOString()))(),
        }),
      };
    } catch (error) { return classifyReadError(error); }
  }

  public async revalidate(input: {
    batch: FrozenReviewFeedbackBatchV1;
    epoch: 'pre-update' | 'post-push';
    expectedHeadSha: string;
  }): Promise<ReviewFeedbackRevalidationResult> {
    try {
      const snapshot = await this.readBoundedSnapshot(
        input.batch.pullRequest.number,
        input.batch.pullRequest.marker,
        undefined,
        async ({ threads, reviews }) => {
          for (const frozen of input.batch.sources) {
            const current = findCandidate(threads, reviews, frozen);
            if (!current) throw new GitHubPermissionSafetyError(`Frozen review source ${frozen.sourceId} was deleted or became ineligible`);
            if (current.source.body !== frozen.body || current.source.bodySha256 !== frozen.bodySha256
              || current.source.snapshotSha256 !== frozen.snapshotSha256 || current.source.commitSha !== frozen.commitSha
              || canonicalJson(current.source.author) !== canonicalJson(frozen.author)
              || (input.epoch === 'pre-update' && canonicalJson(current.source.threadState) !== canonicalJson(frozen.threadState))) {
              throw new GitHubPermissionSafetyError(`Frozen review source ${frozen.sourceId} drifted`);
            }
            const permission = await this.readTrustedPermission(current.login, current.userId);
            if (!permission || permission.userId !== frozen.permission.userId) {
              throw new GitHubPermissionSafetyError(`Frozen review source ${frozen.sourceId} permission was revoked`);
            }
          }
        },
      );
      const expected = {
        runId: input.batch.runId,
        canonicalRepository: input.batch.canonicalRepository,
        pullRequestNumber: input.batch.pullRequest.number,
        expectedHeadSha: input.expectedHeadSha,
        expectedHeadRefName: input.batch.pullRequest.headRefName,
        expectedBaseRefName: input.batch.pullRequest.baseRefName,
        marker: input.batch.pullRequest.marker,
        consumedSourceIds: [],
        restPullRequest: {
          number: input.batch.pullRequest.number, nodeId: input.batch.pullRequest.nodeId,
          headSha: input.expectedHeadSha, body: input.batch.pullRequest.marker,
        },
      };
      const targetError = validateObservationTarget(snapshot.target, expected, input.expectedHeadSha);
      if (targetError || snapshot.target.nodeId !== input.batch.pullRequest.nodeId) {
        return { status: 'blocked', reason: targetError ?? 'GitHub pull request node identity drifted' };
      }
      return { status: 'valid', observedHeadSha: input.expectedHeadSha };
    } catch (error) {
      return classifyReadError(error);
    }
  }

  private async readBoundedSnapshot<T>(
    number: number,
    marker: string,
    rest: ReviewFeedbackObservationInput['restPullRequest'] | undefined,
    inspect: (snapshot: { threads: GitHubPullRequestReviewThread[]; reviews: GitHubSubmittedPullRequestReview[] }) => Promise<T>,
  ): Promise<{ target: GitHubPullRequestReviewTarget; value: T }> {
    const before = await this.dependencies.pullRequests.getReviewTarget(number);
    if (!before) throw new GitHubPermissionRetryableError('Marker-bound pull request observation was incomplete');
    const [threads, reviews] = await Promise.all([
      this.dependencies.pullRequests.listReviewThreads(number),
      this.dependencies.pullRequests.listSubmittedReviews(number),
    ]);
    let value: T | undefined;
    let inspectionError: unknown;
    try { value = await inspect({ threads, reviews }); }
    catch (error) { inspectionError = error; }
    const after = await this.dependencies.pullRequests.getReviewTarget(number);
    if (!after) throw new GitHubPermissionRetryableError('Marker-bound pull request observation became incomplete');
    const uncertainty = authorityUncertainty(before, after, marker, rest);
    if (uncertainty) throw new GitHubPermissionRetryableError(uncertainty);
    if (inspectionError) throw inspectionError;
    return { target: before, value: value as T };
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

function authorityProjection(target: GitHubPullRequestReviewTarget, marker: string) {
  return {
    repositoryNodeId: target.repository.nodeId,
    repositoryName: target.repository.name.toLowerCase(),
    repositoryOwnerNodeId: target.repository.owner.nodeId,
    repositoryOwnerLogin: target.repository.owner.login.toLowerCase(),
    number: target.number, nodeId: target.nodeId, state: target.state, isDraft: target.isDraft,
    isCrossRepository: target.isCrossRepository, headRefName: target.headRefName,
    headRefOid: target.headRefOid, baseRefName: target.baseRefName, hasMarker: target.body.includes(marker),
  };
}

function authorityUncertainty(
  before: GitHubPullRequestReviewTarget,
  after: GitHubPullRequestReviewTarget,
  marker: string,
  rest: ReviewFeedbackObservationInput['restPullRequest'] | undefined,
): string | undefined {
  if (canonicalJson(authorityProjection(before, marker)) !== canonicalJson(authorityProjection(after, marker))) {
    return 'GitHub pull request authority observation was torn';
  }
  if (rest && canonicalJson({
    number: rest.number, nodeId: rest.nodeId, headSha: rest.headSha, hasMarker: rest.body.includes(marker),
  }) !== canonicalJson({
    number: before.number, nodeId: before.nodeId, headSha: before.headRefOid, hasMarker: before.body.includes(marker),
  })) return 'GitHub REST and GraphQL authority observations disagree';
  return undefined;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new GitHubPermissionSafetyError('Review thread path is unsafe');
  return normalized;
}

function classifyReadError(error: unknown): Extract<ReviewFeedbackObservationResult, { status: 'retryable' | 'blocked' }> {
  const message = error instanceof Error ? error.message : 'Unknown GitHub review read failure';
  if (error instanceof GitHubPermissionRetryableError
    || /failed to run|timed out|temporar|transport|pagination (?:omitted endCursor|exceeded (?:its )?(?:page )?bound(?: or omitted endCursor)?)/iu.test(message)) {
    return { status: 'retryable', reason: message };
  }
  return { status: 'blocked', reason: message };
}
