import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { createProductionSetup } from '../src/v2/setup-runtime.js';

const execFileAsync = promisify(execFile);

test('production Setup composition derives canonical GitHub origin and owns durable configure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-setup-runtime-'));
  const targetRoot = join(root, 'target');
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main', targetRoot]);
    await writeFile(join(targetRoot, 'package.json'), '{"private":true,"scripts":{"test":"node --test"}}\n');
    await execFileAsync('git', ['-C', targetRoot, 'add', 'package.json']);
    await execFileAsync('git', ['-C', targetRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    await execFileAsync('git', ['-C', targetRoot, 'remote', 'add', 'origin', 'git@github.com:ExampleOwner/example-repo.git']);
    await execFileAsync('git', ['-C', targetRoot, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await execFileAsync('git', ['-C', targetRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    const setup = createProductionSetup({ orchestratorHome: join(root, 'home'), bootId: 'boot-fixture' });
    assert.deepEqual(await setup.execute({ targetRoot, operation: 'configure', dryRun: false }), { status: 'created' });
    const config = JSON.parse(await readFile(join(targetRoot, '.codex-orchestrator', 'config.json'), 'utf8'));
    assert.deepEqual({ owner: config.github.owner, repo: config.github.repo, baseBranch: config.github.baseBranch }, {
      owner: 'ExampleOwner', repo: 'example-repo', baseBranch: 'main',
    });
    assert.deepEqual(config.checks, { test: 'npm test' });
    assert.deepEqual(await setup.execute({ targetRoot, operation: 'configure', dryRun: false }), { status: 'unchanged' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
