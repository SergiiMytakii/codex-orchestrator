import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AcceptanceProof, type FrozenCriterion, type IssueSnapshot } from '../src/v2/acceptance-proof.js';
import { createCheckedChangeCapabilities, type CheckedChangePayloadV1 } from '../src/v2/checked-change.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import type { IosLeaseVerifier } from '../src/v2/mobile-lease.js';
import { InMemoryProofRecordWriter } from '../src/v2/proof-store.js';
import { validateProofReport, type ProofReportV1 } from '../src/v2/proof-report.js';

test('iOS proof report requires lease-bound screenshot, accessibility hierarchy, device log, workflow, and analysis', () => {
  assert.doesNotThrow(() => validateProofReport(iosReport()));
  for (const entry of [
    { name: 'missing lease', mutate: (report: Record<string, any>) => { delete report.visualEvidence.lease; } },
    { name: 'screenshot only', mutate: (report: Record<string, any>) => { report.artifacts = report.artifacts.filter((artifact: any) => artifact.kind !== 'ui-hierarchy'); } },
    { name: 'missing log', mutate: (report: Record<string, any>) => { delete report.visualEvidence.diagnostics.deviceLogRef; } },
    { name: 'missing layout', mutate: (report: Record<string, any>) => { report.visualEvidence.layoutReview = []; } },
    { name: 'missing copy', mutate: (report: Record<string, any>) => { report.visualEvidence.copyReview = []; } },
    { name: 'wrong criterion', mutate: (report: Record<string, any>) => { report.visualEvidence.captures[0].criteriaRefs = ['other']; } },
  ]) {
    const report = structuredClone(iosReport()) as Record<string, any>;
    entry.mutate(report);
    assert.throws(() => validateProofReport(report), { message: /.*/u }, entry.name);
  }
});

test('AcceptanceProof verifies and releases iOS ownership while returning only sanitized evidence', async () => {
  const calls: string[] = [];
  const lease: IosLeaseVerifier = {
    verify: async () => { calls.push('verify'); },
    release: async () => { calls.push('release'); },
  };
  const result = await runAcceptanceFixture(lease);
  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['verify', 'release']);
  const serialized = JSON.stringify(result.receipt);
  assert.equal(serialized.includes('ios-shot'), true);
  for (const forbidden of ['11111111-2222-4333-8444-555555555555', 'dev.codex.proof', 'lease-token', '4242', 'lease.json', 'proofs/proof-ios']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal((await runAcceptanceFixture()).status, 'internal-error');
});

function iosReport(): unknown {
  return {
    version: 1,
    status: 'passed',
    decision: { mode: 'visual', targets: ['ios'] },
    criteria: [{
      id: 'ac-ios', status: 'passed', confidence: 'high', surfaces: ['ios'],
      evidenceRefs: ['ios-shot', 'ios-tree'], analysis: 'The leased iOS fixture reached the requested ready state.',
    }],
    checks: [],
    artifacts: [
      artifact('ios-shot', 'screenshot', 'proofs/proof-ios/final.png', true),
      artifact('ios-tree', 'ui-hierarchy', 'proofs/proof-ios/final.txt', false),
      artifact('ios-log', 'device-log', 'proofs/proof-ios/simulator.log', false),
      artifact('ios-lease', 'lease-record', 'proofs/proof-ios/lease.json', false),
    ],
    visualEvidence: {
      workflow: { entrypoint: 'dev.codex.proof', steps: ['Launch fixture', 'Activate proof'], finalState: 'iOS proof ready is visible.' },
      captures: [{
        target: 'ios', name: 'ios-final', width: 1206, height: 2622, criteriaRefs: ['ac-ios'],
        screenshotRef: 'ios-shot', stateRef: 'ios-tree',
      }],
      diagnostics: { deviceLogRef: 'ios-log' },
      lease: { leaseRef: 'ios-lease' },
      freshness: { capturedAfterFinalInteraction: true },
      layoutReview: [{ summary: 'The final iOS screen is aligned and unclipped.', evidenceRefs: ['ios-shot'] }],
      copyReview: [{ summary: 'Visible iOS copy matches the criterion.', evidenceRefs: ['ios-shot', 'ios-tree'] }],
    },
    findings: [],
    residualRisks: [],
  };
}

function artifact(id: string, kind: string, relativePath: string, publishable: boolean): Record<string, unknown> {
  return { id, kind, relativePath, publishable, sha256: 'a'.repeat(64), description: `${id} evidence` };
}

async function runAcceptanceFixture(lease?: IosLeaseVerifier) {
  const capabilities = createCheckedChangeCapabilities();
  const payload = checkedPayload();
  const report = iosReport() as ProofReportV1;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const record = {
    schema: 'codex-orchestrator.ios-lease', version: 1, status: 'active', proofId: 'proof-ios', token: 'lease-token',
    udid: '11111111-2222-4333-8444-555555555555', deviceName: 'Codex proof-ios', bundleId: 'dev.codex.proof',
    ownerPid: process.pid, appPid: 4242, runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
    deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', runnerCreated: true,
    acquiredAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:20:00.000Z', updatedAt: '2026-07-17T00:01:00.000Z',
  };
  const bytes = new Map<string, Buffer>([
    ['proofs/proof-ios/final.png', png],
    ['proofs/proof-ios/final.txt', Buffer.from('Application, 0x0, {{0, 0}, {402, 874}}\n  Button, label: Activate proof\n  StaticText, label: iOS proof ready\n')],
    ['proofs/proof-ios/simulator.log', Buffer.from('Runner: iOS proof ready\n')],
    ['proofs/proof-ios/lease.json', Buffer.from(`${canonicalJson(record)}\n`)],
  ]);
  for (const item of report.artifacts) item.sha256 = sha256(bytes.get(item.relativePath)!);
  const proof = new AcceptanceProof({
    checkedChangeReader: capabilities,
    proofRecords: new InMemoryProofRecordWriter(),
    proofAgent: { run: async () => ({ kind: 'report', report, proofPhaseChangedFiles: report.artifacts.map((item) => item.relativePath) }) },
    inspectFreshness: async () => ({
      headSha: payload.headSha, indexTreeSha: payload.indexTreeSha,
      trackedContentSha256: payload.trackedContentSha256, untrackedContentSha256: payload.untrackedContentSha256,
      worktreeIdentity: payload.worktreeIdentity, checkPolicySha256: payload.checkPolicySha256,
    }),
    readArtifact: async (path) => bytes.get(path)!,
    inspectArtifact: async () => ({ modifiedAt: '2026-07-17T00:00:01.000Z' }),
    iosLease: lease,
    proofArtifactDir: 'proofs/proof-ios',
    createAttemptId: () => 'ios-attempt-1',
    now: () => '2026-07-17T00:00:00.000Z',
  });
  const issue: IssueSnapshot = {
    number: 89, title: 'iOS proof fixture', body: 'Prove the ready state.',
    url: 'https://example.invalid/issues/89', state: 'OPEN', labels: ['agent:auto'],
  };
  const criteria: FrozenCriterion[] = [{ id: 'ac-ios', order: 1, source: 'explicit', text: 'iOS ready state is visible.' }];
  return proof.proveChange({ proofId: 'proof-ios', issue, frozenCriteria: criteria, checkedChange: capabilities.mint(payload) });
}

function checkedPayload(): CheckedChangePayloadV1 {
  return {
    version: 1, canonicalRepository: 'owner/repo', runId: '00000000-0000-4000-8000-000000000089', issueNumber: 89, cycle: 1,
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), indexTreeSha: 'c'.repeat(40),
    trackedContentSha256: 'd'.repeat(64), untrackedContentSha256: 'e'.repeat(64), worktreeIdentity: 'ios-worktree',
    changedFiles: ['lib/main.dart'], checks: [{ id: 'fixture', command: 'flutter test', status: 'passed', outputSha256: 'f'.repeat(64) }],
    checkPolicySha256: '1'.repeat(64), packageVersion: '0.1.51', proofSchemaVersion: 1,
  };
}
