import { globMatches, normalizePath } from '../path-policy.js';

export const missionDefaultDeniedRepositoryPaths = [
  '.env*',
  '**/.env*',
  '.git',
  '.git/**',
  'id_rsa',
  '**/id_rsa',
  'id_ed25519',
  '**/id_ed25519',
] as const;

export function assertMissionPathPattern(pattern: string, context: string): string {
  const normalized = normalizePath(pattern);
  if (normalized.length === 0 || normalized.startsWith('/')
    || normalized.split('/').some((segment) => segment.length === 0 || segment === '..')) {
    throw new Error(`${context} must be a non-empty repository-relative glob without empty segments.`);
  }
  return normalized;
}

export function scopePatternContainedBy(request: string, grant: string): boolean {
  const normalizedRequest = assertMissionPathPattern(request, 'Mission requested path');
  const normalizedGrant = assertMissionPathPattern(grant, 'Mission granted path');
  if (normalizedRequest === normalizedGrant) return true;
  if (!normalizedRequest.includes('*')) return globMatches(normalizedGrant, normalizedRequest);
  return false;
}

export function missionPathDenied(path: string, patterns: string[]): boolean {
  const normalized = normalizePath(path).normalize('NFC');
  const folded = normalized.toLocaleLowerCase('en-US');
  return patterns.some((pattern) => {
    const normalizedPattern = normalizePath(pattern).normalize('NFC');
    return globMatches(normalizedPattern, normalized)
      || globMatches(normalizedPattern.toLocaleLowerCase('en-US'), folded);
  });
}

export function missionPathPatternsOverlap(left: string, right: string): boolean {
  const leftSegments = assertMissionPathPattern(left, 'Mission scope path').split('/');
  const rightSegments = assertMissionPathPattern(right, 'Mission scope path').split('/');
  const queue: Array<[number, number]> = [[0, 0]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [leftIndex, rightIndex] = queue.shift()!;
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === leftSegments.length && rightIndex === rightSegments.length) return true;
    const leftSegment = leftSegments[leftIndex];
    const rightSegment = rightSegments[rightIndex];
    if (leftSegment === '**') queue.push([leftIndex + 1, rightIndex]);
    if (rightSegment === '**') queue.push([leftIndex, rightIndex + 1]);
    if (leftSegment === undefined || rightSegment === undefined) continue;
    if (leftSegment === '**' || rightSegment === '**'
      || segmentPatternsOverlap(leftSegment, rightSegment)) {
      queue.push([
        leftSegment === '**' ? leftIndex : leftIndex + 1,
        rightSegment === '**' ? rightIndex : rightIndex + 1,
      ]);
    }
  }
  return false;
}

function segmentPatternsOverlap(left: string, right: string): boolean {
  const alphabet = new Set<string>([
    ...[...left].filter((character) => character !== '*'),
    ...[...right].filter((character) => character !== '*'),
    '\u0001',
  ]);
  const queue: Array<[number, number, boolean]> = [[0, 0, false]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [leftIndex, rightIndex, consumed] = queue.shift()!;
    const key = `${leftIndex}:${rightIndex}:${consumed ? 1 : 0}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === left.length && rightIndex === right.length && consumed) return true;
    if (left[leftIndex] === '*') queue.push([leftIndex + 1, rightIndex, consumed]);
    if (right[rightIndex] === '*') queue.push([leftIndex, rightIndex + 1, consumed]);
    for (const character of alphabet) {
      const nextLeft = consumeSegmentCharacter(left, leftIndex, character);
      const nextRight = consumeSegmentCharacter(right, rightIndex, character);
      if (nextLeft !== undefined && nextRight !== undefined) queue.push([nextLeft, nextRight, true]);
    }
  }
  return false;
}

function consumeSegmentCharacter(pattern: string, index: number, character: string): number | undefined {
  const expected = pattern[index];
  if (expected === '*') return index;
  if (expected === character) return index + 1;
  return undefined;
}
