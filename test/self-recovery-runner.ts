import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RunIssue, type RunIssueDependencies, type RunIssueGit } from '../src/v2/run-issue.js';
import { FileRunRecordWriter, type RunRecordWriter } from '../src/v2/run-store.js';
import { LocalGitRunIssueAdapter } from '../src/v2/runtime.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import { createCheckedChangeCapabilities } from '../src/v2/checked-change.js';
import { acquireOwnerControlLock, inspectProcessIdentity, readProcessStartIdentity } from '../src/v2/owner-control-lock.js';
import { captureProcessStartIdentity, observeProcessGroup, observeProcessIdentity } from '../src/v2/process-identity.js';
import { createFrozenReviewFeedbackBatch, hashReviewFeedbackSnapshot, hashReviewFeedbackText } from '../src/v2/review-feedback.js';
import type { ReviewFeedbackObserver } from '../src/v2/review-feedback-coordinator.js';
import type { AgentAutoConfig } from '../src/v2/config.js';

export function recoveryConfig(): AgentAutoConfig {
  const label = (name: string) => ({ name, color: 'ededed', description: name });
  return {
    schema: 'codex-orchestrator.agent-auto', version: 2,
    github: { owner: 'owner', repo: 'repo', baseBranch: 'main', labels: { auto: label('agent:auto'), running: label('agent:running'), blocked: label('agent:blocked'), review: label('agent:review') } },
    runner: { workspaceRoot: '.worktrees', stateDir: '.codex-orchestrator/state', branchTemplate: 'codex/issue-${issueNumber}', pollIntervalSeconds: 60 },
    codex: { command: 'codex', timeoutMs: 1000, idleTimeoutMs: 500, toolNetwork: 'deny' },
    checks: { first: 'first', second: 'second' }, proof: { artifactDir: '.codex-orchestrator/proofs' }, deny: { readPaths: [], commands: [] },
  };
}

export const recoveryStatePath = (root: string) => join(root, '.codex-orchestrator/state/run-state.json');
export const recoveryStore = (root: string) => FileRunRecordWriter.forRepository(recoveryStatePath(root), 'owner/repo').forIssue(42);

async function executeWorker(root: string, checkpoint: string) {
  const scenario = JSON.parse(await readFile(join(root, 'scenario.json'), 'utf8').catch(() => '{}')) as { mode?: 'blocked' | 'answer' | 'malformed-proof' };
  const config = recoveryConfig();
  const configBytes = Buffer.from(canonicalJson(config));
  const home = join(root, 'owner-home');
  const host = hostname();
  const bootId = 'restart-test-same-boot';
  const store = FileRunRecordWriter.forRepository(recoveryStatePath(root), 'owner/repo', {
    host, bootId, processStartIdentity: await readProcessStartIdentity(process.pid), exclusiveRepositoryOwnership: true,
    inspectProcessIdentity: async (pid) => { const result = await inspectProcessIdentity(pid); return result.status === 'present' ? { processStartIdentity: result.processStartIdentity } : result.status; },
  }).forIssue(42);
  const event = (name: string) => appendFile(join(root, 'events.jsonl'), `${JSON.stringify(name)}\n`);
  let paused = false;
  const pause = async (name: string) => {
    if (name !== checkpoint || paused) return;
    paused = true;
    process.send?.({ checkpoint: name });
    await new Promise<void>(() => { setInterval(() => {}, 1000); });
  };
  const traced: RunRecordWriter = {
    inspect: () => store.inspect(), read: () => store.read(),
    compareAndSwap: async (generation, next) => {
      const saved = await store.compareAndSwap(generation, next);
      const run = saved.runs.at(-1)!;
      if (run.lifecycle === 'checking' && run.candidateBinding && run.checks.length === 0) await pause('implementation');
      if (run.checks.length === 2 && run.checks.every((check) => check.status === 'passed') && !run.proofReceipt) await pause('checks');
      if (run.proofReceipt && !run.terminalOutcome) await pause('proof');
      if (run.lifecycle === 'publishing' && run.implementationResult?.review) await pause('review');
      if (run.terminalOutcome?.status === 'review-ready') await pause('publication');
      if (run.pendingEffect?.kind === 'issue-feedback-comment') await pause('before:answer-comment');
      if (run.activeAttempt?.operationId === 'implementation' && run.activeAttempt.stage === 'observed') await pause('owner:result-observed');
      if (run.implementationReportCorrection && run.activeAttempt?.stage === 'adopted') await pause('owner:correction-persisted');
      return saved;
    },
  };
  type Remote = { state?: 'OPEN' | 'CLOSED'; labels: string[]; comments: Array<{ id: string; body: string; authorAssociation: string }>; pullRequest?: { url: string; body: string } };
  const remotePath = join(root, 'github.json');
  const remote = async (): Promise<Remote> => JSON.parse(await readFile(remotePath, 'utf8')) as Remote;
  const saveRemote = (value: Remote) => writeFile(remotePath, canonicalJson(value));
  const local = new LocalGitRunIssueAdapter(undefined, root);
  const git = Object.create(local) as RunIssueGit;
  git.candidateV2 = { ...local.candidateV2,
    createOrObserveCommit: async (input) => {
      const result = await local.candidateV2.createOrObserveCommit(input);
      if (!input.observeOnly && result.kind === 'ok' && result.value.kind === 'created-or-observed') { await event('commit'); await pause('effect:commit'); }
      return result;
    },
  };
  git.push = async (input) => { await local.push(input); await event('push'); await pause('effect:push'); };
  const mint = createCheckedChangeCapabilities();
  const exists = async (path: string) => { try { const bytes = await readFile(path); return { bytes, sha256: sha256(bytes) }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } };
  const writeBound = async ({ path, bytes }: { path: string; bytes: Buffer }) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); };
  const dependencies: RunIssueDependencies = {
    readConfig: async () => ({ bytes: configBytes, config }),
    ownerLock: { acquire: ({ canonicalRepository }) => acquireOwnerControlLock({ orchestratorHome: home, canonicalRepository, bootId, host, pid: process.pid, now: () => new Date().toISOString(), createToken: randomUUID, processAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } }) },
    issues: {
      read: async () => ({ number: 42, title: 'Restart behavior', body: '## Acceptance Criteria\n- The behavior works.', url: 'https://example.invalid/issues/42', state: 'OPEN', ...await remote() }),
      setLabels: async (_issue, labels) => { const value = await remote(); value.labels = labels; await saveRemote(value); await event(labels.includes('agent:running') ? 'claim-labels' : 'terminal-labels'); await pause('effect:claim-labels'); },
      reconcileTerminalLabels: async (_issue, policy) => { const value = await remote(); value.labels = [...new Set([...value.labels.filter((label) => !policy.remove.includes(label)), ...policy.add])]; await saveRemote(value); await event('terminal-labels'); await pause('effect:terminal-labels'); },
      postComment: async (_issue, body) => { const value = await remote(); value.comments.push({ id: `comment-${value.comments.length + 1}`, body, authorAssociation: 'OWNER' }); await saveRemote(value); const claim = body.split('\n')[0]!.endsWith(':claim -->'); const answer = body.split('\n')[0]!.includes(':issue-feedback:'); await event(claim ? 'claim-comment' : answer ? 'answer-comment' : 'terminal-comment'); await pause(claim ? 'effect:claim-comment' : answer ? 'effect:answer-comment' : 'effect:terminal-comment'); },
    },
    pullRequests: {
      findOpen: async () => {
        const observed = (await remote()).pullRequest;
        if (!observed || scenario.mode !== 'answer') return observed;
        const run = (await store.read()).runs[0]!;
        return { ...observed, number: 1, nodeId: 'PR_1', headSha: (await git.getRemoteBranchSha(run.worktreePath, run.branchName))!, headRefName: run.branchName, baseRefName: 'main' };
      },
      createDraft: async ({ body }) => { const value = await remote(); value.pullRequest = { url: 'https://example.invalid/pull/1', body }; await saveRemote(value); await event('pr'); await pause('effect:pr'); return { url: value.pullRequest.url }; },
    },
    git,
    implementationAgent: { run: async (input) => {
      const retained = (await store.read()).runs[0]?.activeAttempt;
      if (retained?.stage === 'observed' && retained.result) {
        const bytes = await readFile(retained.result.path);
        if (sha256(bytes) !== retained.result.sha256) throw new Error('retained owner result changed');
        return { kind: 'completed', attemptId: input.attemptId, report: JSON.parse(bytes.toString('utf8')) };
      }
      await input.onPrepared?.({ attemptId: input.attemptId, reportPath: join(root, 'reports', `${input.attemptId}.json`), preparedAt: new Date().toISOString(), baseline: await git.snapshot(input.worktreePath) });
      await input.onLaunched?.({ attemptId: input.attemptId, pid: process.pid, processGroupId: process.pid, launchedAt: new Date().toISOString() });
      await input.onSessionStarted?.(input.sessionId ?? '01000000-0000-4000-8000-000000000001');
      if (scenario.mode === 'answer' && input.reviewFeedback?.length) {
        await event('answer-agent');
        return { kind: 'completed', attemptId: input.attemptId, report: { version: 1, status: 'answer-only', summary: 'Answered without a change.', changedFiles: [], residualRisks: [], response: 'The existing checked behavior is preserved.' } };
      }
      if (input.reportCorrection) {
        if (!input.sessionId || sha256(input.reportCorrection.bytes) !== input.reportCorrection.sha256) throw new Error('owner correction lost exact report or native session');
        await event('owner-correction');
      } else await event('implementation');
      await writeFile(join(input.worktreePath, 'feature.txt'), 'implemented\n');
      for (const id of Object.keys(config.checks)) await event(`worker-check:${id}`);
      if (scenario.mode === 'blocked') return { kind: 'completed', report: { version: 1, status: 'external-block', summary: 'Unavailable test service.', changedFiles: ['feature.txt'], residualRisks: [], blocker: { kind: 'service', summary: 'Unavailable test service.', attempted: ['Observe service.'], resumable: false } } };
      const source = await git.snapshot(input.worktreePath);
      await event('proof'); await event('review');
      if (scenario.mode === 'malformed-proof' && !input.reportCorrection) {
        await event('owner-malformed-report');
        const report = { version: 1, status: 'completed', summary: 'malformed owner proof', changedFiles: ['feature.txt'], residualRisks: [], checks: Object.entries(config.checks).map(([id, command]) => ({ id, command, status: 'passed', outputSha256: sha256('ok') })) };
        await writeBound({ path: join(root, 'reports', `${input.attemptId}.json`), bytes: Buffer.from(canonicalJson(report)) });
        return { kind: 'completed', report };
      }
      const checks = Object.entries(config.checks).map(([id, command]) => ({ id, command, status: 'passed' as const, outputSha256: sha256('ok') }));
      return { kind: 'completed', attemptId: input.attemptId, report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [], checks,
        proof: { version: 1, status: 'passed', decision: { mode: 'non-visual', targets: [] },
          criteria: input.frozenCriteria.map(c => ({ id: c.id, status: 'passed', confidence: 'high', surfaces: ['non-visual'], evidenceRefs: [checks[0]!.id], analysis: 'The requested public behavior passes.' })),
          checks: [], artifacts: [], findings: [], residualRisks: [] },
        review: { summary: 'Independent reviewers approved the final source.', trackedContentSha256: source.trackedContentSha256,
          untrackedContentSha256: source.untrackedContentSha256,
          coverage: ['candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability', 'repository-standards', 'requirements', 'tests', 'zero-legacy'],
          reviewers: [{ role: 'spec_reviewer', sessionId: '01000000-0000-4000-8000-000000000002', verdict: 'approve' },
            { role: 'standards_reviewer', sessionId: '01000000-0000-4000-8000-000000000003', verdict: 'approve' }] } } };
    } },
    proof: { admitReport: async (input) => {
      await event('proof-admission');
      await event(`proof-target:${canonicalJson(mint.verifyAndRead(input.checkedChange).payload)}`);
      return { status: 'passed', receipt: { proofId: input.proofId, bindingSha256: 'c'.repeat(64), summary: 'passed', publishableEvidence: [], localEvidenceId: `proof:${input.proofId}` } };
    } },
    checkedChangeMint: mint, runRecords: traced,
    writeEvidence: async (entry) => { const path = join(root, 'evidence', `${entry.runId}-${entry.code}.json`); await writeBound({ path, bytes: Buffer.from(canonicalJson(entry)) }); return { id: entry.code, path }; },
    outcomeEvidencePath: (runId, code, hash) => `evidence/${runId}/${sha256(code)}-${hash}.json`,
    inspectOutcomeEvidence: async (path) => { const result = await exists(resolve(root, path)); return result && { sha256: result.sha256 }; },
    writeOutcomeEvidence: (input) => writeBound({ ...input, path: resolve(root, input.path) }),
    packageVersion: '0.1.51',
    createWorkflowGeneration: async () => ({ receipt: { generationHash: '1'.repeat(64), manifestSha256: 'e'.repeat(64), packageVersion: '0.1.51', generationRoot: join(root, 'workflow'), contentSha256: 'f'.repeat(64) }, skillHashes: { 'agent-auto': 'a'.repeat(64), 'acceptance-proof': 'b'.repeat(64) } }),
    verifyWorkflowGeneration: async () => {}, createRunId: randomUUID, createProofId: () => 'proof-1', now: () => new Date().toISOString(),
    processIdentity: { host, bootId,
      capture: async (pid, processGroupId) => { const result = await captureProcessStartIdentity({ platform: process.platform, pid, processGroupId }); return result.status === 'available' ? result.identity : undefined; },
      observe: async (processInfo) => ({ leader: await observeProcessIdentity({ platform: process.platform, ...processInfo }), group: observeProcessGroup(processInfo.processGroupId) }),
    },
    inspectAttemptResult: exists, observeAttemptCleanup: async () => 'confirmed', writeAttemptResult: writeBound, attemptResultPath: ({ attemptId }) => join(root, 'reports', `${attemptId}.json`),
  };
  if (scenario.mode === 'answer') {
    const old = (await store.read()).runs[0]!;
    const head = old.reviewFeedback!.previousPublishedHeadSha!;
    const body = 'Why does this preserve the existing behavior?';
    const sourceId = 'issue-comment:90071992547409939999';
    const batch = createFrozenReviewFeedbackBatch({
      runId: old.runId, canonicalRepository: old.canonicalRepository,
      pullRequest: { nodeId: 'PR_1', number: 1, headSha: head, headRefName: old.branchName, baseRefName: 'main', marker: `<!-- codex-orchestrator:run:${old.runId}:pr -->` },
      priorPublishedHeadSha: head, frozenAt: '2026-10-12T12:01:01.000Z',
      sources: [{ sourceId, kind: 'issue-comment', sourceUrl: 'https://github.com/owner/repo/issues/42#issuecomment-90071992547409939999',
        path: null, line: null, body, bodySha256: hashReviewFeedbackText(body), snapshotSha256: hashReviewFeedbackSnapshot({ sourceId, body }),
        threadState: null, commitSha: head, sourceCreatedAt: '2026-10-12T12:01:00.000Z', sourceUpdatedAt: '2026-10-12T12:01:00.000Z',
        author: { login: 'writer', userId: '42' }, permission: { permission: 'write', userId: '42', checkedAt: '2026-10-12T12:01:01.000Z' },
      }],
    });
    dependencies.reviewFeedback = {
      observeAndFreeze: async () => {
        const current = (await store.read()).runs[0]!;
        return current.reviewFeedback?.consumedSourceIds.includes(sourceId) ? { status: 'none', observedHeadSha: head, eligibleSourceIds: [] } : { status: 'frozen', batch };
      },
      revalidate: async () => {
        const current = await remote();
        return current.comments.some((comment) => comment.id === '90071992547409939999' && comment.body === body && comment.authorAssociation === 'OWNER')
          ? { status: 'valid', observedHeadSha: head } : { status: 'blocked', reason: 'source changed' };
      },
    } as unknown as ReviewFeedbackObserver;
  }
  const result = await new RunIssue(dependencies).runIssue({ targetRoot: root, issueNumber: 42 });
  process.send?.({ result });
}

if (process.argv[2] === '--worker') executeWorker(process.argv[3]!, process.argv[4] ?? '').catch((error) => { console.error(error); process.exitCode = 1; });
