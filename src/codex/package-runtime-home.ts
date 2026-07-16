import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const allowedParentEnv = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE'] as const;
export const forbiddenAppServerEnvKeys = new Set([
  'HOME', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY',
  'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'CODEX_ORCHESTRATOR_ALLOW_MOBILE_DEVICE_CONTROL',
  'CODEX_ORCHESTRATOR_MOBILE_DEVICE_GUARD', 'CODEX_ORCHESTRATOR_PROMPT_FILE', 'CODEX_ORCHESTRATOR_REPORT_FILE',
]);

export interface PackageRuntimeHome {
  root: string;
  sqliteHome: string;
  env: Record<string, string>;
  authMode: 'persisted' | 'access-token';
}

export async function preparePackageRuntimeHome(input: {
  runId: string;
  orchestratorHome?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  phaseEnv?: Record<string, string>;
  allowAccessToken?: boolean;
}): Promise<PackageRuntimeHome> {
  if (!/^[A-Za-z0-9._-]+$/u.test(input.runId)) throw new Error('orchestrator-runtime-home-invalid-run-id');
  const source = input.sourceEnv ?? process.env;
  const base = resolve(input.orchestratorHome ?? source.CODEX_ORCHESTRATOR_HOME ?? join(homedir(), '.codex-orchestrator'));
  const root = join(base, 'codex-home', 'v1');
  await ensurePrivateNoFollow(base, root);
  const sqliteHome = join(root, 'sqlite', input.runId);
  await ensurePrivateNoFollow(root, sqliteHome);
  const env: Record<string, string> = {};
  for (const key of allowedParentEnv) if (source[key]) env[key] = source[key]!;
  for (const [key, value] of Object.entries(input.phaseEnv ?? {})) {
    if (forbiddenAppServerEnvKeys.has(key)) throw new Error(`orchestrator-profile-env-forbidden:${key}`);
    env[key] = value;
  }
  let authMode: PackageRuntimeHome['authMode'] = 'persisted';
  if (source.CODEX_ACCESS_TOKEN) {
    if (!input.allowAccessToken) throw new Error('orchestrator-auth-env-unsupported');
    env.CODEX_ACCESS_TOKEN = source.CODEX_ACCESS_TOKEN;
    authMode = 'access-token';
  }
  if (source.CODEX_API_KEY || source.OPENAI_API_KEY) throw new Error('orchestrator-auth-env-unsupported');
  env.HOME = root; env.CODEX_HOME = root; env.CODEX_SQLITE_HOME = sqliteHome;
  return { root, sqliteHome, env, authMode };
}

export async function assertCodexVersion(command: string, requiredVersion: string, env: Record<string, string>): Promise<void> {
  const { stdout } = await execFileAsync(command, ['--version'], { env });
  const match = /codex-cli\s+([^\s]+)/u.exec(stdout);
  if (!match || match[1] !== requiredVersion) throw new Error(`orchestrator-codex-version-mismatch: required ${requiredVersion}, received ${match?.[1] ?? 'unknown'}`);
}

async function ensurePrivateNoFollow(base: string, target: string): Promise<void> {
  await mkdir(base, { recursive: true, mode: 0o700 });
  let current = base;
  const relative = target.slice(base.length).split(sep).filter(Boolean);
  for (const segment of ['', ...relative]) {
    if (segment) current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`orchestrator-runtime-home-unsafe:${current}`);
      if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
        throw new Error(`orchestrator-runtime-home-owner-mismatch:${current}`);
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await mkdir(current, { mode: 0o700 });
    }
    await chmod(current, 0o700);
  }
}
