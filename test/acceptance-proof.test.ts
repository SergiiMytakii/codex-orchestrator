import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  evaluateAcceptanceProofReport,
  readAcceptanceProofReport,
  type AcceptanceProofUiEvidence,
  type AcceptanceProofReport,
} from '../src/runner/acceptance-proof.js';
import { validConfig } from './fixtures/config.js';

const passingReport: AcceptanceProofReport = {
  status: 'passed',
  criteria: [{
    id: 'ac-1',
    description: 'CLI smoke proves observable behavior.',
    status: 'passed',
    confidence: 'high',
    reasoningSummary: 'The smoke output shows the expected JSON contract.',
    artifactRefs: ['.codex-orchestrator/proofs/issue-611/smoke-output.txt'],
  }],
  artifacts: [{
    type: 'smoke-output',
    path: '.codex-orchestrator/proofs/issue-611/smoke-output.txt',
    description: 'CLI smoke output',
  }],
  proofPhaseDiff: {
    allowedProofPaths: ['.codex-orchestrator/proofs/issue-611/smoke-output.txt'],
    forbiddenProductPaths: [],
  },
  residualRisks: [],
};

test('acceptance proof passes only with high-confidence criterion artifacts and no product diff', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: passingReport,
    proofPhaseChangedFiles: ['.codex-orchestrator/proofs/issue-611/smoke-output.txt'],
  });

  assert.deepEqual(result, {
    ok: true,
    reasons: [],
    warnings: [],
  });
});

test('acceptance proof rejects partial, low-confidence, or artifactless criteria', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: {
      ...passingReport,
      criteria: [
        { ...passingReport.criteria[0]!, status: 'unknown', confidence: 'high' },
        { ...passingReport.criteria[0]!, id: 'ac-2', confidence: 'medium' },
        { ...passingReport.criteria[0]!, id: 'ac-3', artifactRefs: [] },
      ],
    },
    proofPhaseChangedFiles: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /ac-1.*status unknown/);
  assert.match(result.reasons.join('\n'), /ac-2.*confidence medium/);
  assert.match(result.reasons.join('\n'), /ac-3.*artifact/);
});

test('acceptance proof rejects empty criteria and missing local artifact paths', () => {
  const empty = evaluateAcceptanceProofReport({
    config: validConfig,
    report: { ...passingReport, criteria: [] },
    proofPhaseChangedFiles: [],
  });
  const missingArtifact = evaluateAcceptanceProofReport({
    config: validConfig,
    report: passingReport,
    proofPhaseChangedFiles: [],
    artifactExists: () => false,
  });

  assert.equal(empty.ok, false);
  assert.match(empty.reasons.join('\n'), /no criteria/i);
  assert.equal(missingArtifact.ok, false);
  assert.match(missingArtifact.reasons.join('\n'), /missing artifact path/i);
});

test('acceptance proof rejects proof-phase product code changes outside proof-owned paths', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: passingReport,
    proofPhaseChangedFiles: [
      '.codex-orchestrator/proofs/issue-611/smoke-output.txt',
      'src/runner/scoped-auto-command.ts',
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /product-code changes during acceptance proof/i);
  assert.match(result.reasons.join('\n'), /src\/runner\/scoped-auto-command\.ts/);
});

const uiScreenshotPath = '.codex-orchestrator/proofs/issue-209/create-flow-advanced.png';

const uiReport: AcceptanceProofReport = {
  status: 'passed',
  criteria: [{
    id: 'ac-visual',
    description: 'Create campaign flow shows the matching slider with acceptable layout.',
    status: 'passed',
    confidence: 'high',
    reasoningSummary: 'The final desktop screenshot shows the requested create-flow state.',
    artifactRefs: [uiScreenshotPath],
  }],
  artifacts: [{
    type: 'screenshot',
    path: uiScreenshotPath,
    description: 'Create flow advanced settings screenshot',
  }],
  uiEvidence: completeUiEvidence(),
  proofPhaseDiff: {
    allowedProofPaths: [uiScreenshotPath],
    forbiddenProductPaths: [],
  },
  residualRisks: [],
};

test('acceptance proof accepts complete UI evidence contract for screenshot proof', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: uiReport,
    proofPhaseChangedFiles: [uiScreenshotPath],
  });

  assert.deepEqual(result, {
    ok: true,
    reasons: [],
    warnings: [],
  });
});

test('acceptance proof rejects UI evidence missing workflow scope', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: {
      ...uiReport,
      uiEvidence: undefined,
    },
    proofPhaseChangedFiles: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /UI Evidence workflow:/);
  assert.match(result.reasons.join('\n'), /UI Evidence viewport:/);
  assert.match(result.reasons.join('\n'), /UI Evidence freshness:/);
  assert.match(result.reasons.join('\n'), /UI Evidence layout:/);
  assert.match(result.reasons.join('\n'), /UI Evidence copy:/);
  assert.match(result.reasons.join('\n'), /UI Evidence source-input:/);
});

test('acceptance proof rejects UI evidence missing viewport coverage', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: {
      ...uiReport,
      uiEvidence: {
        ...completeUiEvidence(),
        viewportCoverage: [{
          name: 'desktop',
          width: 390,
          height: 844,
          artifactRefs: [uiScreenshotPath],
          requiredBy: 'desktop-web-layout',
        }],
      },
    },
    proofPhaseChangedFiles: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /UI Evidence viewport: desktop-web-layout viewport width/);
});

test('acceptance proof rejects UI evidence missing current artifact freshness', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: {
      ...uiReport,
      uiEvidence: {
        ...completeUiEvidence(),
        artifactFreshness: {
          currentArtifactRefs: [uiScreenshotPath],
          checkedAfterFinalRun: false,
        },
      },
    },
    proofPhaseChangedFiles: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /UI Evidence freshness:/);
});

test('acceptance proof rejects UI evidence with unmapped layout findings', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: {
      ...uiReport,
      uiEvidence: {
        ...completeUiEvidence(),
        layoutReview: {
          checked: true,
          findings: [{ summary: 'Spacing is acceptable.', artifactRefs: ['missing.png'] }],
        },
      },
    },
    proofPhaseChangedFiles: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /UI Evidence layout: .*missing artifact/);
});

test('acceptance proof rejects UI evidence with unmapped copy review', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: {
      ...uiReport,
      uiEvidence: {
        ...completeUiEvidence(),
        copyReview: {
          checked: true,
          rejectedTermsAbsent: ['strictness'],
          findings: [{ summary: 'Copy uses user-facing terms.', artifactRefs: [] }],
        },
      },
    },
    proofPhaseChangedFiles: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /UI Evidence copy:/);
});

test('acceptance proof rejects UI evidence missing source inputs', () => {
  const result = evaluateAcceptanceProofReport({
    config: validConfig,
    report: {
      ...uiReport,
      uiEvidence: {
        ...completeUiEvidence(),
        sourceInputs: {
          acceptanceCriteriaRefs: [],
          implementationEvidenceRefs: [],
        },
      },
    },
    proofPhaseChangedFiles: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /UI Evidence source-input:/);
});

test('acceptance proof loads and classifies missing, invalid, and valid proof reports', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-orchestrator-acceptance-proof-'));
  const invalidReportPath = join(tempDir, 'invalid-report.json');
  const validReportPath = join(tempDir, 'valid-report.json');
  await writeFile(invalidReportPath, '{"status":"passed"}', 'utf8');
  await writeFile(validReportPath, JSON.stringify(passingReport), 'utf8');

  assert.deepEqual(await readAcceptanceProofReport(join(tempDir, 'missing-report.json')), {
    kind: 'missing',
  });
  assert.deepEqual(await readAcceptanceProofReport(invalidReportPath), {
    kind: 'invalid',
    message: 'Invalid acceptance proof report: criteria must be an array',
  });
  assert.deepEqual(await readAcceptanceProofReport(validReportPath), {
    kind: 'valid',
    report: passingReport,
  });
});

function completeUiEvidence(): AcceptanceProofUiEvidence {
  return {
    workflowScope: {
      entrypoint: 'Campaigns > New campaign',
      path: ['Open campaigns', 'Click New campaign', 'Expand advanced settings'],
      screenState: 'New campaign create flow with advanced settings visible',
      authPath: 'real-login',
    },
    viewportCoverage: [{
      name: 'wide desktop',
      width: 1440,
      height: 900,
      artifactRefs: [uiScreenshotPath],
      requiredBy: 'desktop-web-layout',
    }],
    artifactFreshness: {
      currentArtifactRefs: [uiScreenshotPath],
      checkedAfterFinalRun: true,
    },
    layoutReview: {
      checked: true,
      findings: [{ summary: 'Spacing, padding, clipping, overlap, and alignment were reviewed.', artifactRefs: [uiScreenshotPath] }],
    },
    copyReview: {
      checked: true,
      acceptedTerms: ['Matching strictness'],
      rejectedTermsAbsent: ['vector strictness'],
      findings: [{ summary: 'No rejected implementation terms are visible.', artifactRefs: [uiScreenshotPath] }],
    },
    sourceInputs: {
      acceptanceCriteriaRefs: ['issue-815-ac-12', 'issue-815-ac-16'],
      implementationEvidenceRefs: ['implementation-report:validation'],
      reproductionSignalRefs: ['issue-815-failure-case'],
      manualQaPlanRefs: ['manual-qa-plan:create-flow'],
      runtimeValidationRefs: ['playwright:create-campaign'],
    },
  };
}
