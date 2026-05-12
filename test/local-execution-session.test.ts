import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLocalExecutionSession } from '../src/runner/local-execution-session.js';

test('local execution session runs multiple phases against one worktree and aggregates evidence', async () => {
  const seen: Array<[string, string]> = [];

  const result = await runLocalExecutionSession({
    worktreePath: '/repo/.codex-orchestrator/workspaces/issue-17',
    phases: ['implementation', 'code-review'],
    async executePhase(input) {
      seen.push([input.phaseId, input.worktreePath]);
      return {
        phaseId: input.phaseId,
        status: 'passed',
        validation: [{ command: input.phaseId, status: 'passed', summary: 'ok' }],
        artifacts: [{ type: 'log', path: `/logs/${input.phaseId}.log`, description: `${input.phaseId} log` }],
        residualRisks: [],
      };
    },
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.publishReady, true);
  assert.deepEqual(seen, [
    ['implementation', '/repo/.codex-orchestrator/workspaces/issue-17'],
    ['code-review', '/repo/.codex-orchestrator/workspaces/issue-17'],
  ]);
  assert.deepEqual(result.phaseResults.map((phase) => phase.validation[0]?.command), ['implementation', 'code-review']);
  assert.deepEqual(result.phaseResults.map((phase) => phase.artifacts[0]?.path), ['/logs/implementation.log', '/logs/code-review.log']);
});

test('local execution session stops on a failing phase and blocks publication', async () => {
  const seen: string[] = [];

  const result = await runLocalExecutionSession({
    worktreePath: '/repo/.codex-orchestrator/workspaces/issue-17',
    phases: ['implementation', 'cleanup-review', 'code-review'],
    async executePhase(input) {
      seen.push(input.phaseId);
      return {
        phaseId: input.phaseId,
        status: input.phaseId === 'cleanup-review' ? 'failed' : 'passed',
        validation: [{ command: input.phaseId, status: input.phaseId === 'cleanup-review' ? 'failed' : 'passed', summary: 'result' }],
        artifacts: [{ type: 'log', path: `/logs/${input.phaseId}.log`, description: `${input.phaseId} log` }],
        residualRisks: input.phaseId === 'cleanup-review' ? ['cleanup finding remains'] : [],
      };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.publishReady, false);
  assert.deepEqual(seen, ['implementation', 'cleanup-review']);
  assert.deepEqual(result.phaseResults.at(-1)?.residualRisks, ['cleanup finding remains']);
});
