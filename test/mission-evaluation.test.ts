import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluate,
  normalizeLegacyPublishability,
  type EvaluationSnapshot,
  type LegacyPublishabilityNormalizationInput,
} from '../src/runner/mission-evaluation.js';
import type { ScopedCompletionReport } from '../src/runner/completion-report.js';
import type { RunnerBlocker } from '../src/runner/rework-policy.js';

test('publish-ready residual risks stay non-blocking', () => {
  const snapshot = normalizeLegacyPublishability({
    issueNumber: 227,
    baseSha: 'base-sha',
    configHash: 'config-sha256',
    candidateIdentity: {
      kind: 'git-tree',
      headSha: 'head-sha',
      treeSha: 'tree-sha',
      changedFiles: ['src/runner/example.ts'],
    },
    result: {
      status: 'publish-ready',
      report: completedReport(),
      changedFiles: ['src/runner/example.ts'],
      validation: [],
      artifacts: [],
      skippedChecks: [],
      residualRisks: ['Configured check warning: baseline test failed.'],
      commits: [],
    },
  });

  const result = evaluate(snapshot);

  assert.equal(result.blockingDisposition, 'none');
  assert.deepEqual(result.findings.map(({ disposition, reason }) => ({ disposition, reason })), [
    {
      disposition: 'residual-warning',
      reason: 'Configured check warning: baseline test failed.',
    },
  ]);
});

test('partial blockers retain inferred safety finding', () => {
  const reasons = [
    'Quality gate requires TDD evidence.',
    'Changed file .env matches denied pattern .env.',
  ];
  const partialBlockers: RunnerBlocker[] = [{
    key: 'missing-quality-gate-evidence',
    reason: reasons[0]!,
    source: 'review-gate',
    repair: 'implementation-rework',
  }];
  const snapshot = normalizeLegacyPublishability({
    issueNumber: 227,
    baseSha: 'base-sha',
    configHash: 'config-sha256',
    candidateIdentity: {
      kind: 'worktree',
      headSha: 'head-sha',
      changeSetHash: 'diff-sha256',
      changedFiles: ['.env', 'test/example.test.ts'],
    },
    result: {
      status: 'blocked',
      reasons,
      blockers: partialBlockers,
      changedFiles: ['.env', 'test/example.test.ts'],
      skippedChecks: [],
      residualRisks: [],
      commits: [],
    },
  });

  const result = evaluate(snapshot);

  assert.equal(result.blockingDisposition, 'safety-stop');
  assert.equal(result.findings.some((finding) =>
    finding.key === 'denied-path' && finding.disposition === 'safety-stop'), true);
  assert.equal(result.findings.some((finding) =>
    finding.key === 'missing-quality-gate-evidence' && finding.disposition === 'diagnose'), true);
});

test('promotion uses legacy-unobserved identity', () => {
  const snapshot = normalizeLegacyPublishability({
    issueNumber: 227,
    baseSha: 'base-sha',
    configHash: 'config-sha256',
    candidateIdentity: {
      kind: 'legacy-unobserved',
      headSha: 'head-sha',
      reason: 'promotion-before-change-set',
    },
    result: {
      status: 'promotion-requested',
      report: completedReport('needs-promotion'),
    },
  });

  const result = evaluate(snapshot);

  assert.deepEqual(snapshot.candidateIdentity, {
    kind: 'legacy-unobserved',
    headSha: 'head-sha',
    reason: 'promotion-before-change-set',
  });
  assert.equal(result.blockingDisposition, 'diagnose');
  assert.deepEqual(result.findings.map(({ key, disposition }) => ({ key, disposition })), [{
    key: 'scope-expansion',
    disposition: 'scope-expansion',
  }]);
});

test('finding identity matches golden vectors', () => {
  const snapshot: EvaluationSnapshot = {
    version: 1,
    issueNumber: 227,
    baseSha: 'base-sha',
    configHash: 'config-sha256',
    candidateIdentity: {
      kind: 'legacy-unobserved',
      headSha: 'head-sha',
      reason: 'blocked-before-change-set',
    },
    completionStatus: 'blocked',
    blockers: [],
    warnings: [{
      reason: '  Cafe\u0301 \t warning\r\n\r\n',
      evidenceRefs: ['b', 'a', 'a'],
    }],
  };

  const [finding] = evaluate(snapshot).findings;

  assert.deepEqual(finding, {
    id: 'finding:v1:097c6f554e9985466840a0b8f4bb3bce42270a17a10dd8db3a17be2198deac28',
    source: 'residual-risk',
    key: 'residual-warning',
    reason: 'Café warning',
    disposition: 'residual-warning',
    evidenceRefs: ['a', 'b'],
  });
});

test('blocked normalization covers absent, full, and multi-key blocker evidence', () => {
  const baseInput = {
    issueNumber: 227,
    baseSha: 'base-sha',
    configHash: 'config-sha256',
    candidateIdentity: {
      kind: 'legacy-unobserved' as const,
      headSha: 'head-sha',
      reason: 'blocked-before-change-set' as const,
    },
  };
  const absent = normalizeLegacyPublishability({
    ...baseInput,
    result: blockedResult(['Codex completed without file changes']),
  });
  assert.deepEqual(absent.blockers.map((blocker) => blocker.key), ['no-changed-files']);

  const fullReason = 'Quality gate requires TDD evidence.';
  const full = normalizeLegacyPublishability({
    ...baseInput,
    result: blockedResult([fullReason], [{
      key: 'missing-quality-gate-evidence',
      reason: fullReason,
      source: 'publishability',
      repair: 'implementation-rework',
    }]),
  });
  assert.deepEqual(full.blockers.map((blocker) => blocker.key), ['missing-quality-gate-evidence']);

  const multi = normalizeLegacyPublishability({
    ...baseInput,
    result: blockedResult([
      'Quality gate requires TDD evidence. One or more configured checks failed.',
    ]),
  });
  assert.deepEqual(multi.blockers.map((blocker) => blocker.key), [
    'failed-configured-checks',
    'missing-quality-gate-evidence',
  ]);
});

function completedReport(status: 'completed' | 'needs-promotion' = 'completed'): ScopedCompletionReport {
  return {
    status,
    changes: ['Updated runner behavior.'],
    validation: [],
    proofPlan: {
      mode: 'non-visual-smoke',
      reason: 'Focused non-visual validation.',
      validationCommands: ['npm test'],
      requiredArtifacts: [],
    },
    artifacts: [],
    skippedChecks: [],
    residualRisks: [],
    prohibitedActions: [],
    ...(status === 'needs-promotion'
      ? {
          promotion: {
            reason: 'Ownership must expand to the related config.',
            criteria: ['Runner approves related config scope.'],
            evidence: ['The implementation imports the config.'],
          },
        }
      : {}),
  };
}

function blockedResult(
  reasons: string[],
  blockers?: RunnerBlocker[],
): LegacyPublishabilityNormalizationInput['result'] {
  return {
    status: 'blocked',
    reasons,
    ...(blockers ? { blockers } : {}),
    changedFiles: [],
    skippedChecks: [],
    residualRisks: [],
    commits: [],
  };
}
