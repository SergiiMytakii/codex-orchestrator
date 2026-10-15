import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { defaultProcessExecutor } from '../src/v2/adapters/command.js';
import { canonicalJson, sha256 } from '../src/v2/containment.js';
import { LocalGitRunIssueAdapter } from '../src/v2/runtime.js';
import { mkdtemp } from './mission-test-temp.js';

const execFileAsync = promisify(execFile);

test('new runs resolve the configured base from a fresh remote branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-git-base-'));
  const remoteRoot = join(root, 'remote.git');
  const publisherRoot = join(root, 'publisher');
  const targetRoot = join(root, 'target');
  await execFileAsync('git', ['init', '--bare', '-q', remoteRoot]);
  await execFileAsync('git', ['init', '-q', '-b', 'dev', publisherRoot]);
  await writeFile(join(publisherRoot, 'fixture.txt'), 'one\n');
  await execFileAsync('git', ['-C', publisherRoot, 'add', 'fixture.txt']);
  await execFileAsync('git', ['-C', publisherRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'one']);
  await execFileAsync('git', ['-C', publisherRoot, 'remote', 'add', 'origin', remoteRoot]);
  await execFileAsync('git', ['-C', publisherRoot, 'push', '-u', 'origin', 'dev']);
  await execFileAsync('git', ['clone', '-q', '--branch', 'dev', remoteRoot, targetRoot]);
  const staleLocalSha = (await execFileAsync('git', ['-C', targetRoot, 'rev-parse', 'dev'])).stdout.trim();

  await writeFile(join(publisherRoot, 'fixture.txt'), 'two\n');
  await execFileAsync('git', ['-C', publisherRoot, 'add', 'fixture.txt']);
  await execFileAsync('git', ['-C', publisherRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'two']);
  await execFileAsync('git', ['-C', publisherRoot, 'push', 'origin', 'dev']);
  const remoteSha = (await execFileAsync('git', ['-C', publisherRoot, 'rev-parse', 'dev'])).stdout.trim();

  const adapter = new LocalGitRunIssueAdapter();
  assert.notEqual(staleLocalSha, remoteSha);
  assert.equal(await adapter.getBaseSha({ targetRoot, baseBranch: 'dev' }), remoteSha);
});

test('issue worktrees are created from the pinned base SHA instead of a moving branch ref', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-pinned-base-'));
  const targetRoot = join(root, 'target');
  const worktreePath = join(root, 'worktree');
  await mkdir(targetRoot);
  await execFileAsync('git', ['init', '-q', '-b', 'dev', targetRoot]);
  await writeFile(join(targetRoot, 'fixture.txt'), 'one\n');
  await execFileAsync('git', ['-C', targetRoot, 'add', 'fixture.txt']);
  await execFileAsync('git', ['-C', targetRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'one']);
  const pinnedSha = (await execFileAsync('git', ['-C', targetRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(targetRoot, 'fixture.txt'), 'two\n');
  await execFileAsync('git', ['-C', targetRoot, 'add', 'fixture.txt']);
  await execFileAsync('git', ['-C', targetRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'two']);

  const adapter = new LocalGitRunIssueAdapter();
  await adapter.createWorktree({
    targetRoot,
    worktreePath,
    branchName: 'codex/issue-1',
    baseBranch: 'dev',
    baseSha: pinnedSha,
  });
  assert.equal((await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])).stdout.trim(), pinnedSha);
});

for (const reader of ['diff', 'status', 'proof-status'] as const) {
  test(`Git snapshot survives concurrent ${reader} index refresh without losing change evidence`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-v2-snapshot-lock-'));
    await execFileAsync('git', ['init', '-q', '-b', 'main', root]);
    await writeFile(join(root, 'tracked.txt'), 'base\n');
    await execFileAsync('git', ['-C', root, 'add', 'tracked.txt']);
    await execFileAsync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']);
    const headSha = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const indexTreeSha = (await execFileAsync('git', ['-C', root, 'write-tree'])).stdout.trim();
    await writeFile(join(root, 'tracked.txt'), 'changed\n');
    await writeFile(join(root, 'untracked.txt'), 'new\n');
    await mkdir(join(root, 'proofs'));
    await writeFile(join(root, 'proofs', 'artifact.txt'), 'proof\n');
    const patch = (await execFileAsync('git', ['--no-optional-locks', '-C', root, 'diff', '--binary', 'HEAD'])).stdout;
    const lockPath = join(root, '.git', 'index.lock');
    let readerReady!: () => void;
    const ready = { promise: new Promise<void>((resolve) => { readerReady = resolve; }), resolve: () => readerReady() };
    let writerDone!: () => void;
    const written = { promise: new Promise<void>((resolve) => { writerDone = resolve; }), resolve: () => writerDone() };
    const pending: Array<Promise<unknown>> = [];
    let scheduled = false;
    const adapter = new LocalGitRunIssueAdapter((file, args, options) => {
      const operation = (async () => {
        const isReader = args.includes(reader === 'diff' ? 'diff' : 'status');
        if (isReader && !scheduled) {
          scheduled = true;
          // Model Git's optional index refresh holding its real lock while
          // another snapshot command starts. Ordinary scheduler timing hid
          // this collision in isolated lifecycle test reruns.
          const optionalLocks = !args.includes('--no-optional-locks')
            && options?.envOverlay?.GIT_OPTIONAL_LOCKS !== '0'
            && options?.env?.GIT_OPTIONAL_LOCKS !== '0';
          const lock = optionalLocks ? await open(lockPath, 'wx') : undefined;
          ready.resolve();
          if (lock) {
            try { await written.promise; }
            finally { await lock.close(); await unlink(lockPath); }
          }
        }
        if (args.includes('write-tree')) {
          await ready.promise;
          try { return await defaultProcessExecutor(file, args, options); }
          finally { written.resolve(); }
        }
        return defaultProcessExecutor(file, args, options);
      })();
      pending.push(operation);
      return operation;
    });
    try {
      const proof = reader === 'proof-status';
      const [snapshot, changedFiles] = await Promise.all([
        proof ? adapter.snapshotIgnoringUntrackedRoot(root, 'proofs') : adapter.snapshot(root),
        reader === 'diff' ? Promise.resolve(undefined)
          : proof ? adapter.listChangedFilesIgnoringUntrackedRoot(root, 'proofs') : adapter.listChangedFiles(root),
      ]);
      assert.equal(scheduled, true);
      assert.equal(snapshot.headSha, headSha);
      assert.equal(snapshot.indexTreeSha, indexTreeSha);
      assert.equal(snapshot.trackedContentSha256, sha256(patch));
      assert.equal(snapshot.untrackedContentSha256, sha256(canonicalJson([
        ...(!proof ? [{ path: 'proofs/artifact.txt', sha256: sha256('proof\n') }] : []),
        { path: 'untracked.txt', sha256: sha256('new\n') },
      ])));
      if (changedFiles) assert.deepEqual(changedFiles, proof
        ? ['tracked.txt', 'untracked.txt'] : ['tracked.txt', 'proofs/artifact.txt', 'untracked.txt']);
      await assert.rejects(access(lockPath), { code: 'ENOENT' });
    } finally {
      ready.resolve();
      written.resolve();
      await Promise.allSettled(pending);
    }
  });
}
