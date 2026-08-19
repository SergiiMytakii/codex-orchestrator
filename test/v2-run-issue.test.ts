import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { promisify } from 'node:util';

import type { CheckedChange, CheckedChangePayload, CheckedChangePayloadV1 } from '../src/v2/checked-change.js';
import { createCheckedChangeCapabilities } from '../src/v2/checked-change.js';
import type { AgentAutoConfig } from '../src/v2/config.js';
import { canonicalJson, containsCredentialEvidence, containsHostIdentityEvidence, sha256 } from '../src/v2/containment.js';
import type { DeliveryAuthority } from '../src/v2/delivery-authority.js';
import { CandidateProofInspectionError, type ProveChangeResult } from '../src/v2/acceptance-proof.js';
import { CheckProcessQuiescenceError } from '../src/v2/issue-check-policy.js';
import {
  RunIssue,
  OwnerLockContentionError,
  type ImplementationAgentResult,
  type RunIssueDependencies,
  type RunIssueGit,
  type RunIssueResult,
} from '../src/v2/run-issue.js';
import {
  FileRunRecordWriter,
  InMemoryRunRecordWriter,
  WorkflowGenerationUnrecoverableError,
  type RunRecordWriter,
  type RunStateInspection,
} from '../src/v2/run-store.js';
import { LocalGitRunIssueAdapter } from '../src/v2/runtime.js';
import { createFrozenReviewFeedbackBatch, createReviewFeedbackRunData, hashReviewFeedbackSnapshot, hashReviewFeedbackText } from '../src/v2/review-feedback.js';
import type { ReviewFeedbackObserver } from '../src/v2/review-feedback-coordinator.js';
import { mkdtemp } from './mission-test-temp.js';

const execFileAsync = promisify(execFile);

function reviewParticipants(coordinatorSessionId: string, verdict: 'approve' | 'block' = 'approve', targeted = false) {
  const reviewers = [
    { role: 'spec_reviewer', sessionId: `${coordinatorSessionId}:spec`, verdict },
    { role: 'standards_reviewer', sessionId: `${coordinatorSessionId}:standards`, verdict },
  ];
  return targeted ? reviewers.slice(1) : reviewers;
}

test('continuation worktree restoration proves exact local and remote refs before creation', async () => {
  const fixture = await runFixture();
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const record = (await fixture.store.read()).runs[0]!;
  const publishedHead = record.reviewFeedback!.previousPublishedHeadSha!;
  await execFileAsync('git', ['-C', fixture.targetRoot, 'worktree', 'remove', fixture.worktreePath]);

  const git = new LocalGitRunIssueAdapter();
  await git.ensureContinuationWorktree({
    targetRoot: fixture.targetRoot,
    worktreePath: fixture.worktreePath,
    branchName: record.branchName,
    baseBranch: 'main',
    publishedHeadSha: publishedHead,
  });
  assert.equal(await git.getHead(fixture.worktreePath), publishedHead);

  await execFileAsync('git', ['-C', fixture.targetRoot, 'worktree', 'remove', fixture.worktreePath]);
  await execFileAsync('git', ['-C', fixture.targetRoot, 'update-ref', `refs/heads/${record.branchName}`, fixture.baseSha]);
  await assert.rejects(git.ensureContinuationWorktree({
    targetRoot: fixture.targetRoot,
    worktreePath: fixture.worktreePath,
    branchName: record.branchName,
    baseBranch: 'main',
    publishedHeadSha: publishedHead,
  }), /exactly match/u);
  await assert.rejects(readFile(join(fixture.worktreePath, 'feature.txt')));
});

test('restart settles an exactly created continuation worktree before validation dispatch', async () => {
  const fixture = await runFixture();
  await prepareActiveIssueFeedback(fixture);
  fixture.options.ensureContinuationWorktreeThenRejectOnce = true;

  const interrupted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(interrupted, ['status', 'resumable']), { status: 'transport-failed', resumable: true },
    JSON.stringify({ interrupted, state: await fixture.store.read(), events: fixture.events, evidence: fixture.evidence }));
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect?.kind, 'continuation-worktree-create');
  assert.equal(fixture.events.filter((event) => event === 'git:ensure-continuation-worktree').length, 1);
  fixture.dependencies.implementationAgent = {
    run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
      await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:10:02.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
      await onLaunched?.({ attemptId, pid: 8585, processGroupId: 8585, launchedAt: '2026-07-16T12:10:03.000Z' });
      return { kind: 'completed', attemptId, report: {
        version: 1, status: 'answer-only', summary: 'Answered after recovery.', changedFiles: [], residualRisks: [], response: 'Recovered.',
      } };
    },
  };

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.equal(resumed.status, 'review-ready', JSON.stringify({ resumed, state: await fixture.store.read(), evidence: fixture.evidence }));
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect, undefined);
  assert.equal(fixture.events.filter((event) => event === 'git:ensure-continuation-worktree').length, 1);
  assert.equal(fixture.evidence.some((entry) => entry.code === 'validation-progression-dispatch-invalid'), false);
});

test('proof freshness snapshot excludes only the configured untracked artifact root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-proof-freshness-'));
  await execFileAsync('git', ['init', '-b', 'main', root]);
  await writeFile(join(root, 'README.md'), 'base\n');
  await execFileAsync('git', ['-C', root, 'add', 'README.md']);
  await execFileAsync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'base']);
  await writeFile(join(root, 'feature.txt'), 'product change\n');

  const git = new LocalGitRunIssueAdapter();
  const beforeProof = await git.snapshot(root);
  await mkdir(join(root, '.codex-orchestrator', 'proofs', 'proof-1'), { recursive: true });
  await writeFile(join(root, '.codex-orchestrator', 'proofs', 'proof-1', 'evidence.txt'), 'evidence\n');

  assert.notDeepEqual(await git.snapshot(root), beforeProof);
  assert.deepEqual(
    await git.snapshotIgnoringUntrackedRoot(root, '.codex-orchestrator/proofs'),
    beforeProof,
  );

  await writeFile(join(root, '.codex-orchestrator', 'outside.txt'), 'not proof-owned\n');
  assert.notDeepEqual(
    await git.snapshotIgnoringUntrackedRoot(root, '.codex-orchestrator/proofs'),
    beforeProof,
  );
});

test('candidate V2 ignores shared-index authority, pins the stable tree across prune, and materializes it exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-candidate-'));
  await execFileAsync('git', ['init', '-b', 'main', root]);
  await writeFile(join(root, '.gitignore'), '*.ignored\n');
  await writeFile(join(root, 'tracked.txt'), 'base\n');
  await writeFile(join(root, 'deleted.txt'), 'delete me\n');
  await writeFile(join(root, 'script.sh'), '#!/bin/sh\nexit 0\n');
  await execFileAsync('git', ['-C', root, 'add', '.gitignore', 'tracked.txt', 'deleted.txt', 'script.sh']);
  await execFileAsync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'base']);
  const expectedHeadSha = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();

  await writeFile(join(root, 'tracked.txt'), 'staged stale bytes\n');
  await execFileAsync('git', ['-C', root, 'add', 'tracked.txt']);
  await writeFile(join(root, 'tracked.txt'), 'authoritative worktree bytes\n');
  await writeFile(join(root, 'forced.ignored'), 'staged ignored bytes\n');
  await execFileAsync('git', ['-C', root, 'add', '-f', 'forced.ignored']);
  await writeFile(join(root, 'forced.ignored'), 'ignored worktree bytes\n');
  await writeFile(join(root, 'eligible.txt'), 'eligible untracked\n');
  await execFileAsync('git', ['-C', root, 'add', 'eligible.txt']);
  await rm(join(root, 'deleted.txt'));
  await chmod(join(root, 'script.sh'), 0o755);
  await symlink('tracked.txt', join(root, 'link.txt'));
  await mkdir(join(root, '.codex-orchestrator', 'proofs', 'proof-1'), { recursive: true });
  await writeFile(join(root, '.codex-orchestrator', 'proofs', 'proof-1', 'evidence.txt'), 'excluded proof\n');

  const adapter = new LocalGitRunIssueAdapter();
  const sharedIndexBefore = await adapter.getTreeSha(root);
  const captured = await adapter.candidateV2.captureAndPin({
    worktreePath: root,
    expectedHeadSha,
    runId: '00000000-0000-4000-8000-000000000001',
    boundary: { kind: 'implementation-cycle', cycle: 1, authoritySha256: 'a'.repeat(64) },
    artifactDir: '.codex-orchestrator/proofs',
  });
  assert.equal(captured.kind, 'ok', JSON.stringify(captured));
  if (captured.kind !== 'ok') return;
  const binding = captured.value;
  assert.equal(await adapter.getTreeSha(root), sharedIndexBefore);
  assert.deepEqual(binding.canonicalChangedFiles, ['deleted.txt', 'eligible.txt', 'link.txt', 'script.sh', 'tracked.txt']);
  assert.equal((await execFileAsync('git', ['-C', root, 'show', `${binding.candidateCommitSha}:tracked.txt`])).stdout, 'authoritative worktree bytes\n');
  await assert.rejects(execFileAsync('git', ['-C', root, 'cat-file', '-e', `${binding.candidateCommitSha}:forced.ignored`]));
  await assert.rejects(execFileAsync('git', ['-C', root, 'cat-file', '-e', `${binding.candidateCommitSha}:.codex-orchestrator/proofs/proof-1/evidence.txt`]));

  await execFileAsync('git', ['-C', root, 'prune', '--expire=now']);
  assert.deepEqual(await adapter.candidateV2.inspectPin(binding), { kind: 'ok', value: 'matching' });
  const restartedAdapter = new LocalGitRunIssueAdapter(undefined, root);
  assert.deepEqual(await restartedAdapter.candidateV2.reconcileOrphans!({
    repositoryRoot: root,
    workspaceRoot: join(root, '.worktrees'),
    activeCandidateRefs: [],
    pendingCandidates: [{
      runId: '00000000-0000-4000-8000-000000000001', worktreePath: root, expectedHeadSha,
      boundary: { kind: 'implementation-cycle', cycle: 1, authoritySha256: 'a'.repeat(64) }, artifactDir: '.codex-orchestrator/proofs',
    }],
    activeMaterializations: [],
  }), { kind: 'ok', value: undefined });
  assert.deepEqual(await restartedAdapter.candidateV2.inspectPin(binding), { kind: 'ok', value: 'matching' });
  const prepared = await adapter.candidateV2.prepareMaterialization({
    binding,
    runId: '00000000-0000-4000-8000-000000000001',
    workspaceRoot: join(root, '.worktrees'),
    materializationId: '5'.repeat(64),
  });
  assert.equal(prepared.kind, 'ok', JSON.stringify(prepared));
  if (prepared.kind !== 'ok' || prepared.value.kind !== 'prepared') return;
  const unrecordedSiblingPath = join(dirname(prepared.value.materialization.path), 'unrecorded-sibling');
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '--detach', unrecordedSiblingPath, binding.candidateCommitSha]);
  const divergedActive = await restartedAdapter.candidateV2.reconcileOrphans!({
    repositoryRoot: root,
    workspaceRoot: join(root, '.worktrees'),
    activeCandidateRefs: [binding.candidateRef],
    pendingCandidates: [],
    activeMaterializations: [{ path: prepared.value.materialization.path, candidateCommitSha: 'f'.repeat(40) }],
  });
  assert.equal(divergedActive.kind, 'failed');
  assert.deepEqual(await restartedAdapter.candidateV2.reconcileOrphans!({
    repositoryRoot: root,
    workspaceRoot: join(root, '.worktrees'),
    activeCandidateRefs: [binding.candidateRef],
    pendingCandidates: [],
    activeMaterializations: [{ path: prepared.value.materialization.path, candidateCommitSha: binding.candidateCommitSha }],
  }), { kind: 'ok', value: undefined });
  assert.equal((await execFileAsync('git', ['-C', prepared.value.materialization.path, 'rev-parse', 'HEAD'])).stdout.trim(), binding.candidateCommitSha);
  await assert.rejects(readFile(join(unrecordedSiblingPath, 'tracked.txt')));
  const orphanRef = `refs/codex-orchestrator/candidates/00000000-0000-4000-8000-000000000099/${'9'.repeat(64)}`;
  const orphanPath = join(root, '.worktrees', '.candidate-materializations', 'orphan');
  await execFileAsync('git', ['-C', root, 'update-ref', orphanRef, binding.candidateCommitSha]);
  await mkdir(join(root, '.worktrees', '.candidate-materializations'), { recursive: true });
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '--detach', orphanPath, binding.candidateCommitSha]);
  assert.deepEqual(await restartedAdapter.candidateV2.reconcileOrphans!({
    repositoryRoot: root,
    workspaceRoot: join(root, '.worktrees'),
    activeCandidateRefs: [binding.candidateRef],
    pendingCandidates: [],
    activeMaterializations: [{ path: prepared.value.materialization.path, candidateCommitSha: binding.candidateCommitSha }],
  }), { kind: 'ok', value: undefined });
  await assert.rejects(execFileAsync('git', ['-C', root, 'rev-parse', '--verify', orphanRef]));
  await assert.rejects(readFile(join(orphanPath, 'tracked.txt')));
  assert.equal((await execFileAsync('git', ['-C', prepared.value.materialization.path, 'rev-parse', 'HEAD^{tree}'])).stdout.trim(), binding.candidateTreeSha);
  const artifactPath = '.codex-orchestrator/proofs/proof-2/evidence.txt';
  const artifactBytes = Buffer.from('candidate evidence\n');
  const replayArtifactPath = '.codex-orchestrator/proofs/proof-3/evidence.txt';
  const replayArtifactSha = sha256(artifactBytes);
  await mkdir(join(prepared.value.materialization.path, '.codex-orchestrator', 'proofs', 'proof-3'), { recursive: true });
  await writeFile(join(prepared.value.materialization.path, replayArtifactPath), artifactBytes);
  await mkdir(join(root, '.codex-orchestrator', 'proofs', 'proof-3'), { recursive: true });
  await writeFile(join(root, '.codex-orchestrator', 'proofs', 'proof-3', `.evidence.txt.${replayArtifactSha}.tmp`), 'partial');
  assert.deepEqual(await adapter.candidateV2.copyProofArtifacts({
    materialization: prepared.value.materialization, issueWorktreePath: root, artifactDir: '.codex-orchestrator/proofs', proofId: 'proof-3',
    artifacts: [{ relativePath: replayArtifactPath, sha256: replayArtifactSha }],
  }), { kind: 'ok', value: { kind: 'copied-or-observed' } });
  assert.deepEqual(await readFile(join(root, replayArtifactPath)), artifactBytes);
  await assert.rejects(readFile(join(root, '.codex-orchestrator', 'proofs', 'proof-3', `.evidence.txt.${replayArtifactSha}.tmp`)));
  await writeFile(join(root, '.codex-orchestrator', 'proofs', 'proof-3', `.evidence.txt.${replayArtifactSha}.tmp`), artifactBytes);
  assert.deepEqual(await adapter.candidateV2.copyProofArtifacts({
    materialization: prepared.value.materialization, issueWorktreePath: root, artifactDir: '.codex-orchestrator/proofs', proofId: 'proof-3',
    artifacts: [{ relativePath: replayArtifactPath, sha256: replayArtifactSha }],
  }), { kind: 'ok', value: { kind: 'copied-or-observed' } });
  await assert.rejects(readFile(join(root, '.codex-orchestrator', 'proofs', 'proof-3', `.evidence.txt.${replayArtifactSha}.tmp`)));
  await mkdir(join(prepared.value.materialization.path, '.codex-orchestrator', 'proofs', 'proof-2'), { recursive: true });
  await writeFile(join(prepared.value.materialization.path, artifactPath), artifactBytes);
  const escapedArtifactRoot = join(root, 'escaped-artifacts');
  await mkdir(escapedArtifactRoot);
  await symlink(escapedArtifactRoot, join(root, '.codex-orchestrator', 'proofs', 'proof-2'));
  assert.deepEqual(await adapter.candidateV2.copyProofArtifacts({
    materialization: prepared.value.materialization,
    issueWorktreePath: root,
    artifactDir: '.codex-orchestrator/proofs',
    proofId: 'proof-2',
    artifacts: [{ relativePath: artifactPath, sha256: sha256(artifactBytes) }],
  }), { kind: 'ok', value: { kind: 'artifact-conflict', relativePath: artifactPath } });
  await assert.rejects(readFile(join(escapedArtifactRoot, 'evidence.txt')));
  const fifoArtifactPath = '.codex-orchestrator/proofs/proof-4/evidence.fifo';
  const fifoSource = join(prepared.value.materialization.path, fifoArtifactPath);
  await mkdir(dirname(fifoSource), { recursive: true });
  await execFileAsync('mkfifo', [fifoSource]);
  const fifoCopy = adapter.candidateV2.copyProofArtifacts({
    materialization: prepared.value.materialization, issueWorktreePath: root, artifactDir: '.codex-orchestrator/proofs', proofId: 'proof-4',
    artifacts: [{ relativePath: fifoArtifactPath, sha256: sha256(artifactBytes) }],
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let fifoUnblock: Awaited<ReturnType<typeof open>> | undefined;
  const timed = new Promise<'timed-out'>((resolveTimeout) => {
    timeoutHandle = setTimeout(async () => {
      fifoUnblock = await open(fifoSource, constants.O_RDWR | constants.O_NONBLOCK);
      resolveTimeout('timed-out');
    }, 5_000);
  });
  const fifoOutcome = await Promise.race([fifoCopy, timed]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (fifoOutcome === 'timed-out') {
    await fifoCopy;
    await fifoUnblock?.close();
    assert.fail('FIFO artifact inspection blocked before rejecting the non-regular file');
  }
  assert.deepEqual(fifoOutcome, { kind: 'ok', value: { kind: 'artifact-conflict', relativePath: fifoArtifactPath } });
  await rm(fifoSource);
  assert.deepEqual(await adapter.candidateV2.inspectMaterialization({ binding, materialization: prepared.value.materialization, artifactDir: '.codex-orchestrator/proofs' }), { kind: 'ok', value: 'matching' });
  assert.deepEqual(await adapter.candidateV2.removeMaterialization({ materialization: prepared.value.materialization }), { kind: 'ok', value: undefined });
  assert.deepEqual(await adapter.candidateV2.releasePin({ binding, expectedPinnedCommitSha: binding.candidateCommitSha }), { kind: 'ok', value: undefined });
  assert.deepEqual(await adapter.candidateV2.inspectPin(binding), { kind: 'ok', value: 'missing' });
});

test('known live owner contention requeues before labels or state', async () => {
  const fixture = await runFixture({ ownerContention: true });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'requeued');
  assert.equal(fixture.events.some((event) => event.startsWith('effect:') || event.startsWith('state:')), false);
});

test('runner commit preserves the checked pre-proof index and leaves proof artifacts untracked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-proof-commit-'));
  await execFileAsync('git', ['init', '-b', 'main', root]);
  await writeFile(join(root, 'README.md'), 'base\n');
  await execFileAsync('git', ['-C', root, 'add', 'README.md']);
  await execFileAsync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'base']);
  await writeFile(join(root, 'feature.txt'), 'product change\n');

  const git = new LocalGitRunIssueAdapter();
  await git.stageAll(root);
  const checkedTree = await git.getTreeSha(root);
  await mkdir(join(root, '.codex-orchestrator', 'proofs', 'proof-1'), { recursive: true });
  await writeFile(join(root, '.codex-orchestrator', 'proofs', 'proof-1', 'evidence.txt'), 'evidence\n');

  await git.commit({ worktreePath: root, message: 'feat: checked product only' });
  const observed = await git.inspectHead(root);
  assert.equal(observed.treeSha, checkedTree);
  const committed = (await execFileAsync('git', ['-C', root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).stdout.trim();
  assert.equal(committed, 'feature.txt');
  assert.deepEqual(await git.listChangedFiles(root), ['.codex-orchestrator/proofs/proof-1/evidence.txt']);
  assert.deepEqual(await git.listChangedFilesIgnoringUntrackedRoot(root, '.codex-orchestrator/proofs'), []);
  await execFileAsync('git', ['-C', root, 'add', '.codex-orchestrator/proofs/proof-1/evidence.txt']);
  assert.deepEqual(
    await git.listChangedFilesIgnoringUntrackedRoot(root, '.codex-orchestrator/proofs'),
    ['.codex-orchestrator/proofs/proof-1/evidence.txt'],
  );
});

test('public runIssue reaches review-ready only after ordered durable checks, proof, and publication', async () => {
  const fixture = await runFixture();
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready', `${JSON.stringify(result)}\n${fixture.events.join('\n')}`);
  assertSubsequence(fixture.events, [
    'issue-read:initial',
    'state:claimed:claim-comment',
    'effect:claim-comment',
    'state:claimed:claim-labels',
    'effect:claim-labels',
    'state:implementing:none',
    'issue-read:authorize',
    'agent',
    'state:checking:none',
    'check:typecheck',
    'state:proving:none',
    'proof',
    'state:reviewing:none',
    'review:code-review',
    'state:publishing:none',
    'state:publishing:initial-commit',
    'issue-read:authorize',
    'state:publishing:initial-push',
    'issue-read:authorize',
    'git:push',
    'state:publishing:draft-pr',
    'issue-read:authorize',
    'effect:pr',
    'state:review-ready:none',
    'state:review-ready:terminal-comment',
    'issue-read:authorize',
    'effect:handoff-comment',
    'state:review-ready:terminal-labels',
    'issue-read:authorize',
    'effect:terminal-labels',
    'state:review-ready:none',
    'owner-release',
  ]);
  const remoteHead = (await execFileAsync('git', ['--git-dir', fixture.remoteRoot, 'rev-parse', 'refs/heads/codex/issue-42'])).stdout.trim();
  assert.match(remoteHead, /^[0-9a-f]{40}$/u);
  assert.equal((await execFileAsync('git', ['-C', fixture.worktreePath, 'rev-list', '--count', `${fixture.baseSha}..HEAD`])).stdout.trim(), '1');
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'check:typecheck').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'proof').length, 1);
  assert.equal((await execFileAsync('git', ['-C', fixture.worktreePath, 'log', '-1', '--format=%an <%ae>'])).stdout.trim(), 'codex-orchestrator <codex-orchestrator@users.noreply.github.com>');
  assert.ok(fixture.events.indexOf('state:publication-watermark') < fixture.events.indexOf('git:commit'));
});

test('review-ready persists before independent bounded terminal notifications', async () => {
  const fixture = await runFixture({ permanentlyRejectEffect: 'comment', initialLabels: ['agent:auto', 'manual:keep'] });

  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(first.status, 'review-ready', JSON.stringify({ first, evidence: fixture.evidence, events: fixture.events }));
  const persisted = (await fixture.store.read()).runs[0]!;
  assert.equal(persisted.terminalOutcome?.status, 'review-ready');
  assert.equal(persisted.terminalNotifications?.comment.status, 'pending');
  assert.equal(persisted.terminalNotifications?.labels.status, 'delivered', JSON.stringify({
    notifications: persisted.terminalNotifications, events: fixture.events,
    issue: await fixture.dependencies.issues.read(42),
  }));
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:review', 'manual:keep']);
  assert.ok(
    fixture.events.indexOf('state:review-ready:none') < fixture.events.indexOf('effect:handoff-comment'),
    fixture.events.join('\n'),
  );

  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  const exhausted = (await fixture.store.read()).runs[0]!;
  assert.equal(exhausted.terminalOutcome?.status, 'review-ready');
  assert.deepEqual(exhausted.terminalNotifications?.comment, {
    status: 'exhausted', attempts: 3, diagnostic: 'terminal-comment-delivery-unknown',
  });
  const attempts = fixture.events.filter((event) => event === 'effect:handoff-comment').length;
  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(fixture.events.filter((event) => event === 'effect:handoff-comment').length, attempts);
});

test('terminal comment succeeds when managed-label reconciliation permanently fails', async () => {
  const fixture = await runFixture({ permanentlyRejectEffect: 'labels' });

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.equal(result.status, 'review-ready');
  const persisted = (await fixture.store.read()).runs[0]!;
  assert.equal(persisted.terminalOutcome?.status, 'review-ready');
  assert.equal(persisted.terminalNotifications?.comment.status, 'delivered');
  assert.equal(persisted.terminalNotifications?.labels.status, 'pending');
  const comment = (await fixture.dependencies.issues.read(42))?.comments.find((entry) => entry.body.includes(':handoff -->'));
  assert.match(comment?.body ?? '', /## Summary/u);
  assert.match(comment?.body ?? '', /## Pull request/u);
  assert.match(comment?.body ?? '', /## Passed checks/u);
  assert.match(comment?.body ?? '', /## Publishable proof/u);
  assert.match(comment?.body ?? '', /## Not verified/u);
  assert.match(comment?.body ?? '', /## Known risks/u);
  assert.match(comment?.body ?? '', /## Review focus/u);
  assert.match(comment?.body ?? '', /comment on this issue/u);
  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual((await fixture.store.read()).runs[0]?.terminalNotifications?.labels, {
    status: 'exhausted', attempts: 3, diagnostic: 'terminal-labels-delivery-unknown',
  });
  const attempts = fixture.events.filter((event) => event === 'effect:terminal-labels').length;
  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, attempts);
});

test('all terminal outcomes persist before permanent managed-label failure', async () => {
  const cases: Array<{ name: string; options: FixtureOptions; status: 'review-ready' | 'blocked' | 'internal-error' | 'cancelled' }> = [
    { name: 'review-ready', options: {}, status: 'review-ready' },
    { name: 'blocked', options: { proof: async () => ({ status: 'external-block', blocker: {
      kind: 'service', summary: 'proof service is down', attempted: ['bounded probe'], resumable: false,
    }, receipt: receipt() }) }, status: 'blocked' },
    { name: 'internal-error', options: { agentWrites: false }, status: 'internal-error' },
    { name: 'cancelled', options: { implementationResult: { kind: 'cancelled' } }, status: 'cancelled' },
  ];
  for (const entry of cases) {
    const fixture = await runFixture({ ...entry.options, permanentlyRejectEffect: 'labels' });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, entry.status, entry.name);
    const persisted = (await fixture.store.read()).runs[0]!;
    assert.equal(persisted.terminalOutcome?.status, entry.status, entry.name);
    assert.equal(persisted.terminalNotifications?.comment.status, 'delivered', entry.name);
    assert.equal(persisted.terminalNotifications?.labels.status, 'pending', entry.name);
    assert.ok(
      fixture.events.indexOf(`state:${entry.status}:none`) < fixture.events.indexOf('effect:terminal-labels'),
      `${entry.name}: ${fixture.events.join('\n')}`,
    );
  }
});

test('active feedback terminals quiesce before persistence and tolerate permanent notification failure', async () => {
  const outcomes: Array<{
    name: string;
    result: ImplementationAgentResult;
    status: 'blocked' | 'internal-error' | 'cancelled';
  }> = [
    { name: 'blocked', status: 'blocked', result: { kind: 'completed', report: {
      version: 1, status: 'external-block', summary: 'Provider unavailable.', changedFiles: [], residualRisks: [],
      blocker: { kind: 'service', summary: 'Provider unavailable.', attempted: ['bounded probe'], resumable: false },
    } } },
    { name: 'internal-error', status: 'internal-error', result: { kind: 'internal-error' } },
    { name: 'cancelled', status: 'cancelled', result: { kind: 'cancelled' } },
  ];
  for (const outcome of outcomes) {
    for (const failedEffect of ['comment', 'labels'] as const) {
      const fixture = await runFixture({ initialLabels: ['agent:auto', 'manual:keep'] });
      await prepareActiveIssueFeedback(fixture);
      fixture.options.permanentlyRejectEffect = failedEffect;
      fixture.dependencies.implementationAgent = {
        run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
          await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:10:00.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
          await onLaunched?.({ attemptId, pid: 8383, processGroupId: 8383, launchedAt: '2026-07-16T12:10:01.000Z' });
          return { ...outcome.result, attemptId } as ImplementationAgentResult;
        },
      };
      const eventStart = fixture.events.length;
      const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
      assert.equal(result.status, outcome.status, `${outcome.name}/${failedEffect}`);
      const persisted = (await fixture.store.read()).runs[0]!;
      assert.equal(persisted.terminalOutcome?.status, outcome.status, `${outcome.name}/${failedEffect}`);
      assert.equal(persisted.reviewFeedback?.activeBatch, null, `${outcome.name}/${failedEffect}`);
      assert.equal(persisted.terminalNotifications?.report.outcome, outcome.status, `${outcome.name}/${failedEffect}`);
      assert.equal(persisted.terminalNotifications?.[failedEffect].status, 'pending', `${outcome.name}/${failedEffect}`);
      assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels.includes('manual:keep'), true);
      const events = fixture.events.slice(eventStart);
      assert.ok(
        events.indexOf(`state:${outcome.status}:none`) < events.indexOf(
          failedEffect === 'comment' ? `effect:${outcome.status}-comment` : 'effect:terminal-labels',
        ),
        `${outcome.name}/${failedEffect}: ${events.join('\n')}`,
      );
    }
  }
});

test('blocked, internal-error, and cancelled outcomes finalize before best-effort notifications', async () => {
  const cases: Array<{
    name: string;
    options: FixtureOptions;
    status: 'blocked' | 'internal-error' | 'cancelled';
    labels: string[];
  }> = [
    {
      name: 'blocked',
      options: { proof: async () => ({ status: 'external-block', blocker: {
        kind: 'service', summary: 'proof service is down', attempted: ['bounded probe'], resumable: false,
      }, receipt: receipt() }) },
      status: 'blocked', labels: ['agent:auto', 'agent:blocked', 'manual:keep'],
    },
    { name: 'internal-error', options: { agentWrites: false }, status: 'internal-error', labels: ['agent:auto', 'manual:keep'] },
    {
      name: 'cancelled', options: { implementationResult: { kind: 'cancelled' } },
      status: 'cancelled', labels: ['manual:keep'],
    },
  ];
  for (const entry of cases) {
    const fixture = await runFixture({
      ...entry.options,
      initialLabels: ['agent:auto', 'manual:keep'],
      permanentlyRejectEffect: 'comment',
    });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, entry.status, entry.name);
    const persisted = (await fixture.store.read()).runs[0]!;
    assert.equal(persisted.terminalOutcome?.status, entry.status, entry.name);
    assert.equal(persisted.terminalNotifications?.comment.status, 'pending', entry.name);
    assert.equal(persisted.terminalNotifications?.labels.status, 'delivered', entry.name);
    assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, entry.labels, entry.name);
    const terminalCommentEvent = entry.status === 'blocked'
      ? 'effect:blocked-comment' : `effect:${entry.status}-comment`;
    assert.ok(
      fixture.events.findIndex((event) => event === `state:${entry.status}:none`)
        < fixture.events.findIndex((event) => event === terminalCommentEvent),
      entry.name,
    );
  }
});

test('terminal cutoff and marker remain stable across failed delivery and restart replay', async () => {
  const fixture = await runFixture({
    rejectEffect: 'comment',
    initialComments: [{
      id: '90071992547409931234', body: 'before terminal', authorAssociation: 'OWNER',
      createdAt: '2026-07-16T11:00:00.000Z', updatedAt: '2026-07-16T11:00:00.000Z',
    }, {
      id: '12', body: 'older id returned later', authorAssociation: 'OWNER',
      createdAt: '2026-07-16T11:01:00.000Z', updatedAt: '2026-07-16T11:01:00.000Z',
    }],
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const first = (await fixture.store.read()).runs[0]!;
  const cutoff = structuredClone(first.terminalNotifications?.commentCutoff);
  assert.equal(cutoff?.commentId, '90071992547409931234');

  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  const replay = (await fixture.store.read()).runs[0]!;
  assert.deepEqual(replay.terminalNotifications?.commentCutoff, cutoff);
  assert.equal(replay.pendingEffect, undefined);
  const handoffs = (await fixture.dependencies.issues.read(42))?.comments.filter((comment) => comment.body.includes(':handoff -->')) ?? [];
  assert.equal(handoffs.length, 1);
  assert.match(handoffs[0]!.body.split('\n')[0]!, /:cycle:1:handoff -->$/u);
  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(
    (await fixture.dependencies.issues.read(42))?.comments.filter((comment) => comment.body.includes(':handoff -->')).length,
    1,
  );
});

test('terminal cutoff includes comments added after claim and survives cutoff observation failure', async () => {
  const comment = {
    id: '90071992547409939999', body: 'follow-up before handoff', authorAssociation: 'OWNER',
    createdAt: '2026-07-16T12:30:00.000Z', updatedAt: '2026-07-16T12:30:00.000Z',
  };
  const fixture = await runFixture({ commentBeforeTerminal: comment, rejectTerminalCutoffRead: true });

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.equal(result.status, 'review-ready');
  const persisted = (await fixture.store.read()).runs[0]!;
  assert.equal(persisted.terminalOutcome?.status, 'review-ready');
  assert.equal(persisted.terminalNotifications?.commentCutoff.commentId, null);

  const replayFixture = await runFixture({ commentBeforeTerminal: comment, rejectEffect: 'comment' });
  assert.equal((await replayFixture.runner.runIssue({ targetRoot: replayFixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const cutoff = structuredClone((await replayFixture.store.read()).runs[0]!.terminalNotifications?.commentCutoff);
  assert.equal(cutoff?.commentId, comment.id);
  await replayFixture.runner.runIssue({ targetRoot: replayFixture.targetRoot, issueNumber: 42 });
  assert.deepEqual((await replayFixture.store.read()).runs[0]!.terminalNotifications?.commentCutoff, cutoff);
});

test('direct run executes issue-scoped verification checks instead of repository-wide configured checks', async () => {
  const scopedCommand = 'npm --prefix src/service test -- --runInBand scoped.spec.ts';
  const fixture = await runFixture({ issueBody: `Verification:\n- ${scopedCommand}\n\nRisk:\nLow.` });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.includes('check:changed:issue-verification-001'), true);
  assert.equal(fixture.events.some((event) => event.endsWith(':typecheck')), false);
  const record = (await fixture.store.read()).runs[0]!;
  assert.deepEqual(record.checks.map(({ id, command }) => ({ id, command })), [
    { id: 'issue-verification-001', command: scopedCommand },
  ]);
});

test('invalid issue Verification is an exact semantic blocker and replays without duplicate work', async () => {
  const fixture = await runFixture({ issueBody: 'Verification:\n- npm exec -- sh -c owned', rejectStoreEvent: 'state:blocked:none' });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'decision-delta', resumable: false,
  });
  assert.equal(fixture.events.some((event) => event.startsWith('check:')), false);
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect?.kind, 'outcome-evidence');
  const workCalls = fixture.events.filter((event) => event === 'agent').length;
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'decision-delta', resumable: false,
  });
  assert.equal(result.status === 'blocked' && result.blocker?.kind, 'decision-delta');
  assert.match(result.status === 'blocked' ? result.blocker?.reviewerRejectionDetail ?? '' : '', /Verification/u);
  assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
});

test('rejected initial Review preserves exact decision evidence across restart', async () => {
  const fixture = await runFixture({ reviewRejectedOnce: true, rejectStoreEvent: 'state:blocked:none' });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'decision-delta', resumable: false,
  });
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect?.kind, 'outcome-evidence');
  const reviews = fixture.events.filter((event) => event === 'review:code-review').length;
  const replayed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(replayed, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'decision-delta', resumable: false,
  });
  assert.match(replayed.status === 'blocked' ? replayed.blocker?.summary ?? '' : '', /rejected revision 1/u);
  assert.match(replayed.status === 'blocked' ? replayed.blocker?.reviewerRejectionDetail ?? '' : '', /unauthorized ownership expansion/u);
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, reviews);
});

test('a check launch failure is resumable without consuming an implementation cycle', async () => {
  const options: FixtureOptions = { checkReject: true };
  const fixture = await runFixture(options);
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 1);
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 1);

  options.checkReject = false;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 1);
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 1);
});

test('settled pre-launch check, proof, and Review failures clear prepared execution for the next bounded invocation', async () => {
  const cases: Array<{ name: string; options: FixtureOptions; launchedEvent: string }> = [
    { name: 'configured check', options: { checkPreLaunchRejectOnce: true }, launchedEvent: 'check:typecheck' },
    { name: 'Acceptance Proof', options: { proofPreLaunchRejectOnce: true }, launchedEvent: 'proof' },
    { name: 'Review', options: { reviewPreLaunchTransportOnce: true }, launchedEvent: 'review:code-review-launched' },
  ];
  for (const entry of cases) {
    const fixture = await runFixture(entry.options);
    const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, entry.name);
    const second = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(second.status, 'review-ready', `${entry.name}: ${JSON.stringify({ second, state: await fixture.store.read(), events: fixture.events })}`);
    assert.equal(fixture.events.filter((event) => event === entry.launchedEvent).length, 1, entry.name);
    assert.equal(fixture.events.filter((event) => event === 'agent').length, 1, entry.name);
  }
});

test('malformed code review returns one bounded resumable outcome before retrying the same candidate', async () => {
  const fixture = await runFixture({ reviewMalformedOnce: true });
  const deferred = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(deferred, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, 1);
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, 2);
  assert.deepEqual(fixture.reviewReportRepairInputs.map((entry) => entry.repairOnly), [false, true]);
  assert.equal(fixture.reviewReportRepairInputs[1]?.hash, sha256(Buffer.from('{"report":{"version":1}}')));
  assert.deepEqual(fixture.reviewReportRepairInputs[1]?.bytes, Buffer.from('{"report":{"version":1}}'));
  const record = (await fixture.store.read()).runs[0]!;
  assert.equal(record.directReview?.review.reportRepairs, 1);
  assert.equal(record.directReview?.status, 'clear');
});

test('sixth malformed code review remains resumable without semantic exhaustion', async () => {
  const fixture = await runFixture({ reviewMalformedCount: 6 });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const deferred = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(deferred, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  }
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, 7);
  assert.deepEqual(fixture.reviewReportRepairInputs.map((entry) => entry.repairOnly), [false, true, true, true, true, true, true]);
  for (const correction of fixture.reviewReportRepairInputs.slice(1)) {
    assert.deepEqual(correction.bytes, Buffer.from('{"report":{"version":1}}'));
  }
  assert.equal((await fixture.store.read()).runs[0]?.directReview?.review.reportRepairs, 6);
});

test('incoherent needs-work is repaired report-only instead of reaching terminal state', async () => {
  const fixture = await runFixture({ reviewIncoherentNeedsWorkOnce: true });
  const deferred = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(deferred, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.deepEqual(fixture.reviewReportRepairInputs.map((entry) => entry.repairOnly), [false, true]);
  assert.equal((await fixture.store.read()).runs[0]?.directReview?.status, 'clear');
});

test('repeated runIssue replays the durable terminal outcome without a second claim or publication', async () => {
  const fixture = await runFixture();
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(first.status, 'review-ready', JSON.stringify({ first, evidence: fixture.evidence, events: fixture.events, state: await fixture.store.read() }));
  const effectsBefore = fixture.events.filter((event) => event.startsWith('effect:') || event.startsWith('git:')).length;

  const second = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(second, first);
  assert.equal(fixture.events.filter((event) => event.startsWith('effect:') || event.startsWith('git:')).length, effectsBefore);
  assert.equal((await fixture.store.read()).runs.length, 1);
});

test('trusted issue question answers on the same Run and PR without code, checks, proof, review, commit, or push', async () => {
  const fixture = await runFixture({ initialLabels: ['agent:auto', 'manual:keep'] });
  const initial = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(initial.status, 'review-ready');
  if (initial.status !== 'review-ready') return;
  const before = (await fixture.store.read()).runs[0]!;
  const oldHead = before.reviewFeedback!.previousPublishedHeadSha!;
  const body = 'Why does this preserve the existing behavior?';
  const sourceId = 'issue-comment:90071992547409939999';
  const batch = createFrozenReviewFeedbackBatch({
    runId: before.runId,
    canonicalRepository: before.canonicalRepository,
    pullRequest: {
      nodeId: 'PR_1', number: 1, headSha: oldHead, headRefName: before.branchName,
      baseRefName: 'main', marker: `<!-- codex-orchestrator:run:${before.runId}:pr -->`,
    },
    priorPublishedHeadSha: oldHead,
    sources: [{
      sourceId, kind: 'issue-comment', sourceUrl: 'https://github.com/owner/repo/issues/42#issuecomment-90071992547409939999',
      path: null, line: null, body, bodySha256: hashReviewFeedbackText(body),
      snapshotSha256: hashReviewFeedbackSnapshot({
        sourceId, issueNumber: 42, url: 'https://github.com/owner/repo/issues/42#issuecomment-90071992547409939999',
        bodySha256: hashReviewFeedbackText(body), createdAt: '2026-07-16T12:01:00.000Z',
        updatedAt: '2026-07-16T12:01:00.000Z', author: { login: 'writer', id: '42' },
      }),
      threadState: null, commitSha: oldHead,
      sourceCreatedAt: '2026-07-16T12:01:00.000Z', sourceUpdatedAt: '2026-07-16T12:01:00.000Z',
      author: { login: 'writer', userId: '42' },
      permission: { permission: 'write', userId: '42', checkedAt: '2026-07-16T12:01:01.000Z' },
    }],
    frozenAt: '2026-07-16T12:01:01.000Z',
  });
  let offered = false;
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => offered
      ? { status: 'none', observedHeadSha: oldHead, eligibleSourceIds: [] }
      : (offered = true, { status: 'frozen', batch }),
    revalidate: async () => ({ status: 'valid', observedHeadSha: oldHead }),
  } as unknown as ReviewFeedbackObserver;
  fixture.dependencies.pullRequests.findOpen = async () => ({
    url: initial.pullRequestUrl, body: `<!-- codex-orchestrator:run:${before.runId}:pr -->`,
    number: 1, nodeId: 'PR_1', headSha: oldHead, headRefName: before.branchName, baseRefName: 'main',
  });
  fixture.dependencies.implementationAgent = {
    run: async ({ attemptId, worktreePath, onPrepared, onLaunched, reviewFeedback, reviewFeedbackPullRequest }) => {
      assert.deepEqual(reviewFeedback?.map((feedback) => feedback.id), [sourceId]);
      assert.deepEqual(reviewFeedbackPullRequest, {
        number: 1, headSha: oldHead, headRefName: before.branchName,
        url: 'https://github.com/owner/repo/pull/1',
      });
      await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:01:02.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
      await onLaunched?.({ attemptId, pid: 9191, processGroupId: 9191, launchedAt: '2026-07-16T12:01:03.000Z' });
      fixture.events.push('issue-answer-agent');
      return { kind: 'completed', attemptId, report: {
        version: 1, status: 'answer-only', summary: 'Answered without a change.', changedFiles: [], residualRisks: [],
        response: 'Read /Users/alice/private/debug.log with token=super-secret-value before answering.',
      } };
    },
  };
  let injectAcrossPublication = false;
  const readResponseIssue = fixture.dependencies.issues.read.bind(fixture.dependencies.issues);
  fixture.dependencies.issues.read = async (issueNumber) => {
    if (injectAcrossPublication) {
      const persisted = (await fixture.store.read()).runs[0];
      if (persisted?.activeAttempt?.stage === 'adopted' && persisted.reviewFeedback?.activeBatch === null) {
        injectAcrossPublication = false;
        fixture.comments.push({
          id: '90071992547409940001', body: 'New follow-up across answer publication', authorAssociation: 'OWNER',
          createdAt: '2026-07-16T12:03:00.000Z', updatedAt: '2026-07-16T12:03:00.000Z',
          author: 'writer', authorId: '42',
        });
      }
    }
    return readResponseIssue(issueNumber);
  };
  const responseStore = fixture.dependencies.runRecords;
  let rejectedResponseSettlement = false;
  fixture.dependencies.runRecords = {
    inspect: () => responseStore.inspect(),
    read: () => responseStore.read(),
    compareAndSwap: async (generation, next) => {
      const receipt = next.runs[0]?.reviewFeedback?.history.at(-1);
      if (!rejectedResponseSettlement && receipt?.kind === 'responded' && receipt.publication === 'delivered') {
        rejectedResponseSettlement = true;
        throw new Error('response receipt settlement rejected after external publication');
      }
      return responseStore.compareAndSwap(generation, next);
    },
  };

  const eventStart = fixture.events.length;
  const answered = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.equal(answered.status, 'review-ready');
  assert.equal(answered.status === 'review-ready' ? answered.pullRequestUrl : '', initial.pullRequestUrl);
  const events = fixture.events.slice(eventStart);
  assert.equal(events.filter((event) => event === 'issue-answer-agent').length, 1);
  assert.equal(events.some((event) => event.startsWith('check:') || event === 'proof' || event.startsWith('review:')
    || event === 'git:commit' || event === 'git:push'), false, events.join('\n'));
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.runId, before.runId);
  assert.equal(after.branchName, before.branchName);
  assert.equal(after.cycle, before.cycle + 1);
  const responseReceipt = after.reviewFeedback?.history.at(-1);
  assert.equal(responseReceipt?.kind, 'responded');
  if (responseReceipt?.kind === 'responded') assert.equal(responseReceipt.publication, 'failed');
  assert.equal(after.reviewFeedback?.activeBatch, null);
  assert.equal(after.pendingEffect, undefined);
  assert.equal((await fixture.dependencies.issues.read(42))?.labels.includes('manual:keep'), true);
  assert.deepEqual(after.terminalOutcome, before.terminalOutcome);
  assert.equal(after.outcomeEvidenceId, before.outcomeEvidenceId);
  assert.equal(after.reviewFeedback?.consumedSourceIds.filter((id) => id === sourceId).length, 1);
  assert.equal(fixture.comments.filter((comment) => comment.body.includes(`:issue-feedback:${batch.batchId} -->`)).length, 1);
  const publicAnswer = fixture.comments.find((comment) => comment.body.includes(`:issue-feedback:${batch.batchId} -->`))!.body;
  assert.doesNotMatch(publicAnswer, /Users|super-secret|debug\.log/u);
  assert.match(publicAnswer, /could not be published safely/u);

  const replayEvents = fixture.events.length;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.slice(replayEvents).includes('issue-answer-agent'), false);
  assert.equal(fixture.comments.filter((comment) => comment.body.includes(`:issue-feedback:${batch.batchId} -->`)).length, 1);

  const nextBody = 'Can you clarify one more detail?';
  const nextSourceId = 'issue-comment:90071992547409940002';
  const nextBatch = createFrozenReviewFeedbackBatch({
    runId: before.runId,
    canonicalRepository: before.canonicalRepository,
    pullRequest: structuredClone(batch.pullRequest),
    priorPublishedHeadSha: oldHead,
    sources: [{
      ...batch.sources[0]!, sourceId: nextSourceId, body: nextBody,
      sourceUrl: 'https://github.com/owner/repo/issues/42#issuecomment-90071992547409940002',
      bodySha256: hashReviewFeedbackText(nextBody),
      snapshotSha256: hashReviewFeedbackSnapshot({ nextSourceId }),
      sourceCreatedAt: '2026-07-16T12:02:00.000Z', sourceUpdatedAt: '2026-07-16T12:02:00.000Z',
    }],
    frozenAt: '2026-07-16T12:02:01.000Z',
  });
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => ({ status: 'frozen', batch: nextBatch }),
    revalidate: async () => ({ status: 'valid', observedHeadSha: oldHead }),
  } as unknown as ReviewFeedbackObserver;
  fixture.dependencies.implementationAgent = {
    run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
      await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:02:02.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
      await onLaunched?.({ attemptId, pid: 9291, processGroupId: 9291, launchedAt: '2026-07-16T12:02:03.000Z' });
      return { kind: 'completed', attemptId, report: {
        version: 1, status: 'answer-only', summary: 'Clarified without a change.', changedFiles: [], residualRisks: [],
        response: 'The additional detail is explained here.',
      } };
    },
  };
  const frozenPrePublicationBoundary = {
    commentId: fixture.comments.at(-1)?.id ?? null,
    observedAt: '2026-07-16T12:00:00.000Z',
  };
  injectAcrossPublication = true;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const afterSuccessfulResponse = (await fixture.store.read()).runs[0]!;
  assert.deepEqual(afterSuccessfulResponse.terminalNotifications?.commentCutoff, frozenPrePublicationBoundary);
  assert.equal(afterSuccessfulResponse.reviewFeedback?.consumedSourceIds.includes('issue-comment:90071992547409940001'), false);

  const boundaryBody = 'Also redesign the neighboring workflow.';
  const boundarySourceId = 'issue-comment:90071992547409940000';
  const boundaryBatch = createFrozenReviewFeedbackBatch({
    runId: before.runId,
    canonicalRepository: before.canonicalRepository,
    pullRequest: structuredClone(batch.pullRequest),
    priorPublishedHeadSha: oldHead,
    sources: [{
      ...batch.sources[0]!, sourceId: boundarySourceId, body: boundaryBody,
      sourceUrl: 'https://github.com/owner/repo/issues/42#issuecomment-90071992547409940000',
      bodySha256: hashReviewFeedbackText(boundaryBody),
      snapshotSha256: hashReviewFeedbackSnapshot({ boundarySourceId }),
      sourceCreatedAt: '2026-07-16T12:02:00.000Z', sourceUpdatedAt: '2026-07-16T12:02:00.000Z',
    }],
    frozenAt: '2026-07-16T12:02:01.000Z',
  });
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => ({ status: 'frozen', batch: boundaryBatch }),
    revalidate: async () => ({ status: 'valid', observedHeadSha: oldHead }),
  } as unknown as ReviewFeedbackObserver;
  fixture.dependencies.implementationAgent = {
    run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
      await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:02:02.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
      await onLaunched?.({ attemptId, pid: 9292, processGroupId: 9292, launchedAt: '2026-07-16T12:02:03.000Z' });
      return { kind: 'completed', attemptId, report: {
        version: 1, status: 'boundary', summary: 'The request exceeds the issue.', changedFiles: [], residualRisks: [],
        response: 'This requires a new approved decision before implementation.', boundary: { kind: 'out-of-scope' },
      } };
    },
  };
  fixture.options.permanentlyRejectEffect = 'comment';
  const boundaryResult = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(boundaryResult.status, 'review-ready');
  const boundaryRecord = (await fixture.store.read()).runs[0]!;
  const boundaryReceipt = boundaryRecord.reviewFeedback?.history.at(-1);
  assert.equal(boundaryReceipt?.kind, 'responded');
  if (boundaryReceipt?.kind === 'responded') {
    assert.equal(boundaryReceipt.responseKind, 'boundary');
    assert.equal(boundaryReceipt.publication, 'failed');
  }
  assert.equal(boundaryRecord.reviewFeedback?.consumedSourceIds.filter((id) => id === boundarySourceId).length, 1);
  assert.equal(fixture.comments.some((comment) => comment.body.includes(`:issue-feedback:${boundaryBatch.batchId} -->`)), false);

  fixture.setIssueState('CLOSED');
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => ({ status: 'frozen', batch: boundaryBatch }),
    revalidate: async () => ({ status: 'valid', observedHeadSha: oldHead }),
  } as unknown as ReviewFeedbackObserver;
  fixture.dependencies.implementationAgent.run = async () => { throw new Error('closed issue must not launch Agent'); };
  const closed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(closed.status, 'review-ready');
  assert.equal((await fixture.store.read()).runs[0]!.reviewFeedback?.history.length, boundaryRecord.reviewFeedback?.history.length);
});

test('answer-only fails closed when the discovered open PR no longer matches the frozen batch identity', async () => {
  const fixture = await runFixture();
  await prepareActiveIssueFeedback(fixture);
  const before = (await fixture.store.read()).runs[0]!;
  const originalFindOpen = fixture.dependencies.pullRequests.findOpen.bind(fixture.dependencies.pullRequests);
  let discoveries = 0;
  fixture.dependencies.pullRequests.findOpen = async (input) => {
    discoveries += 1;
    if (discoveries === 1) return originalFindOpen(input);
    return {
      url: 'https://example.invalid/pull/99', body: `<!-- codex-orchestrator:run:${before.runId}:pr -->`,
      number: 99, nodeId: 'PR_REPLACEMENT', headSha: before.reviewFeedback!.previousPublishedHeadSha!,
      headRefName: before.branchName, baseRefName: 'main',
    };
  };
  fixture.dependencies.implementationAgent = {
    run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
      await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:10:02.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
      await onLaunched?.({ attemptId, pid: 8484, processGroupId: 8484, launchedAt: '2026-07-16T12:10:03.000Z' });
      return { kind: 'completed', attemptId, report: {
        version: 1, status: 'answer-only', summary: 'Answer ready.', changedFiles: [], residualRisks: [], response: 'The answer.',
      } };
    },
  };

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: false });
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.reviewFeedback?.consumedSourceIds.includes('issue-comment:terminal'), false);
  assert.equal(JSON.stringify(after.terminalOutcome).includes('pull/99'), false);
  assert.equal(fixture.comments.some((comment) => comment.body.includes(':issue-feedback:')), false);
});

test('review-ready rejects a replacement open PR before feedback discovery or freezing', async () => {
  const fixture = await runFixture();
  const initial = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(initial.status, 'review-ready');
  if (initial.status !== 'review-ready') return;
  const before = (await fixture.store.read()).runs[0]!;
  let observations = 0;
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => {
      observations += 1;
      throw new Error('replacement PR must block before feedback observation');
    },
    revalidate: async () => ({ status: 'valid', observedHeadSha: before.reviewFeedback!.previousPublishedHeadSha! }),
  } as unknown as ReviewFeedbackObserver;
  fixture.dependencies.pullRequests.findOpen = async () => ({
    url: 'https://example.invalid/pull/99',
    body: `<!-- codex-orchestrator:run:${before.runId}:pr -->`,
    number: 99,
    nodeId: 'PR_REPLACEMENT',
    headSha: before.reviewFeedback!.previousPublishedHeadSha!,
    headRefName: before.branchName,
    baseRefName: 'main',
  });

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'safety', resumable: false,
  });
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(observations, 0);
  assert.deepEqual(after.reviewFeedback?.consumedSourceIds, before.reviewFeedback?.consumedSourceIds);
  assert.equal(after.reviewFeedback?.activeBatch, null);
});

test('review-ready observation safety block retains the feedback baseline and history owner', async () => {
  const fixture = await runFixture();
  const recovered = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(recovered.status, 'review-ready', JSON.stringify({ recovered, evidence: fixture.evidence, events: fixture.events, state: await fixture.store.read() }));
  const before = (await fixture.store.read()).runs[0]!;
  const previousHead = before.reviewFeedback?.previousPublishedHeadSha;
  fixture.dependencies.reviewFeedback = {} as ReviewFeedbackObserver;

  const blocked = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(
    pick(blocked, ['status', 'kind', 'resumable']),
    { status: 'blocked', kind: 'safety', resumable: false },
    JSON.stringify({ blocked, evidence: fixture.evidence, events: fixture.events, state: await fixture.store.read() }),
  );
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.reviewFeedback?.activeBatch, null);
  assert.equal(after.reviewFeedback?.previousPublishedHeadSha, previousHead);
  assert.deepEqual(after.reviewFeedback?.history, before.reviewFeedback?.history);
});

test('uninitialized feedback data fails closed without losing the Run', async () => {
  const fixture = await runFixture();
  const recovered = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(recovered.status, 'review-ready', JSON.stringify({ recovered, evidence: fixture.evidence, events: fixture.events, state: await fixture.store.read() }));
  const state = await fixture.store.read();
  await fixture.store.compareAndSwap(state.generation, {
    schema: state.schema,
    runs: state.runs.map((run) => ({ ...run, reviewFeedback: createReviewFeedbackRunData() })),
  });
  fixture.dependencies.reviewFeedback = {} as ReviewFeedbackObserver;

  const blocked = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(blocked, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: false });
  assert.equal((await fixture.store.read()).runs[0]?.reviewFeedback?.previousPublishedHeadSha, null);
});

test('trusted issue-comment repair runs checks, proof, review, and updates the same PR without replacement', async () => {
  const fixture = await runFixture({ initialLabels: ['agent:auto', 'manual:keep'] });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(first.status, 'review-ready');
  const initialState = await fixture.store.read();
  const record = initialState.runs[0]!;
  const diffTrees = fixture.dependencies.git.diffTrees;
  fixture.dependencies.git.diffTrees = async (worktreePath, fromTreeSha, toTreeSha) => {
    if (fromTreeSha !== record.baseSha) throw new Error('published previous tree unavailable');
    return diffTrees(worktreePath, fromTreeSha, toTreeSha);
  };
  const frozenAuthority = canonicalJson(record.deliveryAuthority);
  const oldHead = record.reviewFeedback!.previousPublishedHeadSha!;
  assert.equal(record.reviewFeedback?.activeBatch, null);

  const batch = createFrozenReviewFeedbackBatch({
    runId: record.runId,
    canonicalRepository: record.canonicalRepository,
    pullRequest: {
      nodeId: 'PR_1', number: 1, headSha: oldHead, headRefName: record.branchName,
      baseRefName: 'main', marker: `<!-- codex-orchestrator:run:${record.runId}:pr -->`,
    },
    priorPublishedHeadSha: oldHead,
    sources: [{
      sourceId: 'issue-comment:105', kind: 'issue-comment', sourceUrl: 'https://github.com/owner/repo/issues/42#issuecomment-105',
      path: null, line: null, body: 'Change the implementation.',
      bodySha256: hashReviewFeedbackText('Change the implementation.'),
      snapshotSha256: hashReviewFeedbackSnapshot({ id: '105' }),
      threadState: null, commitSha: oldHead,
      sourceCreatedAt: '2026-07-16T12:00:00.000Z', sourceUpdatedAt: '2026-07-16T12:00:00.000Z',
      author: { login: 'writer', userId: '42' },
      permission: { permission: 'write', userId: '42', checkedAt: '2026-07-16T12:00:00.000Z' },
    }],
    frozenAt: '2026-07-16T12:00:00.000Z',
  });
  let offered = false;
  let transientPrePush = true;
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => {
      if (!offered) { offered = true; return { status: 'frozen', batch }; }
      return { status: 'none', observedHeadSha: await fixture.dependencies.git.getHead(fixture.worktreePath), eligibleSourceIds: [] };
    },
    revalidate: async ({ expectedHeadSha }: { expectedHeadSha: string }) => {
      fixture.events.push('feedback-revalidate');
      if (transientPrePush && (await fixture.store.read()).runs[0]?.pendingEffect?.kind === 'review-update-push') {
        transientPrePush = false;
        return { status: 'retryable', reason: 'temporary GitHub timeout' };
      }
      return { status: 'valid', observedHeadSha: expectedHeadSha };
    },
  } as unknown as ReviewFeedbackObserver;
  const prComments: Array<{ id: string; body: string }> = [];
  fixture.dependencies.pullRequests.findOpen = async () => ({
    url: 'https://example.invalid/pull/1',
    body: `<!-- codex-orchestrator:run:${record.runId}:pr -->\n\nCloses #42`,
    number: 1,
    nodeId: 'PR_1',
    headSha: (await fixture.dependencies.git.getRemoteBranchSha(fixture.worktreePath, record.branchName))!,
    headRefName: record.branchName,
    baseRefName: 'main',
  });
  fixture.dependencies.pullRequests.listConversationComments = async () => structuredClone(prComments);
  fixture.dependencies.pullRequests.postConversationComment = async (_number, body) => {
    const comment = { id: String(prComments.length + 1), body };
    prComments.push(comment);
    return comment;
  };
  let feedbackImplementationCalls = 0;
  fixture.dependencies.implementationAgent = {
    run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
      feedbackImplementationCalls += 1;
      const baseline = await fixture.dependencies.git.snapshot(worktreePath);
      await onPrepared?.({
        attemptId, reportPath: `/tmp/${attemptId}-report.json`,
        preparedAt: '2026-07-16T12:00:00.000Z', baseline,
      });
      await onLaunched?.({ attemptId, pid: 5050 + feedbackImplementationCalls, processGroupId: 5050 + feedbackImplementationCalls, launchedAt: '2026-07-16T12:00:00.000Z' });
      fixture.events.push('feedback-implementation');
      await writeFile(join(worktreePath, 'feature.txt'), `implemented after review ${feedbackImplementationCalls}\n`);
      return {
        kind: 'completed', attemptId,
        report: { version: 1, status: 'completed', summary: 'review fixed', changedFiles: ['feature.txt'], residualRisks: [] },
      };
    },
  };

  const setLabels = fixture.dependencies.issues.setLabels;
  await setLabels(42, []);
  const revoked = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(revoked.status, 'review-ready');
  assert.equal((await fixture.store.read()).runs[0]!.reviewFeedback?.activeBatch, null);
  await setLabels(42, ['agent:review']);
  offered = false;

  let rejectActivationLabels = true;
  fixture.dependencies.issues.setLabels = async (issueNumber, next) => {
    if (rejectActivationLabels && next.includes('agent:running')) {
      rejectActivationLabels = false;
      throw new Error('activation labels interrupted');
    }
    return setLabels(issueNumber, next);
  };
  const interrupted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(interrupted, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const frozen = (await fixture.store.read()).runs[0]!;
  assert.equal(frozen.reviewFeedback?.activeBatch?.batchId, batch.batchId);
  assert.equal(frozen.reviewFeedback?.repairRound, 1);
  assert.equal(frozen.pendingEffect?.kind, 'review-activation-labels');
  assert.equal(frozen.terminalNotifications, undefined);
  assert.equal((await fixture.dependencies.issues.read(42))?.labels.includes('manual:keep'), true);

  const continuationStart = fixture.events.length;
  const transient = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(transient, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, JSON.stringify({ transient, evidence: fixture.evidence, state: await fixture.store.read(), events: fixture.events }));
  const interruptedPublication = (await fixture.store.read()).runs[0]!;
  assert.equal(interruptedPublication.reviewFeedback?.verifiedReceipt?.batchId, batch.batchId);
  assert.equal(interruptedPublication.pendingEffect?.kind, 'review-update-push');
  if (interruptedPublication.pendingEffect?.kind === 'review-update-push') assert.match(interruptedPublication.pendingEffect.treeSha, /^[0-9a-f]{40}$/u);

  const continuationEvents = fixture.events.slice(continuationStart);
  const implementationIndex = continuationEvents.indexOf('feedback-implementation');
  assert.ok(implementationIndex > 0, 'feedback implementation was not launched during continuation');
  assert.ok(
    continuationEvents.slice(0, implementationIndex).filter((event) => event === 'feedback-revalidate').length >= 2,
    'feedback implementation lacked launch-gated authorization after preparation',
  );
  const reviewIndex = continuationEvents.indexOf('review:code-review');
  assert.ok(reviewIndex > 0, 'review:code-review was not launched during continuation');
  assert.equal(continuationEvents[reviewIndex - 1], 'feedback-revalidate', 'review lacked immediate feedback revalidation');
  const reviewLaunchedIndex = continuationEvents.indexOf('review:code-review-launched');
  assert.ok(reviewLaunchedIndex > reviewIndex, 'review launch callback did not complete');
  assert.ok(
    continuationEvents.slice(reviewIndex, reviewLaunchedIndex).filter((event) => event === 'feedback-revalidate').length >= 1,
    'review lacked launch-gated feedback revalidation after preparation',
  );
  const proofIndex = continuationEvents.indexOf('proof');
  assert.ok(proofIndex > 1, 'proof was not launched during continuation');
  const proofValidationIndex = continuationEvents.lastIndexOf('feedback-revalidate', proofIndex);
  assert.ok(proofValidationIndex >= 0, 'proof lacked launch-gated feedback revalidation');
  assert.equal(
    continuationEvents.slice(proofValidationIndex + 1, proofIndex).includes('state:proving:none'),
    true,
    'proof command ran before launched lease persistence',
  );

  const updated = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(updated.status, 'review-ready', JSON.stringify({ updated, evidence: fixture.evidence, state: await fixture.store.read(), events: fixture.events }));
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.cycle, record.cycle + 1);
  assert.equal(after.reviewFeedback?.activeBatch, null);
  assert.equal(after.reviewFeedback?.history.length, 1);
  assert.equal((await fixture.dependencies.issues.read(42))?.labels.includes('manual:keep'), true);
  assert.equal(canonicalJson(after.deliveryAuthority), frozenAuthority);
  assert.equal(prComments.length, 1);
  assert.match(prComments[0]!.body, /Complete independent review/u);
  assert.equal(fixture.events.filter((event) => event === 'effect:pr').length, 1);
  assert.equal(continuationEvents.some((event) => event.startsWith('check:')), true);
  assert.equal(continuationEvents.includes('proof'), true);
  assert.equal(continuationEvents.includes('review:code-review'), true);
  assert.equal((await execFileAsync('git', ['-C', fixture.worktreePath, 'rev-list', '--count', `${oldHead}..HEAD`])).stdout.trim(), '1');

  const effectsBeforeReplay = fixture.events.filter((event) => event.startsWith('effect:') || event.startsWith('git:')).length + prComments.length;
  const replay = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(replay.status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event.startsWith('effect:') || event.startsWith('git:')).length + prComments.length, effectsBeforeReplay);

  const secondHead = after.reviewFeedback!.previousPublishedHeadSha!;
  const secondBatch = createFrozenReviewFeedbackBatch({
    runId: record.runId, canonicalRepository: record.canonicalRepository,
    pullRequest: {
      nodeId: 'PR_1', number: 1, headSha: secondHead, headRefName: record.branchName,
      baseRefName: 'main', marker: `<!-- codex-orchestrator:run:${record.runId}:pr -->`,
    },
    priorPublishedHeadSha: secondHead,
    sources: [{
      sourceId: 'pr-thread:T_2', kind: 'thread', sourceUrl: 'https://example.invalid/pull/1#discussion_r2',
      path: 'feature.txt', line: 1, body: 'Second review request.',
      bodySha256: hashReviewFeedbackText('Second review request.'), snapshotSha256: hashReviewFeedbackSnapshot({ id: 'T_2' }),
      threadState: { isResolved: false, isOutdated: false }, commitSha: secondHead,
      sourceCreatedAt: '2026-07-16T12:05:00.000Z', sourceUpdatedAt: '2026-07-16T12:05:00.000Z',
      author: { login: 'writer', userId: '42' },
      permission: { permission: 'write', userId: '42', checkedAt: '2026-07-16T12:05:00.000Z' },
    }],
    frozenAt: '2026-07-16T12:05:00.000Z',
  });
  const readIssue = fixture.dependencies.issues.read;
  let stripClaim = false;
  fixture.dependencies.issues.read = async (issueNumber) => {
    const issue = await readIssue(issueNumber);
    return issue && stripClaim ? {
      ...issue,
      comments: issue.comments.filter((comment) => !comment.body.includes(':claim -->')),
    } : issue;
  };
  let postPushValidations = 0;
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => ({ status: 'frozen', batch: secondBatch }),
    revalidate: async ({ epoch, expectedHeadSha }: {
      epoch: 'pre-update' | 'post-push'; expectedHeadSha: string;
    }) => {
      if (epoch === 'post-push') postPushValidations += 1;
      if (postPushValidations === 3) {
        stripClaim = true;
        postPushValidations += 1;
        await fixture.dependencies.issues.setLabels(42, ['agent:review', 'extra']);
        return { status: 'blocked', reason: 'permission revoked' };
      }
      return { status: 'valid', observedHeadSha: expectedHeadSha };
    },
  } as unknown as ReviewFeedbackObserver;
  const drifted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(
    pick(drifted, ['status', 'kind', 'resumable']),
    { status: 'blocked', kind: 'safety', resumable: false },
    `${JSON.stringify(drifted)}\n${JSON.stringify((await fixture.store.read()).runs[0]?.pendingEffect)}\n${fixture.events.join('\n')}`,
  );
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:blocked', 'extra', 'manual:keep']);
  assert.equal(
    (await fixture.dependencies.issues.read(42))?.comments.filter((comment) => comment.body.includes(':blocked -->')).length,
    1,
  );
  const blockedRecord = (await fixture.store.read()).runs[0]!;
  assert.equal(blockedRecord.pendingEffect, undefined);
  assert.deepEqual(pick(blockedRecord.terminalOutcome!, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'safety', resumable: false,
  });
  assert.equal(blockedRecord.reviewFeedback?.history.length, 2);
  assert.equal(blockedRecord.reviewFeedback?.history[0]?.kind, 'published');
  assert.equal(blockedRecord.reviewFeedback?.history[1]?.kind, 'blocked-safety');
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:blocked', 'extra', 'manual:keep']);
});

test('review update revalidation settles the exact publication effect before mapping authority failure', async (t) => {
  const stages = [
    { name: 'commit authorization', effect: 'review-update-commit', epoch: 'pre-update' },
    { name: 'push authorization', effect: 'review-update-push', epoch: 'pre-update' },
    { name: 'post-push', effect: undefined, epoch: 'post-push' },
    { name: 'summary authorization', effect: 'review-summary', epoch: 'post-push' },
    { name: 'final labels authorization', effect: 'review-final-labels', epoch: 'post-push' },
  ] as const;
  for (const stage of stages) {
    for (const authorityStatus of ['blocked', 'retryable'] as const) {
      await t.test(`${stage.name} ${authorityStatus}`, async () => {
        const fixture = await runFixture();
        await prepareActiveIssueFeedback(fixture);
        const comments: Array<{ id: string; body: string }> = [];
        fixture.dependencies.pullRequests.listConversationComments = async () => structuredClone(comments);
        fixture.dependencies.pullRequests.postConversationComment = async (_number, body) => {
          const comment = { id: String(comments.length + 1), body };
          comments.push(comment);
          return comment;
        };
        let matched = false;
        fixture.dependencies.reviewFeedback!.revalidate = async ({ epoch, expectedHeadSha }) => {
          const effect = (await fixture.store.read()).runs[0]?.pendingEffect?.kind;
          if (!matched && effect === stage.effect && epoch === stage.epoch) {
            matched = true;
            return { status: authorityStatus, reason: `${stage.name} authority ${authorityStatus}` };
          }
          return { status: 'valid', observedHeadSha: expectedHeadSha };
        };

        const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

        assert.equal(matched, true, stage.name);
        assert.deepEqual(
          pick(result, authorityStatus === 'blocked' ? ['status', 'kind', 'resumable'] : ['status', 'resumable']),
          authorityStatus === 'blocked'
            ? { status: 'blocked', kind: 'safety', resumable: false }
            : { status: 'transport-failed', resumable: true },
          JSON.stringify({ stage, authorityStatus, result, state: await fixture.store.read() }),
        );
        assert.equal(
          (await fixture.store.read()).runs[0]?.pendingEffect?.kind,
          authorityStatus === 'retryable' ? stage.effect : undefined,
        );
      });
    }
  }
});

test('unknown review-summary observation retains the exact durable intent', async () => {
  const fixture = await runFixture();
  await prepareActiveIssueFeedback(fixture);
  fixture.dependencies.pullRequests.postConversationComment = async (_number, body) => ({ id: '1', body });
  fixture.dependencies.pullRequests.listConversationComments = async () => {
    const effect = (await fixture.store.read()).runs[0]?.pendingEffect;
    if (effect?.kind === 'review-summary') throw new Error('summary observation unavailable');
    return [];
  };

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect?.kind, 'review-summary');
});

test('deferred check and proof prevent every later publication effect and terminal return', async () => {
  const checkGate = deferred<{ status: 'passed'; output: Buffer }>();
  const proofGate = deferred<ReturnType<typeof passedProof>>();
  const fixture = await runFixture({
    check: () => checkGate.promise,
    proof: () => proofGate.promise,
  });
  let settled = false;
  const running = fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }).finally(() => { settled = true; });
  await waitFor(() => fixture.events.includes('check:typecheck'));
  assert.equal(fixture.events.some((event) => event.startsWith('git:commit')), false);
  assert.equal(settled, false);
  checkGate.resolve({ status: 'passed', output: Buffer.from('ok') });
  await waitFor(() => fixture.events.includes('proof'));
  assert.equal(fixture.events.some((event) => event.startsWith('git:commit')), false);
  assert.equal(settled, false);
  proofGate.resolve(passedProof());
  const result = await running;
  assert.equal(result.status, 'review-ready', `${JSON.stringify(result)}\n${fixture.events.join('\n')}`);
});

test('four trusted post-PR feedback batches update the same Run and PR through fresh reviewed proof', async () => {
  const fixture = await runFixture();
  const initial = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(initial.status, 'review-ready');
  if (initial.status !== 'review-ready') throw new Error('initial publication failed');
  const pullRequestUrl = initial.pullRequestUrl;
  const firstRecord = (await fixture.store.read()).runs[0]!;
  const runId = firstRecord.runId;
  const branchName = firstRecord.branchName;
  const prComments: Array<{ id: string; body: string }> = [];
  fixture.dependencies.pullRequests.findOpen = async () => ({
    url: pullRequestUrl, body: `<!-- codex-orchestrator:run:${runId}:pr -->\n\nCloses #42`,
    number: 1, nodeId: 'PR_1',
    headSha: (await fixture.dependencies.git.getRemoteBranchSha(fixture.worktreePath, branchName))!,
    headRefName: branchName, baseRefName: 'main',
  });
  fixture.dependencies.pullRequests.listConversationComments = async () => structuredClone(prComments);
  fixture.dependencies.pullRequests.postConversationComment = async (_number, body) => {
    const comment = { id: String(prComments.length + 1), body };
    prComments.push(comment);
    return comment;
  };
  let implementationRound = 0;
  fixture.dependencies.implementationAgent = {
    run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
      implementationRound += 1;
      const baseline = await fixture.dependencies.git.snapshot(worktreePath);
      await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:00:00.000Z', baseline });
      await onLaunched?.({ attemptId, pid: 7000 + implementationRound, processGroupId: 7000 + implementationRound, launchedAt: '2026-07-16T12:00:01.000Z' });
      fixture.events.push('feedback-implementation');
      await writeFile(join(worktreePath, 'feature.txt'), `trusted feedback repair ${implementationRound}\n`);
      return { kind: 'completed', attemptId, report: {
        version: 1, status: 'completed', summary: `feedback ${implementationRound} repaired`, changedFiles: ['feature.txt'], residualRisks: [],
      } };
    },
  };

  const reviewerSessions = new Set<string>();
  for (let round = 1; round <= 4; round += 1) {
    const before = (await fixture.store.read()).runs[0]!;
    const oldHead = before.reviewFeedback!.previousPublishedHeadSha!;
    const batch = createFrozenReviewFeedbackBatch({
      runId, canonicalRepository: before.canonicalRepository,
      pullRequest: {
        nodeId: 'PR_1', number: 1, headSha: oldHead, headRefName: branchName,
        baseRefName: 'main', marker: `<!-- codex-orchestrator:run:${runId}:pr -->`,
      },
      priorPublishedHeadSha: oldHead,
      sources: [{
        sourceId: `pr-thread:T_${round}`, kind: 'thread', sourceUrl: `https://example.invalid/pull/1#discussion_r${round}`,
        path: 'feature.txt', line: 1, body: `Trusted repair ${round}`,
        bodySha256: hashReviewFeedbackText(`Trusted repair ${round}`), snapshotSha256: hashReviewFeedbackSnapshot({ round }),
        threadState: { isResolved: false, isOutdated: false }, commitSha: oldHead,
        sourceCreatedAt: `2026-07-16T12:0${round}:00.000Z`, sourceUpdatedAt: `2026-07-16T12:0${round}:00.000Z`,
        author: { login: 'writer', userId: '42' },
        permission: { permission: 'write', userId: '42', checkedAt: `2026-07-16T12:0${round}:00.000Z` },
      }],
      frozenAt: `2026-07-16T12:0${round}:00.000Z`,
    });
    let offered = false;
    fixture.dependencies.reviewFeedback = {
      observeAndFreeze: async () => {
        if (!offered) { offered = true; return { status: 'frozen', batch }; }
        return { status: 'none', observedHeadSha: await fixture.dependencies.git.getHead(fixture.worktreePath), eligibleSourceIds: [] };
      },
      revalidate: async ({ expectedHeadSha }: { expectedHeadSha: string }) => ({ status: 'valid', observedHeadSha: expectedHeadSha }),
    } as unknown as ReviewFeedbackObserver;
    await fixture.dependencies.issues.setLabels(42, ['agent:review']);
    const eventStart = fixture.events.length;
    const reviewInputStart = fixture.reviewInputs.length;
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, 'review-ready', JSON.stringify({ round, result, state: await fixture.store.read(), events: fixture.events.slice(eventStart) }));
    if (result.status !== 'review-ready') throw new Error(`feedback round ${round} did not publish`);
    assert.equal(result.pullRequestUrl, 'https://example.invalid/pull/1');
    const after = (await fixture.store.read()).runs[0]!;
    assert.equal(after.runId, runId);
    assert.equal(after.reviewFeedback?.history.length, round);
    assert.equal(after.reviewFeedback?.history.at(-1)?.kind, 'published');
    assert.equal(fixture.events.slice(eventStart).filter((event) => event === 'feedback-implementation').length, 1);
    assert.equal(fixture.events.slice(eventStart).filter((event) => event === 'proof').length, 1);
    assert.equal(fixture.events.slice(eventStart).filter((event) => event === 'review:code-review').length, 1);
    assert.equal(fixture.events.slice(eventStart).filter((event) => event === 'git:commit').length, 1);
    assert.equal(fixture.events.slice(eventStart).filter((event) => event === 'git:push').length, 1);
    const reviewInput = fixture.reviewInputs[reviewInputStart];
    assert.ok(reviewInput);
    assert.match(reviewInput.repairPatch, /diff --git a\/feature\.txt b\/feature\.txt/u);
    assert.match(reviewInput.repairPatch, new RegExp(`trusted feedback repair ${round}`, 'u'));
    assert.deepEqual(reviewInput.checks.map((check: { id: string }) => check.id), ['typecheck']);
    assert.equal(reviewerSessions.has(reviewInput.reviewerSessionId), false);
    reviewerSessions.add(reviewInput.reviewerSessionId);
    const newHead = after.reviewFeedback!.previousPublishedHeadSha!;
    assert.equal((await execFileAsync('git', ['-C', fixture.worktreePath, 'rev-list', '--count', `${oldHead}..${newHead}`])).stdout.trim(), '1');
    assert.equal((await execFileAsync('git', ['-C', fixture.worktreePath, 'rev-parse', `${newHead}^`])).stdout.trim(), oldHead);
  }
  assert.equal(implementationRound, 4);
  assert.equal(reviewerSessions.size, 4);
  assert.equal(prComments.every((comment) => comment.body.includes('Targeted independent review')), true);
});

test('trusted feedback preserves exact Implement, Proof, and rejected Review blockers across outcome-evidence replay', async () => {
  for (const phase of ['implementation', 'proof', 'review'] as const) {
    const expectedKind = phase === 'implementation' ? 'decision-delta' as const
      : phase === 'proof' ? 'out-of-scope' as const : 'authority-boundary' as const;
    const blocker = {
      kind: expectedKind,
      summary: `${phase} requires issue-local authority`,
      attempted: [`inspected ${phase} feedback authority`],
      resumable: false,
      reviewerRejectionDetail: `Reviewer rejected expanding ${phase} scope.`,
    };
    const fixtureOptions: FixtureOptions = {};
    const fixture = await runFixture(fixtureOptions);
    const initial = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(initial.status, 'review-ready');
    if (initial.status !== 'review-ready') throw new Error('initial publication failed');
    const record = (await fixture.store.read()).runs[0]!;
    const oldHead = record.reviewFeedback!.previousPublishedHeadSha!;
    fixture.dependencies.pullRequests.findOpen = async () => ({
      url: initial.pullRequestUrl,
      body: `<!-- codex-orchestrator:run:${record.runId}:pr -->\n\nCloses #42`,
      number: 1, nodeId: 'PR_1', headSha: oldHead, headRefName: record.branchName, baseRefName: 'main',
    });
    const batch = createFrozenReviewFeedbackBatch({
      runId: record.runId, canonicalRepository: record.canonicalRepository,
      pullRequest: {
        nodeId: 'PR_1', number: 1, headSha: oldHead, headRefName: record.branchName,
        baseRefName: 'main', marker: `<!-- codex-orchestrator:run:${record.runId}:pr -->`,
      },
      priorPublishedHeadSha: oldHead,
      sources: [{
        sourceId: `pr-thread:${phase}`, kind: 'thread', sourceUrl: `https://example.invalid/pull/1#${phase}`,
        path: 'feature.txt', line: 1, body: `${phase} feedback`,
        bodySha256: hashReviewFeedbackText(`${phase} feedback`), snapshotSha256: hashReviewFeedbackSnapshot({ phase }),
        threadState: { isResolved: false, isOutdated: false }, commitSha: oldHead,
        sourceCreatedAt: '2026-07-16T12:10:00.000Z', sourceUpdatedAt: '2026-07-16T12:10:00.000Z',
        author: { login: 'writer', userId: '42' },
        permission: { permission: 'write', userId: '42', checkedAt: '2026-07-16T12:10:00.000Z' },
      }],
      frozenAt: '2026-07-16T12:10:00.000Z',
    });
    let offered = false;
    fixture.dependencies.reviewFeedback = {
      observeAndFreeze: async () => {
        if (!offered) { offered = true; return { status: 'frozen', batch }; }
        return { status: 'none', observedHeadSha: await fixture.dependencies.git.getHead(fixture.worktreePath), eligibleSourceIds: [] };
      },
      revalidate: async ({ expectedHeadSha }: { expectedHeadSha: string }) => ({ status: 'valid', observedHeadSha: expectedHeadSha }),
    } as unknown as ReviewFeedbackObserver;
    if (phase === 'implementation') {
      fixture.dependencies.implementationAgent = {
        run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
          await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:10:00.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
          await onLaunched?.({ attemptId, pid: 8181, processGroupId: 8181, launchedAt: '2026-07-16T12:10:01.000Z' });
          fixture.events.push('feedback-blocker-work');
          return { kind: 'completed', attemptId, report: { version: 1, status: 'external-block', summary: blocker.summary, changedFiles: [], residualRisks: [], blocker } };
        },
      };
    } else if (phase === 'proof') {
      fixture.dependencies.implementationAgent = {
        run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
          await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:10:00.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
          await onLaunched?.({ attemptId, pid: 8182, processGroupId: 8182, launchedAt: '2026-07-16T12:10:01.000Z' });
          await writeFile(join(worktreePath, 'feature.txt'), 'proof feedback repair\n');
          return { kind: 'completed', attemptId, report: { version: 1, status: 'completed', summary: 'repair ready for proof', changedFiles: ['feature.txt'], residualRisks: [] } };
        },
      };
      fixture.dependencies.proof.proveChange = async ({ beforeAgentLaunch, onLaunched }) => {
        await beforeAgentLaunch?.();
        await onLaunched?.({ pid: 8282, processGroupId: 8282, launchedAt: '2026-07-16T12:10:01.000Z' });
        fixture.events.push('feedback-blocker-work');
        return { status: 'external-block', blocker, receipt: receipt() };
      };
    } else {
      fixtureOptions.reviewRejectedAlways = true;
      fixture.dependencies.implementationAgent = {
        run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
          await onPrepared?.({ attemptId, reportPath: `/tmp/${attemptId}-report.json`, preparedAt: '2026-07-16T12:10:00.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
          await onLaunched?.({ attemptId, pid: 8183, processGroupId: 8183, launchedAt: '2026-07-16T12:10:01.000Z' });
          fixture.events.push('feedback-blocker-work');
          await writeFile(join(worktreePath, 'feature.txt'), 'review feedback repair\n');
          return { kind: 'completed', attemptId, report: { version: 1, status: 'completed', summary: 'repair ready for review', changedFiles: ['feature.txt'], residualRisks: [] } };
        },
      };
    }
    await fixture.dependencies.issues.setLabels(42, ['agent:review']);
    const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    let replayed = first;
    if (phase === 'review') {
      assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, phase);
      assert.equal((await fixture.store.read()).runs[0]?.pendingEffect, undefined);
      replayed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    }
    const workCalls = fixture.events.filter((event) => event === 'feedback-blocker-work').length;
    if (phase === 'review') {
      assert.deepEqual(pick(replayed, ['status', 'kind', 'resumable']), {
        status: 'blocked', kind: expectedKind, resumable: false,
      }, phase);
      assert.match(replayed.status === 'blocked' ? replayed.blocker?.reviewerRejectionDetail ?? '' : '', /unauthorized ownership expansion/u);
    } else {
      assert.deepEqual(pick(replayed, ['status', 'kind', 'resumable', 'blocker']), {
        status: 'blocked', kind: blocker.kind, resumable: false, blocker,
      }, phase);
    }
    assert.equal(fixture.events.filter((event) => event === 'feedback-blocker-work').length, workCalls, phase);
    assert.equal(
      (await fixture.dependencies.issues.read(42))?.comments.filter((comment) => comment.body.includes(':blocked -->')).length,
      1,
      phase,
    );
    assert.equal((await fixture.store.read()).runs[0]?.reviewFeedback?.history.at(-1)?.kind, `blocked-${expectedKind}`, phase);
  }
});

test('not eligible and revoked authorization start no implementation or publication', async () => {
  const ineligible = await runFixture({ initialLabels: [] });
  assert.equal((await ineligible.runner.runIssue({ targetRoot: ineligible.targetRoot, issueNumber: 42 })).status, 'not-eligible');
  assert.equal(ineligible.events.includes('agent'), false);

  const revoked = await runFixture({ revokeAtAuthorization: 1 });
  const result = await revoked.runner.runIssue({ targetRoot: revoked.targetRoot, issueNumber: 42 });
  assert.deepEqual(
    pick(result, ['status', 'kind', 'resumable']),
    { status: 'blocked', kind: 'safety', resumable: true },
    JSON.stringify({ result, evidence: revoked.evidence, events: revoked.events, state: await revoked.store.read() }),
  );
  assert.equal(revoked.events.includes('agent'), false);
});

test('malformed config and run state return typed internal error before claim effects', async () => {
  const invalidConfig = await runFixture({ invalidConfig: true });
  assert.equal((await invalidConfig.runner.runIssue({ targetRoot: invalidConfig.targetRoot, issueNumber: 42 })).status, 'internal-error');
  assert.equal(invalidConfig.events.includes('effect:claim-labels'), false);

  const invalidState = await runFixture({ storeReadReject: true });
  assert.equal((await invalidState.runner.runIssue({ targetRoot: invalidState.targetRoot, issueNumber: 42 })).status, 'internal-error');
  assert.equal(invalidState.events.includes('effect:claim-labels'), false);
});

test('unsupported state is effect-free before owner lock and after authoritative reread', async () => {
  const unsupported = { status: 'unsupported' as const, rawSha256: 'a'.repeat(64) };
  const preflight = await runFixture({ stateInspections: [unsupported] });
  assert.deepEqual(
    await preflight.runner.runIssue({ targetRoot: preflight.targetRoot, issueNumber: 42 }),
    { status: 'state-schema-unsupported' },
  );
  assert.equal(preflight.events.includes('owner-acquire'), false);
  assert.deepEqual(preflight.evidence, []);
  assert.equal(preflight.events.some((event) => event.startsWith('effect:')), false);

  const postLock = await runFixture({
    stateInspections: [{ status: 'absent', rawSha256: null }, unsupported],
  });
  assert.deepEqual(
    await postLock.runner.runIssue({ targetRoot: postLock.targetRoot, issueNumber: 42 }),
    { status: 'state-schema-unsupported' },
  );
  assert.equal(postLock.events.includes('owner-acquire'), true);
  assert.deepEqual(postLock.evidence, []);
  assert.equal(postLock.events.some((event) => event.startsWith('effect:')), false);
});

test('real old, unknown, malformed, and missing-discriminator state bytes remain unchanged and effect-free', async () => {
  const cases = [
    Buffer.from('{malformed-json\n'),
    Buffer.from('{"schema":"codex-orchestrator.agent-auto-state","version":4}\n'),
    Buffer.from('{"schema":"codex-orchestrator.run-state","generation":1,"runs":[],"unknown":true}\n'),
    Buffer.from('{"schema":"codex-orchestrator.run-state","generation":1,"runs":[{}]}\n'),
  ];
  for (const bytes of cases) {
    const fixture = await runFixture({ rawRunStateBytes: bytes });
    assert.deepEqual(
      await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }),
      { status: 'state-schema-unsupported' },
    );
    assert.deepEqual(await readFile(fixture.statePath), bytes);
    assert.deepEqual(await readdir(dirname(fixture.statePath)), ['run-state.json']);
    assert.equal(fixture.events.includes('owner-acquire'), false);
    assert.deepEqual(fixture.evidence, []);
    assert.equal(fixture.events.some((event) => event.startsWith('effect:')), false);
  }
});

test('a state identity that changes twice after owner lock requeues without effects', async () => {
  const fixture = await runFixture({ stateInspections: [
    { status: 'absent', rawSha256: null },
    {
      status: 'supported',
      rawSha256: 'b'.repeat(64),
      state: { schema: 'codex-orchestrator.run-state', generation: 0, runs: [] },
    },
    { status: 'absent', rawSha256: null },
  ] });
  assert.deepEqual(
    await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }),
    { status: 'requeued', reason: 'state-changed' },
  );
  assert.deepEqual(fixture.evidence, []);
  assert.equal(fixture.events.some((event) => event.startsWith('effect:')), false);
});

test('claimed initialization verifies the pinned workflow generation before implementation', async () => {
  const fixture = await runFixture({ workflowVerificationReject: true });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'safety', resumable: false,
  });
  assert.equal(fixture.events.includes('agent'), false);
});

test('worktree creation failure is diagnostic and resumes the claimed run', async () => {
  const diagnostic = `Existing branch codex/issue-42 is not merged into main; refusing to remove it automatically.\u0000${'x'.repeat(5_000)}`;
  const fixture = await runFixture({ createWorktreeRejectOnce: diagnostic });

  const interrupted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(interrupted, ['status', 'resumable']), {
    status: 'transport-failed', resumable: true,
  });
  const claimed = (await fixture.store.read()).runs[0]!;
  assert.equal(claimed.lifecycle, 'claimed');
  assert.equal(claimed.terminalOutcome, undefined);
  const summary = fixture.evidence.at(-1)?.summary ?? '';
  assert.match(summary, /Existing branch codex\/issue-42 is not merged into main/u);
  assert.equal(summary.length <= 4 * 1024, true);
  assert.doesNotMatch(summary, /\u0000/u);

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(resumed.status, 'review-ready', JSON.stringify({ resumed, evidence: fixture.evidence, events: fixture.events, state: await fixture.store.read() }));
  assert.equal((await fixture.store.read()).runs[0]!.runId, claimed.runId);
});

test('base refresh failure is resumable and creates no claim or run state', async () => {
  const fixture = await runFixture({ getBaseShaRejectOnce: true });
  const interrupted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(interrupted, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal((await fixture.store.read()).runs.length, 0);
  assert.equal(fixture.events.some((event) => event.startsWith('effect:claim')), false);
  assert.equal(fixture.evidence.at(-1)?.code, 'base-refresh-failed');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
});

test('partial worktree creation artifacts remain correctable in the same claimed run', async () => {
  const fixture = await runFixture({ createIncompleteWorktreeThenRejectOnce: true });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const claimed = (await fixture.store.read()).runs[0]!;
  const stillInterrupted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(stillInterrupted, ['status', 'resumable']), {
    status: 'transport-failed', resumable: true,
  });
  assert.equal((await fixture.store.read()).runs[0]!.lifecycle, 'claimed');

  await rm(fixture.worktreePath, { recursive: true });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal((await fixture.store.read()).runs[0]!.runId, claimed.runId);
});

test('diverged claimed worktree remains correctable instead of becoming terminal', async () => {
  const fixture = await runFixture({ createWorktreeRejectOnce: 'partial creation failed', inspectWorktreeDivergedOnce: true });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const claimed = (await fixture.store.read()).runs[0]!;
  const diverged = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(diverged, ['status', 'resumable']), {
    status: 'transport-failed', resumable: true,
  });
  assert.equal((await fixture.store.read()).runs[0]!.lifecycle, 'claimed');

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal((await fixture.store.read()).runs[0]!.runId, claimed.runId);
});

test('historical claim markers do not revoke a newly claimed run', async () => {
  const historicalClaim = [
    '<!-- codex-orchestrator:run:11111111-1111-4111-8111-111111111111:claim -->',
    'codex-orchestrator claimed #42 for branch codex/issue-42',
  ].join('\n');
  const fixture = await runFixture({
    initialComments: [{ id: 'historical-claim', body: historicalClaim, authorAssociation: 'COLLABORATOR' }],
  });

  assert.equal(
    (await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status,
    'review-ready',
  );
});

test('a pre-upgrade snapshot without comment ids accepts only a live claim that predates the run', async () => {
  const historicalClaim = [
    '<!-- codex-orchestrator:run:11111111-1111-4111-8111-111111111111:claim -->',
    'codex-orchestrator claimed #42 for branch codex/issue-42',
  ].join('\n');
  const fixture = await runFixture({
    rejectEffect: 'claim-comment',
    initialComments: [{
      id: 'historical-claim',
      body: historicalClaim,
      authorAssociation: 'COLLABORATOR',
      createdAt: '2026-07-16T11:00:00.000Z',
      updatedAt: '2026-07-16T11:00:00.000Z',
    }],
  });
  assert.equal(
    (await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status,
    'transport-failed',
  );
  const persisted = await fixture.store.read();
  const legacy = structuredClone(persisted);
  for (const comment of legacy.runs[0]!.issueSnapshot.comments ?? []) {
    delete comment.id;
    delete comment.createdAt;
    delete comment.updatedAt;
  }
  await fixture.store.compareAndSwap(persisted.generation, {
    schema: legacy.schema,
    runs: legacy.runs,
  });

  assert.equal(
    (await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status,
    'review-ready',
  );
});

test('agent-authored commit and proof external block map without publication', async () => {
  const cases: Array<{
    name: string;
    options: FixtureOptions;
    expected: Partial<RunIssueResult>;
  }> = [
    { name: 'agent commit', options: { agentCommit: true }, expected: { status: 'blocked', kind: 'safety' } },
    {
      name: 'proof external',
      options: { proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'], resumable: false }, receipt: receipt() }) },
      expected: { status: 'blocked', kind: 'external' },
    },
  ];
  for (const entry of cases) {
    const fixture = await runFixture(entry.options);
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(result, Object.keys(entry.expected)), entry.expected, entry.name);
    assert.equal(fixture.events.includes('git:push'), false, entry.name);
  }
});

test('ignored repository-relative denied path mutation blocks publication', async () => {
  const fixture = await runFixture({ agentWritesDeniedIgnoredPath: true });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'safety', resumable: true,
  });
  assert.equal(fixture.events.includes('git:commit'), false);
  assert.equal(fixture.events.includes('git:push'), false);
});

test('failed checks and proof findings rework the same worktree until review-ready', async () => {
  let checkCalls = 0;
  const checkFixture = await runFixture({
    check: async () => (++checkCalls === 1
      ? { status: 'failed', output: Buffer.from('typecheck failed') }
      : { status: 'passed', output: Buffer.from('ok') }),
  });
  assert.equal((await checkFixture.runner.runIssue({ targetRoot: checkFixture.targetRoot, issueNumber: 42 })).status, 'repair-ready');
  assert.equal((await checkFixture.runner.runIssue({ targetRoot: checkFixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(checkFixture.events.filter((event) => event === 'agent').length, 2);
  assert.equal(checkFixture.events.filter((event) => event === 'review:code-review').length, 1);
  assert.equal((await checkFixture.store.read()).runs[0]?.cycle, 2);

  let proofCalls = 0;
  const proofFixture = await runFixture({
    proof: async () => (++proofCalls === 1
      ? { status: 'needs-rework', findings: ['fix acceptance behavior'], receipt: receipt() }
      : passedProof()),
  });
  assert.equal((await proofFixture.runner.runIssue({ targetRoot: proofFixture.targetRoot, issueNumber: 42 })).status, 'repair-ready');
  assert.equal((await proofFixture.runner.runIssue({ targetRoot: proofFixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(proofFixture.events.filter((event) => event === 'agent').length, 2);
  assert.equal(proofFixture.events.filter((event) => event === 'review:code-review').length, 1);
  assert.equal(proofFixture.events.filter((event) => event === 'proof').length, 2);
  assert.equal((await proofFixture.store.read()).runs[0]?.cycle, 2);
});

test('sixth in-scope repair continues the same Run without semantic exhaustion', async () => {
  let checkCalls = 0;
  const fixture = await runFixture({
    check: async () => (++checkCalls <= 6
      ? { status: 'failed', output: Buffer.from(`still failing ${checkCalls}`) }
      : { status: 'passed', output: Buffer.from('fixed') }),
  });
  for (let repair = 1; repair <= 6; repair += 1) {
    const deferred = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(deferred, ['status', 'source']), { status: 'repair-ready', source: 'check' });
    assert.equal(fixture.events.includes('git:push'), false);
  }
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready', JSON.stringify({ result, evidence: fixture.evidence, events: fixture.events, state: await fixture.store.read() }));
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 7);
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 7);
});

test('review blockers form one targeted repair batch bound to fresh affected proof', async () => {
  const fixture = await runFixture({
    reviewNeedsWorkOnce: true,
    reviewAffectedTargets: ['check:typecheck', 'criterion:ac-001', 'contract:correctness', 'src/a.ts'],
    configuredChecks: { typecheck: 'npm run typecheck', lint: 'npm run lint' },
    issueBody: '## Acceptance Criteria\n- feature.txt implements the behavior.\n- Unrelated documentation remains stable.',
  });
  const deferred = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(deferred, ['status', 'source']), { status: 'repair-ready', source: 'review' },
    JSON.stringify({ deferred, evidence: fixture.evidence, state: await fixture.store.read(), events: fixture.events }));

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready', JSON.stringify({ result, state: await fixture.store.read() }));
  assert.equal(fixture.reviewInputs.length, 2);
  const [initial, repair] = fixture.reviewInputs;
  assert.equal(initial.repairPatch, null);
  assert.equal(initial.previousTarget, null);
  assert.deepEqual(initial.reviewFocus, [
    'candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability',
    'repository-standards', 'requirements', 'tests', 'zero-legacy',
  ]);
  assert.match(repair.repairPatch, /diff --git a\/feature\.txt b\/feature\.txt/u);
  assert.match(repair.repairPatch, /implemented repair/u);
  assert.equal(repair.previousTarget?.targetRevision, 1);
  assert.deepEqual(repair.repairFindings, []);
  assert.deepEqual(repair.checks.map((check: { id: string }) => check.id), ['typecheck']);
  assert.equal(repair.checkedChangeSha256.length, 64);
  assert.equal(repair.proofReceipt.proofId, 'proof-1');
  assert.equal(repair.currentTreeSha.length, 40);
  assert.notEqual(initial.reviewerSessionId, repair.reviewerSessionId);
  assert.equal(initial.implementationAttemptId, repair.implementationAttemptId);
});

test('answer-only outside issue feedback retries the report instead of terminating review repair', async () => {
  const fixture = await runFixture({ reviewNeedsWorkOnce: true });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'repair-ready');

  fixture.dependencies.implementationAgent = {
    run: async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
      await onPrepared?.({
        attemptId,
        reportPath: `/tmp/${attemptId}-report.json`,
        preparedAt: '2026-07-16T12:10:02.000Z',
        baseline: await fixture.dependencies.git.snapshot(worktreePath),
      });
      await onLaunched?.({ attemptId, pid: 8485, processGroupId: 8485, launchedAt: '2026-07-16T12:10:03.000Z' });
      return { kind: 'completed', attemptId, report: {
        version: 1, status: 'answer-only', summary: 'Verification passed without new edits.',
        changedFiles: [], residualRisks: [], response: 'The existing candidate is ready.',
      } };
    },
  };

  const retry = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(retry, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const retryState = (await fixture.store.read()).runs[0]!;
  assert.equal(retryState.lifecycle, 'implementing');
  assert.equal(retryState.terminalOutcome, undefined);
  assert.equal(retryState.reviewFeedback?.activeBatch ?? null, null);

  fixture.dependencies.implementationAgent.run = async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
    await onPrepared?.({
      attemptId,
      reportPath: `/tmp/${attemptId}-report.json`,
      preparedAt: '2026-07-16T12:10:04.000Z',
      baseline: await fixture.dependencies.git.snapshot(worktreePath),
    });
    await onLaunched?.({ attemptId, pid: 8486, processGroupId: 8486, launchedAt: '2026-07-16T12:10:05.000Z' });
    return { kind: 'completed', attemptId, report: {
      version: 1, status: 'completed', summary: 'Verification passed without new edits.',
      changedFiles: ['feature.txt'], residualRisks: [],
    } };
  };

  const completed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(completed.status, 'review-ready', JSON.stringify({ completed, state: await fixture.store.read() }));
});

test('check and proof blockers join the active review repair batch with exact source impact', async () => {
  for (const phase of ['check', 'proof'] as const) {
    let checkCalls = 0;
    let proofCalls = 0;
    const fixture = await runFixture({
      reviewNeedsWorkOnce: true,
      ...(phase === 'check' ? {
        check: async () => (++checkCalls === 2
          ? { status: 'failed' as const, output: Buffer.from('repair check failed') }
          : { status: 'passed' as const, output: Buffer.from('ok') }),
      } : {
        proof: async () => (++proofCalls === 2
          ? { status: 'needs-rework' as const, findings: ['repair proof failed'], receipt: receipt() }
          : passedProof()),
      }),
    });
    assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'repair-ready', phase);
    const blocked = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(blocked, ['status', 'source']), { status: 'repair-ready', source: phase }, phase);
    const active = (await fixture.store.read()).runs[0]!.directReview!;
    assert.equal(active.stage, 'review-repair', phase);
    const added = active.repairFindings.find((finding) => finding.provenance === phase);
    assert.ok(added, phase);
    assert.match(added.sourceId, phase === 'check' ? /^check:typecheck:/u : /^proof:proof-1:/u, phase);
    assert.deepEqual(added.affectedContracts, [phase === 'check' ? 'configured-checks' : 'acceptance-proof'], phase);
    assert.equal(active.review.defects.some((finding) => finding.id === 'finding-1'), true, phase);
  }
});

test('repair review remains targeted while checks and criteria conservatively use full coverage', async () => {
  const fixture = await runFixture({
    reviewNeedsWorkOnce: true,
    reviewAffectedTargets: ['typecheck', 'ac-001', 'correctness', 'src/a.ts'],
    issueBody: '## Acceptance Criteria\n- The primary behavior works.\n- The secondary behavior remains correct.',
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'repair-ready');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const repair = fixture.reviewInputs[1];
  assert.notEqual(repair.repairPatch, null);
  assert.equal(repair.previousTarget?.targetRevision, 1);
  assert.deepEqual(repair.frozenCriteria.map((criterion: { id: string }) => criterion.id), ['ac-001', 'ac-002']);
  assert.deepEqual(repair.checks.map((check: { id: string }) => check.id), ['typecheck']);
});

test('targeted out-of-cone finding reruns full proof and complete Review for the same target', async () => {
  const fixture = await runFixture({
    reviewNeedsWorkOnce: true,
    reviewOutOfConeOnTargetedOnce: true,
    reviewAffectedTargets: ['check:typecheck', 'contract:correctness', 'path:feature.txt'],
    configuredChecks: { typecheck: 'npm run typecheck', lint: 'npm run lint' },
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'repair-ready');
  const fallback = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(fallback, ['status', 'resumable']), { status: 'transport-failed', resumable: true },
    JSON.stringify({ fallback, reviewInputs: fixture.reviewInputs, events: fixture.events }));
  const fallbackState = (await fixture.store.read()).runs[0]!;
  assert.deepEqual(fallbackState.checks, []);
  assert.equal(fallbackState.proofReceipt, undefined);
  assert.notEqual(fallbackState.directReview?.previousTarget, null);
  const completed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(completed.status, 'review-ready', JSON.stringify({ completed, state: await fixture.store.read() }));

  assert.equal(fixture.reviewInputs.length, 3);
  const targeted = fixture.reviewInputs[1]!;
  const complete = fixture.reviewInputs[2]!;
  assert.notEqual(targeted.repairPatch, null);
  assert.equal(complete.repairPatch, null);
  assert.equal(complete.targetRevision, targeted.targetRevision);
  assert.equal(complete.targetFingerprint, targeted.targetFingerprint);
  assert.deepEqual(complete.previousTarget, targeted.previousTarget);
  assert.notEqual(complete.reviewerSessionId, targeted.reviewerSessionId);
  assert.deepEqual(targeted.checks.map((check: { id: string }) => check.id), ['typecheck']);
  assert.deepEqual(complete.checks.map((check: { id: string }) => check.id).sort(), ['lint', 'typecheck']);
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 2, JSON.stringify(fixture.events));
  assert.equal(fixture.events.filter((event) => event === 'proof').length, 3, JSON.stringify(fixture.events));
  assert.equal(fixture.events.filter((event) => event === 'check:typecheck').length, 3, JSON.stringify(fixture.events));
  assert.equal(fixture.events.filter((event) => event === 'check:changed:lint').length, 2, JSON.stringify(fixture.events));
});

test('one in-cone target cannot hide another out-of-cone target from complete fallback', async () => {
  const fixture = await runFixture({
    reviewNeedsWorkOnce: true,
    reviewOutOfConeOnTargetedOnce: true,
    reviewOutOfConeAffectedTargets: ['path:feature.txt', 'path:unrelated.ts'],
    reviewAffectedTargets: ['contract:correctness', 'path:feature.txt'],
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'repair-ready');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const completed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(completed.status, 'review-ready', JSON.stringify({ completed, state: await fixture.store.read(), events: fixture.events }));
  assert.equal(fixture.reviewInputs.length, 3);
  assert.notEqual(fixture.reviewInputs[1]?.repairPatch, null);
  assert.equal(fixture.reviewInputs[2]?.repairPatch, null);
  assert.deepEqual(fixture.reviewInputs[2]?.previousTarget, fixture.reviewInputs[1]?.previousTarget);
});

test('approved targeted Review with an open out-of-cone improvement expands to complete validation', async () => {
  const fixture = await runFixture({
    reviewNeedsWorkOnce: true,
    reviewOutOfConeOnTargetedOnce: true,
    reviewOutOfConeApproved: true,
    reviewAffectedTargets: ['check:typecheck', 'contract:correctness', 'path:feature.txt'],
    configuredChecks: { typecheck: 'npm run typecheck', lint: 'npm run lint' },
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'repair-ready');
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.reviewInputs.length, 3);
  assert.notEqual(fixture.reviewInputs[1]?.repairPatch, null);
  assert.equal(fixture.reviewInputs[2]?.repairPatch, null);
  assert.deepEqual(fixture.reviewInputs[2]?.previousTarget, fixture.reviewInputs[1]?.previousTarget);
  assert.equal(fixture.events.filter((event) => event === 'proof').length, 3);
});

test('review waits when no exact complete or targeted tree delta can be supplied', async () => {
  const fixture = await runFixture({ reviewNeedsWorkOnce: true, diffTreesUnisolatable: true });
  assert.deepEqual(pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']), {
    status: 'transport-failed', resumable: true,
  });
  assert.equal(fixture.reviewInputs.length, 0);
});

test('Review waits when every available target patch is unsafe, oversized, or denied', async () => {
  const cases = [
    {
      name: 'secret evidence',
      diffTreeOverride: { changedFiles: ['feature.txt'], patch: 'diff --git a/feature.txt b/feature.txt\n+access_token=credential-material-12345\n' },
    },
    {
      name: 'oversized patch',
      diffTreeOverride: { changedFiles: ['feature.txt'], patch: `diff --git a/feature.txt b/feature.txt\n+${'x'.repeat(1024 * 1024)}` },
    },
    {
      name: 'denied path', denyReadPaths: ['secrets/**'],
      diffTreeOverride: { changedFiles: ['secrets/value.txt'], patch: 'diff --git a/secrets/value.txt b/secrets/value.txt\n-old\n+new\n' },
    },
  ];
  for (const entry of cases) {
    const fixture = await runFixture({
      reviewNeedsWorkOnce: true, diffTreeOverride: entry.diffTreeOverride, denyReadPaths: entry.denyReadPaths,
      configuredChecks: { lint: 'npm run lint', typecheck: 'npm run typecheck' },
    });
    assert.deepEqual(pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']), {
      status: 'transport-failed', resumable: true,
    }, entry.name);
    assert.equal(fixture.reviewInputs.length, 0, entry.name);
  }
});

test('ordinary external and safety terminals publish the blocked issue status', async () => {
  const cases: Array<{ name: string; options: FixtureOptions; kind: 'external' | 'safety' }> = [
    {
      name: 'external proof blocker',
      options: { proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'], resumable: false }, receipt: receipt() }) },
      kind: 'external',
    },
    { name: 'safety blocker', options: { agentCommit: true }, kind: 'safety' },
  ];
  for (const entry of cases) {
    const fixture = await runFixture(entry.options);
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(result, ['status', 'kind']), { status: 'blocked', kind: entry.kind }, entry.name);
    assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:blocked'], entry.name);
    const comment = (await fixture.dependencies.issues.read(42))?.comments.find((item) => item.body.includes(':blocked -->'));
    assert.match(comment?.body ?? '', /## Reason\nReason: .+\n\nAttempted:\n- .+/u, entry.name);
  }
});

test('issue-local authority blockers preserve their exact evidence-bearing public shape', async () => {
  for (const kind of ['decision-delta', 'out-of-scope', 'authority-boundary'] as const) {
    const blocker = {
      kind,
      summary: `${kind} requires issue-local resolution`,
      attempted: ['inspected frozen issue authority', 'checked the authorized change set'],
      resumable: false,
      reviewerRejectionDetail: 'The requested resolution is outside the executable authority.',
    };
    const fixture = await runFixture({
      implementationResult: {
        kind: 'completed',
        report: { version: 1, status: 'external-block', summary: blocker.summary, changedFiles: [], residualRisks: [], blocker },
      },
    });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(result, ['status', 'kind', 'resumable', 'blocker']), {
      status: 'blocked', kind, resumable: false, blocker,
    });
    assert.deepEqual((await fixture.store.read()).runs[0]?.terminalOutcome, result);
  }
});

test('authority blocker outcome evidence replays exact detail after the terminal state write fails', async () => {
  for (const kind of ['decision-delta', 'out-of-scope', 'authority-boundary'] as const) {
    const blocker = {
      kind,
      summary: `${kind} remains outside issue authority`,
      attempted: ['inspected issue authority', 'inspected reviewer rejection'],
      resumable: false,
      reviewerRejectionDetail: 'Reviewer rejected expanding the authorized scope.',
    };
    const fixture = await runFixture({
      rejectStoreEvent: 'state:blocked:none',
      implementationResult: {
        kind: 'completed',
        report: { version: 1, status: 'external-block', summary: blocker.summary, changedFiles: [], residualRisks: [], blocker },
      },
    });
    const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(first, ['status', 'kind', 'resumable']), {
      status: 'blocked', kind, resumable: false,
    });
    assert.equal((await fixture.store.read()).runs[0]?.pendingEffect?.kind, 'outcome-evidence');
    const workCalls = fixture.events.filter((event) => event === 'agent').length;

    const replayed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(replayed, ['status', 'kind', 'resumable', 'blocker']), {
      status: 'blocked', kind, resumable: false, blocker,
    });
    assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
    assert.equal((await fixture.store.read()).runs[0]?.terminalNotifications?.labels.status, 'delivered');
  }
});

test('temporary proof service unavailability resumes the same Run without duplicate implementation or publication', async () => {
  let proofCalls = 0;
  const fixture = await runFixture({
    proof: async () => {
      proofCalls += 1;
      return proofCalls === 1
        ? { status: 'external-block', blocker: {
          kind: 'service', summary: 'proof service is temporarily unavailable', attempted: ['bounded status probe'], resumable: true,
        }, receipt: receipt() }
        : passedProof();
    },
  });
  const deferred = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(deferred, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const paused = (await fixture.store.read()).runs[0]!;
  assert.equal(paused.terminalOutcome, undefined);
  assert.equal(paused.lifecycle, 'proving');
  assert.equal(fixture.events.at(-1), 'owner-release');

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(resumed.status, 'review-ready', JSON.stringify({ resumed, state: await fixture.store.read(), events: fixture.events }));
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'proof').length, 2);
  assert.equal(fixture.events.filter((event) => event === 'git:push').length, 1);
});

test('blocked label delivery resumes from its durable pendingEffect without rerunning work', async () => {
  const fixture = await runFixture({
    rejectEffect: 'labels',
    proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'], resumable: false }, receipt: receipt() }),
  });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(
    pick(first, ['status', 'kind', 'resumable']),
    { status: 'blocked', kind: 'external', resumable: false },
    JSON.stringify({ first, evidence: fixture.evidence, events: fixture.events }),
  );
  assert.equal((await fixture.store.read()).runs[0]?.terminalNotifications?.labels.status, 'pending');
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect, undefined);
  const workCalls = fixture.events.filter((event) => event === 'agent').length;

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(resumed, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.deepEqual(resumed.status === 'blocked' ? resumed.blocker : undefined, {
    kind: 'service', summary: 'down', attempted: ['retry'], resumable: false,
  });
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:blocked']);
  assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
});

test('blocked terminal publishes its reason before labels and does not duplicate the comment on replay', async () => {
  const fixture = await runFixture({
    proof: async () => ({ status: 'external-block', blocker: {
      kind: 'service', summary: 'proof service is down', attempted: ['bounded status probe'], resumable: false,
    }, receipt: receipt() }),
  });

  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  const issue = await fixture.dependencies.issues.read(42);
  const blockedComments = issue?.comments.filter((comment) => comment.body.includes(':blocked -->')) ?? [];
  assert.equal(blockedComments.length, 1);
  assert.match(blockedComments[0]!.body, /proof service is down/u);
  assert.match(blockedComments[0]!.body, /bounded status probe/u);
  assert.match(blockedComments[0]!.body, /Kind: external/u);
  assert.match(blockedComments[0]!.body, /Resumable: no/u);
  assert.ok(
    fixture.events.indexOf('state:blocked:none') < fixture.events.indexOf('effect:blocked-comment')
      && fixture.events.indexOf('effect:blocked-comment') < fixture.events.indexOf('effect:terminal-labels'),
    fixture.events.join('\n'),
  );

  const replay = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(replay, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.equal(
    (await fixture.dependencies.issues.read(42))?.comments.filter((comment) => comment.body.includes(':blocked -->')).length,
    1,
  );
});

test('blocked terminal publishes bounded public text without host paths or credential evidence', async () => {
  const unsafeSummary = 'token=credential-material-12345';
  const fixture = await runFixture({
    proof: async () => ({ status: 'external-block', blocker: {
      kind: 'service', summary: unsafeSummary,
      attempted: Array.from({ length: 4 }, () => 'x'.repeat(3_000)), resumable: false,
    }, receipt: receipt() }),
  });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'blocked', JSON.stringify({ unsafeSummary, result, evidence: fixture.evidence, state: await fixture.store.read() }));
  const comment = (await fixture.dependencies.issues.read(42))?.comments.find((item) => item.body.includes(':blocked -->'));
  assert.ok(comment);
  assert.ok(comment.body.length < 16_384);
  assert.equal(comment.body.includes(unsafeSummary), false, unsafeSummary);
});

test('host identity detection covers generic and Markdown-delimited paths without rejecting artifact text', () => {
  for (const value of [
    'cwd:/Users/example/.ssh/id_rsa',
    String.raw`failed(C:\Users\alice\.ssh\id_rsa)`,
    String.raw`root:C:\Users\alice\.ssh\id_rsa`,
    'file:///C:/Users/alice/.ssh/id_rsa',
    'failed while reading /var/lib/codex/private.log',
    '/root/.ssh/id_rsa',
    '/workspace/project/output.txt',
    '/nix/store/private-output',
    'build failed at `/root/.ssh/id_rsa`',
    'see [/workspace/project/output.txt]',
  ]) assert.equal(containsHostIdentityEvidence(value), true, value);
  for (const value of [
    '<hierarchy><node text="Android proof ready" /></hierarchy>',
    'proofs/proof-android/final.xml',
    'I/flutter: Android proof ready',
    'https://example.invalid/issues/42',
  ]) assert.equal(containsHostIdentityEvidence(value), false, value);
});

test('credential detection covers public terminal credential forms', () => {
  for (const value of [
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'github_pat_abcdefghijklmnopqrstuvwxyz123456',
    'https://alice:credential-material@example.invalid/private',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'NPM_TOKEN=npm-credential-material-12345',
  ]) assert.equal(containsCredentialEvidence(value), true, value);
});

test('blocked comment settlement never posts after the issue closes', async () => {
  const fixture = await runFixture({
    rejectEffect: 'comment',
    proof: async () => ({ status: 'external-block', blocker: {
      kind: 'service', summary: 'down', attempted: ['retry'], resumable: false,
    }, receipt: receipt() }),
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'blocked');
  const readOpen = fixture.dependencies.issues.read;
  fixture.dependencies.issues.read = async (issueNumber) => {
    const observed = await readOpen(issueNumber);
    return observed ? { ...observed, state: 'CLOSED', comments: [] } : observed;
  };
  const postAttempts = fixture.events.filter((event) => event === 'effect:blocked-comment').length;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'blocked');
  }
  assert.equal(fixture.events.filter((event) => event === 'effect:blocked-comment').length, postAttempts);
  assert.deepEqual((await fixture.store.read()).runs[0]?.terminalNotifications?.comment, {
    status: 'exhausted', attempts: 3, diagnostic: 'terminal-comment-observation-diverged',
  });
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect, undefined);
});

test('blocked comment delivery resumes from its durable intent without rerunning work', async () => {
  const fixture = await runFixture({
    rejectEffect: 'comment',
    proof: async () => ({ status: 'external-block', blocker: {
      kind: 'service', summary: 'down', attempted: ['retry'], resumable: false,
    }, receipt: receipt() }),
  });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.equal((await fixture.store.read()).runs[0]?.terminalNotifications?.comment.status, 'pending');
  const workCalls = fixture.events.filter((event) => event === 'agent').length;

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(resumed, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
  assert.equal(
    (await fixture.dependencies.issues.read(42))?.comments.filter((comment) => comment.body.includes(':blocked -->')).length,
    1,
  );
});

test('blocked comment survives a crash after remote publication without duplication or rerunning work', async () => {
  const fixture = await runFixture({
    rejectStoreTransition: { from: 'terminal-comment', to: 'none' },
    proof: async () => ({ status: 'external-block', blocker: {
      kind: 'service', summary: 'down', attempted: ['retry'], resumable: false,
    }, receipt: receipt() }),
  });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect?.kind, 'terminal-comment');
  assert.equal(
    (await fixture.dependencies.issues.read(42))?.comments.filter((comment) => comment.body.includes(':blocked -->')).length,
    1,
  );
  const workCalls = fixture.events.filter((event) => event === 'agent').length;

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(resumed, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
  assert.equal(
    (await fixture.dependencies.issues.read(42))?.comments.filter((comment) => comment.body.includes(':blocked -->')).length,
    1,
  );
});

test('blocked label delivery survives a crash after the remote effect without duplicating work or labels', async () => {
  const fixture = await runFixture({
    rejectStoreTransition: { from: 'terminal-labels', to: 'none' },
    proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'], resumable: false }, receipt: receipt() }),
  });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:blocked']);
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect?.kind, 'terminal-labels');
  const workCalls = fixture.events.filter((event) => event === 'agent').length;
  const labelEffects = fixture.events.filter((event) => event === 'effect:terminal-labels').length;

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(resumed, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
  assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, labelEffects);
});

test('blocked terminal replay repairs a stale running label without rerunning work', async () => {
  const fixture = await runFixture({
    proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'], resumable: false }, receipt: receipt() }),
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'blocked');
  const workCalls = fixture.events.filter((event) => event === 'agent').length;
  const cases = [
    { before: ['agent:auto', 'agent:running'], after: ['agent:auto', 'agent:blocked'] },
    { before: ['manual:keep', 'agent:auto', 'agent:running', 'agent:blocked'], after: ['agent:auto', 'agent:blocked', 'manual:keep'] },
    { before: ['manual:keep', 'agent:running', 'agent:blocked'], after: ['agent:blocked', 'manual:keep'] },
  ];
  for (const entry of cases) {
    await fixture.dependencies.issues.setLabels(42, entry.before);
    const replayed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(
      pick(replayed, ['status', 'kind']),
      { status: 'blocked', kind: 'external' },
      `${JSON.stringify(await fixture.store.read())}\n${fixture.events.join('\n')}`,
    );
    assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, entry.after);
    assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
  }
});

test('blocked transition preserves concurrent labels and never restores revoked authorization', async () => {
  for (const entry of [
    { concurrent: ['manual:keep', 'agent:running'], expected: ['agent:blocked', 'manual:keep'] },
    { concurrent: ['manual:keep'], expected: ['manual:keep'] },
  ]) {
    const fixture = await runFixture({
      blockedTransitionLabels: entry.concurrent,
      proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'], resumable: false }, receipt: receipt() }),
    });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(result, ['status', 'kind']), { status: 'blocked', kind: 'external' });
    assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, entry.expected);
  }
});

test('blocked transition resumes when the post-effect projection write fails', async () => {
  const fixture = await runFixture({
    blockedTransitionLabels: ['agent:running'],
    rejectStoreTransition: { from: 'terminal-labels', to: 'none' },
    proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'], resumable: false }, receipt: receipt() }),
  });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:blocked']);
  assert.equal((await fixture.store.read()).runs[0]?.pendingEffect?.kind, 'terminal-labels');
  const workCalls = fixture.events.filter((event) => event === 'agent').length;
  const labelEffects = fixture.events.filter((event) => event === 'effect:terminal-labels').length;

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(resumed, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
  assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, labelEffects);
});

test('malformed report and clean transport failures retry full implementation without consuming a cycle', async () => {
  const malformed = await runFixture({
    implementationResults: [
      { kind: 'completed', report: { status: 'completed' } },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });
  assert.equal((await malformed.runner.runIssue({ targetRoot: malformed.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await malformed.runner.runIssue({ targetRoot: malformed.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(malformed.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await malformed.store.read()).runs[0]!, ['cycle', 'reportRepairs']), { cycle: 1, reportRepairs: 0 });

  const transport = await runFixture({
    implementationResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });
  assert.equal((await transport.runner.runIssue({ targetRoot: transport.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await transport.runner.runIssue({ targetRoot: transport.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(transport.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await transport.store.read()).runs[0]!, ['cycle', 'transportRetries']), { cycle: 1, transportRetries: 1 });
});

test('incomplete cumulative changedFiles retries full implementation without consuming a cycle', async () => {
  const fixture = await runFixture({
    implementationResults: [
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'delta only', changedFiles: ['repair-only.txt'], residualRisks: [] } },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'cumulative', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await fixture.store.read()).runs[0]!, ['cycle', 'reportRepairs']), { cycle: 1, reportRepairs: 0 });
});

test('six malformed implementation reports retry full implementation for one product result', async () => {
  const malformed = { kind: 'completed' as const, report: { status: 'completed' } };
  const fixture = await runFixture({
    implementationResults: [
      malformed, malformed, malformed, malformed, malformed, malformed,
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'recovered', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.deepEqual(
      pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
      { status: 'transport-failed', resumable: true },
    );
  }
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 7);
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 1);
});

test('settled implementation, proof, and review infrastructure failures resume on the next bounded run', async () => {
  let proofCalls = 0;
  const cases: Array<{ name: string; options: FixtureOptions; expectedImplementationCalls: number }> = [
    {
      name: 'implementation',
      options: { implementationResults: [
        { kind: 'transport-failed', resumable: true },
        { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } },
      ] },
      expectedImplementationCalls: 2,
    },
    {
      name: 'proof',
      options: { proof: async () => (++proofCalls === 1
        ? { status: 'transport-failed', resumable: true, receipt: receipt() }
        : passedProof()) },
      expectedImplementationCalls: 1,
    },
    { name: 'review', options: { reviewTransportOnce: true }, expectedImplementationCalls: 1 },
  ];

  for (const entry of cases) {
    proofCalls = 0;
    const fixture = await runFixture(entry.options);
    const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, entry.name);
    assert.equal(fixture.events.includes('effect:pr'), false, entry.name);
    assert.equal(fixture.events.at(-1), 'owner-release', entry.name);
    const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(resumed.status, 'review-ready', entry.name);
    assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, entry.expectedImplementationCalls, entry.name);
    assert.equal(fixture.events.filter((event) => event === 'effect:pr').length, 1, entry.name);
    assert.equal(fixture.events.filter((event) => event === 'owner-release').length, 2, entry.name);
  }
});

test('resumable implementation transport retries once when the interrupted attempt changed the worktree', async () => {
  const fixture = await runFixture({
    transportWrites: true,
    implementationResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await fixture.store.read()).runs[0]!, ['cycle', 'transportRetries']), { cycle: 1, transportRetries: 1 },
    JSON.stringify({ state: await fixture.store.read(), events: fixture.events, evidence: fixture.evidence }));
});

test('invoked publication rejection is resumable, retains pendingEffect, and starts no later effect', async () => {
  const fixture = await runFixture({ rejectEffect: 'push' });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const state = await fixture.store.read();
  assert.equal(state.runs[0]?.lifecycle, 'publishing');
  assert.equal(state.runs[0]?.pendingEffect?.kind, 'initial-push');
  assert.equal(fixture.events.includes('effect:pr'), false);
});

test('every invoked effect rejection stays resumable with its exact durable pendingEffect', async () => {
  const remoteCases: Array<{ effect: NonNullable<FixtureOptions['rejectEffect']>; pendingEffect: string }> = [
    { effect: 'claim-labels', pendingEffect: 'claim-labels' },
    { effect: 'claim-comment', pendingEffect: 'claim-comment' },
    { effect: 'pr', pendingEffect: 'draft-pr' },
  ];
  for (const entry of remoteCases) {
    const fixture = await runFixture({ rejectEffect: entry.effect });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, entry.effect);
    assert.equal((await fixture.store.read()).runs[0]?.pendingEffect?.kind, entry.pendingEffect, entry.effect);
  }
  for (const effect of ['comment', 'labels'] as const) {
    const fixture = await runFixture({ rejectEffect: effect });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, 'review-ready', effect);
    const notifications = (await fixture.store.read()).runs[0]?.terminalNotifications;
    assert.equal(notifications?.[effect].status, 'pending', effect);
    assert.equal((await fixture.store.read()).runs[0]?.pendingEffect, undefined, effect);
  }
  const local = await runFixture({ rejectEffect: 'commit' });
  assert.deepEqual(
    pick(await local.runner.runIssue({ targetRoot: local.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  const unknownState = await local.store.read();
  assert.equal(unknownState.runs[0]?.pendingEffect?.kind, 'initial-commit');
  assert.equal(local.events.includes('git:push'), false);
  const unknownRun = unknownState.runs[0]!;
  const unknownIntent = unknownRun.pendingEffect;
  assert.ok(unknownIntent?.kind === 'initial-commit');
  if (unknownIntent?.kind !== 'initial-commit') return;
  await assert.rejects(local.store.compareAndSwap(unknownState.generation, {
    schema: unknownState.schema,
    runs: [{
      ...unknownRun,
      pendingEffect: {
        ...unknownIntent,
        candidateRef: `refs/codex-orchestrator/candidates/${unknownRun.runId}/${'f'.repeat(64)}`,
      },
    }],
  }), /effectId|candidate binding/u);
  const recoveredLocal = await local.runner.runIssue({ targetRoot: local.targetRoot, issueNumber: 42 });
  assert.equal(recoveredLocal.status, 'review-ready', JSON.stringify({ recoveredLocal, record: (await local.store.read()).runs[0] }));
  assert.equal(local.events.filter((event) => event === 'git:commit').length, 2);
});

test('unknown candidate branch CAS observes an exact completed effect before replay', async () => {
  const fixture = await runFixture({ rejectEffect: 'commit', commitUnknownAfterEffect: true });
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  assert.equal(fixture.events.filter((event) => event === 'git:commit').length, 1);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'git:commit').length, 1);
});

test('confirmed candidate commit retains identity until fallible cleanup is reconciled', async () => {
  for (const option of ['candidateNormalizeFailOnce', 'candidateReleaseFailOnce'] as const) {
    const fixture = await runFixture({ [option]: true });
    assert.deepEqual(
      pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
      { status: 'transport-failed', resumable: true },
      option,
    );
    const cleanupPending = (await fixture.store.read()).runs[0]!;
    assert.equal(cleanupPending.lifecycle, 'publishing', option);
    assert.equal(cleanupPending.pendingEffect?.kind, option === 'candidateNormalizeFailOnce' ? 'initial-commit' : 'candidate-pin-release', option);
    assert.equal(!!cleanupPending.candidateBinding, true, option);
    assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready', option);
    assert.equal(fixture.events.filter((event) => event === 'git:commit').length, 1, option);
  }
});

test('a rejected claim comment never grants the running status label', async () => {
  const fixture = await runFixture({ rejectEffect: 'claim-comment' });
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  const issue = await fixture.dependencies.issues.read(42);
  assert.deepEqual(issue?.labels, ['agent:auto']);
  assert.equal(fixture.events.includes('effect:claim-labels'), false);
});

test('implementation and proof transport, cancellation, internal failure, and malformed reports stay typed', async () => {
  const cases: Array<{ name: string; options: FixtureOptions; status: string; resumable?: boolean }> = [
    { name: 'implementation transport', options: { implementationResult: { kind: 'transport-failed', resumable: true } }, status: 'transport-failed', resumable: true },
    { name: 'implementation cancelled', options: { implementationResult: { kind: 'cancelled' } }, status: 'cancelled' },
    { name: 'implementation internal', options: { implementationResult: { kind: 'internal-error' } }, status: 'internal-error' },
    { name: 'implementation malformed', options: { implementationResult: { kind: 'completed', report: { status: 'completed' } } }, status: 'transport-failed', resumable: true },
    { name: 'proof transport', options: { proof: async () => ({ status: 'transport-failed', resumable: true, receipt: receipt() }) }, status: 'transport-failed', resumable: true },
    { name: 'proof cancelled', options: { proof: async () => ({ status: 'cancelled', receipt: receipt() }) }, status: 'cancelled' },
    { name: 'proof internal', options: { proof: async () => ({ status: 'internal-error', receipt: receipt() }) }, status: 'internal-error' },
    { name: 'proof rejects', options: { proofReject: true }, status: 'internal-error' },
    { name: 'check rejects', options: { checkReject: true }, status: 'transport-failed', resumable: true },
    { name: 'unchanged', options: { agentWrites: false }, status: 'internal-error' },
  ];
  for (const entry of cases) {
    const fixture = await runFixture(entry.options);
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, entry.status, entry.name);
    if (entry.resumable !== undefined) assert.equal((result as { resumable?: boolean }).resumable, entry.resumable, entry.name);
    assert.equal(fixture.events.includes('git:push'), false, entry.name);
  }
});

test('candidate proof inspection failures retain typed recovery and evidence states', async () => {
  let ioAttempts = 0;
  const ioFailure = await runFixture({
    proof: async () => {
      ioAttempts += 1;
      if (ioAttempts === 1) throw new CandidateProofInspectionError('candidate-materialization-io-failed');
      return passedProof();
    },
  });
  assert.deepEqual(
    pick(await ioFailure.runner.runIssue({ targetRoot: ioFailure.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  assert.equal(ioFailure.events.includes('git:commit'), false);
  const retryableRecord = (await ioFailure.store.read()).runs[0]!;
  assert.equal(retryableRecord.terminalOutcome, undefined);
  assert.ok(retryableRecord.candidateMaterialization);
  assert.equal(retryableRecord.activeAttempt?.stage, 'launched');
  assert.equal(
    (await ioFailure.runner.runIssue({ targetRoot: ioFailure.targetRoot, issueNumber: 42 })).status,
    'review-ready',
    JSON.stringify({ evidence: ioFailure.evidence, state: await ioFailure.store.read(), events: ioFailure.events }),
  );
  assert.equal(ioAttempts, 2);
  assert.equal(ioFailure.events.includes('candidate-process-absence'), true);

  const conflict = await runFixture({
    proof: async () => { throw new CandidateProofInspectionError('candidate-artifact-conflict'); },
  });
  assert.deepEqual(
    pick(await conflict.runner.runIssue({ targetRoot: conflict.targetRoot, issueNumber: 42 }), ['status', 'kind', 'resumable']),
    { status: 'blocked', kind: 'safety', resumable: false },
  );
  const record = (await conflict.store.read()).runs[0]!;
  assert.ok(record.candidateBinding);
  assert.equal(record.pendingEffect, undefined);
  assert.equal(conflict.events.includes('effect:blocked-comment'), true);
  assert.equal(conflict.events.includes('effect:terminal-labels'), true);
  assert.equal(conflict.events.includes('git:commit'), false);
});

test('post-proof candidate drift opens the next bounded cycle without a terminal wedge', async () => {
  const fixture = await runFixture({ proofMutatesWorktreeOnce: true });
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  const reopened = (await fixture.store.read()).runs[0]!;
  assert.equal(reopened.lifecycle, 'implementing');
  assert.equal(reopened.cycle, 2);
  assert.equal(reopened.terminalOutcome, undefined);
  assert.equal(reopened.candidateBinding, undefined);
  const retried = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(retried.status, 'review-ready', JSON.stringify({ retried, record: (await fixture.store.read()).runs[0], events: fixture.events }));
});

test('post-proof drift persists the next cycle before fallible pin cleanup', async () => {
  const fixture = await runFixture({ proofMutatesWorktreeOnce: true, candidateReleaseFailBeforeCommitOnce: true });
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  const transitioned = (await fixture.store.read()).runs[0]!;
  assert.equal(transitioned.lifecycle, 'implementing');
  assert.equal(transitioned.cycle, 2);
  assert.equal(transitioned.candidateBinding, undefined);
  const replay = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(replay.status, 'review-ready', JSON.stringify({ replay, state: await fixture.store.read(), events: fixture.events }));
});

test('issue read rejection and post-effect CAS failure are resumable with retained pendingEffect', async () => {
  const readFailure = await runFixture({ issueReadRejectAt: 3 });
  const readResult = await readFailure.runner.runIssue({ targetRoot: readFailure.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(readResult, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal(readFailure.events.includes('git:commit'), false);

  const casFailure = await runFixture({ rejectStoreTransition: { from: 'initial-push', to: 'none' } });
  const casResult = await casFailure.runner.runIssue({ targetRoot: casFailure.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(casResult, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, JSON.stringify({ casResult, evidence: casFailure.evidence, events: casFailure.events, state: await casFailure.store.read() }));
  const state = await casFailure.store.read();
  assert.equal(state.runs[0]?.pendingEffect?.kind, 'initial-push');
  assert.equal(casFailure.events.includes('git:push'), true);
});

test('restart after effect-before-confirmation reconciles publication without duplicate effects', async () => {
  const transitions = [
    { from: 'initial-commit', to: 'candidate-pin-release' },
    { from: 'candidate-pin-release', to: 'initial-push' },
    { from: 'initial-push', to: 'none' },
    { from: 'draft-pr', to: 'none' },
    { from: 'terminal-comment', to: 'none' },
    { from: 'terminal-labels', to: 'none' },
  ];
  for (const transition of transitions) {
    const fixture = await runFixture({ rejectStoreTransition: transition });
    const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    const terminalNotification = transition.from === 'terminal-comment' || transition.from === 'terminal-labels';
    assert.deepEqual(
      pick(first, terminalNotification ? ['status'] : ['status', 'resumable']),
      terminalNotification ? { status: 'review-ready' } : { status: 'transport-failed', resumable: true },
      JSON.stringify({ transition, first, evidence: fixture.evidence, events: fixture.events, state: await fixture.store.read() }),
    );
    const countsBefore = effectCounts(fixture.events);

    const second = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(second.status, 'review-ready', `${JSON.stringify(transition)}: ${JSON.stringify(second)}`);
    const countsAfter = effectCounts(fixture.events);
    for (const [effect, count] of Object.entries(countsBefore)) {
      if (count > 0) assert.equal(countsAfter[effect], count, `${effect} duplicated at ${JSON.stringify(transition)}`);
    }
    assert.equal((await fixture.store.read()).runs.length, 1);
  }
});

test('restart reconciles an interrupted claim without creating a second run', async () => {
  for (const effect of ['claim-labels', 'claim-comment'] as const) {
    const fixture = await runFixture({ rejectEffect: effect });
    assert.deepEqual(
      pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
      { status: 'transport-failed', resumable: true },
    );
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, 'review-ready', `${effect}: ${JSON.stringify(result)}`);
    assert.equal((await fixture.store.read()).runs.length, 1);
    assert.equal(fixture.events.filter((event) => event === 'agent').length, 1);
  }
});

test('restart resumes interrupted implementation in the same worktree as the next bounded cycle', async () => {
  const options: FixtureOptions = { implementationResult: { kind: 'transport-failed', resumable: false } };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const terminal = await fixture.store.read();
  const interrupted = structuredClone(terminal.runs[0]!);
  interrupted.lifecycle = 'implementing';
  delete interrupted.activeAttempt;
  delete interrupted.terminalOutcome;
  delete interrupted.outcomeEvidenceId;
  await fixture.store.compareAndSwap(terminal.generation, {
    schema: 'codex-orchestrator.run-state',
    runs: [interrupted],
  });
  options.implementationResult = undefined;
  fixture.dependencies.packageVersion = '0.1.52';
  fixture.dependencies.createWorkflowGeneration = async () => { throw new Error('replacement package workflow is corrupt'); };

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready');
  const state = await fixture.store.read();
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0]?.cycle, 2);
  assert.equal(state.runs[0]?.packageVersion, '0.1.51');
  assert.equal(state.runs[0]?.workflowGeneration.generationHash, '1'.repeat(64));
  assert.equal(state.runs[0]?.skillHashes['agent-auto'], 'a'.repeat(64));
  assert.equal(state.runs[0]?.worktreePath, fixture.worktreePath);
});

test('safe-halt returns after one tick, preserves attempt identity, and retries without semantic spend', async () => {
  const fixture = await runFixture({
    implementationResult: { kind: 'safe-halt' },
  });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const frozen = (await fixture.store.read()).runs[0]!;
  assert.equal(frozen.lifecycle, 'safe-halt');
  assert.equal(frozen.activeAttempt?.stage, 'launched');
  const attemptId = frozen.activeAttempt?.attemptId;
  assert.equal(frozen.cycle, 1);
  assert.equal(fixture.events.at(-1), 'owner-release');
  assert.equal(fixture.events.includes('git:push'), false);

  let observations = 0;
  fixture.dependencies.processIdentity.observe = async () => {
    observations += 1;
    return observations === 1
      ? { leader: 'same' as const, group: 'live' as const }
      : { leader: 'absent' as const, group: 'absent' as const };
  };
  const second = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(second, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const stillFrozen = (await fixture.store.read()).runs[0]!;
  assert.equal(stillFrozen.activeAttempt?.attemptId, attemptId);
  assert.equal(stillFrozen.cycle, 1);
  assert.equal(observations, 1);

  await rm(stillFrozen.activeAttempt!.resultPath, { force: true });
  fixture.options.implementationResult = undefined;
  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(resumed.status, 'review-ready', JSON.stringify({ resumed, state: await fixture.store.read(), events: fixture.events }));
  assert.equal(observations, 2);
  assert.equal((await fixture.store.read()).runs[0]!.cycle, 1);
});

test('one bounded safe-halt observation covers every live operation family without replacement or budget spend', async () => {
  const safeImplementation = (): ImplementationAgentResult => ({ kind: 'safe-halt' });
  const cases: Array<{ name: string; options: FixtureOptions }> = [
    { name: 'implementation', options: { implementationResults: [safeImplementation()] } },
    { name: 'report-repair', options: { implementationResults: [
      { kind: 'completed', report: { version: 0, status: 'bad' } }, safeImplementation(),
    ] } },
    { name: 'code-review', options: { reviewSafeHaltOnce: true } },
    { name: 'configured-check', options: { checkSafeHaltOnce: true } },
    { name: 'acceptance-proof', options: { proofSafeHaltOnce: true } },
  ];
  for (const entry of cases) {
    const fixture = await runFixture(entry.options);
    if (entry.name === 'report-repair') {
      const malformed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
      assert.deepEqual(pick(malformed, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
      assert.equal((await fixture.store.read()).runs[0]?.lifecycle, 'implementing');
      assert.equal((await fixture.store.read()).runs[0]?.activeAttempt, undefined);
    }
    const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, entry.name);
    const frozen = (await fixture.store.read()).runs[0]!;
    assert.equal(frozen.lifecycle, 'safe-halt', entry.name);
    assert.equal(frozen.activeAttempt?.stage, 'launched', entry.name);
    const exactState = canonicalJson(await fixture.store.read());
    const attemptId = frozen.activeAttempt.attemptId;
    let observations = 0;
    fixture.dependencies.processIdentity.observe = async () => {
      observations += 1;
      return observations === 1
        ? { leader: 'same' as const, group: 'live' as const }
        : { leader: 'absent' as const, group: 'absent' as const };
    };

    const live = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(live, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, entry.name);
    assert.equal(canonicalJson(await fixture.store.read()), exactState, `${entry.name}: live observation mutated Run state`);
    assert.equal((await fixture.store.read()).runs[0]!.activeAttempt?.attemptId, attemptId, entry.name);
    assert.equal(observations, 1, entry.name);

    await rm((await fixture.store.read()).runs[0]!.activeAttempt!.resultPath, { force: true });
    const completed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(completed.status, 'review-ready', `${entry.name}: ${JSON.stringify(completed)}`);
    assert.equal(observations, 2, entry.name);
  }
});

test('safe-halt observation failure is bounded and exact result adoption prevents replacement', async () => {
  const fixture = await runFixture({ implementationResults: [{ kind: 'safe-halt' }] });
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  const frozenState = canonicalJson(await fixture.store.read());
  fixture.dependencies.processIdentity.observe = async () => { throw new Error('EPERM'); };
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  assert.equal(canonicalJson(await fixture.store.read()), frozenState);

  const frozen = (await fixture.store.read()).runs[0]!;
  const attempt = frozen.activeAttempt!;
  const report = { version: 1, status: 'completed', summary: 'recovered', changedFiles: ['feature.txt'], residualRisks: [] };
  const bytes = Buffer.from(canonicalJson(report));
  await writeFile(join(fixture.worktreePath, 'feature.txt'), 'implemented by unresolved process\n');
  await fixture.dependencies.writeAttemptResult({ path: attempt.resultPath, bytes, sha256: sha256(bytes) });
  let processObservations = 0;
  fixture.dependencies.processIdentity.observe = async () => {
    processObservations += 1;
    return { leader: 'reused', group: 'absent' };
  };
  let cleanupObservations = 0;
  fixture.dependencies.observeAttemptCleanup = async () => {
    cleanupObservations += 1;
    return cleanupObservations === 1 ? 'pending' : 'confirmed';
  };
  let recoveryCalls = 0;
  fixture.dependencies.implementationAgent.run = async ({ attemptId }) => {
    recoveryCalls += 1;
    assert.equal(attemptId, attempt.attemptId);
    return { kind: 'completed', attemptId, report };
  };

  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  const cleanupFrozen = (await fixture.store.read()).runs[0]!.activeAttempt!;
  assert.equal(cleanupFrozen.stage, 'observed');
  assert.equal(cleanupFrozen.cleanup, 'pending');
  assert.equal(cleanupFrozen.attemptId, attempt.attemptId);
  assert.equal(recoveryCalls, 0);

  const adopted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(adopted.status, 'review-ready', JSON.stringify({ adopted, state: await fixture.store.read(), events: fixture.events }));
  assert.equal(recoveryCalls, 1);
  assert.equal(processObservations, 1);
  assert.equal(cleanupObservations, 2);
  assert.equal((await fixture.store.read()).runs[0]!.cycle, 1);
});

test('cancellation waits for deferred check and proof settlement before terminal state and owner release', async () => {
  for (const phase of ['check', 'proof'] as const) {
    const controller = new AbortController();
    const gate = deferred<unknown>();
    const fixture = await runFixture({
      signal: controller.signal,
      ...(phase === 'check'
        ? { check: () => gate.promise as Promise<{ status: 'passed'; output: Buffer }> }
        : { proof: () => gate.promise as Promise<ProveChangeResult> }),
    });
    let settled = false;
    const running = fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }).finally(() => { settled = true; });
    await waitFor(() => fixture.events.includes(phase === 'check' ? 'check:typecheck' : 'proof'));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, phase);
    assert.equal(fixture.events.includes('owner-release'), false, phase);
    if (phase === 'check') gate.resolve({ status: 'passed', output: Buffer.from('ok') });
    else gate.resolve(passedProof());
    assert.equal((await running).status, 'cancelled', phase);
    assert.equal(fixture.events.at(-1), 'owner-release', phase);
  }
});

test('cancellation also waits for an in-flight store write and remote effect before releasing ownership', async () => {
  for (const phase of ['store', 'effect'] as const) {
    const controller = new AbortController();
    const gate = deferred<void>();
    const fixture = await runFixture({
      signal: controller.signal,
      ...(phase === 'store'
        ? { storeGate: { event: 'state:checking:none', promise: gate.promise } }
        : { pushGate: gate.promise }),
    });
    let settled = false;
    const running = fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }).finally(() => { settled = true; });
    await waitFor(() => fixture.events.includes(phase === 'store' ? 'store:deferred' : 'effect:push-deferred'));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, phase);
    assert.equal(fixture.events.includes('owner-release'), false, phase);
    gate.resolve();
    assert.equal((await running).status, 'cancelled', phase);
    assert.equal(fixture.events.at(-1), 'owner-release', phase);
  }
});

interface FixtureOptions {
  rawRunStateBytes?: Buffer;
  stateInspections?: RunStateInspection[];
  ownerContention?: boolean;
  initialLabels?: string[];
  blockedTransitionLabels?: string[];
  revokeAtAuthorization?: number;
  agentCommit?: boolean;
  check?: () => Promise<{ status: 'passed' | 'failed'; output: Buffer; outputSha256?: string }>;
  proof?: (checkedChange: CheckedChange<any>) => Promise<ProveChangeResult>;
  implementationResult?: ImplementationAgentResult;
  implementationResults?: ImplementationAgentResult[];
  skipImplementationLaunchPersistence?: boolean;
  transportWrites?: boolean;
  agentWrites?: boolean;
  agentWritesDeniedIgnoredPath?: boolean;
  checkReject?: boolean;
  proofReject?: boolean;
  proofError?: Error;
  proofMutatesWorktreeOnce?: boolean;
  issueReadRejectAt?: number;
  rejectStoreEvent?: string;
  rejectStoreOccurrence?: number;
  rejectStoreTransition?: { from: string; to: string };
  signal?: AbortSignal;
  storeGate?: { event: string; promise: Promise<void> };
  pushGate?: Promise<void>;
  invalidConfig?: boolean;
  storeReadReject?: boolean;
  storeReadError?: Error;
  rejectEffect?: 'claim-labels' | 'claim-comment' | 'commit' | 'push' | 'pr' | 'comment' | 'labels';
  permanentlyRejectEffect?: 'comment' | 'labels';
  commitUnknownAfterEffect?: boolean;
  candidateNormalizeFailOnce?: boolean;
  candidateReleaseFailOnce?: boolean;
  candidateReleaseFailBeforeCommitOnce?: boolean;
  initialComments?: Array<{
    id?: string;
    body: string;
    authorAssociation: string;
    createdAt?: string;
    updatedAt?: string;
    author?: string;
    authorId?: string;
  }>;
  commentBeforeTerminal?: {
    id?: string;
    body: string;
    authorAssociation: string;
    createdAt?: string;
    updatedAt?: string;
    author?: string;
    authorId?: string;
  };
  rejectTerminalCutoffRead?: boolean;
  workflowVerificationReject?: boolean;
  reviewMalformedOnce?: boolean;
  reviewMalformedCount?: number;
  reviewIncoherentNeedsWorkOnce?: boolean;
  reviewNeedsWorkOnce?: boolean;
  reviewOutOfConeOnTargetedOnce?: boolean;
  reviewOutOfConeApproved?: boolean;
  reviewOutOfConeAffectedTargets?: string[];
  reviewRejectedOnce?: boolean;
  reviewRejectedAlways?: boolean;
  reviewAffectedTargets?: string[];
  configuredChecks?: Record<string, string>;
  createWorktreeRejectOnce?: string;
  createIncompleteWorktreeThenRejectOnce?: boolean;
  ensureContinuationWorktreeThenRejectOnce?: boolean;
  inspectWorktreeDivergedOnce?: boolean;
  diffTreesUnisolatable?: boolean;
  diffTreeOverride?: { changedFiles: string[]; patch: string };
  denyReadPaths?: string[];
  getBaseShaRejectOnce?: boolean;
  issueBody?: string;
  permissionSequence?: Array<'write' | 'admin' | 'read' | 'throw'>;
  implementationPreparedGate?: Promise<void>;
  implementationBeforePreparedGate?: Promise<void>;
  reviewSafeHaltOnce?: boolean;
  reviewTransportOnce?: boolean;
  reviewPreLaunchTransportOnce?: boolean;
  checkSafeHaltOnce?: boolean;
  proofSafeHaltOnce?: boolean;
  checkPreLaunchRejectOnce?: boolean;
  proofPreLaunchRejectOnce?: boolean;
}

async function runFixture(options: FixtureOptions = {}) {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-v2-run-issue-'));
  const remoteRoot = await mkdtemp(join(tmpdir(), 'codex-v2-run-remote-'));
  const workspaceRoot = join(targetRoot, '.worktrees');
  const worktreePath = join(workspaceRoot, 'issue-42');
  await execFileAsync('git', ['init', '--bare', remoteRoot]);
  await execFileAsync('git', ['init', '-b', 'main', targetRoot]);
  await writeFile(join(targetRoot, 'README.md'), 'base\n');
  if (options.agentWritesDeniedIgnoredPath) await writeFile(join(targetRoot, '.gitignore'), '.env\n');
  await execFileAsync('git', ['-C', targetRoot, 'add', 'README.md', ...(options.agentWritesDeniedIgnoredPath ? ['.gitignore'] : [])]);
  await execFileAsync('git', ['-C', targetRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'base']);
  await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', remoteRoot]);
  await execFileAsync('git', ['-C', targetRoot, 'push', '-u', 'origin', 'main']);
  const baseSha = (await execFileAsync('git', ['-C', targetRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const events: string[] = [];
  const evidence: Array<{ runId: string; code: string; summary: string }> = [];
  const config = configFixture();
  if (options.configuredChecks) config.checks = structuredClone(options.configuredChecks);
  if (options.denyReadPaths) config.deny.readPaths = [...options.denyReadPaths];
  if (options.agentWritesDeniedIgnoredPath) config.deny.readPaths = ['.env'];
  const configBytes = Buffer.from(`${canonicalJson(config)}\n`);
  const capabilities = createCheckedChangeCapabilities();
  const statePath = join(targetRoot, '.codex-orchestrator', 'run-state.json');
  if (options.rawRunStateBytes) {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, options.rawRunStateBytes);
  }
  const rawStore: RunRecordWriter = options.rawRunStateBytes
    ? new FileRunRecordWriter(statePath)
    : new InMemoryRunRecordWriter();
  const tracedStore = traceStore(
    rawStore,
    events,
    options.rejectStoreEvent,
    options.rejectStoreOccurrence,
    options.storeGate,
    options.rejectStoreTransition,
  );
  const inspectedStore: RunRecordWriter = options.stateInspections
    ? {
      inspect: async () => structuredClone(options.stateInspections!.shift() ?? await tracedStore.inspect()),
      read: tracedStore.read,
      compareAndSwap: tracedStore.compareAndSwap,
    }
    : tracedStore;
  const store: RunRecordWriter = options.storeReadReject || options.storeReadError
    ? {
      inspect: async () => { throw options.storeReadError ?? new Error('state read failed'); },
      read: async () => { throw options.storeReadError ?? new Error('state read failed'); },
      compareAndSwap: tracedStore.compareAndSwap,
    }
    : inspectedStore;
  const localGit = new LocalGitRunIssueAdapter();
  const candidateAuthorityHashes: string[] = [];
  const implementationAttemptIds: string[] = [];
  const git = traceGit(localGit, events, options, candidateAuthorityHashes);
  let labels = [...(options.initialLabels ?? ['agent:auto'])];
  let blockedTransitionMutated = false;
  let nextCommentId = 1;
  let comments: Array<{
    id?: string;
    body: string;
    authorAssociation: string;
    createdAt?: string;
    updatedAt?: string;
    author?: string;
    authorId?: string;
  }> = structuredClone(options.initialComments ?? []);
  let pullRequest: { url: string; body: string } | undefined;
  let removedBeforeContinuation = false;
  let rejectTerminalCutoffRead = false;
  let reads = 0;
  let authReads = 0;
  let reviewCalls = 0;
  let reviewSessionCount = 0;
  const reviewInputs: any[] = [];
  const reviewReportRepairInputs: Array<{ repairOnly: boolean; hash: string | null; bytes: Buffer | null }> = [];
  const implementationAuthorities: DeliveryAuthority[] = [];
  const reviewAuthorities: DeliveryAuthority[] = [];
  const checkedChangePayloads: CheckedChangePayload[] = [];
  const rejectedEffects = new Set<string>();
  const shouldReject = (effect: string) => {
    if (options.rejectEffect !== effect || rejectedEffects.has(effect)) return false;
    rejectedEffects.add(effect);
    return true;
  };
  const issue = {
    number: 42,
    title: 'Implement behavior',
    body: options.issueBody ?? '## Acceptance Criteria\n- The behavior works.',
    url: 'https://example.invalid/issues/42',
  };
  let issueState: 'OPEN' | 'CLOSED' = 'OPEN';
  const dependencies: RunIssueDependencies = {
    readConfig: async () => ({
      bytes: configBytes,
      config: options.invalidConfig ? { ...config, unknown: true } as AgentAutoConfig : config,
    }),
    ownerLock: {
      acquire: async () => {
        events.push('owner-acquire');
        if (options.ownerContention) throw new OwnerLockContentionError('live');
        return { release: async () => { events.push('owner-release'); } };
      },
    },
    issues: {
      read: async () => {
        reads += 1;
        if (rejectTerminalCutoffRead) {
          rejectTerminalCutoffRead = false;
          throw new Error('terminal cutoff read rejected');
        }
        if (options.issueReadRejectAt === reads) throw new Error('issue read rejected');
        if (reads === 1) events.push('issue-read:initial');
        else {
          events.push('issue-read:authorize');
          authReads += 1;
          if (options.revokeAtAuthorization === authReads) labels = labels.filter((label) => label !== 'agent:auto');
        }
        return { ...issue, state: issueState, labels: [...labels].sort(), comments: structuredClone(comments) };
      },
      setLabels: async (_issueNumber, next) => {
        const claim = next.includes('agent:running');
        events.push(claim ? 'effect:claim-labels' : 'effect:terminal-labels');
        if (claim && shouldReject('claim-labels')) throw new Error('claim labels rejected');
        if (!claim && shouldReject('labels')) throw new Error('labels rejected');
        labels = [...new Set([...labels.filter((label) => !label.startsWith('agent:')), ...next])];
        if (claim && pullRequest && options.ensureContinuationWorktreeThenRejectOnce && !removedBeforeContinuation) {
          removedBeforeContinuation = true;
          await execFileAsync('git', ['-C', targetRoot, 'worktree', 'remove', worktreePath]);
        }
      },
      reconcileTerminalLabels: async (_issueNumber, policy) => {
        events.push('effect:terminal-labels');
        if (options.permanentlyRejectEffect === 'labels' || shouldReject('labels')) throw new Error('labels rejected');
        if (!blockedTransitionMutated && options.blockedTransitionLabels) {
          blockedTransitionMutated = true;
          labels = [...options.blockedTransitionLabels];
        }
        const hasManagedStatus = labels.some((label) => label.startsWith('agent:'));
        labels = labels.filter((label) => !policy.remove.includes(label));
        if (hasManagedStatus) {
          for (const label of policy.add) if (!labels.includes(label)) labels.push(label);
        }
      },
      postComment: async (_issueNumber, body) => {
        const claim = body.split('\n')[0]?.endsWith(':claim -->') ?? false;
        const blocked = body.split('\n')[0]?.endsWith(':blocked -->') ?? false;
        const internalError = body.split('\n')[0]?.endsWith(':internal-error -->') ?? false;
        const cancelled = body.split('\n')[0]?.endsWith(':cancelled -->') ?? false;
        events.push(claim ? 'effect:claim-comment'
          : blocked ? 'effect:blocked-comment'
            : internalError ? 'effect:internal-error-comment'
              : cancelled ? 'effect:cancelled-comment' : 'effect:handoff-comment');
        if (claim && shouldReject('claim-comment')) throw new Error('claim comment rejected');
        if (!claim && (options.permanentlyRejectEffect === 'comment' || shouldReject('comment'))) throw new Error('comment rejected');
        comments.push({ id: `comment-${nextCommentId++}`, body, authorAssociation: 'OWNER' });
      },
      getRepositoryPermission: async (_login, expectedUserId) => {
        const permission = options.permissionSequence?.shift() ?? 'write';
        if (permission === 'throw') throw new Error('permission unavailable');
        return { permission, checkedAt: '2026-07-30T00:00:01.000Z', userId: expectedUserId };
      },
    },
    pullRequests: {
      findOpen: async () => pullRequest,
      createDraft: async ({ body }) => {
        events.push('effect:pr');
        if (shouldReject('pr')) throw new Error('pr rejected');
        pullRequest = { url: 'https://example.invalid/pull/1', body };
        if (options.commentBeforeTerminal) comments.push(structuredClone(options.commentBeforeTerminal));
        rejectTerminalCutoffRead = options.rejectTerminalCutoffRead ?? false;
        return { url: pullRequest.url };
      },
    },
    git,
    implementationAgent: {
      run: async ({ attemptId, worktreePath: path, deliveryAuthority, cycle, reworkFindings, onPrepared, onLaunched }) => {
        implementationAttemptIds.push(attemptId);
        implementationAuthorities.push(structuredClone(deliveryAuthority));
        events.push('agent');
        events.push('agent:implementation');
        if (options.implementationBeforePreparedGate) {
          events.push('agent:before-prepared-gated');
          await options.implementationBeforePreparedGate;
        }
        await onPrepared?.({
          attemptId,
          reportPath: `/tmp/${attemptId}-report.json`,
          preparedAt: '2026-07-16T12:00:00.000Z',
          baseline: await dependencies.git.snapshot(path),
        });
        if (options.implementationPreparedGate) {
          events.push('agent:prepared-gated');
          await options.implementationPreparedGate;
        }
        if (!options.skipImplementationLaunchPersistence) {
          events.push('agent:on-launched');
          await onLaunched?.({
            attemptId, pid: 6060, processGroupId: 6060, launchedAt: '2026-07-16T12:00:01.000Z',
          });
        }
        const sequenced = options.implementationResults?.shift();
        const selected = sequenced ?? options.implementationResult;
        if (options.transportWrites && selected?.kind === 'transport-failed') {
          await writeFile(join(path, 'feature.txt'), 'partial implementation\n');
        }
        if (selected?.kind !== 'completed' && selected) return selected;
        if (options.agentWrites !== false) {
          await writeFile(join(path, 'feature.txt'), cycle > 1 ? `implemented repair ${reworkFindings.join('|')}\n` : 'implemented\n');
        }
        if (options.agentWritesDeniedIgnoredPath) await writeFile(join(path, '.env'), 'ignored denied fixture\n');
        if (options.agentCommit) {
          await execFileAsync('git', ['-C', path, 'add', '--all']);
          await execFileAsync('git', ['-C', path, '-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-m', 'agent commit']);
        }
        const changedFiles = ['feature.txt'];
        const completed = selected ?? { kind: 'completed' as const, report: { version: 1, status: 'completed', summary: 'done', changedFiles, residualRisks: [] } };
        return completed.kind === 'completed' ? { ...completed, attemptId: completed.attemptId ?? attemptId } : completed;
      },
    },
    implementationReviewer: {
      run: async (input) => {
        reviewInputs.push(structuredClone({ ...input, signal: undefined, onPrepared: undefined, onLaunched: undefined, originalReportBytes: undefined }));
        reviewReportRepairInputs.push({
          repairOnly: input.repairOnly,
          hash: input.originalReportSha256,
          bytes: input.originalReportBytes ? Buffer.from(input.originalReportBytes) : null,
        });
        reviewAuthorities.push(structuredClone(input.deliveryAuthority));
        reviewCalls += 1;
        events.push('review:code-review');
        const invocation = {
          attemptId: input.attemptId, operation: input.operation,
          reviewerSessionId: input.reviewerSessionId, targetRevision: input.targetRevision,
          targetFingerprint: input.targetFingerprint,
        };
        await input.onPrepared(invocation);
        if (options.reviewPreLaunchTransportOnce) {
          options.reviewPreLaunchTransportOnce = false;
          events.push('review:pre-launch-failed');
          return { kind: 'transport-failed' as const, resumable: true };
        }
        await input.onLaunched({ ...invocation, pid: 4242, processGroupId: 4242 });
        events.push('review:code-review-launched');
        if (options.reviewTransportOnce) {
          options.reviewTransportOnce = false;
          return { kind: 'transport-failed' as const, resumable: true };
        }
        if (options.reviewSafeHaltOnce) {
          options.reviewSafeHaltOnce = false;
          return {
            kind: 'safe-halt' as const,
            process: {
              pid: 4242, processGroupId: 4242, startedAt: '2026-07-16T12:00:00.000Z',
              baseline: {
                headSha: baseSha, indexTreeSha: baseSha, trackedContentSha256: '3'.repeat(64),
                untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'fixture-review',
              },
            },
          };
        }
        if ((options.reviewMalformedOnce && reviewCalls === 1)
          || (options.reviewMalformedCount ?? 0) > 0) {
          if ((options.reviewMalformedCount ?? 0) > 0) options.reviewMalformedCount!--;
          const originalReportBytes = Buffer.from('{"report":{"version":1}}');
          await writeFile(`/tmp/${input.attemptId}-report.json`, originalReportBytes);
          return {
            kind: 'report-invalid', diagnostic: 'missing operation', originalReportBytes,
            originalReportSha256: sha256(originalReportBytes),
          };
        }
        if (options.reviewIncoherentNeedsWorkOnce) {
          options.reviewIncoherentNeedsWorkOnce = false;
          const originalReportBytes = Buffer.from(JSON.stringify({ verdict: 'needs-work', defects: [] }));
          await writeFile(`/tmp/${input.attemptId}-report.json`, originalReportBytes);
          return {
            kind: 'report-invalid', diagnostic: 'needs-work review requires an open or reopened defect or repair finding',
            originalReportBytes, originalReportSha256: sha256(originalReportBytes),
          };
        }
        if (options.reviewNeedsWorkOnce) {
          options.reviewNeedsWorkOnce = false;
          return {
            kind: 'completed' as const, attemptId: invocation.attemptId, artifactSha256: '7'.repeat(64),
            report: {
              version: 1 as const, operation: input.operation, targetRevision: input.targetRevision,
              targetFingerprint: input.targetFingerprint, verdict: 'needs-work' as const,
              coverage: ['acceptance-criteria', 'correctness'],
              defects: [{
                id: 'finding-1', class: 'blocker' as const, severity: 'high' as const, confidence: 'high' as const,
                status: 'open' as const, invariant: 'behavior works', failure: 'edge case fails', evidence: ['focused test'],
                repair: 'fix edge case', affectedTargets: options.reviewAffectedTargets ?? ['src/a.ts'], introducedTargetRevision: input.targetRevision,
                statusTargetRevision: input.targetRevision, supersededBy: null,
              }],
              residualRisks: [], reviewerSessionId: input.reviewerSessionId,
              reviewers: reviewParticipants(input.reviewerSessionId, 'approve', input.repairPatch !== null), repairFindingOutcomes: [],
            },
          };
        }
        if (options.reviewOutOfConeOnTargetedOnce && input.repairPatch !== null) {
          options.reviewOutOfConeOnTargetedOnce = false;
          return {
            kind: 'completed' as const, attemptId: invocation.attemptId, artifactSha256: '6'.repeat(64),
            report: {
              version: 1 as const, operation: input.operation, targetRevision: input.targetRevision,
              targetFingerprint: input.targetFingerprint, verdict: options.reviewOutOfConeApproved ? 'approved' as const : 'needs-work' as const,
              coverage: ['correctness'],
              defects: [
                ...input.defects.map((defect) => ({ ...defect, status: 'verified' as const, statusTargetRevision: input.targetRevision })),
                {
                  id: 'out-of-cone', class: options.reviewOutOfConeApproved ? 'improvement' as const : 'blocker' as const,
                  severity: 'high' as const, confidence: 'high' as const,
                  status: 'open' as const, invariant: 'unrelated scope stays closed', failure: 'unrelated behavior changed',
                  evidence: ['unrelated file'], repair: 'reopen complete review',
                  affectedTargets: options.reviewOutOfConeAffectedTargets ?? ['path:unrelated.ts'],
                  introducedTargetRevision: input.targetRevision, statusTargetRevision: input.targetRevision, supersededBy: null,
                },
              ],
              residualRisks: [], reviewerSessionId: input.reviewerSessionId,
              reviewers: reviewParticipants(input.reviewerSessionId, 'approve', input.repairPatch !== null),
              repairFindingOutcomes: [
                ...input.defects.map((defect) => ({ id: defect.id, status: 'verified' as const })),
                ...input.repairFindings.map((finding) => ({ id: finding.id, status: 'verified' as const })),
              ],
            },
          };
        }
        if (options.reviewRejectedOnce || options.reviewRejectedAlways) {
          options.reviewRejectedOnce = false;
          return {
            kind: 'completed' as const, attemptId: invocation.attemptId, artifactSha256: '9'.repeat(64),
            report: {
              version: 1 as const, operation: input.operation, targetRevision: input.targetRevision,
              targetFingerprint: input.targetFingerprint, verdict: 'rejected' as const, coverage: [],
              defects: [{
                id: 'review-rejection-1', class: 'blocker' as const, severity: 'high' as const, confidence: 'high' as const,
                status: 'open' as const, invariant: 'issue authority remains bounded', failure: 'unauthorized ownership expansion',
                evidence: ['reviewed immutable candidate'], repair: 'return to Plan for an explicit authority decision',
                affectedTargets: ['contract:authority'], introducedTargetRevision: input.targetRevision,
                statusTargetRevision: input.targetRevision, supersededBy: null,
              }],
              residualRisks: ['Publishing would exceed issue authority.'], reviewerSessionId: input.reviewerSessionId,
              reviewers: reviewParticipants(input.reviewerSessionId, 'block', input.repairPatch !== null),
              repairFindingOutcomes: [],
            },
          };
        }
        return {
          kind: 'completed', attemptId: invocation.attemptId, artifactSha256: '8'.repeat(64),
          report: {
            version: 1, operation: input.operation, targetRevision: input.targetRevision,
            targetFingerprint: input.targetFingerprint, verdict: 'approved',
            coverage: [...input.reviewFocus],
            defects: input.defects.map((defect) => ({ ...defect, status: 'verified' as const, statusTargetRevision: input.targetRevision })),
            residualRisks: [], reviewerSessionId: input.reviewerSessionId,
            reviewers: reviewParticipants(input.reviewerSessionId, 'approve', input.repairPatch !== null),
            repairFindingOutcomes: [
              ...input.defects.map((defect) => ({ id: defect.id, status: 'verified' as const })),
              ...input.repairFindings.map((finding) => ({ id: finding.id, status: 'verified' as const })),
            ],
          },
        };
      },
    },
    checks: {
      supportsLaunchOwnership: true,
      run: async ({ id, onLaunched }) => {
        if (options.checkPreLaunchRejectOnce) {
          options.checkPreLaunchRejectOnce = false;
          events.push('check:pre-launch-failed');
          throw new Error('check tooling unavailable before launch');
        }
        await onLaunched?.({ pid: 987654, processGroupId: 987654 });
        events.push(id === 'typecheck' ? 'check:typecheck' : `check:changed:${id}`);
        if (options.checkSafeHaltOnce) {
          options.checkSafeHaltOnce = false;
          throw new CheckProcessQuiescenceError(987654);
        }
        if (options.checkReject) throw new Error('check rejected');
        const fallback: { status: 'passed'; output: Buffer; outputSha256?: string } = {
          status: 'passed', output: Buffer.from('ok'),
        };
        const result = await (options.check?.() ?? fallback);
        return {
          ...result,
          outputSha256: result.outputSha256 ?? sha256(result.output),
          observation: { leader: 'absent' as const, group: 'absent' as const },
        };
      },
    },
    proof: {
      proveChange: async ({ checkedChange, recoverOnly, beforeAgentLaunch, onLaunched }) => {
        await beforeAgentLaunch?.();
        if (options.proofPreLaunchRejectOnce) {
          options.proofPreLaunchRejectOnce = false;
          events.push('proof:pre-launch-failed');
          throw new Error('proof tooling unavailable before launch');
        }
        await onLaunched?.({ pid: 24680, processGroupId: 24680, launchedAt: '2026-07-16T12:00:00.000Z' });
        events.push('proof');
        if (options.proofSafeHaltOnce) {
          options.proofSafeHaltOnce = false;
          return { status: 'safe-halt' as const };
        }
        if (recoverOnly) events.push('proof-recover-only');
        checkedChangePayloads.push(capabilities.verifyAndRead(checkedChange).payload);
        if (options.proofError) throw options.proofError;
        if (options.proofReject) throw new Error('proof rejected');
        const result = await (options.proof?.(checkedChange) ?? passedProof());
        if (options.proofMutatesWorktreeOnce) {
          options.proofMutatesWorktreeOnce = false;
          await writeFile(join(worktreePath, 'feature.txt'), 'post-proof drift\n');
        }
        return result;
      },
    },
    checkedChangeMint: capabilities,
    runRecords: store,
    writeEvidence: async (entry) => {
      evidence.push(structuredClone(entry));
      return { id: `evidence:${entry.runId}:${entry.code}`, path: `.codex-orchestrator/evidence/${entry.runId}.json` };
    },
    outcomeEvidencePath: (runId, code, summarySha256) => `.codex-orchestrator/evidence/${runId}/${sha256(code)}-${summarySha256}.json`,
    inspectOutcomeEvidence: async (path) => {
      try { return { sha256: sha256(await readFile(resolve(targetRoot, path))) }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    writeOutcomeEvidence: async ({ path, bytes, sha256: expectedSha256 }) => {
      const destination = resolve(targetRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      try {
        const existing = await readFile(destination);
        if (sha256(existing) !== expectedSha256) throw new Error('evidence diverged');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      assert.equal(sha256(bytes), expectedSha256);
      await writeFile(destination, bytes);
    },
    packageVersion: '0.1.51',
    createWorkflowGeneration: async () => ({
      receipt: workflowGeneration('0.1.51', '1'),
      skillHashes: { 'agent-auto': 'a'.repeat(64), 'acceptance-proof': 'b'.repeat(64) },
    }),
    verifyWorkflowGeneration: async () => {
      if (options.workflowVerificationReject) throw new Error('generation drift');
    },
    createRunId: () => '00000000-0000-4000-8000-000000000001',
    createProofId: () => 'proof-1',
    createReviewSessionId: () => `code-review-session-${++reviewSessionCount}`,
    processIdentity: {
      host: 'fixture-host', bootId: 'fixture-boot',
      capture: async () => ({ kind: 'unavailable', platform: 'darwin' }),
      observe: async () => {
        events.push('candidate-process-absence');
        return { leader: 'absent', group: 'absent' };
      },
    },
    inspectAttemptResult: async (path) => {
      try {
        const bytes = await readFile(path);
        return { bytes, sha256: sha256(bytes) };
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    observeAttemptCleanup: async () => {
      events.push('attempt-cleanup-observe');
      return 'confirmed' as const;
    },
    writeAttemptResult: async ({ path, bytes, sha256: expectedSha256 }) => {
      assert.equal(sha256(bytes), expectedSha256);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    attemptResultPath: ({ attemptId }) => `/tmp/${attemptId}-report.json`,
    now: () => '2026-07-16T12:00:00.000Z',
    signal: options.signal,
  };
  return {
    runner: new RunIssue(dependencies), dependencies, options, targetRoot, remoteRoot, worktreePath, baseSha, statePath,
    events, evidence, store: rawStore, comments, implementationAuthorities, reviewAuthorities,
    candidateAuthorityHashes, checkedChangePayloads, reviewInputs,
    reviewReportRepairInputs,
    implementationAttemptIds,
    setIssueState: (state: 'OPEN' | 'CLOSED') => { issueState = state; },
  };
}

async function prepareActiveIssueFeedback(fixture: Awaited<ReturnType<typeof runFixture>>): Promise<void> {
  const initial = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(initial.status, 'review-ready');
  if (initial.status !== 'review-ready') throw new Error('initial publication failed');
  const record = (await fixture.store.read()).runs[0]!;
  const head = record.reviewFeedback!.previousPublishedHeadSha!;
  const batch = createFrozenReviewFeedbackBatch({
    runId: record.runId,
    canonicalRepository: record.canonicalRepository,
    pullRequest: {
      nodeId: 'PR_1', number: 1, headSha: head, headRefName: record.branchName,
      baseRefName: 'main', marker: `<!-- codex-orchestrator:run:${record.runId}:pr -->`,
    },
    priorPublishedHeadSha: head,
    sources: [{
      sourceId: 'issue-comment:terminal', kind: 'issue-comment', sourceUrl: 'https://example.invalid/issues/42#terminal',
      path: null, line: null, body: 'Apply the requested in-scope follow-up.',
      bodySha256: hashReviewFeedbackText('Apply the requested in-scope follow-up.'),
      snapshotSha256: hashReviewFeedbackSnapshot({ id: 'terminal' }), threadState: null, commitSha: head,
      sourceCreatedAt: '2026-07-16T12:10:00.000Z', sourceUpdatedAt: '2026-07-16T12:10:00.000Z',
      author: { login: 'writer', userId: '42' },
      permission: { permission: 'write', userId: '42', checkedAt: '2026-07-16T12:10:00.000Z' },
    }],
    frozenAt: '2026-07-16T12:10:00.000Z',
  });
  let offered = false;
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => offered
      ? { status: 'none', observedHeadSha: head, eligibleSourceIds: [] }
      : (offered = true, { status: 'frozen', batch }),
    revalidate: async () => ({ status: 'valid', observedHeadSha: head }),
  } as unknown as ReviewFeedbackObserver;
  fixture.dependencies.pullRequests.findOpen = async () => ({
    url: initial.pullRequestUrl, body: `<!-- codex-orchestrator:run:${record.runId}:pr -->`,
    number: 1, nodeId: 'PR_1', headSha: head, headRefName: record.branchName, baseRefName: 'main',
  });
}

function workflowGeneration(packageVersion: string, seed: string) {
  return {
    generationHash: seed.repeat(64),
    manifestSha256: 'e'.repeat(64),
    packageVersion,
    generationRoot: `/tmp/workflow-generations/${seed}.content.token`,
    contentSha256: 'f'.repeat(64),
  };
}

function traceStore(
  store: RunRecordWriter,
  events: string[],
  rejectEvent?: string,
  rejectOccurrence = 1,
  storeGate?: { event: string; promise: Promise<void> },
  rejectTransition?: { from: string; to: string },
): RunRecordWriter {
  let rejected = false;
  let matches = 0;
  return {
    inspect: () => store.inspect(),
    read: () => store.read(),
    compareAndSwap: async (generation, next) => {
      const record = next.runs.at(-1);
      const event = `state:${record?.lifecycle ?? 'none'}:${record?.pendingEffect?.kind ?? 'none'}`;
      const prior = (await store.read()).runs.find((candidate) => candidate.runId === record?.runId);
      const transition = { from: prior?.pendingEffect?.kind ?? 'none', to: record?.pendingEffect?.kind ?? 'none' };
      events.push(event);
      if (storeGate?.event === event) {
        events.push('store:deferred');
        await storeGate.promise;
        storeGate = undefined;
      }
      if (rejectEvent === event) matches += 1;
      if (!rejected && ((rejectEvent === event && matches === rejectOccurrence)
        || (rejectTransition?.from === transition.from && rejectTransition.to === transition.to))) {
        rejected = true;
        throw new Error('store rejected');
      }
      return store.compareAndSwap(generation, next);
    },
  };
}

function traceGit(
  delegate: LocalGitRunIssueAdapter,
  events: string[],
  options: FixtureOptions,
  candidateAuthorityHashes: string[],
): RunIssueGit {
  const rejected = new Set<string>();
  let createWorktreeRejected = false;
  let inspectWorktreeDiverged = false;
  let getBaseShaRejected = false;
  let ensureContinuationWorktreeRejected = false;
  let candidateNormalizeRejected = false;
  let candidateReleaseRejected = false;
  const shouldReject = (effect: string) => {
    if (options.rejectEffect !== effect || rejected.has(effect)) return false;
    rejected.add(effect);
    return true;
  };
  return {
    candidateV2: {
      ...delegate.candidateV2,
      captureAndPin: async (input) => {
        candidateAuthorityHashes.push(input.boundary.authoritySha256);
        return delegate.candidateV2.captureAndPin(input);
      },
      normalizeSharedIndex: async (input) => {
        if (options.candidateNormalizeFailOnce && !candidateNormalizeRejected && events.includes('git:commit')) {
          candidateNormalizeRejected = true;
          return { kind: 'failed', code: 'candidate-io-failed', detailSha256: sha256('normalize failed') };
        }
        return delegate.candidateV2.normalizeSharedIndex(input);
      },
      releasePin: async (input) => {
        if (!candidateReleaseRejected && ((options.candidateReleaseFailBeforeCommitOnce && events.includes('proof'))
          || (options.candidateReleaseFailOnce && events.includes('git:commit')))) {
          candidateReleaseRejected = true;
          return { kind: 'failed', code: 'candidate-ref-update-unknown', detailSha256: sha256('release failed') };
        }
        return delegate.candidateV2.releasePin(input);
      },
      createOrObserveCommit: async (input) => {
        if (!input.observeOnly && shouldReject('commit')) {
          events.push('git:commit');
          if (options.commitUnknownAfterEffect) await delegate.candidateV2.createOrObserveCommit(input);
          return { kind: 'failed', code: 'candidate-ref-update-unknown', detailSha256: sha256('commit rejected') };
        }
        const before = await delegate.getHead(input.worktreePath);
        const result = await delegate.candidateV2.createOrObserveCommit(input);
        if (!input.observeOnly && before === input.parentSha) events.push('git:commit');
        return result;
      },
    },
    getBaseSha: async (input) => {
      if (options.getBaseShaRejectOnce && !getBaseShaRejected) {
        getBaseShaRejected = true;
        throw new Error('remote unavailable');
      }
      return delegate.getBaseSha(input);
    },
    createWorktree: async (input) => {
      if (options.createIncompleteWorktreeThenRejectOnce && !createWorktreeRejected) {
        createWorktreeRejected = true;
        await mkdir(input.worktreePath, { recursive: true });
        throw new Error('git left an incomplete worktree directory');
      }
      if (options.createWorktreeRejectOnce && !createWorktreeRejected) {
        createWorktreeRejected = true;
        throw new Error(options.createWorktreeRejectOnce);
      }
      return delegate.createWorktree(input);
    },
    ensureContinuationWorktree: async (input) => {
      if (options.ensureContinuationWorktreeThenRejectOnce && !ensureContinuationWorktreeRejected) {
        ensureContinuationWorktreeRejected = true;
        events.push('git:ensure-continuation-worktree');
        await delegate.ensureContinuationWorktree(input);
        throw new Error('continuation worktree result became unknown');
      }
      events.push('git:ensure-continuation-worktree');
      return delegate.ensureContinuationWorktree(input);
    },
    inspectWorktree: async (input) => {
      if (options.inspectWorktreeDivergedOnce && !inspectWorktreeDiverged) {
        inspectWorktreeDiverged = true;
        return 'diverged';
      }
      return delegate.inspectWorktree(input);
    },
    snapshot: (path) => delegate.snapshot(path),
    fingerprintDeniedPaths: (path, deniedPaths) => delegate.fingerprintDeniedPaths(path, deniedPaths),
    listChangedFiles: (path) => delegate.listChangedFiles(path),
    diffTrees: (path, previousTreeSha, candidateTreeSha) => options.diffTreesUnisolatable
      ? Promise.reject(new Error('previous tree object unavailable'))
      : options.diffTreeOverride
        ? Promise.resolve(structuredClone(options.diffTreeOverride))
        : delegate.diffTrees(path, previousTreeSha, candidateTreeSha),
    listChangedFilesIgnoringUntrackedRoot: (path, ignoredRoot) => delegate.listChangedFilesIgnoringUntrackedRoot(path, ignoredRoot),
    fingerprintChangedFiles: (path, changedFiles) => delegate.fingerprintChangedFiles(path, changedFiles),
    stageAll: async (path) => { events.push('git:stage'); return delegate.stageAll(path); },
    getTreeSha: (path) => delegate.getTreeSha(path),
    getHead: (path) => delegate.getHead(path),
    inspectHead: (path) => delegate.inspectHead(path),
    getRemoteBranchSha: (path, branch) => delegate.getRemoteBranchSha(path, branch),
    commit: async (input) => {
      events.push('git:commit');
      if (shouldReject('commit')) throw new Error('commit rejected');
      return delegate.commit(input);
    },
    push: async (input) => {
      events.push('git:push');
      if (options.pushGate) {
        events.push('effect:push-deferred');
        await options.pushGate;
      }
      if (shouldReject('push')) throw new Error('push rejected');
      return delegate.push(input);
    },
  };
}

function configFixture(): AgentAutoConfig {
  const label = (name: string) => ({ name, color: 'ededed', description: `${name} label` });
  return {
    schema: 'codex-orchestrator.agent-auto',
    version: 2,
    github: {
      owner: 'owner', repo: 'repo', baseBranch: 'main',
      labels: {
        auto: label('agent:auto'),
        running: label('agent:running'),
        blocked: label('agent:blocked'),
        review: label('agent:review'),
      },
    },
    runner: { workspaceRoot: '.worktrees', stateDir: '.codex-orchestrator/state', branchTemplate: 'codex/issue-${issueNumber}', pollIntervalSeconds: 60 },
    codex: { command: 'codex', timeoutMs: 1000, idleTimeoutMs: 500, toolNetwork: 'deny' },
    checks: { typecheck: 'npm run typecheck' },
    proof: { artifactDir: '.codex-orchestrator/proofs' },
    deny: { readPaths: [], commands: [] },
  };
}

function passedProof() {
  return { status: 'passed' as const, receipt: receipt() };
}

function receipt() {
  return {
    proofId: 'proof-1',
    bindingSha256: 'c'.repeat(64),
    summary: 'passed',
    publishableEvidence: [],
    localEvidenceId: 'proof:proof-1',
  };
}

function pick(value: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, (value as Record<string, unknown>)[key]]));
}

function effectCounts(events: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events.filter((value) => value.startsWith('effect:') || value.startsWith('git:'))) {
    counts[event] = (counts[event] ?? 0) + 1;
  }
  return counts;
}

function assertSubsequence(actual: string[], expected: string[]): void {
  let index = 0;
  for (const value of actual) if (value === expected[index]) index += 1;
  assert.equal(index, expected.length, `missing ${expected[index]}\n${actual.join('\n')}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}
