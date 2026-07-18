import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
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

function dependencies(effects: string[]): SetupDependencies {
  return {
    repository: {
      inspect: async () => ({ repository: { owner: 'owner', repo: 'repo' }, baseBranch: 'main' }),
    },
    labels: {
      listPage: async () => ({ labels: [], nextCursor: undefined }),
      create: async () => 'created',
    },
    ownership: {
      acquire: async () => {
        effects.push('lock:acquire');
        return { release: async () => { effects.push('lock:release'); } };
      },
      inspectOwner: async () => ({ status: 'absent' }),
    },
  };
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
