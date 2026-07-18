import { execFile } from 'node:child_process';
import { link, lstat, mkdir, open, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';

const WAIT_MS = 5_000;
const POLL_MS = 25;

export type ImmutableWorkflowPublishStep =
  | 'before-claim-link' | 'after-claim-link'
  | 'after-content-mkdir' | 'after-first-content-file'
  | 'before-content-parent-sync' | 'after-content-parent-sync'
  | 'before-ready-link' | 'after-ready-link' | 'after-ready-parent-sync';

export interface ImmutableWorkflowOwner {
  bootId: string;
  pid: number;
  token: string;
  parentToken: string | null;
  processStartIdentity: string;
}

interface ReadyRecord {
  token: string;
}

interface ReadyContext<TReady extends ReadyRecord> {
  ready: TReady;
  readyPath: string;
  contentRoot: string;
  reused: boolean;
}

export async function publishImmutableWorkflow<
  TOwner extends ImmutableWorkflowOwner,
  TReady extends ReadyRecord,
  TContent,
  TResult,
>(input: {
  parent: string;
  identity: string;
  bootId: string;
  createOwner: (parentToken: string | null, processStartIdentity: string) => TOwner;
  parseOwner: (value: unknown) => TOwner;
  createReady: (owner: TOwner, content: TContent) => TReady;
  parseReady: (value: unknown) => TReady;
  serializeRecord: (value: unknown) => Buffer;
  readControl: (path: string) => Promise<Buffer>;
  writeContent: (contentRoot: string, onStep: (step: ImmutableWorkflowPublishStep) => Promise<void>) => Promise<TContent>;
  resultFromReady: (context: ReadyContext<TReady>) => Promise<TResult>;
  resultFromPublished?: (context: ReadyContext<TReady> & { content: TContent }) => Promise<TResult>;
  assertContentPathAvailable?: (contentRoot: string) => Promise<void>;
  verifyReadyCollision?: (existing: Buffer, proposed: Buffer) => void;
  activePublisherError: string;
  recoveryChainError: string;
  onStep?: (step: ImmutableWorkflowPublishStep) => Promise<void> | void;
}): Promise<TResult> {
  const claimPath = join(input.parent, `${input.identity}.claim`);
  const readyPath = join(input.parent, `${input.identity}.ready`);
  const started = Date.now();
  const processStartIdentity = await readProcessStartIdentity(process.pid);
  if (!processStartIdentity) throw new Error('publisher process identity is unavailable');
  let owner: TOwner;

  while (true) {
    if (await exists(readyPath)) return resultFromReady(input, readyPath, true);
    if (!await exists(claimPath)) {
      owner = input.createOwner(null, processStartIdentity);
      if (await tryLinkRecord(input, `.claim-candidate-${owner.token}`, claimPath, owner)) {
        activeOwnerTokens.add(owner.token);
        break;
      }
      continue;
    }
    const leaf = await leafOwner(input);
    const sameLiveProcess = leaf.bootId === input.bootId
      && await processIdentityMatches(leaf.pid, leaf.processStartIdentity);
    if (sameLiveProcess && !(leaf.pid === process.pid && !activeOwnerTokens.has(leaf.token))) {
      if (Date.now() - started > WAIT_MS) throw new Error(input.activePublisherError);
      await delay(POLL_MS);
      continue;
    }
    owner = input.createOwner(leaf.token, processStartIdentity);
    const recoveryPath = join(input.parent, `${input.identity}.recovery.${leaf.token}`);
    if (await tryLinkRecord(input, `.recovery-candidate-${owner.token}`, recoveryPath, owner)) {
      activeOwnerTokens.add(owner.token);
      break;
    }
  }

  const contentRoot = join(input.parent, `${input.identity}.content.${owner.token}`);
  try {
    await input.assertContentPathAvailable?.(contentRoot);
    await mkdir(contentRoot, { mode: 0o700 });
    await input.onStep?.('after-content-mkdir');
    const content = await input.writeContent(contentRoot, async (step) => { await input.onStep?.(step); });
    await input.onStep?.('before-content-parent-sync');
    await syncDirectory(input.parent);
    await input.onStep?.('after-content-parent-sync');
    const ready = input.createReady(owner, content);
    const readyBytes = input.serializeRecord(ready);
    const candidate = join(input.parent, `.ready-candidate-${owner.token}`);
    await input.onStep?.('before-ready-link');
    await writeSynced(candidate, readyBytes, 0o600);
    try {
      await link(candidate, readyPath);
      await rm(candidate, { force: true });
      await input.onStep?.('after-ready-link');
      await syncDirectory(input.parent);
      await input.onStep?.('after-ready-parent-sync');
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      if (input.verifyReadyCollision) input.verifyReadyCollision(await input.readControl(readyPath), readyBytes);
    } finally {
      await rm(candidate, { force: true });
    }
    if (input.resultFromPublished) {
      return input.resultFromPublished({ ready, readyPath, contentRoot, content, reused: false });
    }
    return resultFromReady(input, readyPath, false);
  } catch (error) {
    if (!await exists(readyPath)) await removeOwnedContent(contentRoot);
    throw error;
  } finally {
    activeOwnerTokens.delete(owner.token);
  }
}

async function resultFromReady<TOwner extends ImmutableWorkflowOwner, TReady extends ReadyRecord, TContent, TResult>(
  input: Parameters<typeof publishImmutableWorkflow<TOwner, TReady, TContent, TResult>>[0],
  readyPath: string,
  reused: boolean,
): Promise<TResult> {
  const ready = input.parseReady(JSON.parse((await input.readControl(readyPath)).toString('utf8')));
  const leaf = await leafOwner(input);
  if (leaf.token !== ready.token) throw new Error(input.recoveryChainError);
  return input.resultFromReady({
    ready,
    readyPath,
    contentRoot: join(input.parent, `${input.identity}.content.${ready.token}`),
    reused,
  });
}

async function leafOwner<TOwner extends ImmutableWorkflowOwner, TReady extends ReadyRecord, TContent, TResult>(
  input: Parameters<typeof publishImmutableWorkflow<TOwner, TReady, TContent, TResult>>[0],
): Promise<TOwner> {
  let owner = input.parseOwner(JSON.parse((await input.readControl(join(input.parent, `${input.identity}.claim`))).toString('utf8')));
  const seen = new Set([owner.token]);
  while (await exists(join(input.parent, `${input.identity}.recovery.${owner.token}`))) {
    const next = input.parseOwner(JSON.parse((await input.readControl(join(input.parent, `${input.identity}.recovery.${owner.token}`))).toString('utf8')));
    if (next.parentToken !== owner.token || seen.has(next.token)) throw new Error(input.recoveryChainError);
    owner = next;
    seen.add(owner.token);
  }
  return owner;
}

async function tryLinkRecord<TOwner extends ImmutableWorkflowOwner, TReady extends ReadyRecord, TContent, TResult>(
  input: Parameters<typeof publishImmutableWorkflow<TOwner, TReady, TContent, TResult>>[0],
  candidateName: string,
  destination: string,
  owner: TOwner,
): Promise<boolean> {
  const candidate = join(input.parent, candidateName);
  await input.onStep?.('before-claim-link');
  await writeSynced(candidate, input.serializeRecord(owner), 0o600);
  activeOwnerTokens.add(owner.token);
  try {
    await link(candidate, destination);
    await syncDirectory(input.parent);
    await rm(candidate, { force: true });
    await input.onStep?.('after-claim-link');
    return true;
  } catch (error) {
    if (isCode(error, 'EEXIST')) {
      activeOwnerTokens.delete(owner.token);
      return false;
    }
    activeOwnerTokens.delete(owner.token);
    throw error;
  } finally {
    await rm(candidate, { force: true });
  }
}

async function writeSynced(path: string, bytes: Buffer, mode: number): Promise<void> {
  await writeFile(path, bytes, { mode });
  await chmod(path, mode);
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

const activeOwnerTokens = new Set<string>();

async function processIdentityMatches(pid: number, expected: string): Promise<boolean> {
  return await readProcessStartIdentity(pid) === expected;
}

async function readProcessStartIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform() === 'linux') {
    try {
      const text = await readFile(`/proc/${pid}/stat`, 'utf8');
      const close = text.lastIndexOf(') ');
      const fields = close < 0 ? [] : text.slice(close + 2).trim().split(/\s+/u);
      return fields[19] ? `linux:${fields[19]}` : undefined;
    } catch { return undefined; }
  }
  return await new Promise((resolveIdentity) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }, (error, stdout) => {
      const value = error ? '' : stdout.trim().replace(/\s+/gu, ' ');
      resolveIdentity(value ? `${platform()}:${value}` : undefined);
    });
  });
}

async function removeOwnedContent(root: string): Promise<void> {
  if (!await exists(root)) return;
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('publisher content cleanup encountered a symbolic link');
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) await visit(join(path, entry));
    } else if (info.isFile()) {
      await chmod(path, 0o600);
    } else {
      throw new Error('publisher content cleanup encountered a special entry');
    }
  };
  await visit(root);
  await rm(root, { recursive: true, force: true });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (isCode(error, 'ENOENT')) return false; throw error; }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
