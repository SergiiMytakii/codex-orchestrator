import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppServerProcessOwner,
  type AppServerProcessStartInput,
} from './app-server-process.js';
import {
  assertCodexVersion,
  preparePackageRuntimeHome,
  type PackageRuntimeHome,
} from './package-runtime-home.js';

interface AuthAppServerClient {
  request(method: string, params?: unknown): Promise<unknown>;
  waitForNotification(method: string, predicate?: (params: unknown) => boolean): Promise<unknown>;
}

interface AuthAppServerOwner {
  client: AuthAppServerClient;
  close(reason?: string): Promise<void>;
}

export interface AuthLoginCommandDependencies {
  prepareRuntimeHome?: (input: Parameters<typeof preparePackageRuntimeHome>[0]) => Promise<PackageRuntimeHome>;
  versionChecker?: typeof assertCodexVersion;
  ownerFactory?: (input: AppServerProcessStartInput) => Promise<AuthAppServerOwner>;
  supervisorPath?: string;
}

export interface AuthLoginCommandOptions {
  command?: string;
  requiredVersion?: '0.144.4';
  serverArgs?: string[];
  orchestratorHome?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  onAuthUrl?: (url: string) => void;
  dependencies?: AuthLoginCommandDependencies;
}

export interface AuthLoginCommandResult {
  status: 'already-authenticated' | 'authenticated';
}

export async function runAuthLoginCommand(options: AuthLoginCommandOptions = {}): Promise<AuthLoginCommandResult> {
  const dependencies = options.dependencies ?? {};
  const command = options.command ?? 'codex';
  const requiredVersion = options.requiredVersion ?? '0.144.4';
  const runId = `auth-login-${randomUUID()}`;
  const runtimeHome = await (dependencies.prepareRuntimeHome ?? preparePackageRuntimeHome)({
    runId,
    orchestratorHome: options.orchestratorHome,
    sourceEnv: options.sourceEnv,
    allowAccessToken: false,
  });
  if (runtimeHome.authMode !== 'persisted') throw new Error('orchestrator-auth-env-unsupported');
  await (dependencies.versionChecker ?? assertCodexVersion)(command, requiredVersion, runtimeHome.env);
  const owner = await (dependencies.ownerFactory ?? AppServerProcessOwner.start)({
    runId,
    runtimeHome,
    command,
    args: ['app-server', ...(options.serverArgs ?? [])],
    cwd: runtimeHome.root,
    supervisorPath: dependencies.supervisorPath
      ?? join(dirname(fileURLToPath(import.meta.url)), 'app-server-supervisor.js'),
    requireAccount: false,
  });

  try {
    const account = await owner.client.request('account/read', { refreshToken: false });
    if (isRecord(account) && account.account) return { status: 'already-authenticated' };

    const started = await owner.client.request('account/login/start', { type: 'chatgpt' });
    const login = parseLoginStart(started);
    options.onAuthUrl?.(login.authUrl);
    const completed = await owner.client.waitForNotification(
      'account/login/completed',
      (params) => isRecord(params) && params.loginId === login.loginId,
    );
    if (!isRecord(completed) || completed.success !== true) {
      const detail = isRecord(completed) && typeof completed.error === 'string' ? completed.error : 'unknown';
      throw new Error(`orchestrator-auth-login-failed:${detail}`);
    }
    return { status: 'authenticated' };
  } finally {
    await owner.close('auth-login-complete');
  }
}

function parseLoginStart(value: unknown): { loginId: string; authUrl: string } {
  if (!isRecord(value) || value.type !== 'chatgpt' || typeof value.loginId !== 'string' || typeof value.authUrl !== 'string') {
    throw new Error('orchestrator-auth-login-start-invalid');
  }
  return { loginId: value.loginId, authUrl: value.authUrl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
