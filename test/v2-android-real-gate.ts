import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AcceptanceProof, type FrozenCriterion, type IssueSnapshot } from '../src/v2/acceptance-proof.js';
import { createCheckedChangeCapabilities, type CheckedChangePayloadV1 } from '../src/v2/checked-change.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import { FileAndroidLeaseVerifier } from '../src/v2/mobile-lease.js';
import { InMemoryProofRecordWriter } from '../src/v2/proof-store.js';
import type { ProofReportV1 } from '../src/v2/proof-report.js';

const args = parseArgs(process.argv.slice(2));
const root = required(args.root);
const proofRoot = required(args['proof-root']);
const proofId = required(args['proof-id']);
const startedAt = required(args['started-at']);
const width = requiredInteger(args.width);
const height = requiredInteger(args.height);
const relativePaths = {
  screenshot: required(args.screenshot),
  hierarchy: required(args.hierarchy),
  log: required(args.log),
  lease: required(args.lease),
};

const artifactInputs = [
  { id: 'android-shot', kind: 'screenshot' as const, relativePath: relativePaths.screenshot, publishable: true, description: 'Final Android fixture state.' },
  { id: 'android-tree', kind: 'ui-hierarchy' as const, relativePath: relativePaths.hierarchy, publishable: false, description: 'Final Android UI hierarchy.' },
  { id: 'android-log', kind: 'device-log' as const, relativePath: relativePaths.log, publishable: false, description: 'PID-scoped Android device log.' },
  { id: 'android-lease', kind: 'lease-record' as const, relativePath: relativePaths.lease, publishable: false, description: 'Runner-owned Android lease.' },
];
const report: ProofReportV1 = {
  version: 1,
  status: 'passed',
  decision: { mode: 'visual', targets: ['android'] },
  criteria: [{
    id: 'ac-android-real', status: 'passed', confidence: 'high', surfaces: ['android'],
    evidenceRefs: ['android-shot', 'android-tree'],
    analysis: 'The exact leased fixture process reached the Android proof ready state after the final interaction.',
  }],
  checks: [],
  artifacts: await Promise.all(artifactInputs.map(async (artifact) => ({
    ...artifact,
    sha256: sha256(await readFile(resolve(root, artifact.relativePath))),
  }))),
  visualEvidence: {
    workflow: {
      entrypoint: 'dev.codex.proof/.MainActivity',
      steps: ['Launch the leased fixture', 'Locate Activate proof from the UI hierarchy', 'Activate the proof'],
      finalState: 'Android proof ready is visible in the screenshot and UI hierarchy.',
    },
    captures: [{
      target: 'android', name: 'final', width, height, criteriaRefs: ['ac-android-real'],
      screenshotRef: 'android-shot', stateRef: 'android-tree',
    }],
    diagnostics: { deviceLogRef: 'android-log' },
    lease: { leaseRef: 'android-lease' },
    freshness: { capturedAfterFinalInteraction: true },
    layoutReview: [{
      summary: 'The centered content is aligned, evenly spaced, fully visible, and free of clipping or overlap.',
      evidenceRefs: ['android-shot'],
    }],
    copyReview: [{
      summary: 'The visible final-state copy says Android proof ready and matches the acceptance criterion.',
      evidenceRefs: ['android-shot', 'android-tree'],
    }],
  },
  findings: [],
  residualRisks: [],
};

const capabilities = createCheckedChangeCapabilities();
const payload: CheckedChangePayloadV1 = {
  version: 1,
  canonicalRepository: 'codex-orchestrator/v2-mobile-fixture',
  runId: '00000000-0000-4000-8000-000000000404',
  issueNumber: 404,
  cycle: 1,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  indexTreeSha: 'c'.repeat(40),
  trackedContentSha256: 'd'.repeat(64),
  untrackedContentSha256: 'e'.repeat(64),
  worktreeIdentity: 'runner-owned-android-fixture',
  changedFiles: ['lib/main.dart'],
  checks: [{ id: 'flutter-build', command: 'flutter build apk --debug', status: 'passed', outputSha256: 'f'.repeat(64) }],
  checkPolicySha256: '1'.repeat(64),
  packageVersion: '0.1.51',
  proofSchemaVersion: 1,
};
const issue: IssueSnapshot = {
  number: 404,
  title: 'Prove the runner-owned Android fixture',
  body: 'The Android fixture reaches its ready state after activation.',
  url: 'https://example.invalid/issues/404',
  state: 'OPEN',
  labels: ['agent:auto'],
};
const criteria: FrozenCriterion[] = [{
  id: 'ac-android-real', order: 1, source: 'explicit', text: 'The Android fixture visibly reaches the ready state.',
}];
const proof = new AcceptanceProof({
  checkedChangeReader: capabilities,
  proofRecords: new InMemoryProofRecordWriter(),
  proofAgent: {
    run: async () => ({ kind: 'report', report, proofPhaseChangedFiles: report.artifacts.map((artifact) => artifact.relativePath) }),
  },
  inspectFreshness: async () => ({
    headSha: payload.headSha,
    indexTreeSha: payload.indexTreeSha,
    trackedContentSha256: payload.trackedContentSha256,
    untrackedContentSha256: payload.untrackedContentSha256,
    worktreeIdentity: payload.worktreeIdentity,
    checkPolicySha256: payload.checkPolicySha256,
  }),
  readArtifact: (relativePath) => readFile(resolve(root, relativePath)),
  inspectArtifact: async (relativePath) => ({ modifiedAt: (await stat(resolve(root, relativePath))).mtime.toISOString() }),
  androidLease: new FileAndroidLeaseVerifier({ leaseRoot: required(args['lease-root']), worktreeRoot: root }),
  proofArtifactDir: proofRoot,
  createAttemptId: () => 'android-real-attempt',
  now: () => startedAt,
});
const result = await proof.proveChange({ proofId, issue, frozenCriteria: criteria, checkedChange: capabilities.mint(payload) });
process.stdout.write(`${canonicalJson(result)}\n`);
if (result.status !== 'passed') process.exitCode = 1;

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('real Android gate arguments are invalid');
    output[key.slice(2)] = value;
  }
  return output;
}

function required(value: string | undefined): string {
  if (!value) throw new Error('real Android gate argument is missing');
  return value;
}

function requiredInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('real Android gate dimension is invalid');
  return parsed;
}
