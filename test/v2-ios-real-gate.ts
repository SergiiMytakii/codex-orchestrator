import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AcceptanceProof, type FrozenCriterion, type IssueSnapshot } from '../src/v2/acceptance-proof.js';
import { createCheckedChangeCapabilities, type CheckedChangePayloadV1 } from '../src/v2/checked-change.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import { FileIosLeaseVerifier, type IosLeaseRecordV1 } from '../src/v2/mobile-lease.js';
import { InMemoryProofRecordWriter } from '../src/v2/proof-store.js';
import type { ProofReportV1 } from '../src/v2/proof-report.js';

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const root = required(args.root);
const proofRoot = required(args['proof-root']);
const proofId = required(args['proof-id']);
const startedAt = required(args['started-at']);
const xcrun = required(args.xcrun);
const width = requiredInteger(args.width);
const height = requiredInteger(args.height);
const paths = {
  screenshot: required(args.screenshot), hierarchy: required(args.hierarchy),
  log: required(args.log), lease: required(args.lease),
};
const artifactInputs = [
  { id: 'ios-shot', kind: 'screenshot' as const, relativePath: paths.screenshot, publishable: true, description: 'Final iOS fixture state.' },
  { id: 'ios-tree', kind: 'ui-hierarchy' as const, relativePath: paths.hierarchy, publishable: false, description: 'Final XCUITest accessibility hierarchy.' },
  { id: 'ios-log', kind: 'device-log' as const, relativePath: paths.log, publishable: false, description: 'Process-scoped Simulator log.' },
  { id: 'ios-lease', kind: 'lease-record' as const, relativePath: paths.lease, publishable: false, description: 'Runner-created Simulator lease.' },
];
const report: ProofReportV1 = {
  version: 1, status: 'passed', decision: { mode: 'visual', targets: ['ios'] },
  criteria: [{
    id: 'ac-ios-real', status: 'passed', confidence: 'high', surfaces: ['ios'],
    evidenceRefs: ['ios-shot', 'ios-tree'],
    analysis: 'The exact runner-created Simulator fixture reached the iOS proof ready state through accessibility-driven interaction.',
  }],
  checks: [],
  artifacts: await Promise.all(artifactInputs.map(async (artifact) => ({
    ...artifact, sha256: sha256(await readFile(resolve(root, artifact.relativePath))),
  }))),
  visualEvidence: {
    workflow: { entrypoint: 'dev.codex.proof', steps: ['Launch fixture with XCUITest', 'Select Activate proof by accessibility label'], finalState: 'iOS proof ready is visible.' },
    captures: [{ target: 'ios', name: 'final', width, height, criteriaRefs: ['ac-ios-real'], screenshotRef: 'ios-shot', stateRef: 'ios-tree' }],
    diagnostics: { deviceLogRef: 'ios-log' }, lease: { leaseRef: 'ios-lease' },
    freshness: { capturedAfterFinalInteraction: true },
    layoutReview: [{ summary: 'The centered final content is aligned, readable, unclipped, and free of overlap.', evidenceRefs: ['ios-shot'] }],
    copyReview: [{ summary: 'Visible iOS final-state copy matches the acceptance criterion.', evidenceRefs: ['ios-shot', 'ios-tree'] }],
  },
  findings: [], residualRisks: [],
};
const capabilities = createCheckedChangeCapabilities();
const payload: CheckedChangePayloadV1 = {
  version: 1, canonicalRepository: 'codex-orchestrator/v2-mobile-fixture', runId: '00000000-0000-4000-8000-000000000505',
  issueNumber: 505, cycle: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), indexTreeSha: 'c'.repeat(40),
  trackedContentSha256: 'd'.repeat(64), untrackedContentSha256: 'e'.repeat(64), worktreeIdentity: 'runner-created-ios-fixture',
  changedFiles: ['lib/main.dart'], checks: [{ id: 'xcuitest', command: 'xcodebuild test', status: 'passed', outputSha256: 'f'.repeat(64) }],
  checkPolicySha256: '1'.repeat(64), packageVersion: '0.1.51', proofSchemaVersion: 1,
};
const proof = new AcceptanceProof({
  checkedChangeReader: capabilities,
  proofRecords: new InMemoryProofRecordWriter(),
  proofAgent: { run: async () => ({ kind: 'report', report, proofPhaseChangedFiles: report.artifacts.map((artifact) => artifact.relativePath) }) },
  inspectFreshness: async () => ({
    headSha: payload.headSha, indexTreeSha: payload.indexTreeSha,
    trackedContentSha256: payload.trackedContentSha256, untrackedContentSha256: payload.untrackedContentSha256,
    worktreeIdentity: payload.worktreeIdentity, checkPolicySha256: payload.checkPolicySha256,
  }),
  readArtifact: (relativePath) => readFile(resolve(root, relativePath)),
  inspectArtifact: async (relativePath) => ({ modifiedAt: (await stat(resolve(root, relativePath))).mtime.toISOString() }),
  iosLease: new FileIosLeaseVerifier({
    leaseRoot: required(args['lease-root']), worktreeRoot: root,
    artifactRelativePathForProof: () => paths.lease,
    targetController: { release: (record) => releaseSimulator(xcrun, record) },
  }),
  proofArtifactDir: proofRoot, createAttemptId: () => 'ios-real-attempt', now: () => startedAt,
});
const issue: IssueSnapshot = {
  number: 505, title: 'Prove runner-created iOS fixture', body: 'The iOS fixture reaches its ready state.',
  url: 'https://example.invalid/issues/505', state: 'OPEN', labels: ['agent:auto'],
};
const criteria: FrozenCriterion[] = [{ id: 'ac-ios-real', order: 1, source: 'explicit', text: 'The iOS fixture visibly reaches the ready state.' }];
const result = await proof.proveChange({ proofId, issue, frozenCriteria: criteria, checkedChange: capabilities.mint(payload) });
process.stdout.write(`${canonicalJson(result)}\n`);
if (result.status !== 'passed') process.exitCode = 1;

async function releaseSimulator(xcrunPath: string, record: IosLeaseRecordV1): Promise<void> {
  const list = async () => {
    const { stdout } = await execFileAsync(xcrunPath, ['simctl', 'list', 'devices', '-j']);
    const parsed = JSON.parse(stdout) as { devices?: Record<string, Array<{ udid: string; name: string; state: string }>> };
    return Object.values(parsed.devices ?? {}).flat();
  };
  const matches = (await list()).filter((device) => device.udid === record.udid);
  if (matches.length === 0) return;
  if (matches.length !== 1 || matches[0].name !== record.deviceName) throw new Error('real iOS release target mismatch');
  if (matches[0].state === 'Booted') await execFileAsync(xcrunPath, ['simctl', 'shutdown', record.udid]);
  await execFileAsync(xcrunPath, ['simctl', 'delete', record.udid]);
  if ((await list()).some((device) => device.udid === record.udid)) throw new Error('real iOS target deletion was not confirmed');
}

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('real iOS gate arguments are invalid');
    output[key.slice(2)] = value;
  }
  return output;
}
function required(value: string | undefined): string { if (!value) throw new Error('real iOS gate argument missing'); return value; }
function requiredInteger(value: string | undefined): number {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('real iOS dimension invalid'); return parsed;
}
