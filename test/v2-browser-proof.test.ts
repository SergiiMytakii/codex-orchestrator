import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

import { AcceptanceProof, type FrozenCriterion, type IssueSnapshot } from '../src/v2/acceptance-proof.js';
import { createCheckedChangeCapabilities, type CheckedChangePayloadV1 } from '../src/v2/checked-change.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import { InMemoryProofRecordWriter } from '../src/v2/proof-store.js';
import { validateProofReport, type ProofReportV1 } from '../src/v2/proof-report.js';

test('browser proof report requires criterion-linked responsive screenshots, DOM state, diagnostics, and analysis', () => {
  assert.doesNotThrow(() => validateProofReport(browserReport()));

  const cases: Array<{ name: string; mutate: (report: Record<string, any>) => void }> = [
    { name: 'screenshot only', mutate: (report) => { report.artifacts = report.artifacts.filter((artifact: any) => artifact.kind !== 'dom-snapshot'); } },
    { name: 'one viewport', mutate: (report) => { report.visualEvidence.captures = report.visualEvidence.captures.slice(0, 1); } },
    { name: 'missing console diagnostics', mutate: (report) => { delete report.visualEvidence.diagnostics.consoleRef; } },
    { name: 'missing network diagnostics', mutate: (report) => { delete report.visualEvidence.diagnostics.networkRef; } },
    { name: 'missing layout analysis', mutate: (report) => { report.visualEvidence.layoutReview = []; } },
    { name: 'missing copy analysis', mutate: (report) => { report.visualEvidence.copyReview = []; } },
    { name: 'irrelevant criterion mapping', mutate: (report) => { report.visualEvidence.captures[0].criteriaRefs = ['different-criterion']; } },
    { name: 'not post interaction', mutate: (report) => { report.visualEvidence.freshness.capturedAfterFinalInteraction = false; } },
  ];

  for (const entry of cases) {
    const report = structuredClone(browserReport()) as Record<string, any>;
    entry.mutate(report);
    assert.throws(() => validateProofReport(report), { message: /.*/u }, entry.name);
  }
});

test('non-visual reports forbid visual evidence and browser reports require it', () => {
  const visual = browserReport() as Record<string, any>;
  const missing = structuredClone(visual);
  delete missing.visualEvidence;
  assert.throws(() => validateProofReport(missing));

  const nonVisual = structuredClone(visual);
  nonVisual.decision = { mode: 'non-visual', targets: [] };
  nonVisual.criteria[0].surfaces = ['non-visual'];
  assert.throws(() => validateProofReport(nonVisual));
});

test('actual changed localhost workflow passes through AcceptanceProof with fresh responsive browser evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-browser-'));
  const before = '<main><h1>Workspace</h1></main>';
  const after = `<!doctype html>
    <style>
      body { font-family: sans-serif; margin: 0; padding: 32px; }
      #dashboard { display: none; grid-template-columns: 1fr 1fr; gap: 16px; }
      #dashboard.ready { display: grid; }
      .card { border: 1px solid #333; padding: 16px; }
      @media (max-width: 480px) { body { padding: 12px; } #dashboard.ready { grid-template-columns: 1fr; } }
    </style>
    <main>
      <h1>Workspace</h1>
      <button id="activate">Open dashboard</button>
      <section id="dashboard" data-testid="dashboard"><article class="card">Dashboard ready</article><article class="card">2 checks passed</article></section>
    </main>
    <script>document.querySelector('#activate').addEventListener('click', () => document.querySelector('#dashboard').classList.add('ready'));</script>`;
  assert.notEqual(after, before);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(after);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const entrypoint = `http://127.0.0.1:${address.port}/`;

  try {
    const proofRoot = 'proofs/proof-browser';
    const absoluteProofRoot = join(root, proofRoot);
    const capabilities = createCheckedChangeCapabilities();
    const payload = checkedPayload();
    const checkedChange = capabilities.mint(payload);
    const issue: IssueSnapshot = {
      number: 77,
      title: 'Add responsive dashboard workflow',
      body: 'The dashboard reaches its final state at desktop and narrow widths.',
      url: 'https://example.invalid/issues/77',
      state: 'OPEN',
      labels: ['agent:auto'],
    };
    const criteria: FrozenCriterion[] = [{
      id: 'ac-web', order: 1, source: 'explicit', text: 'The responsive dashboard workflow reaches the ready state.',
    }];
    const proof = new AcceptanceProof({
      checkedChangeReader: capabilities,
      proofRecords: new InMemoryProofRecordWriter(),
      proofAgent: {
        run: async () => ({
          kind: 'report',
          report: await captureRealBrowserReport({ entrypoint, root, proofRoot }),
          proofPhaseChangedFiles: [
            `${proofRoot}/desktop.png`, `${proofRoot}/desktop.dom.json`,
            `${proofRoot}/narrow.png`, `${proofRoot}/narrow.dom.json`,
            `${proofRoot}/console.json`, `${proofRoot}/network.json`,
          ],
        }),
      },
      inspectFreshness: async () => ({
        headSha: payload.headSha,
        indexTreeSha: payload.indexTreeSha,
        trackedContentSha256: payload.trackedContentSha256,
        untrackedContentSha256: payload.untrackedContentSha256,
        worktreeIdentity: payload.worktreeIdentity,
        checkPolicySha256: payload.checkPolicySha256,
      }),
      readArtifact: (relativePath) => readFile(join(root, relativePath)),
      inspectArtifact: async (relativePath) => ({ modifiedAt: (await stat(join(root, relativePath))).mtime.toISOString() }),
      proofArtifactDir: proofRoot,
      createAttemptId: (() => { let id = 0; return () => `browser-attempt-${++id}`; })(),
      now: () => new Date().toISOString(),
    });

    const result = await proof.proveChange({ proofId: 'proof-browser', issue, frozenCriteria: criteria, checkedChange });
    assert.equal(result.status, 'passed');
    if (result.status !== 'passed') return;
    assert.deepEqual(result.receipt.publishableEvidence.map((evidence) => evidence.ref), [
      'artifact:desktop-shot',
      'artifact:narrow-shot',
    ]);
    assert.equal(JSON.stringify(result.receipt).includes(proofRoot), false);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test('AcceptanceProof rejects stale, malformed, oversized, secret-bearing, and misclassified browser artifacts', async () => {
  const cases: Array<{
    name: string;
    mutate: (input: { report: ProofReportV1; bytes: Map<string, Buffer>; metadata: Map<string, string>; changedFiles: string[] }) => void;
  }> = [
    {
      name: 'stale',
      mutate: ({ metadata }) => metadata.set('proofs/proof-browser/desktop.png', '2026-07-15T00:00:00.000Z'),
    },
    {
      name: 'malformed screenshot',
      mutate: ({ bytes }) => bytes.set('proofs/proof-browser/desktop.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    },
    {
      name: 'oversized DOM',
      mutate: ({ bytes }) => bytes.set('proofs/proof-browser/desktop.dom.json', Buffer.alloc(1024 * 1024 + 1, 0x61)),
    },
    {
      name: 'secret-bearing console',
      mutate: ({ bytes }) => bytes.set('proofs/proof-browser/console.json', Buffer.from('{"Authorization":"Bearer secret-value-123"}\n')),
    },
    {
      name: 'absolute user path in DOM',
      mutate: ({ bytes }) => bytes.set('proofs/proof-browser/desktop.dom.json', Buffer.from('{"path":"/Users/private-user/.config/tool"}\n')),
    },
    {
      name: 'local diagnostics marked publishable',
      mutate: ({ report }) => { report.artifacts.find((artifact) => artifact.kind === 'console-log')!.publishable = true; },
    },
    {
      name: 'unchanged prior artifact with fresh mtime',
      mutate: ({ changedFiles }) => { changedFiles.splice(changedFiles.indexOf('proofs/proof-browser/desktop.png'), 1); },
    },
  ];

  for (const entry of cases) {
    const result = await runPolicyFixture(entry.mutate);
    assert.equal(result.status, 'internal-error', entry.name);
  }
});

function browserReport(): unknown {
  const artifacts = [
    artifact('artifact:desktop-shot', 'screenshot', 'proofs/proof-browser/desktop.png', true),
    artifact('artifact:desktop-dom', 'dom-snapshot', 'proofs/proof-browser/desktop.dom.json', false),
    artifact('artifact:narrow-shot', 'screenshot', 'proofs/proof-browser/narrow.png', true),
    artifact('artifact:narrow-dom', 'dom-snapshot', 'proofs/proof-browser/narrow.dom.json', false),
    artifact('artifact:console', 'console-log', 'proofs/proof-browser/console.json', false),
    artifact('artifact:network', 'network-log', 'proofs/proof-browser/network.json', false),
  ];
  return {
    version: 1,
    status: 'passed',
    decision: { mode: 'visual', targets: ['browser'] },
    criteria: [{
      id: 'ac-web',
      status: 'passed',
      confidence: 'high',
      surfaces: ['browser'],
      evidenceRefs: ['artifact:desktop-shot', 'artifact:desktop-dom', 'artifact:narrow-shot', 'artifact:narrow-dom'],
      analysis: 'Both responsive views reached the requested dashboard state.',
    }],
    checks: [],
    artifacts,
    visualEvidence: {
      workflow: {
        entrypoint: 'http://127.0.0.1:4173/',
        steps: ['Navigate to the fixture', 'Activate the dashboard'],
        finalState: 'Dashboard is visible with the completed marker.',
      },
      captures: [
        {
          target: 'browser',
          name: 'desktop',
          width: 1280,
          height: 720,
          criteriaRefs: ['ac-web'],
          screenshotRef: 'artifact:desktop-shot',
          stateRef: 'artifact:desktop-dom',
        },
        {
          target: 'browser',
          name: 'narrow',
          width: 390,
          height: 844,
          criteriaRefs: ['ac-web'],
          screenshotRef: 'artifact:narrow-shot',
          stateRef: 'artifact:narrow-dom',
        },
      ],
      diagnostics: {
        consoleRef: 'artifact:console',
        networkRef: 'artifact:network',
      },
      freshness: { capturedAfterFinalInteraction: true },
      layoutReview: [{
        summary: 'Spacing, clipping, overlap, and alignment are correct at both widths.',
        evidenceRefs: ['artifact:desktop-shot', 'artifact:narrow-shot'],
      }],
      copyReview: [{
        summary: 'Visible dashboard copy matches the acceptance criterion.',
        evidenceRefs: ['artifact:desktop-shot', 'artifact:desktop-dom', 'artifact:narrow-shot', 'artifact:narrow-dom'],
      }],
    },
    findings: [],
    residualRisks: [],
  };
}

function artifact(id: string, kind: string, relativePath: string, publishable: boolean): Record<string, unknown> {
  return {
    id,
    kind,
    relativePath,
    sha256: 'a'.repeat(64),
    publishable,
    description: `${id} evidence`,
  };
}

async function captureRealBrowserReport(input: { entrypoint: string; root: string; proofRoot: string }): Promise<ProofReportV1> {
  const absoluteProofRoot = join(input.root, input.proofRoot);
  await mkdir(absoluteProofRoot, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  });
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];
  try {
    for (const viewport of [{ name: 'desktop', width: 1280, height: 720 }, { name: 'narrow', width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('requestfailed', (request) => networkFailures.push(`${request.method()} ${request.url()}`));
      await page.goto(input.entrypoint);
      await page.locator('#activate').click();
      await page.locator('#dashboard.ready').waitFor();
      assert.match(await page.locator('#dashboard').innerText(), /Dashboard ready/u);
      await page.screenshot({ path: join(absoluteProofRoot, `${viewport.name}.png`), fullPage: true });
      await writeFile(join(absoluteProofRoot, `${viewport.name}.dom.json`), `${canonicalJson({
        url: page.url(),
        text: await page.locator('body').innerText(),
        dashboardClass: await page.locator('#dashboard').getAttribute('class'),
      })}\n`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  await writeFile(join(absoluteProofRoot, 'console.json'), `${canonicalJson({ errors: consoleErrors })}\n`);
  await writeFile(join(absoluteProofRoot, 'network.json'), `${canonicalJson({ failures: networkFailures })}\n`);
  const report = browserReport() as ProofReportV1;
  report.visualEvidence!.workflow.entrypoint = input.entrypoint;
  for (const artifact of report.artifacts) {
    artifact.sha256 = sha256(await readFile(join(input.root, artifact.relativePath)));
  }
  return report;
}

function checkedPayload(): CheckedChangePayloadV1 {
  return {
    version: 1,
    canonicalRepository: 'owner/repo',
    runId: '00000000-0000-4000-8000-000000000077',
    issueNumber: 77,
    cycle: 1,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    indexTreeSha: 'c'.repeat(40),
    trackedContentSha256: 'd'.repeat(64),
    untrackedContentSha256: 'e'.repeat(64),
    worktreeIdentity: 'browser-worktree',
    changedFiles: ['fixture/index.html'],
    checks: [{ id: 'fixture', command: 'fixture-check', status: 'passed', outputSha256: 'f'.repeat(64) }],
    checkPolicySha256: '1'.repeat(64),
    packageVersion: '0.1.51',
    proofSchemaVersion: 1,
  };
}

async function runPolicyFixture(
  mutate: (input: { report: ProofReportV1; bytes: Map<string, Buffer>; metadata: Map<string, string>; changedFiles: string[] }) => void,
) {
  const capabilities = createCheckedChangeCapabilities();
  const payload = checkedPayload();
  const report = browserReport() as ProofReportV1;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const bytes = new Map(report.artifacts.map((artifact) => [artifact.relativePath, artifact.kind === 'screenshot' ? png : Buffer.from('{}\n')]));
  const metadata = new Map(report.artifacts.map((artifact) => [artifact.relativePath, '2026-07-16T12:00:01.000Z']));
  const changedFiles = report.artifacts.map((artifact) => artifact.relativePath);
  mutate({ report, bytes, metadata, changedFiles });
  for (const artifact of report.artifacts) artifact.sha256 = sha256(bytes.get(artifact.relativePath)!);
  const proof = new AcceptanceProof({
    checkedChangeReader: capabilities,
    proofRecords: new InMemoryProofRecordWriter(),
    proofAgent: { run: async () => ({ kind: 'report', report, proofPhaseChangedFiles: changedFiles }) },
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
    proofArtifactDir: 'proofs/proof-browser',
    createAttemptId: (() => { let id = 0; return () => `policy-attempt-${++id}`; })(),
    now: () => '2026-07-16T12:00:00.000Z',
  });
  const issue: IssueSnapshot = {
    number: 77,
    title: 'Browser proof policy',
    body: 'Prove the responsive browser behavior.',
    url: 'https://example.invalid/issues/77',
    state: 'OPEN',
    labels: ['agent:auto'],
  };
  return proof.proveChange({
    proofId: 'proof-browser',
    issue,
    frozenCriteria: [{ id: 'ac-web', order: 1, source: 'explicit', text: 'Browser behavior works.' }],
    checkedChange: capabilities.mint(payload),
  });
}
