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
  type ImplementationAgentResult,
  type RunIssueDependencies,
  type RunIssueGit,
  type RunIssueResult,
} from '../src/v2/run-issue.js';
import { InMemoryRunRecordWriter, type RunRecordWriter } from '../src/v2/run-store.js';
import { LocalGitRunIssueAdapter } from '../src/v2/runtime.js';
import { mkdtemp } from './mission-test-temp.js';

const execFileAsync = promisify(execFile);

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
    'state:implementing:none',
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

test('agent-authored commit, failed check, proof rework, and proof external block map without publication', async () => {
  const cases: Array<{
    name: string;
    options: FixtureOptions;
    expected: Partial<RunIssueResult>;
  }> = [
    { name: 'agent commit', options: { agentCommit: true }, expected: { status: 'blocked', kind: 'safety' } },
    { name: 'check failed', options: { check: async () => ({ status: 'failed', output: Buffer.from('failed') }) }, expected: { status: 'internal-error' } },
    { name: 'proof rework', options: { proof: async () => ({ status: 'needs-rework', findings: ['fix'], receipt: receipt() }) }, expected: { status: 'internal-error' } },
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

test('invoked publication rejection is non-resumable, retains intent, and starts no later effect', async () => {
  const fixture = await runFixture({ rejectEffect: 'push' });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: false });
  const state = await fixture.store.read();
  assert.equal(state.runs[0]?.lifecycle, 'transport-failed');
  assert.equal(state.runs[0]?.intent?.kind, 'push');
  assert.equal(fixture.events.includes('effect:pr'), false);
});

test('every invoked remote effect rejection is non-resumable while local commit rejection is internal', async () => {
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
    assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: false }, entry.effect);
    assert.equal((await fixture.store.read()).runs[0]?.intent?.kind, entry.intent, entry.effect);
  }
  const local = await runFixture({ rejectEffect: 'commit' });
  assert.equal((await local.runner.runIssue({ targetRoot: local.targetRoot, issueNumber: 42 })).status, 'internal-error');
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

test('issue read rejection is resumable before effect; post-effect CAS failure is non-resumable with retained intent', async () => {
  const readFailure = await runFixture({ issueReadRejectAt: 3 });
  const readResult = await readFailure.runner.runIssue({ targetRoot: readFailure.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(readResult, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.equal(readFailure.events.includes('git:commit'), false);

  const casFailure = await runFixture({ rejectStoreEvent: 'state:publishing:none', rejectStoreOccurrence: 2 });
  const casResult = await casFailure.runner.runIssue({ targetRoot: casFailure.targetRoot, issueNumber: 42 });
  assert.deepEqual(pick(casResult, ['status', 'resumable']), { status: 'transport-failed', resumable: false });
  const state = await casFailure.store.read();
  assert.equal(state.runs[0]?.intent?.kind, 'commit');
  assert.equal(casFailure.events.includes('git:push'), false);
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
  initialLabels?: string[];
  revokeAtAuthorization?: number;
  agentCommit?: boolean;
  check?: () => Promise<{ status: 'passed' | 'failed'; output: Buffer }>;
  proof?: (checkedChange: CheckedChange) => Promise<ProveChangeResult>;
  implementationResult?: ImplementationAgentResult;
  agentWrites?: boolean;
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
  rejectEffect?: 'claim-labels' | 'claim-comment' | 'commit' | 'push' | 'pr' | 'comment' | 'labels';
}

async function runFixture(options: FixtureOptions = {}) {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-v2-run-issue-'));
  const remoteRoot = await mkdtemp(join(tmpdir(), 'codex-v2-run-remote-'));
  const workspaceRoot = join(targetRoot, '.worktrees');
  const worktreePath = join(workspaceRoot, 'issue-42');
  await execFileAsync('git', ['init', '--bare', remoteRoot]);
  await execFileAsync('git', ['init', '-b', 'main', targetRoot]);
  await writeFile(join(targetRoot, 'README.md'), 'base\n');
  await execFileAsync('git', ['-C', targetRoot, 'add', 'README.md']);
  await execFileAsync('git', ['-C', targetRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'base']);
  await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', remoteRoot]);
  const baseSha = (await execFileAsync('git', ['-C', targetRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const events: string[] = [];
  const config = configFixture();
  const configBytes = Buffer.from(`${canonicalJson(config)}\n`);
  const capabilities = createCheckedChangeCapabilities();
  const rawStore = new InMemoryRunRecordWriter();
  const tracedStore = traceStore(rawStore, events, options.rejectStoreEvent, options.rejectStoreOccurrence, options.storeGate);
  const store: RunRecordWriter = options.storeReadReject
    ? { read: async () => { throw new Error('malformed state'); }, compareAndSwap: tracedStore.compareAndSwap }
    : tracedStore;
  const localGit = new LocalGitRunIssueAdapter();
  const git = traceGit(localGit, events, options);
  let labels = [...(options.initialLabels ?? ['agent:auto'])];
  let comments: Array<{ body: string; authorAssociation: string }> = [];
  let reads = 0;
  let authReads = 0;
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
      acquire: async () => ({ release: async () => { events.push('owner-release'); } }),
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
        if (options.rejectEffect === 'claim-labels' && claim) throw new Error('claim labels rejected');
        if (options.rejectEffect === 'labels' && !claim) throw new Error('labels rejected');
        labels = [...next];
      },
      postComment: async (_issueNumber, body) => {
        const claim = body.split('\n')[0]?.endsWith(':claim -->') ?? false;
        events.push(claim ? 'effect:claim-comment' : 'effect:handoff-comment');
        if (options.rejectEffect === 'claim-comment' && claim) throw new Error('claim comment rejected');
        if (options.rejectEffect === 'comment' && !claim) throw new Error('comment rejected');
        comments.push({ body, authorAssociation: 'OWNER' });
      },
    },
    pullRequests: {
      findOpen: async () => undefined,
      createDraft: async () => {
        events.push('effect:pr');
        if (options.rejectEffect === 'pr') throw new Error('pr rejected');
        return { url: 'https://example.invalid/pull/1' };
      },
    },
    git,
    implementationAgent: {
      run: async ({ worktreePath: path }) => {
        events.push('agent');
        if (options.implementationResult) return options.implementationResult;
        if (options.agentWrites !== false) await writeFile(join(path, 'feature.txt'), 'implemented\n');
        if (options.agentCommit) {
          await execFileAsync('git', ['-C', path, 'add', '--all']);
          await execFileAsync('git', ['-C', path, '-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-m', 'agent commit']);
        }
        return { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [] } };
      },
    },
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
    skillHashes: { 'agent-auto': 'a'.repeat(64), 'acceptance-proof': 'b'.repeat(64) },
    createRunId: () => '00000000-0000-4000-8000-000000000001',
    createProofId: () => 'proof-1',
    now: () => '2026-07-16T12:00:00.000Z',
    signal: options.signal,
  };
  return { runner: new RunIssue(dependencies), targetRoot, remoteRoot, worktreePath, baseSha, events, store: rawStore };
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
  return {
    getBaseSha: (input) => delegate.getBaseSha(input),
    createWorktree: (input) => delegate.createWorktree(input),
    snapshot: (path) => delegate.snapshot(path),
    listChangedFiles: (path) => delegate.listChangedFiles(path),
    stageAll: async (path) => { events.push('git:stage'); return delegate.stageAll(path); },
    getTreeSha: (path) => delegate.getTreeSha(path),
    getHead: (path) => delegate.getHead(path),
    commit: async (input) => {
      events.push('git:commit');
      if (options.rejectEffect === 'commit') throw new Error('commit rejected');
      return delegate.commit(input);
    },
    push: async (input) => {
      events.push('git:push');
      if (options.pushGate) {
        events.push('effect:push-deferred');
        await options.pushGate;
      }
      if (options.rejectEffect === 'push') throw new Error('push rejected');
      return delegate.push(input);
    },
  };
}

function configFixture(): AgentAutoConfigV1 {
  const label = (name: string) => ({ name, color: 'ededed', description: `${name} label` });
  return {
    schema: 'codex-orchestrator.agent-auto',
    version: 1,
    github: {
      owner: 'owner', repo: 'repo', baseBranch: 'main',
      labels: { auto: label('agent:auto'), running: label('agent:running'), blocked: label('agent:blocked'), review: label('agent:review') },
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
