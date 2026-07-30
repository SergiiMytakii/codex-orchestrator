import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import type { CheckedChange, CheckedChangePayloadV1 } from '../src/v2/checked-change.js';
import { createCheckedChangeCapabilities } from '../src/v2/checked-change.js';
import type { AgentAutoConfig } from '../src/v2/config.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import { InjectedContainedMutableOperation, type DurableMutableInvocationV1, type MutableWorktreeOperationId } from '../src/v2/contained-report-operation.js';
import { AcceptanceProof, CandidateProofInspectionError, type IosProofInputsV1, type ProofAgent, type ProveChangeResult } from '../src/v2/acceptance-proof.js';
import { InMemoryProofRecordWriter } from '../src/v2/proof-store.js';
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
} from '../src/v2/run-store.js';
import { ContainedImplementationAgent, LocalGitRunIssueAdapter } from '../src/v2/runtime.js';
import { hashRouteDecision, hashTriageArtifact, type RouteReceiptV1 } from '../src/v2/route-decision.js';
import { SpecCoordinator } from '../src/v2/spec-coordinator.js';
import { createSpecRevision } from '../src/v2/spec-delivery.js';
import { createWaitingQuestion, hashNormalizedAnswer } from '../src/v2/waiting-human.js';
import { createFrozenReviewFeedbackBatch, createReviewFeedbackBootstrap, hashReviewFeedbackSnapshot, hashReviewFeedbackText } from '../src/v2/review-feedback.js';
import type { ReviewFeedbackCoordinator } from '../src/v2/review-feedback-coordinator.js';
import { materializeWorkflowGeneration } from '../src/v2/workflow-assets.js';
import { mkdtemp } from './mission-test-temp.js';

const execFileAsync = promisify(execFile);

function mutableInvocationFixture(input: {
  operation: MutableWorktreeOperationId; attemptId: string; worktreePath: string;
  workflowGeneration: { generationHash: string };
  baseline: DurableMutableInvocationV1['baseline'];
  phaseFacts?: string[];
  repairOnly?: boolean;
  reworkFindings?: string[];
}): DurableMutableInvocationV1 {
  return {
    version: 1, operation: input.operation,
    attemptId: input.attemptId, generationHash: input.workflowGeneration.generationHash,
    promptFactsSha256: sha256(canonicalJson(input.phaseFacts ?? [])), worktreePath: input.worktreePath,
    reportPath: `/tmp/${input.attemptId}-report.json`, phase: 'prepared', host: 'test-host', bootId: 'test-boot',
    context: { repairOnly: input.repairOnly ?? false, reworkFindings: [...(input.reworkFindings ?? [])] },
    preparedAt: '2026-07-16T12:00:00.000Z', launchedAt: null, pid: null, processStartIdentity: null,
    processGroupId: null, baseline: structuredClone(input.baseline), reportSha256: null, resultSnapshot: null,
  };
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
    boundary: { kind: 'implementation-cycle', cycle: 1 },
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
      boundary: { kind: 'implementation-cycle', cycle: 1 }, artifactDir: '.codex-orchestrator/proofs',
    }],
    activeExecutions: [],
  }), { kind: 'ok', value: undefined });
  assert.deepEqual(await restartedAdapter.candidateV2.inspectPin(binding), { kind: 'ok', value: 'matching' });
  const prepared = await adapter.candidateV2.prepareExecution({
    binding,
    runId: '00000000-0000-4000-8000-000000000001',
    workspaceRoot: join(root, '.worktrees'),
    operation: 'final-check',
    attemptId: '5'.repeat(64),
  });
  assert.equal(prepared.kind, 'ok', JSON.stringify(prepared));
  if (prepared.kind !== 'ok' || prepared.value.kind !== 'prepared') return;
  const unrecordedSiblingPath = join(dirname(prepared.value.lease.path), 'unrecorded-sibling');
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '--detach', unrecordedSiblingPath, binding.candidateCommitSha]);
  const divergedActive = await restartedAdapter.candidateV2.reconcileOrphans!({
    repositoryRoot: root,
    workspaceRoot: join(root, '.worktrees'),
    activeCandidateRefs: [binding.candidateRef],
    pendingCandidates: [],
    activeExecutions: [{ path: prepared.value.lease.path, candidateCommitSha: 'f'.repeat(40) }],
  });
  assert.equal(divergedActive.kind, 'failed');
  assert.deepEqual(await restartedAdapter.candidateV2.reconcileOrphans!({
    repositoryRoot: root,
    workspaceRoot: join(root, '.worktrees'),
    activeCandidateRefs: [binding.candidateRef],
    pendingCandidates: [],
    activeExecutions: [{ path: prepared.value.lease.path, candidateCommitSha: binding.candidateCommitSha }],
  }), { kind: 'ok', value: undefined });
  assert.equal((await execFileAsync('git', ['-C', prepared.value.lease.path, 'rev-parse', 'HEAD'])).stdout.trim(), binding.candidateCommitSha);
  await assert.rejects(readFile(join(unrecordedSiblingPath, 'tracked.txt')));
  const orphanRef = `refs/codex-orchestrator/candidates/00000000-0000-4000-8000-000000000099/${'9'.repeat(64)}`;
  const orphanPath = join(root, '.worktrees', '.candidate-executions', 'orphan');
  await execFileAsync('git', ['-C', root, 'update-ref', orphanRef, binding.candidateCommitSha]);
  await mkdir(join(root, '.worktrees', '.candidate-executions'), { recursive: true });
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '--detach', orphanPath, binding.candidateCommitSha]);
  assert.deepEqual(await restartedAdapter.candidateV2.reconcileOrphans!({
    repositoryRoot: root,
    workspaceRoot: join(root, '.worktrees'),
    activeCandidateRefs: [binding.candidateRef],
    pendingCandidates: [],
    activeExecutions: [{ path: prepared.value.lease.path, candidateCommitSha: binding.candidateCommitSha }],
  }), { kind: 'ok', value: undefined });
  await assert.rejects(execFileAsync('git', ['-C', root, 'rev-parse', '--verify', orphanRef]));
  await assert.rejects(readFile(join(orphanPath, 'tracked.txt')));
  assert.equal((await execFileAsync('git', ['-C', prepared.value.lease.path, 'rev-parse', 'HEAD^{tree}'])).stdout.trim(), binding.candidateTreeSha);
  const artifactPath = '.codex-orchestrator/proofs/proof-2/evidence.txt';
  const artifactBytes = Buffer.from('candidate evidence\n');
  const replayArtifactPath = '.codex-orchestrator/proofs/proof-3/evidence.txt';
  const replayArtifactSha = sha256(artifactBytes);
  await mkdir(join(prepared.value.lease.path, '.codex-orchestrator', 'proofs', 'proof-3'), { recursive: true });
  await writeFile(join(prepared.value.lease.path, replayArtifactPath), artifactBytes);
  await mkdir(join(root, '.codex-orchestrator', 'proofs', 'proof-3'), { recursive: true });
  await writeFile(join(root, '.codex-orchestrator', 'proofs', 'proof-3', `.evidence.txt.${replayArtifactSha}.tmp`), 'partial');
  assert.deepEqual(await adapter.candidateV2.copyProofArtifacts({
    lease: prepared.value.lease, issueWorktreePath: root, artifactDir: '.codex-orchestrator/proofs', proofId: 'proof-3',
    artifacts: [{ relativePath: replayArtifactPath, sha256: replayArtifactSha }],
  }), { kind: 'ok', value: { kind: 'copied-or-observed' } });
  assert.deepEqual(await readFile(join(root, replayArtifactPath)), artifactBytes);
  await assert.rejects(readFile(join(root, '.codex-orchestrator', 'proofs', 'proof-3', `.evidence.txt.${replayArtifactSha}.tmp`)));
  await writeFile(join(root, '.codex-orchestrator', 'proofs', 'proof-3', `.evidence.txt.${replayArtifactSha}.tmp`), artifactBytes);
  assert.deepEqual(await adapter.candidateV2.copyProofArtifacts({
    lease: prepared.value.lease, issueWorktreePath: root, artifactDir: '.codex-orchestrator/proofs', proofId: 'proof-3',
    artifacts: [{ relativePath: replayArtifactPath, sha256: replayArtifactSha }],
  }), { kind: 'ok', value: { kind: 'copied-or-observed' } });
  await assert.rejects(readFile(join(root, '.codex-orchestrator', 'proofs', 'proof-3', `.evidence.txt.${replayArtifactSha}.tmp`)));
  await mkdir(join(prepared.value.lease.path, '.codex-orchestrator', 'proofs', 'proof-2'), { recursive: true });
  await writeFile(join(prepared.value.lease.path, artifactPath), artifactBytes);
  const escapedArtifactRoot = join(root, 'escaped-artifacts');
  await mkdir(escapedArtifactRoot);
  await symlink(escapedArtifactRoot, join(root, '.codex-orchestrator', 'proofs', 'proof-2'));
  assert.deepEqual(await adapter.candidateV2.copyProofArtifacts({
    lease: prepared.value.lease,
    issueWorktreePath: root,
    artifactDir: '.codex-orchestrator/proofs',
    proofId: 'proof-2',
    artifacts: [{ relativePath: artifactPath, sha256: sha256(artifactBytes) }],
  }), { kind: 'ok', value: { kind: 'artifact-conflict', relativePath: artifactPath } });
  await assert.rejects(readFile(join(escapedArtifactRoot, 'evidence.txt')));
  const fifoArtifactPath = '.codex-orchestrator/proofs/proof-4/evidence.fifo';
  const fifoSource = join(prepared.value.lease.path, fifoArtifactPath);
  await mkdir(dirname(fifoSource), { recursive: true });
  await execFileAsync('mkfifo', [fifoSource]);
  const fifoCopy = adapter.candidateV2.copyProofArtifacts({
    lease: prepared.value.lease, issueWorktreePath: root, artifactDir: '.codex-orchestrator/proofs', proofId: 'proof-4',
    artifacts: [{ relativePath: fifoArtifactPath, sha256: sha256(artifactBytes) }],
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let fifoUnblock: Awaited<ReturnType<typeof open>> | undefined;
  const timed = new Promise<'timed-out'>((resolveTimeout) => {
    timeoutHandle = setTimeout(async () => {
      fifoUnblock = await open(fifoSource, constants.O_RDWR | constants.O_NONBLOCK);
      resolveTimeout('timed-out');
    }, 250);
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
  assert.deepEqual(await adapter.candidateV2.inspectExecution({ binding, lease: prepared.value.lease, artifactDir: '.codex-orchestrator/proofs' }), { kind: 'ok', value: 'matching' });
  assert.deepEqual(await adapter.candidateV2.removeExecution({ lease: prepared.value.lease, requireProcessAbsent: true }), { kind: 'ok', value: undefined });
  assert.deepEqual(await adapter.candidateV2.releasePin({ binding, expectedPinnedCommitSha: binding.candidateCommitSha }), { kind: 'ok', value: undefined });
  assert.deepEqual(await adapter.candidateV2.inspectPin(binding), { kind: 'ok', value: 'missing' });
});

test('initial and persisted waiting routes use one durable continuation without implementation', async () => {
  const fixture = await runFixture({ route: 'awaiting-user', agentWrites: false });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(first.status, 'awaiting-user', JSON.stringify(fixture.events));
  assert.equal(fixture.events.includes('agent'), false);
  const state = await fixture.store.read();
  assert.equal(state.runs[0]?.lifecycle, 'waiting-human');
  assert.equal(state.runs[0]?.waitingHuman?.phase, 'awaiting-answer');
  const effects = fixture.events.length;
  const replay = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(replay, first);
  assert.equal(fixture.events.slice(effects).includes('agent'), false);
});

test('spec-required route freezes independently reviewed authority without product implementation', async () => {
  const fixture = await runFixture({ route: 'spec-required', agentWrites: false });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'spec-frozen', JSON.stringify(fixture.events));
  assert.equal(fixture.events.includes('agent'), false);
  assert.deepEqual(fixture.events.filter((event) => event.startsWith('spec-')), ['spec-author', 'spec-review:full']);
  const run = (await fixture.store.read()).runs[0]!;
  assert.equal(run.lifecycle, 'spec-authoring');
  assert.equal(run.specDelivery?.stage, 'frozen');
  assert.equal(run.specDelivery?.frozen?.receiptSha256, result.status === 'spec-frozen' ? result.receipt.receiptSha256 : '');
  const replay = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(replay, result);
  assert.deepEqual(fixture.events.filter((event) => event.startsWith('spec-')), ['spec-author', 'spec-review:full']);
});

test('trusted waiting answer reroutes the same run before implementation and retains terminal history', async () => {
  const fixture = await runFixture({ routeSequence: ['awaiting-user', 'direct'], trustedAnswerOnReplay: true });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'awaiting-user');
  const before = fixture.events.length;
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready', JSON.stringify(fixture.events.slice(before)));
  const resumedEvents = fixture.events.slice(before);
  assert.equal(resumedEvents.filter((event) => event === 'route:triage').length, 1);
  assert.ok(resumedEvents.indexOf('route:triage') < resumedEvents.indexOf('agent'));
  const run = (await fixture.store.read()).runs[0]!;
  assert.equal(run.runId, '00000000-0000-4000-8000-000000000001');
  assert.equal(run.waitingHuman?.phase, 'history-only');
  assert.equal(run.waitingHuman?.history.length, 1);
});

test('a second approved awaiting-user route re-enters waiting-human in the same run', async () => {
  const fixture = await runFixture({ routeSequence: ['awaiting-user', 'awaiting-user'], trustedAnswerOnReplay: true, agentWrites: false });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'awaiting-user');
  const second = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(second.status, 'awaiting-user', JSON.stringify(fixture.events));
  const run = (await fixture.store.read()).runs[0]!;
  assert.equal(run.lifecycle, 'waiting-human');
  assert.equal(run.waitingHuman?.phase, 'awaiting-answer');
  assert.equal(run.waitingHuman?.history.length, 1);
  assert.equal('questionReceipt' in run.waitingHuman! ? run.waitingHuman.questionReceipt.question.generation : undefined, 2);
  assert.equal(fixture.events.includes('agent'), false);
});

test('known live owner contention requeues before labels or state', async () => {
  const fixture = await runFixture({ ownerContention: true });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'requeued');
  assert.equal(fixture.events.some((event) => event.startsWith('effect:') || event.startsWith('state:')), false);
});

test('agent:auto remains authorization when the running status label disappears after claim', async () => {
  const fixture = await runFixture({ dropRunningDuringRoute: true });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
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
    'state:claimed:comment',
    'effect:claim-comment',
    'state:claimed:claim-labels',
    'effect:claim-labels',
    'state:triaging:none',
    'route:triage',
    'state:routed:none',
    'state:implementing:none',
    'route:direct',
    'issue-read:authorize',
    'agent',
    'state:checking:none',
    'check:typecheck',
    'state:proving:none',
    'proof',
    'state:publishing:none',
    'state:publishing:commit',
    'issue-read:authorize',
    'state:publishing:push',
    'issue-read:authorize',
    'git:push',
    'state:publishing:pr',
    'issue-read:authorize',
    'effect:pr',
    'state:publishing:comment',
    'issue-read:authorize',
    'effect:handoff-comment',
    'state:publishing:labels',
    'issue-read:authorize',
    'effect:terminal-labels',
    'state:review-ready:none',
    'owner-release',
  ]);
  const remoteHead = (await execFileAsync('git', ['--git-dir', fixture.remoteRoot, 'rev-parse', 'refs/heads/codex/issue-42'])).stdout.trim();
  assert.match(remoteHead, /^[0-9a-f]{40}$/u);
  assert.equal((await execFileAsync('git', ['-C', fixture.worktreePath, 'rev-list', '--count', `${fixture.baseSha}..HEAD`])).stdout.trim(), '1');
  assert.equal((await execFileAsync('git', ['-C', fixture.worktreePath, 'log', '-1', '--format=%an <%ae>'])).stdout.trim(), 'codex-orchestrator <codex-orchestrator@users.noreply.github.com>');
  assert.ok(fixture.events.indexOf('state:publication-watermark') < fixture.events.indexOf('git:commit'));
});

test('direct run executes issue-scoped verification checks instead of repository-wide configured checks', async () => {
  const scopedCommand = 'npm --prefix src/service test -- --runInBand scoped.spec.ts';
  const fixture = await runFixture({ issueBody: `Verification:\n- ${scopedCommand}\n\nRisk:\nLow.` });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.includes('check:qualification:issue-verification-001'), true);
  assert.equal(fixture.events.includes('check:changed:issue-verification-001'), true);
  assert.equal(fixture.events.some((event) => event.endsWith(':typecheck')), false);
  const record = (await fixture.store.read()).runs[0]!;
  assert.deepEqual(record.checkQualification?.checks.map(({ id, command }) => ({ id, command })), [
    { id: 'issue-verification-001', command: scopedCommand },
  ]);
  assert.deepEqual(record.checks.map(({ id, command }) => ({ id, command })), [
    { id: 'issue-verification-001', command: scopedCommand },
  ]);
});

test('invalid issue Verification blocks before any configured or scoped check runs', async () => {
  const fixture = await runFixture({ issueBody: 'Verification:\n- npm exec -- sh -c owned' });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal(fixture.events.some((event) => event.startsWith('check:')), false);
  assert.equal((await fixture.store.read()).runs[0]?.terminalOutcome, undefined);
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

test('a legacy unchanged-failure check is discarded and rerun on resume', async () => {
  const options: FixtureOptions = { checkReject: true };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const terminal = await fixture.store.read();
  const interrupted = structuredClone(terminal.runs[0]!);
  interrupted.lifecycle = 'checking';
  interrupted.checks = [{
    id: 'typecheck', command: 'npm run typecheck', status: 'unchanged-failure', outputSha256: sha256('legacy failure'),
  }];
  delete interrupted.changeBindingVersion;
  delete interrupted.candidateBinding;
  delete interrupted.executionLease;
  delete interrupted.terminalOutcome;
  delete interrupted.outcomeEvidenceId;
  const legacyStatePath = join(fixture.targetRoot, '.legacy-run-state.json');
  await writeFile(legacyStatePath, `${canonicalJson({
    schema: terminal.schema, version: 2, generation: terminal.generation, runs: [interrupted],
  })}\n`);
  const legacyStore = new FileRunRecordWriter(legacyStatePath);
  fixture.dependencies.runRecords = legacyStore;

  options.checkReject = false;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const completed = await legacyStore.read();
  assert.equal(completed.version, 3);
  assert.deepEqual(completed.runs[0]?.checks.map((check) => check.status), ['passed']);
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 1);
});

test('a qualification check launch failure resumes before implementation without consuming a cycle', async () => {
  const options: FixtureOptions = { qualificationCheckReject: true };
  const fixture = await runFixture(options);
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 0);
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 1);
  assert.equal((await fixture.store.read()).runs[0]?.terminalOutcome, undefined);

  options.qualificationCheckReject = false;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 1);
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 1);
});

test('a dirty resumed worktree keeps the interrupted implementation fenced without relaunch', async () => {
  const options: FixtureOptions = {
    implementationResult: { kind: 'transport-failed', resumable: false },
  };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const terminal = await fixture.store.read();
  const interrupted = structuredClone(terminal.runs[0]!);
  interrupted.lifecycle = 'implementing';
  delete interrupted.terminalOutcome;
  delete interrupted.outcomeEvidenceId;
  await fixture.store.compareAndSwap(terminal.generation, {
    schema: terminal.schema, version: terminal.version, runs: [interrupted],
  });
  await writeFile(join(fixture.worktreePath, 'feature.txt'), 'partial interrupted implementation\n');

  options.implementationResult = undefined;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal(fixture.events.filter((event) => event === 'check:qualification:typecheck').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 1);
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 1);
});

test('a crash after green qualification but before implementation launch does not consume a cycle', async () => {
  const options: FixtureOptions = {
    implementationResult: { kind: 'transport-failed', resumable: false },
    skipImplementationLaunchPersistence: true,
  };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const terminal = await fixture.store.read();
  const interrupted = structuredClone(terminal.runs[0]!);
  interrupted.lifecycle = 'implementing';
  delete interrupted.terminalOutcome;
  delete interrupted.outcomeEvidenceId;
  await fixture.store.compareAndSwap(terminal.generation, {
    schema: terminal.schema, version: terminal.version, runs: [interrupted],
  });

  options.implementationResult = undefined;
  options.skipImplementationLaunchPersistence = false;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 1);
  assert.equal(fixture.events.filter((event) => event === 'check:qualification:typecheck').length, 2);
});

test('malformed code review consumes one durable report-repair bit and retries before checks', async () => {
  const fixture = await runFixture({ reviewMalformedOnce: true });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, 2);
  const record = (await fixture.store.read()).runs[0]!;
  assert.equal(record.directReview?.review.reportRepairs, 1);
  assert.equal(record.directReview?.status, 'clear');
});

test('code-review restart lets canonical invocation observe process state before candidate cleanup', async () => {
  const fixture = await runFixture({ reviewSafeHaltOnce: true });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const interrupted = (await fixture.store.read()).runs[0]!;
  assert.equal(interrupted.reportInvocation?.operation, 'code-review');
  assert.equal(interrupted.reportInvocation?.phase, 'launched');
  assert.equal(interrupted.executionLease?.operation, 'direct-review');
  assert.equal(interrupted.executionLease?.phase, 'launched');
  assert.equal(fixture.events.includes('candidate-process-absence'), false);

  const recovered = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(recovered.status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'review:code-review-launched').length, 1);
  assert.equal(fixture.events.includes('candidate-process-absence'), false);
});

test('launched direct-review lease without canonical invocation fails closed instead of using a legacy process reader', async () => {
  const fixture = await runFixture({ reviewSafeHaltOnce: true });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const state = await fixture.store.read();
  const interrupted = structuredClone(state.runs[0]!);
  delete interrupted.reportInvocation;
  await fixture.store.compareAndSwap(state.generation, { schema: state.schema, version: state.version, runs: [interrupted] });

  const replayed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(replayed, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: false });
  assert.equal(fixture.events.includes('candidate-process-absence'), false);
});

test('code review gets four report-only repairs per target revision', async () => {
  const fixture = await runFixture({ reviewMalformedCount: 4 });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, 5);
  assert.equal((await fixture.store.read()).runs[0]?.directReview?.review.reportRepairs, 4);
});

test('an exhausted malformed Closure report remains terminal on replay', async () => {
  let checkCalls = 0;
  const fixture = await runFixture({
    reviewMalformedCount: 5,
    reviewMalformedMode: 'closure',
    check: async () => (++checkCalls === 1
      ? { status: 'failed', output: Buffer.from('task regression') }
      : { status: 'passed', output: Buffer.from('ok') }),
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'internal-error');
  const terminal = await fixture.store.read();
  const reviewCalls = fixture.events.filter((event) => event === 'review:code-review').length;
  const implementationCalls = fixture.events.filter((event) => event === 'agent').length;
  fixture.options.reviewMalformedCount = 0;

  const replayed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(replayed.status, 'internal-error');
  const replayedState = await fixture.store.read();
  assert.equal(replayedState.generation, terminal.generation);
  assert.equal(replayedState.runs[0]?.outcomeEvidenceId, terminal.runs[0]?.outcomeEvidenceId);
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, reviewCalls);
  assert.equal(fixture.events.filter((event) => event === 'agent').length, implementationCalls);
});

test('a legacy malformed Closure terminal is no longer a parallel recovery owner', async () => {
  let checkCalls = 0;
  const fixture = await runFixture({
    reviewMalformedCount: 5,
    reviewMalformedMode: 'closure',
    check: async () => (++checkCalls === 1
      ? { status: 'failed', output: Buffer.from('task regression') }
      : { status: 'passed', output: Buffer.from('ok') }),
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'internal-error');
  const terminal = await fixture.store.read();
  const legacy = structuredClone(terminal.runs[0]!);
  assert.equal(legacy.directReview?.terminalCode, 'direct-review-report-malformed');
  legacy.directReview!.review.reportRepairs = 1;
  delete legacy.directReview!.terminalCode;
  legacy.outcomeEvidenceId = `evidence:${legacy.runId}:direct-review-report-malformed`;
  const migrated = await fixture.store.compareAndSwap(terminal.generation, {
    schema: terminal.schema, version: terminal.version, runs: [legacy],
  });
  const reviewCalls = fixture.events.filter((event) => event === 'review:code-review').length;
  const implementationCalls = fixture.events.filter((event) => event === 'agent').length;
  fixture.options.reviewMalformedCount = 0;

  const replayed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(replayed.status, 'internal-error');
  assert.equal((await fixture.store.read()).generation, migrated.generation);
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, reviewCalls);
  assert.equal(fixture.events.filter((event) => event === 'agent').length, implementationCalls);
});

test('repeated runIssue replays the durable terminal outcome without a second claim or publication', async () => {
  const fixture = await runFixture();
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(first.status, 'review-ready');
  const effectsBefore = fixture.events.filter((event) => event.startsWith('effect:') || event.startsWith('git:')).length;

  const second = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(second, first);
  assert.equal(fixture.events.filter((event) => event.startsWith('effect:') || event.startsWith('git:')).length, effectsBefore);
  assert.equal((await fixture.store.read()).runs.length, 1);
});

test('incomplete review observation preserves the review-ready feedback baseline for a later tick', async () => {
  const fixture = await runFixture();
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const before = (await fixture.store.read()).runs[0]!;
  const previousHead = before.reviewFeedback?.previousPublishedHeadSha;
  fixture.dependencies.reviewFeedback = {} as ReviewFeedbackCoordinator;

  const blocked = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(blocked, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.reviewFeedback?.phase, 'idle');
  assert.equal(after.reviewFeedback?.previousPublishedHeadSha, previousHead);
  assert.deepEqual(after.reviewFeedback?.history, before.reviewFeedback?.history);
});

test('migrated bootstrap feedback survives incomplete observation without losing its owner', async () => {
  const fixture = await runFixture();
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const state = await fixture.store.read();
  await fixture.store.compareAndSwap(state.generation, {
    schema: state.schema, version: state.version,
    runs: state.runs.map((run) => ({ ...run, reviewFeedback: createReviewFeedbackBootstrap() })),
  });
  fixture.dependencies.reviewFeedback = {} as ReviewFeedbackCoordinator;

  const blocked = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(blocked, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal((await fixture.store.read()).runs[0]?.reviewFeedback?.phase, 'bootstrap-required');
});

test('migrated bootstrap does not consume feedback across a torn claim observation', async () => {
  const fixture = await runFixture();
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const persisted = await fixture.store.read();
  const record = persisted.runs[0]!;
  const head = record.reviewFeedback!.previousPublishedHeadSha!;
  await fixture.store.compareAndSwap(persisted.generation, {
    schema: persisted.schema, version: persisted.version,
    runs: [{ ...record, reviewFeedback: createReviewFeedbackBootstrap() }],
  });
  const bootstrap = (await fixture.store.read()).runs[0]!;
  fixture.dependencies.pullRequests.findOpen = async () => ({
    url: 'https://example.invalid/pull/1', body: `<!-- codex-orchestrator:run:${record.runId}:pr -->`,
    number: 1, nodeId: 'PR_1', headSha: head,
  });
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => ({
      status: 'frozen',
      batch: trustedFeedbackBatch(record.runId, record.canonicalRepository, record.branchName, head),
    }),
  } as unknown as ReviewFeedbackCoordinator;
  const readIssue = fixture.dependencies.issues.read;
  let reads = 0;
  fixture.dependencies.issues.read = async (issueNumber) => {
    const issue = await readIssue(issueNumber);
    reads += 1;
    return issue && reads === 2 ? { ...issue, comments: [] } : issue;
  };
  const effectsBefore = fixture.events.filter((event) => event.startsWith('effect:') || event === 'agent').length;

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.deepEqual((await fixture.store.read()).runs[0], bootstrap);
  assert.equal(fixture.events.filter((event) => event.startsWith('effect:') || event === 'agent').length, effectsBefore);
});

test('torn issue claim observation preserves review-ready and stable claim loss keeps the safety terminal', async () => {
  const fixture = await runFixture();
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const before = (await fixture.store.read()).runs[0]!;
  const head = before.reviewFeedback!.previousPublishedHeadSha!;
  const batch = trustedFeedbackBatch(before.runId, before.canonicalRepository, before.branchName, head);
  fixture.dependencies.pullRequests.findOpen = async () => ({
    url: 'https://example.invalid/pull/1', body: `<!-- codex-orchestrator:run:${before.runId}:pr -->`,
    number: 1, nodeId: 'PR_1', headSha: head,
  });
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => ({ status: 'frozen', batch }),
  } as unknown as ReviewFeedbackCoordinator;
  const readIssue = fixture.dependencies.issues.read;
  let continuationReads = 0;
  fixture.dependencies.issues.read = async (issueNumber) => {
    const issue = await readIssue(issueNumber);
    continuationReads += 1;
    return issue && continuationReads >= 2 ? { ...issue, comments: [] } : issue;
  };
  const effectsBefore = fixture.events.filter((event) => event.startsWith('effect:') || event === 'agent').length;

  const torn = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(torn, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.deepEqual((await fixture.store.read()).runs[0], before);
  assert.equal(fixture.events.filter((event) => event.startsWith('effect:') || event === 'agent').length, effectsBefore);

  const stable = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(stable, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: false });
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 1);
});

test('review-ready replay remains effect-free without an eligible feedback batch and updates the same PR once for a trusted batch', async () => {
  const fixture = await runFixture({ rejectStoreEvent: 'state:blocked:none' });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(first.status, 'review-ready');
  const initialState = await fixture.store.read();
  const record = initialState.runs[0]!;
  const oldHead = record.reviewFeedback!.previousPublishedHeadSha!;
  const reviewCallsBeforeFeedback = fixture.events.filter((event) => event === 'review:code-review').length;
  assert.equal(record.reviewFeedback?.phase, 'idle');

  const batch = createFrozenReviewFeedbackBatch({
    runId: record.runId,
    canonicalRepository: record.canonicalRepository,
    pullRequest: {
      nodeId: 'PR_1', number: 1, headSha: oldHead, headRefName: record.branchName,
      baseRefName: 'main', marker: `<!-- codex-orchestrator:run:${record.runId}:pr -->`,
    },
    priorPublishedHeadSha: oldHead,
    sources: [{
      sourceId: 'pr-thread:T_1', kind: 'thread', sourceUrl: 'https://example.invalid/pull/1#discussion_r1',
      path: 'feature.txt', line: 1, body: 'Change the implementation.',
      bodySha256: hashReviewFeedbackText('Change the implementation.'),
      snapshotSha256: hashReviewFeedbackSnapshot({ id: 'T_1' }),
      threadState: { isResolved: false, isOutdated: false }, commitSha: oldHead,
      sourceCreatedAt: '2026-07-16T12:00:00.000Z', sourceUpdatedAt: '2026-07-16T12:00:00.000Z',
      author: { login: 'writer', userId: '42' },
      permission: { permission: 'write', userId: '42', checkedAt: '2026-07-16T12:00:00.000Z' },
    }],
    frozenAt: '2026-07-16T12:00:00.000Z',
  });
  let offered = false;
  let observationReads = 0;
  let transientPrePush = true;
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => {
      observationReads += 1;
      if (!offered) { offered = true; return { status: 'frozen', batch }; }
      return { status: 'none', observedHeadSha: await fixture.dependencies.git.getHead(fixture.worktreePath), eligibleSourceIds: [] };
    },
    revalidate: async ({ expectedHeadSha }: { expectedHeadSha: string }) => {
      fixture.events.push('feedback-revalidate');
      if (transientPrePush && (await fixture.store.read()).runs[0]?.intent?.kind === 'review-update-push') {
        transientPrePush = false;
        return { status: 'retryable', reason: 'temporary GitHub timeout' };
      }
      return { status: 'valid', observedHeadSha: expectedHeadSha };
    },
  } as unknown as ReviewFeedbackCoordinator;
  const prComments: Array<{ id: string; body: string }> = [];
  fixture.dependencies.pullRequests.findOpen = async () => ({
    url: 'https://example.invalid/pull/1',
    body: `<!-- codex-orchestrator:run:${record.runId}:pr -->\n\nCloses #42`,
    number: 1,
    nodeId: 'PR_1',
    headSha: (await fixture.dependencies.git.getRemoteBranchSha(fixture.worktreePath, record.branchName))!,
  });
  fixture.dependencies.pullRequests.listConversationComments = async () => structuredClone(prComments);
  fixture.dependencies.pullRequests.postConversationComment = async (_number, body) => {
    const comment = { id: String(prComments.length + 1), body };
    prComments.push(comment);
    return comment;
  };
  let feedbackImplementationCalls = 0;
  fixture.dependencies.implementationAgent = {
    run: async ({ operation, worktreePath, invocationState, beforeLaunch, workflowGeneration, phaseFacts }) => {
      feedbackImplementationCalls += 1;
      const attemptId = `feedback-implementation-${feedbackImplementationCalls}`;
      const baseline = await fixture.dependencies.git.snapshot(worktreePath);
      const prepared = mutableInvocationFixture({ operation, attemptId, worktreePath, workflowGeneration, baseline, phaseFacts });
      assert.equal(await invocationState.compareAndSwap(undefined, prepared), true);
      await beforeLaunch?.();
      const launched = { ...prepared, phase: 'launched' as const, pid: 5050 + feedbackImplementationCalls,
        processGroupId: 5050 + feedbackImplementationCalls, processStartIdentity: `test:${5050 + feedbackImplementationCalls}`,
        launchedAt: '2026-07-16T12:00:01.000Z' };
      assert.equal(await invocationState.compareAndSwap(prepared, launched), true);
      fixture.events.push('feedback-implementation');
      await writeFile(join(worktreePath, 'feature.txt'), `implemented after review ${feedbackImplementationCalls}\n`);
      const resultSnapshot = await fixture.dependencies.git.snapshot(worktreePath);
      assert.equal(await invocationState.compareAndSwap(launched, { ...launched, phase: 'adopted',
        reportSha256: '9'.repeat(64), resultSnapshot }), true);
      return {
        kind: 'completed', attemptId,
        report: { version: 1, status: 'completed', summary: 'review fixed', changedFiles: ['feature.txt'], residualRisks: [] },
      };
    },
    settle: async () => ({ kind: 'safe-halt', code: 'unexpected-feedback-settlement' }),
  };

  const setLabels = fixture.dependencies.issues.setLabels;
  await setLabels(42, []);
  const revoked = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(revoked.status, 'review-ready');
  assert.equal((await fixture.store.read()).runs[0]!.reviewFeedback?.phase, 'idle');
  await setLabels(42, ['agent:review']);
  offered = false;

  let rejectActivationLabels = true;
  let activationLabelWrites = 0;
  fixture.dependencies.issues.setLabels = async (issueNumber, next) => {
    if (next.includes('agent:running')) {
      activationLabelWrites += 1;
      if (rejectActivationLabels) {
        rejectActivationLabels = false;
        await setLabels(issueNumber, next);
        throw new Error('activation labels interrupted after effect');
      }
    }
    return setLabels(issueNumber, next);
  };
  const interrupted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(interrupted, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const frozen = (await fixture.store.read()).runs[0]!;
  assert.equal(frozen.reviewFeedback?.phase, 'frozen');
  assert.equal(frozen.reviewFeedback?.repairRound, 1);
  assert.equal(frozen.intent?.kind, 'review-activation-labels');

  const continuationStart = fixture.events.length;
  const transient = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(transient, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal(activationLabelWrites, 1, 'effect-before-CAS recovery repeated the activation label write');
  const interruptedPublication = (await fixture.store.read()).runs[0]!;
  assert.equal(interruptedPublication.reviewFeedback?.phase, 'publishing');
  assert.equal(interruptedPublication.intent?.kind, 'review-update-push');
  if (interruptedPublication.intent?.kind === 'review-update-push') assert.match(interruptedPublication.intent.treeSha, /^[0-9a-f]{40}$/u);

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
  assert.equal(proofValidationIndex, proofIndex - 1, 'proof lacked immediate authorization before canonical invocation observation');

  const updated = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(updated.status, 'review-ready', JSON.stringify(updated));
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.cycle, record.cycle);
  assert.equal(after.reviewFeedback?.phase, 'idle');
  assert.equal(after.reviewFeedback?.history.length, 1);
  assert.equal(observationReads, 1);
  assert.equal(feedbackImplementationCalls, 1);
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length - reviewCallsBeforeFeedback, 1);
  assert.equal(activationLabelWrites, 1);
  assert.equal(prComments.length, 1);
  assert.equal((await execFileAsync('git', ['-C', fixture.worktreePath, 'rev-list', '--count', `${oldHead}..HEAD`])).stdout.trim(), '1');

  const effectsBeforeReplay = fixture.events.filter((event) => event.startsWith('effect:') || event.startsWith('git:')).length + prComments.length;
  const workerCallsBeforeReplay = feedbackImplementationCalls;
  const reviewCallsBeforeReplay = fixture.events.filter((event) => event === 'review:code-review').length;
  const labelWritesBeforeReplay = activationLabelWrites;
  const replay = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(replay.status, 'review-ready');
  assert.equal(observationReads, 2);
  assert.equal(feedbackImplementationCalls, workerCallsBeforeReplay);
  assert.equal(fixture.events.filter((event) => event === 'review:code-review').length, reviewCallsBeforeReplay);
  assert.equal(activationLabelWrites, labelWritesBeforeReplay);
  assert.equal(prComments.length, 1);
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
    return issue && stripClaim ? { ...issue, comments: [] } : issue;
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
  } as unknown as ReviewFeedbackCoordinator;
  const drifted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(
    pick(drifted, ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
    `${JSON.stringify(drifted)}\n${JSON.stringify((await fixture.store.read()).runs[0]?.intent)}\n${fixture.events.join('\n')}`,
  );
  assert.equal((await fixture.store.read()).runs[0]?.intent?.kind, 'review-blocked-labels');
  await fixture.dependencies.issues.setLabels(42, ['agent:review']);
  const interruptedBlock = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(interruptedBlock, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const interruptedBlockRecord = (await fixture.store.read()).runs[0]!;
  assert.equal(interruptedBlockRecord.lifecycle, 'publishing');
  assert.equal(interruptedBlockRecord.intent?.kind, 'review-blocked-labels');
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:blocked']);
  const commentsBeforeRecovery = prComments.length;

  const blocked = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(blocked, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: false });
  assert.equal(prComments.length, commentsBeforeRecovery);
  const blockedRecord = (await fixture.store.read()).runs[0]!;
  assert.equal(blockedRecord.reviewFeedback?.history.length, 2);
  assert.equal(blockedRecord.reviewFeedback?.history[0]?.kind, 'published');
  assert.equal(blockedRecord.reviewFeedback?.history[1]?.kind, 'blocked-safety');
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:blocked']);
});

test('trusted feedback revocation after canonical prepare settles before blocking labels and never launches', async () => {
  const fixture = await runFixture();
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
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
      sourceId: 'pr-thread:revoked', kind: 'thread', sourceUrl: 'https://example.invalid/pull/1#discussion_revoked',
      path: 'feature.txt', line: 1, body: 'Change this.', bodySha256: hashReviewFeedbackText('Change this.'),
      snapshotSha256: hashReviewFeedbackSnapshot({ id: 'revoked' }),
      threadState: { isResolved: false, isOutdated: false }, commitSha: head,
      sourceCreatedAt: '2026-07-16T12:05:00.000Z', sourceUpdatedAt: '2026-07-16T12:05:00.000Z',
      author: { login: 'writer', userId: '42' },
      permission: { permission: 'write', userId: '42', checkedAt: '2026-07-16T12:05:00.000Z' },
    }],
    frozenAt: '2026-07-16T12:05:00.000Z',
  });
  let revalidations = 0;
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => ({ status: 'frozen', batch }),
    revalidate: async ({ expectedHeadSha }: { expectedHeadSha: string }) => {
      revalidations += 1;
      return revalidations === 2
        ? { status: 'blocked', reason: 'trusted permission revoked after prepare' }
        : { status: 'valid', observedHeadSha: expectedHeadSha };
    },
  } as unknown as ReviewFeedbackCoordinator;
  fixture.dependencies.pullRequests.findOpen = async () => ({
    url: 'https://example.invalid/pull/1', body: `<!-- codex-orchestrator:run:${record.runId}:pr -->\n\nCloses #42`,
    number: 1, nodeId: 'PR_1', headSha: head,
  });
  const canonical = installCanonicalExecution(fixture);
  await fixture.dependencies.issues.setLabels(42, ['agent:review']);

  const blocked = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(blocked, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: false });
  const settled = (await fixture.store.read()).runs[0]!;
  assert.equal(settled.mutableInvocation, undefined);
  assert.equal(settled.lifecycle, 'blocked');
  assert.equal(canonical.launches(), 0);
  assert.equal(revalidations, 2);
  assert.deepEqual(pick(settled, ['cycle', 'reportRepairs']), { cycle: record.cycle, reportRepairs: record.reportRepairs });
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

test('not eligible and revoked authorization start no implementation or publication', async () => {
  const ineligible = await runFixture({ initialLabels: [] });
  assert.equal((await ineligible.runner.runIssue({ targetRoot: ineligible.targetRoot, issueNumber: 42 })).status, 'not-eligible');
  assert.equal(ineligible.events.includes('agent'), false);

  const orphanWaiting = await runFixture({ initialLabels: ['agent:auto', 'agent:waiting-human'] });
  assert.equal((await orphanWaiting.runner.runIssue({ targetRoot: orphanWaiting.targetRoot, issueNumber: 42 })).status, 'not-eligible');
  assert.equal(orphanWaiting.events.some((event) => event.startsWith('effect:claim')), false);

  const revoked = await runFixture({ revokeAtAuthorization: 1 });
  const result = await revoked.runner.runIssue({ targetRoot: revoked.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: true });
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


test('claimed initialization verifies the pinned workflow generation before triage', async () => {
  const fixture = await runFixture({ workflowVerificationReject: true });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'safety', resumable: false,
  });
  assert.equal(fixture.events.includes('route:triage'), false);
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
  assert.equal(resumed.status, 'review-ready', JSON.stringify(resumed));
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

test('triage receives persisted issue comments and authorization is rechecked after routing', async () => {
  const comments = [{ body: 'Product owner clarification.', authorAssociation: 'OWNER' }];
  const visible = await runFixture({ initialComments: comments, expectedTriageComment: comments[0]!.body });
  assert.equal((await visible.runner.runIssue({ targetRoot: visible.targetRoot, issueNumber: 42 })).status, 'review-ready');

  const revoked = await runFixture({ revokeDuringRoute: true });
  const result = await revoked.runner.runIssue({ targetRoot: revoked.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'kind']), { status: 'blocked', kind: 'safety' });
  assert.equal(revoked.events.includes('agent'), false);
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
    version: legacy.version,
    runs: legacy.runs,
  });

  assert.equal(
    (await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status,
    'review-ready',
  );
});

test('a competing claim marker added during routing revokes the current run', async () => {
  const fixture = await runFixture({ competingClaimDuringRoute: true });

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(result, ['status', 'kind']), { status: 'blocked', kind: 'safety' });
  assert.equal(fixture.events.includes('agent'), false);
});

test('a competing claim observed after claiming blocks before triage launches', async () => {
  const fixture = await runFixture({ competingClaimAfterClaim: true });

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(result, ['status', 'kind']), { status: 'blocked', kind: 'safety' });
  assert.equal(fixture.events.includes('route:triage'), false);
});

test('triage receives an ordinary comment posted after the initial issue read', async () => {
  const lateComment = 'Clarification posted while the claim was being established.';
  const fixture = await runFixture({
    ordinaryCommentAfterClaim: lateComment,
    expectedTriageComment: lateComment,
  });

  assert.equal(
    (await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status,
    'review-ready',
  );
});

test('pre-triage comment refresh preserves the frozen issue body', async () => {
  const frozenBody = '## Acceptance Criteria\n- The behavior works.';
  const mutatedBody = '## Acceptance Criteria\n- Replace the frozen contract.';
  const fixture = await runFixture({
    issueBodyAfterClaim: mutatedBody,
    expectedTriageIssueBody: frozenBody,
  });

  assert.equal(
    (await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status,
    'review-ready',
  );
  assert.equal(fixture.events.includes('route:triage'), true);
});

test('a malformed duplicate of the current claim marker revokes the run', async () => {
  const fixture = await runFixture({ malformedCurrentClaimDuringRoute: true });

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(result, ['status', 'kind']), { status: 'blocked', kind: 'safety' });
  assert.equal(fixture.events.includes('agent'), false);
});

test('reposting a deleted historical claim under a new comment id revokes the run', async () => {
  const historicalClaim = [
    '<!-- codex-orchestrator:run:11111111-1111-4111-8111-111111111111:claim -->',
    'codex-orchestrator claimed #42 for branch codex/issue-42',
  ].join('\n');
  const fixture = await runFixture({
    initialComments: [{ id: 'historical-claim', body: historicalClaim, authorAssociation: 'COLLABORATOR' }],
    replaceHistoricalClaimDuringRoute: true,
  });

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(result, ['status', 'kind']), { status: 'blocked', kind: 'safety' });
  assert.equal(fixture.events.includes('agent'), false);
});

test('claimed initialization refreshes comments that arrived before restart', async () => {
  const options: FixtureOptions = { rejectEffect: 'claim-comment' };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const lateComment = 'Clarification added while the claim was interrupted.';
  await fixture.dependencies.issues.postComment(42, lateComment);
  options.expectedTriageComment = lateComment;

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
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
      options: { proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'] }, receipt: receipt() }) },
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
  assert.equal((await checkFixture.runner.runIssue({ targetRoot: checkFixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(checkFixture.events.filter((event) => event === 'agent').length, 2);
  assert.equal((await checkFixture.store.read()).runs[0]?.cycle, 2);

  let proofCalls = 0;
  const proofFixture = await runFixture({
    proof: async () => (++proofCalls === 1
      ? { status: 'needs-rework', findings: ['fix acceptance behavior'], receipt: receipt() }
      : passedProof()),
  });
  assert.equal((await proofFixture.runner.runIssue({ targetRoot: proofFixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(proofFixture.events.filter((event) => event === 'agent').length, 2);
  assert.equal(proofFixture.events.filter((event) => event === 'proof').length, 2);
  assert.equal((await proofFixture.store.read()).runs[0]?.cycle, 2);
});

test('a red scoped qualification check is repaired before the issue implementation starts', async () => {
  let qualificationCalls = 0;
  const fixture = await runFixture({
    qualificationCheck: async () => (++qualificationCalls === 1
      ? { status: 'failed', output: Buffer.from('base build is red') }
      : { status: 'passed', output: Buffer.from('base build repaired') }),
  });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assertSubsequence(fixture.events, [
    'check:qualification:typecheck',
    'agent:qualification-repair',
    'check:qualification:typecheck',
    'agent:implementation',
    'check:typecheck',
  ]);
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 1);
});

test('qualification repair has its own bounded budget and never starts the issue implementation while checks stay red', async () => {
  const fixture = await runFixture({
    qualificationCheck: async () => ({ status: 'failed', output: Buffer.from('base remains red') }),
  });

  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'kind', 'resumable']),
    { status: 'blocked', kind: 'exhausted', resumable: true },
  );
  assert.equal(fixture.events.filter((event) => event === 'agent:qualification-repair').length, 5);
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 0);
  const record = (await fixture.store.read()).runs[0]!;
  assert.equal(record.cycle, 1);
  assert.equal(record.checkQualification?.repairAttempts, 5);
});

test('a launched qualification repair transport failure is recovered without spending a main cycle', async () => {
  let qualificationCalls = 0;
  const options: FixtureOptions = {
    qualificationCheck: async () => (++qualificationCalls < 3
      ? { status: 'failed', output: Buffer.from('base remains red') }
      : { status: 'passed', output: Buffer.from('base repaired') }),
    implementationResults: [{ kind: 'transport-failed', resumable: true }],
  };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.store.read()).runs[0]?.checkQualification?.repairAttempts, 0);
  assert.equal(fixture.events.filter((event) => event === 'agent:qualification-repair').length, 1);
  const terminal = await fixture.store.read();
  const interrupted = structuredClone(terminal.runs[0]!);
  interrupted.lifecycle = 'implementing';
  delete interrupted.terminalOutcome;
  delete interrupted.outcomeEvidenceId;
  await fixture.store.compareAndSwap(terminal.generation, {
    schema: terminal.schema, version: terminal.version, runs: [interrupted],
  });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const record = (await fixture.store.read()).runs[0]!;
  assert.equal(record.cycle, 1);
  assert.equal(record.checkQualification?.repairAttempts, 2);
  assert.equal(fixture.events.filter((event) => event === 'agent:qualification-repair').length, 2);
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 1);
});

test('a malformed recovered qualification report is settled once and does not wedge restart', async () => {
  let qualificationCalls = 0;
  const options: FixtureOptions = {
    qualificationCheck: async () => (++qualificationCalls === 1
      ? { status: 'failed', output: Buffer.from('base is red') }
      : { status: 'passed', output: Buffer.from('base is green') }),
    implementationResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'completed', report: { status: 'completed' } },
    ],
  };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.store.read()).runs[0]?.checkQualification?.repairAttempts, 1);
  assert.equal((await fixture.store.read()).runs[0]?.mutableInvocation, undefined);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 1);
});

test('real canonical qualification recovery spends zero for infrastructure and one for recovered malformed output', async () => {
  const fixture = await runFixture({
    qualificationCheck: async () => ({ status: 'failed', output: Buffer.from('base is red') }),
  });
  const canonical = installCanonicalExecution(fixture);

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.store.read()).runs[0]?.checkQualification?.repairAttempts, 0);
  assert.equal(canonical.launches(), 1);

  canonical.process = { status: 'unknown' };
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.store.read()).runs[0]?.checkQualification?.repairAttempts, 0);
  assert.equal(canonical.launches(), 1);

  canonical.process = { status: 'absent', processGroupAlive: false };
  canonical.report = Buffer.from('{"status":"completed"}');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.store.read()).runs[0]?.checkQualification?.repairAttempts, 1);
  assert.equal((await fixture.store.read()).runs[0]?.mutableInvocation, undefined);
  assert.equal(canonical.launches(), 1);

  await fixture.dependencies.issues.setLabels(42, ['agent:running']);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'blocked');
  assert.equal((await fixture.store.read()).runs[0]?.checkQualification?.repairAttempts, 1);
});

test('recovered qualification repair rejects ignored denied-path mutation', async () => {
  const options: FixtureOptions = {
    qualificationCheck: async () => ({ status: 'failed', output: Buffer.from('base is red') }),
    implementationResults: [{ kind: 'transport-failed', resumable: true }],
    agentWritesDeniedIgnoredPath: true,
  };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  await writeFile(join(fixture.worktreePath, '.env'), 'recovered repair touched denied path\n');

  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'kind', 'resumable']),
    { status: 'transport-failed', kind: undefined, resumable: true },
  );
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 0);
});

test('qualification repair preserves an explicit external blocker without starting the issue implementation', async () => {
  const fixture = await runFixture({
    qualificationCheck: async () => ({ status: 'failed', output: Buffer.from('base is red') }),
    implementationResult: {
      kind: 'completed',
      report: {
        version: 1,
        status: 'external-block',
        summary: 'tool is unavailable',
        changedFiles: [],
        residualRisks: [],
        blocker: { kind: 'tool', summary: 'tool is unavailable', attempted: ['ran scoped check'] },
      },
    },
  });

  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'kind', 'resumable']),
    { status: 'blocked', kind: 'external', resumable: true },
  );
  assert.equal(fixture.events.filter((event) => event === 'agent:qualification-repair').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 0);
});

test('a changed qualification command cannot adopt or relaunch an in-flight implementation', async () => {
  const options: FixtureOptions = {
    implementationResult: { kind: 'transport-failed', resumable: false },
  };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const terminal = await fixture.store.read();
  const interrupted = structuredClone(terminal.runs[0]!);
  assert.equal(interrupted.directReview, undefined);
  assert.equal(interrupted.routeReceipt?.route, 'direct');
  assert.equal(interrupted.cycle, 1);
  interrupted.lifecycle = 'implementing';
  delete interrupted.terminalOutcome;
  delete interrupted.outcomeEvidenceId;
  await fixture.store.compareAndSwap(terminal.generation, {
    schema: terminal.schema, version: terminal.version, runs: [interrupted],
  });
  const nextConfig = { ...configFixture(), checks: { typecheck: 'npm test' } };
  fixture.dependencies.readConfig = async () => ({
    config: nextConfig,
    bytes: Buffer.from(`${canonicalJson(nextConfig)}\n`),
  });
  options.implementationResult = undefined;

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const resumed = (await fixture.store.read()).runs[0]!;
  assert.equal(fixture.events.filter((event) => event === 'check:qualification:typecheck').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 1);
  assert.deepEqual(resumed.checkQualification?.checks.map(({ id, command }) => ({ id, command })), [
    { id: 'typecheck', command: 'npm run typecheck' },
  ]);
});

test('the fifth failed implementation cycle exhausts without publication', async () => {
  const fixture = await runFixture({
    check: async () => ({ status: 'failed', output: Buffer.from('still failing') }),
  });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'exhausted', resumable: true });
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 5);
  assert.equal(fixture.events.includes('git:push'), false);
  assert.equal((await fixture.store.read()).runs[0]?.cycle, 5);
});

test('ordinary external safety and exhausted terminals publish the blocked issue status', async () => {
  const cases: Array<{ name: string; options: FixtureOptions; kind: 'external' | 'safety' | 'exhausted' }> = [
    {
      name: 'external proof blocker',
      options: { proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'] }, receipt: receipt() }) },
      kind: 'external',
    },
    { name: 'safety blocker', options: { agentCommit: true }, kind: 'safety' },
    { name: 'exhausted checks', options: { check: async () => ({ status: 'failed', output: Buffer.from('still failing') }) }, kind: 'exhausted' },
  ];
  for (const entry of cases) {
    const fixture = await runFixture(entry.options);
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(result, ['status', 'kind']), { status: 'blocked', kind: entry.kind }, entry.name);
    assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:blocked'], entry.name);
  }
});

test('blocked label delivery resumes from its durable intent without rerunning work', async () => {
  const fixture = await runFixture({
    rejectEffect: 'labels',
    proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'] }, receipt: receipt() }),
  });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal((await fixture.store.read()).runs[0]?.intent?.kind, 'blocked-labels');
  const workCalls = fixture.events.filter((event) => event === 'agent').length;

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(resumed, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:blocked']);
  assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
});

test('blocked label delivery survives a crash after the remote effect without duplicating work or labels', async () => {
  const fixture = await runFixture({
    rejectStoreEvent: 'state:blocked:none',
    proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'] }, receipt: receipt() }),
  });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:blocked']);
  assert.equal((await fixture.store.read()).runs[0]?.intent?.kind, 'blocked-labels');
  const workCalls = fixture.events.filter((event) => event === 'agent').length;
  const labelEffects = fixture.events.filter((event) => event === 'effect:terminal-labels').length;

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(resumed, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
  assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, labelEffects);
});

test('blocked terminal replay repairs a stale running label without rerunning work', async () => {
  const fixture = await runFixture({
    proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'] }, receipt: receipt() }),
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
      proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'] }, receipt: receipt() }),
    });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(result, ['status', 'kind']), { status: 'blocked', kind: 'external' });
    assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, entry.expected);
  }
});

test('blocked transition resumes when the post-effect projection write fails', async () => {
  const fixture = await runFixture({
    blockedTransitionLabels: ['agent:running'],
    rejectStoreEvent: 'state:proving:blocked-labels',
    rejectStoreOccurrence: 2,
    proof: async () => ({ status: 'external-block', blocker: { kind: 'service', summary: 'down', attempted: ['retry'] }, receipt: receipt() }),
  });
  const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:blocked']);
  assert.equal((await fixture.store.read()).runs[0]?.intent?.kind, 'blocked-labels');
  const workCalls = fixture.events.filter((event) => event === 'agent').length;
  const labelEffects = fixture.events.filter((event) => event === 'effect:terminal-labels').length;

  const resumed = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(resumed, ['status', 'kind']), { status: 'blocked', kind: 'external' });
  assert.equal(fixture.events.filter((event) => event === 'agent').length, workCalls);
  assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, labelEffects);
});

test('malformed report repair consumes its semantic budget without consuming a cycle', async () => {
  const malformed = await runFixture({
    implementationResults: [
      { kind: 'completed', report: { status: 'completed' } },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });
  assert.equal((await malformed.runner.runIssue({ targetRoot: malformed.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(malformed.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await malformed.store.read()).runs[0]!, ['cycle', 'reportRepairs']), { cycle: 1, reportRepairs: 1 });

});

for (const reportFault of ['schema', 'changedFiles'] as const) {
  for (const ending of ['recover', 'revoke'] as const) {
    test(`real contained ${reportFault} report repair ${ending === 'recover' ? 'recovers' : 'settles on revocation'} with its exact durable prompt context`, async (t) => {
      const fixture = await runFixture();
      const production = await installProductionContainedAgent(fixture, reportFault);
      t.after(production.cleanup);

      const interrupted = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
      assert.deepEqual(
        pick(interrupted, ['status', 'resumable']),
        { status: 'transport-failed', resumable: true },
        `${JSON.stringify(interrupted)}\n${JSON.stringify(fixture.evidence)}\n${fixture.events.join('\n')}`,
      );
      const crashed = (await fixture.store.read()).runs[0]!;
      assert.equal(crashed.mutableInvocation?.phase, 'launched');
      assert.equal(crashed.mutableInvocation?.context.repairOnly, true);
      assert.deepEqual(crashed.mutableInvocation?.context.reworkFindings, reportFault === 'schema'
        ? ['The previous implementation report did not match the generated schema.']
        : ['The report changedFiles must equal the complete current product change set: ["feature.txt"].']);
      assert.equal(crashed.reportRepairs, 1);
      assert.equal(production.launches(), 2);
      assert.match(production.prompts[1]!, /Report repair only/u);
      assert.match(production.prompts[1]!, reportFault === 'schema'
        ? /previous implementation report did not match the generated schema/u
        : /report changedFiles must equal the complete current product change set/u);

      await production.writeRecoveredReport();
      if (ending === 'revoke') await fixture.dependencies.issues.setLabels(42, ['agent:running']);
      const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

      if (ending === 'recover') assert.equal(result.status, 'review-ready', JSON.stringify(result));
      else assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: true });
      const settled = (await fixture.store.read()).runs[0]!;
      assert.equal(settled.mutableInvocation, undefined);
      assert.equal(settled.reportRepairs, 1);
      assert.equal(settled.cycle, 1);
      assert.equal(production.launches(), 2);
    });
  }
}

for (const reportFault of ['schema', 'changedFiles'] as const) {
  test(`real contained interrupted ${reportFault} report repair rejects recovered worktree mutation without relaunch`, async (t) => {
    const fixture = await runFixture();
    const production = await installProductionContainedAgent(fixture, reportFault, { mutateRepairWorktree: true });
    t.after(production.cleanup);

    assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
    const interrupted = (await fixture.store.read()).runs[0]!;
    assert.equal(interrupted.mutableInvocation?.phase, 'launched');
    assert.equal(interrupted.mutableInvocation?.context.repairOnly, true);
    assert.equal(interrupted.reportRepairs, 1);
    assert.equal(production.launches(), 2);
    await production.writeRecoveredReport();

    const rejected = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

    assert.deepEqual(pick(rejected, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: true });
    const terminal = (await fixture.store.read()).runs[0]!;
    assert.equal(terminal.lifecycle, 'blocked');
    assert.equal(terminal.mutableInvocation, undefined);
    assert.equal(terminal.reportRepairs, 1);
    assert.equal(terminal.cycle, 1);
    assert.equal(production.launches(), 2);
    assert.equal(fixture.evidence.some((entry) => entry.code === 'report-repair-modified-worktree'), true);
  });
}

test('implementation infrastructure failure yields after one launch without a durable retry budget', async () => {
  const fixture = await runFixture({
    implementationResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 1);
  assert.equal('transportRetries' in (await fixture.store.read()).runs[0]!, false);
});

test('incomplete cumulative changedFiles gets one report-only repair without consuming a cycle', async () => {
  const fixture = await runFixture({
    implementationResults: [
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'delta only', changedFiles: ['repair-only.txt'], residualRisks: [] } },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'cumulative', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await fixture.store.read()).runs[0]!, ['cycle', 'reportRepairs']), { cycle: 1, reportRepairs: 1 });
});

test('repeated cumulative changedFiles mismatch remains fail-closed', async () => {
  const mismatch = { kind: 'completed' as const, report: { version: 1 as const, status: 'completed' as const, summary: 'delta only', changedFiles: ['repair-only.txt'], residualRisks: [] } };
  const fixture = await runFixture({ implementationResults: [mismatch, mismatch] });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.equal(result.status, 'internal-error');
  const outcome = (await fixture.store.read()).runs[0]?.terminalOutcome;
  assert.equal(outcome?.status, 'internal-error');
  if (outcome?.status === 'internal-error') assert.equal(outcome.code, 'implementation-change-set-invalid');
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 2);
});

test('implementation transport with an unreported worktree effect stays fenced without relaunch', async () => {
  const fixture = await runFixture({
    transportWrites: true,
    implementationResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 1);
  assert.equal((await fixture.store.read()).runs[0]?.mutableInvocation?.phase, 'launched');
});

test('invoked publication rejection is resumable, retains intent, and starts no later effect', async () => {
  const fixture = await runFixture({ rejectEffect: 'push' });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const state = await fixture.store.read();
  assert.equal(state.runs[0]?.lifecycle, 'publishing');
  assert.equal(state.runs[0]?.intent?.kind, 'push');
  assert.equal(fixture.events.includes('effect:pr'), false);
});

test('every invoked effect rejection stays resumable with its exact durable intent', async () => {
  const remoteCases: Array<{ effect: NonNullable<FixtureOptions['rejectEffect']>; intent: string }> = [
    { effect: 'claim-labels', intent: 'claim-labels' },
    { effect: 'claim-comment', intent: 'comment' },
    { effect: 'pr', intent: 'pr' },
    { effect: 'comment', intent: 'comment' },
    { effect: 'labels', intent: 'labels' },
  ];
  for (const entry of remoteCases) {
    const fixture = await runFixture({ rejectEffect: entry.effect });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, entry.effect);
    assert.equal((await fixture.store.read()).runs[0]?.intent?.kind, entry.intent, entry.effect);
  }
  const local = await runFixture({ rejectEffect: 'commit' });
  assert.deepEqual(
    pick(await local.runner.runIssue({ targetRoot: local.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: false },
  );
  const unknownState = await local.store.read();
  assert.equal(unknownState.runs[0]?.intent?.kind, 'commit');
  assert.equal(local.events.includes('git:push'), false);
  const unknownRun = unknownState.runs[0]!;
  const unknownIntent = unknownRun.intent;
  assert.ok(unknownIntent?.kind === 'commit');
  if (unknownIntent?.kind !== 'commit') return;
  await assert.rejects(local.store.compareAndSwap(unknownState.generation, {
    schema: unknownState.schema,
    version: 3,
    runs: [{
      ...unknownRun,
      intent: {
        ...unknownIntent,
        candidateRef: `refs/codex-orchestrator/candidates/${unknownRun.runId}/${'f'.repeat(64)}`,
      },
    }],
  }), /intent candidate binding/u);
  const recoveredLocal = await local.runner.runIssue({ targetRoot: local.targetRoot, issueNumber: 42 });
  assert.equal(recoveredLocal.status, 'review-ready', JSON.stringify({ recoveredLocal, record: (await local.store.read()).runs[0] }));
  assert.equal(local.events.filter((event) => event === 'git:commit').length, 2);
});

test('unknown candidate branch CAS observes an exact completed effect before replay', async () => {
  const fixture = await runFixture({ rejectEffect: 'commit', commitUnknownAfterEffect: true });
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: false },
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
    assert.equal(cleanupPending.intent?.kind, option === 'candidateNormalizeFailOnce' ? 'commit' : 'push', option);
    assert.equal(!!cleanupPending.candidateBinding, option === 'candidateNormalizeFailOnce', option);
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
    { name: 'implementation malformed', options: { implementationResult: { kind: 'completed', report: { status: 'completed' } } }, status: 'internal-error' },
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
  assert.ok(retryableRecord.executionLease);
  assert.equal(retryableRecord.executionLease?.phase, 'prepared');
  assert.equal(
    (await ioFailure.runner.runIssue({ targetRoot: ioFailure.targetRoot, issueNumber: 42 })).status,
    'review-ready',
  );
  assert.equal(ioAttempts, 2);
  assert.equal(ioFailure.events.includes('candidate-process-absence'), false);

  const conflict = await runFixture({
    proof: async () => { throw new CandidateProofInspectionError('candidate-artifact-conflict'); },
  });
  assert.deepEqual(
    pick(await conflict.runner.runIssue({ targetRoot: conflict.targetRoot, issueNumber: 42 }), ['status', 'kind', 'resumable']),
    { status: 'blocked', kind: 'safety', resumable: false },
  );
  const record = (await conflict.store.read()).runs[0]!;
  assert.ok(record.candidateBinding);
  assert.equal(record.intent, undefined);
  assert.equal(conflict.events.includes('effect:terminal-labels'), false);
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

test('passed proof receipt remains durable while candidate cleanup replays without a second proof', async () => {
  const fixture = await runFixture({ candidateExecutionRemoveFailOnce: true });
  assert.deepEqual(
    pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true },
  );
  const pending = (await fixture.store.read()).runs[0]!;
  assert.equal(pending.lifecycle, 'proving');
  assert.ok(pending.proofReceipt);
  assert.equal(pending.executionLease?.operation, 'acceptance-proof');
  const proofs = fixture.events.filter((event) => event === 'proof').length;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'proof').length, proofs);
});

test('RunIssue defers one absent proof recovery before launching one PID-rebound replacement', async () => {
  const fixture = await runFixture();
  const proofRecords = new InMemoryProofRecordWriter();
  const observedPids: number[] = [];
  let launches = 0;
  let recoveryObservations = 0;
  const proofAgent: ProofAgent<any> = { run: async (input) => {
    observedPids.push(input.iosProofInputs!.ownerPid);
    const prior = await input.invocationState!.read();
    if (prior) {
      recoveryObservations += 1;
      assert.equal(prior.attemptId, 'proof-attempt-1');
      assert.equal(await input.invocationState!.compareAndSwap(prior, undefined), true);
      return { kind: 'deferred', code: 'report-operation-output-unavailable' };
    }
    launches += 1;
    assert.equal(await input.invocationState!.compareAndSwap(undefined, {
      version: 1, operation: 'acceptance-proof', attemptId: `proof-attempt-${launches}`,
      generationHash: input.workflowGeneration!.generationHash, promptFactsSha256: '9'.repeat(64),
      reportPath: `/tmp/proof-attempt-${launches}-report.json`, phase: 'launched', host: 'host', bootId: 'boot',
      preparedAt: '2026-07-16T12:00:00.000Z', launchedAt: '2026-07-16T12:00:01.000Z',
      pid: input.iosProofInputs!.ownerPid, processStartIdentity: `start-${input.iosProofInputs!.ownerPid}`,
      processGroupId: input.iosProofInputs!.ownerPid,
      baseline: { headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
        untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'proof-candidate' },
    }), true);
    if (launches === 1) return { kind: 'deferred', code: 'report-operation-process-active-or-uncertain' };
    const evidenceRef = input.checks[0]!.id;
    return { kind: 'report', proofPhaseChangedFiles: [], proofPhaseArtifactSha256: {}, report: {
      version: 1, status: 'passed', decision: { mode: 'non-visual', targets: [] },
      criteria: input.frozenCriteria.map((criterion) => ({ id: criterion.id, status: 'passed', confidence: 'high',
        surfaces: ['non-visual'], evidenceRefs: [evidenceRef], analysis: 'Runner check proves the criterion.' })),
      checks: [], artifacts: [], findings: [], residualRisks: [],
    } };
  } };
  const proof = new AcceptanceProof<any>({
    checkedChangeReader: fixture.dependencies.checkedChangeMint as ReturnType<typeof createCheckedChangeCapabilities>,
    proofRecords, proofAgent,
    inspectFreshness: async (payload, lease) => {
      assert.equal(payload.version, 2);
      assert.ok(lease && fixture.dependencies.git.candidateV2);
      const inspected = await fixture.dependencies.git.candidateV2.inspectExecution({
        binding: payload.binding, lease, artifactDir: configFixture().proof.artifactDir,
      });
      assert.deepEqual(inspected, { kind: 'ok', value: 'matching' });
      return { bindingId: payload.binding.bindingId, candidateTreeSha: payload.binding.candidateTreeSha,
        checkPolicySha256: payload.checkPolicySha256 };
    },
    readArtifact: async () => { throw new Error('unexpected proof artifact'); },
    proofArtifactDir: configFixture().proof.artifactDir, now: fixture.dependencies.now,
  });
  const ownerPids = [4242, 4343, 4444];
  fixture.dependencies.proof.proveChange = async (input) => proof.proveChange({ ...input, iosProofInputs: {
    helperPath: '/immutable/ios-lease.mjs', leaseRoot: '/leases', leaseArtifactPath: '/candidate/proof-1/ios-lease.json',
    proofId: input.proofId, ownerPid: ownerPids.shift()!, xcrunPath: '/usr/bin/xcrun', runtimeId: null, deviceTypeId: null,
  } satisfies IosProofInputsV1 });

  assert.deepEqual(pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true });
  assert.equal((await fixture.store.read()).runs[0]?.lifecycle, 'proving');
  assert.equal((await proofRecords.read('proof-1'))?.invocation?.attemptId, 'proof-attempt-1');
  assert.deepEqual(pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true });
  assert.equal((await fixture.store.read()).runs[0]?.lifecycle, 'proving');
  assert.equal((await proofRecords.read('proof-1'))?.invocation, undefined);
  assert.equal(launches, 1);
  assert.equal(recoveryObservations, 1);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(launches, 2);
  assert.equal(recoveryObservations, 1);
  assert.deepEqual(observedPids, [4242, 4242, 4444]);
});

test('RunIssue settles an active proof before revoked authorization releases leases or publishes terminal labels', async () => {
  const fixture = await runFixture();
  const proofRecords = new InMemoryProofRecordWriter();
  let processAbsent = false;
  let launches = 0;
  let observations = 0;
  let releases = 0;
  const proof = new AcceptanceProof<any>({
    checkedChangeReader: fixture.dependencies.checkedChangeMint as ReturnType<typeof createCheckedChangeCapabilities>,
    proofRecords,
    proofAgent: { run: async (input) => {
      const prior = await input.invocationState!.read();
      if (prior) {
        observations += 1;
        if (processAbsent) assert.equal(await input.invocationState!.compareAndSwap(prior, undefined), true);
        return { kind: 'deferred', code: processAbsent
          ? 'report-operation-output-unavailable' : 'report-operation-process-active-or-uncertain' };
      }
      await input.beforeLaunch?.();
      launches += 1;
      assert.equal(await input.invocationState!.compareAndSwap(undefined, {
        version: 1, operation: 'acceptance-proof', attemptId: `proof-attempt-${launches}`,
        generationHash: input.workflowGeneration!.generationHash, promptFactsSha256: '9'.repeat(64),
        reportPath: `/tmp/proof-attempt-${launches}.json`, phase: 'launched', host: 'host', bootId: 'boot',
        preparedAt: '2026-07-16T12:00:00.000Z', launchedAt: '2026-07-16T12:00:01.000Z',
        pid: 4242, processStartIdentity: 'start-4242', processGroupId: 4242,
        baseline: { headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
          untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'proof-candidate' },
      }), true);
      return { kind: 'deferred', code: 'report-operation-process-active-or-uncertain' };
    } },
    inspectFreshness: async (payload, lease) => {
      assert.equal(payload.version, 2);
      assert.ok(lease && fixture.dependencies.git.candidateV2);
      const inspected = await fixture.dependencies.git.candidateV2.inspectExecution({
        binding: payload.binding, lease, artifactDir: configFixture().proof.artifactDir,
      });
      assert.deepEqual(inspected, { kind: 'ok', value: 'matching' });
      return { bindingId: payload.binding.bindingId, candidateTreeSha: payload.binding.candidateTreeSha,
        checkPolicySha256: payload.checkPolicySha256 };
    },
    readArtifact: async () => { throw new Error('unexpected proof artifact'); },
    androidLease: { verify: async () => {}, release: async () => { releases += 1; } },
    proofArtifactDir: configFixture().proof.artifactDir, now: fixture.dependencies.now,
  });
  fixture.dependencies.proof.proveChange = async (input) => proof.proveChange({ ...input, iosProofInputs: {
    helperPath: '/immutable/ios-lease.mjs', leaseRoot: '/leases', leaseArtifactPath: '/candidate/proof-1/ios-lease.json',
    proofId: input.proofId, ownerPid: 4242, xcrunPath: '/usr/bin/xcrun', runtimeId: null, deviceTypeId: null,
  } });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  await fixture.dependencies.issues.setLabels(42, []);
  const terminalEffects = fixture.events.filter((event) => event === 'effect:terminal-labels').length;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.store.read()).runs[0]?.lifecycle, 'proving');
  assert.equal((await proofRecords.read('proof-1'))?.invocation?.attemptId, 'proof-attempt-1');
  assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, terminalEffects);
  assert.equal(releases, 0);
  processAbsent = true;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await proofRecords.read('proof-1'))?.invocation, undefined);
  assert.equal(releases, 0);
  assert.deepEqual(pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'kind']),
    { status: 'blocked', kind: 'safety' });
  assert.equal(launches, 1);
  assert.equal(observations, 2);
  assert.equal(releases, 1);
});

test('issue read rejection and post-effect CAS failure are resumable with retained intent', async () => {
  const readFailure = await runFixture({ issueReadRejectAt: 3 });
  const readResult = await readFailure.runner.runIssue({ targetRoot: readFailure.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(readResult, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal(readFailure.events.includes('git:commit'), false);

  const casFailure = await runFixture({ rejectStoreEvent: 'state:publishing:none', rejectStoreOccurrence: 2 });
  const casResult = await casFailure.runner.runIssue({ targetRoot: casFailure.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(casResult, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const state = await casFailure.store.read();
  assert.equal(state.runs[0]?.intent?.kind, 'push');
  assert.equal(casFailure.events.includes('git:push'), true);
});

test('restart after effect-before-confirmation reconciles publication without duplicate effects', async () => {
  for (const occurrence of [2, 3, 4] as const) {
    const fixture = await runFixture({ rejectStoreEvent: 'state:publishing:none', rejectStoreOccurrence: occurrence });
    const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(first, ['status', 'resumable']), { status: 'transport-failed', resumable: true }, `occurrence ${occurrence}`);
    const countsBefore = effectCounts(fixture.events);

    const second = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(second.status, 'review-ready', `occurrence ${occurrence}: ${JSON.stringify(second)}`);
    const countsAfter = effectCounts(fixture.events);
    for (const [effect, count] of Object.entries(countsBefore)) {
      if (count > 0) assert.equal(countsAfter[effect], count, `${effect} duplicated at occurrence ${occurrence}`);
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

test('restart adopts interrupted implementation in the same worktree and semantic cycle', async () => {
  const options: FixtureOptions = { implementationResult: { kind: 'transport-failed', resumable: false } };
  const fixture = await runFixture(options);
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const terminal = await fixture.store.read();
  const interrupted = structuredClone(terminal.runs[0]!);
  interrupted.lifecycle = 'implementing';
  delete interrupted.terminalOutcome;
  delete interrupted.outcomeEvidenceId;
  await fixture.store.compareAndSwap(terminal.generation, {
    schema: 'codex-orchestrator.agent-auto-state',
    version: terminal.version,
    runs: [interrupted],
  });
  options.implementationResult = undefined;
  fixture.dependencies.packageVersion = '0.1.52';
  fixture.dependencies.createWorkflowGeneration = async () => { throw new Error('replacement package workflow is corrupt'); };

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready');
  const state = await fixture.store.read();
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0]?.cycle, 1);
  assert.equal(state.runs[0]?.packageVersion, '0.1.51');
  assert.equal(state.runs[0]?.workflowGeneration.generationHash, '1'.repeat(64));
  assert.equal(state.runs[0]?.skillHashes['agent-auto'], 'a'.repeat(64));
  assert.equal(state.runs[0]?.worktreePath, fixture.worktreePath);
});

test('mutable safe-halt yields with its canonical invocation retained', async () => {
  const fixture = await runFixture({
    implementationResult: {
      kind: 'safe-halt',
      code: 'mutable-operation-process-active-or-uncertain',
    },
  });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal((await fixture.store.read()).runs[0]?.mutableInvocation?.phase, 'launched');
  assert.equal(fixture.events.includes('git:push'), false);
  assert.equal(fixture.events.at(-1), 'owner-release');
});

for (const phase of ['prepared', 'launched', 'adopted'] as const) {
  test(`authorization revocation settles an exact ${phase} mutable invocation before terminal label effects`, async () => {
    const fixture = await runFixture({
      implementationResult: { kind: 'transport-failed', resumable: true },
      skipImplementationLaunchPersistence: phase === 'prepared',
    });
    assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
    let state = await fixture.store.read();
    let invocation = state.runs[0]!.mutableInvocation!;
    assert.equal(invocation.phase, phase === 'prepared' ? 'prepared' : 'launched');
    let report: Buffer | undefined;
    if (phase === 'adopted') {
      await writeFile(join(fixture.worktreePath, 'feature.txt'), 'recovered exact implementation\n');
      report = Buffer.from('{"version":1,"status":"completed","summary":"recovered","changedFiles":["feature.txt"],"residualRisks":[]}');
      const resultSnapshot = await fixture.dependencies.git.snapshot(fixture.worktreePath);
      invocation = { ...invocation, phase: 'adopted', reportSha256: sha256(report), resultSnapshot };
      await fixture.store.compareAndSwap(state.generation, {
        schema: state.schema, version: state.version,
        runs: [{ ...state.runs[0]!, mutableInvocation: invocation }],
      });
      state = await fixture.store.read();
    }
    installCanonicalSettlement(fixture, {
      report,
      process: { status: 'absent', processGroupAlive: false },
    });
    await fixture.dependencies.issues.setLabels(42, ['agent:running']);
    const labelEffectsBefore = fixture.events.filter((event) => event === 'effect:terminal-labels').length;

    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

    assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: true });
    const settled = (await fixture.store.read()).runs[0]!;
    assert.equal(settled.mutableInvocation, undefined);
    assert.equal(settled.lifecycle, 'blocked');
    assert.deepEqual(pick(settled, ['cycle', 'reportRepairs']), { cycle: 1, reportRepairs: 0 });
    assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, labelEffectsBefore + 1);
  });
}

test('authorization revocation defers an uncertain launched mutable invocation without terminal label effects', async () => {
  const fixture = await runFixture({ implementationResult: { kind: 'transport-failed', resumable: true } });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  installCanonicalSettlement(fixture, { process: { status: 'unknown' } });
  await fixture.dependencies.issues.setLabels(42, ['agent:running']);
  const labelEffectsBefore = fixture.events.filter((event) => event === 'effect:terminal-labels').length;

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const retained = (await fixture.store.read()).runs[0]!;
  assert.equal(retained.lifecycle, 'implementing');
  assert.equal(retained.mutableInvocation?.phase, 'launched');
  assert.deepEqual(pick(retained, ['cycle', 'reportRepairs']), { cycle: 1, reportRepairs: 0 });
  assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, labelEffectsBefore);
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

test('persisted proving recovery runs before cancellation can terminalize the run', async () => {
  const controller = new AbortController();
  let proofCalls = 0;
  const fixture = await runFixture({
    signal: controller.signal,
    proof: async () => {
      proofCalls += 1;
      return proofCalls < 3
        ? { status: 'transport-failed', resumable: true, receipt: receipt() }
        : { status: 'cancelled', receipt: receipt() };
    },
  });

  assert.deepEqual(pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true });
  assert.equal(proofCalls, 1);
  controller.abort();
  const terminalEffects = fixture.events.filter((event) => event === 'effect:terminal-labels').length;
  const recovery = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(recovery, ['status', 'resumable']),
    { status: 'transport-failed', resumable: true }, JSON.stringify({ recovery, proofCalls, record: (await fixture.store.read()).runs[0] }));
  const retained = (await fixture.store.read()).runs[0]!;
  assert.equal(retained.lifecycle, 'proving');
  assert.equal(retained.terminalOutcome, undefined);
  assert.equal(retained.executionLease?.operation, 'acceptance-proof');
  assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, terminalEffects);
  assert.equal(proofCalls, 2);

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'cancelled');
  assert.equal(proofCalls, 3);
  assert.equal((await fixture.store.read()).runs[0]?.lifecycle, 'cancelled');
  assert.equal(fixture.events.at(-1), 'owner-release');
});

test('persisted proving recovery precedes changed check-policy reconciliation', async () => {
  const controller = new AbortController();
  let proofCalls = 0;
  const fixture = await runFixture({
    signal: controller.signal,
    proofBeforeLaunchSequence: [true, false, true],
    proof: async () => {
      proofCalls += 1;
      return proofCalls < 3
        ? { status: 'transport-failed', resumable: true, receipt: receipt() }
        : { status: 'cancelled', receipt: receipt() };
    },
  });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  fixture.config.checks.lint = 'npm run lint';
  controller.abort();
  assert.deepEqual(pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true });
  assert.equal(proofCalls, 2);
  assert.equal(fixture.events.includes('check:lint'), false);
  assert.equal((await fixture.store.read()).runs[0]?.lifecycle, 'proving');

  assert.deepEqual(pick(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), ['status', 'kind', 'resumable']),
    { status: 'blocked', kind: 'safety', resumable: true });
  assert.equal(proofCalls, 2);
  assert.equal(fixture.events.includes('check:lint'), false);
  assert.equal((await fixture.store.read()).runs[0]?.executionLease, undefined);
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
  ownerContention?: boolean;
  route?: 'direct' | 'awaiting-user' | 'spec-required';
  routeSequence?: Array<'direct' | 'awaiting-user' | 'spec-required'>;
  trustedAnswerOnReplay?: boolean;
  initialLabels?: string[];
  blockedTransitionLabels?: string[];
  revokeAtAuthorization?: number;
  agentCommit?: boolean;
  qualificationCheck?: () => Promise<{ status: 'passed' | 'failed'; output: Buffer; outputSha256?: string }>;
  check?: () => Promise<{ status: 'passed' | 'failed'; output: Buffer; outputSha256?: string }>;
  proof?: (checkedChange: CheckedChange<any>) => Promise<ProveChangeResult>;
  proofBeforeLaunchSequence?: boolean[];
  implementationResult?: ImplementationAgentResult;
  implementationResults?: ImplementationAgentResult[];
  skipImplementationLaunchPersistence?: boolean;
  transportWrites?: boolean;
  agentWrites?: boolean;
  agentWritesDeniedIgnoredPath?: boolean;
  checkReject?: boolean;
  qualificationCheckReject?: boolean;
  proofReject?: boolean;
  proofError?: Error;
  proofMutatesWorktreeOnce?: boolean;
  issueReadRejectAt?: number;
  rejectStoreEvent?: string;
  rejectStoreOccurrence?: number;
  signal?: AbortSignal;
  storeGate?: { event: string; promise: Promise<void> };
  pushGate?: Promise<void>;
  invalidConfig?: boolean;
  storeReadReject?: boolean;
  storeReadError?: Error;
  rejectEffect?: 'claim-labels' | 'claim-comment' | 'commit' | 'push' | 'pr' | 'comment' | 'labels';
  commitUnknownAfterEffect?: boolean;
  candidateNormalizeFailOnce?: boolean;
  candidateReleaseFailOnce?: boolean;
  candidateReleaseFailBeforeCommitOnce?: boolean;
  candidateExecutionRemoveFailOnce?: boolean;
  initialComments?: Array<{
    id?: string;
    body: string;
    authorAssociation: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
  expectedTriageComment?: string;
  revokeDuringRoute?: boolean;
  dropRunningDuringRoute?: boolean;
  workflowVerificationReject?: boolean;
  reviewMalformedOnce?: boolean;
  reviewMalformedCount?: number;
  reviewMalformedMode?: 'full' | 'closure';
  reviewSafeHaltOnce?: boolean;
  createWorktreeRejectOnce?: string;
  createIncompleteWorktreeThenRejectOnce?: boolean;
  inspectWorktreeDivergedOnce?: boolean;
  getBaseShaRejectOnce?: boolean;
  competingClaimDuringRoute?: boolean;
  malformedCurrentClaimDuringRoute?: boolean;
  replaceHistoricalClaimDuringRoute?: boolean;
  competingClaimAfterClaim?: boolean;
  ordinaryCommentAfterClaim?: string;
  issueBodyAfterClaim?: string;
  expectedTriageIssueBody?: string;
  issueBody?: string;
}

function trustedFeedbackBatch(runId: string, canonicalRepository: string, branchName: string, headSha: string) {
  return createFrozenReviewFeedbackBatch({
    runId, canonicalRepository,
    pullRequest: {
      nodeId: 'PR_1', number: 1, headSha, headRefName: branchName, baseRefName: 'main',
      marker: `<!-- codex-orchestrator:run:${runId}:pr -->`,
    },
    priorPublishedHeadSha: headSha,
    sources: [{
      sourceId: 'pr-thread:torn-claim', kind: 'thread', sourceUrl: 'https://example.invalid/pull/1#discussion_torn',
      path: 'feature.txt', line: 1, body: 'Change this implementation.',
      bodySha256: hashReviewFeedbackText('Change this implementation.'),
      snapshotSha256: hashReviewFeedbackSnapshot({ id: 'torn-claim' }),
      threadState: { isResolved: false, isOutdated: false }, commitSha: headSha,
      sourceCreatedAt: '2026-07-16T12:05:00.000Z', sourceUpdatedAt: '2026-07-16T12:05:00.000Z',
      author: { login: 'writer', userId: '42' },
      permission: { permission: 'write', userId: '42', checkedAt: '2026-07-16T12:05:00.000Z' },
    }],
    frozenAt: '2026-07-16T12:05:00.000Z',
  });
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
  if (options.agentWritesDeniedIgnoredPath) config.deny.readPaths = ['.env'];
  const capabilities = createCheckedChangeCapabilities();
  const rawStore = new InMemoryRunRecordWriter();
  const tracedStore = traceStore(rawStore, events, options.rejectStoreEvent, options.rejectStoreOccurrence, options.storeGate);
  const store: RunRecordWriter = options.storeReadReject || options.storeReadError
    ? { read: async () => { throw options.storeReadError ?? new Error('malformed state'); }, compareAndSwap: tracedStore.compareAndSwap }
    : tracedStore;
  const localGit = new LocalGitRunIssueAdapter();
  const git = traceGit(localGit, events, options);
  let labels = [...(options.initialLabels ?? ['agent:auto'])];
  let blockedTransitionMutated = false;
  let nextCommentId = 1;
  let comments: Array<{
    id?: string;
    body: string;
    authorAssociation: string;
    createdAt?: string;
    updatedAt?: string;
  }> = structuredClone(options.initialComments ?? []);
  let pullRequest: { url: string; body: string } | undefined;
  let reads = 0;
  let authReads = 0;
  let reviewCalls = 0;
  let qualificationRepairApplied = false;
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
    state: 'OPEN' as const,
  };
  const dependencies: RunIssueDependencies = {
    readConfig: async () => ({
      bytes: Buffer.from(`${canonicalJson(config)}\n`),
      config: options.invalidConfig ? { ...config, unknown: true } as AgentAutoConfig : config,
    }),
    ownerLock: {
      acquire: async () => {
        if (options.ownerContention) throw new OwnerLockContentionError('live');
        return { release: async () => { events.push('owner-release'); } };
      },
    },
    issues: {
      read: async () => {
        reads += 1;
        if (options.issueReadRejectAt === reads) throw new Error('issue read rejected');
        if (reads === 1) events.push('issue-read:initial');
        else {
          events.push('issue-read:authorize');
          authReads += 1;
          if (options.revokeAtAuthorization === authReads) labels = labels.filter((label) => label !== 'agent:auto');
        }
        return { ...issue, labels: [...labels].sort(), comments: structuredClone(comments) };
      },
      setLabels: async (_issueNumber, next) => {
        const claim = next.includes('agent:running');
        events.push(claim ? 'effect:claim-labels' : 'effect:terminal-labels');
        if (claim && shouldReject('claim-labels')) throw new Error('claim labels rejected');
        if (!claim && shouldReject('labels')) throw new Error('labels rejected');
        labels = [...next];
      },
      transitionToBlocked: async (_issueNumber, policy) => {
        events.push('effect:terminal-labels');
        if (shouldReject('labels')) throw new Error('labels rejected');
        if (!blockedTransitionMutated && options.blockedTransitionLabels) {
          blockedTransitionMutated = true;
          labels = [...options.blockedTransitionLabels];
        }
        if (labels.includes(policy.review) || labels.includes(policy.waitingHuman)) return;
        if (!labels.some((label) => label === policy.auto || label === policy.running || label === policy.blocked)) return;
        labels = labels.filter((label) => label !== policy.running);
        if (!labels.includes(policy.blocked)) labels.push(policy.blocked);
      },
      postComment: async (_issueNumber, body) => {
        const claim = body.split('\n')[0]?.endsWith(':claim -->') ?? false;
        events.push(claim ? 'effect:claim-comment' : 'effect:handoff-comment');
        if (claim && shouldReject('claim-comment')) throw new Error('claim comment rejected');
        if (!claim && shouldReject('comment')) throw new Error('comment rejected');
        comments.push({ id: `comment-${nextCommentId++}`, body, authorAssociation: 'OWNER' });
        if (claim && options.competingClaimAfterClaim) {
          comments.push({
            id: `comment-${nextCommentId++}`,
            body: [
              '<!-- codex-orchestrator:run:33333333-3333-4333-8333-333333333333:claim -->',
              'codex-orchestrator claimed #42 for branch codex/issue-42',
            ].join('\n'),
            authorAssociation: 'COLLABORATOR',
          });
        }
        if (claim && options.ordinaryCommentAfterClaim) {
          comments.push({
            id: `comment-${nextCommentId++}`,
            body: options.ordinaryCommentAfterClaim,
            authorAssociation: 'OWNER',
          });
        }
        if (claim && options.issueBodyAfterClaim) issue.body = options.issueBodyAfterClaim;
      },
    },
    pullRequests: {
      findOpen: async () => pullRequest,
      createDraft: async ({ body }) => {
        events.push('effect:pr');
        if (shouldReject('pr')) throw new Error('pr rejected');
        pullRequest = { url: 'https://example.invalid/pull/1', body };
        return { url: pullRequest.url };
      },
    },
    git,
    routeCoordinator: {
      run: async ({ state, workflowGeneration, promptFacts }) => {
        events.push('route:triage');
        if (options.expectedTriageComment) {
          assert.equal(promptFacts.some((fact) => fact.includes(options.expectedTriageComment!)), true);
        }
        if (options.expectedTriageIssueBody) {
          const issueFact = promptFacts.find((fact) => fact.startsWith('issue='));
          assert.ok(issueFact);
          const routedIssue = JSON.parse(issueFact.slice('issue='.length)) as { body?: unknown };
          assert.equal(routedIssue.body, options.expectedTriageIssueBody);
          assert.notEqual(routedIssue.body, options.issueBodyAfterClaim);
        }
        const expected = await state.read();
        const route = options.routeSequence?.shift() ?? options.route ?? 'direct';
        const awaiting = route === 'awaiting-user';
        const artifact = awaiting ? {
          version: 1 as const, status: 'awaiting-user' as const,
          inspectedEvidence: [{ kind: 'issue' as const, location: '#42', summary: 'Read issue.' }], assumptions: [],
          direct: null, specRequired: null,
          awaitingUser: {
            outcomes: [
              { id: 'a', title: 'A', behaviorDelta: 'Use A.', evidence: ['Issue is ambiguous.'] },
              { id: 'b', title: 'B', behaviorDelta: 'Use B.', evidence: ['Issue is ambiguous.'] },
            ],
            absenceOfAuthorizedChoiceEvidence: ['No authorized answer.'], recommendation: 'Choose A.', question: 'A or B?',
          },
          blocker: null,
        } : route === 'spec-required' ? {
          version: 1 as const, status: 'spec-required' as const,
          inspectedEvidence: [{ kind: 'issue' as const, location: '#42', summary: 'Read issue.' }], assumptions: [],
          direct: null,
          specRequired: { summary: 'Spec fixture.', complexityReasons: ['Durable review authority.'], specMode: 'standard' as const, reviewFocus: ['independence'] },
          awaitingUser: null, blocker: null,
        } : {
          version: 1 as const, status: 'direct' as const,
          inspectedEvidence: [{ kind: 'issue' as const, location: '#42', summary: 'Read issue.' }], assumptions: [],
          direct: { summary: 'Direct fixture.', behaviors: ['Implement behavior.'], verification: ['Run checks.'] },
          specRequired: null, awaitingUser: null, blocker: null,
        };
        const triage = {
          operation: 'triage' as const,
          attemptId: 'triage-fixture',
          artifactSha256: hashTriageArtifact(artifact),
          generationHash: workflowGeneration.generationHash,
        };
        const review = awaiting ? {
          operation: 'ambiguity-review' as const, attemptId: 'review-fixture', candidateSha256: triage.artifactSha256,
          artifactSha256: '9'.repeat(64), verdict: 'approved' as const, generationHash: workflowGeneration.generationHash,
        } : null;
        const receipt: RouteReceiptV1 = {
          version: 1,
          route,
          triage,
          review,
          artifact,
          decisionSha256: '',
          decidedAt: '2026-07-16T12:00:00.000Z',
          assumptions: [],
        };
        receipt.decisionSha256 = hashRouteDecision(receipt);
        const completed = {
          version: expected.version,
          triageRepairs: expected.triageRepairs,
          candidateReviews: awaiting ? 1 as const : expected.candidateReviews,
          phase: 'route-complete' as const,
          triage,
          review,
        };
        const triageInFlight = { ...expected, phase: 'triage-in-flight' as const };
        assert.equal(await state.compareAndSwap(expected, triageInFlight), true);
        const preparedTriage = reportInvocation(triage.attemptId, 'triage', 'prepared', workflowGeneration.generationHash);
        const launchedTriage = reportInvocation(triage.attemptId, 'triage', 'launched', workflowGeneration.generationHash);
        assert.equal(await state.invocation.compareAndSwap(undefined, preparedTriage), true);
        assert.equal(await state.invocation.compareAndSwap(preparedTriage, launchedTriage), true);
        if (awaiting) {
          const candidateReady = { ...expected, phase: 'candidate-ready' as const, candidate: artifact, triage };
          assert.equal(await state.settle(triageInFlight, candidateReady, triage.attemptId), true);
          const reviewInFlight = { ...candidateReady, phase: 'review-in-flight' as const };
          assert.equal(await state.compareAndSwap(candidateReady, reviewInFlight), true);
          const preparedReview = reportInvocation(review!.attemptId, 'ambiguity-review', 'prepared', workflowGeneration.generationHash);
          const launchedReview = reportInvocation(review!.attemptId, 'ambiguity-review', 'launched', workflowGeneration.generationHash);
          assert.equal(await state.invocation.compareAndSwap(undefined, preparedReview), true);
          assert.equal(await state.invocation.compareAndSwap(preparedReview, launchedReview), true);
          assert.equal(await state.complete(reviewInFlight, completed, receipt, review!.attemptId), true);
        } else {
          assert.equal(await state.complete(triageInFlight, completed, receipt, triage.attemptId), true);
        }
        if (options.revokeDuringRoute) labels = labels.filter((label) => label !== 'agent:auto');
        if (options.dropRunningDuringRoute) labels = labels.filter((label) => label !== 'agent:running');
        if (options.competingClaimDuringRoute) {
          comments.push({
            id: `comment-${nextCommentId++}`,
            body: [
              '<!-- codex-orchestrator:run:22222222-2222-4222-8222-222222222222:claim -->',
              'codex-orchestrator claimed #42 for branch codex/issue-42',
            ].join('\n'),
            authorAssociation: 'COLLABORATOR',
          });
        }
        if (options.malformedCurrentClaimDuringRoute) {
          const currentClaim = comments.find((comment) => comment.body.includes(':claim -->'));
          assert.ok(currentClaim);
          comments.push({
            id: `comment-${nextCommentId++}`,
            body: `${currentClaim.body.split('\n')[0]}\nmalformed claim body`,
            authorAssociation: 'OWNER',
          });
        }
        if (options.replaceHistoricalClaimDuringRoute) {
          const historicalIndex = comments.findIndex((comment) => comment.id === 'historical-claim');
          assert.notEqual(historicalIndex, -1);
          const [historical] = comments.splice(historicalIndex, 1);
          comments.push({ ...historical!, id: `comment-${nextCommentId++}` });
        }
        return { status: 'succeeded' as const, receipt };
      },
    },
    routeContinuations: {
      direct: async () => { events.push('route:direct'); return { status: 'completed' }; },
      specRequired: (context, state, signal) => new SpecCoordinator({
        state,
        createAuthorSessionId: () => 'author-session',
        createReviewerSessionId: () => 'reviewer-session',
        operation: {
          author: async ({ state: delivery, authorSessionId: sessionId, invocationState }) => {
            events.push('spec-author');
            const attemptId = `author-${delivery.revisions.length + 1}`;
            const preparedInvocation = reportInvocation(attemptId, 'spec-author');
            const launchedInvocation = reportInvocation(attemptId, 'spec-author', 'launched');
            assert.equal(await invocationState.compareAndSwap(undefined, preparedInvocation), true);
            assert.equal(await invocationState.compareAndSwap(preparedInvocation, launchedInvocation), true);
            return { status: 'completed', value: createSpecRevision({
              revision: delivery.revisions.length + 1, path: '/state/spec.md', content: '# Frozen spec\n',
              evidence: [{ path: 'issue:42', sha256: 'c'.repeat(64), description: 'Issue authority' }],
              author: { attemptId, sessionId }, previousRevision: delivery.revisions.at(-1) ?? null,
            }) };
          },
          review: async ({ state: delivery, mode, reviewerSessionId, invocationState }) => {
            events.push(`spec-review:${mode}`);
            const attemptId = `review-${mode}`;
            const sessionId = reviewerSessionId;
            const preparedInvocation = reportInvocation(attemptId, 'spec-review');
            const launchedInvocation = reportInvocation(attemptId, 'spec-review', 'launched');
            assert.equal(await invocationState.compareAndSwap(undefined, preparedInvocation), true);
            assert.equal(await invocationState.compareAndSwap(preparedInvocation, launchedInvocation), true);
            const target = delivery.revisions.at(-1)!;
            return { status: 'completed', reportSha256: 'd'.repeat(64), value: {
              version: 1 as const, targetRevision: target.revision, targetSha256: target.revisionSha256,
              mode, verdict: 'approved' as const, reviewer: { attemptId, sessionId },
              coverage: ['approved-product-intent','deterministic-executability','safety','scope','validation'],
              defects: [], affectedDefectIds: [], affectedContracts: [],
              closureRequestSha256: mode === 'closure' ? delivery.review.closureRequestSha256 : null,
              acceptedRisks: [], coverageInvalidated: false,
            } };
          },
        },
      }).run(context, signal),
      awaitingUser: async (context, state) => {
        const current = await state.read();
        if (current?.phase === 'awaiting-answer') {
          if (options.trustedAnswerOnReplay) {
            const normalizedAnswer = 'Choose A';
            const answer = {
              version: 1 as const, questionId: current.questionReceipt.question.questionId,
              questionSha256: current.questionReceipt.question.questionSha256,
              commentId: '102', commentUrl: 'https://example.invalid/comments/102', authorId: '2', author: 'maintainer',
              permission: 'write' as const, permissionCheckedAt: '2026-07-16T12:03:00.000Z',
              commentCreatedAt: '2026-07-16T12:02:00.000Z', commentUpdatedAt: '2026-07-16T12:02:00.000Z',
              observedAt: '2026-07-16T12:03:00.000Z', normalizedAnswer,
              normalizedSha256: hashNormalizedAnswer(normalizedAnswer), duplicateCommentIds: [],
            };
            const next = { ...current, phase: 'resume-ready' as const, answerReceipt: answer };
            assert.equal(await state.compareAndSwap(current, next), true);
            return { status: 'resume-ready' as const, answer };
          }
          return { status: 'awaiting-answer', questionId: current.questionReceipt.question.questionId, answerPrefix: current.questionReceipt.question.answerPrefix };
        }
        if (current?.phase === 'resumed') {
          const prior = current.history[0]!.question;
          const question = createWaitingQuestion({
            runId: context.runId, generation: 2, routeDecisionSha256: context.receipt.decisionSha256,
            workflowGenerationHash: context.workflowGeneration.generationHash,
            priorQuestionSha256: prior.questionSha256, conflictHashes: [],
            recommendation: 'Choose A.', question: 'A or B?',
          });
          const next = {
            version: 1 as const, clarificationAttempts: 1 as const, permissionRetries: current.permissionRetries,
            effectRetries: structuredClone(current.effectRetries), history: structuredClone(current.history),
            phase: 'awaiting-answer' as const,
            questionReceipt: {
              question, commentId: '103', commentUrl: 'https://example.invalid/comments/103', authorId: '1', author: 'runner',
              createdAt: '2026-07-16T12:04:00.000Z', observedAt: '2026-07-16T12:04:00.000Z',
            },
          };
          assert.equal(await state.compareAndSwap(current, next), true);
          return { status: 'awaiting-answer', questionId: question.questionId, answerPrefix: question.answerPrefix };
        }
        const question = createWaitingQuestion({
          runId: context.runId, generation: 1, routeDecisionSha256: context.receipt.decisionSha256,
          workflowGenerationHash: context.workflowGeneration.generationHash, priorQuestionSha256: null, conflictHashes: [],
          recommendation: 'Choose A.', question: 'A or B?',
        });
        const next = {
          version: 1 as const, clarificationAttempts: 0 as const, permissionRetries: 0 as const,
          effectRetries: { questionComment: 0 as const, waitLabels: 0 as const, resumeLabels: 0 as const, revokeLabels: 0 as const },
          history: [], phase: 'awaiting-answer' as const,
          questionReceipt: {
            question, commentId: '101', commentUrl: 'https://example.invalid/comments/101', authorId: '1', author: 'runner',
            createdAt: '2026-07-16T12:01:00.000Z', observedAt: '2026-07-16T12:01:00.000Z',
          },
        };
        assert.equal(await state.compareAndSwap(undefined, next), true);
        return { status: 'awaiting-answer', questionId: question.questionId, answerPrefix: question.answerPrefix };
      },
    },
    implementationAgent: {
      run: async ({ operation, worktreePath: path, reworkFindings, repairOnly, invocationState, beforeLaunch, workflowGeneration, phaseFacts }) => {
        const qualificationRepair = operation === 'qualification-repair';
        assert.equal(
          reworkFindings.some((finding) => finding.startsWith('Pre-implementation scoped check ')),
          qualificationRepair,
        );
        const attemptId = qualificationRepair ? 'qualification-repair-attempt-1'
          : operation === 'review-feedback-implementation' ? 'feedback-implementation-attempt-1' : 'implementation-attempt-1';
        let invocation = await invocationState.read();
        if (invocation && invocation.promptFactsSha256 !== sha256(canonicalJson(phaseFacts ?? []))) {
          return { kind: 'safe-halt', code: 'mutable-operation-correlation-drift' };
        }
        if (invocation?.phase === 'prepared') {
          assert.equal(await invocationState.compareAndSwap(invocation, undefined), true);
          return { kind: 'transport-failed', resumable: true, code: 'mutable-operation-prepared-attempt-abandoned' };
        }
        if (invocation?.phase === 'launched'
          && canonicalJson(await dependencies.git.snapshot(path)) !== canonicalJson(invocation.baseline)) {
          return { kind: 'safe-halt', code: 'mutable-operation-worktree-without-report' };
        }
        if (invocation && options.transportWrites) return { kind: 'safe-halt', code: 'mutable-operation-worktree-without-report' };
        if (!invocation) {
          events.push('agent');
          events.push(qualificationRepair ? 'agent:qualification-repair' : 'agent:implementation');
          const baseline = await dependencies.git.snapshot(path);
          invocation = mutableInvocationFixture({
            operation, attemptId, worktreePath: path, workflowGeneration, baseline, phaseFacts, repairOnly, reworkFindings,
          });
          assert.equal(await invocationState.compareAndSwap(undefined, invocation), true);
          await beforeLaunch?.();
          if (qualificationRepair || !options.skipImplementationLaunchPersistence) {
            const launched = { ...invocation, phase: 'launched' as const, pid: 6060, processGroupId: 6060,
              processStartIdentity: 'test:6060', launchedAt: '2026-07-16T12:00:01.000Z' };
            assert.equal(await invocationState.compareAndSwap(invocation, launched), true);
            invocation = launched;
          }
        }
        const sequenced = options.implementationResults?.shift();
        const selected = sequenced ?? options.implementationResult;
        if (options.transportWrites && selected?.kind === 'transport-failed') {
          await writeFile(join(path, 'feature.txt'), 'partial implementation\n');
        }
        if (selected?.kind !== 'completed' && selected) {
          if (selected.kind === 'cancelled' || selected.kind === 'internal-error') {
            assert.equal(await invocationState.compareAndSwap(invocation, undefined), true);
          }
          return selected;
        }
        if (options.agentWrites !== false) {
          await writeFile(join(path, qualificationRepair ? 'qualification-repair.txt' : 'feature.txt'), 'implemented\n');
        }
        if (qualificationRepair) qualificationRepairApplied = true;
        if (options.agentWritesDeniedIgnoredPath) await writeFile(join(path, '.env'), 'ignored denied fixture\n');
        if (options.agentCommit) {
          await execFileAsync('git', ['-C', path, 'add', '--all']);
          await execFileAsync('git', ['-C', path, '-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-m', 'agent commit']);
        }
        const changedFiles = qualificationRepair
          ? ['qualification-repair.txt']
          : [...(qualificationRepairApplied ? ['feature.txt', 'qualification-repair.txt'] : ['feature.txt'])].sort();
        const completed = selected ?? { kind: 'completed' as const, report: { version: 1, status: 'completed', summary: 'done', changedFiles, residualRisks: [] } };
        if (invocation.phase === 'launched') {
          const resultSnapshot = await dependencies.git.snapshot(path);
          const adopted = { ...invocation, phase: 'adopted' as const,
            reportSha256: '9'.repeat(64), resultSnapshot };
          assert.equal(await invocationState.compareAndSwap(invocation, adopted), true);
        }
        return completed.kind === 'completed' ? { ...completed, attemptId: completed.attemptId ?? attemptId } : completed;
      },
      settle: async ({ invocationState }) => {
        const invocation = await invocationState.read();
        if (!invocation) return { kind: 'settled' as const };
        if (invocation.phase !== 'prepared') {
          return { kind: 'safe-halt' as const, code: 'mutable-operation-process-active-or-uncertain' };
        }
        return await invocationState.compareAndSwap(invocation, undefined)
          ? { kind: 'settled' as const }
          : { kind: 'safe-halt' as const, code: 'mutable-operation-state-conflict' };
      },
    },
    implementationReviewer: {
      run: async (input) => {
        reviewCalls += 1;
        events.push('review:code-review');
        const existingInvocation = await input.invocationState.read();
        if (!existingInvocation) {
          const preparedInvocation = reportInvocation('code-review-attempt-1', 'code-review', 'prepared', input.workflowGeneration.generationHash);
          const launchedInvocation = reportInvocation('code-review-attempt-1', 'code-review', 'launched', input.workflowGeneration.generationHash);
          assert.equal(await input.invocationState.compareAndSwap(undefined, preparedInvocation), true);
          assert.equal(await input.invocationState.compareAndSwap(preparedInvocation, launchedInvocation), true);
          events.push('review:code-review-launched');
        }
        if (options.reviewSafeHaltOnce) {
          options.reviewSafeHaltOnce = false;
          return { kind: 'safe-halt', code: 'report-operation-process-active-or-uncertain' };
        }
        if ((options.reviewMalformedOnce && reviewCalls === 1)
          || ((options.reviewMalformedCount ?? 0) > 0 && (!options.reviewMalformedMode || options.reviewMalformedMode === input.mode))) {
          if ((options.reviewMalformedCount ?? 0) > 0) options.reviewMalformedCount!--;
          const originalReportBytes = Buffer.from('{"report":{"version":1}}');
          return {
            kind: 'report-invalid', diagnostic: 'missing operation', originalReportBytes,
            originalReportSha256: sha256(originalReportBytes),
          };
        }
        return {
          kind: 'completed', attemptId: 'code-review-attempt-1', artifactSha256: '8'.repeat(64),
          report: {
            version: 1, operation: input.operation, targetRevision: input.targetRevision,
            targetFingerprint: input.targetFingerprint, verdict: 'approved', mode: input.mode,
            coverage: ['acceptance-criteria', 'correctness', 'test-quality'], defects: [], residualRisks: [],
            reviewerSessionId: input.reviewerSessionId, closureRequestSha256: input.closureRequestSha256,
            repairFindingOutcomes: input.fixedRepairFindings.map((finding) => ({ id: finding.id, status: 'verified' as const })),
          },
        };
      },
    },
    waitForReviewProcessAbsence: async () => { events.push('candidate-process-absence'); },
    checks: {
      supportsLaunchOwnership: true,
      run: async ({ id, phase, onLaunched }) => {
        await onLaunched?.({ pid: 987654, processGroupId: 987654 });
        events.push(phase === 'qualification'
          ? `check:qualification:${id}`
          : id === 'typecheck' ? 'check:typecheck' : `check:changed:${id}`);
        if (options.qualificationCheckReject && phase === 'qualification') throw new Error('qualification check rejected');
        if (options.checkReject && phase === 'changed') throw new Error('check rejected');
        const fallback: { status: 'passed'; output: Buffer; outputSha256?: string } = {
          status: 'passed', output: Buffer.from('ok'),
        };
        const result = await (phase === 'qualification'
          ? options.qualificationCheck?.() ?? fallback
          : options.check?.() ?? fallback);
        return { ...result, outputSha256: result.outputSha256 ?? sha256(result.output) };
      },
    },
    proof: {
      proveChange: async ({ checkedChange, beforeAgentLaunch }) => {
        if ((options.proofBeforeLaunchSequence?.shift() ?? true)) await beforeAgentLaunch?.();
        events.push('proof');
        capabilities.verifyAndRead(checkedChange);
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
    createReviewSessionId: () => 'code-review-session-1',
    now: () => '2026-07-16T12:00:00.000Z',
    signal: options.signal,
  };
  return { runner: new RunIssue(dependencies), dependencies, options, config, targetRoot, remoteRoot, worktreePath, baseSha, events, evidence, store: rawStore };
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
): RunRecordWriter {
  let rejected = false;
  let matches = 0;
  return {
    read: () => store.read(),
    markPublicationEffectPossible: async () => {
      events.push('state:publication-watermark');
      await (store.markPublicationEffectPossible?.() ?? Promise.resolve());
    },
    compareAndSwap: async (generation, next) => {
      const record = next.runs.at(-1);
      const event = `state:${record?.lifecycle ?? 'none'}:${record?.intent?.kind ?? 'none'}`;
      events.push(event);
      if (storeGate?.event === event) {
        events.push('store:deferred');
        await storeGate.promise;
        storeGate = undefined;
      }
      if (rejectEvent === event) matches += 1;
      if (!rejected && rejectEvent === event && matches === rejectOccurrence) {
        rejected = true;
        throw new Error('store rejected');
      }
      return store.compareAndSwap(generation, next);
    },
  };
}

function traceGit(delegate: LocalGitRunIssueAdapter, events: string[], options: FixtureOptions): RunIssueGit {
  const rejected = new Set<string>();
  let createWorktreeRejected = false;
  let inspectWorktreeDiverged = false;
  let getBaseShaRejected = false;
  let candidateNormalizeRejected = false;
  let candidateReleaseRejected = false;
  let candidateExecutionRemoveRejected = false;
  const shouldReject = (effect: string) => {
    if (options.rejectEffect !== effect || rejected.has(effect)) return false;
    rejected.add(effect);
    return true;
  };
  return {
    candidateV2: {
      ...delegate.candidateV2,
      removeExecution: async (input) => {
        if (options.candidateExecutionRemoveFailOnce && !candidateExecutionRemoveRejected
          && input.lease.operation === 'acceptance-proof') {
          candidateExecutionRemoveRejected = true;
          return { kind: 'failed' as const, code: 'candidate-io-failed' as const, detailSha256: sha256('remove failed') };
        }
        return delegate.candidateV2.removeExecution(input);
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
        if (shouldReject('commit')) {
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
        waitingHuman: label('agent:waiting-human'),
      },
    },
    runner: { workspaceRoot: '.worktrees', stateDir: '.codex-orchestrator/state', branchTemplate: 'codex/issue-${issueNumber}', pollIntervalSeconds: 60, maxCycles: 5 },
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

function installCanonicalSettlement(
  fixture: Awaited<ReturnType<typeof runFixture>>,
  options: {
    report?: Buffer;
    process: { status: 'unknown' } | { status: 'absent'; processGroupAlive: false };
  },
): void {
  const existingAgent = fixture.dependencies.implementationAgent;
  fixture.dependencies.implementationAgent = {
    ...existingAgent,
    settle: async (input: Parameters<typeof existingAgent.run>[0]) => {
      const invocation = await input.invocationState.read();
      const operation = new InjectedContainedMutableOperation({
        host: 'test-host', bootId: 'test-boot', now: () => '2026-07-16T12:00:02.000Z', createAttemptId: () => 'must-not-launch',
        snapshot: (path) => fixture.dependencies.git.snapshot(path),
        prepare: async ({ operation, workflowGeneration }) => ({
          operation, generationHash: workflowGeneration.generationHash, policy: {
            sandboxMode: 'workspace-write' as const, cwdClass: 'worktree' as const, worktreeAccess: 'write' as const,
            writableRootClasses: ['worktree' as const], runnerPostcondition: 'change-set' as const,
            network: 'deny' as const, networkHosts: [], mcpTools: [], approvalCeiling: 'never' as const, externalWrite: false,
          }, reportPath: invocation?.reportPath ?? '/unexpected-report.json',
        }),
        readReport: async () => options.report
          ? { status: 'available' as const, bytes: options.report }
          : { status: 'absent' as const },
        processStartIdentity: async () => 'must-not-launch',
        inspectProcess: async () => options.process,
        launch: async () => { throw new Error('settlement must not launch'); },
      });
      const settled = await operation.settle({
        operation: input.operation, runId: input.runId, worktreePath: input.worktreePath,
        workflowGeneration: input.workflowGeneration, promptFacts: input.phaseFacts ?? [], signal: input.signal,
        context: { repairOnly: input.repairOnly, reworkFindings: [...input.reworkFindings] },
        invocationState: input.invocationState,
      });
      return settled.status === 'settled'
        ? { kind: 'settled' as const }
        : { kind: 'safe-halt' as const, code: settled.code };
    },
  } as typeof fixture.dependencies.implementationAgent;
}

function installCanonicalExecution(fixture: Awaited<ReturnType<typeof runFixture>>) {
  let launchCount = 0;
  const controls = {
    report: undefined as Buffer | undefined,
    process: { status: 'present', processStartIdentity: 'start-6060', processGroupAlive: true } as
      | { status: 'present'; processStartIdentity: string; processGroupAlive: boolean }
      | { status: 'unknown' }
      | { status: 'absent'; processGroupAlive: false },
    launches: () => launchCount,
  };
  const operation = () => new InjectedContainedMutableOperation({
    host: 'test-host', bootId: 'test-boot', now: () => '2026-07-16T12:00:02.000Z',
    createAttemptId: () => `canonical-attempt-${launchCount + 1}`,
    snapshot: (path) => fixture.dependencies.git.snapshot(path),
    prepare: async ({ operation: worker, attemptId, workflowGeneration }) => ({
      operation: worker, generationHash: workflowGeneration.generationHash, policy: {
        sandboxMode: 'workspace-write' as const, cwdClass: 'worktree' as const, worktreeAccess: 'write' as const,
        writableRootClasses: ['worktree' as const], runnerPostcondition: 'change-set' as const,
        network: 'deny' as const, networkHosts: [], mcpTools: [], approvalCeiling: 'never' as const, externalWrite: false,
      }, reportPath: `/tmp/${attemptId}-canonical-report.json`,
    }),
    readReport: async () => controls.report
      ? { status: 'available' as const, bytes: controls.report }
      : { status: 'absent' as const },
    processStartIdentity: async () => 'start-6060',
    inspectProcess: async () => controls.process,
    launch: async ({ onSpawned }) => {
      launchCount += 1;
      await onSpawned({ pid: 6060, processGroupId: 6060 });
      return { status: 'safe-halt' as const };
    },
  });
  const promptFacts = (input: { phaseFacts?: string[] }) => input.phaseFacts ?? [];
  fixture.dependencies.implementationAgent = {
    run: async (input) => {
      const result = await operation().run({
        operation: input.operation, runId: input.runId, worktreePath: input.worktreePath,
        workflowGeneration: input.workflowGeneration, promptFacts: promptFacts(input), signal: input.signal,
        context: { repairOnly: input.repairOnly, reworkFindings: [...input.reworkFindings] },
        invocationState: input.invocationState, beforeLaunch: input.beforeLaunch,
      });
      if (result.status === 'completed') return {
        kind: 'completed' as const, attemptId: result.attemptId,
        report: JSON.parse(result.reportBytes.toString('utf8')) as unknown,
      };
      if (result.status === 'safe-halt') return { kind: 'safe-halt' as const, code: result.code };
      if (result.status === 'retryable') return { kind: 'transport-failed' as const, resumable: true, code: result.code };
      if (result.status === 'cancelled') return { kind: 'cancelled' as const };
      return result.kind === 'external'
        ? { kind: 'transport-failed' as const, resumable: true, code: result.code }
        : { kind: 'safe-halt' as const, code: result.code };
    },
    settle: async (input) => {
      const result = await operation().settle({
        operation: input.operation, runId: input.runId, worktreePath: input.worktreePath,
        workflowGeneration: input.workflowGeneration, promptFacts: promptFacts(input), signal: input.signal,
        context: { repairOnly: input.repairOnly, reworkFindings: [...input.reworkFindings] },
        invocationState: input.invocationState,
      });
      return result.status === 'settled'
        ? { kind: 'settled' as const }
        : { kind: 'safe-halt' as const, code: result.code };
    },
  };
  return controls;
}

async function installProductionContainedAgent(
  fixture: Awaited<ReturnType<typeof runFixture>>,
  reportFault: 'schema' | 'changedFiles',
  options: { mutateRepairWorktree?: boolean } = {},
) {
  const packageRoot = join(import.meta.dirname, '..', '..');
  const orchestratorHome = join(fixture.targetRoot, '.contained-implementation-home');
  const parentCodexHome = join(orchestratorHome, 'parent-codex-home');
  await mkdir(parentCodexHome, { recursive: true });
  const generation = await materializeWorkflowGeneration({
    packageRoot, runtimeRoot: orchestratorHome, packageVersion: '0.1.51', bootId: 'test-boot',
  });
  fixture.dependencies.createWorkflowGeneration = async () => ({
    receipt: generation,
    skillHashes: { 'agent-auto': 'a'.repeat(64), 'acceptance-proof': 'b'.repeat(64) },
  });
  const config = (await fixture.dependencies.readConfig(fixture.targetRoot)).config;
  const prompts: string[] = [];
  let launches = 0;
  let repairReportPath: string | undefined;
  const process = {
    run: async (input: {
      prompt: string; cwd: string; reportPath: string;
      onSpawned?: (identity: { pid: number; processGroupId: number }) => Promise<void>;
    }) => {
      launches += 1;
      prompts.push(input.prompt);
      const child = spawn('/bin/sleep', ['1'], { detached: true, stdio: 'ignore' });
      if (!child.pid) throw new Error('fixture process did not start');
      await input.onSpawned?.({ pid: child.pid, processGroupId: child.pid });
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      if (launches === 1) {
        await writeFile(join(input.cwd, 'feature.txt'), 'implemented by contained fixture\n');
        const report = reportFault === 'schema'
          ? Buffer.from('{"status":"completed"}')
          : Buffer.from('{"version":1,"status":"completed","summary":"wrong set","changedFiles":["wrong.ts"],"residualRisks":[]}');
        return { kind: 'completed' as const, report: { kind: 'available' as const, bytes: report } };
      }
      if (launches === 2) {
        repairReportPath = input.reportPath;
        if (options.mutateRepairWorktree) {
          await writeFile(join(input.cwd, 'feature.txt'), 'report repair illegally changed implementation\n');
        }
        return { kind: 'transport-failed' as const };
      }
      throw new Error('report repair was launched more than once');
    },
  };
  fixture.dependencies.implementationAgent = new ContainedImplementationAgent({
    config: () => config,
    orchestratorHome,
    parentCodexHome,
    safePath: '/usr/bin:/bin:/usr/sbin:/sbin',
    bootId: 'test-boot',
    git: fixture.dependencies.git,
    process: process as never,
    createAttemptId: () => `production-attempt-${launches + 1}`,
    now: () => '2026-07-16T12:00:00.000Z',
  });
  return {
    prompts,
    launches: () => launches,
    writeRecoveredReport: async () => {
      assert.ok(repairReportPath);
      await writeFile(repairReportPath, '{"version":1,"status":"completed","summary":"repaired report","changedFiles":["feature.txt"],"residualRisks":[]}');
    },
    cleanup: async () => {
      await execFileAsync('chmod', ['-R', 'u+w', orchestratorHome]);
      await rm(orchestratorHome, { recursive: true, force: true });
    },
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

function reportInvocation(
  attemptId: string,
  operation: 'triage' | 'ambiguity-review' | 'code-review' | 'spec-author' | 'spec-review',
  phase: 'prepared' | 'launched' = 'prepared',
  generationHash = '1'.repeat(64),
) {
  return {
    version: 1 as const, operation, attemptId, generationHash, promptFactsSha256: 'a'.repeat(64),
    reportPath: `/attempts/${attemptId}/report.json`, phase,
    host: 'host-a', bootId: 'boot-a', preparedAt: '2026-07-16T12:00:00.000Z',
    launchedAt: phase === 'launched' ? '2026-07-16T12:00:01.000Z' : null,
    pid: phase === 'launched' ? 4242 : null,
    processStartIdentity: phase === 'launched' ? 'process-start-4242' : null,
    processGroupId: phase === 'launched' ? 4242 : null,
    baseline: {
      headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
      untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'worktree-1',
    },
  };
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
