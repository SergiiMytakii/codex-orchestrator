import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter as hostPathDelimiter, join } from 'node:path';
import { homedir, platform as hostPlatform } from 'node:os';

export async function discoverFlutterExecutable(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<string | undefined> {
  const { env, platform } = input;
  return firstExecutable([
    env.CODEX_ORCHESTRATOR_FLUTTER_BIN,
    env.CODEX_ORCHESTRATOR_FLUTTER_ROOT
      ? sdkTool(env.CODEX_ORCHESTRATOR_FLUTTER_ROOT, platform, 'bin', executableName('flutter', platform))
      : undefined,
    env.FLUTTER_ROOT ? sdkTool(env.FLUTTER_ROOT, platform, 'bin', executableName('flutter', platform)) : undefined,
    ...await fvmFlutterCandidates(env, platform),
    await pathExecutable('flutter', env, platform),
  ], platform);
}

async function fvmFlutterCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string[]> {
  if (platform === 'win32') {
    return [];
  }
  const homes = uniqueStrings([
    env.FVM_HOME,
    env.HOME ? join(env.HOME, 'fvm') : undefined,
    env.HOME ? join(env.HOME, '.fvm') : undefined,
    join(homedir(), 'fvm'),
    join(homedir(), '.fvm'),
  ]);
  const candidates: string[] = [];
  for (const home of homes) {
    const versionsDir = join(home, 'versions');
    const versions = await sortedVersionDirectories(versionsDir);
    candidates.push(...versions.map((version) =>
      sdkTool(versionsDir, platform, version, 'bin', executableName('flutter', platform)),
    ));
  }
  return candidates;
}

async function sortedVersionDirectories(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersionsDescending);
}

function compareVersionsDescending(left: string, right: string): number {
  const parsedLeft = numericVersionParts(left);
  const parsedRight = numericVersionParts(right);
  const length = Math.max(parsedLeft.length, parsedRight.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (parsedRight[index] ?? 0) - (parsedLeft[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return right.localeCompare(left);
}

function numericVersionParts(version: string): number[] {
  const match = version.match(/\d+(?:\.\d+)*/u);
  return match ? match[0].split('.').map((part) => Number(part)) : [];
}

async function firstExecutable(candidates: Array<string | undefined>, platform: NodeJS.Platform): Promise<string | undefined> {
  for (const candidate of candidates.filter((value): value is string => Boolean(value))) {
    if (await isExecutable(candidate, platform)) {
      return candidate;
    }
  }
  return undefined;
}

async function pathExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | undefined> {
  const pathValue = env.PATH ?? '';
  const pathDelimiter = platform === hostPlatform() ? hostPathDelimiter : platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const entry of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`);
      if (await isExecutable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sdkTool(root: string, platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? join(root, ...parts) : join(root, ...parts);
}

function executableName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}
