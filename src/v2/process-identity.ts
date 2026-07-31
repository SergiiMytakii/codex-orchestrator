import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import type { ProcessStartIdentity } from './active-attempt.js';

export type ProcessIdentityObservation = 'same' | 'reused' | 'absent' | 'unknown';
export type ProcessGroupObservation = 'live' | 'absent' | 'unknown';
export type ProcessStartIdentityCapture =
  | { status: 'available'; identity: ProcessStartIdentity }
  | { status: 'reused' | 'absent' | 'unknown' };

export interface ProcessIdentitySystem {
  readFile(path: string): Promise<string>;
  readDarwinProcessGroupId(pid: number): Promise<
    | { status: 'present'; processGroupId: number }
    | { status: 'absent' | 'unknown' }
  >;
}

const productionSystem: ProcessIdentitySystem = {
  readFile: (path) => readFile(path, 'utf8'),
  readDarwinProcessGroupId,
};

export async function captureProcessStartIdentity(input: {
  platform: NodeJS.Platform;
  pid: number;
  processGroupId: number;
}, system: ProcessIdentitySystem = productionSystem): Promise<ProcessStartIdentityCapture> {
  positive(input.pid, 'process pid');
  positive(input.processGroupId, 'process group id');
  if (input.platform === 'linux') {
    const observed = await readLinuxProcess(input.pid, system);
    if (observed.status !== 'present') return observed;
    if (observed.processGroupId !== input.processGroupId) return { status: 'reused' };
    return { status: 'available', identity: { kind: 'linux-start-ticks', value: observed.startTicks } };
  }
  if (input.platform === 'darwin') {
    const observed = await system.readDarwinProcessGroupId(input.pid);
    if (observed.status !== 'present') return observed;
    if (observed.processGroupId !== input.processGroupId) return { status: 'reused' };
    return { status: 'available', identity: { kind: 'unavailable', platform: 'darwin' } };
  }
  return { status: 'unknown' };
}

export async function observeProcessIdentity(input: {
  platform: NodeJS.Platform;
  pid: number;
  processGroupId: number;
  processStartIdentity: ProcessStartIdentity;
}, system: ProcessIdentitySystem = productionSystem): Promise<ProcessIdentityObservation> {
  const observed = await observeProcess(input.platform, input.pid, system);
  return classifyProcessIdentity({
    platform: input.platform,
    expectedPid: input.pid,
    expectedProcessGroupId: input.processGroupId,
    expectedStartIdentity: input.processStartIdentity,
    observed,
  });
}

export function observeProcessGroup(
  processGroupId: number,
  probe: (pid: number, signal: 0) => void = process.kill,
): ProcessGroupObservation {
  positive(processGroupId, 'process group id');
  try {
    probe(-processGroupId, 0);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    if (code === 'EPERM') return 'live';
    return 'unknown';
  }
}

export function classifyProcessIdentity(input: {
  platform: NodeJS.Platform;
  expectedPid: number;
  expectedProcessGroupId: number;
  expectedStartIdentity: ProcessStartIdentity;
  observed:
    | { status: 'absent' | 'unknown' }
    | { status: 'present'; pid: number; processGroupId: number; startIdentity: string | null };
}): ProcessIdentityObservation {
  if (input.observed.status !== 'present') return input.observed.status;
  if (input.observed.pid !== input.expectedPid || input.observed.processGroupId !== input.expectedProcessGroupId) return 'reused';
  if (input.platform === 'darwin') return 'unknown';
  if (input.expectedStartIdentity.kind !== 'linux-start-ticks' || input.observed.startIdentity === null) return 'unknown';
  return input.expectedStartIdentity.value === input.observed.startIdentity ? 'same' : 'reused';
}

async function observeProcess(
  platform: NodeJS.Platform,
  pid: number,
  system: ProcessIdentitySystem,
): Promise<Parameters<typeof classifyProcessIdentity>[0]['observed']> {
  positive(pid, 'process pid');
  if (platform === 'linux') {
    const observed = await readLinuxProcess(pid, system);
    return observed.status === 'present'
      ? { status: 'present', pid, processGroupId: observed.processGroupId, startIdentity: observed.startTicks }
      : observed;
  }
  if (platform === 'darwin') {
    const observed = await system.readDarwinProcessGroupId(pid);
    return observed.status === 'present'
      ? { status: 'present', pid, processGroupId: observed.processGroupId, startIdentity: null }
      : observed;
  }
  return { status: 'unknown' };
}

async function readLinuxProcess(pid: number, system: ProcessIdentitySystem): Promise<
  | { status: 'present'; processGroupId: number; startTicks: string }
  | { status: 'absent' | 'unknown' }
> {
  let stat: string;
  try {
    stat = await system.readFile(`/proc/${pid}/stat`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? { status: 'absent' } : { status: 'unknown' };
  }
  const close = stat.lastIndexOf(') ');
  const declaredPid = Number.parseInt(stat.slice(0, stat.indexOf(' ')), 10);
  const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
  const processGroupId = Number.parseInt(fields[2] ?? '', 10);
  const startTicks = fields[19];
  if (declaredPid !== pid || !Number.isSafeInteger(processGroupId) || processGroupId <= 0 || !startTicks || !/^[0-9]+$/u.test(startTicks)) {
    return { status: 'unknown' };
  }
  return { status: 'present', processGroupId, startTicks };
}

function readDarwinProcessGroupId(pid: number): Promise<
  | { status: 'present'; processGroupId: number }
  | { status: 'absent' | 'unknown' }
> {
  return new Promise((resolveObservation) => {
    execFile('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        const code = (error as unknown as { code?: unknown }).code;
        resolveObservation(code === 1 || code === '1' ? { status: 'absent' } : { status: 'unknown' });
        return;
      }
      const processGroupId = Number.parseInt(stdout.trim(), 10);
      resolveObservation(Number.isSafeInteger(processGroupId) && processGroupId > 0
        ? { status: 'present', processGroupId }
        : { status: 'unknown' });
    });
  });
}

function positive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} is invalid`);
}
