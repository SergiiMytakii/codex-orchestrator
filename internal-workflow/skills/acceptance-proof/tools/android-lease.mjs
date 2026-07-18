#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LEASE_FILE = 'android.json';
const LEASE_MS = 15 * 60 * 1000;

class Blocked extends Error {}

try {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  const result = await execute(command, args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const blocked = error instanceof Blocked;
  process.stdout.write(`${JSON.stringify({
    status: blocked ? 'blocked' : 'internal-error',
    reason: blocked ? error.message : 'Android lease helper failed internally.',
  })}\n`);
  process.exitCode = blocked ? 20 : 70;
}

async function execute(command, args) {
  const leaseRoot = requiredPath(args['lease-root'], 'lease root');
  const artifactPath = requiredPath(args.artifact, 'lease artifact');
  const proofId = requiredString(args['proof-id'], 'proof ID');
  const adb = args.adb
    ? requiredPath(args.adb, 'adb path')
    : process.env.ANDROID_ADB || join(process.env.HOME || '', 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
  const now = parseNow();
  await ensureDirectDirectory(leaseRoot);
  await ensureDirectDirectory(dirname(artifactPath));
  const leasePath = join(leaseRoot, LEASE_FILE);

  if (command === 'acquire') {
    const appId = requiredAppId(args['app-id']);
    const ownerPid = requiredPid(args['owner-pid']);
    const target = await selectEmulator(adb);
    const existing = await readLease(leasePath);
    if (existing) {
      if (existing.proofId === proofId && existing.appId === appId && existing.ownerPid === ownerPid) {
        await verifyTarget(adb, existing, false);
        return publicResult('reused', existing);
      }
      if (!(Date.parse(existing.expiresAt) < now.getTime() && !pidAlive(existing.ownerPid))) {
        throw new Blocked('An active foreign Android lease already exists.');
      }
      if (existing.serial !== target.serial || existing.appId !== appId) {
        throw new Blocked('A stale Android lease does not match the requested target identity.');
      }
      await rm(leasePath);
    }
    const livePid = await appPid(adb, target.serial, appId);
    if (livePid !== undefined) throw new Blocked('The requested Android app already has a user-owned live process.');
    const lease = {
      schema: 'codex-orchestrator.android-lease',
      version: 1,
      status: 'active',
      proofId,
      token: randomUUID(),
      serial: target.serial,
      appId,
      ownerPid,
      appPid: null,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      updatedAt: now.toISOString(),
    };
    await createExclusiveJson(leasePath, lease);
    await writeAtomicJson(artifactPath, lease);
    return publicResult('acquired', lease);
  }

  const token = requiredString(args.token, 'lease token');
  const lease = await requireOwnedLease(leasePath, proofId, token, now);
  if (command === 'bind') {
    await verifyTarget(adb, lease, false, true);
    const pid = await appPid(adb, lease.serial, lease.appId);
    if (pid === undefined) throw new Blocked('The leased Android app is not running.');
    const bound = { ...lease, appPid: pid, updatedAt: now.toISOString() };
    await replaceJson(leasePath, bound);
    await writeAtomicJson(artifactPath, bound);
    return publicResult('bound', bound);
  }
  if (command === 'verify') {
    await verifyTarget(adb, lease, true);
    await writeAtomicJson(artifactPath, { ...lease, updatedAt: now.toISOString() });
    return publicResult('verified', lease);
  }
  if (command === 'release') {
    await verifyTarget(adb, lease, Number.isSafeInteger(lease.appPid));
    const released = { ...lease, status: 'released', updatedAt: now.toISOString() };
    await writeAtomicJson(artifactPath, released);
    await rm(leasePath);
    await syncDirectory(dirname(leasePath));
    return publicResult('released', released);
  }
  throw new Blocked('Unknown Android lease command.');
}

async function selectEmulator(adb) {
  const output = await adbCommand(adb, ['devices', '-l']);
  const rows = output.stdout.split(/\r?\n/u).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial, state] = line.split(/\s+/u);
    return { serial, state };
  });
  if (rows.some((row) => !row.serial.startsWith('emulator-'))) throw new Blocked('Physical Android devices are not eligible for runner leases.');
  if (rows.length !== 1 || rows[0].state !== 'device') throw new Blocked('Exactly one online Android emulator is required.');
  const boot = await adbCommand(adb, ['-s', rows[0].serial, 'shell', 'getprop', 'sys.boot_completed']);
  if (boot.stdout.trim() !== '1') throw new Blocked('The Android emulator has not completed boot.');
  return rows[0];
}

async function verifyTarget(adb, lease, requireBoundApp, allowUnboundLive = false) {
  const target = await selectEmulator(adb);
  if (target.serial !== lease.serial) throw new Blocked('The leased Android emulator identity changed.');
  const currentPid = await appPid(adb, lease.serial, lease.appId);
  if (requireBoundApp) {
    if (!Number.isSafeInteger(lease.appPid) || currentPid !== lease.appPid) {
      throw new Blocked('The leased Android app PID changed or disappeared.');
    }
  } else if (!allowUnboundLive && lease.appPid === null && currentPid !== undefined) {
    throw new Blocked('The leased Android app became live before runner binding.');
  }
}

async function appPid(adb, serial, appId) {
  const result = await adbCommand(adb, ['-s', serial, 'shell', 'pidof', '-s', appId], true);
  const value = result.stdout.trim();
  if (!value) return undefined;
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Blocked('Android app PID observation is invalid.');
  return pid;
}

async function adbCommand(adb, args, allowFailure = false) {
  try {
    return await execFileAsync(adb, args, { timeout: 15_000, maxBuffer: 1024 * 1024, env: process.env });
  } catch (error) {
    if (allowFailure && typeof error === 'object' && error !== null && 'stdout' in error) {
      return { stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
    }
    throw new Blocked('Android tooling did not return a usable target observation.');
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Blocked('Android lease arguments are invalid.');
    const equals = arg.indexOf('=');
    if (equals > 2) {
      result[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Blocked('Android lease argument value is missing.');
    result[arg.slice(2)] = value;
  }
  return result;
}

function parseNow() {
  const value = process.env.CODEX_ORCHESTRATOR_NOW || new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new Error('invalid lease clock');
  return date;
}

async function requireOwnedLease(path, proofId, token, now) {
  const lease = await readLease(path);
  if (!lease || lease.proofId !== proofId || lease.token !== token) throw new Blocked('Android lease ownership does not match.');
  if (lease.status !== 'active' || Date.parse(lease.expiresAt) < now.getTime()) throw new Blocked('Android lease is not active.');
  return lease;
}

async function readLease(path) {
  try {
    return validateLease(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Blocked('Android lease state is malformed.');
  }
}

function validateLease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid lease');
  const keys = ['schema', 'version', 'status', 'proofId', 'token', 'serial', 'appId', 'ownerPid', 'appPid', 'acquiredAt', 'expiresAt', 'updatedAt'].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error('invalid lease keys');
  if (value.schema !== 'codex-orchestrator.android-lease' || value.version !== 1 || !['active', 'released'].includes(value.status)) throw new Error('invalid lease schema');
  requiredString(value.proofId, 'proof ID');
  requiredString(value.token, 'token');
  if (!/^emulator-[0-9]+$/u.test(value.serial)) throw new Error('invalid serial');
  requiredAppId(value.appId);
  requiredPid(value.ownerPid);
  if (value.appPid !== null) requiredPid(value.appPid);
  for (const field of ['acquiredAt', 'expiresAt', 'updatedAt']) {
    if (new Date(value[field]).toISOString() !== value[field]) throw new Error('invalid lease timestamp');
  }
  return value;
}

async function ensureDirectDirectory(path) {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe lease directory');
}

async function createExclusiveJson(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function replaceJson(path, value) {
  await writeAtomicJson(path, value);
}

async function writeAtomicJson(path, value) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function publicResult(status, lease) {
  return { status, proofId: lease.proofId, token: lease.token, serial: lease.serial, appId: lease.appId, appPid: lease.appPid, expiresAt: lease.expiresAt };
}

function requiredPath(value, field) {
  const text = requiredString(value, field);
  if (!text.startsWith('/')) throw new Blocked(`${field} must be absolute.`);
  return resolve(text);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Blocked(`${field} is invalid.`);
  return value;
}

function requiredAppId(value) {
  const text = requiredString(value, 'app ID');
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(text)) throw new Blocked('Android app ID is invalid.');
  return text;
}

function requiredPid(value) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Blocked('Android owner PID is invalid.');
  return pid;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
