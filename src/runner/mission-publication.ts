import { createHash } from 'node:crypto';

import type { GitHubIssueAdapter } from '../github/issues.js';
import type { GitHubPullRequestAdapter, GitHubPullRequestDetails } from '../github/pull-requests.js';
import { publicationAttemptId } from './mission-identifiers.js';
import { transitionPlanParent } from './mission-plan-parent.js';
import { transitionMission } from './mission-state-machine.js';
import type {
  JsonValue,
  MissionStateSnapshot,
  MissionStateStore,
} from './mission-state-store.js';

export const publicationStates = [
  'prepared', 'push-intent', 'pushed', 'pr-create-intent', 'pr-confirmed',
  'labels-intent', 'labels-confirmed', 'comment-intent', 'resumable',
  'review-ready', 'external-input-required', 'safety-stop', 'cancelled',
] as const;
export type MissionPublicationState = (typeof publicationStates)[number];

export type MissionPublicationPullRequest = GitHubPullRequestDetails;

export type MissionPublicationMutationKind =
  | 'push' | 'create-pr' | 'add-labels' | 'remove-labels' | 'post-comment';

export interface MissionPublicationMutationAttempt {
  kind: MissionPublicationMutationKind;
  actionKey: string;
  stage: 'prepared' | 'dispatched';
  observationAttempts: number;
  labels?: string[];
}

export interface MissionPublicationFenceInput {
  publicationId: string;
  ownerId: string;
  repository: string;
  fencingEpoch: number;
  actionKey: string;
}

export interface MissionPublicationRecord {
  id: string;
  revision: number;
  state: MissionPublicationState;
  ownerId: string;
  repository: string;
  issueNumber: number;
  fencingEpoch: number;
  candidateCommit: string;
  candidateTree: string;
  baseSha: string;
  validationSnapshot: string;
  validationReceiptIds: string[];
  configHash: string;
  branch: string;
  baseBranch: string;
  marker: string;
  title: string;
  titleHash: string;
  body: string;
  bodyHash: string;
  managedLabels: string[];
  desiredLabels: string[];
  terminalComment: string;
  commentHash: string;
  baseObservedSha?: string;
  warnings: string[];
  pullRequest?: MissionPublicationPullRequest;
  labelMutation?: { add: string[]; remove: string[]; preserve: string[] };
  mutationAttempt?: MissionPublicationMutationAttempt;
  resumeTarget?: Exclude<MissionPublicationState, 'resumable'>;
  nextEligibleAt?: string;
  actionKey?: string;
}

export interface MissionPublicationBranchAdapter {
  observe(branch: string): Promise<
    { kind: 'absent' } | { kind: 'present'; commitSha: string }
  >;
  push(input: { branch: string; candidateCommit: string }): Promise<void>;
  observeBase(branch: string): Promise<string | undefined>;
}

export type MissionPublicationPullRequestAdapter = Pick<GitHubPullRequestAdapter,
  'listAllByHeadBranch' | 'createDraftPullRequest'>;

export type MissionPublicationIssueAdapter = Pick<GitHubIssueAdapter,
  'getLabels' | 'addLabels' | 'removeLabels' | 'listAllComments' | 'postComment'>;

export interface MissionPublicationSagaDependencies {
  branches: MissionPublicationBranchAdapter;
  pullRequests: MissionPublicationPullRequestAdapter;
  issues: MissionPublicationIssueAdapter;
  assertMutationFence(input: MissionPublicationFenceInput): Promise<void>;
  now?(): string;
  retryDelayMs?: number;
  classifyRemoteError?(error: unknown): 'transient' | 'authority';
}

export type MissionPublicationEvent =
  | { type: 'branch-observed'; observation: { kind: 'absent' } | { kind: 'expected'; commitSha: string } | { kind: 'other'; commitSha: string } }
  | { type: 'base-observed'; observation: { kind: 'absent' } | { kind: 'present'; commitSha: string } }
  | { type: 'pull-requests-observed'; pullRequests: MissionPublicationPullRequest[] }
  | { type: 'labels-observed'; labels: string[] }
  | { type: 'comments-observed'; comments: Array<{ id: string; body: string }> }
  | { type: 'mutation-attempted'; attempt: Omit<MissionPublicationMutationAttempt, 'stage' | 'observationAttempts'> }
  | { type: 'mutation-dispatched'; actionKey: string }
  | { type: 'remote-safety-conflict' }
  | { type: 'remote-external-change' }
  | { type: 'transient-failure'; nextEligibleAt: string; actionKey: string; postconditionObserved?: boolean }
  | { type: 'resume-eligible'; now: string }
  | { type: 'authority-missing' }
  | { type: 'cancel-requested' };

export class MissionPublicationCoordinator {
  public constructor(private readonly store: MissionStateStore) {}

  public prepare(input: {
    expectedGeneration: number;
    missionId: string;
    expectedRevision: number;
    fencingEpoch: number;
    publication: MissionPublicationRecord;
  }): Promise<MissionStateSnapshot> {
    assertMissionPublicationRecord(input.publication);
    return this.store.mutate(input.expectedGeneration, (draft) => {
      const mission = draft.missions[input.missionId];
      if (!mission || mission.revision !== input.expectedRevision
        || mission.fencingEpoch !== input.fencingEpoch) {
        throw new Error(`Scoped Mission ${input.missionId} publication fence does not match.`);
      }
      if (mission.state !== 'candidate-ready') {
        throw new Error(`Scoped Mission ${input.missionId} is not candidate-ready.`);
      }
      if (draft.publications[input.publication.id]
        || Object.values(draft.publications).some((aggregate) =>
          (aggregate.value as unknown as MissionPublicationRecord).ownerId === input.missionId)) {
        throw new Error(`Scoped Mission ${input.missionId} already has a Publication.`);
      }
      const receipt = mission.applyReceipt;
      if (!receipt
        || input.publication.ownerId !== mission.id
        || input.publication.fencingEpoch !== input.fencingEpoch
        || input.publication.candidateCommit !== receipt.commitSha
        || input.publication.candidateTree !== receipt.treeSha
        || input.publication.baseSha !== receipt.oldCommitSha
        || receipt.targetRef !== `refs/heads/${input.publication.branch}`) {
        throw new Error('Scoped Mission Publication does not match the applied candidate.');
      }
      draft.missions[input.missionId] = transitionMission(mission, {
        type: 'adapt-to-publication',
      });
      draft.publications[input.publication.id] = {
        revision: input.publication.revision,
        value: structuredClone(input.publication) as unknown as JsonValue,
      };
    });
  }
}

export class MissionPublicationSaga {
  public constructor(
    private readonly store: MissionStateStore,
    private readonly adapters: MissionPublicationSagaDependencies,
  ) {}

  public run(publicationId: string): Promise<MissionStateSnapshot> {
    return this.runFromBranch(publicationId);
  }

  public async defer(input: {
    publicationId: string;
    nextEligibleAt: string;
    actionKey: string;
  }): Promise<MissionStateSnapshot> {
    const { snapshot, record } = await this.load(input.publicationId);
    if (hasScheduledPublicationRecovery(record)) {
      throw new Error(`Publication ${record.id} already has scheduled recovery.`);
    }
    if (record.state === 'resumable') {
      throw new Error(`Publication ${record.id} is already resumable.`);
    }
    return this.persist(snapshot, record, transitionMissionPublication(record, {
      type: 'transient-failure',
      nextEligibleAt: input.nextEligibleAt,
      actionKey: input.actionKey,
    }));
  }

  public async resume(input: {
    publicationId: string;
    now: string;
  }): Promise<MissionStateSnapshot> {
    const { snapshot, record } = await this.load(input.publicationId);
    if (hasScheduledPublicationRecovery(record)) {
      exactTimestamp(input.now);
      if (input.now < record.nextEligibleAt!) throw new Error('Publication is not eligible.');
      return snapshot;
    }
    return this.persist(snapshot, record, transitionMissionPublication(record, {
      type: 'resume-eligible', now: input.now,
    }));
  }

  public async cancel(publicationId: string): Promise<MissionStateSnapshot> {
    const { snapshot, record } = await this.load(publicationId);
    return this.persist(snapshot, record, transitionMissionPublication(record, {
      type: 'cancel-requested',
    }));
  }

  private async runFromBranch(publicationId: string): Promise<MissionStateSnapshot> {
    await this.reconcileBranch(publicationId);
    await this.reconcilePullRequest(publicationId);
    await this.reconcileLabels(publicationId);
    return this.reconcileComment(publicationId);
  }

  public reconcileBranch(publicationId: string): Promise<MissionStateSnapshot> {
    return this.withRecovery(publicationId, () => this.reconcileBranchOnce(publicationId));
  }

  private async reconcileBranchOnce(publicationId: string): Promise<MissionStateSnapshot> {
    let { snapshot, record } = await this.load(publicationId);
    if (record.state !== 'prepared' && record.state !== 'push-intent') return snapshot;
    let observation = await this.remote('publication:observe-branch', () =>
      this.adapters.branches.observe(record.branch));
    if (record.state === 'prepared') {
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'branch-observed',
        observation: observation.kind === 'absent'
          ? observation
          : { kind: 'expected', commitSha: observation.commitSha },
      }));
      record = publicationFrom(snapshot, publicationId);
      if (record.state !== 'push-intent') return snapshot;
      observation = await this.remote('publication:observe-branch', () =>
        this.adapters.branches.observe(record.branch));
    }
    if (observation.kind === 'absent') {
      const actionKey = mutationActionKey(record, 'push');
      if (record.mutationAttempt) throw new MissionPublicationBoundaryError(actionKey, 'transient', undefined, true);
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-attempted', attempt: { kind: 'push', actionKey },
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.fence(record, actionKey);
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-dispatched', actionKey,
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.remote(actionKey, () => this.adapters.branches.push({
        branch: record.branch,
        candidateCommit: record.candidateCommit,
      }));
      observation = await this.remote('publication:observe-branch', () =>
        this.adapters.branches.observe(record.branch));
      if (observation.kind === 'absent') throw new MissionPublicationBoundaryError(actionKey, 'transient', undefined, true);
    }
    return this.persist(snapshot, record, transitionMissionPublication(record, {
      type: 'branch-observed',
      observation: { kind: 'expected', commitSha: observation.commitSha },
    }));
  }

  public reconcilePullRequest(publicationId: string): Promise<MissionStateSnapshot> {
    return this.withRecovery(publicationId, () => this.reconcilePullRequestOnce(publicationId));
  }

  private async reconcilePullRequestOnce(publicationId: string): Promise<MissionStateSnapshot> {
    let { snapshot, record } = await this.load(publicationId);
    if (record.state !== 'pushed' && record.state !== 'pr-create-intent') return snapshot;
    if (record.state === 'pr-create-intent') {
      const verified = await this.verifyBranchAndBase(snapshot, record);
      snapshot = verified.snapshot;
      record = verified.record;
      if (!verified.ok) return snapshot;
    }
    if (record.state === 'pushed' && record.baseObservedSha === undefined) {
      const baseCommit = await this.remote('publication:observe-base', () =>
        this.adapters.branches.observeBase(record.baseBranch));
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'base-observed',
        observation: baseCommit === undefined
          ? { kind: 'absent' }
          : { kind: 'present', commitSha: baseCommit },
      }));
      record = publicationFrom(snapshot, publicationId);
      if (record.state !== 'pushed') return snapshot;
    }
    let pullRequests = await this.remote('publication:list-pull-requests', () =>
      this.adapters.pullRequests.listAllByHeadBranch(record.branch));
    snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
      type: 'pull-requests-observed', pullRequests,
    }));
    record = publicationFrom(snapshot, publicationId);
    if (record.state !== 'pr-create-intent') return snapshot;
    const verified = await this.verifyBranchAndBase(snapshot, record);
    snapshot = verified.snapshot;
    record = verified.record;
    if (!verified.ok) return snapshot;
    const marked = pullRequests.filter((pullRequest) => pullRequest.body.includes(record.marker));
    if (marked.length === 0) {
      const actionKey = mutationActionKey(record, 'create-pr');
      if (record.mutationAttempt) throw new MissionPublicationBoundaryError(actionKey, 'transient', undefined, true);
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-attempted', attempt: { kind: 'create-pr', actionKey },
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.fence(record, actionKey);
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-dispatched', actionKey,
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.remote(actionKey, () => this.adapters.pullRequests.createDraftPullRequest({
        headBranch: record.branch,
        baseBranch: record.baseBranch,
        title: record.title,
        body: record.body,
      }));
      pullRequests = await this.remote('publication:list-pull-requests', () =>
        this.adapters.pullRequests.listAllByHeadBranch(record.branch));
      if (!pullRequests.some((pullRequest) => pullRequest.body.includes(record.marker))) {
        throw new MissionPublicationBoundaryError(actionKey, 'transient', undefined, true);
      }
      return this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'pull-requests-observed', pullRequests,
      }));
    }
    return snapshot;
  }

  private async verifyBranchAndBase(
    snapshot: MissionStateSnapshot,
    record: MissionPublicationRecord,
  ): Promise<{ snapshot: MissionStateSnapshot; record: MissionPublicationRecord; ok: boolean }> {
    const branch = await this.remote('publication:verify-branch', () =>
      this.adapters.branches.observe(record.branch));
    if (branch.kind === 'absent' || branch.commitSha !== record.candidateCommit) {
      const stopped = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'remote-safety-conflict',
      }));
      return { snapshot: stopped, record: publicationFrom(stopped, record.id), ok: false };
    }
    const baseCommit = await this.remote('publication:verify-base', () =>
      this.adapters.branches.observeBase(record.baseBranch));
    if (baseCommit === undefined) {
      const stopped = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'remote-external-change',
      }));
      return { snapshot: stopped, record: publicationFrom(stopped, record.id), ok: false };
    }
    if (baseCommit !== record.baseObservedSha) {
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'base-observed', observation: { kind: 'present', commitSha: baseCommit },
      }));
      record = publicationFrom(snapshot, record.id);
    }
    return { snapshot, record, ok: true };
  }

  private async verifyConfirmedRemote(
    snapshot: MissionStateSnapshot,
    record: MissionPublicationRecord,
  ): Promise<{ snapshot: MissionStateSnapshot; record: MissionPublicationRecord; ok: boolean }> {
    const branch = await this.verifyBranchAndBase(snapshot, record);
    if (!branch.ok) return branch;
    snapshot = branch.snapshot;
    record = branch.record;
    const pullRequests = await this.remote('publication:verify-pull-request', () =>
      this.adapters.pullRequests.listAllByHeadBranch(record.branch));
    const marked = pullRequests.filter((pullRequest) => pullRequest.body.includes(record.marker));
    const expected = record.pullRequest;
    if (marked.length > 1 || !expected) {
      const stopped = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'remote-safety-conflict',
      }));
      return { snapshot: stopped, record: publicationFrom(stopped, record.id), ok: false };
    }
    if (marked.length === 1 && marked[0]!.nodeId !== expected.nodeId) {
      const event = maintainerAssociation(marked[0]!.authorAssociation)
        ? { type: 'remote-external-change' as const }
        : { type: 'remote-safety-conflict' as const };
      const stopped = await this.persist(snapshot, record, transitionMissionPublication(record, event));
      return { snapshot: stopped, record: publicationFrom(stopped, record.id), ok: false };
    }
    if (marked.length === 1 && (marked[0]!.headRefName !== record.branch
      || marked[0]!.baseRefName !== record.baseBranch)) {
      const stopped = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'remote-safety-conflict',
      }));
      return { snapshot: stopped, record: publicationFrom(stopped, record.id), ok: false };
    }
    if (marked.length === 0 || marked[0]!.state !== 'OPEN' || !marked[0]!.isDraft
      || digest(marked[0]!.title) !== record.titleHash
      || digest(marked[0]!.body) !== record.bodyHash) {
      const stopped = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'remote-external-change',
      }));
      return { snapshot: stopped, record: publicationFrom(stopped, record.id), ok: false };
    }
    return { snapshot, record, ok: true };
  }

  public reconcileLabels(publicationId: string): Promise<MissionStateSnapshot> {
    return this.withRecovery(publicationId, () => this.reconcileLabelsOnce(publicationId));
  }

  private async reconcileLabelsOnce(publicationId: string): Promise<MissionStateSnapshot> {
    let { snapshot, record } = await this.load(publicationId);
    if (record.state !== 'pr-confirmed' && record.state !== 'labels-intent') return snapshot;
    const verified = await this.verifyConfirmedRemote(snapshot, record);
    snapshot = verified.snapshot;
    record = verified.record;
    if (!verified.ok) return snapshot;
    const labels = await this.remote('publication:list-labels', () =>
      this.adapters.issues.getLabels(record.issueNumber));
    snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
      type: 'labels-observed', labels,
    }));
    record = publicationFrom(snapshot, publicationId);
    if (record.state !== 'labels-intent' || !record.labelMutation) return snapshot;
    if (record.labelMutation.add.length > 0) {
      const actionKey = mutationActionKey(record, 'add-labels');
      if (record.mutationAttempt) throw new MissionPublicationBoundaryError(actionKey, 'transient', undefined, true);
      const attemptedLabels = [...record.labelMutation.add];
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-attempted', attempt: { kind: 'add-labels', actionKey, labels: attemptedLabels },
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.fence(record, actionKey);
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-dispatched', actionKey,
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.remote(actionKey, () =>
        this.adapters.issues.addLabels(record.issueNumber, attemptedLabels));
      const observed = await this.remote('publication:list-labels', () =>
        this.adapters.issues.getLabels(record.issueNumber));
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'labels-observed', labels: observed,
      }));
      record = publicationFrom(snapshot, publicationId);
      if (record.mutationAttempt) throw new MissionPublicationBoundaryError(actionKey, 'transient', undefined, true);
    }
    if (record.state === 'labels-intent' && record.labelMutation?.remove.length) {
      const actionKey = mutationActionKey(record, 'remove-labels');
      if (record.mutationAttempt) throw new MissionPublicationBoundaryError(actionKey, 'transient', undefined, true);
      const attemptedLabels = [...record.labelMutation.remove];
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-attempted', attempt: { kind: 'remove-labels', actionKey, labels: attemptedLabels },
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.fence(record, actionKey);
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-dispatched', actionKey,
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.remote(actionKey, () =>
        this.adapters.issues.removeLabels(record.issueNumber, attemptedLabels));
    }
    const observed = await this.remote('publication:list-labels', () =>
      this.adapters.issues.getLabels(record.issueNumber));
    if (record.mutationAttempt && !labelAttemptSatisfied(record.mutationAttempt, observed)) {
      throw new MissionPublicationBoundaryError(record.mutationAttempt.actionKey, 'transient', undefined, true);
    }
    return this.persist(snapshot, record, transitionMissionPublication(record, {
      type: 'labels-observed', labels: observed,
    }));
  }

  public reconcileComment(publicationId: string): Promise<MissionStateSnapshot> {
    return this.withRecovery(publicationId, () => this.reconcileCommentOnce(publicationId));
  }

  private async reconcileCommentOnce(publicationId: string): Promise<MissionStateSnapshot> {
    let { snapshot, record } = await this.load(publicationId);
    if (record.state !== 'labels-confirmed' && record.state !== 'comment-intent') return snapshot;
    const verified = await this.verifyConfirmedRemote(snapshot, record);
    snapshot = verified.snapshot;
    record = verified.record;
    if (!verified.ok) return snapshot;
    let comments = await this.remote('publication:list-comments', () =>
      this.adapters.issues.listAllComments(record.issueNumber));
    snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
      type: 'comments-observed', comments,
    }));
    record = publicationFrom(snapshot, publicationId);
    if (record.state !== 'comment-intent') return snapshot;
    const marker = record.marker.replace(':publication ', ':publication-comment ');
    if (!comments.some((comment) => comment.body.includes(marker))) {
      const actionKey = mutationActionKey(record, 'post-comment');
      if (record.mutationAttempt) throw new MissionPublicationBoundaryError(actionKey, 'transient', undefined, true);
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-attempted', attempt: { kind: 'post-comment', actionKey },
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.fence(record, actionKey);
      snapshot = await this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'mutation-dispatched', actionKey,
      }));
      record = publicationFrom(snapshot, publicationId);
      await this.remote(actionKey, () =>
        this.adapters.issues.postComment(record.issueNumber, record.terminalComment));
      comments = await this.remote('publication:list-comments', () =>
        this.adapters.issues.listAllComments(record.issueNumber));
      if (!comments.some((comment) => comment.body.includes(marker))) {
        throw new MissionPublicationBoundaryError(actionKey, 'transient', undefined, true);
      }
      return this.persist(snapshot, record, transitionMissionPublication(record, {
        type: 'comments-observed', comments,
      }));
    }
    return snapshot;
  }

  private async withRecovery(
    publicationId: string,
    operation: () => Promise<MissionStateSnapshot>,
  ): Promise<MissionStateSnapshot> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof MissionPublicationBoundaryError)
        && !(error instanceof Error && /(?:generation|revision) conflict/u.test(error.message))) {
        throw error;
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { snapshot, record } = await this.load(publicationId);
        if (terminal(record.state) || record.state === 'resumable') return snapshot;
        let next: MissionPublicationRecord;
        if (error instanceof MissionPublicationBoundaryError && error.classification === 'authority') {
          next = transitionMissionPublication(record, { type: 'authority-missing' });
        } else {
          const now = this.adapters.now?.() ?? new Date().toISOString();
          exactTimestamp(now);
          const delay = this.adapters.retryDelayMs ?? 1_000;
          if (!Number.isSafeInteger(delay) || delay <= 0) throw new Error('Publication retry delay must be positive.');
          const actionKey = error instanceof MissionPublicationBoundaryError
            ? error.actionKey : `publication:${record.id}:state-conflict`;
          next = transitionMissionPublication(record, {
            type: 'transient-failure',
            nextEligibleAt: new Date(Date.parse(now) + delay).toISOString(),
            actionKey,
            postconditionObserved: error instanceof MissionPublicationBoundaryError
              && error.postconditionObserved,
          });
        }
        try {
          return await this.persist(snapshot, record, next);
        } catch (persistError) {
          if (!(persistError instanceof Error && /(?:generation|revision) conflict/u.test(persistError.message))) {
            throw persistError;
          }
        }
      }
      throw new Error(`Publication ${publicationId} could not persist recovery after 4 conflicts.`, {
        cause: error,
      });
    }
  }

  private async remote<T>(actionKey: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MissionPublicationBoundaryError) throw error;
      const classification = this.adapters.classifyRemoteError?.(error) ?? defaultRemoteClassification(error);
      throw new MissionPublicationBoundaryError(actionKey, classification, error);
    }
  }

  private fence(record: MissionPublicationRecord, actionKey: string): Promise<void> {
    return this.remote(actionKey, () => this.adapters.assertMutationFence({
      publicationId: record.id,
      ownerId: record.ownerId,
      repository: record.repository,
      fencingEpoch: record.fencingEpoch,
      actionKey,
    }));
  }

  private async load(publicationId: string): Promise<{
    snapshot: MissionStateSnapshot;
    record: MissionPublicationRecord;
  }> {
    const snapshot = await this.store.load();
    return { snapshot, record: publicationFrom(snapshot, publicationId) };
  }

  private persist(
    snapshot: MissionStateSnapshot,
    previous: MissionPublicationRecord,
    next: MissionPublicationRecord,
  ): Promise<MissionStateSnapshot> {
    return this.store.mutate(snapshot.generation, (draft) => {
      const stored = draft.publications[previous.id];
      if (!stored || stored.revision !== previous.revision) {
        throw new Error(`Publication ${previous.id} revision conflict.`);
      }
      draft.publications[previous.id] = {
        revision: next.revision,
        value: structuredClone(next) as unknown as JsonValue,
      };
      delete draft.nextEligibleAt[publicationScheduleKey(previous.id)];
      if ((next.state === 'resumable' || hasScheduledPublicationRecovery(next)) && next.nextEligibleAt) {
        draft.nextEligibleAt[publicationScheduleKey(next.id)] = next.nextEligibleAt;
      }
      const owner = draft.missions[next.ownerId];
      if (owner) {
        let mapped = owner;
        if (next.state === 'resumable' && previous.state !== 'resumable') {
          const deferred = transitionMission(mapped, {
            type: 'publication-transient-failure',
            actionKey: next.actionKey!,
            nextEligibleAt: next.nextEligibleAt!,
          });
          mapped = {
            ...deferred,
            resumableReason: 'Publication remote boundary is transient or not yet observable.',
            requiredPredicate: 'Publication remote postcondition becomes observable.',
          };
        } else if (previous.state === 'resumable' && next.state !== 'resumable'
          && mapped.state === 'resumable') {
          mapped = transitionMission(mapped, {
            type: 'resume-eligible', now: previous.nextEligibleAt!,
          });
        }
        if (terminal(next.state) && next.state !== previous.state) {
          mapped = transitionMission(mapped, { type: publicationOwnerEvent(next.state) });
        }
        draft.missions[next.ownerId] = mapped;
      }
      const parent = draft.planParents[next.ownerId];
      if (parent) {
        let mapped = parent;
        if (next.state === 'resumable' && previous.state !== 'resumable') {
          mapped = transitionPlanParent(mapped, {
            type: 'transient-failure',
            resumeTarget: 'publication-prepared',
            actionKey: next.actionKey!,
            nextEligibleAt: next.nextEligibleAt!,
            reason: 'Publication remote boundary is transient or not yet observable.',
            requiredPredicate: 'Publication remote postcondition becomes observable.',
          });
        } else if (previous.state === 'resumable' && next.state !== 'resumable'
          && mapped.state === 'wave-waiting') {
          mapped = transitionPlanParent(mapped, {
            type: 'resume-eligible', now: previous.nextEligibleAt!,
          });
        }
        if (terminal(next.state) && next.state !== previous.state) {
          mapped = transitionPlanParent(mapped,
            next.state === 'review-ready' ? { type: 'publication-review-ready' }
              : next.state === 'external-input-required' ? { type: 'external-input-required' }
                : next.state === 'safety-stop' ? { type: 'safety-stop' }
                  : { type: 'publication-cancelled' });
        }
        draft.planParents[next.ownerId] = mapped;
      }
    });
  }
}

export function createMissionPublication(input: Omit<MissionPublicationRecord,
  'id' | 'revision' | 'state' | 'titleHash' | 'bodyHash' | 'commentHash'
  | 'pullRequest' | 'labelMutation' | 'mutationAttempt' | 'resumeTarget' | 'nextEligibleAt' | 'actionKey'
  | 'baseObservedSha' | 'warnings'>): MissionPublicationRecord {
  const id = publicationAttemptId({
    ownerId: input.ownerId,
    candidateCommit: input.candidateCommit,
    baseSha: input.baseSha,
    configHash: input.configHash,
  });
  return {
    ...structuredClone(input), id, revision: 1, state: 'prepared',
    titleHash: digest(input.title), bodyHash: digest(input.body),
    commentHash: digest(input.terminalComment), warnings: [],
  };
}

export function publicationScheduleKey(publicationId: string): string {
  requireString(publicationId, 'Publication schedule ID');
  return `publication:${publicationId}`;
}

export function listEligiblePublications(
  snapshot: MissionStateSnapshot,
  now: string,
  limit = 100,
): Array<{ publicationId: string; revision: number; nextEligibleAt: string; actionKey: string }> {
  exactTimestamp(now);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Publication scheduler limit must be positive.');
  const eligible: Array<{ publicationId: string; revision: number; nextEligibleAt: string; actionKey: string }> = [];
  for (const [key, nextEligibleAt] of Object.entries(snapshot.nextEligibleAt)
    .filter(([key, value]) => key.startsWith('publication:') && value <= now)
    .sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]))) {
    if (eligible.length >= Math.min(limit, 100)) break;
    const publicationId = key.slice('publication:'.length);
    const aggregate = snapshot.publications[publicationId];
    const publication = aggregate?.value as unknown as MissionPublicationRecord | undefined;
    if (!publication || (publication.state !== 'resumable' && !hasScheduledPublicationRecovery(publication))
      || publication.nextEligibleAt !== nextEligibleAt
      || !publication.actionKey) continue;
    eligible.push({
      publicationId,
      revision: publication.revision,
      nextEligibleAt,
      actionKey: publication.actionKey,
    });
  }
  return eligible;
}

export function hasScheduledPublicationRecovery(record: MissionPublicationRecord): boolean {
  return record.state !== 'resumable'
    && record.resumeTarget === record.state
    && record.nextEligibleAt !== undefined
    && record.actionKey !== undefined;
}

export function assertMissionPublicationRecord(
  value: unknown,
  path = 'Publication',
): asserts value is MissionPublicationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'id', 'revision', 'state', 'ownerId', 'repository', 'issueNumber', 'fencingEpoch',
    'candidateCommit', 'candidateTree', 'baseSha', 'validationSnapshot',
    'validationReceiptIds', 'configHash', 'branch', 'baseBranch', 'marker', 'title',
    'titleHash', 'body', 'bodyHash', 'managedLabels', 'desiredLabels', 'terminalComment',
    'commentHash', 'baseObservedSha', 'warnings', 'pullRequest', 'labelMutation',
    'mutationAttempt', 'resumeTarget', 'nextEligibleAt', 'actionKey',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${path} has unexpected field ${key}.`);
  }
  for (const field of [
    'id', 'ownerId', 'repository', 'branch', 'baseBranch', 'marker', 'title', 'body',
    'terminalComment',
  ]) requireString(record[field], `${path}.${field}`);
  requireInteger(record.revision, `${path}.revision`, 1);
  requireInteger(record.issueNumber, `${path}.issueNumber`, 1);
  requireInteger(record.fencingEpoch, `${path}.fencingEpoch`, 1);
  if (typeof record.state !== 'string' || !publicationStates.includes(record.state as MissionPublicationState)) {
    throw new Error(`${path}.state is invalid.`);
  }
  for (const field of ['candidateCommit', 'candidateTree', 'baseSha', 'validationSnapshot']) {
    requireObjectId(record[field], `${path}.${field}`);
  }
  for (const field of ['configHash', 'titleHash', 'bodyHash', 'commentHash']) {
    requireDigest(record[field], `${path}.${field}`);
  }
  requireStringArray(record.validationReceiptIds, `${path}.validationReceiptIds`);
  requireStringArray(record.managedLabels, `${path}.managedLabels`);
  requireStringArray(record.desiredLabels, `${path}.desiredLabels`);
  requireStringArray(record.warnings, `${path}.warnings`);
  if (!(record.desiredLabels as string[]).every((label) => (record.managedLabels as string[]).includes(label))) {
    throw new Error(`${path}.desiredLabels must stay inside managedLabels.`);
  }
  if (!(record.body as string).includes(record.marker as string)) {
    throw new Error(`${path}.body must contain the immutable publication marker.`);
  }
  const commentMarker = (record.marker as string).replace(':publication ', ':publication-comment ');
  if (!(record.terminalComment as string).includes(commentMarker)) {
    throw new Error(`${path}.terminalComment must contain the immutable comment marker.`);
  }
  if (record.titleHash !== digest(record.title as string)
    || record.bodyHash !== digest(record.body as string)
    || record.commentHash !== digest(record.terminalComment as string)) {
    throw new Error(`${path} content hashes do not match pinned content.`);
  }
  if (record.baseObservedSha !== undefined) requireObjectId(record.baseObservedSha, `${path}.baseObservedSha`);
  if (record.pullRequest !== undefined) assertPublicationPullRequest(record.pullRequest, `${path}.pullRequest`);
  if (record.labelMutation !== undefined) {
    const mutation = requireObject(record.labelMutation, `${path}.labelMutation`);
    exactFields(mutation, ['add', 'remove', 'preserve'], `${path}.labelMutation`);
    requireStringArray(mutation.add, `${path}.labelMutation.add`);
    requireStringArray(mutation.remove, `${path}.labelMutation.remove`);
    requireStringArray(mutation.preserve, `${path}.labelMutation.preserve`);
  }
  if (record.mutationAttempt !== undefined) {
    assertMutationAttempt(record.mutationAttempt, `${path}.mutationAttempt`);
  }
  if (record.resumeTarget !== undefined) {
    if (typeof record.resumeTarget !== 'string'
      || !publicationStates.includes(record.resumeTarget as MissionPublicationState)
      || record.resumeTarget === 'resumable') {
      throw new Error(`${path}.resumeTarget is invalid.`);
    }
  }
  if (record.nextEligibleAt !== undefined) exactTimestampField(record.nextEligibleAt, `${path}.nextEligibleAt`);
  if (record.actionKey !== undefined) requireString(record.actionKey, `${path}.actionKey`);
  if (record.state === 'resumable'
    && (!record.resumeTarget || !record.nextEligibleAt || !record.actionKey)) {
    throw new Error(`${path} resumable state requires target, timestamp, and action key.`);
  }
  if (record.state !== 'resumable' && !hasScheduledPublicationRecovery(value as MissionPublicationRecord)
    && (record.resumeTarget !== undefined || record.nextEligibleAt !== undefined || record.actionKey !== undefined)) {
    throw new Error(`${path} non-resumable state cannot retain scheduling metadata.`);
  }
  const effectiveState = record.state === 'resumable' ? record.resumeTarget! : record.state;
  if (record.mutationAttempt !== undefined) {
    const attempt = record.mutationAttempt as MissionPublicationMutationAttempt;
    if (!mutationMatchesState(attempt.kind, effectiveState as MissionPublicationState)
      || attempt.actionKey !== mutationActionKey(value as MissionPublicationRecord, attempt.kind)) {
      throw new Error(`${path}.mutationAttempt does not match its publication phase and identity.`);
    }
  }
  const requiresPullRequest = [
    'pr-confirmed', 'labels-intent', 'labels-confirmed', 'comment-intent', 'review-ready',
  ].includes(effectiveState as string);
  if (requiresPullRequest && record.pullRequest === undefined) {
    throw new Error(`${path} ${String(record.state)} requires a pinned pull request.`);
  }
  if (record.pullRequest !== undefined) {
    const pullRequest = record.pullRequest as MissionPublicationPullRequest;
    if (pullRequest.headRefName !== record.branch || pullRequest.baseRefName !== record.baseBranch
      || digest(pullRequest.title) !== record.titleHash || digest(pullRequest.body) !== record.bodyHash
      || !pullRequest.body.includes(record.marker as string)) {
      throw new Error(`${path}.pullRequest does not match pinned publication content.`);
    }
  }
  if (effectiveState === 'labels-intent' && record.labelMutation === undefined) {
    throw new Error(`${path} labels-intent requires labelMutation.`);
  }
  if (effectiveState !== 'labels-intent' && !terminal(record.state as MissionPublicationState)
    && record.labelMutation !== undefined) {
    throw new Error(`${path}.labelMutation is allowed only in labels-intent.`);
  }
  if ([
    'pr-create-intent', 'pr-confirmed', 'labels-intent', 'labels-confirmed', 'comment-intent',
    'review-ready',
  ].includes(effectiveState as string) && record.baseObservedSha === undefined) {
    throw new Error(`${path} ${String(record.state)} requires an observed base identity.`);
  }
  const typed = value as MissionPublicationRecord;
  const expectedId = publicationAttemptId({
    ownerId: typed.ownerId,
    candidateCommit: typed.candidateCommit,
    baseSha: typed.baseSha,
    configHash: typed.configHash,
  });
  if (typed.id !== expectedId) throw new Error(`${path}.id does not match its pinned identity.`);
}

export function transitionMissionPublication(
  record: MissionPublicationRecord,
  event: MissionPublicationEvent,
): MissionPublicationRecord {
  const next = structuredClone(record);
  if (hasScheduledPublicationRecovery(record) && event.type !== 'resume-eligible') {
    delete next.resumeTarget;
    delete next.nextEligibleAt;
    delete next.actionKey;
  }
  if (event.type === 'remote-safety-conflict' && !terminal(record.state)) {
    return terminalAdvance(next, 'safety-stop');
  }
  if (event.type === 'remote-external-change' && !terminal(record.state)) {
    return terminalAdvance(next, 'external-input-required');
  }
  if (event.type === 'cancel-requested' && !terminal(record.state)) return terminalAdvance(next, 'cancelled');
  if (event.type === 'authority-missing' && !terminal(record.state)) return terminalAdvance(next, 'external-input-required');
  if (event.type === 'transient-failure' && !terminal(record.state)) {
    exactTimestamp(event.nextEligibleAt);
    if (next.mutationAttempt?.stage === 'prepared') delete next.mutationAttempt;
    else if (next.mutationAttempt?.stage === 'dispatched' && event.postconditionObserved) {
      next.mutationAttempt.observationAttempts += 1;
      if (next.mutationAttempt.observationAttempts >= 3) {
        return terminalAdvance(next, 'external-input-required');
      }
    }
    next.resumeTarget = record.state === 'resumable' ? record.resumeTarget : record.state;
    next.nextEligibleAt = event.nextEligibleAt;
    next.actionKey = event.actionKey;
    return advance(next, 'resumable');
  }
  if (record.state === 'resumable' && event.type === 'resume-eligible') {
    exactTimestamp(event.now);
    if (!record.resumeTarget || !record.nextEligibleAt || event.now < record.nextEligibleAt) throw new Error('Publication is not eligible.');
    const target = record.resumeTarget;
    next.state = target;
    next.revision += 1;
    return next;
  }
  if (event.type === 'mutation-attempted' && !terminal(record.state) && record.state !== 'resumable') {
    if (record.mutationAttempt || !mutationMatchesState(event.attempt.kind, record.state)) {
      throw new Error(`Publication mutation attempt is invalid for ${record.state}.`);
    }
    const attempt: MissionPublicationMutationAttempt = {
      ...structuredClone(event.attempt), stage: 'prepared', observationAttempts: 0,
    };
    assertMutationAttempt(attempt, 'Publication mutationAttempt');
    next.mutationAttempt = attempt;
    return advance(next, record.state);
  }
  if (event.type === 'mutation-dispatched' && record.mutationAttempt?.stage === 'prepared'
    && record.mutationAttempt.actionKey === event.actionKey) {
    next.mutationAttempt = { ...record.mutationAttempt, stage: 'dispatched', observationAttempts: 0 };
    return advance(next, record.state);
  }
  if ((record.state === 'prepared' || record.state === 'push-intent') && event.type === 'branch-observed') {
    if (event.observation.kind === 'other') return terminalAdvance(next, 'safety-stop');
    if (event.observation.kind === 'expected') {
      if (event.observation.commitSha !== record.candidateCommit) return terminalAdvance(next, 'safety-stop');
      delete next.mutationAttempt;
      return advance(next, 'pushed');
    }
    return advance(next, 'push-intent');
  }
  if (!terminal(record.state) && record.state !== 'prepared' && record.state !== 'push-intent'
    && record.state !== 'resumable' && event.type === 'base-observed') {
    if (event.observation.kind === 'absent') return terminalAdvance(next, 'external-input-required');
    next.baseObservedSha = event.observation.commitSha;
    if (event.observation.commitSha !== record.baseSha) {
      const warning = `Base branch advanced from ${record.baseSha} to ${event.observation.commitSha} after validation.`;
      if (!next.warnings.includes(warning)) next.warnings.push(warning);
    }
    return advance(next, record.state);
  }
  if ((record.state === 'pushed' || record.state === 'pr-create-intent') && event.type === 'pull-requests-observed') {
    const marked = event.pullRequests.filter((pullRequest) => pullRequest.body.includes(record.marker));
    if (marked.length > 1) return terminalAdvance(next, 'safety-stop');
    if (marked.length === 0) return advance(next, 'pr-create-intent');
    const pullRequest = marked[0]!;
    const immutable = pullRequest.headRefName === record.branch && pullRequest.baseRefName === record.baseBranch;
    if (!immutable) return terminalAdvance(next, 'safety-stop');
    if (pullRequest.state !== 'OPEN' || !pullRequest.isDraft
      || digest(pullRequest.title) !== record.titleHash || digest(pullRequest.body) !== record.bodyHash) {
      return terminalAdvance(next, 'external-input-required');
    }
    next.pullRequest = structuredClone(pullRequest);
    delete next.mutationAttempt;
    return advance(next, 'pr-confirmed');
  }
  if ((record.state === 'pr-confirmed' || record.state === 'labels-intent') && event.type === 'labels-observed') {
    if (record.mutationAttempt
      && (record.mutationAttempt.kind === 'add-labels' || record.mutationAttempt.kind === 'remove-labels')) {
      if (!labelAttemptSatisfied(record.mutationAttempt, event.labels)) {
        return advance(next, 'labels-intent');
      }
      delete next.mutationAttempt;
    }
    const labels = new Set(event.labels);
    const desired = new Set(record.desiredLabels);
    const add = record.desiredLabels.filter((label) => !labels.has(label));
    const remove = record.managedLabels.filter((label) => labels.has(label) && !desired.has(label));
    const preserve = event.labels.filter((label) => !record.managedLabels.includes(label));
    if (add.length || remove.length) {
      next.labelMutation = { add: add.sort(), remove: remove.sort(), preserve: preserve.sort() };
      return advance(next, 'labels-intent');
    }
    delete next.labelMutation;
    return advance(next, 'labels-confirmed');
  }
  if ((record.state === 'labels-confirmed' || record.state === 'comment-intent') && event.type === 'comments-observed') {
    const markerComments = event.comments.filter((comment) => comment.body.includes(record.marker.replace(':publication ', ':publication-comment ')));
    const exact = markerComments.filter((comment) => digest(comment.body) === record.commentHash);
    if (markerComments.length === 0) return advance(next, 'comment-intent');
    if (markerComments.length === 1 && exact.length === 1) {
      delete next.mutationAttempt;
      return terminalAdvance(next, 'review-ready');
    }
    return terminalAdvance(next, 'external-input-required');
  }
  throw new Error(`Publication transition is not allowed: ${record.state} + ${event.type}`);
}

function advance(record: MissionPublicationRecord, state: MissionPublicationState): MissionPublicationRecord {
  record.state = state; record.revision += 1; return record;
}
function terminalAdvance(
  record: MissionPublicationRecord,
  state: Extract<MissionPublicationState, 'review-ready' | 'external-input-required' | 'safety-stop' | 'cancelled'>,
): MissionPublicationRecord {
  delete record.resumeTarget;
  delete record.nextEligibleAt;
  delete record.actionKey;
  delete record.mutationAttempt;
  return advance(record, state);
}

function mutationActionKey(record: MissionPublicationRecord, kind: MissionPublicationMutationKind): string {
  return `publication:${record.id}:${kind}`;
}

function mutationMatchesState(kind: MissionPublicationMutationKind, state: MissionPublicationState): boolean {
  return (kind === 'push' && state === 'push-intent')
    || (kind === 'create-pr' && state === 'pr-create-intent')
    || ((kind === 'add-labels' || kind === 'remove-labels') && state === 'labels-intent')
    || (kind === 'post-comment' && state === 'comment-intent');
}

function labelAttemptSatisfied(attempt: MissionPublicationMutationAttempt, labels: string[]): boolean {
  const observed = new Set(labels);
  if (attempt.kind === 'add-labels') return (attempt.labels ?? []).every((label) => observed.has(label));
  if (attempt.kind === 'remove-labels') return (attempt.labels ?? []).every((label) => !observed.has(label));
  return false;
}

function maintainerAssociation(value: string): boolean {
  return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(value.toUpperCase());
}

function defaultRemoteClassification(error: unknown): 'transient' | 'authority' {
  if (error && typeof error === 'object') {
    const value = error as { status?: unknown; code?: unknown; stderr?: unknown; message?: unknown };
    const combined = `${String(value.status ?? '')} ${String(value.code ?? '')} ${String(value.stderr ?? '')} ${String(value.message ?? '')}`;
    if (/(?:^|\D)(?:401|403)(?:\D|$)|unauthori[sz]ed|forbidden/u.test(combined.toLowerCase())) return 'authority';
  }
  return 'transient';
}

class MissionPublicationBoundaryError extends Error {
  public constructor(
    public readonly actionKey: string,
    public readonly classification: 'transient' | 'authority',
    public readonly cause?: unknown,
    public readonly postconditionObserved = false,
  ) {
    super(`Publication remote boundary failed: ${actionKey}`);
  }
}
function terminal(state: MissionPublicationState): state is Extract<MissionPublicationState,
  'review-ready' | 'external-input-required' | 'safety-stop' | 'cancelled'> {
  return ['review-ready', 'external-input-required', 'safety-stop', 'cancelled'].includes(state);
}
function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
function exactTimestamp(value: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error('Publication timestamp is invalid.');
}

function exactTimestampField(value: unknown, path: string): void {
  if (typeof value !== 'string') throw new Error(`${path} must be a timestamp.`);
  try {
    exactTimestamp(value);
  } catch {
    throw new Error(`${path} must be an exact UTC ISO timestamp.`);
  }
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function exactFields(record: Record<string, unknown>, fields: string[], path: string): void {
  const expected = new Set(fields);
  if (Object.keys(record).length !== expected.size || Object.keys(record).some((key) => !expected.has(key))) {
    throw new Error(`${path} must contain exact fields.`);
  }
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be non-empty.`);
}

function requireInteger(value: unknown, path: string, minimum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${path} must be an integer >= ${minimum}.`);
}

function requireObjectId(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) {
    throw new Error(`${path} must be a full Git object ID.`);
  }
}

function requireDigest(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${path} must be a SHA-256 digest.`);
  }
}

function requireStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
    || new Set(value).size !== value.length) {
    throw new Error(`${path} must contain unique non-empty strings.`);
  }
}

function assertPublicationPullRequest(value: unknown, path: string): void {
  const record = requireObject(value, path);
  exactFields(record, [
    'number', 'nodeId', 'url', 'state', 'isDraft', 'headRefName', 'baseRefName',
    'title', 'body', 'authorAssociation',
  ], path);
  requireInteger(record.number, `${path}.number`, 1);
  for (const field of ['nodeId', 'url', 'headRefName', 'baseRefName', 'title', 'body', 'authorAssociation']) {
    requireString(record[field], `${path}.${field}`);
  }
  if (record.state !== 'OPEN' && record.state !== 'CLOSED' && record.state !== 'MERGED') {
    throw new Error(`${path}.state is invalid.`);
  }
  if (typeof record.isDraft !== 'boolean') throw new Error(`${path}.isDraft must be boolean.`);
}

function assertMutationAttempt(value: unknown, path: string): asserts value is MissionPublicationMutationAttempt {
  const record = requireObject(value, path);
  const allowed = new Set(['kind', 'actionKey', 'stage', 'observationAttempts', 'labels']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(`${path} has unexpected fields.`);
  if (typeof record.kind !== 'string'
    || !['push', 'create-pr', 'add-labels', 'remove-labels', 'post-comment'].includes(record.kind)) {
    throw new Error(`${path}.kind is invalid.`);
  }
  requireString(record.actionKey, `${path}.actionKey`);
  if (record.stage !== 'prepared' && record.stage !== 'dispatched') {
    throw new Error(`${path}.stage is invalid.`);
  }
  requireInteger(record.observationAttempts, `${path}.observationAttempts`, 0);
  if (record.labels !== undefined) requireStringArray(record.labels, `${path}.labels`);
  const labelKind = record.kind === 'add-labels' || record.kind === 'remove-labels';
  if (labelKind !== Array.isArray(record.labels)) throw new Error(`${path}.labels must match its mutation kind.`);
}

function publicationFrom(
  snapshot: MissionStateSnapshot,
  publicationId: string,
): MissionPublicationRecord {
  const stored = snapshot.publications[publicationId];
  if (!stored) throw new Error(`Publication ${publicationId} does not exist.`);
  const record = structuredClone(stored.value) as unknown as MissionPublicationRecord;
  if (record.id !== publicationId || record.revision !== stored.revision) {
    throw new Error(`Publication ${publicationId} identity does not match its stored aggregate.`);
  }
  return record;
}

function publicationOwnerEvent(
  state: Extract<MissionPublicationState,
  'review-ready' | 'external-input-required' | 'safety-stop' | 'cancelled'>,
): 'publication-review-ready' | 'publication-external' | 'publication-safety' | 'publication-cancelled' {
  if (state === 'review-ready') return 'publication-review-ready';
  if (state === 'external-input-required') return 'publication-external';
  if (state === 'safety-stop') return 'publication-safety';
  return 'publication-cancelled';
}
