export interface PathGlobClassificationInput {
  runtimeChangedPathGlobs: string[];
  testChangedPathGlobs: string[];
}

export interface PathGlobClassification {
  runtimeFiles: string[];
  testFiles: string[];
}

export interface DeniedPathMatch {
  path: string;
  pattern: string;
}

export interface ScreenshotArtifactPathInput {
  artifactPath: string;
  artifactDir: string;
  changedFiles: string[];
  hasPassedRunnerVisualValidation: boolean;
  exists?: (normalizedPath: string) => boolean;
}

export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function globMatches(pattern: string, path: string): boolean {
  const patternSegments = normalizePath(pattern).split('/');
  const pathSegments = normalizePath(path).split('/');
  return globSegmentsMatch(patternSegments, pathSegments);
}

export function findDeniedPathMatch(path: string, patterns: string[]): DeniedPathMatch | undefined {
  const normalized = normalizePath(path);
  const pattern = patterns.find((candidate) => globMatches(candidate, normalized));
  return pattern ? { path: normalized, pattern } : undefined;
}

export function classifyChangedPaths(
  paths: string[],
  globs: PathGlobClassificationInput,
): PathGlobClassification {
  const normalizedPaths = paths.map(normalizePath);
  const testFiles = normalizedPaths.filter((path) =>
    globs.testChangedPathGlobs.some((pattern) => globMatches(pattern, path)),
  );
  const runtimeFiles = normalizedPaths
    .filter((path) => globs.runtimeChangedPathGlobs.some((pattern) => globMatches(pattern, path)))
    .filter((path) => !globs.testChangedPathGlobs.some((pattern) => globMatches(pattern, path)));

  return { runtimeFiles, testFiles };
}

function changedPathCovers(changedPath: string, artifactPath: string): boolean {
  const normalizedChangedPath = normalizePath(changedPath);
  const normalizedArtifactPath = normalizePath(artifactPath);
  return normalizedChangedPath === normalizedArtifactPath
    || normalizedArtifactPath.startsWith(normalizedChangedPath.replace(/\/?$/, '/'));
}

export function acceptsScreenshotArtifactPath(input: ScreenshotArtifactPathInput): boolean {
  const path = normalizePath(input.artifactPath);
  if (input.exists && !input.exists(path)) {
    return false;
  }
  if (!isPathUnderDirectory(path, input.artifactDir)) {
    return false;
  }
  if (input.hasPassedRunnerVisualValidation) {
    return true;
  }
  return input.changedFiles.some((file) => changedPathCovers(file, path));
}

function isPathUnderDirectory(path: string, directory: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedDirectory = normalizePath(directory).replace(/\/+$/u, '');
  if (hasTraversalSegment(normalizedPath) || hasTraversalSegment(normalizedDirectory)) {
    return false;
  }
  return normalizedPath.startsWith(`${normalizedDirectory}/`);
}

export function isRunnerVisualProofCodeArtifactPath(path: string, artifactDir: string): boolean {
  return isPathUnderDirectory(path, artifactDir) && /\.(?:cjs|js|mjs|ts|tsx)$/iu.test(normalizePath(path));
}

export function uniqueSortedPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map(normalizePath))).sort((left, right) => left.localeCompare(right));
}

function globSegmentsMatch(patternSegments: string[], pathSegments: string[]): boolean {
  const [patternSegment, ...remainingPattern] = patternSegments;
  if (patternSegment === undefined) {
    return pathSegments.length === 0;
  }

  if (patternSegment === '**') {
    for (let index = 0; index <= pathSegments.length; index += 1) {
      if (globSegmentsMatch(remainingPattern, pathSegments.slice(index))) {
        return true;
      }
    }
    return false;
  }

  const [pathSegment, ...remainingPath] = pathSegments;
  if (pathSegment === undefined || !globSegmentMatches(patternSegment, pathSegment)) {
    return false;
  }
  return globSegmentsMatch(remainingPattern, remainingPath);
}

function globSegmentMatches(patternSegment: string, pathSegment: string): boolean {
  const escaped = patternSegment
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '[^/]*');
  return new RegExp(`^${escaped}$`).test(pathSegment);
}

function hasTraversalSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '..');
}
