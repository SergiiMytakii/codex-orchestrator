import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export interface LegacyCutoverRecord {
  kind: 'legacy-v1' | 'experimental-skill-runtime-v2';
  repository: { owner: string; repo: string };
  workspaceRoot: string;
  stateDir: string;
  runningLabel: string;
  configSha256: string;
}

export type LegacyDetection =
  | { status: 'recognized'; record: LegacyCutoverRecord }
  | { status: 'unsupported' };

export interface CutoverManifestV1 {
  schema: 'codex-orchestrator.agent-auto-fresh-cutover';
  version: 1;
  transactionId: string;
  repository: { owner: string; repo: string };
  source: { configPath: string; configSha256: string; statePath: string; stateSha256: string };
  destination: { workspaceRoot: string; stateDir: string; proofDir: string; configSha256: string };
  retained: { worktreePaths: string[]; localRefs: string[]; remoteRefs: string[] };
  backup: { root: string; configPath: string; statePath: string };
}

export function detectLegacyConfig(bytes: Buffer): LegacyDetection {
  if (bytes.length === 0 || bytes.length > 1024 * 1024) return { status: 'unsupported' };
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return { status: 'unsupported' }; }
  if (!isRecord(value)) return { status: 'unsupported' };
  const kind = value.version === 1 && value.schema === undefined
    ? 'legacy-v1'
    : value.schema === 'codex-orchestrator.skill-runtime-v2' && value.version === 1
      ? 'experimental-skill-runtime-v2'
      : undefined;
  if (!kind || !isRecord(value.github) || !isRecord(value.runner) || !isRecord(value.github.labels)
    || !isRecord(value.github.labels.running)) return { status: 'unsupported' };
  const owner = value.github.owner;
  const repo = value.github.repo;
  const workspaceRoot = value.runner.workspaceRoot;
  const stateDir = value.runner.stateDir;
  const runningLabel = value.github.labels.running.name;
  if (!isName(owner, 39) || !isName(repo, 100) || !isRelativePath(workspaceRoot)
    || !isRelativePath(stateDir) || !isName(runningLabel, 256)) return { status: 'unsupported' };
  return {
    status: 'recognized',
    record: {
      kind, repository: { owner, repo }, workspaceRoot, stateDir, runningLabel,
      configSha256: sha256(bytes),
    },
  };
}

export function parseCutoverManifest(value: unknown): CutoverManifestV1 {
  exact(value, ['schema', 'version', 'transactionId', 'repository', 'source', 'destination', 'retained', 'backup'], 'manifest');
  if (value.schema !== 'codex-orchestrator.agent-auto-fresh-cutover' || value.version !== 1) throw new Error('manifest identity is invalid');
  if (!isSha(value.transactionId)) throw new Error('manifest transaction is invalid');
  exact(value.repository, ['owner', 'repo'], 'repository');
  if (!isName(value.repository.owner, 39) || !isName(value.repository.repo, 100)) throw new Error('manifest repository is invalid');
  exact(value.source, ['configPath', 'configSha256', 'statePath', 'stateSha256'], 'source');
  if (!isRelativePath(value.source.configPath) || !isSha(value.source.configSha256)
    || !isRelativePath(value.source.statePath) || !isSha(value.source.stateSha256)) throw new Error('manifest source is invalid');
  exact(value.destination, ['workspaceRoot', 'stateDir', 'proofDir', 'configSha256'], 'destination');
  if (!isRelativePath(value.destination.workspaceRoot) || !isRelativePath(value.destination.stateDir)
    || !isRelativePath(value.destination.proofDir) || !isSha(value.destination.configSha256)) throw new Error('manifest destination is invalid');
  exact(value.retained, ['worktreePaths', 'localRefs', 'remoteRefs'], 'retained');
  for (const key of ['worktreePaths', 'localRefs', 'remoteRefs'] as const) boundedStrings(value.retained[key], `retained.${key}`);
  exact(value.backup, ['root', 'configPath', 'statePath'], 'backup');
  if (!isRelativePath(value.backup.root) || !isRelativePath(value.backup.configPath) || !isRelativePath(value.backup.statePath)) throw new Error('manifest backup is invalid');
  return value as unknown as CutoverManifestV1;
}

export function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exact(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${field} keys are invalid`);
}

function boundedStrings(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 1024 || value.some((item) => !isName(item, 16 * 1024))) throw new Error(`${field} is invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isName(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'); }
function isSha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function isRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 && !value.startsWith('/')
    && !value.includes('\\') && posix.normalize(value) === value
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
