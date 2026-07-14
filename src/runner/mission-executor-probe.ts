import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverMissionExecutorPrerequisites,
  type MissionCapabilityProbeInput,
  type MissionSandboxBackend,
} from './mission-capability-kernel.js';
import { runMissionProcess } from './mission-process-executor.js';
import { buildMissionSandboxInvocation } from './mission-sandbox.js';

export interface MissionExecutorProbeResult {
  supported: boolean;
  backend?: MissionSandboxBackend;
  checks: string[];
  failures: string[];
}

export const missionExecutorRequiredChecks = [
  'canonical-write-denied',
  'credential-env-stripped',
  'denied-read-path-blocked',
  'descendant-process-terminated',
  'network-denied',
  'quarantine-write-allowed',
] as const;

export async function probeMissionExecutorCapabilities(
  input: MissionCapabilityProbeInput,
): Promise<MissionExecutorProbeResult> {
  const prerequisites = discoverMissionExecutorPrerequisites(input);
  if (!prerequisites.prerequisitesAvailable || !prerequisites.backend) {
    return { supported: false, checks: [], failures: prerequisites.missing };
  }
  if (prerequisites.backend !== 'macos-sandbox') {
    return {
      supported: false,
      backend: prerequisites.backend,
      checks: [],
      failures: ['active-probe-not-implemented:linux-bwrap'],
    };
  }

  const workspace = await mkdtemp(join(tmpdir(), 'mission-probe-workspace-'));
  const quarantine = await mkdtemp(join(tmpdir(), 'mission-probe-quarantine-'));
  const checks: string[] = [];
  const failures: string[] = [];
  try {
    const quarantinePath = join(quarantine, 'allowed.txt');
    const canonicalPath = join(workspace, 'blocked.txt');
    const secretPath = join(workspace, '.env');
    await writeFile(secretPath, 'filesystem-credential-canary', 'utf8');
    const sandboxInput = {
      backend: prerequisites.backend,
      workspaceRoot: workspace,
      quarantineRoot: quarantine,
      mode: 'quarantine-write',
    } as const;
    const processInput = {
      cwd: workspace,
      timeoutMs: 5_000,
      sourceEnv: { PATH: process.env.PATH, MISSION_SECRET_CANARY: 'credential-env-canary' },
      allowedEnvKeys: ['PATH', 'MISSION_SECRET_CANARY'],
    };
    const quarantineWrite = await runMissionProcess({
      ...buildMissionSandboxInvocation({
        ...sandboxInput,
        command: '/usr/bin/tee',
        args: [quarantinePath],
      }),
      ...processInput,
      stdin: 'ok',
    });
    if (quarantineWrite.exitCode === 0 && (await readFile(quarantinePath, 'utf8').catch(() => '')) === 'ok') {
      checks.push('quarantine-write-allowed');
    } else {
      failures.push('quarantine-write-not-observed');
    }
    const canonicalWrite = await runMissionProcess({
      ...buildMissionSandboxInvocation({
        ...sandboxInput,
        command: '/usr/bin/tee',
        args: [canonicalPath],
      }),
      ...processInput,
      stdin: 'bad',
    });
    if (canonicalWrite.exitCode !== 0 && !(await exists(canonicalPath))) checks.push('canonical-write-denied');
    else failures.push('canonical-write-succeeded');
    const deniedRead = await runMissionProcess({
      ...buildMissionSandboxInvocation({
        ...sandboxInput,
        mode: 'read-only',
        command: '/bin/cat',
        args: [secretPath],
        deniedReadPaths: [secretPath],
      }),
      ...processInput,
    });
    if (deniedRead.exitCode !== 0 && !deniedRead.stdout.includes('filesystem-credential-canary')) checks.push('denied-read-path-blocked');
    else failures.push('denied-read-path-readable');
    const environment = await runMissionProcess({
      ...buildMissionSandboxInvocation({
        ...sandboxInput,
        mode: 'read-only',
        command: '/usr/bin/env',
        args: [],
      }),
      ...processInput,
    });
    if (!environment.stdout.includes('credential-env-canary')) checks.push('credential-env-stripped');
    else failures.push('credential-env-visible');

    const networkInvocation = buildMissionSandboxInvocation({
      backend: prerequisites.backend,
      workspaceRoot: workspace,
      quarantineRoot: quarantine,
      mode: 'read-only',
      command: '/usr/bin/perl',
      args: [
        '-MSocket',
        '-MErrno=EPERM',
        '-e',
        'socket(my $s, PF_INET, SOCK_STREAM, 0) or die $!; connect($s, sockaddr_in(9, inet_aton("127.0.0.1"))); exit($! == EPERM ? 0 : 30)',
      ],
    });
    const network = await runMissionProcess({
      ...networkInvocation,
      cwd: workspace,
      timeoutMs: 5_000,
      sourceEnv: { PATH: process.env.PATH },
      allowedEnvKeys: ['PATH'],
    });
    if (network.exitCode === 0) checks.push('network-denied');
    else failures.push(`network-canary:${network.exitCode}`);

    const daemonInvocation = buildMissionSandboxInvocation({
      backend: prerequisites.backend,
      workspaceRoot: workspace,
      quarantineRoot: quarantine,
      mode: 'read-only',
      command: '/usr/bin/perl',
      args: [
        '-MPOSIX=setsid',
        '-e',
        'my $pid=fork(); if(!defined $pid){print "fork-denied"; exit 0} if($pid==0){setsid(); exec "/bin/sleep","60"; exit 50} print $pid; waitpid($pid,0); exit 40',
      ],
    });
    const daemon = await runMissionProcess({
      ...daemonInvocation,
      cwd: workspace,
      timeoutMs: 1_000,
      sourceEnv: { PATH: process.env.PATH },
      allowedEnvKeys: ['PATH'],
    });
    if (!daemon.timedOut && daemon.exitCode === 0 && daemon.stdout.trim() === 'fork-denied') {
      checks.push('descendant-process-terminated');
    } else {
      const descendantPid = Number(daemon.stdout.trim());
      if (Number.isSafeInteger(descendantPid) && descendantPid > 0) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already contained */ }
      }
      failures.push(`descendant-fork-not-denied:${daemon.exitCode}`);
    }
  } catch (error) {
    failures.push(`active-probe:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await Promise.all([workspace, quarantine]
      .map((path) => rm(path, { recursive: true, force: true })));
  }
  checks.sort();
  failures.sort();
  return {
    supported: failures.length === 0,
    backend: prerequisites.backend,
    checks,
    failures,
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
