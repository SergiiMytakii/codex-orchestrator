import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { validateConfigV2, type CodexOrchestratorConfigV2 } from '../src/config/schema.js';
import { InMemoryGitHubLabelAdapter } from '../src/setup/labels.js';
import { runSetupCommand } from '../src/setup/setup-command.js';
import { migrateConfigV1ToV2 } from '../src/setup/skill-runtime-v2-migration.js';
import { validConfig } from './fixtures/config.js';

const execFileAsync = promisify(execFile);

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-orchestrator-test-'));
}

async function initGitHubRemote(targetRoot: string, remoteUrl: string): Promise<void> {
  await execFileAsync('git', ['-C', targetRoot, 'init']);
  await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', remoteUrl]);
}

async function initTrackedBranch(targetRoot: string, branchName: string): Promise<void> {
  const remote = join(await mkdtemp(join(tmpdir(), 'codex-orchestrator-remote-')), 'remote.git');
  await execFileAsync('git', ['init', '--bare', remote]);
  await execFileAsync('git', ['-C', targetRoot, 'init', '-b', branchName]);
  await execFileAsync('git', ['-C', targetRoot, 'config', 'user.name', 'Test User']);
  await execFileAsync('git', ['-C', targetRoot, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(targetRoot, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['-C', targetRoot, 'add', 'README.md']);
  await execFileAsync('git', ['-C', targetRoot, 'commit', '-m', 'Initial']);
  await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', remote]);
  await execFileAsync('git', ['-C', targetRoot, 'push', '-u', 'origin', branchName]);
}

function configV2(): CodexOrchestratorConfigV2 {
  return structuredClone(migrateConfigV1ToV2(validConfig));
}

async function writeConfig(targetRoot: string, config: unknown): Promise<void> {
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
}

test('setup creates config v2 without target prompt copies', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubLabelAdapter([{ name: 'agent:auto' }]);

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: adapter,
  });

  const persisted = JSON.parse(
    await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'),
  ) as unknown;
  assert.equal(result.config.version, 2);
  assert.equal(validateConfigV2(persisted).ok, true);
  assert.deepEqual(
    JSON.parse(await readFile(join(targetRoot, '.codex-orchestrator', 'state', 'runner-state.json'), 'utf8')),
    { version: 2, generation: 0, runs: [] },
  );
  assert.equal(adapter.createdLabels.length, 0);
  await assert.rejects(
    readFile(join(targetRoot, '.codex-orchestrator', 'prompts', 'setup-skill.md'), 'utf8'),
    /ENOENT/,
  );
  assert.match(result.output, /skill runtime: package-owned v2/);
});

test('setup chooses the current upstream branch as the explicit Codex PR base', async () => {
  const targetRoot = await tempRepo();
  await initTrackedBranch(targetRoot, 'sirbro-dev');

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'M-Ivonin',
    githubRepo: 'tipsterBro',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.deepEqual(result.config.branches.base, { mode: 'explicit', remote: 'origin', branch: 'sirbro-dev' });
  assert.match(result.output, /branches: base origin\/sirbro-dev/);
});

test('setup adds checked orchestrator npm scripts and preserves user scripts', async () => {
  const targetRoot = await tempRepo();
  await writeFile(
    join(targetRoot, 'package.json'),
    `${JSON.stringify({
      name: 'target-project',
      scripts: {
        test: 'node --test',
        'orchestrator:doctor': 'npm run build --silent && node dist/src/cli.js doctor --target .',
      },
    }, null, 2)}\n`,
    'utf8',
  );

  await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  const packageJson = JSON.parse(await readFile(join(targetRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.test, 'node --test');
  assert.equal(
    packageJson.scripts?.['orchestrator:doctor'],
    'npm run build --silent && node dist/src/cli.js doctor --target .',
  );
  assert.equal(packageJson.scripts?.['orchestrator:status'], 'codex-orchestrator status --target .');
  assert.equal(
    packageJson.scripts?.['orchestrator:daemon'],
    'codex-orchestrator doctor --target . && codex-orchestrator daemon --target .',
  );
});

test('setup adds runtime folders to gitignore exactly once', async () => {
  const targetRoot = await tempRepo();
  await writeFile(join(targetRoot, '.gitignore'), 'node_modules/\n', 'utf8');

  const options = {
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  };
  await runSetupCommand(options);
  await runSetupCommand(options);

  const gitignore = await readFile(join(targetRoot, '.gitignore'), 'utf8');
  assert.equal((gitignore.match(/# codex-orchestrator runtime files/gu) ?? []).length, 1);
  assert.equal((gitignore.match(/\.codex-orchestrator\/state\//gu) ?? []).length, 1);
  assert.match(gitignore, /\.codex-orchestrator\/proofs\//);
  assert.match(gitignore, /\.codex-orchestrator\/workspaces\//);
});

test('setup dry-run reports config v2 but writes no files or labels', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubLabelAdapter();

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    dryRun: true,
    prepareLabels: true,
    labelAdapter: adapter,
  });

  assert.equal(adapter.createdLabels.length, 0);
  assert.equal(result.labelPlan.wouldCreate.length, 7);
  assert.match(result.output, /mode: dry-run/);
  assert.match(result.output, /labels: create-missing/);
  assert.match(result.output, /skill runtime: package-owned v2/);
  assert.match(result.output, /Codex will not be launched/);
  await assert.rejects(readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(join(targetRoot, '.gitignore'), 'utf8'), /ENOENT/);
});

test('setup infers GitHub owner and repo from origin remote', async () => {
  const targetRoot = await tempRepo();
  await initGitHubRemote(targetRoot, 'git@github.com:SergiiMytakii/IntelleReach.git');

  const result = await runSetupCommand({
    targetRoot,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(result.config.github.owner, 'SergiiMytakii');
  assert.equal(result.config.github.repo, 'IntelleReach');
});

test('setup preserves an existing valid config v2', async () => {
  const targetRoot = await tempRepo();
  const existing = configV2();
  existing.runner.maxParallelChildren = 2;
  existing.checks = { architecture: 'npm run test:architecture' };
  existing.reviewGates.riskRouting.riskyChangedPathGlobs = ['src/payments/**'];
  await writeConfig(targetRoot, existing);

  const result = await runSetupCommand({
    targetRoot,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(result.config.version, 2);
  assert.equal(result.config.runner.maxParallelChildren, 2);
  assert.deepEqual(result.config.checks, { architecture: 'npm run test:architecture' });
  assert.deepEqual(result.config.reviewGates.riskRouting.riskyChangedPathGlobs, ['src/payments/**']);
  assert.equal(validateConfigV2(result.config).ok, true);
});

test('setup blocks an existing config v1 without modifying it', async () => {
  const targetRoot = await tempRepo();
  const source = `${JSON.stringify(validConfig, null, 2)}\n`;
  await writeConfig(targetRoot, validConfig);

  await assert.rejects(
    runSetupCommand({ targetRoot, labelAdapter: new InMemoryGitHubLabelAdapter() }),
    /orchestrator-skill-runtime-v2-activation-required/,
  );
  assert.equal(await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'), source);
});

test('setup rejects runtime state without writing', async () => {
  const targetRoot = await tempRepo();
  const config = { ...configV2(), runtime: { activePid: 123 } };
  await writeConfig(targetRoot, config);
  const source = await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8');

  await assert.rejects(
    runSetupCommand({ targetRoot, labelAdapter: new InMemoryGitHubLabelAdapter() }),
    /runtime is runtime state/,
  );
  assert.equal(await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'), source);
});

test('setup only configures checks supported by target package scripts', async () => {
  const targetRoot = await tempRepo();
  await writeFile(join(targetRoot, 'package.json'), '{"scripts":{"test":"node --test"}}\n', 'utf8');

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.deepEqual(result.config.checks, { test: 'npm test' });
  assert.match(result.output, /checks: test/);
  assert.doesNotMatch(result.output, /checks: .*typecheck/);
});

test('setup creates missing labels only when explicitly enabled', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubLabelAdapter();

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    prepareLabels: true,
    labelAdapter: adapter,
  });

  assert.equal(result.config.github.prepareLabels, 'create-missing');
  assert.equal(adapter.createdLabels.length, 7);
});

test('setup preparation mode rejects dry-run before invoking preparation', async () => {
  const targetRoot = await tempRepo();
  await assert.rejects(
    runSetupCommand({ targetRoot, prepareSkillRuntimeV2: true, dryRun: true }),
    /cannot be combined with --dry-run/,
  );
});
