import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import type { CheckedChange, CheckedChangePayloadV1 } from '../src/v2/checked-change.js';
import { createCheckedChangeCapabilities } from '../src/v2/checked-change.js';
import type { AgentAutoConfigV1 } from '../src/v2/config.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import { ProofQuiescenceError, type ProveChangeResult } from '../src/v2/acceptance-proof.js';
import {
  RunIssue,
  OwnerLockContentionError,
  type ImplementationAgentResult,
  type RunIssueDependencies,
  type RunIssueGit,
  type RunIssueResult,
} from '../src/v2/run-issue.js';
import {
  InMemoryRunRecordWriter,
  WorkflowGenerationUnrecoverableError,
  type RunRecordWriter,
} from '../src/v2/run-store.js';
import { LocalGitRunIssueAdapter } from '../src/v2/runtime.js';
import { hashRouteDecision, hashTriageArtifact, type RouteReceiptV1 } from '../src/v2/route-decision.js';
import { SpecCoordinator } from '../src/v2/spec-coordinator.js';
import { createSpecRevision } from '../src/v2/spec-delivery.js';
import { createWaitingQuestion, hashNormalizedAnswer } from '../src/v2/waiting-human.js';
import { mkdtemp } from './mission-test-temp.js';

const execFileAsync = promisify(execFile);

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
});

test('public runIssue reaches review-ready only after ordered durable checks, proof, and publication', async () => {
  const fixture = await runFixture();
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready', `${JSON.stringify(result)}\n${fixture.events.join('\n')}`);
  assertSubsequence(fixture.events, [
    'containment',
    'issue-read:initial',
    'state:claimed:claim-labels',
    'effect:claim-labels',
    'state:claimed:comment',
    'effect:claim-comment',
    'state:triaging:none',
    'route:triage',
    'state:routed:none',
    'state:implementing:none',
    'route:direct',
    'issue-read:authorize',
    'agent',
    'state:checking:none',
    'check:typecheck',
    'git:stage',
    'state:proving:none',
    'proof',
    'state:publishing:none',
    'state:publishing:commit',
    'issue-read:authorize',
    'git:commit',
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

test('baseline active V1 migration returns dedicated workflow generation evidence', async () => {
  const fixture = await runFixture({ storeReadError: new WorkflowGenerationUnrecoverableError() });
  let evidenceCode = '';
  const write = fixture.dependencies.writeEvidence;
  fixture.dependencies.writeEvidence = async (input) => {
    evidenceCode = input.code;
    return write(input);
  };
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'internal-error');
  assert.equal(evidenceCode, 'workflow-generation-unrecoverable');
  assert.equal(fixture.events.includes('implementation'), false);
});

test('claimed migration verifies the pinned workflow generation before triage', async () => {
  const fixture = await runFixture({ workflowVerificationReject: true });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), {
    status: 'blocked', kind: 'safety', resumable: false,
  });
  assert.equal(fixture.events.includes('route:triage'), false);
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

test('claimed migration refreshes comments that arrived before restart', async () => {
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

test('malformed report repair and clean transport retry use separate budgets without consuming a cycle', async () => {
  const malformed = await runFixture({
    implementationResults: [
      { kind: 'completed', report: { status: 'completed' } },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });
  assert.equal((await malformed.runner.runIssue({ targetRoot: malformed.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(malformed.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await malformed.store.read()).runs[0]!, ['cycle', 'reportRepairs']), { cycle: 1, reportRepairs: 1 });

  const transport = await runFixture({
    implementationResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } },
    ],
  });
  assert.equal((await transport.runner.runIssue({ targetRoot: transport.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(transport.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await transport.store.read()).runs[0]!, ['cycle', 'transportRetries']), { cycle: 1, transportRetries: 1 });
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
    { status: 'transport-failed', resumable: true },
  );
  assert.equal(local.events.includes('git:push'), false);
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
    { name: 'check rejects', options: { checkReject: true }, status: 'internal-error' },
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

test('issue read rejection and post-effect CAS failure are resumable with retained intent', async () => {
  const readFailure = await runFixture({ issueReadRejectAt: 3 });
  const readResult = await readFailure.runner.runIssue({ targetRoot: readFailure.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(readResult, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal(readFailure.events.includes('git:commit'), false);

  const casFailure = await runFixture({ rejectStoreEvent: 'state:publishing:none', rejectStoreOccurrence: 2 });
  const casResult = await casFailure.runner.runIssue({ targetRoot: casFailure.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(casResult, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  const state = await casFailure.store.read();
  assert.equal(state.runs[0]?.intent?.kind, 'commit');
  assert.equal(casFailure.events.includes('git:push'), false);
});

test('restart after effect-before-confirmation reconciles publication without duplicate effects', async () => {
  for (const occurrence of [2, 3, 4, 5] as const) {
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

test('restart resumes interrupted implementation in the same worktree as the next bounded cycle', async () => {
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
    version: 1,
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

test('safe-halt retains process ownership and owner lock until absence is confirmed', async () => {
  const absence = deferred<void>();
  const fixture = await runFixture({
    implementationResult: {
      kind: 'safe-halt',
      process: {
        pid: 123,
        processGroupId: 123,
        startedAt: '2026-07-16T12:00:00.000Z',
        baseline: {
          headSha: 'a'.repeat(40),
          indexTreeSha: 'b'.repeat(40),
          trackedContentSha256: 'c'.repeat(64),
          untrackedContentSha256: 'd'.repeat(64),
          worktreeIdentity: 'worktree',
        },
      },
      waitForAbsence: () => absence.promise,
    },
  });
  let settled = false;
  const running = fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }).finally(() => { settled = true; });
  await waitFor(() => fixture.events.includes('state:safe-halt:none'));
  assert.equal(settled, false);
  assert.equal(fixture.events.includes('owner-release'), false);
  assert.equal(fixture.events.includes('git:push'), false);
  absence.resolve();
  const result = await running;
  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: false });
  assert.equal(fixture.events.at(-1), 'owner-release');
});

test('proof process quiescence also safe-halts the run until absence is confirmed', async () => {
  const absence = deferred<void>();
  const fixture = await runFixture({ proofError: new ProofQuiescenceError(321, 321, () => absence.promise) });
  let settled = false;
  const running = fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }).finally(() => { settled = true; });
  await waitFor(() => fixture.events.includes('state:safe-halt:none'));
  assert.equal(settled, false);
  assert.equal(fixture.events.includes('owner-release'), false);
  absence.resolve();
  assert.deepEqual(pick(await running, ['status', 'resumable']), { status: 'transport-failed', resumable: false });
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
  ownerContention?: boolean;
  route?: 'direct' | 'awaiting-user' | 'spec-required';
  routeSequence?: Array<'direct' | 'awaiting-user' | 'spec-required'>;
  trustedAnswerOnReplay?: boolean;
  initialLabels?: string[];
  revokeAtAuthorization?: number;
  agentCommit?: boolean;
  check?: () => Promise<{ status: 'passed' | 'failed'; output: Buffer }>;
  proof?: (checkedChange: CheckedChange) => Promise<ProveChangeResult>;
  implementationResult?: ImplementationAgentResult;
  implementationResults?: ImplementationAgentResult[];
  agentWrites?: boolean;
  agentWritesDeniedIgnoredPath?: boolean;
  checkReject?: boolean;
  proofReject?: boolean;
  proofError?: Error;
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
  initialComments?: Array<{ body: string; authorAssociation: string }>;
  expectedTriageComment?: string;
  revokeDuringRoute?: boolean;
  workflowVerificationReject?: boolean;
  reviewMalformedOnce?: boolean;
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
  const baseSha = (await execFileAsync('git', ['-C', targetRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const events: string[] = [];
  const config = configFixture();
  if (options.agentWritesDeniedIgnoredPath) config.deny.readPaths = ['.env'];
  const configBytes = Buffer.from(`${canonicalJson(config)}\n`);
  const capabilities = createCheckedChangeCapabilities();
  const rawStore = new InMemoryRunRecordWriter();
  const tracedStore = traceStore(rawStore, events, options.rejectStoreEvent, options.rejectStoreOccurrence, options.storeGate);
  const store: RunRecordWriter = options.storeReadReject || options.storeReadError
    ? { read: async () => { throw options.storeReadError ?? new Error('malformed state'); }, compareAndSwap: tracedStore.compareAndSwap }
    : tracedStore;
  const localGit = new LocalGitRunIssueAdapter();
  const git = traceGit(localGit, events, options);
  let labels = [...(options.initialLabels ?? ['agent:auto'])];
  let comments: Array<{ body: string; authorAssociation: string }> = structuredClone(options.initialComments ?? []);
  let pullRequest: { url: string; body: string } | undefined;
  let reads = 0;
  let authReads = 0;
  let reviewCalls = 0;
  const rejectedEffects = new Set<string>();
  const shouldReject = (effect: string) => {
    if (options.rejectEffect !== effect || rejectedEffects.has(effect)) return false;
    rejectedEffects.add(effect);
    return true;
  };
  const issue = {
    number: 42,
    title: 'Implement behavior',
    body: '## Acceptance Criteria\n- The behavior works.',
    url: 'https://example.invalid/issues/42',
    state: 'OPEN' as const,
  };
  const dependencies: RunIssueDependencies = {
    readConfig: async () => ({
      bytes: configBytes,
      config: options.invalidConfig ? { ...config, unknown: true } as AgentAutoConfigV1 : config,
    }),
    validateContainment: async () => { events.push('containment'); },
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
      postComment: async (_issueNumber, body) => {
        const claim = body.split('\n')[0]?.endsWith(':claim -->') ?? false;
        events.push(claim ? 'effect:claim-comment' : 'effect:handoff-comment');
        if (claim && shouldReject('claim-comment')) throw new Error('claim comment rejected');
        if (!claim && shouldReject('comment')) throw new Error('comment rejected');
        comments.push({ body, authorAssociation: 'OWNER' });
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
          triageTransportRetries: expected.triageTransportRetries,
          ambiguityTransportRetries: expected.ambiguityTransportRetries,
          candidateReviews: awaiting ? 1 as const : expected.candidateReviews,
          phase: 'route-complete' as const,
          triage,
          review,
        };
        assert.equal(await state.complete(expected, completed, receipt), true);
        if (options.revokeDuringRoute) labels = labels.filter((label) => label !== 'agent:auto');
        return { status: 'succeeded' as const, receipt };
      },
    },
    routeContinuations: {
      direct: async () => { events.push('route:direct'); return { status: 'completed' }; },
      specRequired: (context, state, signal) => new SpecCoordinator({
        state,
        operation: {
          author: async ({ state: delivery, onPrepared, onLaunched }) => {
            events.push('spec-author');
            const attemptId = `author-${delivery.revisions.length + 1}`;
            const sessionId = delivery.authorSessionId ?? 'author-session';
            await onPrepared({ attemptId, sessionId });
            await onLaunched({ attemptId, sessionId, pid: 701, processGroupId: 701 });
            return { status: 'completed', value: createSpecRevision({
              revision: delivery.revisions.length + 1, path: '/state/spec.md', content: '# Frozen spec\n',
              evidence: [{ path: 'issue:42', sha256: 'c'.repeat(64), description: 'Issue authority' }],
              author: { attemptId, sessionId }, previousRevision: delivery.revisions.at(-1) ?? null,
            }) };
          },
          review: async ({ state: delivery, mode, onPrepared, onLaunched }) => {
            events.push(`spec-review:${mode}`);
            const attemptId = `review-${mode}`;
            const sessionId = delivery.review.reviewer?.sessionId ?? 'review-session';
            await onPrepared({ attemptId, sessionId });
            await onLaunched({ attemptId, sessionId, pid: 702, processGroupId: 702 });
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
          recover: async () => ({ status: 'blocked', kind: 'safety', code: 'unexpected-spec-recovery' }),
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
      run: async ({ worktreePath: path }) => {
        events.push('agent');
        const sequenced = options.implementationResults?.shift();
        const selected = sequenced ?? options.implementationResult;
        if (selected?.kind !== 'completed' && selected) return selected;
        if (options.agentWrites !== false) await writeFile(join(path, 'feature.txt'), 'implemented\n');
        if (options.agentWritesDeniedIgnoredPath) await writeFile(join(path, '.env'), 'ignored denied fixture\n');
        if (options.agentCommit) {
          await execFileAsync('git', ['-C', path, 'add', '--all']);
          await execFileAsync('git', ['-C', path, '-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-m', 'agent commit']);
        }
        const completed = selected ?? { kind: 'completed' as const, report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } };
        return completed.kind === 'completed' ? { ...completed, attemptId: completed.attemptId ?? 'implementation-attempt-1' } : completed;
      },
    },
    implementationReviewer: {
      run: async (input) => {
        reviewCalls += 1;
        events.push('review:code-review');
        const invocation = {
          attemptId: 'code-review-attempt-1', operation: input.operation, mode: input.mode,
          reviewerSessionId: input.reviewerSessionId, targetRevision: input.targetRevision,
          targetFingerprint: input.targetFingerprint, closureRequestSha256: input.closureRequestSha256,
        };
        await input.onPrepared(invocation);
        await input.onLaunched({ ...invocation, pid: 4242, processGroupId: 4242 });
        if (options.reviewMalformedOnce && reviewCalls === 1) {
          const originalReportBytes = Buffer.from('{"report":{"version":1}}');
          return {
            kind: 'report-invalid', diagnostic: 'missing operation', originalReportBytes,
            originalReportSha256: sha256(originalReportBytes),
          };
        }
        return {
          kind: 'completed', attemptId: invocation.attemptId, artifactSha256: '8'.repeat(64),
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
    waitForReviewProcessAbsence: async () => {},
    checks: {
      run: async () => {
        events.push('check:typecheck');
        if (options.checkReject) throw new Error('check rejected');
        return options.check?.() ?? { status: 'passed', output: Buffer.from('ok') };
      },
    },
    proof: {
      proveChange: async ({ checkedChange }) => {
        events.push('proof');
        capabilities.verifyAndRead(checkedChange);
        if (options.proofError) throw options.proofError;
        if (options.proofReject) throw new Error('proof rejected');
        return options.proof?.(checkedChange) ?? passedProof();
      },
    },
    checkedChangeMint: capabilities,
    runRecords: store,
    writeEvidence: async ({ runId, code }) => ({ id: `evidence:${runId}:${code}`, path: `.codex-orchestrator/evidence/${runId}.json` }),
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
  return { runner: new RunIssue(dependencies), dependencies, targetRoot, remoteRoot, worktreePath, baseSha, events, store: rawStore };
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
  const shouldReject = (effect: string) => {
    if (options.rejectEffect !== effect || rejected.has(effect)) return false;
    rejected.add(effect);
    return true;
  };
  return {
    getBaseSha: (input) => delegate.getBaseSha(input),
    createWorktree: (input) => delegate.createWorktree(input),
    inspectWorktree: (input) => delegate.inspectWorktree(input),
    snapshot: (path) => delegate.snapshot(path),
    fingerprintDeniedPaths: (path, deniedPaths) => delegate.fingerprintDeniedPaths(path, deniedPaths),
    listChangedFiles: (path) => delegate.listChangedFiles(path),
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

function configFixture(): AgentAutoConfigV1 {
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
    codex: { command: 'codex', requiredVersion: '0.144.4', timeoutMs: 1000, idleTimeoutMs: 500, toolNetwork: 'deny' },
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
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}
