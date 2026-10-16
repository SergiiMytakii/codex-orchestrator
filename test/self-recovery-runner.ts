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
      if (run.proofReceipt && run.lifecycle !== 'publishing' && !run.terminalOutcome) await pause('proof');
      if (run.lifecycle === 'publishing' && run.directReview) await pause('review');
      if (run.terminalOutcome?.status === 'review-ready') await pause('publication');
      if (run.pendingEffect?.kind === 'issue-feedback-comment') await pause('before:answer-comment');
      if (run.activeAttempt?.operationId === 'acceptance-proof' && run.activeAttempt.stage === 'adopted') {
        if (run.proofExecution?.reportCorrection) await pause('proof:correction-persisted');
        else if (!run.proofReceipt) await pause('proof:result-adopted');
      }
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
      await input.onPrepared?.({ attemptId: input.attemptId, reportPath: join(root, 'reports', `${input.attemptId}.json`), preparedAt: new Date().toISOString(), baseline: await git.snapshot(input.worktreePath) });
      await input.onLaunched?.({ attemptId: input.attemptId, pid: process.pid, processGroupId: process.pid, launchedAt: new Date().toISOString() });
      if (scenario.mode === 'answer' && input.reviewFeedback?.length) {
        await event('answer-agent');
        return { kind: 'completed', attemptId: input.attemptId, report: { version: 1, status: 'answer-only', summary: 'Answered without a change.', changedFiles: [], residualRisks: [], response: 'The existing checked behavior is preserved.' } };
      }
      await event('implementation');
      await writeFile(join(input.worktreePath, 'feature.txt'), 'implemented\n');
      for (const id of Object.keys(config.checks)) await event(`worker-check:${id}`);
      return { kind: 'completed', attemptId: input.attemptId, report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [], checks: Object.entries(config.checks).map(([id, command]) => ({ id, command, status: 'passed', outputSha256: sha256('ok') })) } };
    } },
    proof: { proveChange: async (input) => {
      if (scenario.mode === 'malformed-proof') {
        const bytes = Buffer.from('{"version":1}');
        const diagnostic = 'missing proof fields';
        const malformed = { status: 'report-repair' as const, reportRepairCount: 1, findings: [diagnostic], reportCorrection: { bytes, sha256: sha256(bytes), diagnostic } };
        const artifact = join(input.materialization!.path, config.proof.artifactDir, 'scenario.txt');
        if (input.recoverOnly) {
          await event('proof-result-observation');
          const retained = (await store.read()).runs[0]!.activeAttempt;
          if (!retained || !('result' in retained) || !retained.result) throw new Error('original proof result identity was lost');
          const saved = await readFile(retained.result.path);
          if (sha256(saved) !== retained.result.sha256 || !saved.equals(Buffer.from(canonicalJson(malformed)))) throw new Error('original malformed result bytes changed');
          if ((await readFile(artifact, 'utf8')) !== 'original scenario evidence') throw new Error('original proof artifacts were lost');
          return malformed;
        }
        if (!input.reportCorrection) {
          await input.beforeAgentLaunch?.(); await input.onLaunched?.({ pid: process.pid, processGroupId: process.pid, launchedAt: new Date().toISOString() });
          await event('proof'); await event('proof-scenario');
          await mkdir(dirname(artifact), { recursive: true }); await writeFile(artifact, 'original scenario evidence');
          await event(`proof-materialization:${input.materialization!.path}`);
          await event(`proof-target:${canonicalJson(mint.verifyAndRead(input.checkedChange).payload)}`);
          await writeBound({ path: join(root, 'reports', `${input.attemptId}.json`), bytes: Buffer.from(canonicalJson(malformed)) });
          return malformed;
        }
        if (!input.reportCorrection.bytes.equals(bytes) || input.reportCorrection.sha256 !== sha256(bytes) || input.reportCorrection.diagnostic !== diagnostic) throw new Error('correction lost exact report bytes or diagnostic');
        if ((await readFile(artifact, 'utf8')) !== 'original scenario evidence') throw new Error('report correction lost original proof artifacts');
        await input.beforeAgentLaunch?.(); await input.onLaunched?.({ pid: process.pid, processGroupId: process.pid, launchedAt: new Date().toISOString() });
        await event('proof-correction'); await event(`correction-materialization:${input.materialization!.path}`);
        return { status: 'passed', receipt: { proofId: input.proofId, bindingSha256: 'c'.repeat(64), summary: 'passed', publishableEvidence: [], localEvidenceId: `proof:${input.proofId}` } };
      }
      await input.beforeAgentLaunch?.(); await input.onLaunched?.({ pid: process.pid, processGroupId: process.pid, launchedAt: new Date().toISOString() }); await event('proof');
      await event(`proof-target:${canonicalJson(mint.verifyAndRead(input.checkedChange).payload)}`);
      if (scenario.mode === 'blocked') return { status: 'external-block', blocker: { kind: 'service', summary: 'Unavailable test service.', attempted: ['Observe service.'], resumable: false }, receipt: { proofId: input.proofId, bindingSha256: 'c'.repeat(64), summary: 'service unavailable', publishableEvidence: [], localEvidenceId: `proof:${input.proofId}` } };
      return { status: 'passed', receipt: { proofId: input.proofId, bindingSha256: 'c'.repeat(64), summary: 'passed', publishableEvidence: [], localEvidenceId: `proof:${input.proofId}` } };
    } },
    implementationReviewer: { run: async (input) => {
      const invocation = { attemptId: input.attemptId, operation: input.operation, reviewerSessionId: input.reviewerSessionId, targetRevision: input.targetRevision, targetFingerprint: input.targetFingerprint };
      await input.onPrepared({ ...invocation, validationContext: { operation: input.operation, targetRevision: input.targetRevision, targetFingerprint: input.targetFingerprint, reviewerSessionId: input.reviewerSessionId, availableReviewers: ['spec_reviewer', 'standards_reviewer'], requiredCoverage: input.reviewFocus, previousFindingIds: [], requireAllReviewers: true, requireReviewerEvidence: true } });
      await input.onLaunched({ ...invocation, pid: process.pid, processGroupId: process.pid }); await event('review');
      await event(`review-target:${input.currentTreeSha}`);
      return { kind: 'completed', attemptId: input.attemptId, artifactSha256: '8'.repeat(64), report: { version: 1, operation: input.operation, targetRevision: input.targetRevision, targetFingerprint: input.targetFingerprint, verdict: 'approved', coverage: input.reviewFocus, defects: [], residualRisks: [], reviewerSessionId: input.reviewerSessionId, reviewers: [{ role: 'spec_reviewer', sessionId: `${input.reviewerSessionId}:spec`, verdict: 'approve' }, { role: 'standards_reviewer', sessionId: `${input.reviewerSessionId}:standards`, verdict: 'approve' }] } };
    } },
    checkedChangeMint: mint, runRecords: traced,
    writeEvidence: async (entry) => { const path = join(root, 'evidence', `${entry.runId}-${entry.code}.json`); await writeBound({ path, bytes: Buffer.from(canonicalJson(entry)) }); return { id: entry.code, path }; },
    outcomeEvidencePath: (runId, code, hash) => `evidence/${runId}/${sha256(code)}-${hash}.json`,
    inspectOutcomeEvidence: async (path) => { const result = await exists(resolve(root, path)); return result && { sha256: result.sha256 }; },
    writeOutcomeEvidence: (input) => writeBound({ ...input, path: resolve(root, input.path) }),
    packageVersion: '0.1.51',
    createWorkflowGeneration: async () => ({ receipt: { generationHash: '1'.repeat(64), manifestSha256: 'e'.repeat(64), packageVersion: '0.1.51', generationRoot: join(root, 'workflow'), contentSha256: 'f'.repeat(64) }, skillHashes: { 'agent-auto': 'a'.repeat(64), 'acceptance-proof': 'b'.repeat(64) } }),
    verifyWorkflowGeneration: async () => {}, createRunId: randomUUID, createProofId: () => 'proof-1', createReviewSessionId: () => 'review-session-1', now: () => new Date().toISOString(),
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
