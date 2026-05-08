import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../src/config/schema.js';
import { InMemoryGitHubLabelAdapter } from '../src/setup/labels.js';
import { runSetupCommand } from '../src/setup/setup-command.js';

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-orchestrator-test-'));
}

test('setup creates project config and package prompt fallbacks', async () => {
  const targetRoot = await tempRepo();
  const adapter = new InMemoryGitHubLabelAdapter([{ name: 'agent:auto' }]);

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: adapter,
  });

  const configJson = JSON.parse(await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8')) as unknown;
  const validation = validateConfig(configJson);

  assert.equal(result.dryRun, false);
  assert.equal(validation.ok, true);
  assert.equal(adapter.createdLabels.length, 0);
  assert.match(await readFile(join(targetRoot, '.codex-orchestrator', 'prompts', 'setup-skill.md'), 'utf8'), /Setup/);
  assert.match(
    await readFile(join(targetRoot, '.codex-orchestrator', 'prompts', 'workflows', 'prd.md'), 'utf8'),
    /PRD/,
  );
});

test('setup updates existing config without accepting runtime state', async () => {
  const targetRoot = await tempRepo();
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify({
      github: {
        owner: 'SergiiMytakii',
        repo: 'IntelleReach',
      },
    }),
    'utf8',
  );

  await runSetupCommand({
    targetRoot,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  const config = JSON.parse(await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  assert.equal('runtime' in config, false);
  assert.equal(validateConfig(config).ok, true);
});

test('setup rejects existing runtime state without writing', async () => {
  const targetRoot = await tempRepo();
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify({
      runtime: {
        activePid: 123,
      },
      github: {
        owner: 'SergiiMytakii',
        repo: 'IntelleReach',
      },
    }),
    'utf8',
  );

  await assert.rejects(
    runSetupCommand({
      targetRoot,
      labelAdapter: new InMemoryGitHubLabelAdapter(),
    }),
    /runtime is runtime state/,
  );
});

test('dry-run reports intended automation without writing files or creating labels', async () => {
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
  assert.match(result.output, /.codex-orchestrator\/config.json/);
  assert.match(result.output, /labels: create-missing/);
  assert.match(result.output, /prd: package-owned-prompt-fallback/);
  assert.match(result.output, /Codex will not be launched/);
  await assert.rejects(readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'), /ENOENT/);
});

test('setup creates missing labels only when explicitly enabled', async () => {
  const targetRoot = await tempRepo();
  const reportOnlyAdapter = new InMemoryGitHubLabelAdapter();
  const createAdapter = new InMemoryGitHubLabelAdapter();

  const reportOnly = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: reportOnlyAdapter,
  });

  const createMissing = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    prepareLabels: true,
    labelAdapter: createAdapter,
    replacePackageSkills: true,
  });

  assert.equal(reportOnly.labelPlan.missing.length, 7);
  assert.equal(reportOnlyAdapter.createdLabels.length, 0);
  assert.equal(createMissing.config.github.prepareLabels, 'create-missing');
  assert.equal(createAdapter.createdLabels.length, 7);
});

test('setup does not create labels from an existing config policy without the current flag', async () => {
  const targetRoot = await tempRepo();
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify({
      github: {
        owner: 'SergiiMytakii',
        repo: 'IntelleReach',
        prepareLabels: 'create-missing',
      },
    }),
    'utf8',
  );
  const adapter = new InMemoryGitHubLabelAdapter();

  const result = await runSetupCommand({
    targetRoot,
    labelAdapter: adapter,
  });

  assert.equal(result.config.github.prepareLabels, 'report-only');
  assert.equal(result.labelPlan.policy, 'report-only');
  assert.equal(adapter.createdLabels.length, 0);
});

test('setup reuses existing local skills', async () => {
  const targetRoot = await tempRepo();
  const skillsRoot = await tempRepo();
  await mkdir(join(skillsRoot, 'to-prd'), { recursive: true });
  await writeFile(join(skillsRoot, 'to-prd', 'SKILL.md'), '# to-prd\n', 'utf8');

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    skillsRoot,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(result.config.workflows.prd.source, 'existing-skill');
  assert.equal(result.config.workflows.issueBreakdown.source, 'package-owned-prompt-fallback');
});

test('setup does not overwrite existing prompt files by default', async () => {
  const targetRoot = await tempRepo();
  const promptPath = join(targetRoot, '.codex-orchestrator', 'prompts', 'workflows', 'prd.md');
  await mkdir(join(targetRoot, '.codex-orchestrator', 'prompts', 'workflows'), { recursive: true });
  await writeFile(promptPath, 'user-owned prompt\n', 'utf8');

  await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(await readFile(promptPath, 'utf8'), 'user-owned prompt\n');
});
