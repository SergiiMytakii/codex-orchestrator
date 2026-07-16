import { posix } from 'node:path';

const MAX_STRING_LENGTH = 16 * 1024;
const MAX_DESCRIPTION_LENGTH = 4 * 1024;
const MAX_ARRAY_LENGTH = 256;

interface LabelPolicy {
  name: string;
  color: string;
  description: string;
}

export interface AgentAutoConfigV1 {
  schema: 'codex-orchestrator.agent-auto';
  version: 1;
  github: {
    owner: string;
    repo: string;
    baseBranch: string;
    labels: {
      auto: LabelPolicy;
      running: LabelPolicy;
      blocked: LabelPolicy;
      review: LabelPolicy;
    };
  };
  runner: {
    workspaceRoot: string;
    stateDir: string;
    branchTemplate: 'codex/issue-${issueNumber}';
    pollIntervalSeconds: number;
    maxCycles: 5;
  };
  codex: {
    command: string;
    requiredVersion: '0.144.4';
    timeoutMs: number;
    idleTimeoutMs: number;
    toolNetwork: 'deny';
  };
  checks: Record<string, string>;
  proof: { artifactDir: string };
  deny: { readPaths: string[]; commands: string[] };
}

export function parseAgentAutoConfig(value: unknown): AgentAutoConfigV1 {
  assertExactObject(value, ['schema', 'version', 'github', 'runner', 'codex', 'checks', 'proof', 'deny'], 'config');
  if (value.schema !== 'codex-orchestrator.agent-auto') throw new Error('config.schema is invalid');
  if (value.version !== 1) throw new Error('config.version is invalid');

  assertExactObject(value.github, ['owner', 'repo', 'baseBranch', 'labels'], 'config.github');
  assertGitHubOwner(value.github.owner, 'config.github.owner');
  assertGitHubRepo(value.github.repo, 'config.github.repo');
  assertNonEmptyString(value.github.baseBranch, 'config.github.baseBranch');
  assertExactObject(value.github.labels, ['auto', 'running', 'blocked', 'review'], 'config.github.labels');
  for (const key of ['auto', 'running', 'blocked', 'review'] as const) {
    validateLabel(value.github.labels[key], `config.github.labels.${key}`);
  }

  assertExactObject(value.runner, [
    'workspaceRoot',
    'stateDir',
    'branchTemplate',
    'pollIntervalSeconds',
    'maxCycles',
  ], 'config.runner');
  assertRepositoryRelativePath(value.runner.workspaceRoot, 'config.runner.workspaceRoot');
  assertRepositoryRelativePath(value.runner.stateDir, 'config.runner.stateDir');
  if (value.runner.branchTemplate !== 'codex/issue-${issueNumber}') throw new Error('config.runner.branchTemplate is invalid');
  assertPositiveSafeInteger(value.runner.pollIntervalSeconds, 'config.runner.pollIntervalSeconds');
  if (value.runner.maxCycles !== 5) throw new Error('config.runner.maxCycles must be 5');

  assertExactObject(value.codex, [
    'command',
    'requiredVersion',
    'timeoutMs',
    'idleTimeoutMs',
    'toolNetwork',
  ], 'config.codex');
  assertNonEmptyString(value.codex.command, 'config.codex.command');
  if (value.codex.requiredVersion !== '0.144.4') throw new Error('config.codex.requiredVersion is invalid');
  assertPositiveSafeInteger(value.codex.timeoutMs, 'config.codex.timeoutMs');
  assertPositiveSafeInteger(value.codex.idleTimeoutMs, 'config.codex.idleTimeoutMs');
  if (value.codex.toolNetwork !== 'deny') throw new Error('config.codex.toolNetwork must be deny');

  assertRecord(value.checks, 'config.checks');
  const checkEntries = Object.entries(value.checks);
  if (checkEntries.length > MAX_ARRAY_LENGTH) throw new Error('config.checks exceeds 256 entries');
  for (const [name, command] of checkEntries) {
    assertNonEmptyString(name, 'config.checks key');
    assertNonEmptyString(command, `config.checks.${name}`);
  }

  assertExactObject(value.proof, ['artifactDir'], 'config.proof');
  assertRepositoryRelativePath(value.proof.artifactDir, 'config.proof.artifactDir');

  assertExactObject(value.deny, ['readPaths', 'commands'], 'config.deny');
  assertStringArray(value.deny.readPaths, 'config.deny.readPaths');
  for (const deniedPath of value.deny.readPaths) assertDeniedPath(deniedPath, 'config.deny.readPaths');
  assertStringArray(value.deny.commands, 'config.deny.commands');
  for (const command of value.deny.commands) assertCanonicalAbsolutePath(command, 'config.deny.commands');

  return value as unknown as AgentAutoConfigV1;
}

function validateLabel(value: unknown, field: string): void {
  assertExactObject(value, ['name', 'color', 'description'], field);
  assertNonEmptyString(value.name, `${field}.name`);
  assertNonEmptyString(value.color, `${field}.color`);
  assertNonEmptyString(value.description, `${field}.description`, MAX_DESCRIPTION_LENGTH);
}

function assertDeniedPath(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${field} entries must be strings`);
  if (value.startsWith('/')) assertCanonicalAbsolutePath(value, field);
  else assertRepositoryRelativePath(value, field);
}

function assertRepositoryRelativePath(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (value.startsWith('/') || value.includes('\\') || posix.normalize(value) !== value) {
    throw new Error(`${field} must be a normalized repository-relative POSIX path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${field} must not contain empty, dot, or dot-dot segments`);
  }
}

function assertCanonicalAbsolutePath(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (!value.startsWith('/') || value.includes('\\') || posix.normalize(value) !== value) {
    throw new Error(`${field} must contain canonical absolute POSIX paths`);
  }
  const segments = value.split('/').slice(1);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${field} must not contain empty, dot, or dot-dot segments`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) throw new Error(`${field} must be an array of at most 256 strings`);
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_STRING_LENGTH) throw new Error(`${field} entries must be bounded strings`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive safe integer`);
}

function assertNonEmptyString(value: unknown, field: string, maxLength = MAX_STRING_LENGTH): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
}

function assertGitHubOwner(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 39 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(value)) {
    throw new Error(`${field} is not a canonical GitHub owner`);
  }
}

function assertGitHubRepo(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9._-]+$/u.test(value) || value === '.' || value === '..') {
    throw new Error(`${field} is not a canonical GitHub repository name`);
  }
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
}

function assertExactObject(value: unknown, expectedKeys: string[], field: string): asserts value is Record<string, unknown> {
  assertRecord(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}
