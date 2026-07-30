import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AcceptanceProof,
  type FrozenCriterion,
  type IssueSnapshot,
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
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import type { ProofReceipt, ProofReportV1 } from '../src/v2/proof-report.js';
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

test('caller-owned passed receipt prevents a duplicate attempt while binding mismatch fails before launch', async () => {
  const fixture = proofFixture();
  const first = await fixture.proof.proveChange(fixture.input());
  assert.equal(first.status, 'passed');
  if (first.status !== 'passed') return;
  const repeated = await fixture.proof.proveChange(fixture.input({ passedReceipt: first.receipt }));
  const mismatched = await fixture.proof.proveChange(fixture.input({
    frozenCriteria: [{ ...fixture.criteria[0]!, text: 'Changed criterion text.' }],
    passedReceipt: first.receipt,
  }));

  assert.deepEqual(repeated, first);
  assert.equal(mismatched.status, 'internal-error');
  assert.equal(fixture.agentCalls.length, 1);
  assert.equal(fixture.freshnessCalls.length, 3);
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

test('malformed report, rewritten criteria, and unsafe report paths request one explicit caller-owned report repair', async () => {
  const cases: Array<{ name: string; agentResult: ProofAgentResult }> = [
    { name: 'malformed', agentResult: { kind: 'report', report: { status: 'passed' }, proofPhaseChangedFiles: [] } },
    {
      name: 'criterion coverage',
      agentResult: { kind: 'report', report: passingReport({ criterionId: 'rewritten-id' }), proofPhaseChangedFiles: [artifactPath()] },
    },
    {
      name: 'raw path',
      agentResult: {
        kind: 'report',
        report: passingReport({ artifactRelativePath: '../outside.txt' }),
        proofPhaseChangedFiles: ['../outside.txt'],
      },
    },
  ];
  for (const entry of cases) {
    const fixture = proofFixture({ agentResult: entry.agentResult });
    const result = await fixture.proof.proveChange(fixture.input());
    assert.equal(result.status, 'report-repair', entry.name);
    if (result.status !== 'report-repair') continue;
    assert.equal(result.reportRepairCount, 1, entry.name);
    assert.equal(result.findings.length, 1, entry.name);
    assert.equal(fixture.agentCalls.length, 1, entry.name);
  }
});

test('forbidden proof diff fails closed without format repair', async () => {
  const cases: Array<{ name: string; agentResult: ProofAgentResult }> = [
    {
      name: 'forbidden diff',
      agentResult: { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath(), 'src/product.ts'] },
    },
  ];
  for (const entry of cases) {
    const fixture = proofFixture({ agentResult: entry.agentResult });
    assert.equal((await fixture.proof.proveChange(fixture.input())).status, 'internal-error', entry.name);
  }
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

test('report repair and transport retry are explicit caller-owned attempts with bounded counters', async () => {
  const malformed = proofFixture({
    agentResult: {
      kind: 'report',
      report: {
        ...passingReport(),
        artifacts: passingReport().artifacts.map((artifact) => ({ ...artifact, kind: 'command-output' as const })),
      },
      proofPhaseChangedFiles: [artifactPath()],
    },
  });
  const invalid = await malformed.proof.proveChange(malformed.input());
  assert.equal(invalid.status, 'report-repair');
  if (invalid.status !== 'report-repair') return;
  const repaired = proofFixture();
  assert.equal((await repaired.proof.proveChange(repaired.input({
    attemptId: 'attempt-report-repair',
    reportRepairCount: invalid.reportRepairCount,
    reportRepairFindings: invalid.findings,
  }))).status, 'passed');
  assert.equal(repaired.agentCalls.length, 1);
  const repairCall = repaired.agentCalls[0] as { repairOnly: boolean; repairFindings: string[] };
  assert.equal(repairCall.repairOnly, true);
  assert.match(repairCall.repairFindings[0] ?? '', /only screenshots or sanitized generated summaries may be publishable/u);

  const invalidRepair = proofFixture({ agentResult: {
    kind: 'report', report: { version: 1 }, proofPhaseChangedFiles: [],
  } });
  const exhaustedRepair = await invalidRepair.proof.proveChange(invalidRepair.input({
    attemptId: 'attempt-invalid-report-repair',
    reportRepairCount: 1,
    reportRepairFindings: invalid.findings,
  }));
  assert.equal(exhaustedRepair.status, 'internal-error');
  assert.equal(invalidRepair.agentCalls.length, 1);

  const transport = proofFixture({
    agentResult: { kind: 'transport-failed', resumable: true },
  });
  let launchAuthorizations = 0;
  const retryable = await transport.proof.proveChange(transport.input({
    beforeAgentLaunch: async () => { launchAuthorizations += 1; },
  }));
  assert.deepEqual(retryable, { status: 'transport-failed', resumable: true });
  assert.equal(transport.agentCalls.length, 1);
  assert.equal(launchAuthorizations, 1);

  const exhausted = proofFixture({ agentResult: { kind: 'transport-failed', resumable: true } });
  const terminal = await exhausted.proof.proveChange(exhausted.input({ transportRetryCount: 1 }));
  assert.equal(terminal.status, 'transport-failed');
  if (terminal.status === 'transport-failed') assert.equal(terminal.resumable, false);
});

test('passed proof returns only a sanitized receipt and has no hidden lifecycle dependency', async () => {
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
  assert.equal(fixture.agentCalls.length, 1);
});

test('passed receipt remains monotonic when mobile lease cleanup must be retried', async () => {
  let releaseCalls = 0;
  const fixture = proofFixture({
    androidLease: {
      verify: async () => {},
      release: async () => {
        releaseCalls += 1;
        if (releaseCalls === 1) throw new Error('cleanup pending');
      },
    },
  });
  const result = await fixture.proof.proveChange(fixture.input());
  assert.equal(result.status, 'cleanup-pending');
  if (result.status !== 'cleanup-pending') return;
  assert.equal(result.outcome.status, 'passed');
  await fixture.proof.cleanupMobileLeases('proof-1');
  assert.equal(releaseCalls, 2);
  assert.equal(result.outcome.receipt.summary, 'Acceptance proof passed.');
});

test('caller-owned passed receipt is strictly validated before reuse', async () => {
  const fixture = proofFixture();
  const forged: ProofReceipt = {
    proofId: 'proof-1', bindingSha256: '0'.repeat(64), summary: 'Passed.',
    publishableEvidence: [], localEvidenceId: 'proof:proof-1',
  };
  const result = await fixture.proof.proveChange(fixture.input({ passedReceipt: forged }));
  assert.equal(result.status, 'internal-error');
  assert.equal(fixture.agentCalls.length, 0);
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
    if (entry.expected === 'transport-failed') {
      assert.equal(outcome.status === 'transport-failed' && outcome.resumable, true);
    } else {
      assert.deepEqual(Object.keys(outcome).includes('receipt'), true);
    }
  }
});

function proofFixture(options: {
  agentResult?: ProofAgentResult;
  artifactContent?: Buffer;
  inspectFreshness?: (payload: CheckedChangePayloadV1) => Promise<CheckedChangeFreshness>;
  androidLease?: AndroidLeaseVerifier;
} = {}) {
  const capabilities = createCheckedChangeCapabilities();
  const payload = checkedPayload();
  const checkedChange = capabilities.mint(payload);
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
    proofAgent: {
      run: async (input) => {
        agentCalls.push(input);
        return options.agentResult ?? { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath()] };
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
    androidLease: options.androidLease,
  });
  return {
    proof,
    agentCalls,
    freshnessCalls,
    criteria,
    input: (overrides: Partial<{
      proofId: string;
      issue: IssueSnapshot;
      frozenCriteria: FrozenCriterion[];
      checkedChange: CheckedChange;
      beforeAgentLaunch: () => Promise<void>;
      attemptId: string;
      recoverOnly: boolean;
      proofStartedAt: string;
      transportRetryCount: number;
      reportRepairCount: number;
      reportRepairFindings: string[];
      passedReceipt: ProofReceipt;
    }> = {}) => ({
      proofId: 'proof-1',
      attemptId: 'attempt-proof',
      recoverOnly: false,
      proofStartedAt: '2026-07-16T12:00:00.000Z',
      transportRetryCount: 0,
      reportRepairCount: 0,
      reportRepairFindings: [],
      issue,
      frozenCriteria: criteria,
      checkedChange,
      ...overrides,
    }),
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
