import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AcceptanceProof,
  type FrozenCriterion,
  type IssueSnapshot,
  type ProofAgentResult,
} from '../src/v2/acceptance-proof.js';
import {
  createCheckedChangeCapabilities,
  type CheckedChange,
  type CheckedChangeFreshness,
  type CheckedChangePayloadV1,
} from '../src/v2/checked-change.js';
import { InMemoryProofRecordWriter } from '../src/v2/proof-store.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import type { ProofReportV1 } from '../src/v2/proof-report.js';

const artifactBytes = Buffer.from('proof evidence\n');

test('CheckedChange is nominal at compile time and rejects forged runtime objects', () => {
  // @ts-expect-error CheckedChange has a module-private nominal brand.
  const compileTimeForgery: CheckedChange = {};
  void compileTimeForgery;

  const capabilities = createCheckedChangeCapabilities();
  const checked = capabilities.mint(checkedPayload());
  assert.equal(capabilities.verifyAndRead(checked).payload.headSha, 'b'.repeat(40));
  assert.throws(() => capabilities.verifyAndRead(checkedPayload() as unknown as CheckedChange), /not minted/u);
});

test('identical proof binding reuses one passed attempt while mismatch fails before process launch', async () => {
  const fixture = proofFixture();
  const first = await fixture.proof.proveChange(fixture.input());
  const repeated = await fixture.proof.proveChange(fixture.input());
  const mismatched = await fixture.proof.proveChange(fixture.input({
    frozenCriteria: [{ ...fixture.criteria[0]!, text: 'Changed criterion text.' }],
  }));

  assert.equal(first.status, 'passed');
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

test('malformed report, rewritten criteria, raw path escape, and forbidden proof diff fail closed', async () => {
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
    {
      name: 'forbidden diff',
      agentResult: { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath(), 'src/product.ts'] },
    },
  ];
  for (const entry of cases) {
    const fixture = proofFixture({ agentResult: entry.agentResult });
    const result = await fixture.proof.proveChange(fixture.input());
    assert.equal(result.status, 'internal-error', entry.name);
  }
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
  inspectFreshness?: (payload: CheckedChangePayloadV1) => Promise<CheckedChangeFreshness>;
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
        return options.agentResult ?? { kind: 'report', report: passingReport(), proofPhaseChangedFiles: [artifactPath()] };
      },
    },
    inspectFreshness: async (value) => {
      freshnessCalls.push(value);
      return inspectFreshness(value);
    },
    readArtifact: async (relativePath) => {
      if (relativePath !== artifactPath()) throw new Error('artifact missing');
      return artifactBytes;
    },
    proofArtifactDir: 'proofs/proof-1',
    createAttemptId: () => 'attempt-1',
    now: () => '2026-07-16T12:00:00.000Z',
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
    }> = {}) => ({ proofId: 'proof-1', issue, frozenCriteria: criteria, checkedChange, ...overrides }),
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

function passingReport(overrides: { criterionId?: string; artifactRelativePath?: string } = {}): ProofReportV1 {
  const artifactRelativePath = overrides.artifactRelativePath ?? artifactPath();
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
      kind: 'generated-file',
      relativePath: artifactRelativePath,
      sha256: sha256(artifactBytes),
      publishable: true,
      description: 'Acceptance evidence summary.',
    }],
    findings: [],
    residualRisks: [],
  };
}

const _canonicalProofFixture = canonicalJson(passingReport());
void _canonicalProofFixture;
