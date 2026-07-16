import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { writeDurableAtomicFile } from '../fs/durable-atomic-file.js';

export const CONTAINMENT_CODEX_VERSION = '0.144.4' as const;
export const CONTAINMENT_PLATFORM = 'darwin' as const;
export const CONTAINMENT_SCHEMA = 'codex-orchestrator.containment' as const;
const CERTIFICATE_FILE = `containment-codex-${CONTAINMENT_CODEX_VERSION}.json`;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CERTIFICATE_BYTES = 1024 * 1024;
const DENIED_TOOL_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_CONFIG_DIR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_CONFIG_USERCONFIG',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_CONFIG',
  'AZURE_CONFIG_DIR',
  'AZURE_CLIENT_SECRET',
] as const;

export interface ContainmentProbeResultV2 {
  parentAuthReadable: true;
  parentAuthUsable: true;
  externalCredentialsUsable: false;
  deniedSecretReadable: true;
  productionSentinelExecuted: false;
}

export interface ContainmentCertificateV2 {
  schema: typeof CONTAINMENT_SCHEMA;
  version: 2;
  codexVersion: typeof CONTAINMENT_CODEX_VERSION;
  platform: typeof CONTAINMENT_PLATFORM;
  packageVersion: string;
  argvPolicySha256: string;
  root: ContainmentProbeResultV2;
  nativeChild: ContainmentProbeResultV2;
  completedAt: string;
  resultSha256: string;
}

export function containmentCertificatePath(
  orchestratorHome = resolve(process.env.CODEX_ORCHESTRATOR_HOME ?? join(homedir(), '.codex-orchestrator')),
): string {
  return join(orchestratorHome, 'v2', 'certifications', CERTIFICATE_FILE);
}

export function buildContainmentCodexArgs(input: {
  schemaPath: string;
  reportPath: string;
  toolHome: string;
  tmpDir: string;
  safePath: string;
}): string[] {
  return [
    'exec',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'workspace-write',
    '--output-schema',
    input.schemaPath,
    '--output-last-message',
    input.reportPath,
    '-c',
    'approval_policy="never"',
    '-c',
    'skills.include_instructions=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'features.apps=false',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'shell_environment_policy.inherit="none"',
    '-c',
    `shell_environment_policy.set.HOME=${tomlString(input.toolHome)}`,
    '-c',
    `shell_environment_policy.set.PATH=${tomlString(input.safePath)}`,
    '-c',
    `shell_environment_policy.set.TMPDIR=${tomlString(input.tmpDir)}`,
    '-c',
    'shell_environment_policy.set.LANG="C.UTF-8"',
    '-c',
    'shell_environment_policy.set.LC_ALL="C.UTF-8"',
    ...DENIED_TOOL_ENV_KEYS.flatMap((key) => [
      '-c',
      `shell_environment_policy.set.${key}=""`,
    ]),
    '-',
  ];
}

export function buildContainmentCodexEnvironment(input: {
  parentEnv: NodeJS.ProcessEnv;
  parentCodexHome: string;
  safePath: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: input.safePath,
    CODEX_HOME: input.parentCodexHome,
    HOME: input.parentEnv.HOME ?? homedir(),
    LANG: input.parentEnv.LANG ?? 'C.UTF-8',
    LC_ALL: input.parentEnv.LC_ALL ?? 'C.UTF-8',
    TMPDIR: input.parentEnv.TMPDIR ?? '/tmp',
  };
  return env;
}

export function containmentArgvPolicySha256(): string {
  const args = buildContainmentCodexArgs({
    schemaPath: '<snapshot-schema>',
    reportPath: '<attempt-report>',
    toolHome: '<isolated-tool-home>',
    tmpDir: '<attempt-tmp>',
    safePath: '<fixed-safe-path>',
  });
  return sha256(canonicalJson({ command: 'codex', args, promptTransport: 'stdin' }));
}

export function createContainmentCertificate(input: {
  packageVersion: string;
  argvPolicySha256: string;
  root: ContainmentProbeResultV2;
  nativeChild: ContainmentProbeResultV2;
  completedAt: string;
}): ContainmentCertificateV2 {
  assertNonEmptyString(input.packageVersion, 'packageVersion');
  assertSha256(input.argvPolicySha256, 'argvPolicySha256');
  validateProbeResult(input.root, 'root');
  validateProbeResult(input.nativeChild, 'nativeChild');
  assertIsoTimestamp(input.completedAt);
  assert.equalPlatform();
  const unsigned = {
    schema: CONTAINMENT_SCHEMA,
    version: 2 as const,
    codexVersion: CONTAINMENT_CODEX_VERSION,
    platform: CONTAINMENT_PLATFORM,
    packageVersion: input.packageVersion,
    argvPolicySha256: input.argvPolicySha256,
    root: input.root,
    nativeChild: input.nativeChild,
    completedAt: input.completedAt,
  };
  return { ...unsigned, resultSha256: sha256(canonicalJson(unsigned)) };
}

export function validateContainmentCertificate(value: unknown): ContainmentCertificateV2 {
  assertExactObject(value, [
    'schema',
    'version',
    'codexVersion',
    'platform',
    'packageVersion',
    'argvPolicySha256',
    'root',
    'nativeChild',
    'completedAt',
    'resultSha256',
  ], 'containment certificate');
  if (value.schema !== CONTAINMENT_SCHEMA) throw new Error('invalid containment schema');
  if (value.version !== 2) throw new Error('invalid containment version');
  if (value.codexVersion !== CONTAINMENT_CODEX_VERSION) throw new Error('invalid containment Codex version');
  if (value.platform !== CONTAINMENT_PLATFORM) throw new Error('invalid containment platform');
  assertNonEmptyString(value.packageVersion, 'packageVersion');
  assertSha256(value.argvPolicySha256, 'argvPolicySha256');
  validateProbeResult(value.root, 'root');
  validateProbeResult(value.nativeChild, 'nativeChild');
  assertIsoTimestamp(value.completedAt);
  assertSha256(value.resultSha256, 'resultSha256');
  const unsigned = {
    schema: value.schema,
    version: value.version,
    codexVersion: value.codexVersion,
    platform: value.platform,
    packageVersion: value.packageVersion,
    argvPolicySha256: value.argvPolicySha256,
    root: value.root,
    nativeChild: value.nativeChild,
    completedAt: value.completedAt,
  };
  if (sha256(canonicalJson(unsigned)) !== value.resultSha256) {
    throw new Error('containment result digest mismatch');
  }
  return value as unknown as ContainmentCertificateV2;
}

export async function writeContainmentCertificate(
  path: string,
  certificate: ContainmentCertificateV2,
): Promise<void> {
  validateContainmentCertificate(certificate);
  await writeDurableAtomicFile(path, `${canonicalJson(certificate)}\n`);
}

export async function readContainmentCertificate(path: string): Promise<ContainmentCertificateV2> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_CERTIFICATE_BYTES) throw new Error('containment certificate exceeds 1 MiB');
  return validateContainmentCertificate(parseJsonWithoutDuplicateKeys(bytes.toString('utf8')));
}

export async function removeMatchingContainmentCertificate(
  path: string,
  expected: { codexVersion: string; packageVersion: string; argvPolicySha256: string },
): Promise<void> {
  let certificate: ContainmentCertificateV2;
  try {
    certificate = await readContainmentCertificate(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    return;
  }
  if (
    certificate.codexVersion === expected.codexVersion
    && certificate.packageVersion === expected.packageVersion
    && certificate.argvPolicySha256 === expected.argvPolicySha256
  ) {
    await rm(path, { force: true });
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical JSON accepts safe integers only');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const fields = keys.map((key) => {
      const item = record[key];
      if (item === undefined) throw new Error('canonical JSON rejects undefined');
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    });
    return `{${fields.join(',')}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateProbeResult(value: unknown, field: string): asserts value is ContainmentProbeResultV2 {
  assertExactObject(value, [
    'parentAuthReadable',
    'parentAuthUsable',
    'externalCredentialsUsable',
    'deniedSecretReadable',
    'productionSentinelExecuted',
  ], field);
  if (value.parentAuthReadable !== true) throw new Error(`${field}.parentAuthReadable must be true`);
  if (value.parentAuthUsable !== true) throw new Error(`${field}.parentAuthUsable must be true`);
  if (value.deniedSecretReadable !== true) throw new Error(`${field}.deniedSecretReadable must be true`);
  for (const key of ['externalCredentialsUsable', 'productionSentinelExecuted'] as const) {
    if (value[key] !== false) throw new Error(`${field}.${key} must be false`);
  }
}

function assertExactObject(value: unknown, expectedKeys: string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpected.length || actualKeys.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('completedAt must be an ISO timestamp');
  }
}

const assert = {
  equalPlatform(): void {
    if (platform() !== CONTAINMENT_PLATFORM) throw new Error('containment certificate requires darwin');
  },
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function parseJsonWithoutDuplicateKeys(source: string): unknown {
  let index = 0;

  const skipWhitespace = () => {
    while (/\s/.test(source[index] ?? '')) index += 1;
  };

  const parseValue = (): unknown => {
    skipWhitespace();
    const current = source[index];
    if (current === '{') return parseObject();
    if (current === '[') return parseArray();
    if (current === '"') return parseString();
    if (source.startsWith('true', index)) { index += 4; return true; }
    if (source.startsWith('false', index)) { index += 5; return false; }
    if (source.startsWith('null', index)) { index += 4; return null; }
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error(`invalid JSON at byte ${index}`);
    index += match[0].length;
    return Number(match[0]);
  };

  const parseString = (): string => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (!escaped && character === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index)) as string;
      }
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      index += 1;
    }
    throw new Error('unterminated JSON string');
  };

  const parseObject = (): Record<string, unknown> => {
    index += 1;
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWhitespace();
    if (source[index] === '}') { index += 1; return result; }
    while (true) {
      skipWhitespace();
      if (source[index] !== '"') throw new Error('JSON object key must be a string');
      const key = parseString();
      if (seen.has(key)) throw new Error(`duplicate JSON key: ${key}`);
      seen.add(key);
      skipWhitespace();
      if (source[index] !== ':') throw new Error('JSON object key must be followed by colon');
      index += 1;
      result[key] = parseValue();
      skipWhitespace();
      if (source[index] === '}') { index += 1; return result; }
      if (source[index] !== ',') throw new Error('JSON object entries must be comma-separated');
      index += 1;
    }
  };

  const parseArray = (): unknown[] => {
    index += 1;
    const result: unknown[] = [];
    skipWhitespace();
    if (source[index] === ']') { index += 1; return result; }
    while (true) {
      result.push(parseValue());
      skipWhitespace();
      if (source[index] === ']') { index += 1; return result; }
      if (source[index] !== ',') throw new Error('JSON array entries must be comma-separated');
      index += 1;
    }
  };

  const value = parseValue();
  skipWhitespace();
  if (index !== source.length) throw new Error('trailing JSON content');
  return value;
}
