import { basename } from 'node:path';
import { createHash } from 'node:crypto';

import { uniqueSortedPaths } from '../path-policy.js';
import { assertMissionPathPattern, scopePatternContainedBy } from './mission-path-language.js';

export type MissionSandboxBackend = 'macos-sandbox' | 'linux-bwrap';
export type MissionCapability = 'git-status' | 'read-file' | 'validate-patch';

export const missionGitStatusArgv = [
  '/usr/bin/git',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.hooksPath=/dev/null',
  'status', '--porcelain=v1', '--untracked-files=all',
] as const;

export interface MissionCapabilityProbeInput {
  platform: NodeJS.Platform;
  commands: ReadonlySet<string>;
}

export interface MissionCapabilityProbeResult {
  prerequisitesAvailable: boolean;
  backend?: MissionSandboxBackend;
  missing: string[];
}

export interface MissionCapabilityRequest {
  missionId: string;
  actionKey: string;
  capability: MissionCapability;
  argv: string[];
  requestedPaths: string[];
  grantedPaths: string[];
  inputSnapshot: string;
  fencingEpoch: number;
  expiresAt: string;
  readPath?: string;
  maxReadBytes?: number;
}

export interface MissionCapabilityPermit extends MissionCapabilityRequest {
  network: 'deny';
  workspace: 'read-only';
}

export function missionCapabilityPermitFingerprint(permit: MissionCapabilityPermit): string {
  const canonical = JSON.stringify([
    'mission-capability-permit-v1',
    permit.missionId,
    permit.actionKey,
    permit.capability,
    permit.argv,
    permit.requestedPaths,
    permit.grantedPaths,
    permit.inputSnapshot,
    permit.fencingEpoch,
    permit.expiresAt,
    permit.readPath ?? null,
    permit.maxReadBytes ?? null,
    permit.network,
    permit.workspace,
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

const secretPath = /(^|\/)(?:\.env(?:\..*)?|\.git(?:\/|$)|id_(?:rsa|ed25519)(?:\.pub)?$)/iu;
const safeEnvironmentKeys = new Set([
  'CI', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'PATH', 'TERM', 'TZ',
]);

export function discoverMissionExecutorPrerequisites(
  input: MissionCapabilityProbeInput,
): MissionCapabilityProbeResult {
  if (input.platform === 'darwin') {
    const missing = [
      input.commands.has('/usr/bin/sandbox-exec') ? undefined : 'sandbox-exec',
      input.commands.has('/usr/bin/git') ? undefined : 'git',
    ].filter((value): value is string => value !== undefined);
    return {
      prerequisitesAvailable: missing.length === 0,
      backend: missing.length === 0 ? 'macos-sandbox' : undefined,
      missing,
    };
  }
  if (input.platform === 'linux') {
    const hasBwrap = [...input.commands].some((command) => basename(command) === 'bwrap');
    const hasGit = [...input.commands].some((command) => basename(command) === 'git');
    const missing = [hasBwrap ? undefined : 'bwrap', hasGit ? undefined : 'git']
      .filter((value): value is string => value !== undefined);
    return {
      prerequisitesAvailable: missing.length === 0,
      backend: missing.length === 0 ? 'linux-bwrap' : undefined,
      missing,
    };
  }
  return {
    prerequisitesAvailable: false,
    backend: undefined,
    missing: [`unsupported-platform:${input.platform}`],
  };
}

export function authorizeMissionCapability(
  request: MissionCapabilityRequest,
): MissionCapabilityPermit {
  requireText(request.missionId, 'missionId');
  requireText(request.actionKey, 'actionKey');
  requireText(request.inputSnapshot, 'inputSnapshot');
  if (!Number.isSafeInteger(request.fencingEpoch) || request.fencingEpoch <= 0) {
    throw new Error('Mission capability fencingEpoch must be a positive integer.');
  }
  if (!Number.isFinite(Date.parse(request.expiresAt))) {
    throw new Error('Mission capability expiresAt must be an ISO timestamp.');
  }
  assertAllowedArgv(request.capability, request.argv);
  const grantedPaths = normalizeScope(request.grantedPaths, 'granted');
  const requestedPaths = normalizeScope(request.requestedPaths, 'requested');
  if (request.capability === 'read-file') {
    if (typeof request.readPath !== 'string' || request.readPath.includes('*')
      || requestedPaths.length !== 1 || requestedPaths[0] !== request.readPath
      || !Number.isSafeInteger(request.maxReadBytes) || request.maxReadBytes! <= 0
      || request.maxReadBytes! > 1024 * 1024) {
      throw new Error('Mission read-file requires one concrete readPath and maxReadBytes up to 1048576.');
    }
  } else if (request.readPath !== undefined || request.maxReadBytes !== undefined) {
    throw new Error(`Mission capability ${request.capability} forbids read-file inputs.`);
  }
  if (request.capability === 'git-status'
    && (requestedPaths.length !== 1 || requestedPaths[0] !== '**')) {
    throw new Error('Mission capability git-status requires explicit whole-repository scope.');
  }
  for (const path of requestedPaths) {
    if (secretPath.test(path)) {
      throw new Error(`Mission capability requested secret path: ${path}.`);
    }
    if (!grantedPaths.some((grant) => scopePatternContainedBy(path, grant))) {
      throw new Error(`Mission capability path is outside granted scope: ${path}.`);
    }
  }
  return {
    missionId: request.missionId,
    actionKey: request.actionKey,
    capability: request.capability,
    argv: [...request.argv],
    requestedPaths,
    grantedPaths,
    inputSnapshot: request.inputSnapshot,
    fencingEpoch: request.fencingEpoch,
    expiresAt: request.expiresAt,
    ...(request.capability === 'read-file' ? {
      readPath: request.readPath,
      maxReadBytes: request.maxReadBytes,
    } : {}),
    network: 'deny',
    workspace: 'read-only',
  };
}

export function scrubMissionExecutorEnv(
  source: NodeJS.ProcessEnv,
  allowedKeys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [...new Set(allowedKeys)].sort()) {
    if (!safeEnvironmentKeys.has(key)) {
      continue;
    }
    const value = source[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function assertAllowedArgv(capability: MissionCapability, argv: string[]): void {
  const expected: Record<MissionCapability, string[][]> = {
    'git-status': [[]],
    'read-file': [[]],
    'validate-patch': [[]],
  };
  const normalized = argv.map((value, index) => index === 0 ? basename(value) : value);
  if (!expected[capability].some((candidate) => arraysEqual(candidate, normalized))) {
    throw new Error(`Mission capability ${capability} requires allowlisted argv.`);
  }
}

function normalizeScope(paths: string[], kind: string): string[] {
  const normalized = uniqueSortedPaths(paths);
  if (normalized.length === 0) {
    throw new Error(`Mission capability ${kind} scope must contain repository-relative globs.`);
  }
  normalized.forEach((path) => assertMissionPathPattern(path, `Mission capability ${kind} scope`));
  return normalized;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Mission capability ${field} must be non-empty.`);
  }
}
