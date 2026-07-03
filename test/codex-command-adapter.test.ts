import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CodexCommandAdapter, buildCodexProcessEnv, resolveCodexProfile } from '../src/codex/command-adapter.js';
import type { ProcessExecutor } from '../src/process/command.js';
import { validConfig } from './fixtures/config.js';

const execFileAsync = promisify(execFile);
const fixtureTargetRoot = join(tmpdir(), 'codex-orchestrator-codex-fixture-repo');

const input = {
  targetRoot: fixtureTargetRoot,
  config: validConfig,
  worktreePath: join(fixtureTargetRoot, '.codex-orchestrator', 'workspaces', 'issue-155'),
  promptPath: join(fixtureTargetRoot, '.codex-orchestrator', 'state', 'prompts', 'issue-155.md'),
  promptText: 'Prompt text',
  reportPath: join(fixtureTargetRoot, '.codex-orchestrator', 'state', 'reports', 'issue-155.json'),
  isolatedHomePath: join(fixtureTargetRoot, '.codex-orchestrator', 'state', 'codex-home', 'issue-155'),
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
    join(input.targetRoot, validConfig.runner.stateDir),
    '--ignore-user-config',
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

test('codex command adapter ignores user config even when legacy args omit the flag', async () => {
  const calls: Parameters<ProcessExecutor>[] = [];
  const executor: ProcessExecutor = async (...args) => {
    calls.push(args);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };
  const config = {
    ...validConfig,
    codex: {
      ...validConfig.codex,
      args: validConfig.codex.args.filter((arg) => arg !== '--ignore-user-config'),
    },
  };
  const adapter = new CodexCommandAdapter(config, executor);

  await adapter.run({ ...input, config });

  const [, args] = calls[0] ?? [];
  assert.ok(args);
  assert.equal(args.includes('--ignore-user-config'), true);
});

test('codex command adapter enables figma mcp only when prompt requires figma', async () => {
  const calls: Parameters<ProcessExecutor>[] = [];
  const executor: ProcessExecutor = async (...args) => {
    calls.push(args);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };
  const adapter = new CodexCommandAdapter(validConfig, executor);

  const plain = await adapter.run({
    ...input,
    promptText: 'Implement this backend issue without design assets.',
  });
  const figma = await adapter.run({
    ...input,
    promptText: 'Use the design at https://www.figma.com/design/abc123/File?node-id=1-2 before coding.',
  });

  const [, plainArgs] = calls[0] ?? [];
  const [, figmaArgs] = calls[1] ?? [];
  assert.ok(plainArgs);
  assert.ok(figmaArgs);
  assert.equal(plainArgs.some((arg) => arg.includes('mcp_servers.figma')), false);
  assert.deepEqual(plain.figmaMcp, { requirement: 'none', enabled: false });
  assert.deepEqual(figma.figmaMcp, { requirement: 'optional', enabled: true });
  assert.equal(figmaArgs.includes('--ignore-user-config'), true);
  assert.ok(figmaArgs.some((arg) => arg === 'mcp_servers.figma.url="https://mcp.figma.com/mcp"'));
  assert.ok(figmaArgs.some((arg) => arg === 'mcp_servers.figma.http_headers."X-Figma-Region"="us-east-1"'));
  assert.ok(figmaArgs.indexOf('mcp_servers.figma.url="https://mcp.figma.com/mcp"') < figmaArgs.lastIndexOf('-'));
});

test('codex command adapter disables optional figma mcp on rework but keeps required figma enabled', async () => {
  const calls: Parameters<ProcessExecutor>[] = [];
  const executor: ProcessExecutor = async (...args) => {
    calls.push(args);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };
  const adapter = new CodexCommandAdapter(validConfig, executor);

  const optional = await adapter.run({
    ...input,
    promptText: 'Use https://www.figma.com/design/abc123/File?node-id=1-2 as helpful context.',
    disableOptionalFigmaMcp: true,
  });
  const required = await adapter.run({
    ...input,
    promptText: 'This issue requires Figma source of truth before implementation.',
    disableOptionalFigmaMcp: true,
  });

  const [, optionalArgs] = calls[0] ?? [];
  const [, requiredArgs] = calls[1] ?? [];
  assert.ok(optionalArgs);
  assert.ok(requiredArgs);
  assert.equal(optionalArgs.some((arg) => arg.includes('mcp_servers.figma')), false);
  assert.equal(requiredArgs.some((arg) => arg.includes('mcp_servers.figma')), true);
  assert.deepEqual(optional.figmaMcp, { requirement: 'optional', enabled: false });
  assert.deepEqual(required.figmaMcp, { requirement: 'required', enabled: true });
});

test('codex command adapter blocks child mobile device control through a guard PATH', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-codex-guard-'));
  const guardedInput = {
    ...input,
    targetRoot,
    worktreePath: join(targetRoot, '.codex-orchestrator', 'workspaces', 'issue-155'),
    promptPath: join(targetRoot, '.codex-orchestrator', 'state', 'prompts', 'issue-155.md'),
    reportPath: join(targetRoot, '.codex-orchestrator', 'state', 'reports', 'issue-155.json'),
    isolatedHomePath: join(targetRoot, '.codex-orchestrator', 'state', 'codex-home', 'issue-155'),
  };
  const executor: ProcessExecutor = async (_file, _args, options) => {
    const guardBin = join(targetRoot, validConfig.runner.stateDir, 'mobile-device-guard', 'bin');
    assert.equal(options?.env?.PATH?.split(':')[0], guardBin);
    assert.equal(options?.env?.CODEX_ORCHESTRATOR_MOBILE_DEVICE_GUARD, '1');
    assert.match(await readFile(join(guardBin, 'emulator'), 'utf8'), /runner-owned mobile visual proof/);
    await assert.rejects(
      execFileAsync(join(guardBin, 'emulator'), ['-list-avds'], { env: options?.env }),
      /runner-owned mobile visual proof/,
    );
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };
  const adapter = new CodexCommandAdapter(validConfig, executor);

  await adapter.run(guardedInput);
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

test('codex command adapter selects phase-specific command profile deterministically', async () => {
  const calls: Parameters<ProcessExecutor>[] = [];
  const executor: ProcessExecutor = async (...args) => {
    calls.push(args);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };
  const config = {
    ...validConfig,
    codex: {
      ...validConfig.codex,
      profiles: {
        'plan-parent': {
          command: 'codex-plan',
          args: ['exec-plan', '${sessionId}'],
          timeoutMs: 12_000,
          idleTimeoutMs: 6_000,
          env: {
            CODEX_ORCHESTRATOR_PHASE: '${sessionId}',
          },
        },
      },
    },
  };
  const adapter = new CodexCommandAdapter(config, executor);

  await adapter.run({ ...input, config, phase: 'plan-parent' });

  const [file, args, options] = calls[0] ?? [];
  assert.equal(file, 'codex-plan');
  assert.deepEqual(args, ['exec-plan', input.sessionId]);
  assert.equal(options?.timeoutMs, 12_000);
  assert.equal(options?.idleTimeoutMs, 6_000);
  assert.equal(options?.env?.CODEX_ORCHESTRATOR_PHASE, input.sessionId);
});

test('codex phase profile timeout wins over per-run timeout override', async () => {
  const calls: Parameters<ProcessExecutor>[] = [];
  const executor: ProcessExecutor = async (...args) => {
    calls.push(args);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  };
  const config = {
    ...validConfig,
    codex: {
      ...validConfig.codex,
      profiles: {
        'scoped-issue': {
          timeoutMs: 22_000,
        },
      },
    },
  };
  const adapter = new CodexCommandAdapter(config, executor);

  await adapter.run({ ...input, config, phase: 'scoped-issue', timeoutMs: 44_000 });

  const [, , options] = calls[0] ?? [];
  assert.equal(options?.timeoutMs, 22_000);
});

test('codex profile fallback keeps global command values for missing phases', () => {
  const profile = resolveCodexProfile(validConfig, 'tree-child');

  assert.equal(profile.command, validConfig.codex.command);
  assert.deepEqual(profile.args, validConfig.codex.args);
  assert.equal(profile.timeoutMs, validConfig.codex.timeoutMs);
  assert.equal(profile.idleTimeoutMs, validConfig.codex.idleTimeoutMs);
});

test('codex env keeps CODEX_HOME on the user codex home for authentication', () => {
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
