import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  runResolutionMission,
  type MissionAuthorizationDecision,
  type MissionResolutionDependencies,
  type MissionResolutionInput,
  type MissionResolutionProposal,
} from '../src/runner/mission-resolution-loop.js';
import type { EvaluationSnapshot } from '../src/runner/mission-evaluation.js';

test('issue 227 configured-check blocker reaches candidate-ready through the full mission loop', async () => {
  const stages: string[] = [];
  const result = await runResolutionMission(baseInput(), dependencies({
    diagnose: async () => {
      stages.push('diagnose');
      return runnerAction('frontend-targeted-eslint');
    },
    authorize: async ({ proposal, actionKey }) => {
      stages.push('authorize');
      return allowed(actionKey, proposal);
    },
    execute: async ({ actionKey }) => {
      stages.push('execute');
      return {
        kind: 'completed',
        receipt: {
          id: `receipt:${actionKey}`,
          actionKey,
          evidenceRefs: ['proof:targeted-eslint-passed'],
        },
      };
    },
    reconcile: async () => {
      stages.push('reconcile');
      return {
        kind: 'satisfied',
        snapshot: publishReadySnapshot(),
        scope: ['src/frontend/context/AuthContext.tsx', 'src/frontend/lib/errorUtils.ts'],
        validationReceiptIds: ['proof:targeted-eslint-passed'],
        acceptanceCoverage: ['issue-227:error-formatting'],
      };
    },
  }));

  assert.equal(result.kind, 'candidate-ready');
  assert.deepEqual(stages, ['diagnose', 'authorize', 'execute', 'reconcile']);
  assert.equal(result.evaluation.blockingDisposition, 'none');
  assert.equal(result.history.some((entry) => entry.outcome === 'progress'), true);
  assert.equal('blocked' in result, false);
});

test('rejected recoverable authorization feeds alternatives into a fresh diagnosis', async () => {
  const diagnosisContexts: Array<{ alternatives: string[]; suppressed: string[] }> = [];
  let authorizations = 0;
  const result = await runResolutionMission(baseInput(), dependencies({
    diagnose: async (context) => {
      diagnosisContexts.push({
        alternatives: context.alternatives,
        suppressed: context.suppressedStrategyFingerprints,
      });
      return diagnosisContexts.length === 1
        ? runnerAction('repo-level-broken-lint')
        : runnerAction('frontend-targeted-eslint');
    },
    authorize: async ({ proposal, actionKey }) => {
      authorizations += 1;
      return authorizations === 1
        ? {
            kind: 'rejected-recoverable',
            reason: 'legacy-shell-command-is-not-safe',
            alternatives: ['use frontend-targeted-eslint'],
          }
        : allowed(actionKey, proposal);
    },
    reconcile: successfulReconciliation,
  }));

  assert.equal(result.kind, 'candidate-ready');
  assert.deepEqual(diagnosisContexts[1]?.alternatives, ['use frontend-targeted-eslint']);
  assert.equal(result.history.some((entry) => entry.outcome === 'authorization-rejected'), true);
});

test('transient execution resumes and replays the exact action key without strategy penalty', async () => {
  let diagnoseCalls = 0;
  let firstActionKey = '';
  const first = await runResolutionMission(baseInput(), dependencies({
    diagnose: async () => {
      diagnoseCalls += 1;
      return runnerAction('frontend-targeted-eslint');
    },
    execute: async ({ actionKey }) => {
      firstActionKey = actionKey;
      return {
        kind: 'transient',
        reason: 'sandbox-worker-restarted',
        nextEligibleAt: '2026-07-14T18:01:00.000Z',
      };
    },
  }));

  assert.equal(first.kind, 'resumable');
  assert.equal(first.kind === 'resumable' ? first.resumeTarget : undefined, 'executing');
  assert.equal(first.history.some((entry) => entry.outcome === 'strategy-stagnated'), false);

  const replayKeys: string[] = [];
  const second = await runResolutionMission({
    ...baseInput(),
    resume: first.kind === 'resumable' ? first.resume : undefined,
    history: first.history,
  }, dependencies({
    diagnose: async () => {
      diagnoseCalls += 1;
      return runnerAction('must-not-rediagnose');
    },
    execute: async ({ actionKey }) => {
      replayKeys.push(actionKey);
      return {
        kind: 'completed',
        receipt: { id: 'receipt:replayed', actionKey, evidenceRefs: [] },
      };
    },
    reconcile: successfulReconciliation,
  }));

  assert.equal(second.kind, 'candidate-ready');
  assert.deepEqual(replayKeys, [firstActionKey]);
  assert.equal(diagnoseCalls, 1);
});

test('deterministically completed no-progress strategy stagnates and forces a materially new strategy', async () => {
  const diagnosisContexts: string[][] = [];
  let reconciliations = 0;
  const result = await runResolutionMission(baseInput(), dependencies({
    diagnose: async (context) => {
      diagnosisContexts.push(context.suppressedStrategyFingerprints);
      return runnerAction(diagnosisContexts.length === 1
        ? 'rerun-broken-repo-lint'
        : 'frontend-targeted-eslint');
    },
    reconcile: async () => {
      reconciliations += 1;
      return reconciliations === 1
        ? {
            kind: 'satisfied',
            snapshot: blockedSnapshot(),
            scope: ['src/frontend/context/AuthContext.tsx', 'src/frontend/lib/errorUtils.ts'],
            validationReceiptIds: [],
            acceptanceCoverage: ['issue-227:error-formatting'],
          }
        : successfulReconciliation();
    },
  }));

  assert.equal(result.kind, 'candidate-ready');
  assert.equal(result.history.some((entry) => entry.outcome === 'strategy-stagnated'), true);
  assert.equal(diagnosisContexts[1]?.length, 1);
});

test('only evidence-backed external and safety proposals terminate the mission', async () => {
  const external = await runResolutionMission(baseInput(), dependencies({
    diagnose: async () => ({
      version: 1,
      kind: 'external-input',
      evidence: ['credential:required-design-system'],
      resumePredicate: 'design-system credential is installed',
    }),
    authorize: async ({ proposal }) => proposal.kind === 'external-input'
      ? {
          kind: 'external-input-required',
          evidence: proposal.evidence,
          resumePredicate: proposal.resumePredicate,
        }
      : { kind: 'rejected-recoverable', reason: 'wrong proposal', alternatives: [] },
  }));
  assert.deepEqual(external.kind === 'external-input-required' ? {
    kind: external.kind,
    evidence: external.evidence,
    resumePredicate: external.resumePredicate,
  } : external, {
    kind: 'external-input-required',
    evidence: ['credential:required-design-system'],
    resumePredicate: 'design-system credential is installed',
  });

  const safety = await runResolutionMission(baseInput(), dependencies({
    diagnose: async () => ({
      version: 1,
      kind: 'safety-stop',
      evidence: ['path:.env.production'],
      invariant: 'secret-boundary',
    }),
    authorize: async ({ proposal }) => proposal.kind === 'safety-stop'
      ? {
          kind: 'safety-stop',
          evidence: proposal.evidence,
          invariant: proposal.invariant,
        }
      : { kind: 'rejected-recoverable', reason: 'wrong proposal', alternatives: [] },
  }));
  assert.deepEqual(safety.kind === 'safety-stop' ? {
    kind: safety.kind,
    evidence: safety.evidence,
    invariant: safety.invariant,
  } : safety, {
    kind: 'safety-stop',
    evidence: ['path:.env.production'],
    invariant: 'secret-boundary',
  });
});

test('an Agent cannot unilaterally prove an external or safety boundary', async () => {
  let executions = 0;
  const result = await runResolutionMission(baseInput(), dependencies({
    diagnose: async () => ({
      version: 1,
      kind: 'external-input',
      evidence: ['model-claim:not-runner-verified'],
      resumePredicate: 'someone changes something',
    }),
    authorize: async ({ proposal, actionKey }) => allowed(actionKey, proposal),
    execute: async () => {
      executions += 1;
      throw new Error('terminal proposal must not execute');
    },
  }));

  assert.equal(result.kind, 'safety-stop');
  assert.equal(result.kind === 'safety-stop' ? result.invariant : '',
    'terminal-boundary-not-runner-verified');
  assert.equal(executions, 0);
});

test('resume and reconciliation reject stale Mission identity', async () => {
  const first = await runResolutionMission(baseInput(), dependencies({
    execute: async () => ({
      kind: 'transient',
      reason: 'worker-restarted',
      nextEligibleAt: '2026-07-14T18:01:00.000Z',
    }),
  }));
  assert.equal(first.kind, 'resumable');
  const stale = await runResolutionMission({
    ...baseInput(),
    snapshot: {
      ...blockedSnapshot(),
      candidateIdentity: {
        ...blockedSnapshot().candidateIdentity,
        kind: 'worktree',
        changeSetHash: 'changed-under-resume',
        changedFiles: ['src/frontend/context/AuthContext.tsx'],
      },
    },
    resume: first.kind === 'resumable' ? first.resume : undefined,
  }, dependencies());
  assert.equal(stale.kind, 'safety-stop');
  assert.equal(stale.kind === 'safety-stop' ? stale.invariant : '', 'stale-resolution-resume');

  const drift = await runResolutionMission(baseInput(), dependencies({
    reconcile: async () => ({
      kind: 'satisfied',
      snapshot: { ...publishReadySnapshot(), issueNumber: 228 },
      scope: ['src/frontend/context/AuthContext.tsx'],
      validationReceiptIds: [],
      acceptanceCoverage: [],
    }),
  }));
  assert.equal(drift.kind, 'safety-stop');
  assert.equal(drift.kind === 'safety-stop' ? drift.invariant : '',
    'reconciliation-snapshot-identity-mismatch');
});

test('step budget exhaustion schedules diagnosis instead of producing internal blocked', async () => {
  const result = await runResolutionMission({ ...baseInput(), maxSteps: 1 }, dependencies({
    authorize: async () => ({
      kind: 'rejected-recoverable',
      reason: 'try-another-strategy',
      alternatives: ['inspect package metadata'],
    }),
  }));

  assert.equal(result.kind, 'resumable');
  assert.equal(result.kind === 'resumable' ? result.resumeTarget : undefined, 'diagnosing');
  assert.equal(JSON.stringify(result).includes('blocked'), false);
});

function baseInput(): MissionResolutionInput {
  return {
    missionId: 'mission-intellireach-227',
    snapshot: blockedSnapshot(),
    scope: ['src/frontend/context/AuthContext.tsx', 'src/frontend/lib/errorUtils.ts'],
    validationReceiptIds: [],
    acceptanceCoverage: ['issue-227:error-formatting'],
    maxSteps: 8,
  };
}

function blockedSnapshot(): EvaluationSnapshot {
  return {
    version: 1,
    issueNumber: 227,
    baseSha: 'base-227',
    configHash: 'config-227',
    candidateIdentity: {
      kind: 'worktree',
      headSha: 'head-227',
      changeSetHash: 'changes-227',
      changedFiles: [
        'src/frontend/context/AuthContext.tsx',
        'src/frontend/lib/errorUtils.spec.ts',
        'src/frontend/lib/errorUtils.ts',
      ],
    },
    completionStatus: 'blocked',
    blockers: [{
      key: 'failed-configured-checks',
      source: 'configured-check',
      repair: 'implementation-rework',
      reason: 'npm --prefix src/frontend run lint failed before linting; targeted ESLint passed.',
    }],
    warnings: [],
  };
}

function publishReadySnapshot(): EvaluationSnapshot {
  return {
    ...blockedSnapshot(),
    completionStatus: 'completed',
    blockers: [],
    warnings: [{
      reason: 'Repo-level frontend lint script remains incompatible; targeted ESLint passed.',
      evidenceRefs: ['proof:targeted-eslint-passed'],
    }],
  };
}

function runnerAction(executorId: string): MissionResolutionProposal {
  return {
    version: 1,
    kind: 'runner-action',
    executorId,
    findingIds: ['finding:failed-frontend-lint'],
    rationale: 'collect deterministic lint evidence',
  };
}

function allowed(
  actionKey: string,
  proposal: MissionResolutionProposal,
): MissionAuthorizationDecision {
  return {
    kind: 'allowed',
    permit: {
      id: `permit:${actionKey}`,
      actionKey,
      strategyFingerprint: '',
      proposal,
    },
  };
}

function dependencies(
  overrides: Partial<MissionResolutionDependencies> = {},
): MissionResolutionDependencies {
  return {
    diagnose: async () => runnerAction('frontend-targeted-eslint'),
    authorize: async ({ proposal, actionKey }) => allowed(actionKey, proposal),
    execute: async ({ actionKey }) => ({
      kind: 'completed',
      receipt: { id: `receipt:${actionKey}`, actionKey, evidenceRefs: [] },
    }),
    reconcile: successfulReconciliation,
    nextEligibleAt: () => '2026-07-14T18:05:00.000Z',
    ...overrides,
  };
}

async function successfulReconciliation() {
  return {
    kind: 'satisfied' as const,
    snapshot: publishReadySnapshot(),
    scope: ['src/frontend/context/AuthContext.tsx', 'src/frontend/lib/errorUtils.ts'],
    validationReceiptIds: ['proof:targeted-eslint-passed'],
    acceptanceCoverage: ['issue-227:error-formatting'],
  };
}
