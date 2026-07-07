import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type ProofPlan,
  readPlanAutoCompletionReport,
  readScopedCompletionReport,
  readScopedCompletionReportDetailed,
} from '../src/runner/completion-report.js';

const defaultProofPlan: ProofPlan = {
  mode: 'non-visual-smoke',
  reason: 'Unit tests and smoke output prove the non-visual acceptance criteria.',
  validationCommands: ['npm test -- warmup'],
  requiredArtifacts: [],
};

test('scoped completion report validation names missing required fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'report.json');
  await writeFile(reportPath, JSON.stringify({ status: 'completed' }), 'utf8');

  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: changes must be a string array/,
  );
});

test('completion report validation rejects invalid JSON clearly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'report.json');
  await writeFile(reportPath, '{not-json', 'utf8');

  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: report must be valid JSON/,
  );
});

test('detailed scoped completion report read returns structured invalid JSON evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'report.json');
  await writeFile(reportPath, '{not-json', 'utf8');

  const result = await readScopedCompletionReportDetailed(reportPath);

  assert.equal(result.kind, 'invalid');
  if (result.kind === 'invalid') {
    assert.match(result.message, /Invalid scoped completion report: report must be valid JSON/);
    assert.deepEqual(result.errors, ['Invalid scoped completion report: report must be valid JSON']);
    assert.equal(result.rawContent, '{not-json');
  }
});

test('detailed scoped completion report read truncates invalid raw content deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'report.json');
  await writeFile(reportPath, 'x'.repeat(9000), 'utf8');

  const result = await readScopedCompletionReportDetailed(reportPath);

  assert.equal(result.kind, 'invalid');
  if (result.kind === 'invalid') {
    assert.equal(result.rawContent?.length, 8000);
    assert.equal(result.rawContent, 'x'.repeat(8000));
  }
});

test('scoped completion report accepts structured review handoff for human review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'report.json');
  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'completed',
      changes: ['Updated sender disable recovery path.'],
      validation: [{ command: 'npm test -- warmup', status: 'passed', summary: 'red -> green proof passed' }],
      proofPlan: defaultProofPlan,
      artifacts: [],
      skippedChecks: [],
      residualRisks: ['No live provider smoke in local env.'],
      prohibitedActions: [],
      reviewHandoff: {
        flowUsed: 'small-task-implementer',
        riskLevel: 'low',
        implementedContract: ['Disable event schedules warmup recovery once.'],
        proofByAcceptanceCriteria: ['AC1: unit test covers disabled sender warmup outcome.'],
        reviewFocus: ['Check notification signature and warmup state naming.'],
        humanReviewChecklist: ['Read src/warmup/recovery.ts and test/warmup/recovery.test.ts.'],
      },
    }),
    'utf8',
  );

  const result = await readScopedCompletionReport(reportPath);
  assert.equal(result.kind, 'valid');
  if (result.kind === 'valid') {
    assert.equal(result.report.reviewHandoff?.flowUsed, 'small-task-implementer');
    assert.deepEqual(result.report.reviewHandoff?.reviewFocus, ['Check notification signature and warmup state naming.']);
  }
});

test('scoped completion report accepts structured TDD red-green validation evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'report.json');
  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'completed',
      changes: ['src/filters.ts'],
      validation: [{
        command: 'focused behavior proof',
        status: 'passed',
        summary: 'machine-readable proof attached',
        evidence: {
          kind: 'tdd-red-green',
          red: {
            command: 'node --test dist/test/filters.test.js',
            status: 'failed',
            summary: 'new filter behavior failed before implementation',
          },
          green: {
            command: 'node --test dist/test/filters.test.js',
            status: 'passed',
            summary: 'new filter behavior passed after implementation',
          },
        },
      }],
      proofPlan: {
        mode: 'cli',
        reason: 'Focused CLI behavior proof is sufficient.',
        validationCommands: ['focused behavior proof'],
        requiredArtifacts: [],
      },
      artifacts: [],
      skippedChecks: [],
      residualRisks: [],
      prohibitedActions: [],
    }),
    'utf8',
  );

  const result = await readScopedCompletionReport(reportPath);
  assert.equal(result.kind, 'valid');
  if (result.kind === 'valid') {
    assert.equal(result.report.validation[0]?.evidence?.kind, 'tdd-red-green');
  }
});

test('scoped completion report rejects malformed structured TDD evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'report.json');
  const baseReport = {
    status: 'completed',
    changes: ['src/filters.ts'],
    proofPlan: defaultProofPlan,
    artifacts: [],
    skippedChecks: [],
    residualRisks: [],
    prohibitedActions: [],
  };

  await writeFile(
    reportPath,
    JSON.stringify({
      ...baseReport,
      validation: [{
        command: 'focused behavior proof',
        status: 'passed',
        summary: 'malformed proof',
        evidence: {
          kind: 'tdd-red-green',
          red: { command: 'node --test', status: 'passed', summary: 'red did not fail' },
          green: { command: 'node --test', status: 'passed', summary: 'green passed' },
        },
      }],
    }),
    'utf8',
  );
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: validation evidence red status must be failed/,
  );

  await writeFile(
    reportPath,
    JSON.stringify({
      ...baseReport,
      validation: [{
        command: 'focused behavior proof',
        status: 'passed',
        summary: 'malformed proof',
        evidence: {
          kind: 'tdd-red-green',
          red: { command: 'node --test', status: 'failed', summary: 'red failed' },
          green: { command: 'node --test', status: 'failed', summary: 'green did not pass' },
        },
      }],
    }),
    'utf8',
  );
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: validation evidence green status must be passed/,
  );
});

test('scoped completion report accepts supported proof plan modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'report.json');
  for (const mode of ['none', 'non-visual-smoke', 'cli', 'api', 'worker', 'browser-visual', 'mobile-visual'] as const) {
    await writeFile(
      reportPath,
      JSON.stringify({
        status: 'completed',
        changes: ['src/feature.ts'],
        validation: [{ command: 'npm test', status: 'passed', summary: 'passed' }],
        proofPlan: {
          mode,
          reason: `${mode} proof is appropriate for this issue.`,
          validationCommands: mode === 'none' ? [] : ['npm test'],
          requiredArtifacts: [],
          ...(mode === 'browser-visual' ? { visualTarget: 'browser' } : {}),
          ...(mode === 'mobile-visual' ? { visualTarget: 'mobile' } : {}),
        },
        artifacts: [],
        skippedChecks: [],
        residualRisks: [],
        prohibitedActions: [],
      }),
      'utf8',
    );

    const result = await readScopedCompletionReport(reportPath);
    assert.equal(result.kind, 'valid');
    if (result.kind === 'valid') {
      assert.equal(result.report.proofPlan.mode, mode);
    }
  }
});

test('scoped completion report rejects missing or malformed proof plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'report.json');
  const baseReport = {
    status: 'completed',
    changes: ['src/feature.ts'],
    validation: [{ command: 'npm test', status: 'passed', summary: 'passed' }],
    artifacts: [],
    skippedChecks: [],
    residualRisks: [],
    prohibitedActions: [],
  };

  await writeFile(reportPath, JSON.stringify(baseReport), 'utf8');
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: proofPlan must be an object/,
  );

  await writeFile(
    reportPath,
    JSON.stringify({ ...baseReport, proofPlan: { ...defaultProofPlan, mode: 'analytics' } }),
    'utf8',
  );
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: proofPlan\.mode must be one of/,
  );

  await writeFile(
    reportPath,
    JSON.stringify({ ...baseReport, proofPlan: { ...defaultProofPlan, reason: '' } }),
    'utf8',
  );
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: proofPlan\.reason must be a non-empty string/,
  );

  await writeFile(
    reportPath,
    JSON.stringify({ ...baseReport, proofPlan: { ...defaultProofPlan, validationCommands: 'npm test' } }),
    'utf8',
  );
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: proofPlan\.validationCommands must be a string array/,
  );

  await writeFile(
    reportPath,
    JSON.stringify({ ...baseReport, proofPlan: { ...defaultProofPlan, validationCommands: ['npm test', ' '] } }),
    'utf8',
  );
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: proofPlan\.validationCommands must contain only non-empty strings/,
  );

  await writeFile(
    reportPath,
    JSON.stringify({ ...baseReport, proofPlan: { ...defaultProofPlan, requiredArtifacts: 'smoke.log' } }),
    'utf8',
  );
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: proofPlan\.requiredArtifacts must be a string array/,
  );

  await writeFile(
    reportPath,
    JSON.stringify({ ...baseReport, proofPlan: { ...defaultProofPlan, requiredArtifacts: ['smoke.log', ''] } }),
    'utf8',
  );
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: proofPlan\.requiredArtifacts must contain only non-empty strings/,
  );

  await writeFile(
    reportPath,
    JSON.stringify({ ...baseReport, proofPlan: { ...defaultProofPlan, visualTarget: 'desktop' } }),
    'utf8',
  );
  await assert.rejects(
    readScopedCompletionReport(reportPath),
    /Invalid scoped completion report: proofPlan\.visualTarget must be browser or mobile/,
  );
});

test('plan-auto completion report validation keeps graph errors explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-completion-'));
  const reportPath = join(root, 'plan-report.json');
  await writeFile(
    reportPath,
    JSON.stringify({
      status: 'completed',
      parent: { body: 'Parent' },
      graph: {
        nodes: [
          {
            stableId: 'child-a',
            title: 'Child A',
            body: 'Body',
            afkHitl: 'afk',
            ownershipScope: ['src/a.ts'],
            dependsOn: ['missing'],
            verification: ['npm test'],
          },
        ],
        edges: [],
        specGate: 'wave-level',
      },
      residualRisks: [],
    }),
    'utf8',
  );

  await assert.rejects(readPlanAutoCompletionReport(reportPath), /depends on unknown node/);
});
