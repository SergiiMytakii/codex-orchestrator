import {
  runMissionProcess,
  type MissionProcessInput,
  type MissionProcessResult,
} from './mission-process-executor.js';
import { realpathSync } from 'node:fs';
import type { MissionSandboxBackend } from './mission-capability-kernel.js';
import { buildMissionSandboxInvocation } from './mission-sandbox.js';

export interface MissionInputSnapshotVerifier {
  verify(inputSnapshot: string): Promise<void>;
}

export interface MissionGitInputSnapshotVerifierOptions {
  workspaceRoot: string;
  quarantineRoot: string;
  backend: MissionSandboxBackend;
  gitExecutable: string;
  deniedReadPaths?: string[];
}

export class MissionGitInputSnapshotVerifier implements MissionInputSnapshotVerifier {
  public constructor(
    private readonly options: MissionGitInputSnapshotVerifierOptions,
    private readonly runProcess: (input: MissionProcessInput) => Promise<MissionProcessResult> = runMissionProcess,
    private readonly timeoutMs = 5_000,
  ) {
    const canonicalGit = realpathSync.native(options.gitExecutable);
    const trusted = options.backend === 'macos-sandbox'
      ? /^\/(?:Applications\/Xcode\.app\/Contents\/Developer|Library\/Developer\/CommandLineTools)\/usr\/bin\/git$/u.test(canonicalGit)
      : canonicalGit === '/usr/bin/git' || canonicalGit === '/bin/git';
    if (!trusted) throw new Error(`Mission snapshot git executable is not trusted: ${canonicalGit}.`);
    this.options = { ...options, gitExecutable: canonicalGit };
  }

  public async verify(inputSnapshot: string): Promise<void> {
    const match = /^tree:([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(inputSnapshot);
    if (!match) {
      throw new Error('Mission input snapshot must pin a full Git tree object id.');
    }
    const [tree, status] = await Promise.all([
      this.git(['rev-parse', 'HEAD^{tree}']),
      this.git(['status', '--porcelain=v1', '--untracked-files=all']),
    ]);
    if (tree.trim() !== match[1] || status.trim().length > 0) {
      throw new Error('Mission input snapshot no longer matches the canonical workspace.');
    }
  }

  private async git(args: string[]): Promise<string> {
    const result = await this.runProcess({
      ...buildMissionSandboxInvocation({
        backend: this.options.backend,
        workspaceRoot: this.options.workspaceRoot,
        quarantineRoot: this.options.quarantineRoot,
        mode: 'read-only',
        command: this.options.gitExecutable,
        args: [
        '--no-optional-locks',
        '-C', this.options.workspaceRoot,
        '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false',
        '-c', 'core.hooksPath=/dev/null',
          ...args,
        ],
        deniedReadPaths: this.options.deniedReadPaths,
      }),
      cwd: this.options.workspaceRoot,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: 1024 * 1024,
      sourceEnv: { PATH: process.env.PATH },
      allowedEnvKeys: ['PATH'],
    });
    if (result.exitCode !== 0 || result.termination !== 'exited') {
      throw new Error(`Mission input snapshot Git command failed with exit ${result.exitCode}: ${result.stderr.trim()}.`);
    }
    return result.stdout;
  }
}
