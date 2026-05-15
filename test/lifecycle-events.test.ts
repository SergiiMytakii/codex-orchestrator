import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunnerLifecycleEventStore } from '../src/runner/lifecycle-events.js';
import { validConfig } from './fixtures/config.js';

test('lifecycle event store appends JSONL events and reads recent newest first', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-events-'));
  const store = new RunnerLifecycleEventStore(targetRoot, validConfig);

  await store.append({
    timestamp: new Date('2026-05-15T10:00:00.000Z'),
    issueNumber: 1,
    mode: 'scoped-issue',
    sessionId: 'one',
    phase: 'scoped-issue',
    status: 'started',
    summary: 'first',
    artifacts: [{ kind: 'snapshot', path: '/tmp/snapshot-one.json' }],
  });
  await store.append({
    timestamp: new Date('2026-05-15T10:01:00.000Z'),
    issueNumber: 1,
    mode: 'scoped-issue',
    sessionId: 'one',
    phase: 'quality-review',
    status: 'completed',
    summary: 'second',
  });

  const recent = await store.readRecent(1);

  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.summary, 'second');
});

test('lifecycle event store skips malformed lines when reading recent events', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-events-malformed-'));
  const store = new RunnerLifecycleEventStore(targetRoot, validConfig);
  await mkdir(join(targetRoot, validConfig.runner.stateDir, 'events'), { recursive: true });
  await writeFile(
    store.eventsPath(),
    [
      '{bad json',
      JSON.stringify({
        version: 1,
        id: 'event-id',
        timestamp: '2026-05-15T10:00:00.000Z',
        issueNumber: 1,
        mode: 'scoped-issue',
        phase: 'scoped-issue',
        status: 'started',
        summary: 'valid',
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  const recent = await store.readRecent();

  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.summary, 'valid');
});

test('lifecycle event store strips unknown fields before status can expose events', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-events-sanitize-'));
  const store = new RunnerLifecycleEventStore(targetRoot, validConfig);
  await mkdir(join(targetRoot, validConfig.runner.stateDir, 'events'), { recursive: true });
  await writeFile(
    store.eventsPath(),
    `${JSON.stringify({
      version: 1,
      id: 'event-id',
      timestamp: '2026-05-15T10:00:00.000Z',
      issueNumber: 1,
      mode: 'scoped-issue',
      phase: 'scoped-issue',
      status: 'started',
      summary: 'valid',
      rawTranscript: 'secret transcript',
      artifacts: [{ kind: 'snapshot', path: '/tmp/snapshot.json', promptText: 'hidden' }],
    })}\n`,
    'utf8',
  );

  const recent = await store.readRecent();

  assert.equal('rawTranscript' in (recent[0] as unknown as Record<string, unknown>), false);
  assert.equal('promptText' in (recent[0]?.artifacts?.[0] as unknown as Record<string, unknown>), false);
});


test('lifecycle event store uses append order as newest tie-breaker for equal timestamps', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-events-tie-'));
  const store = new RunnerLifecycleEventStore(targetRoot, validConfig);
  const timestamp = new Date('2026-05-15T10:00:00.000Z');

  await store.append({
    timestamp,
    issueNumber: 1,
    mode: 'scoped-issue',
    phase: 'scoped-issue',
    status: 'started',
    summary: 'first',
  });
  await store.append({
    timestamp,
    issueNumber: 1,
    mode: 'scoped-issue',
    phase: 'scoped-issue',
    status: 'started',
    summary: 'second',
  });

  const recent = await store.readRecent();

  assert.equal(recent[0]?.summary, 'second');
  assert.equal(recent[1]?.summary, 'first');
});
