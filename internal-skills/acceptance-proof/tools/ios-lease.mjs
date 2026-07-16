#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LEASE_FILE = 'ios.json';
const LEASE_MS = 20 * 60 * 1000;
const UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/iu;

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
    reason: blocked ? error.message : 'iOS lease helper failed internally.',
  })}\n`);
  process.exitCode = blocked ? 20 : 70;
}

async function execute(command, args) {
  const leaseRoot = requiredPath(args['lease-root'], 'lease root');
  const artifactPath = requiredPath(args.artifact, 'lease artifact');
  const proofId = requiredString(args['proof-id'], 'proof ID');
  const xcrun = requiredPath(args.xcrun || '/usr/bin/xcrun', 'xcrun path');
  const now = parseNow();
  await ensureDirectDirectory(leaseRoot);
  await ensureDirectDirectory(dirname(artifactPath));
  const leasePath = join(leaseRoot, LEASE_FILE);

  if (command === 'acquire') {
    const bundleId = requiredBundleId(args['bundle-id']);
    const ownerPid = requiredPid(args['owner-pid']);
    const runtimeId = requiredIdentifier(args.runtime, 'runtime ID', 'com.apple.CoreSimulator.SimRuntime.');
    const deviceTypeId = requiredIdentifier(args['device-type'], 'device type ID', 'com.apple.CoreSimulator.SimDeviceType.');
    const existing = await readLease(leasePath);
    const booted = await listDevices(xcrun, 'booted');
    if (booted.some((device) => device.udid !== existing?.udid)) {
      throw new Blocked('A user-owned booted Simulator session already exists.');
    }
    if (existing) {
      if (existing.status === 'active' && existing.proofId === proofId && existing.bundleId === bundleId
        && existing.ownerPid === ownerPid && Date.parse(existing.expiresAt) >= now.getTime()) {
        await requireRecordedTarget(xcrun, existing, false);
        return publicResult('reused', existing);
      }
      if (!(Date.parse(existing.expiresAt) < now.getTime() && !pidAlive(existing.ownerPid))) {
        throw new Blocked('An active foreign iOS lease already exists.');
      }
      await cleanupRecordedTarget(xcrun, existing);
      await rm(leasePath);
      await syncDirectory(dirname(leasePath));
    }
    if (booted.length !== 0) throw new Blocked('A booted Simulator appeared before lease acquisition.');

    const deviceName = `Codex ${proofId}`;
    const preparing = {
      schema: 'codex-orchestrator.ios-lease', version: 1, status: 'preparing', proofId, token: randomUUID(),
      udid: null, deviceName, bundleId, ownerPid, appPid: null, runtimeId, deviceTypeId, runnerCreated: true,
      acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + LEASE_MS).toISOString(), updatedAt: now.toISOString(),
    };
    await createExclusiveJson(leasePath, preparing);
    let createdUdid;
    try {
      const created = await simctl(xcrun, ['create', deviceName, deviceTypeId, runtimeId]);
      createdUdid = created.stdout.trim();
      if (!UDID_PATTERN.test(createdUdid)) throw new Blocked('simctl create returned an invalid Simulator identity.');
      const active = { ...preparing, status: 'active', udid: createdUdid, updatedAt: now.toISOString() };
      await replaceJson(leasePath, active);
      await writeAtomicJson(artifactPath, active);
      return publicResult('acquired', active);
    } catch (error) {
      if (createdUdid && UDID_PATTERN.test(createdUdid)) await simctl(xcrun, ['delete', createdUdid], true);
      await rm(leasePath, { force: true });
      await syncDirectory(dirname(leasePath));
      throw error;
    }
  }

  const token = requiredString(args.token, 'lease token');
  const lease = await requireOwnedLease(leasePath, proofId, token, now);
  if (command === 'bind') {
    const appPid = requiredPid(args['app-pid']);
    await verifyAppTarget(xcrun, lease, appPid);
    const bound = { ...lease, appPid, updatedAt: now.toISOString() };
    await replaceJson(leasePath, bound);
    await writeAtomicJson(artifactPath, bound);
    return publicResult('bound', bound);
  }
  if (command === 'verify') {
    if (!Number.isSafeInteger(lease.appPid)) throw new Blocked('The iOS lease is not bound to an app process.');
    await verifyAppTarget(xcrun, lease, lease.appPid);
    await writeAtomicJson(artifactPath, { ...lease, updatedAt: now.toISOString() });
    return publicResult('verified', lease);
  }
  if (command === 'release') {
    await cleanupRecordedTarget(xcrun, lease, true);
    const released = { ...lease, status: 'released', updatedAt: now.toISOString() };
    await writeAtomicJson(artifactPath, released);
    await rm(leasePath);
    await syncDirectory(dirname(leasePath));
    return publicResult('released', released);
  }
  throw new Blocked('Unknown iOS lease command.');
}

async function listDevices(xcrun, scope = 'all') {
  const args = scope === 'booted' ? ['list', 'devices', 'booted', '-j'] : ['list', 'devices', '-j'];
  const result = await simctl(xcrun, args);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Blocked('simctl device inventory is malformed.'); }
  return Object.values(parsed.devices || {}).flat().filter((device) => device && device.isAvailable !== false).map((device) => ({
    udid: device.udid, name: device.name, state: device.state,
  }));
}

async function requireRecordedTarget(xcrun, lease, requireBooted) {
  if (!lease.runnerCreated || !UDID_PATTERN.test(String(lease.udid))) throw new Blocked('The iOS lease lacks a runner-created target.');
  const matches = (await listDevices(xcrun)).filter((device) => device.udid === lease.udid);
  if (matches.length !== 1) throw new Blocked('The leased Simulator identity is absent or ambiguous.');
  if (requireBooted && matches[0].state !== 'Booted') throw new Blocked('The leased Simulator is not booted.');
  return matches[0];
}

async function verifyAppTarget(xcrun, lease, appPid) {
  await requireRecordedTarget(xcrun, lease, true);
  const container = (await simctl(xcrun, ['get_app_container', lease.udid, lease.bundleId, 'app'])).stdout.trim();
  if (!container.endsWith('.app') || container.includes('\n')) throw new Blocked('The leased iOS app container is invalid.');
  const services = (await simctl(xcrun, ['spawn', lease.udid, 'launchctl', 'list'])).stdout;
  const matches = services.split(/\r?\n/u).map((line) => /^\s*(\d+)\s+\S+\s+UIKitApplication:([^[]+)\[/u.exec(line))
    .filter((match) => match && match[2] === lease.bundleId);
  if (matches.length !== 1 || Number(matches[0][1]) !== appPid) {
    throw new Blocked('The leased iOS app PID changed or does not match its bundle container.');
  }
}

async function cleanupRecordedTarget(xcrun, lease, allowAbsent = false) {
  if (!lease.runnerCreated) throw new Blocked('Only runner-created Simulators may be released.');
  const devices = await listDevices(xcrun);
  let matches = lease.udid
    ? devices.filter((device) => device.udid === lease.udid)
    : devices.filter((device) => device.name === lease.deviceName);
  if (matches.length === 0 && allowAbsent) return;
  if (matches.length !== 1 || !UDID_PATTERN.test(matches[0].udid)) throw new Blocked('Runner-created Simulator cleanup identity is absent or ambiguous.');
  if (matches[0].state === 'Booted') await simctl(xcrun, ['shutdown', matches[0].udid]);
  await simctl(xcrun, ['delete', matches[0].udid]);
  matches = (await listDevices(xcrun)).filter((device) => device.udid === matches[0].udid);
  if (matches.length !== 0) throw new Blocked('Runner-created Simulator deletion was not confirmed.');
}

async function simctl(xcrun, args, allowFailure = false) {
  try {
    return await execFileAsync(xcrun, ['simctl', ...args], { timeout: 20_000, maxBuffer: 1024 * 1024, env: process.env });
  } catch (error) {
    if (allowFailure) return { stdout: '', stderr: '' };
    throw new Blocked('iOS Simulator tooling did not return a usable target observation.');
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Blocked('iOS lease arguments are invalid.');
    const equals = arg.indexOf('=');
    if (equals > 2) { result[arg.slice(2, equals)] = arg.slice(equals + 1); continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Blocked('iOS lease argument value is missing.');
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
  if (!lease || lease.status !== 'active' || lease.proofId !== proofId || lease.token !== token) throw new Blocked('iOS lease ownership does not match.');
  if (Date.parse(lease.expiresAt) < now.getTime()) throw new Blocked('iOS lease is not active.');
  return lease;
}

async function readLease(path) {
  try { return validateLease(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Blocked('iOS lease state is malformed.');
  }
}

function validateLease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid lease');
  const keys = ['schema', 'version', 'status', 'proofId', 'token', 'udid', 'deviceName', 'bundleId', 'ownerPid', 'appPid', 'runtimeId', 'deviceTypeId', 'runnerCreated', 'acquiredAt', 'expiresAt', 'updatedAt'].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error('invalid lease keys');
  if (value.schema !== 'codex-orchestrator.ios-lease' || value.version !== 1 || !['preparing', 'active', 'released'].includes(value.status)) throw new Error('invalid lease schema');
  requiredString(value.proofId, 'proof ID');
  requiredString(value.token, 'token');
  requiredString(value.deviceName, 'device name');
  requiredBundleId(value.bundleId);
  requiredPid(value.ownerPid);
  if (value.appPid !== null) requiredPid(value.appPid);
  requiredIdentifier(value.runtimeId, 'runtime ID', 'com.apple.CoreSimulator.SimRuntime.');
  requiredIdentifier(value.deviceTypeId, 'device type ID', 'com.apple.CoreSimulator.SimDeviceType.');
  if (value.runnerCreated !== true) throw new Error('invalid runner ownership');
  if (value.status === 'preparing' ? value.udid !== null : !UDID_PATTERN.test(String(value.udid))) throw new Error('invalid UDID');
  for (const field of ['acquiredAt', 'expiresAt', 'updatedAt']) if (new Date(value[field]).toISOString() !== value[field]) throw new Error('invalid timestamp');
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
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

async function replaceJson(path, value) { await writeAtomicJson(path, value); }

async function writeAtomicJson(path, value) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function publicResult(status, lease) {
  return { status, proofId: lease.proofId, token: lease.token, udid: lease.udid, bundleId: lease.bundleId, appPid: lease.appPid, expiresAt: lease.expiresAt };
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

function requiredIdentifier(value, field, prefix) {
  const text = requiredString(value, field);
  if (!text.startsWith(prefix) || !/^[A-Za-z0-9.-]+$/u.test(text)) throw new Blocked(`${field} is invalid.`);
  return text;
}

function requiredBundleId(value) {
  const text = requiredString(value, 'bundle ID');
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(text)) throw new Blocked('iOS bundle ID is invalid.');
  return text;
}

function requiredPid(value) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Blocked('iOS process ID is invalid.');
  return pid;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
