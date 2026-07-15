import type { ProcessExecutor } from '../process/command.js';
import { defaultProcessExecutor } from '../process/command.js';
import type { MissionPublicationBranchAdapter } from './mission-publication.js';

export class GitMissionPublicationBranchAdapter implements MissionPublicationBranchAdapter {
  public constructor(
    private readonly targetRoot: string,
    private readonly execute: ProcessExecutor = defaultProcessExecutor,
    private readonly remote = 'origin',
  ) {}

  public async observe(branch: string): Promise<
    { kind: 'absent' } | { kind: 'present'; commitSha: string }
  > {
    const commitSha = await this.observeRef(branch);
    return commitSha === undefined ? { kind: 'absent' } : { kind: 'present', commitSha };
  }

  public observeBase(branch: string): Promise<string | undefined> {
    return this.observeRef(branch);
  }

  public async push(input: { branch: string; candidateCommit: string }): Promise<void> {
    const ref = branchRef(input.branch);
    objectId(input.candidateCommit, 'candidateCommit');
    const result = await this.execute('git', [
      'push', '--no-verify', `--force-with-lease=${ref}:`, this.remote,
      `${input.candidateCommit}:${ref}`,
    ], { cwd: this.targetRoot });
    if (result.exitCode !== 0) {
      throw new Error(`Mission publication push failed: ${result.stderr.trim()}`);
    }
  }

  private async observeRef(branch: string): Promise<string | undefined> {
    const ref = branchRef(branch);
    const result = await this.execute('git', ['ls-remote', '--refs', this.remote, ref], {
      cwd: this.targetRoot,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Mission publication ref observation failed: ${result.stderr.trim()}`);
    }
    const lines = result.stdout.trim().length === 0 ? [] : result.stdout.trim().split(/\r?\n/u);
    if (lines.length === 0) return undefined;
    if (lines.length !== 1) throw new Error(`Mission publication ref ${ref} is ambiguous.`);
    const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\s+(.+)$/u.exec(lines[0] ?? '');
    if (!match || match[2] !== ref) throw new Error(`Mission publication ref ${ref} response is malformed.`);
    return match[1];
  }
}

function branchRef(branch: string): string {
  if (branch.length === 0 || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')
    || branch.endsWith('.') || branch.includes('..') || branch.includes('//') || branch.includes('@{')
    || /[\s~^:?*[\\]/u.test(branch)) {
    throw new Error(`Mission publication branch is invalid: ${branch}.`);
  }
  return `refs/heads/${branch}`;
}

function objectId(value: string, field: string): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) {
    throw new Error(`Mission publication ${field} must be a full Git object ID.`);
  }
}
