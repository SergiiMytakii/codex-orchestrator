import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CodexProcess,
  ProcessQuiescenceError,
  spawnNodeSupervisedProcess,
  type SpawnSpec,
  type SpawnSupervisedProcess,
  type SupervisedChild,
} from '../src/v2/codex-process.js';
import {
  buildContainmentCodexArgs,
  buildContainmentCodexEnvironment,
  defaultContainmentOperationPolicy,
} from '../src/v2/containment.js';

test('builds the exact contained argv and allowlisted process environment without suppressing native subagents', async () => {
  await withRunFixture(async (fixture) => {
    let captured: SpawnSpec | undefined;
    const child = new FakeChild({ reportPath: fixture.reportPath });
    const processRunner = new CodexProcess(async (spec) => {
      captured = spec;
      return child;
    });
    const result = await processRunner.run(fixture.input(), new AbortController().signal);

    assert.equal(result.kind, 'completed');
    assert.deepEqual(captured?.args, buildContainmentCodexArgs({
      schemaPath: fixture.schemaPath,
      reportPath: fixture.reportPath,
      toolHome: fixture.toolHome,
      tmpDir: fixture.attemptTmp,
      safePath: fixture.safePath,
      operationPolicy: defaultContainmentOperationPolicy(),
      executionProfile: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
    }));
    assert.deepEqual(captured?.env, buildContainmentCodexEnvironment({
      parentEnv: fixture.parentEnv,
      parentCodexHome: fixture.parentCodexHome,
      safePath: fixture.safePath,
    }));
    assert.equal(captured?.args.includes('--ignore-user-config'), true);
    assert.equal(captured?.args.includes('--ignore-rules'), true);
    assert.equal(captured?.args.includes('--skip-git-repo-check'), true);
    assert.equal(captured?.args.some((arg) => arg.includes('skills.include_instructions=false')), true);
    assert.equal(captured?.args.some((arg) => arg.includes('features.apps=false')), true);
    assert.equal(captured?.args.some((arg) => arg.includes('web_search="disabled"')), true);
    assert.equal(captured?.args.some((arg) => /collab|spawn_agent|multi_agent/iu.test(arg)), false);
    assert.deepEqual(Object.keys(captured?.env ?? {}).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
    assert.equal(Object.values(captured?.env ?? {}).includes('ambient-secret'), false);
  });
});

test('contained argv rejects operation policy widening and honors a declared read-only sandbox', () => {
  const base = {
    schemaPath: '/tmp/schema.json', reportPath: '/tmp/report.json', toolHome: '/tmp/home', tmpDir: '/tmp/tmp', safePath: '/usr/bin:/bin',
  };
  const readOnly = {
    ...defaultContainmentOperationPolicy(),
    sandboxMode: 'read-only' as const,
    worktreeAccess: 'read-only' as const,
    writableRootClasses: [],
    runnerPostcondition: 'report-only' as const,
  };
  const args = buildContainmentCodexArgs({ ...base, operationPolicy: readOnly });
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.throws(() => buildContainmentCodexArgs({
    ...base,
    operationPolicy: { ...readOnly, networkHosts: ['example.com'] },
  }), /authority/iu);
  assert.throws(() => buildContainmentCodexArgs({
    ...base,
    operationPolicy: { ...readOnly, mcpTools: ['github'] },
  }), /authority/iu);
  assert.throws(() => buildContainmentCodexArgs({
    ...base,
    operationPolicy: { ...readOnly, externalWrite: true as false },
  }), /authority/iu);
});

test('awaits stdin, exit, process-group absence, streams, and only then reads the report', async () => {
  await withRunFixture(async (fixture) => {
    const events: string[] = [];
    const child = new FakeChild({ reportPath: fixture.reportPath, events });
    const result = await new CodexProcess(async () => child).run(fixture.input(), new AbortController().signal);

    assert.equal(result.kind, 'completed');
    assert.deepEqual(events, ['stdin', 'wait-exit', 'wait-group:0', 'wait-streams', 'write-report']);
    assert.equal(result.report.kind, 'available');
    assert.equal(result.stdout.toString('utf8'), 'stdout');
    assert.equal(result.stderr.toString('utf8'), 'stderr');
  });
});

test('launch gate records the spawned process before stdin and terminates on rejected persistence', async () => {
  await withRunFixture(async (fixture) => {
    const events: string[] = [];
    const acceptedChild = new FakeChild({ reportPath: fixture.reportPath, events });
    const accepted = await new CodexProcess(async () => acceptedChild).run(fixture.input({
      onSpawned: async ({ pid, processGroupId }) => {
        events.push(`gate:${pid}:${processGroupId}`);
      },
    }), new AbortController().signal);
    assert.equal(accepted.kind, 'completed');
    assert.deepEqual(events.slice(0, 2), ['gate:4242:4242', 'stdin']);

    const rejectedChild = new FakeChild({
      reportPath: fixture.reportPath,
      events: [],
      pendingExit: true,
      resolveExitOn: 'SIGTERM',
    });
    const rejected = await new CodexProcess(async () => rejectedChild).run(fixture.input({
      onSpawned: async () => { throw new Error('CAS rejected'); },
    }), new AbortController().signal);
    assert.equal(rejected.kind, 'launch-gate-failed');
    assert.equal(rejectedChild.events.includes('stdin'), false);
    assert.deepEqual(rejectedChild.terminations, ['SIGTERM']);
  });
});

test('classifies nonzero exit, spawn failure, and bounded-output overflow separately', async () => {
  await withRunFixture(async (fixture) => {
    const nonzero = await new CodexProcess(async () => new FakeChild({
      reportPath: fixture.reportPath,
      exit: { exitCode: 7, signal: null },
    })).run(fixture.input(), new AbortController().signal);
    assert.equal(nonzero.kind, 'exit-failed');

    const spawnFailure = await new CodexProcess(async () => {
      throw new Error('spawn rejected');
    }).run(fixture.input(), new AbortController().signal);
    assert.equal(spawnFailure.kind, 'spawn-failed');

    const truncated = await new CodexProcess(async () => new FakeChild({
      reportPath: fixture.reportPath,
      streams: { stdout: Buffer.from('partial'), stderr: Buffer.alloc(0), truncated: true },
    })).run(fixture.input(), new AbortController().signal);
    assert.equal(truncated.kind, 'output-truncated');
  });
});

test('classifies confirmed Codex stream disconnect without a report as transport failure', async () => {
  await withRunFixture(async (fixture) => {
    const result = await new CodexProcess(async () => new FakeChild({
      reportPath: fixture.reportPath,
      exit: { exitCode: 1, signal: null },
      writeReport: false,
      streams: {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('ERROR: stream disconnected before completion: retry the request'),
        truncated: false,
      },
    })).run(fixture.input(), new AbortController().signal);

    assert.equal(result.kind, 'transport-failed');
    assert.equal(result.report.kind, 'missing');
  });
});

test('wall timeout terminates the group and escalates to SIGKILL before returning', async () => {
  await withRunFixture(async (fixture) => {
    const child = new FakeChild({
      reportPath: fixture.reportPath,
      pendingExit: true,
      groupFailures: 1,
      resolveExitOn: 'SIGKILL',
    });
    const result = await new CodexProcess(async () => child).run(fixture.input({ timeoutMs: 30, idleTimeoutMs: 1_000 }), new AbortController().signal);
    assert.equal(result.kind, 'timeout');
    assert.deepEqual(child.terminations, ['SIGTERM', 'SIGKILL']);
    assert.equal(child.events.includes('wait-streams'), true);
  });
});

test('idle timeout is reset by stream activity and is distinct from wall timeout', async () => {
  await withRunFixture(async (fixture) => {
    const child = new FakeChild({ reportPath: fixture.reportPath, pendingExit: true, resolveExitOn: 'SIGTERM' });
    child.activityAt = Date.now();
    setTimeout(() => { child.activityAt = Date.now(); }, 15);
    const result = await new CodexProcess(async () => child).run(fixture.input({ timeoutMs: 250, idleTimeoutMs: 35 }), new AbortController().signal);
    assert.equal(result.kind, 'idle-timeout');
    assert.equal(Date.now() - child.startedAt >= 35, true);
    assert.deepEqual(child.terminations, ['SIGTERM']);
  });
});

test('caller cancellation uses the same quiescence barrier and returns only after streams close', async () => {
  await withRunFixture(async (fixture) => {
    const controller = new AbortController();
    const child = new FakeChild({ reportPath: fixture.reportPath, pendingExit: true, resolveExitOn: 'SIGTERM' });
    setTimeout(() => controller.abort(), 15);
    const result = await new CodexProcess(async () => child).run(fixture.input({ timeoutMs: 1_000, idleTimeoutMs: 1_000 }), controller.signal);
    assert.equal(result.kind, 'cancelled');
    assert.deepEqual(child.terminations, ['SIGTERM']);
    assert.equal(child.events.at(-1), 'write-report');
  });
});

test('normal parent exit with a detached descendant terminates the remaining group', async () => {
  await withRunFixture(async (fixture) => {
    const child = new FakeChild({ reportPath: fixture.reportPath, groupFailures: 1 });
    const result = await new CodexProcess(async () => child).run(fixture.input(), new AbortController().signal);
    assert.equal(result.kind, 'completed');
    assert.deepEqual(child.terminations, ['SIGTERM']);
    assert.deepEqual(child.groupTimeouts, [0, 5_000]);
  });
});

test('throws typed safe-halt evidence when group absence cannot be proved after SIGTERM and SIGKILL', async () => {
  await withRunFixture(async (fixture) => {
    const child = new FakeChild({
      reportPath: fixture.reportPath,
      pendingExit: true,
      groupFailures: Number.POSITIVE_INFINITY,
      resolveExitOn: 'SIGKILL',
    });
    await assert.rejects(
      new CodexProcess(async () => child).run(fixture.input({ timeoutMs: 20, idleTimeoutMs: 1_000 }), new AbortController().signal),
      (error: unknown) => error instanceof ProcessQuiescenceError
        && error.pid === child.pid
        && error.processGroupId === child.processGroupId,
    );
    assert.deepEqual(child.terminations, ['SIGTERM', 'SIGKILL']);
  });
});

test('throws typed safe-halt evidence when streams cannot be confirmed closed', async () => {
  await withRunFixture(async (fixture) => {
    const child = new FakeChild({ reportPath: fixture.reportPath, streamFailure: true });
    await assert.rejects(
      new CodexProcess(async () => child).run(fixture.input(), new AbortController().signal),
      (error: unknown) => error instanceof ProcessQuiescenceError
        && error.pid === child.pid
        && error.processGroupId === child.processGroupId,
    );
  });
});

test('production supervisor captures output and exit from an immediately exiting child', { timeout: 5_000 }, async () => {
  const child = await spawnNodeSupervisedProcess({
    file: '/bin/sh',
    args: ['-c', 'printf fast-output'],
    cwd: process.cwd(),
    env: { PATH: '/usr/bin:/bin' },
    stdin: '',
  });
  await child.writeStdinAndClose('');
  const exit = await child.waitForExit();
  await child.waitForGroupAbsent(1_000);
  const streams = await child.waitForStreamsClosed();
  assert.deepEqual(exit, { exitCode: 0, signal: null });
  assert.equal(streams.stdout.toString('utf8'), 'fast-output');
  assert.equal(streams.truncated, false);
});

class FakeChild implements SupervisedChild {
  readonly pid = 4242;
  readonly processGroupId = 4242;
  readonly events: string[];
  readonly terminations: Array<'SIGTERM' | 'SIGKILL'> = [];
  readonly groupTimeouts: number[] = [];
  readonly startedAt = Date.now();
  activityAt = this.startedAt;
  private readonly reportPath: string;
  private readonly streams: { stdout: Buffer; stderr: Buffer; truncated: boolean };
  private readonly exitResult: { exitCode: number | null; signal: string | null };
  private readonly pendingExit: boolean;
  private readonly resolveExitOn?: 'SIGTERM' | 'SIGKILL';
  private readonly streamFailure: boolean;
  private readonly shouldWriteReport: boolean;
  private groupFailures: number;
  private resolveExit?: (value: { exitCode: number | null; signal: string | null }) => void;

  constructor(options: {
    reportPath: string;
    events?: string[];
    streams?: { stdout: Buffer; stderr: Buffer; truncated: boolean };
    exit?: { exitCode: number | null; signal: string | null };
    pendingExit?: boolean;
    resolveExitOn?: 'SIGTERM' | 'SIGKILL';
    groupFailures?: number;
    streamFailure?: boolean;
    writeReport?: boolean;
  }) {
    this.reportPath = options.reportPath;
    this.events = options.events ?? [];
    this.streams = options.streams ?? { stdout: Buffer.from('stdout'), stderr: Buffer.from('stderr'), truncated: false };
    this.exitResult = options.exit ?? { exitCode: 0, signal: null };
    this.pendingExit = options.pendingExit ?? false;
    this.resolveExitOn = options.resolveExitOn;
    this.groupFailures = options.groupFailures ?? 0;
    this.streamFailure = options.streamFailure ?? false;
    this.shouldWriteReport = options.writeReport ?? true;
  }

  lastActivityAt(): number {
    return this.activityAt;
  }

  async writeStdinAndClose(): Promise<void> {
    this.events.push('stdin');
  }

  async waitForExit(): Promise<{ exitCode: number | null; signal: string | null }> {
    this.events.push('wait-exit');
    if (!this.pendingExit) return this.exitResult;
    return new Promise((resolveExit) => { this.resolveExit = resolveExit; });
  }

  async terminateGroup(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    this.terminations.push(signal);
    if (signal === this.resolveExitOn) this.resolveExit?.({ exitCode: null, signal });
  }

  async waitForGroupAbsent(timeoutMs: number): Promise<void> {
    this.events.push(`wait-group:${timeoutMs}`);
    this.groupTimeouts.push(timeoutMs);
    if (this.groupFailures > 0) {
      this.groupFailures -= 1;
      throw new Error('group still present');
    }
  }

  async waitForStreamsClosed(): Promise<{ stdout: Buffer; stderr: Buffer; truncated: boolean }> {
    this.events.push('wait-streams');
    if (this.streamFailure) throw new Error('streams remained open');
    if (this.shouldWriteReport) {
      await writeFile(this.reportPath, '{"status":"fixture"}\n');
      this.events.push('write-report');
    }
    return this.streams;
  }
}

async function withRunFixture(
  run: (fixture: {
    schemaPath: string;
    reportPath: string;
    toolHome: string;
    attemptTmp: string;
    safePath: string;
    parentCodexHome: string;
    parentEnv: NodeJS.ProcessEnv;
    input: (overrides?: Partial<Parameters<CodexProcess['run']>[0]>) => Parameters<CodexProcess['run']>[0];
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-process-'));
  try {
    const schemaPath = join(root, 'schema.json');
    const reportPath = join(root, 'report.json');
    const toolHome = join(root, 'tool-home');
    const attemptTmp = join(root, 'tmp');
    const parentCodexHome = join(root, 'parent-codex-home');
    const safePath = '/usr/bin:/bin';
    await Promise.all([mkdir(toolHome), mkdir(attemptTmp), mkdir(parentCodexHome)]);
    await writeFile(schemaPath, '{}\n');
    const parentEnv: NodeJS.ProcessEnv = {
      HOME: join(root, 'parent-home'),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TMPDIR: join(root, 'parent-tmp'),
      GH_TOKEN: 'ambient-secret',
    };
    await run({
      schemaPath,
      reportPath,
      toolHome,
      attemptTmp,
      safePath,
      parentCodexHome,
      parentEnv,
      input: (overrides = {}) => ({
        codexPath: '/usr/bin/codex',
        cwd: root,
        schemaPath,
        reportPath,
        toolHome,
        tmpDir: attemptTmp,
        safePath,
        parentCodexHome,
        parentEnv,
        prompt: 'Run the exact package skill.',
        timeoutMs: overrides.timeoutMs ?? 5_000,
        idleTimeoutMs: overrides.idleTimeoutMs ?? 5_000,
        operationPolicy: defaultContainmentOperationPolicy(),
        executionProfile: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
        ...(overrides.onSpawned ? { onSpawned: overrides.onSpawned } : {}),
      }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const _spawnTypeProof: SpawnSupervisedProcess | undefined = undefined;
void _spawnTypeProof;
