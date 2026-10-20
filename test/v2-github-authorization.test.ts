import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { canonicalJson } from '../src/v2/containment.js';
import { parseAgentAutoConfig } from '../src/v2/config.js';
import { hasGitHubReauthorization } from '../src/v2/runtime.js';
import type { RunRecord } from '../src/v2/run-store.js';
import { mkdtemp } from './mission-test-temp.js';

async function fixture() {
  const targetRoot = await mkdtemp(join(tmpdir(), 'github-reauthorization-'));
  const config = parseAgentAutoConfig(JSON.parse(await readFile('.codex-orchestrator/config.json', 'utf8')));
  const evidencePath = `${config.runner.stateDir}/v2/evidence/stopped.json`;
  const record = { runId: '00000000-0000-4000-8000-000000000001', issueNumber: 263,
    terminalOutcome: { status: 'cancelled', evidencePath } } as RunRecord;
  await mkdir(join(targetRoot, config.runner.stateDir, 'v2/evidence'), { recursive: true });
  await writeFile(join(targetRoot, evidencePath), JSON.stringify({ version: 1, runId: record.runId,
    recordedAt: '2026-10-06T12:00:00.900Z', summary: canonicalJson({ status: 'cancelled' }) }));
  return { targetRoot, config, record, issue: { state: 'OPEN', labels: [config.github.labels.auto.name] } };
}

test('GitHub current auto label authorizes stopped work without a new label event', async () => {
  const input = await fixture();
  input.record.updatedAt = '2026-10-13T12:00:00.000Z';
  assert.equal(await hasGitHubReauthorization(input), true);
  input.record.terminalAuthorizationGrantId = '10'; // Historical state does not override current GitHub labels.
  assert.equal(await hasGitHubReauthorization(input), true);
});

test('GitHub closure, revoked/conflicting labels and absent evidence cannot authorize execution', async () => {
  const input = await fixture();
  for (const issue of [{ state: 'CLOSED', labels: input.issue.labels }, { state: 'OPEN', labels: [] },
    ...['blocked', 'running', 'review'].map(kind => ({ state: 'OPEN', labels: [...input.issue.labels,
      input.config.github.labels[kind as 'blocked' | 'running' | 'review'].name] }))]) {
    assert.equal(await hasGitHubReauthorization({ ...input, issue }), false);
  }
  input.record.terminalOutcome!.evidencePath = `${input.config.runner.stateDir}/v2/evidence/missing.json`;
  assert.equal(await hasGitHubReauthorization(input), false);
});
