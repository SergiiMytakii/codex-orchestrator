import { randomUUID } from 'node:crypto';

import type { ProcessExecutor } from '../process/command.js';
import { defaultProcessExecutor } from '../process/command.js';
import {
  canonicalRuntimeOwnerRecord,
  parseRuntimeOwnerRecord,
  RuntimeOwnerConflictError,
  type RuntimeOwnerObservation,
  type RuntimeOwnerRecord,
  type RuntimeOwnerRefAdapter,
} from './mission-runtime-owner.js';

const defaultOwnerRef = 'refs/codex-orchestrator/runtime-owner-v1';
const ownerFile = 'codex-orchestrator-runtime-owner-v1.json';

export class GitRuntimeOwnerRefAdapter implements RuntimeOwnerRefAdapter {
  public constructor(
    private readonly targetRoot: string,
    private readonly execute: ProcessExecutor = defaultProcessExecutor,
    private readonly remote = 'origin',
    private readonly ownerRef = defaultOwnerRef,
  ) {}

  public async read(): Promise<RuntimeOwnerObservation | undefined> {
    const listed = await this.git(['ls-remote', '--refs', this.remote, this.ownerRef]);
    const lines = listed.stdout.trim().length === 0
      ? []
      : listed.stdout.trim().split(/\r?\n/u);
    if (lines.length === 0) {
      return undefined;
    }
    if (lines.length !== 1) {
      throw new RuntimeOwnerConflictError('remote owner ref is ambiguous');
    }
    const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\s+(.+)$/u.exec(lines[0] ?? '');
    if (!match || match[2] !== this.ownerRef) {
      throw new RuntimeOwnerConflictError('remote owner ref response is malformed');
    }
    const sha = match[1] as string;
    const observedRef = `refs/codex-orchestrator/observed/${process.pid}-${randomUUID()}`;
    await this.git(['fetch', '--no-tags', this.remote, `+${this.ownerRef}:${observedRef}`]);
    try {
      const fetchedSha = objectId(await this.git(['rev-parse', observedRef]), 'observed owner');
      if (fetchedSha !== sha) {
        throw new RuntimeOwnerConflictError('owner ref moved between listing and fetch');
      }
      const shown = await this.git(['show', `${observedRef}:${ownerFile}`]);
      return {
        sha,
        record: parseRuntimeOwnerRecord(shown.stdout.replace(/\r?\n$/u, '')),
      };
    } finally {
      await this.git(['update-ref', '-d', observedRef]);
    }
  }

  public async compareAndSwap(
    expectedSha: string | undefined,
    record: RuntimeOwnerRecord,
  ): Promise<RuntimeOwnerObservation> {
    const canonical = canonicalRuntimeOwnerRecord(record);
    const blob = objectId(await this.git(['hash-object', '-w', '--stdin'], canonical), 'blob');
    const tree = objectId(await this.git(
      ['mktree'],
      `100644 blob ${blob}\t${ownerFile}\n`,
    ), 'tree');
    const commit = objectId(await this.git(
      ['commit-tree', tree, '-m', `codex-orchestrator runtime owner epoch ${record.fencingEpoch}`],
      undefined,
      fixedGitIdentityEnv(),
    ), 'commit');
    const lease = `--force-with-lease=${this.ownerRef}:${expectedSha ?? ''}`;
    const pushed = await this.execute('git', [
      'push',
      lease,
      this.remote,
      `${commit}:${this.ownerRef}`,
    ], { cwd: this.targetRoot });
    if (pushed.exitCode !== 0) {
      try {
        const reconciled = await this.read();
        if (reconciled?.sha === commit
          && canonicalRuntimeOwnerRecord(reconciled.record) === canonical) {
          return reconciled;
        }
      } catch {
        // Preserve the compare-and-swap failure below when reconciliation is unavailable.
      }
      throw new RuntimeOwnerConflictError(
        `compare-and-swap failed${pushed.stderr.trim() ? `: ${pushed.stderr.trim()}` : ''}`,
      );
    }
    const observed = await this.read();
    if (!observed || observed.sha !== commit
      || canonicalRuntimeOwnerRecord(observed.record) !== canonical) {
      throw new RuntimeOwnerConflictError('post-push owner ref does not match the requested record');
    }
    return observed;
  }

  private async git(
    args: string[],
    stdin?: string,
    env?: Record<string, string>,
  ) {
    const result = await this.execute('git', args, {
      cwd: this.targetRoot,
      ...(stdin === undefined ? {} : { stdin }),
      ...(env === undefined ? {} : { env }),
    });
    if (result.exitCode !== 0) {
      throw new Error(`Git runtime-owner command failed: git ${args.join(' ')}: ${result.stderr.trim()}`);
    }
    return result;
  }
}

function objectId(result: { stdout: string }, kind: string): string {
  const id = result.stdout.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(id)) {
    throw new Error(`Git runtime-owner ${kind} command returned an invalid object ID.`);
  }
  return id;
}

function fixedGitIdentityEnv(): Record<string, string> {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    GIT_AUTHOR_NAME: 'codex-orchestrator',
    GIT_AUTHOR_EMAIL: 'codex-orchestrator@localhost',
    GIT_COMMITTER_NAME: 'codex-orchestrator',
    GIT_COMMITTER_EMAIL: 'codex-orchestrator@localhost',
  };
}
