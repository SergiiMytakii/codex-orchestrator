import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

import type { MissionSandboxBackend } from './mission-capability-kernel.js';

export interface MissionSandboxInput {
  backend: MissionSandboxBackend;
  workspaceRoot: string;
  quarantineRoot: string;
  mode: 'read-only' | 'quarantine-write';
  command: string;
  args: string[];
  deniedReadPaths?: string[];
}

export interface MissionSandboxInvocation {
  file: string;
  args: string[];
}

export function buildMissionSandboxInvocation(input: MissionSandboxInput): MissionSandboxInvocation {
  assertAbsolute(input.workspaceRoot, 'workspaceRoot');
  assertAbsolute(input.quarantineRoot, 'quarantineRoot');
  assertAbsolute(input.command, 'command');
  const workspaceRoot = canonicalExistingPath(input.workspaceRoot);
  const quarantineRoot = canonicalExistingPath(input.quarantineRoot);
  if (input.backend === 'macos-sandbox') {
    const deniedUserRoots = [...new Set([
      '/Users', homedir(), tmpdir(), '/private/tmp', '/tmp', '/Volumes',
    ].map(canonicalExistingPath))];
    const profile = [
      '(version 1)',
      '(deny default)',
      '(deny network*)',
      '(allow process-exec)',
      '(allow signal (target self))',
      '(allow sysctl-read)',
      '(allow file-read*)',
      '(allow file-write* (literal "/dev/null"))',
      `(deny file-read-data ${deniedUserRoots.map((path) => `(subpath ${quoted(path)})`).join(' ')})`,
      `(allow file-read-data (subpath ${quoted(workspaceRoot)}) (subpath ${quoted(quarantineRoot)}))`,
      ...(input.deniedReadPaths ?? []).map((path) => {
        assertAbsolute(path, 'deniedReadPaths entry');
        const canonical = canonicalExistingPath(path);
        return `(deny file-read-data (literal ${quoted(canonical)}) (subpath ${quoted(canonical)}))`;
      }),
      ...(input.mode === 'quarantine-write'
        ? [`(allow file-write* (subpath ${quoted(quarantineRoot)}))`]
        : []),
    ].join('');
    return {
      file: '/usr/bin/sandbox-exec',
      args: ['-p', profile, input.command, ...input.args],
    };
  }
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-net',
    '--proc', '/proc',
    '--dev', '/dev',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', workspaceRoot, workspaceRoot,
  ];
  if (input.mode === 'quarantine-write') {
    args.push('--bind', quarantineRoot, quarantineRoot);
  } else {
    args.push('--ro-bind', quarantineRoot, quarantineRoot);
  }
  args.push('--chdir', workspaceRoot, input.command, ...input.args);
  return { file: '/usr/bin/bwrap', args };
}

function canonicalExistingPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch (error) {
    throw new Error(`Mission sandbox path must resolve to an existing canonical path: ${value}.`, {
      cause: error,
    });
  }
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function assertAbsolute(value: string, field: string): void {
  if (!value.startsWith('/')) {
    throw new Error(`Mission sandbox ${field} must be absolute.`);
  }
}
