import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join, relative, resolve, delimiter as hostPathDelimiter } from 'node:path';
import { platform as hostPlatform } from 'node:os';

type IosProofProjectType = 'auto' | 'flutter' | 'ios';

export interface IosVisualProofCommandInput {
  issueNumber: number;
  worktreePath?: string;
  artifactDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  projectType?: IosProofProjectType;
  flutterTarget?: string;
  flutterFlavor?: string;
  iosBundleId?: string;
  iosScheme?: string;
  launchSettleMs?: number;
  fallbackReason?: string;
}

interface IosSimulator {
  udid: string;
  name: string;
  state: string;
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | Buffer;
  stderr: string;
}

export async function runIosVisualProofCommand(input: IosVisualProofCommandInput): Promise<void> {
  const env = input.env ?? process.env;
  const platform = input.platform ?? hostPlatform();
  if (platform !== 'darwin') {
    throw new Error('iOS visual proof requires macOS with Xcode simulator tooling.');
  }

  const worktreePath = resolve(input.worktreePath ?? env.CODEX_ORCHESTRATOR_WORKTREE_PATH ?? process.cwd());
  const artifactDir = input.artifactDir ?? env.CODEX_ORCHESTRATOR_ARTIFACT_DIR ?? '.codex-orchestrator/proofs';
  const proofDir = resolve(worktreePath, artifactDir, `issue-${input.issueNumber}`);
  const runtimeDir = resolve(worktreePath, '.codex-orchestrator/runtime/ios-visual-proof');
  const projectType = await resolveProjectType(worktreePath, input.projectType ?? iosProjectTypeFromEnv(env.CODEX_ORCHESTRATOR_IOS_PROJECT_TYPE));
  const xcrun = await pathExecutable('xcrun', env, platform) ?? fail('xcrun was not found. Install Xcode command line tools or put xcrun on PATH.');
  const simulator = await resolveSimulator(xcrun, env);

  await mkdir(proofDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const build = await buildIosApp({
    worktreePath,
    runtimeDir,
    projectType,
    input,
    env,
    platform,
  });

  await runCommand(xcrun, ['simctl', 'install', simulator.udid, build.appPath], { env });
  await runCommand(xcrun, ['simctl', 'launch', simulator.udid, build.bundleId], { env });
  await delay(input.launchSettleMs ?? numberFromEnv(env.CODEX_ORCHESTRATOR_IOS_LAUNCH_SETTLE_MS) ?? 5000);
  await runCommand(xcrun, ['simctl', 'io', simulator.udid, 'screenshot', join(proofDir, 'ios-launch.png')], { env });

  await writeFile(join(proofDir, 'ios-ui-summary.txt'), [
    'iOS visual proof',
    `issue: ${input.issueNumber}`,
    `projectType: ${projectType}`,
    `simulator: ${simulator.name}`,
    `udid: ${simulator.udid}`,
    `bundleId: ${build.bundleId}`,
    `app: ${relative(worktreePath, build.appPath)}`,
    input.fallbackReason ? `fallbackFrom: ${input.fallbackReason}` : undefined,
    'screenshot: ios-launch.png',
  ].filter(Boolean).join('\n'));
}

export function parseIosVisualProofArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: IosVisualProofCommandInput } | { ok: false; error: string } {
  const parsed: IosVisualProofCommandInput = {
    issueNumber: Number(env.CODEX_ORCHESTRATOR_ISSUE_NUMBER),
    worktreePath: env.CODEX_ORCHESTRATOR_WORKTREE_PATH ?? process.cwd(),
    artifactDir: env.CODEX_ORCHESTRATOR_ARTIFACT_DIR,
    flutterTarget: env.CODEX_ORCHESTRATOR_FLUTTER_TARGET,
    flutterFlavor: env.CODEX_ORCHESTRATOR_IOS_FLAVOR,
    iosBundleId: env.CODEX_ORCHESTRATOR_IOS_BUNDLE_ID,
    iosScheme: env.CODEX_ORCHESTRATOR_IOS_SCHEME,
    launchSettleMs: numberFromEnv(env.CODEX_ORCHESTRATOR_IOS_LAUNCH_SETTLE_MS),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = (): string | undefined => {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) return undefined;
      index += 1;
      return value;
    };
    switch (arg) {
      case '--issue': {
        const value = next();
        if (!value || !Number.isInteger(Number(value)) || Number(value) < 1) {
          return { ok: false, error: 'visual-proof ios requires --issue <number>' };
        }
        parsed.issueNumber = Number(value);
        break;
      }
      case '--target':
      case '--worktree': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.worktreePath = value;
        break;
      }
      case '--artifact-dir': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.artifactDir = value;
        break;
      }
      case '--project': {
        const value = next();
        if (value !== 'auto' && value !== 'flutter' && value !== 'ios') {
          return { ok: false, error: '--project must be auto, flutter, or ios' };
        }
        parsed.projectType = value;
        break;
      }
      case '--bundle-id': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.iosBundleId = value;
        break;
      }
      case '--scheme': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.iosScheme = value;
        break;
      }
      case '--flutter-target': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.flutterTarget = value;
        break;
      }
      case '--flavor': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.flutterFlavor = value;
        break;
      }
      case '--launch-settle-ms': {
        const value = next();
        if (!value || !Number.isFinite(Number(value)) || Number(value) < 0) {
          return { ok: false, error: '--launch-settle-ms must be a non-negative number' };
        }
        parsed.launchSettleMs = Number(value);
        break;
      }
      default:
        return { ok: false, error: `Unknown visual-proof ios option: ${arg ?? ''}` };
    }
  }

  if (!Number.isInteger(parsed.issueNumber) || parsed.issueNumber < 1) {
    return { ok: false, error: 'visual-proof ios requires --issue <number>' };
  }
  return { ok: true, value: parsed };
}

async function buildIosApp(input: {
  worktreePath: string;
  runtimeDir: string;
  projectType: Exclude<IosProofProjectType, 'auto'>;
  input: IosVisualProofCommandInput;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<{ appPath: string; bundleId: string }> {
  const bundleId = input.input.iosBundleId
    ?? await inferIosBundleId(input.worktreePath)
    ?? fail('Could not infer iOS bundle identifier. Pass --bundle-id or set CODEX_ORCHESTRATOR_IOS_BUNDLE_ID.');

  if (input.projectType === 'flutter') {
    const flutter = await resolveFlutter(input.env, input.platform);
    const args = ['build', 'ios', '--simulator', '--debug'];
    if (input.input.flutterTarget) args.push('-t', input.input.flutterTarget);
    if (input.input.flutterFlavor) args.push('--flavor', input.input.flutterFlavor);
    await runCommand(flutter, args, { cwd: input.worktreePath, env: input.env });
    return {
      appPath: await findAppBundle(join(input.worktreePath, 'build', 'ios', 'iphonesimulator')),
      bundleId,
    };
  }

  const xcodebuild = await pathExecutable('xcodebuild', input.env, input.platform)
    ?? fail('xcodebuild was not found. Install Xcode command line tools or put xcodebuild on PATH.');
  const project = await findFirstWithExtension(input.worktreePath, '.xcworkspace')
    ?? await findFirstWithExtension(input.worktreePath, '.xcodeproj')
    ?? fail('Native iOS visual proof expected an .xcworkspace or .xcodeproj.');
  const projectFlag = project.endsWith('.xcworkspace') ? '-workspace' : '-project';
  const scheme = input.input.iosScheme ?? basename(project).replace(/\.(?:xcworkspace|xcodeproj)$/u, '');
  const derivedDataPath = join(input.runtimeDir, 'DerivedData');
  await runCommand(xcodebuild, [
    projectFlag,
    project,
    '-scheme',
    scheme,
    '-configuration',
    'Debug',
    '-sdk',
    'iphonesimulator',
    '-derivedDataPath',
    derivedDataPath,
    'build',
  ], { cwd: input.worktreePath, env: input.env });
  return {
    appPath: await findAppBundle(join(derivedDataPath, 'Build', 'Products')),
    bundleId,
  };
}

async function resolveSimulator(xcrun: string, env: NodeJS.ProcessEnv): Promise<IosSimulator> {
  const booted = await listSimulators(xcrun, ['simctl', 'list', 'devices', 'booted', '-j'], env);
  if (booted[0]) return booted[0];

  const available = await listSimulators(xcrun, ['simctl', 'list', 'devices', 'available', '-j'], env);
  const simulator = available[0] ?? fail('No booted or available iOS simulator was found.');
  await runCommand(xcrun, ['simctl', 'boot', simulator.udid], { env, allowFailure: true });
  return simulator;
}

async function listSimulators(xcrun: string, args: string[], env: NodeJS.ProcessEnv): Promise<IosSimulator[]> {
  const result = await runCommand(xcrun, args, { env });
  const parsed = JSON.parse(String(result.stdout)) as { devices?: Record<string, Array<IosSimulator & { isAvailable?: boolean }>> };
  return Object.values(parsed.devices ?? {})
    .flat()
    .filter((device) => device.isAvailable !== false)
    .map((device) => ({ udid: device.udid, name: device.name, state: device.state }));
}

async function resolveProjectType(worktreePath: string, configured?: IosProofProjectType): Promise<Exclude<IosProofProjectType, 'auto'>> {
  if (configured && configured !== 'auto') return configured;
  if (await isFile(join(worktreePath, 'pubspec.yaml')) && await isDirectory(join(worktreePath, 'ios'))) {
    return 'flutter';
  }
  if (await findFirstWithExtension(worktreePath, '.xcodeproj') || await findFirstWithExtension(worktreePath, '.xcworkspace')) {
    return 'ios';
  }
  throw new Error('Could not detect an iOS project. Use --project flutter or --project ios from a Flutter/native iOS repo.');
}

async function inferIosBundleId(worktreePath: string): Promise<string | undefined> {
  const files = await listFiles(worktreePath, 4);
  for (const file of files.filter((path) => path.endsWith('project.pbxproj'))) {
    const match = /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\s]+)/u.exec(await readFile(file, 'utf8'));
    if (match?.[1]) return match[1].replaceAll('"', '');
  }
  return undefined;
}

async function findAppBundle(root: string): Promise<string> {
  const files = await listFiles(root, 8);
  const app = files.find((path) => path.endsWith('.app'));
  if (!app) {
    throw new Error(`iOS build did not produce an .app under ${root}.`);
  }
  return app;
}

async function findFirstWithExtension(root: string, extension: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.find((entry) => entry.isDirectory() && entry.name.endsWith(extension))
    ? join(root, entries.find((entry) => entry.isDirectory() && entry.name.endsWith(extension))?.name ?? '')
    : undefined;
}

async function resolveFlutter(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string> {
  return env.CODEX_ORCHESTRATOR_FLUTTER_BIN
    ?? (env.CODEX_ORCHESTRATOR_FLUTTER_ROOT ? join(env.CODEX_ORCHESTRATOR_FLUTTER_ROOT, 'bin', executableName('flutter', platform)) : undefined)
    ?? (env.FLUTTER_ROOT ? join(env.FLUTTER_ROOT, 'bin', executableName('flutter', platform)) : undefined)
    ?? await pathExecutable('flutter', env, platform)
    ?? fail('Flutter was not found for Flutter iOS visual proof.');
}

async function runCommand(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  timeoutMs?: number;
} = {}): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), options.timeoutMs) : undefined;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0 || options.allowFailure) {
        resolvePromise(result);
        return;
      }
      reject(new Error([
        `Command failed (${code ?? signal}): ${command} ${args.join(' ')}`,
        result.stderr || result.stdout,
      ].filter(Boolean).join('\n')));
    });
  });
}

async function pathExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | undefined> {
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const entry of (env.PATH ?? '').split(hostPathDelimiter).filter(Boolean)) {
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

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listFiles(root: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) {
        files.push(path);
      } else {
        files.push(...await listFiles(path, maxDepth - 1));
      }
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function executableName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function iosProjectTypeFromEnv(value: string | undefined): IosProofProjectType | undefined {
  if (value === 'auto' || value === 'flutter' || value === 'ios') return value;
  return undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
