import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  settleCommentEffect,
  settleCommitEffect,
  settleCleanupEffect,
  settleDraftPullRequestEffect,
  settleLabelsEffect,
  settlePushEffect,
} from '../src/v2/pending-effect-settlement.js';
import { createPendingEffect } from '../src/v2/run-store.js';

test('every finite handler observes a confirmed postcondition without repeating the effect', async () => {
  const cases = [
    () => settleCommitEffect(createPendingEffect({
      kind: 'initial-commit', parentSha: sha('a'), treeSha: sha('b'), message: 'commit',
    }), adapter('confirmed')),
    () => settlePushEffect(createPendingEffect({
      kind: 'initial-push', branch: 'codex/issue-1', sha: sha('c'),
    }), adapter('confirmed')),
    () => settleDraftPullRequestEffect(createPendingEffect({
      kind: 'draft-pr', owner: 'owner', repo: 'repo', head: 'codex/issue-1', base: 'main', issueNumber: 1, marker: 'marker',
    }), adapter('confirmed')),
    () => settleCommentEffect(createPendingEffect({
      kind: 'handoff-comment', issueNumber: 1, marker: 'marker', bodySha256: sha('d'),
    }), adapter('confirmed')),
    () => settleLabelsEffect(createPendingEffect({
      kind: 'final-labels', issueNumber: 1, expected: ['agent:review'],
    }), adapter('confirmed')),
    () => settleCleanupEffect(createPendingEffect({
      kind: 'candidate-pin-release', bindingId: 'f'.repeat(64), expectedPinnedCommitSha: sha('e'),
    }), adapter('confirmed')),
  ];
  for (const run of cases) assert.equal((await run()).status, 'confirmed');
});

test('a handler invokes once only after observing absence and requires the exact postcondition', async () => {
  let state: 'absent' | 'confirmed' = 'absent';
  let invokes = 0;
  const result = await settlePushEffect(createPendingEffect({
    kind: 'review-update-push', batchId: 'batch-1', branch: 'codex/issue-1',
    priorRemoteSha: sha('a'), sha: sha('b'), treeSha: sha('c'),
  }), {
    observe: async () => state,
    invoke: async () => { invokes += 1; state = 'confirmed'; },
  });
  assert.equal(result.status, 'confirmed');
  assert.equal(invokes, 1);
});

test('unknown delivery retains observation-only recovery and never invokes twice after the effect landed', async () => {
  let state: 'absent' | 'confirmed' = 'absent';
  let invokes = 0;
  const effect = createPendingEffect({
    kind: 'review-summary', batchId: 'batch-1', pullRequestNumber: 1, pullRequestNodeId: 'PR_1',
    marker: 'marker', bodySha256: sha('d'), epochHeadSha: sha('e'),
  });
  const unknown = await settleCommentEffect(effect, {
    observe: async () => state,
    invoke: async () => { invokes += 1; state = 'confirmed'; throw new Error('transport lost'); },
  });
  assert.equal(unknown.status, 'unknown');
  const replay = await settleCommentEffect(effect, {
    observe: async () => state,
    invoke: async () => { invokes += 1; },
  });
  assert.equal(replay.status, 'confirmed');
  assert.equal(invokes, 1);
});

test('diverged and unobserved postconditions fail closed with the intent unchanged', async () => {
  const effect = createPendingEffect({
    kind: 'claim-labels', issueNumber: 1, expected: ['agent:auto', 'agent:running'],
  });
  let invokes = 0;
  const diverged = await settleLabelsEffect(effect, {
    observe: async () => 'diverged',
    invoke: async () => { invokes += 1; },
  });
  assert.equal(diverged.status, 'diverged');
  const unobserved = await settleLabelsEffect(effect, {
    observe: async () => 'absent',
    invoke: async () => { invokes += 1; },
  });
  assert.equal(unobserved.status, 'unobserved');
  assert.equal(invokes, 1);
});

test('typed handlers reject the wrong finite effect kind before observation or invocation', async () => {
  let calls = 0;
  assert.throws(() => settlePushEffect(createPendingEffect({
    kind: 'final-labels', issueNumber: 1, expected: ['agent:review'],
  }) as never, {
    observe: async () => { calls += 1; return 'confirmed'; },
    invoke: async () => { calls += 1; },
  }), /push effect kind/u);
  assert.equal(calls, 0);
});

function adapter(observation: 'confirmed') {
  let invokes = 0;
  return {
    observe: async () => observation,
    invoke: async () => { invokes += 1; },
    get invokes() { return invokes; },
  };
}

function sha(character: string): string {
  return character.repeat(40);
}
