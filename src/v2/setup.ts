import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson } from './containment.js';
import { parseAgentAutoConfig, type AgentAutoConfig } from './config.js';
import { SetupStore } from './setup-store.js';

export type SetupOperation = 'configure' | 'prepare-labels' | 'doctor' | 'status';

export interface SetupIntent {
  targetRoot: string;
  operation: SetupOperation;
  dryRun: boolean;
  repository?: { owner: string; repo: string };
}

export type SetupAction =
  | { kind: 'write-ignore'; path: '.gitignore' }
  | { kind: 'write-config'; path: '.codex-orchestrator/config.json' }
  | { kind: 'create-label'; name: string };

export interface SetupDiagnostic {
  code: string;
  status: 'pass' | 'warning' | 'block';
  summary: string;
}

export interface SetupFailure {
  code: string;
  summary: string;
}

export type SetupOutcome =
  | { status: 'created' | 'unchanged' | 'labels-prepared' }
  | { status: 'planned'; actions: SetupAction[] }
  | { status: 'inspected'; disposition: 'ok' | 'blocked'; diagnostics: SetupDiagnostic[] }
  | { status: 'labels-partial'; created: string[]; missing: string[]; cause: SetupFailure }
  | { status: 'blocked-active' | 'repository-mismatch' | 'unsupported-schema'; reason: string }
  | { status: 'transport-failed' | 'io-failed'; detail: SetupFailure };

export interface SetupDependencies {
  repository: {
    inspect(targetRoot: string): Promise<{
      repository?: { owner: string; repo: string };
      baseBranch?: string;
    }>;
  };
  labels: {
    listPage(input: { owner: string; repo: string; cursor?: string }): Promise<{
      labels: Array<{ name: string }>;
      nextCursor?: string;
    }>;
    create(input: { owner: string; repo: string; label: AgentAutoConfig['github']['labels'][keyof AgentAutoConfig['github']['labels']] }): Promise<
      'created' | 'already-exists' | { status: 'failed'; failure: SetupFailure }
    >;
  };
  ownership: {
    acquire(repository: { owner: string; repo: string }): Promise<{ release(): Promise<void> }>;
    inspectOwner(repository: { owner: string; repo: string }): Promise<{ status: 'absent' | 'inactive' | 'active' | 'ambiguous'; reason?: string }>;
  };
  now?: () => string;
}

const CONFIG_PATH = '.codex-orchestrator/config.json';
const IGNORE_PATH = '.gitignore';
const IGNORE_START = '# codex-orchestrator v2 runtime start';
const IGNORE_END = '# codex-orchestrator v2 runtime end';

export class Setup {
  constructor(private readonly dependencies: SetupDependencies, private readonly store = new SetupStore()) {}

  async execute(intent: SetupIntent): Promise<SetupOutcome> {
    if (!isIntent(intent)) return { status: 'unsupported-schema', reason: 'Setup intent is invalid.' };
    let targetRoot = resolve(intent.targetRoot);
    try {
      const info = await lstat(targetRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) return { status: 'io-failed', detail: failure('target-root', 'Target root is not a direct directory.') };
      targetRoot = await realpath(targetRoot);
    } catch {
      return { status: 'io-failed', detail: failure('target-root', 'Target root is unavailable.') };
    }
    const observed = await this.dependencies.repository.inspect(targetRoot).catch(() => undefined);
    if (!observed?.repository || !observed.baseBranch) {
      return { status: 'repository-mismatch', reason: 'Canonical repository and base branch could not be determined.' };
    }
    if (intent.repository && !sameRepository(intent.repository, observed.repository)) {
      return { status: 'repository-mismatch', reason: 'Requested repository does not match target origin.' };
    }
    try {
      if (intent.operation === 'configure') {
        return await this.configure(targetRoot, intent, observed.repository, observed.baseBranch);
      }
      if (intent.operation === 'prepare-labels') {
        return await this.prepareLabels(targetRoot, intent, observed.repository, observed.baseBranch);
      }
      if (intent.operation === 'doctor' || intent.operation === 'status') {
        return await this.inspect(targetRoot, observed.repository);
      }
      return { status: 'unsupported-schema', reason: 'Setup operation is unsupported.' };
    } catch {
      return { status: 'io-failed', detail: failure('setup-operation', 'Setup operation could not complete safely.') };
    }
  }

  private async configure(
    targetRoot: string,
    intent: SetupIntent,
    repository: { owner: string; repo: string },
    baseBranch: string,
  ): Promise<SetupOutcome> {
    const existing = await this.store.readOptional(resolve(targetRoot, CONFIG_PATH));
    if (existing) {
      let config: AgentAutoConfig;
      try {
        config = parseAgentAutoConfig(JSON.parse(existing.toString('utf8')));
      } catch {
        return unsupportedConfig();
      }
      if (!sameRepository(config.github, repository) || (intent.repository && !sameRepository(config.github, intent.repository))) {
        return { status: 'repository-mismatch', reason: 'Persisted repository does not match target origin.' };
      }
      return { status: 'unchanged' };
    }
    const config = await defaultConfig(targetRoot, repository, baseBranch, this.store);
    const currentIgnore = await this.store.readOptional(resolve(targetRoot, IGNORE_PATH));
    const nextIgnore = renderIgnore(currentIgnore?.toString('utf8') ?? '', config);
    const actions: SetupAction[] = [];
    if (nextIgnore.changed) actions.push({ kind: 'write-ignore', path: IGNORE_PATH });
    actions.push({ kind: 'write-config', path: CONFIG_PATH });
    if (intent.dryRun) return { status: 'planned', actions };
    const lock = await this.dependencies.ownership.acquire(repository);
    try {
      const recheck = await this.store.readOptional(resolve(targetRoot, CONFIG_PATH));
      if (recheck) {
        try {
          const parsed = parseAgentAutoConfig(JSON.parse(recheck.toString('utf8')));
          return sameRepository(parsed.github, repository)
            ? { status: 'unchanged' }
            : { status: 'repository-mismatch', reason: 'Persisted repository changed while waiting for setup ownership.' };
        } catch {
          return unsupportedConfig();
        }
      }
      if (nextIgnore.changed) await this.store.writeAtomic(resolve(targetRoot, IGNORE_PATH), nextIgnore.bytes, 0o644);
      await this.store.writeAtomic(resolve(targetRoot, CONFIG_PATH), `${canonicalJson(config)}\n`, 0o644);
      return { status: 'created' };
    } catch {
      return { status: 'io-failed', detail: failure('configure-write', 'Setup could not durably commit target configuration.') };
    } finally {
      await lock.release();
    }
  }

  private async prepareLabels(
    targetRoot: string,
    intent: SetupIntent,
    repository: { owner: string; repo: string },
    baseBranch: string,
  ): Promise<SetupOutcome> {
    const existing = await this.store.readOptional(resolve(targetRoot, CONFIG_PATH));
    let config: AgentAutoConfig;
    const localActions: SetupAction[] = [];
    let nextIgnore: { changed: boolean; bytes: string } | undefined;
    if (existing) {
      try { config = parseAgentAutoConfig(JSON.parse(existing.toString('utf8'))); }
      catch { return unsupportedConfig(); }
      if (!sameRepository(config.github, repository)) {
        return { status: 'repository-mismatch', reason: 'Persisted repository does not match target origin.' };
      }
    } else {
      try { config = await defaultConfig(targetRoot, repository, baseBranch, this.store); }
      catch { return { status: 'io-failed', detail: failure('config-plan', 'Setup could not derive deterministic configuration.') }; }
      nextIgnore = renderIgnore((await this.store.readOptional(resolve(targetRoot, IGNORE_PATH)))?.toString('utf8') ?? '', config);
      if (nextIgnore.changed) localActions.push({ kind: 'write-ignore', path: IGNORE_PATH });
      localActions.push({ kind: 'write-config', path: CONFIG_PATH });
    }
    let observedLabels: string[];
    try { observedLabels = await this.listAllLabels(repository); }
    catch { return { status: 'transport-failed', detail: failure('label-list', 'GitHub labels could not be inspected.') }; }
    const existingNames = new Set(observedLabels.map((name) => name.toLowerCase()));
    const policyLabels = Object.values(config.github.labels);
    const missing = policyLabels.filter((label) => !existingNames.has(label.name.toLowerCase()));
    const actions = [...localActions, ...missing.map((label) => ({ kind: 'create-label' as const, name: label.name }))];
    if (intent.dryRun) return { status: 'planned', actions };
    const lock = await this.dependencies.ownership.acquire(repository);
    const created: string[] = [];
    try {
      if (!existing) {
        const recheck = await this.store.readOptional(resolve(targetRoot, CONFIG_PATH));
        if (recheck) {
          try {
            const parsed = parseAgentAutoConfig(JSON.parse(recheck.toString('utf8')));
            if (!sameRepository(parsed.github, repository)) {
              return { status: 'repository-mismatch', reason: 'Persisted repository changed while waiting for setup ownership.' };
            }
          } catch { return unsupportedConfig(); }
        } else {
          if (nextIgnore?.changed) await this.store.writeAtomic(resolve(targetRoot, IGNORE_PATH), nextIgnore.bytes, 0o644);
          await this.store.writeAtomic(resolve(targetRoot, CONFIG_PATH), `${canonicalJson(config)}\n`, 0o644);
        }
      }
      for (const [index, label] of missing.entries()) {
        let outcome: Awaited<ReturnType<SetupDependencies['labels']['create']>>;
        try { outcome = await this.dependencies.labels.create({ ...repository, label }); }
        catch {
          return {
            status: 'labels-partial', created, missing: missing.slice(index).map((item) => item.name),
            cause: failure('label-create-transport', 'GitHub label creation did not settle.'),
          };
        }
        if (outcome === 'created') { created.push(label.name); continue; }
        if (outcome === 'already-exists') {
          let reread: string[];
          try { reread = await this.listAllLabels(repository); }
          catch {
            return {
              status: 'labels-partial', created, missing: missing.slice(index).map((item) => item.name),
              cause: failure('label-reconcile', 'Concurrent label creation could not be reconciled.'),
            };
          }
          if (reread.some((name) => name.toLowerCase() === label.name.toLowerCase())) continue;
          return {
            status: 'labels-partial', created, missing: missing.slice(index).map((item) => item.name),
            cause: failure('label-reconcile', 'Concurrent label creation was not observable.'),
          };
        }
        return { status: 'labels-partial', created, missing: missing.slice(index).map((item) => item.name), cause: outcome.failure };
      }
      return { status: 'labels-prepared' };
    } catch {
      return { status: 'io-failed', detail: failure('prepare-labels', 'Label preparation could not durably configure the target.') };
    } finally {
      await lock.release();
    }
  }

  private async inspect(targetRoot: string, repository: { owner: string; repo: string }): Promise<SetupOutcome> {
    const bytes = await this.store.readOptional(resolve(targetRoot, CONFIG_PATH));
    if (!bytes) {
      return {
        status: 'inspected', disposition: 'blocked', diagnostics: [
          { code: 'config-missing', status: 'block', summary: 'V2 configuration is missing.' },
        ],
      };
    }
    let config: AgentAutoConfig;
    try { config = parseAgentAutoConfig(JSON.parse(bytes.toString('utf8'))); }
    catch {
      return {
        status: 'inspected', disposition: 'blocked', diagnostics: [{
          code: 'unsupported-schema', status: 'block', summary: 'Configuration schema is unsupported.',
        }],
      };
    }
    const diagnostics: SetupDiagnostic[] = [
      { code: 'config-v2', status: 'pass', summary: 'V2 configuration is valid.' },
    ];
    const repositoryMatch = sameRepository(config.github, repository);
    diagnostics.push(repositoryMatch
      ? { code: 'repository', status: 'pass', summary: 'Configured repository matches target origin.' }
      : { code: 'repository', status: 'block', summary: 'Configured repository does not match target origin.' });
    const owner = await this.dependencies.ownership.inspectOwner(repository).catch(() => ({ status: 'ambiguous' as const }));
    diagnostics.push(owner.status === 'active' || owner.status === 'ambiguous'
      ? { code: 'owner', status: 'block', summary: 'An active or ambiguous V2 owner blocks setup.' }
      : { code: 'owner', status: 'pass', summary: 'No active V2 owner blocks setup.' });
    try {
      const labels = new Set((await this.listAllLabels(repository)).map((name) => name.toLowerCase()));
      const missing = Object.values(config.github.labels).filter((label) => !labels.has(label.name.toLowerCase()));
      diagnostics.push(missing.length === 0
        ? { code: 'labels', status: 'pass', summary: 'All configured V2 labels exist.' }
        : { code: 'labels', status: 'block', summary: 'One or more configured V2 labels are missing.' });
    } catch {
      diagnostics.push({ code: 'labels', status: 'block', summary: 'Configured V2 labels could not be inspected.' });
    }
    return {
      status: 'inspected',
      disposition: diagnostics.some((diagnostic) => diagnostic.status === 'block') ? 'blocked' : 'ok',
      diagnostics,
    };
  }

  private async listAllLabels(repository: { owner: string; repo: string }): Promise<string[]> {
    const output: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.dependencies.labels.listPage({ ...repository, cursor });
      output.push(...result.labels.map((label) => label.name));
      if (!result.nextCursor) return output;
      if (cursors.has(result.nextCursor)) throw new Error('label pagination cursor repeated');
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error('label pagination exceeded bound');
  }

}

async function defaultConfig(
  targetRoot: string,
  repository: { owner: string; repo: string },
  baseBranch: string,
  store: SetupStore,
): Promise<AgentAutoConfig> {
  const packageJson = await store.readOptional(resolve(targetRoot, 'package.json'));
  let scripts: Record<string, unknown> = {};
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson.toString('utf8')) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) scripts = parsed.scripts as Record<string, unknown>;
    } catch {
      throw new Error('package.json is invalid');
    }
  }
  const checks: Record<string, string> = {};
  if (typeof scripts.test === 'string') checks.test = 'npm test';
  if (typeof scripts.typecheck === 'string') checks.typecheck = 'npm run typecheck';
  return parseAgentAutoConfig({
    schema: 'codex-orchestrator.agent-auto',
    version: 2,
    github: {
      owner: repository.owner,
      repo: repository.repo,
      baseBranch,
      labels: {
        auto: { name: 'agent:auto', color: '1d76db', description: 'Ready for the agent.' },
        running: { name: 'agent:running', color: 'fbca04', description: 'Agent is running.' },
        blocked: { name: 'agent:blocked', color: 'd93f0b', description: 'Agent needs help.' },
        review: { name: 'agent:review', color: '0e8a16', description: 'Ready for review.' },
        waitingHuman: { name: 'agent:waiting-human', color: '5319e7', description: 'Waiting for an authorized product answer.' },
      },
    },
    runner: {
      workspaceRoot: '.codex-orchestrator/workspaces-v2',
      stateDir: '.codex-orchestrator/v2/state',
      branchTemplate: 'codex/issue-${issueNumber}',
      pollIntervalSeconds: 60,
      maxCycles: 5,
    },
    codex: {
      command: 'codex', requiredVersion: '0.144.4', timeoutMs: 900_000, idleTimeoutMs: 300_000, toolNetwork: 'deny',
    },
    checks,
    proof: { artifactDir: '.codex-orchestrator/v2/proofs' },
    deny: {
      readPaths: ['.env', '.env.local', '.git/config'],
      commands: ['/usr/bin/gh', '/usr/bin/npm', '/usr/bin/ssh'],
    },
  });
}

function renderIgnore(current: string, config: AgentAutoConfig): { changed: boolean; bytes: string } {
  if (current.includes(IGNORE_START) || current.includes(IGNORE_END)) {
    const complete = current.includes(`${IGNORE_START}\n`) && current.includes(`${IGNORE_END}\n`);
    if (!complete) throw new Error('managed ignore block is malformed');
    return { changed: false, bytes: current };
  }
  const prefix = current.length === 0 ? '' : current.endsWith('\n') ? `${current}\n` : `${current}\n\n`;
  const entries = [config.runner.workspaceRoot, config.runner.stateDir, config.proof.artifactDir].map((path) => `${path}/`);
  return { changed: true, bytes: `${prefix}${IGNORE_START}\n${entries.join('\n')}\n${IGNORE_END}\n` };
}

function unsupportedConfig(): SetupOutcome {
  return { status: 'unsupported-schema', reason: 'Configuration schema is unsupported or unreadable.' };
}

function sameRepository(left: { owner: string; repo: string }, right: { owner: string; repo: string }): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();
}

function failure(code: string, summary: string): SetupFailure { return { code, summary }; }

function isIntent(value: SetupIntent): boolean {
  return typeof value?.targetRoot === 'string' && value.targetRoot.length > 0
    && ['configure', 'prepare-labels', 'doctor', 'status'].includes(value.operation)
    && typeof value.dryRun === 'boolean'
    && (value.repository === undefined || (typeof value.repository.owner === 'string' && value.repository.owner.length > 0
      && typeof value.repository.repo === 'string' && value.repository.repo.length > 0));
}
