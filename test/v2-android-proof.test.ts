import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AcceptanceProof, type FrozenCriterion, type IssueSnapshot } from '../src/v2/acceptance-proof.js';
import { checkedChangePayloadSha256, createCheckedChangeCapabilities, type CheckedChangePayloadV1 } from '../src/v2/checked-change.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import type { AndroidLeaseVerifier } from '../src/v2/mobile-lease.js';
import { validateProofReport, type ProofReportV1 } from '../src/v2/proof-report.js';

test('Android proof report requires lease-bound screenshot, UI hierarchy, device log, workflow, and analysis', () => {
  assert.doesNotThrow(() => validateProofReport(androidReport()));
  const cases: Array<{ name: string; mutate: (report: Record<string, any>) => void }> = [
    { name: 'missing lease', mutate: (report) => { delete report.visualEvidence.lease; } },
    { name: 'screenshot only', mutate: (report) => { report.artifacts = report.artifacts.filter((artifact: any) => artifact.kind !== 'ui-hierarchy'); } },
    { name: 'missing device log', mutate: (report) => { delete report.visualEvidence.diagnostics.deviceLogRef; } },
    { name: 'missing layout review', mutate: (report) => { report.visualEvidence.layoutReview = []; } },
    { name: 'missing copy review', mutate: (report) => { report.visualEvidence.copyReview = []; } },
    { name: 'wrong criterion', mutate: (report) => { report.visualEvidence.captures[0].criteriaRefs = ['other']; } },
    { name: 'local hierarchy publishable', mutate: (report) => { report.artifacts.find((artifact: any) => artifact.kind === 'ui-hierarchy').publishable = true; } },
  ];
  for (const entry of cases) {
    const report = structuredClone(androidReport()) as Record<string, any>;
    entry.mutate(report);
    assert.throws(() => validateProofReport(report), { message: /.*/u }, entry.name);
  }
});

test('AcceptanceProof verifies and releases Android ownership while returning only sanitized evidence', async () => {
  const calls: string[] = [];
  const lease: AndroidLeaseVerifier = {
    verify: async ({ proofId, artifactRelativePath, artifactBytes }) => {
      calls.push(`verify:${proofId}`);
      assert.equal(artifactRelativePath, 'proofs/proof-android/lease.json');
      assert.equal(JSON.parse(artifactBytes.toString('utf8')).serial, 'emulator-5580');
    },
    release: async (proofId) => { calls.push(`release:${proofId}`); },
  };
  const result = await runAcceptanceFixture({ lease });
  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['verify:proof-android', 'release:proof-android']);
  const serialized = JSON.stringify(result.receipt);
  assert.equal(serialized.includes('android-shot'), true);
  for (const forbidden of ['emulator-5580', 'dev.codex.proof', 'lease-token', '4242', 'lease.json', 'proofs/proof-android']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('AcceptanceProof accepts current Runner-prepared Android artifacts without requiring the contained worker to rewrite them', async () => {
  const lease: AndroidLeaseVerifier = { verify: async () => {}, release: async () => {} };
  const prepared = [
    'proofs/proof-android/final.png',
    'proofs/proof-android/final.xml',
    'proofs/proof-android/logcat.txt',
    'proofs/proof-android/lease.json',
    'proofs/proof-android/android-runner-receipt.json',
  ];
  assert.equal((await runAcceptanceFixture({ lease, runnerPreparedArtifactPaths: prepared })).status, 'passed');
  assert.equal((await runAcceptanceFixture({
    lease,
    runnerPreparedArtifactPaths: prepared,
    mutateBytesAfterDigest: (bytes) => bytes.set('proofs/proof-android/final.xml', Buffer.from('<hierarchy tampered="true" />\n')),
  })).status, 'internal-error');
  assert.equal((await runAcceptanceFixture({
    lease,
    runnerPreparedArtifactPaths: prepared,
    omitRunnerReceiptFromReport: true,
  })).status, 'internal-error');
  assert.equal((await runAcceptanceFixture({
    lease,
    runnerPreparedArtifactPaths: [...prepared, '../foreign.png'],
  })).status, 'internal-error');
});

test('AcceptanceProof persists an unfinished Android UI warning even when the worker omits it', async () => {
  const warning = 'Android UI proof unfinished: emulator boot timed out.';
  const result = await runAcceptanceFixture({ runnerPreparationWarnings: [warning] });
  assert.equal(result.status, 'passed');
  assert.match(result.receipt.summary, /passed with warning/iu);
  assert.match(result.receipt.summary, /emulator boot timed out/iu);
  const saturated = await runAcceptanceFixture({ runnerPreparationWarnings: [warning], residualRiskCount: 256 });
  assert.equal(saturated.status, 'passed');
  assert.match(saturated.receipt.summary, /emulator boot timed out/iu);
});

test('AcceptanceProof fails closed when Android lease verification is absent or rejects ownership', async () => {
  assert.equal((await runAcceptanceFixture({})).status, 'internal-error');
  const calls: string[] = [];
  const rejectingLease: AndroidLeaseVerifier = {
    verify: async () => { calls.push('verify'); throw new Error('lease mismatch'); },
    release: async () => { calls.push('release'); },
  };
  assert.equal((await runAcceptanceFixture({ lease: rejectingLease })).status, 'internal-error');
  assert.deepEqual(calls, ['verify', 'release']);
});

test('AcceptanceProof rejects secret-bearing Android device logs before lease acceptance', async () => {
  const calls: string[] = [];
  const lease: AndroidLeaseVerifier = {
    verify: async () => { calls.push('verify'); },
    release: async () => { calls.push('release'); },
  };
  const result = await runAcceptanceFixture({
    lease,
    mutateBytes: (bytes) => bytes.set('proofs/proof-android/logcat.txt', Buffer.from('Authorization: Bearer secret-value-123\n')),
  });
  assert.equal(result.status, 'internal-error');
  assert.deepEqual(calls, ['release']);
});

test('AcceptanceProof rejects stale Android state and retains custody for caller-owned report repair', async () => {
  const lease: AndroidLeaseVerifier = { verify: async () => {}, release: async () => {} };
  assert.equal((await runAcceptanceFixture({
    lease,
    mutateMetadata: (metadata) => metadata.set('proofs/proof-android/final.xml', '2026-07-15T00:00:00.000Z'),
  })).status, 'internal-error');

  const calls: string[] = [];
  const repairLease: AndroidLeaseVerifier = {
    verify: async () => { calls.push('verify'); },
    release: async () => { calls.push('release'); },
  };
  assert.equal((await runAcceptanceFixture({ lease: repairLease, malformedFirstReport: true })).status, 'report-repair');
  assert.deepEqual(calls, []);
});

function androidReport(): unknown {
  return {
    version: 1,
    status: 'passed',
    decision: { mode: 'visual', targets: ['android'] },
    criteria: [{
      id: 'ac-android',
      status: 'passed',
      confidence: 'high',
      surfaces: ['android'],
      evidenceRefs: ['android-shot', 'android-tree'],
      analysis: 'The leased Android fixture reached the requested ready state.',
    }],
    checks: [],
    artifacts: [
      artifact('android-shot', 'screenshot', 'proofs/proof-android/final.png', true),
      artifact('android-tree', 'ui-hierarchy', 'proofs/proof-android/final.xml', false),
      artifact('android-log', 'device-log', 'proofs/proof-android/logcat.txt', false),
      artifact('android-lease', 'lease-record', 'proofs/proof-android/lease.json', false),
      artifact('android-runner-receipt', 'generated-file', 'proofs/proof-android/android-runner-receipt.json', false),
    ],
    visualEvidence: {
      workflow: {
        entrypoint: 'dev.codex.proof/.MainActivity',
        steps: ['Launch the leased fixture', 'Activate ready state'],
        finalState: 'Android proof ready is visible.',
      },
      captures: [{
        target: 'android',
        name: 'android-final',
        width: 1080,
        height: 2424,
        criteriaRefs: ['ac-android'],
        screenshotRef: 'android-shot',
        stateRef: 'android-tree',
      }],
      diagnostics: { deviceLogRef: 'android-log' },
      lease: { leaseRef: 'android-lease' },
      freshness: { capturedAfterFinalInteraction: true },
      layoutReview: [{ summary: 'The final screen is aligned, unclipped, and readable.', evidenceRefs: ['android-shot'] }],
      copyReview: [{ summary: 'Visible Android copy matches the criterion.', evidenceRefs: ['android-shot', 'android-tree'] }],
    },
    findings: [],
    residualRisks: [],
  };
}

function artifact(id: string, kind: string, relativePath: string, publishable: boolean): Record<string, unknown> {
  return { id, kind, relativePath, publishable, sha256: 'a'.repeat(64), description: `${id} evidence` };
}

async function runAcceptanceFixture(input: {
  lease?: AndroidLeaseVerifier;
  mutateBytes?: (bytes: Map<string, Buffer>) => void;
  mutateBytesAfterDigest?: (bytes: Map<string, Buffer>) => void;
  mutateMetadata?: (metadata: Map<string, string>) => void;
  malformedFirstReport?: boolean;
  runnerPreparedArtifactPaths?: string[];
  omitRunnerReceiptFromReport?: boolean;
  runnerPreparationWarnings?: string[];
  residualRiskCount?: number;
}) {
  const capabilities = createCheckedChangeCapabilities();
  const payload = checkedPayload();
  const report = androidReport() as ProofReportV1;
  if (input.runnerPreparationWarnings?.length && !input.runnerPreparedArtifactPaths) {
    report.decision = { mode: 'non-visual', targets: [] };
    report.checks = payload.checks.map((check) => ({ ...check, summary: 'Configured check passed.' }));
    report.criteria = report.criteria.map((criterion) => ({
      ...criterion, surfaces: ['non-visual'], evidenceRefs: [payload.checks[0]!.id],
    }));
    report.artifacts = [];
    delete report.visualEvidence;
  }
  if (input.residualRiskCount) report.residualRisks = Array.from({ length: input.residualRiskCount }, (_, index) => `risk-${index}`);
  if (input.omitRunnerReceiptFromReport) {
    report.artifacts = report.artifacts.filter((item) => !item.relativePath.endsWith('/android-runner-receipt.json'));
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const leaseRecord = {
    schema: 'codex-orchestrator.android-lease', version: 1, status: 'active', proofId: 'proof-android',
    token: 'lease-token', serial: 'emulator-5580', appId: 'dev.codex.proof', ownerPid: process.pid, appPid: 4242,
    acquiredAt: '2026-07-16T12:00:00.000Z', expiresAt: '2026-07-16T12:30:00.000Z', updatedAt: '2026-07-16T12:01:00.000Z',
  };
  const bytes = new Map<string, Buffer>([
    ['proofs/proof-android/final.png', png],
    ['proofs/proof-android/final.xml', Buffer.from('<hierarchy><node text="Android proof ready" /></hierarchy>\n')],
    ['proofs/proof-android/logcat.txt', Buffer.from('I/flutter: Android proof ready\n')],
    ['proofs/proof-android/lease.json', Buffer.from(`${canonicalJson(leaseRecord)}\n`)],
    ['proofs/proof-android/android-runner-receipt.json', Buffer.from(`${canonicalJson({
      schema: 'codex-orchestrator.runner-android-proof', version: 1, status: 'prepared', proofId: 'proof-android',
      configuredCheckIds: payload.checks.map((check) => check.id), buildOutputSha256: '7'.repeat(64),
      checkedChangeSha256: checkedChangePayloadSha256(payload), apkSha256: '8'.repeat(64),
      artifactRefs: [
        'proofs/proof-android/final.png', 'proofs/proof-android/final.xml',
        'proofs/proof-android/logcat.txt', 'proofs/proof-android/lease.json',
      ],
      navigation: { launchUriConfigured: false, tapText: ['Live'] },
      capturedAt: '2026-07-16T12:00:01.000Z',
    })}\n`)],
  ]);
  input.mutateBytes?.(bytes);
  const runnerPreparedArtifactSha256 = input.runnerPreparedArtifactPaths
    ? Object.fromEntries(input.runnerPreparedArtifactPaths.map((path) => [path, sha256(bytes.get(path) ?? Buffer.alloc(0))]))
    : undefined;
  input.mutateBytesAfterDigest?.(bytes);
  const metadata = new Map(report.artifacts.map((artifact) => [artifact.relativePath, '2026-07-16T12:00:01.000Z']));
  input.mutateMetadata?.(metadata);
  for (const reportArtifact of report.artifacts) reportArtifact.sha256 = sha256(bytes.get(reportArtifact.relativePath)!);
  let agentCalls = 0;
  const proof = new AcceptanceProof({
    checkedChangeReader: capabilities,
    proofAgent: {
      run: async () => {
        agentCalls += 1;
        if (input.malformedFirstReport && agentCalls === 1) {
          const malformed = structuredClone(report) as unknown as Record<string, unknown>;
          delete malformed.visualEvidence;
          return { kind: 'report' as const, report: malformed, proofPhaseChangedFiles: report.artifacts.map((item) => item.relativePath) };
        }
        return {
          kind: 'report' as const,
          report,
          proofPhaseChangedFiles: input.runnerPreparedArtifactPaths
            ? []
            : input.malformedFirstReport ? [] : report.artifacts.map((item) => item.relativePath),
        };
      },
    },
    inspectFreshness: async () => ({
      headSha: payload.headSha,
      indexTreeSha: payload.indexTreeSha,
      trackedContentSha256: payload.trackedContentSha256,
      untrackedContentSha256: payload.untrackedContentSha256,
      worktreeIdentity: payload.worktreeIdentity,
      checkPolicySha256: payload.checkPolicySha256,
    }),
    readArtifact: async (relativePath) => bytes.get(relativePath)!,
    inspectArtifact: async (relativePath) => ({ modifiedAt: metadata.get(relativePath)! }),
    androidLease: input.lease,
    proofArtifactDir: 'proofs/proof-android',
  });
  const issue: IssueSnapshot = {
    number: 88, title: 'Android proof fixture', body: 'Prove the ready state.',
    url: 'https://example.invalid/issues/88', state: 'OPEN', labels: ['agent:auto'],
  };
  const criteria: FrozenCriterion[] = [{ id: 'ac-android', order: 1, source: 'explicit', text: 'Android ready state is visible.' }];
  return proof.proveChange({
    proofId: 'proof-android', attemptId: 'proof-attempt-1', recoverOnly: false, proofStartedAt: '2026-07-16T12:00:00.000Z', transportRetryCount: 0, reportRepairCount: 0, reportRepairFindings: [], issue, frozenCriteria: criteria, checkedChange: capabilities.mint(payload),
    runnerPreparedArtifactPaths: input.runnerPreparedArtifactPaths,
    runnerPreparedArtifactSha256,
    runnerPreparationWarnings: input.runnerPreparationWarnings,
  });
}

function checkedPayload(): CheckedChangePayloadV1 {
  return {
    version: 1,
    canonicalRepository: 'owner/repo',
    runId: '00000000-0000-4000-8000-000000000088',
    issueNumber: 88,
    cycle: 1,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    indexTreeSha: 'c'.repeat(40),
    trackedContentSha256: 'd'.repeat(64),
    untrackedContentSha256: 'e'.repeat(64),
    worktreeIdentity: 'android-worktree',
    changedFiles: ['lib/main.dart'],
    checks: [{ id: 'fixture', command: 'flutter test', status: 'passed', outputSha256: 'f'.repeat(64) }],
    checkPolicySha256: '1'.repeat(64),
    packageVersion: '0.1.51',
    proofSchemaVersion: 1,
  };
}
