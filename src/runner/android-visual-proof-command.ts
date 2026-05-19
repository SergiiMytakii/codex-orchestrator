import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, win32, posix, delimiter as hostPathDelimiter } from 'node:path';
import { homedir, platform as hostPlatform } from 'node:os';

type AndroidProofProjectType = 'auto' | 'flutter' | 'android';
type PathApi = typeof posix;

export interface AndroidVisualProofCommandInput {
  issueNumber: number;
  worktreePath?: string;
  artifactDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  projectType?: AndroidProofProjectType;
  launchConfigName?: string;
  flutterTarget?: string;
  flutterFlavor?: string;
  androidPackage?: string;
  gradleInstallTask?: string;
  launchSettleMs?: number;
}

interface AndroidProofTools {
  adb: string;
  emulator?: string;
  flutter?: string;
  sdkRoot: string;
}

interface AndroidDevice {
  serial: string;
  state: string;
  kind: 'device' | 'emulator';
}

interface FlutterLaunchConfig {
  name: string;
  program?: string;
  args: string[];
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | Buffer;
  stderr: string;
}

export async function runAndroidVisualProofCommand(input: AndroidVisualProofCommandInput): Promise<void> {
  const env = input.env ?? process.env;
  const platform = input.platform ?? hostPlatform();
  const worktreePath = resolve(input.worktreePath ?? env.CODEX_ORCHESTRATOR_WORKTREE_PATH ?? process.cwd());
  const artifactDir = input.artifactDir ?? env.CODEX_ORCHESTRATOR_ARTIFACT_DIR ?? '.codex-orchestrator/proofs';
  const proofDir = resolve(worktreePath, artifactDir, `issue-${input.issueNumber}`);
  const runtimeDir = resolve(worktreePath, '.codex-orchestrator/runtime/android-visual-proof');
  const projectType = await resolveProjectType(worktreePath, input.projectType ?? androidProjectTypeFromEnv(env.CODEX_ORCHESTRATOR_ANDROID_PROJECT_TYPE));
  const tools = await resolveAndroidProofTools({ env, platform, needsFlutter: projectType === 'flutter' });
  const commandEnv = await androidProofCommandEnv({ env, sdkRoot: tools.sdkRoot, runtimeDir });
  const device = await selectAndroidDevice({ adb: tools.adb, emulator: tools.emulator, env: commandEnv });

  await mkdir(proofDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await waitForBoot({ adb: tools.adb, serial: device.serial, env: commandEnv });

  const packageName = await buildAndInstall({
    worktreePath,
    projectType,
    input,
    env: commandEnv,
    tools,
    device,
    platform,
  });
  const activity = await resolveMainActivity({ adb: tools.adb, serial: device.serial, packageName, env: commandEnv });
  await runCommand(tools.adb, ['-s', device.serial, 'shell', 'am', 'start', '-n', activity], { env: commandEnv, platform });
  await delay(input.launchSettleMs ?? numberFromEnv(env.CODEX_ORCHESTRATOR_ANDROID_LAUNCH_SETTLE_MS) ?? 5000);

  const screenshot = await runCommand(tools.adb, ['-s', device.serial, 'exec-out', 'screencap', '-p'], {
    env: commandEnv,
    encoding: 'buffer',
    platform,
  });
  await writeFile(join(proofDir, 'android-launch.png'), screenshot.stdout);

  const uiDump = await runCommand(tools.adb, ['-s', device.serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], {
    env: commandEnv,
    allowFailure: true,
    platform,
  });
  await writeFile(join(proofDir, 'android-ui.xml'), String(uiDump.stdout || uiDump.stderr || ''));

  const logcat = await runCommand(tools.adb, ['-s', device.serial, 'logcat', '-d', '-t', '300'], {
    env: commandEnv,
    allowFailure: true,
    platform,
  });
  await writeFile(join(proofDir, 'android-logcat.txt'), String(logcat.stdout || logcat.stderr || ''));

  await writeFile(join(proofDir, 'android-ui-summary.txt'), [
    'Android visual proof',
    `issue: ${input.issueNumber}`,
    `projectType: ${projectType}`,
    `serial: ${device.serial}`,
    `target: ${device.kind}`,
    `adb: ${tools.adb}`,
    `package: ${packageName}`,
    `activity: ${activity}`,
    'screenshot: android-launch.png',
  ].join('\n'));
}

export function parseAndroidVisualProofArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: AndroidVisualProofCommandInput } | { ok: false; error: string } {
  const parsed: AndroidVisualProofCommandInput = {
    issueNumber: Number(env.CODEX_ORCHESTRATOR_ISSUE_NUMBER),
    worktreePath: env.CODEX_ORCHESTRATOR_WORKTREE_PATH ?? process.cwd(),
    artifactDir: env.CODEX_ORCHESTRATOR_ARTIFACT_DIR,
    launchConfigName: env.CODEX_ORCHESTRATOR_FLUTTER_LAUNCH_CONFIG,
    flutterTarget: env.CODEX_ORCHESTRATOR_FLUTTER_TARGET,
    flutterFlavor: env.CODEX_ORCHESTRATOR_ANDROID_FLAVOR,
    androidPackage: env.CODEX_ORCHESTRATOR_ANDROID_PACKAGE,
    gradleInstallTask: env.CODEX_ORCHESTRATOR_ANDROID_GRADLE_INSTALL_TASK,
    launchSettleMs: numberFromEnv(env.CODEX_ORCHESTRATOR_ANDROID_LAUNCH_SETTLE_MS),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = (): string | undefined => {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        return undefined;
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--issue': {
        const value = next();
        if (!value || !Number.isInteger(Number(value)) || Number(value) < 1) {
          return { ok: false, error: 'visual-proof android requires --issue <number>' };
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
        if (value !== 'auto' && value !== 'flutter' && value !== 'android') {
          return { ok: false, error: '--project must be auto, flutter, or android' };
        }
        parsed.projectType = value;
        break;
      }
      case '--launch-config': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.launchConfigName = value;
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
      case '--package': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.androidPackage = value;
        break;
      }
      case '--gradle-install-task': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        parsed.gradleInstallTask = value;
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
        return { ok: false, error: `Unknown visual-proof android option: ${arg ?? ''}` };
    }
  }

  if (!Number.isInteger(parsed.issueNumber) || parsed.issueNumber < 1) {
    return { ok: false, error: 'visual-proof android requires --issue <number>' };
  }

  return { ok: true, value: parsed };
}

export function androidSdkDefaultRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const pathApi = pathApiForPlatform(platform);
  if (platform === 'win32') {
    return [
      env.LOCALAPPDATA ? pathApi.join(env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
      env.USERPROFILE ? pathApi.join(env.USERPROFILE, 'AppData', 'Local', 'Android', 'Sdk') : undefined,
    ].filter((value): value is string => Boolean(value));
  }
  const home = env.HOME ?? homedir();
  if (platform === 'darwin') {
    return [pathApi.join(home, 'Library', 'Android', 'sdk')];
  }
  return [pathApi.join(home, 'Android', 'Sdk')];
}

async function resolveAndroidProofTools(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  needsFlutter: boolean;
}): Promise<AndroidProofTools> {
  const { env, platform, needsFlutter } = input;
  const sdkRoots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    ...androidSdkDefaultRoots(env, platform),
  ].filter((value): value is string => Boolean(value));
  const adb = await firstExecutable([
    env.CODEX_ORCHESTRATOR_ADB,
    env.ADB,
    ...sdkRoots.map((root) => sdkTool(root, platform, 'platform-tools', executableName('adb', platform))),
    await pathExecutable('adb', env, platform),
  ], platform);
  const emulator = await firstExecutable([
    env.CODEX_ORCHESTRATOR_EMULATOR,
    ...sdkRoots.map((root) => sdkTool(root, platform, 'emulator', executableName('emulator', platform))),
    await pathExecutable('emulator', env, platform),
  ], platform);
  const flutter = await firstExecutable([
    env.CODEX_ORCHESTRATOR_FLUTTER_BIN,
    env.CODEX_ORCHESTRATOR_FLUTTER_ROOT
      ? sdkTool(env.CODEX_ORCHESTRATOR_FLUTTER_ROOT, platform, 'bin', executableName('flutter', platform))
      : undefined,
    env.FLUTTER_ROOT ? sdkTool(env.FLUTTER_ROOT, platform, 'bin', executableName('flutter', platform)) : undefined,
    await pathExecutable('flutter', env, platform),
  ], platform);

  if (!adb) {
    throw new Error([
      'Android platform tools were not found.',
      'Set ANDROID_HOME or ANDROID_SDK_ROOT, install Android SDK in the OS default location, or put adb on PATH.',
      'Defaults checked: macOS ~/Library/Android/sdk, Linux ~/Android/Sdk, Windows %LOCALAPPDATA%\\Android\\Sdk.',
    ].join(' '));
  }
  if (needsFlutter && !flutter) {
    throw new Error([
      'Flutter was not found for Flutter Android visual proof.',
      'Set CODEX_ORCHESTRATOR_FLUTTER_BIN, CODEX_ORCHESTRATOR_FLUTTER_ROOT, FLUTTER_ROOT, or put flutter on PATH.',
    ].join(' '));
  }

  return { adb, emulator, flutter, sdkRoot: sdkRootFromAdb(adb, platform) };
}

async function buildAndInstall(input: {
  worktreePath: string;
  projectType: Exclude<AndroidProofProjectType, 'auto'>;
  input: AndroidVisualProofCommandInput;
  env: NodeJS.ProcessEnv;
  tools: AndroidProofTools;
  device: AndroidDevice;
  platform: NodeJS.Platform;
}): Promise<string> {
  if (input.projectType === 'flutter') {
    if (!input.tools.flutter) {
      throw new Error('Flutter Android visual proof requires flutter.');
    }
    const launchConfig = await readFlutterLaunchConfig(input.worktreePath, input.input.launchConfigName);
    const build = flutterBuildPlan(launchConfig, input.input);
    await runCommand(input.tools.flutter, build.args, { cwd: input.worktreePath, env: input.env, platform: input.platform });
    const apk = await findBuiltApk(input.worktreePath, build.flavor);
    await runCommand(input.tools.adb, ['-s', input.device.serial, 'install', '-r', '-t', relative(input.worktreePath, apk)], {
      cwd: input.worktreePath,
      env: input.env,
      platform: input.platform,
    });
    return input.input.androidPackage
      ?? await inferAndroidPackageName(input.worktreePath, build.flavor)
      ?? fail('Could not infer Android applicationId. Pass --package or set CODEX_ORCHESTRATOR_ANDROID_PACKAGE.');
  }

  const gradle = await resolveGradleWrapper(input.worktreePath, input.platform);
  const gradleInstallTask = input.input.gradleInstallTask ?? 'installDebug';
  await runCommand(gradle, [gradleInstallTask], { cwd: input.worktreePath, env: input.env, platform: input.platform });
  return input.input.androidPackage
    ?? await inferAndroidPackageName(input.worktreePath)
    ?? fail('Native Android visual proof requires --package or CODEX_ORCHESTRATOR_ANDROID_PACKAGE when applicationId cannot be inferred.');
}

async function selectAndroidDevice(input: { adb: string; emulator?: string; env: NodeJS.ProcessEnv }): Promise<AndroidDevice> {
  const existing = await listAndroidDevices(input.adb, input.env);
  if (input.env.ANDROID_SERIAL) {
    const requested = existing.find((device) => device.serial === input.env.ANDROID_SERIAL);
    if (!requested) {
      throw new Error(`ANDROID_SERIAL=${input.env.ANDROID_SERIAL} is set, but adb did not report that device as connected.`);
    }
    return requested;
  }
  const connected = existing.find((device) => device.kind === 'device') ?? existing.find((device) => device.kind === 'emulator');
  if (connected) {
    return connected;
  }
  if (!input.emulator) {
    throw new Error('No Android device is connected and emulator was not found. Connect a device or install the Android emulator tool.');
  }
  const avds = String((await runCommand(input.emulator, ['-list-avds'], { env: input.env })).stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (avds.length === 0) {
    throw new Error('No Android device is connected and emulator -list-avds returned no AVDs.');
  }
  const child = spawn(input.emulator, ['-avd', avds[0], '-no-snapshot-save'], {
    env: input.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  await runCommand(input.adb, ['wait-for-device'], { env: input.env, timeoutMs: 120_000 });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const started = (await listAndroidDevices(input.adb, input.env))[0];
    if (started) return started;
    await delay(2_000);
  }
  throw new Error(`Started AVD ${avds[0]}, but adb did not report a usable device.`);
}

async function listAndroidDevices(adb: string, env: NodeJS.ProcessEnv): Promise<AndroidDevice[]> {
  const result = await runCommand(adb, ['devices', '-l'], { env });
  return String(result.stdout)
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/u);
      return {
        serial,
        state,
        kind: serial?.startsWith('emulator-') ? 'emulator' as const : 'device' as const,
      };
    })
    .filter((device) => Boolean(device.serial) && device.state === 'device');
}

async function waitForBoot(input: { adb: string; serial: string; env: NodeJS.ProcessEnv }): Promise<void> {
  await runCommand(input.adb, ['-s', input.serial, 'wait-for-device'], { env: input.env, timeoutMs: 120_000 });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await runCommand(input.adb, ['-s', input.serial, 'shell', 'getprop', 'sys.boot_completed'], {
      env: input.env,
      allowFailure: true,
    });
    if (String(result.stdout).trim() === '1') {
      return;
    }
    await delay(2_000);
  }
  throw new Error(`Android device ${input.serial} did not finish booting.`);
}

async function resolveMainActivity(input: {
  adb: string;
  serial: string;
  packageName: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const result = await runCommand(input.adb, ['-s', input.serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', input.packageName], {
    env: input.env,
  });
  const activity = String(result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.includes('/'))
    .at(-1);
  if (!activity) {
    throw new Error(`Could not resolve launch activity for ${input.packageName}.`);
  }
  return activity;
}

async function resolveProjectType(worktreePath: string, configured?: AndroidProofProjectType): Promise<Exclude<AndroidProofProjectType, 'auto'>> {
  if (configured && configured !== 'auto') {
    return configured;
  }
  if (await isFile(join(worktreePath, 'pubspec.yaml')) && await isDirectory(join(worktreePath, 'android'))) {
    return 'flutter';
  }
  if (await isFile(join(worktreePath, 'gradlew')) || await isFile(join(worktreePath, 'gradlew.bat'))) {
    return 'android';
  }
  throw new Error('Could not detect an Android project. Use --project flutter or --project android from a Flutter/native Android repo.');
}

async function readFlutterLaunchConfig(worktreePath: string, launchConfigName?: string): Promise<FlutterLaunchConfig> {
  const fallback: FlutterLaunchConfig = { name: 'default flutter build', args: [] };
  if (!launchConfigName) {
    return fallback;
  }
  const contents = await readFile(join(worktreePath, '.vscode', 'launch.json'), 'utf8');
  const launch = JSON.parse(stripJsonComments(contents)) as { configurations?: FlutterLaunchConfig[] };
  const config = launch.configurations?.find((entry) => entry.name === launchConfigName);
  if (!config) {
    throw new Error(`Flutter launch config '${launchConfigName}' was not found in .vscode/launch.json.`);
  }
  return {
    name: config.name,
    program: config.program,
    args: Array.isArray(config.args) ? config.args.map(String) : [],
  };
}

function flutterBuildPlan(launchConfig: FlutterLaunchConfig, input: AndroidVisualProofCommandInput): { args: string[]; flavor?: string } {
  const launchArgs = [...launchConfig.args];
  const flavor = input.flutterFlavor ?? valueAfter(launchArgs, '--flavor');
  const target = input.flutterTarget ?? launchConfig.program;
  const args = ['build', 'apk', '--debug'];
  if (target) {
    args.push('-t', target);
  }
  if (flavor && !launchArgs.includes('--flavor')) {
    args.push('--flavor', flavor);
  }
  args.push(...launchArgs);
  return { args, flavor };
}

async function inferAndroidPackageName(worktreePath: string, flavor?: string): Promise<string | undefined> {
  const candidates = [
    join(worktreePath, 'android', 'app', 'build.gradle'),
    join(worktreePath, 'android', 'app', 'build.gradle.kts'),
    join(worktreePath, 'app', 'build.gradle'),
    join(worktreePath, 'app', 'build.gradle.kts'),
  ];
  for (const candidate of candidates) {
    if (!await isFile(candidate)) continue;
    const contents = await readFile(candidate, 'utf8');
    const flavorPackage = flavor ? applicationIdFromNamedBlock(contents, flavor) : undefined;
    const packageName = flavorPackage ?? applicationIdFromNamedBlock(contents, 'defaultConfig') ?? applicationIdFromText(contents);
    if (packageName) return packageName;
  }
  return undefined;
}

function applicationIdFromNamedBlock(contents: string, blockName: string): string | undefined {
  const start = contents.indexOf(blockName);
  if (start < 0) return undefined;
  const block = contents.slice(start, start + 4000);
  return applicationIdFromText(block);
}

function applicationIdFromText(contents: string): string | undefined {
  const match = /\bapplicationId\s*(?:=|\()\s*["']([^"']+)["']/u.exec(contents)
    ?? /\bapplicationId\s+["']([^"']+)["']/u.exec(contents);
  return match?.[1];
}

async function findBuiltApk(worktreePath: string, flavor?: string): Promise<string> {
  const expected = flavor
    ? join(worktreePath, 'build', 'app', 'outputs', 'flutter-apk', `app-${flavor}-debug.apk`)
    : join(worktreePath, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk');
  if (await isFile(expected)) return expected;
  const root = join(worktreePath, 'build', 'app', 'outputs', 'flutter-apk');
  const files = await listFiles(root);
  const apks = await Promise.all(files
    .filter((path) => path.endsWith('.apk'))
    .map(async (path) => ({ path, info: await stat(path) })));
  apks.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs);
  if (apks[0]) return apks[0].path;
  throw new Error(`Flutter build did not produce an APK under ${relative(worktreePath, root)}.`);
}

async function resolveGradleWrapper(worktreePath: string, platform: NodeJS.Platform): Promise<string> {
  const wrapper = platform === 'win32' ? join(worktreePath, 'gradlew.bat') : join(worktreePath, 'gradlew');
  if (await isExecutable(wrapper, platform)) return wrapper;
  throw new Error(`Native Android visual proof expected Gradle wrapper at ${relative(worktreePath, wrapper)}.`);
}

async function androidProofCommandEnv(input: {
  env: NodeJS.ProcessEnv;
  sdkRoot: string;
  runtimeDir: string;
}): Promise<NodeJS.ProcessEnv> {
  const home = input.env.HOME ?? input.env.USERPROFILE;
  const pubCache = input.env.PUB_CACHE ?? (home ? join(home, '.pub-cache') : join(input.runtimeDir, 'pub-cache'));
  const gradleHome = input.env.GRADLE_USER_HOME ?? (home ? join(home, '.gradle') : join(input.runtimeDir, 'gradle-home'));
  await mkdir(pubCache, { recursive: true });
  await mkdir(gradleHome, { recursive: true });
  return {
    ...input.env,
    ANDROID_HOME: input.env.ANDROID_HOME ?? input.sdkRoot,
    ANDROID_SDK_ROOT: input.env.ANDROID_SDK_ROOT ?? input.sdkRoot,
    PUB_CACHE: pubCache,
    GRADLE_USER_HOME: gradleHome,
  };
}

async function runCommand(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  timeoutMs?: number;
  encoding?: 'buffer';
  platform?: NodeJS.Platform;
} = {}): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.platform === 'win32' && /\.(?:bat|cmd)$/iu.test(command),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill('SIGTERM'), options.timeoutMs)
      : undefined;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrText = Buffer.concat(stderr).toString('utf8');
      const result: CommandResult = {
        code,
        signal,
        stdout: options.encoding === 'buffer' ? stdoutBuffer : stdoutBuffer.toString('utf8'),
        stderr: stderrText,
      };
      if (code === 0 || options.allowFailure) {
        resolvePromise(result);
        return;
      }
      reject(new Error([
        `Command failed (${code ?? signal}): ${command} ${args.join(' ')}`,
        stderrText || String(result.stdout),
      ].filter(Boolean).join('\n')));
    });
  });
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

async function listFiles(root: string): Promise<string[]> {
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
      files.push(...await listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function sdkTool(root: string, platform: NodeJS.Platform, ...parts: string[]): string {
  return pathApiForPlatform(platform).join(root, ...parts);
}

function sdkRootFromAdb(adb: string, platform: NodeJS.Platform): string {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.dirname(pathApi.dirname(adb));
}

function executableName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

function pathApiForPlatform(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? win32 : posix;
}

function valueAfter(args: string[], key: string): string | undefined {
  const index = args.findIndex((arg) => arg === key);
  return index >= 0 ? args[index + 1] : undefined;
}

function stripJsonComments(contents: string): string {
  return contents
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|\s)\/\/.*$/gmu, '$1');
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function androidProjectTypeFromEnv(value: string | undefined): AndroidProofProjectType | undefined {
  if (value === 'auto' || value === 'flutter' || value === 'android') {
    return value;
  }
  return undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
