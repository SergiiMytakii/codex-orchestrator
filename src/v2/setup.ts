import { lstat, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { canonicalJson } from './containment.js';
import { parseAgentAutoConfig, type AgentAutoConfigV1 } from './config.js';
import {
  detectLegacyConfig,
  parseCutoverManifest,
  sha256,
  type CutoverManifestV1,
  type LegacyCutoverRecord,
} from './legacy-cutover.js';
import { SetupStore } from './setup-store.js';

export type SetupOperation = 'configure' | 'prepare-labels' | 'fresh' | 'doctor' | 'status';

export interface SetupIntent {
  targetRoot: string;
  operation: SetupOperation;
  dryRun: boolean;
  repository?: { owner: string; repo: string };
}

export type SetupAction =
  | { kind: 'write-ignore'; path: '.gitignore' }
  | { kind: 'write-config'; path: '.codex-orchestrator/config.json' }
  | { kind: 'migrate-config-v1-to-v2'; path: '.codex-orchestrator/config.json' }
  | { kind: 'create-label'; name: string }
  | { kind: 'backup-legacy'; path: string }
  | { kind: 'commit-fresh'; path: '.codex-orchestrator/config.json' };

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
  | { status: 'created' | 'unchanged' | 'labels-prepared' | 'fresh-reset' | 'migrated' }
  | { status: 'planned'; actions: SetupAction[] }
  | { status: 'inspected'; disposition: 'ok' | 'blocked'; diagnostics: SetupDiagnostic[] }
  | { status: 'labels-partial'; created: string[]; missing: string[]; cause: SetupFailure }
  | { status: 'legacy-detected' | 'blocked-active' | 'repository-mismatch' | 'unsupported-schema'; reason: string }
  | { status: 'transport-failed' | 'io-failed'; detail: SetupFailure };

export interface SetupDependencies {
  repository: {
    inspect(targetRoot: string): Promise<{
      repository?: { owner: string; repo: string };
      baseBranch?: string;
    }>;
    inspectRetained(input: {
      targetRoot: string;
      legacy: { workspaceRoot: string; stateDir: string };
      v2: { workspaceRoot: string; stateDir: string; proofDir: string };
    }): Promise<{ worktreePaths: string[]; localRefs: string[]; remoteRefs: string[]; collisions: string[] }>;
  };
  labels: {
    listPage(input: { owner: string; repo: string; cursor?: string }): Promise<{
      labels: Array<{ name: string }>;
      nextCursor?: string;
    }>;
    create(input: { owner: string; repo: string; label: AgentAutoConfigV1['github']['labels'][keyof AgentAutoConfigV1['github']['labels']] }): Promise<
      'created' | 'already-exists' | { status: 'failed'; failure: SetupFailure }
    >;
    listOpenIssueNumbersWithLabel(input: { owner: string; repo: string; label: string }): Promise<number[]>;
  };
  ownership: {
    acquire(repository: { owner: string; repo: string }): Promise<{ release(): Promise<void> }>;
    inspectV2Owner(repository: { owner: string; repo: string }): Promise<{ status: 'absent' | 'inactive' | 'active' | 'ambiguous'; reason?: string }>;
    acquireLegacyFence(targetRoot: string): Promise<{ release(): Promise<void> }>;
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
      return await this.fresh(targetRoot, intent, observed.repository, observed.baseBranch);
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
      let config: AgentAutoConfigV1;
      try {
        config = parseAgentAutoConfig(JSON.parse(existing.toString('utf8')));
      } catch {
        const migration = parseConfigV1Migration(existing);
        if (migration.status === 'migratable') {
          if (!sameRepository(migration.config.github, repository)
            || (intent.repository && !sameRepository(migration.config.github, intent.repository))) {
            return { status: 'repository-mismatch', reason: 'Persisted repository does not match target origin.' };
          }
          if (intent.dryRun) {
            return { status: 'planned', actions: [{ kind: 'migrate-config-v1-to-v2', path: CONFIG_PATH }] };
          }
          const owner = await this.dependencies.ownership.inspectV2Owner(repository).catch(() => ({
            status: 'ambiguous' as const, reason: 'V2 owner state could not be inspected.',
          }));
          if (owner.status === 'active' || owner.status === 'ambiguous') {
            return { status: 'blocked-active', reason: owner.reason ?? 'An active or ambiguous V2 owner blocks Config V1 migration.' };
          }
          let running: number[];
          try {
            running = await this.dependencies.labels.listOpenIssueNumbersWithLabel({
              ...repository, label: migration.runningLabel,
            });
          } catch {
            return { status: 'transport-failed', detail: failure('migration-running-read', 'Migration could not prove remote running claims are absent.') };
          }
          if (running.length > 0) return { status: 'blocked-active', reason: 'Open Config V1 running claims block migration.' };
          const lock = await this.dependencies.ownership.acquire(repository);
          try {
            const recheck = await this.store.readOptional(resolve(targetRoot, CONFIG_PATH));
            if (!recheck || !recheck.equals(existing)) {
              return { status: 'blocked-active', reason: 'Configuration changed while waiting for setup ownership.' };
            }
            let lockedRunning: number[];
            try {
              lockedRunning = await this.dependencies.labels.listOpenIssueNumbersWithLabel({
                ...repository, label: migration.runningLabel,
              });
            } catch {
              return { status: 'transport-failed', detail: failure('migration-running-read', 'Migration could not prove remote running claims are absent under setup ownership.') };
            }
            if (lockedRunning.length > 0) return { status: 'blocked-active', reason: 'Open Config V1 running claims block migration.' };
            await this.store.writeAtomic(resolve(targetRoot, CONFIG_PATH), `${canonicalJson(migration.config)}\n`, 0o644);
            return { status: 'migrated' };
          } finally {
            await lock.release();
          }
        }
        if (migration.status === 'collision') {
          return { status: 'unsupported-schema', reason: 'Config V1 label names collide with agent:waiting-human.' };
        }
        return classifyNonV2Config(existing);
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
          return classifyNonV2Config(recheck);
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
    let config: AgentAutoConfigV1;
    const localActions: SetupAction[] = [];
    let nextIgnore: { changed: boolean; bytes: string } | undefined;
    if (existing) {
      try { config = parseAgentAutoConfig(JSON.parse(existing.toString('utf8'))); }
      catch { return classifyNonV2Config(existing); }
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
          } catch { return classifyNonV2Config(recheck); }
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
    let config: AgentAutoConfigV1;
    try { config = parseAgentAutoConfig(JSON.parse(bytes.toString('utf8'))); }
    catch {
      if (parseConfigV1Migration(bytes).status === 'migratable') {
        return { status: 'legacy-detected', reason: 'Config V1 requires setup migration.' };
      }
      const classified = classifyNonV2Config(bytes);
      const legacy = classified.status === 'legacy-detected';
      return {
        status: 'inspected', disposition: 'blocked', diagnostics: [{
          code: legacy ? 'legacy-detected' : 'unsupported-schema', status: 'block',
          summary: legacy ? 'Legacy configuration requires setup --fresh.' : 'Configuration schema is unsupported.',
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
    const owner = await this.dependencies.ownership.inspectV2Owner(repository).catch(() => ({ status: 'ambiguous' as const }));
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

  private async fresh(
    targetRoot: string,
    intent: SetupIntent,
    repository: { owner: string; repo: string },
    baseBranch: string,
  ): Promise<SetupOutcome> {
    const configPath = resolve(targetRoot, CONFIG_PATH);
    let sourceBytes: Buffer | undefined;
    try { sourceBytes = await this.store.readOptional(configPath); }
    catch { return { status: 'io-failed', detail: failure('fresh-config-read', 'Fresh could not read target configuration safely.') }; }
    if (!sourceBytes) return { status: 'unsupported-schema', reason: 'Fresh requires a recognized Legacy configuration.' };
    try {
      const v2 = parseAgentAutoConfig(JSON.parse(sourceBytes.toString('utf8')));
      if (!sameRepository(v2.github, repository)) return { status: 'repository-mismatch', reason: 'Persisted repository does not match target origin.' };
      return this.replayCommittedFresh(targetRoot, repository, sourceBytes);
    } catch {
      // Detect-only parsing below owns the Legacy boundary.
    }
    const detected = detectLegacyConfig(sourceBytes);
    if (detected.status !== 'recognized') return { status: 'unsupported-schema', reason: 'Fresh configuration schema is unsupported.' };
    const legacy = detected.record;
    if (!sameRepository(legacy.repository, repository) || (intent.repository && !sameRepository(legacy.repository, intent.repository))) {
      return { status: 'repository-mismatch', reason: 'Legacy repository does not match target origin.' };
    }
    if (intent.dryRun) {
      return { status: 'planned', actions: [
        { kind: 'backup-legacy', path: '.codex-orchestrator/v2/legacy-backups' },
        { kind: 'commit-fresh', path: CONFIG_PATH },
      ] };
    }
    let ownerLock: Awaited<ReturnType<SetupDependencies['ownership']['acquire']>> | undefined;
    let legacyFence: Awaited<ReturnType<SetupDependencies['ownership']['acquireLegacyFence']>> | undefined;
    try {
      const owner = await this.dependencies.ownership.inspectV2Owner(repository);
      if (owner.status === 'active' || owner.status === 'ambiguous') {
        return { status: 'blocked-active', reason: owner.reason ?? 'An active or ambiguous V2 owner blocks fresh.' };
      }
      ownerLock = await this.dependencies.ownership.acquire(repository);
      legacyFence = await this.dependencies.ownership.acquireLegacyFence(targetRoot);
      let running: number[];
      try { running = await this.dependencies.labels.listOpenIssueNumbersWithLabel({ ...repository, label: legacy.runningLabel }); }
      catch { return { status: 'transport-failed', detail: failure('fresh-running-read', 'Fresh could not prove remote running claims are absent.') }; }
      if (running.length > 0) return { status: 'blocked-active', reason: 'Open Legacy running claims block fresh.' };
      const config = await defaultConfig(targetRoot, repository, baseBranch, this.store);
      const roots = [config.runner.workspaceRoot, config.runner.stateDir, config.proof.artifactDir];
      for (const root of roots) {
        if (!await this.store.isAbsentOrEmptyDirectory(resolve(targetRoot, root))) {
          return { status: 'blocked-active', reason: `V2 destination root is not empty: ${root}` };
        }
      }
      let retained: Awaited<ReturnType<SetupDependencies['repository']['inspectRetained']>>;
      try {
        retained = await this.dependencies.repository.inspectRetained({
          targetRoot,
          legacy: { workspaceRoot: legacy.workspaceRoot, stateDir: legacy.stateDir },
          v2: { workspaceRoot: config.runner.workspaceRoot, stateDir: config.runner.stateDir, proofDir: config.proof.artifactDir },
        });
      } catch {
        return { status: 'io-failed', detail: failure('fresh-retained-read', 'Fresh could not inspect retained worktrees and refs.') };
      }
      if (retained.collisions.length > 0) return { status: 'blocked-active', reason: 'Retained worktree or ref collision blocks fresh.' };
      const configBytes = `${canonicalJson(config)}\n`;
      const manifest = await this.buildManifest(targetRoot, legacy, configBytes, retained);
      const manifestDirectory = resolve(targetRoot, '.codex-orchestrator/v2/fresh-cutover');
      const manifestPath = resolve(manifestDirectory, `${manifest.transactionId}.json`);
      const existingManifests = await this.readManifests(manifestDirectory);
      if (existingManifests.some((entry) => entry.transactionId !== manifest.transactionId)) {
        return { status: 'blocked-active', reason: 'Ambiguous fresh-cutover manifests block authority switch.' };
      }
      const existingManifest = existingManifests[0];
      if (existingManifest && canonicalJson(existingManifest) !== canonicalJson(manifest)) {
        return { status: 'blocked-active', reason: 'Fresh-cutover manifest does not match current Legacy evidence.' };
      }
      if (!existingManifest) await this.store.writeAtomic(manifestPath, `${canonicalJson(manifest)}\n`, 0o600);
      await this.copyConfigBackupIfNeeded(
        resolve(targetRoot, CONFIG_PATH), resolve(targetRoot, manifest.backup.configPath), manifest.source.configSha256,
      );
      await this.copyBackupIfNeeded(
        resolve(targetRoot, legacy.stateDir), resolve(targetRoot, manifest.backup.statePath), manifest.source.stateSha256,
      );
      const ignore = renderIgnore((await this.store.readOptional(resolve(targetRoot, IGNORE_PATH)))?.toString('utf8') ?? '', config);
      if (ignore.changed) await this.store.writeAtomic(resolve(targetRoot, IGNORE_PATH), ignore.bytes, 0o644);
      await this.store.writeAtomic(configPath, configBytes, 0o644);
      return { status: 'fresh-reset' };
    } catch {
      return { status: 'io-failed', detail: failure('fresh-write', 'Fresh could not durably complete the cutover.') };
    } finally {
      await legacyFence?.release().catch(() => undefined);
      await ownerLock?.release().catch(() => undefined);
    }
  }

  private async replayCommittedFresh(
    targetRoot: string,
    repository: { owner: string; repo: string },
    configBytes: Buffer,
  ): Promise<SetupOutcome> {
    let manifests: CutoverManifestV1[];
    try { manifests = await this.readManifests(resolve(targetRoot, '.codex-orchestrator/v2/fresh-cutover')); }
    catch { return { status: 'unsupported-schema', reason: 'Fresh-cutover manifest set is unreadable or ambiguous.' }; }
    const matches = manifests.filter((manifest) => sameRepository(manifest.repository, repository)
      && manifest.destination.configSha256 === sha256(configBytes));
    return matches.length === 1 && manifests.length === 1
      ? { status: 'fresh-reset' }
      : { status: 'unsupported-schema', reason: 'Valid V2 configuration is not linked to one exact fresh-cutover manifest.' };
  }

  private async readManifests(directory: string): Promise<CutoverManifestV1[]> {
    const output: CutoverManifestV1[] = [];
    for (const path of await this.store.listJsonFiles(directory)) {
      const bytes = await this.store.readOptional(path);
      if (!bytes) throw new Error('fresh manifest disappeared');
      output.push(parseCutoverManifest(JSON.parse(bytes.toString('utf8'))));
    }
    return output;
  }

  private async buildManifest(
    targetRoot: string,
    legacy: LegacyCutoverRecord,
    configBytes: string,
    retained: { worktreePaths: string[]; localRefs: string[]; remoteRefs: string[] },
  ): Promise<CutoverManifestV1> {
    const stateSha256 = await this.store.hashPath(resolve(targetRoot, legacy.stateDir));
    const destination = {
      workspaceRoot: '.codex-orchestrator/workspaces-v2', stateDir: '.codex-orchestrator/v2/state',
      proofDir: '.codex-orchestrator/v2/proofs', configSha256: sha256(configBytes),
    };
    const inventory = {
      worktreePaths: [...retained.worktreePaths].sort(), localRefs: [...retained.localRefs].sort(), remoteRefs: [...retained.remoteRefs].sort(),
    };
    const transactionId = sha256(canonicalJson({
      repository: legacy.repository, configSha256: legacy.configSha256, stateSha256, destination, retained: inventory,
    }));
    const backupRoot = `.codex-orchestrator/v2/legacy-backups/${transactionId}`;
    return {
      schema: 'codex-orchestrator.agent-auto-fresh-cutover', version: 1, transactionId,
      repository: legacy.repository,
      source: { configPath: CONFIG_PATH, configSha256: legacy.configSha256, statePath: legacy.stateDir, stateSha256 },
      destination,
      retained: inventory,
      backup: { root: backupRoot, configPath: `${backupRoot}/${basename(CONFIG_PATH)}`, statePath: `${backupRoot}/state` },
    };
  }

  private async copyBackupIfNeeded(source: string, destination: string, expectedHash: string): Promise<void> {
    const destinationHash = await this.store.hashPath(destination);
    if (destinationHash === expectedHash) return;
    const sourceHash = await this.store.hashPath(source);
    if (sourceHash !== expectedHash) throw new Error('fresh source hash changed');
    const absentHash = await this.store.hashPath(`${destination}.known-absent-sentinel`);
    if (destinationHash !== absentHash) throw new Error('fresh backup destination contains different evidence');
    await this.store.copyTree(source, destination);
  }

  private async copyConfigBackupIfNeeded(source: string, destination: string, expectedHash: string): Promise<void> {
    const destinationBytes = await this.store.readOptional(destination);
    if (destinationBytes) {
      if (sha256(destinationBytes) !== expectedHash) throw new Error('fresh config backup contains different evidence');
      return;
    }
    const sourceBytes = await this.store.readOptional(source);
    if (!sourceBytes || sha256(sourceBytes) !== expectedHash) throw new Error('fresh config source hash changed');
    await this.store.writeAtomic(destination, sourceBytes, 0o600);
  }
}

async function defaultConfig(
  targetRoot: string,
  repository: { owner: string; repo: string },
  baseBranch: string,
  store: SetupStore,
): Promise<AgentAutoConfigV1> {
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

function renderIgnore(current: string, config: AgentAutoConfigV1): { changed: boolean; bytes: string } {
  if (current.includes(IGNORE_START) || current.includes(IGNORE_END)) {
    const complete = current.includes(`${IGNORE_START}\n`) && current.includes(`${IGNORE_END}\n`);
    if (!complete) throw new Error('managed ignore block is malformed');
    return { changed: false, bytes: current };
  }
  const prefix = current.length === 0 ? '' : current.endsWith('\n') ? `${current}\n` : `${current}\n\n`;
  const entries = [config.runner.workspaceRoot, config.runner.stateDir, config.proof.artifactDir].map((path) => `${path}/`);
  return { changed: true, bytes: `${prefix}${IGNORE_START}\n${entries.join('\n')}\n${IGNORE_END}\n` };
}

function classifyNonV2Config(bytes: Buffer): SetupOutcome {
  const detected = detectLegacyConfig(bytes);
  return detected.status === 'recognized'
    ? { status: 'legacy-detected', reason: detected.record.kind === 'experimental-skill-runtime-v2'
      ? 'Experimental runtime configuration requires setup --fresh.'
      : 'Legacy configuration requires setup --fresh.' }
    : { status: 'unsupported-schema', reason: 'Configuration schema is unsupported or unreadable.' };
}

type ConfigV1Migration =
  | { status: 'migratable'; config: AgentAutoConfigV1; runningLabel: string }
  | { status: 'collision' | 'not-v1' };

function parseConfigV1Migration(bytes: Buffer): ConfigV1Migration {
  let input: unknown;
  try { input = JSON.parse(bytes.toString('utf8')); }
  catch { return { status: 'not-v1' }; }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { status: 'not-v1' };
  const record = input as Record<string, unknown>;
  if (record.schema !== 'codex-orchestrator.agent-auto' || record.version !== 1) return { status: 'not-v1' };
  const github = record.github;
  if (typeof github !== 'object' || github === null || Array.isArray(github)) return { status: 'not-v1' };
  const labels = (github as Record<string, unknown>).labels;
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) return { status: 'not-v1' };
  const labelRecord = labels as Record<string, unknown>;
  if (Object.keys(labelRecord).sort().join(',') !== 'auto,blocked,review,running') return { status: 'not-v1' };
  const names = Object.values(labelRecord).map((label) => {
    if (typeof label !== 'object' || label === null || Array.isArray(label)) return undefined;
    return (label as Record<string, unknown>).name;
  });
  if (names.includes('agent:waiting-human')) return { status: 'collision' };
  try {
    const candidate = structuredClone(record);
    candidate.version = 2;
    const candidateGithub = candidate.github as Record<string, unknown>;
    candidateGithub.labels = {
      ...(candidateGithub.labels as Record<string, unknown>),
      waitingHuman: {
        name: 'agent:waiting-human', color: '5319e7', description: 'Waiting for an authorized product answer.',
      },
    };
    const config = parseAgentAutoConfig(candidate);
    return { status: 'migratable', config, runningLabel: config.github.labels.running.name };
  } catch {
    return { status: 'not-v1' };
  }
}

function sameRepository(left: { owner: string; repo: string }, right: { owner: string; repo: string }): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();
}

function failure(code: string, summary: string): SetupFailure { return { code, summary }; }

function isIntent(value: SetupIntent): boolean {
  return typeof value?.targetRoot === 'string' && value.targetRoot.length > 0
    && ['configure', 'prepare-labels', 'fresh', 'doctor', 'status'].includes(value.operation)
    && typeof value.dryRun === 'boolean'
    && (value.repository === undefined || (typeof value.repository.owner === 'string' && value.repository.owner.length > 0
      && typeof value.repository.repo === 'string' && value.repository.repo.length > 0));
}
