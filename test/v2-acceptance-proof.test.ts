import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AcceptanceProof,
  ProofLaunchAuthorizationError,
  type FrozenCriterion,
  type IosProofInputsV1,
  type IssueSnapshot,
  type ProofAgent,
  type ProofAgentResult,
} from '../src/v2/acceptance-proof.js';
import {
  checkedChangeFreshnessMatches,
  createCheckedChangeCapabilities,
  type CheckedChange,
  type CheckedChangeFreshness,
  type CheckedChangePayloadV1,
  type CheckedChangePayloadV2,
} from '../src/v2/checked-change.js';
import type { CandidateBindingV2 } from '../src/v2/candidate.js';
import { InMemoryProofRecordWriter } from '../src/v2/proof-store.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import type { ProofReportV1 } from '../src/v2/proof-report.js';
import type { AndroidLeaseVerifier } from '../src/v2/mobile-lease.js';

const artifactBytes = Buffer.from('proof evidence\n');

test('CheckedChange is nominal at compile time and rejects forged runtime objects', () => {
  // @ts-expect-error CheckedChange has a module-private nominal brand.
  const compileTimeForgery: CheckedChange = {};
  void compileTimeForgery;

  const capabilities = createCheckedChangeCapabilities();
  const checked = capabilities.mint(checkedPayload());
  assert.equal(capabilities.verifyAndRead(checked).payload.headSha, 'b'.repeat(40));
  assert.throws(() => capabilities.verifyAndRead(checkedPayload() as unknown as CheckedChange), /not minted/u);
  const legacyFailure = {
    ...checkedPayload(),
    checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'unchanged-failure', outputSha256: 'a'.repeat(64) }],
  };
  assert.throws(() => capabilities.mint(legacyFailure as unknown as CheckedChangePayloadV1), /status must be passed/u);
});

test('CheckedChange V2 binds every receipt and changed path to one candidate while V1 remains index-based', () => {
  const capabilities = createCheckedChangeCapabilities();
  const binding: CandidateBindingV2 = {
    version: 2,
    bindingId: '1'.repeat(64),
    expectedHeadSha: 'a'.repeat(40),
    candidateRef: `refs/codex-orchestrator/candidates/00000000-0000-4000-8000-000000000001/${'1'.repeat(64)}`,
    candidateCommitSha: 'b'.repeat(40),
    candidateTreeSha: 'c'.repeat(40),
    canonicalChangedFiles: ['src/a.ts'],
    sourceWorktreeIdentity: '2'.repeat(64),
  };
  const payload: CheckedChangePayloadV2 = {
    version: 2,
    canonicalRepository: 'owner/repo',
    runId: '00000000-0000-4000-8000-000000000001',
    issueNumber: 1,
    cycle: 1,
    baseSha: 'a'.repeat(40),
    binding,
    changedFiles: ['src/a.ts'],
    checks: [{
      id: 'typecheck', command: 'npm run typecheck', status: 'passed', outputSha256: '3'.repeat(64),
      bindingId: binding.bindingId, candidateTreeSha: binding.candidateTreeSha, checkPolicySha256: '4'.repeat(64),
    }],
    checkPolicySha256: '4'.repeat(64),
    packageVersion: '2.0.10',
    proofSchemaVersion: 1,
  };

  assert.deepEqual(capabilities.verifyAndRead(capabilities.mint(payload)).payload, payload);
  assert.equal(checkedChangeFreshnessMatches(payload, {
    bindingId: binding.bindingId,
    candidateTreeSha: binding.candidateTreeSha,
    checkPolicySha256: payload.checkPolicySha256,
  }), true);
  assert.equal(checkedChangeFreshnessMatches(payload, {
    bindingId: binding.bindingId,
    candidateTreeSha: 'd'.repeat(40),
    checkPolicySha256: payload.checkPolicySha256,
  }), false);
  assert.throws(() => capabilities.mint({
    ...payload,
    binding: { ...binding, candidateRef: `refs/codex-orchestrator/candidates/00000000-0000-4000-8000-000000000002/${binding.bindingId}` },
  }), /not derived/u);
  assert.throws(() => capabilities.mint({
    ...payload,
    binding: { ...binding, candidateRef: `refs/codex-orchestrator/candidates/${payload.runId}/${'9'.repeat(64)}` },
  }), /not derived/u);

  const legacy = checkedPayload();
  assert.equal(checkedChangeFreshnessMatches(legacy, freshness(legacy)), true);
  assert.equal(checkedChangeFreshnessMatches(legacy, { ...freshness(legacy), indexTreeSha: 'f'.repeat(40) }), false);
});

test('identical proof binding reuses one passed attempt while mismatch fails before process launch', async () => {
  const fixture = proofFixture();
  const iosProofInputs = iosInputs();
  const first = await fixture.proof.proveChange(fixture.input({ iosProofInputs }));
  const repeated = await fixture.proof.proveChange(fixture.input({ iosProofInputs }));
  const mismatched = await fixture.proof.proveChange(fixture.input({
    iosProofInputs: { ...iosProofInputs, runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0' },
  }));

  assert.equal(first.status, 'passed');
  assert.deepEqual(repeated, first);
  assert.equal(mismatched.status, 'internal-error');
  assert.equal(fixture.agentCalls.length, 1);
  assert.equal(fixture.freshnessCalls.length, 3);
});

test('a restarted runner recovers the exact launched proof before a later replacement', async () => {
  let calls = 0;
  const fixture = proofFixture({ agentRun: async (input) => {
    calls += 1;
    const prior = await input.invocationState!.read();
    if (prior) {
      assert.equal(await input.invocationState!.compareAndSwap(prior, undefined), true);
      return { kind: 'deferred', code: 'report-operation-output-unavailable' };
    }
    if (calls === 1) {
      assert.equal(await input.invocationState!.compareAndSwap(undefined, {
        version: 1, operation: 'acceptance-proof', attemptId: 'attempt-1',
        generationHash: 'a'.repeat(64), promptFactsSha256: 'b'.repeat(64), reportPath: '/tmp/attempt-1-report.json',
        phase: 'launched', host: 'host', bootId: 'boot', preparedAt: '2026-07-16T12:00:00.000Z',
        launchedAt: '2026-07-16T12:00:01.000Z', pid: 4242, processStartIdentity: 'start-4242', processGroupId: 4242,
        baseline: { headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
          untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'proof-worktree' },
      }), true);
      return { kind: 'deferred', code: 'report-operation-process-active-or-uncertain' };
    }
    return { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath()],
      proofPhaseArtifactSha256: { [artifactPath()]: sha256(artifactBytes) } };
  } });

  assert.equal((await fixture.proof.proveChange(fixture.input({ iosProofInputs: iosInputs() }))).status, 'transport-failed');
  const launchedBinding = (await fixture.writer.read('proof-1'))!.bindingSha256;
  assert.equal((await fixture.proof.proveChange(fixture.input({
    iosProofInputs: { ...iosInputs(), ownerPid: 4343 },
  }))).status, 'transport-failed');
  const recovered = await fixture.writer.read('proof-1');
  assert.equal(recovered?.invocation, undefined);
  assert.equal(recovered?.iosProofInputs?.ownerPid, 4242);
  assert.equal(recovered?.bindingSha256, launchedBinding);
  assert.equal(calls, 2);
  assert.equal((await fixture.proof.proveChange(fixture.input({
    iosProofInputs: { ...iosInputs(), ownerPid: 4444 },
  }))).status, 'passed');
  assert.equal((await fixture.writer.read('proof-1'))?.iosProofInputs?.ownerPid, 4444);
  assert.equal((await fixture.writer.read('proof-1'))?.bindingSha256, launchedBinding);
  assert.equal(calls, 3);
  assert.deepEqual(fixture.agentCalls.map((call) => (call as { iosProofInputs: IosProofInputsV1 }).iosProofInputs.ownerPid),
    [4242, 4242, 4444]);
});

test('proof launch authorization waits for exact active invocation settlement before lease release', async () => {
  let absent = false;
  let launches = 0;
  let observations = 0;
  let releases = 0;
  const fixture = proofFixture({
    androidLease: { verify: async () => {}, release: async () => { releases += 1; } },
    agentRun: async (input) => {
      const prior = await input.invocationState!.read();
      if (prior) {
        observations += 1;
        if (absent) assert.equal(await input.invocationState!.compareAndSwap(prior, undefined), true);
        return { kind: 'deferred', code: absent
          ? 'report-operation-output-unavailable' : 'report-operation-process-active-or-uncertain' };
      }
      await (input as typeof input & { beforeLaunch?: () => Promise<void> }).beforeLaunch?.();
      launches += 1;
      assert.equal(await input.invocationState!.compareAndSwap(undefined, {
        version: 1, operation: 'acceptance-proof', attemptId: `attempt-${launches}`,
        generationHash: 'a'.repeat(64), promptFactsSha256: 'b'.repeat(64), reportPath: `/tmp/attempt-${launches}.json`,
        phase: 'launched', host: 'host', bootId: 'boot', preparedAt: '2026-07-16T12:00:00.000Z',
        launchedAt: '2026-07-16T12:00:01.000Z', pid: 4242, processStartIdentity: 'start-4242', processGroupId: 4242,
        baseline: { headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
          untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'proof-worktree' },
      }), true);
      return { kind: 'deferred', code: 'report-operation-process-active-or-uncertain' };
    },
  });
  const allowed = async () => {};
  const revoked = async () => { throw new ProofLaunchAuthorizationError({ status: 'blocked' }); };

  assert.equal((await fixture.proof.proveChange(fixture.input({ iosProofInputs: iosInputs(), beforeAgentLaunch: allowed }))).status, 'transport-failed');
  assert.equal((await fixture.proof.proveChange(fixture.input({ iosProofInputs: { ...iosInputs(), ownerPid: 4343 }, beforeAgentLaunch: revoked }))).status, 'transport-failed');
  assert.equal(releases, 0);
  assert.equal(launches, 1);
  assert.equal(observations, 1);
  absent = true;
  assert.equal((await fixture.proof.proveChange(fixture.input({ iosProofInputs: { ...iosInputs(), ownerPid: 4343 }, beforeAgentLaunch: revoked }))).status, 'transport-failed');
  assert.equal((await fixture.writer.read('proof-1'))?.invocation, undefined);
  assert.equal(releases, 0);
  await assert.rejects(fixture.proof.proveChange(fixture.input({
    iosProofInputs: { ...iosInputs(), ownerPid: 4444 }, beforeAgentLaunch: revoked,
  })), ProofLaunchAuthorizationError);
  assert.equal(releases, 1);
  assert.equal(launches, 1);
  assert.equal(observations, 2);
});

test('active proof recovery precedes freshness and cancellation settlement', async () => {
  const controller = new AbortController();
  let fresh = true;
  let absent = false;
  let observations = 0;
  let launches = 0;
  let releases = 0;
  const fixture = proofFixture({
    signal: controller.signal,
    inspectFreshness: async (payload) => fresh
      ? freshness(payload)
      : { ...freshness(payload), headSha: 'f'.repeat(40) },
    androidLease: { verify: async () => {}, release: async () => { releases += 1; } },
    agentRun: async (input) => {
      const prior = await input.invocationState!.read();
      if (prior) {
        observations += 1;
        if (absent) assert.equal(await input.invocationState!.compareAndSwap(prior, undefined), true);
        return { kind: 'deferred', code: absent
          ? 'report-operation-output-unavailable' : 'report-operation-process-active-or-uncertain' };
      }
      launches += 1;
      assert.equal(await input.invocationState!.compareAndSwap(undefined, {
        version: 1, operation: 'acceptance-proof', attemptId: 'attempt-active',
        generationHash: 'a'.repeat(64), promptFactsSha256: 'b'.repeat(64), reportPath: '/tmp/attempt-active.json',
        phase: 'launched', host: 'host', bootId: 'boot', preparedAt: '2026-07-16T12:00:00.000Z',
        launchedAt: '2026-07-16T12:00:01.000Z', pid: 4242, processStartIdentity: 'start-4242', processGroupId: 4242,
        baseline: { headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
          untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'proof-worktree' },
      }), true);
      return { kind: 'deferred', code: 'report-operation-process-active-or-uncertain' };
    },
  });

  assert.equal((await fixture.proof.proveChange(fixture.input({ iosProofInputs: iosInputs() }))).status, 'transport-failed');
  assert.equal((await fixture.writer.read('proof-1'))?.invocation?.attemptId, 'attempt-active');
  fresh = false;
  controller.abort();
  const unresolved = await fixture.proof.proveChange(fixture.input({ iosProofInputs: iosInputs() }));
  assert.equal(unresolved.status, 'transport-failed', JSON.stringify(unresolved));
  assert.equal((await fixture.writer.read('proof-1'))?.invocation?.attemptId, 'attempt-active');
  assert.equal(releases, 0);
  absent = true;
  assert.equal((await fixture.proof.proveChange(fixture.input({ iosProofInputs: iosInputs() }))).status, 'transport-failed');
  assert.equal((await fixture.writer.read('proof-1'))?.invocation, undefined);
  assert.equal(releases, 0);
  assert.equal((await fixture.proof.proveChange(fixture.input({ iosProofInputs: iosInputs() }))).status, 'internal-error');
  assert.equal((await fixture.writer.read('proof-1'))?.status, 'internal-error');
  assert.equal(launches, 1);
  assert.equal(observations, 2);
  assert.equal(releases, 1);
});

test('stale HEAD/index/tracked/untracked/worktree/check-policy fails before proof effects', async () => {
  for (const field of [
    'headSha',
    'indexTreeSha',
    'trackedContentSha256',
    'untrackedContentSha256',
    'worktreeIdentity',
    'checkPolicySha256',
  ] as const) {
    const fixture = proofFixture({
      inspectFreshness: async (payload) => ({ ...freshness(payload), [field]: `stale-${field}` }),
    });
    const result = await fixture.proof.proveChange(fixture.input());
    assert.equal(result.status, 'internal-error', field);
    assert.equal(fixture.agentCalls.length, 0, field);
  }
});

test('freshness is rechecked after proof and stale checked input cannot be accepted as passed', async () => {
  let calls = 0;
  const fixture = proofFixture({
    inspectFreshness: async (payload) => {
      calls += 1;
      return calls === 1 ? freshness(payload) : { ...freshness(payload), headSha: 'f'.repeat(40) };
    },
  });
  const result = await fixture.proof.proveChange(fixture.input());
  assert.equal(result.status, 'internal-error');
  assert.equal(fixture.agentCalls.length, 1);
});

test('malformed report, rewritten criteria, raw path escape, and forbidden proof diff fail closed', async () => {
  const cases: Array<{ name: string; agentResult: ProofAgentResult; repairable?: boolean }> = [
    { name: 'malformed', repairable: true, agentResult: { kind: 'report', report: { status: 'passed' }, proofPhaseChangedFiles: [] } },
    {
      name: 'criterion coverage',
      repairable: true,
      agentResult: { kind: 'report', report: passingReport({ criterionId: 'rewritten-id' }), proofPhaseChangedFiles: [artifactPath()] },
    },
    {
      name: 'raw path',
      repairable: true,
      agentResult: {
        kind: 'report',
        report: passingReport({ artifactRelativePath: '../outside.txt' }),
        proofPhaseChangedFiles: ['../outside.txt'],
      },
    },
    {
      name: 'forbidden diff',
      agentResult: { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath(), 'src/product.ts'] },
    },
  ];
  for (const entry of cases) {
    const fixture = proofFixture({ agentResult: entry.agentResult });
    if (entry.repairable) assert.equal((await fixture.proof.proveChange(fixture.input())).status, 'transport-failed', entry.name);
    const result = await fixture.proof.proveChange(fixture.input());
    assert.equal(result.status, 'internal-error', entry.name);
  }
});

test('proof reports cannot forge completed checks and use only CheckedChange check evidence', async () => {
  const forged = passingReport() as ProofReportV1 & { checks: unknown[] };
  forged.checks = [{
    id: 'forged', command: 'true', status: 'passed', summary: 'not runner-owned', outputSha256: 'a'.repeat(64),
  }];
  forged.criteria[0]!.evidenceRefs = ['forged'];
  const rejected = proofFixture({
    agentResult: { kind: 'report', report: forged, proofPhaseChangedFiles: [artifactPath()] },
  });
  assert.equal((await rejected.proof.proveChange(rejected.input())).status, 'transport-failed');
  assert.equal((await rejected.proof.proveChange(rejected.input())).status, 'internal-error');

  const trusted = passingReport();
  trusted.criteria[0]!.evidenceRefs = ['typecheck'];
  const accepted = proofFixture({
    agentResult: { kind: 'report', report: trusted, proofPhaseChangedFiles: [artifactPath()] },
  });
  assert.equal((await accepted.proof.proveChange(accepted.input())).status, 'passed');
});

test('host identity filtering applies only to publishable artifacts', async () => {
  const localBytes = Buffer.from('Configured command: /Users/example/bin/node --version\n');
  const localReport = passingReport({
    artifactContent: localBytes,
    artifactKind: 'static-inspection',
    publishable: false,
  });
  const local = proofFixture({
    artifactContent: localBytes,
    agentResult: { kind: 'report', report: localReport, proofPhaseChangedFiles: [artifactPath()] },
  });
  assert.equal((await local.proof.proveChange(local.input())).status, 'passed');

  const publishableReport = passingReport({ artifactContent: localBytes });
  const publishable = proofFixture({
    artifactContent: localBytes,
    agentResult: { kind: 'report', report: publishableReport, proofPhaseChangedFiles: [artifactPath()] },
  });
  assert.equal((await publishable.proof.proveChange(publishable.input())).status, 'internal-error');
});

test('malformed output spends one durable repair while infrastructure spends none', async () => {
  const malformed = proofFixture({
    agentResults: [
      {
        kind: 'report',
        report: {
          ...passingReport(),
          artifacts: passingReport().artifacts.map((artifact) => ({ ...artifact, kind: 'command-output' as const })),
        },
        proofPhaseChangedFiles: [artifactPath()],
      },
      { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath()] },
    ],
  });
  assert.equal((await malformed.proof.proveChange(malformed.input())).status, 'transport-failed');
  assert.equal((await malformed.proof.proveChange(malformed.input())).status, 'passed');
  assert.equal(malformed.agentCalls.length, 2);
  const repairCall = malformed.agentCalls[1] as { repairOnly: boolean; repairFindings: string[] };
  assert.equal(repairCall.repairOnly, true);
  assert.match(repairCall.repairFindings[0] ?? '', /only screenshots or sanitized generated summaries may be publishable/u);
  assert.equal((await malformed.writer.read('proof-1'))?.reportRepairs, 1);

  const transport = proofFixture({
    agentResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath()] },
    ],
  });
  let launchAuthorizations = 0;
  assert.equal((await transport.proof.proveChange(transport.input({
    beforeAgentLaunch: async () => { launchAuthorizations += 1; },
  }))).status, 'transport-failed');
  assert.equal((await transport.proof.proveChange(transport.input({
    beforeAgentLaunch: async () => { launchAuthorizations += 1; },
  }))).status, 'passed');
  assert.equal(transport.agentCalls.length, 2);
  assert.equal(launchAuthorizations, 2);
  assert.equal((await transport.writer.read('proof-1'))?.reportRepairs, 0);

  let revokedReleaseCalls = 0;
  const revoked = proofFixture({
    agentResults: [
      { kind: 'transport-failed', resumable: true },
      { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath()] },
    ],
    androidLease: {
      verify: async () => {},
      release: async () => { revokedReleaseCalls += 1; },
    },
  });
  let authorizationAttempt = 0;
  assert.equal((await revoked.proof.proveChange(revoked.input({
    beforeAgentLaunch: async () => { authorizationAttempt += 1; },
  }))).status, 'transport-failed');
  await assert.rejects(revoked.proof.proveChange(revoked.input({
    beforeAgentLaunch: async () => {
      authorizationAttempt += 1;
      if (authorizationAttempt === 2) throw new ProofLaunchAuthorizationError({ status: 'blocked' });
    },
  })), ProofLaunchAuthorizationError);
  assert.equal(revoked.agentCalls.length, 2);
  assert.equal(revokedReleaseCalls, 1);
});

test('report-only proof repair preserves the complete pre-repair artifact inventory across recovery and replay', async () => {
  for (const adversary of ['modify', 'manufacture'] as const) {
    const original = { [artifactPath()]: sha256(artifactBytes) };
    const afterRepair = adversary === 'modify'
      ? { [artifactPath()]: sha256(Buffer.from('mutated evidence\n')) }
      : { ...original, 'proofs/proof-1/manufactured.txt': sha256(Buffer.from('manufactured\n')) };
    const fixture = proofFixture({
      agentResults: [
        Object.assign({ kind: 'report', report: { status: 'passed' }, proofPhaseChangedFiles: [] } as ProofAgentResult,
          { proofPhaseArtifactSha256: original }),
        Object.assign({ kind: 'report', report: passingReport(), proofPhaseChangedFiles: [] } as ProofAgentResult,
          { proofPhaseArtifactSha256: afterRepair }),
      ],
    });

    assert.equal((await fixture.proof.proveChange(fixture.input())).status, 'transport-failed', adversary);
    const prepared = await fixture.writer.read('proof-1');
    assert.deepEqual((prepared as unknown as { repairArtifactSha256?: unknown }).repairArtifactSha256, original, adversary);
    assert.equal((await fixture.proof.proveChange(fixture.input())).status, 'internal-error', adversary);
    assert.equal((await fixture.proof.proveChange(fixture.input())).status, 'internal-error', `${adversary} replay`);
    assert.equal(fixture.agentCalls.length, 2, `${adversary} duplicate repair launch`);
  }

  const interrupted = proofFixture({
    agentResults: [
      Object.assign({ kind: 'report', report: { status: 'passed' }, proofPhaseChangedFiles: [] } as ProofAgentResult,
        { proofPhaseArtifactSha256: { [artifactPath()]: sha256(artifactBytes) } }),
      { kind: 'internal-error', code: 'proof-report-repair-artifact-drift' } as ProofAgentResult,
    ],
  });
  assert.equal((await interrupted.proof.proveChange(interrupted.input())).status, 'transport-failed');
  assert.equal((await interrupted.proof.proveChange(interrupted.input())).status, 'internal-error');
  assert.match((await interrupted.writer.read('proof-1'))?.receipt?.summary ?? '', /report repair modified proof artifacts/iu);
  assert.equal((await interrupted.proof.proveChange(interrupted.input())).status, 'internal-error');
  assert.equal(interrupted.agentCalls.length, 2);
});

test('passed proof returns a sanitized receipt and persists no run lifecycle capability', async () => {
  const fixture = proofFixture();
  const result = await fixture.proof.proveChange(fixture.input());
  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') return;
  assert.deepEqual(Object.keys(result.receipt).sort(), [
    'bindingSha256',
    'localEvidenceId',
    'proofId',
    'publishableEvidence',
    'summary',
  ]);
  assert.equal(JSON.stringify(result.receipt).includes('.codex-orchestrator'), false);
  assert.equal(result.receipt.publishableEvidence[0]?.ref, 'artifact:evidence');
  const state = await fixture.writer.read('proof-1');
  assert.equal(state?.status, 'passed');
  assert.equal('lifecycle' in (state ?? {}), false);
  assert.equal('cycle' in (state ?? {}), false);
  assert.equal('intent' in (state ?? {}), false);
});

test('passed receipt stays monotonic while lease cleanup retries without relaunch', async () => {
  let releases = 0;
  const fixture = proofFixture({ androidLease: {
    verify: async () => {},
    release: async () => { releases += 1; if (releases === 1) throw new Error('cleanup fault'); },
  } });
  assert.equal((await fixture.proof.proveChange(fixture.input())).status, 'transport-failed');
  assert.equal((await fixture.writer.read('proof-1'))?.status, 'passed');
  assert.equal((await fixture.proof.proveChange(fixture.input())).status, 'passed');
  assert.equal(fixture.agentCalls.length, 1);
  assert.equal(releases, 2);
});

test('proof infrastructure deferral preserves ownership and semantic budget', async () => {
  const fixture = proofFixture({
    agentResult: { kind: 'deferred', code: 'proof-process-active-or-uncertain' },
  });
  assert.equal((await fixture.proof.proveChange(fixture.input())).status, 'transport-failed');
  assert.equal((await fixture.writer.read('proof-1'))?.reportRepairs, 0);
});

test('durable report repair context is reconstructed on the following invocation', async () => {
  const malformed = { kind: 'report' as const, report: { version: 1 }, proofPhaseChangedFiles: [] };
  const fixture = proofFixture({
    agentResults: [malformed, { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath()] }],
  });
  assert.equal((await fixture.proof.proveChange(fixture.input())).status, 'transport-failed');
  const result = await fixture.proof.proveChange(fixture.input());
  assert.equal(result.status, 'passed');
  assert.equal((fixture.agentCalls[1] as { repairOnly: boolean }).repairOnly, true);
});

test('needs-rework, external-block, transport, cancellation, and internal agent outcomes remain typed', async () => {
  const cases: Array<{ result: ProofAgentResult; expected: string }> = [
    {
      result: {
        kind: 'report',
        report: {
          ...passingReport(),
          status: 'needs-rework',
          criteria: [{ ...passingReport().criteria[0]!, status: 'failed', confidence: 'medium' }],
          findings: ['Behavior is incomplete.'],
        },
        proofPhaseChangedFiles: [artifactPath()],
      },
      expected: 'needs-rework',
    },
    {
      result: {
        kind: 'report',
        report: {
          ...passingReport(),
          status: 'external-block',
          criteria: [{ ...passingReport().criteria[0]!, status: 'unknown', confidence: 'low', evidenceRefs: [] }],
          blocker: { kind: 'service', summary: 'Fixture unavailable.', attempted: ['retry fixture'] },
        },
        proofPhaseChangedFiles: [artifactPath()],
      },
      expected: 'external-block',
    },
    { result: { kind: 'transport-failed', resumable: true }, expected: 'transport-failed' },
    { result: { kind: 'cancelled' }, expected: 'cancelled' },
    { result: { kind: 'internal-error' }, expected: 'internal-error' },
  ];
  for (const entry of cases) {
    const fixture = proofFixture({ agentResult: entry.result });
    const outcome = await fixture.proof.proveChange(fixture.input());
    assert.equal(outcome.status, entry.expected);
    assert.deepEqual(Object.keys(outcome).includes('receipt'), true);
  }
});

function proofFixture(options: {
  agentResult?: ProofAgentResult;
  agentResults?: ProofAgentResult[];
  artifactContent?: Buffer;
  inspectFreshness?: (payload: CheckedChangePayloadV1) => Promise<CheckedChangeFreshness>;
  androidLease?: AndroidLeaseVerifier;
  agentError?: Error;
  agentRun?: ProofAgent['run'];
  signal?: AbortSignal;
} = {}) {
  const capabilities = createCheckedChangeCapabilities();
  const payload = checkedPayload();
  const checkedChange = capabilities.mint(payload);
  const writer = new InMemoryProofRecordWriter();
  const agentCalls: unknown[] = [];
  const freshnessCalls: CheckedChangePayloadV1[] = [];
  const criteria: FrozenCriterion[] = [{ id: 'ac-001', order: 1, source: 'explicit', text: 'The behavior works.' }];
  const issue: IssueSnapshot = {
    number: 42,
    title: 'Implement behavior',
    body: '## Acceptance Criteria\n- The behavior works.',
    url: 'https://example.invalid/issues/42',
    state: 'OPEN',
    labels: ['agent:auto'],
  };
  const inspectFreshness = options.inspectFreshness ?? (async (value: CheckedChangePayloadV1) => freshness(value));
  const proof = new AcceptanceProof({
    checkedChangeReader: capabilities,
    proofRecords: writer,
    proofAgent: {
      run: async (input) => {
        agentCalls.push(input);
        if (options.agentError) throw options.agentError;
        if (options.agentRun) return options.agentRun(input);
        await input.beforeLaunch?.();
        const result = options.agentResults?.shift() ?? options.agentResult
          ?? { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath()] };
        return result.kind === 'report' && !result.proofPhaseArtifactSha256
          ? { ...result, proofPhaseArtifactSha256: { [artifactPath()]: sha256(options.artifactContent ?? artifactBytes) } }
          : result;
      },
    },
    inspectFreshness: async (value) => {
      if (value.version !== 1) throw new Error('legacy fixture received V2 payload');
      freshnessCalls.push(value);
      return inspectFreshness(value);
    },
    readArtifact: async (relativePath) => {
      if (relativePath !== artifactPath()) throw new Error('artifact missing');
      return options.artifactContent ?? artifactBytes;
    },
    proofArtifactDir: 'proofs/proof-1',
    now: () => '2026-07-16T12:00:00.000Z',
    androidLease: options.androidLease,
    signal: options.signal,
  });
  return {
    proof,
    writer,
    agentCalls,
    freshnessCalls,
    criteria,
    input: (overrides: Partial<{
      proofId: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      checkedChange: CheckedChange;
      beforeAgentLaunch: () => Promise<void>;
      iosProofInputs: IosProofInputsV1;
    }> = {}) => ({ proofId: 'proof-1', issue, frozenCriteria: criteria, checkedChange, ...overrides }),
  };
}

function iosInputs(): IosProofInputsV1 {
  return {
    helperPath: '/immutable/skills/acceptance-proof/tools/ios-lease.mjs',
    leaseRoot: '/orchestrator/v2/repository/leases',
    leaseArtifactPath: '/worktree/proofs/proof-1/ios-lease.json', proofId: 'proof-1', ownerPid: 4242,
    xcrunPath: '/usr/bin/xcrun', runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
    deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
  };
}

function checkedPayload(): CheckedChangePayloadV1 {
  return {
    version: 1,
    canonicalRepository: 'owner/repo',
    runId: '00000000-0000-4000-8000-000000000001',
    issueNumber: 42,
    cycle: 1,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    indexTreeSha: 'c'.repeat(40),
    trackedContentSha256: 'd'.repeat(64),
    untrackedContentSha256: 'e'.repeat(64),
    worktreeIdentity: 'worktree-identity',
    changedFiles: ['src/feature.ts'],
    checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'passed', outputSha256: 'f'.repeat(64) }],
    checkPolicySha256: '1'.repeat(64),
    packageVersion: '0.1.51',
    proofSchemaVersion: 1,
  };
}

function freshness(payload: CheckedChangePayloadV1): CheckedChangeFreshness {
  return {
    headSha: payload.headSha,
    indexTreeSha: payload.indexTreeSha,
    trackedContentSha256: payload.trackedContentSha256,
    untrackedContentSha256: payload.untrackedContentSha256,
    worktreeIdentity: payload.worktreeIdentity,
    checkPolicySha256: payload.checkPolicySha256,
  };
}

function artifactPath(): string {
  return 'proofs/proof-1/evidence.txt';
}

function passingReport(overrides: {
  criterionId?: string;
  artifactRelativePath?: string;
  artifactContent?: Buffer;
  artifactKind?: ProofReportV1['artifacts'][number]['kind'];
  publishable?: boolean;
} = {}): ProofReportV1 {
  const artifactRelativePath = overrides.artifactRelativePath ?? artifactPath();
  const content = overrides.artifactContent ?? artifactBytes;
  return {
    version: 1,
    status: 'passed',
    decision: { mode: 'non-visual', targets: [] },
    criteria: [{
      id: overrides.criterionId ?? 'ac-001',
      status: 'passed',
      confidence: 'high',
      surfaces: ['non-visual'],
      evidenceRefs: ['artifact:evidence'],
      analysis: 'The artifact proves the behavior.',
    }],
    checks: [],
    artifacts: [{
      id: 'artifact:evidence',
      kind: overrides.artifactKind ?? 'generated-file',
      relativePath: artifactRelativePath,
      sha256: sha256(content),
      publishable: overrides.publishable ?? true,
      description: 'Acceptance evidence summary.',
    }],
    findings: [],
    residualRisks: [],
  };
}

const _canonicalProofFixture = canonicalJson(passingReport());
void _canonicalProofFixture;
