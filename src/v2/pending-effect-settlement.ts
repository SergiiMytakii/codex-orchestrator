import { canonicalJson } from './containment.js';
import { createPendingEffect, type PendingEffect, type PendingEffectInput } from './run-store.js';

type CommitEffect = Extract<PendingEffect, { kind: 'initial-commit' | 'review-update-commit' }>;
type PushEffect = Extract<PendingEffect, { kind: 'initial-push' | 'review-update-push' }>;
type DraftPullRequestEffect = Extract<PendingEffect, { kind: 'draft-pr' }>;
type CommentEffect = Extract<PendingEffect, {
  kind: 'claim-comment' | 'handoff-comment' | 'spec-question-comment' | 'review-summary';
}>;
type LabelsEffect = Extract<PendingEffect, {
  kind: 'claim-labels' | 'final-labels' | 'blocked-labels' | 'review-activation-labels'
    | 'review-final-labels' | 'review-blocked-labels' | 'spec-waiting-labels';
}>;
type CleanupEffect = Extract<PendingEffect, { kind: 'candidate-pin-release' }>;

export type EffectPostcondition = 'absent' | 'confirmed' | 'diverged';

export type EffectSettlement =
  | { status: 'confirmed' }
  | { status: 'unknown' }
  | { status: 'unauthorized' }
  | { status: 'diverged' }
  | { status: 'unobserved' };

export interface FiniteEffectAdapter {
  observe(): Promise<EffectPostcondition>;
  authorize?(): Promise<boolean>;
  invoke(): Promise<void>;
}

export function settleCommitEffect(effect: CommitEffect, adapter: FiniteEffectAdapter): Promise<EffectSettlement> {
  assertEffect(effect, ['initial-commit', 'review-update-commit'], 'commit');
  return settle(adapter);
}

export function settlePushEffect(effect: PushEffect, adapter: FiniteEffectAdapter): Promise<EffectSettlement> {
  assertEffect(effect, ['initial-push', 'review-update-push'], 'push');
  return settle(adapter);
}

export function settleDraftPullRequestEffect(
  effect: DraftPullRequestEffect,
  adapter: FiniteEffectAdapter,
): Promise<EffectSettlement> {
  assertEffect(effect, ['draft-pr'], 'draft pull request');
  return settle(adapter);
}

export function settleCommentEffect(effect: CommentEffect, adapter: FiniteEffectAdapter): Promise<EffectSettlement> {
  assertEffect(effect, ['claim-comment', 'handoff-comment', 'spec-question-comment', 'review-summary'], 'comment');
  return settle(adapter);
}

export function settleLabelsEffect(effect: LabelsEffect, adapter: FiniteEffectAdapter): Promise<EffectSettlement> {
  assertEffect(effect, [
    'claim-labels', 'final-labels', 'blocked-labels', 'review-activation-labels',
    'review-final-labels', 'review-blocked-labels', 'spec-waiting-labels',
  ], 'labels');
  return settle(adapter);
}

export function settleCleanupEffect(effect: CleanupEffect, adapter: FiniteEffectAdapter): Promise<EffectSettlement> {
  assertEffect(effect, ['candidate-pin-release'], 'cleanup');
  return settle(adapter);
}

async function settle(adapter: FiniteEffectAdapter): Promise<EffectSettlement> {
  let before: EffectPostcondition;
  try { before = await adapter.observe(); }
  catch { return { status: 'unknown' }; }
  if (before === 'confirmed') return { status: 'confirmed' };
  if (before === 'diverged') return { status: 'diverged' };
  if (adapter.authorize && !await adapter.authorize()) return { status: 'unauthorized' };
  try {
    await adapter.invoke();
  } catch {
    return { status: 'unknown' };
  }
  let after: EffectPostcondition;
  try { after = await adapter.observe(); }
  catch { return { status: 'unknown' }; }
  if (after === 'confirmed') return { status: 'confirmed' };
  return { status: after === 'diverged' ? 'diverged' : 'unobserved' };
}

function assertEffect(effect: PendingEffect, allowed: PendingEffect['kind'][], label: string): void {
  if (!allowed.includes(effect.kind)) throw new Error(`${label} effect kind is invalid`);
  const { effectId: _effectId, ...input } = effect;
  if (canonicalJson(effect) !== canonicalJson(createPendingEffect(input as PendingEffectInput))) {
    throw new Error(`${label} effect identity is invalid`);
  }
}
