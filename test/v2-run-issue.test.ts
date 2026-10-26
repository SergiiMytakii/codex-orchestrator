import { runConfiguredChecks } from '../src/v2/runner-checks.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { promisify } from 'node:util';

import type { CheckedChange, CheckedChangePayload, CheckedChangePayloadV1, CheckedChangePayloadV2 } from '../src/v2/checked-change.js';
import { createCheckedChangeCapabilities } from '../src/v2/checked-change.js';
import type { AgentAutoConfig } from '../src/v2/config.js';
import { canonicalJson, containsCredentialEvidence, containsHostIdentityEvidence, sha256 } from '../src/v2/containment.js';
import type { DeliveryAuthority } from '../src/v2/delivery-authority.js';
import { type ProveChangeResult } from '../src/v2/acceptance-proof.js';
import {
  RunIssue,
  OwnerLockContentionError,
  type ImplementationAgentResult,
  type RunIssueDependencies,
  type RunIssueGit,
  type RunIssueResult,
} from '../src/v2/run-issue.js';
import {
  createPendingEffect,
  FileRunRecordWriter,
  InMemoryRunRecordWriter,
  WorkflowGenerationUnrecoverableError,
  type RunRecordWriter,
  type RunStateInspection,
} from '../src/v2/run-store.js';
import { hasGitHubReauthorization, LocalGitRunIssueAdapter } from '../src/v2/runtime.js';
import { runNeedsDaemonTick } from '../src/v2/cli.js';
import { decodeAgentReportForValidation } from '../src/v2/report-envelope.js';
import { createFrozenReviewFeedbackBatch, createReviewFeedbackRunData, hashReviewFeedbackSnapshot, hashReviewFeedbackText } from '../src/v2/review-feedback.js';
import type { ReviewFeedbackObserver } from '../src/v2/review-feedback-coordinator.js';
import { mkdtemp } from './mission-test-temp.js';

const execFileAsync = promisify(execFile);

test('host checks run before proof and resume the same owner with trusted receipts', async () => {
  const fixture = await runFixture({ hostChecks: true, configuredChecks: { test: 'printf host-passed' },
    implementationResults: [{ kind: 'completed', report: { version: 1, status: 'checks-request',
      summary: 'Source ready', changedFiles: ['feature.txt'], residualRisks: [] } }] });
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  assert.equal((await fixture.runner.runIssue(input)).status, 'transport-failed');
  const requested = (await fixture.store.read()).runs[0]!;
  assert.equal(requested.runnerChecks?.status, 'complete');
  assert.equal(requested.runnerChecks?.results[0]?.exitCode, 0);
  assert.equal(await readFile(requested.runnerChecks!.results[0]!.logPath, 'utf8'), 'host-passed');
  assert.equal(fixture.events.includes('proof:admission'), false);
  assert.equal(fixture.events.includes('git:push'), false);
  assert.equal((await fixture.runner.runIssue(input)).status, 'review-ready');
  assert.deepEqual((await fixture.store.read()).runs[0]!.codexSession, requested.codexSession);
});

for (const wrongBase of [false, true]) {
  test(`host completion ${wrongBase ? 'rejects stale' : 'admits confirmed unrelated'} Flutter baseline evidence`, async () => {
    const fixture = await runFixture({ hostChecks: true, configuredChecks: { test: 'flutter test --no-pub' },
      implementationResults: [{ kind: 'completed', report: { version: 1, status: 'checks-request',
        summary: 'Source ready', changedFiles: ['feature.txt'], residualRisks: [] } }] });
    fixture.dependencies.configuredChecks!.run = async input => [{ id: 'test', command: input.checks.test!,
      exitCode: 1, outputSha256: sha256('candidate failure'), logPath: '/private/candidate.log',
      baseline: { baseSha: wrongBase ? 'a'.repeat(40) : input.baseSha, logPath: '/private/base.log',
        outputSha256: sha256('baseline failure'), affectedTests: ['test/changed_test.dart'],
        failures: [{ test: 'test/unrelated_test.dart :: old failure', errorSha256: sha256('same failure') }] } }];
    const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
    assert.equal((await fixture.runner.runIssue(input)).status, 'transport-failed');
    assert.equal((await fixture.runner.runIssue(input)).status, wrongBase ? 'blocked' : 'review-ready');
    assert.equal(fixture.events.includes('git:push'), !wrongBase);
  });
}

test('host mode rejects worker-only receipts without trusted command execution', async () => {
  const fixture = await runFixture({ hostChecks: true });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'blocked');
  assert.ok('evidencePath' in result);
  assert.match(await readFile(resolve(fixture.targetRoot, result.evidencePath!), 'utf8'), /runner-checks-evidence-mismatch/);
  assert.equal(fixture.events.includes('git:push'), false);
});

for (const failure of ['failed-command', 'source-drift', 'policy-drift', 'forged-output', 'interrupted'] as const) {
  test(`host evidence rejects ${failure} before publication`, async () => {
    const fixture = await runFixture({ hostChecks: true, configuredChecks: { test: failure === 'failed-command' ? 'exit 9' : 'printf host-passed' },
      implementationResults: [{ kind: 'completed', report: { version: 1, status: 'checks-request', summary: 'Check source', changedFiles: ['feature.txt'], residualRisks: [] } }] });
    const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
    assert.equal((await fixture.runner.runIssue(input)).status, 'transport-failed');
    if (failure === 'source-drift') {
      fixture.options.agentWrites = false;
      await writeFile(join(fixture.worktreePath, 'feature.txt'), 'source changed after host checks');
    }
    if (failure === 'policy-drift') (await fixture.dependencies.readConfig(fixture.targetRoot)).config.checks.test = 'printf different-policy';
    if (failure === 'forged-output') {
      const implement = fixture.dependencies.implementationAgent.run;
      fixture.dependencies.implementationAgent.run = async request => {
        const r = await implement(request);
        if (r.kind === 'completed') (r.report as any).checks[0].outputSha256 = sha256('invented output');
        return r;
      };
    }
    if (failure === 'interrupted') {
      const state = await fixture.store.read();
      state.runs[0]!.runnerChecks = { ...state.runs[0]!.runnerChecks!, status: 'pending', results: [] };
      await fixture.store.compareAndSwap(state.generation, { schema: state.schema, runs: state.runs });
      fixture.dependencies.configuredChecks!.run = async () => { throw new Error('must never replay interrupted host action'); };
    }
    assert.equal((await fixture.runner.runIssue(input)).status, 'blocked');
    assert.equal(fixture.events.includes('proof:admission'), false);
    assert.equal(fixture.events.includes('git:push'), false);
  });
}

test('explicit host check request can retry unchanged source after environment repair', async () => {
  const request = { kind: 'completed' as const, report: { version: 1, status: 'checks-request', summary: 'Check source', changedFiles: ['feature.txt'], residualRisks: [] } };
  const fixture = await runFixture({ hostChecks: true, configuredChecks: { test: 'test -f ../environment-ready' },
    implementationResults: [structuredClone(request), structuredClone(request)] });
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  await fixture.runner.runIssue(input);
  const first = (await fixture.store.read()).runs[0]!.runnerChecks!;
  assert.equal(first.results[0]!.exitCode, 1);
  await writeFile(join(dirname(fixture.worktreePath), 'environment-ready'), 'ready');
  await fixture.runner.runIssue(input);
  const second = (await fixture.store.read()).runs[0]!.runnerChecks!;
  assert.equal(second.sourceSha256, first.sourceSha256);
  assert.equal(second.results[0]!.exitCode, 0);
  assert.equal((await fixture.runner.runIssue(input)).status, 'review-ready');
});

test('corrected host request clears report-only recovery before proof and Review', async () => {
  const request = { kind: 'completed' as const, report: { version: 1, status: 'checks-request', summary: 'Source ready', changedFiles: ['feature.txt'], residualRisks: [] } };
  const malformed = structuredClone(request) as any;
  delete malformed.report.residualRisks;
  const fixture = await runFixture({ hostChecks: true, configuredChecks: { test: 'printf passed' },
    implementationResults: [malformed, request] });
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  await fixture.runner.runIssue(input);
  assert.ok((await fixture.store.read()).runs[0]!.implementationReportCorrection);
  await fixture.runner.runIssue(input);
  assert.equal((await fixture.store.read()).runs[0]!.implementationReportCorrection, undefined);
  const implement = fixture.dependencies.implementationAgent.run;
  fixture.dependencies.implementationAgent.run = async request => {
    assert.equal(request.reportCorrection, undefined);
    return implement(request);
  };
  assert.equal((await fixture.runner.runIssue(input)).status, 'review-ready');
});

test('one Codex owner supplies checks, proof and independent Review before Runner publishes', async () => {
  const fixture = await runFixture();
  assert.equal(Object.hasOwn(fixture.dependencies, 'implementationReviewer'), false);
  assert.equal(Object.hasOwn(fixture.dependencies.proof, 'proveChange'), false);
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready', JSON.stringify({result,evidence:fixture.evidence,record:(await fixture.store.read()).runs[0]}));
  assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, 1);
  assert.equal(fixture.events.filter(event => event === 'proof:admission').length, 1);
  const record = (await fixture.store.read()).runs[0]!;
  assert.ok(record.codexSession);
  assert.ok(record.implementationResult?.proof);
  assert.equal(record.implementationResult?.review?.reviewers.length, 2);
});

test('native completion adopts the decoded report identity before nullable proof normalization', async () => {
  const fixture = await runFixture();
  const implement = fixture.dependencies.implementationAgent.run;
  fixture.dependencies.implementationAgent.run = async input => {
    const result = await implement(input);
    if (result.kind !== 'completed') return result;
    const report = structuredClone(result.report) as Record<string, any>;
    report.proof.visualEvidence = null;
    report.proof.blocker = null;
    const reportBytes = Buffer.from(JSON.stringify({ report }, null, 2) + '\n');
    await fixture.dependencies.writeAttemptResult({ path: fixture.dependencies.attemptResultPath({ canonicalRepository: 'owner/repo', runId: input.runId, attemptId: input.attemptId }), bytes: reportBytes, sha256: sha256(reportBytes) });
    return { ...result, report: decodeAgentReportForValidation(reportBytes), reportBytes };
  };
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready', JSON.stringify({ result, evidence: fixture.evidence }));
  const record = (await fixture.store.read()).runs[0]!;
  assert.equal(Object.hasOwn(record.implementationResult!.proof!, 'visualEvidence'), false);
  assert.equal(Object.hasOwn(record.implementationResult!.proof!, 'blocker'), false);
  assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, 1);
});

for (const interruption of ['launched', 'observed', 'observed-changed'] as const) {
  test(`native report recovery from ${interruption} preserves decoded identity and source binding`, async () => {
    const fixture = await runFixture({ fileBackedStore: true });
    const implement = fixture.dependencies.implementationAgent.run;
    const fingerprintDeniedPaths = fixture.dependencies.git.fingerprintDeniedPaths;
    let reportReturned = false;
    let interruptObserved = interruption !== 'launched';
    fixture.dependencies.git.fingerprintDeniedPaths = async (...args) => {
      if (reportReturned && interruptObserved) {
        interruptObserved = false;
        throw new Error('fixture interrupted after durable result observation');
      }
      return fingerprintDeniedPaths(...args);
    };
    fixture.dependencies.implementationAgent.run = async input => {
      const result = await implement(input);
      if (result.kind !== 'completed') return result;
      const report = structuredClone(result.report) as Record<string, any>;
      report.proof.visualEvidence = null;
      report.proof.blocker = null;
      const reportBytes = Buffer.from(JSON.stringify({ report }, null, 2) + '\n');
      await fixture.dependencies.writeAttemptResult({ path: fixture.dependencies.attemptResultPath({ canonicalRepository: 'owner/repo', runId: input.runId, attemptId: input.attemptId }), bytes: reportBytes, sha256: sha256(reportBytes) });
      reportReturned = true;
      return interruption === 'launched' ? { kind: 'safe-halt' } : { ...result, report: decodeAgentReportForValidation(reportBytes), reportBytes };
    };
    const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
    assert.equal((await fixture.runner.runIssue(input)).status, 'transport-failed');
    const interrupted = (await fixture.store.read()).runs[0]!;
    assert.equal(interrupted.activeAttempt?.stage, interruption === 'launched' ? 'launched' : 'observed');
    assert.equal(fixture.events.includes('git:push'), false);
    const resultPath = interrupted.activeAttempt!.resultPath;
    const originalBytes = await readFile(resultPath);
    if (interruption === 'observed-changed') {
      const envelope = JSON.parse(originalBytes.toString('utf8'));
      envelope.report.summary = 'changed after durable observation';
      await writeFile(resultPath, JSON.stringify(envelope, null, 2) + '\n');
    }
    let recoveredReports = 0;
    fixture.dependencies.implementationAgent.run = async recovery => {
      recoveredReports += 1;
      assert.equal(recovery.attemptId, interrupted.activeAttempt!.attemptId);
      assert.equal(recovery.sessionId, interrupted.codexSession?.id);
      const reportBytes = await readFile(resultPath);
      return { kind: 'completed', attemptId: recovery.attemptId, report: decodeAgentReportForValidation(reportBytes), reportBytes };
    };
    const result = await new RunIssue(fixture.dependencies).runIssue(input);
    const record = (await fixture.store.read()).runs[0]!;
    assert.equal(recoveredReports, 1);
    assert.deepEqual(record.codexSession, interrupted.codexSession);
    assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, 1, 'recovery reads the retained native report without launching another owner');
    if (interruption === 'observed-changed') {
      assert.equal(result.status, 'transport-failed');
      assert.ok(fixture.evidence.some(entry => entry.summary.includes('observed active attempt result identity mismatch')));
      assert.equal(fixture.events.includes('git:push'), false);
      assert.equal(record.activeAttempt?.stage, 'observed');
    } else {
      assert.equal(result.status, 'review-ready', JSON.stringify({ result, evidence: fixture.evidence }));
      assert.equal(Object.hasOwn(record.implementationResult!.proof!, 'visualEvidence'), false);
      assert.equal(Object.hasOwn(record.implementationResult!.proof!, 'blocker'), false);
      assert.deepEqual(await readFile(resultPath), originalBytes, 'validation must preserve the exact native report artifact');
    }
  });
}

for (const malformed of [
  { name: 'empty', bytes: Buffer.alloc(0) },
  { name: 'invalid JSON', bytes: Buffer.from('{"report":') },
  { name: 'invalid decoded report', bytes: Buffer.from('{\n  "report": { "version": 1 }\n}\n') },
]) {
  test(`native launched recovery retains exact ${malformed.name} bytes for report correction`, async () => {
    const fixture = await runFixture();
    const implement = fixture.dependencies.implementationAgent.run;
    fixture.dependencies.implementationAgent.run = async input => {
      await implement(input);
      await fixture.dependencies.writeAttemptResult({ path: fixture.dependencies.attemptResultPath({ canonicalRepository: 'owner/repo', runId: input.runId, attemptId: input.attemptId }), bytes: malformed.bytes, sha256: sha256(malformed.bytes) });
      return { kind: 'safe-halt' };
    };
    const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
    assert.equal((await fixture.runner.runIssue(input)).status, 'transport-failed');
    const interrupted = (await fixture.store.read()).runs[0]!;
    fixture.dependencies.implementationAgent.run = async recovery => {
      assert.equal(recovery.attemptId, interrupted.activeAttempt!.attemptId);
      const reportBytes = await readFile(interrupted.activeAttempt!.resultPath);
      return { kind: 'completed', attemptId: recovery.attemptId, report: decodeAgentReportForValidation(reportBytes), reportBytes };
    };
    assert.equal((await new RunIssue(fixture.dependencies).runIssue(input)).status, 'transport-failed');
    const retained = (await fixture.store.read()).runs[0]!;
    assert.ok(retained.implementationReportCorrection, JSON.stringify(fixture.evidence));
    assert.equal(retained.implementationReportCorrection.sha256, sha256(malformed.bytes));
    assert.deepEqual(await readFile(retained.implementationReportCorrection.path), malformed.bytes);
    assert.ok(fixture.evidence.some(entry => entry.code === 'implementation-report-retryable'));
    assert.equal(fixture.events.includes('git:push'), false);
    assert.deepEqual(retained.codexSession, interrupted.codexSession);
  });
}

test('recoverable tool and service failures continue the same owner without relabeling or a new cycle', async () => {
  for (const kind of ['tool', 'service'] as const) {
    const blocker = {
      kind, summary: 'Local browser proof is unavailable.',
      attempted: ['Start the isolated local browser'], resumable: true,
    };
    const fixture = await runFixture({ fileBackedStore: true, implementationResults: [{ kind: 'completed', report: {
      version: 1, status: 'external-block', summary: blocker.summary, changedFiles: [], residualRisks: [], blocker,
    } }] });
    const stopped = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(stopped, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
    const before = (await fixture.store.read()).runs[0]!;
    assert.equal(runNeedsDaemonTick(before), true);
    assert.equal(before.terminalOutcome, undefined);
    assert.equal(before.activeAttempt, undefined);
    assert.ok(fixture.evidence.some(e => e.code === 'implementation-environment-retryable' && e.summary.includes(blocker.summary)));
    assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:running']);
    assert.equal(fixture.events.includes('git:push'), false);
    const resumed = await new RunIssue(fixture.dependencies).runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(resumed.status, 'review-ready');
    const after = (await fixture.store.read()).runs[0]!;
    assert.equal(after.runId, before.runId);
    assert.equal(after.worktreePath, before.worktreePath);
    assert.equal(after.cycle, before.cycle);
    assert.deepEqual(after.codexSession, before.codexSession);
    assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, 2);
  }
});

test('a recoverable blocker accepted during report correction returns the owner to ordinary execution', async () => {
  const fixture = await runFixture({ implementationResults: [
    { kind: 'completed', report: { status: 'completed' } },
    { kind: 'completed', report: { version: 1, status: 'external-block', summary: 'Tool needs recovery',
      changedFiles: [], residualRisks: [], blocker: { kind: 'tool', summary: 'Tool needs recovery',
        attempted: ['Inspect the unavailable tool'], resumable: true } } },
  ] });
  const modes: boolean[] = [];
  const implement = fixture.dependencies.implementationAgent.run;
  fixture.dependencies.implementationAgent.run = async request => {
    modes.push(Boolean(request.reportCorrection));
    return implement(request);
  };
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  assert.equal((await fixture.runner.runIssue(input)).status, 'transport-failed');
  assert.equal((await fixture.runner.runIssue(input)).status, 'transport-failed');
  assert.equal((await fixture.runner.runIssue(input)).status, 'review-ready');
  assert.deepEqual(modes, [false, true, false]);
});

test('removing blocked while keeping auto resumes the same Run and session without a new label event', async () => {
  const fixture = await runFixture({ fileBackedStore: true, implementationResult: { kind: 'completed', report: {
    version: 1, status: 'external-block', summary: 'Local tool unavailable.', changedFiles: [], residualRisks: [],
    blocker: { kind: 'credential', summary: 'Local tool unavailable.', attempted: ['Start the tool'], resumable: true },
  } } });
  const config = (await fixture.dependencies.readConfig(fixture.targetRoot)).config;
  fixture.dependencies.outcomeEvidencePath = (runId, code, summarySha256) =>
    `${config.runner.stateDir}/v2/evidence/${runId}/${sha256(code)}-${summarySha256}.json`;
  fixture.dependencies.issues.isReauthorized = (record, issue) => hasGitHubReauthorization({
    targetRoot: fixture.targetRoot, config, record, issue,
  });
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  assert.equal((await fixture.runner.runIssue(input)).status, 'blocked');
  const before = (await fixture.store.read()).runs[0]!;
  const calls = fixture.events.filter(event => event === 'agent:implementation').length;
  assert.deepEqual((await fixture.dependencies.issues.read(42))?.labels, ['agent:auto', 'agent:blocked']);
  for (let tick = 0; tick < 2; tick++) assert.equal((await fixture.runner.runIssue(input)).status, 'blocked');
  assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, calls);

  await fixture.dependencies.issues.setLabels(42, ['agent:auto']);
  fixture.options.implementationResult = undefined;
  const result = await fixture.runner.runIssue(input);
  assert.equal(result.status, 'review-ready', JSON.stringify({ result, evidence: fixture.evidence }));
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.runId, before.runId);
  assert.equal(after.codexSession?.id, before.codexSession?.id);
  assert.equal(after.cycle, before.cycle + 1);
  assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, calls + 1);
});

test('unknown candidate ownership reports reconciliation failure before claim and preserves the candidate', async () => {
  const fixture = await runFixture();
  const ref = 'refs/codex-orchestrator/candidates/retained/unknown-owner';
  await execFileAsync('git', ['-C', fixture.targetRoot, 'update-ref', ref, 'HEAD']);

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.equal(result.status, 'transport-failed');
  const evidence = fixture.evidence.find(entry => entry.code === 'candidate-reconciliation-failed');
  assert.ok(evidence, JSON.stringify(fixture.evidence));
  assert.match(evidence.summary, /candidate-io-failed/u);
  assert.ok(evidence.summary.includes('5a34167c57c1e180ed95a5e0fdf577a8dbc6b921ded1a191fb2ae1a6d03f3a53'));
  assert.equal(fixture.evidence.some(entry => entry.code === 'issue-read-failed'), false);
  assert.equal((await fixture.store.read()).runs.length, 0);
  assert.equal(fixture.events.includes('agent'), false);
  assert.equal((await execFileAsync('git', ['-C', fixture.targetRoot, 'rev-parse', ref])).stdout,
    (await execFileAsync('git', ['-C', fixture.targetRoot, 'rev-parse', 'HEAD'])).stdout);
});

test('issue read failures retain the original transport reason before claim', async () => {
  const fixture = await runFixture();
  fixture.dependencies.issues.read = async () => {
    throw Object.assign(new Error('Failed to run gh: exit 1'), { stderr: 'HTTP 503: Service Unavailable' });
  };
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'transport-failed');
  assert.match(fixture.evidence.find(entry => entry.code === 'issue-read-failed')!.summary, /HTTP 503: Service Unavailable/u);
  assert.equal((await fixture.store.read()).runs.length, 0);
});

test('issue read diagnostics redact credentials instead of persisting stderr secrets', async () => {
  const fixture = await runFixture();
  fixture.dependencies.issues.read = async () => {
    throw Object.assign(new Error('gh failed'), { stderr: 'token=verysecretcredential123' });
  };
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const summary = fixture.evidence.find(entry => entry.code === 'issue-read-failed')!.summary;
  assert.match(summary, /redacted/u);
  assert.equal(summary.includes('verysecretcredential123'), false);
});

test('terminal cancellation labels do not revoke a fresh grant arriving during comment delivery', async () => {
  const fixture = await runFixture({ fileBackedStore: true, implementationResult: { kind: 'cancelled' } });
  let authorized = false;
  let authorizationChecks = 0;
  fixture.dependencies.issues.isReauthorized = async () => {
    authorizationChecks += 1;
    return authorized;
  };
  const postComment = fixture.dependencies.issues.postComment;
  fixture.dependencies.issues.postComment = async (issueNumber, body) => {
    const comment = await postComment(issueNumber, body);
    if (body.split('\n')[0]?.endsWith(':cancelled -->')) {
      authorized = true;
      await fixture.dependencies.issues.setLabels(issueNumber, ['agent:auto']);
    }
    return comment;
  };

  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.equal(result.status, 'cancelled');
  assert.equal(authorizationChecks, 1);
  assert.equal((await fixture.dependencies.issues.read(42))?.labels.includes('agent:auto'), true);
  assert.equal(fixture.events.filter(event => event === 'effect:terminal-labels').length, 1);
});

test('a fresh GitHub grant retains the Run and owner while refreshing candidate evidence', async () => {
  const fixture = await runFixture({ fileBackedStore: true, proof: async () => ({
    status: 'internal-error', receipt: { ...passedProof().receipt, summary: 'Proof artifact unavailable.' },
  }) });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'internal-error');
  const before = (await fixture.store.read()).runs[0]!;
  const implementations = fixture.events.filter(event => event === 'agent:implementation').length;
  await fixture.dependencies.issues.setLabels(42, ['agent:auto']);
  fixture.dependencies.issues.isReauthorized = async () => true;
  fixture.options.proof = async () => passedProof();
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready', JSON.stringify({ result, events: fixture.events }));
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.runId, before.runId);
  assert.equal(after.codexSession?.id, before.codexSession?.id);
  assert.equal(after.candidateBinding, undefined, 'published candidate pin is released');
  assert.ok((fixture.checkedChangePayloads.at(-1) as CheckedChangePayloadV2).binding);
  assert.equal(after.checks.length, before.checks.length);
  assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, implementations + 1);
});

test('a journal cancellation remains progress history without a fresh GitHub grant', async () => {
  const fixture = await runFixture({ implementationResult: { kind: 'cancelled' } });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'cancelled');
  const implementations = fixture.events.filter(event => event === 'agent:implementation').length;
  fixture.dependencies.issues.isReauthorized = async () => false;
  fixture.options.implementationResult = undefined;
  for (let tick = 0; tick < 2; tick++) assert.equal(
    (await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'cancelled');
  assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, implementations);
});

test('a fresh GitHub grant survives interrupted outcome evidence at both state boundaries', async () => {
  for (const failure of [
    { rejectStoreEvent: 'state:cancelled:outcome-evidence' },
    { rejectStoreTransition: { from: 'outcome-evidence', to: 'none' } },
  ] as const) {
    const fixture = await runFixture({ fileBackedStore: true, implementationResult: { kind: 'cancelled' }, ...failure });
    let grantId = '10';
    fixture.dependencies.issues.getAuthorizationGrantId = async () => grantId;
    fixture.dependencies.issues.isReauthorized = async (record) =>
      !!record.terminalOutcome && BigInt(grantId) > BigInt(record.terminalAuthorizationGrantId ?? '0');
    assert.ok(['cancelled', 'transport-failed'].includes(
      (await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status));
    const interrupted = (await fixture.store.read()).runs[0]!;
    assert.equal(interrupted.pendingEffect?.kind, 'outcome-evidence');
    const runId = interrupted.runId;
    grantId = '11';
    await fixture.dependencies.issues.setLabels(42, ['agent:auto']);
    fixture.options.implementationResult = undefined;
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, 'review-ready', JSON.stringify({ failure, result, events: fixture.events }));
    assert.equal((await fixture.store.read()).runs[0]!.runId, runId);
    assert.equal(fixture.events.filter(event => event === 'git:push').length, 1);
  }
});

test('a repeated terminal outcome after reauthorization receives a distinct immutable evidence path', async () => {
  const fixture = await runFixture({ fileBackedStore: true, implementationResult: { kind: 'cancelled' } });
  let now = Date.parse('2026-07-16T12:00:00.000Z');
  fixture.dependencies.now = () => new Date(now).toISOString();
  let grantId = '10';
  fixture.dependencies.issues.getAuthorizationGrantId = async () => grantId;
  fixture.dependencies.issues.isReauthorized = async record =>
    !!record.terminalOutcome && BigInt(grantId) > BigInt(record.terminalAuthorizationGrantId ?? '0');

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'cancelled');
  const first = (await fixture.store.read()).runs[0]!;
  const priorEvidencePath = first.terminalOutcome!.evidencePath;
  grantId = '11';
  now += 1_000;
  await fixture.dependencies.issues.setLabels(42, ['agent:auto']);

  const secondResult = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });

  assert.equal(secondResult.status, 'cancelled', JSON.stringify({ secondResult, record: (await fixture.store.read()).runs[0] }));
  const second = (await fixture.store.read()).runs[0]!;
  assert.notEqual(second.terminalOutcome!.evidencePath, priorEvidencePath);
  assert.equal(second.pendingEffect, undefined);
  assert.ok(await readFile(resolve(fixture.targetRoot, priorEvidencePath)));
  assert.ok(await readFile(resolve(fixture.targetRoot, second.terminalOutcome!.evidencePath)));
});

test('new run persists GitHub comments through claim without leaking transport metadata', async () => {
  const fixture = await runFixture({ fileBackedStore: true, initialComments: [{
    id: '6010397751', body: 'Historical discussion', authorAssociation: 'COLLABORATOR',
    createdAt: '2026-07-15T12:00:00.000Z', updatedAt: '2026-07-15T12:00:00.000Z',
    url: 'https://example.invalid/issues/42#issuecomment-6010397751',
    author: { login: 'owner', id: '123' },
  } as any] });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const saved = (await fixture.store.read()).runs[0]!.issueSnapshot.comments!.find(c => c.id === '6010397751');
  assert.deepEqual(saved, { id: '6010397751', body: 'Historical discussion', authorAssociation: 'COLLABORATOR',
    createdAt: '2026-07-15T12:00:00.000Z', updatedAt: '2026-07-15T12:00:00.000Z' });
});

test('Run retains proof failure diagnostics and existing candidate/workflow identity without launching Review or publication', async () => {
  const fixture = await runFixture({ proof: async () => ({
    status: 'internal-error', receipt: { ...passedProof().receipt, summary: 'Proof artifacts are invalid: proof artifact hash mismatch' },
  }) });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'internal-error');
  const diagnostic = fixture.evidence.find((entry) => entry.code === 'acceptance-proof-diagnostic');
  assert.ok(diagnostic);
  const detail = JSON.parse(diagnostic.summary);
  assert.match(detail.summary, /artifact hash mismatch/u);
  const record = (await fixture.store.read()).runs[0]!;
  assert.equal(detail.workflowGenerationHash, record.workflowGeneration.generationHash);
  assert.equal(detail.packageVersion, record.packageVersion);
  assert.equal(detail.candidateCommitSha, record.candidateBinding!.candidateCommitSha);
  assert.equal(record.proofReceipt, undefined, 'failure receipt cannot become passed proof authority');
  assert.equal(fixture.events.some((event) => event.startsWith('review:') || event === 'git:push' || event === 'effect:pr'), false);
  assert.equal((await execFileAsync('git', ['--git-dir', fixture.remoteRoot, 'for-each-ref', '--format=%(refname)', 'refs/heads/codex/issue-42'])).stdout.trim(), '');
});

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
      await onPrepared?.({ attemptId, reportPath: join(fixture.targetRoot, '.attempt-results', `${attemptId}-report.json`), preparedAt: '2026-07-16T12:10:02.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
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
  const candidate = fixture.dependencies.git.candidateV2!;
  const createOrObserveCommit = candidate.createOrObserveCommit;
  let committedWithDurableIntent = false;
  candidate.createOrObserveCommit = async input => {
    const record = (await fixture.store.read()).runs[0]!;
    assert.deepEqual(record.pendingEffect, createPendingEffect({
      kind: 'initial-commit', parentSha: input.parentSha, treeSha: input.treeSha,
      message: input.message, candidateRef: input.candidateRef,
    }));
    assert.equal(record.candidateBinding?.candidateTreeSha, input.treeSha);
    if (!input.observeOnly) committedWithDurableIntent = true;
    return createOrObserveCommit(input);
  };
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
    'worker:verification',
    'state:checking:none',
    'proof:admission',
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
  assert.equal(fixture.events.filter((event) => event === 'owner:independent-review').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'worker:verification').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'proof:admission').length, 1);
  assert.equal((await execFileAsync('git', ['-C', fixture.worktreePath, 'log', '-1', '--format=%an <%ae>'])).stdout.trim(), 'codex-orchestrator <codex-orchestrator@users.noreply.github.com>');
  assert.equal(committedWithDurableIntent, true);
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
    status: 'pending', attempts: 3, diagnostic: 'terminal-comment-delivery-unknown',
  });
  const attempts = fixture.events.filter((event) => event === 'effect:handoff-comment').length;
  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(fixture.events.filter((event) => event === 'effect:handoff-comment').length, attempts + 1);
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
    status: 'pending', attempts: 3, diagnostic: 'terminal-labels-delivery-unknown',
  });
  const attempts = fixture.events.filter((event) => event === 'effect:terminal-labels').length;
  await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(fixture.events.filter((event) => event === 'effect:terminal-labels').length, attempts + 1);
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
          await onPrepared?.({ attemptId, reportPath: join(fixture.targetRoot, '.attempt-results', `${attemptId}-report.json`), preparedAt: '2026-07-16T12:10:00.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
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

test('Issue Verification cannot replace mandatory configured checks on the final candidate', async () => {
  const body = [
    'Verification:',
    '- npm test -- --runInBand --runTestsByPath src/match-predictions/utils/prediction-evaluation-settlement.util.spec.ts src/match-predictions/utils/recent-prediction-performance.spec.ts',
    '- Extend public-function tests with a mixed cohort covering half outcomes, pushes, invalid settlements and missing reference odds; verify consistent denominators and unchanged precision.',
    '- Verify that missing reference odds remain excluded from Recent Performance while administrative aggregation retains its existing fallback.',
    '- npm run typecheck',
  ].join('\n');
  const configuredChecks = { typecheck: 'npm run typecheck', build: 'npm run build' };
  const fixture = await runFixture({ issueBody: body, configuredChecks });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const record = (await fixture.store.read()).runs[0]!;
  assert.deepEqual(record.checks.map(({ id, command }) => ({ id, command })), [
    { id: 'typecheck', command: 'npm run typecheck' },
    { id: 'build', command: 'npm run build' },
  ]);
  assert.equal(record.issueSnapshot.body, body);
  assert.equal(fixture.events.some(event => event.includes('issue-verification-')), false);
  assert.equal(fixture.events.filter(event => event === 'proof:admission').length, 1);
  assert.equal(fixture.events.filter(event => event === 'owner:independent-review').length, 1);
});

test('Issue Verification shell text cannot execute or block configured checks', async () => {
  const fixture = await runFixture({ issueBody: 'Verification:\n- npm exec -- sh -c owned\n## Verification\n- `broken Markdown' });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready');
  const record = (await fixture.store.read()).runs[0]!;
  assert.deepEqual(record.checks.map(({ id, command }) => ({ id, command })), [
    { id: 'typecheck', command: 'npm run typecheck' },
  ]);
  assert.equal(fixture.events.some(event => event.includes('issue-verification-')), false);
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

for (const fault of ['before-send', 'after-send', 'revoked-auto'] as const) {
  test(`issue feedback response keeps its durable intent through ${fault} delivery failure`, async () => {
    const fixture = await runFixture({ fileBackedStore: true });
    await prepareActiveIssueFeedback(fixture);
    const before = (await fixture.store.read()).runs[0]!;
    let answers = 0;
    fixture.dependencies.implementationAgent.run = async ({ attemptId, worktreePath, onPrepared, onLaunched }) => {
      answers += 1;
      await onPrepared?.({ attemptId, reportPath: join(fixture.targetRoot, '.attempt-results', `${attemptId}-report.json`), preparedAt: '2026-07-16T12:10:02.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
      await onLaunched?.({ attemptId, pid: 9191, processGroupId: 9191, launchedAt: '2026-07-16T12:10:03.000Z' });
      return { kind: 'completed', attemptId, report: { version: 1, status: 'answer-only', summary: 'Answer ready.', changedFiles: [], residualRisks: [], response: 'The exact answer.' } };
    };
    const post = fixture.dependencies.issues.postComment;
    let failures = fault === 'after-send' ? 1 : 4;
    fixture.dependencies.issues.postComment = async (issueNumber, body) => {
      if (body.includes(':issue-feedback:') && failures > 0) {
        failures -= 1;
        if (fault === 'after-send') await post(issueNumber, body);
        throw new Error('temporary response transport failure');
      }
      return post(issueNumber, body);
    };
    const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
    assert.equal((await fixture.runner.runIssue(input)).status, 'review-ready');
    const pending = (await fixture.store.read()).runs[0]!.pendingEffect;
    assert.equal(pending?.kind, 'issue-feedback-comment');
    if (fault === 'revoked-auto') {
      const read = fixture.dependencies.issues.read;
      fixture.dependencies.issues.read = async (number) => {
        const issue = await read(number);
        return issue ? { ...issue, labels: issue.labels.filter((label) => label !== 'agent:auto') } : issue;
      };
    }
    for (let tick = 0; tick < 5; tick += 1) assert.equal((await new RunIssue(fixture.dependencies).runIssue(input)).status, 'review-ready');
    const completed = (await fixture.store.read()).runs[0]!;
    assert.equal(completed.runId, before.runId);
    assert.equal(completed.pendingEffect, undefined);
    assert.equal(completed.reviewFeedback?.history.at(-1)?.kind, 'responded');
    const receipt = completed.reviewFeedback?.history.at(-1);
    if (receipt?.kind === 'responded') assert.equal(receipt.publication, fault === 'revoked-auto' ? 'suppressed' : 'delivered');
    assert.equal(fixture.comments.filter((comment) => comment.body.includes(':issue-feedback:')).length, fault === 'revoked-auto' ? 0 : 1);
    assert.equal(answers, 1);
    assert.equal(fixture.events.filter((event) => event === 'proof:admission').length, 1);
  });
}

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
      await onPrepared?.({ attemptId, reportPath: join(fixture.targetRoot, '.attempt-results', `${attemptId}-report.json`), preparedAt: '2026-07-16T12:10:02.000Z', baseline: await fixture.dependencies.git.snapshot(worktreePath) });
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

test('deferred proof prevents every later publication effect and terminal return', async () => {
  const proofGate = deferred<ReturnType<typeof passedProof>>();
  const fixture = await runFixture({
    proof: () => proofGate.promise,
  });
  const admissionEntered = deferred<void>();
  const admitReport = fixture.dependencies.proof.admitReport;
  fixture.dependencies.proof.admitReport = async input => {
    admissionEntered.resolve();
    return admitReport(input);
  };
  let settled = false;
  const running = fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }).finally(() => { settled = true; });
  try {
    await Promise.race([
      admissionEntered.promise,
      running.then(result => {
        throw new Error(`Runner settled before proof admission: ${JSON.stringify({ result, evidence: fixture.evidence, events: fixture.events })}`);
      }),
    ]);
    assert.equal(fixture.events.some((event) => event.startsWith('git:commit')), false);
    assert.equal(settled, false);
    proofGate.resolve(passedProof());
    const result = await running;
    assert.equal(result.status, 'review-ready', `${JSON.stringify(result)}\n${fixture.events.join('\n')}`);
  } finally {
    proofGate.resolve(passedProof());
    await running.catch(() => undefined);
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

test('malformed config stops while state I/O remains resumable before claim effects', async () => {
  const invalidConfig = await runFixture({ invalidConfig: true });
  assert.equal((await invalidConfig.runner.runIssue({ targetRoot: invalidConfig.targetRoot, issueNumber: 42 })).status, 'internal-error');
  assert.equal(invalidConfig.events.includes('effect:claim-labels'), false);

  const invalidState = await runFixture({ storeReadReject: true });
  assert.equal((await invalidState.runner.runIssue({ targetRoot: invalidState.targetRoot, issueNumber: 42 })).status, 'transport-failed');
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

test('unsupported-state diagnostics reach the public result without claiming the repository', async () => {
  const reason = 'Legacy run records are incompatible; archive the journal before starting a new one.';
  const fixture = await runFixture({ stateInspections: [{ status: 'unsupported', rawSha256: 'a'.repeat(64), reason }] });
  assert.deepEqual(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), { status: 'state-schema-unsupported', reason });
  assert.equal(fixture.events.includes('owner-acquire'), false);
  assert.deepEqual(fixture.evidence, []);
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
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, 'state-schema-unsupported');
    assert.ok('reason' in result && result.reason?.includes('archive'));
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

test('a discovered base mismatch creates no claim, implementation worktree, or run state', async () => {
  const fixture = await runFixture({ issueBody: `## Acceptance Criteria\n- The behavior works.\n\nsource-base-sha:${'f'.repeat(40)}\n` });
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  const result = await fixture.runner.runIssue(input);
  assert.equal(result.status, 'not-eligible');
  assert.equal((await fixture.store.read()).runs.length, 0);
  assert.equal(fixture.events.some((event) => event.startsWith('effect:claim')), false);
  assert.equal(fixture.evidence.at(-1)?.code, 'discovery-base-mismatch');
});

test('an existing run retains its pinned base and rejects a different discovery base without changing state', async () => {
  const fixture = await runFixture();
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  const readIssue = fixture.dependencies.issues.read;
  let sourceBase = fixture.baseSha;
  fixture.dependencies.issues.read = async (number) => {
    const issue = await readIssue(number);
    return issue ? { ...issue, body: `${issue.body}\nsource-base-sha:${sourceBase}\n` } : undefined;
  };
  assert.equal((await fixture.runner.runIssue(input)).status, 'review-ready');
  const before = await fixture.store.read();
  const effects = effectCounts(fixture.events);
  sourceBase = 'f'.repeat(40);
  assert.equal((await fixture.runner.runIssue(input)).status, 'not-eligible');
  assert.deepEqual(await fixture.store.read(), before);
  assert.deepEqual(effectCounts(fixture.events), effects);
  sourceBase = fixture.baseSha;
  assert.equal((await fixture.runner.runIssue(input)).status, 'review-ready');
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

test('a missing candidate adapter before implementation does not invent retained work', async () => {
  const fixture = await runFixture({ fileBackedStore: true });
  fixture.dependencies.git.candidateV2 = undefined;
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'blocked');
  const comment = (await fixture.dependencies.issues.read(42))?.comments.find(item => item.body.includes(':blocked -->'))?.body ?? '';
  assert.match(comment, /Git candidate adapter or immutable candidate binding is unavailable/u);
  assert.match(comment, /candidate-git-v2-required/u);
  assert.doesNotMatch(comment, /retained implementation|Implementation report retained/u);
  assert.equal(fixture.events.includes('agent:implementation'), false);
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

test('recoverable proof failure returns to the same owner for fresh evidence without renewed authority', async () => {
  for (const interruptRelease of [false, true]) {
    const fixture = await runFixture();
    let proofSequence = 0;
    fixture.dependencies.createProofId = () => `recovery-proof-${++proofSequence}`;
    if (interruptRelease) {
      const candidate = fixture.dependencies.git.candidateV2!;
      const release = candidate.releasePin.bind(candidate);
      let interrupted = false;
      candidate.releasePin = async input => {
        if (!interrupted) { interrupted = true; throw new Error('temporary pin release failure'); }
        return release(input);
      };
    }
    const blocker = { kind: 'service' as const, summary: 'proof service is temporarily unavailable',
      attempted: ['bounded status probe'], resumable: true };
    const admit = fixture.dependencies.proof.admitReport;
    let blockedProofId: string | undefined;
    fixture.dependencies.proof.admitReport = async input => {
      const result = await admit(input);
      blockedProofId ??= input.proofId;
      return input.proofId === blockedProofId
        ? { status: 'external-block', blocker, receipt: receipt() }
        : result;
    };
    const deferred = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.deepEqual(pick(deferred, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
    const paused = (await fixture.store.read()).runs[0]!;
    assert.equal(paused.terminalOutcome, undefined);
    assert.equal(runNeedsDaemonTick(paused), true);
    assert.equal(paused.implementationResult, undefined);
    assert.equal(paused.pendingEffect?.kind, interruptRelease ? 'candidate-pin-release' : undefined);
    assert.equal(fixture.events.at(-1), 'owner-release');

    const resumed = await new RunIssue(fixture.dependencies).runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(resumed.status, 'review-ready', JSON.stringify({ resumed, state: await fixture.store.read(), events: fixture.events }));
    assert.equal(fixture.events.filter((event) => event === 'agent').length, 2);
    assert.equal(fixture.events.filter((event) => event === 'proof:admission').length, 2);
    assert.equal(fixture.events.filter((event) => event === 'git:push').length, 1);
    const final = (await fixture.store.read()).runs;
    assert.equal(final.length, 1);
    assert.equal(final[0]!.runId, paused.runId);
    for (const payload of fixture.checkedChangePayloads) {
      assert.equal(payload.version, 2);
      if (payload.version !== 2) throw new Error('Expected immutable candidate proof');
      assert.equal(payload.binding.expectedHeadSha, paused.baseSha);
    }
    assert.deepEqual(final[0]!.codexSession, paused.codexSession);
    assert.equal(final[0]!.cycle, paused.cycle);
  }
});

test('revoked issue authority still releases retained mobile resources before terminal state', async () => {
  const fixture = await runFixture({ fileBackedStore: true, proof: async () => ({ status: 'cleanup-pending', outcome: passedProof() }) });
  const invoke = () => new RunIssue(fixture.dependencies).runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal((await invoke()).status, 'transport-failed');
  const originalRead = fixture.dependencies.issues.read;
  fixture.dependencies.issues.read = async number => { const issue = await originalRead(number); return issue ? { ...issue, labels: [] } : issue; };
  let cleanups = 0;
  fixture.dependencies.proof.cleanupMobileLeases = async () => { if (++cleanups === 1) throw new Error('still pending'); };
  assert.equal((await invoke()).status, 'transport-failed');
  assert.equal((await fixture.store.read()).runs[0]!.terminalOutcome, undefined);
  assert.equal((await invoke()).status, 'blocked');
  assert.equal(cleanups, 2);
  assert.equal(fixture.events.includes('git:push'), false);
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

test('dummy token exception is exact and does not suppress other credential evidence', () => {
  assert.equal(containsCredentialEvidence("accessToken: 'test-token', refreshToken: 'test-refresh'"), false);
  for (const value of [
    "accessToken: 'test-token-real-credential'",
    "accessToken: 'test-token' + privateSuffix",
    "accessToken: 'test-token'\n  + privateSuffix",
    "+accessToken: 'test-token'\n+  + privateSuffix,",
    "accessToken: 'test-token', refreshToken: 'credential-material-12345'",
    "password: 'test-token'",
    "api_accessToken: 'test-token',",
    "otherrefreshToken: 'test-refresh';",
    `'api-accessToken': 'test-token',`,
    `"other-refreshToken": "test-refresh"`,
    `'other+accessToken': 'test-token',`,
    `éaccessToken: 'test-token',`,
    `𐐀accessToken: 'test-token',`,
    `"пaccessToken": "test-token"`,
    'accessToken: test-token',
    'accessToken: "test-token\\escaped"',
    "accessToken: 'test-token', GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
    "accessToken: 'test-token', Authorization: 'Bearer credential-material-12345'",
  ]) assert.equal(containsCredentialEvidence(value), true, value);
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
    status: 'exhausted', attempts: 2, diagnostic: 'terminal-comment-observation-diverged',
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

test('closed issue confirms a previously posted terminal comment without another publication', async () => {
  const fixture = await runFixture({ fileBackedStore: true,
    rejectStoreTransition: { from: 'terminal-comment', to: 'none' },
    proof: async () => ({ status: 'external-block', blocker: {
      kind: 'service', summary: 'down', attempted: ['retry'], resumable: false,
    }, receipt: receipt() }),
  });
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  assert.equal((await fixture.runner.runIssue(input)).status, 'blocked');
  assert.equal((await fixture.store.read()).runs[0]!.pendingEffect?.kind, 'terminal-comment');
  const posts = fixture.events.filter((event) => event === 'effect:blocked-comment').length;
  assert.equal(fixture.comments.filter((comment) => comment.body.includes(':blocked -->')).length, 1);
  fixture.setIssueState('CLOSED');
  assert.equal((await new RunIssue(fixture.dependencies).runIssue(input)).status, 'blocked');
  assert.equal((await fixture.store.read()).runs[0]!.terminalNotifications?.comment.status, 'delivered');
  assert.equal(fixture.events.filter((event) => event === 'effect:blocked-comment').length, posts);
  assert.equal(fixture.comments.filter((comment) => comment.body.includes(':blocked -->')).length, 1);
  assert.equal(fixture.events.filter((event) => event === 'agent:implementation').length, 1);
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
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [], checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'passed', outputSha256: sha256('worker output') }] } },
    ],
  });
  assert.equal((await malformed.runner.runIssue({ targetRoot: malformed.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await malformed.runner.runIssue({ targetRoot: malformed.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(malformed.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await malformed.store.read()).runs[0]!, ['cycle', 'reportRepairs']), { cycle: 1, reportRepairs: 0 });

  const transport = await runFixture({
    implementationResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [], checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'passed', outputSha256: sha256('worker output') }] } },
    ],
  });
  assert.equal((await transport.runner.runIssue({ targetRoot: transport.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await transport.runner.runIssue({ targetRoot: transport.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(transport.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await transport.store.read()).runs[0]!, ['cycle', 'transportRetries']), { cycle: 1, transportRetries: 0 });
});

test('model capacity evidence retains its cause and resumes the same run without consuming a cycle', async () => {
  const failure = { kind: 'transport-failed' as const, exitCode: 1, signal: null,
    reportStatus: 'available' as const, detail: 'codex-model-capacity' };
  const fixture = await runFixture({ implementationResults: [
    { kind: 'transport-failed', resumable: true, failure },
  ] });
  const writeEvidence = fixture.dependencies.writeEvidence;
  let retainedFailure: unknown;
  fixture.dependencies.writeEvidence = async entry => {
    if (entry.code === 'codex-model-capacity') retainedFailure = entry.failure;
    return writeEvidence(entry);
  };
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  const result = await fixture.runner.runIssue(input);
  assert.deepEqual(pick(result, ['status', 'resumable']), { status: 'transport-failed', resumable: true });
  assert.ok(fixture.evidence.some(entry => entry.code === 'codex-model-capacity'));
  assert.deepEqual(retainedFailure, failure);
  const before = (await fixture.store.read()).runs[0]!;
  assert.equal(fixture.events.includes('git:push'), false);
  assert.equal((await fixture.runner.runIssue(input)).status, 'review-ready');
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.runId, before.runId);
  assert.equal(after.worktreePath, before.worktreePath);
  assert.deepEqual(after.codexSession, before.codexSession);
  assert.equal(after.cycle, before.cycle);
});

test('incomplete cumulative changedFiles retries full implementation without consuming a cycle', async () => {
  const fixture = await runFixture({
    implementationResults: [
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'delta only', changedFiles: ['repair-only.txt'], residualRisks: [] } },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'cumulative', changedFiles: ['feature.txt'], residualRisks: [], checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'passed', outputSha256: sha256('worker output') }] } },
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
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'recovered', changedFiles: ['feature.txt'], residualRisks: [], checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'passed', outputSha256: sha256('worker output') }] } },
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

for (const reason of ['proof artifact temporarily unavailable', 'admission service capacity exceeded']) {
  test(`proof admission infrastructure recovery preserves the owner and exact candidate: ${reason}`, async () => {
    const fixture = await runFixture({ proofError: new Error(reason) });
    assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
    assert.ok(fixture.evidence.some(entry => entry.summary.includes(reason)));
    const before = (await fixture.store.read()).runs[0]!;
    fixture.options.proofError = undefined;
    assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
    const after = (await fixture.store.read()).runs[0]!;
    assert.deepEqual(after.codexSession, before.codexSession);
    assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, 1);
    assert.deepEqual(fixture.checkedChangePayloads[1], fixture.checkedChangePayloads[0]);
  });
}

test('resumable implementation transport retries once when the interrupted attempt changed the worktree', async () => {
  const fixture = await runFixture({
    transportWrites: true,
    implementationResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'completed', report: { version: 1, status: 'completed', summary: 'done', changedFiles: ['feature.txt'], residualRisks: [], checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'passed', outputSha256: sha256('worker output') }] } },
    ],
  });

  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.filter((event) => event === 'agent').length, 2);
  assert.deepEqual(pick((await fixture.store.read()).runs[0]!, ['cycle', 'transportRetries']), { cycle: 1, transportRetries: 0 },
    JSON.stringify({ state: await fixture.store.read(), events: fixture.events, evidence: fixture.evidence }));
});

test('publication tree observation failure preserves the exact intent and resumes without implementation', async () => {
  const fixture = await runFixture({ fileBackedStore: true, rejectEffect: 'push' });
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  assert.equal((await fixture.runner.runIssue(input)).status, 'transport-failed');
  const retained = (await fixture.store.read()).runs[0]!;
  assert.equal(retained.candidateBinding, undefined);
  assert.equal(retained.pendingEffect?.kind, 'initial-push');
  const inspect = fixture.dependencies.git.inspectHead;
  fixture.dependencies.git.inspectHead = async () => { throw new Error('temporary Git observation failure'); };
  assert.deepEqual(pick(await new RunIssue(fixture.dependencies).runIssue(input), ['status', 'resumable']),
    { status: 'transport-failed', resumable: true });
  assert.deepEqual((await fixture.store.read()).runs[0], retained);
  fixture.dependencies.git.inspectHead = inspect;
  assert.equal((await new RunIssue(fixture.dependencies).runIssue(input)).status, 'review-ready');
  assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, 1);
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
    { name: 'proof rejects', options: { proofReject: true }, status: 'transport-failed', resumable: true },
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

for (const cleanupFailure of [false, true]) {
  test(`candidate source drift after proof admission blocks publication with cleanup failure=${cleanupFailure}`, async () => {
    const fixture = await runFixture({ proofMutatesWorktreeOnce: true, candidateReleaseFailBeforeCommitOnce: cleanupFailure });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, 'blocked');
    const stopped = (await fixture.store.read()).runs[0]!;
    assert.equal(stopped.cycle, 1);
    assert.ok(stopped.codexSession);
    assert.equal(fixture.events.includes('git:push'), false);
    assert.equal(fixture.events.includes('effect:pr'), false);
    assert.deepEqual(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), result);
    assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, 1);
  });
}

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

test('restart resumes interrupted implementation in the same native session and pinned workflow', async () => {
  const fixture = await runFixture({ implementationResult: { kind: 'transport-failed', resumable: true } });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
  const before = (await fixture.store.read()).runs[0]!;
  fixture.options.implementationResult = undefined;
  fixture.dependencies.packageVersion = '0.1.52';
  fixture.dependencies.createWorkflowGeneration = async () => { throw new Error('replacement package workflow is corrupt'); };
  assert.equal((await new RunIssue(fixture.dependencies).runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.runId, before.runId);
  assert.deepEqual(after.codexSession, before.codexSession);
  assert.equal(after.cycle, 1);
  assert.equal(after.packageVersion, '0.1.51');
  assert.equal(after.workflowGeneration.generationHash, '1'.repeat(64));
  assert.equal(after.skillHashes['agent-auto'], 'a'.repeat(64));
  assert.equal(after.worktreePath, fixture.worktreePath);
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
  await writeFile(join(fixture.worktreePath, 'feature.txt'), 'implemented by unresolved process\n');
  const source = await fixture.dependencies.git.snapshot(fixture.worktreePath);
  const report = { version: 1, status: 'completed', summary: 'recovered', changedFiles: ['feature.txt'], residualRisks: [],
    checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'passed', outputSha256: sha256('worker output') }],
    proof: { version: 1, status: 'passed', decision: { mode: 'non-visual', targets: [] }, criteria: frozen.frozenCriteria.map(c => ({
      id: c.id, status: 'passed', confidence: 'high', surfaces: ['non-visual'], evidenceRefs: ['typecheck'], analysis: 'Public behavior passes.' })), checks: [], artifacts: [], findings: [], residualRisks: [] },
    review: { summary: 'Independent reviewers approved final source.', trackedContentSha256: source.trackedContentSha256,
      untrackedContentSha256: source.untrackedContentSha256, coverage: ['candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability', 'repository-standards', 'requirements', 'tests', 'zero-legacy'],
      reviewers: [{ role: 'spec_reviewer', sessionId: '01000000-0000-4000-8000-000000000002', verdict: 'approve' },
        { role: 'standards_reviewer', sessionId: '01000000-0000-4000-8000-000000000003', verdict: 'approve' }] } };
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

for (const invalid of ['missing-checks', 'failed-check', 'duplicate-check', 'wrong-command', 'missing-policy-check',
  'missing-proof', 'failed-proof', 'unknown-criterion', 'missing-review', 'missing-coverage', 'one-reviewer',
  'duplicate-reviewer', 'owner-as-reviewer', 'non-native-reviewer', 'wrong-source-hash'] as const) {
  test(`owner completion rejects ${invalid} before publication and resumes the same native session`, async () => {
    const fixture = await runFixture({ configuredChecks: { typecheck: 'npm run typecheck', build: 'npm run build' } });
    const implement = fixture.dependencies.implementationAgent.run;
    const sessions: Array<string | undefined> = [];
    let corrupt = true;
    fixture.dependencies.implementationAgent.run = async input => {
      sessions.push(input.sessionId);
      const result = await implement(input);
      if (result.kind !== 'completed' || !corrupt) return result;
      const report = structuredClone(result.report) as Record<string, any>;
      if (invalid === 'missing-checks') delete report.checks;
      if (invalid === 'failed-check') report.checks[0].status = 'failed';
      if (invalid === 'duplicate-check') report.checks.push({ ...report.checks[0] });
      if (invalid === 'wrong-command') report.checks[0].command = 'unrelated command';
      if (invalid === 'missing-policy-check') report.checks.pop();
      if (invalid === 'missing-proof') delete report.proof;
      if (invalid === 'failed-proof') report.proof.status = 'needs-rework';
      if (invalid === 'unknown-criterion') report.proof.criteria[0].status = 'unknown';
      if (invalid === 'missing-review') delete report.review;
      if (invalid === 'missing-coverage') report.review.coverage.pop();
      if (invalid === 'one-reviewer') report.review.reviewers.pop();
      if (invalid === 'duplicate-reviewer') report.review.reviewers[1] = { ...report.review.reviewers[0] };
      if (invalid === 'owner-as-reviewer') report.review.reviewers[0].sessionId = '01000000-0000-4000-8000-000000000001';
      if (invalid === 'non-native-reviewer') report.review.reviewers[0].sessionId = 'invented-reviewer-token';
      if (invalid === 'wrong-source-hash') report.review.trackedContentSha256 = 'f'.repeat(64);
      return { ...result, report };
    };
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(fixture.events.includes('git:push'), false, invalid);
    assert.equal(fixture.events.includes('effect:pr'), false, invalid);
    assert.equal(fixture.events.includes('proof:admission'), false, invalid);
    const policy = ['wrong-command', 'missing-policy-check', 'wrong-source-hash'].includes(invalid);
    if (policy) {
      assert.equal(result.status, 'blocked', JSON.stringify(result));
      assert.deepEqual(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), result);
      assert.equal(sessions.length, 1);
    } else {
      assert.equal(result.status, 'transport-failed', JSON.stringify(fixture.evidence));
      const stopped = (await fixture.store.read()).runs[0]!;
      assert.equal(stopped.codexSession?.id, '01000000-0000-4000-8000-000000000001');
      assert.ok(stopped.implementationReportCorrection);
      corrupt = false;
      assert.equal((await new RunIssue(fixture.dependencies).runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
      assert.deepEqual(sessions, [undefined, stopped.codexSession?.id]);
    }
  });
}

test('additional owner checks remain recorded while configured receipts bind the publication candidate', async () => {
  const fixture = await runFixture();
  const implement = fixture.dependencies.implementationAgent.run;
  fixture.dependencies.implementationAgent.run = async input => {
    const result = await implement(input);
    if (result.kind !== 'completed') return result;
    const report = structuredClone(result.report) as Record<string, any>;
    report.checks.push({ id: 'lint', command: 'npm run lint', status: 'passed', outputSha256: sha256('lint') });
    return { ...result, report };
  };
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const record = (await fixture.store.read()).runs[0]!;
  assert.equal(record.implementationResult?.checks?.length, 2);
  assert.equal(record.checks.length, 1);
  assert.ok('candidateTreeSha' in record.checks[0]!);
  assert.equal(record.checks[0]!.outputSha256, record.implementationResult?.checks?.[0]?.outputSha256);
});

for (const path of ['README.md', 'extra-source.txt']) {
  test(`owner review binds final ${path === 'README.md' ? 'tracked' : 'untracked'} source content`, async () => {
    const fixture = await runFixture();
    const implement = fixture.dependencies.implementationAgent.run;
    fixture.dependencies.implementationAgent.run = async input => {
      const result = await implement(input);
      await writeFile(join(input.worktreePath, path), 'source changed after independent Review\n');
      if (result.kind !== 'completed') return result;
      const report = structuredClone(result.report) as Record<string, any>;
      report.changedFiles = await fixture.dependencies.git.listChangedFiles(input.worktreePath);
      return { ...result, report };
    };
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, 'blocked');
    assert.equal(fixture.events.includes('proof:admission'), false);
    assert.equal(fixture.events.includes('git:push'), false);
  });
}

test('trusted issue question resumes the same owner session and PR without changing published code', async () => {
  const fixture = await runFixture();
  await prepareActiveIssueFeedback(fixture);
  const before = (await fixture.store.read()).runs[0]!;
  const effects = fixture.events.filter(event => /^(git:push|git:commit|effect:pr|proof:admission)$/u.test(event));
  const comments: Array<{ id: string; body: string }> = [];
  fixture.dependencies.pullRequests.listConversationComments = async () => comments;
  fixture.dependencies.pullRequests.postConversationComment = async (_number, body) => {
    const comment = { id: String(comments.length + 1), body }; comments.push(comment); return comment;
  };
  let ownerSession: string | undefined;
  fixture.dependencies.implementationAgent.run = async input => {
    ownerSession = input.sessionId;
    await input.onPrepared?.({ attemptId: input.attemptId, reportPath: fixture.dependencies.attemptResultPath({ canonicalRepository: before.canonicalRepository, runId: before.runId, attemptId: input.attemptId }), preparedAt: '2026-07-16T12:10:00.000Z', baseline: await fixture.dependencies.git.snapshot(input.worktreePath) });
    await input.onLaunched?.({ attemptId: input.attemptId, pid: 6060, processGroupId: 6060, launchedAt: '2026-07-16T12:10:00.000Z' });
    await input.onSessionStarted?.(input.sessionId!);
    return { kind: 'completed', report: { version: 1, status: 'answer-only', summary: 'Answered the trusted question.', changedFiles: [], residualRisks: [], response: 'The verified behavior remains unchanged.' } };
  };
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.runId, before.runId);
  assert.equal(ownerSession, before.codexSession?.id);
  assert.equal(after.reviewFeedback?.previousPublishedHeadSha, before.reviewFeedback?.previousPublishedHeadSha);
  assert.deepEqual(fixture.events.filter(event => /^(git:push|git:commit|effect:pr|proof:admission)$/u.test(event)), effects);
  assert.equal(fixture.comments.filter(comment => comment.body.includes(':issue-feedback:')).length, 1);
});

test('worker failed verification remains a typed blocker without false success', async () => {
  const blocker = {
    kind: 'tool' as const, summary: 'Configured typecheck failed after the implementation repair.',
    attempted: ['npm run typecheck'], resumable: false,
  };
  const fixture = await runFixture({ implementationResult: { kind: 'completed', report: {
    version: 1, status: 'external-block', summary: 'Verification failed.', changedFiles: [], residualRisks: [], blocker,
  } } });
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') throw new Error('Expected typed worker blocker');
  assert.equal(result.kind, 'external');
  assert.deepEqual(result.blocker, blocker);
  assert.equal(fixture.events.includes('proof:admission'), false);
  assert.equal(fixture.events.includes('git:push'), false);
  const comment = (await fixture.dependencies.issues.read(42))?.comments.find(item => item.body.includes(':blocked -->'))?.body ?? '';
  assert.match(comment, /Configured typecheck failed/u);
  assert.equal((await fixture.store.read()).runs[0]!.checks.length, 0);
});

test('a fresh GitHub grant resumes a cancelled Run without stale cancellation labels undoing it', async () => {
  const fixture = await runFixture({ fileBackedStore: true, implementationResult: { kind: 'cancelled' } });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'cancelled');
  const stopped = (await fixture.store.read()).runs[0]!;
  const priorEvidence = stopped.terminalOutcome!.evidencePath;
  const grants: string[] = [];
  const writeEvidence = fixture.dependencies.writeEvidence;
  fixture.dependencies.writeEvidence = async input => {
    if (input.code === 'github-reauthorization') grants.push(input.summary);
    return writeEvidence(input);
  };
  await fixture.dependencies.issues.setLabels(42, ['agent:auto']);
  fixture.dependencies.issues.isReauthorized = async () => true;
  fixture.options.implementationResult = undefined;
  const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(result.status, 'review-ready', JSON.stringify({ result, grants, stopped: { pending: stopped.pendingEffect, active: stopped.activeAttempt, materialization: stopped.candidateMaterialization }, events: fixture.events, evidence: fixture.evidence }));
  const resumed = (await fixture.store.read()).runs[0]!;
  assert.equal(resumed.runId, stopped.runId);
  assert.equal(resumed.branchName, stopped.branchName);
  assert.equal(resumed.worktreePath, stopped.worktreePath);
  assert.ok(grants.some(summary => summary.includes(priorEvidence)));
  assert.ok((await readFile(resolve(fixture.targetRoot, priorEvidence), 'utf8')).includes('cancelled'));
  assert.equal(fixture.events.filter(event => event === 'git:push').length, 1);
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
  assert.equal((await restartedAdapter.candidateV2.reconcileOrphans!({
    repositoryRoot: root,
    workspaceRoot: join(root, '.worktrees'),
    activeCandidateRefs: [binding.candidateRef],
    pendingCandidates: [],
    activeMaterializations: [{ path: prepared.value.materialization.path, candidateCommitSha: binding.candidateCommitSha }],
  })).kind, 'failed');
  assert.equal((await execFileAsync('git', ['-C', prepared.value.materialization.path, 'rev-parse', 'HEAD'])).stdout.trim(), binding.candidateCommitSha);
  assert.equal(await readFile(join(unrecordedSiblingPath, 'tracked.txt'), 'utf8'), 'authoritative worktree bytes\n');
  const orphanRef = `refs/codex-orchestrator/candidates/00000000-0000-4000-8000-000000000099/${'9'.repeat(64)}`;
  const orphanPath = join(root, '.worktrees', '.candidate-materializations', 'orphan');
  await execFileAsync('git', ['-C', root, 'update-ref', orphanRef, binding.candidateCommitSha]);
  await mkdir(join(root, '.worktrees', '.candidate-materializations'), { recursive: true });
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '--detach', orphanPath, binding.candidateCommitSha]);
  assert.equal((await restartedAdapter.candidateV2.reconcileOrphans!({
    repositoryRoot: root,
    workspaceRoot: join(root, '.worktrees'),
    activeCandidateRefs: [binding.candidateRef],
    pendingCandidates: [],
    activeMaterializations: [{ path: prepared.value.materialization.path, candidateCommitSha: binding.candidateCommitSha }],
  })).kind, 'failed');
  assert.equal((await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', orphanRef])).stdout.trim(), binding.candidateCommitSha);
  assert.equal(await readFile(join(orphanPath, 'tracked.txt'), 'utf8'), 'authoritative worktree bytes\n');
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

for (const scenario of [
  { name: 'explicit dummy token', patch: "+tokens.storeTokens(accessToken: 'test-token', refreshToken: 'test-refresh');", paths: ['test/session_test.dart'], status: 'review-ready' },
  { name: 'credential leak', patch: '+access_token=credential-material-12345', paths: ['feature.txt'], status: 'blocked' },
  { name: 'denied path', patch: '+secret change', paths: ['secrets/value.txt'], status: 'blocked' },
  { name: 'large source patch', patch: '+' + 'x'.repeat(1024 * 1024), paths: ['feature.txt'], status: 'review-ready' },
]) {
  test(`candidate admission enforces ${scenario.name}`, async () => {
    const fixture = await runFixture({ denyReadPaths: ['secrets/**'], diffTreeOverride: { changedFiles: scenario.paths, patch: `diff --git a/feature.txt b/feature.txt\n${scenario.patch}\n` } });
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, scenario.status, JSON.stringify(fixture.evidence));
    if (result.status === 'blocked') {
      assert.equal(fixture.events.includes('git:push'), false);
      assert.equal(fixture.events.includes('proof:admission'), false);
      assert.deepEqual(await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 }), result);
    }
  });
}

test('four trusted feedback changes keep the same Run, native owner and PR with fresh bound proof', async () => {
  const fixture = await runFixture();
  await prepareActiveIssueFeedback(fixture, 'issue-comment:round-1');
  enableFeedbackPublication(fixture);
  const before = (await fixture.store.read()).runs[0]!;
  const implement = fixture.dependencies.implementationAgent.run;
  let round = 0;
  fixture.dependencies.implementationAgent.run = async input => {
    assert.equal(input.sessionId, before.codexSession?.id);
    const result = await implement(input);
    if (result.kind !== 'completed') return result;
    round += 1;
    await writeFile(join(input.worktreePath, 'feature.txt'), `trusted feedback round ${round}\n`);
    const source = await fixture.dependencies.git.snapshot(input.worktreePath);
    const report = structuredClone(result.report) as Record<string, any>;
    report.changedFiles = await fixture.dependencies.git.listChangedFiles(input.worktreePath);
    report.review.trackedContentSha256 = source.trackedContentSha256;
    report.review.untrackedContentSha256 = source.untrackedContentSha256;
    return { ...result, report };
  };
  for (let index = 1; index <= 4; index += 1) {
    if (index > 1) { await prepareActiveIssueFeedback(fixture, `issue-comment:round-${index}`); enableFeedbackPublication(fixture); }
    const result = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(result.status, 'review-ready', JSON.stringify({ result, evidence: fixture.evidence, outcome: result.status !== 'review-ready' && 'evidencePath' in result ? await readFile(resolve(fixture.targetRoot, result.evidencePath), 'utf8').catch(() => '') : '' }));
    const current = (await fixture.store.read()).runs[0]!;
    assert.equal(current.runId, before.runId);
    assert.equal(current.codexSession?.id, before.codexSession?.id);
    assert.ok(current.reviewFeedback?.consumedSourceIds.includes(`issue-comment:round-${index}`));
    assert.equal(current.implementationResult?.proof?.status, 'passed');
  }
  assert.equal(round, 4);
  assert.equal(fixture.events.filter(event => event === 'effect:pr').length, 1);
  assert.equal(fixture.events.filter(event => event === 'git:push').length, 5);
  assert.equal(fixture.events.filter(event => event === 'proof:admission').length, 5);
});

for (const scenario of ['complete', 'repeat-request', 'source-edit', 'prepare-failure', 'cleanup-failure'] as const) {
  test(`Android resource request ${scenario} preserves one native owner and publication safety`, async () => {
    const fixture = await runFixture();
    const implement = fixture.dependencies.implementationAgent.run;
    let ownerCalls = 0;
    let cleanupCalls = 0;
    const preparationObservations: Array<boolean | undefined> = [];
    let preparedPayload: CheckedChangePayloadV2 | undefined;
    const artifact = '.codex-orchestrator/proofs/runner-prepared.json';
    const prepared = { runnerPreparedArtifactPaths: [artifact], runnerPreparedArtifactSha256: { [artifact]: sha256('prepared metadata') }, runnerPreparationWarnings: [] };
    fixture.dependencies.proof.prepareAndroid = async input => {
      preparationObservations.push(input.observeOnly);
      const payload = fixture.capabilities.verifyAndRead(input.checkedChange).payload as CheckedChangePayloadV2;
      if (preparedPayload) assert.deepEqual(payload, preparedPayload);
      preparedPayload = payload;
      if (scenario === 'prepare-failure' && preparationObservations.length === 1) throw new Error('Android build preparation unavailable');
      return { status: 'prepared', ...prepared };
    };
    fixture.dependencies.proof.cleanupMobileLeases = async () => {
      cleanupCalls += 1;
      if (scenario === 'cleanup-failure') throw new Error('mobile cleanup unavailable');
    };
    fixture.dependencies.implementationAgent.run = async input => {
      ownerCalls += 1;
      const result = await implement(input);
      if (result.kind !== 'completed') return result;
      const report = structuredClone(result.report) as Record<string, any>;
      if (ownerCalls === 1 || scenario === 'repeat-request') {
        report.status = 'android-proof-request'; delete report.proof; delete report.review;
      } else {
        assert.equal(input.sessionId, '01000000-0000-4000-8000-000000000001');
        assert.deepEqual(input.androidProofPreparation?.runnerPreparedArtifactPaths, prepared.runnerPreparedArtifactPaths);
        assert.deepEqual(input.androidProofPreparation?.runnerPreparedArtifactSha256, prepared.runnerPreparedArtifactSha256);
        if (scenario === 'source-edit') {
          await writeFile(join(input.worktreePath, 'feature.txt'), 'edited after Android build\n');
          const source = await fixture.dependencies.git.snapshot(input.worktreePath);
          report.review.trackedContentSha256 = source.trackedContentSha256;
          report.review.untrackedContentSha256 = source.untrackedContentSha256;
        }
      }
      return { ...result, report };
    };
    const first = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    assert.equal(first.status, 'transport-failed', JSON.stringify(fixture.evidence));
    assert.ok(preparedPayload, JSON.stringify({ evidence: fixture.evidence, record: (await fixture.store.read()).runs[0] }));
    assert.equal(fixture.events.includes('git:push'), false);
    const before = (await fixture.store.read()).runs[0]!;
    assert.equal(before.codexSession?.id, '01000000-0000-4000-8000-000000000001');
    if (scenario === 'prepare-failure') {
      assert.ok(cleanupCalls > 0);
      assert.equal(fixture.events.includes('proof:admission'), false);
      assert.equal(before.androidProofPreparation?.status, 'pending');
      assert.equal((await new RunIssue(fixture.dependencies).runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'transport-failed');
      assert.deepEqual(preparationObservations, [false, true]);
      assert.equal(ownerCalls, 1, 'resource observation cannot launch a new owner process');
    }
    assert.equal(preparedPayload.binding.candidateTreeSha, before.candidateBinding?.candidateTreeSha);
    assert.deepEqual(preparedPayload.checks, before.checks);
    const second = await new RunIssue(fixture.dependencies).runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
    if (scenario === 'complete' || scenario === 'prepare-failure') {
      assert.equal(second.status, 'review-ready', JSON.stringify(fixture.evidence));
      assert.deepEqual(fixture.checkedChangePayloads.at(-1), preparedPayload);
      assert.ok(cleanupCalls > 0);
    } else {
      assert.ok(second.status === 'blocked' || second.status === 'transport-failed', JSON.stringify(second));
      assert.equal(fixture.events.includes('git:push'), false);
      assert.equal(fixture.events.includes('effect:pr'), false);
      if (scenario === 'source-edit' || scenario === 'repeat-request') assert.ok(cleanupCalls > 0, 'terminal resource safety requires lease cleanup');
      if (scenario === 'cleanup-failure') {
        assert.ok(cleanupCalls > 0);
        assert.ok((await fixture.store.read()).runs[0]?.proofReceipt);
        fixture.dependencies.proof.cleanupMobileLeases = async () => { cleanupCalls += 1; };
        assert.equal((await new RunIssue(fixture.dependencies).runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
        assert.equal(ownerCalls, 2, 'cleanup recovery must retain the completed owner report');
      }
    }
    assert.equal(ownerCalls, 2);
    assert.equal((await fixture.store.read()).runs[0]?.codexSession?.id, before.codexSession?.id);
  });
}

for (const drift of ['configured-command', 'missing-check', 'missing-pin'] as const) {
  test(`restart publication rejects ${drift} without a new owner process`, async () => {
    const fixture = await runFixture({ rejectEffect: drift === 'missing-pin' ? 'commit' : 'push', configuredChecks: { typecheck: 'npm run typecheck', build: 'npm run build' } });
    const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
    assert.equal((await fixture.runner.runIssue(input)).status, 'transport-failed');
    const before = (await fixture.store.read()).runs[0]!;
    const originalOwnerCount = fixture.events.filter(event => event === 'agent:implementation').length;
    if (drift === 'configured-command') {
      const readConfig = fixture.dependencies.readConfig;
      fixture.dependencies.readConfig = async root => {
        const result = await readConfig(root);
        const config = structuredClone(result.config); config.checks.build = 'npm run different-build';
        return { config, bytes: Buffer.from(canonicalJson(config)) };
      };
    } else if (drift === 'missing-check') {
      const state = await fixture.store.read();
      const record = structuredClone(state.runs[0]!); record.checks.pop();
      await fixture.store.compareAndSwap(state.generation, { schema: state.schema, runs: [record] });
    } else await execFileAsync('git', ['-C', fixture.worktreePath, 'update-ref', '-d', before.candidateBinding?.candidateRef ?? 'refs/heads/nonexistent']);
    const result = await new RunIssue(fixture.dependencies).runIssue(input);
    assert.ok(result.status === 'transport-failed' || result.status === 'blocked', JSON.stringify(result));
    assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, originalOwnerCount);
    assert.equal(fixture.events.includes('effect:pr'), false);
    assert.equal((await fixture.store.read()).runs[0]?.runId, before.runId);
  });
}

test('tests-only acceptance remains inside the owner completion with no separate semantic execution', async () => {
  const fixture = await runFixture({ issueBody: [
    '## Acceptance Criteria', '- The requested public behavior passes.', '## Proof requirements', '```json',
    JSON.stringify({ version: 1, level: 'tests-only', reason: 'Behavior is established through public tests.', authentication: 'none', steps: [] }), '```',
  ].join('\n') });
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  assert.equal(fixture.events.filter(event => event === 'agent:implementation').length, 1);
  assert.equal(Object.hasOwn(fixture.dependencies.proof, 'proveChange'), false);
  assert.equal(Object.hasOwn(fixture.dependencies, 'implementationReviewer'), false);
});

for (const sessionStarted of [false, true]) test(`new authorization refreshes current issue criteria authority and workflow with sessionStarted=${sessionStarted}`, async () => {
  const fixture = await runFixture({ fileBackedStore: true });
  const implement = fixture.dependencies.implementationAgent.run;
  fixture.dependencies.implementationAgent.run = async input => {
    await input.onPrepared?.({ attemptId: input.attemptId, reportPath: fixture.dependencies.attemptResultPath({ canonicalRepository: 'owner/repo', runId: input.runId, attemptId: input.attemptId }), preparedAt: '2026-07-16T12:00:00.000Z', baseline: await fixture.dependencies.git.snapshot(input.worktreePath) });
    await input.onLaunched?.({ attemptId: input.attemptId, pid: 6060, processGroupId: 6060, launchedAt: '2026-07-16T12:00:00.000Z' });
    if (sessionStarted) await input.onSessionStarted?.('00000000-0000-4000-8000-000000000099');
    return { kind: 'cancelled' };
  };
  assert.equal((await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'cancelled');
  const before = (await fixture.store.read()).runs[0]!;
  assert.equal(!!before.codexSession, sessionStarted);
  const readIssue = fixture.dependencies.issues.read;
  const body = '## Acceptance Criteria\n- The newly authorized behavior is current.';
  fixture.dependencies.issues.read = async number => { const issue = await readIssue(number); return issue ? { ...issue, body } : issue; };
  fixture.dependencies.issues.isReauthorized = async () => true;
  await fixture.dependencies.issues.setLabels(42, ['agent:auto']);
  fixture.dependencies.createWorkflowGeneration = async () => ({ receipt: workflowGeneration('0.1.52', '2'), skillHashes: { 'agent-auto': 'c'.repeat(64), 'acceptance-proof': 'd'.repeat(64) } });
  fixture.dependencies.packageVersion = '0.1.52';
  fixture.dependencies.implementationAgent.run = async input => {
    assert.equal(input.issue.body, body);
    assert.equal(input.frozenCriteria[0]?.text, 'The newly authorized behavior is current.');
    assert.equal(input.workflowGeneration.generationHash, '2'.repeat(64));
    assert.equal(input.sessionId, before.codexSession?.id);
    return implement(input);
  };
  assert.equal((await new RunIssue(fixture.dependencies).runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 })).status, 'review-ready');
  const after = (await fixture.store.read()).runs[0]!;
  assert.equal(after.runId, before.runId);
  assert.equal(after.issueSnapshot.body, body);
  assert.notEqual(after.deliveryAuthority?.authoritySha256, before.deliveryAuthority?.authoritySha256);
  assert.equal(after.workflowGeneration.generationHash, '2'.repeat(64));
  assert.ok(after.codexSession);
  if (sessionStarted) assert.deepEqual(after.codexSession, before.codexSession);
  assert.equal(after.packageVersion, '0.1.52');
  assert.equal(after.skillHashes['agent-auto'], 'c'.repeat(64));
});

interface FixtureOptions {
  hostChecks?: boolean;
  fileBackedStore?: boolean;
  rawRunStateBytes?: Buffer;
  stateInspections?: RunStateInspection[];
  ownerContention?: boolean;
  initialLabels?: string[];
  blockedTransitionLabels?: string[];
  revokeAtAuthorization?: number;
  agentCommit?: boolean;
  proof?: (checkedChange: CheckedChange<any>) => Promise<ProveChangeResult>;
  implementationResult?: ImplementationAgentResult;
  implementationResults?: ImplementationAgentResult[];
  skipImplementationLaunchPersistence?: boolean;
  transportWrites?: boolean;
  agentWrites?: boolean;
  agentWritesDeniedIgnoredPath?: boolean;
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
}

async function runFixture(options: FixtureOptions = {}) {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-v2-run-issue-'));
  await mkdir(join(targetRoot, '.attempt-results'));
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
  if (options.hostChecks) config.runner.checkExecution = 'host';
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
  const rawStore: RunRecordWriter = options.rawRunStateBytes || options.fileBackedStore
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
  const implementationAuthorities: DeliveryAuthority[] = [];
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
    configuredChecks: { run: async input => runConfiguredChecks({ ...input,
      logRoot: join(targetRoot, '.host-check-logs', String(Date.now())), timeoutMs: 5000, env: process.env }) },
    implementationAgent: {
      run: async ({ runnerChecks, attemptId, worktreePath: path, deliveryAuthority, cycle, reworkFindings, onPrepared, onLaunched, onSessionStarted, sessionId, frozenCriteria }) => {
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
          reportPath: join(targetRoot, '.attempt-results', `${attemptId}-report.json`),
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
        await onSessionStarted?.(sessionId ?? '01000000-0000-4000-8000-000000000001');
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
        const checks = Object.entries(config.checks).map(([id, command]) => ({
          id, command, status: 'passed' as const, outputSha256: runnerChecks?.results.find(r => r.id === id)?.outputSha256 ?? sha256(`worker check output: ${id}`),
        }));
        events.push('worker:verification');
        events.push('owner:independent-review');
        const completed = selected ?? { kind: 'completed' as const, report: {
          version: 1, status: 'completed', summary: 'done', changedFiles, residualRisks: [], checks,
        } };
        if (completed.kind === 'completed' && typeof completed.report === 'object' && completed.report !== null
          && (completed.report as { status?: string }).status === 'completed') {
          return { ...completed, attemptId: completed.attemptId ?? attemptId, report: {
            checks,
            proof: { version: 1, status: 'passed', decision: { mode: 'non-visual', targets: [] },
              criteria: frozenCriteria.map(c => ({ id: c.id, status: 'passed', confidence: 'high', surfaces: ['non-visual'],
                evidenceRefs: [checks[0]?.id ?? 'inspection'], analysis: 'The requested behavior passes its public check.' })),
              checks: [], artifacts: checks.length ? [] : [{ id: 'inspection', kind: 'static-inspection', relativePath: 'feature.txt', sha256: sha256('implemented'), publishable: false, description: 'Inspected behavior.' }], findings: [], residualRisks: [] },
            review: { summary: 'Independent reviewers approved the final source.',
              trackedContentSha256: (await dependencies.git.snapshot(path)).trackedContentSha256,
              untrackedContentSha256: (await dependencies.git.snapshot(path)).untrackedContentSha256,
              coverage: ['candidate-proof-binding', 'correctness', 'duplicate-ownership', 'maintainability', 'repository-standards', 'requirements', 'tests', 'zero-legacy'],
              reviewers: [
                { role: 'spec_reviewer', sessionId: '01000000-0000-4000-8000-000000000002', verdict: 'approve' },
                { role: 'standards_reviewer', sessionId: '01000000-0000-4000-8000-000000000003', verdict: 'approve' },
              ] },
            ...completed.report,
          } };
        }
        return completed.kind === 'completed' ? { ...completed, attemptId: completed.attemptId ?? attemptId } : completed;
      },
    },
    proof: {
      admitReport: async ({ checkedChange, proofId, report }) => {
        events.push('proof:admission');
        checkedChangePayloads.push(capabilities.verifyAndRead(checkedChange).payload);
        if (options.proofError) throw options.proofError;
        if (options.proofReject) throw new Error('proof rejected');
        const result = await (options.proof?.(checkedChange) ?? passedProof());
        if (options.proofMutatesWorktreeOnce) {
          options.proofMutatesWorktreeOnce = false;
          await writeFile(join(worktreePath, 'feature.txt'), 'post-proof drift\n');
        }
        return result.status === 'passed' ? { ...result, receipt: { ...result.receipt, proofId } } : result;
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
    attemptResultPath: ({ attemptId }) => join(targetRoot, '.attempt-results', `${attemptId}-report.json`),
    now: () => '2026-07-16T12:00:00.000Z',
    signal: options.signal,
  };
  return {
    runner: new RunIssue(dependencies), dependencies, capabilities, options, targetRoot, remoteRoot, worktreePath, baseSha, statePath,
    events, evidence, store: rawStore, comments, implementationAuthorities,
    candidateAuthorityHashes, checkedChangePayloads,
    implementationAttemptIds,
    setIssueState: (state: 'OPEN' | 'CLOSED') => { issueState = state; },
  };
}

function enableFeedbackPublication(fixture: Awaited<ReturnType<typeof runFixture>>): void {
  const comments: Array<{ id: string; body: string }> = [];
  fixture.dependencies.pullRequests.findOpen = async () => {
    const record = (await fixture.store.read()).runs[0]!;
    return {
      url: 'https://example.invalid/pull/1', body: `<!-- codex-orchestrator:run:${record.runId}:pr -->`,
      number: 1, nodeId: 'PR_1', headRefName: record.branchName, baseRefName: 'main',
      headSha: (await fixture.dependencies.git.getRemoteBranchSha(fixture.worktreePath, record.branchName))!,
    };
  };
  fixture.dependencies.pullRequests.listConversationComments = async () => structuredClone(comments);
  fixture.dependencies.pullRequests.postConversationComment = async (_number, body) => {
    const comment = { id: String(comments.length + 1), body };
    comments.push(comment);
    return comment;
  };
}

async function prepareActiveIssueFeedback(fixture: Awaited<ReturnType<typeof runFixture>>, sourceId = 'issue-comment:terminal'): Promise<void> {
  const initial = await fixture.runner.runIssue({ targetRoot: fixture.targetRoot, issueNumber: 42 });
  assert.equal(initial.status, 'review-ready', JSON.stringify({ result: initial, evidence: fixture.evidence }));
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
      sourceId, kind: 'issue-comment', sourceUrl: 'https://example.invalid/issues/42#terminal',
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
        if (!candidateReleaseRejected && ((options.candidateReleaseFailBeforeCommitOnce && events.includes('proof:admission'))
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


test('merged published PR retains successful handoff without reopening review or implementation', async () => {
  const fixture = await runFixture();
  const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
  const initial = await fixture.runner.runIssue(input);
  assert.equal(initial.status, 'review-ready', JSON.stringify({ initial, evidence: fixture.evidence }));
  enableFeedbackPublication(fixture);
  const record = (await fixture.store.read()).runs[0]!;
  const published = await fixture.dependencies.pullRequests.findOpen({ headBranch: record.branchName, baseBranch: 'main' });
  const events = [...fixture.events];
  fixture.dependencies.pullRequests.findOpen = async () => undefined;
  Object.assign(fixture.dependencies.pullRequests, { findMerged: async () => published });
  fixture.dependencies.reviewFeedback = {
    observeAndFreeze: async () => { throw new Error('merged PR must not enter review feedback'); },
  } as unknown as ReviewFeedbackObserver;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await new RunIssue(fixture.dependencies).runIssue(input), initial);
    assert.equal((await fixture.store.read()).runs[0]!.terminalOutcome!.status, 'review-ready');
  }
  assert.equal(fixture.events.filter(event => event === 'agent:implementation').length,
    events.filter(event => event === 'agent:implementation').length);
});


test('merge during feedback observation retains handoff and mismatched merged PR fails closed', async (t) => {
  for (const mismatch of [false, true]) await t.test(mismatch ? 'foreign handoff' : 'merge race', async () => {
    const fixture = await runFixture();
    const input = { targetRoot: fixture.targetRoot, issueNumber: 42 };
    const initial = await fixture.runner.runIssue(input);
    assert.equal(initial.status, 'review-ready');
    enableFeedbackPublication(fixture);
    let merged = false;
    const published = await fixture.dependencies.pullRequests.findOpen({ headBranch: 'codex/issue-42', baseBranch: 'main' });
    Object.assign(fixture.dependencies.pullRequests, {
      findMerged: async () => merged ? { ...published, ...(mismatch ? { headSha: 'f'.repeat(40) } : {}) } : undefined,
    });
    fixture.dependencies.reviewFeedback = {
      observeAndFreeze: async () => { merged = true; return { status: 'blocked', reason: 'PR is no longer open' }; },
    } as unknown as ReviewFeedbackObserver;
    const result = await new RunIssue(fixture.dependencies).runIssue(input);
    if (mismatch) assert.deepEqual(pick(result, ['status', 'kind', 'resumable']), { status: 'blocked', kind: 'safety', resumable: false });
    else assert.deepEqual(result, initial);
  });
});
