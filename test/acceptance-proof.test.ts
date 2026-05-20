import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateAcceptanceProofReport,
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
