import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readPlanAutoCompletionReport, readScopedCompletionReport } from '../src/runner/completion-report.js';

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
