import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ShellCommandExecutor } from '../src/process/command.js';
import { runDoctorCommand } from '../src/runner/doctor-command.js';
import { InMemoryGitHubLabelAdapter } from '../src/setup/labels.js';
import { validConfig } from './fixtures/config.js';

async function tempRepo(config = validConfig): Promise<string> {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-doctor-'));
  await mkdir(join(targetRoot, '.codex-orchestrator', 'state'), { recursive: true });
  await writeFile(join(targetRoot, '.codex-orchestrator', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return targetRoot;
}

test('doctor command reports pass warning and failure checks as JSON without mutations', async () => {
  const targetRoot = await tempRepo();
  const shellExecutor: ShellCommandExecutor = async (command) => ({
    stdout: command.includes('rev-parse --verify') ? '' : 'ok',
    stderr: command.includes('rev-parse --verify') ? 'missing branch' : '',
    exitCode: command.includes('rev-parse --verify') ? 1 : 0,
  });
  const commandResolver = async () => '/usr/local/bin/tool';
  const labelAdapter = new InMemoryGitHubLabelAdapter([{ name: validConfig.github.labels.auto.name }]);

  const result = await runDoctorCommand({ targetRoot, shellExecutor, commandResolver, labelAdapter, json: true });

  assert.equal(result.json.version, 1);
  assert.equal(result.json.summary.pass > 0, true);
  assert.equal(result.json.summary.warn > 0, true);
  assert.equal(result.json.summary.fail > 0, true);
  assert.equal(labelAdapter.createdLabels.length, 0);
  assert.match(result.output, /"pass"/);
  assert.doesNotMatch(result.output, /GH_TOKEN|secret/);
});

test('doctor command returns config failure instead of throwing on invalid config', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'codex-orchestrator-doctor-invalid-'));
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(join(targetRoot, '.codex-orchestrator', 'config.json'), '{"version":2}\n', 'utf8');

  const result = await runDoctorCommand({ targetRoot, json: true });

  assert.equal(result.json.summary.fail, 1);
  assert.match(result.output, /Invalid config/);
});

test('doctor explains how to repair an unavailable codex command', async () => {
  const targetRoot = await tempRepo();
  const shellExecutor: ShellCommandExecutor = async (command) => ({
    stdout: '',
    stderr: '',
    exitCode: command.includes("'codex'") ? 1 : 0,
  });
  const commandResolver = async (command: string) => (command === 'codex' ? undefined : `/usr/local/bin/${command}`);

  const result = await runDoctorCommand({
    targetRoot,
    shellExecutor,
    commandResolver,
    labelAdapter: new InMemoryGitHubLabelAdapter(
      Object.values(validConfig.github.labels).map((label) => ({ name: label.name })),
    ),
    json: true,
  });

  const codexFailure = result.json.fail.find((check) => check.id === 'codex-command');

  assert.equal(
    codexFailure?.summary,
    "Codex command 'codex' is not available. Re-run setup so codex-orchestrator can persist a stable Codex CLI path.",
  );
});

test('doctor command fails when a configured phase profile command is unavailable', async () => {
  const targetRoot = await tempRepo({
    ...validConfig,
    codex: {
      ...validConfig.codex,
      profiles: {
        'fresh-context-review': {
          command: 'missing-fresh-review-codex',
        },
      },
    },
  });
  const shellExecutor: ShellCommandExecutor = async (command) => ({
    stdout: command.includes('missing-fresh-review-codex') ? '' : 'ok',
    stderr: command.includes('missing-fresh-review-codex') ? 'not found' : '',
    exitCode: command.includes('missing-fresh-review-codex') ? 1 : 0,
  });
  const commandResolver = async (command: string) =>
    command === 'missing-fresh-review-codex' ? undefined : `/usr/local/bin/${command}`;

  const result = await runDoctorCommand({
    targetRoot,
    shellExecutor,
    commandResolver,
    labelAdapter: new InMemoryGitHubLabelAdapter(Object.values(validConfig.github.labels).map((label) => ({ name: label.name }))),
    json: true,
  });

  assert.equal(result.json.fail.some((check) => check.id === 'codex-profile-fresh-context-review'), true);
});
