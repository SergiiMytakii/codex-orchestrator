import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export interface SessionCodexHomePathInput {
  targetRoot: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}

export function sessionCodexHomePath(input: SessionCodexHomePathInput): string {
  const root = input.env?.CODEX_ORCHESTRATOR_CODEX_HOME_ROOT
    || join(tmpdir(), 'codex-orchestrator', 'codex-home');
  const projectHash = createHash('sha256').update(input.targetRoot).digest('hex').slice(0, 12);
  const projectName = sanitizePathSegment(basename(input.targetRoot)) || 'project';

  return join(root, `${projectName}-${projectHash}`, input.sessionId);
}

export async function cleanupSessionCodexHome(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '');
}
