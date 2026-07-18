import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { parseAgentAutoConfig } from '../src/v2/config.js';
import { Setup, type SetupDependencies } from '../src/v2/setup.js';
import { SetupStore, type SetupStoreFaultPoint } from '../src/v2/setup-store.js';

test('Setup.execute creates minimal config last and repeat configure is byte-stable', async (t) => {
  const root = await targetFixture(t);
  const effects: string[] = [];
  const setup = new Setup(dependencies(effects));
  const result = await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false });
  assert.deepEqual(result, { status: 'created' });
  const configPath = join(root, '.codex-orchestrator', 'config.json');
  const configBytes = await readFile(configPath);
  const config = parseAgentAutoConfig(JSON.parse(configBytes.toString('utf8')));
  assert.equal(config.github.owner, 'owner');
  assert.equal(config.github.repo, 'repo');
  assert.equal(config.github.baseBranch, 'main');
  assert.equal(config.runner.workspaceRoot, '.codex-orchestrator/workspaces-v2');
  assert.equal(config.runner.stateDir, '.codex-orchestrator/v2/state');
  assert.deepEqual(config.checks, { test: 'npm test', typecheck: 'npm run typecheck' });
  const ignoreBytes = await readFile(join(root, '.gitignore'));
  assert.match(ignoreBytes.toString('utf8'), /# codex-orchestrator v2 runtime start[\s\S]*workspaces-v2\/[\s\S]*# codex-orchestrator v2 runtime end\n$/u);
  await assert.rejects(stat(join(root, '.codex-orchestrator', 'v2', 'state')), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, '.codex-orchestrator', 'workspaces-v2')), { code: 'ENOENT' });
  assert.deepEqual(effects, ['lock:acquire', 'lock:release']);

  effects.length = 0;
  const repeated = await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false });
  assert.deepEqual(repeated, { status: 'unchanged' });
  assert.deepEqual(await readFile(configPath), configBytes);
  assert.deepEqual(await readFile(join(root, '.gitignore')), ignoreBytes);
  assert.deepEqual(effects, []);
});

test('Setup.execute dry-run returns exact ordered actions and performs zero writes', async (t) => {
  const root = await targetFixture(t);
  const effects: string[] = [];
  const setup = new Setup(dependencies(effects));
  const result = await setup.execute({ targetRoot: root, operation: 'configure', dryRun: true });
  assert.deepEqual(result, {
    status: 'planned',
    actions: [
      { kind: 'write-ignore', path: '.gitignore' },
      { kind: 'write-config', path: '.codex-orchestrator/config.json' },
    ],
  });
  await assert.rejects(stat(join(root, '.codex-orchestrator')), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, '.gitignore')), { code: 'ENOENT' });
  assert.deepEqual(effects, []);
});

test('Setup.execute migrates the exact Config V1 shape once under an inactive owner', async (t) => {
  const root = await targetFixture(t);
  const effects: string[] = [];
  const setup = new Setup(dependencies(effects));
  assert.deepEqual(await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false }), { status: 'created' });
  const configPath = join(root, '.codex-orchestrator', 'config.json');
  const v1 = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  v1.version = 1;
  delete ((v1.github as { labels: Record<string, unknown> }).labels).waitingHuman;
  await writeFile(configPath, `${JSON.stringify(v1)}\n`);

  effects.length = 0;
  assert.deepEqual(await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false }), { status: 'migrated' });
  const migrated = parseAgentAutoConfig(JSON.parse(await readFile(configPath, 'utf8')));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.github.labels.waitingHuman.name, 'agent:waiting-human');
  assert.deepEqual(effects, ['lock:acquire', 'lock:release']);
  assert.deepEqual(await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false }), { status: 'unchanged' });
});

test('Setup.execute plans Config V1 migration without writes and blocks label collisions', async (t) => {
  const root = await targetFixture(t);
  const setup = new Setup(dependencies([]));
  await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false });
  const configPath = join(root, '.codex-orchestrator', 'config.json');
  const v1 = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  v1.version = 1;
  const labels = (v1.github as { labels: Record<string, { name: string }> }).labels;
  delete labels.waitingHuman;
  await writeFile(configPath, `${JSON.stringify(v1)}\n`);
  const before = await readFile(configPath);
  assert.deepEqual(await setup.execute({ targetRoot: root, operation: 'configure', dryRun: true }), {
    status: 'planned', actions: [{ kind: 'migrate-config-v1-to-v2', path: '.codex-orchestrator/config.json' }],
  });
  assert.deepEqual(await readFile(configPath), before);

  labels.auto!.name = 'agent:waiting-human';
  await writeFile(configPath, `${JSON.stringify(v1)}\n`);
  const collisionBytes = await readFile(configPath);
  assert.equal((await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false })).status, 'unsupported-schema');
  assert.deepEqual(await readFile(configPath), collisionBytes);
});

test('Setup.execute leaves Config V1 byte-exact when owner or running-claim evidence blocks migration', async (t) => {
  for (const blocker of ['owner', 'running'] as const) {
    const root = await targetFixture(t);
    const seed = new Setup(dependencies([]));
    await seed.execute({ targetRoot: root, operation: 'configure', dryRun: false });
    const configPath = join(root, '.codex-orchestrator', 'config.json');
    const v1 = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    v1.version = 1;
    delete ((v1.github as { labels: Record<string, unknown> }).labels).waitingHuman;
    await writeFile(configPath, `${JSON.stringify(v1)}\n`);
    const before = await readFile(configPath);
    const deps = dependencies([]);
    if (blocker === 'owner') deps.ownership.inspectV2Owner = async () => ({ status: 'active', reason: 'live owner' });
    else deps.labels.listOpenIssueNumbersWithLabel = async () => [99];
    assert.equal((await new Setup(deps).execute({ targetRoot: root, operation: 'configure', dryRun: false })).status, 'blocked-active');
    assert.deepEqual(await readFile(configPath), before);
  }
});

test('Config V1 migration rechecks running claims after setup ownership is acquired', async (t) => {
  const root = await targetFixture(t);
  const seed = new Setup(dependencies([]));
  await seed.execute({ targetRoot: root, operation: 'configure', dryRun: false });
  const configPath = join(root, '.codex-orchestrator', 'config.json');
  const v1 = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  v1.version = 1;
  delete ((v1.github as { labels: Record<string, unknown> }).labels).waitingHuman;
  await writeFile(configPath, `${JSON.stringify(v1)}\n`);
  const before = await readFile(configPath);
  const deps = dependencies([]);
  let reads = 0;
  deps.labels.listOpenIssueNumbersWithLabel = async () => (++reads === 1 ? [] : [99]);

  assert.equal((await new Setup(deps).execute({ targetRoot: root, operation: 'configure', dryRun: false })).status, 'blocked-active');
  assert.equal(reads, 2);
  assert.deepEqual(await readFile(configPath), before);
});

test('doctor and status report the exact Config V1 migration requirement', async (t) => {
  const root = await targetFixture(t);
  const setup = new Setup(dependencies([]));
  await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false });
  const configPath = join(root, '.codex-orchestrator', 'config.json');
  const v1 = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  v1.version = 1;
  delete ((v1.github as { labels: Record<string, unknown> }).labels).waitingHuman;
  await writeFile(configPath, `${JSON.stringify(v1)}\n`);
  for (const operation of ['doctor', 'status'] as const) {
    assert.deepEqual(await setup.execute({ targetRoot: root, operation, dryRun: false }), {
      status: 'legacy-detected', reason: 'Config V1 requires setup migration.',
    });
  }
});

test('Setup.execute rejects repository mismatch before local writes', async (t) => {
  const root = await targetFixture(t);
  const effects: string[] = [];
  const setup = new Setup(dependencies(effects));
  const result = await setup.execute({
    targetRoot: root,
    operation: 'configure',
    dryRun: false,
    repository: { owner: 'other', repo: 'repo' },
  });
  assert.equal(result.status, 'repository-mismatch');
  await assert.rejects(stat(join(root, '.codex-orchestrator')), { code: 'ENOENT' });
  assert.deepEqual(effects, []);
});

test('Setup.execute refuses a symlinked managed directory without writing outside target', async (t) => {
  const root = await targetFixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'codex-v2-setup-outside-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(outside, { recursive: true, force: true }); });
  await symlink(outside, join(root, '.codex-orchestrator'));
  const result = await new Setup(dependencies([])).execute({ targetRoot: root, operation: 'configure', dryRun: false });
  assert.equal(result.status, 'io-failed');
  await assert.rejects(stat(join(outside, 'config.json')), { code: 'ENOENT' });
});

test('prepare-labels paginates case-insensitively and creates only missing labels after config commit', async (t) => {
  const root = await targetFixture(t);
  const effects: string[] = [];
  const base = dependencies(effects);
  const pages = [
    { labels: [{ name: 'agent:auto' }], nextCursor: 'page-2' },
    { labels: [{ name: 'AGENT:RUNNING' }], nextCursor: undefined },
  ];
  const created: string[] = [];
  base.labels.listPage = async ({ cursor }) => pages[cursor ? 1 : 0]!;
  base.labels.create = async ({ label }) => {
    await stat(join(root, '.codex-orchestrator', 'config.json'));
    created.push(label.name);
    return 'created';
  };
  const result = await new Setup(base).execute({ targetRoot: root, operation: 'prepare-labels', dryRun: false });
  assert.deepEqual(result, { status: 'labels-prepared' });
  assert.deepEqual(created, ['agent:blocked', 'agent:review', 'agent:waiting-human']);
  assert.deepEqual(effects, ['lock:acquire', 'lock:release']);
});

test('prepare-labels dry-run reports local and paginated GitHub actions with zero writes', async (t) => {
  const root = await targetFixture(t);
  const effects: string[] = [];
  const deps = dependencies(effects);
  deps.labels.listPage = async () => ({ labels: [{ name: 'agent:auto' }], nextCursor: undefined });
  const result = await new Setup(deps).execute({ targetRoot: root, operation: 'prepare-labels', dryRun: true });
  assert.deepEqual(result, {
    status: 'planned',
    actions: [
      { kind: 'write-ignore', path: '.gitignore' },
      { kind: 'write-config', path: '.codex-orchestrator/config.json' },
      { kind: 'create-label', name: 'agent:running' },
      { kind: 'create-label', name: 'agent:blocked' },
      { kind: 'create-label', name: 'agent:review' },
      { kind: 'create-label', name: 'agent:waiting-human' },
    ],
  });
  await assert.rejects(stat(join(root, '.codex-orchestrator')), { code: 'ENOENT' });
  assert.deepEqual(effects, []);
});

test('prepare-labels returns typed partial progress and always releases ownership', async (t) => {
  const root = await targetFixture(t);
  const effects: string[] = [];
  const deps = dependencies(effects);
  deps.labels.create = async ({ label }) => label.name === 'agent:blocked'
    ? { status: 'failed', failure: { code: 'github-unavailable', summary: 'GitHub label creation failed.' } }
    : 'created';
  const result = await new Setup(deps).execute({ targetRoot: root, operation: 'prepare-labels', dryRun: false });
  assert.deepEqual(result, {
    status: 'labels-partial',
    created: ['agent:auto', 'agent:running'],
    missing: ['agent:blocked', 'agent:review', 'agent:waiting-human'],
    cause: { code: 'github-unavailable', summary: 'GitHub label creation failed.' },
  });
  assert.deepEqual(effects, ['lock:acquire', 'lock:release']);
});

test('prepare-labels reconciles already-exists only after a complete reread observes it', async (t) => {
  const root = await targetFixture(t);
  const deps = dependencies([]);
  let reads = 0;
  deps.labels.listPage = async () => ({ labels: reads++ === 0 ? [] : [{ name: 'agent:auto' }], nextCursor: undefined });
  deps.labels.create = async ({ label }) => label.name === 'agent:auto' ? 'already-exists' : 'created';
  assert.deepEqual(await new Setup(deps).execute({ targetRoot: root, operation: 'prepare-labels', dryRun: false }), { status: 'labels-prepared' });
  assert.equal(reads, 2);
});

test('doctor and status return deterministic read-only diagnostics owned by Setup', async (t) => {
  const root = await targetFixture(t);
  const effects: string[] = [];
  const deps = dependencies(effects);
  const setup = new Setup(deps);
  await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false });
  effects.length = 0;
  deps.labels.listPage = async () => ({ labels: [
    { name: 'agent:auto' }, { name: 'agent:running' }, { name: 'agent:blocked' }, { name: 'agent:review' },
    { name: 'agent:waiting-human' },
  ], nextCursor: undefined });
  for (const operation of ['doctor', 'status'] as const) {
    const result = await setup.execute({ targetRoot: root, operation, dryRun: false });
    assert.deepEqual(result, {
      status: 'inspected', disposition: 'ok', diagnostics: [
        { code: 'config-v2', status: 'pass', summary: 'V2 configuration is valid.' },
        { code: 'repository', status: 'pass', summary: 'Configured repository matches target origin.' },
        { code: 'owner', status: 'pass', summary: 'No active V2 owner blocks setup.' },
        { code: 'labels', status: 'pass', summary: 'All configured V2 labels exist.' },
      ],
    });
  }
  assert.deepEqual(effects, []);
});

test('fresh copies Legacy metadata under both fences and commits V2 config last', async (t) => {
  const root = await legacyTargetFixture(t);
  const effects: string[] = [];
  const deps = dependencies(effects);
  deps.repository.inspectRetained = async () => ({ worktreePaths: ['/tmp/retained'], localRefs: ['refs/heads/codex/old'], remoteRefs: [], collisions: [] });
  deps.ownership.acquireLegacyFence = async () => {
    effects.push('legacy:acquire');
    return { release: async () => { effects.push('legacy:release'); } };
  };
  deps.labels.listOpenIssueNumbersWithLabel = async () => {
    effects.push('github:running-read');
    return [];
  };
  const originalState = await readFile(join(root, '.codex-orchestrator', 'state', 'owner.json'));
  const result = await new Setup(deps).execute({ targetRoot: root, operation: 'fresh', dryRun: false });
  assert.deepEqual(result, { status: 'fresh-reset' });
  assert.deepEqual(effects, ['lock:acquire', 'legacy:acquire', 'github:running-read', 'legacy:release', 'lock:release']);
  const config = parseAgentAutoConfig(JSON.parse(await readFile(join(root, '.codex-orchestrator', 'config.json'), 'utf8')));
  assert.equal(config.runner.workspaceRoot, '.codex-orchestrator/workspaces-v2');
  assert.deepEqual(await readFile(join(root, '.codex-orchestrator', 'state', 'owner.json')), originalState);
  const manifests = await readdir(join(root, '.codex-orchestrator', 'v2', 'fresh-cutover'));
  assert.equal(manifests.length, 1);
  const manifest = JSON.parse(await readFile(join(root, '.codex-orchestrator', 'v2', 'fresh-cutover', manifests[0]!), 'utf8')) as {
    backup: { configPath: string; statePath: string };
  };
  assert.equal(JSON.parse(await readFile(join(root, manifest.backup.configPath), 'utf8')).version, 1);
  assert.deepEqual(await readFile(join(root, manifest.backup.statePath, 'owner.json')), originalState);
});

test('fresh does not classify its own setup ownership as an active V2 runner', async (t) => {
  const root = await legacyTargetFixture(t);
  const effects: string[] = [];
  const deps = dependencies(effects);
  let setupOwnsRepository = false;
  deps.ownership.inspectV2Owner = async () => setupOwnsRepository
    ? { status: 'active' }
    : { status: 'absent' };
  deps.ownership.acquire = async () => {
    setupOwnsRepository = true;
    effects.push('lock:acquire');
    return {
      release: async () => {
        setupOwnsRepository = false;
        effects.push('lock:release');
      },
    };
  };

  assert.deepEqual(
    await new Setup(deps).execute({ targetRoot: root, operation: 'fresh', dryRun: false }),
    { status: 'fresh-reset' },
  );
  assert.deepEqual(effects, ['lock:acquire', 'lock:release']);
});

test('fresh blocks active, remote, nonempty-root, and retained-collision evidence before writes', async (t) => {
  for (const blocked of ['owner', 'remote', 'root', 'collision'] as const) {
    await t.test(blocked, async (t) => {
      const root = await legacyTargetFixture(t);
      const effects: string[] = [];
      const deps = dependencies(effects);
      deps.repository.inspectRetained = async () => ({
        worktreePaths: [], localRefs: [], remoteRefs: [], collisions: blocked === 'collision' ? ['refs/heads/codex/issue-1'] : [],
      });
      if (blocked === 'owner') deps.ownership.inspectV2Owner = async () => ({ status: 'active' });
      if (blocked === 'remote') deps.labels.listOpenIssueNumbersWithLabel = async () => [17];
      if (blocked === 'root') await mkdir(join(root, '.codex-orchestrator', 'workspaces-v2'), { recursive: true }).then(() => writeFile(join(root, '.codex-orchestrator', 'workspaces-v2', 'x'), 'x'));
      const before = await readFile(join(root, '.codex-orchestrator', 'config.json'));
      const result = await new Setup(deps).execute({ targetRoot: root, operation: 'fresh', dryRun: false });
      assert.equal(result.status, 'blocked-active');
      assert.deepEqual(await readFile(join(root, '.codex-orchestrator', 'config.json')), before);
      await assert.rejects(stat(join(root, '.codex-orchestrator', 'v2', 'fresh-cutover')), { code: 'ENOENT' });
    });
  }
});

test('fresh dry-run is write-free and committed replay returns without locks or writes', async (t) => {
  const root = await legacyTargetFixture(t);
  const effects: string[] = [];
  const deps = dependencies(effects);
  deps.repository.inspectRetained = async () => ({ worktreePaths: [], localRefs: [], remoteRefs: [], collisions: [] });
  const setup = new Setup(deps);
  assert.deepEqual(await setup.execute({ targetRoot: root, operation: 'fresh', dryRun: true }), {
    status: 'planned', actions: [
      { kind: 'backup-legacy', path: '.codex-orchestrator/v2/legacy-backups' },
      { kind: 'commit-fresh', path: '.codex-orchestrator/config.json' },
    ],
  });
  assert.deepEqual(effects, []);
  await setup.execute({ targetRoot: root, operation: 'fresh', dryRun: false });
  effects.length = 0;
  assert.deepEqual(await setup.execute({ targetRoot: root, operation: 'fresh', dryRun: false }), { status: 'fresh-reset' });
  assert.deepEqual(effects, []);
});

test('fresh fails closed on GitHub read failure and ambiguous precommit manifests', async (t) => {
  await t.test('GitHub read', async (t) => {
    const root = await legacyTargetFixture(t);
    const deps = dependencies([]);
    deps.labels.listOpenIssueNumbersWithLabel = async () => { throw new Error('offline'); };
    assert.equal((await new Setup(deps).execute({ targetRoot: root, operation: 'fresh', dryRun: false })).status, 'transport-failed');
  });
  await t.test('manifest ambiguity', async (t) => {
    const root = await legacyTargetFixture(t);
    const directory = join(root, '.codex-orchestrator', 'v2', 'fresh-cutover');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'foreign.json'), '{}\n');
    assert.equal((await new Setup(dependencies([])).execute({ targetRoot: root, operation: 'fresh', dryRun: false })).status, 'io-failed');
    assert.equal(JSON.parse(await readFile(join(root, '.codex-orchestrator', 'config.json'), 'utf8')).version, 1);
  });
});

test('configure converges after every injected config publication boundary', async (t) => {
  for (const point of faultPoints) {
    await t.test(point, async (t) => {
      const root = await targetFixture(t);
      const canonicalRoot = await realpath(root);
      let injected = false;
      const store = new SetupStore({
        fault: ({ path, point: observed }) => {
          if (!injected && path === join(canonicalRoot, '.codex-orchestrator', 'config.json') && observed === point) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        },
      });
      const setup = new Setup(dependencies([]), store);
      assert.equal((await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false })).status, 'io-failed');
      assert.deepEqual(await setup.execute({ targetRoot: root, operation: 'configure', dryRun: false }),
        point === 'before-file-fsync' || point === 'before-rename' ? { status: 'created' } : { status: 'unchanged' });
      parseAgentAutoConfig(JSON.parse(await readFile(join(root, '.codex-orchestrator', 'config.json'), 'utf8')));
    });
  }
});

test('fresh converges after every injected config publication boundary without changing Legacy state', async (t) => {
  for (const point of faultPoints) {
    await t.test(point, async (t) => {
      const root = await legacyTargetFixture(t);
      const canonicalRoot = await realpath(root);
      const originalState = await readFile(join(root, '.codex-orchestrator', 'state', 'owner.json'));
      let injected = false;
      const store = new SetupStore({
        fault: ({ path, point: observed }) => {
          if (!injected && path === join(canonicalRoot, '.codex-orchestrator', 'config.json') && observed === point) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        },
      });
      const setup = new Setup(dependencies([]), store);
      assert.equal((await setup.execute({ targetRoot: root, operation: 'fresh', dryRun: false })).status, 'io-failed');
      assert.deepEqual(await setup.execute({ targetRoot: root, operation: 'fresh', dryRun: false }), { status: 'fresh-reset' });
      parseAgentAutoConfig(JSON.parse(await readFile(join(root, '.codex-orchestrator', 'config.json'), 'utf8')));
      assert.deepEqual(await readFile(join(root, '.codex-orchestrator', 'state', 'owner.json')), originalState);
      assert.equal((await readdir(join(root, '.codex-orchestrator', 'v2', 'fresh-cutover'))).length, 1);
    });
  }
});

function dependencies(effects: string[]): SetupDependencies {
  return {
    repository: {
      inspect: async () => ({ repository: { owner: 'owner', repo: 'repo' }, baseBranch: 'main' }),
      inspectRetained: async () => ({ worktreePaths: [], localRefs: [], remoteRefs: [], collisions: [] }),
    },
    labels: {
      listPage: async () => ({ labels: [], nextCursor: undefined }),
      create: async () => 'created',
      listOpenIssueNumbersWithLabel: async () => [],
    },
    ownership: {
      acquire: async () => {
        effects.push('lock:acquire');
        return { release: async () => { effects.push('lock:release'); } };
      },
      inspectV2Owner: async () => ({ status: 'absent' }),
      acquireLegacyFence: async () => ({ release: async () => undefined }),
    },
  };
}

async function legacyTargetFixture(t: TestContext): Promise<string> {
  const root = await targetFixture(t);
  await mkdir(join(root, '.codex-orchestrator', 'state'), { recursive: true });
  await writeFile(join(root, '.codex-orchestrator', 'config.json'), `${JSON.stringify({
    version: 1,
    github: { owner: 'owner', repo: 'repo', labels: { running: { name: 'agent:running' } } },
    runner: { workspaceRoot: '.codex-orchestrator/workspaces', stateDir: '.codex-orchestrator/state' },
  })}\n`);
  await writeFile(join(root, '.codex-orchestrator', 'state', 'owner.json'), '{"pid":999999}\n');
  return root;
}

const faultPoints: SetupStoreFaultPoint[] = [
  'before-file-fsync', 'before-rename', 'after-rename', 'before-parent-fsync',
];

async function targetFixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-v2-setup-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'node --test', lint: 'eslint .' } }));
  return root;
}
