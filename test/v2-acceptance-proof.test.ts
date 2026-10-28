import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcceptanceProof, CandidateProofInspectionError, type FrozenCriterion, type IssueSnapshot } from '../src/v2/acceptance-proof.js';
import { checkedChangeFreshnessMatches, createCheckedChangeCapabilities, type CheckedChange, type CheckedChangeFreshness, type CheckedChangePayloadV1, type CheckedChangePayloadV2 } from '../src/v2/checked-change.js';
import type { CandidateBindingV2 } from '../src/v2/candidate.js';
import { sha256 } from '../src/v2/containment.js';
import type { ProofReportV1 } from '../src/v2/proof-report.js';
import type { AndroidLeaseVerifier } from '../src/v2/mobile-lease.js';

const artifactBytes = Buffer.from('proof evidence\n');
const startedAt = '2026-07-16T12:00:00.000Z';

test('owner report admission is stateless and returns only a sanitized receipt', async () => {
  const fixture = proofFixture();
  const result = await fixture.proof.admitReport(fixture.input());
  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') return;
  assert.deepEqual(Object.keys(result.receipt).sort(), ['bindingSha256', 'localEvidenceId', 'proofId', 'publishableEvidence', 'summary']);
  assert.equal(result.receipt.publishableEvidence[0]?.ref, 'artifact:evidence');
  assert.deepEqual(await fixture.proof.admitReport(fixture.input()), result);
  assert.equal(fixture.freshnessCalls.length, 4);
});

test('input, inspection, report and artifact failures retain a bounded diagnostic', async () => {
  const invalid = proofFixture();
  const input = await invalid.proof.admitReport(invalid.input({ proofStartedAt: 'invalid' }));
  assert.equal(input.status, 'internal-error');
  if (input.status === 'internal-error') assert.match(input.receipt.summary, /input.*proofStartedAt/u);
  for (const [fixture, expected] of [
    [proofFixture({ inspectFreshness: async () => { throw new Error('inspection unavailable'); } }), /inspection unavailable/u],
    [proofFixture({ report: { status: 'passed' } as ProofReportV1 }), /report/u],
    [proofFixture({ artifactContent: Buffer.from('different') }), /artifact hash mismatch/u],
  ] as const) {
    const result = await fixture.proof.admitReport(fixture.input());
    assert.equal(result.status, 'internal-error');
    if (result.status === 'internal-error') assert.match(result.receipt.summary, expected);
  }
});

test('failure detail redacts sensitive text before truncation', async () => {
  for (const message of ['access_token=credential-material-12345', 'token=credential-material-12345',
    'ENOENT /Users/example/private/evidence.json', 'x'.repeat(2000) + ' password=credential-material-12345']) {
    const fixture = proofFixture({ inspectFreshness: async () => { throw new Error(message); } });
    const result = await fixture.proof.admitReport(fixture.input());
    assert.equal(result.status, 'internal-error');
    if (result.status !== 'internal-error') continue;
    assert.match(result.receipt.summary, /\[redacted\]/u);
    assert.ok(result.receipt.summary.length <= 1024);
    assert.equal(result.receipt.summary.includes('credential-material'), false);
    assert.equal(result.receipt.summary.includes('/Users/'), false);
  }
  const fixture = proofFixture({ inspectFreshness: async () => { throw new Error('unavailable\n' + 'x'.repeat(2000)); } });
  const result = await fixture.proof.admitReport(fixture.input());
  assert.equal(result.status, 'internal-error');
  if (result.status === 'internal-error') {
    assert.equal(result.receipt.summary.length, 1024);
    assert.equal(result.receipt.summary.includes('\n'), false);
  }
});

test('every stale checked field is rejected before reading evidence', async () => {
  for (const field of ['headSha', 'indexTreeSha', 'trackedContentSha256', 'untrackedContentSha256', 'worktreeIdentity', 'checkPolicySha256'] as const) {
    const fixture = proofFixture({ inspectFreshness: async (payload) => ({ ...freshness(payload), [field]: `stale-${field}` }) });
    assert.equal((await fixture.proof.admitReport(fixture.input())).status, 'internal-error', field);
    assert.equal(fixture.artifactReads.length, 0, field);
  }
});

test('candidate freshness is checked again after evidence reads', async () => {
  let calls = 0;
  const fixture = proofFixture({ inspectFreshness: async (payload) => ++calls === 1 ? freshness(payload) : { ...freshness(payload), headSha: 'f'.repeat(40) } });
  const result = await fixture.proof.admitReport(fixture.input());
  assert.equal(result.status, 'internal-error');
  assert.equal(fixture.artifactReads.length, 1);
});

test('missing reports, criterion drift and unsafe paths fail closed', async () => {
  for (const report of [undefined, { version: 1 }, passingReport({ criterionId: 'rewritten-id' }), passingReport({ artifactRelativePath: '../outside.txt' }), passingReport({ artifactRelativePath: 'proofs/other/evidence.txt' })]) {
    const fixture = proofFixture();
    assert.equal((await fixture.proof.admitReport(fixture.input({ report: report as ProofReportV1 }))).status, 'internal-error');
  }
  const fixture = proofFixture();
  assert.equal((await fixture.proof.admitReport(fixture.input({ changedArtifactPaths: [artifactPath(), 'src/product.ts'] }))).status, 'internal-error');
  assert.equal((await fixture.proof.admitReport(fixture.input({ proofId: '../outside' }))).status, 'internal-error');
});

test('declared artifact hashes, capture times, bytes and publication classes are enforced', async () => {
  for (const options of [
    { modifiedAt: '2026-07-16T11:59:59.999Z' },
    { modifiedAt: 'invalid' },
    { metadataUnavailable: true },
    { artifactContent: Buffer.alloc(0), report: passingReport({ artifactContent: Buffer.alloc(0) }) },
    { artifactContent: Buffer.from([0xff]), report: passingReport({ artifactContent: Buffer.from([0xff]) }) },
    { artifactContent: Buffer.from('password=credential-material-12345'), report: passingReport({ artifactContent: Buffer.from('password=credential-material-12345') }) },
    { report: passingReport({ artifactKind: 'command-output', publishable: true }) },
    { report: passingReport({ artifactKind: 'screenshot' }) },
  ]) {
    const fixture = proofFixture(options);
    assert.equal((await fixture.proof.admitReport(fixture.input())).status, 'internal-error', JSON.stringify(options));
  }
  const fixture = proofFixture();
  for (const overrides of [
    { runnerPreparedArtifactPaths: [artifactPath()], runnerPreparedArtifactSha256: {} },
    { runnerPreparedArtifactPaths: [artifactPath()], runnerPreparedArtifactSha256: { [artifactPath()]: '0'.repeat(64) } },
    { runnerPreparedArtifactPaths: ['proofs/other/evidence.txt'], runnerPreparedArtifactSha256: { 'proofs/other/evidence.txt': sha256(artifactBytes) } },
  ]) assert.equal((await fixture.proof.admitReport(fixture.input(overrides))).status, 'internal-error');
});

test('proof summaries admit application routes and percentage ratios without admitting host paths', async () => {
  const content = Buffer.from([
    'Entrypoint: /dashboard/updated-home-analytics on an isolated local server.',
    'Copy review: 25%/20%/N/A and 80%/N/A/N/A remain correct.',
  ].join('\n'));
  const fixture = proofFixture({ artifactContent: content, report: passingReport({ artifactContent: content }) });
  assert.equal((await fixture.proof.admitReport(fixture.input())).status, 'passed');

  for (const path of ['/Users/example/private/report.md', '/home/example/private/report.md',
    '/var/lib/codex/private.log', '/workspace/project/output.txt', '/nix/store/private-output',
    '/srv/private/customer-a/report.md', '/data/project/private/report.md', '/custom/project/private/report.md',
    'file:///custom/private/report.md', String.raw`C:\Users\example\private\report.md`,
    '~/private/report.md']) {
    const unsafe = Buffer.from(`Entrypoint: /dashboard/updated-home-analytics; retained file ${path}`);
    const rejected = proofFixture({ artifactContent: unsafe, report: passingReport({ artifactContent: unsafe }) });
    assert.equal((await rejected.proof.admitReport(rejected.input())).status, 'internal-error', path);
  }
});

test('host identity is allowed only in local diagnostic artifacts', async () => {
  const content = Buffer.from('Configured command: /Users/example/bin/node --version\n');
  const local = proofFixture({ artifactContent: content, report: passingReport({ artifactContent: content, artifactKind: 'static-inspection', publishable: false }) });
  assert.equal((await local.proof.admitReport(local.input())).status, 'passed');
  const published = proofFixture({ artifactContent: content, report: passingReport({ artifactContent: content }) });
  assert.equal((await published.proof.admitReport(published.input())).status, 'internal-error');
});

test('lease cleanup pending preserves the already admitted outcome', async () => {
  let calls = 0;
  const fixture = proofFixture({ androidLease: { verify: async () => {}, release: async () => { if (++calls === 1) throw new Error('pending'); } } });
  const result = await fixture.proof.admitReport(fixture.input());
  assert.equal(result.status, 'cleanup-pending');
  if (result.status !== 'cleanup-pending') return;
  assert.equal(result.outcome.status, 'passed');
  await fixture.proof.cleanupMobileLeases('proof-1');
  assert.equal(calls, 2);
});

test('invalid admission also retains pending lease cleanup', async () => {
  const fixture = proofFixture({ androidLease: { verify: async () => {}, release: async () => { throw new Error('pending'); } } });
  const result = await fixture.proof.admitReport(fixture.input({ report: undefined as unknown as ProofReportV1 }));
  assert.equal(result.status, 'cleanup-pending');
  if (result.status === 'cleanup-pending') assert.equal(result.outcome.status, 'internal-error');
});

test('candidate inspection errors preserve their typed boundary', async () => {
  const fixture = proofFixture({ inspectFreshness: async () => { throw new CandidateProofInspectionError('source-stale'); } });
  await assert.rejects(fixture.proof.admitReport(fixture.input()), CandidateProofInspectionError);
});

test('external block and rework reports remain evidence-admitted terminal outcomes', async () => {
  for (const status of ['needs-rework', 'external-block'] as const) {
    const report: ProofReportV1 = { ...passingReport(), status, criteria: [{ ...passingReport().criteria[0]!, status: 'failed', confidence: 'medium' }], findings: ['Behavior is incomplete.'],
      ...(status === 'external-block' ? { blocker: { kind: 'service' as const, summary: 'Fixture unavailable.', attempted: ['retry fixture'], resumable: false } } : {}) };
    const fixture = proofFixture({ report });
    assert.equal((await fixture.proof.admitReport(fixture.input())).status, status);
  }
});

test('cancellation fails closed without reading evidence', async () => {
  const controller = new AbortController(); controller.abort();
  const fixture = proofFixture({ signal: controller.signal });
  assert.equal((await fixture.proof.admitReport(fixture.input())).status, 'cancelled');
  assert.deepEqual(fixture.artifactReads, []);
});

test('mandatory Android live proof cannot pass through nonvisual evidence', async () => {
  const fixture = proofFixture();
  const input = fixture.input();
  input.issue.body = '## Proof requirements\n```json\n' + JSON.stringify({ version: 1, level: 'android-live', reason: 'Verify the real interaction.', authentication: 'dev-account', steps: [{ action: 'expect', text: 'Top Picks' }] }) + '\n```';
  assert.equal((await fixture.proof.admitReport(input)).status, 'external-block');
  const result = await fixture.proof.admitReport({ ...input, runnerPreparedArtifactPaths: [artifactPath()], runnerPreparedArtifactSha256: { [artifactPath()]: sha256(artifactBytes) } });
  assert.equal(result.status, 'internal-error');
  if (result.status === 'internal-error') assert.match(result.receipt.summary, /issue proof level/u);
});

function proofFixture(options: {
  report?: ProofReportV1; artifactContent?: Buffer; modifiedAt?: string; metadataUnavailable?: boolean;
  inspectFreshness?: (payload: CheckedChangePayloadV1) => Promise<CheckedChangeFreshness>;
  androidLease?: AndroidLeaseVerifier; signal?: AbortSignal;
} = {}) {
  const capabilities = createCheckedChangeCapabilities();
  const payload = checkedPayload();
  const checkedChange = capabilities.mint(payload);
  const freshnessCalls: CheckedChangePayloadV1[] = [];
  const artifactReads: string[] = [];
  const criteria: FrozenCriterion[] = [{ id: 'ac-001', order: 1, source: 'explicit', text: 'The behavior works.' }];
  const issue: IssueSnapshot = { number: 42, title: 'Implement behavior', body: '## Acceptance Criteria\n- The behavior works.', url: 'https://example.invalid/issues/42', state: 'OPEN', labels: ['agent:auto'] };
  const proof = new AcceptanceProof({ checkedChangeReader: capabilities,
    inspectFreshness: async (value) => { if (value.version !== 1) throw new Error('legacy fixture received V2 payload'); freshnessCalls.push(value); return options.inspectFreshness?.(value) ?? freshness(value); },
    readArtifact: async (path) => { artifactReads.push(path); if (path !== artifactPath()) throw new Error('artifact missing'); return options.artifactContent ?? artifactBytes; },
    inspectArtifact: options.metadataUnavailable ? undefined : async () => ({ modifiedAt: options.modifiedAt ?? '2026-07-16T12:00:01.000Z' }),
    proofArtifactDir: 'proofs', androidLease: options.androidLease, signal: options.signal,
  });
  return { proof, freshnessCalls, artifactReads, input: (overrides: Partial<Parameters<typeof proof.admitReport>[0]> = {}) => ({ proofId: 'proof-1', proofStartedAt: startedAt, issue: structuredClone(issue), frozenCriteria: criteria, checkedChange, report: options.report ?? passingReport(), changedArtifactPaths: [artifactPath()], ...overrides }) };
}
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
    deliveryAuthoritySha256: 'd'.repeat(64),
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


test('criterion IDs retain exact frozen order and complete coverage', async () => {
  const fixture = proofFixture();
  const input = fixture.input();
  input.frozenCriteria = [input.frozenCriteria[0]!, { id: 'ac-002', order: 2, source: 'explicit', text: 'Second behavior works.' }];
  const second = { ...input.report.criteria[0]!, id: 'ac-002' };
  input.report.criteria.push(second);
  assert.equal((await fixture.proof.admitReport(input)).status, 'passed');
  input.report.criteria.reverse();
  assert.equal((await fixture.proof.admitReport(input)).status, 'internal-error');
  input.report.criteria = [second];
  assert.equal((await fixture.proof.admitReport(input)).status, 'internal-error');
});

test('V2 original candidate can be admitted without materialization but supplied custody must match', async () => {
  const capabilities = createCheckedChangeCapabilities();
  const binding: CandidateBindingV2 = {
    version: 2, bindingId: '1'.repeat(64), expectedHeadSha: 'a'.repeat(40),
    candidateRef: `refs/codex-orchestrator/candidates/00000000-0000-4000-8000-000000000001/${'1'.repeat(64)}`,
    candidateCommitSha: 'b'.repeat(40), candidateTreeSha: 'c'.repeat(40), canonicalChangedFiles: ['src/a.ts'], sourceWorktreeIdentity: '2'.repeat(64),
  };
  const payload: CheckedChangePayloadV2 = {
    version: 2, canonicalRepository: 'owner/repo', runId: '00000000-0000-4000-8000-000000000001', issueNumber: 42,
    cycle: 1, baseSha: 'a'.repeat(40), deliveryAuthoritySha256: 'd'.repeat(64), binding,
    changedFiles: ['src/a.ts'], checks: [{ id: 'typecheck', command: 'npm run typecheck', status: 'passed', outputSha256: '3'.repeat(64), bindingId: binding.bindingId, candidateTreeSha: binding.candidateTreeSha, checkPolicySha256: '4'.repeat(64) }],
    checkPolicySha256: '4'.repeat(64), packageVersion: '2.0.34', proofSchemaVersion: 1,
  };
  const inspections: unknown[] = [];
  const proof = new AcceptanceProof<CheckedChangePayloadV2>({
    checkedChangeReader: capabilities,
    inspectFreshness: async (_payload, materialization) => { inspections.push(materialization); return { bindingId: binding.bindingId, candidateTreeSha: binding.candidateTreeSha, checkPolicySha256: payload.checkPolicySha256 }; },
    readArtifact: async () => artifactBytes,
    inspectArtifact: async () => ({ modifiedAt: '2026-07-16T12:00:01.000Z' }), proofArtifactDir: 'proofs',
  });
  const input = { ...proofFixture().input(), checkedChange: capabilities.mint(payload) };
  assert.equal((await proof.admitReport(input)).status, 'passed');
  assert.deepEqual(inspections, [undefined, undefined]);
  const materialization = { version: 2 as const, bindingId: '9'.repeat(64), candidateCommitSha: binding.candidateCommitSha, path: '/tmp/candidate' };
  const result = await proof.admitReport({ ...input, materialization });
  assert.equal(result.status, 'internal-error');
  assert.equal(inspections.length, 2);
});
