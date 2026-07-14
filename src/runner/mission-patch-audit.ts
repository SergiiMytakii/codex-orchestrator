import { Buffer } from 'node:buffer';

import { globMatches, normalizePath } from '../path-policy.js';
import { missionPathDenied } from './mission-path-language.js';

export interface MissionPatchAuditInput {
  patch: string;
  grantedPaths: string[];
  deniedPaths: string[];
  maxBytes: number;
}

export interface MissionPatchFile {
  path: string;
  operation: 'add' | 'delete' | 'modify';
  oldMode: string | null;
  newMode: string | null;
}

export type MissionPatchAuditResult =
  | { accepted: true; files: MissionPatchFile[] }
  | { accepted: false; reason: string };

export function auditMissionPatch(input: MissionPatchAuditInput): MissionPatchAuditResult {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new Error('Mission patch maxBytes must be a positive integer.');
  }
  if (Buffer.byteLength(input.patch, 'utf8') > input.maxBytes) {
    return rejected('patch-size-limit');
  }
  if (/^(?:GIT binary patch|Binary files )/mu.test(input.patch)) {
    return rejected('binary-patch-forbidden');
  }
  const lines = input.patch.split(/\r?\n/u);
  const files: Array<{
    path: string;
    oldMode: string | null;
    newMode: string | null;
    oldHeader: boolean;
    newHeader: boolean;
    hunk: boolean;
    inHunk: boolean;
    remainingOld: number;
    remainingNew: number;
  }> = [];
  let current: (typeof files)[number] | undefined;
  for (const line of lines) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(line);
    if (line.startsWith('diff ') && !header) {
      return rejected('malformed-diff-header');
    }
    if (header) {
      if (current) {
        if (current.inHunk) return rejected('hunk-line-count-mismatch');
        files.push(current);
      }
      if (header[1] !== header[2]) return rejected('rename-or-copy-forbidden');
      const path = normalizePath(header[2]!);
      const pathDenial = validatePath(path, input.grantedPaths, input.deniedPaths);
      if (pathDenial) return rejected(pathDenial);
      current = {
        path,
        oldMode: '100644',
        newMode: '100644',
        oldHeader: false,
        newHeader: false,
        hunk: false,
        inHunk: false,
        remainingOld: 0,
        remainingNew: 0,
      };
      continue;
    }
    if (!current) {
      if (/^(?:--- |\+\+\+ |@@ |Index: )/u.test(line)) {
        return rejected('patch-record-before-diff-header');
      }
      continue;
    }
    if (current.inHunk) {
      if (line === '\\ No newline at end of file') continue;
      if (line.length === 0) return rejected('hunk-line-count-mismatch');
      if (line.startsWith(' ')) {
        current.remainingOld -= 1;
        current.remainingNew -= 1;
      } else if (line.startsWith('-')) {
        current.remainingOld -= 1;
      } else if (line.startsWith('+')) {
        current.remainingNew -= 1;
      } else {
        return rejected('malformed-hunk-body');
      }
      if (current.remainingOld < 0 || current.remainingNew < 0) {
        return rejected('hunk-line-count-mismatch');
      }
      if (current.remainingOld === 0 && current.remainingNew === 0) {
        current.inHunk = false;
      }
      continue;
    }
    if (/^(?:rename|copy) (?:from|to) /u.test(line)) {
      return rejected('rename-or-copy-forbidden');
    }
    const oldPath = /^--- (.+)$/u.exec(line)?.[1];
    if (oldPath && current.oldHeader) return rejected('repeated-file-header');
    if (oldPath && oldPath !== '/dev/null' && oldPath !== `a/${current.path}`) {
      return rejected('patch-header-path-mismatch');
    }
    if (oldPath) {
      current.oldHeader = true;
      if (oldPath === '/dev/null') current.oldMode = null;
    }
    const newPath = /^\+\+\+ (.+)$/u.exec(line)?.[1];
    if (newPath && current.newHeader) return rejected('repeated-file-header');
    if (newPath && newPath !== '/dev/null' && newPath !== `b/${current.path}`) {
      return rejected('patch-header-path-mismatch');
    }
    if (newPath) {
      current.newHeader = true;
      if (newPath === '/dev/null') current.newMode = null;
    }
    if (line.startsWith('@@')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
      if (!hunk || !current.oldHeader || !current.newHeader) {
        return rejected('malformed-hunk-header');
      }
      current.remainingOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current.remainingNew = hunk[4] === undefined ? 1 : Number(hunk[4]);
      if (!Number.isSafeInteger(current.remainingOld) || !Number.isSafeInteger(current.remainingNew)
        || (current.remainingOld === 0 && current.remainingNew === 0)) {
        return rejected('malformed-hunk-header');
      }
      current.hunk = true;
      current.inHunk = current.remainingOld > 0 || current.remainingNew > 0;
      continue;
    }
    const index = /^index [a-f0-9]+\.\.[a-f0-9]+(?: (\d{6}))?$/u.exec(line);
    if (index?.[1]) {
      current.oldMode = index[1];
      current.newMode = index[1];
    }
    const oldMode = /^(?:old mode|deleted file mode) (\d{6})$/u.exec(line)?.[1];
    const newMode = /^(?:new mode|new file mode) (\d{6})$/u.exec(line)?.[1];
    if (oldMode) current.oldMode = oldMode;
    if (newMode) current.newMode = newMode;
    if (current.hunk && /^[ +\-]/u.test(line)) {
      return rejected('hunk-line-count-mismatch');
    }
  }
  if (current) {
    if (current.inHunk) return rejected('hunk-line-count-mismatch');
    files.push(current);
  }
  if (files.length === 0) {
    return rejected('no-file-diffs');
  }
  if (files.some((file) => !file.oldHeader || !file.newHeader || !file.hunk)) {
    return rejected('incomplete-file-diff');
  }
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    return rejected('duplicate-file-diff');
  }
  const foldedPaths = paths.map((path) => path.normalize('NFC').toLocaleLowerCase('en-US'));
  if (new Set(foldedPaths).size !== foldedPaths.length) {
    return rejected('case-colliding-file-diff');
  }
  if (files.some((file) => (file.oldMode !== null && file.oldMode !== '100644')
    || (file.newMode !== null && file.newMode !== '100644')
    || (file.oldMode === null && file.newMode === null))) {
    return rejected('non-regular-file-mode-forbidden');
  }
  return {
    accepted: true,
    files: files.map(({ path, oldMode, newMode }) => ({
      path,
      operation: oldMode === null ? 'add' : newMode === null ? 'delete' : 'modify',
      oldMode,
      newMode,
    })),
  };
}

function validatePath(path: string, grants: string[], denies: string[]): string | undefined {
  if (path.length === 0 || path.startsWith('/') || path.split('/').includes('..')) {
    return 'invalid-repository-path';
  }
  if (path === '.git' || path.startsWith('.git/')) {
    return 'git-internal-path-forbidden';
  }
  if (missionPathDenied(path, denies)) {
    return 'denied-path';
  }
  if (!grants.some((pattern) => globMatches(pattern, path))) {
    return 'path-outside-granted-scope';
  }
  return undefined;
}

function rejected(reason: string): MissionPatchAuditResult {
  return { accepted: false, reason };
}
