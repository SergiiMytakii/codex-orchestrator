import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

import { acquireOwnerControlLock, inspectOwnerControlLock } from './owner-control-lock.js';
import { Setup, type SetupDependencies } from './setup.js';

const execFileAsync = promisify(execFile);

export function createProductionSetup(input: { orchestratorHome: string; bootId: string }): Setup {
  const dependencies: SetupDependencies = {
    repository: {
      inspect: inspectRepository,
    },
    labels: {
      listPage: async ({ owner, repo, cursor }) => {
        if (cursor !== undefined) throw new Error('GitHub label cursor is unsupported by the bounded gh adapter');
        const stdout = await command('gh', ['api', '--paginate', '--slurp', `repos/${owner}/${repo}/labels?per_page=100`]);
        const value = JSON.parse(stdout) as unknown;
        if (!Array.isArray(value) || value.some((page) => !Array.isArray(page))) throw new Error('GitHub label list is malformed');
        return { labels: value.flatMap((page) => (page as unknown[]).map(parseLabel)) };
      },
      create: async ({ owner, repo, label }) => {
        try {
          await command('gh', [
            'label', 'create', label.name, '--repo', `${owner}/${repo}`,
            '--color', label.color, '--description', label.description,
          ]);
          return 'created';
        } catch (error) {
          if (error instanceof Error && /already exists/iu.test(error.message)) return 'already-exists';
          return { status: 'failed', failure: { code: 'label-create', summary: 'GitHub label creation failed.' } };
        }
      },
    },
    ownership: {
      acquire: (repository) => acquireOwnerControlLock({
        orchestratorHome: input.orchestratorHome,
        canonicalRepository: `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`,
        bootId: input.bootId,
        host: hostname(),
        pid: process.pid,
        now: () => new Date().toISOString(),
        createToken: randomUUID,
        processAlive,
        waitMs: 0,
      }),
      inspectOwner: (repository) => inspectOwnerControlLock({
        orchestratorHome: input.orchestratorHome,
        canonicalRepository: `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`,
        bootId: input.bootId,
        host: hostname(),
        processAlive,
      }),
    },
  };
  return new Setup(dependencies);
}

async function inspectRepository(targetRoot: string): Promise<{ repository?: { owner: string; repo: string }; baseBranch?: string }> {
  const remote = (await command('git', ['-C', targetRoot, 'remote', 'get-url', 'origin'])).trim();
  const repository = parseGitHubRemote(remote);
  const symbolic = (await command('git', ['-C', targetRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
  const baseBranch = symbolic.startsWith('origin/') ? symbolic.slice('origin/'.length) : undefined;
  return { ...(repository ? { repository } : {}), ...(baseBranch ? { baseBranch } : {}) };
}

function parseGitHubRemote(value: string): { owner: string; repo: string } | undefined {
  const match = value.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/u);
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
}

function parseLabel(value: unknown): { name: string } {
  if (typeof value !== 'object' || value === null || typeof (value as { name?: unknown }).name !== 'string') {
    throw new Error('GitHub label is malformed');
  }
  return { name: (value as { name: string }).name };
}

async function command(file: string, args: string[]): Promise<string> {
  try { return (await execFileAsync(file, args, { maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) {
    const stderr = typeof error === 'object' && error !== null && typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr.trim()
      : '';
    throw new Error(`${file} command failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return isErrorCode(error, 'EPERM'); }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}
