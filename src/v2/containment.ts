import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import type { WorkflowExecutionProfile, WorkflowOperationPolicy } from './workflow-assets.js';

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

export function buildContainmentCodexArgs(input: {
  schemaPath: string;
  reportPath: string;
  toolHome: string;
  tmpDir: string;
  safePath: string;
  operationPolicy?: WorkflowOperationPolicy;
  executionProfile?: Pick<WorkflowExecutionProfile, 'model' | 'reasoningEffort'>;
  agentProfilePaths?: Record<string, string>;
}): string[] {
  const operationPolicy = input.operationPolicy ?? defaultContainmentOperationPolicy();
  validateContainmentOperationPolicy(operationPolicy);
  for (const [id, path] of Object.entries(input.agentProfilePaths ?? {})) {
    if (!/^[a-z0-9_]+$/u.test(id) || !path.startsWith('/')) throw new Error('agent profile binding is invalid');
  }
  return [
    'exec',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    operationPolicy.sandboxMode,
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
    ...(input.executionProfile ? [
      '-c', `model=${tomlString(input.executionProfile.model)}`,
      '-c', `model_reasoning_effort=${tomlString(input.executionProfile.reasoningEffort)}`,
    ] : []),
    ...Object.entries(input.agentProfilePaths ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).flatMap(([id, path]) => [
      '-c', `agents.${id}.config_file=${tomlString(path)}`,
    ]),
    '-c',
    'shell_environment_policy.inherit="none"',
    '-c',
    `shell_environment_policy.set.HOME=${tomlString(input.toolHome)}`,
    '-c',
    `shell_environment_policy.set.PATH=${tomlString(input.safePath)}`,
    '-c',
    `shell_environment_policy.set.TMPDIR=${tomlString(input.tmpDir)}`,
    '-c',
    `shell_environment_policy.set.CODEX_ORCHESTRATOR_WORKFLOW_ROOT=${tomlString(dirname(dirname(input.schemaPath)))}`,
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

export function validateContainmentOperationPolicy(policy: WorkflowOperationPolicy): void {
  if (!['read-only', 'workspace-write'].includes(policy.sandboxMode)
    || policy.cwdClass !== 'worktree'
    || !['read-only', 'write'].includes(policy.worktreeAccess)
    || policy.network !== 'deny' || policy.networkHosts.length !== 0 || policy.mcpTools.length !== 0
    || policy.approvalCeiling !== 'never' || policy.externalWrite !== false) {
    throw new Error('operation policy exceeds containment authority');
  }
  if (policy.sandboxMode === 'read-only') {
    if (policy.worktreeAccess !== 'read-only' || policy.writableRootClasses.length !== 0 || policy.runnerPostcondition !== 'report-only') {
      throw new Error('read-only operation policy is inconsistent');
    }
    return;
  }
  if (policy.worktreeAccess !== 'write' || policy.writableRootClasses.length !== 1
    || policy.writableRootClasses[0] !== policy.cwdClass
    || !['change-set', 'proof-only'].includes(policy.runnerPostcondition)) {
    throw new Error('write operation policy is inconsistent');
  }
}

export function defaultContainmentOperationPolicy(): WorkflowOperationPolicy {
  return {
    sandboxMode: 'workspace-write', cwdClass: 'worktree', worktreeAccess: 'write', writableRootClasses: ['worktree'],
    runnerPostcondition: 'change-set', network: 'deny', networkHosts: [], mcpTools: [], approvalCeiling: 'never', externalWrite: false,
  };
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

export function containsCredentialEvidence(value: string): boolean {
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
    /["']?authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+/iu,
    /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*["']?[^\s"']{8,}/iu,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  ].some((pattern) => pattern.test(value));
}

export function containsHostIdentityEvidence(value: string): boolean {
  return /(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+)/mu.test(value);
}

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
