import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import type { ProcessCommandResult, ProcessExecutor } from './adapters/command.js';
import { defaultProcessExecutor } from './adapters/command.js';
import { writeDurableAtomicFile } from './adapters/durable-atomic-file.js';
import type { CheckedChangePayloadV1 } from './checked-change.js';
import type { AndroidProofConfig } from './config.js';
import { canonicalJson, sha256 } from './containment.js';
import { parseAndroidLease, type AndroidLeaseRecordV1, type AndroidLeaseTargetController } from './mobile-lease.js';

type BinaryExecutor = (file: string, args: string[], options?: {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}) => Promise<Buffer>;
type EmulatorStarter = (file: string, args: string[], options?: { cwd?: string }) => Promise<{ pid: number }>;
type ProcessIdentityInspection = { status: 'present'; identity: string } | { status: 'absent' } | { status: 'error' };
type AndroidPreparationIntent = {
  schema: 'codex-orchestrator.android-preparation';
  version: 1;
  proofId: string;
  token: string;
  ownerPid: number;
  ownerProcessIdentity: string;
  serial: string;
  dataDir: string;
  emulatorPid: number | null;
  emulatorProcessIdentity: string | null;
};

const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const CAPTURE_TIMEOUT_MS = 2 * 60 * 1000;
const EMULATOR_STOP_ATTEMPTS = 50;
const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const TEXT_CAPTURE_MAX_BYTES = 1024 * 1024;
const CAPTURE_STDERR_MAX_BYTES = 64 * 1024;
const processPreparationTokens = new Set<string>();

export type RunnerAndroidProofResult = {
  status: 'prepared';
  serial: string;
  appPid: number;
  runnerPreparedArtifactPaths: string[];
  runnerPreparedArtifactSha256: Record<string, string>;
} | {
  status: 'blocked';
  summary: string;
  runnerPreparedArtifactPaths: string[];
  runnerPreparedArtifactSha256: Record<string, string>;
};

export class RunnerAndroidProofController implements AndroidLeaseTargetController {
  private readonly adbPath: string;
  private readonly emulatorPath: string;
  private readonly execute: ProcessExecutor;
  private readonly executeBinary: BinaryExecutor;
  private readonly startEmulator: EmulatorStarter;
  private readonly createDataDir: () => Promise<string>;
  private readonly removeDataDir: (path: string) => Promise<void>;
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => Date;
  private readonly createToken: () => string;
  private readonly ownerPid: number;
  private readonly readProcessIdentity: (pid: number) => Promise<string | undefined>;
  private readonly inspectProcessIdentity: (pid: number) => Promise<ProcessIdentityInspection>;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly activePreparationTokens = processPreparationTokens;

  constructor(input: {
    adbPath: string;
    emulatorPath: string;
    execute?: ProcessExecutor;
    executeBinary?: BinaryExecutor;
    startEmulator?: EmulatorStarter;
    createDataDir?: () => Promise<string>;
    removeDataDir?: (path: string) => Promise<void>;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    now?: () => Date;
    createToken?: () => string;
    ownerPid?: number;
    readProcessIdentity?: (pid: number) => Promise<string | undefined>;
    inspectProcessIdentity?: (pid: number) => Promise<ProcessIdentityInspection>;
    signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  }) {
    this.adbPath = resolve(input.adbPath);
    this.emulatorPath = resolve(input.emulatorPath);
    this.execute = input.execute ?? defaultProcessExecutor;
    this.executeBinary = input.executeBinary ?? executeBinary;
    this.startEmulator = input.startEmulator ?? startEmulator;
    this.createDataDir = input.createDataDir ?? createEphemeralDataDir;
    this.removeDataDir = input.removeDataDir ?? removeEphemeralDataDir;
    this.wait = input.wait ?? wait;
    this.now = input.now ?? (() => new Date());
    this.createToken = input.createToken ?? randomUUID;
    this.ownerPid = input.ownerPid ?? process.pid;
    this.readProcessIdentity = input.readProcessIdentity ?? readProcessStartIdentity;
    this.inspectProcessIdentity = input.inspectProcessIdentity
      ?? (input.readProcessIdentity
        ? async (pid) => {
            const identity = await input.readProcessIdentity!(pid);
            return identity ? { status: 'present', identity } : { status: 'absent' };
          }
        : inspectProcessStartIdentity);
    this.signalProcess = input.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  }

  async prepare(input: {
    proofId: string;
    worktreePath: string;
    artifactDir: string;
    leaseRoot: string;
    config: AndroidProofConfig;
    checks: CheckedChangePayloadV1['checks'];
    checkedChangeSha256: string;
    proofAgentBudgetMs: number;
    signal: AbortSignal;
  }): Promise<RunnerAndroidProofResult> {
    if (!/^[0-9a-f]{64}$/u.test(input.checkedChangeSha256)) throw new Error('Checked change digest is invalid.');
    const worktreePath = resolve(input.worktreePath);
    const proofRelativeRoot = `${input.artifactDir}/${input.proofId}`;
    const proofRoot = resolve(worktreePath, proofRelativeRoot);
    if (!proofRoot.startsWith(`${worktreePath}/`)) throw new Error('Android proof artifact root escapes worktree');
    try {
      await ensureManagedProofRoot(worktreePath, proofRoot);
    } catch (error) {
      return { status: 'blocked', summary: boundedError(error), runnerPreparedArtifactPaths: [], runnerPreparedArtifactSha256: {} };
    }
    const receiptRelativePath = `${proofRelativeRoot}/android-runner-receipt.json`;
    const receiptPath = join(worktreePath, receiptRelativePath);
    const leaseRelativePath = `${proofRelativeRoot}/android-lease.json`;
    const leaseArtifactPath = join(worktreePath, leaseRelativePath);
    const screenshotRelativePath = `${proofRelativeRoot}/android-final.png`;
    const hierarchyRelativePath = `${proofRelativeRoot}/android-ui.xml`;
    const logRelativePath = `${proofRelativeRoot}/android-device-log.txt`;
    const externalLeasePath = join(resolve(input.leaseRoot), 'android.json');
    const preparationPath = join(resolve(input.leaseRoot), 'android.preparation.json');
    const preparedStatePath = join(resolve(input.leaseRoot), `android.prepared.${sha256(input.proofId)}.json`);
    const existingLease = await inspectExistingLease(externalLeasePath);
    if (existingLease !== 'absent') {
      if (existingLease !== 'invalid' && existingLease.proofId === input.proofId && existingLease.appPid) {
        const runnerPreparedArtifactPaths = [
          screenshotRelativePath, hierarchyRelativePath, logRelativePath, leaseRelativePath, receiptRelativePath,
        ];
        try {
          const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
          if (receipt.status !== 'prepared' || receipt.proofId !== input.proofId
            || receipt.checkedChangeSha256 !== input.checkedChangeSha256) {
            throw new Error('Persisted Android proof receipt does not match the checked change.');
          }
          const runnerPreparedArtifactSha256 = Object.fromEntries(await Promise.all(runnerPreparedArtifactPaths.map(async (path) => [
            path, sha256(await readFile(join(worktreePath, path))),
          ])));
          const trusted = JSON.parse(await readFile(preparedStatePath, 'utf8')) as Record<string, unknown>;
          if (trusted.schema !== 'codex-orchestrator.android-prepared' || trusted.version !== 1
            || trusted.proofId !== input.proofId || trusted.leaseToken !== existingLease.token
            || trusted.checkedChangeSha256 !== input.checkedChangeSha256
            || canonicalJson(trusted.artifactSha256) !== canonicalJson(runnerPreparedArtifactSha256)) {
            throw new Error('Persisted Android proof artifacts changed after capture.');
          }
          return {
            status: 'prepared', serial: existingLease.serial, appPid: existingLease.appPid,
            runnerPreparedArtifactPaths, runnerPreparedArtifactSha256,
          };
        } catch {
          // Fall through to a warning; incomplete persisted proof must not be claimed as successful.
        }
      }
      const summary = existingLease === 'invalid'
        ? 'Existing durable Android lease is invalid and requires operator recovery.'
        : existingLease.proofId === input.proofId
          ? 'Existing durable Android lease requires terminal recovery before preparation.'
          : 'Existing durable Android lease belongs to another proof.';
      await ensureManagedProofRoot(worktreePath, proofRoot);
      await writeDurableAtomicFile(receiptPath, `${canonicalJson({
        schema: 'codex-orchestrator.runner-android-proof', version: 1, status: 'blocked', proofId: input.proofId,
        configuredCheckIds: input.checks.map((check) => check.id), summary, artifactRefs: [],
        recordedAt: this.now().toISOString(),
      })}\n`, 0o600);
      return {
        status: 'blocked', summary, runnerPreparedArtifactPaths: [receiptRelativePath],
        runnerPreparedArtifactSha256: { [receiptRelativePath]: sha256(await readFile(receiptPath)) },
      };
    }
    let serial: string | undefined;
    let dataDir: string | undefined;
    let emulatorStarted = false;
    let emulatorPid: number | undefined;
    let emulatorProcessIdentity: string | undefined;
    let appPid: number | undefined;
    let activeLease: AndroidLeaseRecordV1 | undefined;
    let installSnapshotPath: string | undefined;
    let preparation: AndroidPreparationIntent | undefined;
    try {
      await access(this.adbPath, constants.X_OK);
      await access(this.emulatorPath, constants.X_OK);
      const avds = lines(await this.requireSuccess(this.emulatorPath, ['-list-avds'], undefined, COMMAND_TIMEOUT_MS, input.signal));
      if (!avds.includes(input.config.avdName)) throw new Error('Configured Android virtual device is unavailable.');
      const observed = parseDevices((await this.requireSuccess(this.adbPath, ['devices', '-l'], undefined, COMMAND_TIMEOUT_MS, input.signal)).stdout);
      serial = chooseSerial(observed.map((device) => device.serial));
      const port = Number(serial.slice('emulator-'.length));
      dataDir = resolve(await this.createDataDir());
      const ownerProcessIdentity = await readProcessStartIdentity(this.ownerPid);
      if (!ownerProcessIdentity) throw new Error('Android proof Runner process identity is unavailable.');
      preparation = {
        schema: 'codex-orchestrator.android-preparation', version: 1, proofId: input.proofId,
        token: this.createToken(), ownerPid: this.ownerPid, ownerProcessIdentity, serial, dataDir,
        emulatorPid: null, emulatorProcessIdentity: null,
      };
      await this.acquirePreparation(preparationPath, preparation);
      const emulator = await this.startEmulator(this.emulatorPath, [
        '-avd', input.config.avdName, '-port', String(port), '-datadir', dataDir, '-wipe-data',
        '-no-snapshot-load', '-no-snapshot-save',
        '-no-boot-anim', '-no-audio', '-no-window',
      ], { cwd: worktreePath });
      emulatorStarted = true;
      emulatorPid = emulator.pid;
      emulatorProcessIdentity = await this.readProcessIdentity(emulator.pid);
      if (!emulatorProcessIdentity) throw new Error('Runner-created Android emulator process identity is unavailable.');
      preparation = { ...preparation, emulatorPid: emulator.pid, emulatorProcessIdentity };
      await replaceOwnedPreparation(preparationPath, preparation);
      await this.waitForBoot(serial, emulator.pid, emulatorProcessIdentity, input.config.bootTimeoutMs, input.signal);

      const acquiredAt = this.now();
      activeLease = {
        schema: 'codex-orchestrator.android-lease', version: 1, status: 'active', proofId: input.proofId,
        token: preparation.token, serial, appId: input.config.applicationId, ownerPid: this.ownerPid, appPid: null,
        runnerCreated: true, emulatorPid: emulator.pid, emulatorProcessIdentity, dataDir,
        acquiredAt: acquiredAt.toISOString(), expiresAt: new Date(acquiredAt.getTime() + proofLeaseDurationMs(input.config, input.proofAgentBudgetMs)).toISOString(),
        updatedAt: acquiredAt.toISOString(),
      };
      await ensureManagedProofRoot(worktreePath, proofRoot);
      await writeDurableAtomicFile(leaseArtifactPath, `${canonicalJson(activeLease)}\n`, 0o600);
      await mkdir(resolve(input.leaseRoot), { recursive: true, mode: 0o700 });
      await createExclusiveLease(externalLeasePath, activeLease);
      await removeOwnedPreparation(preparationPath, preparation.token);
      this.activePreparationTokens.delete(preparation.token);
      preparation = undefined;

      const apkPath = resolve(worktreePath, input.config.apkPath);
      if (!apkPath.startsWith(`${worktreePath}/`)) throw new Error('Configured Android APK escapes worktree.');
      await removeExistingApkSafely(worktreePath, apkPath);
      const build = await this.requireSuccess(
        input.config.flutterCommand,
        input.config.buildArgs,
        worktreePath,
        BUILD_TIMEOUT_MS,
        input.signal,
        true,
      );
      await assertNoSymlinkAncestors(worktreePath, dirname(apkPath));
      installSnapshotPath = join(resolve(input.leaseRoot), `android-install-${activeLease.token}.apk`);
      const apkSha256 = await snapshotFreshRegularFile(apkPath, installSnapshotPath);
      await this.assertOwnedEmulator(emulator.pid, emulatorProcessIdentity);
      await this.requireSuccess(this.adbPath, ['-s', serial, 'install', '-r', installSnapshotPath], undefined, COMMAND_TIMEOUT_MS, input.signal);
      await rm(installSnapshotPath, { force: true });
      installSnapshotPath = undefined;
      await this.assertOwnedEmulator(emulator.pid, emulatorProcessIdentity);
      if (input.config.launchUri) {
        await this.requireSuccess(this.adbPath, [
          '-s', serial, 'shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
          '-d', input.config.launchUri, '-p', input.config.applicationId,
        ], undefined, COMMAND_TIMEOUT_MS, input.signal);
      } else {
        await this.requireSuccess(this.adbPath, [
          '-s', serial, 'shell', 'monkey', '-p', input.config.applicationId,
          '-c', 'android.intent.category.LAUNCHER', '1',
        ], undefined, COMMAND_TIMEOUT_MS, input.signal);
      }
      await this.wait(input.config.settleMs, input.signal);
      appPid = await this.resolveAppPid(serial, input.config.applicationId, input.signal);
      activeLease = { ...activeLease, appPid, updatedAt: this.now().toISOString() };
      await ensureManagedProofRoot(worktreePath, proofRoot);
      await writeDurableAtomicFile(leaseArtifactPath, `${canonicalJson(activeLease)}\n`, 0o600);
      await replaceOwnedLease(externalLeasePath, activeLease);

      for (const text of input.config.tapText ?? []) {
        await this.assertOwnedEmulator(emulator.pid, emulatorProcessIdentity);
        const point = await this.waitForNavigationTarget({
          serial, proofId: input.proofId, text, timeoutMs: input.config.navigationTimeoutMs, signal: input.signal,
        });
        await this.requireSuccess(this.adbPath, ['-s', serial, 'shell', 'input', 'tap', String(point.x), String(point.y)], undefined, COMMAND_TIMEOUT_MS, input.signal);
        await this.wait(input.config.settleMs, input.signal);
        if (await this.resolveAppPid(serial, input.config.applicationId, input.signal) !== appPid) {
          throw new Error('Android proof application PID changed during navigation.');
        }
      }
      await this.assertOwnedEmulator(emulator.pid, emulatorProcessIdentity);
      await this.captureEvidence({ serial, proofId: input.proofId, appPid, proofRoot, worktreePath, signal: input.signal });
      const receipt = {
        schema: 'codex-orchestrator.runner-android-proof', version: 1, status: 'prepared', proofId: input.proofId,
        configuredCheckIds: input.checks.map((check) => check.id), buildOutputSha256: sha256(build.stdout + build.stderr),
        checkedChangeSha256: input.checkedChangeSha256, apkSha256,
        artifactRefs: [screenshotRelativePath, hierarchyRelativePath, logRelativePath, leaseRelativePath],
        navigation: { launchUriConfigured: !!input.config.launchUri, tapText: input.config.tapText ?? [] },
        capturedAt: this.now().toISOString(),
      };
      await ensureManagedProofRoot(worktreePath, proofRoot);
      await writeDurableAtomicFile(receiptPath, `${canonicalJson(receipt)}\n`, 0o600);
      validatePreparedReceipt(await readFile(receiptPath), receipt);
      const runnerPreparedArtifactPaths = [
        screenshotRelativePath, hierarchyRelativePath, logRelativePath, leaseRelativePath, receiptRelativePath,
      ];
      const runnerPreparedArtifactSha256 = Object.fromEntries(await Promise.all(runnerPreparedArtifactPaths.map(async (path) => [
        path, sha256(await readFile(join(worktreePath, path))),
      ])));
      await writeDurableAtomicFile(preparedStatePath, `${canonicalJson({
        schema: 'codex-orchestrator.android-prepared', version: 1, proofId: input.proofId,
        leaseToken: activeLease.token, checkedChangeSha256: input.checkedChangeSha256,
        artifactSha256: runnerPreparedArtifactSha256,
      })}\n`, 0o600);
      return {
        status: 'prepared', serial, appPid,
        runnerPreparedArtifactPaths,
        runnerPreparedArtifactSha256,
      };
    } catch (error) {
      if (installSnapshotPath) await rm(installSnapshotPath, { force: true }).catch(() => {});
      const capturedArtifactRefs: string[] = [];
      if (serial && emulatorStarted && appPid) {
        try {
          await this.captureEvidence({ serial, proofId: input.proofId, appPid, proofRoot, worktreePath, signal: input.signal });
          capturedArtifactRefs.push(screenshotRelativePath, hierarchyRelativePath, logRelativePath);
        } catch {
          // Preserve the original blocker when best-effort diagnostic capture is unavailable.
        }
      }
      let released = false;
      if (activeLease) {
        try {
          await this.release(activeLease);
          await removeOwnedLease(externalLeasePath, activeLease.token);
          released = true;
        } catch {
          // Keep the durable active lease and data directory for safe replay recovery.
        }
      } else if (serial && emulatorStarted && emulatorPid && emulatorProcessIdentity) {
        try {
          await this.stopOwnedEmulator(emulatorPid, emulatorProcessIdentity);
          if (dataDir) await this.removeDataDir(dataDir);
          released = true;
        } catch {
          // The process could not be proven stopped; retain its data directory.
        }
      }
      if (activeLease && released) {
        try {
          await ensureManagedProofRoot(worktreePath, proofRoot);
          await writeDurableAtomicFile(leaseArtifactPath, `${canonicalJson({
            ...activeLease, status: 'released', updatedAt: this.now().toISOString(),
          })}\n`, 0o600);
          capturedArtifactRefs.push(leaseRelativePath);
        } catch {
          // Never write through an unsafe proof root during blocker handling.
        }
      }
      if (preparation && released) {
        await removeOwnedPreparation(preparationPath, preparation.token).catch(() => {});
        this.activePreparationTokens.delete(preparation.token);
      }
      const summary = boundedError(error);
      let receiptWritten = false;
      try {
        await ensureManagedProofRoot(worktreePath, proofRoot);
        await writeDurableAtomicFile(receiptPath, `${canonicalJson({
          schema: 'codex-orchestrator.runner-android-proof', version: 1, status: 'blocked', proofId: input.proofId,
          configuredCheckIds: input.checks.map((check) => check.id), summary,
          artifactRefs: capturedArtifactRefs,
          recordedAt: this.now().toISOString(),
        })}\n`, 0o600);
        receiptWritten = true;
      } catch {
        // An unsafe proof root is itself the blocker; do not mutate it.
      }
      const runnerPreparedArtifactPaths = [...new Set([...capturedArtifactRefs, ...(receiptWritten ? [receiptRelativePath] : [])])];
      return {
        status: 'blocked', summary,
        runnerPreparedArtifactPaths,
        runnerPreparedArtifactSha256: Object.fromEntries(await Promise.all(runnerPreparedArtifactPaths.map(async (path) => [
          path, sha256(await readFile(join(worktreePath, path))),
        ]))),
      };
    }
  }

  async release(record: AndroidLeaseRecordV1): Promise<void> {
    if (record.runnerCreated !== true || typeof record.emulatorPid !== 'number'
      || !Number.isSafeInteger(record.emulatorPid) || !record.emulatorProcessIdentity) return;
    await this.stopOwnedEmulator(record.emulatorPid, record.emulatorProcessIdentity);
    if (record.dataDir) await this.removeDataDir(record.dataDir);
  }

  private async acquirePreparation(path: string, intent: AndroidPreparationIntent): Promise<void> {
    const existing = await readPreparation(path);
    if (existing) {
      if (this.activePreparationTokens.has(existing.token)) throw new Error('Another Android proof preparation is active.');
      const owner = await this.inspectProcessIdentity(existing.ownerPid);
      if (owner.status === 'error') throw new Error('Existing Android proof preparation owner cannot be inspected.');
      if (owner.status === 'present' && owner.identity === existing.ownerProcessIdentity) {
        throw new Error('Another Android proof preparation is active.');
      }
      if (existing.emulatorPid && existing.emulatorProcessIdentity) {
        await this.stopOwnedEmulator(existing.emulatorPid, existing.emulatorProcessIdentity);
      } else {
        throw new Error('Existing Android proof preparation requires operator recovery before reuse.');
      }
      await this.removeDataDir(existing.dataDir);
      await removeOwnedPreparation(path, existing.token);
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(`${canonicalJson(intent)}\n`); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(dirname(path));
    this.activePreparationTokens.add(intent.token);
  }

  private async stopOwnedEmulator(emulatorPid: number, expectedIdentity: string): Promise<void> {
    const initial = await this.inspectProcessIdentity(emulatorPid);
    if (initial.status === 'error') throw new Error('Runner-created Android emulator process identity could not be inspected.');
    if (initial.status === 'absent' || initial.identity !== expectedIdentity) return;
    this.signalProcess(emulatorPid, 'SIGTERM');
    for (let attempt = 0; attempt < EMULATOR_STOP_ATTEMPTS / 2; attempt += 1) {
      const inspection = await this.inspectProcessIdentity(emulatorPid);
      if (inspection.status === 'error') throw new Error('Runner-created Android emulator process identity could not be inspected.');
      if (inspection.status === 'absent' || inspection.identity !== expectedIdentity) return;
      await this.wait(200);
    }
    const beforeKill = await this.inspectProcessIdentity(emulatorPid);
    if (beforeKill.status === 'error') throw new Error('Runner-created Android emulator process identity could not be inspected.');
    if (beforeKill.status === 'absent' || beforeKill.identity !== expectedIdentity) return;
    this.signalProcess(emulatorPid, 'SIGKILL');
    for (let attempt = 0; attempt < EMULATOR_STOP_ATTEMPTS / 2; attempt += 1) {
      const inspection = await this.inspectProcessIdentity(emulatorPid);
      if (inspection.status === 'error') throw new Error('Runner-created Android emulator process identity could not be inspected.');
      if (inspection.status === 'absent' || inspection.identity !== expectedIdentity) return;
      await this.wait(200);
    }
    throw new Error('Runner-created Android emulator process remained active after stop.');
  }

  private async assertOwnedEmulator(emulatorPid: number, expectedIdentity: string): Promise<void> {
    const inspection = await this.inspectProcessIdentity(emulatorPid);
    if (inspection.status !== 'present' || inspection.identity !== expectedIdentity) {
      throw new Error('Runner-created Android emulator process ownership was lost.');
    }
  }

  private async waitForBoot(
    serial: string,
    emulatorPid: number,
    emulatorProcessIdentity: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (signal.aborted) throw new Error('Android proof preparation was cancelled.');
      await this.assertOwnedEmulator(emulatorPid, emulatorProcessIdentity);
      const devices = await this.execute(this.adbPath, ['devices', '-l'], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
      const target = parseDevices(devices.stdout).find((device) => device.serial === serial && device.state === 'device');
      if (target) {
        const boot = await this.execute(this.adbPath, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
        if (boot.exitCode === 0 && boot.stdout.trim() === '1') return;
      }
      await this.wait(1_000, signal);
    }
    throw new Error('Runner-created Android emulator did not finish booting.');
  }

  private async readHierarchy(serial: string, proofId: string, signal?: AbortSignal): Promise<Buffer> {
    void proofId;
    const output = await this.executeBinary(
      this.adbPath,
      ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'],
      {
        timeoutMs: CAPTURE_TIMEOUT_MS, signal,
        maxStdoutBytes: TEXT_CAPTURE_MAX_BYTES, maxStderrBytes: CAPTURE_STDERR_MAX_BYTES,
      },
    );
    const text = output.toString('utf8');
    const start = text.indexOf('<?xml');
    const fallbackStart = text.indexOf('<hierarchy');
    const hierarchyStart = start >= 0 ? start : fallbackStart;
    const end = text.lastIndexOf('</hierarchy>');
    if (hierarchyStart < 0 || end < hierarchyStart) throw new Error('Android UI hierarchy capture is incomplete.');
    return Buffer.from(`${text.slice(hierarchyStart, end + '</hierarchy>'.length)}\n`);
  }

  private async readHierarchyWithIncompleteRetry(
    serial: string,
    proofId: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.readHierarchy(serial, proofId, signal);
      } catch (error) {
        if (signal?.aborted || !(error instanceof Error)
          || error.message !== 'Android UI hierarchy capture is incomplete.' || attempt === 3) throw error;
        await this.wait(200, signal);
      }
    }
    throw new Error('Android UI hierarchy capture is incomplete.');
  }

  private async resolveAppPid(serial: string, applicationId: string, signal?: AbortSignal): Promise<number> {
    const text = (await this.requireSuccess(
      this.adbPath,
      ['-s', serial, 'shell', 'pidof', '-s', applicationId],
      undefined,
      COMMAND_TIMEOUT_MS,
      signal,
    )).stdout.trim();
    const appPid = Number(text);
    if (!Number.isSafeInteger(appPid) || appPid < 1) throw new Error('Android proof application PID is unavailable.');
    return appPid;
  }

  private async waitForNavigationTarget(input: {
    serial: string;
    proofId: string;
    text: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ x: number; y: number }> {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() <= deadline) {
      if (input.signal.aborted) throw new Error('Android proof preparation was cancelled.');
      try {
        const hierarchy = await this.readHierarchy(input.serial, input.proofId, input.signal);
        const point = findNodeCenter(hierarchy.toString('utf8'), input.text);
        if (point) return point;
      } catch (error) {
        if (input.signal.aborted) throw error;
        if (!(error instanceof Error) || error.message !== 'Android UI hierarchy capture is incomplete.') throw error;
        // uiautomator can transiently emit a partial dump while the Flutter view changes; retry within the same bound.
      }
      await this.wait(Math.min(1_000, Math.max(1, deadline - Date.now())), input.signal);
    }
    throw new Error(`Android proof navigation target is unavailable: ${input.text}`);
  }

  private async captureEvidence(input: { serial: string; proofId: string; appPid: number; proofRoot: string; worktreePath: string; signal?: AbortSignal }): Promise<void> {
    const screenshot = await this.executeBinary(this.adbPath, ['-s', input.serial, 'exec-out', 'screencap', '-p'], {
      timeoutMs: CAPTURE_TIMEOUT_MS, signal: input.signal,
      maxStdoutBytes: SCREENSHOT_MAX_BYTES, maxStderrBytes: CAPTURE_STDERR_MAX_BYTES,
    });
    const hierarchy = await this.readHierarchyWithIncompleteRetry(input.serial, input.proofId, input.signal);
    const deviceLog = await this.executeBinary(this.adbPath, [
      '-s', input.serial, 'logcat', '--pid', String(input.appPid), '-d', '-v', 'threadtime',
    ], {
      timeoutMs: CAPTURE_TIMEOUT_MS, signal: input.signal,
      maxStdoutBytes: TEXT_CAPTURE_MAX_BYTES, maxStderrBytes: CAPTURE_STDERR_MAX_BYTES,
    });
    await ensureManagedProofRoot(input.worktreePath, input.proofRoot);
    await writeDurableAtomicFile(join(input.proofRoot, 'android-final.png'), screenshot, 0o600);
    await writeDurableAtomicFile(join(input.proofRoot, 'android-ui.xml'), hierarchy, 0o600);
    await writeDurableAtomicFile(join(input.proofRoot, 'android-device-log.txt'), deviceLog, 0o600);
  }

  private async requireSuccess(
    file: string,
    args: string[],
    cwd?: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
    signal?: AbortSignal,
    processGroup = false,
  ): Promise<ProcessCommandResult> {
    const result = await this.execute(file, args, { ...(cwd ? { cwd } : {}), timeoutMs, signal, processGroup });
    if (result.exitCode !== 0) {
      const diagnostic = safeCommandDiagnostic(`${result.stderr}\n${result.stdout}`);
      throw new Error(`Android proof command ${basename(file)} failed with exit code ${result.exitCode}${diagnostic ? `: ${diagnostic}` : '.'}`);
    }
    return result;
  }
}

function parseDevices(output: string): Array<{ serial: string; state: string }> {
  return output.split(/\r?\n/u).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial = '', state = ''] = line.split(/\s+/u);
    return { serial, state };
  });
}

function chooseSerial(observed: string[]): string {
  const used = new Set(observed.filter((serial) => /^emulator-[0-9]+$/u.test(serial)));
  for (let port = 5554; port <= 5682; port += 2) {
    const serial = `emulator-${port}`;
    if (!used.has(serial)) return serial;
  }
  throw new Error('No isolated Android emulator port is available.');
}

function lines(result: ProcessCommandResult): string[] {
  if (result.exitCode !== 0) throw new Error('Android virtual-device discovery failed.');
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

async function createExclusiveLease(path: string, lease: AndroidLeaseRecordV1): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${canonicalJson(lease)}\n`); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

async function replaceOwnedLease(path: string, lease: AndroidLeaseRecordV1): Promise<void> {
  const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
  if (current.token !== lease.token) throw new Error('Android lease ownership changed before update.');
  await writeDurableAtomicFile(path, `${canonicalJson(lease)}\n`, 0o600);
}

async function removeOwnedLease(path: string, token: string): Promise<void> {
  let current: { token?: unknown };
  try { current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown }; }
  catch (error) { if (isMissing(error)) return; throw error; }
  if (current.token !== token) return;
  await rm(path);
  await syncDirectory(dirname(path));
}

async function readPreparation(path: string): Promise<AndroidPreparationIntent | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (isMissing(error)) return undefined; throw new Error('Existing Android proof preparation is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Existing Android proof preparation is invalid.');
  const record = value as Record<string, unknown>;
  const expected = [
    'schema', 'version', 'proofId', 'token', 'ownerPid', 'ownerProcessIdentity', 'serial', 'dataDir',
    'emulatorPid', 'emulatorProcessIdentity',
  ].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])
    || record.schema !== 'codex-orchestrator.android-preparation' || record.version !== 1
    || typeof record.proofId !== 'string' || typeof record.token !== 'string'
    || !Number.isSafeInteger(record.ownerPid) || (record.ownerPid as number) < 1
    || typeof record.ownerProcessIdentity !== 'string' || typeof record.serial !== 'string'
    || typeof record.dataDir !== 'string'
    || (record.emulatorPid !== null && (!Number.isSafeInteger(record.emulatorPid) || (record.emulatorPid as number) < 1))
    || (record.emulatorProcessIdentity !== null && typeof record.emulatorProcessIdentity !== 'string')) {
    throw new Error('Existing Android proof preparation is invalid.');
  }
  return record as unknown as AndroidPreparationIntent;
}

async function replaceOwnedPreparation(path: string, intent: AndroidPreparationIntent): Promise<void> {
  const current = await readPreparation(path);
  if (!current || current.token !== intent.token) throw new Error('Android proof preparation ownership changed.');
  await writeDurableAtomicFile(path, `${canonicalJson(intent)}\n`, 0o600);
}

async function removeOwnedPreparation(path: string, token: string): Promise<void> {
  const current = await readPreparation(path);
  if (!current || current.token !== token) return;
  await rm(path);
  await syncDirectory(dirname(path));
}

async function inspectExistingLease(path: string): Promise<AndroidLeaseRecordV1 | 'absent' | 'invalid'> {
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) { if (isMissing(error)) return 'absent'; throw error; }
  try { return parseAndroidLease(bytes); } catch { return 'invalid'; }
}

function findNodeCenter(xml: string, expectedText: string): { x: number; y: number } | undefined {
  for (const match of xml.matchAll(/<node\b[^>]*>/gu)) {
    const node = match[0];
    const text = /\btext="([^"]*)"/u.exec(node)?.[1];
    const description = /\bcontent-desc="([^"]*)"/u.exec(node)?.[1];
    if (![text, description].some((value) => value !== undefined && decodeXmlAttribute(value) === expectedText)) continue;
    const bounds = /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u.exec(node);
    if (!bounds) continue;
    const coordinates = bounds.slice(1).map(Number);
    if (coordinates.some((value) => !Number.isSafeInteger(value) || value < 0)) continue;
    const [left, top, right, bottom] = coordinates as [number, number, number, number];
    if (right <= left || bottom <= top) continue;
    return { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) };
  }
  return undefined;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9A-F]+);/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function safeCommandDiagnostic(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)["']?\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/\/(?:Users|home)\/[^\s:]+/gu, '[local-path]')
    .trim()
    .slice(0, 2_048);
}

function executeBinary(
  file: string,
  args: string[],
  options?: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
  },
): Promise<Buffer> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { cwd: options?.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow: 'stdout' | 'stderr' | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 2_000).unref();
    };
    const timeout = options?.timeoutMs ? setTimeout(terminate, options.timeoutMs) : undefined;
    timeout?.unref();
    options?.signal?.addEventListener('abort', terminate, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (options?.maxStdoutBytes && stdoutBytes > options.maxStdoutBytes) {
        overflow = 'stdout'; terminate(); return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (options?.maxStderrBytes && stderrBytes > options.maxStderrBytes) {
        overflow = 'stderr'; terminate(); return;
      }
      stderr.push(chunk);
    });
    child.once('error', (error) => { settled = true; if (timeout) clearTimeout(timeout); rejectRun(error); });
    child.once('close', (code) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (overflow) rejectRun(new Error(`Android binary command ${overflow} exceeded its byte limit.`));
      else if (code === 0) resolveRun(Buffer.concat(stdout));
      else rejectRun(new Error(`Android binary command failed: ${safeCommandDiagnostic(Buffer.concat(stderr).toString('utf8'))}`));
    });
  });
}

function startEmulator(file: string, args: string[], options?: { cwd?: string }): Promise<{ pid: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { cwd: options?.cwd, env: process.env, detached: false, stdio: 'ignore' });
    child.once('error', rejectRun);
    child.once('spawn', () => child.pid ? resolveRun({ pid: child.pid }) : rejectRun(new Error('Android emulator PID is unavailable.')));
  });
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    if (signal?.aborted) return rejectWait(new Error('Android proof preparation was cancelled.'));
    const timeout = setTimeout(resolveWait, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timeout); rejectWait(new Error('Android proof preparation was cancelled.')); }, { once: true });
  });
}

function createEphemeralDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-orchestrator-android-'));
}

async function removeEphemeralDataDir(path: string): Promise<void> {
  const canonical = resolve(path);
  if (dirname(canonical) !== resolve(tmpdir()) || !basename(canonical).startsWith('codex-orchestrator-android-')) {
    throw new Error('Android proof data directory is outside the Runner-owned temporary root.');
  }
  let metadata;
  try { metadata = await lstat(canonical); }
  catch (error) { if (isMissing(error)) return; throw error; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Android proof data directory is unsafe.');
  await rm(canonical, { recursive: true });
}

function boundedError(error: unknown): string {
  return safeCommandDiagnostic(error instanceof Error ? error.message : 'Android proof preparation failed.')
    .replace(/[\r\n\0]+/gu, ' ')
    .slice(0, 4 * 1024);
}

async function readProcessStartIdentity(pid: number): Promise<string | undefined> {
  const result = await inspectProcessStartIdentity(pid);
  return result.status === 'present' ? result.identity : undefined;
}

async function inspectProcessStartIdentity(pid: number): Promise<ProcessIdentityInspection> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'error' };
  if (platform() === 'linux') {
    try {
      const text = await readFile(`/proc/${pid}/stat`, 'utf8');
      const close = text.lastIndexOf(') ');
      const fields = close < 0 ? [] : text.slice(close + 2).trim().split(/\s+/u);
      return fields[19] ? { status: 'present', identity: `linux:${fields[19]}` } : { status: 'error' };
    } catch (error) { return isMissing(error) ? { status: 'absent' } : { status: 'error' }; }
  }
  return await new Promise((resolveIdentity) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        const code = (error as unknown as { code?: unknown }).code;
        resolveIdentity(code === 1 || code === '1'
          ? { status: 'absent' }
          : { status: 'error' });
        return;
      }
      const value = stdout.trim().replace(/\s+/gu, ' ');
      resolveIdentity(value ? { status: 'present', identity: `${platform()}:${value}` } : { status: 'error' });
    });
  });
}

async function snapshotFreshRegularFile(path: string, snapshotPath: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) throw new Error('Configured Android APK was not produced.');
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1) throw new Error('Configured Android APK was not produced as a regular file.');
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    const snapshot = await open(snapshotPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400);
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    try {
      while (position < metadata.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, metadata.size - position), position);
        if (bytesRead === 0) throw new Error('Configured Android APK changed while snapshotting.');
        const bytes = chunk.subarray(0, bytesRead);
        digest.update(bytes);
        await snapshot.write(bytes);
        position += bytesRead;
      }
      await snapshot.sync();
    } finally {
      await snapshot.close();
    }
    const after = await handle.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
      await rm(snapshotPath, { force: true });
      throw new Error('Configured Android APK changed while snapshotting.');
    }
    return digest.digest('hex');
  } catch (error) {
    await rm(snapshotPath, { force: true }).catch(() => {});
    throw error;
  } finally { await handle?.close(); }
}

function proofLeaseDurationMs(config: AndroidProofConfig, proofAgentBudgetMs: number): number {
  if (!Number.isSafeInteger(proofAgentBudgetMs) || proofAgentBudgetMs < 1) throw new Error('Android proof agent budget is invalid.');
  const navigation = (config.tapText?.length ?? 0) * (config.navigationTimeoutMs + config.settleMs);
  return BUILD_TIMEOUT_MS + config.bootTimeoutMs + navigation + proofAgentBudgetMs + 10 * 60 * 1000;
}

async function removeExistingApkSafely(worktreePath: string, apkPath: string): Promise<void> {
  try { await lstat(apkPath); } catch (error) { if (isMissing(error)) return; throw error; }
  await assertNoSymlinkAncestors(worktreePath, dirname(apkPath));
  await rm(apkPath, { force: true });
}

async function assertNoSymlinkAncestors(worktreePath: string, parentPath: string): Promise<void> {
  const relative = parentPath.slice(worktreePath.length + 1);
  if (!relative || parentPath === worktreePath) return;
  let current = worktreePath;
  for (const segment of relative.split('/')) {
    current = join(current, segment);
    let metadata;
    try { metadata = await lstat(current); } catch (error) { if (isMissing(error)) return; throw error; }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Configured Android APK parent path is unsafe.');
  }
}

async function ensureManagedProofRoot(worktreePath: string, proofRoot: string): Promise<void> {
  if (proofRoot === worktreePath || !proofRoot.startsWith(`${worktreePath}/`)) {
    throw new Error('Android proof artifact root escapes worktree.');
  }
  await assertNoSymlinkDirectoryPath(worktreePath, proofRoot);
  await mkdir(proofRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkDirectoryPath(worktreePath, proofRoot);
  const [realWorktree, realProofRoot] = await Promise.all([realpath(worktreePath), realpath(proofRoot)]);
  if (realProofRoot === realWorktree || !realProofRoot.startsWith(`${realWorktree}/`)) {
    throw new Error('Android proof artifact root resolves outside worktree.');
  }
}

async function assertNoSymlinkDirectoryPath(worktreePath: string, targetPath: string): Promise<void> {
  const relative = targetPath.slice(worktreePath.length + 1);
  let current = worktreePath;
  for (const segment of relative.split('/')) {
    current = join(current, segment);
    let metadata;
    try { metadata = await lstat(current); } catch (error) { if (isMissing(error)) return; throw error; }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Android proof artifact directory is unsafe.');
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function validatePreparedReceipt(bytes: Buffer, expected: Record<string, unknown>): void {
  if (bytes.length === 0 || bytes.length > 64 * 1024) throw new Error('Android Runner receipt bytes are invalid.');
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  if (canonicalJson(parsed) !== canonicalJson(expected)) throw new Error('Android Runner receipt validation failed.');
}
