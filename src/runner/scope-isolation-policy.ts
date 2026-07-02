import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';
import { globMatches, normalizePath } from '../path-policy.js';

export interface ScopeIsolationResult {
  ownershipScopes: string[];
  owned: string[];
  runnerOwned: string[];
  outOfScope: string[];
  blockers: string[];
}

export function issueOwnershipScopes(issue: GitHubIssue): string[] {
  return readMetadataBulletBlock(issue.body, 'Ownership')
    .map((scope) => normalizePath(scope.trim()))
    .filter(Boolean)
    .filter(unique)
    .sort((left, right) => left.localeCompare(right));
}

export function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftScope) =>
    right.some((rightScope) =>
      leftScope === rightScope || globMatches(leftScope, rightScope) || globMatches(rightScope, leftScope),
    ),
  );
}

export function evaluateScopeIsolation(input: {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
}): ScopeIsolationResult {
  const ownershipScopes = issueOwnershipScopes(input.issue);
  const normalizedFiles = input.changedFiles.map(normalizePath).filter(unique);
  const owned: string[] = [];
  const runnerOwned: string[] = [];
  const outOfScope: string[] = [];

  if (ownershipScopes.length === 0) {
    return { ownershipScopes, owned: normalizedFiles, runnerOwned, outOfScope, blockers: [] };
  }

  for (const file of normalizedFiles) {
    if (isRunnerOwnedPath(input.config, file)) {
      runnerOwned.push(file);
    } else if (ownershipScopes.some((scope) => pathMatchesOwnershipScope(file, scope))) {
      owned.push(file);
    } else {
      outOfScope.push(file);
    }
  }

  return {
    ownershipScopes,
    owned,
    runnerOwned,
    outOfScope,
    blockers: outOfScope.length === 0
      ? []
      : [`Changed files outside issue ownership scope: ${outOfScope.join(', ')}. Ownership scope: ${ownershipScopes.join(', ')}.`],
  };
}

function isRunnerOwnedPath(config: CodexOrchestratorConfig, path: string): boolean {
  return config.reviewGates.acceptanceProof.proofOwnedPathGlobs.some((pattern) => globMatches(pattern, path));
}

function pathMatchesOwnershipScope(path: string, scope: string): boolean {
  const normalizedScope = normalizePath(scope).replace(/\/+$/u, '');
  return globMatches(normalizedScope, path) || path.startsWith(`${normalizedScope}/`);
}

function readMetadataBulletBlock(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const metadataStart = lines.findIndex((line) => line.trim() === '## codex-orchestrator metadata');
  if (metadataStart < 0) {
    return [];
  }

  const block: string[] = [];
  let inBlock = false;
  for (const line of lines.slice(metadataStart + 1)) {
    if (line.startsWith('## ')) {
      break;
    }
    if (line.trim() === `${heading}:`) {
      inBlock = true;
      continue;
    }
    if (!inBlock) {
      continue;
    }
    const item = /^[-*]\s+(.+)$/u.exec(line.trim());
    if (item) {
      block.push(item[1]?.trim() ?? '');
      continue;
    }
    if (line.trim().length > 0) {
      break;
    }
  }
  return block.filter((item) => item.length > 0);
}

function unique(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}
