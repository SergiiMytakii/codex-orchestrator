import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { validateConfig } from '../src/config/schema.js';
import { InMemoryGitHubLabelAdapter } from '../src/setup/labels.js';
import { runSetupCommand } from '../src/setup/setup-command.js';

const execFileAsync = promisify(execFile);

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-orchestrator-test-'));
}

async function initGitHubRemote(targetRoot: string, remoteUrl: string): Promise<void> {
  await execFileAsync('git', ['-C', targetRoot, 'init']);
  await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', remoteUrl]);
}

test('setup creates project config and package-bundled prompts', async () => {
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

test('setup persists discovered absolute codex command path', async () => {
  const targetRoot = await tempRepo();

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
    codexCommandResolver: async () => '/Applications/Codex.app/Contents/Resources/codex',
  });

  const configJson = JSON.parse(await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8')) as {
    codex?: { command?: string };
  };

  assert.equal(result.config.codex.command, '/Applications/Codex.app/Contents/Resources/codex');
  assert.equal(configJson.codex?.command, '/Applications/Codex.app/Contents/Resources/codex');
});

test('setup preserves an explicitly configured custom codex command', async () => {
  const targetRoot = await tempRepo();
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify({
      github: {
        owner: 'SergiiMytakii',
        repo: 'IntelleReach',
      },
      codex: {
        command: 'custom-codex',
      },
    }),
    'utf8',
  );

  const result = await runSetupCommand({
    targetRoot,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
    codexCommandResolver: async () => '/Applications/Codex.app/Contents/Resources/codex',
  });

  assert.equal(result.config.codex.command, 'custom-codex');
});

test('setup adds checked orchestrator npm scripts to target package json', async () => {
  const targetRoot = await tempRepo();
  await writeFile(
    join(targetRoot, 'package.json'),
    JSON.stringify({
      name: 'target-project',
      scripts: {
        test: 'node --test',
      },
    }, null, 2),
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
  assert.equal(packageJson.scripts?.['orchestrator:doctor'], 'codex-orchestrator doctor --target .');
  assert.equal(packageJson.scripts?.['orchestrator:status'], 'codex-orchestrator status --target .');
  assert.equal(packageJson.scripts?.['orchestrator:status:json'], 'codex-orchestrator status --target . --json');
  assert.equal(
    packageJson.scripts?.['orchestrator:daemon'],
    'codex-orchestrator doctor --target . && codex-orchestrator daemon --target .',
  );
  assert.equal(
    packageJson.scripts?.['orchestrator:daemon:once'],
    'codex-orchestrator doctor --target . && codex-orchestrator daemon --target . --once',
  );
  assert.equal(
    packageJson.scripts?.['orchestrator:daemon:fast'],
    'codex-orchestrator doctor --target . && codex-orchestrator daemon --target . --interval-seconds 60',
  );
  assert.equal(
    packageJson.scripts?.['orchestrator:daemon:max3'],
    'codex-orchestrator doctor --target . && codex-orchestrator daemon --target . --max-runs 3',
  );
});

test('setup preserves existing orchestrator npm scripts', async () => {
  const targetRoot = await tempRepo();
  await writeFile(
    join(targetRoot, 'package.json'),
    JSON.stringify({
      name: 'target-project',
      scripts: {
        'orchestrator:doctor': 'npm run build --silent && node dist/src/cli.js doctor --target .',
      },
    }, null, 2),
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

  assert.equal(
    packageJson.scripts?.['orchestrator:doctor'],
    'npm run build --silent && node dist/src/cli.js doctor --target .',
  );
  assert.equal(packageJson.scripts?.['orchestrator:status'], 'codex-orchestrator status --target .');
});

test('setup adds runtime work folders to gitignore without ignoring committed policy files', async () => {
  const targetRoot = await tempRepo();
  await writeFile(join(targetRoot, '.gitignore'), 'node_modules/\n', 'utf8');

  await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });
  await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(
    await readFile(join(targetRoot, '.gitignore'), 'utf8'),
    [
      'node_modules/',
      '',
      '# codex-orchestrator runtime files',
      '.codex-orchestrator/workspaces/',
      '.codex-orchestrator/state/',
      '',
    ].join('\n'),
  );
  assert.match(await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'), /"github"/);
});

test('setup dry-run does not write gitignore runtime entries', async () => {
  const targetRoot = await tempRepo();

  await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    dryRun: true,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  await assert.rejects(readFile(join(targetRoot, '.gitignore'), 'utf8'), /ENOENT/);
});

test('setup dry-run previews the selected prompt sync mode without writing prompts', async () => {
  const targetRoot = await tempRepo();
  const promptPath = join(targetRoot, '.codex-orchestrator', 'prompts', 'workflows', 'prd.md');
  await mkdir(join(targetRoot, '.codex-orchestrator', 'prompts', 'workflows'), { recursive: true });
  await writeFile(promptPath, 'project prompt\n', 'utf8');

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    dryRun: true,
    promptSyncMode: 'replace',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(await readFile(promptPath, 'utf8'), 'project prompt\n');
  assert.equal(result.promptSync?.updated.includes('workflows/prd.md'), true);
});

test('setup does not duplicate existing runtime gitignore entries', async () => {
  const targetRoot = await tempRepo();
  await writeFile(join(targetRoot, '.gitignore'), './.codex-orchestrator/state\n', 'utf8');

  await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(
    await readFile(join(targetRoot, '.gitignore'), 'utf8'),
    [
      './.codex-orchestrator/state',
      '',
      '# codex-orchestrator runtime files',
      '.codex-orchestrator/workspaces/',
      '',
    ].join('\n'),
  );
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

test('setup migrates existing config defaults without overwriting project policy', async () => {
  const targetRoot = await tempRepo();
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify({
      version: 1,
      github: {
        owner: 'SergiiMytakii',
        repo: 'IntelleReach',
        prepareLabels: 'report-only',
      },
      runner: {
        workspaceRoot: '.codex-orchestrator/workspaces',
        maxParallelChildren: 2,
        stateDir: '.codex-orchestrator/state',
      },
      codex: {
        adapter: 'codex-cli',
        command: 'codex',
        args: [
          'exec',
          '--cd',
          '${worktreePath}',
          '--sandbox',
          'workspace-write',
          '--add-dir',
          '${stateDir}',
          '--ignore-user-config',
          '--output-last-message',
          '${reportPath}',
          '-',
        ],
        promptFileEnv: 'CODEX_ORCHESTRATOR_PROMPT_FILE',
        reportFileEnv: 'CODEX_ORCHESTRATOR_REPORT_FILE',
      },
      checks: {
        architecture: 'npm run test:architecture',
      },
      reviewGates: {
        quality: {
          tdd: {
            requireTestChange: false,
          },
        },
      },
      loopPolicy: {
        issueSelection: {
          priorityLabels: ['priority:urgent', 'priority:normal'],
        },
        rework: {
          maxAttempts: 2,
        },
      },
      branches: {
        base: 'dev',
      },
    }),
    'utf8',
  );

  const result = await runSetupCommand({
    targetRoot,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(result.config.runner.maxParallelChildren, 2);
  assert.deepEqual(result.config.checks, { architecture: 'npm run test:architecture' });
  assert.equal(result.config.branches.base, 'dev');
  assert.equal(result.config.codex.args.includes('--ignore-user-config'), false);
  assert.equal(result.config.codex.args.includes('sandbox_workspace_write.network_access=true'), true);
  assert.equal(result.config.codex.timeoutMs, 1_800_000);
  assert.equal(result.config.reviewGates.visualProof.enabled, true);
  assert.equal(result.config.reviewGates.visualProof.runnerTimeoutMs, 900_000);
  assert.deepEqual(result.config.reviewGates.visualProof.envPassthrough, []);
  assert.equal(result.config.reviewGates.quality.enabled, true);
  assert.equal(result.config.reviewGates.quality.tdd.requireTestChange, false);
  assert.equal(result.config.reviewGates.quality.tdd.enabled, true);
  assert.equal(result.config.reviewGates.quality.cleanupReview.runtimeFileThreshold, 3);
  assert.deepEqual(result.config.loopPolicy.issueSelection.priorityLabels, [
    'priority:urgent',
    'priority:normal',
  ]);
  assert.equal(result.config.loopPolicy.rework.maxAttempts, 2);
  assert.equal(result.config.loopPolicy.freshContextReview.enabled, false);
  assert.equal(result.config.loopPolicy.policySuggestions.maxSuggestions, 5);
  assert.equal(validateConfig(result.config).ok, true);
});

test('setup migrates the old default codex timeout but preserves custom values', async () => {
  const targetRoot = await tempRepo();
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify({
      github: {
        owner: 'SergiiMytakii',
        repo: 'IntelleReach',
      },
      codex: {
        timeoutMs: 600_000,
      },
    }),
    'utf8',
  );

  const migratedDefault = await runSetupCommand({
    targetRoot,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(migratedDefault.config.codex.timeoutMs, 1_800_000);

  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify({
      github: {
        owner: 'SergiiMytakii',
        repo: 'IntelleReach',
      },
      codex: {
        timeoutMs: 900_000,
      },
    }),
    'utf8',
  );

  const custom = await runSetupCommand({
    targetRoot,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(custom.config.codex.timeoutMs, 900_000);
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
  assert.match(result.output, /gitignore runtime entries: \.codex-orchestrator\/workspaces\/, \.codex-orchestrator\/state\//);
  assert.match(result.output, /prd: package-bundled-prompt/);
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

test('setup uses bundled workflow prompts', async () => {
  const targetRoot = await tempRepo();

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(result.config.workflows.prd.source, 'package-bundled-prompt');
  assert.equal(result.config.workflows.prd.skillPath, undefined);
  assert.equal(result.config.workflows.issueBreakdown.source, 'package-bundled-prompt');
});

test('setup migrates old workflow sources to package bundled prompts', async () => {
  const targetRoot = await tempRepo();
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  await writeFile(
    join(targetRoot, '.codex-orchestrator', 'config.json'),
    JSON.stringify({
      github: {
        owner: 'SergiiMytakii',
        repo: 'IntelleReach',
      },
      workflows: {
        prd: {
          skillName: 'to-prd',
          source: 'package-owned-prompt-fallback',
          promptPath: '.codex-orchestrator/prompts/workflows/prd.md',
        },
        scopedImplementation: {
          skillName: 'spec-implementer',
          source: 'existing-skill',
          skillPath: '/Users/example/.codex/skills/spec-implementer/SKILL.md',
          promptPath: '.codex-orchestrator/prompts/workflows/scoped-implementation.md',
        },
      },
    }),
    'utf8',
  );

  const result = await runSetupCommand({
    targetRoot,
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(result.config.workflows.prd.source, 'package-bundled-prompt');
  assert.equal(result.config.workflows.scopedImplementation.source, 'package-bundled-prompt');
  assert.equal(result.config.workflows.scopedImplementation.skillPath, undefined);
});

test('setup does not overwrite existing prompt files by default', async () => {
  const targetRoot = await tempRepo();
  const promptPath = join(targetRoot, '.codex-orchestrator', 'prompts', 'workflows', 'prd.md');
  await mkdir(join(targetRoot, '.codex-orchestrator', 'prompts', 'workflows'), { recursive: true });
  await writeFile(promptPath, 'user-owned prompt\n', 'utf8');

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.equal(await readFile(promptPath, 'utf8'), 'user-owned prompt\n');
  assert.match(result.output, /prompt conflicts: workflows\/prd\.md/);
  assert.match(result.output, /Choose how to handle local prompt edits/);
  assert.match(result.output, /Keep local prompts: codex-orchestrator setup --sync-prompts=keep/);
  assert.match(result.output, /Merge package updates into local prompts: codex-orchestrator setup --sync-prompts=merge/);
  assert.match(result.output, /Replace local prompts: codex-orchestrator setup --sync-prompts=replace/);
});

test('setup syncs untouched prompt updates and reports local prompt conflicts', async () => {
  const targetRoot = await tempRepo();
  await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  const promptRoot = join(targetRoot, '.codex-orchestrator', 'prompts');
  const manifestPath = join(promptRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    prompts: Record<string, { installedHash: string; packageHash: string }>;
  };
  const oldPrdPrompt = 'old package prd prompt\n';
  const oldTriagePrompt = 'old package triage prompt\n';
  const customTriagePrompt = 'project customized triage prompt\n';
  const prdPath = join(promptRoot, 'workflows', 'prd.md');
  const triagePath = join(promptRoot, 'workflows', 'triage.md');

  await writeFile(prdPath, oldPrdPrompt, 'utf8');
  await writeFile(triagePath, customTriagePrompt, 'utf8');
  manifest.prompts['workflows/prd.md'].installedHash = sha256(oldPrdPrompt);
  manifest.prompts['workflows/prd.md'].packageHash = sha256(oldPrdPrompt);
  manifest.prompts['workflows/triage.md'].installedHash = sha256(oldTriagePrompt);
  manifest.prompts['workflows/triage.md'].packageHash = sha256(oldTriagePrompt);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  assert.match(await readFile(prdPath, 'utf8'), /Problem Statement/);
  assert.equal(await readFile(triagePath, 'utf8'), customTriagePrompt);
  assert.match(result.output, /prompt sync: .*1 updated.*1 conflict/);
  assert.match(result.output, /Choose how to handle local prompt edits/);
  assert.match(result.output, /Ask the user which action to take before changing conflicted prompts/);
});

test('setup merge mode appends bundled prompt updates to locally edited prompts', async () => {
  const targetRoot = await tempRepo();
  await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });

  const promptRoot = join(targetRoot, '.codex-orchestrator', 'prompts');
  const manifestPath = join(promptRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    prompts: Record<string, { installedHash: string; packageHash: string }>;
  };
  const oldTriagePrompt = 'old package triage prompt\n';
  const customTriagePrompt = 'project customized triage prompt\n';
  const triagePath = join(promptRoot, 'workflows', 'triage.md');
  await writeFile(triagePath, customTriagePrompt, 'utf8');
  manifest.prompts['workflows/triage.md'].installedHash = sha256(oldTriagePrompt);
  manifest.prompts['workflows/triage.md'].packageHash = sha256(oldTriagePrompt);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = await runSetupCommand({
    targetRoot,
    githubOwner: 'SergiiMytakii',
    githubRepo: 'IntelleReach',
    promptSyncMode: 'merge',
    labelAdapter: new InMemoryGitHubLabelAdapter(),
  });
  const mergedPrompt = await readFile(triagePath, 'utf8');

  assert.match(mergedPrompt, /project customized triage prompt/);
  assert.match(mergedPrompt, /codex-orchestrator package prompt update: workflows\/triage\.md/);
  assert.match(mergedPrompt, /Agent Brief/);
  assert.doesNotMatch(result.output, /prompt conflicts:/);
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
