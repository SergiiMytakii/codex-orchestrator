import { access, constants } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

export type CodexCommandResolver = () => Promise<string | undefined>;
export type ExecutableCommandResolver = (command: string) => Promise<string | undefined>;

export interface ResolveCodexCommandOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  canExecute?: (path: string) => Promise<boolean>;
}

export async function resolveCodexCommand(options: ResolveCodexCommandOptions = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const canExecute = options.canExecute ?? isExecutable;

  const fromPath = await resolveExecutableCommand('codex', { env, platform, canExecute });
  if (fromPath) {
    return fromPath;
  }

  for (const candidate of knownFallbackCandidates(platform)) {
    if (await canExecute(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export async function resolveExecutableCommand(
  command: string,
  options: ResolveCodexCommandOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const canExecute = options.canExecute ?? isExecutable;

  if (hasPathSegment(command, platform)) {
    return await canExecute(command) ? command : undefined;
  }

  for (const candidate of pathCandidates(command, env, platform)) {
    if (await canExecute(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function pathCandidates(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const pathValue = readPathValue(env);
  if (!pathValue) {
    return [];
  }

  const pathModule = platform === 'win32' ? win32 : posix;
  const commands = commandNames(command, platform, env);
  const separator = platform === 'win32' ? ';' : ':';
  const directories = pathValue.split(separator).filter((item) => item.length > 0);

  return directories.flatMap((directory) => commands.map((command) => pathModule.join(directory, command)));
}

function commandNames(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') {
    return [command];
  }

  if (win32.extname(command)) {
    return [command];
  }

  const extensions = readPathExt(env);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function hasPathSegment(command: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return command.includes('\\') || command.includes('/') || win32.isAbsolute(command);
  }

  return command.includes('/') || posix.isAbsolute(command);
}

function readPathValue(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function readPathExt(env: NodeJS.ProcessEnv): string[] {
  const value = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const seen = new Set<string>();
  const extensions: string[] = [];

  for (const rawExtension of value.split(';')) {
    const extension = rawExtension.trim();
    if (!extension || seen.has(extension.toLowerCase())) {
      continue;
    }
    seen.add(extension.toLowerCase());
    extensions.push(extension);
  }

  return extensions;
}

function knownFallbackCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return ['/Applications/Codex.app/Contents/Resources/codex'];
  }

  return [];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
