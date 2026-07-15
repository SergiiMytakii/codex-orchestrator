import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeBridgeRuntimeManifest } from '../src/bridge-runtime.js';
import { InMemoryGitHubIssueAdapter } from '../src/github/issues.js';
import { RunnerStateStore } from '../src/runner/local-state.js';
import {
  inspectBridgeProcesses,
  prepareSkillRuntimeV2,
  type BridgeProcessIdentity,
} from '../src/setup/skill-runtime-v2-preparation.js';
import { validConfig } from './fixtures/config.js';
import { issueFixture } from './fixtures/issues.js';

async function targetFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-runtime-v2-target-'));
  await mkdir(join(root, '.codex-orchestrator'), { recursive: true });
  await writeFile(join(root, '.codex-orchestrator/config.json'), `${JSON.stringify(validConfig, null, 2)}\n`, 'utf8');
  return root;
}

async function bridgePackageFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-runtime-v2-bridge-'));
  await mkdir(join(root, 'dist/src'), { recursive: true });
  await mkdir(join(root, 'prompts'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"codex-orchestrator","version":"1.2.3"}\n', 'utf8');
  await writeFile(join(root, 'dist/src/cli.js'), '#!/usr/bin/env node\n', 'utf8');
  await chmod(join(root, 'dist/src/cli.js'), 0o755);
  await writeFile(join(root, 'prompts/setup-skill.md'), 'prompt\n', 'utf8');
  await writeFile(join(root, 'README.md'), 'readme\n', 'utf8');
  await writeFile(join(root, 'docs/deep-dive.md'), 'deep\n', 'utf8');
  await writeFile(join(root, 'CHANGELOG.md'), 'change\n', 'utf8');
  await writeBridgeRuntimeManifest(root);
  return root;
}

const fenceIdentity = {
  hostId: 'host-a',
  bootNonce: 'boot-a',
  pid: 101,
  isProcessAlive: () => true,
};

test('preparation writes canonical fsynced zero-drain evidence under the exclusive fence', async () => {
  const targetRoot = await targetFixture();
  const packageRoot = await bridgePackageFixture();
  const result = await prepareSkillRuntimeV2(
    { targetRoot },
    {
      packageRoot,
      issueAdapter: new InMemoryGitHubIssueAdapter(),
      inspectProcesses: async () => [],
      now: new Date('2026-07-15T12:00:00.000Z'),
      ...fenceIdentity,
    },
  );

  assert.equal(result.generation.bridgePackageVersion, '1.2.3');
  assert.deepEqual(result.generation.inspectedProcesses, []);
  assert.deepEqual(result.generation.runnerState.nonterminalV1RunIds, []);
  assert.deepEqual(result.generation.githubDrain.runningIssueNumbers, []);
  assert.equal(result.generation.activityFenceGeneration, 1);
  assert.equal(JSON.parse(await readFile(result.path, 'utf8')).canonicalTargetRoot, result.generation.canonicalTargetRoot);
  assert.equal((await stat(result.path)).isFile(), true);
});

test('preparation fails closed on local, GitHub, or matching daemon activity without writing generation', async () => {
  const targetRoot = await targetFixture();
  const packageRoot = await bridgePackageFixture();
  const store = new RunnerStateStore(targetRoot, validConfig);
  await store.upsertRun({
    issueNumber: 77,
    mode: 'scoped-issue',
    workspacePath: '.codex-orchestrator/workspaces/issue-77',
    sessionId: 'issue-77',
    retryCount: 0,
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
  });
  const generationPath = join(targetRoot, validConfig.runner.stateDir, 'skill-runtime-v2/prepared-generation.json');

  await assert.rejects(prepareSkillRuntimeV2(
    { targetRoot },
    { packageRoot, issueAdapter: new InMemoryGitHubIssueAdapter(), inspectProcesses: async () => [], ...fenceIdentity },
  ), /bridge-v1-local-state-active.*77/);
  await assert.rejects(stat(generationPath), /ENOENT/);

  await store.removeRun(77);
  const running = issueFixture({ number: 88, labels: [validConfig.github.labels.running.name] });
  await assert.rejects(prepareSkillRuntimeV2(
    { targetRoot },
    { packageRoot, issueAdapter: new InMemoryGitHubIssueAdapter([running]), inspectProcesses: async () => [], ...fenceIdentity },
  ), /bridge-v1-github-claim-active.*88/);

  const cliPath = join(packageRoot, 'dist/src/cli.js');
  const process: BridgeProcessIdentity = {
    pid: 333,
    uid: typeof globalThis.process.getuid === 'function' ? globalThis.process.getuid() : 0,
    startTime: '100',
    executable: processExecPath(),
    argv: [processExecPath(), cliPath, 'daemon', '--target', targetRoot],
  };
  await assert.rejects(prepareSkillRuntimeV2(
    { targetRoot },
    { packageRoot, issueAdapter: new InMemoryGitHubIssueAdapter(), inspectProcesses: async () => [process], ...fenceIdentity },
  ), /bridge-v1-daemon-active.*333/);
  await assert.rejects(stat(generationPath), /ENOENT/);
});

test('preparation maps GitHub read failure and bridge generation mismatch to stable blockers', async () => {
  const targetRoot = await targetFixture();
  const packageRoot = await bridgePackageFixture();
  const unavailable = new InMemoryGitHubIssueAdapter();
  unavailable.listOpenIssuesWithAnyLabel = async () => { throw new Error('network down'); };
  await assert.rejects(prepareSkillRuntimeV2(
    { targetRoot },
    { packageRoot, issueAdapter: unavailable, inspectProcesses: async () => [], ...fenceIdentity },
  ), /bridge-github-drain-unavailable/);

  const otherPackage = await bridgePackageFixture();
  await writeFile(join(otherPackage, 'README.md'), 'different\n', 'utf8');
  await writeBridgeRuntimeManifest(otherPackage);
  const cliPath = join(otherPackage, 'dist/src/cli.js');
  await assert.rejects(prepareSkillRuntimeV2(
    { targetRoot },
    {
      packageRoot,
      issueAdapter: new InMemoryGitHubIssueAdapter(),
      inspectProcesses: async () => [{
        pid: 444,
        uid: typeof globalThis.process.getuid === 'function' ? globalThis.process.getuid() : 0,
        startTime: '200',
        executable: processExecPath(),
        argv: [processExecPath(), cliPath, 'daemon', '--target', targetRoot],
      }],
      ...fenceIdentity,
    },
  ), /bridge-package-generation-mismatch/);
});

test('Linux process inspection records exact proc identity and unsupported platforms fail closed', async () => {
  const procRoot = await mkdtemp(join(tmpdir(), 'bridge-proc-'));
  await mkdir(join(procRoot, '321'), { recursive: true });
  await writeFile(join(procRoot, '321/status'), 'Name:\tnode\nUid:\t501\t501\t501\t501\n', 'utf8');
  await writeFile(join(procRoot, '321/stat'), '321 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 98765 20\n', 'utf8');
  await writeFile(join(procRoot, '321/cmdline'), `/usr/bin/node\0/pkg/dist/src/cli.js\0daemon\0--target\0/tmp/repo\0`, 'utf8');
  await writeFile(join(procRoot, '321/exe-target'), '/usr/bin/node', 'utf8');

  const processes = await inspectBridgeProcesses({
    platform: 'linux',
    procRoot,
    readExecutable: async (pid) => readFile(join(procRoot, String(pid), 'exe-target'), 'utf8'),
  });
  assert.deepEqual(processes, [{
    pid: 321,
    uid: 501,
    startTime: '98765',
    executable: '/usr/bin/node',
    argv: ['/usr/bin/node', '/pkg/dist/src/cli.js', 'daemon', '--target', '/tmp/repo'],
  }]);
  await assert.rejects(inspectBridgeProcesses({ platform: 'win32' }), /bridge-process-introspection-unsupported/);
});

test('Darwin inspection fails closed before target filtering when daemon argv boundaries are unavailable', async () => {
  const calls: string[] = [];
  await assert.rejects(inspectBridgeProcesses({
    platform: 'darwin',
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'ps' && args.includes('-axo')) return '7\n8\n';
      if (command === 'ps' && args[1] === '7') {
        return '501 Wed Jul 15 10:00:00 2026 /usr/bin/node "/Users/me/My Projects/pkg/dist/src/cli.js" daemon --target /tmp/foo bar\n';
      }
      if (command === 'ps') return '501 Wed Jul 15 10:00:01 2026 /usr/bin/sleep 10\n';
      if (command === 'lsof') return 'p7\nfcwd\nn/usr/bin/node\n';
      throw new Error('unexpected command');
    },
  }), /bridge-process-introspection-unsupported.*does not preserve exact argv boundaries/);
  assert.equal(calls.filter((call) => call.startsWith('lsof ')).length, 1);
});

test('Darwin inspection succeeds when no orchestrator daemon candidate exists', async () => {
  const calls: string[] = [];
  const processes = await inspectBridgeProcesses({
    platform: 'darwin',
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'ps' && args.includes('-axo')) return '8\n';
      if (command === 'ps') return '501 Wed Jul 15 10:00:01 2026 /usr/bin/sleep 10\n';
      throw new Error('unexpected command');
    },
  });

  assert.deepEqual(processes, []);
  assert.equal(calls.some((call) => call.startsWith('lsof ')), false);
});

test('preparation rejects ambiguous argv and executable identity before GitHub drain', async () => {
  const targetRoot = await targetFixture();
  const packageRoot = await bridgePackageFixture();
  const cliPath = join(packageRoot, 'dist/src/cli.js');
  const base: BridgeProcessIdentity = {
    pid: 555,
    uid: typeof globalThis.process.getuid === 'function' ? globalThis.process.getuid() : 0,
    startTime: '300',
    executable: processExecPath(),
    argv: [processExecPath(), cliPath, 'daemon', '--target', '.'],
  };
  await assert.rejects(prepareSkillRuntimeV2(
    { targetRoot },
    { packageRoot, issueAdapter: new InMemoryGitHubIssueAdapter(), inspectProcesses: async () => [base], ...fenceIdentity },
  ), /bridge-process-argv-ambiguous/);
  await assert.rejects(prepareSkillRuntimeV2(
    { targetRoot },
    {
      packageRoot,
      issueAdapter: new InMemoryGitHubIssueAdapter(),
      inspectProcesses: async () => [{ ...base, executable: '/definitely/not/the/node', argv: [processExecPath(), cliPath, 'daemon', '--target', targetRoot] }],
      ...fenceIdentity,
    },
  ), /bridge-process-executable-mismatch/);
});

function processExecPath(): string {
  return globalThis.process.execPath;
}
