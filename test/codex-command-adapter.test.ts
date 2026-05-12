import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexCommandAdapter, buildCodexProcessEnv } from '../src/codex/command-adapter.js';
import type { ProcessExecutor } from '../src/process/command.js';
import { validConfig } from './fixtures/config.js';

const input = {
  targetRoot: '/repo',
  config: validConfig,
  worktreePath: '/repo/.codex-orchestrator/workspaces/issue-155',
  promptPath: '/repo/.codex-orchestrator/state/prompts/issue-155.md',
  promptText: 'Prompt text',
  reportPath: '/repo/.codex-orchestrator/state/reports/issue-155.json',
  isolatedHomePath: '/repo/.codex-orchestrator/state/codex-home/issue-155',
  issueNumber: 155,
  sessionId: 'issue-155-20260508120000',
  branchName: 'codex/issue-155',
};

test('codex command adapter renders args, stdin, cwd, and scrubbed env', async () => {
  const calls: Parameters<ProcessExecutor>[] = [];
  const executor: ProcessExecutor = async (...args) => {
    calls.push(args);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };
  const adapter = new CodexCommandAdapter(validConfig, executor);

  await adapter.run(input);

  const [file, args, options] = calls[0] ?? [];
  assert.equal(file, 'codex');
  assert.deepEqual(args, [
    'exec',
    '--cd',
    input.worktreePath,
    '--sandbox',
    'workspace-write',
    '--add-dir',
    '/repo/.codex-orchestrator/state',
    '-c',
    'sandbox_workspace_write.network_access=true',
    '--output-last-message',
    input.reportPath,
    '-',
  ]);
  assert.equal(options?.cwd, input.worktreePath);
  assert.equal(options?.stdin, 'Prompt text');
  assert.equal(options?.timeoutMs, 1_800_000);
  assert.equal(options?.idleTimeoutMs, 300_000);
  assert.equal(options?.env?.CODEX_ORCHESTRATOR_PROMPT_FILE, input.promptPath);
  assert.equal(options?.env?.CODEX_ORCHESTRATOR_REPORT_FILE, input.reportPath);
});

test('codex command adapter writes durable stdout and stderr stream logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-codex-log-'));
  const logPath = join(root, 'run.log');
  const executor: ProcessExecutor = async (_file, _args, options) => {
    await options?.onStdoutChunk?.('hello\n');
    await options?.onStderrChunk?.('warn\n');
    return { stdout: 'hello\n', stderr: 'warn\n', exitCode: 0 };
  };
  const adapter = new CodexCommandAdapter(validConfig, executor);

  const result = await adapter.run({ ...input, logPath });

  assert.equal(result.logPath, logPath);
  const log = await readFile(logPath, 'utf8');
  assert.match(log, /\[lifecycle\] starting codex exec/);
  assert.match(log, /\[stdout\] hello/);
  assert.match(log, /\[stderr\] warn/);
});

test('codex command adapter renders JSON-line events while preserving raw output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-codex-json-log-'));
  const logPath = join(root, 'run.log');
  const executor: ProcessExecutor = async (_file, _args, options) => {
    await options?.onStdoutChunk?.('{"type":"message","message":"working"}\nnot-json\n');
    return { stdout: 'raw', stderr: '', exitCode: 0 };
  };
  const adapter = new CodexCommandAdapter(validConfig, executor);

  await adapter.run({ ...input, logPath });

  const log = await readFile(logPath, 'utf8');
  assert.match(log, /\[stdout\] message: working/);
  assert.match(log, /\[stdout\] not-json/);
});

test('codex command adapter never renders prompt text into command args', async () => {
  const calls: Parameters<ProcessExecutor>[] = [];
  const executor: ProcessExecutor = async (...args) => {
    calls.push(args);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };
  const adapter = new CodexCommandAdapter(validConfig, executor);

  await adapter.run({
    ...input,
    promptText: 'Issue body says $(touch /tmp/owned) ${reportPath}; gh pr create',
  });

  const [, args] = calls[0] ?? [];
  assert.ok(args);
  assert.equal(args.some((arg) => arg.includes('touch /tmp/owned') || arg.includes('gh pr create')), false);
});

test('codex command adapter allows a per-run timeout override', async () => {
  const calls: Parameters<ProcessExecutor>[] = [];
  const executor: ProcessExecutor = async (...args) => {
    calls.push(args);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };
  const adapter = new CodexCommandAdapter(validConfig, executor);

  await adapter.run({ ...input, timeoutMs: 3_600_000 });

  const [, , options] = calls[0] ?? [];
  assert.equal(options?.timeoutMs, 3_600_000);
});

test('codex env defaults CODEX_HOME to the user codex home for authentication', () => {
  const env = buildCodexProcessEnv(input, {});

  assert.match(env.CODEX_HOME, /\/\.codex$/);
  assert.equal(env.HOME, input.isolatedHomePath);
});

test('codex env keeps only allowed values and drops GitHub/SSH auth', () => {
  const env = buildCodexProcessEnv(input, {
    PATH: '/bin',
    CODEX_HOME: '/codex-home',
    GH_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    SSH_AUTH_SOCK: '/tmp/ssh',
    GIT_ASKPASS: 'askpass',
  });

  assert.equal(env.PATH, '/bin');
  assert.equal(env.CODEX_HOME, '/codex-home');
  assert.equal(env.HOME, input.isolatedHomePath);
  assert.equal('GH_TOKEN' in env, false);
  assert.equal('GITHUB_TOKEN' in env, false);
  assert.equal('SSH_AUTH_SOCK' in env, false);
  assert.equal('GIT_ASKPASS' in env, false);
});
